-- 0036 — Promotional diamonds: a second balance, with an expiry and a rule that it never becomes cash.
--
-- The earning brief's §1 asks for three things this wallet cannot express. Diamonds a member earned from
-- a check-in and diamonds a member paid for sit in one column, so an operator cannot say which of them
-- are still owed, cannot retire a campaign's coins without touching a balance somebody bought, and cannot
-- tell a member "your bonus expires on the 30th" because nothing expires. This migration separates them.
--
-- Three decisions shape the file.
--
-- First, **the second balance is a column and the expiry is a row.** `users.promo_diamond_balance` is the
-- number a phone reads, and it is the same shape as `diamond_balance` so every existing read path keeps
-- working beside it. What makes it promotional is not the column, it is `promo_grants`: one row per
-- award, each with its own `expires_at` and its own `remaining`. A balance cannot expire, but a grant can,
-- and a member who has three grants sees the one nearest its death spent first — which is the difference
-- between an expiry that costs the member nothing and an expiry that quietly eats their bonus.
--
-- Second, **a grant is traceable to the thing that earned it.** `source_kind` plus `source_id` name the
-- check-in, quest or campaign row behind the award, and the pair is unique where an id exists. A reward
-- whose trigger is replayed therefore grants once, the same way a journal entry keyed on
-- `(source_kind, source_id)` posts once — and support answering "why does this account have 500 bonus
-- coins" has a row to read rather than a number to explain.
--
-- Third, **promotional diamonds cannot become cash, and that is structural rather than a rule.** A
-- member's only exit for diamonds is spending them: withdrawal is priced in R-coins
-- (`withdrawal_requests.amount_r_coins`), and `transactions` refuses a row whose sender is also its
-- receiver. So bonus coins cannot be laundered into a payout by their own holder; they can only be given
-- away or lapse. What that does *not* mean is that they are free — a grant mints a coin the platform owes,
-- so the service posts `PROMO_GRANT` against `COIN_LIABILITY` at the operator's face value, and a grant
-- that dies unspent posts `PROMO_LAPSE` to release it. Coins minted without a journal line are exactly the
-- hole 0034 closed.
--
-- Nothing here caps what a member may earn in a day. That is the earning-rules engine (#61) and it needs
-- the grants this table provides before it can count them.

-- ---------------------------------------------------------------------------
-- enums
--
-- `ALTER TYPE ... ADD VALUE` cannot be *used* by the file that creates it, so these are declared
-- before the tables that reference them and nothing below reads a literal in a CHECK expression.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE promo_grant_status AS ENUM ('ACTIVE', 'EXHAUSTED', 'LAPSED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- the second balance
--
-- Defaults to 0 and CHECKs at 0 for the same reason `diamond_balance` does: the column is the number a
-- client is shown, and a negative one would be a promise the platform cannot keep. Purchased diamonds
-- are untouched — no existing read, guard or projection changes meaning, which is what makes this safe
-- to deploy beside a live wallet.
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_diamond_balance INT NOT NULL DEFAULT 0
  CHECK (promo_diamond_balance >= 0);

COMMENT ON COLUMN users.promo_diamond_balance IS
  'Diamonds awarded by the platform rather than bought, equal to the sum of the unspent `remaining` on this account''s ACTIVE grants. Spendable like a purchased diamond, never withdrawable and never cashable by its holder.';

-- ---------------------------------------------------------------------------
-- promo_grants — one row per award, each expiring on its own date
--
-- `remaining` is stored rather than generated so the spend-order index can be partial and the wallet's
-- cached total can be checked against it; the CHECK below is what keeps the three columns one fact
-- instead of three that can drift. `spent` and `lapsed` only ever grow, so a grant's whole history reads
-- as amount = spent + lapsed + remaining and a reversal is a status, not a subtraction.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS promo_grants (
  id          UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID               NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      promo_grant_status NOT NULL DEFAULT 'ACTIVE',
  amount      INT                NOT NULL CHECK (amount > 0),
  spent       INT                NOT NULL DEFAULT 0 CHECK (spent >= 0),
  lapsed      INT                NOT NULL DEFAULT 0 CHECK (lapsed >= 0),
  remaining   INT                NOT NULL CHECK (remaining >= 0),
  -- What the award was for, as the platform's own short vocabulary. A new reward type is a value added
  -- here plus the hook that writes it, never an operator's free-text reason that a report then has to
  -- guess at.
  source_kind TEXT               NOT NULL CHECK (
    source_kind IN ('CHECKIN', 'QUEST', 'CAMPAIGN', 'REFERRAL', 'EVENT', 'ADMIN')
  ),
  -- The row that earned this one: a check-in date, a quest progress key, a campaign id. NULL only where
  -- no such row exists — an admin's hand-held grant — and the unique index below deliberately ignores
  -- those so one operator correcting two accounts is not treated as a duplicate.
  source_id   TEXT,
  reason      VARCHAR(200)       NOT NULL CHECK (reason ~ '\S'),
  granted_by  UUID               REFERENCES admins (id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ        NOT NULL,
  created_at  TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ        NOT NULL DEFAULT now(),
  CHECK (remaining = amount - spent - lapsed),
  -- Alive while there is something left to spend, and dead for one of three named reasons. A grant with
  -- nothing remaining and status ACTIVE is the drift this prevents.
  CHECK ((status = 'ACTIVE') = (remaining > 0)),
  CHECK (expires_at > created_at)
);

-- The spend order: everything still alive for one member, nearest its expiry first.
CREATE INDEX IF NOT EXISTS promo_grant_spend_idx
  ON promo_grants (user_id, expires_at) WHERE status = 'ACTIVE';
-- The lapse sweep, which must not read grants that are already dead.
CREATE INDEX IF NOT EXISTS promo_grant_expiry_idx
  ON promo_grants (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS promo_grant_user_recent_idx
  ON promo_grants (user_id, created_at DESC);

-- A retried reward grants once. Partial because `source_id IS NULL` is a real state (an admin's
-- correction) and two of them must coexist.
CREATE UNIQUE INDEX IF NOT EXISTS promo_grant_source_uq
  ON promo_grants (source_kind, source_id) WHERE source_id IS NOT NULL;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS promo_grants_updated_at ON promo_grants;
  CREATE TRIGGER promo_grants_updated_at BEFORE UPDATE ON promo_grants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE promo_grants IS
  'Promotional diamond awards, one row per grant, each with its own expiry and its own remaining amount. Purchased diamonds are not recorded here.';
COMMENT ON COLUMN promo_grants.expires_at IS
  'When unspent remainder dies. The sweep in promo-diamond.service sets status LAPSED and releases the liability; a grant already partly spent keeps its spent history either way.';
COMMENT ON COLUMN promo_grants.source_kind IS
  'Which reward wrote this grant. Closed list: each value names a hook in this backend, so a new reward type is a migration plus a hook rather than free text.';

-- ---------------------------------------------------------------------------
-- promo_grant_spends — which grant paid for which transaction
--
-- The alternative is to decrement grants in a loop and remember nothing, and that loses two things the
-- money path needs: a refund cannot put coins back on the grant that paid them (and a grant whose
-- expiry has passed must not be topped up), and "how much of this gift was bonus money" becomes
-- unanswerable. One row per (grant, transaction), so a replayed spend cannot double-consume.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS promo_grant_spends (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id       UUID        NOT NULL REFERENCES promo_grants (id) ON DELETE RESTRICT,
  -- RESTRICT on purpose: a ledger row a member spent bonus coins against is evidence, and deleting it
  -- would silently return the grant's remainder to life.
  transaction_id UUID        NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  diamonds       INT         NOT NULL CHECK (diamonds > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (grant_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS promo_grant_spend_tx_idx
  ON promo_grant_spends (transaction_id);

COMMENT ON TABLE promo_grant_spends IS
  'How much of one transaction''s diamond spend came off one promotional grant. The receipt a refund reads.';

-- ---------------------------------------------------------------------------
-- the two accounts a promotional coin needs
--
-- A grant mints a coin the platform owes, funded by nobody, so it is an expense the moment it lands —
-- booked at the same `accounts.coinValue` face value every other coin flow uses. A grant that dies
-- unspent releases that liability, which is income the platform keeps and a member did not receive;
-- naming it separately from PLATFORM_REVENUE is what keeps a campaign's unspent budget out of the
-- figures an operator reads as "coin takes".
-- ---------------------------------------------------------------------------

INSERT INTO fin_accounts (code, name, kind, currency, normal_side) VALUES
  ('PROMO_EXPENSE', 'Promotional coin expense', 'EXPENSE', 'pkr', 'DEBIT'),
  ('PROMO_LAPSED',  'Promotional coins lapsed unspent', 'REVENUE', 'pkr', 'CREDIT')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- purpose accounts may now point at the second balance
--
-- 0029 fixed the legal `balance_source` values by CHECK, so a PROMOTIONAL account owned by a member
-- could not exist without this. It stays a projection: the account names the balance and reads it, and
-- `users.promo_diamond_balance` remains authoritative for the number.
-- ---------------------------------------------------------------------------

ALTER TABLE fin_accounts DROP CONSTRAINT IF EXISTS purpose_account_source_known;
ALTER TABLE fin_accounts ADD CONSTRAINT purpose_account_source_known CHECK (
  balance_source IN (
    'fin_journal_lines',
    'users.diamond_balance',
    'users.r_coin_balance',
    'users.promo_diamond_balance',
    'commission_entries'
  )
);

-- ---------------------------------------------------------------------------
-- the dial
--
-- Expiry is a platform default the operator owns, not a constant in a service, because a campaign
-- brief that says "valid 7 days" is a number somebody has to be able to change without a release.
-- `usableFor` is the usage restriction §1 asks for: which spends bonus coins may pay for. It is a
-- closed list of the four spend paths in this backend, and a path missing from it is refused at the
-- guard rather than filtered in the UI.
-- ---------------------------------------------------------------------------

INSERT INTO system_config (key, value, description) VALUES
  ('promo.diamonds',
   '{"defaultExpiryDays": 30, "usableFor": ["GIFT", "BOX", "STORE", "GAME"]}'::jsonb,
   'How long a promotional grant lives when the awarding code does not say, and which of the four diamond spends it may pay for.')
ON CONFLICT (key) DO NOTHING;
