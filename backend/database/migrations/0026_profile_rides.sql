-- 0026 — How a member arrives in a room becomes something they own.
--
-- A WELCOME effect (0015, priced by 0019) is a flourish: a burst that plays *behind* the room while
-- the entry banner says who arrived. Every app in this genre also sells the other thing — the
-- cinematic that takes the screen over for a few seconds and carries the member in. Tingle's store
-- calls it a ride, and it is a separate purchase from the flourish: different art, a different
-- renderer, a different budget of the room's attention.
--
-- It gets its own catalogue rather than a third `visual_effects.kind` because `kind` is a hard
-- split in code, not a label: an AMBIENT loop is chosen by room category and can never be sold
-- (`effect_kind_not_sellable`), a WELCOME row is a URL a client plays at its own size, and `deleteEffect`
-- refuses to remove the last row of a kind. A ride is none of those — it is a file with a declared
-- format and a hard ceiling on how long the room hands it the screen, which is exactly the shape the
-- gift animation columns already settled in 0023. The precedent inside this schema is 0019 adding
-- `profile_frames` as its own table for the one thing nothing sold yet, instead of bending a column.
--
-- A ride is also the first cosmetic that needs a *policy* of its own in `media.service`: EFFECT
-- accepts Lottie JSON only, and a ride is routinely a short MP4. Hence the `RIDE` media kind.

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profile_rides (
  key        VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name       VARCHAR(60) NOT NULL,
  -- The same URL rule as every other art column: this string is handed to every device in the room.
  url        TEXT        NOT NULL CHECK (url ~ '^(/|https://)'),
  -- Which renderer the client opens the file with. The bytes decide it at upload (the admin panel
  -- stores what the sniffer said, exactly like `gifts.animation_format`), so a row can only name a
  -- container the `RIDE` media policy will accept.
  format     VARCHAR(6)  NOT NULL DEFAULT 'LOTTIE' CHECK (format IN ('LOTTIE', 'SVGA', 'MP4')),
  -- The operator's answer to "how long does the room stop for this", in the same row as the art.
  -- Bounded by the clamp the client already applies to a gift overlay, so a value that would strand
  -- a full screen behind one member is not storable. 0 defers to the asset's own length — allowed,
  -- but a video that never reports one leaves the client holding that 0.
  duration_ms INTEGER     NOT NULL DEFAULT 0 CHECK (duration_ms = 0 OR duration_ms BETWEEN 250 AND 30_000),
  sort_order INTEGER     NOT NULL DEFAULT 0,
  price_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (price_diamonds >= 0),
  for_sale       BOOLEAN NOT NULL DEFAULT false,
  period_days    SMALLINT CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 3650),
  min_vip_level  SMALLINT NOT NULL DEFAULT 0 CHECK (min_vip_level BETWEEN 0 AND 20),
  recommended    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_rides_priced_if_for_sale
    CHECK ((NOT for_sale AND price_diamonds = 0) OR (for_sale AND price_diamonds > 0))
);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS profile_rides_updated_at ON profile_rides;
  CREATE TRIGGER profile_rides_updated_at BEFORE UPDATE ON profile_rides
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE profile_rides IS 'Full-screen entrance cinematics a member buys and arrives with. Admin-managed; published through the store catalogue and the ride map in GET /api/rooms/themes.';
COMMENT ON COLUMN profile_rides.key IS 'Stable identifier receipts and users.profile_ride_key point at. Renaming is a delete plus an insert, never an UPDATE.';
COMMENT ON COLUMN profile_rides.format IS 'LOTTIE | SVGA | MP4 — which renderer a device hands the URL to, the same three the gift engine routes on.';
COMMENT ON COLUMN profile_rides.duration_ms IS 'How long the room hands the screen to this ride. 0 = the client''s own fallback, because a Lottie that never fires a completion callback would otherwise hold the room forever.';
COMMENT ON COLUMN profile_rides.price_diamonds IS 'Read inside the purchase transaction, never from the request body — the same rule that stops a modified client buying a 20,000-diamond ring for 1.';
COMMENT ON COLUMN profile_rides.min_vip_level IS 'Lowest users.vip_level allowed to BUY this ride. Checked in store.purchaseItem before the debit; equipping stays ungated so an admin grant remains wearable.';
COMMENT ON COLUMN profile_rides.recommended IS 'true = the app may surface this ride in a "recommended" rail or above the grid. Cosmetic only.';

