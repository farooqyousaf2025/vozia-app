CREATE TABLE IF NOT EXISTS chat_bubbles (
  key VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name VARCHAR(60) NOT NULL,
  background CHAR(7) NOT NULL CHECK (background ~ '^#[0-9a-fA-F]{6}$'),
  accent CHAR(7) NOT NULL CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
  text_color CHAR(7) NOT NULL CHECK (text_color ~ '^#[0-9a-fA-F]{6}$'),
  motif TEXT NOT NULL DEFAULT 'NONE' CHECK (motif IN ('NONE', 'SPARKLE', 'HEART', 'CROWN')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  price_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (price_diamonds >= 0),
  for_sale BOOLEAN NOT NULL DEFAULT false,
  period_days SMALLINT CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 3650),
  min_vip_level SMALLINT NOT NULL DEFAULT 0 CHECK (min_vip_level BETWEEN 0 AND 20),
  recommended BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_bubbles_priced_if_for_sale
    CHECK ((NOT for_sale AND price_diamonds = 0) OR (for_sale AND price_diamonds > 0))
);

DROP TRIGGER IF EXISTS chat_bubbles_updated_at ON chat_bubbles;
CREATE TRIGGER chat_bubbles_updated_at BEFORE UPDATE ON chat_bubbles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_items DROP CONSTRAINT IF EXISTS user_items_kind_check;
ALTER TABLE user_items ADD CONSTRAINT user_items_kind_check
  CHECK (kind IN ('FRAME', 'THEME', 'EFFECT', 'RIDE', 'BUBBLE'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS chat_bubble_key VARCHAR(40),
  ADD COLUMN IF NOT EXISTS chat_bubble_expires_at TIMESTAMPTZ;

-- Store the send-time style so a later equip or catalogue edit cannot restyle chat history.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS bubble_style JSONB;

INSERT INTO chat_bubbles (key, name, background, accent, text_color, motif, sort_order, price_diamonds, for_sale, period_days) VALUES
  ('bubble-midnight', 'Midnight Spark', '#202746', '#94B6FF', '#F5F7FF', 'SPARKLE', 10, 300, true, 30),
  ('bubble-aurora', 'Aurora', '#123B3C', '#65E2CD', '#F5FFFD', 'NONE', 20, 600, true, 30),
  ('bubble-blossom', 'Blossom', '#41213B', '#F4A6D0', '#FFF5FA', 'HEART', 30, 1200, true, 30),
  ('bubble-royal', 'Royal Signature', '#362C1C', '#F2CB75', '#FFF9E9', 'CROWN', 40, 2000, true, 30)
ON CONFLICT (key) DO NOTHING;
