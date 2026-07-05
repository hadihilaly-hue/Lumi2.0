# UX_FINDINGS.md — deferred (functional, not UX)

Scope of the branch `ux/secondary-pages-a11y`: design-critique + WCAG 2.1 AA
fixes on **index.html**, **teacher.html**, **admin.html** only. Fixes that were
purely visual/accessibility were applied directly (one commit per page). Items
below are **functional bugs** or things that **would require editing
`app.html` / `app.js`** (out of scope) — logged here instead of fixed.

Line numbers refer to the working tree on this branch after the UX commits.

---

## Functional bugs (not UX — logged, not fixed)

### F1 — admin.html: the "In Progress" state is unreachable (always 0)
- **File:** `admin.html` — `getStatus()` at ~line 479.
- **What:** `getStatus` returns only `'complete'` (when `row.done`) or
  `'not_started'`; it never returns `'in_progress'`. So the **"In Progress"
  stat card always shows 0**, and the `in_progress` dot/label styling
  (`.a-status-dot.in_progress`, `.a-status-label.in_progress`, yellow stat
  number) is dead — no data path ever produces that status.
- **Why it's not a UX fix:** this is a data/logic gap, not styling. Either the
  status model should compute a partial/in-progress state (a profile that
  exists but isn't `done`, or has some-but-not-all fields), or the "In Progress"
  UI should be removed. Needs a product decision on what "in progress" means.
- **Suggested direction:** if a profile row exists but `!row.done`, that's
  arguably "in progress" rather than "not started" — but that changes the
  stats semantics, so leaving to the owner.

---

## Out of scope — would require touching app.html / app.js

### S1 — teacher.html "Student mode" toggle navigates into app.html
- **File:** `teacher.html` ~line 651 (`#tTestModeToggle`) → `app.html?mode=test`;
  back-link banner ~line 670 → `app.html?mode=test`.
- **Styling note:** these classes (`.t-test-mode-*`, `.t-back-to-test-*`) ARE
  already styled — in the shared `style.css` (lines ~976–1035, warm accent,
  knob slides on hover). I made **no** changes to them (an earlier draft added
  redundant CSS to teacher.html on a wrong assumption; it was reverted).
- **Deferred / coordination note:** the actual test-mode *behavior* (reading
  `?mode=test`, flipping the sessionStorage flag at the student-app boot path)
  lives in `app.html` / `app.js`, which are **out of scope** and under active
  work/review elsewhere ("Test Mode" review). I did **not** touch that logic.

---

## Environment / testing notes (not bugs)

### E1 — OAuth redirect_mismatch when serving locally
- Serving these pages from `http://localhost` (e.g. `python3 -m http.server`)
  and clicking sign-in produces a Cognito `redirect_mismatch` error page,
  because `localhost:<port>` isn't a registered redirect URI. This is expected
  for local testing and is **not** a code defect. Consequence: the authenticated
  views of `teacher.html` (home/wizard) and `admin.html` (dashboard) can't be
  reached by real sign-in locally, so those views were verified by
  structural/code review + served-markup checks rather than a live logged-in
  session.

---

## Minor UX notes (applied where trivial; listed for awareness)

- **teacher.html class cards** — the card is now keyboard-operable (Enter/Space
  opens the wizard). The nested "Add welcome message" / "Add samples" sub-CTAs
  inside a card are not *independently* keyboard-focusable; keyboard activation
  opens the wizard at its default step. Acceptable fallback; a fuller fix would
  make each sub-CTA its own button.
</content>
</invoke>
