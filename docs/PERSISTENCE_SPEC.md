# Lumi — Persistence Spec: Cross-Session Student Memory (FERPA)

**Status:** Design document. DRAFT — not reviewed by counsel. **Build nothing from this yet.**
This is the Phase 5 design deliverable referenced in `docs/COMPLIANCE.md` §5 Known Gaps:
*"Phase 4 delivers the [deletion] pattern for teacher-owned data; Phase 5 designs it for
student data."* No code, no migrations, and no schema have been applied to RDS.
**Last updated:** 2026-07-04.

This document contains **no real student or staff PII** — data elements are described by
category and column, never by listing actual names, emails, or records. It inherits the
data-inventory, flow-map, subprocessor, and Bedrock citations from `docs/COMPLIANCE.md`;
where this spec adds a new stored surface, it slots into that same inventory.

---

## 0. Context strategy — DECIDED

Lumi needs to remember a student *across* chat sessions so tutoring picks up where it left
off, without re-loading an ever-growing transcript into every prompt. Three options were on
the table; the decision is made.

| Option | What it is | Status |
|---|---|---|
| **A — Full history in context** | Re-load the entire prior transcript into every new session's context. | Rejected — unbounded token growth, cost, and latency; FERPA-hostile (max data resident in every prompt). |
| **B — Rolling summary** | One short auto-generated progress note per student per class; only the note loads at chat start. | **✅ MVP. This spec builds it.** |
| **C — Relevance retrieval** | Full transcript storage + embeddings + per-message semantic retrieval. | Documented upgrade path only (§9). Not MVP. |

**MVP = Option B, rolling summary.** One auto-generated *progress note* per
(student, class). It is:
- **Short** — target ≤ **350 tokens** (~1,400 chars). Justification below.
- **Updated at session end** — Lumi generates/revises the note from that session's
  transcript via a Bedrock call (§3).
- **The only thing loaded at chat start** from this feature — alongside the two existing
  personalization layers. This becomes the **third layer** of the personalization stack.

### The three-layer personalization stack

`docs/COMPLIANCE.md` and `CLAUDE.md` describe a two-layer stack today. This spec adds the
third:

1. **Layer 1 — Teacher profile** (`teacher_profiles`): teaching voice, pedagogy, course
   info, excellence criteria. One row *is* a class (unique on `teacher_email` +
   `class_name`). Built into the system prompt at session start.
2. **Layer 2 — Per-student teacher notes** (`class_enrollments.teacher_notes`): the
   teacher's running observations about *this* student. Injected **server-side inside the
   Lambda** (marker `<<LUMI_TEACHER_NOTES>>`), never reaches the browser. Teacher-authored.
3. **Layer 3 — Student progress note** (`student_progress_notes`, **NEW**): Lumi's *own*
   rolling memory of what it and the student have covered together. Machine-authored,
   revised each session. Loaded at chat start alongside layers 1–2.

