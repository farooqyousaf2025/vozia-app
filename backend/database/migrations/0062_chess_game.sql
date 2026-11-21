-- Chess ships disabled and free. Existing Admin game controls remain the only
-- path to activation or commercial rule configuration.
INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES (
  'CHESS',
  'Chess',
  'Classic two-player chess with server-validated legal moves, checkmate and stalemate.',
  '{"board":"8x8","castling":true,"enPassant":true,"promotion":["q","r","b","n"]}',
  2, 2, 60, TRUE
)
ON CONFLICT (key) DO NOTHING;
