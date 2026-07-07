# Bedrock Prompt Caching — Implementation Plan

**Status:** Design / analysis only. No code changed by this document.
**Target model:** `global.anthropic.claude-sonnet-4-6` (forced in `lambda/index.mjs:20`, `SCHOOL_CONFIG.defaultModel`).
**Author scope:** Cache the large, static teacher-profile system prompt so it is billed once per class (not once per request), while student-specific and per-message content stays uncached. Explicitly forward-compatible with the Phase-5 / Workstream-D persistence note.

---

## 0. TL;DR

- The tutor system prompt is currently sent as a **plain string** (`js/api.js:44`, `system`), so **nothing in it is cached**. The only `cache_control` marker in the whole request is on the last work-sample **image** block (`js/chat.js:172`).
- The static teacher-profile text (engagement rules, teaching voice, course info, syllabus, work-sample rubric descriptions, the fixed STUDENT-MODE rules) is identical for every student in a class and every turn of a session — it is the main uncached cost driver.
- **Plan:** split the tutor system prompt into a **cacheable static segment** (segment 1) and a **dynamic segment** (segment 2), put **one `cache_control` breakpoint at the end of segment 1**, and keep all per-student / per-message content (student context, homework, teacher notes, the future progress note, project context) in segment 2 *after* the breakpoint. This requires (a) `buildTutorSystem` to return an **array of system blocks** instead of a string, (b) `callAPI` to pass it through, and (c) the Lambda's teacher-notes marker swap to operate over an array instead of a string.
- **Estimated saving:** ~70–90% of the *system-prompt* input tokens on every request after the first within a 5-minute window (both across turns of one session and across students of the same class), on profiles large enough to clear the model's minimum cacheable prefix.
- **Hard caveat (must verify):** Claude Sonnet 4.6's minimum cacheable prefix is **2048 tokens** (Anthropic docs). Thin profiles (terse teacher answers, no syllabus) may fall *below* that and **silently not cache** — no error, just `cache_creation_input_tokens: 0`. See §3 and §7.

---

## 1. Current request payload structure (traced)

### 1a. Client assembly

Chat requests are assembled in the split ES-module app (`app.html` loads `app.js` as `type=module`, which imports `js/*.js`). The path is:

```
doSend() / fetchLumi()            js/chat.js:83, :182
  → system = buildTutorSystem(...)          js/prompts.js:149   (STRING)
  → (+ ACTIVE PROJECT CONTEXT appended)     js/chat.js:194-211  (STRING concat)
  → msgs   = buildApiMessages(S)            js/chat.js:153      (ARRAY)
  → callAPI(msgs, system)                   js/api.js:39
      → fetchClaudeProxy({ model, max_tokens:2500, stream:true,
                           system, messages, inject_teacher_notes? })  js/api.js:40-49
          → POST to Lambda Function URL      js/api.js:17
```

`callAPI` sends (`js/api.js:40-49`):

| field | value | notes |
|---|---|---|
| `model` | `CONFIG.models.chat` = `claude-sonnet-4-20250514` | **ignored by Lambda** — model is forced to `defaultModel` (`lambda/index.mjs:345`) |
| `max_tokens` | `2500` | clamped to 2500 ceiling in Lambda |
| `stream` | `true` | |
| `system` | **string** | `buildTutorSystem(...)` output, possibly + project context |
| `messages` | array | `buildApiMessages(S)` |
| `inject_teacher_notes` | `{teacher_profile_id}` or absent | server-side notes injection target |

### 1b. `system` string contents (profile branch) — `js/prompts.js:164-241`

In render order, the tutor system prompt for a profiled class is:

