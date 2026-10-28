-- 0016 — Chat emoji become a catalogue the administrator owns.

-- The set this app ships was imported from Tencent's MIT/Apache-2.0 UI kits and regenerated into
-- backend/public/emoji/ by scripts/build-emoji-manifest.cjs. That file is a build artefact: an
-- operator could not add an emoji, retire one, or point a code at their own art without shipping a
-- new backend, which is the same trap migration 0015 closed for room themes. The rows below are the
-- registry now; `GET /api/emoji` publishes them and the panel edits them under `/api/admin/emoji`.
--
-- A message stores its text with the token in it (`see you [wave]`), never a URL, so retiring an
-- emoji cannot rewrite history: an unknown code simply renders as the plain text it already is.

CREATE TABLE IF NOT EXISTS emoji_characters (
  key        VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  label      VARCHAR(60) NOT NULL,
  -- Root-relative (served by this API) or https (a CDN mirror). Same rule as visual_effects.url:
  -- this string is handed to every device that reads a chat message.
  url        TEXT        NOT NULL CHECK (url ~ '^(/|https://)'),
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE emoji_characters IS 'Chat emoji the picker offers. Admin-managed; published by GET /api/emoji.';
COMMENT ON COLUMN emoji_characters.key IS 'Code written inside a chat message as [key]. The token is derived from this column, so no message stores a URL that could be re-pointed later.';
COMMENT ON COLUMN emoji_characters.sort_order IS 'Position in the picker, low to high. The API returns rows in this order.';

-- Index, not a constraint: two codes may point at the same art if an operator wants a shorter
-- alias, and the upload-delete guard counts rows by url rather than assuming one.
CREATE INDEX IF NOT EXISTS emoji_characters_url_idx ON emoji_characters (url);

-- Seeds: the 62 codes scripts/build-emoji-manifest.cjs produced on the day this migration was
-- written, in its own order, so an upgrade shows exactly the picker members already had.
INSERT INTO emoji_characters (key, label, url, sort_order) VALUES
  ('smile', 'Smile', '/emoji/smile.webp', 0),
  ('expect', 'Expect', '/emoji/expect.webp', 1),
  ('blink', 'Blink', '/emoji/blink.webp', 2),
  ('guffaw', 'Guffaw', '/emoji/guffaw.webp', 3),
  ('kind-smile', 'Kind smile', '/emoji/kind-smile.webp', 4),
  ('haha', 'Haha', '/emoji/haha.webp', 5),
  ('cheerful', 'Cheerful', '/emoji/cheerful.webp', 6),
  ('speechless', 'Speechless', '/emoji/speechless.webp', 7),
  ('amazed', 'Amazed', '/emoji/amazed.webp', 8),
  ('sorrow', 'Sorrow', '/emoji/sorrow.webp', 9),
  ('complacent', 'Complacent', '/emoji/complacent.webp', 10),
  ('silly', 'Silly', '/emoji/silly.webp', 11),
  ('lustful', 'Lustful', '/emoji/lustful.webp', 12),
  ('giggle', 'Giggle', '/emoji/giggle.webp', 13),
  ('kiss', 'Kiss', '/emoji/kiss.webp', 14),
  ('wail', 'Wail', '/emoji/wail.webp', 15),
  ('tears-laugh', 'Tears of joy', '/emoji/tears-laugh.webp', 16),
  ('trapped', 'Trapped', '/emoji/trapped.webp', 17),
  ('mask', 'Mask', '/emoji/mask.webp', 18),
  ('fear', 'Fear', '/emoji/fear.webp', 19),
  ('bare-teeth', 'Bare teeth', '/emoji/bare-teeth.webp', 20),
  ('flare-up', 'Flare up', '/emoji/flare-up.webp', 21),
  ('yawn', 'Yawn', '/emoji/yawn.webp', 22),
  ('tact', 'Tact', '/emoji/tact.webp', 23),
  ('star-eyes', 'Star eyes', '/emoji/star-eyes.webp', 24),
  ('shut-up', 'Shut up', '/emoji/shut-up.webp', 25),
  ('sigh', 'Sigh', '/emoji/sigh.webp', 26),
  ('hehe', 'Hehe', '/emoji/hehe.webp', 27),
  ('silent', 'Silent', '/emoji/silent.webp', 28),
  ('surprised', 'Surprised', '/emoji/surprised.webp', 29),
  ('askance', 'Askance', '/emoji/askance.webp', 30),
  ('ok', 'OK', '/emoji/ok.webp', 31),
  ('poop', 'Poop', '/emoji/poop.webp', 32),
  ('monster', 'Monster', '/emoji/monster.webp', 33),
  ('demon', 'Demon', '/emoji/demon.webp', 34),
  ('rage', 'Rage', '/emoji/rage.webp', 35),
  ('fool', 'Fool', '/emoji/fool.webp', 36),
  ('pig', 'Pig', '/emoji/pig.webp', 37),
  ('cow', 'Cow', '/emoji/cow.webp', 38),
  ('love-you', 'Love you', '/emoji/love-you.webp', 39),
  ('skull', 'Skull', '/emoji/skull.webp', 40),
  ('bomb', 'Bomb', '/emoji/bomb.webp', 41),
  ('coffee', 'Coffee', '/emoji/coffee.webp', 42),
  ('cake', 'Cake', '/emoji/cake.webp', 43),
  ('beer', 'Beer', '/emoji/beer.webp', 44),
  ('flower', 'Flower', '/emoji/flower.webp', 45),
  ('watermelon', 'Watermelon', '/emoji/watermelon.webp', 46),
  ('rich', 'Rich', '/emoji/rich.webp', 47),
  ('heart', 'Heart', '/emoji/heart.webp', 48),
  ('moon', 'Moon', '/emoji/moon.webp', 49),
  ('sun', 'Sun', '/emoji/sun.webp', 50),
  ('star', 'Star', '/emoji/star.webp', 51),
  ('red-packet', 'Red packet', '/emoji/red-packet.webp', 52),
  ('celebrate', 'Celebrate', '/emoji/celebrate.webp', 53),
  ('bless', 'Bless', '/emoji/bless.webp', 54),
  ('fortune', 'Fortune', '/emoji/fortune.webp', 55),
  ('convinced', 'Convinced', '/emoji/convinced.webp', 56),
  ('prohibit', 'Prohibit', '/emoji/prohibit.webp', 57),
  ('666', '666', '/emoji/666.webp', 58),
  ('857', '857', '/emoji/857.webp', 59),
  ('knife', 'Knife', '/emoji/knife.webp', 60),
  ('like', 'Like', '/emoji/like.webp', 61)
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN media_assets.kind IS 'GIFT_ICON | GIFT_ANIMATION | GIFT_SOUND | EFFECT | BADGE | WALLPAPER | EMOJI; decides which formats and byte cap the upload must satisfy.';
