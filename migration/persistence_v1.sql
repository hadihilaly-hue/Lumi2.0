-- =====================================================================
-- persistence_v1.sql — Phase 5 cross-session student memory (FERPA)
-- =====================================================================
--
-- STATUS: SCHEMA APPLIED to lumi-db on 2026-07-08 via the IAM-gated
--   adminSql path (synthetic_data/lambda_admin.py). ENABLEMENT still gated
--   on the §8 open questions (retention window, consent, who-may-view) —
--   real tenants stay at `persistence_enabled = false` until a school
--   opts in under a signed data agreement. The Lumi Demo (synthetic)
--   tenant is seeded at TRUE for voice testing on @lumidemo.test.
--   docs/PERSISTENCE_SPEC.md remains the design of record; this file is
--   the concrete DDL for its Option B (rolling-summary MVP). Re-running
--   is safe — every statement is guarded (idempotency verified live).
--
-- WHAT THIS ADDS:
--   1. schools.persistence_enabled  — per-school feature flag, OFF by default
--      (real students get NO cross-session memory until a school opts in;
--      synthetic @lumidemo.test personas get it enabled for voice testing).
--   2. student_progress_notes       — one rolling progress note per
--      (student, class). Layer 3 of the personalization stack (spec §0).
--      Ships with deleted_at from day one — the whole point of Phase 5.
--
-- FERPA POSTURE (spec §0, §2.1, §6, §10):
--   * The note is an educational-support artifact (SOPIPA educational
--     purpose), NOT an assessment record. It is machine-authored, rolling,
--     and server-internal: it is NEVER returned to the browser (same posture
--     as class_enrollments.teacher_notes) — it exists only to be injected
--     into the system prompt server-side. There is no client route.
--   * DISCARD DEFAULT (spec §0/§2.2): this migration adds NO transcript or
--     embeddings store. The progress note is the ONLY new persisted surface.
--     The working transcript stays in the pre-existing conversations.messages
--     and is summarized in place; nothing new durably retains raw messages.
--   * Soft-delete from day one (deleted_at) so "delete student X" cascades
--     here exactly like the Phase-4 pattern (30-day grace -> hard delete).
--
-- Idempotent: every statement is guarded (IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE). Safe to re-run.
--
-- DEPENDS ON (both already applied to lumi-db):
--   * rds-schema.sql          — public.schools, public.teacher_profiles,
--                               and the shared update_updated_at_column() trigger fn.
--   * rds-school-domains.sql  — public.schools.allowed_domains (the demo-tenant
--                               seed below writes it; the base schools table
--                               does NOT define this column on its own).
--
-- RECONCILED against the live schema on 2026-07-08 (Phase 5 build session):
--   verified schools(name UNIQUE, allowed_domains, updated_at) + the
--   set_schools_updated_at trigger, teacher_profiles.id PK for the FK, and the
--   Phase-4 deleted_at soft-delete convention. No DDL drift; no changes needed.
--
-- Conventions matched from migration/rds-schema.sql + rds-add-deleted-at.sql:
--   * gen_random_uuid() (core PG >= 13; no extension needed).
--   * identity columns are plain uuid with NO FK to app_users — the same
--     choice class_enrollments.student_id / conversations.user_id make
--     (the auth.users FKs were dropped at the RDS cutover; identity is
--     resolved by the Lambda from the JWT, never trusted from the body).
--   * updated_at maintained by the shared update_updated_at_column() trigger.
--   * timestamptz throughout; deleted_at nullable (Phase-4 soft-delete shape).
-- =====================================================================

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;


-- ---------------------------------------------------------------------
-- 1. PER-SCHOOL FEATURE FLAG
-- ---------------------------------------------------------------------
--
-- WHERE THE FLAG LIVES — env var vs. table (tradeoff, per task):
--
--   A per-school boolean COLUMN on public.schools (implemented below) is the
--   right home. The schools table is already Lumi's data-driven per-school
--   config surface — allowed_domains lives there and the Lambda unions it
--   across schools with a 5-min container cache (rds-school-domains.sql).
--   Persistence gating slots into that exact machinery: the Lambda resolves a
--   student's email domain -> school, reads persistence_enabled, and only then
--   loads/writes a Layer-3 note. A column is admin-toggleable per tenant with a
--   single UPDATE, needs no redeploy, is queryable/auditable, and keeps the
--   OFF-by-default privacy invariant enforceable in one place. The alternative,
--   a Lambda ENV VAR (e.g. PERSISTENCE_ENABLED_DOMAINS="lumidemo.test"), is
--   simpler to ship on day one (no schema change) but is global-not-per-tenant,
--   opaque (not visible in the DB alongside allowed_domains), and requires a
--   Lambda redeploy to flip for any school — a poor fit for a flag that will
--   eventually be toggled per AB 1584 / NDPA agreement, per school. We
--   IMPLEMENT the column and FLAG the env-var route as the rejected simpler
--   option, recorded here so the choice is not silently re-litigated.
--
-- FERPA: default FALSE is load-bearing. No school — and therefore no real
-- student — accumulates cross-session memory until an admin explicitly opts
-- the tenant in (which should track the signed data agreement, spec §8 Q1).

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS persistence_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.schools.persistence_enabled IS
  'Phase 5 kill switch for cross-session student memory (student_progress_notes). '
  'FALSE by default: no Layer-3 note is read or written for a student whose school '
  'has not opted in. Flip TRUE per tenant only under a signed data agreement '
  '(AB 1584 / NDPA). The Lambda resolves student email domain -> school -> this flag.';

