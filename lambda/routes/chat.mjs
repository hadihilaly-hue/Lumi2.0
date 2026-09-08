// routes/chat.mjs — Bedrock-backed routes: the default SSE chat stream,
// /suggested-prompts, and the flag-gated /progress-note/flush.
import { query as dbQuery } from "../lib/db.mjs";
import { SCHOOL_CONFIG, safeErr } from "../lib/config.mjs";
import { teacherStatus } from "../lib/auth.mjs";
import { checkRateLimit, logUsage } from "../lib/usage.mjs";
import { callClaude, generateResponse } from "../lib/bedrock.mjs";
import { assembleSystemPrompt, fetchTeacherNotes } from "../lib/prompt.mjs";
import { openEventStream, writeEvent, writeDone, writeError } from "../lib/sse.mjs";
import { isPersistenceEnabled, summarizeAndStoreProgressNote } from "../lib/progressNotes.mjs";

// === Route: GET /suggested-prompts ===
// Server-side replacement for the client's notes-influenced Haiku chips
// (app.js generateInfluencedPrompts). The caller's notes are read server-side
// (JWT-scoped, same source selection as chat injection) and NEVER returned —
// only the 3 generated chip strings. No notes / any failure => {mode:
// 'fallback'} and the client uses its static list. Counts against the same
// per-user rate limit as chat and logs usage.
export async function suggestedPrompts(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "GET";
    if (method !== "GET") return sendJson(405, { error: "Method not allowed" });
    const qs = event.queryStringParameters || {};
    if (!qs.teacher_profile_id) return sendJson(400, { error: "Missing teacher_profile_id" });
    try {
      const notes = await fetchTeacherNotes({
        studentId: user.id,
        teacherProfileId: qs.teacher_profile_id,
      });
      const notesText = notes.map(n => n.text || "").filter(Boolean).join("\n\n");
      if (!notesText) return sendJson(200, { mode: "fallback" });

      const isTeacherUser = (await teacherStatus(user, { provisioned: false })).isDone;
      const rateLimit = await checkRateLimit(user.id, isTeacherUser);
      if (!rateLimit.allowed) return sendJson(200, { mode: "fallback" });

      // System prompt ported verbatim from app.js generateInfluencedPrompts.
      const chipSystem = `You generate exactly 3 starter prompt suggestions that will appear as quick-tap chips above a student's chat with their AI tutor.

You will receive course context and confidential teacher notes about the student. Use the notes to subtly steer 2 of the 3 chips toward relevant topics. NEVER quote, paraphrase, or reveal the notes — they are private to the teacher.

Return EXACTLY a JSON array of 3 strings, in this order:
1. A generic study chip (e.g., "Help me with my homework", "Quiz me on what we've been learning"). Topic-agnostic.
2. A neutral topic-related chip framed as an offer (e.g., "Want to try some factoring practice?").
3. A curiosity-framed topic-related chip (e.g., "What's a clean way to factor quadratics?").

Hard rules:
- NO deficit language. Never "you're struggling with", "to help with your weak area", "since you have trouble", "I'm bad at", "I keep failing".
- Each chip ≤ 60 characters.
- Sound like something a confident, curious student would type.
- If the notes are vague or don't suggest a topic, return 3 generic chips instead (do not invent a topic).

Output ONLY the JSON array. No prose, no code fences, no explanation.`;
      const userMsg = `Course: ${qs.course || ""}\n\nTeacher notes:\n${notesText}\n\nReturn the JSON array now.`;

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const generate = (async () => {
        for await (const chunk of callClaude({
          systemPrompt: chipSystem,
          messages: [{ role: "user", content: userMsg }],
          maxTokens: 300,
        })) {
          if (chunk.type === "message_start") inputTokens = chunk.message?.usage?.input_tokens || 0;
          if (chunk.type === "message_delta") outputTokens = chunk.usage?.output_tokens || outputTokens;
          if (chunk.type === "content_block_delta" && chunk.delta?.text) text += chunk.delta.text;
        }
      })();
      // AUDIT_LAMBDA_BUGS H4: clear the loser timeout so it can't keep the event
      // loop alive and burn a concurrency slot after the response is sent.
      let genTimer;
      try {
        await Promise.race([
          generate,
          new Promise((_, reject) => { genTimer = setTimeout(() => reject(new Error("generation timeout")), 8000); genTimer.unref?.(); }),
        ]);
      } finally {
        clearTimeout(genTimer);
      }

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("no JSON array");
      const chips = JSON.parse(match[0]);
      if (!Array.isArray(chips) || chips.length !== 3) throw new Error("not array of 3");
      if (!chips.every(c => typeof c === "string" && c.length > 0 && c.length <= 80)) {
        throw new Error("chip shape invalid");
      }
      // Defense-in-depth privacy check (ported): reject chips leaking the
      // student's email or profile name.
      const lowered = chips.map(c => c.toLowerCase());
      if (lowered.some(c => c.includes(user.email.toLowerCase()))) throw new Error("chip leaked student email");
      try {
        const r = await dbQuery("SELECT name FROM public.profiles WHERE id = $1", [user.id]);
        const name = r.rows[0]?.name || null;
        if (name && name.trim() && lowered.some(c => c.includes(name.trim().toLowerCase()))) {
          throw new Error("chip leaked student name");
        }
      } catch (err) {
        if (/leaked/.test(err.message)) throw err;
        // name lookup failure is non-fatal — email check already ran
      }

      logUsage({ userId: user.id, email: user.email, isTeacherUser, model: SCHOOL_CONFIG.defaultModel, inputTokens, outputTokens });
      console.log("[suggested-prompts] mode=influenced");
      return sendJson(200, { mode: "influenced", prompts: chips });
    } catch (err) {
      console.warn("[suggested-prompts] generation failed:", safeErr(err));
      return sendJson(200, { mode: "fallback" });
    }
}

