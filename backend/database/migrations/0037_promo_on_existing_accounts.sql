-- Promotional diamonds, on the accounts 0029 already opened for them.
--
-- 0036 added the grants table and, beside it, two things that did not need to exist:
--   * `PROMO_EXPENSE` and `PROMO_LAPSED` — while 0029 had already seeded `PROMOTIONAL:PLATFORM`
--     ("Promotional and bonus budget", EXPENSE, pkr, DEBIT) and nothing had ever posted to it.
--   * the `promo.diamonds` config key — while 0029 had already seeded `accounts.promotional`
--     (`expiryDays`, `welcomeBonusDiamonds`) and nothing had ever read it.
-- Two dials for one expiry, or two budget accounts for one expense, is how an operator's panel and
-- the finance report start disagreeing about the same marketing spend. Both new rows are deleted
-- here; nothing referenced them (zero grants, zero journal lines at the time of writing), so no
-- history moves.
--
-- A lapsed bonus is booked as CREDIT to the same budget account rather than to a revenue account:
-- coins the platform minted and never got to spend are an expense it took back, not income it
-- earned. Calling it revenue would make an unspent campaign budget look like a coin take.
--
-- The second half of this file is the part 0036 left implied: `users.promo_diamond_balance` was
-- made a legal `balance_source`, but the projection had no branch that read it, so a member's bonus
-- pocket would have reported as zero — the gap the view would then present as a fact about the
-- member. Every holder now gets a `PROMOTIONAL:<user>` account, and its lifetime figures come from
-- `promo_grants` because a grant writes no `transactions` row for `coin_movements` to see.
-- ---------------------------------------------------------------------------

DELETE FROM fin_accounts
 WHERE code IN ('PROMO_EXPENSE', 'PROMO_LAPSED')
   AND NOT EXISTS (SELECT 1 FROM fin_journal_lines l WHERE l.account_code = fin_accounts.code);

UPDATE system_config AS target
   SET value       = jsonb_build_object(
         'expiryDays',           COALESCE(src.value->'defaultExpiryDays', target.value->'expiryDays', '30'::jsonb),
         'welcomeBonusDiamonds', COALESCE(target.value->'welcomeBonusDiamonds', '0'::jsonb),
         'usableFor',            COALESCE(src.value->'usableFor', '["GIFT","BOX","STORE","GAME"]'::jsonb)
           ),
       description = 'How long a bonus diamond stays spendable, what a new account is granted (0 disables), '
                     'and which diamonds sinks a promotional pocket may feed. Grants and lapses post to '
                     'PROMOTIONAL:PLATFORM.'
  FROM (SELECT value FROM system_config WHERE key = 'promo.diamonds') src
 WHERE target.key = 'accounts.promotional';

DELETE FROM system_config WHERE key = 'promo.diamonds';

-- ---------------------------------------------------------------------------
-- Every holder gets a window onto their bonus pocket.
--
-- Lazy creation in `ensureUserAccounts` covers members who arrive after this; the backfill covers
-- everyone who existed before, on the same rule 0029 used for its own two categories.
-- ---------------------------------------------------------------------------
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT 'PROMOTIONAL:' || u.id, u.username || ' — bonus diamonds', 'ASSET', 'dmn', 'DEBIT',
         'PROMOTIONAL', 'USER', u.id, 'users.promo_diamond_balance'
    FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f
                      WHERE f.owner_kind = 'USER' AND f.owner_id = u.id AND f.category = 'PROMOTIONAL');

