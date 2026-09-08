# Onboarding proposal — 3-step form vs. today's AI interview

**Status:** proposal only — no code changes. Awaiting a product decision.
**Author:** Devin (W7 workstream) · **Date:** 2026-09-08
**Sources:** `app.html` consent gate (lines ~695-705), `js/onboarding.js`,
`js/schedule.js` (`initScheduleSetup`), `privacy.html` consent bar.

---

## 1. What a new student does today

Measured against the code, first-run is three sequential gates:

```
 index.html ──▶ app.html ──▶ privacy.html?consent=1 ──▶ app.html
 (Google        (consent     (scroll to bottom,         (conversational
  sign-in)       check)       "I understand & agree")     onboarding)
                                                            │
                                     ┌──────────────────────▼───────┐
                                     │ 5-question AI chat           │
                                     │ (js/onboarding.js, Bedrock)  │
                                     └──────────────┬───────────────┘
                                                    ▼
                                     schedule wizard (initScheduleSetup)
                                     grade → classes → teachers
                                     → blocks A–G → study style → confirm
                                                    │
                                                    ▼
                                              home grid
```

Note: the consent gate actually runs **first** (an inline script in `app.html`
redirects to `privacy.html?consent=1` before `app.js` boots) — the flow is
consent → AI chat → wizard, not chat → consent → wizard.

### Interaction count (measured)

| Gate | Clicks/taps | Typing | Bedrock calls |
|---|---|---|---|
| Consent | 1 (+ a full-page scroll to enable the button) | — | 0 |
| AI chat | 6 sends minimum (ready → Q1–Q5 answers; Enter or send button). More if the AI probes a vague answer. | 6 free-text answers (~2–3 min) | **7 minimum** — 1 seed + 1 per reply |
| Schedule wizard (6-class Menlo schedule) | grade 1 · classes 6 picks + 1 Continue · teachers 0–6 (auto-skips when a class has ≤1 teacher) · blocks 6 (one per class) · study style 1 optional + 1 Continue · confirm 1 | — | 0 |
| **Total** | **~21–27 clicks**, all mandatory, ~4–6 min end-to-end | 6 answers | **≥7** |

## 2. Proposal: 3-step form + one warm AI greeting

Replace the AI interview with a short static form; keep consent and the
schedule wizard. After the wizard confirms, land on home with a single
personalized Lumi greeting generated from the form answers.

```
┌─ Step 1/3 · About you ─────────────┐
│  Name          [ Maya            ] │
│  Grade         ( 9 )(10)(11)(12)   │
│  When do you usually start HW?     │
│                [ 6:00 pm ▾      ]  │
│  How do you like to study?         │
│  ⦿ Short bursts (25/5)             │
│  ○ Long focus sessions (50/10)     │
│  ○ Mixed                           │
│                      [ Continue → ]│
└────────────────────────────────────┘   4 clicks + 1 name

┌─ Step 2/3 · Your classes ──────────┐
│  (existing schedule wizard,        │
│   unchanged: classes → teachers    │
│   → blocks → confirm)              │
└────────────────────────────────────┘   ~16–22 clicks, as today

┌─ Step 3/3 · How Lumi helps ────────┐
│  When you're stuck, what helps?    │
│  ( ) Step-by-step walkthrough      │
│  ( ) Guiding questions             │
│  ( ) Show me an example first      │
│  Anything else Lumi should know?   │
│  [ optional free text, 1 line   ]  │
│           [ Start using Lumi → ]   │
└────────────────────────────────────┘   1 click (+ optional typing)

Then: home grid mounts and the first assistant turn is one warm greeting,
e.g. "Hey Maya — I've got your Tuesday covered. Bio lab due Thu; want to
start there or just say hi?"  →  **1 Bedrock call.**
```

### Interaction count (proposed)

