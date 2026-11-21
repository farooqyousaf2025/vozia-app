-- Carrom is shipped inactive and free. Existing Admin game controls remain the only
-- path to activation or commercial rule configuration.
INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES (
  'CARROM',
  'Carrom',
  'Two-player striker-and-coins board with server-simulated shots, fouls and queen cover.',
  '{"board":"1000x1000","coinsPerPlayer":9,"queenCover":true,"serverPhysics":true}',
  2, 2, 90, TRUE
)
ON CONFLICT (key) DO NOTHING;
