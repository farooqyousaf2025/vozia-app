-- 0018 — The rank ladder and the effect library get real art.
--
-- Everything the ladder and the room loops wore so far was drawn by
-- scripts/generate-placeholder-assets.cjs: correct shapes, no craft. This migration points the
-- catalogue at imported artwork instead, which is the swap NOTICE.md §2 has described as routine
-- — the rows store root-relative URLs, so changing the art is a data change and never a client
-- build.
--
-- Source: the *Trace* social/live-streaming template (Flutter), `assets/images/grade_big_*.png`
-- and `assets/lotties/*.json`, MIT © 2023 Matula José Alberto. The licence text and the list of
-- which files came from where live in THIRD_PARTY_LICENSES/trace-assets/; nothing from that
-- package's source code was taken.
--
-- Two rules shape the UPDATEs below:
--
--   * They match on the placeholder URL, not on the level alone. An operator who already uploaded
--     their own badge for Diamond II through the panel keeps it — this migration only replaces art
--     nobody has touched.
--   * The category mapping is re-pointed the same way. A host-facing choice an operator made from
--     the panel is theirs to keep; only the seeded default is upgraded.

-- Twenty-one rungs from a set of twenty-five seals. The ladder follows the artist's own order —
-- sprout, blossom, ember, medallion, diamond, crown, wand, banner — and the two summit rungs take
-- the two trophies, gold for Legend and violet for Immortal. The three near-duplicate trophies and
-- the duplicate banner in the middle were left out rather than shipped unused.
UPDATE rank_levels SET badge_url = '/badges/trace/level-' || level::text || '.png'
 WHERE badge_url = '/badges/level-' || level::text || '.png';

-- Two scenes the generator could not have drawn: a circular audio spectrum for a room whose whole
-- subject is voice, and a microphone that breathes. Both are vector-only Lottie (no embedded
-- bitmaps), so a phone fetches tens of kilobytes and renders them at any size.
INSERT INTO visual_effects (key, kind, name, url, sort_order) VALUES
  ('room-spectrum', 'AMBIENT', 'Audio Spectrum', '/effects/room-spectrum.json', 50),
  ('room-voice',    'AMBIENT', 'Voice',          '/effects/room-voice.json',    60)
ON CONFLICT (key) DO NOTHING;

-- A MUSIC room is the one place a spectrum belongs. Still an operator's decision: the panel's
-- category picker offers all six loops, and this line only fires while MUSIC wears what 0015
-- seeded it with.
UPDATE room_category_effects SET effect_key = 'room-spectrum'
 WHERE category = 'MUSIC' AND effect_key = 'room-sparkle';
