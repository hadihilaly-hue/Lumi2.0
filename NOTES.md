# app.js → ES module split — notes

Branch: `refactor/split-app-js` (off `main`).

Goal: split the ~276 KB single-file `app.js` frontend into ES modules under `js/`
with **no behavior change**. One module extracted per commit; the app stays
loadable (boots, chat UI renders, zero console errors) after every commit.

## Module layout

`app.js` stays the entry point (loaded by `app.html`); it holds the auth-guard
bootstrap IIFE, `init`/`wireListeners`/`startApp`, `wireHwListeners`, and the
debug `testProjectButton`. Everything else moves into `js/`:

| module | responsibility |
|---|---|
| `js/state.js` | `S`, `SB`, DOM element refs, and the cross-cutting mutable globals (`currentUser`, `pendingAttachment`, `_currentProjId`) + their setters |
| `js/data.js` | curriculum data, subjects, `searchCurriculum` |
| `js/api.js` | Claude proxy + `callAPI`/`parseResponse` |
| `js/prompts.js` | student context + system-prompt builders |
| `js/teachers.js` | teacher-profile Lambda/RDS fetching |
| `js/storage.js` | localStorage + Supabase conv/profile/schedule sync |
| `js/ui.js` | low-level UI helpers (toast, escHtml, drawer open/close, fmt) |
| `js/sidebar.js` | sidebar render, history menu, search dropdown |
| `js/conversation.js` | loadConv, openTutor, newChat, openGeneralChat |
| `js/emptystate.js` | welcome + suggested prompts + empty state |
| `js/schedule.js` | grade courses, schedule setup, semester banner |
| `js/onboarding.js` | conversational-AI onboarding |
| `js/voice.js` | voice / speech |
| `js/chat.js` | send/stream (`fetchLumi`), render message, attachments |
| `js/homework.js` | homework planner, calendar, timeline, study plan |
| `js/projects.js` | multi-day project plans |

## Deliberate mechanical changes (not behavior changes)

1. **Cross-module mutable state via setters.** `currentUser`, `pendingAttachment`,
   and `_currentProjId` are reassigned from modules other than the one that
   declares them. An imported binding is read-only in the importing module, so
   these three live in `js/state.js` and are written through
   `setCurrentUser` / `setPendingAttachment` / `setCurrentProjId`. Reads still use
   the bare name (live binding). Identical runtime behavior.

2. **`app.html` loader.** The bootstrap `<script>` now injects `app.js` with
   `type="module"` and **without** the `?t=Date.now()` cache-bust query. The query
   had to go: during the split, `js/*.js` modules import back from `../app.js`, and
   module identity is keyed by URL — a query string would fork `app.js` into two
   instances and run the auth-guard IIFE twice. (In the final state no module
   imports from `app.js`, so it is a clean entry point again.)

## Pre-existing bugs found (NOT fixed — logged per instructions)

- **`startProjectTutor` is undefined.** `window.testProjectButton` (a console-only
  debug helper at the bottom of `app.js`) calls `startProjectTutor(proj.id)`, but no
  such function is defined anywhere in `app.js`. Invoking `testProjectButton()` from
  the console throws `ReferenceError: startProjectTutor is not defined`. This is
  unchanged by the refactor (it was already broken); left as-is in `app.js`.

## Base

This split is generated from the current `main` `app.js`, so it **includes** the
AUDIT_FRONTEND "H1/H2" audit fixes (`hydrateTutorProfile` + class-switch guards in
`loadConv`/`finishOpenTutor`) that landed on `main` via PR #9. They are carried through
the split verbatim (into `js/conversation.js`); no special handling. The split is
regenerated deterministically, so re-basing onto a newer `main` is a re-run, not a
manual merge.

## Pre-existing unrelated edits (not part of this refactor)

- `app.html`: a one-line CSS tweak on the `#teacherModeLink` border (`rgba(...)` →
  `var(--accent-glow)`) exists as separate uncommitted work by another agent. It is out
  of scope and **not included** here — `app.html`'s only change on this branch is the
  ES-module loader.
- `teacher.html`: matching CSS-var tweaks — **left untouched** (out of scope).