1. Intro: *"You are Lumi, acting as a 24/7 digital version of {displayName} for their {course} class…"* (`:167`)
2. Formatting rules — never start with a code block, always complete the response, LaTeX rule (`:169-171`)
3. `studentCtx()` — **student name, grade, schedule, learning style, homework-start time, pain points, study style, bedtime** (`:173`, defined `js/prompts.js:30-60`)
4. `═══ HOW {FIRST} WANTS YOU TO HELP ═══` + `engagement_rules` (`:175-176`)
5. `═══ HOW {FIRST} TALKS AND TEACHES ═══` + `teaching_voice` (`:178-179`)
6. `═══ ABOUT THIS COURSE ═══` + `course_info` (`:181-182`)
7. `═══ COURSE SYLLABUS ═══` + `syllabus_text` — present only if set (`:185-187`)
8. `═══ HOW {FIRST} GIVES FEEDBACK ═══` + the three work-sample tier descriptions — present only if `hasAllTiers` (`:193-207`)
9. `═══ STUDENT MODE RULES ═══` — the fixed NEVER/ALWAYS block incl. the one-piece-feedback bullets (`:211-231`)
10. `hwContext()` + `activeHwForClass(course)` — **active homework tasks with due dates** (`:233`)
11. `Response length: SHORT …` line, immediately followed by the literal marker `<<LUMI_TEACHER_NOTES>>` (`:234`)
12. JSON footer — *"After EVERY reply, append this JSON…"* (`:236-239`)

`ACTIVE PROJECT CONTEXT` is appended to the returned string in `fetchLumi` when a project is open (`js/chat.js:200-209`).

### 1c. `messages` array — `js/chat.js:153-179`

`buildApiMessages(S)` returns:

- If work-sample images are fully loaded for all three tiers: a **synthetic exchange** prepended to `S.messages`:
  - `user`: an intro text block + per-tier text labels + the base64 **image** blocks; `cache_control:{type:'ephemeral'}` is set on the **last image block** (`js/chat.js:172`).
  - `assistant`: a fixed acknowledgement string.
  - then `...S.messages` (the real conversation).
- Otherwise: `S.messages` unchanged.

`S.messages` itself is never mutated with the synthetic exchange (kept out of the persisted conversation).

### 1d. Lambda forwarding — `lambda/index.mjs`

```
handler (default/chat route)
  → systemPrompt = body.system || ""           :2020   (STRING)
  → if systemPrompt.includes(TEACHER_NOTES_MARKER):     :2021
        replace marker with server-built notes section  :2032  (string .split().join())
  → generateResponse({ provider, systemPrompt, messages: body.messages, maxTokens }) :2049
      → callClaude({ systemPrompt, messages, maxTokens })  :343
          → InvokeModelWithResponseStreamCommand({
                modelId: SCHOOL_CONFIG.defaultModel,
                body: { anthropic_version:"bedrock-2023-05-31",
                        max_tokens, system: systemPrompt, messages } })  :344-353
  → stream chunks; reads chunk.message.usage.input_tokens at message_start  :2056
                    reads chunk.usage.output_tokens at message_delta        :2059
  → logUsage({... inputTokens, outputTokens})   :2068
```

Key facts:
- The Lambda relays the **Anthropic Messages API body** to Bedrock via `InvokeModelWithResponseStreamCommand` with `anthropic_version:"bedrock-2023-05-31"` — this is the native path that already carries `cache_control` (the image block proves it). It is **not** the Bedrock Converse API.
- `system` is passed to Bedrock **as a string** today. `messages` pass through untouched.
- The marker swap (`:2021`, `:2032`) is **string-only** — it will break if `system` becomes an array without a code change (see §5).
- Usage is read but **cache fields are not** (`:2056`, `:2059`). There is no visibility into whether caching is happening.

### 1e. Block classification

