-- 0048 — Diamond packages: the top-up catalogue is server data, not a release.
--
-- The wallet used to draw four hard-coded chips (100 / 500 / 1,000 / 5,000) and post a free
-- `amountDiamonds` to the demo recharge endpoint. An operator cannot run a bonus, change a
-- price, or retire a pack without shipping a new APK. This table is the catalogue the app
-- reads, and the id — not the diamond count — is what the checkout endpoint accepts, so a
-- client cannot invent a price.
--
-- Money is stored in minor units of `currency` (`price_cents` is cents for USD), the same
-- unit Stripe takes. `bonus_diamonds` is credited *in addition* to `diamonds` and is still a
-- purchased balance: it is what the package advertises, not a promotional grant.

CREATE TABLE IF NOT EXISTS diamond_packages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name           VARCHAR(80) NOT NULL,
  diamonds       INTEGER NOT NULL CHECK (diamonds > 0),
  bonus_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (bonus_diamonds >= 0),
  price_cents    INTEGER NOT NULL CHECK (price_cents > 0),
  currency       CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  active         BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS diamond_packages_updated_at ON diamond_packages;
CREATE TRIGGER diamond_packages_updated_at BEFORE UPDATE ON diamond_packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS diamond_packages_active_idx
  ON diamond_packages (active, sort_order, diamonds);

-- The four packs the product brief names. Prices follow the default 10 cents/diamond so the
-- catalogue and the legacy `amountDiamonds` checkout quote the same money. ON CONFLICT keeps
-- an operator's edited row when this file is replayed on a clone that already has them.
INSERT INTO diamond_packages (code, name, diamonds, bonus_diamonds, price_cents, currency, sort_order)
VALUES
  ('starter-100',  'Starter',  100,  0,   1000, 'USD', 10),
  ('popular-500',  'Popular',  500,  0,   5000, 'USD', 20),
  ('value-1000',   'Value',   1000,  0,  10000, 'USD', 30),
  ('mega-5000',    'Mega',    5000,  0,  50000, 'USD', 40)
ON CONFLICT (code) DO NOTHING;
