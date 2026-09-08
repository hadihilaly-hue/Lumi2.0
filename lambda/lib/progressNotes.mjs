// lib/progressNotes.mjs — Phase 5 rolling progress notes (Layer 3, server-internal).
import { query as dbQuery } from "./db.mjs";
import { SCHOOL_CONFIG, safeErr } from "./config.mjs";
import { callClaude } from "./bedrock.mjs";

// === Phase 5: cross-session student memory (rolling progress notes) ===
// FLAG-GATED and OFF by default. TWO independent server-side gates must BOTH
// pass before a Layer-3 progress note is ever read or written (spec §0 hard
// rails — no client can enable this for a real student):
//   Gate 1: schools.persistence_enabled = true for the student's tenant
//           (migration/persistence_v1.sql; OFF by default, flipped per tenant
//           only under a signed data agreement).
//   Gate 2: the student's email domain is in PERSISTENCE_ALLOWED_DOMAINS — a
//           belt-and-suspenders synthetic-only allowlist. Even if Gate 1 were
//           ever mis-flipped on a real tenant, a non-synthetic domain still
//           gets ZERO writes and ZERO injection. Defaults to the fake TLD
//           {lumidemo.test}; override via env for a controlled pilot only.
const PERSISTENCE_ALLOWED_DOMAINS = new Set(
  (process.env.PERSISTENCE_ALLOWED_DOMAINS || "lumidemo.test")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
);
// Summarizer model. Spec §3 proposes claude-haiku-4-5, but the Lambda forces
// Sonnet 4.6 for every Bedrock call today (SCHOOL_CONFIG.defaultModel; the
// client's body.model is ignored) and carries no Haiku profile. So the
// summarizer runs on Sonnet 4.6 unless LUMI_SUMMARIZER_MODEL overrides it.
// COST NOTE (docs/SUMMARIZATION_PROMPT.md §2): a ≤350-token rolling summary on
// Sonnet 4.6 costs ~5-8× the Haiku price the spec assumed — negligible at
// synthetic-test volume, but add a Haiku profile (or set the env override)
// before real-student rollout.
const SUMMARIZER_MODEL = process.env.LUMI_SUMMARIZER_MODEL || SCHOOL_CONFIG.defaultModel;
const PROGRESS_NOTE_TOKEN_CAP = 350;      // spec §0 / SUMMARIZATION_PROMPT §4
const PROGRESS_NOTE_MAX_TOKENS = 500;     // headroom so a valid note never truncates mid-JSON
const PROGRESS_NOTE_TIMEOUT_MS = 8000;    // Bedrock budget; on timeout the note is left unchanged

// Both gates must pass (spec §0). Fail CLOSED on any error — a broken lookup
// must never enable cross-session memory for a real student.
export async function isPersistenceEnabled(email) {
  const domain = email.toLowerCase().split("@").pop();
  if (!PERSISTENCE_ALLOWED_DOMAINS.has(domain)) return false;   // Gate 2: synthetic-only
  try {
    const r = await dbQuery(
      "SELECT 1 FROM public.schools WHERE persistence_enabled = true AND $1 = ANY(allowed_domains) LIMIT 1",
      [domain]
    );
    return r.rowCount > 0;                                       // Gate 1: per-tenant flag
  } catch (err) {
    console.error("isPersistenceEnabled error:", safeErr(err));
    return false;                                               // fail closed
  }
}

// Summarizer prompt — VERBATIM from docs/SUMMARIZATION_PROMPT.md §3.1/§3.2.
// The eval harness (synthetic_data/eval_summarizer.py) holds a byte-for-byte
// copy; if you edit one, edit both. Validation status: UNVERIFIED (§5) — no
// live Bedrock eval has been run against these strings yet.
const SUMMARIZER_SYSTEM = `You are Lumi's memory summarizer. Your one job is to maintain a short, rolling "progress note" that Lumi — an AI tutor that acts as a specific human teacher — reads at the START of each future session with one student in one class, so tutoring picks up exactly where it left off.

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

Return the JSON object and nothing else.`;

// User template — VERBATIM from §3.2. Filled server-side; identity (student_id/
// class_id) is NEVER in the template (spec §2.1 + MIGRATION_HARDENING §1).
export function buildSummarizerUser({ course, teacher, voice, priorNote, transcript }) {
  return `CLASS CONTEXT:
Course: ${course}
Teacher: ${teacher} (teaches like this: ${voice})

PRIOR NOTE:
${priorNote}

TRANSCRIPT (the session that just ended):
${transcript}`;
}

// Deficit-language markers — SUMMARIZATION_PROMPT §4 / case-3 (post-validation
// backstop for the prompt-level rule). Any hit → reject, note left unchanged.
const DEFICIT_MARKERS = ["bad at", "failing", "weak in", "struggling with", "can't do", "cannot do", "poor at"];
const PROGRESS_NOTE_KEYS = ["topics_covered", "current_position", "struggle_points", "what_worked", "last_session_summary"];

