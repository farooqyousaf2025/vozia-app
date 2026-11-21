-- Rock Paper Scissors ships inactive and free. Existing Admin game controls are the
-- only path to activation or commercial rule configuration.
INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES (
  'ROCK_PAPER_SCISSORS',
  'Rock Paper Scissors',
  'A simultaneous two-player round of rock, paper and scissors.',
  '{"choices":["ROCK","PAPER","SCISSORS"],"simultaneous":true}',
  2, 2, 30, TRUE
)
ON CONFLICT (key) DO NOTHING;
