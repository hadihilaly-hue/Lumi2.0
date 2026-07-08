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
     exemplary). Per tier: a description of what the teacher looks for
     at that level, plus artifacts of the teacher's work at that level.
     An artifact is EITHER up to 3 photos OR (Q4 v2) one or more
     **written examples** — a report-card comment, essay feedback, or a
     verbal-eval note — so a PE/orchestra teacher with no photo can
     still contribute. HEIC photos are converted to JPEG client-side via
     heic2any before upload; written examples are text-only (no S3) and
     injected server-side (never sent to the student browser). See
     "teacher_work_samples" and "teacher_work_artifacts" under Data
     Architecture and the "Q4 graded work samples" / "Q4 v2 work-sample
     expansion" entries under Roadmap → Implemented.
  6. Review summary cards with Edit buttons + share-course-info
     checkbox + Save
- Steps 1–3 each require a 50-word minimum before Continue is enabled.
  Step 4 (welcome message) requires 80 characters minimum, soft-limited
  at 600 (counter color-shifts past 600 but never blocks). Step 5 (work
  samples) is **fully optional** — Continue is never gated (live
  `validateStep4`). Completeness for the home-card "add samples" banner
  (Q4 v2, Decision D6): a tier counts as complete when it has ≥1 artifact
  of ANY type (a photo OR a written example) — the per-tier description is
  NOT required, so a text-only teacher who leaves the optional "what I
  look for" note blank is not nagged. Via `hasAllWorkSampleTiers`. This
  unblocks text-only teachers, who were wrongly flagged incomplete by the
  old photo-only check.
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
  for the main tutor fetch) — there is no fallback store. Auth is AWS
  Cognito via `cognito-auth.js` (Workstream I, complete 2026-07-02);
  the `sb.auth.*` surface survives as the shim's API. **No live Supabase
  calls/clients/deps remain** (all data I/O goes through `rdsFetch` →
  Lambda); the paused Supabase project awaits final deletion. Note: many
  `*Supabase` function names (e.g. `syncScheduleToSupabase`,
  `loadProfileFromSupabase`) survive in app.js as cosmetic legacy naming —
  they all route to the Lambda now. Teacher notes are injected server-side by the
  chat Lambda and never reach the client (see "Per-student teacher notes
  injection").
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
- Lookup key: teacher_email + course_name (unique constraint
  `teacher_profiles_teacher_email_course_name_key` on the combo)
- Same teacher can have multiple rows, one per class they teach
- Columns (live schema — `migration/rds-schema.sql`): id, created_at,
  updated_at, teacher_email, course_name (NOT NULL), course_code
  (optional SIS catalog code), engagement_rules, teaching_voice,
  course_info, syllabus_file_path, syllabus_text, syllabus_uploaded_at,
  share_course_info, done, suggested_prompts (jsonb — write-only; see
  "Per-class suggested prompts"), welcome_message (Phase 5b — pinned
  welcome card body, nullable), title (honorific Mr./Mrs./Ms./Mx./Dr.,
  written by the onboarding wizard), syllabus_paths (text[]).
- **The old Supabase-era fields no longer exist** — `subject`,
  `class_name`, `teaching_style`, `excellence_criteria`,
  `grading_philosophy`, `common_mistakes`, `explanation_methods`,
  `key_values`, `class_specific_notes`, `messages_json` were all dropped;
  the onboarding wizard writes the flat columns listed above. (Historical
  names appear only in `supabase_setup.sql`.)
- Authz: enforced in the Lambda `/teacher-profile` routes — any
  authenticated user may read (student sessions fetch profiles); writes
  require the JWT email to match `teacher_email`. The Supabase RLS that
  formerly enforced this was stripped at the RDS cutover.

### Class Enrollments (RDS: class_enrollments table)
- Tracks which students are in which classes, with per-student teacher notes
- Columns:
  - id (uuid, PK)
  - student_id (uuid, NOT NULL) — identity column; the Supabase FK to
    auth.users was dropped at the RDS cutover (kept as plain uuid)
  - teacher_profile_id (uuid, FK → teacher_profiles.id, ON DELETE CASCADE)
  - block (text, nullable) — Menlo section letter A–G. CHECK constraint
    `class_enrollments_block_check` enforces the range. Nullable only
    exists so the column could be added before backfill; going forward
    the UI requires a letter and syncEnrollments skips entries without
    one.
  - teacher_notes (text, nullable) — running teacher observations
  - student_name (text, nullable) — cached display name (SIS import /
    conflict-update arm)
  - term (text, nullable) — free-form SIS term label (e.g. "Spring 2026")
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
- RLS (5 policies) — **historical Supabase model, stripped in RDS.** All
  RLS was dropped at the cutover; the Lambda `/class-enrollments` routes
  below now replicate this authz server-side (RLS_AUDIT.md is the snapshot
  they were ported from):
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
- Trigger: `protect_teacher_notes_trigger` (BEFORE UPDATE) — **historical;
  dropped in the RDS schema** (it depended on `auth.jwt()`; see the
  `migration/rds-schema.sql` header). In Supabase it rejected any update
  that changed teacher_notes unless the caller's email matched the
  teacher_profiles.teacher_email for the linked class. Write-protection is
  now enforced in the Lambda `PATCH /class-enrollments` route (2-step
  email-ownership check) instead.
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
  wired into the frontend. No DELETE route — no RLS policy to port;
  dropped-class cleanup is still the pre-Menlo TODO.
- **✅ Server-side prompt injection (shipped 2026-07-01).** The student
  notes-injection read is GONE from the client entirely. The chat Lambda
  replaces the `<<LUMI_TEACHER_NOTES>>` marker the client emits in its system
  prompt with a server-built notes section (student identity from the JWT).
  The notes source is RDS unconditionally; the legacy
  `inject_teacher_notes.use_rds` field is still accepted from old clients but
  ignored (the Supabase branch is gone). Notes never reach the browser for any
  purpose — chips moved server-side too (`GET /suggested-prompts`). See
  "Per-student teacher notes injection" under System Prompt Architecture.

### Other RDS Tables
- **profiles** — student user profiles (id, name, grade, values_profile jsonb)
- **conversations** — chat history (id, user_id, title, messages jsonb,
  teacher, course, is_teacher_test boolean (Teacher Test Mode TM-1;
  default false; flips to true for conversations created while a teacher
  is in test mode), created_at, updated_at)
- Both had Supabase RLS scoped to auth.uid(); in RDS that isolation is
  enforced in the Lambda `/profiles` and `/conversations` routes (JWT
  sub). Live definitions: `migration/rds-schema.sql`.

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
  _email via a JOIN check. **This RLS is the historical Supabase model,
  stripped in RDS** — the live table lives in `migration/rds-schema.sql`
  and the same authz is now enforced in the Lambda `/work-samples` route.
- Writes happen in teacher.html `saveTeacherProfile()` after the
  teacher_profiles upsert returns the row id. Reads happen in
  app.js `getTeacherProfile()` and are converted to base64 images
  by `loadWorkSampleImages()` at chat-open.

### teacher_work_artifacts (Q4 v2)
- Expands work samples from *photos only* to *any artifact* a teacher
  can contribute — a photo OR a block of **text** (quarterly comment,
  essay feedback, verbal-eval note, "other"). This is what makes the
  feature work for a PE / orchestra / drama / language teacher who has
  no photo of "graded work." Child table of `teacher_work_samples`,
  which is left **untouched** so existing photo-only teachers
  (Harris/Bush) need zero migration.
- One row **per artifact** (N per tier, mixed types), unlike
  `teacher_work_samples` (one row per tier). Columns: id, created_at,
  updated_at, teacher_profile_id (UUID FK → teacher_profiles, ON DELETE
  CASCADE), tier (`progressing|proficient|exemplary` CHECK),
  artifact_type (`photo|comment|essay_feedback|eval_note|other` CHECK),
  text_content (non-null for text types), s3_path (non-null for photo),
  label (optional caption), sort_order, deleted_at. A
  content-integrity CHECK enforces `photo ⇒ s3_path` / `text ⇒
  text_content` exclusivity. Live schema in `migration/rds-schema.sql`;
  standalone additive migration `migration/rds-work-artifacts.sql`.
- **In this pass the table holds ONLY text.** New photos still write to
  `teacher_work_samples.photo_paths` (Decision D2-A — freeze photo_paths,
  no backfill); the `photo`/`s3_path` shape exists so a future pass can
  move photos here without a schema change.
- **Lambda `/work-artifacts` route** (GET/POST/DELETE) clones the
  `/work-samples` authz (`denyUnlessOwner` 2-step email ownership), with
  two deliberate differences: **GET is OWNER-SCOPED** (`?teacher_profile_id=`
  or `?teacher_profile_ids=`, every id owner-checked) because artifact
  text must never reach a student browser (Decision P1-A); **DELETE is
  SOFT** (`?id=` → `deleted_at`), matching the Phase-4 posture rather than
  the hard delete `/work-samples` uses. POST validates tier + type against
  the same allowlists as the CHECK, enforces content integrity + a 2,000-
  char text cap, caps 5 artifacts/tier (≤3 photos), and upserts by `id`
  (edit) or INSERTs (create). Also folded into `/my-data` (teacher's own
  text_content is included) and the `/delete-my-account` soft-delete cascade.
- **Injection is SERVER-SIDE** (Decision P1-A), exactly like teacher
  notes — see "Per-tier work-artifacts injection" under System Prompt
  Architecture. Text never reaches the browser, so "Only Lumi sees this"
  (the wizard copy) is literally true for text.
- Writes happen in teacher.html `saveTeacherProfile()` →
  `saveTierArtifacts()` (upsert-by-id / soft-delete removed), inside the
  same per-tier `failedTiers` tolerance as work samples. The wizard seeds
  its editors from a batch owner-scoped GET in `loadAllTeacherProfiles()`.

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
  only the signed-URL source changed. **Auth chain:** Cognito ID token
  → Lambda `verifyAuth` (local JWKS + app_users) → allowed-domains
  check (teachers-only on upload, any authenticated user on
  download). Written from
  `saveTeacherProfile()` in teacher.html; read from openWizard's
  thumbnail batch and from `loadWorkSampleImages()` in app.js.

### RDS Lambda data routes (Workstream F — complete 2026-07-01)
All six route groups live on `lumi-claude-proxy` (source: `lambda/index.mjs`),
each verified end-to-end with a real authed browser session against RDS.
Shared contract: `verifyAuth` (Cognito ID token, verified LOCALLY via
aws-jwt-verify's module-cached JWKS, then cognito_sub → preserved lumi uuid
via the `app_users` bridge) → allowed-domains gate (schools.allowed_domains,
5-min container cache; adminEmails bypass) →
per-route authz replicating the old RLS (RLS_AUDIT.md) → parameterized query
via `db.js` → raw row(s) on success / `{error}` + status on failure → logs
carry `err.code` only, never PII. Identity is ALWAYS taken from the JWT and
never from the request body (docs/archive/MIGRATION_HARDENING.md §1) — verified
live with spoofed ids.
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
- **/work-artifacts** (Q4 v2) GET/POST/DELETE on `teacher_work_artifacts`,
  cloning the `/work-samples` `denyUnlessOwner` authz. Two deliberate
  differences: **GET is OWNER-SCOPED** (single or `?teacher_profile_ids=` batch,
  every id owner-checked) because artifact text is private (Decision P1-A);
  **DELETE is SOFT** (`?id=` → `deleted_at`). POST enforces type/content
  integrity + a 2,000-char text cap + per-tier caps (5/tier, ≤3 photos) and
  upserts by `id`. In this pass writes are text-only (photos stay on
  `/work-samples`).
- **api_usage: NO client route by design** (forgeable). `checkRateLimit` +
  `logUsage` inside the Lambda query `public.api_usage` in RDS
  **unconditionally** — the `USE_RDS_USAGE` env-var gate and the Supabase
  branch were both removed at cutover.
- Function URL CORS AllowMethods now `GET, POST, PATCH, DELETE`.
- jsonb params are JSON.stringify'd in routes (node-postgres turns JS arrays
  into PG array literals otherwise); text[] columns pass raw arrays.

