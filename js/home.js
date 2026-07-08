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
// Deferred to later sessions:
//   Commit 3/4: due-soon strip + greeting + General Chat card + accent-bar
//     palette hash.
//   Session 6: tomorrow-schedule peek (D4-A hidden silently until then).

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
  if (home) home.style.display = '';
  if (chat) chat.style.display = 'none';
  if (header) header.style.display = 'none';
  renderHome();
}

/** Hide the home view. The router calls this before mounting a class view. */
export function unmountHome() {
  const home = document.getElementById('homeView');
  if (home) home.style.display = 'none';
}
