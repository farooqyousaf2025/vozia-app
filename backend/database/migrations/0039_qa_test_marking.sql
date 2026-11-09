-- QA marking: test accounts, and the money they touch.
--
-- The delivery brief asks for two things that pull in opposite directions: test accounts and test
-- transactions must be unmistakable in the backend record, and the people testing must appear in
-- the app under their real approved display names. So the marker lives beside the identity, never
-- inside it: `is_test` says "this row belongs to the QA programme", `qa_ref` is the internal
-- identifier the QA team tracks (country/role/cohort), and `username` / `display_name` / `name`
-- keep holding what a member or partner is actually called. Nothing here renames anybody.
--
-- Why the money rows carry no flag of their own
-- -------------------------------------------
-- The obvious design is `is_test` on transactions, payment_proofs, recharge_orders and the rest,
-- copied from the owner at insert. It is wrong for this product, because accounts get marked
-- *after* they have transacted — that is exactly what happens when a demo account is adopted into
-- the QA programme. A copied flag would leave every earlier row looking like production money, and
-- the only way to repair it would be to rewrite financial history.
--
-- So the marking is derived, once, in `qa_money_marking`: a money row is test activity when any
-- account it belongs to is test activity. It cannot drift, it needs no trigger, and it answers
-- retroactively the moment an account is marked. The cost is a join per read, which is why the
-- identity tables get a partial index on the flag.
--
-- The acting operator is deliberately NOT an owner for this purpose. A QA-flagged admin who
-- approves a real partner's withdrawal has not made that withdrawal test money — the money still
-- belongs to the partner. Who acted is the audit log's job (`admin_audit`), not the marker's.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Identity marking
--
-- The CHECK is the point of `qa_ref`: a test account that nobody can name is a test account that
-- will be mistaken for a real one in six months. Marking one without an internal reference is
-- refused by the database, not by a form validation that a script can skip.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qa_ref  VARCHAR(40);

ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qa_ref  VARCHAR(40);

