-- Add student_name column to class_enrollments so teachers can see who's
-- in their roster without reading the profiles table (profiles RLS is
-- strict own-row-only). Populated by syncEnrollments from the student's
-- own name; backfilled here from profiles for any pre-existing rows
-- (migrations run as service_role and bypass RLS).
--
-- Idempotent.

ALTER TABLE class_enrollments
  ADD COLUMN IF NOT EXISTS student_name TEXT;

-- Backfill existing rows from profiles.name
UPDATE class_enrollments ce
SET student_name = p.name
FROM profiles p
WHERE ce.student_id = p.id
  AND ce.student_name IS NULL;
