-- Teacher Test Mode (TM-1): flag conversations created by a teacher
-- chatting with their own AI persona, so admin analytics + future
-- aggregations can distinguish them from real student conversations.
--
-- DEFAULT FALSE is intentional. Every existing row in `conversations`
-- was written by a student (test mode didn't exist before this commit),
-- so the default correctly classifies historical data with no backfill.
-- New rows from real students will continue to land at false because
-- the student-side write path doesn't set this column. Only writes
-- coming from the test-mode branch in app.js (TM-2) set it to true.
--
-- No RLS changes needed: the existing `auth.uid() = user_id` policy on
-- conversations already isolates rows per user. A teacher's test-mode
-- conversations live under their own auth.uid(), invisible to students.
-- The flag exists purely for filtering inside the teacher's own row set
-- (e.g. excluding test convs from a future admin student-usage report).
--
-- Idempotent via IF NOT EXISTS — safe to re-run.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_teacher_test BOOLEAN NOT NULL DEFAULT FALSE;
