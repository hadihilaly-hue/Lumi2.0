-- Migration: teacher_work_samples + work-samples Storage bucket
-- Purpose: Q4 onboarding step captures graded student-work photos at three
-- performance tiers (progressing/proficient/exemplary). At student-feedback
-- time the photos are sent to Claude as vision input and the per-tier
-- descriptions are spliced into the system prompt so Lumi's feedback voice
-- matches the teacher's authentic grading style.

-- ─── TABLE ───────────────────────────────────────────────────────────────────

CREATE TABLE teacher_work_samples (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  teacher_profile_id  UUID NOT NULL REFERENCES teacher_profiles(id) ON DELETE CASCADE,
  tier                TEXT NOT NULL CHECK (tier IN ('progressing','proficient','exemplary')),
  description         TEXT NOT NULL,
  photo_paths         TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (teacher_profile_id, tier)
);

CREATE INDEX idx_work_samples_profile ON teacher_work_samples(teacher_profile_id);

DROP TRIGGER IF EXISTS set_work_samples_updated_at ON teacher_work_samples;
CREATE TRIGGER set_work_samples_updated_at
  BEFORE UPDATE ON teacher_work_samples
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE teacher_work_samples ENABLE ROW LEVEL SECURITY;

-- ─── RLS (idempotent) ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_read"     ON teacher_work_samples;
DROP POLICY IF EXISTS "owner_insert"  ON teacher_work_samples;
DROP POLICY IF EXISTS "owner_update"  ON teacher_work_samples;
DROP POLICY IF EXISTS "owner_delete"  ON teacher_work_samples;

-- Read: any authenticated user (students need this to load samples at
-- feedback time). Mirrors the auth_read policy on teacher_profiles.
CREATE POLICY "auth_read" ON teacher_work_samples FOR SELECT
  USING (auth.role() = 'authenticated');

-- Write: only the teacher whose teacher_profile_id resolves to their email.
-- The JOIN to teacher_profiles is what scopes ownership.
CREATE POLICY "owner_insert" ON teacher_work_samples FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM teacher_profiles tp
    WHERE tp.id = teacher_profile_id
      AND tp.teacher_email = auth.jwt() ->> 'email'
  ));

CREATE POLICY "owner_update" ON teacher_work_samples FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM teacher_profiles tp
    WHERE tp.id = teacher_profile_id
      AND tp.teacher_email = auth.jwt() ->> 'email'
  ));

CREATE POLICY "owner_delete" ON teacher_work_samples FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM teacher_profiles tp
    WHERE tp.id = teacher_profile_id
      AND tp.teacher_email = auth.jwt() ->> 'email'
  ));

-- ─── STORAGE BUCKET ──────────────────────────────────────────────────────────
-- Note: HEIC is intentionally NOT in allowed_mime_types because Claude's
-- vision API does not accept HEIC. teacher.html converts HEIC → JPEG
-- client-side via heic2any before upload, so all stored objects are
-- JPEG/PNG/WebP.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'work-samples',
  'work-samples',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── STORAGE POLICIES (idempotent) ───────────────────────────────────────────
-- Path convention: {teacher_email}/{course_name}/{tier}/{timestamp}_{filename}
-- Owner check uses the first folder segment = teacher's email.

DROP POLICY IF EXISTS "work_samples_auth_read"     ON storage.objects;
DROP POLICY IF EXISTS "work_samples_owner_insert"  ON storage.objects;
DROP POLICY IF EXISTS "work_samples_owner_update"  ON storage.objects;
DROP POLICY IF EXISTS "work_samples_owner_delete"  ON storage.objects;

CREATE POLICY "work_samples_auth_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'work-samples' AND auth.role() = 'authenticated');

CREATE POLICY "work_samples_owner_insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'work-samples'
    AND (storage.foldername(name))[1] = auth.jwt() ->> 'email'
  );

CREATE POLICY "work_samples_owner_update" ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'work-samples'
    AND (storage.foldername(name))[1] = auth.jwt() ->> 'email'
  );

CREATE POLICY "work_samples_owner_delete" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'work-samples'
    AND (storage.foldername(name))[1] = auth.jwt() ->> 'email'
  );
