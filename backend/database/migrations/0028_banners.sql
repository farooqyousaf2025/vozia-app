-- 0028 — What the app shows before a member has chosen anything.
--
-- Every app in this genre runs a promotional strip: an image over the splash, a carousel on the home
-- grid, a wide art card at the top of the gift panel, a banner above the game desk. Until now the
-- platform had none of it — no table, no endpoint, no composable — so an operator who wanted to point
-- a thousand members at one room could only do it by hand.
--
-- One table with a `placement` column rather than four tables, because the four surfaces draw the
-- same shape and differ only in where they hang: same art, same tap target, same window, same order.
-- Four catalogues would be the same eleven columns written four times, and the panel screen is one
-- list with a placement filter. `placement` is a CHECK rather than free text for the same reason
-- `visual_effects.kind` is: a client asks for one of four known strings and a typo in the database
-- would be a banner that never appears, on a screen where nobody is looking.
--
-- The tap target is stored as a *kind* plus a value, and the app navigates by the kind. That is what
-- keeps the phone honest: a member's device never turns a string into a route by guessing, it asks
-- the server which of four things this banner means and does that one. An operator who points a
-- banner at a room that has since closed gets no banner (the member list filters on it), not a
-- broken navigation.

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS banners (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A readable handle for audit lines and for a support conversation ("the winter-sale banner"),
  -- kept next to the id because the id is what the panel PUTs to and the key is what a human says.
  key         VARCHAR(40) NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  placement   VARCHAR(8)  NOT NULL CHECK (placement IN ('SPLASH', 'HOME', 'GIFT', 'GAME')),
  title       VARCHAR(60) NOT NULL,
  subtitle    VARCHAR(120),
  -- The same URL rule as every other art column: this string is handed to every device.
  url         TEXT        NOT NULL CHECK (url ~ '^(/|https://)'),
  -- Which renderer opens the file. The bytes decide it at upload (`media.service` sniffs, the panel
  -- stores what it was told), so a row cannot name a container the BANNER slot would have refused.
  format      VARCHAR(6)  NOT NULL DEFAULT 'PNG'
                CHECK (format IN ('PNG', 'GIF', 'WEBP', 'JPEG', 'LOTTIE', 'SVGA', 'MP4')),
  -- How long the surface holds this banner before it moves on: a splash's dwell, a carousel page's
  -- time, the slot a scene gets before the room is handed back. It applies to a still image too —
  -- a PNG splash has no length of its own, so somebody has to say when it goes away.
  -- 0 is an answer ("the asset's own length", or the device's own default for that surface) rather
  -- than a gap, which is the same convention `profile_rides.duration_ms` and `gifts.duration_ms`
  -- settled.
  duration_ms INTEGER     NOT NULL DEFAULT 0 CHECK (duration_ms = 0 OR duration_ms BETWEEN 250 AND 30_000),
  cta_type    VARCHAR(8)  NOT NULL DEFAULT 'NONE' CHECK (cta_type IN ('NONE', 'INTERNAL', 'ROOM', 'URL')),
  cta_value   TEXT        CHECK (cta_value IS NULL OR char_length(cta_value) <= 300),
  -- The window a banner is allowed to appear in. NULL start = "since it was made", NULL end =
  -- "until an operator switches it off"; a campaign that outlived its own date is the failure mode
  -- a scheduled surface has to prevent, since nobody re-checks a banner that already ran.
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  -- Advisory counts, not a ledger: they answer "did this banner do anything", and nothing else in
  -- the schema reads them. Both are written only by a signed-in member's own request, so they cannot
  -- be inflated by an anonymous loop, and neither is a number anybody is paid on.
  impressions BIGINT      NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  taps        BIGINT      NOT NULL DEFAULT 0 CHECK (taps >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT banners_window_is_ordered CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  -- The shape of a tap target is a database rule, not a service convention, because a row naming
  -- `ROOM` with a sentence in `cta_value` would be a 500 on every phone that asked for it.
  CONSTRAINT banners_cta_shape CHECK (
    (cta_type = 'NONE' AND cta_value IS NULL)
    OR (cta_type = 'INTERNAL' AND cta_value IN ('HOME', 'STORE', 'WALLET', 'PROFILE'))
    -- A room id, matching the shape `requireUuid` accepts. Whether that room still exists is a
    -- question the read path answers with a join, because rooms close every minute.
    OR (cta_type = 'ROOM' AND cta_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (cta_type = 'URL' AND cta_value ~ '^https://[^[:space:]]+$')
  )
);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS banners_updated_at ON banners;
  CREATE TRIGGER banners_updated_at BEFORE UPDATE ON banners
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

-- The read is always "this placement, live right now, in order" — an index on the live rows so a
-- splash request does not scan a table of retired campaigns.
CREATE INDEX IF NOT EXISTS banners_placement_idx
  ON banners (placement, sort_order, starts_at)
  WHERE is_active;

COMMENT ON TABLE banners IS 'Operator-run promotional art shown at four fixed surfaces. Admin-managed; published through GET /api/banners?placement=.';
COMMENT ON COLUMN banners.key IS 'Stable human handle. Renaming is a delete plus an insert, never an UPDATE — the audit line names it.';
COMMENT ON COLUMN banners.placement IS 'SPLASH | HOME | GIFT | GAME — which screen draws it. A client asks for one placement and never renders a row for another.';
COMMENT ON COLUMN banners.format IS 'PNG | GIF | WEBP | JPEG | LOTTIE | SVGA | MP4 — which renderer a device hands `url` to. Static image formats loop forever; a scene plays for `duration_ms`.';
COMMENT ON COLUMN banners.duration_ms IS 'How long a moving banner holds the surface. 0 = the asset''s own length, or the device''s own ceiling for that container.';
COMMENT ON COLUMN banners.cta_type IS 'NONE | INTERNAL | ROOM | URL — the verb the app runs with `cta_value`. Internal targets are the four screens a phone has a route for.';
COMMENT ON COLUMN banners.cta_value IS 'The screen name, room id or https link `cta_type` names. Never interpreted without `cta_type`, and a ROOM target is dropped from the member list if that room is gone.';
COMMENT ON COLUMN banners.is_active IS 'false = switched off but kept, with its counts. Retiring a campaign is this flag, not a DELETE, so an operator can read what it did afterwards.';
COMMENT ON COLUMN banners.impressions IS 'How many times a signed-in member loaded this banner. Advisory; nothing else reads it.';
COMMENT ON COLUMN banners.taps IS 'How many times a member tapped it. Compare with `impressions` for a click-through rate; no payout depends on either.';

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
--
-- None. A banner is marketing copy over artwork somebody has to hold the rights to, and a migration
-- cannot author that honestly — unlike the rides and badges, which reuse art this repository already
-- documents in THIRD_PARTY_LICENSES. An empty table means every surface shows nothing, which is what
-- a platform with no live campaign should look like.