| Content | Where | Stability | Cache segment |
|---|---|---|---|
| Intro line (displayName, course, firstName) | prompts.js:167 | **static per class** | seg 1 (cached) |
| Formatting rules (code-block / completion / LaTeX) | prompts.js:169-171 | **static global** | seg 1 |
| `engagement_rules` | prompts.js:176 | **static per class** | seg 1 |
| `teaching_voice` | prompts.js:179 | **static per class** | seg 1 |
| `course_info` | prompts.js:182 | **static per class** | seg 1 |
| `syllabus_text` | prompts.js:186 | **static per class** (biggest single block) | seg 1 |
| Work-sample tier descriptions | prompts.js:199-206 | **static per class** | seg 1 |
| STUDENT MODE RULES (NEVER/ALWAYS, one-piece feedback, frustration) | prompts.js:211-231 | **static global** | seg 1 |
| `studentCtx()` (name, grade, schedule, pain points, study style) | prompts.js:173 | **dynamic per student** | seg 2 (uncached) |
| `hwContext()` + `activeHwForClass()` | prompts.js:233 | **dynamic per student/day** | seg 2 |
| `Response length` line | prompts.js:234 | static global (small) | seg 2 (kept adjacent to tail) |
| `<<LUMI_TEACHER_NOTES>>` → server notes | prompts.js:234 / lambda:2032 | **dynamic per student** | seg 2 |
| **(future)** progress note (Workstream D) | not yet built | **dynamic per student** | seg 2 |
| JSON footer | prompts.js:236-239 | static global (small) | seg 2 (kept at very end) |
| `ACTIVE PROJECT CONTEXT` | chat.js:200-209 | dynamic per session/project | seg 2 |
| Work-sample **images** (synthetic exchange) | chat.js:160-178 | **static per class** | already cached (image breakpoint) |
| Real conversation `S.messages` | chat.js:178 | dynamic per turn | uncached |

The classification is the whole design: everything in seg 1 is identical for every student in the class and every turn of a session; everything in seg 2 varies. Today they are interleaved in one string (student context sits near the *top*, at prompts.js:173), which is exactly why caching does nothing — the dynamic student data poisons the prefix.

---

## 2. Bedrock caching constraints — verified vs. UNVERIFIED

### 2a. Verified (from the Anthropic-bundled `claude-api` reference + this codebase)

- **Mechanism & syntax.** `cache_control:{type:'ephemeral'}` (5-min TTL) or `{type:'ephemeral', ttl:'1h'}` (1-hour TTL) placed on a content block. Valid on system text blocks, tool defs, and message content blocks.
- **Prefix match.** The cache key is the exact bytes of the rendered prompt up to each breakpoint. Render order is `tools → system → messages`. Any byte change before a breakpoint invalidates it. (No tools in this app, so `system` is the prefix root.)
- **Breakpoint budget.** Max **4** `cache_control` breakpoints per request. This plan uses **2** (system seg-1 + existing image), leaving 2 spare.
- **Minimum cacheable prefix — Claude Sonnet 4.6 = 2048 tokens.** Shorter prefixes silently do not cache (`cache_creation_input_tokens: 0`, no error). *(Opus tier is 4096; Sonnet 4.5 is 1024 — do not confuse; our forced model is Sonnet 4.6 → 2048.)*
- **Economics.** Cache **read** ≈ 0.1× base input price. Cache **write** = 1.25× for 5-min TTL, 2× for 1-hour TTL. Break-even: 5-min TTL pays off on the **2nd** request; 1-hour TTL needs the **3rd**.
- **Usage fields.** `usage.cache_creation_input_tokens` (written this request), `usage.cache_read_input_tokens` (served from cache), `usage.input_tokens` (uncached remainder). Total prompt = the sum of all three.
- **Bedrock supports prompt caching (5m + 1h)** — GA per the platform-availability matrix.
- **Automatic (top-level) `cache_control` is NOT supported on Bedrock.** We **must** use **explicit per-block `cache_control`** (which is what the existing image block already does). Do not attempt the top-level auto-placement shortcut — it is a no-op on Bedrock.
- **This exact stack already accepts `cache_control`.** `js/chat.js:172` sends `cache_control:{type:'ephemeral'}` to `global.anthropic.claude-sonnet-4-6` through the same `InvokeModelWithResponseStreamCommand` path, in production. So the request is accepted; the open question is only whether hits are *occurring* (nobody reads the cache usage fields today).

