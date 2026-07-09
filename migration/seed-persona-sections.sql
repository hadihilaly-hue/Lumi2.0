-- seed-persona-sections.sql — backfill sections for the 8 synthetic personas.
--
-- Why: GET /available-classes derives a class's `subject` from a single
-- LIMIT-1 subquery on public.sections (by teacher_profile_id). The synthetic
-- personas (synthetic_data/personas.py, seeded by seed_personas.py) were
-- created without any sections rows, so the route returned subject=NULL for
-- all 16 demo classes and the picker bucketed them under a generic header.
-- This one-shot, idempotent script inserts one section per persona class,
-- mapping each course to its department subject.
--
-- Idempotent: safe to re-run. The demo school upserts on its UNIQUE name and
-- each section upserts on the (school_id, sis_id) primary key. This produces
-- rows byte-identical to synthetic_data/seed_personas.py, so whichever of the
-- two runs first leaves the other a no-op.
--
-- Apply via the IAM-gated Lambda adminSql path (see CLAUDE.md → Stack Notes:
-- "Direct DB access for migrations/ops"). Do NOT run against the deployed DB
-- outside that path.
--
-- Scope: touches ONLY the synthetic @lumidemo.test personas and a dedicated
-- "Lumi Demo School" row. No real data (Menlo School, real teacher_profiles)
-- is read or written. Teardown is handled by synthetic_data/cleanup_personas.py
-- (deleting the personas cascades sections; the demo school is dropped too).

BEGIN;

-- 1. The synthetic school — the NOT NULL FK target for sections. allowed_domains
--    is left at its '{}' default on purpose: these accounts never sign in, and
--    we must not open the auth gate to the fake domain. UNIQUE (name) → idempotent.
INSERT INTO public.schools (name)
VALUES ('Lumi Demo School')
ON CONFLICT (name) DO UPDATE SET updated_at = now();

-- 2. One section per persona class. Subject per the department mapping; block and
--    course_name mirror the existing teacher_profiles/class_enrollments rows.
--    sis_id = 'demo-<email local part>-<course slug>', matching the Python seeder.
INSERT INTO public.sections
    (school_id, sis_id, teacher_profile_id, name, course_name, subject, term, block)
SELECT
    (SELECT id FROM public.schools WHERE name = 'Lumi Demo School'),
    'demo-' || split_part(tp.teacher_email, '@', 1) || '-'
        || trim(both '-' from regexp_replace(lower(m.course_name), '[^a-z0-9]+', '-', 'g')),
    tp.id,
    m.course_name || ' — Block ' || m.block,
    m.course_name,
    m.subject,
    'Demo AY2025-26',
    m.block
FROM (VALUES
    ('dferraro@lumidemo.test',   'Algebra II',                 'Mathematics',        'B'),
    ('dferraro@lumidemo.test',   'Precalculus',                'Mathematics',        'D'),
    ('pramaswamy@lumidemo.test', 'Biology',                    'Science',            'A'),
    ('pramaswamy@lumidemo.test', 'AP Biology',                 'Science',            'C'),
    ('nokonkwo@lumidemo.test',   'Music Theory',               'Music',              'E'),
    ('nokonkwo@lumidemo.test',   'Concert Band',               'Music',              'F'),
    ('tbeck@lumidemo.test',      'English 10',                 'English',            'B'),
    ('tbeck@lumidemo.test',      'American Literature',        'English',            'E'),
    ('calvarado@lumidemo.test',  'Spanish II',                 'World Languages',    'C'),
    ('calvarado@lumidemo.test',  'Spanish III',                'World Languages',    'F'),
    ('kzhou@lumidemo.test',      'Intro to Computer Science',  'Computer Science',   'A'),
    ('kzhou@lumidemo.test',      'AP Computer Science A',      'Computer Science',   'D'),
    ('ghalloran@lumidemo.test',  'US History',                 'History',            'B'),
    ('ghalloran@lumidemo.test',  'Government & Politics',      'History',            'G'),
    ('rsantos@lumidemo.test',    'Physical Education 9',       'Physical Education', 'A'),
    ('rsantos@lumidemo.test',    'Health',                     'Physical Education', 'E')
) AS m(teacher_email, course_name, subject, block)
JOIN public.teacher_profiles tp
    ON tp.teacher_email = m.teacher_email
   AND tp.course_name  = m.course_name
ON CONFLICT (school_id, sis_id) DO UPDATE SET
    teacher_profile_id = EXCLUDED.teacher_profile_id,
    name               = EXCLUDED.name,
    course_name        = EXCLUDED.course_name,
    subject            = EXCLUDED.subject,
    term               = EXCLUDED.term,
    block              = EXCLUDED.block,
    updated_at         = now();

COMMIT;

-- Verify (optional): every persona class should now resolve a subject the way
-- GET /available-classes does.
--
--   SELECT tp.course_name,
--          (SELECT s.subject FROM public.sections s
--             WHERE s.teacher_profile_id = tp.id LIMIT 1) AS subject
--     FROM public.teacher_profiles tp
--    WHERE tp.teacher_email LIKE '%@lumidemo.test'
--    ORDER BY subject, tp.course_name;