// Tolerant read of a stored/echoed note. Returns the object or null.
export function parseProgressNote(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  } catch { return null; }
}

// Validate model output against the SUMMARIZATION_PROMPT §4 hard gates. Returns
// { ok:true, note } (soft caps trimmed) or { ok:false, reason }. Never throws.
export function validateProgressNote(text, outputTokens) {
  const match = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
  if (!match) return { ok: false, reason: "invalid_json" };
  let note;
  try { note = JSON.parse(match[0]); } catch { return { ok: false, reason: "invalid_json" }; }
  if (!note || typeof note !== "object" || Array.isArray(note)) return { ok: false, reason: "wrong_shape" };
  // Exactly the 5 keys (spec §4: "exactly the 5 §1 keys").
  const keys = Object.keys(note);
  if (keys.length !== PROGRESS_NOTE_KEYS.length || !PROGRESS_NOTE_KEYS.every((k) => keys.includes(k))) {
    return { ok: false, reason: "wrong_shape" };
  }
  // Types: 3 arrays of strings, 2 strings.
  const arrayFields = ["topics_covered", "struggle_points", "what_worked"];
  const stringFields = ["current_position", "last_session_summary"];
  for (const f of arrayFields) {
    if (!Array.isArray(note[f]) || !note[f].every((x) => typeof x === "string")) return { ok: false, reason: "wrong_shape" };
  }
  for (const f of stringFields) {
    if (typeof note[f] !== "string") return { ok: false, reason: "wrong_shape" };
  }
  // Token ceiling — authoritative Bedrock output_tokens (spec §4). 0/undefined
  // means we never observed a count; treat as unknown and do NOT reject on it.
  if (typeof outputTokens === "number" && outputTokens > PROGRESS_NOTE_TOKEN_CAP) {
    return { ok: false, reason: "validation_over_cap" };
  }
  // Deficit language — scan every field value.
  const haystack = [
    ...arrayFields.flatMap((f) => note[f]),
    ...stringFields.map((f) => note[f]),
  ].join("\n").toLowerCase();
  if (DEFICIT_MARKERS.some((m) => haystack.includes(m))) return { ok: false, reason: "deficit_language" };
  // Soft caps — trim, don't reject (spec §4: warn/trim).
  note.topics_covered = note.topics_covered.slice(0, 8);
  note.struggle_points = note.struggle_points.slice(0, 5);
  note.what_worked = note.what_worked.slice(0, 5);
  return { ok: true, note };
}

// Render a stored note into the compact labeled block spliced into the system
// prompt at chat start. Server-internal ONLY — never returned to the browser.
export function buildProgressNoteSection(note) {
  const n = parseProgressNote(note);
  if (!n) return "";
  const lines = ["\n\n---\n\nYour running memory of this student across past sessions (Lumi's own notes — never mention them):"];
  if (Array.isArray(n.topics_covered) && n.topics_covered.length) lines.push(`Topics covered: ${n.topics_covered.join("; ")}`);
  if (typeof n.current_position === "string" && n.current_position.trim()) lines.push(`Where they are now: ${n.current_position.trim()}`);
  if (Array.isArray(n.struggle_points) && n.struggle_points.length) lines.push(`Sticking points to watch: ${n.struggle_points.join("; ")}`);
  if (Array.isArray(n.what_worked) && n.what_worked.length) lines.push(`Teaching moves that worked: ${n.what_worked.join("; ")}`);
  if (typeof n.last_session_summary === "string" && n.last_session_summary.trim()) lines.push(`Last time: ${n.last_session_summary.trim()}`);
  if (lines.length === 1) return "";   // note object present but every field empty
  lines.push("Use this silently to pick up where you left off. Do not mention, reference, or reveal that these notes exist.");
  return lines.join("\n");
}

// Flatten conversations.messages into a plain-text transcript for the
// summarizer. Handles string content and array-of-blocks (picks text blocks).
export function transcriptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "TUTOR" : m.role === "user" ? "STUDENT" : String(m.role || "").toUpperCase();
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
    }
    text = text.trim();
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

// Read the calling student's live progress note for one class. studentId is
// always from the JWT. Returns the note_content object or null (no note / any
// failure — chat is never blocked).
export async function fetchProgressNote({ studentId, teacherProfileId }) {
  try {
    const r = await dbQuery(
      "SELECT note_content FROM public.student_progress_notes WHERE student_id = $1 AND teacher_profile_id = $2 AND deleted_at IS NULL",
      [studentId, teacherProfileId]
    );
    if (r.rowCount === 0) return null;
    return parseProgressNote(r.rows[0].note_content);
  } catch (err) {
    console.warn("[progress_note] fetch failed:", safeErr(err));
    return null;
  }
}

