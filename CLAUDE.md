# LUMI — PROJECT ARCHITECTURE REFERENCE

## What Lumi Is
Lumi is an AI-powered edtech tool that replicates a specific teacher's
teaching style for 24/7 student support. Teachers onboard themselves
by being interviewed by the AI, which extracts their pedagogy. Students
then interact with Lumi as if talking to that teacher — but Lumi never
gives direct answers, only guides reasoning.

---

## Two Modes

### MODE 1: TEACHER ONBOARDING
- Lumi interviews the teacher in 8 questions max
- One question per turn, no exceptions
- Minimal validation before each question (one sentence max)
- Prioritize behavioral questions over content questions
- Never ask administrative questions (late work, extensions, etc.)
- Question priority: core learning goals → absolute Lumi boundaries
  → pedagogical sequence → intervention technique (example 1) →
  intervention technique (example 2) → B+ vs A criteria → out of
  scope topics → AI/academic integrity policy
- Stores output as a teacher profile object in Supabase

### MODE 2: STUDENT MODE
- Loads the selected teacher's profile from Supabase
- Guides students through the subject WITHOUT giving direct answers
- Always asks students to walk through their reasoning first
- Never says "that's wrong" — instead: "walk me through how you
  applied the framework to reach that"
- Pushes back on reasoning quality, never on conclusions
- Asks one pointed question when it finds a crack in student logic
- Lets students find their own inconsistencies, never points them out

---

## Data Architecture

### Teacher Profile Object (stored in Supabase: teacher_profiles table)
- Lookup key: teacher_email + class_name (unique constraint on combo)
- Same teacher can have multiple rows, one per class they teach
- Fields: teacher_email, class_name, subject, title (honorific — Mr./
  Mrs./Ms./Mx./Dr., written by the onboarding wizard; added in
  20250420_teacher_title.sql, do not re-add), done, teaching_style,
  excellence_criteria, grading_philosophy, common_mistakes (jsonb),
  explanation_methods, key_values, class_specific_notes,
  teacher_voice, messages_json (jsonb), created_at, updated_at
- RLS: teachers manage own rows (matched by auth email), all
  authenticated users can read (so student sessions can fetch profiles)

### Class Enrollments (Supabase: class_enrollments table)
- Tracks which students are in which classes, with per-student teacher notes
- Columns:
  - id (uuid, PK)
  - student_id (uuid, FK → auth.users)
  - teacher_profile_id (uuid, FK → teacher_profiles.id)
  - block (text, nullable) — Menlo section letter A–G. CHECK constraint
    `class_enrollments_block_check` enforces the range. Nullable only
    exists so the column could be added before backfill; going forward
    the UI requires a letter and syncEnrollments skips entries without
    one.
  - teacher_notes (text, nullable) — running teacher observations
  - created_at, updated_at (timestamptz)
- Unique constraint: (student_id, teacher_profile_id, block). Block is
  part of identity because a future teacher roster needs to group
  students by section, not just by course.
- Menlo context: classes are scheduled in named blocks A–G (not period
  numbers). A single teacher often teaches multiple blocks of the same
  course with identical curriculum — the block letter only identifies
  which students are in which section.
- Classes are identified by teacher_profiles.id — there is no separate
  classes table. teacher_profiles already has a unique (teacher_email,
  course_name), so each row IS a class. If a dedicated classes table is
  ever needed, that is its own refactor, not a drive-by.
- RLS (5 policies):
  - student_read_own (SELECT): auth.uid() = student_id
  - student_insert_own (INSERT): auth.uid() = student_id — required so
    the student-side upsert from syncEnrollments() can write
  - student_update_own (UPDATE): auth.uid() = student_id — required
    because syncEnrollments() upserts on the (student_id,
    teacher_profile_id, block) unique constraint; re-saving a schedule
    converts the conflicting insert into an UPDATE, which fails with
    403 without this policy. Broad on purpose; teacher_notes is
    guarded by a trigger, not by narrowing this policy.
  - teacher_read_class (SELECT): teacher owns the referenced
    teacher_profiles row (matched by auth email)
  - teacher_update_class (UPDATE): same ownership check — scoped to
    teacher_notes edits
- Trigger: `protect_teacher_notes_trigger` (BEFORE UPDATE) rejects any
  update that changes teacher_notes unless the caller's email matches
  the teacher_profiles.teacher_email for the linked class. This is the
  surgical guard that keeps student_update_own from becoming a write
  path into teacher_notes. Defined in
  20260424_student_update_policy_and_notes_protection.sql.
- Enrollment rows are written by syncEnrollments() in app.js, called at
  the end of syncScheduleToSupabase() after the student finalizes their
  schedule. It looks up teacher_profiles by (teacher_email, course_name)
  and only enrolls the student in classes where a matching
  teacher_profiles row exists. Classes whose teacher hasn't onboarded
  yet are skipped silently — no error, no user-visible warning.
  Entries missing a block are also skipped, with a console.warn (belt-
  and-suspenders — the UI already requires a block per class). Upsert
  payload is `{student_id, teacher_profile_id, block}`; onConflict
  targets the 3-column unique constraint. teacher_notes is deliberately
  NOT in the payload so per-student observations survive every re-sync.
