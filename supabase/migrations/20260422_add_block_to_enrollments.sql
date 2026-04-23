-- Migration: add block column to class_enrollments.
-- Per-section identity (Menlo blocks A-G) so a future teacher roster can
-- distinguish students across multiple sections of the same course.
-- Replaces the (student_id, teacher_profile_id) unique constraint with one
-- that also includes block.
--
-- Idempotent where possible.

-- 1. Add block column
ALTER TABLE class_enrollments
  ADD COLUMN IF NOT EXISTS block TEXT;

-- 2. CHECK: block must be A-G or NULL (NULL only for the legacy row about
--    to be deleted below; going forward the UI requires a letter).
ALTER TABLE class_enrollments
  DROP CONSTRAINT IF EXISTS class_enrollments_block_check;
ALTER TABLE class_enrollments
  ADD CONSTRAINT class_enrollments_block_check
    CHECK (block IS NULL OR block IN ('A','B','C','D','E','F','G'));

-- 3. Swap unique constraint to include block
ALTER TABLE class_enrollments
  DROP CONSTRAINT IF EXISTS class_enrollments_student_id_teacher_profile_id_key;
ALTER TABLE class_enrollments
  DROP CONSTRAINT IF EXISTS class_enrollments_student_id_teacher_profile_id_block_key;
ALTER TABLE class_enrollments
  ADD CONSTRAINT class_enrollments_student_id_teacher_profile_id_block_key
    UNIQUE (student_id, teacher_profile_id, block);

-- 4. Wipe the single legacy row from commit 1 testing (no block set).
--    On next schedule save, a fresh row is created with block correctly set.
DELETE FROM class_enrollments WHERE block IS NULL;
