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
  (not JSONB); syllabus PDFs go to AWS S3 (`syllabi` bucket) via
  Lambda signed URLs, with text still extracted client-side via
  pdf.js into `teacher_profiles.syllabus_text`; work-sample photos
  go to AWS S3 (`work-samples` bucket) via the same Lambda signed
  URLs, with the runtime base64 vision pipeline (per-image fetch +
  base64 + Anthropic vision blocks at chat-open) unchanged; per-tier
  photo paths + description rows live in teacher_work_samples (one
  row per tier per teacher_profile_id). See Data Architecture and
  the Storage bucket inventory for the full picture.

### MODE 2: STUDENT MODE
- Loads the selected teacher's profile from **RDS via the Lambda — the ONLY
  data layer since the 2026-07-01 cutover + teardown.** The old `USE_RDS`
  flag and every Supabase data branch are deleted; all reads/writes go
  through the per-file `rdsFetch(path, {method, body})` helper (app.js +
  teacher.html; admin.html inlines its single fetch). Failures surface
  VISIBLY (console.error + showToast at hardened writes; chat-area banner
  for the main tutor fetch) — there is no fallback store. Supabase remains
  ONLY as the auth provider (`sb.auth.*`) until the Cognito workstream.
  Teacher notes are injected server-side by the chat Lambda and never reach
  the client (see "Per-student teacher notes injection").
  `migration/SMOKE_TEST.md` and `migration/CUTOVER_PLAN.md` are historical
  records of the executed cutover.
- Guides students through the subject WITHOUT giving direct answers
- Always asks students to walk through their reasoning first
- Never says "that's wrong" — instead: "walk me through how you
  applied the framework to reach that"
- Pushes back on reasoning quality, never on conclusions
- Asks one pointed question when it finds a crack in student logic
- Lets students find their own inconsistencies, never points them out

---

## Data Architecture

### Teacher Profile Object (RDS: teacher_profiles table)
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

