import { loadConv, openGeneralChat } from './conversation.js';
import { getHwTasks } from './homework.js';
import { dateDiffDays } from './projects.js';
import { getStudentName } from './prompts.js';
import { renderSidebar } from './sidebar.js';
import { S, SB, messagesEl, msgInput } from './state.js';
import { getConvs } from './storage.js';
import { rdsFetch } from './teachers.js';
import { autoGrow, escHtml, openSidebar, updateSendBtn } from './ui.js';


export function showWelcome() {
  if (document.getElementById('welcome')) return;
  messagesEl.innerHTML = '';
  const name = getStudentName();
  const greeting = name !== 'there' ? `Welcome back, ${escHtml(name)}!` : `Hi, I'm Lumi!`;
  const w = document.createElement('div');
  w.className = 'empty-state'; w.id = 'welcome';
  w.innerHTML = `
    <div class="empty-orb">✦</div>
    <div class="empty-greeting">${greeting}</div>
    <div class="empty-sub">Pick up where you left off, or start something new.</div>
    <div class="empty-cards">
      <div class="empty-card" id="emptyGenBtn">
        <div class="empty-card-icon">💬</div>
        <div class="empty-card-title">General Chat</div>
        <div class="empty-card-sub">Just talk to Lumi about anything</div>
      </div>
      <div class="empty-card" id="emptyStudyBtn">
        <div class="empty-card-icon">📚</div>
        <div class="empty-card-title">Study with a Teacher</div>
        <div class="empty-card-sub">Pick a subject from the sidebar</div>
      </div>
    </div>`;
  messagesEl.appendChild(w);
  w.querySelector('#emptyGenBtn').addEventListener('click', openGeneralChat);
  w.querySelector('#emptyStudyBtn').addEventListener('click', () => {
    if (window.innerWidth <= 768) openSidebar();
    else { SB.expandedSubject = null; renderSidebar(); }
  });
}

// ─── EMPTY STATE WITH SUGGESTED PROMPTS ──────────────────────────────────────
function getHomeworkOverridePrompt(course) {
  const tasks = getHwTasks().filter(t =>
    !t.isComplete &&
    t.className === course &&
    t.dueDate
  );
  if (!tasks.length) return null;

  // Sort by due date, get soonest
  tasks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const task = tasks[0];

  const today = new Date().toISOString().slice(0, 10);
  const daysUntilDue = dateDiffDays(today, task.dueDate);

  // Only override if due in next 3 days
  if (daysUntilDue > 3) return null;

  // Format relative date
  let relativeDate;
  if (daysUntilDue <= 0) relativeDate = 'today';
  else if (daysUntilDue === 1) relativeDate = 'tomorrow';
  else {
    const dueDay = new Date(task.dueDate + 'T12:00:00');
    relativeDate = dueDay.toLocaleDateString('en-US', { weekday: 'long' });
  }

  return `Help me with ${task.title} (due ${relativeDate})`;
}

// Class-agnostic fallback chips. Used when the student has no teacher_notes
// or when influenced generation fails. Voice-neutral, no deficit framing.
const STATIC_FALLBACK_PROMPTS = [
  "Help me with today's homework",
  "Give me practice problems to work through",
  "Review what I've got so far",
  "Explain a concept I'm stuck on",
  "Quiz me on what we've been learning",
  "Walk me through a worked example",
  "Help me prep for an upcoming test",
  "Take me deeper on something we covered",
  "Push me with a harder version of this",
];

