-- Migration: Teacher Profiles V2
-- Replaces the AI interview with a 3-question form wizard

-- Drop the old table structure
DROP TABLE IF EXISTS teacher_profiles CASCADE;

-- Create new simplified schema
CREATE TABLE teacher_profiles (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  teacher_email        TEXT NOT NULL,
  course_name          TEXT NOT NULL,
  engagement_rules     TEXT,
  teaching_voice       TEXT,
  course_info          TEXT,
  syllabus_file_path   TEXT,
  syllabus_text        TEXT,
  syllabus_uploaded_at TIMESTAMPTZ,
  share_course_info    BOOLEAN DEFAULT FALSE,
  done                 BOOLEAN DEFAULT FALSE,
  UNIQUE (teacher_email, course_name)
);

-- Enable RLS
ALTER TABLE teacher_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies (idempotent)
DROP POLICY IF EXISTS "auth_read" ON teacher_profiles;
DROP POLICY IF EXISTS "owner_insert" ON teacher_profiles;
DROP POLICY IF EXISTS "owner_update" ON teacher_profiles;
DROP POLICY IF EXISTS "owner_delete" ON teacher_profiles;

CREATE POLICY "auth_read" ON teacher_profiles FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "owner_insert" ON teacher_profiles FOR INSERT
  WITH CHECK (auth.jwt() ->> 'email' = teacher_email);

CREATE POLICY "owner_update" ON teacher_profiles FOR UPDATE
  USING (auth.jwt() ->> 'email' = teacher_email);

CREATE POLICY "owner_delete" ON teacher_profiles FOR DELETE
  USING (auth.jwt() ->> 'email' = teacher_email);

-- Auto-update updated_at trigger (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS set_updated_at ON teacher_profiles;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON teacher_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
