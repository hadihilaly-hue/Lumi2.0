-- rds-school-domains.sql — Workstream I Phase 4 (2026-07-02)
--
-- Per-school allowed sign-in domains, replacing the hardcoded
-- @menloschool.org gate (Lambda SCHOOL_CONFIG.domain + client isMenloEmail).
-- The Lambda unions allowed_domains across all schools rows (5-min container
-- cache) and enforces it in verifyCognitoAuth (before any app_users write)
-- and at the per-request route gate. SCHOOL_CONFIG.adminEmails short-circuits
-- the check as lockout protection.
--
-- SIS v1 exports carry no domain field, so imported schools start with the
-- '{}' default; populating them is a Phase 5 decision (derive from imported
-- email domains vs. manual admin config).
--
-- Applied to lumi-db via POST /admin/sql on 2026-07-02.

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS allowed_domains text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.schools.allowed_domains IS
  'Lowercased email domains whose Google accounts may use Lumi (unioned across schools by the Lambda gate). Empty = school imported but sign-in not yet enabled.';

-- Seed the real school. schools.name is UNIQUE.
INSERT INTO public.schools (name, allowed_domains)
VALUES ('Menlo School', '{menloschool.org}')
ON CONFLICT (name) DO UPDATE
  SET allowed_domains = EXCLUDED.allowed_domains, updated_at = now();
