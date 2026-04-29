-- Phase 5b: pinned welcome message column for the per-class welcome card
-- shown at the top of every new student thread (rendered by
-- renderPinnedWelcome in app.js, shipped in Phase 5a).
--
-- Nullable on purpose so existing rows (e.g. Mr. Harris's profile, written
-- before this column existed) don't break. The student-side pinned card
-- falls back to a generic "Welcome to {course}. Ask me anything!" string
-- when welcome_message is null — see renderPinnedWelcome's fallback branch.
--
-- No RLS changes needed: existing SELECT/INSERT/UPDATE policies on
-- teacher_profiles already cover this column. Read by any authenticated
-- user who can already read the row (students need it at chat-open
-- time); written by the row's owner via teacher.html's saveTeacherProfile
-- upsert.

ALTER TABLE teacher_profiles
  ADD COLUMN IF NOT EXISTS welcome_message TEXT;
