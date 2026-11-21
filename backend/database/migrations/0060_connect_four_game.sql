-- Connect Four ships disabled and free. An operator may activate it and configure
-- commercial rules through the existing game-definition controls after review.
INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES (
  'CONNECT_FOUR',
  'Connect Four',
  'Two players drop discs into a vertical grid; connect four to win.',
  '{"rows":6,"columns":7,"connect":4}',
  2, 2, 30, TRUE
)
ON CONFLICT (key) DO NOTHING;