-- ---------------------------------------------------------------------------
-- Ownership: one more thing a receipt can name
-- ---------------------------------------------------------------------------
--
-- `user_items` already keys ownership by (member, kind, item_key), so a ride needs the literal added
-- and nothing else — the UNIQUE, the renewal arithmetic and the expiry sweep all carry on unchanged.
-- The CHECK is dropped and re-added by name because Postgres has no "widen this constraint" statement;
-- the new set is a superset, so every row that existed validates.

ALTER TABLE user_items DROP CONSTRAINT IF EXISTS user_items_kind_check;
ALTER TABLE user_items ADD CONSTRAINT user_items_kind_check
  CHECK (kind IN ('FRAME', 'THEME', 'EFFECT', 'RIDE'));

COMMENT ON COLUMN user_items.kind IS 'FRAME | THEME | EFFECT | RIDE — which catalogue item_key indexes into. Still no foreign key on purpose: retiring a ride must not delete the receipt that says a member paid for it.';

-- ---------------------------------------------------------------------------
-- What a member arrives with right now
-- ---------------------------------------------------------------------------
--
-- The denormalised expiry copied onto `users` is what keeps `toMiniUser()` synchronous — the same
-- reason 0019 did it for the frame, and the reason a ride needs it too: this resolves on the join
-- path for every member entering every room. A NULL key means "no cinematic", which is what every
-- account that has bought nothing is, so there is no free default row and no fallback art.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_ride_key        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS profile_ride_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN users.profile_ride_key IS 'Equipped profile_rides.key, or NULL for no entrance cinematic. Never a client field: /api/store/equip checks ownership and expiry server-side.';
COMMENT ON COLUMN users.profile_ride_expires_at IS 'Denormalised copy of user_items.expires_at so the seat DTO can tell a worn ride from an expired one without a join. store.service writes both in the same transaction.';

-- `media_assets.kind` has no CHECK — the service's own policy table is the registry — but the
-- comment is what an operator reading the schema uses to learn what a slot means, so it names RIDE
-- with the rest.
COMMENT ON COLUMN media_assets.kind IS 'GIFT_ICON | GIFT_ANIMATION | GIFT_SOUND | EFFECT | RIDE | BADGE | WALLPAPER | EMOJI; decides which formats and byte cap the upload must satisfy.';

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
--
-- Three rides built from the Lottie scenes already in public/effects/, played full-screen instead of
-- behind the seats — the same reuse 0019 made when it sold those scenes as entry flourishes, and for
-- the same reason: authorised art (MIT © 2023 Matula José Alberto, see
-- THIRD_PARTY_LICENSES/trace-assets/PROVENANCE.md) that is already on every CDN this platform serves
-- from, so nothing new has to be shipped to devices. Priced above the flourishes they share art with,
-- because a ride holds the whole screen and a flourish does not.
--
-- No `recommended` row is seeded: that flag is an operator's editorial voice, and a migration that
-- picked a favourite would be the catalogue deciding it.

INSERT INTO profile_rides (key, name, url, format, duration_ms, sort_order, price_diamonds, for_sale, period_days) VALUES
  ('ride-confetti',  'Confetti Arrival',  '/effects/room-confetti.json', 'LOTTIE', 4000, 10, 2500, true, 30),
  ('ride-hearts',    'Heart Rain Arrival','/effects/room-hearts.json',   'LOTTIE', 4500, 20, 4000, true, 30),
  ('ride-spectrum',  'Spectrum Entrance', '/effects/room-spectrum.json', 'LOTTIE', 3500, 30, 6000, true, 30)
ON CONFLICT (key) DO NOTHING;
