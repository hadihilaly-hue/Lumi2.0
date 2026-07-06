# AUDIT_FRONTEND.md — Lumi Frontend (READ-ONLY)

Scope: `app.html` + related frontend (`app.js`, `cognito-auth.js`, `index.html`),
with `teacher.html` / `admin.html` inspected only where they define the teacher
access model (scope item 5). Findings are ordered Critical → High → Fragility.
Every finding is verified by code reading unless marked **[unverified]**.
Line numbers are from the working tree at audit time.

---

## CRITICAL

None. No data-loss, credential-leak, or dead-endpoint defect was found in the
frontend. The two most impactful bugs are behavioral/UX and listed under HIGH.
(Teacher notes never reach the client; no live Supabase endpoint or anon key
survives in frontend code; a single Lambda host is used everywhere.)

---

## HIGH

### H1 — Continuing a saved teacher chat silently loses the teacher persona
- **File/line:** `app.js:1387-1416` (`loadConv`), consumed at `app.js:3886-3887` (`fetchLumi` → `buildTutorSystem`).
- **What:** `loadConv` restores `S.tutorCtx = conv.tutorCtx` but that object only
  carries `{subjectId, subjectName, course, teacher}`. `teacherProfile`,
  `notesInjection`, and `workSamples` are set **only** inside `finishOpenTutor`
  (`app.js:1540-1565`), which `loadConv` never calls. `teacherProfile` is
  assigned nowhere else (grep-confirmed: only `app.js:1540/1546/1552/1565`).
- **Why it matters:** When a student reopens any past class conversation from the
  sidebar (`app.js:2074`) or the resume button (`app.js:2381`) and sends another
  message, `fetchLumi` calls `buildTutorSystem(..., S.tutorCtx.teacherProfile || null, S.tutorCtx.workSamples || null)`
  with a null profile → Lumi drops the teacher's teaching style, and
  `notesInjection` is undefined so no per-student teacher notes are injected. The
  student gets generic AI instead of "their teacher at 11pm" — the core product
  promise — with no visible indication anything changed.
- **Fix direction:** In `loadConv`, when `conv.tutorCtx?.teacher && course`,
  re-run the profile-hydration half of `finishOpenTutor` (fetch + set
  `teacherProfile`/`notesInjection`/`workSamples`) before enabling send.

### H2 — Race: rapid class switching cross-wires profile onto the wrong chat
- **File/line:** `app.js:1443` (`openTutor` assigns a fresh `S.tutorCtx`), `app.js:1485-1569` (`finishOpenTutor` mutates the **global** `S.tutorCtx`).
- **What:** `openTutor` sets `S.tutorCtx` to a new object, then `finishOpenTutor`
  awaits `getTeacherProfile` (up to 5s) and afterward writes
  `S.tutorCtx.notesInjection` / `S.tutorCtx.teacherProfile` / renders a banner into
  `messagesEl`. There is no request-token / "is this still the active class?"
  guard. If the user opens Class A then Class B within the fetch window, A's
  late-resolving `finishOpenTutor` writes A's profile (and A's error banner, at
  `app.js:1539`) onto B's now-current `S.tutorCtx` and B's visible chat pane.
- **Why it matters:** B's conversation can be served with A's teacher persona, or
  show A's "couldn't load" banner, with no error. Menlo students switching
  quickly between classes is a normal interaction, not an edge case.
- **Fix direction:** Capture a per-open token (or the `course::teacher` key) at
  `openTutor` entry; in `finishOpenTutor`, bail before writing to `S.tutorCtx` /
  `messagesEl` if the captured key no longer equals the current one.

### H3 — Teacher access config is duplicated 3–4× and has already drifted
- **File/line:** `MENLO_CURRICULUM` defined in `app.js:140`, `teacher.html:1089`,
  `admin.html:202`, `lumi.html:605`; `TEACHER_EMAIL_MAP` in `app.js:725`,
  `teacher.html:1217`, `admin.html:329`; `buildTeacherDatabase()` in
  `teacher.html:1288` and `admin.html:399`.
- **What:** These are hand-maintained copies of the same data. A diff of the email
  maps shows **admin.html has already drifted** — it is missing the
  `"Test Teacher": "hadi.hilaly@menloschool.org"` entry present in `app.js` and
  `teacher.html`. Teacher-name key sets are currently identical across the three
  code files, but nothing enforces that.