ALTER TABLE business_accounts
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qa_ref  VARCHAR(40);

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qa_ref  VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_test_needs_ref') THEN
    ALTER TABLE users ADD CONSTRAINT users_test_needs_ref CHECK (NOT is_test OR qa_ref IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_test_needs_ref') THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_test_needs_ref CHECK (NOT is_test OR qa_ref IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_accounts_test_needs_ref') THEN
    ALTER TABLE business_accounts ADD CONSTRAINT business_accounts_test_needs_ref CHECK (NOT is_test OR qa_ref IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_test_needs_ref') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_test_needs_ref CHECK (NOT is_test OR qa_ref IS NOT NULL);
  END IF;
END $$;

-- A reference is never reused, so "PK-HOST-01" means one account for the life of the programme.
-- Partial, because the overwhelming majority of rows are production and hold no reference at all.
CREATE UNIQUE INDEX IF NOT EXISTS users_qa_ref_idx             ON users (qa_ref)             WHERE qa_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agencies_qa_ref_idx          ON agencies (qa_ref)          WHERE qa_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS business_accounts_qa_ref_idx ON business_accounts (qa_ref) WHERE qa_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admins_qa_ref_idx            ON admins (qa_ref)            WHERE qa_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_test_idx             ON users (is_test)             WHERE is_test;
CREATE INDEX IF NOT EXISTS agencies_test_idx          ON agencies (is_test)          WHERE is_test;
CREATE INDEX IF NOT EXISTS business_accounts_test_idx ON business_accounts (is_test) WHERE is_test;
CREATE INDEX IF NOT EXISTS admins_test_idx            ON admins (is_test)            WHERE is_test;

COMMENT ON COLUMN users.is_test IS
  'QA programme account. Derived money marking lives in qa_money_marking; production reports exclude these by default.';
COMMENT ON COLUMN users.qa_ref IS
  'Internal QA identifier (e.g. PK-HOST-01). Admin-only: never shown in the member app, which displays username.';

-- ---------------------------------------------------------------------------
-- qa_identities — one roster across the four kinds of account.
--
-- `country` is the market the account was opened for, where the schema records one. It is NULL for
-- agencies and admins because those tables have no country column; the brief is explicit that a
-- selected country does not establish legal residence, so this is a QA cohort label and nothing
-- more. `display_name` is what the app shows — the real approved name, not the reference.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW qa_identities AS
  SELECT 'USER'::text     AS owner_kind, id AS owner_id, is_test, qa_ref,
         username         AS display_name, country_code AS country, created_at
    FROM users
  UNION ALL
  SELECT 'BUSINESS'::text, id, is_test, qa_ref,
         display_name, market_country, created_at
    FROM business_accounts
  UNION ALL
  SELECT 'AGENCY'::text, id, is_test, qa_ref,
         name, NULL::varchar, created_at
    FROM agencies
  UNION ALL
  SELECT 'ADMIN'::text, id, is_test, qa_ref,
         COALESCE(display_name, username), NULL::varchar, created_at
    FROM admins;

COMMENT ON VIEW qa_identities IS
  'Every account that can be marked as QA, in one roster. display_name is the real approved name; qa_ref is the internal identifier.';

-- ---------------------------------------------------------------------------
-- qa_money_marking — which money rows are test activity.
--
-- One row per financial record, with `is_test` true when any account it belongs to is marked, and
-- `test_refs` naming those accounts so a report can say *whose* test it was. Owner ids are globally
-- unique UUIDs across users / business_accounts / agencies, so joining on the id alone cannot
-- confuse a member with a partner.
--
-- Journal entries need both halves of the answer. Their *lines* post to platform accounts
-- (COIN_LIABILITY, the tax and commission accounts), which have no owner at all — reading only the
-- lines would call every gift's journal entry production money even when a QA account sent the
-- gift. So the entry also inherits from the row its `source_id` names: the transaction, proof,
-- order, grant, withdrawal or settlement it was posted for. That id is either a bare UUID or
-- `prefix:UUID` (a reversal names `commission:<id>`), so the last 36 characters are taken and
-- UUID-checked before the cast. Looking it up in `money_owners` rather than switching on
-- `source_kind` means a new financial table joins the marking by being added to that CTE, with no
-- second list of kinds to keep in step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW qa_money_marking AS
WITH money_owners AS (
  SELECT 'transactions'::text AS source_table, t.id AS source_id, t.created_at AS occurred_at,
         ARRAY_REMOVE(ARRAY[t.sender_id, t.receiver_id, t.agency_id], NULL) AS owner_ids
    FROM transactions t
  UNION ALL
  SELECT 'payment_proofs', p.id, p.created_at, ARRAY_REMOVE(ARRAY[p.user_id], NULL)
    FROM payment_proofs p
  UNION ALL
  SELECT 'recharge_orders', o.id, o.created_at, ARRAY_REMOVE(ARRAY[o.user_id, o.seller_id, o.bd_id], NULL)
    FROM recharge_orders o
  UNION ALL
  SELECT 'withdrawal_requests', w.id, w.created_at, ARRAY_REMOVE(ARRAY[w.user_id], NULL)
    FROM withdrawal_requests w
  UNION ALL
  SELECT 'promo_grants', g.id, g.created_at, ARRAY_REMOVE(ARRAY[g.user_id], NULL)
    FROM promo_grants g
  UNION ALL
  SELECT 'earning_payouts', e.id, e.created_at, ARRAY_REMOVE(ARRAY[e.user_id], NULL)
    FROM earning_payouts e
  UNION ALL
  SELECT 'commission_entries', c.id, c.created_at, ARRAY_REMOVE(ARRAY[c.beneficiary_id], NULL)
    FROM commission_entries c
  UNION ALL
  SELECT 'commission_settlements', s.id, s.created_at, ARRAY_REMOVE(ARRAY[s.beneficiary_id], NULL)
    FROM commission_settlements s
  UNION ALL
  SELECT 'agency_settlements', a.id, a.created_at, ARRAY_REMOVE(ARRAY[a.agency_id], NULL)
    FROM agency_settlements a
  UNION ALL
  -- A game settlement is keyed by its session, and the money belongs to everyone who sat at it.
  SELECT 'game_settlements', gs.session_id, gs.settled_at,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT gp.user_id), NULL)
    FROM game_settlements gs
    LEFT JOIN game_participants gp ON gp.session_id = gs.session_id
   GROUP BY gs.session_id, gs.settled_at
),
journal_account_owners AS (
  SELECT j.id, ARRAY_REMOVE(ARRAY_AGG(DISTINCT f.owner_id), NULL) AS owner_ids
    FROM fin_journal_entries j
    LEFT JOIN fin_journal_lines l ON l.entry_id = j.id
    LEFT JOIN fin_accounts f      ON f.code = l.account_code
   GROUP BY j.id
),
journal_source_owners AS (
  SELECT j.id, ARRAY_REMOVE(ARRAY_AGG(o.owner_id), NULL) AS owner_ids
    FROM fin_journal_entries j
    JOIN money_owners mo
      ON mo.source_id = CASE
           WHEN RIGHT(j.source_id, 36) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN RIGHT(j.source_id, 36)::uuid
         END
    JOIN LATERAL unnest(mo.owner_ids) AS o(owner_id) ON true
   GROUP BY j.id
),
owners AS (
  SELECT source_table, source_id, occurred_at, owner_ids FROM money_owners
  UNION ALL
  SELECT 'fin_journal_entries', j.id, j.occurred_at,
         COALESCE(jao.owner_ids, '{}'::uuid[]) || COALESCE(jso.owner_ids, '{}'::uuid[])
    FROM fin_journal_entries j
    LEFT JOIN journal_account_owners jao ON jao.id = j.id
    LEFT JOIN journal_source_owners  jso ON jso.id = j.id
)
SELECT o.source_table,
       o.source_id,
       o.occurred_at,
       COALESCE(BOOL_OR(i.is_test), false) AS is_test,
       COALESCE(ARRAY_AGG(i.qa_ref ORDER BY i.qa_ref) FILTER (WHERE i.is_test), '{}'::varchar[]) AS test_refs
  FROM owners o
  LEFT JOIN LATERAL unnest(o.owner_ids) AS oid ON true
  LEFT JOIN qa_identities i ON i.owner_id = oid
 GROUP BY o.source_table, o.source_id, o.occurred_at;

COMMENT ON VIEW qa_money_marking IS
  'Derived test marking for every financial record. True when any owning account is QA-marked; never stored, so marking an account reclassifies its history without rewriting it.';

-- The read the reports and the QA export actually run: production money only.
CREATE OR REPLACE VIEW qa_production_money AS
  SELECT source_table, source_id, occurred_at
    FROM qa_money_marking
   WHERE NOT is_test;