### 2b. UNVERIFIED — confirm in AWS Bedrock docs / a live test before relying on numbers

I could not independently reach live AWS Bedrock documentation from this environment, so treat the following as **to-confirm**, not as settled API facts:

1. **Prompt caching on the `global.` cross-region inference profile.** We use `global.anthropic.claude-sonnet-4-6` (a global inference profile), not a single-region model id. Confirm AWS supports prompt caching on this specific **global inference profile** for Sonnet 4.6, and whether cache entries are scoped per-region or globally. *(The image block suggests caching is at least accepted; confirm it is actually honored/hit on the global profile.)*
2. **Minimum-token parity.** Confirm Bedrock enforces the same 2048-token minimum for Sonnet 4.6 (it is a model property, so parity is expected, but AWS may document a different floor).
3. **Response cache-field names on Bedrock streaming.** Confirm the Bedrock `InvokeModelWithResponseStream` `message_start` chunk carries `message.usage.cache_creation_input_tokens` and `message.usage.cache_read_input_tokens` (first-party does; Bedrock mirrors the Anthropic schema, but verify the exact field names in a CloudWatch dump before wiring metrics).
4. **1-hour TTL availability** on Bedrock for this model/profile (the matrix says 5m+1h GA on Bedrock; confirm for the global profile). If in doubt, ship with the default 5-minute TTL.
5. **No beta header needed.** On Bedrock via `InvokeModel` with `anthropic_version:"bedrock-2023-05-31"`, prompt caching is GA and needs no beta header (unlike some first-party betas). Confirm no `anthropic-beta` field is required in the Bedrock body.
6. **`max_tokens:0` cache pre-warm** is a first-party feature; whether Bedrock `InvokeModel` accepts `max_tokens:0` is unverified. Assume **not available** and do not rely on pre-warming (see §4d).

Do **not** invent or change any Bedrock request parameters beyond adding `cache_control` blocks (already proven on this stack) and restructuring `system` into an array of text blocks (standard Anthropic Messages shape).

---

## 3. Breakpoint placement design

### 3a. Two system segments + existing image breakpoint

Restructure the **profile branch** of `buildTutorSystem` to return an **array of two system blocks**:

```
system = [
  { type: "text",
    text: SEG1,                       // static per class
    cache_control: { type: "ephemeral" } },   // ← breakpoint BP1
  { type: "text",
    text: SEG2 }                      // dynamic; NO cache_control
]
```

**SEG1 (cached, static per class)** — in this order:
1. Intro line
2. Formatting rules
3. `═══ HOW … WANTS YOU TO HELP ═══` + engagement_rules
4. `═══ HOW … TALKS AND TEACHES ═══` + teaching_voice
5. `═══ ABOUT THIS COURSE ═══` + course_info
6. `═══ COURSE SYLLABUS ═══` + syllabus_text (if present)
7. `═══ HOW … GIVES FEEDBACK ═══` + work-sample descriptions (if `hasAllTiers`)
8. `═══ STUDENT MODE RULES ═══` (the full fixed block)

**SEG2 (uncached, dynamic)** — in this order:
1. `studentCtx()`  ← **moves down** from its current near-top position
2. `hwContext()` + `activeHwForClass(course)`
3. `Response length: SHORT …` line
4. `<<LUMI_TEACHER_NOTES>>` marker (server-replaced)
5. `<<LUMI_PROGRESS_NOTE>>` marker (future — reserve the slot now, see §3c)
6. JSON footer
7. (`ACTIVE PROJECT CONTEXT` — appended by `chat.js` into SEG2, see §5)

Render order becomes: `SEG1 [BP1]` → `SEG2` → `messages` (synthetic image exchange `[BP2]` → real convo).

The **only behavioral reordering** is that `studentCtx()` moves from just-below-the-intro to just-below the STUDENT-MODE rules. The JSON footer stays at the very end; SEG1's content order is otherwise unchanged. (Low risk; validate with a persona smoke-test — see §5 step 7.)

### 3b. What caches, and for whom

