-- Migration: Add title column to teacher_profiles
-- Stores how students address the teacher (Mr., Ms., Mrs., Mx., Dr.)
-- Nullable so existing rows don't break
-- Idempotent: safe to re-run

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'teacher_profiles' AND column_name = 'title'
  ) THEN
    ALTER TABLE teacher_profiles ADD COLUMN title TEXT DEFAULT NULL;
  END IF;
END $$;

COMMENT ON COLUMN teacher_profiles.title IS 'How students address this teacher (Mr., Ms., Mrs., Mx., Dr.)';
