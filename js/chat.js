import { callAPI, fetchClaudeProxy } from './api.js';
import { getProjects } from '../app.js';
import { todayStr } from './homework.js';
import { buildCompanionSystem, buildTutorSystem, teacherDisplayName, teacherInitials } from './prompts.js';
import { renderSidebar } from './sidebar.js';
import { $, S, _currentProjId, attachPreview, fileInput, messagesEl, msgInput, pendingAttachment, setPendingAttachment } from './state.js';
import { getConvs, saveConvs, saveCurrentConv, syncConvToSupabase } from './storage.js';
import { escHtml, showToast, updateSendBtn } from './ui.js';
import { _addSpeakerBtn } from './voice.js';


// ─── START LUMI (companion greeting) ────────────────────────────────────────
export async function startLumi() {
  if (S.ready) return;
  S.ready = true;
  const w = document.getElementById('welcome');
  if (w) w.remove();
  if (S.messages.length === 0) await fetchLumi();
}

// ─── ATTACHMENT HANDLING ─────────────────────────────────────────────────────
export function fmtBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

function clearAttachment() {
  setPendingAttachment(null);
  fileInput.value   = '';
  attachPreview.innerHTML = '';
  attachPreview.classList.remove('visible');
  updateSendBtn();
}

export function showAttachPreview(file, base64, mediaType, isImage) {
  attachPreview.innerHTML = '';
  if (isImage) {
    const img = document.createElement('img');
    img.className = 'attach-thumb';
    img.src = `data:${mediaType};base64,${base64}`;
    attachPreview.appendChild(img);
  } else {
    const ext  = file.name.split('.').pop().toUpperCase().slice(0, 4);
    const icon = document.createElement('div');
    icon.className = 'attach-file-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="attach-file-ext">${ext}</span>`;
    attachPreview.appendChild(icon);
  }
  const info = document.createElement('div');
  info.className = 'attach-info';
  info.innerHTML = `<div class="attach-name">${escHtml(file.name)}</div><div class="attach-size">${fmtBytes(file.size)}</div>`;
  const removeBtn = document.createElement('button');
  removeBtn.className = 'attach-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', clearAttachment);
  attachPreview.appendChild(info);
  attachPreview.appendChild(removeBtn);
  attachPreview.classList.add('visible');
}

export function handleFileSelect(file) {
  if (!file) return;
  const maxMB = file.type === 'application/pdf' ? 32 : 5;
  if (file.size > maxMB * 1024 * 1024) { showToast(`File too large. Max ${maxMB}MB.`); return; }
  const isImage = file.type.startsWith('image/');
  const isText  = file.type === 'text/plain' || file.name.endsWith('.txt');
  if (!isImage && file.type !== 'application/pdf' && !isText) { showToast('Unsupported file type.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const base64    = e.target.result.split(',')[1];
    const mediaType = file.type || 'text/plain';
    setPendingAttachment({ file, base64, mediaType, isImage, isText });
    showAttachPreview(file, base64, mediaType, isImage);
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

// ─── SEND ────────────────────────────────────────────────────────────────────
export async function doSend() {
  const text = msgInput.value.trim();
  if (!text && !pendingAttachment) return;
  // Remove prompt cards and empty state on first send
  const pc = $('generalPromptCards'); if (pc) pc.remove();
  const esp = $('emptyStatePrompts'); if (esp) esp.remove();
  if (S.busy) return;
  if (!S.ready) { S.ready = true; const w = document.getElementById('welcome'); if (w) w.remove(); }

  const att = pendingAttachment;
  let contentParts = [];
  if (att) {
    if (att.isImage) {
      contentParts.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.base64 } });
    } else if (att.isText) {
      const decoded = atob(att.base64);
      contentParts.push({ type: 'text', text: `[Attached file: ${att.file.name}]\n${decoded}` });
    } else {
      contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.base64 } });
    }
  }
  if (text) contentParts.push({ type: 'text', text });

  const msgContent = contentParts.length === 1 && contentParts[0].type === 'text'
    ? contentParts[0].text
    : contentParts;

  msgInput.value = ''; msgInput.style.height = 'auto';
  const sentAtt = att;
  clearAttachment();
  updateSendBtn();

  S.messages.push({ role: 'user', content: msgContent });
  saveCurrentConv();
  renderMsg('user', text, true, sentAtt);
  renderSidebar();
  await fetchLumi();
}

