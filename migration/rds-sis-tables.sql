-- SIS importer tables (Workstream D, 2026-07-01).
-- Applied to lumi-db via POST /admin/sql on 2026-07-01 — keep this file in
-- sync with the deployed schema (CLAUDE.md learning: migrations dir must
-- match what's deployed).
--
-- Design (user-confirmed):
--  * `sections` holds full SIS section fidelity (period, room, name) keyed by
--    the SIS's stable class id, scoped per school. The app's roster continues
--    to run on the (student_id, teacher_profile_id, block) model — `block`
--    here is the deterministic bridge letter assigned per (teacher, course)
--    group at import time (1st section by sis_id → 'A', 2nd → 'B', …).
--  * `sis_map` maps stable SIS person-ids to Lumi auth UUIDs so re-imports
--    are idempotent even if an email changes upstream.

CREATE TABLE IF NOT EXISTS public.sections (
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    sis_id text NOT NULL,
    teacher_profile_id uuid NOT NULL REFERENCES public.teacher_profiles(id) ON DELETE CASCADE,
    name text NOT NULL,
    course_name text NOT NULL,
    course_code text,
    subject text NOT NULL,
    term text NOT NULL,
    period integer,
    room text,
    meeting_days text[] DEFAULT '{}'::text[],
    block character(1) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (school_id, sis_id),
    CONSTRAINT sections_block_check CHECK (block IN ('A','B','C','D','E','F','G'))
);

CREATE INDEX IF NOT EXISTS sections_teacher_profile_idx
    ON public.sections (teacher_profile_id);

CREATE TABLE IF NOT EXISTS public.sis_map (
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('teacher', 'student')),
    sis_id text NOT NULL,
    lumi_id uuid NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (school_id, entity_type, sis_id)
);

CREATE INDEX IF NOT EXISTS sis_map_lumi_id_idx ON public.sis_map (lumi_id);
