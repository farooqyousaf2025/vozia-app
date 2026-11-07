-- 0027 — A gift whose payout the server rolls.
--
-- Every other row in `gifts` promises the same credit every time: the sender pays `diamond_price`,
-- the receiver banks `r_coin_value`. A lucky box is the one product in this genre that does not —
-- the sender pays a fixed price and the reward is drawn from a table the operator owns, which is
-- what makes it worth selling and what makes it a money path that needs its own guards.
--
-- Two decisions shape this file.
--
-- First, the box is a `gifts` row with a flag, not a new catalogue. A box is *sent* — to a person,
-- into a room, through the same combo window, the same VIP tier, the same idempotency key, the same
-- `GIFT_SENT` ledger row. Every one of those guards lives in `ledger.sendGift`, and the fastest way
-- to lose one of them is to write a second send path next to it. A flag keeps the box inside the
-- code that already refuses a banned sender, a blocked pair, and a gift sent from outside the room.
--
-- Second, one dial instead of two. The obvious schema is a `tax_bps` and a `receiver_share_bps`, and
-- the obvious bug is the operator who sets them to 60% and 60%: 20% appears out of nowhere, or a
-- row that silently over-delivers. So only the receiver's share is stored and the platform's take is
-- the residual of 10,000 — the same arithmetic 0023 left to the agency commission row, where the
-- commission is subtracted from what landed rather than conjured alongside it. Nothing in this
-- migration can mint a coin: a box debits diamonds exactly like a Rose does, and the roll only
-- changes how many R-coins the receiver keeps out of the reward pool the price already bought.

-- ---------------------------------------------------------------------------
-- The two columns on the gift itself
-- ---------------------------------------------------------------------------

ALTER TABLE gifts
  ADD COLUMN IF NOT EXISTS is_lucky_box       BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS receiver_share_bps SMALLINT NOT NULL DEFAULT 10_000 CHECK (receiver_share_bps BETWEEN 0 AND 10_000);

COMMENT ON COLUMN gifts.is_lucky_box IS 'true = sending this gift rolls a reward from gift_box_outcomes instead of paying r_coin_value flat. The price, the VIP tier and every send guard are unchanged; only the credit is drawn.';
COMMENT ON COLUMN gifts.receiver_share_bps IS 'Of the rolled reward pool, the share in ten-thousandths the receiver banks. The platform''s take is 10,000 minus this, never a second number an operator can set out of step with the first. Ignored unless is_lucky_box.';

-- ---------------------------------------------------------------------------
-- The payout table
-- ---------------------------------------------------------------------------
--
-- `weight` is a count, not a percentage: the draw picks a number below the sum of the weights, so an
-- operator can express "1 in 100" as 1 against 99 and never has to make a column add up to 100.
-- Bounded at 10,000 per row so a mistyped 1000000 cannot quietly make one prize unreachable while
-- the total still reads sensibly in the panel.
--
-- `multiplier_bps` is the reward pool times this many ten-thousandths, so 10,000 pays the pool and
-- 500,000 pays 50x. The floor is 0.01x rather than 1x on purpose: a consolation prize that pays a
-- hundredth of the pool is a real product decision (the low tier of `Lucky Pouch` below is one), and
-- what stops a box from being a giveaway is not a per-row minimum but the expected-payout rule in
-- `lucky-box.service.ts`, which is stated in the seed and enforced on every write. The ceiling is
-- 100x, the same reasoning that caps a gift's price: a number this side of the table is what reaches
-- a phone.

CREATE TABLE IF NOT EXISTS gift_box_outcomes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_id        UUID        NOT NULL REFERENCES gifts (id) ON DELETE CASCADE,
  label          VARCHAR(40) NOT NULL CHECK (label ~ '\S'),
  multiplier_bps INTEGER     NOT NULL CHECK (multiplier_bps BETWEEN 100 AND 1_000_000),
  weight         INTEGER     NOT NULL CHECK (weight BETWEEN 1 AND 10_000),
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  UNIQUE (gift_id, label)
);

CREATE INDEX IF NOT EXISTS gift_box_outcomes_gift_idx ON gift_box_outcomes (gift_id, sort_order);

COMMENT ON TABLE gift_box_outcomes IS 'The prizes one lucky box can roll. Read inside the send transaction, drawn per unit with crypto.randomInt; no client ever sees the weights as anything but the published odds.';
COMMENT ON COLUMN gift_box_outcomes.weight IS 'Relative chance against the other rows of the same box. Not a percentage and not required to sum to anything.';
COMMENT ON COLUMN gift_box_outcomes.multiplier_bps IS 'Times the per-unit reward pool (gifts.r_coin_value) this prize is worth, in ten-thousandths. 10,000 = the pool itself.';

-- ---------------------------------------------------------------------------
-- Seed: one box, five prizes
-- ---------------------------------------------------------------------------
--
-- Priced like a Ring (100 diamonds, 90-coin pool) so the numbers are comparable to a gift an
-- operator already knows. The weights sum to 10,000 and the expected multiplier works out at 1.55x;
-- at a 60% receiver share the box banks 0.93 of the pool in expectation, slightly *less* than the
-- flat Ring beside it — which is the point: the box sells the 20x tail, not a better average.
-- `ledger.validateLuckyBox` refuses any box whose expected payout exceeds the pool it priced, so
-- this invariant is stated here and enforced on every write after it.
--
-- The art is Fireworks' — already shipped, already served, already a burst that reads as a reveal.
-- A box needs an animation that plays *before* the number lands, and inventing a file name devices
-- would 404 on is not one.
--
-- `sort_order` 51 places it immediately after Ring (100 diamonds at 50) and before Happy Cake (150 at
-- 55), because the catalogue's read-order contract is that price never falls as the panel scrolls —
-- a box slotted by name alone would put a 100-diamond item between two gifts worth a fifteenth of it.

INSERT INTO gifts (name, icon_url, animation_url, sound_url, diamond_price, r_coin_value,
                   category, min_vip_level, sort_order, effect_kind, is_lucky_box, receiver_share_bps)
VALUES ('Lucky Pouch', '/gifts/fireworks.png', '/gifts/fireworks.json', '/gifts/sounds/chime.wav',
        100, 90, 'SPECIAL', 0, 51, 'FULLSCREEN', true, 6_000)
ON CONFLICT (name) DO NOTHING;

INSERT INTO gift_box_outcomes (gift_id, label, multiplier_bps, weight, sort_order)
SELECT g.id, o.label, o.multiplier_bps, o.weight, o.sort_order
  FROM gifts g
 CROSS JOIN (VALUES
        ('0.5x',    5_000, 4_000, 10),
        ('1x',     10_000, 3_000, 20),
        ('2x',     20_000, 2_000, 30),
        ('5x',     50_000,   900, 40),
        ('20x',   200_000,   100, 50)
     ) AS o (label, multiplier_bps, weight, sort_order)
 WHERE g.name = 'Lucky Pouch' AND g.is_lucky_box
   AND NOT EXISTS (SELECT 1 FROM gift_box_outcomes e WHERE e.gift_id = g.id)
ON CONFLICT (gift_id, label) DO NOTHING;
