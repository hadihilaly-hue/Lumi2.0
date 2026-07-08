# Lumi Student Experience Redesign — Home → Class Hub-and-Spoke

**Status:** Design spec. Read-only inventory + redesign proposal. **No code changes flow from this
document.** Every product decision that isn't obvious from what the app does today is flagged
in §9 "OPEN DECISIONS — HADI" — those must be answered before session 1 of implementation.

**Author:** compiled from a full walk of `app.html`, `app.js`, `js/*.js`, `teacher-directory.js`,
`cognito-auth.js`, and the live Lambda + RDS schema on `main` at commit `d65c146` (post-deploy
2026-07-08). Cross-references `docs/PERSISTENCE_SPEC.md` (Phase 5 / progress notes) and
`docs/PROMPT_CACHING_PLAN.md` (item-H segment split).

**Scope:** the student surface only. Teacher onboarding (`teacher.html`), admin (`admin.html`),
and privacy (`privacy.html`) are out of scope except for the Test Mode round-trip.

---

## 0. TL;DR

- Replace the persistent sidebar with a **home grid of class cards**. Each card carries a
  one-line "where you left off" and a one-line "next due"; cards that meet tomorrow **and** have
  homework due get a red ring and float to the top.
- Tap a card → **full-screen class view**: chat, that class's convs, projects for that class,
  homework for that class. Back button returns home.
- Home also carries: **tomorrow's schedule peek**, a slim **due-soon strip**, a **PLANNER card**
  (opens the existing `homework.js` cross-subject planner), and a **GENERAL CHAT card** (Lumi
  chat with cross-class context but no teacher persona).
- **The red ring is not deliverable in v1.** The schedule model has no day-of-week dimension
  and no rotation. It ships without the ring; a schema addition unlocks it later (§4.4, §6.2).
- **"Where you left off" v1 = last conversation's preview + timestamp**, sourced from
  `getConvs()` filtered by `(course, teacher)`. Upgrades to the Phase-5 rolling progress note
  the day the persistence gate turns on for the school — same server-side marker mechanism
  already deployed, no client change (§4.1).
- **General Chat = CHEAP option (class list + Layer-3 progress notes only, no fan-out over
  teacher profiles)** — see §5. Full-fanout is a documented deferred experiment.
- **Every localStorage-implied feature is preserved** (§3). The Test Mode teacher round-trip
  keeps working (§4.5). `sidebar.js` is deleted; its class-picker fix (still reading static
  `MENLO_CURRICULUM`) is absorbed by the new home grid, which reads `/available-classes`
  directly.

---

## 1. Phase 1 — exhaustive capability inventory

**Method.** Walked every `js/*.js` module plus `app.html`, `app.js`, `teacher-directory.js`,
`cognito-auth.js`. Everything a student can do today, plus every localStorage key implying a
feature. **Nothing is silently dropped** in the redesign; every row below has a proposed home
or is flagged OPEN.

