-- Batch length is 24 or 48 hours. Started enrollments keep the length captured
-- at start. Existing attempts were 24 hours; deadlines, including extensions, stay as stored.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'batches'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%duration_hours%'
  LOOP
    EXECUTE format('ALTER TABLE batches DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE batches
  ADD CONSTRAINT batches_duration_hours_check CHECK (duration_hours IN (24, 48));

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS duration_hours INT;

UPDATE enrollments
SET duration_hours = 24
WHERE started_at IS NOT NULL
  AND duration_hours IS NULL;

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_duration_hours_check;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_duration_hours_check
  CHECK (duration_hours IS NULL OR duration_hours IN (24, 48));

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_duration_snapshot_check;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_duration_snapshot_check
  CHECK (
    (started_at IS NULL AND duration_hours IS NULL)
    OR (started_at IS NOT NULL AND duration_hours IS NOT NULL)
  );

-- One definition of the start window: opensAt <= stamp < startClosesAt.
CREATE OR REPLACE FUNCTION assessment_start_window_open(
  opens_at TIMESTAMPTZ,
  start_closes_at TIMESTAMPTZ,
  stamp TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT stamp >= opens_at AND stamp < start_closes_at
$$;