- Schedule wizard (app.html + `initScheduleSetup` in app.js) has a
  dedicated block step between teacher selection and study-style: one
  class at a time, 7 square A–G cards, auto-advance on click, required
  for every class. The saved schedule entry shape is now
  `{course, teacher, subject, block}`.
- **Known limitation:** No DELETE policy and no cleanup for dropped
  classes. If a student removes a class from their schedule, the old
  enrollment row persists and the teacher still sees that student on
  their roster. Needs handling before pitching to Menlo admin.

### Other Supabase Tables
- **profiles** — student user profiles (id, name, grade, values_profile jsonb)
- **conversations** — chat history (id, user_id, title, messages jsonb,
  teacher, course, created_at, updated_at)
- Both have RLS scoped to auth.uid()

### System Prompt Architecture
- Built dynamically from teacher profile object at session start
- NEVER rebuilt mid-conversation
- NEVER hardcoded as a string
- Injects: teacher name, subject, philosophy, pedagogy sequence,
  intervention techniques, scope boundaries, never-do list
- For student sessions also injects: student name, grade, current topics
- If no profile found: show student "This teacher hasn't set up their
  Lumi profile yet" — NEVER silently fall back to generic behavior

---

## Known Bugs (track status here)

### BUG 1 — STREAMING: Raw text/code appearing before rendering
- Fix: system prompt must instruct model to always start with plain
  conversational text, never a code block
- Fix: implement streaming-aware markdown renderer (react-markdown)
  that only commits formatted blocks once complete

### BUG 2 — RESPONSES FREEZING / CUTTING OFF MID-SENTENCE
- Fix: max_tokens set to 2500 across all API calls
- Fix: system prompt includes "Always complete your full response.
  If approaching length limits, wrap up your current point concisely
  rather than stopping mid-thought."

---

## Roadmap

### Per-student teacher notes (4-commit sequence)
- ✅ **Commit 1 — schema + enrollment.** class_enrollments table with
  RLS; syncEnrollments() wired into the student schedule flow.
- ✅ **Commit 2a — block column + student block picker.** Added
  `block` (text, A–G via CHECK) to class_enrollments; unique
  constraint swapped to (student_id, teacher_profile_id, block);
  schedule wizard grew a dedicated block step; syncEnrollments now
  includes block in the upsert payload and warns/skips entries
  missing one.
- ⬜ **Commit 2b — teacher roster UI + per-student chat.** Teacher-
  side view of enrolled students grouped by block; click-through to
  an individual student's conversation / notes editor.
- ⬜ **Commit 3 — inject notes into Lumi system prompt.** At student
  session start, read class_enrollments.teacher_notes for the current
  (student, teacher_profile) pair and fold it into the system prompt
  alongside the teacher profile.
- ⬜ **Commit 4 — teacher-notes-influenced suggested prompts.** The
  student-facing suggested-prompt generator takes the teacher's notes
  into account (e.g. if notes say "struggles with proof structure",
  prompts lean that direction).

---

## Existing Teacher Profiles
- Democratic Backsliding — Global Issues (Menlo School)
  Stored in Supabase. DO NOT re-hardcode in app.js.

---

## What NOT To Do
- Do not hardcode teacher profiles in app.js or any frontend file
- Do not use a single lookup key of just teacher_email or just class_name
- Do not silently fall back to generic tutor behavior when no profile exists
- Do not rebuild the system prompt mid-conversation
- Do not ask teachers administrative questions during onboarding

---

## Learnings
- **Manual SQL hacks during testing must be captured as migrations
  before committing the feature.** Commit 2b testing hit two schema
  gaps that were patched directly against the deployed Supabase to
  unblock work:
  - **teacher_profiles.title** — the migration file already existed
    (20250420_teacher_title.sql) but had never been applied to the
    deployed project, so onboarding failed with "Could not find the
    'title' column". Applied by hand. No new migration was needed;
    the fix was just running the existing one.
  - **class_enrollments student_update_own policy +
    protect_teacher_notes trigger** — these had no migration file at
    all. Applied by hand, then back-ported as
    20260424_student_update_policy_and_notes_protection.sql.
  Rule: if you run ad-hoc SQL against the deployed DB, either confirm
  an existing migration covers it (and apply that migration) or write
  a new migration in the same session. Do not ship the feature commit
  until the migrations directory matches what's deployed.

---

## Stack Notes
- **Type:** Static site (no build step, no bundler)
- **Frontend:** Vanilla HTML/CSS/JS — no framework
- **Pages:** index.html (sign-in), app.html (student chat), teacher.html
  (teacher onboarding), admin.html, lumi.html
- **Styling:** style.css (primary, ~75 KB) + styles.css (~18 KB); Inter font via Google Fonts
- **Auth:** Supabase Auth with Google OAuth (implicit flow), restricted to @menloschool.org emails
- **Database:** Supabase (PostgreSQL + RLS) — client initialized in supabase.js using @supabase/supabase-js loaded from CDN
- **AI API:** Anthropic Messages API called directly from the frontend
  - Student tutoring & teacher onboarding: claude-sonnet-4-20250514 (max_tokens: 2500)
  - Lightweight classification tasks: claude-haiku-4-5 (max_tokens: 20)
  - Streaming enabled for student chat (ReadableStream + getReader)
- **Markdown rendering:** Custom lightweight renderer in app.js (no library)
- **Hosting:** GitHub Pages (static deploy)
- **Schema:** See supabase_setup.sql for full table definitions and RLS policies
