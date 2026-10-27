-- 0008_recharge_packages.sql — the catalog a coin seller is allowed to sell (§22).
--
-- §22 makes the package list and the price an administrator owns, not the client and not the
-- seller: "Configure which recharge packages a seller may sell". Until now the platform had no
-- package rows at all — a top-up was any diamond count the caller typed — so a seller could
-- have priced coins themselves. These tables make "this many coins for this much money, at
-- this rate, sold by this partner" a lookup the backend performs.
--
-- `fee_bps` is the expected payment-rail cost of the package. Commission is paid on the
-- eligible net value, so the platform must know the fee before it can promise a rate.

DO $$ BEGIN
  ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'RECHARGE_REVERSAL';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recharge_packages (
  key          VARCHAR(48) PRIMARY KEY,
  label        VARCHAR(80)  NOT NULL,
  diamonds     INT          NOT NULL CHECK (diamonds > 0),
  amount_cents BIGINT       NOT NULL CHECK (amount_cents >= 0),
  currency     VARCHAR(3)   NOT NULL DEFAULT 'pkr',
  -- Share of the collection the payment rail keeps, in basis points. Manual rails (cash, bank
  -- transfer) are 0; a card or wallet rail is not.
  fee_bps      INT          NOT NULL DEFAULT 0 CHECK (fee_bps >= 0 AND fee_bps <= 10_000),
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Empty allowlist for a seller means "whatever is active"; a non-empty one is the exact set
-- the finance team agreed this partner may move. Explicit either way, so a report can say
-- which sellers are restricted and which are not.
CREATE TABLE IF NOT EXISTS recharge_package_sellers (
  package_key         VARCHAR(48) NOT NULL REFERENCES recharge_packages (key) ON DELETE CASCADE,
  business_account_id UUID        NOT NULL REFERENCES business_accounts (id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_key, business_account_id)
);

CREATE INDEX IF NOT EXISTS recharge_package_seller_idx ON recharge_package_sellers (business_account_id);

-- A posted recharge row and a posted clawback row are both permanent, so the reversal needs
-- its own transaction type rather than an ADMIN_ADJUSTMENT that would be indistinguishable
-- from a discretionary correction in an audit.
DROP TRIGGER IF EXISTS recharge_packages_updated_at ON recharge_packages;
CREATE TRIGGER recharge_packages_updated_at BEFORE UPDATE ON recharge_packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Prices in PKR minor units (paisa). Roughly Rs 20 per diamond, with the bulk tiers carrying a
-- small volume discount — the shape the platform intends to sell, not a hardcoded rate in code.
INSERT INTO recharge_packages (key, label, diamonds, amount_cents, currency, fee_bps) VALUES
  ('PKR_250',   'Starter 125',      125,    25_000, 'pkr', 0),
  ('PKR_500',   'Starter 260',      260,    50_000, 'pkr', 0),
  ('PKR_1000',  'Popular 550',      550,   100_000, 'pkr', 0),
  ('PKR_2000',  'Value 1150',      1150,   200_000, 'pkr', 0),
  ('PKR_5000',  'Pro 3000',        3000,   500_000, 'pkr', 0),
  ('PKR_10000', 'Whale 6500',      6500, 1_000_000, 'pkr', 0)
ON CONFLICT (key) DO NOTHING;