-- ---------------------------------------------------------------------------
-- purpose_account_balances, with the branch 0036 implied.
--
-- Re-emitted whole because a view cannot be patched. Only `coin`, `promo_flows`, and the five CASEs
-- that mention a member's PROMOTIONAL account differ from 0029's version; every other category reads
-- exactly as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW purpose_account_balances AS
WITH holds AS (
  SELECT account_code,
         COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'FROZEN'), 0)        AS frozen_minor,
         COALESCE(SUM(amount_minor) FILTER (WHERE kind <> 'FROZEN'), 0)       AS earmarked_minor
    FROM account_holds
   WHERE status = 'OPEN'
   GROUP BY account_code
),
coin AS (
  SELECT id AS owner_id, diamond_balance, r_coin_balance, promo_diamond_balance, created_at
    FROM users
),
open_withdrawals AS (
  SELECT user_id,
         COALESCE(SUM(amount_r_coins), 0) AS awaiting_payout,
         MAX(created_at) AS last_at
    FROM withdrawal_requests
   WHERE status IN ('PENDING', 'APPROVED')
   GROUP BY user_id
),
-- Lifetime totals per user. The leg rules — GIFT_SENT's cross-leg, ADMIN_ADJUSTMENT's signed
-- meta, AGENCY_COMMISSION's notional amount — are resolved once, in `coin_movements` (0029), so
-- this view and the account statement can never disagree about what a transaction did.
flows AS (
  SELECT owner_id,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'dmn' AND direction = 'IN'),  0) AS diamonds_in,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'rcn' AND direction = 'IN'),  0) AS rcoins_in,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'dmn' AND direction = 'OUT'), 0) AS diamonds_out,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'rcn' AND direction = 'OUT'), 0) AS rcoins_out,
         MIN(occurred_at) AS first_at,
         MAX(occurred_at) AS last_at
    FROM coin_movements
   WHERE status = 'COMPLETED'
   GROUP BY owner_id
),
-- What the platform owes a partner. Reversal semantics come from 0007, not 0004: a refund is
-- a status change on the original accrual because a mirrored row would collide with the very
-- UNIQUE (order, beneficiary, kind) that stops a commission being paid twice.
payable AS (
  SELECT beneficiary_id AS owner_id, beneficiary,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'ACCRUED'), 0)  AS accrued_open_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('ACCRUED', 'SETTLED')), 0) AS accrued_all_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'REVERSED'), 0) AS reversed_minor,
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at
    FROM commission_entries
   WHERE beneficiary_id IS NOT NULL
   GROUP BY beneficiary_id, beneficiary
),
batches AS (
  SELECT beneficiary_id AS owner_id, beneficiary,
         COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('DRAFT', 'APPROVED')), 0) AS approved_open_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'PAID'), 0)                 AS paid_out_minor,
         MAX(updated_at) AS last_at
    FROM commission_settlements
   WHERE status <> 'VOID'
   GROUP BY beneficiary_id, beneficiary
),
journal AS (
  SELECT l.account_code,
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0)  AS debits_minor,
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0) AS credits_minor,
         MIN(e.occurred_at) AS first_at,
         MAX(e.occurred_at) AS last_at
    FROM fin_journal_lines l
    JOIN fin_journal_entries e ON e.id = l.entry_id
   GROUP BY l.account_code
),
-- A bonus coin never touches `transactions`: it is minted, not sent. So the promotional account's
-- lifetime figures come from the grant rows themselves — granted in, spent-plus-lapsed out — which
-- is the same arithmetic `promo_grants.remaining` is CHECKed against.
promo_flows AS (
  SELECT user_id,
         COALESCE(SUM(amount), 0)         AS granted,
         COALESCE(SUM(spent + lapsed), 0) AS used,
         MIN(created_at) AS first_at,
         MAX(updated_at) AS last_at
    FROM promo_grants
   GROUP BY user_id
),
users_present  AS (SELECT id AS owner_id FROM users),
business_present AS (SELECT id AS owner_id FROM business_accounts),
agencies_present AS (SELECT id AS owner_id FROM agencies)
SELECT
  a.code AS account_code,
  a.name,
  a.category,
  a.owner_kind,
  a.owner_id,
  a.currency,
  a.status,
  a.balance_source,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(c.diamond_balance, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(c.r_coin_balance, 0)::bigint
    -- The pocket a member can spend but cannot cash out: spendable like a diamond, expiring like
    -- nothing else in the layer.
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER' THEN COALESCE(c.promo_diamond_balance, 0)::bigint
    WHEN a.category = 'AGENCY'       THEN CASE a.normal_side WHEN 'DEBIT' THEN COALESCE(j.debits_minor, 0) - COALESCE(j.credits_minor, 0)
                                                             ELSE COALESCE(j.credits_minor, 0) - COALESCE(j.debits_minor, 0) END
    ELSE 0::bigint
  END AS available_minor,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(c.diamond_balance, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(c.r_coin_balance, 0)::bigint + COALESCE(ow.awaiting_payout, 0)::bigint
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER' THEN COALESCE(c.promo_diamond_balance, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_all_minor, 0) - COALESCE(b.paid_out_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.debits_minor, 0) - COALESCE(j.credits_minor, 0)
    ELSE COALESCE(j.credits_minor, 0) - COALESCE(j.debits_minor, 0)
  END AS balance_minor,
  CASE
    WHEN a.category = 'HOST_RCOIN'  THEN COALESCE(ow.awaiting_payout, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_open_minor, 0)
    ELSE COALESCE(h.earmarked_minor, 0)
  END AS pending_minor,
  CASE WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(b.approved_open_minor, 0)
       ELSE 0::bigint END AS approved_minor,
  COALESCE(h.frozen_minor, 0) AS frozen_minor,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(f.diamonds_in, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(f.rcoins_in, 0)::bigint
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER' THEN COALESCE(pf.granted, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_all_minor, 0) + COALESCE(p.reversed_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.debits_minor, 0)
    ELSE COALESCE(j.credits_minor, 0)
  END AS lifetime_in_minor,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(f.diamonds_out, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(f.rcoins_out, 0)::bigint
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER' THEN COALESCE(pf.used, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(b.paid_out_minor, 0) + COALESCE(p.reversed_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.credits_minor, 0)
    ELSE COALESCE(j.debits_minor, 0)
  END AS lifetime_out_minor,
  CASE
    WHEN a.owner_kind = 'USER'     THEN up.owner_id IS NOT NULL
    WHEN a.owner_kind = 'BUSINESS' THEN bp.owner_id IS NOT NULL
    WHEN a.owner_kind = 'AGENCY'   THEN ap.owner_id IS NOT NULL
    ELSE TRUE
  END AS source_row_present,
  CASE
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER'
      THEN LEAST(c.created_at, COALESCE(pf.first_at, c.created_at), a.created_at)
    WHEN a.owner_kind = 'USER'     THEN LEAST(c.created_at, COALESCE(f.first_at, c.created_at), a.created_at)
    WHEN a.owner_kind = 'BUSINESS' THEN COALESCE(p.first_at, a.created_at)
    ELSE COALESCE(j.first_at, a.created_at)
  END AS opened_at,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN GREATEST(f.last_at, c.created_at, a.updated_at)
    WHEN a.category = 'HOST_RCOIN'   THEN GREATEST(f.last_at, ow.last_at, c.created_at, a.updated_at)
    WHEN a.category = 'PROMOTIONAL' AND a.owner_kind = 'USER' THEN GREATEST(pf.last_at, c.created_at, a.updated_at)
    WHEN a.owner_kind = 'BUSINESS'   THEN GREATEST(p.last_at, b.last_at, a.updated_at)
    ELSE COALESCE(j.last_at, a.updated_at)
  END AS last_activity_at
FROM fin_accounts a
LEFT  JOIN holds h          ON h.account_code = a.code
LEFT  JOIN coin c           ON c.owner_id = a.owner_id AND a.owner_kind = 'USER'
LEFT  JOIN open_withdrawals ow ON ow.user_id = a.owner_id
LEFT  JOIN flows f          ON f.owner_id = a.owner_id
LEFT  JOIN promo_flows pf   ON pf.user_id = a.owner_id AND a.owner_kind = 'USER'
LEFT  JOIN payable p        ON p.owner_id = a.owner_id
                         AND ((a.category = 'BD_MANAGER' AND p.beneficiary = 'BD')
                           OR (a.category = 'COIN_SELLER' AND p.beneficiary = 'SELLER'))
LEFT  JOIN batches b        ON b.owner_id = a.owner_id
                         AND ((a.category = 'BD_MANAGER' AND b.beneficiary = 'BD')
                           OR (a.category = 'COIN_SELLER' AND b.beneficiary = 'SELLER'))
LEFT  JOIN journal j        ON j.account_code = a.code
LEFT  JOIN users_present up ON up.owner_id = a.owner_id
LEFT  JOIN business_present bp ON bp.owner_id = a.owner_id
LEFT  JOIN agencies_present ap ON ap.owner_id = a.owner_id;

COMMENT ON VIEW purpose_account_balances IS
  'One row per purpose account. Available, pending, approved and frozen are derived from the '
  'account''s authoritative source, never stored beside it.';
