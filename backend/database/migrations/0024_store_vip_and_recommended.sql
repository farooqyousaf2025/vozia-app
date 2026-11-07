-- 0024 — A cosmetic can ask for a rank, and can be pointed at.
--
-- The store sells to everybody equally: `for_sale` plus a price is the only gate, so a 20,000-diamond
-- ring sits in the same grid as a 200-diamond one, and the only thing separating a whale's purchase
-- from a new member's is the number they can see. The gift catalogue already solved the equivalent
-- problem — `gifts.min_vip_level` is compared against `users.vip_level` inside the ledger's locks,
-- before the balance is read, so a rank tier is a spend gate rather than a display hint. This
-- migration gives the three cosmetic catalogues the same lever.
--
-- The second column answers a different question. A store with no editorial voice shows a grid and
-- leaves the member to choose; Tingle's console gets clicks out of a "recommended" rail. So an
-- operator can flag a row as worth pointing at, and the app can put it first. It is a display
-- decision stored next to the art it decorates, exactly the way `sort_order` already is — it changes
-- nothing about ownership, price or expiry, and it is deliberately not a ranking algorithm.

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------
--
-- The bounds mirror `users.vip_level`'s own CHECK (`BETWEEN 0 AND 20`): a row asking for level 21
-- could never be bought by anybody, and Postgres would be the only place that noticed. Requiring the
-- buyer's *account* rank — not their wallet — is what makes this a tier rather than a price: two
-- members with identical balances get different stores, which is the point of a loyalty ladder.
--
-- `recommended` has no CHECK because there is nothing to be wrong about; false is the honest default
-- for every row that already exists, so seeding it is not needed and no current item suddenly jumps
-- to the top of a grid.

ALTER TABLE profile_frames
  ADD COLUMN IF NOT EXISTS min_vip_level SMALLINT NOT NULL DEFAULT 0 CHECK (min_vip_level BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS recommended   BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE room_themes
  ADD COLUMN IF NOT EXISTS min_vip_level SMALLINT NOT NULL DEFAULT 0 CHECK (min_vip_level BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS recommended   BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE visual_effects
  ADD COLUMN IF NOT EXISTS min_vip_level SMALLINT NOT NULL DEFAULT 0 CHECK (min_vip_level BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS recommended   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profile_frames.min_vip_level IS 'Lowest users.vip_level allowed to BUY this frame. 0 = anybody. Checked in store.purchaseItem before the debit; a rank that drops later does not revoke what was already bought, and equipping stays ungated so an admin grant remains usable.';
COMMENT ON COLUMN room_themes.min_vip_level IS 'Lowest users.vip_level allowed to buy the theme. Ownership is account-wide; which room wears it is still the host''s choice, set per room.';
COMMENT ON COLUMN visual_effects.min_vip_level IS 'Lowest users.vip_level allowed to buy this WELCOME flourish. AMBIENT loops are priced at zero and sold nowhere, so the column is inert on those rows.';
COMMENT ON COLUMN profile_frames.recommended IS 'true = the app may surface this frame in a "recommended" rail or above the grid. Cosmetic only: no price, ownership or expiry consequence.';
COMMENT ON COLUMN room_themes.recommended IS 'true = an operator wants this look pointed at in the theme picker. Cosmetic only.';
COMMENT ON COLUMN visual_effects.recommended IS 'true = an operator wants this flourish pointed at in the store. Cosmetic only.';
