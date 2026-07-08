-- Q4 v2 work-sample expansion: per-artifact child table.
-- Additive, idempotent. Apply to the live RDS via the IAM-gated adminSql
-- direct-invoke path (the only migration path post-cutover; see CLAUDE.md
-- Stack Notes). Do NOT run against any database from application code.
--
-- Rationale: teacher_work_samples has UNIQUE (teacher_profile_id, tier), which
-- caps a tier at ONE row (one description + one photo_paths array). v2 needs N
-- artifacts per tier, each either a photo OR a block of text (quarterly comment,
-- essay feedback, verbal-eval note, ...), so a PE/orchestra/drama/language
-- teacher can contribute without any photo. This child table holds those
-- artifacts; teacher_work_samples stays untouched (its per-tier "what I look
-- for" description remains the tier guidance line). Legacy photo-only teachers
-- (Harris/Bush) need zero migration — their rows are read exactly as before.
--
-- In this pass only TEXT artifacts are written here: new photos still land in
-- teacher_work_samples.photo_paths (Decision D2-A, freeze photo_paths / no
-- backfill), and text is injected server-side, never reaching the browser
-- (Decision P1-A). The photo/s3_path shape below is kept general so a future
-- pass can move photos here without a schema change.
--
-- deleted_at is present from day one (nullable), reusing the Phase-4 soft-delete
-- posture (30-day grace → documented hard-delete). No backfill needed.

CREATE TABLE IF NOT EXISTS public.teacher_work_artifacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  teacher_profile_id uuid NOT NULL
                       REFERENCES public.teacher_profiles(id) ON DELETE CASCADE,
  tier               text NOT NULL,           -- progressing | proficient | exemplary
  artifact_type      text NOT NULL,           -- photo | comment | essay_feedback | eval_note | other
  text_content       text,                    -- NON-null for text types, NULL for photo
  s3_path            text,                    -- NON-null for photo type, NULL for text
  label              text,                    -- optional teacher caption ("Q2 report comment")
  sort_order         integer NOT NULL DEFAULT 0,   -- stable ordering within a tier
  deleted_at         timestamptz,
  CONSTRAINT teacher_work_artifacts_tier_check
    CHECK (tier = ANY (ARRAY['progressing'::text, 'proficient'::text, 'exemplary'::text])),
  CONSTRAINT teacher_work_artifacts_type_check
    CHECK (artifact_type = ANY (ARRAY['photo'::text, 'comment'::text, 'essay_feedback'::text, 'eval_note'::text, 'other'::text])),
  -- content integrity: photo ⇒ s3_path (text null); text types ⇒ text_content (s3 null)
  CONSTRAINT teacher_work_artifacts_content_check CHECK (
    (artifact_type = 'photo' AND s3_path IS NOT NULL AND text_content IS NULL)
    OR
    (artifact_type <> 'photo' AND text_content IS NOT NULL AND s3_path IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_work_artifacts_profile
  ON public.teacher_work_artifacts USING btree (teacher_profile_id);

-- Reuse the shared updated_at trigger function (defined in rds-schema.sql).
-- CREATE TRIGGER has no IF NOT EXISTS; guard with a DROP so re-runs are idempotent.
DROP TRIGGER IF EXISTS set_work_artifacts_updated_at ON public.teacher_work_artifacts;
CREATE TRIGGER set_work_artifacts_updated_at BEFORE UPDATE ON public.teacher_work_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.teacher_work_artifacts IS 'Q4 v2: per-artifact graded-work examples (N per tier), each a photo (s3_path) or a block of teacher text (text_content). Injected into Lumi''s feedback voice; never shown to students. Sibling to teacher_work_samples (per-tier description container).';
