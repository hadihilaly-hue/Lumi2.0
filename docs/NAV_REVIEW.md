# Lumi 2.0 — Navigation / UX Review

**Question:** can a student and a teacher, on their first visit, get to the thing they came for
without being confused?

**Verdict:** *Student — mostly yes, once they reach home; the road to home is long (14 screens,
~21 clicks, ~10 typed answers) and the first thing home does is cover itself with a modal.*
*Teacher — yes for setup, no for "Student mode": the toggle is the single most dangerous
button in the product for a demo and drops a first-time teacher into the student onboarding
interview with no visible way back.*

Method: both surfaces were driven locally (`python3 -m http.server 8099`, Playwright over the
running Chrome's CDP endpoint, `localStorage` auth shim, `window.fetch` stubs for Lambda routes).
Every screen and transition below has a screenshot; the file names (`s##-…`, `t##-…`) are
referenced inline and embedded in the PR description. Nothing in the product was changed.

Companion docs read: `CLAUDE.md`, `README.md`, `docs/DESIGN.md`, `UX_FINDINGS.md`,
`AUDIT_FRONTEND.md`, `docs/STUDENT_HOME_REDESIGN.md`.

---

## 1. The five findings that matter most

Ordered by (demo damage × likelihood) ÷ effort.

| # | Finding | Where | Effort | Before demo? |
|---|---------|-------|--------|--------------|
| 1 | **Teacher "Student mode" toggle lands in the student onboarding interview** ("I've got 5 quick questions…") if the teacher has never completed student onboarding. No test-mode banner is visible, no back button, no exit. `t19b` | `teacher.html` header → `app.html?mode=test` | trivial (skip onboarding when `S.isTestMode`, or seed `lumi_onboarding_complete`) | **Yes — must** |
| 2 | **Home is covered by two interrupts the instant a new student arrives**: the Homework Check-in modal *and* the "Add/drop period is open — did your schedule change?" banner, 3 seconds after the wizard captured that schedule. `s14`, `s15` | `js/homework.js checkDailyHwPrompt`, semester banner in `js/schedule.js` | trivial (don't fire either on the session that completed the wizard; make the check-in a card, not a modal) | **Yes** |
| 3 | **Class intro slide traps the user.** Open a class → intro overlay → press browser back or land on `#home` → overlay stays on top (`position:absolute; inset:0; z-index:20`), intercepts every click, "←" back button is visible but dead. Only escape is the "Let's get into it" button or a reload. `s17`, `s17b` | `js/conversation.js showIntroSlide`, no `hide` on route change | trivial (hide `#introSlide` in `mountHome`/route change; or make the slide dismiss on any click) | **Yes** |
| 4 | **Card copy contradicts the lock.** Locked class cards read "Say hi to Lee" *and* "SETTING UP"; tapping gives a toast "Your teacher is still setting up." The invitation and the refusal are on the same card. `s33` | `js/home.js` card empty-state (D1-B) vs lock label | trivial (suppress "Say hi" on locked cards; label "Teacher setting up — check back soon") | **Yes** |
| 5 | **"Complete" on the teacher home ≠ "ready" in Student mode.** A class marked `Complete · SETUP COMPLETE` on `teacher.html` shows `SETTING UP` / locked in test mode, because readiness there additionally requires a welcome message and all three work-sample tiers. A teacher who just saw "Setup complete" will not understand why their class is locked. `t03` vs `t19d` | `teacher.html renderClassCards` (`done`) vs `js/storage.js loadTestModeSchedule` (`done && welcome && hasAllTiers`) | trivial to *label* honestly ("Complete · needs samples to go live"); moderate to unify the rule | Label: yes. Rule: after |

Everything else is below, but if only five things get fixed before recording, make it these.

---

## 2. Student journey, step by step

Click counts are the minimum a first-time user needs from the previous step, excluding typing.
Total to first useful chat reply: **~21 clicks, 5 free-text answers, 1 privacy scroll, across
14 distinct screens.**

| # | Screen (shot) | What the user is asked to do | Clicks | Ambiguity / unnecessary / first-time mistake |
|---|---------------|------------------------------|-------:|----------------------------------------------|
| S1 | Sign-in `s00` | "Continue with Google" | 1 | Clean. On localhost it dead-ends at Cognito `redirect_mismatch` (`s01`) — irrelevant to users but **do not record from localhost**. |
| S2 | Consent `s02b`, `s03` | Scroll a full privacy policy to the bottom, then "I understand & agree" | 1 + long scroll | Header says **"Draft — not yet legally reviewed"** and shows `[PLACEHOLDER]` for effective date and contact email. On camera this reads as unfinished. Scroll-gating ("Please scroll to the bottom to continue") is a legal choice; a first-timer will click the greyed button before scrolling and think it is broken. |
| S3 | Onboarding Q1 `s04` | Chat-style: Lumi introduces itself and asks "Ready?" then name | type ×1 | Nice tone. But there is no progress indicator despite the copy promising "5 quick questions"; no way to skip; no header/back. A student who wants to *see the app* first cannot. |
| S4–S7 | Onboarding Q2–Q5 `s05-q2…q5` | Study style, school-night schedule, preferred help when stuck, hardest part of school | type ×4 | Q3 ("what does a school night look like") and Q5 ("hardest part") are the ones students pad or dodge. **Decision too early:** these are exactly the questions that make sense *after* a first chat, not before. Offline: shows a wall of "trouble connecting… refresh" with no retry button (`s32`). |
| S8 | Wizard 1/6 Grade `s07` | Pick 9/10/11/12 | 1 + Next | Grade was not asked in onboarding, so this is fine — but "Next" is a separate click when the choice is single-select. |
| S9 | Wizard 2/6 Classes `s08`, `s08b` | Multi-select classes, then Next | 3–6 + 1 | Good. Only classes with an onboarded teacher appear, but nothing says so — a student whose class is missing will assume a bug. |
| S10 | Wizard 3/6 Teachers `s09`, `s09b` | One screen *per class*: pick the teacher | 1 per class | Auto-advances 200 ms after the tap. **Mistake:** mis-tap → gone; the "Back" affordance is small and the screen already changed. For a class with one teacher (most cases) this screen is pure overhead. |
| S11 | Wizard 4/6 Blocks `s10` | One screen per class: pick block A–G | 1 per class | Same auto-advance. **Steps 3 and 4 ask about the same class twice in a row; merge into one row per class** (see §5.1 for the merged copy). Students also don't always know their block letter at the moment of signup. |
| S12 | Wizard 5/6 Study style `s11` | Choose short bursts / long focus etc. | 1 + Next | **Duplicate:** onboarding Q2 already asked study style and stored `study_style`. A first-timer notices ("didn't I just answer this?"). |
| S13 | Wizard 6/6 Confirm `s12` | Review, "Looks good" | 1 | Fine. |
| S14 | Home, first sight `s14`, `s15`, `s16` | — | 2 to dismiss | **Modal "Homework Check-in" on top of a blurred home, plus an "Add/drop period is open" banner** the same minute the schedule was saved. First impression of the hub is two interruptions. Card order also shifts between visits (recency sort) so cards "move" on camera (`s16` vs `s21`). |
| S15 | Open class `s17` | Card tap → full-screen intro slide ("Hey Alex. Your teacher is in.") → "Let's get into it" | 2 | The slide is good copy and worth keeping (agrees with D13). But it is a **modal with one exit**; see finding 3. |
| S16 | Class chat `s18`, `s19`, `s20` | Type; three starter chips; rail with Chats / Homework / Projects | 1 | Good. The `←` in the header is the only route home; the rail's `+ New chat` and starters are clear. Streaming reply lands in Source Serif — this is the money shot. |
| S17 | Back home `s21` | `←` | 1 | Works. Card now shows the last message preview — good. |
| S18 | Return later `s22`, `s23` | Reload → home → tap card → resumes last conversation | 1 | Works; conversation persisted and the intro slide did not reappear. Browser back from class goes to home (`s24`). |
| S19 | Planner `s25`, `s30` | Tap "Tonight's Study Plan" card | 1 | **Dead end when empty:** a screen with a back button and no primary action. The only way to add homework is the *daily popup* (which only fires once a day) or the `+ Add` inside a class rail. |
| S20 | Homework add flow `s26`–`s26h` | Popup → "+ Add homework" → type chooser → modal → title → save → "Generate tonight's study plan" → plan modal | 5–6 | **Four stacked layers** (popup, chooser, modal, plan modal). `Esc` closes only the top one; `s26f` shows popup and plan modal still open after Esc. On camera this looks like a bug. |
| S21 | Settings `s27`, `s28` | Tap user chip (top-right) → drawer | 1 | Drawer label is only a `title` tooltip; a first-timer finds it by luck. Contents are sensible; "Update My Schedule" reopens the wizard prefilled (`s28`) — good. |
| S22 | General Chat `s29` | Card → full-screen chat | 1 | Clear. Only inconsistency: its prompt cards use emoji glyphs (📚💡✏️✅) while the class starters do not — violates the no-emoji rule in `docs/DESIGN.md`. |
| S23 | Search `s35` | Type in "Search your classes or teachers" | 0 | Filters cards live. Hidden when not on home; harmless. |
| S24 | Empty schedule `s31` | — | — | "No classes on your schedule yet." with **no button** to add one; the only route is user chip → Update My Schedule. |
| S25 | Test mode (student side) `s36` | `?mode=test` | — | Banner clear; "Exit test mode" exists in the drawer. |

**Ambiguity of place:** the student app has no persistent wordmark-as-home-button. From a class,
the only way back is the `←`. From the plan/general views, same. That is *fine* for hub-and-spoke,
but the wordmark (`.home-brand`, "Lumi · Menlo School") on home is a plain `<div>`, not a link, and on class views the header is
the course name. Make the wordmark (or the course pill) always route to `#home` — trivial.

---

## 3. Teacher journey, step by step

Total to a saved profile: **~14 clicks + 4 long text fields (≥50 words ×3, ≥80 chars ×1).**
Total to a per-student note: 4 clicks from home.

| # | Screen (shot) | What the user is asked to do | Clicks | Ambiguity / unnecessary / first-time mistake |
|---|---------------|------------------------------|-------:|----------------------------------------------|
| T1 | Sign-in `t00` | "Sign in with Google" | 1 | Fine. Same Cognito dead end on localhost (`t01`). |
| T2 | Gate `t02` | Non-teacher email → "Not a registered teacher · Your email isn't in our teacher database yet." + Sign out | 1 | Correct behaviour, but a dead end with no "I'm a student → go to app.html" link and no "contact admin" route. A teacher with a personal Gmail would sit here. |
| T3 | Home `t03` | Header: Student mode toggle · name · Sign out. Body: search + All/Not Started/Complete pills, class cards, "My Students" accordion | — | **Three status labels on one card**: dot "Complete", pill "SETUP COMPLETE", and a "New step added" notice with *two* action buttons ("View & Edit", "Add samples"). The filter pills are pointless for 1–4 classes (`t27`: "Not Started" leaves a single card on screen). Subject shows "General" when the course isn't in the directory. |
| T4 | Wizard 1/6 `t04`, `t04b`, `t04c` | Title dropdown + engagement rules (≥50 words) | 1 + type | Sub-prompt chips ("What's off-limits?") look like buttons but are `<span>`s — first-timers will click them. Continue stays disabled with only a word counter to explain why; no message on click. "Show examples" is collapsed by default — expand it by default; it is the best help on the page (`t04d`). |
| T5 | Wizard 2/6 `t05` | Teaching voice (≥50 words) | 1 + type | Same pattern. Fine. |
| T6 | Wizard 3/6 `t06` | Course info (≥50 words) + optional syllabus PDFs | 1 + type | The upload box is *above* the textarea and visually primary; teachers will upload a PDF and expect Continue to enable — it does not (text is extracted but the 50-word gate is on the textarea). |
| T7 | Wizard 4/6 `t07` | Welcome message (≥80 chars) | 1 + type | Good question, clear preview text. |
| T8 | Wizard 5/6 `t08` | Three tiers × (photos / written example / description) | 1 | **Optional, but the heading doesn't say so** — only tiny "(optional)" next to "Add photos". The PII warning box is the first thing on screen. Page is taller than the viewport; the "Review & Save" button is below the fold in a scrolling panel. Mistake: teachers stall here thinking they need three graded papers to continue. |
| T9 | Wizard 6/6 `t09` | Review cards, share-course-info checkbox, "Save and Finish" | 1 | Good. Edit buttons jump back correctly. The share checkbox's consequence is unexplained. |
| T10 | Save `t10`, `t11` | — | 0 | Toast "Profile saved!" then auto-return to home after 1 s. Fine. Save failure shows raw `Failed to save: teacher-profile 500` (`t25`) — leaks route names on camera. |
| T11 | Header "Back" mid-wizard `t23`, `t24` | `‹ Back` in the wizard header | 1 | **Silently discards edits**, no confirm. Two things are labelled "Back": the header one (leave wizard, lose work) and the footer one (previous step). Rename the header one "Exit without saving" or confirm. |
| T12 | Roster `t12`, `t13` | Home → expand class in "My Students" → click a block row | 2 | The accordion header and the block rows are both clickable regions with no button affordance. "0 students ▸" rows expand to nothing. Roster items have no chevron/hint that they open notes. |
| T13 | Per-student notes `t14`, `t15`, `t17` | Type an observation, Send | 1 + type | **Enter inserts a newline; only Ctrl/⌘+Enter or the Send button sends** — nothing says so. Notes show no timestamp and no explanation of what they are for ("Lumi uses these when it tutors this student — the student never sees them" is one line and would remove the biggest question a teacher asks). Save failure toast is fine (`t16`). |
| T14 | Student mode `t19`, `t19b` | Header toggle → `app.html?mode=test` | 1 | **Finding 1.** Fresh teacher → student onboarding interview, no banner, no exit. Teacher who has finished onboarding → student home with the *same* Homework Check-in modal + add/drop banner (`t19c`) and their own classes shown **locked** (`t19d`) — see finding 5. |
| T15 | Locked card in test mode `t19e` | Tap → `teacher.html?course=…&from=test-mode` → wizard step 1 | 1 | Cross-surface jump straight into step 1 of the wizard with a plain "Back". The "You came from Test Mode" banner only renders on teacher *home*, so the teacher never sees it until they back out. |
| T16 | Ready class in test mode `t19f`, `t20`, `t20b` | Card → intro slide → chat with pinned welcome | 2 | This is the demo-worthy path. Homework/Projects rail says "Hidden in test mode" — good honesty. |
| T17 | Exit test mode `t21`, `t22` | User chip → "← Exit test mode" | 2 | Works, returns to `teacher.html`. But the header toggle that got you in is not the thing that gets you out — asymmetric. |

---

## 4. Friction that matters (grouped)

### 4.1 Steps to remove or merge (student)
- **Merge wizard 3 (teacher) + 4 (block) into one row per class.** Today: N teacher screens + N
  block screens, each auto-advancing. Target: one screen, one row per class:
  `US History (H) — [Harris ▾] — Block [C ▾]`. Same data, N×2 screens → 1.
- **Drop wizard step 5 (study style).** Onboarding Q2 already captured it. If onboarding is ever
  skipped, keep the step conditional on `study_style` being unset.
- **Fold grade into the classes screen** (small segmented control above the class grid). Saves a
  screen and a Next.
- Result: schedule wizard goes 6 screens → 3 (Grade+Classes, Teachers+Blocks, Confirm).

### 4.2 Decisions asked too early
- Onboarding Q3–Q5 (school night, help style, hardest part) before the student has seen a
  single chat. These feed the planner, which the student won't touch on day one. Ask the two that
  gate the tutor (name, study style) and defer the rest to the first time they open the planner
  ("Before I plan your night, two quick questions").
- Homework Check-in on the first ever home load. It should never fire on the same session the
  wizard completed, and never together with the semester banner.
- The semester add/drop banner should not fire within N days of the schedule being saved.

### 4.3 Missing back / escape routes
- Class intro overlay (finding 3).
- Onboarding chat: no skip, no progress, no back.
- Teacher gate: no route for "I'm a student".
- Empty planner and empty home: no primary action.
- Stacked homework overlays: `Esc` closes one layer and leaves the rest open.
- Teacher wizard header "Back" is an escape that destroys work with no warning.

### 4.4 Unclear labels / unlabeled state
- "Say hi to X" on a locked card (finding 4).
- Teacher card: Complete + SETUP COMPLETE + New step added (three states, one card).
- Teacher "Complete" vs student-side "SETTING UP" (finding 5).
- Wizard sub-prompt chips look interactive.
- Settings only reachable via an unlabeled avatar chip.
- Notes: Enter vs ⌘+Enter unlabeled; no timestamps.
- Filter pills "All / Not Started / Complete" — state for a list of two.

### 4.5 Awkward on camera
1. Blurred home + modal + banner as the first hub reveal (`s14`).
2. "Draft — not yet legally reviewed" / `[PLACEHOLDER]` on the consent page (`s02b`).
3. Teacher toggles Student mode and gets interviewed as a student (`t19b`).
4. Intro overlay stuck after a stray back-press (`s17b`) — presenter has to reload.
5. Two overlays left open after `Esc` (`s26f`).
6. `Failed to save: teacher-profile 500` toast if the network hiccups (`t25`).
7. Emoji in General Chat prompt cards vs the rest of the UI (`s29`).
8. Cards reorder between visits; "General" as a subject label on teacher cards.

---

## 5. Target navigation model

### 5.1 Student

```
index.html ─ Google ─▶ privacy (once) ─▶ onboarding (2 Qs: name, study style; skippable)
                                          │
                                          ▼
                              schedule wizard (3 screens)
                              1 Grade + Classes   2 Teacher & Block per class   3 Confirm
                                          │
                                          ▼
                     HOME  (hub; wordmark always returns here; no modals on first load)
                     ├─ class card ─▶ CLASS VIEW (intro slide once, dismiss on any click,
                     │                 hidden on route change) ─▶ chat  ← back
                     ├─ Tonight's Study Plan ─▶ PLANNER (empty state has "+ Add homework"
                     │                 as the primary button; check-in becomes a card here)
                     ├─ General Chat ─▶ GENERAL (no emoji starters)
                     └─ user chip (label it "Settings") ─▶ drawer
```

Merged copy for the new wizard screen 2:

> **Who teaches each class, and when?**
> US History (H) · Teacher `[Jordan Harris ▾]` · Block `[C ▾]`
> Chemistry (H) · Teacher `[Daniel Lee ▾]` · Block `[C ▾]`
> Junior English Seminar · Teacher `[Maya Fox ▾]` · Block `[C ▾]`
> *Not sure of your block? It's the letter on your printed schedule.*
> `[Back]` `[Continue]`

(Default-select the teacher when a course has exactly one. Block stays required — an entry
without one is skipped by `syncEnrollments` and the student vanishes from the teacher's roster —
so Continue stays disabled until every row has a block; the hint just tells them where to look.)

Locked-card copy: replace "Say hi to Lee" + "SETTING UP" with a single line
**"Dr. Lee is still setting up — check back soon"**, card non-interactive (no toast needed).

### 5.2 Teacher

```
teacher.html ─ Google ─▶ gate (adds: "Not a teacher? Open the student app →")
                          │
                          ▼
                     HOME: class cards (one status word each: Not started / Ready /
                           Ready — add samples to go live) + roster accordion
                     ├─ Set up / Edit ─▶ WIZARD 6 steps (header: "Exit" with confirm if dirty;
                     │                    step 5 titled "Graded work samples (optional)";
                     │                    examples expanded by default; Continue-disabled
                     │                    reason shown inline on click)
                     ├─ block row ─▶ ROSTER ─▶ NOTES (hint: "⌘/Ctrl+Enter to save. Only you
                     │                    and Lumi see these; students never do." + timestamps)
                     └─ "Preview as student" (rename of Student mode) ─▶ app.html?mode=test
                            • never shows onboarding or homework check-in in test mode
                            • test-mode banner has its own "← Back to Teacher Portal"
                            • readiness rule shown on the teacher card so no surprise locks
```

Drop the search box and filter pills from teacher home until a teacher has >6 classes
(render conditionally; 1 line).

---

## 6. Recommendations, ordered by impact ÷ effort

| Rank | Change | Effort | Before demo? | Files |
|-----:|--------|--------|--------------|-------|
| 1 | Test mode: skip student onboarding and homework check-in when `S.isTestMode`; render the test banner before anything else | trivial | **yes** | `app.js`, `js/homework.js`, `js/onboarding.js` |
| 2 | Hide `#introSlide` + restore `#chatPanel` on every route change / `mountHome` | trivial | **yes** | `js/conversation.js`, `js/classview.js` or `js/router.js` |
| 3 | Suppress Homework Check-in and semester banner on the session that just completed the wizard (set `lumi_hw_date` / semester flag at wizard save) | trivial | **yes** | `js/schedule.js`, `js/homework.js` |
| 4 | Locked card copy: drop "Say hi", single "still setting up" line, no toast | trivial | **yes** | `js/home.js` |
| 5 | Teacher card: one status label; "Complete but needs samples/welcome" gets its own word so it matches student-side lock | trivial | **yes** | `teacher.html renderClassCards` |
| 6 | Wizard step 5 heading "(optional)"; examples expanded by default; sub-prompt chips styled as plain text | trivial | **yes** | `teacher.html`, `style.css` (wizard block only) |
| 7 | Notes: hint text for ⌘/Ctrl+Enter + one-line purpose; make plain Enter send (Shift+Enter newline) | trivial | **yes** | `teacher.html sendNote` |
| 8 | Rename header "Student mode" → "Preview as student"; test-mode banner gets "← Back to Teacher Portal" | trivial | **yes** | `teacher.html`, `app.html` |
| 9 | Remove emoji from General Chat prompt cards | trivial | **yes** | `js/home.js` / `js/general*.js` |
| 10 | Consent page: real effective date + contact, remove "Draft" banner (owner decision, not code) | trivial | **yes if owner can** | `privacy.html` |
| 11 | Friendly save-error copy ("Couldn't save — check your connection and try again") instead of `teacher-profile 500` | trivial | yes | `teacher.html` |
| 12 | `Esc` / backdrop closes the whole homework stack | trivial | yes | `js/homework.js` |
| 13 | Empty planner + empty home get a primary "+ Add homework" / "Add your classes" button | trivial | yes | `js/studyplanview.js`, `js/home.js` |
| 14 | Wizard header "Back" → "Exit" with confirm when dirty | trivial | yes | `teacher.html goHome` |
| 15 | Make wordmark a home link on every student view | trivial | yes | `app.html`, `js/router.js` |
| 16 | Merge wizard teacher+block screens; drop study-style step; fold grade into classes (6 → 3) | moderate | **after** (touches enrollment save path; regression risk during a parallel-edit week) | `js/schedule.js`, `app.html` |
| 17 | Onboarding: 2 questions up front, defer 3 to first planner use; add progress + skip | moderate | after | `js/onboarding.js`, prompt in Lambda |
| 18 | Unify readiness rule (`done` vs `done+welcome+tiers`) in one shared helper used by both surfaces | moderate | after | `js/storage.js`, `teacher.html` |
| 19 | Homework check-in becomes a card on home / planner instead of a modal | moderate | after | `js/homework.js`, `js/home.js` |
| 20 | Gate: "Not a teacher? Open the student app" link | trivial | after (needs owner OK on wording) | `teacher.html` |
| 21 | Teacher home: hide search/filters under 6 classes | trivial | after | `teacher.html` |
| 22 | `#sbExitTestBtn` (rail exit button) was never visible in test-mode class view (`t20b`); confirm whether it is still wired and remove if not | trivial | after | `app.html`, `js/*` |

Items 1–15 are each a few lines, confined to their own file/CSS block, and do not change data
shape — safe alongside the other parallel sessions. Items 16–19 change flows or storage timing
and should land after the recording.

---

## 7. Cross-check against `docs/STUDENT_HOME_REDESIGN.md`

**Agree — and the browser confirms it shipped well:**
- Hub-and-spoke with hash routes (§4.3): back button behaviour, refresh survival, and
  `?mode=test` preservation all verified (`s21`, `s23`, `s24`, `s36`).
- D5-A (land on home, no auto-resume): correct call; the card preview makes resume one tap.
- D11 General Chat copy "Chat with Lumi across your classes." — accurate on screen.
- D10-B test-mode sort (ready first, locked second) — observed in `t19f`.
- D12-A toast for locked cards in student mode — *mechanism* is fine; the **copy** is not (see
  finding 4). The spec did not anticipate D1-B ("Say hi to X") and D12-A rendering on the same
  card; they conflict. Recommend: D1-B applies only to ready cards.
- D13-A keep the intro slide — agree on content; **disagree on implementation**: the spec calls
  it "inside the class view" but it is a document-level overlay that outlives the route.
  Keep the slide, make it route-aware and dismiss-on-any-click.

**Disagree / would amend:**
- §4.1 puts the Homework Check-in and the semester banner in the "preserved localStorage
  features" bucket (§3) without a rule for *when* they fire relative to first load. The
  redesign made home the first thing a student sees, which makes these interrupts far more
  costly than in the sidebar era. Add a rule: no modal/banner on the boot that follows wizard
  completion; at most one interrupt per session.
- §4.5 TM-4 keeps the exit button "on the user chip menu". That is fine as a secondary exit, but
  the primary exit should be on the test banner itself — the thing the teacher is looking at.
- §4.5 TM-3 routes locked test-mode cards to `teacher.html?course=…&from=test-mode` (wizard
  step 1). Observed (`t19e`): the return banner is on teacher *home*, not on the wizard, so the
  teacher sees no return path until they abandon the wizard. Either show the banner in the
  wizard header too, or route to home with the card highlighted.
- §6.3 "Test Mode's home grid" assumes the teacher will see a grid. Observed: a teacher who has
  never completed *student* onboarding never reaches the grid (`t19b`). The spec needs an
  explicit "test mode bypasses onboarding" line.

**Now vs later from the spec's own backlog:**
- Now: none of the spec's remaining items are needed for the demo; the shipped hub is the right
  shape. Spend the pre-demo budget on §6 items 1–15 instead.
- Later: red ring / rotation schema (§6.2), `GET /home-summary` "where you left off" (D6), and
  General Chat context (§5) are all correctly deferred; nothing observed changes that.
- Not in the spec but should be added to it: the schedule wizard compression (§5.1 above), since
  the spec treats the wizard as out of scope (§8) while it is now the longest part of the first
  visit.

---

## 8. What was deliberately left alone
- `admin.html` was not reviewed (not in either first-visit journey).
- Real Cognito sign-in was not exercised (localhost `redirect_mismatch`, already documented in
  `UX_FINDINGS.md`); all authenticated views used the localStorage shim.
- Emoji still present in the General Chat prompt cards were recorded, not removed — this PR
  changes only this document.