-- Seed / enable the SYNTHETIC demo tenant only.
-- Synthetic personas (synthetic_data/personas.py) are all on @lumidemo.test —
-- a deliberately fake TLD, no real people. Enabling persistence here lets the
-- voice-capture tests exercise Layer-3 memory without ever touching a real
-- school. Real schools (e.g. 'Menlo School') are left at the FALSE default.
-- Idempotent: ON CONFLICT (schools.name is UNIQUE) flips the flag on for a
-- pre-existing demo row without disturbing anything else.
--
-- NOTE: allowed_domains is set here too because the Lambda's domain->school
-- resolution needs '{lumidemo.test}' to map synthetic students to THIS row;
-- that also gates sign-in for the synthetic domain, which synthetic testing
-- already requires. This adds no real-person sign-in surface (fake TLD).
INSERT INTO public.schools (name, allowed_domains, persistence_enabled)
VALUES ('Lumi Demo (synthetic)', '{lumidemo.test}', true)
ON CONFLICT (name) DO UPDATE
  SET allowed_domains     = EXCLUDED.allowed_domains,
      persistence_enabled = EXCLUDED.persistence_enabled,
      updated_at          = now();


-- ---------------------------------------------------------------------
-- 2. student_progress_notes  (Layer 3 — Lumi's rolling memory)
-- ---------------------------------------------------------------------
--
-- One row per (student, class). "Class" == a teacher_profiles row (per
-- CLAUDE.md + spec §2.1, each teacher_profiles row IS a class; there is no
-- separate classes table). The FK column is named teacher_profile_id to match
-- class_enrollments.teacher_profile_id and teacher_work_samples.
-- teacher_profile_id EXACTLY — the spec calls this concept "class_id", but the
-- established column name in this schema is teacher_profile_id, so we keep it.

CREATE TABLE IF NOT EXISTS public.student_progress_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,

    -- Student identity. Plain uuid, NOT NULL, NO FK — the same shape as
    -- class_enrollments.student_id / conversations.user_id. It holds
    -- app_users.lumi_id, but (like every other table since the RDS cutover)
    -- we do NOT add an FK: identity is resolved and authorized by the Lambda
    -- from the verified JWT, never trusted from a request body. Keeping it
    -- FK-free matches the deployed convention and avoids coupling deletes.
    student_id uuid NOT NULL,

    -- Class identity == teacher_profiles.id. ON DELETE CASCADE mirrors
    -- class_enrollments / teacher_work_samples: if the class row is hard-
    -- deleted, its Layer-3 notes go with it (no orphaned student memory).
    teacher_profile_id uuid NOT NULL,

    -- The §1 structured fields (topics_covered, current_position,
    -- struggle_points, what_worked, last_session_summary) as jsonb — mirrors
    -- conversations.messages. Structured (not free text) so export and the
    -- framing-rule validations run per-field. NOT NULL because a row only
    -- exists once a valid note has been written; a failed first summary
    -- writes no row at all (spec §3 failure table), so there is no
    -- "empty note" state to represent.
    note_content jsonb NOT NULL,

    -- How many chat sessions have rolled into this note. Doubles as the
    -- idempotency watermark for the three summarization triggers (spec §3):
    -- a session already counted here is never summarized twice.
    source_session_count integer DEFAULT 0 NOT NULL,

    -- Approx token size of the current note_content. Telemetry + guardrail for
    -- the ~350-token ceiling (spec §0). FERPA-neutral: a size, never content.
    token_count integer DEFAULT 0 NOT NULL,

    -- Shape version of note_content, for forward-compat. If the §1 field set
    -- changes, the reader/summarizer can branch on this instead of guessing.
    schema_version integer DEFAULT 1 NOT NULL,

    -- Which summarizer produced the current note (e.g. 'claude-haiku-4-5').
    -- Metadata, not model output. Nullable: unknown for a hand-seeded row.
    model_version text,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    -- SOFT DELETE from day one (spec §2.1, §4) — the defining property of
    -- Phase 5. All reads filter `deleted_at IS NULL`. Deletion sets this,
    -- 30-day grace, then a documented hard-delete purge (see §5 below).
    deleted_at timestamp with time zone,

    CONSTRAINT student_progress_notes_pkey PRIMARY KEY (id),

    -- Integrity guards (cheap, and they make bad writes fail loudly rather
    -- than silently corrupting a note):
    CONSTRAINT student_progress_notes_content_is_object
      CHECK (jsonb_typeof(note_content) = 'object'),
    CONSTRAINT student_progress_notes_session_count_nonneg
      CHECK (source_session_count >= 0),
    CONSTRAINT student_progress_notes_token_count_nonneg
      CHECK (token_count >= 0),
    CONSTRAINT student_progress_notes_schema_version_pos
      CHECK (schema_version >= 1),

    -- FK to the class. ON DELETE CASCADE, matching class_enrollments /
    -- teacher_work_samples.
    CONSTRAINT student_progress_notes_teacher_profile_id_fkey
      FOREIGN KEY (teacher_profile_id)
      REFERENCES public.teacher_profiles(id) ON DELETE CASCADE
);

