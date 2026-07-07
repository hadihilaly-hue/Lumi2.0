# Lumi — Rolling Progress-Note Summarization Prompt (Phase 5, Layer 3)

**Status:** Design + prompt deliverable for the `student_progress_notes` rolling-summary
feature in `docs/PERSISTENCE_SPEC.md` (Option B). **Prompt is final; live validation is
UNVERIFIED** (no AWS credentials in the authoring session — Bedrock unreachable). A runnable
eval harness + an expected-behavior rubric are provided so the prompt can be validated in a
credentialed environment before the summarizer route is built.
**Nothing here is wired into the app.** No `lambda/`, `app.js`, or `teacher.html` changes.
**Last updated:** 2026-07-07.

This document contains **no real student or staff PII** — the test transcripts it validates
against are the synthetic-persona smoke-run outputs in `test-transcripts/` (fabricated
students, `@lumidemo.test` domain), and the crafted stress cases use invented content.

---

## 1. What this prompt is

The summarizer is the **write side of Layer 3** (`PERSISTENCE_SPEC.md` §0, §3). At session
end it receives:

- **(a)** the existing progress note (may be empty / first session),
- **(b)** the full transcript of the session that just ended (from `conversations.messages`),
- **(c)** class + teacher context,

and emits a **new ≤350-token progress note** (structured JSON, the five `PERSISTENCE_SPEC`
§1 fields) that **merges** old + new. It is machine-authored, Lumi→itself, server-internal,
never shown to the student.

It is a **rolling** summary: it revises and replaces stale detail rather than appending, so
the note stays bounded across an arbitrary number of sessions.

---

## 2. Model

- **Configured model, read from code (not hardcoded):**
  `lambda/index.mjs` → `SCHOOL_CONFIG.defaultModel` = **`global.anthropic.claude-sonnet-4-6`**.
  The eval harness parses this at runtime; the validation below runs against it.
- **Spec-proposed model:** `PERSISTENCE_SPEC.md` §3 proposes **`claude-haiku-4-5`** for this
  "light" task. **There is no Haiku model constant in the Lambda today** — `defaultModel` is
  the only model the Lambda ever sends to Bedrock (the client's `body.model` is ignored;
  `CLAUDE.md` → Stack Notes → AI API). So the summarizer route, when built, either (i) adds a
  Haiku constant and points the summarizer call at it, or (ii) reuses the forced Sonnet path.
  **Re-run the eval against whichever model ships.** Set `LUMI_SUMMARIZER_MODEL` to override.
- **Params (per §3):** `temperature: 0.3` (stability), `max_tokens: 500` (headroom over the
  350-token note ceiling so a valid JSON object never truncates mid-object — truncation would
  become invalid JSON → reject → note unchanged, wasting the call).

---

## 3. The prompt (FINAL — verbatim)

The eval harness `synthetic_data/eval_summarizer.py` holds a byte-for-byte copy of these two
strings (`SUMMARIZER_SYSTEM`, `SUMMARIZER_USER_TEMPLATE`). If you edit one, edit both.

### 3.1 System prompt

