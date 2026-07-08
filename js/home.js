// Student home grid (docs/STUDENT_HOME_REDESIGN.md §4.1.1). Renders one card
// per enrolled class; tapping a ready card routes to that class's view.
//
// Layout translates design-handoff/home-v2/Lumi Home.dc.html — the mockup is
// a static rendering target; its {{ }} placeholders, support.js runtime, and
// hardcoded persona strings are never copied.
//
// Session 2 wires (§12.8):
//   • "Where you left off" line from getConvs() filtered by tutorCtx
//     (course, teacher) — §2.1 v1 fallback.
//   • "Next due" chip from getHwTasks() filtered by className — §2.2.
//   • Priority sort v1: urgent-HW → recency → alpha — §4.2, D3-A.
//   • Red urgent dot on cards with HW due ≤24h — §4.2, D3-A.
//   • Test mode preserves D10-B (ready first, locked second, alpha within).
//   • Empty-state D1-B "Say hi to [teacher]" chip when no conv + no HW.
//
// Session 1.5+2, commit 3/4:
//   • Greeting header: name from localStorage.lumi_name, time-of-day, date,
//     count line "N things due this week across M classes".
//   • Due-soon strip: next ~4 items across all classes, urgent styling ≤24h.
//   • Quick actions: Tonight's Study Plan (stubbed disabled) + General Chat.
//   • Deterministic accent-bar palette hashed from course name.
//   • Client-side search filter over the visible grid.
//
// Deferred to later sessions:
//   Session 6: tomorrow-schedule peek (D4-A hidden silently until then).

import { openGeneralChat } from './conversation.js';
import { navClass } from './router.js';
import { S } from './state.js';
import { getConvs, getSchedule } from './storage.js';
import { getHwTasks } from './homework.js';
import { _profileStatusCache } from './teachers.js';
import { showToast } from './ui.js';

// ── Utilities ───────────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k.startsWith('data-')) n.setAttribute(k, v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.appendChild(c);
  return n;
}

