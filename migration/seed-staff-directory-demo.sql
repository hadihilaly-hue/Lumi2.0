-- seed-staff-directory-demo.sql — the 8 @lumidemo.test synthetic personas into
-- public.staff_directory. Idempotent (name is PK; ON CONFLICT DO UPDATE keeps
-- the row consistent with personas.py on re-run).
--
-- Why this file exists: seed_personas.py writes teacher_profiles + enrollments
-- but never touched staff_directory, so the Lambda GET /teacher-directory
-- returned an emailByName map that omitted every demo teacher. The frontend
-- resolveTeacherEmail("Thomas Beck") then returned undefined and getTeacherProfile
-- fell through to "no profile" for every demo class.
--
-- Names MUST match personas.py exactly and MUST match the schedule strings in
-- synthetic_data/demo_student_schedule.md ("First Last"). staff_directory.name
-- is the primary key and the JSON key the client resolves against — no
-- normalization on either side.
--
-- is_admin is intentionally false on ALL 8 rows: the admin identity is a real
-- teacher seeded out-of-band by the app owner. Setting is_admin=true here
-- would clobber the ADMIN_EMAIL / allowedTeacherEmails the Lambda returns.

INSERT INTO public.staff_directory (name, email, is_admin) VALUES
  ('Dale Ferraro',     'dferraro@lumidemo.test',  false),
  ('Priya Ramaswamy',  'pramaswamy@lumidemo.test', false),
  ('Nadia Okonkwo',    'nokonkwo@lumidemo.test',  false),
  ('Thomas Beck',      'tbeck@lumidemo.test',     false),
  ('Carmen Alvarado',  'calvarado@lumidemo.test', false),
  ('Kevin Zhou',       'kzhou@lumidemo.test',     false),
  ('Greg Halloran',    'ghalloran@lumidemo.test', false),
  ('Rick Santos',      'rsantos@lumidemo.test',   false)
ON CONFLICT (name) DO UPDATE
  SET email = EXCLUDED.email,
      updated_at = now();
