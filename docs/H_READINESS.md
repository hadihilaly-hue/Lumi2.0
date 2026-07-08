# Feature H (Bedrock Prompt Caching) — Readiness Re-trace

**Status:** Read-only reconnaissance. No code changed by this document.
**Base:** `main` @ `9bfc138` (branch `claude/bedrock-caching-readiness-fkfux3`).
**Supersedes the stale references in** `docs/PROMPT_CACHING_PLAN.md` (written before merges **B**, **J**, **D**).
**Bottom line:** The plan's core design (SEG1/SEG2 split, one system breakpoint) **survives intact**. Merges J and D have already planted both new markers *in the right places* — one small correction to the plan is required (the work-artifacts marker now lives in SEG1, not SEG2, so the Lambda marker swap must run over **all** blocks, not just the tail). Model ID and SDK/API shape are now **repo-confirmed**; the global-inference-profile "does caching actually hit" question remains the one true UNVERIFIED blocker.

---

## 1. Current prompt assembly, re-traced end-to-end (on `main`)

### 1a. Call path (updated line anchors)

```
doSend()                                  js/chat.js:83
  → fetchLumi()                           js/chat.js:187
      → system = buildTutorSystem(...)    js/prompts.js:149     (STRING today)
        (or buildCompanionSystem()        js/prompts.js:98      — General Chat / no tutorCtx)
      → (+ ACTIVE PROJECT CONTEXT)        js/chat.js:199-216    (STRING concat onto system)
      → msgs = buildApiMessages(S)        js/chat.js:153        (ARRAY; image BP2 at :177)
      → callAPI(msgs, system)             js/chat.js:217 → js/api.js:39
          → fetchClaudeProxy({ model, max_tokens:2500, stream:true,
                               system, messages,
                               inject_teacher_notes?,           js/api.js:48
                               inject_work_artifacts?,          js/api.js:51   ← J (new)
                               inject_progress_note? })         js/api.js:55   ← D (new)
              → POST Lambda Function URL   js/api.js:17
                  → systemPrompt = body.system || ""            lambda/index.mjs:2695  (STRING)
                  → 3× marker swap (string .includes/.split/.join):
                       <<LUMI_TEACHER_NOTES>>                   lambda:2696-2707
                       <<LUMI_WORK_ARTIFACTS>>                  lambda:2715-2725       ← J (new)
                       <<LUMI_PROGRESS_NOTE>>                   lambda:2734-2746       ← D (new)
                  → generateResponse → callClaude               lambda:2763 → :372
                      → InvokeModelWithResponseStreamCommand({
                          modelId: SCHOOL_CONFIG.defaultModel,   lambda:377 (= :20)
                          body:{ anthropic_version:"bedrock-2023-05-31",
                                 max_tokens, system: systemPrompt, messages } })  lambda:381-384
                  → message_start → reads usage.input_tokens ONLY  lambda:2769-2770
                  → logUsage(inputTokens, outputTokens)          lambda:2782
```

Everything the plan described still holds structurally. What changed: **two new inject fields** in `callAPI` (J, D) and **two new marker swaps** in the Lambda (J, D). `system` is still a plain **string** on the wire; nothing in it is cached. The only `cache_control` in the whole request is still the last work-sample **image** block (`js/chat.js:177`, "BP2").

### 1b. Updated block inventory (system prompt, profile branch, in render order)

Current source order in `buildTutorSystem` (`js/prompts.js:166-258`):

