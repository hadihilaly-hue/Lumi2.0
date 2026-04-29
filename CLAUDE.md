# LUMI — PROJECT ARCHITECTURE REFERENCE

## Next session priorities

> **TODO (next session — not part of redesign):** Voice-mode TTS is
> auto-playing on Mr. Harris's replies without the student clicking the
> speaker icon. Required behavior: TTS must be opt-in only — audio only
> plays when the student taps the speaker icon next to a specific
> message. Investigate (a) whether the speech-synthesis API is being
> triggered unconditionally in `renderMsg()` or `fetchLumi()`, (b)
> whether there's a localStorage flag (`_voiceSetting` etc.) controlling
> this that's defaulting to "on", (c) whether the recent voice-mode UI
> polish commit `8400da5` accidentally removed an opt-in gate. Fix
> should land before any real student tester (Mr. Harris's class) hits
> the app — surprise audio in a quiet study environment is a real
> problem. Surfaced after the visual refresh shipped end-to-end on
> 2026-04-29.

## What Lumi Is
Lumi is an AI-powered edtech tool that replicates a specific teacher's
teaching style for 24/7 student support. Teachers onboard themselves
by being interviewed by the AI, which extracts their pedagogy. Students
then interact with Lumi as if talking to that teacher — but Lumi never
gives direct answers, only guides reasoning.

---

## Two Modes

### MODE 1: TEACHER ONBOARDING
- Static multi-step wizard in teacher.html (replaced the original AI
  interview in commit f906bba). Steps:
  1. Title dropdown (Mr./Ms./Mrs./Mx./Dr.) + engagement-rules textarea
     ("How do you want students to engage with Lumi?")
  2. Teaching-voice textarea ("What does your teaching voice sound
     like?")
  3. Course-info textarea ("What do students need to know about your
     course?") + optional syllabus PDF upload (text extracted via
     pdf.js, stored in syllabus_text)
  4. Welcome message textarea (Phase 5b) — pinned to the top of every
     new student thread. Stored as `welcome_message TEXT` on
     teacher_profiles. Soft 600-char counter, hard 80-char min.
  5. Graded work samples — three tiers (progressing / proficient /
     exemplary). Per tier: up to 3 photos + a description of what the
     teacher looks for at that level. HEIC photos are converted to
     JPEG client-side via heic2any before upload. See "teacher_work_
     samples" under Data Architecture and the "Q4 graded work samples"
     entry under Roadmap → Implemented.
  6. Review summary cards with Edit buttons + share-course-info
     checkbox + Save
- Steps 1–3 each require a 50-word minimum before Continue is enabled.
  Step 4 (welcome message) requires 80 characters minimum, soft-limited
  at 600 (counter color-shifts past 600 but never blocks). Step 5 (work
  samples) requires ≥1 photo and a non-empty description for every tier.
- Stores text answers as flat TEXT columns on teacher_profiles
  (not JSONB); syllabus PDF goes to the `syllabi` Storage bucket;
  work-sample photos go to the `work-samples` bucket; per-tier
  photo paths + description rows live in teacher_work_samples (one
  row per tier per teacher_profile_id). See Data Architecture and
  the Storage bucket inventory for the full picture.

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
  teacher_voice, welcome_message (Phase 5b — pinned welcome card body,
  added in 20260429_teacher_welcome_message.sql, nullable), messages_json
  (jsonb), created_at, updated_at
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

### teacher_work_samples (Q4)
- Stores per-tier graded student-work photos + descriptions, one row
  per (teacher_profile_id, tier). Tier is constrained to
  `progressing | proficient | exemplary`.
- Columns: id, created_at, updated_at, teacher_profile_id (UUID FK
  → teacher_profiles, ON DELETE CASCADE), tier, description (TEXT
  NOT NULL), photo_paths (TEXT[] of paths inside the work-samples
  bucket).
- UNIQUE (teacher_profile_id, tier) — exactly 3 rows max per teacher
  profile.
- RLS mirrors teacher_profiles ownership: any authenticated user can
  SELECT (students need it at feedback time); INSERT/UPDATE/DELETE
  require the JWT email to match the linked teacher_profiles.teacher
  _email via a JOIN check. Defined in
  20260427_teacher_work_samples.sql.
- Writes happen in teacher.html `saveTeacherProfile()` after the
  teacher_profiles upsert returns the row id. Reads happen in
  app.js `getTeacherProfile()` and are converted to base64 images
  by `loadWorkSampleImages()` at chat-open.

### Storage bucket inventory
- **`syllabi`** — teacher syllabus PDFs. Created via Supabase dashboard;
  no SQL definition or bucket-level RLS in any migration (gap to close
  if it ever bites). Path convention `{teacher_email}/{course_name}/
  {timestamp}_{filename}.pdf`. Written from `saveTeacherProfile()` in
  teacher.html.
- **`work-samples`** (Q4) — graded student-work photos. Defined in
  SQL by 20260427_teacher_work_samples.sql, NOT via dashboard.
  Private, 10MB per file, allowed_mime_types restricted to
  JPEG/PNG/WebP. HEIC is intentionally excluded because Claude's
  vision API doesn't accept it; teacher.html converts HEIC → JPEG
  client-side via the heic2any CDN script before upload. Storage
  policies on storage.objects use the standard
  `(storage.foldername(name))[1] = auth.jwt() ->> 'email'` owner
  pattern. Path convention
  `{teacher_email}/{course_name}/{tier}/{timestamp}_{filename}`.

### System Prompt Architecture
- Built dynamically from teacher profile object at session start
- NEVER rebuilt mid-conversation
- NEVER hardcoded as a string
- Injects: teacher name, subject, philosophy, pedagogy sequence,
  intervention techniques, scope boundaries, never-do list
- For student sessions also injects: student name, grade, current topics
- If no profile found: show student "This teacher hasn't set up their
  Lumi profile yet" — NEVER silently fall back to generic behavior

### Per-student teacher notes injection (commit 3)
- `buildTutorSystem(subject, course, teacher, teacherProfile,
  teacherNotes = [])` in app.js takes notes as a 5th parameter
  (defaults to `[]`). On the profile branch, the assembled notes
  section is spliced between the "Response length: SHORT" line and
  the "After EVERY reply, append this JSON" rule — `${buildTeacher
  NotesSection(teacherNotes)}` is concatenated to the SHORT line so
  it lands inside the prompt body, not after the JSON instruction.
- The no-profile fallback branch is unchanged: notes are not queried
  and not injected when there is no teacher_profile_id. There is
  nowhere to scope a class_enrollments lookup without a profile.id.
- `finishOpenTutor()` in app.js fetches teacher_notes from
  class_enrollments scoped to (currentUser.id, profile.id) using
  `.maybeSingle()`, wrapped in `Promise.race` against a 5s timeout
  so the chat open never hangs on a slow query. Result is stored on
  `S.tutorCtx.teacherNotes` and read by buildTutorSystem when the
  prompt is built.
- All failure modes silently produce no notes section: timeout
  (resolves to null), generic error, and the multi-block collision
  case where a student is enrolled in two blocks of the same class
  (Supabase returns PGRST116 / "multiple rows"). Each path leaves
  `S.tutorCtx.teacherNotes = []` and logs a console.warn for
  developers; the student sees no error.
- Helpers (both in app.js):
  - `parseNotes(raw)` — graceful JSON parse; returns `[]` on null
    or malformed input. Mirrors the parseNotes() in teacher.html
    intentionally — the read side and write side must agree on the
    `[{ timestamp, text }, ...]` shape.
  - `buildTeacherNotesSection(notes)` — assembles header + joined
    note texts + footer. Caps the assembled section at 8000 chars
    by dropping oldest entries first (`texts.shift()` in a loop)
    and emits `console.warn` reporting the dropped count when
    truncation occurs.
- The footer of the notes section explicitly instructs Lumi to use
  the notes silently and never reference them to the student: "Use
  these notes silently to shape your teaching approach for this
  student. Do not mention, reference, or reveal that these notes
  exist." This is part of the prompt, not a code-level guardrail —
  if a future edit weakens or removes it, Lumi may start leaking
  notes back to students.

### Per-class suggested prompts (commit 4)
- The empty-state of a tutor session shows three "starter" chips. As
  of commit 4, chip text is sourced via a **2-tier precedence**:
  1. `S.tutorCtx.teacherNotes` non-empty → call
     `generateInfluencedPrompts()` for three Haiku-generated chips
     (one generic, one neutral topic-influenced, one curiosity-framed
     topic-influenced). On any Haiku failure (timeout, malformed
     JSON, validation reject) → fall through to tier 2.
  2. Notes empty (or tier 1 failed) → `getFallbackPrompts()` returns
     3 random entries (Fisher–Yates) from `STATIC_FALLBACK_PROMPTS`.
- Result is cached on `S.tutorCtx.suggestedPrompts` and re-shuffled
  in slot order on each render so influenced chips don't always
  occupy the same positions.
- **Helpers (all in app.js):**
  - `STATIC_FALLBACK_PROMPTS` — module-level const near the top of
    the file with other constants. 9 voice-neutral, class-agnostic
    prompts covering homework, practice, review, explain, quiz,
    work-through, study-prep, explore, and challenge action types.
    Each ≤ 60 chars, no deficit framing.
  - `getFallbackPrompts()` — Fisher–Yates shuffle a copy of the
    static list, slice 3. Called from both `prepareSuggestedPrompts`
    (orchestrator path) and `renderEmptyState` (defensive fallback
    if `S.tutorCtx.suggestedPrompts` is unset).
  - `generateInfluencedPrompts(notesText, courseName)` — Haiku call
    (`claude-haiku-4-5`, max_tokens 200, temperature 0.7), wrapped
    in a 5s `Promise.race` timeout. Validates: response is a JSON
    array of exactly 3 strings, each ≤ 80 chars, none containing
    the literal student email or full name (privacy guard against
    accidental note leakage). Throws on any failure; caller catches.
  - `prepareSuggestedPrompts()` — orchestrator. Reads
    `S.tutorCtx.teacherNotes` and `S.tutorCtx.course`, runs the
    precedence, writes to `S.tutorCtx.suggestedPrompts`, logs
    `[suggested_prompts] mode=influenced count=3` or
    `[suggested_prompts] mode=fallback count=3`.
  - The three function helpers are grouped between
    `getHomeworkOverridePrompt` and `renderEmptyState` in app.js.
- **Wiring:** `prepareSuggestedPrompts()` is `await`-ed inside
  `finishOpenTutor()` on the profile branch, after
  `S.tutorCtx.teacherNotes` is populated and before the `setTimeout`
  that calls `renderEmptyState`. Worst-case adds the 5s Haiku
  timeout to chat-open latency; typical is sub-second.
- **Render:** `renderEmptyState()` reads
  `S.tutorCtx.suggestedPrompts`, applies its own Fisher–Yates
  shuffle for slot randomization, then applies the homework
  override (replaces position 0 with `Help me with [task] (due
  [relative])` if a homework task is due within 3 days). The shuffle
  is per-render, so two consecutive opens with identical cached
  prompts still show different slot orders.
- **Design rules baked into the Haiku system prompt:**
  - Chip 1: generic study prompt (camouflage — same shape as a
    no-notes session would show).
  - Chip 2: neutral-framed, topic-influenced
    (e.g. "Want to try some factoring practice?").
  - Chip 3: curiosity-framed, topic-influenced
    (e.g. "What's a clean way to factor quadratics?").
  - NEVER deficit language ("you're struggling with", "to help with
    your weak area", "I'm bad at", "I keep failing", "Help me catch
    up"). Both at the LLM-instruction level and via post-validation.
  - If notes are vague or topic-less, the model is instructed to
    return three generic chips rather than invent a topic.
- **Failure modes** (all silent → static fallback; each logs a
  `console.warn` for developers):
  - Haiku 5s timeout
  - Network/proxy error (incl. 429 rate-limit)
  - Malformed JSON in response
  - Wrong array shape/length
  - A chip > 80 chars
  - A chip contains the student email or full name (privacy guard)
- **`teacher_profiles.suggested_prompts` is now dormant on the
  read side.** The 20250417 migration added the column; teacher.html
  still WRITES it during onboarding (`generateSuggestedPrompts()`
  ~line 1605). After commit 4 the student-side render no longer
  consults it, and production data confirms the column is unused
  in practice (Mr. Harris's row is NULL). **Cleanup item — not
  addressed in commit 4:** either (a) remove the onboarding-side
  generation as dead code, or (b) re-wire it as a deliberate future
  feature (e.g. per-class teacher-curated chip overrides that
  outrank both notes-influenced and static-fallback). Pick one
  before the next teacher-side change in this area.

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
- ✅ **Commit 2b — teacher roster UI + per-student chat.** Teacher-
  side view of enrolled students grouped by block; click-through to
  an individual student's conversation / notes editor.
- ✅ **Commit 3 — inject notes into Lumi system prompt.** At student
  session start, read class_enrollments.teacher_notes for the current
  (student, teacher_profile) pair and fold it into the system prompt
  alongside the teacher profile. See "Per-student teacher notes
  injection" under System Prompt Architecture for the splice point,
  failure modes, helpers, and silent-use instruction.
- ✅ **Commit 4 — teacher-notes-influenced suggested prompts.** Two-tier
  precedence: notes present → Haiku-generated chips (one generic, one
  neutral topic-influenced, one curiosity-framed topic-influenced); notes
  absent (or Haiku call fails) → 3 random chips from a 9-item static
  fallback list. See "Per-class suggested prompts (commit 4)" under
  Data Architecture for the helper inventory, validation rules, and the
  dormant-column cleanup item. **The 4-commit per-student teacher notes
  feature is now COMPLETE — ready for real teacher testing with
  Mr. Harris.**

### Q4 graded work samples + one-piece feedback rule (✅ shipped)
- **What it is.** Onboarding gained a 5th step (now Step 4, with the
  review pushed to Step 5) where teachers upload up to 3 photos per
  performance tier — progressing / proficient / exemplary — plus a
  description of what they look for at that level. At student-feedback
  time, those photos are sent to Claude as vision input and the
  descriptions are spliced into the system prompt so Lumi's feedback
  voice mimics the teacher's actual graded comments.
- **Schema + bucket.** New table `teacher_work_samples` (one row per
  tier, FK to teacher_profiles, ON DELETE CASCADE) and a new private
  Storage bucket `work-samples` (10MB cap, JPEG/PNG/WebP only — HEIC
  excluded because Claude's vision API doesn't accept it; teacher.html
  converts HEIC → JPEG client-side via the heic2any CDN script before
  upload). Defined in `supabase/migrations/20260427_teacher_work_samples.sql`.
- **Banner for existing teachers.** Profiles that are `done: true` but
  missing one or more tiers show a yellow callout inside the home-card
  saying "New step added — please add a few graded work samples".
  Banner click opens the wizard at `{ jumpToStep: 4 }`. The `done` flag
  stays true so students aren't blocked while the teacher fills the
  gap.
- **Single-source-of-truth gate.** `loadWorkSampleImages()` in app.js
  returns null on any shortfall — missing tier, no photos, no
  description, signed-URL failure, fetch failure. The result lives at
  `S.tutorCtx.workSamples`. Both `buildTutorSystem()` (description
  block) and `buildApiMessages()` (synthetic image-prepend exchange)
  read this same object and share a `hasAllTiers` check that is true
  iff every tier has loaded images AND a non-empty description. When
  it's false, ZERO bytes of work-samples wiring land in the prompt
  AND the synthetic exchange is skipped — the result is byte-identical
  to the pre-Q4 prompt + message array for that concern.
- **Synthetic exchange is NOT in S.messages.** `buildApiMessages(S)`
  builds it lazily inside fetchLumi's call to callAPI; S.messages
  itself is never mutated, so the chat UI stays clean and reloaded
  conversations don't grow phantom messages. cache_control: ephemeral
  on the last image keeps the image batch warm across turns.
- **Feature B (one-piece feedback).** Two new ALWAYS bullets in
  STUDENT MODE RULES instruct Lumi to deliver feedback one point at
  a time and to push back warmly when the student asks for everything
  at once. These are universal (not gated on workSamples) — every
  profile-branch prompt gets them.
- **Cleanup items left untouched (do not bundle into Q4 follow-ups).**
  - `netlify/functions/anthropic.mjs` is dead since the Supabase
    Edge Function migration in commit 22a3dd5 — remove in its own
    cleanup commit.
  - The `syllabi` bucket has no SQL definition; it lives in dashboard
    state only. Worth back-filling a no-op migration so it's visible
    to anyone reading `supabase/migrations/`.
  - `teacher_profiles.suggested_prompts` is still write-only on the
    teacher side (per the commit-4 cleanup note in Data Architecture).
    Q4 did NOT re-wire it.

### Visual refresh — cream/navy/orange palette (✅ shipped April 2026)
- **What it is.** End-to-end visual refresh of the student-facing app.
  Replaced the purple palette with a warm cream/navy/orange editorial
  treatment, swapped sans-serif chat bubbles for serif Lumi prose with
  no chrome, added a pinned welcome card at the top of every new
  thread, and gave teachers a wizard step to write their own welcome
  message. Seven commits, no functional regressions.
- **Phases shipped.**
  - Phase 1 — cream/navy/orange CSS tokens + serif typography token.
  - Phase 2a/2b — sidebar restructure: Today section, My Classes with
    teacher subtext, Lumi serif wordmark, navy New chat button, user
    card with grade subtitle.
  - Phase 3 — empty-state home view: Welcome back greeting (conditional
    on no pinned welcome), 3 starter cards with STUDY/FEEDBACK/CONCEPT
    tags, "Where you left off" resume row, dashed dividers.
  - Phase 4 — chat shell: Lumi messages drop bubble chrome and pick up
    `--font-serif`; user bubble color bug fix (`#fff` → `var(--text)`,
    a Phase-1-introduced regression that went unnoticed for several
    commits); initials avatar; text-based "is thinking · reading your
    packet" pill; thumbs/copy feedback row (copy is functional, thumbs
    are visual stubs).
  - Phase 5a — pinned welcome card with orange washi-tape graphic,
    initials avatar, "FROM TEACHER · WRITTEN DURING SETUP" tag, dashed
    divider, serif body, italic signoff. Card is NOT pushed to
    S.messages — only renders for new threads, never for loadConv'd
    continued threads.
  - Phase 5b — `welcome_message TEXT` column on teacher_profiles
    (nullable; existing rows fall back to "Welcome to {course}. Ask me
    anything!"). New Step 4 in the onboarding wizard with banner
    callout for `done` profiles missing a welcome message.
  - Phase 6 — input-bar polish, feedback-label drop, purple-residue
    grep + tokenisation, switch from static `?v=N` to dynamic
    `?t=Date.now()` cache-busting (see Stack Notes).
- **Cache-busting convention (Phase 6).** All HTML pages that load
  `style.css` now use the same dynamic pattern app.js has used since
  the start: `<script>document.write('<link rel="stylesheet"
  href="style.css?t=' + Date.now() + '">');</script>`. Every page
  load gets a fresh URL so browsers can't serve cached CSS. The static
  `?v=N` pattern caused a Phase-4 cache-stale incident that cost a
  full debugging cycle — the dynamic pattern eliminates that risk.
  Trade-off: zero browser-side caching of CSS. Acceptable for a
  single-file CSS app at this scale.
  - **Low-priority follow-up:** `document.write` is quietly deprecated
    and may break in a future browser version or under a strict-mode
    iframe. Works in all production browsers today; if/when warnings
    surface, migrate to the `document.createElement('link')` +
    `appendChild` pattern (synchronous enough during head parsing to
    avoid FOUC in practice). No action needed today.
- **Deferred items (real-user signal needed before building).**
  - **Inline pedagogy moment indicator.** The intro slide carries the
    three pedagogy principles; the design also showed a per-message
    "HOW MR. HARRIS TEACHES · principle 01" tag inline in the chat.
    Implementing that would require either (a) Lumi tagging its own
    turns (system-prompt change, conflicts with current pedagogy
    guardrails) or (b) heuristic client-side classification (fragile).
    Held until a teacher asks for it.
  - **Thinking-state phrasing rotation.** Today the typing indicator
    has two phrasings ("is thinking" / "is thinking · reading your
    packet"). A richer rotation tied to actual conversation context
    (e.g. "cross-checking against doc 3", topic-aware variants for
    the active project / homework task) is sketched in the inline
    TODO at `app.js` makeTyping().
  - **DOM id rename `sbUserEmail` → `sbUserSubtitle`.** Phase 2b
    swapped the rendered content from email to "11th · Menlo" but
    kept the legacy id. Naming-only cleanup; no behaviour change.

### Roadmap: Post-commit-4 feature ideas

> These features emerged during commit 3 design discussions. Commits 3
> and 4 are now both shipped — the base per-student teacher notes
> feature is complete. These follow-ons remain deliberately deferred
> until Mr. Harris (or other real teachers) have tested the base
> feature. Real user signal should validate (or kill) these before we
> invest in building them.

1. **Student-facing reflection tool.** Students can ask Lumi "what
   have I been struggling with?" or "what should I review for finals?"
   Lumi summarizes based on their conversation history and
   teacher_notes. Useful for self-directed study and finals prep.
   Open questions: how far back does Lumi look? do teachers see this
   too?

2. **Teacher-facing class-level analytics.** Teachers open a class/
   block-level chat (not per-student) and ask aggregate questions,
   e.g. "What are Block B students struggling with this week?" Lumi
   reads across all enrollment rows for that block plus their linked
   conversation histories. Requires new RLS thinking: teachers
   reading aggregate data across students. Requires new data capture:
   tagging student chat interactions with topics/concepts.

3. **Pattern detection in student help requests.** Teachers see what
   topics students are most commonly asking Lumi for help with —
   could surface as "3 students asked about factoring this week —
   maybe reteach?" Requires: student conversation classification,
   aggregation across blocks, a dashboard UI for teachers.

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

- **Seeding teacher_notes for read-side testing requires bypassing
  the protect_teacher_notes trigger.** When testing commit 3, you
  cannot just `UPDATE class_enrollments SET teacher_notes = '...'`
  from the Supabase SQL Editor as the postgres role —
  protect_teacher_notes_trigger correctly rejects any UPDATE that
  changes teacher_notes unless the caller's email matches the
  linked teacher_profiles.teacher_email. The postgres role has no
  matching email, so the seed update fails. This is the trigger
  doing its job, not a bug. Workaround: wrap the seed in a single
  SQL block that disables the trigger, runs the update, and
  re-enables it:

  ```sql
  ALTER TABLE class_enrollments DISABLE TRIGGER protect_teacher_notes_trigger;
  UPDATE class_enrollments SET teacher_notes = '...' WHERE id = '...';
  ALTER TABLE class_enrollments ENABLE TRIGGER protect_teacher_notes_trigger;
  ```

  Always re-enable inside the same block — running the lines
  separately leaves a window where the table is unprotected, and a
  failed UPDATE in the middle would leave the trigger off entirely.

- **Verifying the influenced-mode failure path is hard to reproduce
  live.** When testing commit 4, DevTools "Offline" mode may serve
  cached responses for the claude-proxy URL, masking the
  notes-present-but-Haiku-fails fallback path. The fallback path
  itself IS exercised on the very first class-open in fallback mode
  (no notes seeded), which is sufficient verification of the
  chip-rendering code path. The notes-present-but-Haiku-fails case
  is well-defined by the try/catch + 5s `Promise.race` structure
  even when reproducing it live is awkward — trust the structure
  rather than blocking the commit on a flaky live repro.

---

## Stack Notes
- **Type:** Static site (no build step, no bundler)
- **Frontend:** Vanilla HTML/CSS/JS — no framework
- **Pages:** index.html (sign-in), app.html (student chat), teacher.html
  (teacher onboarding), admin.html, lumi.html
- **Styling:** style.css (primary, ~75 KB) + styles.css (~18 KB); Inter font via Google Fonts
- **Auth:** Supabase Auth with Google OAuth (implicit flow), restricted to @menloschool.org emails
- **Database:** Supabase (PostgreSQL + RLS) — client initialized in supabase.js using @supabase/supabase-js loaded from CDN
- **AI API:** Anthropic Messages API via Supabase Edge Function proxy
  at `supabase/functions/claude-proxy/index.ts` (migrated in commit
  22a3dd5). The proxy validates JWT auth, enforces a 2500 max_tokens
  ceiling, restricts to an ALLOWED_MODELS whitelist, applies per-user
  daily rate limits (500/day teachers, 100/day students), logs token
  usage to `api_usage`, then relays the body to Anthropic without
  modifying system prompts or messages. Image content blocks are
  passed through unchanged.
  - Student tutoring & teacher onboarding: claude-sonnet-4-20250514 (max_tokens: 2500)
  - Lightweight classification tasks: claude-haiku-4-5 (conversation
    title generation: max_tokens 20; suggested-prompt chip
    generation, commit 4: max_tokens 200, temperature 0.7, 5s
    timeout)
  - Streaming enabled for student chat (ReadableStream + getReader)
  - The older `netlify/functions/anthropic.mjs` is dead code awaiting
    a separate cleanup commit — do not call it.
- **Markdown rendering:** Custom lightweight renderer in app.js (no library)
- **Hosting:** GitHub Pages (static deploy)
- **Schema:** See supabase_setup.sql for full table definitions and RLS policies