// === Route: POST /progress-note/flush (Phase 5, FLAG-GATED) ===
// Session-end trigger for the rolling progress note (spec §3 trigger 1). The
// client beacons {teacher_profile_id, conversation_id} on New chat / sign-out;
// the Lambda summarizes THAT conversation (the caller's own) and rolls it into
// student_progress_notes. Double-gated (isPersistenceEnabled) so a real
// student gets {status:'disabled'} and ZERO writes. Best-effort: never blocks,
// returns status ONLY — note content is server-internal and never echoed.
export async function progressNoteFlush(ctx) {
  const { event, body, user, sendJson } = ctx;
    const method = event.requestContext?.http?.method || "POST";
    if (method !== "POST") return sendJson(405, { error: "Method not allowed" });
    if (!(await isPersistenceEnabled(user.email))) return sendJson(200, { status: "disabled" });
    const tpid = body.teacher_profile_id;
    const cid = body.conversation_id;
    if (typeof tpid !== "string" || !tpid || typeof cid !== "string" || !cid) {
      return sendJson(400, { error: "Missing teacher_profile_id or conversation_id" });
    }
    try {
      const result = await summarizeAndStoreProgressNote({
        studentId: user.id,
        teacherProfileId: tpid,
        conversationId: cid,
      });
      return sendJson(200, result);
    } catch (err) {
      console.warn("[progress_note] flush failed:", safeErr(err));
      return sendJson(200, { status: "skipped", reason: "error" });
    }
}

  // === Default route: chat (SSE streaming) ===
export async function chat(ctx) {
  const { body, user, sendJson, responseStream } = ctx;
  let isTeacherUser;
  try {
    isTeacherUser = (await teacherStatus(user, { provisioned: false })).isDone;
    const rateLimit = await checkRateLimit(user.id, isTeacherUser);
    if (!rateLimit.allowed) {
      return sendJson(429, { error: `Rate limit exceeded (${rateLimit.limit}/day)` });
    }
  } catch (err) {
    console.error("Pre-chat error:", safeErr(err));
    return sendJson(500, { error: err.message });
  }
  
  const systemPrompt = await assembleSystemPrompt({ body, user });

  const chatStream = openEventStream(responseStream);

  try {
    const provider = body.provider || SCHOOL_CONFIG.defaultProvider;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of generateResponse({
      provider,
      systemPrompt,
      messages: body.messages || [],
      maxTokens: Math.min(body.max_tokens || SCHOOL_CONFIG.maxTokensCap, SCHOOL_CONFIG.maxTokensCap),
    })) {
      if (chunk.type === "message_start") {
        const usage = chunk.message?.usage || {};
        inputTokens = usage.input_tokens || 0;
        // Feature H (prompt caching) verification hook. We CANNOT know from the
        // repo whether the forced `global.` cross-region inference profile emits
        // cache-usage fields (or honors caching at all) until we read these logs
        // — so log defensively: emit the standard Anthropic field names when
        // present, otherwise dump the usage keys that DID arrive so we can
        // confirm the real wire shape without inventing parameter names. Counts
        // only, no PII — same discipline as the [notes]/[artifacts] logs.
        const cacheWrite = usage.cache_creation_input_tokens;
        const cacheRead = usage.cache_read_input_tokens;
        if (cacheWrite !== undefined || cacheRead !== undefined) {
          console.log(`[cache] write=${cacheWrite ?? 0} read=${cacheRead ?? 0} in=${inputTokens}`);
        } else {
          console.log(`[cache] no cache usage fields; usage keys=[${Object.keys(usage).join(",")}]`);
        }
      }
      if (chunk.type === "message_delta") {
        outputTokens = chunk.usage?.output_tokens || outputTokens;
      }
      writeEvent(chatStream, chunk);
    }
    
    writeDone(chatStream);
    chatStream.end();
    
    // Fire-and-forget usage log
    logUsage({
      userId: user.id,
      email: user.email,
      isTeacherUser,
      model: SCHOOL_CONFIG.defaultModel,
      inputTokens,
      outputTokens,
    });
  } catch (err) {
    console.error("Chat stream error:", safeErr(err));
    writeError(chatStream, err.message);
    chatStream.end();
  }
}