| # | Segment | Source | Delivered content | Stability | Target seg |
|---|---|---|---|---|---|
| 1 | Intro line (displayName, course) | prompts.js:169 | teacher text | **static / class** | SEG1 |
| 2 | Formatting rules (code-block / completion / LaTeX) | :171-173 | fixed | **static / global** | SEG1 |
| 3 | **`studentCtx()`** | :175 | name, grade, schedule, style, pain points, bedtime | **dynamic / student** | **SEG2 (must move down)** |
| 4 | `═══ HOW … WANTS YOU TO HELP ═══` + engagement_rules | :177-178 | teacher text | **static / class** | SEG1 |
| 5 | `═══ HOW … TALKS AND TEACHES ═══` + teaching_voice | :180-181 | teacher text | **static / class** | SEG1 |
| 6 | `═══ ABOUT THIS COURSE ═══` + course_info | :183-184 | teacher text | **static / class** | SEG1 |
| 7 | `═══ COURSE SYLLABUS ═══` + syllabus_text (if set) | :187-189 | teacher text (biggest block) | **static / class** | SEG1 |
| 8 | `═══ HOW … GIVES FEEDBACK ═══` + 3 tier descriptions (if `hasAllTiers`) | :195-208 | teacher text | **static / class** | SEG1 |
| 9 | **`<<LUMI_WORK_ARTIFACTS>>`** → server section | :225 / lambda:2725 | **teacher-stable** feedback examples | **static / class** ✅ | **SEG1** ← J |
| 10 | `═══ STUDENT MODE RULES ═══` (NEVER/ALWAYS, one-piece, frustration) | :227-249 | fixed | **static / global** | SEG1 |
| 11 | `hwContext()` + `activeHwForClass(course)` | :251 | active homework + due dates | **dynamic / student·day** | SEG2 |
| 12 | `Response length: SHORT …` line | :252 | fixed (small) | static / global | SEG2 (tail) |
| 13 | **`<<LUMI_TEACHER_NOTES>>`** → server notes | :252 / lambda:2707 | per-student notes | **dynamic / student** | SEG2 |
| 14 | **`<<LUMI_PROGRESS_NOTE>>`** → server note | :252 / lambda:2746 | per-student rolling summary (flag-gated) | **dynamic / student** | **SEG2** ← D |
| 15 | JSON footer ("append this JSON…") | :254-257 | fixed (small) | static / global | SEG2 (tail) |
| — | `ACTIVE PROJECT CONTEXT` | chat.js:199-216 | project title/task/due | **dynamic / session** | SEG2 (appended) |
| — | Work-sample **images** (synthetic exchange, BP2) | chat.js:165-183 | teacher-stable images | already cached (image BP) | messages |
| — | Real `S.messages` | chat.js:183 | conversation | dynamic / turn | messages (uncached) |

