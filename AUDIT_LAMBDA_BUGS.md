# AUDIT 1/4 — LAMBDA BUGS & SECURITY

Scope: `lambda/` only (`index.mjs`, `db.js`, `package.json`, READMEs). Read-only.
Method: full read of both source files + CLAUDE.md cross-check. No code run; items
that can't be confirmed statically are marked **[unverified]**.

Verdict: **No Critical findings.** Identity is taken from the JWT on every write
path and every destructive query is user-scoped — the core trust-boundary
hardening (MIGRATION_HARDENING §1) holds. The real issues are authorization
*breadth* (self-asserted teacher status, share-gate bypass on reads) and a
reintroduced concurrency-slot leak.

---

## Route → auth map (coverage)

| Route | Method(s) | Auth gate | Per-route authz |
|---|---|---|---|
| `adminSql` direct-invoke | (invoke) | **none** — IAM `lambda:InvokeFunction` only; unreachable via Function URL (`!requestContext.http`) | arbitrary SQL by design (item 7) |
| `/db-health` | GET | none (intentional infra probe) | — |
| `/allowed-domains` | GET | none (intentional, public UX) | — |
| `/teacher-profile` | GET/POST/PATCH | verifyAuth + domain | GET default = **any authed reads any teacher** (SELECT *); `scope=all` admin-only; POST/PATCH scoped to JWT email |
| `/profiles` | GET/POST/PATCH | verifyAuth + domain | id = JWT user id (forced) |
| `/conversations` | GET/POST/PATCH/DELETE | verifyAuth + domain | user_id = JWT id (forced/scoped) |
| `/homework-tasks` | GET/POST/PATCH/DELETE | verifyAuth + domain | user_id forced; conflict arm `WHERE user_id = EXCLUDED.user_id` |
| `/work-samples` | GET/POST/DELETE | verifyAuth + domain | GET any authed; POST/DELETE 2-step owner-by-email (403/404) |
| `/class-enrollments` | GET/POST/PATCH | verifyAuth + domain | student_id forced; PATCH 2-step teacher-owner check |
| `/suggested-prompts` | GET | verifyAuth + domain | notes read JWT-scoped |
| `/sis-import` | POST | verifyAuth + domain | **admin-only** (adminEmails) |
| `/upload-url` | POST | verifyAuth + domain | **isTeacher** required |
| `/download-url` | POST | verifyAuth + domain | **none** — no teacher check, no key-ownership check |
| default `/chat` | POST | verifyAuth + domain | rate-limit; notes scoped to JWT |

Auth gate lives at `index.mjs:538-544` (401 no token, 403 wrong domain); every
route below it inherits it. The three no-auth routes above the gate are
intentional and correctly limited.

---

## HIGH

### H1 — Any authenticated user can self-promote to "teacher"
`index.mjs:608-624` (`POST /teacher-profile`), boundary consumed at `:174-187`
(`isTeacher`), `:1476-1477` (`/upload-url`), `:193-212` (rate tier).

**What:** POST `/teacher-profile` requires only a valid token, an allowed domain,
and a non-empty `course_name`. `teacher_email` is forced to the JWT email (good),
but `done` is in `TEACHER_PROFILE_COLS` as a writable `"raw"` column
(`:321`). So any student can insert a `teacher_profiles` row for *their own*
email with `done=true` and any `course_name`.

**Why it matters:** `isTeacher(email)` is `SELECT 1 ... WHERE teacher_email=$1
AND done=true`. Once the row exists, that student is a teacher everywhere the
boundary is checked: `/upload-url` accepts their S3 PUTs (arbitrary file hosting
in `lumi-syllabi-*` / `lumi-work-samples`), they get the 500/day teacher rate
tier, and they appear as a selectable teacher persona to other students
(teacher profiles are world-readable — see H3). Teacher status is entirely
self-asserted; nothing checks the SIS roster / `sis_map` on this write.

**Fix direction:** Gate teacher-profile creation (and/or `done=true`) on an
existing roster identity — e.g. require a matching `sis_map` teacher row or an
admin-seeded stub for the JWT email before allowing insert or before honoring
`done=true`. If low-friction self-onboarding is intended, at minimum drop `done`
from the client-writable allowlist and set it server-side only after a roster check.

### H2 — `/download-url` issues signed URLs for any key with no ownership check
`index.mjs:1492-1503` (route), `:254-262` (`generateDownloadURL`).