// ─── GENERATE TITLE ──────────────────────────────────────────────────────────
async function generateTitle(convId, firstUserMsg) {
  if (!firstUserMsg) return;
  const convs = getConvs();
  if (!convs[convId] || convs[convId].title) return;
  try {
    const prompt = `Generate a short 4-6 word title for this conversation. Just the title, nothing else, no punctuation at the end: ${firstUserMsg.slice(0, 300)}`;
    const res = await fetchClaudeProxy({ model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: prompt }] });
    if (!res.ok) return;
    const data  = await res.json();
    const title = data.content?.[0]?.text?.trim().replace(/[.!?]$/, '');
    if (title) {
      const c2 = getConvs();
      if (c2[convId]) {
        c2[convId].title = title;
        saveConvs(c2);
        syncConvToSupabase(convId);
        renderSidebar();
      }
    }
  } catch { /* non-critical */ }
}

// Q4: returns the messages array to send to Claude. If work-samples images
// are loaded for this session, prepends a synthetic user/assistant exchange
// that puts the images into the conversation as evidence. S.messages is
// NEVER mutated — this keeps the chat UI clean and persistence honest.
//
// Same gate as buildTutorSystem.hasAllTiers — null/empty/partial returns
// S.messages unchanged. Cache-control marker on the last image keeps the
// whole batch warm across turns of one session.
function buildApiMessages(S) {
  const ws = S && S.tutorCtx && S.tutorCtx.workSamples;
  const tiers = ['progressing','proficient','exemplary'];
  const ok = !!ws && tiers.every(t => ws[t] && Array.isArray(ws[t].images) && ws[t].images.length > 0);
  if (!ok) return S.messages;

  const tierLabel = { progressing: 'PROGRESSING-level samples:', proficient: 'PROFICIENT-level samples:', exemplary: 'EXEMPLARY-level samples:' };
  const userBlocks = [
    { type: 'text', text: 'Here are examples of how I grade student work, organized by performance level. Use these as evidence of my authentic feedback voice.' },
  ];
  tiers.forEach(tier => {
    userBlocks.push({ type: 'text', text: tierLabel[tier] });
    ws[tier].images.forEach(img => {
      userBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    });
  });
  // cache_control on the LAST image content block keeps the whole image
  // batch warm across turns of one session.
  const last = userBlocks[userBlocks.length - 1];
  if (last) userBlocks[userBlocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };

  const synthetic = [
    { role: 'user', content: userBlocks },
    { role: 'assistant', content: "Got it. I've studied your feedback across all three levels and I'll match your tone, word choice, and comment style when I give feedback to your students." },
  ];
  return [...synthetic, ...S.messages];
}

// ─── FETCH LUMI RESPONSE ─────────────────────────────────────────────────────
async function fetchLumi() {
  S.busy = true; updateSendBtn();
  const typing = makeTyping();
  messagesEl.appendChild(typing);
  scrollBottom();

  try {
    let system = S.tutorCtx
      ? buildTutorSystem(S.tutorCtx.subjectName, S.tutorCtx.course, S.tutorCtx.teacher, S.tutorCtx.teacherProfile || null, S.tutorCtx.workSamples || null)
      : buildCompanionSystem();

    // Inject active project context if the student is working on a project
    if (_currentProjId) {
      const proj = getProjects().find(p => p.id === _currentProjId);
      if (proj) {
        const today = todayStr();
        const todayTask = proj.plan.find(d => d.date === today && !d.isComplete);
        const taskLabel = todayTask ? todayTask.label : proj.plan[0]?.label || 'getting started';
        system += `\n\nACTIVE PROJECT CONTEXT:
The student is working on: ${proj.title}
Class: ${proj.className}
Due date: ${proj.dueDate}
Today's task: ${taskLabel}
${proj.requirements ? 'Requirements: ' + proj.requirements : ''}

If they uploaded a rubric or project instructions it will be attached to their first message — read it carefully and use it to guide your help throughout the conversation.

Remember: help them THINK through the project, never do it for them. Ask guiding questions, help them brainstorm, review their work, but the thinking must be theirs.`;
      }
    }
    const { clean, data } = await callAPI(buildApiMessages(S), system);
    typing.remove();
    S.messages.push({ role: 'assistant', content: clean });
    S.exchangeCount++;
    saveCurrentConv();
    renderMsg('lumi', clean, true);
    // TTS is opt-in per message via the speaker icon next to each Lumi
    // message — no auto-play. The previous `_voiceSetting !== 'off'`
    // auto-trigger here defaulted everyone to "hear" mode and surprised
    // students with audio they hadn't asked for. See _readVoiceSetting
    // TODO above for the broader cleanup.
    renderSidebar();
    if (data) applyProfile(data);
    if (S.exchangeCount === 1) {
      const firstUser = S.messages.find(m => m.role === 'user');
      const msgText = typeof firstUser?.content === 'string'
        ? firstUser.content
        : (Array.isArray(firstUser?.content) ? (firstUser.content.find(p => p.type === 'text')?.text || '') : '');
      if (msgText) generateTitle(S.currentId, msgText);
    }
  } catch (err) {
    typing.remove();
    const errMsg = err.message || 'Something went wrong.';
    renderError(`API error: ${errMsg}`);
    showToast(errMsg);
    console.error('Lumi API error:', err);
  } finally {
    S.busy = false; updateSendBtn();
  }
}