function getFallbackPrompts() {
  const pool = [...STATIC_FALLBACK_PROMPTS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

// Orchestrator. Notes-influenced chips are generated SERVER-SIDE (GET
// /suggested-prompts — the Lambda reads this student's notes and calls the
// model; notes never reach the browser). No notes / any failure → random
// static prompts. Caches result on S.tutorCtx.suggestedPrompts (JS memory
// only — never persisted). 8s client budget so chat-open never hangs on it.
export async function prepareSuggestedPrompts() {
  const ctx = S.tutorCtx;
  if (!ctx) return;
  const inj = ctx.notesInjection;
  if (inj?.teacher_profile_id) {
    try {
      const path = `suggested-prompts?teacher_profile_id=${encodeURIComponent(inj.teacher_profile_id)}`
        + `&course=${encodeURIComponent(ctx.course || '')}`;
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
      const res = await Promise.race([rdsFetch(path), timeout]);
      if (res?.mode === 'influenced' && Array.isArray(res.prompts) && res.prompts.length === 3) {
        ctx.suggestedPrompts = res.prompts;
        console.log('[suggested_prompts] mode=influenced count=3');
        return;
      }
    } catch (e) {
      console.warn('[suggested_prompts] influenced generation failed, falling back:', e?.message || e);
    }
  }
  ctx.suggestedPrompts = getFallbackPrompts();
  console.log('[suggested_prompts] mode=fallback count=' + ctx.suggestedPrompts.length);
}

export function renderEmptyState(profile, course) {
  // Source: chips prepared in finishOpenTutor (influenced or fallback).
  // Defensive fallback if renderEmptyState is somehow called outside that flow.
  let prompts = (S.tutorCtx?.suggestedPrompts && S.tutorCtx.suggestedPrompts.length === 3)
    ? [...S.tutorCtx.suggestedPrompts]
    : getFallbackPrompts();

  // Fisher–Yates shuffle so influenced chips don't always land in the same slots.
  for (let i = prompts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [prompts[i], prompts[j]] = [prompts[j], prompts[i]];
  }

  // Homework override: if a task is due in the next 3 days, replace position 0.
  const hwOverride = getHomeworkOverridePrompt(course);
  if (hwOverride) {
    prompts[0] = hwOverride;
  }

  // Skip the "Welcome back" greeting when the teacher's pinned welcome
  // card is already going to address the student — avoids double-greeting.
  const hasPinnedWelcome = !!profile?.welcome_message;
  const studentName = getStudentName();
  const showGreeting = !hasPinnedWelcome && studentName !== 'there';

  // "Where you left off" — most recent prior conv for this (course, teacher),
  // excluding the just-opened empty thread. Falls through silently if none.
  const teacher = S.tutorCtx?.teacher;
  const convs = getConvs();
  const priorConv = Object.values(convs)
    .filter(c => c.id !== S.currentId
      && c.tutorCtx?.course === course
      && c.tutorCtx?.teacher === teacher
      && (c.title || c.preview))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || null;

  // Card category tags — fixed slot mapping per design (visual only,
  // not derived from prompt content).
  const TAGS = ['STUDY', 'FEEDBACK', 'CONCEPT'];

  const el = document.createElement('div');
  el.className = 'empty-state-prompts';
  el.id = 'emptyStatePrompts';
  el.innerHTML = `
    ${showGreeting ? `<div class="esp-greeting">Welcome back, ${escHtml(studentName)}.</div>` : ''}
    <div class="esp-divider"><span>Your conversation will start below</span></div>
    <div class="esp-cards">
      ${prompts.map((p, i) => `
        <button class="esp-card" data-index="${i}">
          <div class="esp-card-tag">${TAGS[i] || ''}</div>
          <div class="esp-card-text">${escHtml(p)}</div>
        </button>`).join('')}
    </div>
    ${priorConv ? `
      <button class="esp-resume">
        <span class="esp-resume-label">Where you left off</span>
        <span class="esp-resume-title">${escHtml(priorConv.title || priorConv.preview || 'Previous conversation')}</span>
        <span class="esp-resume-arrow">→</span>
      </button>` : ''}
  `;

  // Wire card clicks
  el.querySelectorAll('.esp-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.index, 10);
      msgInput.value = prompts[idx];
      msgInput.focus();
      autoGrow(msgInput);
      updateSendBtn();
    });
  });

  // Wire "Where you left off" click — loadConv handles state + render.
  if (priorConv) {
    const resumeBtn = el.querySelector('.esp-resume');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => loadConv(priorConv.id));
    }
  }

  messagesEl.appendChild(el);
}
