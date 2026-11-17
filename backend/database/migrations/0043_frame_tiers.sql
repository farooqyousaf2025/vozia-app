-- 0043: rarity tiers and a client-rendered aura for avatar frames.
--
-- The ring art stays a still PNG: `animated` tells the device to draw a rotating, pulsing aura
-- behind it in the frame's accent colour, so a "live" frame needs no video pipeline and no new
-- upload format. `tier` is the rarity badge the shop and the profile show; it prices nothing by
-- itself — price_diamonds remains the only number a purchase reads.

ALTER TABLE profile_frames
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'COMMON'
    CHECK (tier IN ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  ADD COLUMN IF NOT EXISTS animated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profile_frames.tier IS
  'Rarity badge shown in the shop and on the profile: COMMON | RARE | EPIC | LEGENDARY. Display only; pricing stays in price_diamonds.';
COMMENT ON COLUMN profile_frames.animated IS
  'True = devices draw a rotating aura in the accent colour behind the still ring PNG. The art column never holds video for a frame.';

UPDATE profile_frames AS f
   SET tier = v.tier, animated = v.animated
  FROM (VALUES
    ('ring-bronze',   'COMMON',    false),
    ('ring-silver',   'COMMON',    false),
    ('ring-jade',     'RARE',      false),
    ('ring-ocean',    'RARE',      true),
    ('ring-amber',    'EPIC',      true),
    ('ring-rose',     'EPIC',      true),
    ('ring-sky',      'RARE',      false),
    ('ring-violet',   'EPIC',      false),
    ('ring-crown',    'LEGENDARY', true),
    ('ring-immortal', 'LEGENDARY', true)
  ) AS v(key, tier, animated)
 WHERE f.key = v.key;