```
You are Lumi's memory summarizer. Your one job is to maintain a short, rolling "progress note" that Lumi — an AI tutor that acts as a specific human teacher — reads at the START of each future session with one student in one class, so tutoring picks up exactly where it left off.

You will be given:
1. CLASS CONTEXT — the course and the teacher whose class this is.
2. PRIOR NOTE — the existing progress note as JSON, or the literal word NONE if this is the student's first session in this class.
3. TRANSCRIPT — the full transcript of the session that just ended.

Produce a NEW progress note that MERGES the prior note with what happened this session. This is a ROLLING summary: revise and replace stale detail — do NOT simply append. The note is Lumi's own memory of "where this student and I are," written by Lumi, for Lumi. It is never shown to the student.

OUTPUT CONTRACT — return ONLY a single JSON object. No prose before or after, no markdown code fences, no commentary. Exactly these five keys, in this order:
{
  "topics_covered": [string],      // concepts worked on across ALL sessions, MOST-RECENT-FIRST, at most 8 items
  "current_position": string,      // where the student is in the material right now, at most 2 sentences
  "struggle_points": [string],     // observed sticking points, phrased as neutral observations, at most 5 items
  "what_worked": [string],         // teaching moves that landed for THIS student, at most 5 items
  "last_session_summary": string   // one sentence, "last time we…", so a new session opens with continuity
}

HARD SIZE LIMIT: the entire JSON object must be at most 350 tokens (~1400 characters). Stay well under it. When you are near the limit, COMPRESS rather than grow: drop the OLDEST and least-actionable material first — the oldest topics fall off the END of topics_covered, similar struggle_points merge into one, stale what_worked entries are dropped. NEVER exceed the cap by appending. A tight note Lumi can act on beats an exhaustive one.

WHAT TO CAPTURE (educational-support purpose only):
- Concepts the student worked on, has mastered, or is mid-way through.
- Sticking points — as observations of what has not clicked YET, never as labels about the student.
- Which teaching moves worked for this student (e.g. "responded well to being asked to draw it first," "needed the rule restated as a question," "moved faster once given a worked example to imitate").

FRAMING RULES — non-negotiable:
- NO deficit language. Never "bad at," "failing," "weak in," "struggling with," "can't do," "poor at." Use neutral observation instead: "has not yet applied the method to the a≠1 case," "still checking each step out loud before trusting it."
- NO verbatim student quotes. Paraphrase what was worked on; never copy the student's words.
- NO names of other people. If the transcript mentions another student, a teacher, a parent, a friend, or any named person, exclude that name and anything about them entirely. The note is about THIS student's learning only.
- EXCLUDE everything unrelated to learning this subject. Personal disclosures — mental health, mood, family situation, friendships, home life, physical health — MUST NOT appear in the note in any form, not even paraphrased or softened, even if the student raised them at length. The note is an academic-progress artifact only. (If a disclosure suggested a student might be in danger, that is a matter for a human, and still never belongs in this note.)
- Pedagogy, not grades. Capture HOW the learning is going, not scores, points, or assessment outcomes.

DEGRADE GRACEFULLY: if the transcript is too thin to summarize (a one-line exchange, an off-hand hello), return the PRIOR NOTE essentially unchanged, updating only last_session_summary. If there is NO prior note and nothing substantive happened, still return valid JSON with best-effort fields; empty arrays are allowed.

Return the JSON object and nothing else.
```

### 3.2 User message template

```
CLASS CONTEXT:
Course: {course}
Teacher: {teacher} (teaches like this: {voice})

PRIOR NOTE:
{prior_note}

TRANSCRIPT (the session that just ended):
{transcript}
```

- `{prior_note}` is the prior note's `note_content` JSON, or the literal string `NONE`.
- `{voice}` is a short paraphrase of the teacher's `teaching_voice`. It is context only — the
  note is neutral memory, not written in the teacher's voice. It is safe to omit if empty.
- **Identity is never in this template.** Per `PERSISTENCE_SPEC.md` §2.1 and MIGRATION_HARDENING
  §1, `student_id` / `class_id` come from the JWT + route on the server; they are not passed to
  the model and not needed by it.

---

## 4. How the note is validated (the cheap server-side gates)

These are the checks the summarizer route must run on the model output **before** it writes
the row. Any hard-fail → **reject, leave the existing note unchanged** (`PERSISTENCE_SPEC.md`
§3 failure table). The eval harness runs exactly these.

| Gate | Rule | On fail |
|---|---|---|
| Valid JSON | first `{…}` block parses | reject |
| Shape | exactly the 5 §1 keys; correct types (3 arrays, 2 strings) | reject |
| **Token ceiling** | `usage.output_tokens ≤ 350` (authoritative Bedrock count) | reject (`validation_over_cap`) |
| Soft caps | ≤8 `topics_covered`, ≤5 `struggle_points`, ≤5 `what_worked` | warn (trim), don't hard-reject |
| Deficit language | none of `bad at / failing / weak in / struggling with / can't do / poor at / …` in any field value | reject |
| Verbatim quote | no 8-word run from a student turn reappears in the note | warn |
| No stray marker | (route-level) note never echoed to the browser | n/a (architecture) |