**What:** The route takes `{bucket, key}` from the body and signs a 1-hour GET
URL for whatever key is passed. The only gate is auth + domain (`:538-544`);
there is **no** teacher check and **no** check that the key belongs to the
caller. Keys are discoverable: `syllabus_paths`/`syllabus_file_path` come back
from the world-readable `/teacher-profile` GET (H3), and `photo_paths` from the
any-authed `/work-samples` GET (`:913-926`).

**Why it matters:** Any authenticated school user can download **any** teacher's
syllabus PDF or graded-work photos regardless of `share_course_info`. This
directly contradicts the documented syllabi auth chain in CLAUDE.md ("Cognito ID
token verify → **teacher row check** → allowed-domains check — before it will
sign a URL") — that teacher-row check does not exist in the code. (For
work-samples, "any authenticated user on download" is documented as intentional
for the vision pipeline; for syllabi it is not.)

**Fix direction:** Before signing, resolve the key's owner (parse the
`teachers/{userId}/...` prefix or look it up) and require either caller ==
owner, or an explicit share flag for syllabi. At minimum re-add the documented
teacher-row check for the `syllabi` bucket.

### H3 — Default `/teacher-profile` GET returns `SELECT *` for any teacher, defeating `share_course_info`
`index.mjs:593-605`.

**What:** `GET /teacher-profile?teacher_email=<any>&course_name=<any>` runs
`SELECT * FROM teacher_profiles ...` and returns every column to any
authenticated caller. The separate `?template_for_course=` path (`:582-591`)
carefully enforces `share_course_info = true`, but the default path ignores it
entirely and returns strictly more data (`course_info`, `syllabus_text`,
`messages_json`, `welcome_message`, `syllabus_paths`, …).

**Why it matters:** The `share_course_info` sharing control is decorative — a
student can read any teacher's full course content and onboarding transcript
directly, and harvest S3 keys that feed H2. The code comment calls this a
faithful replication of the old `auth_read` RLS, so it may be "intended," but
the intent and the `share_course_info` gate are mutually contradictory.

**Fix direction:** Decide the policy once. If cross-teacher reads should honor
sharing, scope the default GET to the caller's own rows (JWT email) and route
all cross-teacher reads through the share-checked template path; and stop
returning `messages_json`/S3 paths to non-owners via a column allowlist like
`scope=all` already uses.

### H4 — Uncleared `Promise.race` timers reintroduce the event-loop slot-burn
`index.mjs:416-417` (`fetchTeacherNotes`, 3s), `:1140-1143` (`/suggested-prompts`
generate race, 8s), `:1142` timeout promise.

**What:** Each race arms a `setTimeout` that is never `clearTimeout`'d or
`.unref()`'d. When the real work wins the race (the common case), the loser
timer stays pending on the event loop.

**Why it matters:** `db.js:69-78` documents that `streamifyResponse`
invocations "only finalize when the event loop drains," and that an
un-drained loop made every DB-touching invocation burn its full timeout while
holding one of the account's **10** concurrency slots. A dangling 3s (every
notes-injected chat) or 8s (every influenced suggested-prompts call) timer
recreates exactly that class of bug in bounded form — the invocation lingers
holding a slot after the response is already sent. Under load this throttles the
whole function.

**Fix direction:** Store the timer handle and `clearTimeout` in a `finally`, or
`.unref()` the timeout so it can't keep the loop alive.

---

## NOTES

- **N1 — `/upload-url` does not enforce content-type or size** (`:1479-1484`).
  `contentType` is passed straight into the presigned `PutObjectCommand`;
  there is no `ContentLengthRange` / content-type allowlist condition. CLAUDE.md
  claims work-samples are "10 MB, JPEG/PNG/WebP only — server-enforced via
  Content-Type signing." That enforcement is not present; a teacher can upload
  any type/size. Fix: sign with a fixed content-type per bucket and a size
  condition (POST policy or presigned-post).

- **N2 — Error messages leaked to clients** on `/db-health` (`:508`),
  `/upload-url` (`:1487`), `/download-url` (`:1501`), pre-chat (`:1515`), and the
  chat stream (`:1581`). These return raw `err.message`, unlike the data routes
  which correctly return a generic `"Database error"`. Low value to an attacker
  but inconsistent; normalize to generic messages.