-- ONE LIVE NOTE per (student, class): a PARTIAL unique index (not a table
-- constraint, because the predicate is required). Scoped to non-deleted rows
-- so a soft-deleted note does NOT block writing a fresh one if the student
-- re-enrolls — exactly the spec §2.1 requirement. Every read path MUST also
-- filter `deleted_at IS NULL` to line up with this index.
CREATE UNIQUE INDEX IF NOT EXISTS student_progress_notes_student_class_live_key
    ON public.student_progress_notes (student_id, teacher_profile_id)
    WHERE deleted_at IS NULL;

-- Read-path indexes. The chat Lambda looks a note up by (student_id,
-- teacher_profile_id) at session start; the scheduled summarization sweep
-- (spec §3 trigger 3) and the retention purge scan by student and by class.
CREATE INDEX IF NOT EXISTS idx_progress_notes_student
    ON public.student_progress_notes (student_id);
CREATE INDEX IF NOT EXISTS idx_progress_notes_teacher_profile
    ON public.student_progress_notes (teacher_profile_id);

-- updated_at maintenance — reuse the shared trigger function already defined
-- in rds-schema.sql. CREATE OR REPLACE TRIGGER is idempotent on PG 14+
-- (this schema targets RDS PostgreSQL 18).
CREATE OR REPLACE TRIGGER set_progress_notes_updated_at
    BEFORE UPDATE ON public.student_progress_notes
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.student_progress_notes IS
  'Phase 5 Layer-3 rolling student memory: one machine-authored progress note '
  'per (student, class). Server-internal ONLY — never returned to the browser '
  '(same posture as class_enrollments.teacher_notes); injected into the system '
  'prompt at chat start. Discard default: this is the ONLY new persisted surface '
  '(no transcript/embeddings store). Soft-delete from day one (deleted_at).';
COMMENT ON COLUMN public.student_progress_notes.note_content IS
  'Structured §1 fields (topics_covered, current_position, struggle_points, '
  'what_worked, last_session_summary). Neutral-observation framing, no deficit '
  'language, no third-party PII, pedagogy-not-grades (spec §1, post-validated).';
COMMENT ON COLUMN public.student_progress_notes.deleted_at IS
  'Soft-delete tombstone (Phase-4 pattern). Reads filter IS NULL; 30-day grace; '
  'then hard-delete purge (see the retention section of this migration).';


