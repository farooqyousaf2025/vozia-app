-- 0058 — configurable, informational weekly attendance goals for agency hosts.
ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS weekly_attendance_target_days SMALLINT NOT NULL DEFAULT 5;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agencies_weekly_attendance_target_days_check'
      AND conrelid = 'agencies'::regclass
  ) THEN
    ALTER TABLE agencies
      ADD CONSTRAINT agencies_weekly_attendance_target_days_check
      CHECK (weekly_attendance_target_days BETWEEN 1 AND 7);
  END IF;
END $$;