**Key observation:** the static-per-class + static-global blocks (#1, 2, 4–10) are already **contiguous** in source order **except for `studentCtx()` (#3) wedged in at the top**. The dynamic tail (#11–15 + project context) is already grouped after STUDENT MODE RULES. So the SEG1/SEG2 split needs exactly **one reorder** — move `studentCtx()` down — which is precisely what the plan predicted, and *less* churn than the plan implied (the J and D markers already sit on the correct side of the intended breakpoint).

**Marker placement vs. the intended BP1 (end of #10):**
- `<<LUMI_WORK_ARTIFACTS>>` (#9) is **inside SEG1**, and its server-injected content is **teacher-stable** — confirmed: `js/conversation.js:117,247` set `first_name` to the **teacher's** first name (`ctx.teacher.split()[0]`), and `buildArtifactSection` (lambda:611-655) prints no timestamps and orders deterministically by `(tier, sort_order)`. So delivered SEG1 bytes are identical across every student of the class → **cache-valid**. ✅
- `<<LUMI_TEACHER_NOTES>>` (#13) and `<<LUMI_PROGRESS_NOTE>>` (#14) are **inside SEG2**, after BP1 — correct. D already "reserved the slot" the plan asked for.

---

## 2. Plan deltas — `PROMPT_CACHING_PLAN.md` section by section

| Plan section | Verdict | Delta |
|---|---|---|
| §0 TL;DR | **Survives** | Design unchanged. Add: two server markers (J, D) now co-exist with notes; the array-aware Lambda swap must cover all three. |
| §1a call path (line refs) | **Update refs** | `js/api.js:44`→ system still forwarded verbatim but callAPI now also sends `inject_work_artifacts` (:51) + `inject_progress_note` (:55). Image BP `chat.js:172`→**:177**. `buildTutorSystem` still :149. |
| §1b string contents | **Update** | Insert item #9 `<<LUMI_WORK_ARTIFACTS>>` (before STUDENT MODE RULES) and item #14 `<<LUMI_PROGRESS_NOTE>>` (adjacent to notes marker). See §1b table above. |
| §1c messages | **Survives verbatim** | `buildApiMessages` unchanged; image `cache_control` now at `chat.js:177`. |
| §1d Lambda forwarding (line refs) | **Update refs** | `systemPrompt = body.system` now **:2695** (was :2020). Marker swap now **three** blocks at :2696-2746 (was one at :2021-2033). `callClaude` at **:372-387**. `message_start` usage at **:2769-2770**. Still string-only; still reads input/output tokens only, **no cache fields**. |
| §1e classification | **Survives + extend** | Add work-artifacts (static/class → SEG1) and progress-note (dynamic/student → SEG2) rows. `studentCtx()` still the sole poison at the top. |
| §2a verified facts | **Survives; 2 upgraded** | Model ID and native-Messages/`cache_control`-accepted are now **repo-confirmed** (see §3). Economics/mechanism unchanged. |
| §2b UNVERIFIED | **Mostly survives** | Items 1–4, 6 still unverifiable from repo (need AWS docs / live dump). Item 5 (no beta header) has stronger repo evidence now. See §3. |
| §3a two-segment design | **Survives** | Still one breakpoint (BP1). **Correction:** plan §5-step-4 says "the marker only ever appears in SEG2" — **now false** (WORK_ARTIFACTS is in SEG1). The Lambda loop must run every marker replacement over **every** block. |
| §3b what caches / for whom | **Survives** | BP1 caches SEG1 (incl. teacher-stable artifact section) cross-student; BP2 (image) caches per-student session. Unchanged. |
| §3c persistence forward-compat | **Already realized** | The `<<LUMI_PROGRESS_NOTE>>` slot D shipped is exactly where the plan reserved it (SEG2, after notes). No SEG1 invalidation. ✅ |
| §4 savings estimate | **Survives** | Numbers are estimates as before. SEG1 is now slightly larger when a teacher has text artifacts (adds the server-injected feedback section into the cached prefix — *helps* clear the 2048 floor). |
| §5 checklist | **Survives w/ 1 edit** | Step 4 must swap all three markers array-aware (not "only SEG2"). See §5 below for the revised, single-session checklist. |
| §6 files to touch | **Survives** | Same 4 files. See §6 + overlap analysis. |
| §7 risks | **Survives** | All still apply. Add: any future edit that moves a *dynamic* value into SEG1 (or makes the artifact section per-student) silently kills the class cache. |

**Is the SEG1/SEG2 split still achievable with one breakpoint, everything dynamic after it?** **Yes.** After moving `studentCtx()` into SEG2, SEG1 = items #1,2,4–10 (all static/class or static/global, contiguous) and SEG2 = studentCtx + hwContext + Response-length + notes + progress-note + JSON footer + project context (all dynamic or trivially-small static tail). The single BP1 sits at the end of STUDENT MODE RULES (#10). No dynamic content remains before BP1.

---

## 3. UNVERIFIED list — re-verified against the repo

**Now confirmable FROM THE REPO (promote out of UNVERIFIED):**

1. **Forced model ID** — `SCHOOL_CONFIG.defaultModel = "global.anthropic.claude-sonnet-4-6"` (`lambda/index.mjs:20`, used at :377). ✅ Confirmed. The client's `body.model` (`claude-sonnet-4-20250514`, `js/config.js:18`) is ignored.
2. **SDK / API shape** — `InvokeModelWithResponseStreamCommand` (`lambda/index.mjs:3`, :373) with `anthropic_version:"bedrock-2023-05-31"` and a native Anthropic Messages body (`system` + `messages`, :381-384). ✅ Confirmed the native (non-Converse) path. `cache_control` is already accepted on this exact path in production (`js/chat.js:177` image block). So an array-shaped `system` with a `cache_control` text block is a valid, already-exercised request shape.

**Still UNVERIFIED (cannot be settled from the repo — carry forward with the exact check):**

| # | Question | Why repo can't answer | Exact check to run |
|---|---|---|---|
| 1 | Does Bedrock **honor** (produce cache hits for) prompt caching on the **`global.` cross-region inference profile** for Sonnet 4.6? Acceptance ≠ hits. | Runtime/billing behavior; not in code. **This is the one gating unknown.** | After landing the §5 `[cache]` log: open a class, send 2 messages <5 min apart, read CloudWatch — turn-2 must show `cache_read_input_tokens ≈ SEG1`. If it stays 0 with an identical prefix, the global profile isn't honoring caches (or SEG1 < floor). |
| 2 | Bedrock's **minimum cacheable prefix** for Sonnet 4.6 (plan assumes 2048). | Model/platform property, not in code. | AWS Bedrock prompt-caching docs for Sonnet 4.6; or empirically — a profile whose SEG1 < ~2048 tokens will show `cache_creation_input_tokens: 0`. |
| 3 | Exact **cache usage field names** on the Bedrock streaming `message_start` chunk. | Code reads `input_tokens`/`output_tokens` only (`lambda:2770,2773`) — cache fields are never touched today, so the wire shape is unobserved. | Add a temporary raw-chunk `console.log` at `message_start`; dump CloudWatch; confirm `message.usage.cache_creation_input_tokens` / `cache_read_input_tokens`. |
| 4 | **1-hour TTL** availability on Bedrock for this global profile. | Platform capability, not in code. | AWS docs; or send `{type:'ephemeral', ttl:'1h'}` and check for error. Default to 5-min TTL regardless. |
| 5 | **No `anthropic-beta` header** needed. | Not in code — but the prod image `cache_control` works with **no** beta field in the body (`lambda:381-386`), which is strong evidence none is needed for *acceptance*. Honoring is tied to #1. | Confirm in AWS docs; the live test in #1 also settles it. **Downgraded from unknown → likely-fine.** |
| 6 | `max_tokens:0` cache **pre-warm** on Bedrock. | Not in code. | Assume unavailable; do **not** build pre-warming this pass (plan §4d). |

---

## 4. General Chat (STUDENT_HOME_REDESIGN §5, decided D7-A "CHEAP") — caching accommodation?

**None needed — General Chat is and should stay a cache-exempt path.** D7-A ships the *cheap* variant: `buildCompanionSystem()` (`js/prompts.js:98`, a **string**) plus a one-line class-list append and, when Layer-3 is enabled, per-class `last_session_summary` bundles via a new `<<LUMI_PROGRESS_NOTES_ALL>>` marker — total ~900 system-prompt tokens (redesign §5.1). That is **below** the Sonnet 4.6 2048-token cacheable floor, so a breakpoint would be a guaranteed no-op; the redesign explicitly calls the caching interaction "trivial… sent uncached." H already leaves the companion/fallback branches as strings by design (plan §5 step 1), so General Chat and H don't interact: H caches the per-class tutor prefix (one class per prefix), General Chat wears no teacher persona and concatenates nothing cacheable. The only thing to preserve is the invariant that the *tutor* path (`buildTutorSystem` profile branch) stays the single place the cached prefix is assembled — if the deferred FULL/D7-B variant is ever revived (concat all class profiles), revisit, because that produces a per-student prefix with different economics (redesign §5.1(b)). Not a v1 concern.

---

## 5. Revised implementation checklist (one build session)

Additive and backward-compatible — a stale client still POSTing a **string** `system` must keep working.

1. **`js/prompts.js` — split the profile branch of `buildTutorSystem` (only).**
   - Build `SEG1` = items #1,2,4–10 (intro, formatting, engagement, teaching_voice, course_info, syllabus?, work-sample descriptions?, `<<LUMI_WORK_ARTIFACTS>>`, STUDENT MODE RULES). **Keep the `<<LUMI_WORK_ARTIFACTS>>` marker inside SEG1** (its injected content is teacher-stable — confirmed §1b).
   - Build `SEG2` = `studentCtx()` (**moved down from :175**) + `hwContext()`+`activeHwForClass()` + Response-length line + `<<LUMI_TEACHER_NOTES>>` + `<<LUMI_PROGRESS_NOTE>>` + JSON footer.
   - Return `[{type:'text', text:SEG1, cache_control:{type:'ephemeral'}}, {type:'text', text:SEG2}]`.
   - Leave `buildCompanionSystem` and the no-profile fallback returning **strings**. Return type becomes `string | Array`.
2. **`js/chat.js` — project-context append must target the array's last block.**
   - `fetchLumi` at :199-216 appends `ACTIVE PROJECT CONTEXT` with `system += …`. Add a tiny `appendToSystem(system, text)` helper: array → append to `system[system.length-1].text` (SEG2); string → keep the current concat.
   - Leave `buildApiMessages` image breakpoint (`:177`) exactly as-is (BP2).
3. **`js/api.js` — confirm pass-through (likely zero change).** `callAPI` forwards `system` verbatim (:44); JSON-encodes array or string identically. Just verify no stringify/mutation.
4. **`lambda/index.mjs` — make the 3 marker swaps array-aware.**
   - `body.system` may now be a **string or an array of `{type:'text', text}`**. Normalize once: if array, run **each** of the three existing marker replacements over **every** block's `.text` (a given marker appears in exactly one block, so running all three on all blocks is safe and simplest — and required because WORK_ARTIFACTS is in SEG1, not the tail). Always strip stray markers (current behavior).
   - Pass the **array** straight to `generateResponse`/`callClaude` — `system: systemPrompt` (:383) accepts an array unchanged (valid Messages shape).
   - Keep the exact current **string** path for stale clients.
5. **`lambda/index.mjs` — log cache usage (the verification hook).** At `message_start` (:2769-2770) also read `chunk.message?.usage?.cache_creation_input_tokens` / `cache_read_input_tokens` (confirm names via §3 #3) and `console.log('[cache] write=… read=… in=…')` — counts only, matching the `[notes]`/`[artifacts]` discipline. (Optional follow-up: `api_usage` columns — not required for first deploy.)
6. **Verify.**
   - *Behavioral:* smoke 2–3 personas (`synthetic_data/smoke_test.py`) — confirm moving `studentCtx()` below STUDENT MODE RULES didn't shift voice.
   - *Caching:* two messages <5 min → turn 1 `cache_creation ≈ SEG1`, turn 2 `cache_read ≈ SEG1`. Cross-student: second student's first turn shows a SEG1 `cache_read`. If turn-2 read stays 0 → diff SEG1 bytes (leaked dynamic value) or SEG1 < 2048 floor (§3 #1,#2).

**Out of scope this pass:** pre-warming (§3 #6); `api_usage` cache columns; touching companion/General-Chat; any change to J/D injection logic (only the *shape* of the container changes).

---

## 6. Files H will touch — overlap check vs. the redesign

| File | H change | Risk | Redesign (STUDENT_HOME_REDESIGN §Sessions) says |
|---|---|---|---|
| `js/prompts.js` | Split `buildTutorSystem` profile branch → 2-block array; move `studentCtx()` to SEG2 | Medium (prompt reorder) | Marked **"U" unchanged** *except* `buildCompanionSystem` gets a one-line class-list add in **Session 5**. **Different function** — but same file → merge-conflict possible. |
| `js/chat.js` | `appendToSystem` helper in `fetchLumi` (project-context append) | Low | Marked **"U" unchanged** (streaming/doSend/renderMsg/buildApiMessages). Redesign moves *mounting* to `js/classview.js`; the `fetchLumi` project-context block is not listed as edited. Same file → low-but-nonzero conflict. |
| `js/api.js` | Verify-only (no expected change) | Trivial | Not in the redesign's change set. No overlap. |
| `lambda/index.mjs` | Array-aware 3-marker swap (:2695-2746); pass array to Bedrock; `[cache]` log (:2769-2770) | Medium (keep string path) | Redesign Session 5 adds a **new** `<<LUMI_PROGRESS_NOTES_ALL>>` marker + swap route for General Chat — **additive, different marker**, but touches the same marker-swap region. Sequence H before/after cleanly. |

**Scheduling guidance for Hadi:**
- **No hard blocker.** H and the redesign edit overlapping *files* (`js/prompts.js`, `js/chat.js`, `lambda/index.mjs`) but **disjoint regions** (H = tutor `buildTutorSystem` + `fetchLumi` project append + tutor marker swaps; redesign = `buildCompanionSystem` + `classview.js` mount + a new General-Chat marker).
- **Fragile assumption to hold (flagged in the task):** the redesign commits to *not changing the prompt-assembly contract* (its own table: markers survive, `chat.js`/`prompts.js` = "U"). H **depends on** that: specifically (a) `buildTutorSystem` stays the single assembly point for the tutor system prompt, (b) `callAPI` keeps forwarding `system` verbatim, and (c) the project-context append stays in `fetchLumi` (not relocated into `classview.js`). If a redesign session moves the tutor prompt build or the `system` forwarding into new module(s), H must re-base onto the new call site.
- **Recommended order:** land H **before** the redesign's Session 5 (General Chat context), or coordinate so Session 5's `<<LUMI_PROGRESS_NOTES_ALL>>` swap is written array-aware from the start (reusing H's normalized per-block marker loop). If the redesign lands first, H's Lambda step 4 must also cover the new marker.

---

## 7. Unresolved items (carry into the build)

1. **UNVERIFIED #1 (global-profile cache hits)** — the one true gate. Provable only post-deploy via the §5 `[cache]` log. Everything else is mechanical.
2. **2048-token floor per class** — thin profiles (terse answers, no syllabus, no artifacts) may leave SEG1 under the floor → silent no-cache (not an error). Now *slightly* mitigated: a teacher with text artifacts adds the injected feedback section into SEG1. Confirm with a token count on real profiles before quoting savings.
3. **Cache field names on Bedrock stream** (§3 #3) — dump once before wiring metrics.
4. **Cross-student sharing** remains best-effort (TTL-window + account/region cache scope); the reliable win is within-session across turns.
5. **Redesign region collisions** (§6) — not blocking, but rebase-sensitive if the redesign relocates tutor prompt assembly.
