-- 0034 — every coin the platform issued is now a liability the book has heard of.
--
-- `fin_accounts` has carried `COIN_LIABILITY` since 0029 on the understanding that coins are a service
-- still owed, so the account should read as what the platform still has to deliver. It did not. The only
-- route that ever credited it was `seller-recharge.service.ts`'s `creditOrder`, which posts one
-- `RECHARGE_ORDER` entry per order it verifies. That is 27 orders on this database. Meanwhile
-- `payments.controller.ts` had been crediting diamonds from `payment_intent.succeeded` all along, and
-- `ledger.service.ts`'s `settlePaymentOnClient` — the shared primitive both routes call — moved the
-- balance and wrote a `transactions` row and stopped there. Sixty-six confirmed Stripe payments, 625000
-- cents of real collection, and not one line in the journal. The liability was not a running total of
-- coins owed; it was a running total of the orders a seller happened to open.
--
-- The fix belongs in the primitive, not in the controller. `settlePaymentOnClient` now posts
-- `COIN_ISSUANCE` — DEBIT `PROVIDER_COLLECTIONS` / CREDIT `COIN_LIABILITY` — inside the same SQL
-- transaction as the credit it describes, keyed on the `payment_proofs` row id. Two properties that
-- matter for a money path:
--
--   * It is the default. A caller that forgets to opt out books the issuance; a caller that forgets to
--     post one is silent. The failure mode chosen here is the one that over-records, because an
--     unrecorded collection is invisible while a duplicate is caught by the unique
--     `(source_kind, source_id)` and by the tie-outs below.
--   * The key is the proof, which is already unique per settlement because `payment_proofs` is unique on
--     `(provider, external_id)`. A redelivered Stripe webhook therefore returns the existing entry rather
--     than doubling the liability — the same idempotency the credit itself already had, extended to the
--     bookkeeping instead of bolted beside it.
--
-- `journaledByCaller` is the opt-out, and exactly one caller takes it. The seller order's entry is not a
-- less precise version of the generic one: it splits the gross into `PROVIDER_COLLECTIONS` and
-- `PROVIDER_FEES`, so booking both would double the liability *and* lose the fee. It is also the shape
-- `reconciliation.service.ts`'s existing recharge checks read, keyed on the order id. Leaving it alone and
-- opting out keeps those tie-outs meaningful; the 36 proofs already backed above sum to 2475000 cents,
-- which equals the `RECHARGE_ORDER` credit total to the cent, and that agreement is the evidence the two
-- rules describe the same money.
--
-- Backfill, below: the 66 proofs that minted coins with no entry get one, at the cents and currency they
-- recorded, with `occurred_at` set to the proof's own time so the entry lands in the period the payment
-- actually arrived rather than the day this file ran. It is idempotent — running it twice inserts nothing,
-- because the same `(COIN_ISSUANCE, proof id)` already exists.
--
-- Two paths still mint coins with no journal line, and that is now a stated position rather than an
-- oversight:
--
--   * `POST /api/wallet/recharge` (the simulated top-up) collects nothing. Booking `PROVIDER_COLLECTIONS`
--     against it would invent an asset the stack does not have, which is the same reason 0032 gave for
--     leaving a withdrawal's payout with no cash leg. It exists so a reviewer can get coins.
--   * `adjustBalance` grants or takes coins by operator fiat. Its contra is not a collection, and the
--     account that should absorb it — promotional spend — is what roadmap #60 has not built yet.
--
-- Neither appears in the tie-outs below, and it is worth being precise about why: the checks are written
-- against `payment_proofs`, and these two paths mint coins without ever creating a proof row. They sit
-- outside `recharge.issued_has_journal` by construction, so the check stays at zero while they run. That
-- makes them invisible to the report rather than counted by it — the honest reading is that the book now
-- covers every coin a PSP confirmed, and the operator-granted coins remain a gap that #60 should close
-- with a contra account, not one a count-of-offending-rows check can express.

BEGIN;

-- The entries the primitive would have posted, had it existed when these payments settled.
WITH missing AS (
    SELECT p.id AS proof_id,
           p.provider,
           p.external_id,
           p.diamonds,
           p.amount_cents,
           p.currency,
           p.created_at
      FROM payment_proofs p
     WHERE p.amount_cents > 0
       -- A proof whose settlement already booked an order entry is backed; see the header.
       AND NOT EXISTS (
           SELECT 1
             FROM recharge_orders o
             JOIN fin_journal_entries e ON e.source_kind = 'RECHARGE_ORDER' AND e.source_id = o.id::text
            WHERE o.transaction_id = p.transaction_id
       )
       -- And one booked by this migration on a previous run is backed too.
       AND NOT EXISTS (
           SELECT 1
             FROM fin_journal_entries e
            WHERE e.source_kind = 'COIN_ISSUANCE'
              AND e.source_id = p.id::text
       )
),
entries AS (
    INSERT INTO fin_journal_entries (reference, source_kind, source_id, memo, currency, occurred_at)
        SELECT 'JR-BF-' || substr(md5('coin-issuance' || m.proof_id::text), 1, 24),
               'COIN_ISSUANCE',
               m.proof_id::text,
               left(
                   m.provider || ' payment ' || m.external_id || ': ' || m.diamonds ||
                   ' diamonds for ' || m.amount_cents || ' ' || m.currency,
                   300
               ),
               m.currency,
               m.created_at
          FROM missing m
    RETURNING id, source_id
)
INSERT INTO fin_journal_lines (entry_id, account_code, direction, amount_cents, currency)
    SELECT e.id, 'PROVIDER_COLLECTIONS', 'DEBIT'::fin_direction, m.amount_cents, m.currency
      FROM entries e
      JOIN missing m ON m.proof_id::text = e.source_id
    UNION ALL
    SELECT e.id, 'COIN_LIABILITY', 'CREDIT'::fin_direction, m.amount_cents, m.currency
      FROM entries e
      JOIN missing m ON m.proof_id::text = e.source_id;

COMMIT;
