# AUDIT 2/4 — LAMBDA INEFFICIENCIES

**Scope:** `lambda/index.mjs` (1585 lines), `lambda/db.js` (90 lines). Read-only.
**Method:** Full read of both Lambda files; frontend usage cross-checked in `app.js`,
`teacher.html`, `lumi.html` to confirm over-fetch / oversized-response claims.
**Ranking:** by real latency/cost impact (frequency × per-invocation cost), not purity.

---

## FINDINGS (ranked)

### 1. `isTeacher()` runs an uncached DB query on every chat, chip, and upload request
- **File/line:** `lambda/index.mjs:174` (definition), called at `:1508` (chat — the hot path), `:1103` (`/suggested-prompts`), `:1476` (`/upload-url`).
- **What:** `isTeacher(email)` issues `SELECT 1 FROM public.teacher_profiles WHERE teacher_email = $1 AND done = true` on **every** invocation of these routes. Unlike the token cache (`db.js`), JWKS cache, `domainsCache` (`:69`), and `appUserCache` (`:111`), teacher-status is never memoized. On the chat path this is one of ~3 serial DB round-trips per student message (`isTeacher` → `checkRateLimit` → `logUsage`), and it is the only one of the three that is cacheable.
- **Estimated impact:** HIGH by frequency. Chat is the highest-traffic route; every message pays one extra RDS-Proxy round-trip (~2–5 ms warm, more on cold/contended pool, and it holds the `max:1` pool connection while it runs). Eliminating it removes ~1/3 of the hot-path DB round-trips.
- **Fix direction:** Add a container-scoped `Map` cache keyed by lowercased email with a short TTL (e.g. 60–300 s — teacher status flips only when a teacher completes onboarding), mirroring `appUserCache`/`domainsCache`. Admin emails already short-circuit before the query.

### 2. `/sis-import` does per-row N+1 writes for people, profile stubs, and sections
- **File/line:** `lambda/index.mjs:1353` (`ensurePerson` → `ensureAppUser` at `:1315` + `sis_map` INSERT at `:1361`), `:1380` (per-student `profiles` stub INSERT), `:1399` (per-group `teacher_profiles` INSERT), `:1413`–`:1429` (per-class `sections` INSERT).
- **What:** Enrollments are correctly batched into 100-row multi-VALUES upserts (`:1437`), but **people and sections are inserted one row at a time inside `for` loops**. Per student that is 3 serial awaited queries (`app_users` upsert + `sis_map` insert + `profiles` stub); per teacher 2; plus one query per class for `sections`. A 1000-student / 200-class school ≈ 3,000+ serial RDS-Proxy round-trips in a single invocation.
- **Estimated impact:** HIGH per-invocation, LOW frequency (admin-only, occasional roster import). This serial fan-out is the direct cause of the 45 s `DEADLINE_MS` (`:1196`) tripping `status:"partial"` (`:1372`, `:1377`, `:1396`, `:1414`, `:1438`), forcing the client to re-POST the entire payload multiple times to finish one import.
- **Fix direction:** Batch the same way enrollments already are — multi-row `INSERT ... VALUES (...),(...) ON CONFLICT` for `sis_map`, `profiles` stubs, and `sections`, chunked ~100–500 rows. `app_users` needs the per-row `xmax = 0` created/existing signal, but can still be batched with `RETURNING lumi_id, email, (xmax = 0)`. Would collapse thousands of round-trips into tens and likely remove the need for partial-resume on normal-sized schools.

### 3. `/conversations` GET ships every conversation's full `messages` jsonb (×50) on app open
- **File/line:** `lambda/index.mjs:726` (`SELECT id, title, messages, teacher, course, ...`); frontend consumer `app.js:1132`–`1168`.
- **What:** The list endpoint returns the complete `messages` blob for the caller's 50 most-recent conversations. The code's own PATCH comment (`:717`) notes messages "can be hundreds of KB." For the initial sidebar render the frontend only derives `preview` (first user message, sliced to 60 chars, `app.js:1140`) and `exchangeCount` (`app.js:1146`) — a few dozen bytes per row.
- **Estimated impact:** MEDIUM, partially justified. Payload can reach multiple MB on a heavy user, paid on every app load. **Caveat (verified):** there is no single-conversation GET route; `openConversation` reads `conv.messages` from the local cache populated by this call (`app.js:1160`, `1391`), so the blob is a deliberate prefetch, not pure waste — stripping it would break instant reopen.
- **Fix direction:** Split into a lightweight list (id/title/preview/counts/timestamps) plus a lazy `GET /conversations?id=` for message bodies on open; or return only the most-recent N conversations' bodies and lazy-load the tail. Requires a small frontend change, so lower priority than #1.