### Class Enrollments (RDS: class_enrollments table)
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
- **RDS read path (the only path since teardown).** `GET
  /class-enrollments` on the Lambda mirrors the two SELECT RLS policies:
  - `?scope=teaching` → the caller's roster across classes they OWN
    (`JOIN teacher_profiles tp ON tp.id = ce.teacher_profile_id WHERE
    tp.teacher_email = <jwt email>`), returned **with** `teacher_notes` (the
    teacher owns them). Replicates `teacher_read_class`. Wired into teacher.html
    `loadAllEnrollments`.
  - default (student scope) → the caller's own rows (`WHERE student_id = <jwt
    user id>`), returned **without** `teacher_notes`. Replicates
    `student_read_own` minus notes. No frontend student consumer today.
  - **`teacher_notes` protection.** The original `protect_teacher_notes()`
    trigger was a WRITE guard (only the owning teacher could *modify* notes); it
    did NOT restrict reads, and it was dropped in the RDS schema (it used
    `auth.jwt()`). The route re-implements protection as a READ rule:
    `teacher_notes` is never returned to a student — it appears only in the
    teacher-scope projection (server-side authz, not RLS).
- **Writes migrated (Workstream G, 2026-07-01).** `POST /class-enrollments`
  (the syncEnrollments student upsert — student_id always from the JWT; the
  conflict-update arm can only touch student_name/updated_at, so teacher_notes
  is structurally unwritable by students) and `PATCH /class-enrollments`
  (teacher note save — 2-step email ownership check, 403 non-owner). Both
  wired into the frontend behind `USE_RDS`. No DELETE route — no RLS policy
  to port; dropped-class cleanup is still the pre-Menlo TODO.
- **✅ Server-side prompt injection (shipped 2026-07-01).** The student
  notes-injection read is GONE from the client entirely. The chat Lambda
  replaces the `<<LUMI_TEACHER_NOTES>>` marker the client emits in its system
  prompt with a server-built notes section (student identity from the JWT;
  `inject_teacher_notes.use_rds` selects RDS vs Supabase so the source flips
  with the flag at cutover). Notes never reach the browser for any purpose —
  chips moved server-side too (`GET /suggested-prompts`). See "Per-student
  teacher notes injection" under System Prompt Architecture.

### Other RDS Tables
- **profiles** — student user profiles (id, name, grade, values_profile jsonb)
- **conversations** — chat history (id, user_id, title, messages jsonb,
  teacher, course, is_teacher_test boolean (Teacher Test Mode TM-1 —
  added in 20260429_2_teacher_test_mode.sql; default false; flips
  to true for conversations created while a teacher is in test
  mode), created_at, updated_at)
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
- **`syllabi`** — teacher syllabus PDFs. Storage lives in AWS S3
  bucket `lumi-syllabi-613136968914` (us-east-1); not accessible via
  Supabase Storage anymore. All access is mediated by the Lambda's
  `POST /upload-url` and `POST /download-url` endpoints on the same
  Lambda Function URL as chat — the browser never talks to S3
  directly except via the returned pre-signed URLs. Key convention
  `teachers/{userId}/{classSlug}/{ts}-{filename}.pdf` (generated by
  the Lambda, returned in the upload-url response, stored in
  `teacher_profiles.syllabus_paths`). Written and read from
  `saveTeacherProfile()` in teacher.html. The `work-samples` bucket
  below uses the same pattern (migrated Day 4, commit 8d2c3d8).
- **`work-samples`** (Q4) — graded student-work photos. Storage lives
  in AWS S3 bucket `lumi-work-samples` (us-east-1); not accessible
  via Supabase Storage anymore (migrated Day 4, commit 8d2c3d8). All
  access is mediated by the Lambda's `POST /upload-url` and
  `POST /download-url` endpoints on the same Lambda Function URL as
  syllabi/chat. Key convention
  `teachers/{userId}/{classSlug}/{tier}/{ts}-{filename}` — four
  segments (one more than syllabi) because tier is also encoded in
  the key, in addition to the `tier` DB column on
  `teacher_work_samples` (redundant, intentional). 10 MB per file,
  JPEG/PNG/WebP only (server-enforced via Content-Type signing on
  the upload URL). HEIC conversion stays client-side via heic2any
  in teacher.html before upload — unchanged. Pre-signed download
  URLs valid for 1 hour (longer than syllabi's 5min because the
  runtime vision pipeline fans out to per-image fetches at
  chat-open). **Runtime vision pipeline:** `loadWorkSampleImages()`
  in app.js fetches signed URLs in parallel via `POST /download-url`,
  then fetches each image blob, converts to base64, and sends them
  to Claude as vision content blocks — same end shape as before,
  only the signed-URL source changed. **Auth chain:** Supabase JWT
  → Lambda `verifyAuth` → Menlo domain check (teachers-only on
  upload, any authenticated user on download). Written from
  `saveTeacherProfile()` in teacher.html; read from openWizard's
  thumbnail batch and from `loadWorkSampleImages()` in app.js.

### RDS Lambda data routes (Workstream F — complete 2026-07-01)
All six route groups live on `lumi-claude-proxy` (source: `lambda/index.mjs`),
each verified end-to-end with a real authed browser session against RDS.
Shared contract: `verifyAuth` (Supabase JWT) → @menloschool.org domain gate →
per-route authz replicating the old RLS (RLS_AUDIT.md) → parameterized query
via `db.js` → raw row(s) on success / `{error}` + status on failure → logs
carry `err.code` only, never PII. Identity is ALWAYS taken from the JWT and
never from the request body (MIGRATION_HARDENING.md §1) — verified live with
spoofed ids.
- **/teacher-profile** GET (default; `?template_for_course=` for
  checkForTemplate; `?scope=all` admin-gated to SCHOOL_CONFIG.adminEmails —
  deliberately narrower than the old any-authenticated auth_read) +
  POST (saveTeacherProfile upsert, teacher_email from JWT, RETURNING *) +
  PATCH (column-allowlist update by (JWT email, course_name), 404 when
  unowned). GET 404s on zero rows — frontend must treat as "no profiles yet".
- **/profiles** GET (own row, single object, 404 when none) + POST
  (partial-column upsert, id = JWT sub) + PATCH (update-only).
- **/conversations** GET (`?is_teacher_test=` splits TM-1 threads, newest 50)
  + POST (returns `{id}` only) + PATCH (`{id, updated_at}` back — messages
  jsonb never echoed) + DELETE (`?id=` / `?all=true`).
- **/homework-tasks** GET + POST (bulk upsert, client uuids; conflict-update
  arm carries `WHERE user_id = EXCLUDED.user_id` so a guessed uuid can't
  hijack a foreign row — returned `{upserted}` count exposes skips) + PATCH +
  DELETE (`?id=` / `?all=true`).
- **/work-samples** GET (any authenticated caller, `?teacher_profile_id=` or
  `?teacher_profile_ids=`) + POST/DELETE (2-step JOIN-by-email authz: 403
  non-owner, 404 missing profile — fail-visible where RLS was silently empty).
- **api_usage: NO client route by design** (forgeable). `checkRateLimit` +
  `logUsage` inside the Lambda gained RDS branches gated on `USE_RDS_USAGE=1`
  (env var, unset until cutover so live rate limits keep reading Supabase's
  real history; both must flip together).
- Function URL CORS AllowMethods now `GET, POST, PATCH, DELETE`.
- jsonb params are JSON.stringify'd in routes (node-postgres turns JS arrays
  into PG array literals otherwise); text[] columns pass raw arrays.

### SIS importer (Workstream D — shipped 2026-07-01)
- **`POST /sis-import`** on the Lambda ingests one school's roster in the
  canonical v1.0 format (synthetic_data/schema.md). Admin-only
  (SCHOOL_CONFIG.adminEmails). Validation-first: all 8 §9 rules hard-fail
  (400 + structured error list, nothing written); course_code bijection,
  cross-type email reuse, zero-enrollment classes, and zero-class teachers
  surface as warnings.
- **Write pipeline (all idempotent):** school upsert → Supabase auth users
  via admin API (get-or-create; existing emails resolve via generate_link —
  people who share an email map to ONE auth identity) + `sis_map` rows →
  profiles stubs (COALESCE — never clobbers self-entered data) →
  teacher_profiles stubs (done=false; existing rows never un-onboarded) →
  `sections` rows → class_enrollments (teacher_notes untouched).
- **Sections/block bridge:** the SIS models sections with integer periods;
  the app runs on Menlo-style block letters. Full section fidelity lands in
  the `sections` table (migration/rds-sis-tables.sql) and each section gets
  a deterministic letter within its (teacher, course_name) group ordered by
  sis_id (A, B, …; hard-fails past 7). `sis_map` keys stable SIS person-ids
  to auth UUIDs.
- **Resumable:** ~45s internal deadline returns `{status:'partial'}`; the
  caller re-POSTs the same payload until `{status:'complete'}`. Tested with
  all three synthetic sizes (small 1 round; medium 2; large 6 rounds /
  920 people / 200 sections / 4800 enrollments) + idempotent re-import
  (zero new rows) + the four §9 reject cases.
- **Known v1 limitations:** re-exports UPSERT but do not PRUNE rows missing
  from the new export (stale enrollments persist — same problem-class as
  dropped-class cleanup); imported people can't sign in until the
  @menloschool.org domain gate is replaced in the Cognito workstream.
- Test artifacts: migration/sis-test-cleanup.py removes a synthetic school
  end-to-end (auth users included); it depends on /admin/sql — delete both
  together at teardown.

### System Prompt Architecture
- Built dynamically from teacher profile object at session start
- NEVER rebuilt mid-conversation
- NEVER hardcoded as a string
- Injects: teacher name, subject, philosophy, pedagogy sequence,
  intervention techniques, scope boundaries, never-do list
- For student sessions also injects: student name, grade, current topics
- If no profile found: show student "This teacher hasn't set up their
  Lumi profile yet" — NEVER silently fall back to generic behavior

### Per-student teacher notes injection (commit 3; moved SERVER-SIDE 2026-07-01)
- **Notes never reach the browser.** The client emits the literal marker
  `<<LUMI_TEACHER_NOTES>>` in `buildTutorSystem` (profile branch only,
  at the old splice point between the "Response length: SHORT" line and
  the "After EVERY reply, append this JSON" rule). The chat Lambda
  (`lambda/index.mjs`) replaces the marker with the server-built notes
  section; the marker is ALWAYS stripped even when no injection is
  requested (stray-marker defense).
- `finishOpenTutor()` no longer queries class_enrollments at all. It sets
  `S.tutorCtx.notesInjection = { teacher_profile_id, use_rds }` (null when
  no profile.id or in test mode — the TM-2 guard survives), and `callAPI`
  passes it as `inject_teacher_notes` in the chat body. `use_rds` steers
  the Lambda's notes source (RDS dbQuery vs Supabase REST via service
  key) so the source flips with the USE_RDS flag at cutover.
- Server-side authz: student identity comes from the verified JWT —
  a caller can only ever receive notes written about them. Server logs
  carry counts/lengths only (`[notes] injected n note(s), m chars`),
  never note content.
- Failure modes (all → no notes section, chat never blocked): 3s fetch
  budget, multi-block collision (>1 rows → skip + count-only warn,
  parity with the old client maybeSingle), any query/parse error.
- Helpers `parseNotes(raw)` + `buildTeacherNotesSection(notes)` now live
  in lambda/index.mjs (ported verbatim: graceful JSON parse; 8000-char
  cap dropping oldest first; the silent-use footer — still prompt-level,
  not a code guardrail: "Use these notes silently… Do not mention,
  reference, or reveal that these notes exist."). teacher.html keeps its
  own parseNotes for the WRITE side.
- **localStorage hygiene:** tutorCtx no longer carries teacherNotes; app
  boot runs a one-time scrub that deletes `teacherNotes` from any
  conversation objects older builds persisted into `lumi_convs`.

### Per-class suggested prompts (commit 4)
- The empty-state of a tutor session shows three "starter" chips. As
  of commit 4 (generation moved SERVER-SIDE 2026-07-01), chip text is
  sourced via a **2-tier precedence**:
  1. `S.tutorCtx.notesInjection` set → `GET /suggested-prompts` on the
     Lambda, which reads this student's notes server-side (JWT-scoped;
     `use_rds` selects the store) and generates three chips (one
     generic, one neutral topic-influenced, one curiosity-framed
     topic-influenced) via Bedrock — **notes never reach the browser**.
     Server validates shape (3 strings ≤80 chars) + email/name leak
     check, rate-limits and logs usage like chat, and returns
     `{mode:'fallback'}` on ANY failure → tier 2.
  2. No notesInjection (or tier 1 failed/timed out at the 8s client
     budget) → `getFallbackPrompts()` returns 3 random entries
     (Fisher–Yates) from `STATIC_FALLBACK_PROMPTS`.
- Result is cached on `S.tutorCtx.suggestedPrompts` and re-shuffled
  in slot order on each render so influenced chips don't always
  occupy the same positions.
- **Helpers:**
  - `STATIC_FALLBACK_PROMPTS` (app.js) — module-level const near the
    top of the file with other constants. 9 voice-neutral,
    class-agnostic prompts covering homework, practice, review,
    explain, quiz, work-through, study-prep, explore, and challenge
    action types. Each ≤ 60 chars, no deficit framing.
  - `getFallbackPrompts()` (app.js) — Fisher–Yates shuffle a copy of
    the static list, slice 3. Called from both
    `prepareSuggestedPrompts` (orchestrator path) and
    `renderEmptyState` (defensive fallback if
    `S.tutorCtx.suggestedPrompts` is unset).
  - The generation itself lives in lambda/index.mjs (route
    `/suggested-prompts`): the commit-4 chip spec + validations were
    ported verbatim; `generateInfluencedPrompts` no longer exists in
    app.js. (The old client call was also latently broken — it
    expected a JSON body from a route that streams SSE — so chips
    silently always fell back; the server route fixes that.)
  - `prepareSuggestedPrompts()` (app.js) — orchestrator. Reads
    `S.tutorCtx.notesInjection` and `S.tutorCtx.course`, runs the
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
  bucket `work-samples` for graded student-work photos (10MB cap,
  JPEG/PNG/WebP only — HEIC excluded because Claude's vision API
  doesn't accept it; teacher.html converts HEIC → JPEG client-side
  via the heic2any CDN script before upload). Initially Supabase
  Storage; migrated to AWS S3 via Lambda signed URLs in Day 4 of the
  AWS migration (commit 8d2c3d8). Defined in
  `supabase/migrations/20260427_teacher_work_samples.sql` (table
  definition still valid; the bucket + RLS policies portion is now
  historical).
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
  - `supabase/functions/claude-proxy/index.ts` is now fully dead code
    — chat moved to Lambda in commit 5247f0b (Week 1), syllabi storage
    in 506eed9 (Day 3), work-samples storage in 8d2c3d8 (Day 4).
    Nothing in the codebase calls Supabase Storage for either bucket
    anymore. Queued for cleanup deletion.
  - **Syllabi storage migrated to AWS S3 (commit 506eed9, 2026-05-19).**
    Bucket `lumi-syllabi-613136968914` (us-east-1). Access is gated
    by the Lambda's IAM execution role (`S3LumiStorage` inline policy)
    plus the Lambda's own auth checks — Supabase JWT verify → teacher
    row check → `@menloschool.org` domain check — before it will sign
    a URL. CORS on the S3 bucket is restricted to the GitHub Pages
    origin. Pre-signed URLs expire after 5 minutes. The old reference
    migration `supabase/migrations/20260430_syllabi_bucket.sql` is
    now stale (it described a Supabase Storage config we never
    actually used) — leave untracked or delete in a follow-up cleanup.
    **TODO:** Lambda has no `/delete-objects` endpoint yet, so files
    a teacher removes from their list become S3 orphans. Acceptable
    at current scale (cents/month). Fix options when prioritized: add
    `/delete-objects` to the Lambda, or attach an S3 lifecycle rule
    to auto-expire unreferenced objects.
  - **Work-samples storage migrated to AWS S3 (commit 8d2c3d8, 2026-05-20).**
    Bucket `lumi-work-samples` (us-east-1). Access pattern identical
    to syllabi: Lambda's IAM execution role + auth chain (Supabase JWT
    verify → teacher row check → `@menloschool.org` domain check)
    gate pre-signed URL issuance. CORS restricted to the GitHub Pages
    origin. Pre-signed URLs valid for 1 hour (longer than syllabi
    because the runtime vision pipeline needs headroom for parallel
    per-image fetches at chat-open). HEIC conversion stays client-side
    via heic2any — the bucket only ever sees JPEG/PNG/WebP. The
    original bucket + RLS policies portion of
    `supabase/migrations/20260427_teacher_work_samples.sql` is now
    stale at the storage layer (the table definition itself is still
    valid). **TODO:** Lambda has no `/delete-objects` endpoint yet,
    so files a teacher removes from a tier become S3 orphans (~3×
    the rate of syllabi orphans because deletes happen per-tier
    inside the save loop). Same fix options as syllabi: add
    `/delete-objects` to the Lambda, or attach an S3 lifecycle rule.
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

### Teacher Test Mode (✅ shipped 2026-04-29, post-redesign)
- **What it is.** Lets a teacher enter the student app as themselves
  to verify their AI persona — live conversation, not preview. Same
  pedagogy guardrails, same pinned welcome card, same chat shell as
  a real student session. Conversations save under the teacher's
  auth.uid() with `is_teacher_test=true` so they never bleed into
  student data or admin analytics.
- **Schema.** `is_teacher_test BOOLEAN NOT NULL DEFAULT FALSE` on
  conversations (TM-1, 20260429_2_teacher_test_mode.sql). No RLS
  changes — existing `auth.uid() = user_id` policy isolates teacher's
  test conversations naturally.
- **URL conventions.**
  - `app.html?mode=test` — entry point. Boot detection in app.js
    flips `S.isTestMode = true` for the tab and mirrors to
    `sessionStorage.lumi_test_mode` for stickiness across refreshes.
    Cleared by the in-sidebar "Exit test mode" button.
  - `teacher.html?course=<encoded>` — TM-3 locked-class route. The
    student-app sidebar routes locked classes to teacher.html with
    the course preselected; bootHome auto-opens the wizard.
  - `teacher.html?from=test-mode` — TM-4 round-trip marker. When
    bootHome sees this param, it reveals a "Back to test mode" banner
    on the home view so the teacher can one-click their way back
    after completing the wizard.
- **Plumbing (TM-2).** Every write path is gated behind
  `if (S.isTestMode) return;` to prevent a teacher from writing
  student-shaped state into shared tables: syncProfileToSupabase,
  syncEnrollments, syncScheduleToSupabase, syncStudyStyleToSupabase,
  loadProfileFromSupabase. `getSchedule` / `getConvs` / `saveConvs`
  branch to in-memory state (`S.testSchedule` / `S.testConvs`) so
  localStorage keys belonging to the student persona on a shared
  browser are never touched.
- **Sidebar gating (TM-3).** `loadTestModeSchedule` synthesizes the
  teacher's classes from teacher_profiles + teacher_work_samples,
  baking a `ready` flag onto each entry. Locked items get a
  `.locked` CSS class, "Finish your profile to test" subtitle, and
  click-routes to `teacher.html?course=…&from=test-mode` for
  completion. Zero-ready edge case appends a "Complete a class
  profile to start testing." note. "+ Add a class" hidden.
- **Banner + toggle (TM-4).** Persistent terracotta-accented banner
  at the top of the chat panel ("TEST MODE — you're chatting with
  your own AI persona for {course}.") — never dismissible. Sidebar
  exit button below the user card. Teacher home gets an iOS-style
  "Student mode" toggle in the header. The legacy
  `rgba(123,105,245,.3)` Student-Mode link (a third purple shade
  Phase 6 missed) is gone.
- **Pollution-prevention checklist** — verify before adding any new
  write path to app.js: does it write to a shared table or the
  student persona's localStorage? If yes, add a guard
  `if (S.isTestMode) return;` at the top.

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
- **Database:** AWS RDS Postgres (`lumi-db`) behind the `lumi-claude-proxy` Lambda — per-route JWT authz replaced RLS (see "RDS Lambda data routes"). Supabase is AUTH-ONLY (`sb.auth.*` via supabase.js CDN client) until the Cognito migration; supabase_setup.sql is historical.
- **AI API:** Anthropic Messages API via AWS Lambda lumi-claude-proxy
  (Function URL: https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws/).
  The proxy validates JWT auth, enforces a 2500 max_tokens
  ceiling, restricts to an ALLOWED_MODELS whitelist, applies per-user
  daily rate limits (500/day teachers, 100/day students), logs token
  usage to `api_usage`, then relays the body to Anthropic (via Bedrock)
  without modifying system prompts or messages. Image content blocks are
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