// Cheap teacher display line for cards. Not the same as prompts.js's
// teacherDisplayName, which needs a hydrated profile with a `title`. Cards
// render from schedule/directory only, so we fall back to last-name-only —
// which is what teacherDisplayName also returns without a profile.
function displayTeacher(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName;
  return parts[parts.length - 1];
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Compact relative timestamp: "2m ago", "3h ago", "yesterday", "3d ago",
 * "2w ago". Anything past 4 weeks returns "" (the caller drops the line —
 * an ancient conv isn't useful context).
 *
 * `now` is injectable so tests are deterministic.
 */
export function relativeTs(ts, now = Date.now()) {
  if (!ts || typeof ts !== 'number') return '';
  const diff = Math.max(0, now - ts);
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < 4 * WEEK) return `${Math.floor(diff / WEEK)}w ago`;
  return '';
}

/**
 * "Due" label for the next-due chip. Days-based (matches how due dates are
 * stored — ISO date strings, no time-of-day).
 *   today       → "today"
 *   tomorrow    → "tomorrow"
 *   this week   → "Mon" / "Tue" / …
 *   further out → "Jun 24"
 *   past due    → "overdue"
 */
export function dueLabel(dueDateStr, now = new Date()) {
  if (!dueDateStr) return '';
  const due = new Date(dueDateStr + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][due.getDay()];
  }
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Is the given ISO dueDate within 24h of now? Anything overdue also counts as
 * urgent (spec §4.2: "task with dueDate ≤ now + 24h"). Uses whole-day math —
 * matches the storage granularity.
 */
export function isUrgentDue(dueDateStr, now = new Date()) {
  if (!dueDateStr) return false;
  const due = new Date(dueDateStr + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / (24 * 60 * 60 * 1000));
  return days <= 1;
}

/**
 * "Good morning/afternoon/evening" based on local hour. Injectable for tests.
 *   < 12  → morning
 *   < 17  → afternoon
 *   else  → evening
 */
export function timeOfDayGreeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

/**
 * Deterministic 8-slot accent-bar palette seeded from the mockup's colors.
 * Same course name → same color across every render, so students learn to
 * recognize their classes by tile hue. `hashPalette` is pure.
 */
export const ACCENT_PALETTE = [
  '#C76D3D', '#6B8A6B', '#4A7A7A', '#3D6AAB',
  '#9A6B4A', '#B8893D', '#8A5A6B', '#7A8A4A',
];
export function hashPalette(course, palette = ACCENT_PALETTE) {
  const s = String(course || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % palette.length;
  return palette[idx];
}

/**
 * "N things due this week across M classes". Returns { things, classes,
 * sentence } — the sentence is null when there is no due HW to summarize,
 * so the caller renders no subline.
 */
export function weekSummary(tasks, scheduleLen, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() + 7);
  const inWindow = tasks.filter(t => {
    if (!t || t.isComplete || !t.dueDate) return false;
    const d = new Date(t.dueDate + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return false;
    return d >= today && d <= cutoff;
  });
  const things = inWindow.length;
  const classes = scheduleLen | 0;
  if (things === 0) return { things: 0, classes, sentence: null };
  const noun = things === 1 ? 'thing' : 'things';
  const cnoun = classes === 1 ? 'class' : 'classes';
  const sentence = `You have <strong>${things} ${noun}</strong> due this week across ${classes} ${cnoun}.`;
  return { things, classes, sentence };
}

/**
 * Pick the next N (default 4) incomplete tasks with a real dueDate across
 * all classes, ordered by dueDate asc. Each entry keeps the task and adds
 * `isUrgent` for the ≤24h styling. `now` injectable for tests.
 */
export function pickDueSoon(tasks, n = 4, now = new Date()) {
  const rows = tasks.filter(t => t && !t.isComplete && t.dueDate);
  rows.sort((a, b) => a.dueDate < b.dueDate ? -1 : 1);
  return rows.slice(0, n).map(t => ({ task: t, isUrgent: isUrgentDue(t.dueDate, now) }));
}

// ── Data collection ─────────────────────────────────────────────────────────

/**
 * Newest prior conversation for (course, teacher). Same filter shape as
 * emptystate.js:154-159 (§2.1 step 2). Returns null when none.
 */
function findLastConv(convs, course, teacher) {
  const rows = Object.values(convs).filter(c =>
    c && c.tutorCtx && c.tutorCtx.course === course
      && c.tutorCtx.teacher === teacher
      && (c.title || c.preview)
  );
  if (!rows.length) return null;
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows[0];
}

/**
 * Next incomplete homework task for a given class name. Returns null when
 * none. Sort matches homework.js:activeHwForClass — dueDate ascending, missing
 * dates last. Raw task shape kept so the card can render title + due chip.
 */
function findNextHw(tasks, course) {
  const rows = tasks.filter(t => t && !t.isComplete && t.className === course);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1);
  return rows[0];
}

/**
 * Build the card list from S.schedule (or S.testSchedule in test mode).
 * Each entry: {course, teacher, block, ready, lastConv, nextHw, hasUrgentHw}.
 *
 * `ready` sourcing (spec §2.3):
 *  - Test mode: honor the `ready` flag baked onto each S.testSchedule entry
 *    by loadTestModeSchedule (it knows the teacher's own profile.done state).
 *  - Student mode: use _profileStatusCache from teachers.js
 *    (preloadProfileStatuses fills it — 'ready' | 'pending'). Missing entries
 *    default to READY so a cold cache doesn't lock every card.
 *
 * `now` is injectable so the urgent-HW calc is testable.
 */
export function buildCards(now = new Date()) {
  const schedule = S.isTestMode ? (S.testSchedule || []) : getSchedule();
  const convs = getConvs();
  // In test mode, don't decorate cards with per-class homework — the teacher
  // isn't actually enrolled, so any HW rows are noise (matches §4.2 test-mode
  // override: "no dot, no ring").
  const tasks = S.isTestMode ? [] : getHwTasks();

  return schedule.map(entry => {
    const ready = S.isTestMode
      ? entry.ready !== false
      : (_profileStatusCache[`${entry.course}::${entry.teacher}`] !== 'pending');
    const lastConv = findLastConv(convs, entry.course, entry.teacher);
    const nextHw = findNextHw(tasks, entry.course);
    const hasUrgentHw = !!(nextHw && isUrgentDue(nextHw.dueDate, now));
    return {
      course: entry.course,
      teacher: entry.teacher,
      block: entry.block || '',
      ready,
      lastConv,
      nextHw,
      hasUrgentHw,
    };
  });
}

/**
 * Priority sort v1 per §4.2 + D3-A. Ascending → top of grid.
 *   1. Cards with hasUrgentHw first, by their most-urgent task's dueDate.
 *   2. Remaining cards by "most recently used" (lastConv.ts desc).
 *   3. Alphabetical by course name as final tie-break.
 *
 * Test-mode override (§4.2 + D10-B): ignore urgent/recency; ready first,
 * locked second, alphabetical within each.
 */
export function sortCards(cards, isTestMode) {
  const byCourse = (a, b) => String(a.course).localeCompare(String(b.course));
  if (isTestMode) {
    return [...cards].sort((a, b) => {
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      return byCourse(a, b);
    });
  }
  return [...cards].sort((a, b) => {
    if (a.hasUrgentHw !== b.hasUrgentHw) return a.hasUrgentHw ? -1 : 1;
    if (a.hasUrgentHw && b.hasUrgentHw) {
      const da = a.nextHw?.dueDate || '9999';
      const db = b.nextHw?.dueDate || '9999';
      if (da !== db) return da < db ? -1 : 1;
    }
    const ta = a.lastConv?.ts || 0;
    const tb = b.lastConv?.ts || 0;
    if (ta !== tb) return tb - ta;
    return byCourse(a, b);
  });
}

// ── Card rendering ──────────────────────────────────────────────────────────

// Course-name → 1-char glyph for the icon tile. Falls back to the first letter
// of the course. Deterministic and pure so tests / snapshots are stable.
function courseGlyph(course) {
  const c = String(course || '').trim();
  if (!c) return '·';
  return c[0].toUpperCase();
}

/**
 * Text for the snippet line. Precedence per §2.1 + §9 D1-B:
 *   • last-conv title (or preview) → "…"
 *   • otherwise the D1-B static "Say hi to [teacher]" chip.
 * Timestamp is NOT rendered inline — the mockup uses a single-line ellipsised
 * snippet, and the fresh-vs-stale signal already lives in the recency sort.
 */
function snippetText(card) {
  if (card.lastConv) {
    return card.lastConv.title || card.lastConv.preview || '';
  }
  const t = displayTeacher(card.teacher) || 'your teacher';
  return `Say hi to ${t}`;
}

/**
 * Chip content for the bottom-of-card row. Priority:
 *   • locked → nothing (the "Setting up" lock label lives elsewhere).
 *   • has next-due HW → "Due [label] · [title]" (title truncated).
 *   • no HW at all → "All caught up" (muted).
 */
function renderChip(card) {
  if (!card.nextHw) {
    return el('span', {
      class: 'home-card-chip home-card-chip--caughtup',
      text: 'All caught up',
    });
  }
  const label = dueLabel(card.nextHw.dueDate);
  const title = String(card.nextHw.title || '').trim();
  const truncTitle = title.length > 28 ? title.slice(0, 27) + '…' : title;
  const chipText = label
    ? `Due ${label}${truncTitle ? ' · ' + truncTitle : ''}`
    : (truncTitle || 'Task pending');
  const cls = 'home-card-chip' + (card.hasUrgentHw ? ' home-card-chip--urgent' : '');
  return el('span', { class: cls, text: chipText });
}

function renderCard(card) {
  const titles = el('div', { class: 'home-card-titles' }, [
    el('div', { class: 'home-card-course', text: card.course }),
    el('div', {
      class: 'home-card-meta',
      text: [displayTeacher(card.teacher), card.block ? 'Block ' + card.block : '']
        .filter(Boolean).join(' · '),
    }),
  ]);
  const headChildren = [
    el('div', { class: 'home-card-icon', text: courseGlyph(card.course) }),
    titles,
  ];
  if (card.hasUrgentHw) {
    headChildren.push(el('span', { class: 'home-card-dot', 'aria-label': 'Due soon' }));
  }
  const head = el('div', { class: 'home-card-head' }, headChildren);

  const snippetString = snippetText(card);
  const snippet = el('div', { class: 'home-card-snippet' }, [
    el('span', { class: 'home-card-snippet-bullet' }),
    el('span', { class: 'home-card-snippet-text', text: snippetString }),
  ]);
  if (!snippetString) snippet.style.display = 'none';

  const chipRow = el('div', { class: 'home-card-chip-row' });
  if (!card.ready) {
    chipRow.appendChild(el('span', { class: 'home-card-lock', text: 'Setting up' }));
  } else {
    chipRow.appendChild(renderChip(card));
  }

  const body = el('div', { class: 'home-card-body' }, [head, snippet, chipRow]);
  const accent = el('div', { class: 'home-card-accent' });
  accent.style.background = hashPalette(card.course);

  const cls = ['home-card'];
  if (!card.ready) cls.push('home-card--locked');
  if (card.ready && card.hasUrgentHw) cls.push('home-card--urgent');

  const node = el('button', {
    class: cls.join(' '),
    'data-course': card.course,
    'data-teacher': card.teacher,
    type: 'button',
  }, [accent, body]);

  node.addEventListener('click', () => {
    if (card.ready) {
      // Ready card → route into the class view.
      navClass(card.course, card.teacher);
      return;
    }
    // Locked card behavior — spec §4.5 TM-3 vs §9 D12-A.
    if (S.isTestMode) {
      // Test mode: route the teacher to their own onboarding for this class.
      const params = new URLSearchParams({ course: card.course, from: 'test-mode' });
      window.location.href = `teacher.html?${params.toString()}`;
      return;
    }
    // Student mode: quiet toast; the card stays visible so enrollment isn't
    // silently dropped from the student's mental model.
    showToast('Your teacher is still setting up.');
  });

  return node;
}

// ── Greeting header ─────────────────────────────────────────────────────────

/**
 * Populate the greeting title + subline from real data. The subline reads
 * "Wednesday, July 8 · You have N things due this week across M classes."
 * Count line is omitted when there are no due tasks.
 */
function renderGreeting() {
  const titleEl = document.getElementById('homeGreetingTitle');
  const subEl = document.getElementById('homeGreetingSub');
  if (!titleEl || !subEl) return;

  const rawName = (typeof localStorage !== 'undefined'
    ? (localStorage.getItem('lumi_name') || '')
    : '').trim();
  const first = rawName ? rawName.split(/\s+/)[0] : '';
  const now = new Date();
  const tod = timeOfDayGreeting(now);
  titleEl.textContent = first ? `Good ${tod}, ${first}` : `Good ${tod}`;

  const date = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  // In test mode we deliberately suppress the "N things due" line — the
  // teacher isn't actually enrolled, so any HW rows are noise (§4.5).
  const tasks = S.isTestMode ? [] : getHwTasks();
  const scheduleLen = S.isTestMode
    ? (S.testSchedule || []).length
    : getSchedule().length;
  const { sentence } = weekSummary(tasks, scheduleLen, now);
  subEl.innerHTML = sentence
    ? `${escHtml(date)} · ${sentence}`
    : escHtml(date);
}

// ── Due-soon strip ──────────────────────────────────────────────────────────

function renderDueStrip() {
  const section = document.getElementById('homeDueSection');
  const strip = document.getElementById('homeDueStrip');
  if (!section || !strip) return;

  // Test mode suppresses the strip (§4.5 — HW rows are noise for a teacher).
  if (S.isTestMode) { section.style.display = 'none'; return; }

  const now = new Date();
  const items = pickDueSoon(getHwTasks(), 4, now);
  strip.innerHTML = '';
  if (items.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  for (const { task, isUrgent } of items) {
    const dueDate = new Date(task.dueDate + 'T00:00:00');
    const dayAbbrev = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dueDate.getDay()];
    const dayNum = String(dueDate.getDate()).padStart(2, '0');
    const badge = el('div', { class: 'home-due-badge' }, [
      el('span', { class: 'home-due-badge-day', text: dayAbbrev }),
      el('span', { class: 'home-due-badge-num', text: dayNum }),
    ]);
    const when = dueLabel(task.dueDate, now);
    const whenTitle = when ? when[0].toUpperCase() + when.slice(1) : '';
    const metaParts = [whenTitle, task.className || ''].filter(Boolean);
    const text = el('div', { class: 'home-due-text' }, [
      el('div', { class: 'home-due-title', text: task.title || 'Task' }),
      el('div', { class: 'home-due-meta', text: metaParts.join(' · ') }),
    ]);
    const card = el('button', {
      class: 'home-due-card' + (isUrgent ? ' home-due-card--urgent' : ''),
      type: 'button',
      'data-hw-id': task.id || '',
    }, [badge, text]);
    // Tap → navigate to the class view for that task; the HW panel wiring
    // (scroll-to-task) is Session 3 territory (§4.8).
    card.addEventListener('click', () => {
      const schedule = getSchedule();
      const match = schedule.find(s => s.course === task.className);
      if (match) navClass(match.course, match.teacher);
      else showToast(`No matching class on your schedule for "${task.className || 'this task'}".`);
    });
    strip.appendChild(card);
  }
}

// ── Quick actions ───────────────────────────────────────────────────────────

// Small SVG icons (calendar / speech-bubble) inlined so we don't depend on an
// icon library. Same shapes as the mockup.
const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function renderQuickActions() {
  const row = document.getElementById('homeQuickActions');
  if (!row) return;
  row.innerHTML = '';
  // Suppress in test mode — the strip is scoped to real student surfaces.
  if (S.isTestMode) { row.style.display = 'none'; return; }
  row.style.display = '';

  // Tonight's Study Plan — Hadi's decision: STUB disabled (Session 4 wire).
  const plan = el('button', {
    class: 'home-qa home-qa--navy',
    type: 'button',
    disabled: 'disabled',
    'aria-disabled': 'true',
    title: 'Coming soon',
  }, [
    el('div', { class: 'home-qa-icon', html: ICON_CAL }),
    el('div', { class: 'home-qa-body' }, [
      el('div', { class: 'home-qa-title', text: "Tonight's Study Plan" }),
      el('div', { class: 'home-qa-sub', text: 'Coming soon — Session 4' }),
    ]),
  ]);
  row.appendChild(plan);

  // General Chat — wire to the existing openGeneralChat() in conversation.js.
  // Small in-flight stopgap: reuse #classViewHeader with "General Chat" label
  // so the back button is still visible. Proper #general router route lands
  // in Session 4 (§4.1.3).
  const chat = el('button', {
    class: 'home-qa home-qa--cream',
    type: 'button',
  }, [
    el('div', { class: 'home-qa-icon', html: ICON_CHAT }),
    el('div', { class: 'home-qa-body' }, [
      el('div', { class: 'home-qa-title', text: 'General Chat' }),
      el('div', { class: 'home-qa-sub', text: 'Chat with Lumi across your classes.' }),
    ]),
  ]);
  chat.addEventListener('click', () => {
    const home = document.getElementById('homeView');
    const panel = document.getElementById('chatPanel');
    const header = document.getElementById('classViewHeader');
    const courseEl = document.getElementById('classViewCourse');
    const teacherEl = document.getElementById('classViewTeacher');
    if (home) home.style.display = 'none';
    if (courseEl) courseEl.textContent = 'General Chat';
    if (teacherEl) teacherEl.textContent = 'Across your classes';
    if (header) header.style.display = '';
    if (panel) panel.style.display = '';
    openGeneralChat();
  });
  row.appendChild(chat);
}

// ── Search filter ───────────────────────────────────────────────────────────

let _searchWired = false;
function wireSearchOnce() {
  if (_searchWired) return;
  const input = document.getElementById('homeSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const grid = document.getElementById('homeGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.home-card');
    for (const c of cards) {
      const course = String(c.getAttribute('data-course') || '').toLowerCase();
      const teacher = String(c.getAttribute('data-teacher') || '').toLowerCase();
      const match = !q || course.includes(q) || teacher.includes(q);
      c.style.display = match ? '' : 'none';
    }
  });
  _searchWired = true;
}

