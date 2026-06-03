-- Seed: one test enrollment to exercise the RDS class-enrollments / teacher-roster path
-- (GET /class-enrollments?scope=teaching under ?lambda=1).
--
-- Derives teacher_profile_id from (teacher_email, course_name) rather than hardcoding a
-- UUID, so it stays correct if the profile row is recreated. Idempotent (ON CONFLICT).
-- The student_id is a synthetic uuid — fine for the teacher-roster test (the teacher just
-- needs a student to appear in their class). For a STUDENT-scope test, seed a separate row
-- whose student_id is the tester's real auth uid instead.
INSERT INTO class_enrollments (student_id, teacher_profile_id, block, student_name, teacher_notes)
SELECT '00000000-0000-0000-0000-000000000001', tp.id, 'A', 'Test Student',
       '[{"timestamp":"2026-05-28T00:00:00Z","text":"Strong on factoring; nudge on word problems."}]'
  FROM teacher_profiles tp
 WHERE tp.teacher_email = 'hadi.hilaly@menloschool.org'
   AND tp.course_name = 'Algebra 2 with Trig'
ON CONFLICT (student_id, teacher_profile_id, block) DO NOTHING;