### SIS importer (Workstream D — shipped 2026-07-01; auth-provider-free since Workstream I Phase 5)
- **`POST /sis-import`** on the Lambda ingests one school's roster in the
  canonical v1.0/v1.1 format (synthetic_data/schema.md). Admin-only
  (SCHOOL_CONFIG.adminEmails). Validation-first: all 8 §9 rules hard-fail
  (400 + structured error list, nothing written); course_code bijection,
  cross-type email reuse, zero-enrollment classes, and zero-class teachers
  surface as warnings. v1.1 adds optional `school.allowed_domains` (bare
  lowercase domains, hard-validated): present = replaces the school's
  sign-in domains, absent = never clobbers; empty-after-import surfaces a
  warning that imported people can't sign in yet.
- **Write pipeline (all idempotent; NO auth provider involved):** school
  upsert (incl. allowed_domains when present) → `app_users` identity rows
  (email → fresh lumi uuid, cognito_sub NULL; people who share an email map
  to ONE identity; a Cognito user appears lazily at the person's first
  Google sign-in and links by verified email — see verifyCognitoAuth) +
  `sis_map` rows → profiles stubs (COALESCE — never clobbers self-entered
  data) → teacher_profiles stubs (done=false; existing rows never
  un-onboarded) → `sections` rows → class_enrollments (teacher_notes
  untouched).
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
  dropped-class cleanup).
