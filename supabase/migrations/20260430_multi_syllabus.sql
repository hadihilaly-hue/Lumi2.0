-- Migration: multi-syllabus support — array column for file paths.
-- Replaces the singleton syllabus_file_path with syllabus_paths TEXT[].
-- Phased rollout: the legacy syllabus_file_path column is intentionally
-- NOT dropped here. Drop it (and syllabus_uploaded_at) in a follow-up
-- migration once production data confirms every active profile has been
-- re-saved through the new array path. teacher.html will keep writing
-- syllabus_file_path = first path during the transition window so any
-- consumer still reading the old column sees a value.

ALTER TABLE teacher_profiles
  ADD COLUMN IF NOT EXISTS syllabus_paths TEXT[] DEFAULT '{}'::text[];

-- Backfill: lift any existing single-file path into the array.
-- Idempotent — only populates rows where syllabus_paths is still empty,
-- so re-running this migration after teachers have already added more
-- files via the new path will not clobber their work.
UPDATE teacher_profiles
SET syllabus_paths = ARRAY[syllabus_file_path]
WHERE syllabus_file_path IS NOT NULL
  AND (syllabus_paths IS NULL OR cardinality(syllabus_paths) = 0);

COMMENT ON COLUMN teacher_profiles.syllabus_paths IS
  'Array of storage paths (bucket: syllabi) for the teacher''s uploaded syllabi. Replaces singleton syllabus_file_path. Cap: 20 files per profile, enforced client-side. Phase 1 stores PDFs only; DOCX/JPG/PNG support would extend the bucket''s allowed_mime_types in a follow-up.';