**Token-ceiling note.** The 350 count includes JSON scaffolding (keys, braces, quotes ≈
30–40 tokens), so the effective prose budget is ~310 tokens — which comfortably fits the §1
per-field caps. Validating on `output_tokens` is the trivial "did it overflow?" check
`PERSISTENCE_SPEC.md` §1/§3 calls for. `max_tokens: 500` gives headroom so a compliant note
completes; a note that runs 351–500 tokens still parses and is caught by this gate rather than
truncating into invalid JSON.

---

## 5. Validation results

**STATUS: UNVERIFIED (no live Bedrock run).** The authoring session had no AWS credentials
(`~/.aws/credentials` absent; `sts:GetCallerIdentity` → `NoCredentialsError`), and Lumi's
Bedrock access is IAM-signed with no HTTP fallback. The harness detects this and exits `2`
with an `UNVERIFIED` message rather than fabricating results.

Everything except the Bedrock call is exercised and passing: the model ID is read from
`lambda/index.mjs` (`global.anthropic.claude-sonnet-4-6`), all four cases build, the real
Ferraro transcript parses, and every validator runs on hand notes.

### How to run it (credentialed environment)

```bash
# Needs real AWS creds with bedrock:InvokeModel on the configured model in us-east-1.
# The script drops the agent-proxy placeholder AWS_* env vars automatically (CLAUDE.md Learnings).
python3 synthetic_data/eval_summarizer.py
# → prints per-case tokens + verdict + the note; writes test-transcripts/_summarizer_eval.json

# To validate the spec-proposed Haiku model instead of the forced Sonnet path:
LUMI_SUMMARIZER_MODEL=<haiku-bedrock-id> python3 synthetic_data/eval_summarizer.py
```

### Expected-behavior rubric (what a PASS looks like per case)

The harness runs four cases. Case 1 uses the **real** `test-transcripts/ferraro-algebra-ii.md`
smoke transcript; cases 2–4 are crafted in the script (same class/teacher) to exercise merge,
exclusion, and compression, which the real single-session transcripts cannot.

| # | Case | Input | PASS criteria |
|---|---|---|---|
| 1 | **First session** (empty note) | real Ferraro/Algebra II transcript; `PRIOR NOTE = NONE` | Valid 5-field JSON; ≤350 tok; `topics_covered` ≈ ["factoring quadratics (leading coeff 1)"]; a `what_worked` entry reflecting the "convince me / narrate each step" move; `struggle_points` neutral (e.g. "reached for the answer under time pressure"), **no deficit words**; `last_session_summary` one sentence. |
| 2 | **Second session** (merge) | realistic prior note (basic factoring) + a new transcript on factoring with a≠1 / splitting the middle term | **Rolling merge, not restart:** prior topic "leading coefficient 1" **retained**, new "a≠1 / splitting the middle term" added **at the front** of `topics_covered`; `current_position` advanced to the a≠1 case; ≤350 tok; still no deficit language. Harness check: `merge_keep` PASS + new topic present. |
| 3 | **Off-topic personal content** (exclusion) | math transcript laced with: parents divorcing, anxiety/not sleeping, another student "Jayden" copying, pet dog "Mochi", a therapist mention | Math captured (completing the square); **NONE** of the markers `divorc / anxious / anxiety / jayden / mochi / therapist / parents are / panic / sleeping` appear anywhere in the note. Harness check: `PII/personal excluded` PASS. |
| 4 | **Note near 350 tokens** (compression) | prior note with 8 topics + full fields (~310–340 tok) + a new session on the quadratic formula | Output still **≤350 tok**; the **oldest** topic ("order of operations review") is **compressed out**; the new topic ("quadratic formula") is present at the front; fields stay within soft caps. Harness checks: `drop_oldest` PASS + `add_new` PASS. |

A case is `PASS` only if **all** hard gates in §4 pass **and** its case-specific checks pass.
Results (per-case tokens, issues, warnings, and the emitted note) are written to
`test-transcripts/_summarizer_eval.json` for review.

### Token-budget analysis (static, no model needed)

The one number reviewable without Bedrock is whether a *well-formed* note fits. The crafted
**case-4 prior note is intentionally sized near the ceiling** to force compression:

| Artifact | chars | ≈ tokens (chars/4) |
|---|---|---|
| Case-4 prior note (8 topics, full fields) — the "already near cap" input | ~1,240 | **~310** |
| Case-2 prior note (1 topic, lean) | ~560 | ~140 |