| # | Capability | Today's home | Proposed home (redesigned) | Notes |
|---|---|---|---|---|
|  1 | Sign in with Google (Cognito) | `index.html` (unchanged) | unchanged | `cognito-auth.js` shim; PKCE + refresh |
|  2 | Consent gate (SOPIPA/COPPA) | pre-boot `/consent` check in `app.html` | unchanged | still runs before the new home mounts |
|  3 | New-user onboarding chat (name, study style, activities, HW start, learning pref, pain points) | `#onboarding` in `app.html` + `js/onboarding.js` | unchanged; runs once on first sign-in before home mounts | writes to `/profiles`; still gated by `lumi_onboarding_complete` |
|  4 | Optional Google Calendar connect | inside onboarding + settings | keep in Settings drawer | `lumi_cal_connected`; `_calEvents` in-memory |
|  5 | Schedule wizard (grade → classes → teacher-per-class → block-per-class → study style → confirm) | `#schedSetup` triggered by `initScheduleSetup()` | keep, invoked from **home empty state** and from **Settings → Update schedule** | writes `lumi_schedule`, `lumi_grade`, `lumi_study_style`; sync to `/profiles` + `/class-enrollments`; catalog from `/available-classes` (fallback static) |
|  6 | Semester banner ("new semester" / "add/drop") | top of `.main` via `checkSemesterBanner()` | keep; render at top of **home** view | `lumi_banner_dismissed` |
|  7 | Class list (from schedule) | sidebar "My Classes" | **home grid of class cards** (primary redesign) | now sourced from `S.schedule` + `/available-classes` metadata (§4.3) |
|  8 | Open a class in tutor mode | sidebar click → `openTutor()` | tap card → full-screen class view | intro slide (`lumi_intro_shown`) preserved |
|  9 | Class conversation history | sidebar collapsible per-class list | inside class view: side/drawer of that class's convs | fully keyed to `(course, teacher)` today via `tutorCtx` |
| 10 | New chat in a class | sidebar "New chat" (context-dependent) | inside class view header | plus a "New chat" in general chat |
| 11 | Rename / delete a conversation | `openHistMenu()` inline dropdown | keep inside class view convs panel + general convs panel | `showInlineConfirm()` |
| 12 | Streaming chat (Sonnet 4.6 via Bedrock) | `chat.js` `doSend()` → `callAPI()` | unchanged | all injection markers (§4.6) survive |
| 13 | Voice input (mic → transcript → confirm bar) | `voice.js` attached to `#micBtn` + `#msgInput` | **inside class view chat only** (per §4.6) | needs re-attach on view change |
| 14 | TTS speaker button on Lumi turns | `_addSpeakerBtn` injected in `renderMsg` | unchanged | `lumi_voice_setting` |
| 15 | Voice mode selector (Off / Hear Lumi / Voice mode) | Settings drawer | unchanged | consolidates old `lumi_mute_tts` / `lumi_voice_mode` |
| 16 | File attachments (image, PDF, text) with base64 preview | chat input `#attachBtn` + drag-drop overlay | keep, per class view | `handleFileSelect`; PDF text via `pdfjs` |
| 17 | LaTeX rendering, code fences, feedback row (thumbs / copy) | `renderMsg()` | unchanged | thumbs are visual stubs today; keep the stubs |
| 18 | Suggested-prompt chips (teacher-notes-influenced or static fallback) | `emptystate.js` `renderEmptyState()` inside empty class chat | **inside class view empty state only** | `/suggested-prompts` server-side; still fallback-safe |
| 19 | Pinned welcome card (from teacher's `welcome_message`) | first Lumi bubble on new tutor chat | keep, inside class view | not in `S.messages` |
| 20 | Server-side teacher-notes injection (`<<LUMI_TEACHER_NOTES>>`) | `buildTutorSystem` marker → Lambda swap | unchanged | notes never reach the browser |
| 21 | Server-side work-artifacts (text) injection (`<<LUMI_WORK_ARTIFACTS>>`) | same marker mechanism | unchanged | text never reaches browser |
| 22 | Client-side work-samples vision pipeline (up to 3 base64 images per tier) | `loadWorkSampleImages()` → `buildApiMessages` synthetic exchange | unchanged | still per-class, gated by all-3-tiers-loaded |
| 23 | Server-side progress-note injection (`<<LUMI_PROGRESS_NOTE>>`, Layer 3) | Lambda marker swap; client only sets `inject_progress_note` | unchanged | **flag-gated OFF** for real students today |
| 24 | Progress-note flush on class-switch / sign-out | `storage.js` `flushProgressNote()` | unchanged | still fires on class exit + on `doSignOut()` |
| 25 | Homework tasks (add / list / complete / due badges) | `hwPopup`, `hwAddModal`, `hwDetailModal`, sidebar list | (a) inside class view as **"This class's homework"** panel; (b) **Planner card** on home shows all classes; (c) **due-soon strip** on home summarizes urgent items | `lumi_hw_tasks` + `/homework-tasks` |
| 26 | Daily HW check-in popup (once per session) | `checkDailyHwPrompt()` on start | keep, triggered from home mount | `sessionStorage.homeworkCheckinShown` + `lumi_hw_date` |
| 27 | "Tonight's study plan" generator (Pomodoro chunks + calendar) | `showHwPlanModal()`, `buildStudyPlanWithCalendar()` | keep, launched from **Planner card** and from **due-soon strip** | `lumi_edited_plan` |
| 28 | Floating planner strip (current block + timer + "Done") | `#plannerStrip` (persistent) | keep, floats over home + class views | `advancePlannerBlock()`, `startPlannerStrip()` |
| 29 | Multi-day project plans (AI-generated + rubric upload + injection into HW) | `projCreateModal`, `projPlanModal`, `js/projects.js` | inside class view as **"Projects for this class"** panel | `lumi_projects` local + tasks synced via `/homework-tasks` |
| 30 | Timeline modal (project plan view) | `#timelineModal` | keep, launched from projects panel | `closeTimelineModal` |
| 31 | Search across teachers + classes | sidebar `#sbSearch` dropdown | move to **home header** (searches enrolled classes + adds new ones) | `renderSearchDropdown()` |
| 32 | Static "All Menlo classes" tree (browse mode) | sidebar under a collapsible | move behind the **"+ Add a class"** entry point in the schedule wizard (already exists there) | removes the sidebar's dual-purpose confusion |
| 33 | Settings drawer (theme, sign out, update schedule, calendar, voice, memory clear, chat/project cleanup, teacher-mode link) | `#settingsDrawer` opened from gear button | keep drawer; reachable via **user chip on home** | every item preserved (17 controls) |
| 34 | "Clear all memory" (destructive: delete `/conversations`, `/profiles`, wipe local) | Settings drawer | unchanged | still calls `rdsFetch` + wipes `lumi_convs`, `lumi_current`, `lumi_name`, `lumi_grade` |
| 35 | Teacher Mode link (only for allowed emails) | Settings drawer footer | unchanged | derived from `/teacher-directory` `ALLOWED_TEACHER_EMAILS` |
| 36 | Test Mode entry (`?mode=test`, sticky in `sessionStorage.lumi_test_mode`) | boot detection in `app.js` | **must keep working** — see §4.5 | banner + exit button preserved |
| 37 | Test-mode synthesized schedule | `loadTestModeSchedule()` (no persistence) | in Test Mode, home grid renders from `S.testSchedule`; locked cards route to `teacher.html?course=…&from=test-mode` | tomorrow-peek / due-strip / planner suppressed in test mode |
| 38 | Test-mode conversation isolation (`is_teacher_test=true`, `S.testConvs`) | `getConvs`/`saveConvs` branch on `isTestMode` | unchanged | class-view convs panel already reads through the same helpers |
| 39 | General chat (no teacher persona; today assembles a "companion" system prompt with `studentCtx()`) | sidebar "General Chat" button → `openGeneralChat()` | **home "General Chat" card** — same entry, redesigned surface (§5) | `buildCompanionSystem()` |
| 40 | Values / goals / interests silent extraction | `parseResponse()` per Lumi turn → merges into `S.values/goals/interests` → persisted on the conv | unchanged | still driven by the fixed JSON footer in system prompts |
| 41 | Dark mode toggle | `#themeToggle` in Settings | unchanged | `localStorage.lumi-theme` |
| 42 | Privacy consent memoization | `localStorage.lumi_privacy_ok` | unchanged | |
| 43 | Ctrl/Cmd+Enter to send | key handler on `#msgInput` | unchanged, per class view | |

**Verified nothing dropped**: every localStorage key found across the codebase (`lumi_*` and
`lumi-*`) maps to a row above. Full manifest lives in §3.

---

## 2. Phase 2 — data availability check

### 2.1 "Where you left off" — the summary line on each class card

Layer-3 progress notes (`docs/PERSISTENCE_SPEC.md`) are the *ideal* source, but they are
**flag-gated OFF** for every real student today: `isPersistenceEnabled(email)` fails closed
unless the caller's domain is in `PERSISTENCE_ALLOWED_DOMAINS` **and** `schools.persistence_enabled=true`
for that domain (spec §0). Menlo domains are not on the allowlist; the `schools.persistence_enabled`
column itself is only in the *proposed* migration `migration/persistence_v1.sql` and has not
been applied. **v1 cannot depend on progress notes.**

**v1 fallback (recommended): last-conversation snippet + timestamp.** For each class card:

1. Read `getConvs()` (already reads through the `S.isTestMode` branch, so it's Test-Mode-safe).
2. Filter to conversations whose `tutorCtx.course === card.course` **and**
   `tutorCtx.teacher === card.teacher`. This is the same filter `emptystate.js` uses for its
   "Resume where you left off" row (`js/emptystate.js:154-159`) — precedent, not new logic.
3. Sort by `conv.ts` desc, take the first.
4. Line 1 = `conv.title || conv.preview` (already computed at save time in `saveCurrentConv`,
   truncated to 60 chars).
5. Line 2 = a compact relative timestamp ("2h ago", "yesterday", "3 days ago"). Client-side.
6. Empty state (no prior conv for that class): show a friendly `"—"` OR a starter chip
   ("Start with today's homework"). **OPEN D1**.

**Cost:** zero new API. Zero Lambda change. Just reads `lumi_convs` (or `S.testConvs` in Test
Mode) and filters. Timestamps are already stored.

**Clean upgrade path when Layer-3 flips on.** Client → `S.tutorCtx.progressNoteInjection` is
already set today in `js/conversation.js` (Phase 5 client wiring). To surface a note *without*
sending it to the browser, we do NOT change the client. Instead, add a **new dedicated Lambda
route** `GET /home-summary?teacher_profile_ids=a,b,c` that:
- verifies caller,
- reads each `student_progress_notes.note_content` where `student_id = <jwt sub>`,
- returns per-class `{ teacher_profile_id, last_session_summary, updated_at }` — the single
  `last_session_summary` field only. That one line is exactly what the card wants.
- Full notes still never reach the browser; the summary line is short by field-spec (≤ 1
  sentence, `PERSISTENCE_SPEC.md` §1) and does not contain sticking-point diagnostics or
  student PII by prompt design.
- Fail-open to the v1 conv-snippet fallback if the route errors, times out, or returns null.

The switch from "last conv snippet" to "last-session-summary line" is one card-render change
and one Lambda route add. **OPEN D2** — do we ship the fallback surface with a copy tag like
"from your last chat" so students understand it changes character once progress notes turn on?

### 2.2 "Next assignment due" line, due-soon strip, red ring

**"Next due" per card — works today.** `homework.js` already exposes `activeHwForClass(course)`
which returns the soonest incomplete task for a class (title + `dueDate`). Match is by
free-text `course === className` — brittle but consistent because both come from the same
schedule pick at task creation (`app.js:377-384`). This is the same match `prompts.js:212`
uses to inject HW into the tutor system prompt. **No change needed.**

**Due-soon strip on home — works today.** `getHwTasks()` sorted by `dueDate`, filter incomplete,
take the first N (proposal: N=3 within 72h). Same data source as the Planner card.

**Red ring — BLOCKED. Schedule model has no day-of-week dimension.**
- Schedule entry shape (verified in `js/schedule.js:504-514`):
  `{ course, teacher, subject, block }`. That's it. Block is a single A–G letter with **no
  associated day map**. No rotation table anywhere in the codebase (grep for "rotation",
  "monday", "day.*week" returns one TODO in `chat.js`).
- The Menlo A–G rotation is real but *un-modeled*. The app cannot answer "does Block C meet
  tomorrow?" without new data.
- **Consequence for v1:** the red ring cannot ship. The visual affordance ("this class matters
  most right now") must be reached a different way.

**Two viable v1 substitutes** (§9 D3 for the pick):

- **D3-A. Drop the ring entirely for v1.** Sort by "next-due-soonest" instead: any card with
  homework due within 24h sorts to the top and gets a red *dot* (not a ring). "Class I have
  tomorrow" is deferred until schedule schema grows a day map.
- **D3-B. Ship an interim heuristic.** Assume every class meets every school day. Then "meets
  tomorrow" is really "the next weekday isn't a weekend". This over-fires (rings *every* class
  every weekday) — so the ring degenerates to "has HW due within 24h", identical to D3-A. Not
  worth a separate axis.

**Recommendation: D3-A**. The ring is a lie without day data; ship the dot; add the ring in a
future session when the schedule model grows a rotation.

**How the rotation could later be modeled (not for v1).** Two clean options:
1. **Per-student, in the schedule entry:** add `meets_days: string[]` to each entry, populated
   in the schedule wizard by a new step ("Which days does Block C meet?"). Cheap; wrong for
   Menlo (block-day mapping is school-wide, not per-student).
2. **School-wide rotation table** (better). Add `school_block_schedule (school_id, block, days
   text[])` to RDS. Populate once per school. Client reads via a `GET /block-schedule` route.
   Test Mode uses a hardcoded rotation because it's synthetic. This is what Menlo actually is.

### 2.3 Card metadata sources

| Field | Source | Fail behavior |
|---|---|---|
| Course name | `S.schedule[i].course` (from wizard) | never null once wizard ran |
| Block letter | `S.schedule[i].block` | possibly `""` for legacy rows |
| Teacher display name | `teacherDisplayName(profile.name, profile)` via `teacher-directory.js` | fetch is memoized once per page load; **fails OPEN** — falls back to `TEACHER_EMAIL_MAP[email]` or the last-name from the raw string. **Empty-table behavior**: a fresh table gives an empty `TEACHER_EMAIL_MAP`; every card renders the raw schedule teacher string as-is. No crash; slightly worse titles ("Harris" instead of "Mr. Harris"). |
| Teacher email | `TEACHER_EMAIL_MAP[teacherName]` from `/teacher-directory` | see above |
| Teacher initials for avatar | `teacherInitials(name)` — returns "✦" on empty/whitespace/non-string | never crashes |
| "Ready" (teacher done onboarding) | `preloadProfileStatuses()` in `teachers.js` → `/available-classes` (`done=true` filter) | falls back to static `MENLO_CURRICULUM` on network fail — every class shows as "ready" (fail-open); this is intentional per the current code |
| Last conv snippet + ts | `getConvs()` filtered by `tutorCtx.(course, teacher)` | empty state per D1 |
| Next-due task | `activeHwForClass(course)` from `homework.js` | returns null → no line, no dot |

**Empty-table fallback confirmed**: `/teacher-directory` failure or empty response yields an
empty `TEACHER_EMAIL_MAP`; every downstream teacher-name lookup coalesces to the raw schedule
string. **This is fine.** The card still renders. Documented behavior — do not "fix" it in this
redesign.

---

## 3. Complete localStorage / sessionStorage manifest

Preserved verbatim so nothing in the redesign silently drops a key. Every one of these has a
row in §1's capability table.

**localStorage (persistent per browser):**

| Key | Payload | Feature | Kept in redesign? |
|---|---|---|---|
| `lumi-theme` | `"dark"` / `"light"` | dark-mode toggle | yes (Settings) |
| `lumi_onboarding_complete` | `"true"` | onboarding gate | yes |
| `lumi_name` | string | student first name | yes |
| `lumi_grade` | `"9"`-`"12"` | grade | yes |
| `lumi_learning_style` | enum | learning style (system-prompt input) | yes (system prompt) |
| `lumi_hw_start` | `"HH:MM"` | homework start time | yes (planner + prompts) |
| `lumi_activities` | free text | typical school-night description | yes (prompts) |
| `lumi_pain_points` | JSON `string[]` | academic-support areas | yes (prompts) |
| `lumi_study_style` | JSON `{work_minutes, break_minutes, label}` | Pomodoro preset | yes (planner + prompts) |
| `lumi_schedule` | JSON `[{course, teacher, subject, block}]` | schedule | yes — **primary input to home grid** |
| `lumi_convs` | JSON `{[localId]: conv}` | conv cache | yes |
| `lumi_current` | conv id | last-active conv | yes |
| `lumi_intro_shown` | JSON `string[]` (course names) | intro slide once-per-class | yes |
| `lumi_projects` | JSON `Project[]` | project plans | yes (class-view Projects panel) |
| `lumi_hw_tasks` | JSON `HwTask[]` | homework list | yes (class-view HW + Planner) |
| `lumi_hw_date` | date string | daily HW check-in memo | yes |
| `lumi_edited_plan` | JSON `{date, blocks[], startMinutes}` | nightly plan edits | yes |
| `lumi_cal_connected` | `"true"` | Google Calendar connected flag | yes |
| `lumi_voice_setting` | JSON voice config | current voice mode | yes |
| `lumi_mute_tts` | legacy `"true"` | pre-consolidation TTS mute — read for migration only | migration read only |
| `lumi_voice_mode` | legacy `"true"` | pre-consolidation voice-in mode — read for migration only | migration read only |
| `lumi_banner_dismissed` | timestamp ms | semester banner snooze (30d) | yes |
| `lumi_privacy_ok` | email | privacy consent memo | yes |
| `lumi_data` | legacy convs | pre-migration convs | migration read only |
| `lumi_auth` | JSON `{id_token, refresh_token, expires_at}` | Cognito session | yes (auth) |

**sessionStorage (per tab):**

| Key | Payload | Feature | Kept? |
|---|---|---|---|
| `lumi_test_mode` | `"true"` | Test Mode stickiness across refresh | yes (§4.5) |
| `lumi_auth_pkce` | JSON `{verifier, state, redirectTo, redirectUri}` | PKCE state | yes |
| `homeworkCheckinShown` | `"true"` | daily HW popup once-per-session guard | yes |

---

## 4. Phase 4 — redesign spec

### 4.1 Screen-by-screen

#### 4.1.1 Home (`app.html?` — new default)

Top-to-bottom regions:

1. **Header.**
   - Lumi wordmark (serif, existing) on the left.
   - Search box in the middle: filters the class grid live; typing a class name not in the
     grid opens a shortcut chip **"+ Add [X] to your schedule"** → launches
     `initScheduleSetup(onDone, currentSchedule)` with the query prefilled. Also matches
     teachers (opens the class-add wizard prefilled for that teacher). Replaces the sidebar
     search entirely.
   - User chip on the right (avatar + first name + "11th · Menlo" subtitle from `prompts.js
     :setSidebarUserSubtitle`). Chip is the settings entry point (tap → Settings drawer). No
     separate gear icon.
2. **Semester banner** (existing `checkSemesterBanner()`) if the calendar window matches and
   the banner hasn't been dismissed.
3. **Tomorrow's schedule peek.** A dismissible ~48 px strip:
   `Tomorrow: 8:30 · Block A · Algebra 2 · Mr. Harris` — the first class of tomorrow only.
   Tap → expands to a modal with the full day's block order.
   **This region is BLOCKED on the same data gap as the red ring** (§2.2). v1 behavior:
   render only if a school-wide block schedule exists; otherwise hide the strip entirely and
   suppress the whole feature. **OPEN D4** — hide silently vs. show a permanent "Set up your
   block schedule" prompt.
4. **Due-soon strip.** A slim horizontal scroller of up to 3 chips:
   `⏰ Chem essay · due tomorrow 8:00 · Ms. Huntley`. Chip tap → open that class view scrolled
   to the HW panel with the task highlighted. Chip source: `getHwTasks()` filtered
   `!isComplete`, sorted by `dueDate` asc, sliced to N=3 within 72h.
5. **Class grid** — the star of the redesign. Cards ordered by priority (§4.4). Cards are:
   - Course name (large, serif).
   - Teacher display name + block letter under it, one line.
   - "Where you left off" line (§2.1).
   - "Next due" line (§2.2).
   - Red *dot* (v1) if HW due within 24h.
   - Faded appearance + a small padlock corner + "Complete setup to start" if
     `preloadProfileStatuses()` says the teacher is not `done=true`. Tap → in student mode,
     shows a "not ready yet" toast; in test mode, routes to
     `teacher.html?course=<encoded>&from=test-mode` (existing TM-3 behavior — carried over).
6. **Utility cards** at the bottom of the same grid (visually distinct — dashed border or a
   quieter tone):
   - **General Chat card.** Big Lumi mark + "Chat with Lumi across your classes".
   - **Planner card.** "Tonight's homework · N tasks". Tap → `showHwPlanModal()`
     (the existing `buildStudyPlanWithCalendar()` UI, unchanged).
7. **Floating planner strip** (`#plannerStrip`) — already floats across the app, preserved.
8. **"+ Add a class"** — small quiet button below the grid; opens the same wizard as (1)'s
   inline shortcut.

**States:**
- **Loading.** Skeleton cards while `getSchedule()` is resolving (instant from localStorage)
  and while `preloadProfileStatuses()` fetches `/available-classes`. Do not block on the
  network probe for `done=true` — render enabled cards first, disable on late reply. Same
  pattern the wizard already uses at `js/schedule.js:145-154`.
- **Empty (no schedule).** Grid becomes a single hero card:
  *"Let's set up your classes."* → `initScheduleSetup(onDone)`. Also triggered
  automatically on first mount when `lumi_onboarding_complete !== 'true'` — this fires the
  onboarding chat first, then the wizard, then lands here.
- **Empty (no done=true classes).** Rare: the student is enrolled but no teacher has finished
  onboarding. Cards render, all faded/locked, with a light banner:
  *"Your teachers are still setting up Lumi. Come back soon."*
- **Error (`/available-classes` fetch fails).** **Fail-open** to the static `MENLO_CURRICULUM`
  fallback — every card renders as "ready". This is the current documented behavior; keeping
  it lets students use the app when the Lambda is briefly slow. Log the failure.
- **Error (`/teacher-directory` fetch fails).** Empty `TEACHER_EMAIL_MAP` → cards render raw
  schedule teacher strings; no crash.

#### 4.1.2 Class view (`app.html#class/<encoded course>|<encoded teacher email>`)

Full-screen when reached. Regions:

1. **Header.** Back button (top-left, always visible — this is the new navigation primitive).
   Course title, teacher display name + block. Small "New chat" button, top-right.
2. **Left rail** (collapsible on narrow viewports, ~260 px):
   - Convs for this class (existing per-class filtering already in place via `tutorCtx`).
   - Section: **Projects for this class** (Q4 projects; opens `renderProjectPlan` on click).
   - Section: **Homework for this class** (filter `activeHwForClass(course)` and its siblings).
   The rail's job is what the sidebar used to do, but scoped to this class.
3. **Main chat panel.** Identical to today's chat: pinned welcome card (from teacher's
   `welcome_message`), intro slide (once per class per session; `_introShownFor` set), empty
   state (chips + resume row) OR the ongoing conversation. Input box, attach, mic, send.
4. **Test Mode banner** if `S.isTestMode` — non-dismissible, top of the chat panel, carrying
   the course name (existing `updateTestModeBanner`).

**States:**
- **Loading.** Skeleton bubbles while `hydrateTutorProfile()` awaits the profile fetch.
- **Empty (new class, no conv yet).** Suggested-prompt chips + welcome card + resume row
  (if any prior). Same three-block layout as today's `renderEmptyState()`.
- **Error (profile fetch fails).** Existing `{ __error }` banner from `teachers.js` —
  "This teacher hasn't set up their Lumi profile yet" — kept verbatim.
- **Error (Bedrock stream fails mid-turn).** Existing SSE error surface, unchanged.

#### 4.1.3 General Chat card view

Full-screen when reached. Same shell as class view but:
- No teacher-persona system prompt (uses `buildCompanionSystem`).
- Header shows "General Chat" + a small legend: "Lumi has your class list, no teacher voice."
- Left rail: convs for general chat only (already filtered by "no `tutorCtx`" in
  `emptystate.js:154-159` semantics).
- Empty state: same starter chips + resume row.

Context payload chosen per §5.

#### 4.1.4 Planner card view

Not a full-screen route; opens the existing `#hwPlanModal` overlay on top of the home. Zero
UI change from today. **The card just adds a first-class entry point.**

#### 4.1.5 Schedule peek (tomorrow modal)

Overlay listing tomorrow's blocks in order, each row: block letter, course, teacher, "next due"
if any. Same data as the strip in (3). Hidden entirely in Test Mode.

### 4.2 Priority / red-ring / dot algorithm

**Inputs** (all client-side):
- `S.schedule` — the student's `[{course, teacher, subject, block}]`.
- `getHwTasks()` — homework, with `dueDate` (ISO string, possibly `""` / "no date") and
  `isComplete`.
- Now, as a `Date`.
- (v2 only) tomorrow's block letters, from the yet-to-exist school-wide rotation.

**Per-card fields computed:**
- `hasUrgentHw = task with dueDate ≤ now + 24h && !isComplete && className === card.course`
- (v2) `meetsTomorrow = tomorrowBlocks.includes(card.block)`

**v1 sort key** (ascending → top of grid):
1. Cards with `hasUrgentHw = true` sort first, by their most-urgent task's `dueDate`.
2. Remaining cards sort by "most recently used" (max `conv.ts` in `getConvs()` for that card's
   `(course, teacher)`) desc.
3. Fallback tie-break: alphabetical by course name.

**v1 visual:** the red *dot* (5-6 px) sits in the top-right of any card with `hasUrgentHw`.
No ring.

**v2 sort key** (when a rotation exists):
1. `meetsTomorrow && hasUrgentHw` — red ring (2-3 px border in `--accent-red`), sorted by
   `dueDate` asc.
2. `meetsTomorrow && !hasUrgentHw` — no ring, keep the ordering to the top.
3. `!meetsTomorrow && hasUrgentHw` — red *dot* (not ring).
4. Recency, then alphabetical.

**No-schedule / no-rotation behavior.** v2 degrades gracefully to v1 if the rotation lookup
fails or the school has no rotation configured. **The client MUST NOT assume every block meets
every day** — that would over-fire the ring on every card every weekday.

**Test Mode override.** Sort by alphabetical only; no dot, no ring, no strip. Rationale: the
teacher isn't actually enrolled with tomorrow's homework; the ring would be noise.

### 4.3 Navigation / state model

**Approach:** client-side hash routing, no framework. Two views:
- `app.html` (no hash, or `#home`) → home grid.
- `app.html#class/<courseB64>/<teacherEmailB64>` → class view.
- `app.html#general` → general chat.

**Why hashes, not path routes:** avoids server-side rewrites (this is GitHub Pages); works
with the existing static hosting. Also survives refresh (student stays where they were).

**Deep-link compatibility (must preserve):**
- **`app.html?mode=test`** — Test Mode entry. Query params and hash coexist. Boot detection in
  `app.js:44-48` runs **before** the hash router mounts; `S.isTestMode` gates data reads. When
  Test Mode is active, the home grid renders the synthesized test schedule; class-view routing
  still works but the class-view opens against the teacher's own profile (already the case).
- **`teacher.html?course=…&from=test-mode`** (TM-3, TM-4). Unchanged. The home grid's locked
  cards keep routing to it, and the "Back to test mode" banner on `teacher.html` keeps
  returning here.
- The existing "resume last chat on boot" behavior (via `lumi_current`) becomes: **on boot,
  if a hash is present, route to it; else render home**. We do NOT auto-open the last chat
  anymore. **OPEN D5** — is that the right call? Some students may prefer "open where I left
  off". Proposal: honor `?resume=1` for that behavior; otherwise land on home.

**State container.** `S.route = { name: 'home' | 'class' | 'general', course?, teacher? }`.
`S.tutorCtx` still gets populated when a class view mounts, so the existing chat pipeline
(system prompt build, notes/artifacts/progress-note injection markers) is unchanged.

**Back-button behavior.** `history.back()` from a class view goes home. Browser back at home
goes to `index.html` (sign-in), which auto-forwards back to `app.html` if session valid.
Native mobile back is the same, which matters for the phone use-case.

### 4.4 Priority / red-ring — see §4.2 above (unified spec).

### 4.5 `?mode=test` in the new layout

Verified from `app.js:41-118` and `js/prompts.js:updateTestModeBanner` and `js/storage.js
:loadTestModeSchedule`. The Test Mode plumbing (TM-1 through TM-4) has 3 non-negotiable
invariants:

- **TM-2** (data isolation): every write path guards on `S.isTestMode`. The redesign adds no
  new write paths that touch shared tables — the class-view chat pipeline is the same
  pipeline, gated by the same helpers. **Sanity checklist in code review:** any new function
  that calls `syncScheduleToSupabase`, `syncEnrollments`, `syncProfileToSupabase`,
  `syncConvToSupabase`, `saveConvs`, `loadProfileFromSupabase` MUST short-circuit on
  `S.isTestMode`.
- **TM-3** (locked classes route to teacher.html): home grid respects the "ready" gate. In
  Test Mode, locked cards route to `teacher.html?course=<encoded>&from=test-mode`. **In
  student mode**, locked cards show the "not ready yet" toast — no cross-navigation.
- **TM-4** (the banner + exit button): the exit button lives on the **user chip menu** in the
  new layout (settings drawer already has it today — same location). The banner surface
  moves from a chat-panel-anchored bar to a strip at the top of the home view, and stays on
  top of class views (per existing behavior via `#testModeBanner`). `updateTestModeBanner
  (course)` is called on class-view mount, same as today.

**In-scope:** verifying, at implementation time, that the new hash router does not accidentally
strip the `?mode=test` query param during a class-view mount (routers that use
`history.pushState('','',hashOnly)` will do exactly this if you're not careful). **Session 1
must include a Test Mode boot smoke-test.**

### 4.6 Module impact map

Legend: **U** unchanged · **M** modified · **R** replaced · **N** new.

| File | Verdict | One-line reason |
|---|---|---|
| `app.html` | **M** | delete sidebar markup; add home grid container, class-view container, general-chat container, tomorrow strip, due strip; keep every modal (`#hwPopup`, `#hwPlanModal`, `#projCreateModal`, `#projPlanModal`, `#hwDetailModal`, `#timelineModal`, `#settingsDrawer`) untouched |
| `app.js` | **M** | replace `renderSidebar()` boot with a router boot: read hash → mount home/class/general; keep `checkDailyHwPrompt`, `checkSemesterBanner`, `preloadProfileStatuses`, calendar wiring, voice init unchanged |
| `js/sidebar.js` | **R** (deleted) | folded into `js/home.js` + `js/classview.js`; the two static-catalog picker reads (`data.js:searchCurriculum` + subjects-tree) migrate: search moves to home header; browse-tree moves behind "+ Add a class" (which already uses `/available-classes` in the wizard, so this is where the known static-catalog fix lands automatically) |
| `js/conversation.js` | **M** | `openTutor()` becomes a hash-navigate → class-view mount; `openGeneralChat()` becomes hash `#general`; `newChat()`, `loadConv()`, `renderPinnedWelcome()` unchanged |
| `js/chat.js` | **U** | streaming, `doSend`, `renderMsg`, `handleFileSelect`, `buildApiMessages` — all unchanged |
| `js/emptystate.js` | **M** | `showWelcome()` (the current homepage) is gone; `renderEmptyState()` (per-class chips + resume row + welcome copy) stays for the class-view empty state |
| `js/prompts.js` | **U** | `buildTutorSystem` unchanged (marker mechanism preserved); `buildCompanionSystem` for General Chat (§5) — the "cheap" variant needs a one-line addition (the class list) |
| `js/voice.js` | **M** | `initVoice()` becomes idempotent + re-attachable; on class-view mount, re-bind `#micBtn` and `#msgInput` (both live inside the class view container now); on class-view unmount, `_recognition?.stop()`. TTS state (`_voiceMode`) stays global |
| `js/homework.js` | **U** for the planner UI; class-view read paths reuse `activeHwForClass(course)` unchanged |
| `js/projects.js` | **U** for modals; class-view Projects panel reads `getProjects().filter(p => p.className === course)` — pure read, no changes needed to `projects.js` itself |
| `js/schedule.js` | **U** | wizard invocation unchanged; `checkSemesterBanner()` unchanged |
| `js/onboarding.js` | **U** | 5-question chat wizard unchanged; runs before home mounts on first sign-in |
| `js/state.js` | **M** | add `S.route`; keep everything else |
| `js/storage.js` | **U** | schedule/convs/profile/enrollments/flushProgressNote paths unchanged |
| `js/data.js` | **U** but effectively demoted | `MENLO_CURRICULUM` becomes fallback-only (already the case in the wizard); the home grid never reads it |
| `js/api.js` | **U** | `callAPI` unchanged; every injection field it forwards (`inject_teacher_notes`, `inject_work_artifacts`, `inject_progress_note`) still lands on the Lambda unchanged |
| `js/teachers.js` | **U** | `preloadProfileStatuses`, `fetchAvailableClasses`, `getTeacherProfile`, `loadWorkSampleImages` — all reused by the home grid + class view |
| `teacher-directory.js` | **U** | one-shot memoized fetch; every consumer preserved |
| `js/ui.js` | **U** | helpers |
| `js/config.js` | **U** | |
| `cognito-auth.js` | **U** | |
| `js/home.js` | **N** | new module — home grid render, priority sort, dot rules, search, tomorrow strip, due strip; ~400 lines |
| `js/classview.js` | **N** | new module — class view chrome (header, left rail, chat panel mount); wraps the existing chat pipeline; ~300 lines |
| `js/router.js` | **N** | new module — hash router; parses `#home`, `#class/<c>/<t>`, `#general`; mounts + unmounts; ~120 lines |

### 4.7 Migration strategy

**Recommendation: flag-gated feature switch, single session cut.**

**Reasoning.** Teachers see this too via Test Mode; leaving a stale sidebar codebase alive
alongside the new grid doubles the maintenance surface and *risks* the Test Mode invariants
(TM-2 in particular — a stale write path from the old sidebar could pollute student data if it
survives). But we also can't yank the sidebar in one big commit with no way to revert if
teachers hate the grid on day one. **Best compromise:**

1. Land the router + `home.js` + `classview.js` behind `S.homeRedesign` (a boolean read from
   `localStorage.lumi_home_redesign_v1` at boot, default `false`). Old sidebar still boots
   when the flag is off; new home boots when it's on.
2. Turn the flag on for the author's own account (hardcode by email or by an admin toggle in
   Settings) and one test cohort.
3. After a week of live use in Test Mode + a small student group, flip the default to `true`
   and delete the sidebar code + the flag in a separate cleanup session.
4. **Do NOT ship the flag long-term.** It exists specifically to shorten the "roll back if
   this is bad" window to one Settings toggle. Kill it after two weeks max.

**Do not** ship the redesign flag-off in production and enable it out-of-band without also
turning it on for Test Mode — teachers can't validate their voice on a UI students don't have.

### 4.8 Ordered implementation plan (Claude Code sessions)

**Rule of thumb:** one feature per session; end each session with a commit AND a browser smoke
test showing the vertical slice works. Smallest end-to-end usable slice first, expanding out.

**Session 1 — Router + home grid MVP (smallest end-to-end slice).**
- Add `js/router.js`, `js/home.js`, minimal `js/classview.js` (just mount the existing chat
  panel into the new class view shell — reuse `#chatPanel` markup).
- Feature flag scaffold (`S.homeRedesign` from `localStorage.lumi_home_redesign_v1`).
- Home grid renders cards from `S.schedule`, teacher display name + block, tap → class view.
- Class view: back button, header, chat panel (untouched pipeline).
- Test Mode boot smoke (verify `?mode=test` survives the router mount).
- Commit; deploy to a preview branch; author uses their own account with the flag on for one
  day.

**Session 2 — "Where you left off" + "Next due" lines.**
- Add the last-conv snippet + timestamp line (§2.1 v1 fallback).
- Add the next-due line via `activeHwForClass(course)` (§2.2).
- Priority sort v1 (urgent-HW → recency → alpha).
- Red dot on cards with urgent HW.
- Commit + smoke.

**Session 3 — Class-view rail: convs, HW panel, projects panel.**
- Convs list (per-class filter — already implemented in `emptystate.js`, reuse the filter).
- HW panel scrolled to the tapped task if we arrived from a due-strip chip.
- Projects panel: read `getProjects().filter(p => p.className === course)`, open
  `renderProjectPlan` on click.
- Commit + smoke.

**Session 4 — Home utility cards + due-soon strip.**
- General Chat card (mounts `js/classview.js` with `S.route.name = 'general'`, chat uses
  `buildCompanionSystem` — see Session 5 for context enrichment).
- Planner card (opens existing `#hwPlanModal`).
- Due-soon strip at top of home (up to 3 chips, 72h horizon).
- Commit + smoke.

**Session 5 — General Chat cheap-context implementation.**
- Extend `buildCompanionSystem()` with the class list line (§5).
- If Layer-3 is enabled for the school, `POST /general-chat-context` returns per-class
  `last_session_summary` bundles and the client emits `<<LUMI_PROGRESS_NOTES_ALL>>` — server
  swaps. Fail-open to no context.
- Commit + smoke.

**Session 6 — Tomorrow's schedule strip (if rotation lands) OR ship "hide entirely" behavior.**
- If §9 D4 says "hide silently", this session is a 20-line UI change: don't render the strip.
- If we ship a rotation schema in the same window, this session builds the rotation lookup
  and the strip. Otherwise the strip stays out.
- Commit + smoke.

**Session 7 — Voice re-attachment audit.**
- Verify `voice.js` re-binds cleanly on class-view mount/unmount.
- Fix any leaked `_recognition` state.
- Commit + smoke.

**Session 8 — Flag flip + sidebar deletion + `sidebar.js` cleanup.**
- Delete `js/sidebar.js` and the `#sidebar` markup in `app.html`.
- Delete the feature flag branch.
- Move sidebar-only CSS to `home.css` / delete unused.
- Commit + verify (this is a big diff; take an extra look).

**Session 9 (optional) — Progress-note surface upgrade.**
- Add `GET /home-summary` Lambda route (§2.1 clean upgrade path).
- Wire the home cards to prefer the server line over the last-conv snippet when it exists.
- Fail-open.
- Commit + smoke.

Every session ends with `npm test` green (root + lambda), a browser smoke, and a manual Test
Mode boot check.

### 4.9 Voice — the one non-obvious hazard

Today `voice.js` is globally attached at boot (`initVoice()` binds `#micBtn` once, uses global
`_recognition` state). The class view *mounts and unmounts* — if we re-render its shell on
every navigation, `#micBtn` will exist in a fresh subtree and the old binding will point at a
detached DOM node. Two clean options for the redesign:

- **Option V-A (recommended).** Keep `#micBtn`, `#msgInput`, `#voiceListeningBar`,
  `#voiceConfirmBar` at document scope (children of `app.html` not the class-view container),
  and only move the chat *messages panel* + input row per view. `voice.js` untouched.
- **Option V-B.** Re-bind `voice.js` on class-view mount. Requires making `initVoice()`
  idempotent and adding a teardown that stops `_recognition` on unmount.

**Recommendation: V-A** — smallest diff, matches how the settings drawer already lives at
document scope.

---

## 5. Phase 3 — General Chat context design

The General Chat card is a *cross-class* Lumi that never wears a teacher persona. What context
should it have?

### 5.1 The two options, priced

**(a) CHEAP — class list + Layer-3 progress notes only (recommended).**

- What goes in the system prompt, in addition to today's `buildCompanionSystem` output:
  - One sentence naming the student's classes:
    `"Your classes this term: Algebra 2 (Mr. Harris), Chemistry (Ms. Huntley), …"`
    (from `S.schedule`; 3–8 classes, ~30–60 chars each; total ~200–400 chars).
  - When Layer-3 is enabled for the school, one compact per-class block *pulled by the server
    only*:
    ```
    ═══ WHAT LUMI KNOWS ABOUT THIS STUDENT ═══
    Algebra 2 (Mr. Harris): {last_session_summary}
    Chemistry (Ms. Huntley): {last_session_summary}
    …
    ```
    That's 1 line per class × 3–8 classes ≈ 8–20 lines. Each note is designed at ≤ 1 sentence
    (`PERSISTENCE_SPEC.md` §1). Total added: ~400–800 chars, or ~100–200 tokens.
  - **No teacher profiles**, **no work-samples**, **no engagement rules**, **no syllabi**.
- **Token cost per request.** Base companion prompt ~600 tokens. Add class list (~100 tokens).
  Add Layer-3 rolling summaries at full 8 classes (~200 tokens). **Total ~900 tokens** in the
  system prompt — small enough to be sent uncached without noticeable cost.
- **Caching interaction.** Trivial. There's no cache breakpoint on this prompt; it's short
  enough that the 2048-token Sonnet 4.6 minimum wouldn't be reached even if we tried.
- **Lambda changes.** Add a marker `<<LUMI_PROGRESS_NOTES_ALL>>` and a swap route parallel to
  the existing per-class ones. Reuses everything from `PERSISTENCE_SPEC.md`. Or: new route
  `GET /general-chat-context` returns the concatenated block; client emits the marker;
  Lambda swaps. Either shape ~150 lines. **Fail-open** to no notes section.
- **Behavior.** Lumi knows which classes the student takes and, when persistence is on, roughly
  where they are in each. It cannot mimic a teacher's voice or grading philosophy — by design.

**(b) FULL — merged multi-class context (all teacher profiles concatenated).**

- What goes in: every enrolled class's `buildTutorSystem`-shaped payload (engagement rules +
  teaching voice + course info + syllabus + work-sample text descriptions) concatenated.
