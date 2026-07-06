-- staff_directory — the teacher name→email directory, moved OUT of the committed
-- frontend (teacher-directory.js) into RDS so real staff PII is no longer in the
-- public repo (Compliance Phase 2b, full removal).
--
-- Served to authenticated callers by the Lambda GET /teacher-directory route.
-- SCHEMA ONLY — the real rows are seeded out-of-band via the IAM-gated adminSql
-- invoke path (see docs/PII_REMOVAL_PLAN.md); no real names/emails are committed.

CREATE TABLE IF NOT EXISTS public.staff_directory (
  name       text PRIMARY KEY,               -- teacher display name ("First Last")
  email      text NOT NULL,                  -- @menloschool.org email
  is_admin   boolean NOT NULL DEFAULT false, -- exactly one row true = app owner/admin
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive email lookups + the admin lookup.
CREATE INDEX IF NOT EXISTS staff_directory_email_lower_idx
  ON public.staff_directory (lower(email));
CREATE INDEX IF NOT EXISTS staff_directory_is_admin_idx
  ON public.staff_directory (is_admin) WHERE is_admin;