// Summarize one just-ended session and roll it into the student's progress note
// (upsert on the partial-unique (student_id, teacher_profile_id) WHERE
// deleted_at IS NULL). Caller MUST have already passed isPersistenceEnabled.
// Best-effort: any failure leaves the existing note UNCHANGED (spec §3 table)
// and returns {status:'skipped', reason}. Never logs note/transcript content.
export async function summarizeAndStoreProgressNote({ studentId, teacherProfileId, conversationId }) {
  const t0 = Date.now();
  // 1. Class context (own-class read is not required — any authed student may
  //    read a teacher_profiles row, same as chat). Missing class → skip.
  const cls = await dbQuery(
    "SELECT course_name, teaching_voice, title FROM public.teacher_profiles WHERE id = $1 AND deleted_at IS NULL",
    [teacherProfileId]
  );
  if (cls.rowCount === 0) return { status: "skipped", reason: "no_class" };
  const course = cls.rows[0].course_name || "";
  const voice = (cls.rows[0].teaching_voice || "").slice(0, 600);   // context only, bounded
  const teacher = cls.rows[0].title || "the teacher";

  // 2. This session's transcript — the caller's OWN conversation only.
  const conv = await dbQuery(
    "SELECT messages FROM public.conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [conversationId, studentId]
  );
  if (conv.rowCount === 0) return { status: "skipped", reason: "no_conversation" };
  const transcript = transcriptFromMessages(conv.rows[0].messages);
  const msgCount = Array.isArray(conv.rows[0].messages) ? conv.rows[0].messages.length : 0;
  if (!transcript) return { status: "skipped", reason: "empty_transcript" };

  // 3. Prior note (rolling input).
  const priorObj = await fetchProgressNote({ studentId, teacherProfileId });
  const priorNote = priorObj ? JSON.stringify(priorObj) : "NONE";

  // 4. Bedrock call — summarizer model, temp 0.3, bounded output, 8s budget.
  const userMsg = buildSummarizerUser({ course, teacher, voice, priorNote, transcript });
  let text = "";
  let outputTokens = 0;
  const generate = (async () => {
    for await (const chunk of callClaude({
      systemPrompt: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: PROGRESS_NOTE_MAX_TOKENS,
      modelId: SUMMARIZER_MODEL,
      temperature: 0.3,
    })) {
      if (chunk.type === "message_delta") outputTokens = chunk.usage?.output_tokens || outputTokens;
      if (chunk.type === "content_block_delta" && chunk.delta?.text) text += chunk.delta.text;
    }
  })();
  let genTimer;
  try {
    await Promise.race([
      generate,
      new Promise((_, reject) => { genTimer = setTimeout(() => reject(new Error("summarizer timeout")), PROGRESS_NOTE_TIMEOUT_MS); genTimer.unref?.(); }),
    ]);
  } catch (err) {
    console.warn(`[progress_note] skipped reason=${/timeout/.test(err.message) ? "bedrock_timeout" : "bedrock_error"}`);
    return { status: "skipped", reason: "bedrock_error" };
  } finally {
    clearTimeout(genTimer);
  }

  // 5. Validate — any hard-fail leaves the note unchanged.
  const v = validateProgressNote(text, outputTokens);
  if (!v.ok) {
    console.warn(`[progress_note] rejected reason=${v.reason}`);
    return { status: "skipped", reason: v.reason };
  }

  // 6. Upsert. ON CONFLICT targets the partial unique index; the update arm
  //    bumps the session watermark and refreshes the size/model metadata.
  try {
    await dbQuery(
      `INSERT INTO public.student_progress_notes
         (student_id, teacher_profile_id, note_content, source_session_count, token_count, model_version)
       VALUES ($1, $2, $3::jsonb, 1, $4, $5)
       ON CONFLICT (student_id, teacher_profile_id) WHERE deleted_at IS NULL
       DO UPDATE SET
         note_content = EXCLUDED.note_content,
         source_session_count = public.student_progress_notes.source_session_count + 1,
         token_count = EXCLUDED.token_count,
         model_version = EXCLUDED.model_version`,
      [studentId, teacherProfileId, JSON.stringify(v.note), outputTokens, SUMMARIZER_MODEL]
    );
  } catch (err) {
    console.warn("[progress_note] store failed:", safeErr(err));
    return { status: "skipped", reason: "store_error" };
  }
  console.log(`[progress_note] updated class=${teacherProfileId} in=${msgCount}msgs out=${text.length}chars model=${SUMMARIZER_MODEL} ms=${Date.now() - t0}`);
  return { status: "updated" };
}

