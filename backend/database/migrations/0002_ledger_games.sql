-- 0002_ledger_games.sql — let the ledger name the game a row belongs to.
--
-- `transactions` already carries room_id and agency_id as first-class columns, so a game
-- fee, prize or refund that only lives inside `meta` would be the odd one out, and
-- reconciling "what did QUIZ_BATTLE pay out last week" would need a JSONB scan. One
-- nullable FK fixes that without touching any posted row.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS game_session_id UUID REFERENCES game_sessions (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tx_game_session_idx ON transactions (game_session_id, created_at DESC);