// ── HTML escape ─────────────────────────────────────────────────────────────
// Tiny helper for the greeting subline (we set .innerHTML so <strong> renders).
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Screen mount ────────────────────────────────────────────────────────────

/** (Re)render the grid inside #homeGrid. */
export function renderHome() {
  const grid = document.getElementById('homeGrid');
  if (!grid) return;
  const cards = sortCards(buildCards(), S.isTestMode);
  grid.innerHTML = '';

  if (cards.length === 0) {
    // Empty-schedule state. In practice the boot flow already routes new users
    // through the schedule wizard before app.js hands off to the router.
    grid.appendChild(el('div', { class: 'home-empty', text: 'No classes on your schedule yet.' }));
    return;
  }

  for (const card of cards) grid.appendChild(renderCard(card));
}

/** Show the home view and render it. Called by the router on 'home' route. */
export function mountHome() {
  const home = document.getElementById('homeView');
  const chat = document.getElementById('chatPanel');
  const header = document.getElementById('classViewHeader');
  const rail = document.getElementById('classViewRail');
  const railToggle = document.getElementById('classViewRailToggle');
  if (home) home.style.display = '';
  if (chat) chat.style.display = 'none';
  if (header) header.style.display = 'none';
  // Session 3: the rail is scoped to a class view; hide it whenever we return
  // to the home grid (routed via navHome / Back button).
  if (rail) rail.style.display = 'none';
  if (railToggle) railToggle.style.display = 'none';
  renderGreeting();
  renderDueStrip();
  renderQuickActions();
  renderHome();
  wireSearchOnce();
}

/** Hide the home view. The router calls this before mounting a class view. */
export function unmountHome() {
  const home = document.getElementById('homeView');
  if (home) home.style.display = 'none';
}