- Test artifacts: migration/sis-test-cleanup.py removes a synthetic school
  end-to-end (app_users identity rows included); it runs SQL through the
  Lambda's direct-invoke admin branch (`aws lambda invoke` with an adminSql
  payload — IAM-gated; the lumi-deploy profile has InvokeFunction).

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
  `S.tutorCtx.notesInjection = { teacher_profile_id }` (null when
  no profile.id or in test mode — the TM-2 guard survives), and `callAPI`
  passes it as `inject_teacher_notes` in the chat body. The Lambda reads
  notes from RDS unconditionally (`fetchTeacherNotes` → `dbQuery`); any
  legacy `use_rds` field a stale client still sends is accepted and ignored.
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

### Per-tier work-artifacts injection (Q4 v2; server-side, Decision P1-A)
- **Text work-artifacts never reach the browser.** The client emits the
  literal marker `<<LUMI_WORK_ARTIFACTS>>` in `buildTutorSystem` (`js/prompts.js`,
  profile branch only), in the **teacher-stable prefix, BEFORE the
  `<<LUMI_TEACHER_NOTES>>` marker** (student-specific) — so item-H prompt
  caching can place a `cache_control` breakpoint with the stable artifact text
  inside the cached prefix and the per-student notes after it (Decision D9). The
  chat Lambda replaces the marker with a server-built section; the marker is
  ALWAYS stripped, so a teacher with no text artifacts gets a byte-identical
  DELIVERED prompt (the client-assembled string carries the marker, exactly like
  the notes marker precedent).
