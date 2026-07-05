-- Compliance Phase 4: soft-delete support.
-- Additive, idempotent. Adds a nullable deleted_at to every table that holds
-- a person's PII, so account deletion can soft-delete first (30-day grace),
-- then hard-delete via a documented procedure (see docs/COMPLIANCE.md).
-- Applied to the live RDS on 2026-07-04 via the IAM-gated adminSql path.

ALTER TABLE public.app_users            ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.teacher_profiles     ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.teacher_work_samples ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.profiles             ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.conversations        ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.homework_tasks       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.class_enrollments    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Revocation gate: app_users.deleted_at is read on every authenticated request
-- (verifyCognitoAuth), so setting it denies the account immediately. The
-- cognito_sub UNIQUE index already backs that lookup.
