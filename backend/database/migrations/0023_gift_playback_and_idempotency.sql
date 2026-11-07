-- 0023 — The gift catalogue describes *how* an animation plays, not only which file to play.
--
-- `effect_kind` already tells a client how loud a gift is (a row in the ticker, or the whole
-- screen), and `animation_url` tells it what to fetch. Between those two the client had to guess
-- everything else: which decoder owns the bytes, how long the overlay may hold the screen, whether
-- a second copy of the same gift may be merged into a counter, and which of three simultaneous
-- gifts wins the takeover slot. Guessing is fine for a demo and unacceptable once an operator adds
-- gifts at runtime — an MP4 handed to a Lottie parser is a blank rectangle, and a 20-diamond rose
-- that preempts a 20 000-diamond jet is a revenue complaint.
--
-- So the four properties move to the row the administrator edits, exactly like the price already
-- did. Nothing here is read-only derived from `animation_url`'s extension either: an upload is
-- stored as `/uploads/<uuid>` with no extension in the URL that matters, and a CDN mirror may
-- rewrite the rest.

-- Which renderer plays `animation_url`. The engine picks by this column, never by sniffing the
-- suffix, so `media.service` can keep refusing a file whose bytes disagree with the format the
-- operator chose for it.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS animation_format VARCHAR(6) NOT NULL DEFAULT 'LOTTIE'
  CHECK (animation_format IN ('LOTTIE', 'SVGA', 'MP4'));

-- How long the overlay may hold, in milliseconds. 0 means "as long as the asset plays": a Lottie
-- scene's own duration or an MP4's moov track length, capped by the client. Non-zero is a hard
-- ceiling, which is what lets an operator shorten a 12-second cinematic without re-encoding it.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS duration_ms INT NOT NULL DEFAULT 0
  CHECK (duration_ms >= 0 AND duration_ms <= 30_000);

-- Queue priority for the takeover slot: with two gifts in flight the higher number plays first,
-- and a legendary is never dropped behind a burst of roses. Independent of `sort_order`, which
-- orders the *panel* by price; a cheap gift shown early must not be able to outrank an expensive
-- one shown late.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS display_priority INT NOT NULL DEFAULT 0
  CHECK (display_priority >= 0 AND display_priority <= 1000);

-- Combo: repeated sends of the same gift to the same receiver in the same room, inside one window,
-- are counted on screen instead of each replaying the animation. `combo_window_ms` is the fixed
-- window the server opens on the first send; the client cannot extend it, because a hacked client
-- that held a window open forever would also hold its counter.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS combo_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS combo_window_ms INT NOT NULL DEFAULT 5_000
  CHECK (combo_window_ms >= 1_000 AND combo_window_ms <= 15_000);

COMMENT ON COLUMN gifts.animation_format IS 'LOTTIE | SVGA | MP4 — which renderer the client hands animation_url to.';
COMMENT ON COLUMN gifts.duration_ms IS 'Hard ceiling on the on-screen overlay in ms; 0 defers to the asset length.';
COMMENT ON COLUMN gifts.display_priority IS 'Takeover-queue rank; higher plays first when two gifts are in flight.';
COMMENT ON COLUMN gifts.combo_enabled IS 'Whether the server counts repeat sends into one combo instead of replaying the animation.';

-- ---- seed the playback fields the client used to infer -------------------------------------
--
-- Every shipped gift is a Lottie file under /gifts/, which is why LOTTIE needed no backfill. The
-- rest is derived from the tier the catalogue already carried: a FULLSCREEN gift held the screen
-- for the client's 6-second cap, a TICKER row lived 3 seconds in the column.

UPDATE gifts SET duration_ms = CASE WHEN effect_kind = 'FULLSCREEN' THEN 6000 ELSE 2500 END,
                 -- Loud gifts get a loud number: the price ladder is 1..20 000 diamonds, and the
                 -- queue only needs a total order, so it follows the same ladder with headroom.
                 display_priority = CASE WHEN effect_kind = 'FULLSCREEN' THEN 100 ELSE 10 END,
                 combo_enabled = true
 WHERE duration_ms = 0 AND animation_format = 'LOTTIE';

-- ---------------------------------------------------------------------------
-- Idempotency for the gift path.
--
-- A gift is the one POST in this API that takes money away, and the one a client is most likely to
-- submit twice: the phone is on a lift, the socket said nothing for four seconds, the user taps
-- Send again. The rate limiter bounds how fast that can happen and the row locks below make each
-- send correct — they do not make a *retry* fold into the original. That is what this table is:
-- the sender's own key, unique per account, recorded before the money moves and resolved to the
-- transaction it produced.
--
-- A retry is only equal to the original if it asks for the same gift, receiver and quantity, so
-- the request is fingerprinted (`sha256` of those three) and a second *different* body under the
-- same key is refused rather than silently answered with the first gift.
--
-- Keys live for a month, which is far longer than any client retry schedule; `pruneGiftRequests`
-- in the ledger service drops them on the minute sweep so the table cannot grow without bound.
CREATE TABLE IF NOT EXISTS gift_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key VARCHAR(80) NOT NULL CHECK (idempotency_key ~ '^[\w.-]{8,80}$'),
  request_hash    CHAR(64) NOT NULL,
  -- NULL between the insert and the ledger write: both happen in the same SQL transaction, so a
  -- reader outside it can never see a row that is missing its transaction.
  transaction_id  UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sender_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gift_requests_created_idx ON gift_requests (created_at);

COMMENT ON TABLE gift_requests IS 'Sender-scoped idempotency keys for POST /api/gifts/send; a replayed request is answered from the transaction it already bought.';
COMMENT ON COLUMN gift_requests.request_hash IS 'sha256 over giftId/receiverId/quantity — the same key with a different body is a conflict, not a replay.';