- **Why it matters:** This IS the TEACHER_DATABASE source (see item 5 blast radius
  below). Adding/removing/renaming a teacher requires editing 3–4 files in lockstep;
  any miss silently changes who can log into `teacher.html` (gate at
  `teacher.html:1374`) or which classes students can resolve.
- **Fix direction:** Extract `MENLO_CURRICULUM` + `TEACHER_EMAIL_MAP` into one
  shared module (or serve from the Lambda) and import in all pages; delete the copies.

---

## SCOPE ITEM 5 — TEACHER_DATABASE blast radius (redesign target)

**Where the allowlist lives:** There is no single `TEACHER_DATABASE` constant. It
is *derived* at page load by `buildTeacherDatabase()` (`teacher.html:1288`,
`admin.html:399`) from two hand-written literals — `MENLO_CURRICULUM` and
`TEACHER_EMAIL_MAP` — then hardcodes one dev account. So the "allowlist" is
effectively *every teacher named in `MENLO_CURRICULUM` who also has an entry in
`TEACHER_EMAIL_MAP`*, plus `hadi.hilaly@menloschool.org`.

**Everything that depends on it (the full dependency chain):**

1. `TEACHER_EMAIL_MAP` (literal) — `app.js:725`, `teacher.html:1217`, `admin.html:329`.
2. `MENLO_CURRICULUM` (literal) — `app.js:140`, `teacher.html:1089`, `admin.html:202`, `lumi.html:605`.
3. `buildTeacherDatabase()` → `TEACHER_DATABASE` — `teacher.html:1310`, `admin.html:414`.
4. **Teacher login gate** — `teacher.html:1374` (`TEACHER_DATABASE[email]`; miss → `unknownView`). This is the actual access-control decision for teacher mode.
5. **Which classes a teacher may onboard/edit** — `tTeacher = found` (`teacher.html:1380`); `found.classes` drives the whole wizard/home surface.
6. **Hardcoded dev backdoor** — `buildTeacherDatabase` unconditionally grants `hadi.hilaly@menloschool.org` *all* classes (`teacher.html:1307`, mirrored in admin.html). Baked into the access model, not config.
7. **Admin console** — `admin.html:487/493` iterate `TEACHER_DATABASE` for the whole admin view.
8. **Student → teacher profile resolution** — `TEACHER_EMAIL_MAP[teacher]` maps a scheduled teacher name to the email used in every profile lookup: `preloadProfileStatuses` (`app.js:803,818`), `getTeacherProfile` (`app.js:886`). A name/email change here breaks student lookups, not just teacher login.
9. **Second, divergent teacher gate** — `ALLOWED_TEACHER_EMAILS = ['hadi.hilaly@menloschool.org']` (`app.js:99`) controls the "Switch to Teacher Mode" link in `app.html:345`. This does **not** use `TEACHER_DATABASE`; a redesign that updates one gate and not the other will desync them (see F1).
10. **Test-mode schedule synthesis** — `loadTestModeSchedule` (`app.js:562`) mutates `TEACHER_EMAIL_MAP` at runtime (`app.js:610`) so the teacher's own name resolves (see F2).

**Redesign takeaway:** changing the teacher access model touches ≥10 sites across
4 files, spanning both *access control* (teacher.html gate, app.js link gate) and
*data resolution* (student-side profile lookups). Consolidate to one source before
redesigning, or the two gates and the student lookup path will drift independently.

---

## FRAGILITY NOTES

### F1 — Two independent teacher gates that can desync
- `app.js:99` `ALLOWED_TEACHER_EMAILS` (single hardcoded email) gates the
  teacher-mode *link*; `teacher.html:1374` `TEACHER_DATABASE` gates *actual entry*.
  Today only `hadi` sees the link, yet any curriculum teacher can reach
  `teacher.html` directly and pass the real gate. Any access-model change must
  update both, or the link and the page will disagree. **Fix:** derive both from
  one source.

### F2 — Runtime mutation of the shared TEACHER_EMAIL_MAP
- `app.js:610` `TEACHER_EMAIL_MAP[fullName] = currentUser.email;` inside
  `loadTestModeSchedule`. Mutating shared config at runtime breaks if the map is
  ever frozen/derived/server-sourced, and collides if a teacher's Google
  `full_name` equals an existing curriculum name (overwrites that mapping for the
  session). **Fix:** keep a separate test-mode lookup instead of writing into the map.