- **BP1 (end of SEG1)** caches SEG1 only. SEG1 bytes are identical for every student in the class → **cross-student and cross-turn cache hits within the TTL window.** This is the main prize.
- **BP2 (last work-sample image, existing)** caches `SEG1 + SEG2 + synthetic-user-blocks-up-to-image`. Because SEG2 contains per-student data, BP2's prefix is **per-student** → the image batch caches **across turns of one student's session**, but **not across students**. (SEG1 still shares cross-student via BP1.) This is unchanged from today except that today nothing verifies it hits.

> Cross-student sharing depends on two students of the same class hitting the Lambda within the TTL window and on the Bedrock cache being account/region-scoped. It is best-effort, not guaranteed; the within-session win is the reliable one.

### 3c. Forward-compatibility with the persistence note (Workstream D / Phase 5)

`docs/PERSISTENCE_SPEC.md` describes a per-(student, class) rolling **progress note** (≤350 tokens) to be injected server-side at chat start, alongside teacher notes. It is **dynamic per student** and must therefore live in **SEG2, after BP1**. Reserve a `<<LUMI_PROGRESS_NOTE>>` marker slot in SEG2 now (immediately after the teacher-notes marker). Because it sits after the cache breakpoint, adding the progress note later:
- does **not** change SEG1's bytes → does **not** invalidate the teacher-profile cache;
- is billed as normal uncached input (≤~350 tokens) each turn;
- requires **no caching rework** — the Lambda simply gains a second marker-replace (mirroring the existing notes swap).

This is the explicit reason to land the SEG1/SEG2 split before D, not after.

---

## 4. Savings estimate (all numbers are estimates)

### 4a. Token sizing (rough, label as estimates)

| Block | Est. tokens |
|---|---|
| SEG1 fixed globals (intro + formatting + STUDENT MODE RULES + headers) | ~700–900 |
| engagement_rules / teaching_voice / course_info (teacher-written) | ~300–1200 combined |
| syllabus_text (if present) | 0, or ~2000–8000 |
| work-sample descriptions (if all tiers) | ~150–600 |
| **SEG1 total** | **~1200–2500 (no syllabus) → ~4000–11000 (with syllabus)** |
| SEG2 (studentCtx + hw + Response line + footer) | ~200–600 |
| teacher notes (when injected; capped 8000 chars) | 0–~2000 |
| work-sample images (≤9 blocks, Sonnet 4.6 ≤1568px) | ~1200–1600 **each** → up to ~10000–14000 |

### 4b. Per-request saving on a SEG1 cache hit

`saving ≈ 0.9 × SEG1_tokens × input_price`. Sonnet 4.6 input ≈ $3 / 1M tokens.

Worked example — SEG1 = 4000 tokens (profile with a modest syllabus), 5-min TTL, a 6-turn session inside 5 minutes:

| | Uncached (today) | Cached (SEG1) |
|---|---|---|
| Turn 1 | 4000 × $3/1e6 = **$0.01200** | write 1.25× = **$0.01500** |
| Turns 2–6 (×5) | 5 × $0.01200 = **$0.06000** | 5 × (0.1× ) = 5 × $0.00120 = **$0.00600** |
| **Session total (SEG1 only)** | **$0.07200** | **$0.02100** |

≈ **71% reduction** on the system-prompt portion of a 6-turn session. Longer sessions and cross-student hits push it toward the ~90% asymptote (every request after the first pays 0.1× instead of 1×). Cross-student: a second student's first turn within the window pays a 0.1× **read** instead of a 1× (or 1.25× write) — the write is amortized across the whole class.

The work-sample images (up to ~14k tokens) are already the single largest cacheable chunk; they cache across a student's session via BP2 today, but **this is unverified in production** — landing the usage-field logging (§5) will confirm it for the first time.

### 4c. Break-even

- 5-min TTL: net win from the **2nd** request onward. Given typical tutor sessions are multi-turn and class cohorts overlap in time, essentially always net-positive.
- 1-hour TTL: net win from the **3rd** request; useful only if we see bursty-but-gappy traffic. Start with the default 5-min TTL; revisit if logs show gaps.

