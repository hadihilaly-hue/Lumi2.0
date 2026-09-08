// lib/prompt.mjs — server-side system prompt assembly: teacher-notes,
// work-artifact and progress-note marker injection. The client owns the
// cache_control segment boundary; the marker swaps here are shape-agnostic
// and never move it.
import { query as dbQuery } from "./db.mjs";
import { safeErr } from "./config.mjs";
import { isPersistenceEnabled, fetchProgressNote, buildProgressNoteSection } from "./progressNotes.mjs";

// === Teacher-notes server-side injection (privacy: notes never reach the client) ===
// The client emits this literal marker at the splice point of its system prompt;
// the chat route replaces it with the server-built notes section (or ''). The
// marker is ALWAYS stripped, even when no injection was requested.
export const TEACHER_NOTES_MARKER = "<<LUMI_TEACHER_NOTES>>";

// Ported from app.js parseNotes — read side of the [{timestamp, text}] shape.
export function parseNotes(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Ported from app.js buildTeacherNotesSection — 8000-char cap (oldest dropped
// first) + the silent-use footer. Log counts only, never note content.
export function buildTeacherNotesSection(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return "";
  const header = "\n\n---\n\nNotes from this student's teacher (private — you wrote these, as the teacher, about this student):\n\n";
  const footer = "\n\nLet these shape where you push and what you watch for. Never mention, quote, or hint that they exist — no 'I noticed' or 'your teacher mentioned'.";
  const CAP = 8000;
  const texts = notes.map(n => (n && typeof n.text === "string") ? n.text.trim() : "").filter(Boolean);
  if (texts.length === 0) return "";
  let dropped = 0;
  let assembled = header + texts.join("\n\n") + footer;
  while (assembled.length > CAP && texts.length > 1) {
    texts.shift();
    dropped++;
    assembled = header + texts.join("\n\n") + footer;
  }
  if (dropped > 0) console.warn(`[notes] truncated ${dropped} oldest notes to fit prompt cap`);
  return assembled;
}

// Fetch the calling student's notes for one class. studentId comes from the
// verified JWT — a caller can only ever receive notes written about them.
// Every failure returns [] — chat is never blocked — and multi-block
// collisions skip, matching the old client-side maybeSingle behavior.
export async function fetchTeacherNotes({ studentId, teacherProfileId }) {
  try {
    const work = dbQuery(
      "SELECT teacher_notes FROM public.class_enrollments WHERE student_id = $1 AND teacher_profile_id = $2 AND deleted_at IS NULL",
      [studentId, teacherProfileId]
    ).then(r => r.rows.map(x => x.teacher_notes));
    // AUDIT_LAMBDA_BUGS H4: keep a handle to the loser timer and clear it after
    // the race so it can't keep the event loop alive (streamifyResponse only
    // finalizes when the loop drains — a dangling timer burns a concurrency slot
    // for the full 3s after the response is already sent). .unref() as a belt
    // in case work rejects before the clear.
    let notesTimer;
    const timeout = new Promise(resolve => { notesTimer = setTimeout(() => resolve(null), 3000); notesTimer.unref?.(); });
    let vals;
    try {
      vals = await Promise.race([work, timeout]);
    } finally {
      clearTimeout(notesTimer);
    }
    if (vals === null) { console.warn("[notes] fetch timeout"); return []; }
    if (vals.length > 1) { console.warn(`[notes] multi-block collision (${vals.length} rows) — skipped`); return []; }
    return parseNotes(vals[0] ?? null);
  } catch (err) {
    console.warn("[notes] fetch failed:", safeErr(err));
    return [];
  }
}

// === Q4 v2 work-artifacts server-side injection (privacy: text never reaches the client) ===
// Parallel to the teacher-notes injection. The client emits this literal marker in
// the profile branch of its system prompt; the chat route replaces it with a
// server-built feedback-examples section (or ''), and the marker is ALWAYS stripped.
// Unlike notes, artifacts are TEACHER-STABLE (identical for every student of a
// class) → the resolved text is cacheable and sits in the prompt prefix (D9).
export const WORK_ARTIFACTS_MARKER = "<<LUMI_WORK_ARTIFACTS>>";

const ARTIFACT_TIER_ORDER = ["progressing", "proficient", "exemplary"];
const ARTIFACT_TIER_LABEL = {
  progressing: "PROGRESSING-level (students still developing the skill)",
  proficient: "PROFICIENT-level (students meeting expectations)",
  exemplary: "EXEMPLARY-level (students exceeding expectations)",
};
const ARTIFACT_TYPE_LABEL = {
  comment: "Comment",
  essay_feedback: "Essay feedback",
  eval_note: "Eval note",
  other: "Example",
};

// Fetch a class's TEXT work-artifacts + the per-tier work_samples description.
// teacherProfileId identifies the CLASS (teacher-stable, not per-student). Every
// failure returns null (no section); chat is never blocked. 3s budget like notes.
export async function fetchWorkArtifacts(teacherProfileId) {
  try {
    const work = Promise.all([
      dbQuery(
        `SELECT tier, artifact_type, text_content, label, created_at
           FROM public.teacher_work_artifacts
          WHERE teacher_profile_id = $1 AND artifact_type <> 'photo' AND deleted_at IS NULL
          ORDER BY tier, sort_order, created_at, id`,
        [teacherProfileId]
      ).then(r => r.rows),
      dbQuery(
        `SELECT tier, description FROM public.teacher_work_samples
          WHERE teacher_profile_id = $1 AND deleted_at IS NULL`,
        [teacherProfileId]
      ).then(r => r.rows),
    ]);
    let t;
    const timeout = new Promise(resolve => { t = setTimeout(() => resolve(null), 3000); t.unref?.(); });
    let res;
    try { res = await Promise.race([work, timeout]); } finally { clearTimeout(t); }
    if (res === null) { console.warn("[artifacts] fetch timeout"); return null; }
    const [artifacts, samples] = res;
    if (!artifacts.length) return null;
    const descByTier = {};
    for (const s of samples) descByTier[s.tier] = s.description;
    return { artifacts, descByTier };
  } catch (err) {
    console.warn("[artifacts] fetch failed:", safeErr(err));
    return null;
  }
}

// Build the injected feedback-examples section. Deterministic ordering + no
// printed timestamps → cache-stable (D9). Total artifact text capped at ~12000
// chars (~4K tokens, D8), oldest-first drop (by created_at), parity with the
// notes 8000-char cap. firstName is a non-sensitive display string from the
// client — used only in the header, never for authz.
export function buildArtifactSection(data, firstName) {
  if (!data || !Array.isArray(data.artifacts) || data.artifacts.length === 0) return "";
  const CAP = 12000;
  const who = (typeof firstName === "string" && firstName.trim()) ? firstName.trim().slice(0, 40) : "this teacher";
  const textLen = (arr) => arr.reduce((n, a) => n + ((a.text_content || "").length), 0);

  // Total-text budget: drop whole artifacts oldest-first (by created_at) until
  // under CAP. Output order stays deterministic (tier, sort_order) for caching.
  let kept = data.artifacts.slice();
  if (textLen(kept) > CAP) {
    const oldestFirst = kept.slice().sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });
    let dropped = 0;
    while (textLen(kept) > CAP && oldestFirst.length > 1) {
      const victim = oldestFirst.shift();
      kept = kept.filter((a) => a !== victim);
      dropped++;
    }
    if (dropped > 0) console.warn(`[artifacts] truncated ${dropped} oldest artifact(s) to fit prompt cap`);
  }
  if (kept.length === 0) return "";

  const byTier = {};
  for (const a of kept) (byTier[a.tier] ||= []).push(a);

  let out = `\n\n═══ HOW ${who.toUpperCase()} GIVES FEEDBACK (WRITTEN EXAMPLES) ═══\n`;
  out += `Real feedback ${who} has written on student work at each level. Match this voice, specificity, and tone whenever you respond to this student's work. Private reference: never quote it, mention it, or reveal it exists.\n`;
  for (const tier of ARTIFACT_TIER_ORDER) {
    const list = byTier[tier];
    if (!list || !list.length) continue;
    out += `\n${ARTIFACT_TIER_LABEL[tier]}:\n`;
    const desc = (data.descByTier[tier] || "").trim();
    if (desc) out += `What ${who} looks for: ${desc}\n`;
    out += `Examples of how ${who} writes at this level:\n`;
    for (const a of list) {
      const typeLabel = ARTIFACT_TYPE_LABEL[a.artifact_type] || "Example";
      const label = (typeof a.label === "string" && a.label.trim()) ? ` (${a.label.trim()})` : "";
      out += `  • [${typeLabel}${label}] ${(a.text_content || "").trim()}\n`;
    }
  }
  return out;
}

