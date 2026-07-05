import { S } from './state.js';


// ─── CLAUDE API PROXY ─────────────────────────────────────────────────────────
export const CLAUDE_PROXY_URL = 'https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws/';

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
export async function callAPI(msgs, system) {
  const res = await fetchClaudeProxy({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    stream: true,
    system,
    messages: msgs,
    // Server-side teacher-notes injection target (Lambda swaps the
    // <<LUMI_TEACHER_NOTES>> marker in `system`; notes never reach the client).
    ...(S.tutorCtx?.notesInjection ? { inject_teacher_notes: S.tutorCtx.notesInjection } : {}),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6); if (raw === '[DONE]') continue;
      try { const ev = JSON.parse(raw); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') full += ev.delta.text; } catch {}
    }
  }
  return parseResponse(full);
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
