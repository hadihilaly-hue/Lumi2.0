-- First-run privacy-consent gate: per-account acceptance record.
-- Additive, idempotent. Applied to the live RDS on 2026-07-05 via the
-- IAM-gated adminSql path.
--
-- The /consent route (lambda/index.mjs) reads/sets this; app.html + teacher.html
-- gate an un-consented signed-in user to privacy.html?consent=1 before entry.
-- Consent is recorded once (COALESCE — POST never overwrites an earlier accept).

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamptz;
