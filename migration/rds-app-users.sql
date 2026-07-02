-- rds-app-users.sql — Workstream I Phase 2 (2026-07-01)
--
-- Identity bridge between Cognito and the Supabase-era UUIDs that every RDS
-- table keys on (profiles.id, conversations.user_id, class_enrollments.
-- student_id, sis_map.lumi_id, ...). Cognito does not allow choosing a user's
-- `sub`, so the Lambda's verifyAuth resolves cognito_sub -> lumi_id here and
-- returns lumi_id as user.id to every route.
--
-- Linking rules (implemented in lambda/index.mjs verifyCognitoAuth):
--   * fast path: lookup by cognito_sub
--   * first sign-in: link by VERIFIED email to an existing row (SIS imports
--     pre-create email rows with cognito_sub NULL), else mint a new lumi_id
--   * email already bound to a DIFFERENT cognito_sub -> fail closed (401)
--
-- email is the linking key only; authz throughout the Lambda keys on the
-- JWT email. A Google-side email change keeps working via the sub fast path
-- (the stored email goes stale, which is cosmetic).
--
-- Applied to lumi-db via POST /admin/sql on 2026-07-01.

CREATE TABLE IF NOT EXISTS public.app_users (
    lumi_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub text UNIQUE,                -- NULL until first Cognito sign-in
    email       text NOT NULL UNIQUE,       -- lowercased
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_users IS
  'Cognito sub -> preserved lumi uuid identity bridge (Workstream I). Read/written only by the Lambda''s verifyCognitoAuth; SIS importer inserts email-only rows (Phase 5).';

-- Seed the one real user with his preserved Supabase-issued uuid and the
-- Cognito sub observed in the Phase 1 verification round trip.
INSERT INTO public.app_users (lumi_id, cognito_sub, email)
VALUES ('3587c875-ddc8-4e0b-b65f-ff3677d7ccce',
        '14f83488-b051-70d3-ab5d-91ee8f879cee',
        'hadi.hilaly@menloschool.org')
ON CONFLICT (email) DO NOTHING;
