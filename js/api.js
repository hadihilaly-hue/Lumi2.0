import { S } from './state.js';
import { CONFIG } from './config.js';


// ─── CLAUDE API PROXY ─────────────────────────────────────────────────────────
// AUDIT_FRONTEND F6: host now lives in js/config.js. Re-exported here so existing
// importers (e.g. teachers.js) keep working unchanged.
export const CLAUDE_PROXY_URL = CONFIG.claudeProxyUrl;

// Helper to make authenticated API calls to the Claude proxy
export async function fetchClaudeProxy(body, options = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated. Please sign in again.');
  }

  const res = await fetch(CLAUDE_PROXY_URL, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...options,
    method: 'POST',
  });

  // Handle rate limiting
  if (res.status === 429) {
    const errData = await res.json().catch(() => ({}));
    const match = errData.error?.match(/\((\d+)\/day\)/);
    const limit = match ? match[1] : '100';
    throw new Error(`You've hit today's Lumi limit (${limit} messages per day). Try again tomorrow!`);
  }

  return res;
}

// ─── API CALL ────────────────────────────────────────────────────────────────
export async function callAPI(msgs, system, onChunk) {
  const res = await fetchClaudeProxy({
    model: CONFIG.models.chat,
    max_tokens: 2500,
    stream: true,
    system,
    messages: msgs,
    // Server-side teacher-notes injection target (Lambda swaps the
    // <<LUMI_TEACHER_NOTES>> marker in `system`; notes never reach the client).
    ...(S.tutorCtx?.notesInjection ? { inject_teacher_notes: S.tutorCtx.notesInjection } : {}),
    // Q4 v2: server-side text work-artifacts injection (Lambda swaps the
    // <<LUMI_WORK_ARTIFACTS>> marker; artifact text never reaches the client).
    ...(S.tutorCtx?.artifactsInjection ? { inject_work_artifacts: S.tutorCtx.artifactsInjection } : {}),
    // Phase 5: same target drives the <<LUMI_PROGRESS_NOTE>> swap. The Lambda
    // gates it (OFF for real students) and the note never reaches the client;
    // for an ungated student the marker is simply stripped to nothing.
    ...(S.tutorCtx?.notesInjection ? { inject_progress_note: S.tutorCtx.notesInjection } : {}),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  let streamErr = null;
  outer:
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = consumeSseBuffer(buf);
    buf = rest;
    for (const ev of events) {
      if (ev.type === 'text') {
        full += ev.text;
        // Session 6: the caller renders as it arrives. Hand it only the text a
        // student should see — the trailing profile blob is stripped here the
        // same way parseResponse strips it from the final string.
        if (onChunk) { try { onChunk(streamVisibleText(full)); } catch (e) { console.warn('[stream] onChunk threw:', e); } }
      } else if (ev.type === 'error') {
        // Previously dropped on the floor: an error event carries no `type`, so
        // the old delta test skipped it and the stream ended with empty text.
        streamErr = ev.message; break outer;
      } else if (ev.type === 'done') {
        break outer;
      }
    }
  }
  if (streamErr) throw new Error(streamErr);
  return parseResponse(full);
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
// Pure. Takes everything decoded so far, returns the complete events found plus
// the unconsumed remainder — a partial line is held back for the next read, so a
// delta split across two network reads survives.
export function consumeSseBuffer(buffer) {
  const events = [];
  let rest = String(buffer ?? '');
  let nl;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6);
    if (raw === '[DONE]') { events.push({ type: 'done' }); continue; }
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }   // malformed line: skip, keep streaming
    if (ev && typeof ev.error === 'string') { events.push({ type: 'error', message: ev.error }); continue; }
    // Strict on purpose: real Bedrock/Anthropic deltas carry delta.type.
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      events.push({ type: 'text', text: ev.delta.text });
    }
  }
  return { events, rest };
}

// Pure. What the student should see mid-stream. The system prompt makes Lumi
// append a profile JSON blob after every reply; parseResponse strips it from the
// finished string, but mid-stream it would otherwise type itself out on screen.
// Hide from the last "\n{" when the tail is that blob — or any prefix of it,
// since it arrives a character at a time.
const PROFILE_START = '{"values"';
export function streamVisibleText(accumulated) {
  const text = String(accumulated ?? '');
  const i = text.lastIndexOf('\n{');
  if (i === -1) return text;
  const tail = text.slice(i + 1);
  const isBlob = tail.startsWith(PROFILE_START)
    || PROFILE_START.startsWith(tail.slice(0, PROFILE_START.length));
  return isBlob ? text.slice(0, i) : text;
}

// ─── PARSE ───────────────────────────────────────────────────────────────────
function parseResponse(text) {
  const lb = text.lastIndexOf('\n{');
  if (lb !== -1) {
    const cand = text.slice(lb + 1).trim();
    try {
      const p = JSON.parse(cand);
      if ('values' in p && 'goals' in p && 'interests' in p)
        return { clean: text.slice(0, lb).trim(), data: p };
    } catch {}
  }
  const m = text.match(/\n?\{"values"\s*:[\s\S]*?\}(?:\s*)$/);
  if (m) { try { return { clean: text.slice(0, text.length - m[0].length).trim(), data: JSON.parse(m[0].trim()) }; } catch {} }
  return { clean: text.trim(), data: null };
}
