--
-- PostgreSQL database dump
--

\restrict iNegLPYjzo6C0HTNg4eHvrmBwuDyh0MaR6b2v22yHxFhVpUQzqBNibIXlQyZqIc

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: protect_teacher_notes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_teacher_notes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.teacher_notes IS DISTINCT FROM NEW.teacher_notes
     AND NOT EXISTS (
       SELECT 1 FROM teacher_profiles
       WHERE id = NEW.teacher_profile_id
         AND teacher_email = auth.jwt() ->> 'email'
     )
  THEN
    RAISE EXCEPTION 'Only the teacher can modify teacher_notes';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_usage; Type: TABLE; Schema: public; Owner: -
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


--
-- Name: class_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    teacher_profile_id uuid NOT NULL,
    teacher_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    block text,
    student_name text,
    CONSTRAINT class_enrollments_block_check CHECK (((block IS NULL) OR (block = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text, 'E'::text, 'F'::text, 'G'::text]))))
);


--
-- Name: TABLE class_enrollments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.class_enrollments IS 'Per-student enrollment rows. teacher_notes stores running teacher observations per student per class.';


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: homework_tasks; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: teacher_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teacher_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    teacher_email text NOT NULL,
    course_name text NOT NULL,
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


--
-- Name: COLUMN teacher_profiles.syllabus_paths; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teacher_profiles.syllabus_paths IS 'Array of storage paths (bucket: syllabi) for the teacher''s uploaded syllabi. Replaces singleton syllabus_file_path. Cap: 20 files per profile, enforced client-side. Phase 1 stores PDFs only; DOCX/JPG/PNG support would extend the bucket''s allowed_mime_types in a follow-up.';


--
-- Name: teacher_work_samples; Type: TABLE; Schema: public; Owner: -
--

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
-- Name: api_usage api_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_pkey PRIMARY KEY (id);


--
-- Name: class_enrollments class_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_pkey PRIMARY KEY (id);


--
-- Name: class_enrollments class_enrollments_student_id_teacher_profile_id_block_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_student_id_teacher_profile_id_block_key UNIQUE (student_id, teacher_profile_id, block);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: homework_tasks homework_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homework_tasks
    ADD CONSTRAINT homework_tasks_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: teacher_profiles teacher_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_profiles
    ADD CONSTRAINT teacher_profiles_pkey PRIMARY KEY (id);


--
-- Name: teacher_profiles teacher_profiles_teacher_email_course_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_profiles
    ADD CONSTRAINT teacher_profiles_teacher_email_course_name_key UNIQUE (teacher_email, course_name);


--
-- Name: teacher_work_samples teacher_work_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_pkey PRIMARY KEY (id);


--
-- Name: teacher_work_samples teacher_work_samples_teacher_profile_id_tier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_teacher_profile_id_tier_key UNIQUE (teacher_profile_id, tier);


--
-- Name: idx_api_usage_email_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_usage_email_date ON public.api_usage USING btree (user_email, created_at);


--
-- Name: idx_api_usage_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_usage_user_date ON public.api_usage USING btree (user_id, created_at);


--
-- Name: idx_enrollments_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_student ON public.class_enrollments USING btree (student_id);


--
-- Name: idx_enrollments_teacher_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollments_teacher_profile ON public.class_enrollments USING btree (teacher_profile_id);


--
-- Name: idx_work_samples_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_samples_profile ON public.teacher_work_samples USING btree (teacher_profile_id);


--
-- Name: class_enrollments protect_teacher_notes_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_teacher_notes_trigger BEFORE UPDATE ON public.class_enrollments FOR EACH ROW EXECUTE FUNCTION public.protect_teacher_notes();