- **Token cost per request.** Measure via `js/prompts.js:164-241` + real profile sizes:
  - Typical per-class payload without syllabus: engagement_rules (~500 tokens) +
    teaching_voice (~500) + course_info (~500) + work-sample descriptions (~300 total) =
    **~1,800 tokens per class**.
  - Rich per-class payload with syllabus: add 1,500–6,000 tokens for the syllabus text.
  - 6-class student without syllabi: **~11,000 tokens**. With syllabi: **~30,000+ tokens**.
  - Add the STUDENT MODE RULES + `studentCtx()` boilerplate (~800 tokens each): fine, still
    static.
- **Caching interaction.** This is where the option collapses. Per `docs/PROMPT_CACHING_PLAN.md`
  the item-H design is *one class per cached prefix*. A general chat that concatenates N
  class profiles produces a prefix that is unique to *this student's class list*. Two
  consequences:
  - No cache reuse across students (obvious).
  - Cache reuse across turns *for the same student* only works if their class list stays
    stable, which it does for a term — so caching per-student would help. But the cache
    write itself is 1.25×–2× the base input cost, on a 30k-token payload, on the *first turn
    of every 5-minute window*. That's an ~$0.15 write per session for the payload alone at
    Sonnet 4.6 pricing (verify pricing at build time). Break-even is 2 turns per window.
  - Worse: cache prefix ordering matters. Different students' class lists produce different
    orderings, so the cache is per-student — no economy of scale.
