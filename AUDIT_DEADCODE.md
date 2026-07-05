# AUDIT 4/4 — DEAD CODE & MIGRATION DEBT

**Repo:** `~/Desktop/Hadi` · **Scope:** whole tracked tree (45 files, `git ls-files`) · **Mode:** READ-ONLY (no edits, no git ops)
**Date:** 2026-07-04 · **Method:** 4 parallel deep-read passes + direct verification greps.

**Caveats.**
- Parallel sessions currently have **`app.html` and `teacher.html` modified (uncommitted)**; line numbers reflect the live working tree at audit time and may shift.
- Untracked files `DIAGNOSTIC_REPORT.md` and `AUDIT_LAMBDA_PERF.md` (other audit sessions' outputs) were left untouched and are out of scope.
- "Live" = reachable from running code. Line refs are `file:line`. Labels: **SAFE-TO-DELETE** / **NEEDS-INVESTIGATION** / **STALE-DOC** / **FUTURE-CONFLICT** / **unverified**.

---

## CATEGORY 1 — SUPABASE MIGRATION LEFTOVERS

### 1a. Dead flags — `USE_RDS` / `use_rds` / `USE_RDS_USAGE`
- **`USE_RDS`, `useRds`, `USE_RDS_USAGE`: ZERO occurrences in any code file.** grep across `.js/.mjs/.html/.json` = 0. The migration flag is fully removed. **CLAUDE.md is stale** on this (see 5a).
- `lambda/index.mjs:1527` — comment `// inj.use_rds is accepted-and-ignored (legacy clients still send it).` The `inj.use_rds` field is read nowhere; notes fetch is unconditional. **SAFE-TO-DELETE** (comment + swallow only).
- `checkRateLimit` (`lambda/index.mjs:193-212`) and `logUsage` (`:215-225`) query `public.api_usage` **unconditionally** — no `USE_RDS_USAGE` gate, no Supabase branch survives. Confirmed.

### 1b. Unreachable dual-path branches
- `app.js:3671-3676` — `if (session?.provider_token && …)`. The Cognito shim `buildSession()` (`cognito-auth.js:57-75`) never sets `provider_token`, so this arm is **dead-but-graceful** (Google Calendar flow). **NEEDS-INVESTIGATION** (tied to dormant calendar feature; delete only with a decision to drop calendar).
- `app.js:4344-4347` (`fetchCalendarToken`) — `session?.provider_token || null` always → null; `_calToken` (`:4251, 4346, 4374, 4445`) is effectively always null. `connectGoogleCalendar` (`:4429`) is already a "temporarily unavailable" stub with a `TODO(GIS)`. **NEEDS-INVESTIGATION** (whole calendar-token path dormant).
- No `if (USE_RDS)` remnants, no `sb.from(`, `.rpc(`, `createClient`, `service_role`, Supabase URL, or Supabase Storage call anywhere. **No live Supabase call exists.**

### 1c. Vestigial `*Supabase` naming (live code, misleading names) — cosmetic
All route through `rdsFetch` → Lambda; behavior is RDS. Rename is cosmetic, **not dead code**:
`syncScheduleToSupabase` (`app.js:629`), `syncEnrollments` (`:650`), `loadConvsFromSupabase` (`:1132`), `syncConvToSupabase`/`_doSyncConv` (`:1175-1218`), `deleteConvFromSupabase` (`:1221`), `syncProfileToSupabase` (`:1235`), `loadProfileFromSupabase` (`:1276`), `syncStudyStyleToSupabase` (`:4304`), `syncHwToSupabase` (`:5621`), `loadHwFromSupabase` (`:6438`). Also ~27 stale historical comments (`app.js` 70, 91, 291, 700, 795-796, 850-853, 882, 1110 `// SUPABASE SYNC`, 1125, 1152, 1234, 1288, 1345, 3042, 3513, 4251, 4306, 4431, 4448, 6367-6437) and the `sbId` field (`:1153,1156,1198,1224,1345`) which now stores the **RDS** UUID under a Supabase-era name. **SAFE-TO-DELETE** (comments/renames); the fields/functions themselves are live.

### 1d. No-op stub functions (dead bodies, still called)
- `syncProjectsToSupabase` (`app.js:6370`) — body is `// no-op`; called at `:6583`. **SAFE-TO-DELETE** (drop function + call).
- `loadProjectsFromSupabase` (`app.js:6433`) — body is `// no-op`; called at `:3683`. **SAFE-TO-DELETE**.

### 1e. `sb` shim & CDN
- `cognito-auth.js:195-267` defines `sb` as a hand-rolled Cognito PKCE shim (`sb.auth.getSession/signInWithOAuth/signOut/onAuthStateChange`); `access_token` = Cognito **ID token**. Fully Cognito-backed. Two "supabase" mentions (`:2, 193`) are comments. **SAFE-TO-DELETE** (comments).
- **No supabase-js CDN `<script>` in any HTML page** (index/app/lumi/admin/teacher). Confirmed.

### 1f. Lambda deps
- `lambda/package.json` declares only `@aws-sdk/rds-signer`, `aws-jwt-verify`, `pg` — **no Supabase deps**; `package-lock.json` has 0 "supabase" hits. All declared deps used.
- **Undeclared runtime deps (not Supabase, but a real gap):** `index.mjs` imports `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` — **not in package.json and not in node_modules** (provided by the Lambda Node runtime). **NEEDS-INVESTIGATION** (breaks on any runtime that doesn't bundle SDK v3; conventional-but-fragile).

### 1g. Orphaned migration files / SQL
- **Live schema:** `migration/rds-schema.sql`, `rds-sis-tables.sql`, `rds-app-users.sql`, `rds-school-domains.sql`.
- **Historical Supabase-era SQL (do NOT apply; keep as records):** `supabase_setup.sql` (126 ln) and `migration/supabase-schema.sql` (611 ln) — **NOT duplicates of each other** (`diff` differs; compact vs full dump). **NEEDS-INVESTIGATION** (archive-or-keep decision).
- `teacher-config.example.js` — 2-line `'your-api-key-here'` placeholder from the pre-proxy era when an API key lived client-side. No code loads it. **SAFE-TO-DELETE** (vestigial).

---

## CATEGORY 2 — DUPLICATE LOGIC (Lambda AND frontend / file A AND file B)

### 2a. ⭐ `lumi.html` is an ENTIRE stale duplicate of the live frontend — biggest single item
`lumi.html` (1809 ln, self-contained, inline `<style>`, no external CSS) carries a full second copy of the live app: its own `S` state machine, `fetchClaudeProxy` (`:581`), `buildTutorSystem` (`:790`), `showAttachPreview`/`handleFileSelect` (`:1494-1543`), footer-JSON strip regex (`:1689`), `applyProfile` (`:1695`), `MENLO_CURRICULUM` (`~:625`), model/max_tokens constants. **Not linked from any HTML/JS** — referenced only by CLAUDE.md:817 and RDS_MIGRATION_DIAGNOSTIC.md. The live student app is `app.html` → `app.js`. **SAFE-TO-DELETE as a unit** once GitHub Pages routing is confirmed not to serve it directly (see unverified). Every 2b/2c "lumi.html copy" below folds into this.

### 2b. Teacher-notes logic — Lambda vs teacher.html
- `parseNotes` — `lambda/index.mjs:378-384` **and** `teacher.html:2813-2821`. Logic **IDENTICAL** but unshared (read-side server, write-side client). Removed from app.js (`:956-959` comment only). **NEEDS-INVESTIGATION** — intentional split, but two copies in two languages drift silently if the note shape changes.
- `buildTeacherNotesSection` + the 8000-char cap + silent-use footer — **`lambda/index.mjs:388-404` only**, no client copy. **Checked clean** (single source).

### 2c. Suggested prompts
- `generateInfluencedPrompts` — **confirmed GONE from app.js** (only comments at `app.js:2255`, `lambda:1085,1107`). Generation + chip validation (3 strings ≤80 char, email/name-leak check) lives only in `lambda/index.mjs:1108-1169`. **Checked clean.**
- `STATIC_FALLBACK_PROMPTS` + `getFallbackPrompts` (`app.js:2256-2275`) are client-only fallback, correctly not duplicated.

### 2d. System-prompt / message assembly
- `buildTutorSystem` — `app.js:429` (5-arg, full profile+work-samples prompt) vs `lumi.html:790` (3-arg, old "digital version of {teacher}" prompt, no profile). **DRIFTED**; the Lambda does not build the tutor prompt (client sends it). Only duplicate is app.js vs dead lumi.html → **SAFE-TO-DELETE** (lumi copy).
- **Footer-JSON contract triplicated inside app.js:** `{"values":[…],"goals":[…],"interests":[…]}` "append after every reply" hardcoded in **3** prompt branches (`app.js:401, 516, 541`) — plus lumi.html:784,807. Strip regex byte-identical at `app.js:3996` & `lumi.html:1689`; `applyProfile` at `app.js:4002` & `lumi.html:1695`. **NEEDS-INVESTIGATION** for the 3 in-file app.js copies (drift within the live file); SAFE-TO-DELETE for lumi copies.

### 2e. `classSlug` duplicated within teacher.html — easy local fix
Identical snippet `(course||'general').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'general'` at **`teacher.html:2357-2360` and `:2510-2513`** (syllabus vs work-sample upload). The full S3 key layout is single-source in `lambda/index.mjs:228-241` (`buildS3Key`). **SAFE-TO-DELETE** (extract one helper).

### 2f. Attach/image + fetch helpers — live vs dead lumi
`showAttachPreview`+`handleFileSelect` (`app.js:3734-3777` vs `lumi.html:1494-1543`, essentially identical), `fetchClaudeProxy` (`app.js:112` vs `lumi.html:581`; app.js has extra 429 handling), `fmtBytes` (`app.js:3720`/`lumi.html:1480`). **SAFE-TO-DELETE** (lumi copies). HEIC handling is teacher.html-only (`:1865-1878`) — not duplicated.

### 2g. Duplicated constants / roster data
- **Model IDs — DRIFTED (latent bug):** Lambda `defaultModel: "global.anthropic.claude-sonnet-4-6"` (`lambda:20`) vs client `'claude-sonnet-4-20250514'` (`app.js:3105,3148,3952`; `lumi.html:1596`) and `'claude-haiku-4-5'` (`app.js:3826`; `teacher.html:2291`; `lumi.html:1648`). Client strings don't match the Lambda id. **NEEDS-INVESTIGATION** — Lambda appears to force `SCHOOL_CONFIG.defaultModel` in `callClaude`, so client `body.model` is likely a dead/ignored string that misleadingly implies a model choice. *Confirm the Lambda ignores `body.model`.*
- **`max_tokens: 2500`** duplicated at `app.js:3106,3149,3953` + `lumi.html:1649` + Lambda `maxTokensCap:2500` (`lambda:21`, clamps at `:1556`). **NEEDS-INVESTIGATION** (same magic number, two languages).
- **`MENLO_CURRICULUM` + `TEACHER_EMAIL_MAP`** full copies in `app.js:140/725` and `teacher.html:1089/1217` (comment `:1088` says "same as app.js"), partial in `lumi.html:~625`. **NEEDS-INVESTIGATION** — high drift risk; also a PII issue (see Cat 3). SIS import suggests this belongs in the DB → all client copies are eventual-removal candidates.
- **`rdsFetch`** duplicated: `app.js:834` vs `teacher.html:1072` (comment `:1069` "mirror of rdsFetch in app.js"). **NEEDS-INVESTIGATION** (drift risk on auth/error handling across two standalone pages).

---

## CATEGORY 3 — CONTENT THAT SHOULDN'T BE IN A PUBLIC REPO

### 3a. CRITICAL — real secrets/keys
**None found.** No `AKIA/ASIA` keys, no `sk-ant-`/Anthropic keys, no Supabase `service_role`/`anon` JWT, no DB password (all `<DB_PASSWORD>` placeholders), no bearer/`ADMIN_TOKEN` value. Real `teacher-config.js` is `.gitignore`d and untracked. No `.env`/`.env.*` tracked.

### 3b. ⭐ HIGH — real Menlo faculty roster hardcoded client-side — **NEEDS-INVESTIGATION**
The full **real Menlo School faculty roster** (~66 real name→`@menloschool.org` pairs + real course assignments) is embedded in shipped client code:
- `app.js:99` `ALLOWED_TEACHER_EMAILS=['hadi.hilaly@menloschool.org']`; `app.js:195-` real course→teacher catalog (~133 name entries); `app.js:724-` `TEACHER_EMAIL_MAP` (~66 real email pairs).
- `teacher.html:1218-` same map (~68 ln); `admin.html:197` `ADMIN_EMAIL` + `:330-` same map; `lambda/index.mjs:16` `SCHOOL_CONFIG.adminEmails`.
- Real-name references in `MIGRATION_PLAN.md:25,297` ("Mr. Harris", "Harris and Bush records removed…"), `migration/rds-app-users.sql:37`, `RDS_MIGRATION_DIAGNOSTIC.md:118`.
The owner's own email is arguably fine; the **~66 third-party teacher names+emails are the real leak** for a public repo. Recommend scrubbing to data-driven (DB/SIS) before publishing. Note: `PII_INVENTORY.md` flags Menlo data generally but **does not call out that the roster is hardcoded client-side** — that's the gap.

### 3c. LOW — semi-public infra identifiers (awareness only, not leaks)
AWS account `613136968914`; Cognito pool `us-east-1_C0xhKzu94`, app client `538k8vb5uh8k7ikim8ql64vf44`, domain `lumi-auth-613136968914`; Lambda Function URL `44d5lnv7ir7q4xgapsukc4tlnq0jtjxz…`; S3 buckets `lumi-syllabi-613136968914`, `lumi-work-samples`; Supabase project ref `mzrzmfkfjfdwsjwblbzz` (paused); Google OAuth client id (public by design, secret NOT in repo). Semi-public by nature — flagged, not for deletion.

### 3d. Seed / synthetic data — VERIFIED CLEAN
- `migration/seed-teacher.sql` — `demo.teacher@menloschool.org` + fake "Demo Teacher"/Algebra. **Clean.**
- `migration/seed-class-enrollments.sql` — synthetic UUID + `'Test Student'` + fake `teacher_notes`. No real student. **Clean.**
- `synthetic_data/generate.py` (Faker, `EMAIL_DOMAIN="example-school.test"`, seeded) + `v1/{small,medium,large}.json` (920 `@example-school.test` emails) — genuinely fake. **Clean.**
- No real student names/grades/GPA or real teacher observations anywhere in the tree.

### 3e. Stray non-Lumi files committed to repo root — **SAFE-TO-DELETE**
- **`CCS`** (18KB, extensionless) — actually a CSS file (old purple `:root{--primary:#6366f1…}` palette, pre-cream/navy refresh). Referenced by nothing.
- **`Hadi`** (12KB, extensionless) — an unrelated HTML page titled **"Political Research Hub"** (Chart.js/Poppins). Not part of Lumi. It is the **only** referrer of `styles.css` (see 5b).

---

## CATEGORY 4 — FUTURE `messages` TABLE CONFLICTS

The team plans a dedicated `messages` TABLE. No such table exists in any schema file yet (clean on table-name), but:

### 4a. Naming collisions — **FUTURE-CONFLICT**
- **`conversations.messages` jsonb COLUMN** (`migration/rds-schema.sql:79` `messages jsonb DEFAULT '[]'`) — the core collision: a new `messages` table vs this jsonb column. Mapped `CONVERSATION_COLS.messages:"jsonb"` (`lambda:344`), SELECT/RETURNed (`lambda:727,742`).
- **`teacher_profiles.messages_json` jsonb** — only in historical `supabase_setup.sql:75`; **absent from live schema and unused in all code** (grep = 0). Dormant near-miss. Also a **STALE-DOC** phantom (see 5d).
- Anthropic-API `messages` payload keys / `S.messages` in `app.js` (1062,1160,1188,1349,1376,2857,3108,3151,3956) and `lambda:264-297` — request-body names, not DB, but a same-named table hurts review clarity. **FUTURE-CONFLICT (readability).**

### 4b. Statelessness assumption — a conversation == one jsonb blob
These sites read/write the whole array and would all need rework to per-message rows:
- `getConvs`/`saveConvs` (`app.js:1321-1330`) — whole `lumi_convs` localStorage blob.
- `loadConvsFromSupabase` (`app.js:1132-1168`) — `row.messages||[]` stored whole (`:1137`).
- `syncConvToSupabase` (`app.js:1181-1215`) — POST/PATCH body `messages: conv.messages` (`:1188`).
- Lambda POST `/conversations` inserts messages jsonb whole; **PATCH deliberately never echoes messages** (`RETURNING id, updated_at`, `lambda:760`, comment `:715-718`).
- `loadConv(id)` (`app.js:1388-1400`) — `S.messages = conv.messages`, assumes fully materialized array.
- rds-schema.sql:79 default `'[]'` bakes array-per-conversation into the column. Sites `app.js:1183,1349,1370-1376` treat history as one in-memory array. **FUTURE-CONFLICT.**

---

## CATEGORY 5 — STALE DOCS (CLAUDE.md claims that no longer match code)

### 5a. `use_rds` / `USE_RDS_USAGE` toggle described as live, but removed
CLAUDE.md **lines 52-54, 184-186, 287-288, 351-354** describe `use_rds` steering notes source and `USE_RDS_USAGE=1` gating rate-limit/usage. Neither exists in code (only the "accepted-and-ignored" comment `lambda:1527`; rate-limit/usage query RDS unconditionally). **STALE-DOC.**

### 5b. `styles.css` described as Lumi styling — it isn't
CLAUDE.md:818 "style.css (primary, ~75 KB) + styles.css (~18 KB)". **`styles.css` (18KB) is loaded by NO Lumi page** — only referrer is the stray `Hadi` file (`Hadi:7`). `style.css` (actually ~90KB, not 75KB) is the real stylesheet (index.html:10, and `document.write` in app/teacher/admin.html:10). **STALE-DOC**; `styles.css` is **SAFE-TO-DELETE** (orphaned once `Hadi` goes).

### 5c. `?t=Date.now()` cache-busting claimed universal — index.html excepted
CLAUDE.md Phase-6 (line ~629) says all HTML pages moved to dynamic `?t=Date.now()`. **`index.html:10` still uses static `style.css?v=21`.** **STALE-DOC / incomplete migration.**

### 5d. teacher_profiles field list is the OLD Supabase shape
CLAUDE.md:82-88 lists `teaching_style, excellence_criteria, grading_philosophy, common_mistakes (jsonb), explanation_methods, key_values, class_specific_notes, teacher_voice, messages_json (jsonb)`. **Verified against `migration/rds-schema.sql:129-148`: NONE of those columns exist.** Live columns are `course_code, engagement_rules, teaching_voice, course_info, syllabus_file_path, syllabus_text, syllabus_uploaded_at, share_course_info, done, suggested_prompts, welcome_message, title, syllabus_paths` — mostly undocumented. `messages_json` is a **phantom** (only in historical `supabase_setup.sql:75`). **STALE-DOC** (entire field list). `class_enrollments.student_name` and `.term` (rds-schema.sql:69-70) are also present-but-undocumented.

### 5e. "Supabase fully retired — zero references in running code"
CLAUDE.md:60, 819. Accurate for **behavior** (no live Supabase call), but false at the **string** level — `app.js` has 62 `supabase` occurrences (function names/comments, see Cat 1c). **STALE-DOC** (overstated absolute).

### 5f. Dangling file references in CLAUDE.md (no `netlify/` or `supabase/` dir exists)
Every path below is cited as if present; none exist in the tree. **STALE-DOC** (fix is editing CLAUDE.md, not deletion):

| CLAUDE.md line(s) | Missing target |
|---|---|
| 552, 835 | `netlify/functions/anthropic.mjs` ("dead code awaiting cleanup" — already gone) |
| 555 | `supabase/functions/claude-proxy/index.ts` |
| 522, 585, 211 | `supabase/migrations/20260427_teacher_work_samples.sql` |
| 567 | `supabase/migrations/20260430_syllabi_bucket.sql` |
| 83, 765 | `20250420_teacher_title.sql` |
| 87 | `20260429_teacher_welcome_message.sql` |
| 135, 772 | `20260424_student_update_policy_and_notes_protection.sql` |
| 192, 670 | `20260429_2_teacher_test_mode.sql` |
| 447 | "the 20250417 migration" (unnamed) |
| 819 | `supabase/` cited as a historical dir — absent |

These migrations were consolidated into `migration/rds-schema.sql` at cutover; the per-file Supabase names are no longer authoritative.

### 5g. `lumi.html` listed as a live "Page"
CLAUDE.md:817 lists lumi.html among live pages, but nothing navigates to it (see 2a). **STALE-DOC** (should be marked legacy/orphaned or deleted).

---

## CHECKED AND CLEAN (verified, no issue)
- **No live credential leak** — zero real keys/secrets/passwords in the tracked tree.
- **No live Supabase call/client/CDN/dep** — all data I/O goes through `rdsFetch` → Lambda; behavior claim in CLAUDE.md is accurate.
- **`USE_RDS` flag fully removed** from code (dual-path branches gone except dormant graceful calendar checks).
- **Seed + synthetic data are genuinely fake** (`example-school.test`, Faker, "Demo Teacher"/"Test Student") — no real student PII.
- **Schema columns present & documented correctly:** `welcome_message`, `is_teacher_test` (conversations), `teacher_work_samples` (+tier CHECK), `class_enrollments.block` (+A–G CHECK), `suggested_prompts` — all in `migration/rds-schema.sql`.
- **`style.css`** is correctly the one live stylesheet across the 4 real pages.
- **`admin.html`** is genuinely in use (SIS admin console, referenced by lambda + migration docs) — reached by direct URL, not orphaned.
- **`supabase_setup.sql` vs `migration/supabase-schema.sql`** are NOT duplicates (126 vs 611 ln); both correctly historical.
- **No `messages` table exists yet** — only the jsonb-column collision is pre-existing, not a table-name clash.
- **`buildTeacherNotesSection`, `generateInfluencedPrompts`** — single-source in Lambda; no leftover client duplicate.

## UNVERIFIED (could not confirm from the tree)
- Whether `lumi.html` is a live GitHub Pages deploy target (reachable by direct URL even if unlinked) — hosting config not in the repo. Confirm before deleting 2a.
- Whether the Lambda actually ignores client `body.model` (would make the drifted client model-id strings in 2g fully dead) — needs a live Lambda read/trace.
- Actual production DB state (e.g. whether `messages_json` was ever physically dropped) — inferable from SQL only, no live connection.
- `@aws-sdk/*` runtime-provided imports (1f) — relies on the deployed Lambda runtime bundling SDK v3; not verifiable from the repo.
