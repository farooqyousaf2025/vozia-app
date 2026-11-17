-- 0042 — the cash a coin seller holds is the seller's debt, not the platform's collection.
--
-- Settled with the user on 2026-11-09: a member buys coins from a coin seller and sells R-coins to
-- one, and the cash moves out of the seller's own pocket, outside the app. 0041 gave that
-- settlement its document; this gives it its account. Until now `creditOrder` debited
-- PROVIDER_COLLECTIONS — "Money held by the payment provider" (0004) — for rupees the seller is
-- holding, so the book claimed an asset nobody had handed over, and the seller's commission sat
-- beside it as an expense the platform would pay from a bank account that cash never reached.
--
-- The seller is an agent: they collect on the platform's behalf and keep their commission out of
-- what they collected. Three consequences, and nothing else changes:
--
--   * SELLER_RECEIVABLE (ASSET) is what sellers hold for the platform. A credited order debits it
--     instead of PROVIDER_COLLECTIONS, a reversal credits it back, and a SELLER commission batch
--     credits it — the seller keeps that money rather than receiving a transfer for it. The batch
--     nets when finance prepares it, which is the moment its entries turn SETTLED and the payable
--     is released, so the receivable and `commission_entries` never disagree about what is owed.
--   * PROVIDER_COLLECTIONS stays what its name says. A Stripe settlement (COIN_ISSUANCE) and a BD
--     commission batch still use it: a BD manager holds no cash, so paying one is a real outflow.
--   * The coin side does not move. COIN_LIABILITY is still credited the gross on every order, so
--     `recharge.credited_has_journal` and `recharge.issued_has_journal` keep their meaning; only
--     the asset account changed, and the entries still balance line for line.
--
-- The commission ceiling makes the netting safe rather than hopeful: 0004's trigger refuses an
-- accrual that would push an order's total commission above what that order collected, so a
-- seller's payable can never exceed the receivable it is settled against.
--
-- The sell side is deliberately NOT priced here. A member's R-coin sale to a seller is a
-- withdrawal_requests row (0041) whose cash is handed over at a rate agreed outside the platform;
-- `payWithdrawal` has always refused to price external cash, and inventing a rate to net it against
-- the receivable would put a number in the book that nobody agreed to. It appears on the seller's
-- statement in R-coins beside the money lines, and the statement says which is which.
--
-- Restatement: lines already written under the old account are corrected rather than left to
-- disagree with the new ones. Every UPDATE below is scoped to entries that are provably a seller's
-- — a RECHARGE_ORDER, a REVERSAL of one, or a SETTLEMENT whose batch names beneficiary SELLER — so
-- agency settlements and Stripe issuances keep PROVIDER_COLLECTIONS. Idempotent: after the first
-- run the WHERE clause matches nothing.

INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, balance_source)
VALUES ('SELLER_RECEIVABLE', 'Cash a coin seller collected for the platform', 'ASSET', 'pkr', 'DEBIT',
        'PENDING_SETTLEMENT', 'fin_journal_lines')
ON CONFLICT (code) DO NOTHING;

-- A credited seller order: the asset is what that seller owes, not what a provider holds.
UPDATE fin_journal_lines l
   SET account_code = 'SELLER_RECEIVABLE'
  FROM fin_journal_entries e
 WHERE l.entry_id = e.id
   AND e.source_kind = 'RECHARGE_ORDER'
   AND l.account_code = 'PROVIDER_COLLECTIONS'
   AND l.direction = 'DEBIT';

-- Its reversal hands the money back through the same seller.
UPDATE fin_journal_lines l
   SET account_code = 'SELLER_RECEIVABLE'
  FROM fin_journal_entries e
 WHERE l.entry_id = e.id
   AND e.source_kind = 'REVERSAL'
   AND l.account_code = 'PROVIDER_COLLECTIONS'
   AND l.direction = 'CREDIT'
   AND EXISTS (SELECT 1 FROM recharge_orders o WHERE e.source_id = 'order:' || o.id::text);

-- A seller's commission batch is kept out of the cash they already hold.
UPDATE fin_journal_lines l
   SET account_code = 'SELLER_RECEIVABLE'
  FROM fin_journal_entries e
  JOIN commission_settlements cs ON cs.id::text = e.source_id
 WHERE l.entry_id = e.id
   AND e.source_kind = 'SETTLEMENT'
   AND cs.beneficiary = 'SELLER'
   AND l.account_code = 'PROVIDER_COLLECTIONS'
   AND l.direction = 'CREDIT';