- **Lambda changes.** Non-trivial: fetch every enrolled `teacher_profile` server-side (client
  can't be trusted to send them), assemble the concat, apply markers per class *for the
  cache-split*, respect a total token budget so a 12-class student doesn't blow past 200k
  context. ~500 lines of new server code + probably a new schema for "assembled context
  snapshots" if we cache them anywhere.
- **Behavior.** Lumi could genuinely answer "help me draft a bio-history-integrated argument"
  with knowledge of both teachers' voices. That is the actual product upside.

### 5.2 Recommendation

**Ship (a) CHEAP in v1.** Reasons:

- **Doesn't add a persona ambiguity.** A cross-class Lumi that speaks in *no* teacher's voice
  is a cleaner mental model than one that averages voices. The student always knows "if I want
  Mr. Harris, I open Mr. Harris's card".
- **Cache design is not paid for by v1's product need.** The (b) full option gives Lumi more
  raw material but the token cost is real and the caching story is complicated. If a real
  student cannot demonstrably answer *actual* cross-class questions better with (b) than (a),
  we've paid for nothing.
- **Layer-3 slot is already reserved.** When Menlo turns on persistence, (a) automatically
  gets better because it starts carrying per-class summaries — for free, via the existing
  marker mechanism.
- **Deferrable to a data-driven decision.** Ship (a) in v1; if teachers or students ask for
  something (b)-shaped after real use, revisit with actual measurements.

**Do NOT collapse (a) and (b) behind a settings toggle.** That doubles surface for a
low-signal choice.

### 5.3 Concrete v1 spec for (a)

- **Client (`js/prompts.js`):** extend `buildCompanionSystem()` to append after `studentCtx()`:
  ```
  ═══ YOUR CLASSES ═══
  <one line per schedule entry: "Course (Teacher name)">
  <<LUMI_PROGRESS_NOTES_ALL>>
  ```
  and pass `{ inject_progress_notes_all: { teacher_profile_ids: [...] } }` in the chat body.
  Empty schedule → skip both blocks entirely.

- **Lambda:** add a marker + swap parallel to the existing 3. Server verifies caller from JWT,
  reads each `student_progress_notes.note_content->>'last_session_summary'` for
  `student_id = <jwt sub>` AND `teacher_profile_id = ANY($1::uuid[])`, formats as one line per
  class, joins with the same "silent use" trailer as the per-class version. Gated by
  `isPersistenceEnabled(email)` — off means the block is empty and the marker is stripped.
  Fail-open on any error.

- **Model:** unchanged. `SCHOOL_CONFIG.defaultModel` (Sonnet 4.6). No caching config change —
  the prompt is short enough that caching is not worth the write cost.

---

## 6. Migration notes + gotchas

### 6.1 The `sidebar.js` static-catalog fix, absorbed

The known "sidebar.js pickers still read `MENLO_CURRICULUM`" follow-up is fixed **by not
porting the sidebar**. Both sidebar pickers (subject-tree browse + search-dropdown) are
replaced:
- Subject-tree browse → gone; the equivalent is inside the schedule wizard's "All Menlo
  classes" toggle, and *that* path already fetches `/available-classes` since the recent
  landing (`js/schedule.js:145-154`). No new fix required.
- Search dropdown → moves to the home header, backed by `S.schedule` (enrolled classes) +
  `/available-classes` (new classes to add).

### 6.2 The schedule rotation gap — deliberately not solved here

We *know* the schedule model can't answer "meets tomorrow". The redesign ships without solving
it, on purpose:
- Solving it well requires **product decisions** (is the rotation per-school? per-teacher?
  hardcoded for Menlo? student-editable?) that are not this doc's scope.
- Shipping a bad heuristic (assume every class meets every day) would be worse than not
  shipping the ring: it would over-fire every day.
- Deferring is safe: the sort order still lifts urgent-HW cards to the top, so the *goal* of
  the ring ("show me what I need right now") is 80% delivered by the dot.

### 6.3 Test Mode's home grid

`loadTestModeSchedule()` (`js/storage.js:249` region) synthesizes the teacher's own classes as
`S.testSchedule`, each entry carrying a `ready` boolean. The home grid honors `ready`: locked
cards get the padlock corner and route to `teacher.html?course=…&from=test-mode`. Ready
cards open into the class view *against the teacher's own persona* — same as today. No
Layer-3, no due-strip, no tomorrow-peek.

### 6.4 Voice, again

See §4.9. If Option V-A is taken, `voice.js` is literally untouched. If V-B, plan for an
`initVoice()` idempotency refactor.

### 6.5 CSS

`style.css` is one big file. The redesign adds ~600 lines for home + class-view + strips; no
migration is needed because the current sidebar CSS gets deleted in Session 8. The cream/navy/
orange palette (`docs/COMPLIANCE.md`… actually `CLAUDE.md` §Visual refresh) is preserved — this
redesign is layout only, not visual language.

---

## 7. Open questions to `docs/PERSISTENCE_SPEC.md` (not blockers, but worth aligning)

- `PERSISTENCE_SPEC.md` §5 assumes progress notes are read *only* by the chat marker swap.
  This spec proposes a `GET /home-summary` route that returns `last_session_summary` per class
  to the browser. **Is that OK?** Argument for: `last_session_summary` is a single sentence,
  never contains PII by prompt design, and is *less* sensitive than the on-screen conv preview
  the app already shows. Argument against: it's a policy shift from "notes never reach the
  browser". **Kicked to §9 D6.**
- `PERSISTENCE_SPEC.md` §7 retention TBD. This redesign doesn't set it; just consumes whatever
  the spec lands on.

---

## 8. What's NOT in this spec

- Any change to `teacher.html`, `admin.html`, `privacy.html`, `index.html`.
- Any schema migration. If we ever add a rotation, it lands as a separate migration + spec.
- Any change to the Bedrock model, the chat streaming pipeline, or the injection markers.
- Any change to Cognito auth, the consent gate, or the domain allowlist.
- Any change to the item-H prompt caching design — this redesign preserves the segment split
  as-is.

---

## 9. DECISIONS — LOCKED (D1–D13, 2026-07-08)

Hadi accepted every recommendation as printed on 2026-07-08. This section is now the
authoritative product spec for session 1. Alternatives are kept below for context; do not
implement them.

**D1. DECIDED — D1-B: show a static "Say hi to [teacher]" chip.** Empty-state per class card (no
prior conv, no HW).
  - D1-A — show `"—"` (silent).
  - D1-B — show a static "Say hi to [teacher]" chip. **← chosen**
  - D1-C — show one of the STATIC_FALLBACK_PROMPTS ("Want to try some factoring
    practice?").

**D2. DECIDED — D2-A: no tag on the "where you left off" line.** The line looks the same before
and after the Layer-3 flip; content just gets smarter.
  - D2-A — no tag. **← chosen**
  - D2-B — a small "from your last chat" tag on the v1 fallback.

**D3. DECIDED — D3-A: no red ring in v1; use a red dot for HW-due-in-24h.** Ring lands in v2
alongside the rotation schema (see §6.2).
  - D3-A — drop ring; red dot on urgent-HW cards. **← chosen**
  - D3-B — ship a naive "assume every class meets every weekday" ring.

**D4. DECIDED — D4-A: hide the tomorrow-schedule strip silently until a rotation exists.**
  - D4-A — hide silently. **← chosen**
  - D4-B — always show; nag students to set up a block schedule they can't affect.

**D5. DECIDED — D5-A: land on home on boot; drop the auto-resume behavior.** `?resume=1`
deep-links preserve the old behavior for notification-tap flows.
  - D5-A — land on home. **← chosen**
  - D5-B — auto-open the last chat.
  - D5-C — land on home but pre-highlight the card that owns the last chat.

**D6. DECIDED — YES: `GET /home-summary` returns `last_session_summary` to the browser.** Follow-
up work (blocking): amend `docs/PERSISTENCE_SPEC.md` to document the one-field policy carve-out
("this single field is student-visible; the rest of the note is not"). Filed as §11 follow-up
below.

**D7. DECIDED — D7-A (CHEAP): General Chat carries the class list + Layer-3 summaries only,
never teacher personas.** No fanout over `buildTutorSystem`-shaped profiles.
  - D7-A — CHEAP. **← chosen**
  - D7-B — FULL (concat all class profiles).

**D8. DECIDED — D8-A / V-A: keep voice at document scope; class view owns only the messages
panel + input row.** `voice.js` untouched.
  - D8-A — voice at document scope. **← chosen**
  - D8-B — make `initVoice()` idempotent and re-bind on class-view mount.

**D9. DECIDED — D9-A: 2-week feature-flag window, then delete the flag and the sidebar code.**
  - D9-A — 2 weeks, then delete. **← chosen**
  - D9-B — leave the flag in but default-on after a week.
  - D9-C — hard cut, no flag.

**D10. DECIDED — D10-B: Test Mode home grid sorts "ready" first, then "locked", then
alphabetical within each group.**
  - D10-A — alphabetical only.
  - D10-B — ready → locked → alphabetical. **← chosen**

**D11. DECIDED — copy is "Chat with Lumi across your classes."** — the class-list context makes
the promise honest.

**D12. DECIDED — D12-A: locked cards in student (non-test) mode surface a toast "Your teacher is
still setting up".** Card remains visible so the student's enrollment map is intact.
  - D12-A — toast. **← chosen**
  - D12-B — hide the card.
  - D12-C — Settings-style modal.

**D13. DECIDED — D13-A: keep the intro slide (`_introShownFor` once-per-class) unchanged inside
the class view.** It sets pedagogy expectations, not identity; the card only shows identity.
  - D13-A — keep. **← chosen**
  - D13-B — deprecate.

---

## 11. Follow-ups locked in by §9

- **From D6:** amend `docs/PERSISTENCE_SPEC.md` §7 (or wherever the "notes never reach the
  browser" invariant is stated) to record the `last_session_summary` carve-out. Do this
  BEFORE the `GET /home-summary` route is added — the spec must precede the code.
- **From D9:** calendar the 2-week flag-window kill in whatever tracker Hadi uses; session 8 of
  the implementation plan (§4.8) is the concrete task.
- **From D3 / §6.2:** file a separate design pass for the rotation schema before session 6 —
  block-day mapping is per-school, not per-student, so this is a school-wide `schools.
  block_schedule` (or `school_block_schedule`) addition, plus a client `GET /block-schedule`
  route. Ring + tomorrow-strip both light up when that lands.

---

## 10. Sign-off checklist for implementation session 1

Before landing any code:

- [x] §9 D1–D13 answered — locked 2026-07-08.
- [ ] A staging Cognito account with a real Menlo email is available for smoke tests.
- [ ] `docs/PERSISTENCE_SPEC.md` §7 (retention) resolved — even a "keep current default"
      answer.
- [ ] Test Mode boot flow re-read and understood (`app.js:41-118` + `js/prompts.js
      :updateTestModeBanner`).
- [ ] Someone (you) has actually seen the mockup and confirmed the visual affordance
      choices — this spec is layout, not visuals.

---

## 12. Session 1 boot-smoke gate (2026-07-08)

Session 1 landed on branch `feature/session-1-home-redesign` in four small commits:

| # | Sha (branch) | What |
|---|---|---|
| 1 | `5a1ef23` | State scaffold (`S.homeRedesign`, `S.route`) + `js/router.js` + 15 router tests |
| 2 | `7a4a5b0` | `js/home.js` + `#homeView` / `#classViewHeader` containers + CSS |
| 3 | `41772e1` | `js/classview.js` + boot wiring + TM-4 exit button in Settings |
| 4 | *(this doc)* | Boot-smoke gate + manual browser verification list |

### 12.1 TM-1 through TM-4 walk (file by file)

Written against the exact changes on this branch. Every invariant preserved.

**TM-1 — `is_teacher_test=true` conversation flag.**
- Server-side only: Lambda + RDS. Session 1 touched neither.
- Conversation writes go through `js/storage.js:syncConvToSupabase`, unchanged.
- **Result: intact.**

**TM-2 — data isolation via `S.isTestMode` write-path guards.**
- Session 1 added ZERO new write paths. Every new module (`js/router.js`,
  `js/home.js`, `js/classview.js`) only reads state / mutates DOM.
- `home.js` reads `S.schedule` (or `S.testSchedule` when `S.isTestMode`); writes
  nothing back.
- `classview.js` calls `openTutor(...)`, which itself already respects TM-2
  (line 237 of `js/conversation.js`: `if (profile && ... && !S.isTestMode)`).
  No change here.
- `router.js` calls `history.pushState` and reads/writes `location.hash` — no
  shared-table surface.
- **Result: intact.**

**TM-3 — locked classes route to `teacher.html?course=…&from=test-mode`.**
- `js/home.js:renderCard`: when `!card.ready` **and** `S.isTestMode`, navigates
  to `teacher.html?course=<encoded>&from=test-mode` — matches the sidebar's
  previous route (`js/sidebar.js` had the same pattern).
- Student mode locked-card behavior is a toast (§9 D12-A) — never routes
  cross-page.
- **Result: intact, and slightly better (a locked card is now a big grid tile,
  not a small sidebar row).**

**TM-4 — persistent banner + exit button.**
- Chat-panel banner (`#testModeBanner`): app.js still flips
  `display = 'flex'` when `S.isTestMode` (unchanged). Visible during class
  view because the class view mounts the same `#chatPanel`.
- Home-view banner (`#homeTestBanner`): new in commit 2. Also flipped visible
  when `S.isTestMode`. Visible on home.
- Exit button — **the regression risk**. The original exit lives in
  `#sbExitTestBtn` inside `#sidebar`, which is CSS-hidden under
  `.home-redesign-v1`. If we shipped commit 2/3 alone, a teacher entering test
  mode would have no way out. Fixed in commit 3 by mirroring the exit button
  into Settings (`#settingsExitTestBtn`) — same click handler, same
  destination. Spec §4.5 called for this ("the exit button lives on the user
  chip menu in the new layout"), and the user chip is the Settings entry.
- **Result: intact.**

### 12.2 Student boot path (flag-off)

- `app.html` loads → auth guard → allowed-email → `loadTeacherDirectory` →
  test-mode boot detection → `S.homeRedesign` is `false` → **no body class
  applied** → user-chip populated (both sidebar chip AND home chip; home is
  hidden so writes are harmless) → `init()` → onboarding / schedule wizard as
  needed → `startApp()` → the existing `renderSidebar()` + `showWelcome()`
  path runs verbatim.
- Byte-identical to pre-redesign: no route hash appended, no `#homeView`
  shown, sidebar visible, chat panel is the landing surface.

### 12.3 Student boot path (flag-on)

- Same up through auth + directory + user chip.
- `S.homeRedesign` is `true` (localStorage flag set) → `body.classList` gets
  `home-redesign-v1` → CSS hides `.sidebar`, `.sb-overlay`, `.mob-header`.
- `init()` → `startApp()` → `renderSidebar()` still fires (populates
  `#sbUserEmail` subtitle) but the sidebar is invisible → hits the `if
  (S.homeRedesign)` branch → `initRouter({onHome: mountHome, onClass:
  mountClass})`.
- Router parses `location.hash`. Empty hash → `mountHome()` shows `#homeView`
  and renders the card grid.
- `?mode=test` in the URL survives every `pushState` because
  `buildRouteUrl(route, location.search)` prepends the query verbatim.

### 12.4 Teacher Test-Mode boot path (flag-on)

- URL: `app.html?mode=test`.
- Boot detection sets `sessionStorage.lumi_test_mode = 'true'` and
  `S.isTestMode = true`.
- `#testModeBanner` + `#homeTestBanner` + `#settingsExitTestBtn` all get
  `display` flipped to visible.
- `loadTestModeSchedule()` synthesizes `S.testSchedule` — each entry carries
  a `ready` flag.
- Home grid renders sorted `ready` first, then locked, alphabetical within
  each (§9 D10-B).
- Ready card → `navClass(course, teacher)` → `#class/<b64>/<b64>` hash →
  `openTutor(...)`. Query string preserves `?mode=test` (verified in the
  unit tests).
- Locked card → `teacher.html?course=<encoded>&from=test-mode`.
- Exit: Settings drawer → "← Exit test mode" → clears sessionStorage +
  navigates to `teacher.html`.

### 12.5 Test suites

- Root: **108 tests pass** (was 91; +15 router pure surface, +1 boot-smoke
  auto-discovery for `js/home.js`, +1 for `js/classview.js`).
- Lambda: **158 tests pass** (unchanged — no Lambda changes this session).
- All commits gated on both suites green.

### 12.6 What a student sees (flag-on)

- **Boot** → cream/navy grid of cards, one per enrolled class, alphabetized
  by course name. Big serif course name; small teacher last name; small
  block letter.
- **Tap a card** → the existing chat opens full-screen with a back-arrow
  button, the course title, and the teacher name in the header strip. Chat
  behaves exactly as before (streaming, welcome card, work samples,
  suggested-prompt chips, teacher-notes injection).
- **Back button** → returns to the grid.
- **Refresh at `#class/…`** → re-mounts the same class (D5-A: honor hash on
  boot).
- **Refresh at `#home` / no hash** → home.
- **Locked class** → tiled but faded, "Setting up" tag; tap in student mode
  shows a toast; tap in test mode routes to `teacher.html` prefilled.
- **Test Mode teachers** → grid with a terracotta strip at the top; Settings
  drawer carries an "Exit test mode" button; the existing chat-panel banner
  still shows during a class view.

### 12.7 Manual browser verification list (for Hadi)

Toggle: `localStorage.setItem('lumi_home_redesign_v1','true'); location.reload();`

Run each; each is <60 seconds.

- [ ] **B1.** Flag OFF → app boots into the old sidebar layout, byte-identical
      (no home grid visible, no `body.home-redesign-v1` class).
- [ ] **B2.** Flag ON → home grid renders, sidebar hidden, no console errors.
      Card count matches `getSchedule().length`.
- [ ] **B3.** Tap a *ready* card → class view mounts, back button visible,
      chat pipeline works (send a message, see streamed reply).
- [ ] **B4.** Back button → returns to home; the URL hash flips to `#home`;
      previous chat state preserved (revisiting the same card resumes it).
- [ ] **B5.** Deep-link — paste `app.html#class/<b64>/<b64>` in the URL bar
      (or hit refresh while on a class) → boots straight to that class.
- [ ] **B6.** `app.html?mode=test` → home grid renders with the terracotta
      test strip; ready classes sorted first, locked second (D10-B).
- [ ] **B7.** In Test Mode, navigate into a ready class → URL preserves
      `?mode=test` after the class hash. TM banner still visible in-chat.
- [ ] **B8.** Test Mode → Settings drawer shows the "Exit test mode" button;
      click → routes to `teacher.html`, sessionStorage cleared.
- [ ] **B9.** Student mode, tap a *locked* card → toast appears; no
      navigation.
- [ ] **B10.** Flag OFF → all the above surfaces (banner, exit button,
      sidebar) return to their old positions with no drift.

Any failure → flip the flag off (`localStorage.removeItem('lumi_home_redesign_v1'); location.reload();`) and the old layout is fully restored. Rollback is one line.

### 12.8 Session 2 pickup (per §4.8)

- Last-conv snippet + timestamp per card (§2.1 v1 fallback).
- Next-due line via `activeHwForClass(course)` (§2.2).
- Priority sort v1 (urgent-HW → recency → alpha).
- Red dot on cards with urgent HW (§9 D3-A).

### 12.9 Session 1.5+2 (combined) — home-v2 mockup wired to real data

Landed 2026-07-08 on `main` in four commits:

| # | What |
|---|---|
| 1 | Visual shell from `design-handoff/home-v2/Lumi Home.dc.html` — 1140px centered layout, brand row + greeting + user chip, search input, empty due-soon section, empty quick-actions, mockup card DOM (accent bar + icon tile + serif course + teacher·block + snippet slot + chip row). Fixes the current single-column grid bug. `renderSidebar()`/`showWelcome()` path untouched → flag-off byte-identical. |
| 2 | Real data wiring — where-you-left-off snippet (getConvs filtered by tutorCtx), next-due chip (getHwTasks filtered by className), priority sort v1 (urgent → recency → alpha; test-mode preserves D10-B), red urgent dot on ≤24h HW, D1-B "Say hi to [teacher]" empty-state chip. +16 tests. |
| 3 | Greeting + due-soon strip + General Chat + accent-bar palette hash + client-side search. Tonight's Study Plan stubbed disabled (Hadi decision — Session 4 wire). Test mode suppresses HW-shaped content. +9 tests. |
| 4 | *(this section)* — TM-1..TM-4 re-trace against the new markup. |

**Locked "Hadi pick" decisions (2026-07-08):**
- Subject grouping — FLATTEN to one grid.
- Tonight's Study Plan quick action — STUB disabled ("Coming soon — Session 4").
- Search bar — client-side filter only (no add-class shortcut).

**TM-1 through TM-4 re-trace (against the code as of commit 4).**

**TM-1 — `is_teacher_test=true` conversation flag.**
- Server-side only. Session 1.5+2 touched neither the Lambda nor RDS.
- Every conv write still routes through `js/storage.js:syncConvToSupabase` (unchanged).
- **Intact.**

**TM-2 — data isolation via `S.isTestMode` write-path guards.**
- Session 1.5+2 added zero new write paths. `js/home.js` only reads state and
  mutates DOM. `grep -n "sync|saveConvs|saveHwTasks|localStorage.setItem" js/home.js` returns nothing.
- The General Chat card handler calls `openGeneralChat()` from `js/conversation.js` (an existing surface;
  itself unchanged this session). It does call `saveCurrentConv()` on entry, but that already respects TM-2
  through `getConvs`/`saveConvs`, which branch on `S.isTestMode` (`js/storage.js:400-408`).
- `buildCards`, `renderGreeting`, `renderDueStrip`, `renderQuickActions` all short-circuit HW/conv reads
  on `S.isTestMode`. Test-mode suppression is uniform: no strip, no count line, no quick-actions row.
- **Intact.**

**TM-3 — locked classes route to `teacher.html?course=…&from=test-mode`.**
- `js/home.js:renderCard` — when `!card.ready` and `S.isTestMode`, navigates to
  `teacher.html?course=<encoded>&from=test-mode` (unchanged since Session 1).
- Student-mode locked card → `showToast('Your teacher is still setting up.')` (D12-A; unchanged).
- Locked cards keep their opacity + `.home-card--locked` treatment on the new card DOM.
- **Intact.**

**TM-4 — persistent banner + exit button.**
- `#testModeBanner` (in `#chatPanel`) — app.js still flips visible when `S.isTestMode`. Visible in class view and General Chat surfaces because both mount `#chatPanel`.
- `#homeTestBanner` (in `#homeView`) — preserved in the new markup; flip-visible logic unchanged.
- `#settingsExitTestBtn` — unchanged. Exit button lives in Settings drawer per §4.5.
- General Chat entry from the quick-action card reuses `#classViewHeader` with the label "General Chat / Across your classes" — back button still routes home via `navHome()`. TM banner still visible in-chat.
- **Intact.**

**`?mode=test` deep-link.**
- Zero new `pushState` calls in commits 1–4. Router unchanged. `buildRouteUrl` still preserves `location.search` verbatim.
- The General Chat click handler does NOT `pushState`; it swaps DOM only. Back button (already wired to `navHome()` in Session 1) restores `?mode=test` naturally since the current URL still carries it.
- **Intact.**

**Suites (commit 4).**
- Root: **133 tests pass** (+25 from Session 1: relativeTs, dueLabel, isUrgentDue, buildCards {ready/last-conv/next-hw/urgent}, sortCards {urgent/recency/alpha, test-mode D10-B}, timeOfDayGreeting, hashPalette, weekSummary, pickDueSoon).
- Lambda: **158 tests pass** (unchanged — no Lambda changes).
- All commits gated on both suites green.

**Manual verification list (extends §12.7 for the new surface).**

Toggle: `localStorage.setItem('lumi_home_redesign_v1','true'); location.reload();`

- **B11.** Flag ON → header shows serif greeting title ("Good <tod>, <First>") + date + count line ("N things due this week across M classes"). Zero HW → count line drops silently.
- **B12.** Due-soon strip renders up to 4 chips; urgent (≤24h) items get terracotta border + terracotta ink on the day badge. Empty → whole section hidden.
- **B13.** Quick-actions row shows Tonight's Study Plan (navy, disabled with "Coming soon" tooltip) + General Chat (cream). General Chat click → chat surface, back button returns home.
- **B14.** Search input filters cards live by course/teacher substring; blank query restores all.
- **B15.** Accent-bar color is stable across renders for the same course (`hashPalette` determinism).
- **B16.** `?mode=test` → strip / count line / quick-actions all suppressed; only the class grid renders (D10-B sort holds).
- **B17.** Mobile ≤640px → header stacks; grid single-column; strip single-column; quick-actions stack.
- **B18.** Grid **fills viewport width** and **centers** at the 1140 px cap. Home surface **scrolls** — all cards below the fold are reachable. (Layout-root fix 2026-07-08.)
- **B19.** Tap a ready card → class view shows the **back arrow + course title + teacher subline stacked ABOVE the chat panel** (not beside it). Chat panel fills remaining vertical space. Pinned welcome card renders, suggested-prompt chips appear, sending a message streams a reply — same as the old sidebar-initiated chat. (Layout-root fix 2026-07-08.)

### 12.10 Live-testing bugfixes (2026-07-08)

Three bugs surfaced in the first browser session with the flag on:

| Bug | Symptom | Root cause | Fix commit |
|---|---|---|---|
| 1 | Home occupies only the left ~half of the viewport, doesn't center. | `.main{display:flex}` (flex-row) at style.css:337 — `#homeView` was a flex-row child with no `flex:1`/`width:100%`, so it shrank to the intrinsic width of the 1140px shell. `.home-redesign-v1 .content{display:block}` neutralized `.main{flex:1}` but did not override `.main`'s flex-row layout. | Column-flex layout roots scoped to `.home-redesign-v1`. |
| 2 | Content below the first card row unreachable. | Same layout defect. `html,body{overflow:hidden}` means the redesign must scroll internally; `#homeView` had `overflow-y:auto` but the flex-row squeeze + `.main{overflow:hidden}` clipped it. | Same commit — `#homeView{flex:1;min-height:0;overflow-y:auto}` gives it real vertical space to scroll in. |
| 3 | Tapping a class card mounts an "empty" chat — no welcome card, no teacher identity. | Downstream layout artifact — NOT a wiring bug. `#classViewHeader` + `#chatPanel` rendered side-by-side as flex-row children; `#chatPanel` collapsed to intrinsic height ≈ 0. `renderPinnedWelcome`, teacher-notes injection, streaming, and work samples were all firing correctly into `#messages`, which was visually clipped. `classview.js:mountClass → openTutor` is byte-identical to `sidebar.js`'s callers at js/sidebar.js:262/296/368/553. | Same layout commit fixes it. Verified via B19. |

**Adjacent diagnostic (not a bug — added defensively).**
`lookupSubjectForCourse` (js/conversation.js:14) returns `{subjectId:null}` for any course not in the static `MENLO_CURRICULUM` (js/data.js:3). Not a chat blocker (`S.tutorCtx.subjectId=null` doesn't gate anything downstream), but silent under the redesign — the sidebar previously masked it because its browse tree was built FROM `MENLO_CURRICULUM`, whereas the home grid renders directly from `S.schedule`. `js/classview.js:mountClass` now `console.warn`s when this happens so a schedule/catalog drift (e.g. `/available-classes` renamed a course that's still stored in `lumi_schedule` under the old name) is diagnosable rather than invisible.

**TM-1..TM-4 re-verification after the layout fix.**
- **TM-1**: Server-side only. Untouched.
- **TM-2**: The fix is CSS-only + one `console.warn`. Zero new write paths in `js/home.js` / `js/classview.js` (grep `sync|saveConvs|localStorage.setItem` in the changed files returns nothing).
- **TM-3**: Locked-card routing unchanged. `S.isTestMode` branch in `js/home.js:renderCard` still points to `teacher.html?course=<encoded>&from=test-mode`.
- **TM-4**: `#homeTestBanner` + `#testModeBanner` + `#settingsExitTestBtn` IDs unchanged. Banners still flip `display` visible when `S.isTestMode`. `.class-view-header{flex-shrink:0}` scoped to the flag; TM-mode banner in `#chatPanel` still stacks above the messages area (chat-panel is flex-column internally).
- `?mode=test` deep-link: zero new `pushState` calls; router untouched.