// Render a visible error bubble in the chat
function renderError(msg) {
  const el = document.createElement('div');
  el.className = 'msg lumi';
  el.innerHTML = `<div class="msg-bubble" style="background:rgba(255,80,80,.08);border-color:rgba(255,80,80,.25);color:#ff8585;">⚠️ ${escHtml(msg)}</div>`;
  messagesEl.appendChild(el);
  scrollBottom();
}

// ─── PROFILE ─────────────────────────────────────────────────────────────────
function applyProfile({ values = [], goals = [], interests = [] }) {
  let anyNew = false;
  const add = (arr, set) => {
    arr.forEach(raw => {
      if (!raw) return; const k = raw.toLowerCase().trim();
      if (!set.has(k)) { set.add(k); anyNew = true; }
    });
  };
  add(values, S.values); add(goals, S.goals); add(interests, S.interests);
  if (anyNew) saveCurrentConv();
}

// ─── RENDER TEACHER NOTE ────────────────────────────────────────────────────
// Pinned welcome card — sits at the top of every new tutor thread.
// Replaces the legacy renderTeacherNote + the auto-intro chat greeting.
// Reads profile.welcome_message when present (Phase 5b ships the column);
// falls back to a class-agnostic placeholder until then. Card is NOT a chat
// message: it's not pushed to S.messages, so it doesn't roundtrip through
// saveCurrentConv / loadConv — which is intentional. Continued threads
// (loaded from sidebar) re-enter via loadConv and never see this card,
// matching the design's "only at the start of new threads" rule.
export function renderPinnedWelcome(teacher, profile, course) {
  if (!teacher || !profile) return;

  const initials = teacherInitials(teacher);
  const dName = teacherDisplayName(teacher, profile);
  const tagName = dName.toUpperCase();
  const lastName = teacher.split(' ').slice(-1)[0] || '';
  const lastInitial = lastName[0] || '';
  const signoff = profile?.title
    ? `— ${profile.title} ${lastInitial}.`
    : `— ${initials}`;

  // Reads profile.welcome_message (Phase 5b column). When null — older
  // profiles pre-dating the column, or in-progress onboarding — fall back to
  // a short generic line so the card still has content. The teacher.html
  // home-card banner nudges teachers to fill this in.
  const bodyHtml = profile.welcome_message
    ? escHtml(profile.welcome_message)
        .split(/\n\n+/)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('')
    : `<p>Welcome to ${escHtml(course)}. Ask me anything!</p>`;

  const card = document.createElement('div');
  card.className = 'pinned-welcome';
  card.innerHTML = `
    <div class="pw-tape" aria-hidden="true"></div>
    <div class="pw-head">
      <div class="pw-avatar">${escHtml(initials)}</div>
      <div class="pw-head-text">
        <div class="pw-head-row">
          <span class="pw-name">${escHtml(dName)}</span>
          <span class="pw-tag">FROM ${escHtml(tagName)} · WRITTEN DURING SETUP</span>
        </div>
        <div class="pw-subline">Pinned to every new thread · they wrote this themselves, not AI</div>
      </div>
    </div>
    <div class="pw-divider"></div>
    <div class="pw-body">${bodyHtml}</div>
    <div class="pw-signoff">${escHtml(signoff)}</div>
  `;
  messagesEl.appendChild(card);
}