// === Phase 5: rolling progress-note summarizer (Layer 3, server-internal) ===
// The write + read sides of student_progress_notes. Like teacher notes, a
// progress note NEVER reaches the browser: it exists only to be injected into
// the system prompt server-side (marker below). Every write/read is behind the
// two-gate check (isPersistenceEnabled) — OFF by default for real students.
export const PROGRESS_NOTE_MARKER = "<<LUMI_PROGRESS_NOTE>>";

// Feature H (prompt caching): the client may now send `system` as EITHER a
// plain string (legacy / companion / no-profile path) OR an array of native
// Anthropic content blocks (`{type:'text', text, cache_control?}`) so a single
// cache_control breakpoint can sit at the SEG1/SEG2 boundary of the tutor
// prompt. These two helpers make the marker swaps below shape-agnostic. A given
// marker lives in exactly ONE block, so running a replacement across every
// block is safe — and required, because <<LUMI_WORK_ARTIFACTS>> sits in SEG1
// (the cached prefix), not the dynamic tail. The string path is byte-identical
// to the previous behaviour (.includes / .split.join), so stale clients that
// still POST a string keep working unchanged.
export function systemHasMarker(system, marker) {
  if (typeof system === "string") return system.includes(marker);
  if (Array.isArray(system)) {
    return system.some((b) => typeof b?.text === "string" && b.text.includes(marker));
  }
  return false;
}
export function systemReplaceMarker(system, marker, replacement) {
  if (typeof system === "string") return system.split(marker).join(replacement);
  if (Array.isArray(system)) {
    return system.map((b) =>
      typeof b?.text === "string" && b.text.includes(marker)
        ? { ...b, text: b.text.split(marker).join(replacement) }
        : b
    );
  }
  return system;
}