### F3 — Redundant teacher-profile fetches
- `preloadProfileStatuses` (`app.js:800-825`) fetches every scheduled teacher's
  profile rows but keeps only `done` status in `_profileStatusCache`, discarding
  the row data. `getTeacherProfile` (`app.js:884-908`) then re-fetches the same
  profile on every class open and does **not** consult `_profileCache` first (it
  only falls back to the cache on a thrown error, `app.js:945`). Opening the same
  class N times = N Lambda round-trips. **Fix:** have `preloadProfileStatuses`
  populate `_profileCache`, and let `getTeacherProfile` serve a warm cache entry.

### F4 — Nested 5s timeouts collapse the fail-visible error signal
- `getTeacherProfile` already races a 5s timeout and returns an `{__error}` marker
  (`app.js:895-906`) that `openTutor` turns into a visible chat banner
  (`app.js:1531`). `finishOpenTutor` wraps that same call in a **second** 5s
  `Promise.race` that resolves to `null` on timeout (`app.js:1490-1491`),
  discarding the `{__error}` distinction — a slow-but-failed fetch is rendered as
  "teacher hasn't set up" instead of the error banner. **Fix:** drop the outer
  timeout (the inner one already bounds it) or propagate the marker.

### F5 — Stale error copy references a removed feature
- `app.js:3124` onboarding fetch failure shows: *"Please check your API key in
  settings and refresh the page."* There is no API-key field in settings anymore
  (auth is Cognito; the Lambda holds the key). Misleading dead-end for users.
  **Fix:** replace with a network/retry message.

### F6 — Hardcoded infra values that should be config
- Lambda host is hardcoded in three constants: `CLAUDE_PROXY_URL` (`app.js:109`),
  and `LAMBDA_BASE_URL` (`cognito-auth.js:275`) — same host, two spellings (one
  with trailing slash, one without). Cognito domain/client id at
  `cognito-auth.js:12-13`. Model IDs are scattered literals:
  `claude-sonnet-4-20250514` (`app.js:3105, 3148, 3952`) and `claude-haiku-4-5`
  (`app.js:3826`). Not dead — all valid — but a host or model swap means editing
  multiple files. **Fix:** centralize into one config object.

---

## CHECKED AND CLEAN

- **Main chat send error path** — `fetchLumi` (`app.js:3929-3934`) removes the
  typing indicator, renders a red error bubble (`renderError`, `app.js:3941`), and
  shows a toast; `callAPI` throws on non-2xx (`app.js:3962-3966`); rate limits get
  a friendly message (`app.js:129-134`). User always sees a failure.
- **`openTutor` profile-fetch failure** — visible in-chat banner + disabled input
  with explanatory placeholder (`app.js:1531-1543`), not a silent generic fallback.
- **Hardened writes surface errors** — profile sync (`app.js:1269`), conversation
  delete (`app.js:1230`), homework sync (`app.js:5648`) all `showToast` on failure.
- **`rdsFetch` error contract** is consistent: 404 → `null` (data state), any other
  non-2xx throws (`app.js:834-848`); onboarding/title/project callers check
  `res.ok`.
- **No dead endpoints** — no `supabase.co` URL, `createClient`, or anon key in
  frontend (naming only; the `sb` object is the Cognito shim). Single Lambda host
  (`44d5lnv7ir7q4xgapsukc4tlnq0jtjxz…`) used throughout — no stale/old URL.
- **Cognito auth flow** (`cognito-auth.js`) — PKCE with state validation
  (`:124`), deduped refresh (`:162-191`), `?code/&state` scrubbed on every path
  (`:116-120`), domain gate fails open with server as authority (`:274-293`).
- **State reset on class open** — `S.tutorCtx.notesInjection` / `.workSamples`
  are explicitly reset at the start of `finishOpenTutor` (`app.js:1503, 1512`), so
  stale notes/samples don't leak across a fresh open (contrast H1/H2, which are
  about *loadConv* and *concurrency*, not the reset itself).
- **Teacher notes** never reach the browser — injected server-side; client only
  emits the `<<LUMI_TEACHER_NOTES>>` marker + a one-time localStorage scrub
  (`app.js:76-89`).

---

*Read-only audit — no files other than this report were modified; no git
operations performed.*