--
-- Name: class_enrollments set_class_enrollments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_class_enrollments_updated_at BEFORE UPDATE ON public.class_enrollments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: conversations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: teacher_profiles set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.teacher_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: teacher_work_samples set_work_samples_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_work_samples_updated_at BEFORE UPDATE ON public.teacher_work_samples FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: api_usage api_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: class_enrollments class_enrollments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: class_enrollments class_enrollments_teacher_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_enrollments
    ADD CONSTRAINT class_enrollments_teacher_profile_id_fkey FOREIGN KEY (teacher_profile_id) REFERENCES public.teacher_profiles(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: homework_tasks homework_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.homework_tasks
    ADD CONSTRAINT homework_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: teacher_work_samples teacher_work_samples_teacher_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teacher_work_samples
    ADD CONSTRAINT teacher_work_samples_teacher_profile_id_fkey FOREIGN KEY (teacher_profile_id) REFERENCES public.teacher_profiles(id) ON DELETE CASCADE;


--
-- Name: api_usage Service role full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access" ON public.api_usage USING ((auth.role() = 'service_role'::text));


--
-- Name: conversations Users can only access own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can only access own conversations" ON public.conversations USING ((auth.uid() = user_id));


--
-- Name: profiles Users can only access own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can only access own profile" ON public.profiles USING ((auth.uid() = id));


--
-- Name: homework_tasks Users can only access own tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can only access own tasks" ON public.homework_tasks USING ((auth.uid() = user_id));


--
-- Name: api_usage Users can view own usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own usage" ON public.api_usage FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: api_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: teacher_profiles auth_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_read ON public.teacher_profiles FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: teacher_work_samples auth_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_read ON public.teacher_work_samples FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: class_enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.class_enrollments ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: homework_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.homework_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: teacher_profiles owner_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_delete ON public.teacher_profiles FOR DELETE USING (((auth.jwt() ->> 'email'::text) = teacher_email));


--
-- Name: teacher_work_samples owner_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_delete ON public.teacher_work_samples FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.teacher_profiles tp
  WHERE ((tp.id = teacher_work_samples.teacher_profile_id) AND (tp.teacher_email = (auth.jwt() ->> 'email'::text))))));


--
-- Name: teacher_profiles owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_insert ON public.teacher_profiles FOR INSERT WITH CHECK (((auth.jwt() ->> 'email'::text) = teacher_email));


--
-- Name: teacher_work_samples owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_insert ON public.teacher_work_samples FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.teacher_profiles tp
  WHERE ((tp.id = teacher_work_samples.teacher_profile_id) AND (tp.teacher_email = (auth.jwt() ->> 'email'::text))))));


--
-- Name: teacher_profiles owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_update ON public.teacher_profiles FOR UPDATE USING (((auth.jwt() ->> 'email'::text) = teacher_email));


--
-- Name: teacher_work_samples owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_update ON public.teacher_work_samples FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.teacher_profiles tp
  WHERE ((tp.id = teacher_work_samples.teacher_profile_id) AND (tp.teacher_email = (auth.jwt() ->> 'email'::text))))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: class_enrollments student_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_insert_own ON public.class_enrollments FOR INSERT WITH CHECK ((auth.uid() = student_id));


--
-- Name: class_enrollments student_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_read_own ON public.class_enrollments FOR SELECT USING ((auth.uid() = student_id));


--
-- Name: class_enrollments student_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY student_update_own ON public.class_enrollments FOR UPDATE USING ((auth.uid() = student_id)) WITH CHECK ((auth.uid() = student_id));


--
-- Name: teacher_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teacher_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: class_enrollments teacher_read_class; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teacher_read_class ON public.class_enrollments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.teacher_profiles
  WHERE ((teacher_profiles.id = class_enrollments.teacher_profile_id) AND (teacher_profiles.teacher_email = (auth.jwt() ->> 'email'::text))))));


--
-- Name: class_enrollments teacher_update_class; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teacher_update_class ON public.class_enrollments FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.teacher_profiles
  WHERE ((teacher_profiles.id = class_enrollments.teacher_profile_id) AND (teacher_profiles.teacher_email = (auth.jwt() ->> 'email'::text))))));


--
-- Name: teacher_work_samples; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teacher_work_samples ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict iNegLPYjzo6C0HTNg4eHvrmBwuDyh0MaR6b2v22yHxFhVpUQzqBNibIXlQyZqIc