- `js/conversation.js` sets `S.tutorCtx.artifactsInjection = { teacher_profile_id,
  first_name }` (both `finishOpenTutor` + `hydrateTutorProfile`), and `callAPI`
  passes it as `inject_work_artifacts`. Unlike notes, this is **NOT test-mode
  gated** — a teacher validating their own persona in test mode SHOULD see
  artifact-shaped feedback; artifacts are teacher-stable/class-scoped, never
  student PII. `first_name` is a non-sensitive display string used only in the
  section header.
- Lambda helpers `WORK_ARTIFACTS_MARKER`, `fetchWorkArtifacts(teacherProfileId)`
  (text rows + per-tier `teacher_work_samples.description`, 3s budget, fail-open
  to null) + `buildArtifactSection(data, firstName)` (per-tier labeled examples,
  deterministic order, ~12,000-char oldest-first total cap for the token budget,
  Decision D8) live next to the notes helpers. Logs carry counts/lengths only
  (`[artifacts] injected n artifact(s), m chars`), never content.
- **Photos are unchanged** — they stay on `teacher_work_samples.photo_paths` and
  ride the existing client vision pipeline (`loadWorkSampleImages` +
  `buildApiMessages`), gated by the pre-existing all-3-tiers image gate. Because
  no photo rows are written to `teacher_work_artifacts` this pass (Decision D2-A),
  the client union reader is a no-op and was deliberately left untouched — the
  strongest zero-re-onboarding guarantee for Harris/Bush.