| Gate | Clicks/taps | Typing | Bedrock calls |
|---|---|---|---|
| Consent | 1 (+ scroll) — unchanged | — | 0 |
| Step 1 form | ~4 | 1 (name, pre-fillable from Google) | 0 |
| Step 2 wizard | ~16–22 — unchanged | — | 0 |
| Step 3 form | 1 (+ optional text) | 0–1 | 0 |
| Warm greeting | 0 (rendered, not asked) | 0 | **1** |
| **Total** | **~22–28 clicks** — nearly identical count, but **~0 typing** and ~1–2 min | 1–2 | **1** |

The win is not clicks — it's **typing, latency, and Bedrock cost**: ~6 fewer
model round-trips (7 → 1) and ~2 minutes shorter wall time.

## 3. Profile fields — what each flow captures

| `OB.profile` field | Today (AI chat) | Proposed form |
|---|---|---|
| `name` | Q1 (or Google pre-fill) | Step 1 input, Google pre-fill |
| `study_style.{work,break,label}` | Q2 free text → model parses to 25/5, 50/10, custom | Step 1 radio → exact same shape |
| `learning_style` | Q4 free text → `step_by_step`/`socratic`/`example_first`/`mixed` | Step 3 radio → same enum |
| `homework_start_time` | Q3 free text → `HH:MM` | Step 1 time select |
| `typical_activities` | Q3 free text | Step 3 optional line |
| `pain_points` | Q5 free text → array | Step 3 optional line → single-entry array (or split on `;`) |
| `calendar_connected` | `###SHOW_CAL_BUTTON` marker if student asks | "Connect later" link in settings — unchanged default `false` |
| `onboarding_complete` | set in wrap-up message | set on Step 3 submit |

Net: every persisted field survives; only the *richness* of `typical_activities`
and `pain_points` shrinks from conversational prose to short text.

## 4. Bedrock calls saved

- **Per new student:** ≥7 → 1 (**–86%**). At Menlo scale (~800 students) that is
  ~5,000 calls per intake season, plus eliminated retry/probe calls.
- **Latency:** each chat reply is a full round-trip (~1–3 s); the form removes
  6 of them — onboarding drops from ~4–6 min to ~1–2 min.
- **Failure surface:** today a Lambda/Bedrock hiccup mid-interview strands the
  student (only recourse is refresh); the form can't fail on inference — only
  the final `POST /profiles` can, and it already has a toast.

## 5. Risks and open questions

1. **The chat is the demo.** The AI interview doubles as the product pitch —
   "Lumi talks like a warm tutor" is shown before it's told. A form-first flow
   delays the first magical moment until the greeting. Mitigation: make the
   single greeting demonstrably personal (use name + first due item).
2. **Personalization quality.** `pain_points` / `typical_activities` become
   thinner. If teachers rely on them in the system prompt, tutor tone may
   regress. Mitigation: keep them optional-but-encouraged, or add a second
   Bedrock call later that *expands* the short answers into the same prose
   shape (still 2 calls ≪ 7).
3. **Compliance posture unchanged.** Consent stays a separate gate; nothing in
   this proposal reduces the scroll-to-agree requirement — flag if legal
   wants it re-reviewed anyway.
4. **Calendar connect** loses its conversational prompt; it becomes a
   settings affordance only. Likely fine (it was conditional today).
5. **Edge cases the AI absorbed for free:** students who ramble, answer
   multiple questions at once, or ask Lumi questions back. The form loses
   that flexibility but gains predictability — no `###PROFILE_UPDATE` parse
   failures either.
6. **Data drift:** `obApplyProfile` also writes `lumi_name`,
   `lumi_learning_style`, `lumi_hw_start`, `lumi_activities`,
   `lumi_pain_points`, `lumi_study_style`, `lumi_onboarding_complete` to
   localStorage — a form implementation must write the same keys so the rest
   of the app is untouched.

## 6. Recommendation

Worth piloting: identical required-effort, ~86% fewer Bedrock calls, half the
time-to-first-screen, and the form is strictly less fragile than a 7-call
chat protocol. The main judgment call is whether losing the conversational
"first impression" hurts adoption — the single warm greeting is the proposed
counterweight.
