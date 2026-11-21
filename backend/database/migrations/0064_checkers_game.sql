-- Checkers is available to operators but ships inactive and free by default.
INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES (
  'CHECKERS',
  'Checkers',
  'Two-player draughts with mandatory captures, multi-jumps and king promotion.',
  '{"board":"8x8","variant":"american-checkers","mandatoryCapture":true,"multiJump":true,"serverAuthoritative":true}',
  2, 2, 60, TRUE
)
ON CONFLICT (key) DO NOTHING;