### 4. `/profiles` GET returns `google_calendar_token` (PII) that the frontend never reads
- **File/line:** `lambda/index.mjs:666` (`SELECT * FROM public.profiles WHERE id = $1`); frontend consumer `app.js:1276`–`1311`.
- **What:** `SELECT *` returns `google_calendar_token` on every profile load. Grep across all frontend files (`app.js`, `*.html`) found **zero** reads of `google_calendar_token` — the client only reads the boolean `calendar_connected` flag (`app.js:3030`, `:3040`). The token is over-fetched to the browser on every load.
- **Estimated impact:** LOW on bytes (single token string), but it is a PII over-exposure (matches `PII_INVENTORY.md`) more than a perf issue. Same `SELECT *` pattern in `/teacher-profile` (`:597`/`:601`) and `/homework-tasks` (`:810`) — but there the wide columns (incl. `syllabus_text`) ARE consumed by the frontend (`app.js:465`, injected into the prompt), so those are **not** over-fetch.
- **Fix direction:** Replace the `/profiles` `SELECT *` with an explicit column list excluding `google_calendar_token` (add `calendar_connected` explicitly). Keeps PII server-side; no frontend change needed.

### 5. `isEmailAllowed()` (domain check) runs twice per authenticated request
- **File/line:** `lambda/index.mjs:125` (inside `verifyCognitoAuth`) and again at `:542` (in `handleRequest`).
- **What:** Every authenticated request evaluates the domain gate twice.
- **Estimated impact:** NEGLIGIBLE — both calls hit the 5-minute `domainsCache` (`:71`), so it is a redundant in-memory `Set` lookup, not a DB round-trip (cache miss would double the domains query, but only once per 5 min per container). Listed for completeness, not action.
- **Fix direction:** Optional — the `handleRequest` call at `:542` is redundant for the Cognito path since `verifyCognitoAuth` already gated. Leave as defense-in-depth or drop; no measurable win.

---

## CHECKED AND CLEAN

- **IAM auth token caching** (`db.js:39`–`47`): cached at module scope, refreshed 60 s before the 15-min expiry. Correct — no per-request Signer call.
- **Connection pool reuse** (`db.js:49`–`86`): single module-level `Pool` (`max:1`), `keepAlive`, bounded `connectionTimeoutMillis`/`query_timeout`, `allowExitOnIdle` (well-documented 2026-07-02 event-loop-drain fix). RDS-Proxy handling is careful; no per-request connection churn, no obvious races (`password: getAuthToken` re-evaluated per checkout with fresh cached token).
- **JWKS / Cognito verification** (`index.mjs:113`–`168`): verifies locally against module-cached JWKS — no per-request egress.
- **`appUserCache`** (`:111`): container-scoped, bounded at 500 with FIFO eviction; immutable mapping so no TTL needed. Correct.
- **`domainsCache`** (`:69`): 5-min TTL, stale-on-error, fail-closed. Correct.
- **`checkRateLimit`** (`:193`): `SELECT count(*)::int` — returns only the count, not rows. Inherently per-request (a counter); not cacheable. Clean.
- **`/work-samples` GET** (`:920`): batched via `= ANY($1::uuid[])` — no N+1 across the `.in()` read.
- **`/homework-tasks` POST** (`:832`) and **`/class-enrollments` POST** (`:1009`): batched multi-VALUES upserts. Clean.
- **`/sis-import` enrollments** (`:1437`): correctly chunked at 100 rows (the one batched write in that route — see finding #2 for the rest).
- **`fetchTeacherNotes`** (`:410`): single scoped query with a 3 s race-timeout; no loop.
- **`/class-enrollments` teaching scope** (`:1058`) and note-authz (`:1032`): single JOINed queries, not per-row lookups. Clean.
- **`logUsage`** (`:215`): single fire-and-forget INSERT after the stream closes (`:1571`) — off the response critical path. Clean.
- **`/teacher-profile` `scope=all`** (`:576`) and **`template_for_course`** (`:583`): both use explicit narrow column lists, not `SELECT *`. Clean.

---

## UNVERIFIED / NOTES
- Per-round-trip latency estimates (2–5 ms) are typical RDS-Proxy figures, **not measured** for this deployment. The *relative* ranking (frequency × count of avoidable queries) holds regardless.
- Finding #2's "3,000+ round-trips" assumes a 1000-student school; actual school sizes were not confirmed. The N+1 pattern itself is verified in code.
