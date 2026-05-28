--
-- Lumi RDS schema
-- Derived from migration/supabase-schema.sql (Supabase public schema dump, PG 17.6).
-- Target: AWS RDS PostgreSQL 18. No Supabase extensions, RLS, auth.*, or storage.* deps.
--
-- Transformations applied:
--   * Stripped all RLS (7 ENABLE ROW LEVEL SECURITY + 18 CREATE POLICY).
--   * Dropped protect_teacher_notes() + its trigger (depended on auth.jwt());
--     teacher-notes write protection now enforced at the Lambda layer
--     (MIGRATION_HARDENING.md sec 1).
--   * Dropped all 5 FOREIGN KEYs to auth.users; identity columns kept as plain
--     uuid for later Cognito wiring (see note above the FOREIGN KEY section).
--   * Removed dump artifacts (\restrict/\unrestrict, CREATE SCHEMA public).
--   * No CREATE EXTENSION needed: gen_random_uuid() is core PostgreSQL (>= v13).
--
-- New objects (SIS import: MIGRATION_PLAN.md Workstream C / synthetic_data/schema.md):
--   * Table  public.schools                  (multi-tenant root)
--   * Column public.class_enrollments.term
--   * Column public.teacher_profiles.course_code
--

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;

SET default_tablespace = '';
SET default_table_access_method = heap;


--
-- FUNCTIONS
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- TABLES
--

CREATE TABLE public.api_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    user_email text NOT NULL,
    is_teacher boolean DEFAULT false NOT NULL,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE public.class_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    teacher_profile_id uuid NOT NULL,
    teacher_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    block text,
    student_name text,
    term text,
    CONSTRAINT class_enrollments_block_check CHECK (((block IS NULL) OR (block = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text, 'E'::text, 'F'::text, 'G'::text]))))
);


CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    title text,
    messages jsonb DEFAULT '[]'::jsonb,
    teacher text,
    course text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    is_teacher_test boolean DEFAULT false NOT NULL
);


CREATE TABLE public.homework_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    title text,
    class_name text,
    teacher_name text,
    due_date date,
    estimated_minutes integer,
    is_complete boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);


CREATE TABLE public.profiles (
    id uuid NOT NULL,
    name text,
    grade text,
    values_profile jsonb DEFAULT '{"goals": [], "values": [], "interests": []}'::jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    schedule jsonb DEFAULT '[]'::jsonb,
    schedule_updated_at timestamp with time zone,
    semester_banner_dismissed_at timestamp with time zone,
    study_style jsonb DEFAULT '{"label": "Short Bursts", "work_minutes": 25, "break_minutes": 5}'::jsonb,
    google_calendar_token text,
    calendar_connected boolean DEFAULT false,
    learning_style text DEFAULT 'mixed'::text,
    pain_points jsonb DEFAULT '[]'::jsonb,
    typical_activities text DEFAULT ''::text,
    onboarding_complete boolean DEFAULT false,
    homework_start_time text DEFAULT '18:00'::text
);


CREATE TABLE public.schools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE public.teacher_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    teacher_email text NOT NULL,
    course_name text NOT NULL,
    course_code text,
    engagement_rules text,
    teaching_voice text,
    course_info text,
    syllabus_file_path text,
    syllabus_text text,
    syllabus_uploaded_at timestamp with time zone,
    share_course_info boolean DEFAULT false,
    done boolean DEFAULT false,
    suggested_prompts jsonb,
    welcome_message text,
    title text,
    syllabus_paths text[] DEFAULT '{}'::text[]
);


CREATE TABLE public.teacher_work_samples (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    teacher_profile_id uuid NOT NULL,
    tier text NOT NULL,
    description text NOT NULL,
    photo_paths text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT teacher_work_samples_tier_check CHECK ((tier = ANY (ARRAY['progressing'::text, 'proficient'::text, 'exemplary'::text])))
);


--
-- PRIMARY KEY / UNIQUE CONSTRAINTS
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_student_id_teacher_profile_id_block_key UNIQUE (student_id, teacher_profile_id, block);

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homework_tasks
    ADD CONSTRAINT homework_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_name_key UNIQUE (name);

ALTER TABLE ONLY public.teacher_profiles
    ADD CONSTRAINT teacher_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teacher_profiles
    ADD CONSTRAINT teacher_profiles_teacher_email_course_name_key UNIQUE (teacher_email, course_name);

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_teacher_profile_id_tier_key UNIQUE (teacher_profile_id, tier);


--
-- INDEXES
--

CREATE INDEX idx_api_usage_email_date ON public.api_usage USING btree (user_email, created_at);

CREATE INDEX idx_api_usage_user_date ON public.api_usage USING btree (user_id, created_at);

CREATE INDEX idx_enrollments_student ON public.class_enrollments USING btree (student_id);

CREATE INDEX idx_enrollments_teacher_profile ON public.class_enrollments USING btree (teacher_profile_id);

CREATE INDEX idx_work_samples_profile ON public.teacher_work_samples USING btree (teacher_profile_id);


--
-- TRIGGERS (updated_at maintenance)
--

CREATE TRIGGER set_class_enrollments_updated_at BEFORE UPDATE ON public.class_enrollments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.teacher_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_work_samples_updated_at BEFORE UPDATE ON public.teacher_work_samples FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_schools_updated_at BEFORE UPDATE ON public.schools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- FOREIGN KEY CONSTRAINTS
--
-- NOTE: The 5 FKs to auth.users (Supabase) were intentionally dropped. Their
-- identity columns are kept as plain uuid for later Cognito wiring:
--   api_usage.user_id (NOT NULL), class_enrollments.student_id (NOT NULL),
--   conversations.user_id, homework_tasks.user_id, profiles.id (PK, no default).
-- Only the two internal (public.*) foreign keys are retained below.
--

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_teacher_profile_id_fkey FOREIGN KEY (teacher_profile_id) REFERENCES public.teacher_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_teacher_profile_id_fkey FOREIGN KEY (teacher_profile_id) REFERENCES public.teacher_profiles(id) ON DELETE CASCADE;


--
-- COMMENTS
--

COMMENT ON TABLE public.class_enrollments IS 'Per-student enrollment rows. teacher_notes stores running teacher observations per student per class.';

COMMENT ON COLUMN public.teacher_profiles.syllabus_paths IS 'Array of storage paths (bucket: syllabi) for the teacher''s uploaded syllabi. Replaces singleton syllabus_file_path. Cap: 20 files per profile, enforced client-side. Phase 1 stores PDFs only; DOCX/JPG/PNG support would extend the bucket''s allowed_mime_types in a follow-up.';

COMMENT ON TABLE public.schools IS 'Tenant root for multi-tenant SIS imports. Not yet referenced by other tables; school_id foreign keys to be wired in a later migration.';

COMMENT ON COLUMN public.class_enrollments.term IS 'Free-form SIS term label (e.g. "Spring 2026"). Nullable: legacy rows predate SIS import. See synthetic_data/schema.md.';

COMMENT ON COLUMN public.teacher_profiles.course_code IS 'Optional SIS catalog code (e.g. "MATH-301"), shared across all sections of a course_name. See synthetic_data/schema.md.';
