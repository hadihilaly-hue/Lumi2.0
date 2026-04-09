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
- Fields: teacher_email, class_name, subject, done, teaching_style,
  excellence_criteria, grading_philosophy, common_mistakes (jsonb),
  explanation_methods, key_values, class_specific_notes, teacher_voice,
  messages_json (jsonb), created_at, updated_at
- RLS: teachers manage own rows (matched by auth email), all
  authenticated users can read (so student sessions can fetch profiles)

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
