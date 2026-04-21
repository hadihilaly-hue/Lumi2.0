-- Migration: class_enrollments
-- Tracks which students are enrolled in which classes, with a place
-- to store per-student teacher notes (written by teachers in a later commit).
-- Idempotent: safe to re-run.

-- Prerequisite: teacher_profiles has UNIQUE (teacher_email, course_name)
-- (confirmed in 20250416_teacher_profiles_v2.sql line 22).

CREATE TABLE IF NOT EXISTS class_enrollments (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_profile_id  UUID NOT NULL REFERENCES teacher_profiles(id) ON DELETE CASCADE,
  teacher_notes       TEXT DEFAULT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (student_id, teacher_profile_id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_enrollments_student
  ON class_enrollments (student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_teacher_profile
  ON class_enrollments (teacher_profile_id);

-- Enable RLS
ALTER TABLE class_enrollments ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "student_read_own" ON class_enrollments;
DROP POLICY IF EXISTS "student_insert_own" ON class_enrollments;
DROP POLICY IF EXISTS "teacher_read_class" ON class_enrollments;
DROP POLICY IF EXISTS "teacher_update_class" ON class_enrollments;

-- Students can read their own enrollments
CREATE POLICY "student_read_own" ON class_enrollments
  FOR SELECT USING (auth.uid() = student_id);

-- Students can insert their own enrollments (upsert needs this)
CREATE POLICY "student_insert_own" ON class_enrollments
  FOR INSERT WITH CHECK (auth.uid() = student_id);

-- Teachers can read enrollments for classes they own
-- (auth.jwt() ->> 'email' pattern matches teacher_profiles RLS in v2 migration)
CREATE POLICY "teacher_read_class" ON class_enrollments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM teacher_profiles
      WHERE teacher_profiles.id = class_enrollments.teacher_profile_id
        AND teacher_profiles.teacher_email = auth.jwt() ->> 'email'
    )
  );

-- Teachers can update enrollments for their classes (for teacher_notes)
CREATE POLICY "teacher_update_class" ON class_enrollments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM teacher_profiles
      WHERE teacher_profiles.id = class_enrollments.teacher_profile_id
        AND teacher_profiles.teacher_email = auth.jwt() ->> 'email'
    )
  );

-- No DELETE policy — nobody deletes enrollment rows (by design).
-- TODO: Add dropped-class cleanup before shipping to Menlo.

-- Auto-update updated_at (reuses function from teacher_profiles_v2 migration)
DROP TRIGGER IF EXISTS set_class_enrollments_updated_at ON class_enrollments;
CREATE TRIGGER set_class_enrollments_updated_at
  BEFORE UPDATE ON class_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE class_enrollments IS 'Per-student enrollment rows. teacher_notes stores running teacher observations per student per class.';