### Per-class suggested prompts (commit 4)
- The empty-state of a tutor session shows three "starter" chips. As
  of commit 4 (generation moved SERVER-SIDE 2026-07-01), chip text is
  sourced via a **2-tier precedence**:
  1. `S.tutorCtx.notesInjection` set → `GET /suggested-prompts` on the
     Lambda, which reads this student's notes server-side (JWT-scoped,
     from RDS) and generates three chips (one
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
  read side.** The column (jsonb, in `migration/rds-schema.sql`) is still
  WRITTEN by teacher.html during onboarding (`generateSuggestedPrompts()`
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

### Q4 v2 work-sample expansion — written examples (✅ shipped)
- **What it is.** Extends Q4 work samples from *photos only* to *any
  artifact* — a photo OR a block of **text** (report-card comment, essay
  feedback, verbal-eval note, "other"), tagged to a tier. Makes the
  feature usable for PE / orchestra / drama / language teachers who have
  no photo of "graded work." Spec: `docs/Q4V2_SPEC.md`.
- **Where it lives.** New child table `teacher_work_artifacts`
  (text-only in this pass; see Data Architecture); Lambda
  `/work-artifacts` route (owner-scoped GET, soft DELETE); server-side
  injection via the `<<LUMI_WORK_ARTIFACTS>>` marker (see "Per-tier
  work-artifacts injection"); teacher.html Step-5 "+ Add written example"
  editors with an "Only Lumi sees this" affordance.
- **Key decisions (from the spec's D1–D9/P1 index, recommendations
  taken except where noted):** D1-A new child table · D2-A freeze
  `photo_paths`, no backfill · D3 enum `photo|comment|essay_feedback|
  eval_note|other` · D4 ≤5 artifacts/tier, ≤2,000 chars/text · D5-a
  description stays the tier's guidance line · **D6** step stays optional
  (live behavior) but `hasAllWorkSampleTiers` now counts any artifact
  type · D7-A per-tier text gate (photo vision gate unchanged) · D8
  ~12,000-char total artifact-text cap · D9 artifacts before the notes
  marker · **P1-A** text injected server-side ("Only Lumi sees this" is
  literally true for text).
- **Zero re-onboarding.** `teacher_work_samples` is untouched; with no
  artifact rows the injected prompt + photo vision exchange are identical
  to pre-v2. **Known inconsistency (per the spec / Decision P1):** *text*
  is server-side (never hits the browser) but *photos* still transit the
  student browser via the vision pipeline — a documented, accepted
  pre-existing gap; a future pass can move photos server-side too.

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
  AWS migration (commit 8d2c3d8). The live table is in
  `migration/rds-schema.sql` (the original Supabase migration
  `20260427_teacher_work_samples.sql` and its bucket/RLS policies are no
  longer in the tree).
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
- **Cleanup items (status as of this doc refresh).**
  - `netlify/functions/anthropic.mjs` — **already removed** (the whole
    `netlify/` dir is gone from the tree).
  - `supabase/functions/claude-proxy/index.ts` — **already removed** (the
    whole `supabase/` dir is gone). Chat moved to Lambda in commit 5247f0b
    (Week 1), syllabi storage in 506eed9 (Day 3), work-samples storage in
    8d2c3d8 (Day 4). Nothing in the codebase calls Supabase Storage anymore.
  - **Syllabi storage migrated to AWS S3 (commit 506eed9, 2026-05-19).**
    Bucket `lumi-syllabi-613136968914` (us-east-1). Access is gated
    by the Lambda's IAM execution role (`S3LumiStorage` inline policy)
    plus the Lambda's own auth checks — Cognito ID token verify →
    teacher row check → allowed-domains check — before it will sign
    a URL. CORS on the S3 bucket is restricted to the GitHub Pages
    origin. Pre-signed URLs expire after 5 minutes. (The old reference
    migration `supabase/migrations/20260430_syllabi_bucket.sql`, which
    described a Supabase Storage config never actually used, is no longer
    in the tree.)
    **TODO:** Lambda has no `/delete-objects` endpoint yet, so files
    a teacher removes from their list become S3 orphans. Acceptable
    at current scale (cents/month). Fix options when prioritized: add
    `/delete-objects` to the Lambda, or attach an S3 lifecycle rule
    to auto-expire unreferenced objects.
  - **Work-samples storage migrated to AWS S3 (commit 8d2c3d8, 2026-05-20).**
    Bucket `lumi-work-samples` (us-east-1). Access pattern identical
    to syllabi: Lambda's IAM execution role + auth chain (Cognito ID
    token verify → teacher row check → allowed-domains check)
    gate pre-signed URL issuance. CORS restricted to the GitHub Pages
    origin. Pre-signed URLs valid for 1 hour (longer than syllabi
    because the runtime vision pipeline needs headroom for parallel
    per-image fetches at chat-open). HEIC conversion stays client-side
    via heic2any — the bucket only ever sees JPEG/PNG/WebP. (The
    original Supabase migration `20260427_teacher_work_samples.sql` and
    its bucket + RLS policies are no longer in the tree; the live table
    lives in `migration/rds-schema.sql`.) **TODO:** Lambda has no
    `/delete-objects` endpoint yet,
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
- **Cache-busting convention (Phase 6).** app.html, teacher.html,
  admin.html, and privacy.html use the dynamic pattern app.js has used
  since the start: `<script>document.write('<link rel="stylesheet"
  href="style.css?t=' + Date.now() + '">');</script>`. Every page
  load gets a fresh URL so browsers can't serve cached CSS.
  **Exception:** `index.html` still uses the static `style.css?v=21`
  pattern (the migration was not applied there). The static
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
  conversations (TM-1; live in `migration/rds-schema.sql`). No authz
  changes — the per-user JWT-sub scoping in the Lambda `/conversations`
  route (formerly the `auth.uid() = user_id` RLS policy) isolates a
  teacher's test conversations naturally.
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
  Stored in RDS (`teacher_profiles`). DO NOT re-hardcode in app.js.

---

## Synthetic teacher personas (voice-capture testing, 2026-07-05)
- **What it is.** 8 fabricated teachers across subjects (Algebra/Precalc,
  Biology, Music, English, Spanish, Intro/AP CS, US History/Gov, PE/Health),
  seeded into live RDS to test whether Lumi captures *distinct* teacher
  voices. Quality of the onboarding answers was deliberately varied: 3
  thorough, 3 average, 2 messy/terse. The 3 thorough personas are all
  **non-humanities** (Ferraro/math, Ramaswamy/bio, Okonkwo/music) on purpose
  — to stress the known bias where every AI persona drifts into an
  English-teacher voice.
- **All data is synthetic** — fake names, fake students, fake domain
  `@lumidemo.test`. No real Menlo people. Everything keys off that domain.
- **Where it lives.** `synthetic_data/personas.py` is the single source of
  truth (8 teachers, 16 classes, 78 students, 122 enrollments, plus the
  per-persona smoke-test questions). `seed_personas.py` (idempotent insert +
  student-projection verify), `smoke_test.py` (cost-capped Bedrock voice
  test → `test-transcripts/`), `cleanup_personas.py` (full teardown),
  `lambda_admin.py` (boto3 helper for the IAM-gated adminSql invoke path).
  `synthetic_data/PERSONAS_README.md` documents run order.
- **Frontend wiring.** `TEACHER_EMAIL_MAP` in `app.js` + `teacher.html` carries
  the 8 synthetic name→email mappings (clearly-marked block) so the personas
  render in a real Student-Mode sidebar. **To fully revert: delete that block
  in both files AND run `cleanup_personas.py`.**
- **Seeding uses ONLY clean upserts** (no trigger-disabling or other schema
  hacks — teacher_notes is left untouched), so there is nothing to "un-hack";
  teardown is just the cleanup script + the map block.
- **Phase-3 smoke-test findings (2026-07-05, 24 Bedrock calls, sonnet-4-6):**
  all 8 refused the direct-answer bait and redirected with one question; none
  broke. Voice distinctiveness tracked input quality: the thorough
  non-humanities personas were the MOST in-voice (Ferraro's "Okay. Convince
  me"; Ramaswamy's "ooh!" + correlation-vs-causation; Okonkwo's ear-first
  craft language) — i.e. the anti-bias test PASSED. Average/messy personas
  were on-message but generic. One glitch: the terse PE persona (Santos)
  slipped into third person ("here's what Mr. Santos would ask you") — a
  side effect of the "always call them {display}" prompt line when the voice
  fields are too thin to anchor first-person identity. Actionable takeaway:
  rich onboarding answers → richer personas; the pipeline is not the
  bottleneck, the input is.

---

## What NOT To Do
- Do not hardcode teacher profiles in app.js or any frontend file
- Do not use a single lookup key of just teacher_email or just class_name
- Do not silently fall back to generic tutor behavior when no profile exists
- Do not rebuild the system prompt mid-conversation
- Do not ask teachers administrative questions during onboarding

---

## Learnings
- **The Claude-Code remote-exec environment ships placeholder `AWS_*` env
  vars that shadow `~/.aws/credentials`.** `AWS_ACCESS_KEY_ID` is set to a
  14-char proxy value (`prox…`), so boto3/aws-cli fail with
  `InvalidClientTokenId` even after you write a real key to
  `~/.aws/credentials` (env vars win over the file in boto3's provider
  chain). Fix: `os.environ.pop("AWS_ACCESS_KEY_ID" / "AWS_SECRET_ACCESS_KEY"
  / "AWS_SESSION_TOKEN")` before creating any client — `synthetic_data/
  lambda_admin.py` and `smoke_test.py` do this at import. Leave `AWS_CA_BUNDLE`
  intact (needed for TLS through the egress proxy).
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
  (teacher onboarding), admin.html (SIS admin console), privacy.html.
  The live student app is app.html → app.js. (The legacy orphaned `lumi.html`
  copy was deleted in Compliance Phase 2b — it was unlinked dead code carrying
  hardcoded staff names.)
- **Styling:** style.css is the single live stylesheet (~90 KB), loaded by
  index/app/teacher/admin/privacy; Inter font via Google Fonts. `styles.css`
  (~18 KB) is orphaned — no Lumi page loads it.
- **Auth:** AWS Cognito (pool `lumi-users` / `us-east-1_C0xhKzu94`, app client `lumi-web`, hosted domain `lumi-auth-613136968914`) with Google as the sole IdP — code+PKCE via `cognito-auth.js` (repo root; exposes the old `sb.auth.*` surface, so call sites still read like supabase-js). `session.access_token` = the Cognito ID token; the Lambda verifies it locally (aws-jwt-verify, module-cached JWKS — zero per-request egress) and resolves it to the preserved lumi uuid via the `app_users` bridge (link-by-verified-email on first sign-in). Sign-in domains are data-driven off `schools.allowed_domains` (client UX check via `GET /allowed-domains` fails open; server enforcement in verifyCognitoAuth + the route gate fails closed; SCHOOL_CONFIG.adminEmails bypass). **Supabase is retired** (Workstream I complete 2026-07-02): no live Supabase calls/clients/deps remain (though vestigial `*Supabase` function names persist in app.js — cosmetic), project paused pending deletion; `supabase_setup.sql` + `RLS_AUDIT.md` remain in-tree as historical records (the `supabase/` dir itself is gone).
- **Database:** AWS RDS Postgres (`lumi-db`) behind the `lumi-claude-proxy` Lambda — per-route JWT authz replaced RLS (see "RDS Lambda data routes"). Direct DB access for migrations/ops: the Lambda's direct-invoke admin branch ONLY (`aws lambda invoke --payload '{"adminSql":..., "params":[...]}'` — IAM-gated, unreachable via the function URL; replaced the deleted /admin/sql + ADMIN_TOKEN at teardown).
- **AI API:** Claude via **Amazon Bedrock** (streamed with
  `InvokeModelWithResponseStreamCommand`) behind AWS Lambda lumi-claude-proxy
  (Function URL: https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws/).
  The proxy validates JWT auth, clamps max_tokens to a 2500 ceiling
  (`Math.min(body.max_tokens, 2500)`), applies per-user daily rate limits
  (500/day teachers, 100/day students), logs token usage to `api_usage`,
  then relays to Bedrock. Image content blocks pass through unchanged.
  - **Model is forced by the Lambda.** Every proxied call uses
    `SCHOOL_CONFIG.defaultModel` = `global.anthropic.claude-sonnet-4-6`
    (a Bedrock global inference profile). There is **no ALLOWED_MODELS
    whitelist**, and the client's `body.model` is **ignored** — the client
    strings `claude-sonnet-4-20250514` (chat/onboarding, app.js) and
    `claude-haiku-4-5` (conversation-title generation, max_tokens 20;
    teacher.html) are still sent but have no effect on which model runs.
  - **The Lambda DOES modify the system prompt** on the chat route: it
    replaces the `<<LUMI_TEACHER_NOTES>>` marker with a server-built notes
    section (and always strips a stray marker). `messages` are passed
    through untouched.
  - `provider` defaults to `"claude"`; the `gemini`/`gpt` branches exist
    but throw "not yet implemented".
  - Server-side chip generation (`GET /suggested-prompts`) also runs through
    the same forced model (`callClaude`, max_tokens 300, 8s server timeout).
  - Streaming enabled for student chat (ReadableStream + getReader).
- **Markdown rendering:** Custom lightweight renderer in app.js (no library)
- **Hosting:** GitHub Pages (static deploy)
- **Schema:** `migration/rds-schema.sql` (+ `rds-sis-tables.sql`, `rds-app-users.sql`, `rds-school-domains.sql`) is the live RDS schema; supabase_setup.sql is the historical Supabase-era definition (RLS included) — do not apply it anywhere

---

## Compliance & Data Governance (FERPA / SOPIPA / AB 1584)

Ongoing hardening pass to make Lumi structurally ready for K-12 privacy law before
scaled student use at Menlo. Phased; each phase is reviewed and committed separately.

- **`docs/COMPLIANCE.md` is the source of truth** for the data inventory (every PII/
  education-record element: where collected, where stored, retention, who can access),
  the data-flow map (browser → Lambda → RDS/Bedrock; no direct browser→Bedrock; teacher
  notes injected server-side; no live Supabase path), the subprocessor list, the Bedrock
  no-training/in-region citation (verified against live AWS docs), and an honest Known
  Gaps list. Keep it PII-free — describe categories/columns, never real names/emails.
- **Phase 1 shipped (2026-07-04):** `docs/COMPLIANCE.md` created; temporary
  `DIAGNOSTIC_REPORT.md` folded in and deleted.
- **Phase 2a shipped (2026-07-04):** Lambda log redaction — a single `safeErr(err)`
  helper is the choke point for all route error logging (the 4 full-error-object dumps
  are gone). `/admin/sql` documented as IAM-gated + HTTP-unreachable (the real lockdown)
  with an OPTIONAL `ADMIN_INVOKE_SECRET` in-payload gate (off unless the env var is set).
  Deployed + verified (authed fetch + CloudWatch clean). **Phase 2b (remove hardcoded
  `MENLO_CURRICULUM`/`TEACHER_EMAIL_MAP` staff PII + git-history scrub) is DEFERRED** —
  it collides with the active `refactor/split-app-js` worktree editing the same `app.js`;
  revisit once that refactor merges. History scrub still owner-approved but not yet run.
- **Phase 3 shipped (2026-07-04):** `privacy.html` (draft, SOPIPA/COPPA posted policy),
  linked from the sign-in footer; populated from `docs/COMPLIANCE.md`, marked DRAFT
  (not legally reviewed), placeholder contact + effective date.
- **Phase 4 shipped (2026-07-04):** soft-delete `deleted_at` added to all 7 PII tables
  (`migration/rds-add-deleted-at.sql`). `GET /my-data` (JWT-scoped export, `teacher_notes`
  excluded) + `POST /delete-my-account` (`{"confirm":"DELETE"}`, 30-day grace).
  `verifyCognitoAuth` reads `app_users.deleted_at` every request → immediate revocation
  (identity-cache early-return removed). Hard-delete SQL procedure documented in
  `docs/COMPLIANCE.md` §6. Deployed + verified live incl. the reversible
  delete→401→restore→200 test. **This work is on branch `compliance/phases` (both
  remotes), not yet merged to `main`** — pending PR, kept off `main` to avoid the
  multi-agent working-tree churn.
- **Phase 5 spec drafted (2026-07-04):** `docs/PERSISTENCE_SPEC.md` — design doc ONLY,
  nothing built. Cross-session student memory. **DECIDED: rolling-summary MVP** (Option B) —
  one short auto-generated progress note per (student, class), the **third personalization
  layer** on top of teacher profile (layer 1) + per-student teacher notes (layer 2). Note is
  ≤350 tokens, revised each session via a Bedrock (Haiku) call, injected server-side at chat
  start, never reaches the browser. New `student_progress_notes` table ships with `deleted_at`
  from day one; deletion reuses the Phase 4 soft-delete → 30-day grace → hard-delete pattern
  ("delete student X" = one cascade); `/my-data`-style per-student JSON export; note/transcript
  content never logged (Phase 2 redaction helper). **DECISION PENDING — HADI:** discard raw
  transcripts after summarizing (default; smallest FERPA surface, forecloses retrieval) vs.
  retain (enables the documented Option C pgvector + Titan Embeddings retrieval upgrade path).
  Retention default 365 days (school-contract dependent). Open questions for the school:
  retention, who may view notes, under-16 opt-in consent, discard-vs-retain.
- **Key facts established in the Phase 0 diagnostic** (carry forward):
  - **`deleted_at` / soft-delete** — was absent at Phase 0; **added to all 7 PII tables
    in Phase 4** with self-service export/delete + immediate revocation. Admin-initiated
    "delete student X" + per-student export remain (Phase 5 design). `conversations.messages`
    already persists student chat content today.
  - **Lambda backend is clean of hardcoded secrets** (RDS IAM auth, Cognito JWKS, no
    Secrets Manager in use). `/admin/sql` has **no HTTP route** — reachable only via the
    IAM-gated direct-invoke `adminSql` branch (`lambda/index.mjs:470`).
  - **Real staff PII is committed to the public repos** (`admin.html` staff directory,
    `app.js` `MENLO_CURRICULUM` + admin email) in HEAD + history — Phase 2 scope; history
    rewrite only with explicit owner approval.
  - 4 Lambda log sites dumped full error objects (`lambda/index.mjs:1486/1500/1514/1580`)
    — Phase 2 redaction target; no central log helper existed.