// ─── RENDER MESSAGE ──────────────────────────────────────────────────────────
export function renderMsg(role, content, animate, att) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (!animate) el.style.animation = 'none';

  if (role === 'lumi') {
    const hd = document.createElement('div'); hd.className = 'msg-head';
    const av = document.createElement('div'); av.className = 'msg-avatar';
    av.textContent = S.tutorCtx ? teacherInitials(S.tutorCtx.teacher) : '✦';
    const nm = document.createElement('span'); nm.className = 'msg-name';
    nm.textContent = S.tutorCtx ? teacherDisplayName(S.tutorCtx.teacher, S.tutorCtx.teacherProfile) : 'Lumi';
    hd.append(av, nm); el.appendChild(hd);
    // Speaker button + feedback row added after bubble is built (need text)
  }

  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';

  if (Array.isArray(content)) {
    content.forEach(part => {
      if (part.type === 'image' && part.source?.data) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = `data:${part.source.media_type};base64,${part.source.data}`;
        bubble.appendChild(img);
      } else if (part.type === 'document') {
        const chip = document.createElement('div');
        chip.className = 'msg-file-chip';
        chip.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF document`;
        bubble.appendChild(chip);
      } else if (part.type === 'text' && part.text) {
        const textNode = document.createElement('div');
        textNode.innerHTML = fmtText(part.text);
        bubble.appendChild(textNode);
      }
    });
  } else {
    if (att) {
      if (att.isImage) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = `data:${att.mediaType};base64,${att.base64}`;
        bubble.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'msg-file-chip';
        chip.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escHtml(att.file.name)}`;
        bubble.appendChild(chip);
      }
    }
    if (content) {
      const textNode = document.createElement('div');
      textNode.innerHTML = fmtText(content);
      bubble.appendChild(textNode);
    }
  }

  el.appendChild(bubble);
  messagesEl.appendChild(el);

  // Render LaTeX math in the message bubble
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(bubble, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    } catch (e) { console.warn('[KaTeX] render error:', e); }
  }

  if (animate) scrollBottom();

  // Add speaker button + feedback row to Lumi messages after bubble is in DOM
  if (role === 'lumi') {
    const plainText = typeof content === 'string' ? content
      : (Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '');
    if (plainText) _addSpeakerBtn(el, plainText);

    // Feedback row: thumbs up/down (visual stubs) + copy (functional).
    // Phase 6 sweep dropped the trailing label — design intent was buttons
    // alone; the "How would X rate this?" copy was ambiguous.
    const fbRow = document.createElement('div');
    fbRow.className = 'msg-feedback';
    fbRow.innerHTML = `
      <button class="msg-fb-btn" data-action="up" aria-label="Helpful">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22V11M2 13v7a2 2 0 0 0 2 2h13.5a2.5 2.5 0 0 0 2.4-1.8l2-7A2.5 2.5 0 0 0 19.5 10H14V5a3 3 0 0 0-3-3l-4 9z"/></svg>
      </button>
      <button class="msg-fb-btn" data-action="down" aria-label="Not helpful">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2v11M22 11V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4.1 3.8l-2 7A2.5 2.5 0 0 0 4.5 14H10v5a3 3 0 0 0 3 3l4-9z"/></svg>
      </button>
      <button class="msg-fb-btn" data-action="copy" aria-label="Copy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    `;
    fbRow.querySelectorAll('.msg-fb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'copy' && plainText && navigator.clipboard) {
          navigator.clipboard.writeText(plainText).then(
            () => showToast('Copied', 'ok'),
            () => showToast('Copy failed')
          );
          return;
        }
        // Visual flash for thumbs (real telemetry capture deferred).
        btn.classList.toggle('active');
      });
    });
    el.appendChild(fbRow);
  }
}

function fmtText(text) {
  if (!text) return '';

  // Protect math blocks from markdown processing (underscores, asterisks, etc.)
  const mathBlocks = [];
  let processed = text;
  // Display math first ($$...$$), then inline ($...$)
  processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (m) => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });
  processed = processed.replace(/\$([^\$\n]+?)\$/g, (m) => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });

  let html;
  if (typeof marked !== 'undefined') {
    html = marked.parse(processed, { breaks: true });
  } else {
    let s = processed.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code>$1</code>');
    const ps = s.split(/\n\n+/);
    html = ps.length > 1 ? ps.map(p => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('') : `<p>${s.replace(/\n/g,'<br>')}</p>`;
  }

  // Restore math blocks (may be inside <p>, <code>, etc. — KaTeX auto-render handles that)
  mathBlocks.forEach((block, i) => { html = html.replace(`\x00MATH${i}\x00`, block); });
  return html;
}

function makeTyping() {
  const wrap = document.createElement('div'); wrap.className = 'msg lumi typing-msg';
  const hd   = document.createElement('div'); hd.className = 'msg-head';
  const av   = document.createElement('div'); av.className = 'msg-avatar';
  av.textContent = S.tutorCtx ? teacherInitials(S.tutorCtx.teacher) : '✦';
  const nm   = document.createElement('span'); nm.className = 'msg-name';
  nm.textContent = S.tutorCtx
    ? teacherDisplayName(S.tutorCtx.teacher, S.tutorCtx.teacherProfile)
    : 'Lumi';
  hd.append(av, nm);

  // Subtext is dynamic when the just-sent user message had an attachment
  // (multimodal content array). Otherwise: plain "is thinking".
  // TODO (Phase 6 sweep): expand to a rotation tied to actual conversation
  // context — e.g. "cross-checking against doc 3" when a referenced document
  // exists, or topic-aware variants drawn from the active project / homework
  // task. Today's two-phrasing fallback is the minimum viable surface.
  const lastMsg = S.messages[S.messages.length - 1];
  const hasAttachment = Array.isArray(lastMsg?.content);
  const subtext = `${nm.textContent} is thinking${hasAttachment ? ' · reading your packet' : ''}`;

  const ind = document.createElement('div');
  ind.className = 'typing';
  ind.innerHTML = `<span class="typing-dot"></span><span class="typing-text">${escHtml(subtext)}</span>`;
  wrap.append(hd, ind);
  return wrap;
}

export function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