### 4d. Pre-warming — optional, deprioritized

First-party supports a `max_tokens:0` prewarm to write the cache before the first real turn. On Bedrock this is **unverified** (§2b item 6) and likely unnecessary: continuous session traffic keeps SEG1 warm on its own. **Do not build pre-warming in this pass.**

---

## 5. Ordered implementation checklist (one session)

Do these in order. Keep the change additive and backward-compatible (a stale client that still sends a string `system` must keep working).

1. **`js/prompts.js` — split the profile branch of `buildTutorSystem`.**
   - Build `SEG1` and `SEG2` strings per §3a (move `studentCtx()` into SEG2; keep the `<<LUMI_TEACHER_NOTES>>` marker in SEG2; add a `<<LUMI_PROGRESS_NOTE>>` marker slot right after it).
   - Return `[{type:'text', text: SEG1, cache_control:{type:'ephemeral'}}, {type:'text', text: SEG2}]`.
   - **Leave the non-profile branches (companion, no-profile fallback) returning strings** — they are small and not worth caching. Return type of `buildTutorSystem` is now `string | Array`.

2. **`js/chat.js` — project-context append must target SEG2, not concatenate onto a string.**
   - Where `fetchLumi` appends `ACTIVE PROJECT CONTEXT` (`:200-209`): if `system` is an array, append the project text to the **last block's `.text`** (SEG2); if it's a string (companion/fallback), keep the current concat. Small helper, e.g. `appendToSystem(system, text)`.

3. **`js/api.js` — pass `system` through unchanged.**
   - `callAPI` already forwards `system` verbatim (`:44`). Confirm it does not stringify or mutate it. Array or string both flow to the Lambda as JSON.

4. **`lambda/index.mjs` — make the notes marker swap array-aware.**
   - Today: `systemPrompt = body.system || ""` then `systemPrompt.includes(...)` / `.split().join()` (`:2020-2033`).
   - New: accept `body.system` as **string or array of `{type:'text', text}` blocks**.
     - If **array**: for each block, run the existing marker replacement on `block.text` (the marker only ever appears in SEG2). Always strip a stray marker even when no injection is requested (preserve current behavior). Then pass the **array** straight through to `callClaude`.
     - If **string** (stale client): keep the exact current code path.
   - Also handle the future `<<LUMI_PROGRESS_NOTE>>` marker the same way when Workstream D lands (out of scope now, but the loop should be written so a second marker is a one-line addition).
   - `callClaude` (`:343-353`) already puts `system` into the Bedrock body verbatim — an array is valid Anthropic Messages shape, so no change there beyond passing whatever `generateResponse` received.

5. **`lambda/index.mjs` — surface cache usage for verification.**
   - At `message_start` (`:2056`) also read `chunk.message?.usage?.cache_creation_input_tokens` and `cache_read_input_tokens` (confirm exact field names against a live dump — §2b item 3).
   - Add a log line, e.g. `console.log(`[cache] write=${cw} read=${cr} in=${inputTokens}`)` (counts only — no PII, consistent with the existing `[notes]` logging discipline).
   - (Optional, follow-up) extend `logUsage` / the `api_usage` table with `cache_read_input_tokens` / `cache_creation_input_tokens` columns for durable analytics. Not required for the first deploy.

6. **Leave the image breakpoint (`js/chat.js:172`) exactly as-is.** It is a second, independent breakpoint (BP2) and already correct.