Layer 2 is teacher→student ("here's what to watch for"). Layer 3 is Lumi→itself ("here's
where we are"). They are complementary and both server-side.

### Why ≤ 350 tokens

- **Prompt-budget discipline.** Layer 2 already carries an 8,000-char cap (`CLAUDE.md`,
  teacher-notes injection). Layer 1 is large. Layer 3 must stay small so the three layers
  plus the actual conversation fit comfortably under the model context without crowding out
  the student's live turns. 350 tokens is roughly a tight paragraph per field (§1 fields) —
  enough to be useful, small enough that it never dominates.
- **Summarization stability.** A hard output ceiling keeps the Bedrock call cheap, fast,
  and bounded, and makes the "did the model overflow?" validation trivial (§3 failure
  handling). Rolling summaries drift toward bloat if uncapped; the cap forces the model to
  *replace* stale detail rather than append.
- **Cost.** One short synthesis per session per student per class, at Haiku pricing, is
  negligible; an uncapped growing summary is not.

The 350-token figure is a **starting default** — tunable after real teacher/student
testing. Flag it, don't treat it as load-bearing.

### DECISION PENDING — HADI: discard vs. retain transcripts

**DEFAULT (my proposal, your call): raw transcripts are DISCARDED after the note update.**
The dedicated transcript-for-summarization surface exists only transiently — during the
session and immediately after, long enough to feed the Bedrock summarizer. Once the note is
written, **the only persisted surface this feature adds is one progress note per
(student, class). Nothing else.**

**Tradeoff — stated explicitly:** discarding **forecloses the Option C retrieval upgrade
path** (§9). Semantic retrieval needs the raw message history to embed; if we never keep it,
Option C can only be built by *re-accumulating* history from scratch after the retain
decision flips — everything before the flip is unrecoverable. In exchange, the discard
default gives the **smallest possible FERPA surface**: one short note per student-class is
the entire student-memory footprint, which makes deletion, export, and "what do you store
about my child?" answers trivial.

⚠ **This interacts with an existing store — see §2.1.** `conversations.messages` *already*
persists full student chat content indefinitely today (`COMPLIANCE.md` §1 note ¹, §5). The
discard default is about **not adding a *new* transcript/embeddings store**; whether the
*existing* `conversations.messages` is also pruned/retained is the separate retention
decision in §7 and must be resolved together with this one.

**Mark: DECISION PENDING — HADI.** The rest of this spec is written to the discard default
and notes at each point what changes if you flip to retain.

---

## 1. Progress-note contents (exact fields)

The note is stored as structured JSON (see `note_content` in §2) so each field can be
independently rendered, validated, capped, and — later — selectively exported. Rendered
into the system prompt as a compact labeled block at chat start.

| Field | Type | Meaning | Cap (soft) |
|---|---|---|---|
| `topics_covered` | string[] | Topics/concepts worked on across sessions, most-recent-first. | ≤ 8 items |
| `current_position` | string | Where the student currently is in the material ("mid-way through factoring quadratics; can factor with leading coeff 1, not yet with a≠1"). | ≤ 2 sentences |
| `struggle_points` | string[] | Observed sticking points — *phrased as observations, never deficit labels* (see below). | ≤ 5 items |
| `what_worked` | string[] | Pedagogical approaches that landed for *this* student ("responded well to being asked to draw it first"; "needed the rule restated as a question"). | ≤ 5 items |
| `last_session_summary` | string | One-line "last time we…" so a new session can open with continuity. | ≤ 1 sentence |

Plus system-managed metadata (columns, not model output): `updated_at`, `source_session_count`
(how many sessions have rolled into this note), `model_version` (which summarizer produced
the current note).

**Framing rules (baked into the summarizer system prompt AND post-validated), reusing the
Layer-2 / suggested-prompts precedent in `CLAUDE.md`:**
- **No deficit language.** Never "the student is bad at / failing / weak in." Use neutral
  observation ("has not yet applied the framework to a≠1 case"). Same rule already enforced
  on suggested-prompt chips.
- **No third-party PII.** The note is about this student only; never names other students,
  teachers-by-name beyond the class context, or family.
- **Pedagogy, not grades.** The note captures *how learning is going*, not scores. It is an
  educational-support artifact (SOPIPA educational-purpose), not an assessment record.

---

## 2. Schema (design only — NOT applied)

### 2.1 `student_progress_notes` (NEW)

One row per (student, class). "Class" = `teacher_profiles.id` — per `CLAUDE.md`, each
`teacher_profiles` row *is* a class; there is no separate `classes` table.

```
student_progress_notes
  id                    uuid        PK  default gen_random_uuid()
  student_id            uuid        NOT NULL   -- app_users.lumi_id (the internal id)
  class_id              uuid        NOT NULL   -- FK → teacher_profiles.id
  note_content          jsonb       NOT NULL   -- the §1 structured fields
  source_session_count  integer     NOT NULL default 0
  model_version         text                   -- e.g. 'claude-haiku-4-5'
  created_at            timestamptz NOT NULL default now()
  updated_at            timestamptz NOT NULL default now()
  deleted_at            timestamptz            -- SOFT DELETE from day one (§5)

  UNIQUE (student_id, class_id) WHERE deleted_at IS NULL
```

Design notes:
- **`deleted_at` from day one** — this is the whole point of Phase 5; unlike every existing
  table (`COMPLIANCE.md` §1 note ¹), this surface ships with soft-delete built in.
- **Partial unique constraint** so a soft-deleted note doesn't block writing a fresh one if
  a student re-enrolls. All reads filter `deleted_at IS NULL`.
- **`note_content` as jsonb**, mirroring `conversations.messages` and
  `teacher_profiles.common_mistakes`. Structured fields (§1), not free text, so export and
  validation are per-field.
- **No RLS** — RDS dropped RLS at the migration; access is enforced in the Lambda per-route
  authz (below), consistent with every other route in `CLAUDE.md` → "RDS Lambda data routes".

**Access (server-side authz, mirroring the Layer-2 notes model):**
- **Student (owner):** the note is *about* the student but is **never returned to the
  browser** — same posture as `teacher_notes`. It exists to be injected into the system
  prompt server-side, not displayed. (Open question §8: do we ever show students their own
  note? Default: no.)
- **Read path is server-internal only:** the chat Lambda reads the row for the
  JWT-identified student + current class at session start and folds it into the system
  prompt. Student identity is **always from the JWT, never the request body** (`CLAUDE.md`,
  MIGRATION_HARDENING §1).
- **Write path is server-internal only:** the summarizer (§3) writes it. There is **no
  client route** that returns or accepts note content — like `api_usage`, it is
  structurally unreachable from the browser by design.
- **Teacher/admin visibility:** DECISION PENDING (§8). Default MVP: not exposed to teachers
  in the UI; admin can reach it only via the IAM-gated direct-invoke `adminSql` branch.

### 2.2 Transient transcript handling

**Under the discard default (proposed):**
- **During a session**, the working transcript already lives in **`conversations.messages`
  (jsonb)** — this store exists today and is written as the student chats. The summarizer
  reads *this* at session end. **No new transcript table is introduced.**
- **"Discard" means: no *additional* transcript or embeddings store is created for
  summarization.** The progress note is the only *new* persisted surface.
- The still-open question is what happens to `conversations.messages` itself long-term. Two
  sub-options, tied to §7 retention:
  - **(b1) Leave `conversations.messages` as-is** (persists per current behaviour, governed
    by the Phase 5 student-data retention/deletion pipeline in §5/§7). Simplest; the
    student keeps their visible chat history. *The note is a summary layered on top, not a
    replacement.* **← recommended MVP.**
  - **(b2) Strict discard:** reduce `conversations.messages` to the note after
    summarization (delete/truncate old threads once rolled up). Smallest footprint, but
    students lose scroll-back history and it is a bigger product change. Not MVP.
- **Nothing is written to a dedicated `session_messages` table, and no embeddings exist.**

**If the decision flips to RETAIN (Option C prep), the schema becomes:**
- Add a durable message-level store (either promote `conversations.messages` to the system
  of record for retrieval, or add `session_messages(id, student_id, class_id,
  conversation_id, role, content, created_at, deleted_at)` — one row per message, soft-delete
  from day one).
- Add `message_embeddings(message_id FK, embedding vector(N), model, created_at)` with the
  **pgvector** extension on RDS. See §9 for the full delta.
- The progress note (§2.1) stays exactly as-is — it is additive either way, and remains the
  cheap default context layer even when retrieval exists.

---

## 3. Summary generation flow

### Trigger — what "session end" means for a stateless web app

There is no server-held session; the browser holds a thread. So "session end" must be
*inferred*. **Default (flagged — DECISION PENDING, tune after testing):**

> **Session end = 30 minutes of inactivity** on a (student, class) thread, OR an explicit
> end signal, whichever comes first.

Detected via three complementary triggers (belt-and-suspenders, because none alone is
reliable in a browser):
1. **Explicit signals (best-effort):** clicking "New chat", signing out, or tab close
   (`navigator.sendBeacon` to a `POST /progress-note/flush` on the Lambda). Best-effort —
   beacons are not guaranteed.
2. **Lazy-at-next-open (guaranteed):** when a student opens a (student, class) thread, the
   Lambda checks whether the *previous* session for that pair ended > 30 min ago without a
   note update; if so, it summarizes the prior transcript *first*, then loads the fresh note.
   This guarantees eventual summarization even if every explicit signal is missed.
3. **Scheduled sweep (backstop):** an EventBridge-scheduled Lambda invocation (e.g. every
   15 min) finds threads with `last_message_at > 30 min` and no note update since, and
   summarizes them. Ensures notes update even for students who never return.

Trigger 2 is the correctness guarantee; 1 keeps the note fresh for active users; 3 catches
the long tail. **All three are idempotent** — a `source_session_count` / last-summarized
watermark prevents double-summarizing the same session.

### The Bedrock call

- **Model:** `claude-haiku-4-5` — consistent with `CLAUDE.md`'s "lightweight classification
  tasks" tier (title generation, suggested-prompt chips). A ≤350-token pedagogical summary
  is a light task; Haiku is cheap, fast, and already on the `ALLOWED_MODELS` whitelist.
  Swappable to Sonnet if quality testing demands it — flagged, not load-bearing.
- **Path:** browser/EventBridge → Lambda → **AWS Bedrock**. Same posture as all inference
  (`COMPLIANCE.md` §2/§4): no direct browser→Bedrock, content stays in-Region, Bedrock does
  not train on it.
- **Inputs:** (a) the **prior** progress note (so the summary is *rolling* — it revises,
  not restarts) + (b) this session's messages from `conversations.messages`.
- **Instruction:** produce the §1 structured fields as JSON, obeying the framing rules,
  under the 350-token ceiling; **prefer replacing stale detail over appending**.
- **Params:** low temperature (~0.3) for stability; `max_tokens` sized to the ceiling;
  strict JSON-shape expectation.
- **Rate-limit + usage logging:** reuse the existing `checkRateLimit` / `logUsage`
  machinery; count-and-length telemetry only (§6).

### Failure handling — the note is never corrupted

Summarization is best-effort and **must never overwrite a good note with a bad one.**

| Failure | Behaviour |
|---|---|
| Bedrock error / timeout | **Leave existing note unchanged.** Retry on next trigger. Chat is never blocked. |
| Malformed / non-JSON output | Reject; leave existing note unchanged; log error-class only. |
| Validation fail (over cap, deficit language, PII leak, wrong shape) | Reject; leave existing note unchanged. |
| First-ever summary fails (no prior note) | No note is written. Next session simply loads no Layer-3 note — identical to the "no note yet" happy path. Graceful degradation, exactly like the Layer-2 notes-injection failure modes. |

The read side already tolerates a missing note (a student with no history has none), so
every failure mode degrades to "no Layer-3 context this session" — never an error surfaced
to the student, never a blocked chat. Same design philosophy as the server-side
teacher-notes injection in `CLAUDE.md`.

---

## 4. Deletion pipeline (reuse the Phase 4 pattern)

Phase 4 established the pattern for teacher-owned data; Phase 5 applies it to student data.
Same three stages:

1. **Soft delete** — set `deleted_at = now()`. All reads filter `deleted_at IS NULL`, so
   the row is immediately invisible to every path (chat injection, export).
2. **30-day grace** — the row remains recoverable for 30 days (accidental-deletion
   protection; matches the Phase 4 teacher-data grace window).
3. **Hard delete** — after 30 days, a documented purge removes the rows permanently, run via
   the IAM-gated **direct-invoke `adminSql`** branch (`CLAUDE.md` Stack Notes — the only
   direct-DB path; HTTP-unreachable by design). Purge = `DELETE FROM student_progress_notes
   WHERE deleted_at < now() - interval '30 days'`.

**"Delete student X" is ONE cascading operation.** Keyed on `student_id`, a single admin
operation soft-deletes every student-owned surface in the same transaction:
`profiles`, `conversations`, `homework_tasks`, this student's `class_enrollments` rows,
`api_usage`, **and `student_progress_notes`**. Because the discard default keeps no
transcript/embeddings store, **there is nothing else to also clear** — the cascade list is
exactly the enumerated tables. (If the retain decision flips, the cascade must also cover
`session_messages` + `message_embeddings` — noted in §9.)

> This is a Phase 4/5 *implementation prerequisite*: the enumerated tables need `deleted_at`
> columns before the cascade is real. `student_progress_notes` ships with one; the others
> are covered by the Phase 5 student-data deletion work this spec's deletion section feeds
> into. Flagged, not solved here (design-only).

---

## 5. Export (per-student JSON, mirroring `/my-data`)

FERPA gives parents/eligible students the right to *inspect* the education records held
about them. Phase 4 introduced a `/my-data`-style JSON export for the data-subject's own
records; Phase 5 mirrors it for the student-memory surface.

- **`GET /my-data` (student-scoped):** returns a JSON bundle of everything stored about the
  **JWT-identified** caller — identity always from the token, never the body. Reuses the
  existing per-route authz.
- **Under the discard default, the Layer-3 contribution to this export is the progress
  note(s) ONLY** — one note per class the student is enrolled in. **State this explicitly to
  requesting parents/students:** *because raw transcripts are not retained as a separate
  store, the student-memory export is the summary note, not a message-by-message
  transcript.* (The broader `/my-data` bundle still includes the student's `profiles` row,
  their `conversations` while those exist, and `homework_tasks` — those are separate
  pre-existing surfaces, not part of this feature.)
- If the retain decision flips, the export must additionally include the retained transcript
  and a human-readable note that embeddings exist (derived data) — §9.
- **Amendment requests** (FERPA's correct-the-record right): because the note is
  machine-generated and rolling, an amendment is handled by correcting the underlying signal
  (teacher note / re-summarization) rather than hand-editing the JSON — flag for the §8
  school conversation.

---

## 6. Logging (Phase 2 redaction helper — enforced)

**Note content and transcript content NEVER hit CloudWatch.** Enforced through the central
redaction helper introduced in Phase 2 (`COMPLIANCE.md` §1 note ³, §5 — logs carry route +
status + timing + error-class only; no PII, JWT claims, request bodies, or row contents).

Summarizer log lines carry **counts, lengths, model, latency, and error-class only** —
never a field of the note, never a message. Mirrors the existing `[notes] injected n
note(s), m chars` convention in `CLAUDE.md`:

```
[progress_note] updated class=<uuid> in=<n>msgs out=<m>chars model=haiku-4-5 ms=<t>
[progress_note] skipped reason=bedrock_timeout            # error-class only
[progress_note] rejected reason=validation_over_cap       # never the offending text
```

The redaction helper is the enforcement point — no summarizer/export code path may log raw
`note_content` or `conversations.messages`. This is a review-gate invariant, not a
convention.

---

## 7. Retention

**DEFAULT: 365-day retention placeholder on `student_progress_notes`** — after 365 days
with no session in that class, the note is soft-deleted (then follows the §4 grace →
hard-delete pipeline). **Mark: DECISION PENDING — school-contract dependent.** The real
number comes from the AB 1584 / NDPA agreement with Menlo, which does not exist yet
(`COMPLIANCE.md` §5). 365 days is a placeholder chosen to (a) survive a full academic year
plus summer, and (b) not persist indefinitely — the current default for *every other* table
(`COMPLIANCE.md` §1 note ¹), which Phase 5 exists to fix.

This retention decision is **coupled to the discard-vs-retain decision (§0)** and to the
open question of `conversations.messages` retention (§2.2). They should be resolved
together, ideally in the same school-contract conversation.

---

## 8. Open questions for the school

To be resolved in the AB 1584 / NDPA conversation with Menlo before scaled student use:

1. **Retention length.** How long may Lumi keep a student progress note (and the underlying
   chat history)? Drives §7. Default placeholder: 365 days.
2. **Who may view progress notes?** Teacher? Admin? Parent on request only? Student
   themselves? MVP default: server-internal only (injected into the prompt, shown to no
   one). Exposing to teachers is a plausible next feature but has its own consent surface.
3. **Under-16 opt-in consent (CCPA/CPRA).** California requires affirmative opt-in for
   processing personal information of minors under 16 (or parental consent under 13). Does
   maintaining a rolling AI memory of a student require an explicit consent flow at
   onboarding? Who captures/stores that consent?
4. **Discard vs. retain transcripts.** Should the school weigh in on whether Lumi keeps raw
   conversation history (enabling the Option C retrieval feature) or keeps only the summary
   note (smallest footprint)? This is both a product and a privacy decision — see §0 / §9.
   Coupled with question 1.

---

## 9. Upgrade path — Option C, relevance retrieval (DOCUMENTED, NOT MVP)

If, after real use, the rolling summary proves too lossy and we want per-message semantic
recall, this is the upgrade. It is written here so the MVP doesn't accidentally foreclose it
*silently* — but note (§0) that the **discard default DOES foreclose it** unless history is
re-accumulated from the flip-date forward.

**What changes — schema:**
- **Retain the transcript.** Either promote `conversations.messages` to the retrieval system
  of record, or add `session_messages(id, student_id, class_id, conversation_id, role,
  content, created_at, deleted_at)` — soft-delete from day one.
- **Add embeddings.** Enable the **pgvector** extension on RDS; add
  `message_embeddings(message_id FK, embedding vector(N), model, created_at)`. Retrieval =
  embed the student's current turn, ANN-search their own prior messages (JWT-scoped), inject
  the top-k into the prompt *in addition to* the Layer-3 note.

**What changes — infra:**
- **An embeddings model.** Likely **Amazon Titan Embeddings via Bedrock** (keeps the "no
  direct browser→Bedrock, in-account, no-training" posture from `COMPLIANCE.md` §4).
  **[NEEDS VERIFICATION against current AWS docs]** — do not assert as fact that Titan
  Embeddings runs in-VPC / in-Region / no-training on the same terms as the text models;
  confirm against the live Bedrock documentation at build time before relying on it in the
  compliance narrative.
- pgvector index maintenance, embedding backfill jobs, and larger RDS storage/compute.

**What changes — FERPA surface (larger, not smaller):**
- Full message history becomes a durable education record — expands the §1 data inventory,
  the deletion cascade (§4 must now also purge `session_messages` + `message_embeddings`),
  and the `/my-data` export (§5 must return the transcript + disclose derived embeddings).
- Embeddings are derived personal data — deletion must purge them alongside their source
  messages, and export must disclose their existence.
- More data resident = more to protect, more to breach, more to delete correctly. The MVP's
  discard default is the privacy-conservative choice precisely because it keeps this surface
  from ever existing.

**Net:** Option C is strictly *additive* to the Layer-3 note — the note remains the cheap
default context even when retrieval exists. The cost is a materially larger stored-data and
FERPA surface, and (given the discard default) a history that must be re-accumulated before
retrieval can work.

---

## 10. Not stored / not done (SOPIPA educational-purpose boundary)

Explicitly out of scope — Lumi does **not** and will **not**, for this feature:
- **Train models** on student notes or transcripts. Inference is Bedrock-only, which does
  not train on inputs/outputs (`COMPLIANCE.md` §4, cited). No note/transcript ever leaves
  for model training.
- **Run analytics or profiling** on message or note *content* for any non-educational
  purpose — no ad targeting, no behavioral profiling, no cross-student data mining, no sale
  or disclosure of data. (The deferred teacher-facing *class analytics* ideas in `CLAUDE.md`
  are a separate, future, consent-gated feature — explicitly not built or enabled here.)
- **Anything beyond the educational purpose** of helping *this* student learn in *this*
  class (SOPIPA). The progress note is a tutoring-support artifact, not an assessment,
  ranking, or record shared outside the educational relationship.
```