- **N3 — `ssl: { rejectUnauthorized: false }`** in `db.js:59` disables RDS TLS
  certificate verification. Acceptable-ish inside the VPC to RDS Proxy but
  weakens MITM protection; prefer pinning the RDS CA bundle.

- **N4 — Rate-limit race / fail-open.** `checkRateLimit` (`:193-212`) counts
  `api_usage` rows, but `logUsage` is fire-and-forget and not awaited
  (`:1167`, `:1571`); concurrent requests all read the pre-insert count, so the
  daily cap is soft under bursts. Also fail-open on DB error (documented
  trade-off). Acceptable, noted for completeness.

- **N5 — CORS not set in code [unverified].** No route sets
  `Access-Control-Allow-Origin`; `sendJson` sets only `Content-Type`. CORS is
  configured at the Function URL level (per CLAUDE.md) and that config is **not
  in this repo**, so permissiveness can't be verified here. Confirm the Function
  URL `AllowOrigins` is restricted to the GitHub Pages origin (not `*`) and
  `AllowMethods` is the documented `GET, POST, PATCH, DELETE`.

- **N6 — `adminSql` direct-invoke branch = arbitrary SQL** (`:470-493`). Item 7
  (note only). Reachability rests entirely on the invariant that Function URL
  events always carry `requestContext.http`; if any non-HTTP trigger is ever
  added to this function that invariant breaks into unauthenticated DB RCE. Also
  returns `err.message` to the invoker. Handled by another session per brief.

- **N7 — Redundant double domain check** (`isEmailAllowed` runs in
  `verifyCognitoAuth :125` and again at `:542`). Harmless defense-in-depth,
  not a bug.

---

## Checked and clean (coverage)

- **SQL injection:** every query in `index.mjs`/`db.js` is parameterized
  (`$1..$n`). Dynamic column/placeholder text is built only from server-side
  allowlists (`TEACHER_PROFILE_COLS`, `PROFILE_COLS`, `CONVERSATION_COLS`,
  `HOMEWORK_TASK_COLS`) and numeric counters — never from request values. The
  `teacher_profile_ids` list is bound as an array param with `= ANY($1::uuid[])`
  (uuid cast rejects garbage). No string concatenation of user input into SQL
  anywhere except the by-design `adminSql` branch. **Placeholder index
  arithmetic verified** on all multi-row inserts (teacher-profile POST,
  profiles, conversations, homework POST `base*8`, class-enrollments POST
  `base*4`, sis enrollments `base*5`) — all correct.
- **Cross-user writes:** none found. `profiles.id`, `conversations.user_id`,
  `homework_tasks.user_id`, `class_enrollments.student_id` are all forced from
  the JWT; the two upsert conflict arms that could be hijacked
  (`/homework-tasks` and `/class-enrollments` POST) are guarded (`WHERE user_id =
  EXCLUDED.user_id`; conflict arm only touches `student_name`/`updated_at`).
- **Unscoped destructive queries:** none. Every UPDATE/DELETE is either
  JWT-scoped (`WHERE user_id/id = $jwt`) or pre-authorized by a 2-step
  owner-by-email check before an id-only mutation (`/work-samples`,
  `/class-enrollments` PATCH). TOCTOU windows are negligible (ownership immutable).
- **Missing try/catch:** DB and Bedrock calls are wrapped. Every route body is in
  try/catch; `fetchTeacherNotes`, `getAllowedDomains`, `isTeacher`,
  `checkRateLimit`, `logUsage` each self-handle. Chat/suggested-prompts streams
  catch and degrade. No unhandled rejection path found (fire-and-forget
  `logUsage` catches internally). Only defect in this area is H4 (timer hygiene,
  not error handling).
- **Hardcoded secrets:** none in `lambda/`. DB uses IAM auth (no password);
  Cognito pool/client IDs come from env vars and fail closed when unset
  (`:43-49`, `:100-103`). `adminEmails`, bucket names, model id, and the
  Function URL are identifiers, not secrets. (The `NEWS_API_KEY` in the
  frontend `app.js` is outside this audit's scope.)
- **Admin/identity gates:** `scope=all`, `/sis-import`, and the adminEmails
  domain-bypass all key on the verified JWT email; `email_verified` is required
  and the app_users email/sub collision path fails closed (`:152-156`).