7. **Verify behavior, then caching.**
   - **Behavioral:** re-run the persona smoke-test harness (`synthetic_data/smoke_test.py`) or eyeball 2–3 personas to confirm moving `studentCtx()` below the rules did not shift voice/behavior. The static teacher content and the JSON footer position are unchanged.
   - **Caching (the proof):** with the new `[cache]` log, open a class, send **two** messages within 5 minutes, and check CloudWatch:
     - Turn 1: `cache_creation_input_tokens ≈ SEG1 tokens`, `cache_read_input_tokens = 0`.
     - Turn 2: `cache_read_input_tokens ≈ SEG1 tokens` (a hit), `cache_creation_input_tokens = 0`.
   - **Cross-student:** open the same class as a second student within the window; expect a `cache_read` hit on that student's **first** turn for SEG1.
   - **Regression guard:** if `cache_read_input_tokens` stays 0 across identical-prefix turns, a silent invalidator is present — diff the two SEG1 byte strings (most likely a per-request value leaked into SEG1, or the profile is under the 2048-token floor).

### Post-deploy verification cheat-sheet

| Signal | Where | Healthy value |
|---|---|---|
| `cache_creation_input_tokens` | Bedrock `message_start` usage → `[cache]` log | > 0 on the first request of a window; 0 thereafter |
| `cache_read_input_tokens` | same | ≈ SEG1 (and, within a session, ≈ SEG1+SEG2+images) on 2nd+ requests |
| `input_tokens` | same | drops to just SEG2 + new turn on cached requests |
| profile size | count_tokens on SEG1 | **≥ 2048** or caching no-ops (see §7) |

There is **no** built-in Bedrock CloudWatch *metric* for cache hits — the streamed `usage` object is the source of truth, which is why step 5 (logging it) is the verification mechanism.

---

## 6. Files to touch (summary)

| File | Change | Risk |
|---|---|---|
| `js/prompts.js` | `buildTutorSystem` profile branch → return 2-block array; move `studentCtx()` to SEG2; add progress-note marker slot | Medium (prompt reorder) |
| `js/chat.js` | project-context append targets SEG2 block | Low |
| `js/api.js` | confirm `system` passes through as array | Trivial |
| `lambda/index.mjs` | array-aware marker swap (`:2020-2033`); pass array to Bedrock; log cache usage (`:2056`) | Medium (must keep string path for stale clients) |

No schema changes required for the first deploy. Optional `api_usage` cache columns are a follow-up.

---

## 7. Risks & caveats

1. **Sub-minimum profiles silently don't cache.** SEG1 must exceed **2048 tokens** (Sonnet 4.6 floor) or the breakpoint is a no-op. Thin profiles (terse `engagement_rules`/`teaching_voice`/`course_info`, no syllabus, no work samples) can land ~1200–1600 tokens. This is not an error and not harmful — it just yields no saving for those classes. Rich profiles and any class with a syllabus clear the bar easily. **Verify with count_tokens on real profiles** before claiming savings.
2. **Global inference profile caching is UNVERIFIED (§2b item 1).** The single biggest thing to confirm in AWS docs / live logs: that prompt caching is honored on `global.anthropic.claude-sonnet-4-6`. The existing image `cache_control` proves acceptance, not hits — step 5's logging closes this.
3. **Prompt reordering.** Moving `studentCtx()` below the rules is a real (if minor) prompt change. Validate with the persona smoke test (§5 step 7).
4. **Backward compatibility.** A cached browser still POSTing a string `system` must keep working — the Lambda must handle both string and array. Do not remove the string path.
5. **Silent invalidators.** Nothing per-request may leak into SEG1: no timestamps, no student id, no `Date.now()`. `studentCtx()`, homework, notes, project context, and the progress note **must all** remain in SEG2. Any future edit that interpolates dynamic data into SEG1 will silently kill the cache for that class.
6. **Cross-student sharing is best-effort**, gated on TTL-window overlap and Bedrock cache scope. The reliable, always-on win is within a single session across turns.
7. **1-hour TTL** doubles the write cost; only adopt it if logs show traffic gaps between 5 and 60 minutes. Default to 5-minute TTL.
8. **Do not guess Bedrock parameters.** The only additions are `cache_control` blocks (proven on this stack) and an array-shaped `system` (standard Messages format). Everything in §2b must be confirmed against AWS docs or a live CloudWatch dump before the numbers in §4 are treated as real.