-- ---------------------------------------------------------------------
-- 3. RETENTION + HARD-DELETE PURGE TEMPLATES  (COMMENTED — see spec §7)
-- ---------------------------------------------------------------------
--
-- Left COMMENTED OUT because the retention WINDOW is an OPEN DECISION
-- (spec §7 / §8 Q1 — school-contract dependent). 365 days is the placeholder
-- default (survives a full academic year + summer, and does not persist
-- indefinitely). Do NOT wire these into a schedule until the window is
-- confirmed in the AB 1584 / NDPA agreement.
--
-- These run via the IAM-gated direct-invoke `adminSql` branch (the only
-- direct-DB path; HTTP-unreachable by design), same as every purge in this repo.
--
-- (a) RETENTION SOFT-DELETE — retire notes untouched for the retention window.
--     Parameterized on the window; default 365 days. Enters the 30-day grace.
--
--     UPDATE public.student_progress_notes
--        SET deleted_at = now()
--      WHERE deleted_at IS NULL
--        AND updated_at < now() - interval '365 days';   -- <-- retention window (OPEN)
--
-- (b) HARD-DELETE PURGE — permanently remove rows past the 30-day grace
--     (spec §4). Mirrors the Phase-4 hard-delete procedure in docs/COMPLIANCE.md.
--
--     DELETE FROM public.student_progress_notes
--      WHERE deleted_at IS NOT NULL
--        AND deleted_at < now() - interval '30 days';    -- fixed 30-day grace
--
-- NOTE ON THE "delete student X" CASCADE (spec §4): a per-student soft delete
-- is keyed on student_id and belongs in the Lambda's softDeleteUserRows()
-- cascade (lambda/index.mjs) alongside the other student-owned tables:
--
--     UPDATE public.student_progress_notes
--        SET deleted_at = now()
--      WHERE student_id = $1 AND deleted_at IS NULL;
--
-- That wiring is a Lambda change, intentionally NOT made here (this file is
-- schema-only). Flagged so it is not forgotten when the route work lands.


-- =====================================================================
-- ROLLBACK  (commented — copy/paste to reverse this migration)
-- =====================================================================
-- Run inside a single transaction. Order: drop the child table first, then
-- the flag column. The seeded demo school row is left in place by default
-- (dropping a tenant is a heavier decision than reverting DDL); the optional
-- last statement removes it if a clean teardown is wanted.
--
-- BEGIN;
--   DROP TABLE IF EXISTS public.student_progress_notes;   -- table drop also
--                                                          -- removes its
--                                                          -- indexes + trigger
--   ALTER TABLE public.schools DROP COLUMN IF EXISTS persistence_enabled;
--   -- Optional full teardown of the synthetic tenant seeded above:
--   -- DELETE FROM public.schools WHERE name = 'Lumi Demo (synthetic)';
-- COMMIT;


-- =====================================================================
-- HOW TO APPLY AND VERIFY  (historical — this file was applied 2026-07-08)
-- =====================================================================
-- APPLY (IAM-gated direct-invoke adminSql path — the only direct-DB route;
--        never over the Lambda Function URL):
--   1. Resolved: OFF-by-default confirmed for every real tenant; §8
--      open questions still tracked in docs/PERSISTENCE_SPEC.md §8 for the
--      *enablement* decision. This migration only lays down the schema and
--      seeds the synthetic tenant — no real student gets memory yet.
--   2. Sent through the adminSql branch on 2026-07-08 via
--      synthetic_data/lambda_admin.py (boto3 `aws lambda invoke` with an
--      {"adminSql": "...", "params": [...]} payload). Idempotent — re-running
--      is a no-op.
--
-- VERIFY (read-only queries through the same adminSql path):
--   * Flag exists and defaults OFF for real tenants, ON only for the demo:
--       SELECT name, persistence_enabled, allowed_domains FROM public.schools;
--       -- expect: 'Menlo School' -> false; 'Lumi Demo (synthetic)' -> true.
--   * Table + soft-delete column present:
--       SELECT column_name, data_type, is_nullable
--         FROM information_schema.columns
--        WHERE table_name = 'student_progress_notes' ORDER BY ordinal_position;
--       -- expect deleted_at timestamptz nullable; note_content jsonb NOT NULL.
--   * Partial-unique + FK enforce one live note per (student, class):
--       \d+ public.student_progress_notes
--       -- expect student_progress_notes_student_class_live_key
--       --   UNIQUE ... WHERE (deleted_at IS NULL)
--       -- and the teacher_profile_id FK ON DELETE CASCADE.
--   * Soft-delete round-trip does NOT block a re-insert (partial-index proof),
--     using a throwaway teacher_profiles.id for :cid and any uuid for :sid:
--       INSERT INTO public.student_progress_notes (student_id, teacher_profile_id, note_content)
--         VALUES (:sid, :cid, '{}'::jsonb);
--       UPDATE public.student_progress_notes SET deleted_at = now()
--         WHERE student_id = :sid AND teacher_profile_id = :cid;
--       INSERT INTO public.student_progress_notes (student_id, teacher_profile_id, note_content)
--         VALUES (:sid, :cid, '{}'::jsonb);   -- must SUCCEED (live row is unique, dead one ignored)
--       -- clean up: DELETE FROM public.student_progress_notes WHERE student_id = :sid;
--   * Idempotency: re-run this whole file; it should complete with no errors
--     and create nothing new.
-- =====================================================================
