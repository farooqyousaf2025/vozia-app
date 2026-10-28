-- 0014 — Admin-uploaded media: gift art, gift animations, gift sounds, effect scenes, badges.
--
-- Until now every visual was a file this repository generated itself and the catalogue stored
-- as a root-relative URL, so an operator could only point a gift at art that already existed on
-- the server. This table is the missing half of "add and remove gifts from the admin panel":
-- the row records what was uploaded, and the bytes live under backend/uploads/.
--
-- stored_name is chosen by the server (uuid + an extension derived from the sniffed format,
-- never from the client's file name), so no upload can escape the uploads directory or be
-- served as a type the browser would execute. file_name is kept purely so the admin list can
-- show what the operator picked; it is never used to build a path.
--
-- There is no deleted_at. A removed upload is unlinked and its row deleted; the audit trail
-- keeps who removed what, which is where that history belongs.

CREATE TABLE IF NOT EXISTS media_assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         VARCHAR(24) NOT NULL,
  file_name    VARCHAR(120) NOT NULL,
  stored_name  VARCHAR(80)  NOT NULL UNIQUE,
  content_type VARCHAR(64)  NOT NULL,
  byte_size    INTEGER      NOT NULL CHECK (byte_size > 0),
  sha256       CHAR(64)     NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  url          TEXT         NOT NULL UNIQUE,
  -- Pixel size when the format carries one (PNG/GIF/WebP); NULL for audio and Lottie, whose
  -- canvas is inside the JSON.
  width        INTEGER      CHECK (width IS NULL OR width > 0),
  height       INTEGER      CHECK (height IS NULL OR height > 0),
  uploaded_by  UUID         REFERENCES admins(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The admin library lists one kind at time, newest first.
CREATE INDEX IF NOT EXISTS media_assets_kind_idx
  ON media_assets (kind, created_at DESC);

-- Uploading the same bytes twice returns the existing row instead of storing a second copy,
-- and that lookup has to be indexed once the library grows.
CREATE INDEX IF NOT EXISTS media_assets_sha_idx ON media_assets (sha256);

COMMENT ON TABLE media_assets IS 'Operator-uploaded images, Lottie scenes and sounds served from /uploads. Rows are referenced by URL from gifts and visual_effects.';
COMMENT ON COLUMN media_assets.kind IS 'GIFT_ICON | GIFT_ANIMATION | GIFT_SOUND | EFFECT | BADGE; decides which formats and byte cap the upload must satisfy.';
COMMENT ON COLUMN media_assets.stored_name IS 'Server-chosen file name under backend/uploads. Never derived from client input.';
COMMENT ON COLUMN media_assets.sha256 IS 'Content hash, used to de-duplicate uploads. Not a signature — nothing here is trusted because it matches.';