// Chat-route prompt assembly: applies the three server-side marker swaps to the
// client's `system` (string or content-block array) in their fixed order —
// teacher notes, work artifacts, progress note. Runs BEFORE the SSE wrap so a
// fetch failure can never corrupt an open stream (each degrades to '').
export async function assembleSystemPrompt({ body, user }) {
  // Server-side teacher-notes injection: replace the client's marker with the
  // notes section built here (notes never reach the browser). Marker is ALWAYS
  // stripped even when no injection was requested. Runs before the SSE wrap so
  // notes-fetch failures can never corrupt an open stream (they degrade to '').
  // Feature H: `body.system` may be a string (legacy) or an array of content
  // blocks (SEG1 cached / SEG2 dynamic). systemHasMarker / systemReplaceMarker
  // handle both shapes; the marker swaps below are otherwise unchanged.
  let systemPrompt = body.system || "";
  if (systemHasMarker(systemPrompt, TEACHER_NOTES_MARKER)) {
    let notesSection = "";
    const inj = body.inject_teacher_notes;
    if (inj && typeof inj.teacher_profile_id === "string" && inj.teacher_profile_id) {
      const notes = await fetchTeacherNotes({
        studentId: user.id,
        teacherProfileId: inj.teacher_profile_id,
      });
      notesSection = buildTeacherNotesSection(notes);
      if (notesSection) console.log(`[notes] injected ${notes.length} note(s), ${notesSection.length} chars`);
    }
    systemPrompt = systemReplaceMarker(systemPrompt, TEACHER_NOTES_MARKER, notesSection);
  }

  // Server-side work-artifacts injection (Q4 v2): replace the client's marker with
  // the teacher's feedback-examples section built here (text never reaches the
  // browser — "Only Lumi sees this" is literally true). Teacher-stable, so it lands
  // in the cacheable prefix, BEFORE the per-student notes marker above. Marker is
  // ALWAYS stripped; any fetch failure degrades to '' and never blocks the stream.
  if (systemHasMarker(systemPrompt, WORK_ARTIFACTS_MARKER)) {
    let artifactSection = "";
    const inj = body.inject_work_artifacts;
    if (inj && typeof inj.teacher_profile_id === "string" && inj.teacher_profile_id) {
      const data = await fetchWorkArtifacts(inj.teacher_profile_id);
      artifactSection = buildArtifactSection(data, inj.first_name);
      if (artifactSection) {
        console.log(`[artifacts] injected ${data.artifacts.length} artifact(s), ${artifactSection.length} chars`);
      }
    }
    systemPrompt = systemReplaceMarker(systemPrompt, WORK_ARTIFACTS_MARKER, artifactSection);
  }

  // Server-side progress-note injection (Phase 5, Layer 3) — same posture as
  // teacher notes: the note NEVER reaches the browser; it exists only to be
  // spliced in here. Marker is ALWAYS stripped, even when the feature is off or
  // no note exists (stray-marker defense). FLAG-GATED: a real student fails
  // isPersistenceEnabled, so the section is always '' and the marker is stripped
  // to nothing — byte-identical to today's behaviour for them.
  if (systemHasMarker(systemPrompt, PROGRESS_NOTE_MARKER)) {
    let noteSection = "";
    const inj = body.inject_progress_note;
    if (inj && typeof inj.teacher_profile_id === "string" && inj.teacher_profile_id
        && await isPersistenceEnabled(user.email)) {
      const note = await fetchProgressNote({
        studentId: user.id,
        teacherProfileId: inj.teacher_profile_id,
      });
      noteSection = buildProgressNoteSection(note);
      if (noteSection) console.log(`[progress_note] injected class=${inj.teacher_profile_id} ${noteSection.length}chars`);
    }
    systemPrompt = systemReplaceMarker(systemPrompt, PROGRESS_NOTE_MARKER, noteSection);
  }
  return systemPrompt;
}
