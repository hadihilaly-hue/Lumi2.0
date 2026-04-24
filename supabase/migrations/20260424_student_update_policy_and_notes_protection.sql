-- Migration: student UPDATE policy + protect_teacher_notes trigger
--
-- This migration does two things that must ship together:
--
-- 1. Adds a student_update_own RLS policy on class_enrollments so
--    students can UPDATE their own enrollment rows. This is required
--    because syncEnrollments() upserts with onConflict targeting the
--    (student_id, teacher_profile_id, block) unique constraint — when
--    a student re-saves their schedule, Postgres converts the "insert
--    that conflicts" into an UPDATE. Without UPDATE permission, adding
--    a new class to an existing schedule fails with a 403 RLS error.
--
-- 2. Adds a protect_teacher_notes() trigger that surgically blocks
--    students (or anyone who isn't the owning teacher) from modifying
--    the teacher_notes column. The RLS policy above is intentionally
--    broad — it lets students touch their own rows — so we need a
--    row-level guard to keep teacher_notes write-protected from the
--    student side. Ownership is matched via auth.jwt() ->> 'email'
--    against teacher_profiles.teacher_email, consistent with the
--    existing teacher_read_class / teacher_update_class policies on
--    this table.
--
-- Why this migration exists: during commit 2b testing, adding a class
-- to an existing schedule failed with a 403 because students had no
-- UPDATE policy. Granting UPDATE alone would have let students
-- overwrite teacher_notes, so the trigger is the matching guard.
--
-- Idempotent: safe to re-run (DROP ... IF EXISTS + CREATE OR REPLACE).

-- 1. Student UPDATE policy on class_enrollments
DROP POLICY IF EXISTS "student_update_own" ON class_enrollments;
CREATE POLICY "student_update_own" ON class_enrollments
  FOR UPDATE
  USING (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id);

-- 2. Trigger function: reject teacher_notes edits from non-owning teachers
CREATE OR REPLACE FUNCTION protect_teacher_notes()
RETURNS TRIGGER AS $$
BEGIN
  -- Only enforce when teacher_notes is actually changing
  IF NEW.teacher_notes IS DISTINCT FROM OLD.teacher_notes THEN
    IF NOT EXISTS (
      SELECT 1 FROM teacher_profiles
      WHERE teacher_profiles.id = NEW.teacher_profile_id
        AND teacher_profiles.teacher_email = auth.jwt() ->> 'email'
    ) THEN
      RAISE EXCEPTION 'teacher_notes can only be modified by the teacher who owns this class';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach trigger BEFORE UPDATE on class_enrollments
DROP TRIGGER IF EXISTS protect_teacher_notes_trigger ON class_enrollments;
CREATE TRIGGER protect_teacher_notes_trigger
  BEFORE UPDATE ON class_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION protect_teacher_notes();