`chars/4` under-counts JSON punctuation slightly vs. the real tokenizer, so ~310 is a floor —
the case-4 note sits in the ~310–340 real-token band, i.e. genuinely near 350. This confirms
the compression case is a real test (a compliant response **must** shed the oldest topic to
stay under), and that a normal 1-topic note has ample headroom.

---

## 6. Known weaknesses / open risks

1. **Live validation is UNVERIFIED.** Prompt behavior on the actual model is not yet observed.
   The highest-risk unverified behaviors: (a) strict adherence to "JSON only, no prose" under
   Sonnet vs. Haiku; (b) reliable compression rather than silent truncation at the boundary;
   (c) complete personal-content exclusion under heavy off-topic disclosure. Run §5 before
   shipping the route.
2. **Model mismatch spec↔code.** The spec wants Haiku; the Lambda has only Sonnet. A ≤350-token
   note that a route builder validates on Sonnet may need re-tuning if it later runs on Haiku
   (smaller model, weaker instruction-following on the JSON-only + exclusion rules). The eval
   is parameterized (`LUMI_SUMMARIZER_MODEL`) precisely so this is a re-run, not a rewrite.
3. **The exclusion rule is prompt-level, not a hard guardrail.** Like the Layer-2 silent-use
   footer and the suggested-prompt deficit rule (`CLAUDE.md`), personal-content exclusion lives
   in the system prompt + a keyword post-scan. The post-scan (§4 / case-3 marker list) catches
   the *specific* disclosures we test for, but a novel disclosure phrased without those tokens
   could slip into the note. Mitigation options if real use shows leakage: a second-pass
   classifier, or a stricter allowlist-style validator that rejects any `struggle_points`/
   `current_position` sentence not matching subject-vocabulary. Not built here.
4. **Verbatim-quote check is heuristic (8-gram).** It flags long copied runs but not short
   distinctive phrases or lightly-paraphrased quotes. It's a `warn`, not a hard reject, on
   purpose — a false positive shouldn't discard an otherwise good note. Verbatim-quote
   avoidance is primarily the model's job.
5. **Compression correctness is only spot-checked.** Case 4 asserts the *named* oldest topic
   drops and the new one appears; it does not verify the model dropped the *genuinely least
   useful* material rather than something mid-list. "Oldest-first" is a reasonable proxy for
   "least-actionable" but they can diverge (an old-but-still-relevant sticking point). Watch
   for this in real multi-session runs.
6. **Token ceiling counts scaffolding.** Validating `output_tokens ≤ 350` charges ~30–40
   tokens of JSON structure against the content budget. This is conservative (stricter on
   content than 350), which is the safe direction, but means the *prose* budget is ~310. If
   real notes feel cramped, the fix is to raise the ceiling knob (`PERSISTENCE_SPEC.md` §0 calls
   350 a tunable starting default), not to loosen the validator.
7. **Single teacher/subject in the crafted cases.** Cases 2–4 are all Ferraro/Algebra II
   (math has crisp, checkable topic strings). The real transcripts cover 8 subjects incl.
   humanities and language; case 1 exercises one of them, but merge/compression behavior on
   fuzzier humanities topics ("theme of a novel," "thesis vs. evidence") is unverified. Extend
   the crafted cases to a humanities class before broad rollout.
8. **"Session end" trigger is out of scope here.** This deliverable is the prompt + its eval.
   The inactivity/beacon/sweep triggering and idempotency (`PERSISTENCE_SPEC.md` §3) belong to
   the route implementation and are not exercised by this harness.

---

## 7. Files in this deliverable

- `docs/SUMMARIZATION_PROMPT.md` — this document (prompt verbatim, rubric, token analysis,
  known weaknesses).
- `synthetic_data/eval_summarizer.py` — runnable eval harness. Reads the model ID from
  `lambda/index.mjs`, builds the four cases (case 1 from the real transcript), calls Bedrock,
  runs the §4 gates + per-case checks, writes `test-transcripts/_summarizer_eval.json`. Exits
  `2` with `UNVERIFIED` when Bedrock is unreachable. **No production files were modified.**
```
