-- 0031 — the coin face value, and the revenue the gift and game paths already took.
--
-- Two money paths have always kept a cut and never said so in the book. A gift takes diamonds from
-- a sender and banks R-coins to a receiver in the same ledger row, and the difference — the catalogue
-- spread on a flat gift, the drawn tax on a lucky box — is the platform's. A settled game keeps the
-- entry fees it never hands back, which is its commission plus whatever the prize ladder did not
-- distribute. Both moved coins and neither was ever worth a journal line, which is why
-- `GET /api/admin/accounts/reconcile` reported the platform's revenue account as empty while the
-- ledger showed millions of diamonds spent.
--
-- Booking a coin spread in a money book needs a money value for a coin, and the platform had exactly
-- one: `STRIPE_CENTS_PER_DIAMOND`, which lives inside the payment provider's configuration and only
-- describes what a top-up pack costs. So the rate moves to `system_config`, where the rest of the
-- money switches already live (0029 seeded the withdrawal and promotional ones the same way), with
-- its default set to the value the code hardcodes today. One row, one number, and both this backfill
-- and the write path read it — which is the only reason a SQL migration is allowed to state an amount
-- in minor units at all.
--
-- `0` is a meaningful value: it says the book does not value coins, and the writers then post nothing
-- rather than inventing a rate. The reconciler reports those rows as unbooked rather than swallowing
-- the gap.

INSERT INTO system_config (key, value, description) VALUES
  ('accounts.coinValue',
   '{"minorPerCoin": 10}'::jsonb,
   'What one coin is worth in minor units when the finance book values a gift spread or a game pool. Defaults to STRIPE_CENTS_PER_DIAMOND; 0 stops the book valuing coins at all.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Every completed gift and every settled game that is missing its entry gets one, at the rate seeded
-- above, so the revenue account describes the platform's whole history instead of today onward — and
-- so the reconciler's new coverage check starts from a book that is actually closed. Idempotent twice
-- over: the UNIQUE (source_kind, source_id) index rejects a second entry for a row, and the `missing`
-- CTE only walks rows that have none.
--
-- A spread is booked as three lines on the entry: the diamond liability the sender's coins released
-- (DEBIT), the coin liability the receiver's credits minted (CREDIT), and the difference as revenue
-- on whichever side it falls. A box that rolled a 20x tail pays out more than the pool its price
-- bought, and that is a loss — so the revenue line is a DEBIT, not a dropped line. Dropping it would
-- report the platform as having kept a spread it actually paid.
-- ---------------------------------------------------------------------------
WITH rate AS (
  SELECT COALESCE(
           (SELECT (value->>'minorPerCoin')::BIGINT FROM system_config WHERE key = 'accounts.coinValue'),
           0
         ) AS minor
),
src AS (
  SELECT 'GIFT_TAX'::VARCHAR(24) AS kind,
         t.id::TEXT              AS source_id,
         t.amount_diamonds * r.minor AS released_minor,
         t.amount_r_coins  * r.minor AS minted_minor,
         (t.amount_diamonds - t.amount_r_coins) * r.minor AS spread_minor,
         left('Gift spread from ledger row ' || t.reference, 300) AS memo
    FROM transactions t, rate r
   WHERE t.type = 'GIFT_SENT'
     AND t.status = 'COMPLETED'
     AND r.minor > 0
     AND t.amount_diamonds <> t.amount_r_coins
   UNION ALL
  SELECT 'GAME_TAKE',
         gs.session_id::TEXT,
         gs.gross_pool * r.minor,
         gs.distributed * r.minor,
         (gs.gross_pool - gs.distributed) * r.minor,
         left('Game pool kept by ' || gs.game_key || ' session ' || gs.session_id, 300)
    FROM game_settlements gs, rate r
   WHERE gs.status = 'SETTLED'
     AND r.minor > 0
     AND gs.gross_pool <> gs.distributed
),
missing AS (
  SELECT s.*
    FROM src s
   WHERE NOT EXISTS (
     SELECT 1 FROM fin_journal_entries e
      WHERE e.source_kind = s.kind AND e.source_id = s.source_id
   )
),
entries AS (
  INSERT INTO fin_journal_entries (reference, source_kind, source_id, memo, currency)
       SELECT 'JR-BF-' || substr(md5(m.kind || m.source_id), 1, 24), m.kind, m.source_id, m.memo, 'pkr'
         FROM missing m
  RETURNING id, source_kind, source_id
)
INSERT INTO fin_journal_lines (entry_id, account_code, direction, amount_cents, currency)
       SELECT e.id, 'COIN_LIABILITY', 'DEBIT'::fin_direction, m.released_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.released_minor > 0
       UNION ALL
       SELECT e.id, 'COIN_LIABILITY', 'CREDIT'::fin_direction, m.minted_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.minted_minor > 0
       UNION ALL
       SELECT e.id, 'PLATFORM_REVENUE', 'CREDIT'::fin_direction, m.spread_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.spread_minor > 0
       UNION ALL
       SELECT e.id, 'PLATFORM_REVENUE', 'DEBIT'::fin_direction, -m.spread_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.spread_minor < 0;
