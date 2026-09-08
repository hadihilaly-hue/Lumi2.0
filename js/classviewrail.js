// Class-view left rail (Session 3 per docs/STUDENT_HOME_REDESIGN.md §4.1.2 + §4.8).
// Renders three sections scoped to the currently-open class:
//   1. Conversation history: every past conv for this (course, teacher),
//      newest first. Tap → loadConv() (the exact path the old sidebar used).
//   2. Homework: activeHwForClass-style filter over getHwTasks().
//   3. Projects: getProjects().filter(p => p.className === course).
//
// The rail is collapsible via a header toggle. Collapsed by default on ≤640px,
// expanded on desktop. State survives navigation via localStorage.
//
// Test-mode isolation (TM-2): getConvs() already returns S.testConvs in test
// mode (js/storage.js), so per-class filtering just works. HW and projects are
// suppressed in test mode to match home.js's §4.5 override — a teacher isn't
// actually enrolled with real due work.
//
// Pure helpers below are unit-tested; the DOM render + wire-up is exercised at
// boot in the browser (spec §12.7).

import { loadConv, openTutor, lookupSubjectForCourse } from './conversation.js';
import { renderEmptyStatePanel, showChatSkeleton } from './emptystate.js';
import { getHwTasks, openHwBackdrop, showHwAddModal } from './homework.js';
import { getProjects, showProjectPlanModal, showProjectCreateModal } from './projects.js';
import { S, SB } from './state.js';
import { getConvs } from './storage.js';
import { showToast } from './ui.js';

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * List of prior conversations for a given (course, teacher), newest first.
 * `convs` is the raw map from getConvs() (id → conv). Returns an array of
 * conversation objects with a `ts` (fallback 0) and a display `label` (title
 * or preview). Excludes convs without any title/preview — matches how the
 * empty-state resume row is populated (js/emptystate.js:154-159).
 */
export function listConvsForClass(convs, course, teacher) {
  if (!convs || !course || !teacher) return [];
  const rows = Object.values(convs).filter(c =>
    c && c.tutorCtx
      && c.tutorCtx.course === course
      && c.tutorCtx.teacher === teacher
      && (c.title || c.preview)
  );
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows;
}

/**
 * List of incomplete homework tasks for a class, dueDate ascending (missing
 * dates last). Mirrors js/homework.js:activeHwForClass but returns the full
 * task list, not just the top-1.
 */
export function listHwForClass(tasks, course) {
  if (!Array.isArray(tasks) || !course) return [];
  const rows = tasks.filter(t => t && !t.isComplete && t.className === course);
  rows.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1);
  return rows;
}

/**
 * List of projects for a class, incomplete first, then by due date ascending.
 * The projects module already stores `className` on each project (see
 * js/projects.js:createProject), so per-class scoping is a clean filter.
 */
export function listProjectsForClass(projects, course) {
  if (!Array.isArray(projects) || !course) return [];
  const rows = projects.filter(p => p && p.className === course);
  rows.sort((a, b) => {
    if ((a.isComplete || false) !== (b.isComplete || false)) return a.isComplete ? 1 : -1;
    return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
  });
  return rows;
}

/**
 * Compact relative timestamp for the rail — mirrors home.js:relativeTs but
 * kept local to keep this module standalone for tests.
 */
export function railRelativeTs(ts, now = Date.now()) {
  if (!ts || typeof ts !== 'number') return '';
  const diff = Math.max(0, now - ts);
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < 4 * WEEK) return `${Math.floor(diff / WEEK)}w ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Collapse state ──────────────────────────────────────────────────────────
// Persist across nav so the student's preference sticks. Desktop-only: at
// ≤768px the rail is a slide-in drawer instead (see railIsDrawer below).

const COLLAPSE_KEY = 'lumi_classview_rail_collapsed';

function readCollapsedPref() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw === null) {
      // First visit — use viewport width to pick the default.
      if (typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(max-width: 640px)').matches) return true;
      return false;
    }
    return raw === '1';
  } catch { return false; }
}

function writeCollapsedPref(collapsed) {
  try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

// ── Mobile drawer (≤768px) ──────────────────────────────────────────────────
// Below RAIL_DRAWER_BP the rail is a slide-in drawer — same pattern as the
// mobile sidebar (fixed off-canvas, .open + scrim overlay, header toggle).
// Drawer state is transient; it never writes the desktop collapse pref.
export const RAIL_DRAWER_BP = 768;

export function railIsDrawer() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(`(max-width:${RAIL_DRAWER_BP}px)`).matches;
}

export function closeRailDrawer() {
  const rail = document.getElementById('classViewRail');
  const overlay = document.getElementById('cvRailOverlay');
  const toggle = document.getElementById('classViewRailToggle');
  if (rail) rail.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// ── Boot-hydration skeletons ────────────────────────────────────────────────
// The rail's datasets arrive at different times: conversations hydrate before
// the router mounts (storage.js), projects are local-only, and homework tasks
// stream in after first paint (projects.js:loadHwFromRds — non-blocking from
// app.js). While that fetch is unresolved the rail would paint empty
// sections, so each section shows shimmer rows until the hw store exists.
// RDS failures only log a warning (no event fires), so RAIL_SKELETON_MS is
// the ceiling: on error the skeleton settles to the real (empty) state.
const RAIL_SKELETON_MS = 6000;
const RAIL_SKELETON_POLL_MS = 300;
let _railSettled = false;
let _railSettleTimer = null;

export function localStoreHas(key) {
  try { return localStorage.getItem(key) !== null; } catch { return true; }
}

export function railDataPending() {
  if (_railSettled) return false;
  if (S.isTestMode || localStoreHas('lumi_hw_tasks')) { settleRail(false); return false; }
  return true;
}

// loadHwFromRds() writes the store without dispatching 'lumi:hw-changed', so
// poll the key on a short interval; the RAIL_SKELETON_MS ceiling doubles as
// the settle-on-error path (RDS failures only log a warning).
function armRailSettleWatch() {
  if (_railSettleTimer) return;
  const started = Date.now();
  _railSettleTimer = setInterval(() => {
    if (localStoreHas('lumi_hw_tasks') || S.isTestMode
        || Date.now() - started > RAIL_SKELETON_MS) settleRail(true);
  }, RAIL_SKELETON_POLL_MS);
}

function settleRail(rerender) {
  _railSettled = true;
  if (_railSettleTimer) { clearInterval(_railSettleTimer); _railSettleTimer = null; }
  if (rerender) refreshRail();
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'class') n.className = v;
    else if (k.startsWith('data-')) n.setAttribute(k, v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.appendChild(c);
  return n;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Compact due-date chip for HW rows in the rail.
function dueChip(dueDateStr, now = new Date()) {
  if (!dueDateStr) return '';
  const due = new Date(dueDateStr + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][due.getDay()];
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Section renderers ───────────────────────────────────────────────────────

function startNewChat(course, teacher) {
  // Route matches the existing sidebar "click a class" flow: openTutor()
  // resets S.messages, sets fresh tutorCtx, and hydrates the profile again.
  const { subjectId } = lookupSubjectForCourse(course);
  openTutor(subjectId, course, teacher);
}

function renderNewChatBtn(course, teacher) {
  const btn = el('button', {
    class: 'cv-rail-newchat',
    type: 'button',
    title: `Start a fresh conversation in ${course}`,
  });
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    <span>New chat in ${escHtml(course)}</span>`;
  btn.addEventListener('click', () => { closeRailDrawer(); startNewChat(course, teacher); });
  return btn;
}

// Shimmer rows while the hw boot-load is unresolved (see railDataPending).
function renderSkeletonSection(label, rows) {
  const section = el('section', { class: 'cv-rail-section' });
  section.appendChild(el('div', { class: 'cv-rail-section-label', text: label }));
  const list = el('div', { class: 'cv-rail-list' });
  for (let i = 0; i < rows; i++) {
    list.appendChild(el('div', { class: 'skel cv-rail-skel-row' }));
  }
  section.appendChild(list);
  return section;
}

function renderConvsSection(course, teacher) {
  const section = el('section', { class: 'cv-rail-section' });
  section.appendChild(el('div', { class: 'cv-rail-section-label', text: 'Chats' }));

  const list = el('div', { class: 'cv-rail-list' });
  const convs = getConvs();
  const rows = listConvsForClass(convs, course, teacher);

  if (!rows.length) {
    list.appendChild(renderEmptyStatePanel({
      title: 'No chats yet',
      compact: true,
      cta: { label: 'New chat', onClick: () => { closeRailDrawer(); startNewChat(course, teacher); } },
    }));
  } else {
    const now = Date.now();
    for (const conv of rows) {
      const isActive = conv.id === S.currentId;
      const label = conv.title || conv.preview || 'Untitled';
      const ts = railRelativeTs(conv.ts || 0, now);
      const item = el('button', {
        class: 'cv-rail-conv' + (isActive ? ' active' : ''),
        type: 'button',
        'data-id': conv.id,
      });
      item.appendChild(el('div', { class: 'cv-rail-conv-title', text: label }));
      if (ts) item.appendChild(el('div', { class: 'cv-rail-conv-meta', text: ts }));
      item.addEventListener('click', () => handleConvClick(conv.id));
      list.appendChild(item);
    }
  }
  section.appendChild(list);
  return section;
}

function handleConvClick(convId) {
  // Reuse the EXACT load path the old sidebar used (js/sidebar.js:442-452).
  // loadConv() rehydrates S.currentId/messages/tutorCtx, re-renders messages,
  // and awaits hydrateTutorProfile — the whole persona chain unchanged.
  closeRailDrawer();
  SB.mode = 'tutor';
  const convs = getConvs();
  const conv = convs[convId];
  if (conv?.tutorCtx) {
    SB.activeTeacher = {
      subjectId: conv.tutorCtx.subjectId,
      course: conv.tutorCtx.course,
      teacher: conv.tutorCtx.teacher,
    };
  }
  // loadConv lazy-fetches messages when the conv has an sbId but no cached
  // messages — shimmer bubbles fill that gap instead of a blank panel.
  if (conv && conv.sbId && !(conv.messages && conv.messages.length)) showChatSkeleton();
  loadConv(convId);
  // Re-render the rail so the newly-active row highlights.
  refreshActiveRow(convId);
}

function refreshActiveRow(newActiveId) {
  const inner = document.getElementById('classViewRailInner');
  if (!inner) return;
  inner.querySelectorAll('.cv-rail-conv').forEach(node => {
    if (node.getAttribute('data-id') === newActiveId) node.classList.add('active');
    else node.classList.remove('active');
  });
}

function renderHwSection(course, _teacher) {
  const section = el('section', { class: 'cv-rail-section' });
  section.appendChild(el('div', { class: 'cv-rail-section-label', text: 'Homework' }));

  const list = el('div', { class: 'cv-rail-list' });
  // TM override: no HW rows in test mode (§4.5 — noise for teacher).
  const rows = S.isTestMode ? [] : listHwForClass(getHwTasks(), course);

  if (!rows.length) {
    // 'Hidden in test mode' stays a plain line — hidden data isn't an
    // actionable empty state, so no CTA there.
    if (S.isTestMode) {
      list.appendChild(el('div', { class: 'cv-rail-empty', text: 'Hidden in test mode.' }));
    } else {
      list.appendChild(renderEmptyStatePanel({
        title: 'Nothing due right now.',
        compact: true,
        cta: {
          label: 'Add homework',
          onClick: () => { closeRailDrawer(); openHwBackdrop(); showHwAddModal(course); },
        },
      }));
    }
  } else {
    const now = new Date();
    for (const task of rows) {
      const item = el('div', { class: 'cv-rail-hw', 'data-hw-id': task.id || '' });
      item.appendChild(el('div', { class: 'cv-rail-hw-title', text: task.title || 'Task' }));
      const chipText = dueChip(task.dueDate, now);
      if (chipText) {
        item.appendChild(el('span', {
          class: 'cv-rail-hw-chip' + (chipText === 'overdue' || chipText === 'today' || chipText === 'tomorrow' ? ' urgent' : ''),
          text: chipText,
        }));
      }
      list.appendChild(item);
    }
  }
  section.appendChild(list);
  return section;
}

function renderProjectsSection(course, _teacher) {
  const section = el('section', { class: 'cv-rail-section' });
  section.appendChild(el('div', { class: 'cv-rail-section-label', text: 'Projects' }));

  const list = el('div', { class: 'cv-rail-list' });
  // TM override: no projects in test mode (parity with HW — a teacher isn't
  // enrolled with real project state).
  const rows = S.isTestMode ? [] : listProjectsForClass(getProjects(), course);

  if (!rows.length) {
    if (S.isTestMode) {
      list.appendChild(el('div', { class: 'cv-rail-empty', text: 'Hidden in test mode.' }));
    } else {
      list.appendChild(renderEmptyStatePanel({
        title: 'No active projects',
        compact: true,
        cta: {
          label: 'New project',
          onClick: () => { closeRailDrawer(); openHwBackdrop(); showProjectCreateModal({ className: course }); },
        },
      }));
    }
  } else {
    for (const proj of rows) {
      const item = el('button', {
        class: 'cv-rail-project' + (proj.isComplete ? ' complete' : ''),
        type: 'button',
        'data-proj-id': proj.id,
      });
      item.appendChild(el('div', { class: 'cv-rail-project-title', text: proj.title || 'Untitled project' }));
      const chipText = dueChip(proj.dueDate, new Date());
      const metaParts = ['Due ' + (chipText || (proj.dueDate || 'TBD'))];
      item.appendChild(el('div', { class: 'cv-rail-project-meta', text: metaParts.join(' · ') }));
      item.addEventListener('click', () => {
        closeRailDrawer();
        try { showProjectPlanModal(proj); }
        catch (e) {
          console.warn('[cv-rail] project plan open failed:', e);
          showToast('Could not open project plan.');
        }
      });
      list.appendChild(item);
    }
  }
  section.appendChild(list);
  return section;
}

// ── Mount / render ──────────────────────────────────────────────────────────

let _wiredToggle = false;
let _wiredRefreshListener = false;

function wireToggleOnce() {
  if (_wiredToggle) return;
  const btn = document.getElementById('classViewRailToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const rail = document.getElementById('classViewRail');
    if (!rail) return;
    if (railIsDrawer()) {
      const open = rail.classList.toggle('open');
      const overlay = document.getElementById('cvRailOverlay');
      if (overlay) overlay.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    const isCollapsed = rail.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    writeCollapsedPref(isCollapsed);
  });
  const overlay = document.getElementById('cvRailOverlay');
  if (overlay) overlay.addEventListener('click', closeRailDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && railIsDrawer()) closeRailDrawer();
  });
  _wiredToggle = true;
}

// Listen for the 'lumi:conv-changed' custom event. conversation.js dispatches
// this from loadConv / finishOpenTutor / newChat so the rail can update the
// active-row highlight without needing a direct import (which would introduce
// a cycle: classviewrail.js already imports conversation.js).
function wireRefreshListenerOnce() {
  if (_wiredRefreshListener) return;
  if (typeof document === 'undefined' || !document.addEventListener) return;
  document.addEventListener('lumi:conv-changed', () => refreshRail());
  // 'lumi:hw-changed' fires whenever the hw store is written (homework.js).
  // It settles the boot skeleton AND refreshes the Homework section — the
  // rail otherwise never sees hw rows that arrive after first paint.
  document.addEventListener('lumi:hw-changed', () => { settleRail(false); refreshRail(); });
  _wiredRefreshListener = true;
}

/**
 * Render the rail for the given (course, teacher). Called by classview.js
 * mountClass() after the chat panel is shown. Idempotent — safe to re-call on
 * hashchange, back/forward, or a redundant nav.
 */
export function mountRail(course, teacher) {
  const rail = document.getElementById('classViewRail');
  const inner = document.getElementById('classViewRailInner');
  const toggle = document.getElementById('classViewRailToggle');
  if (!rail || !inner || !course || !teacher) return;

  wireToggleOnce();
  wireRefreshListenerOnce();

  // Toggle button visibility — this is a redesign-flag-only affordance; the
  // old sidebar handles nav under flag-off, so keep the button hidden then.
  const homeFlag = !!S.homeRedesign;
  if (toggle) toggle.style.display = homeFlag ? '' : 'none';

  if (!homeFlag) {
    // Flag off: rail stays invisible. Sidebar handles everything.
    rail.style.display = 'none';
    return;
  }

  rail.style.display = '';

  if (railIsDrawer()) {
    // Drawer mode: stays closed until the header toggle opens it; the
    // collapse pref (and its width:0 rule) is desktop-only.
    rail.classList.remove('collapsed');
    closeRailDrawer();
  } else {
    // Restore collapsed pref (first mount → viewport-based default).
    const collapsed = readCollapsedPref();
    rail.classList.toggle('collapsed', collapsed);
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  // Re-render inner contents. Cheap — a handful of DOM nodes per section.
  inner.innerHTML = '';
  inner.appendChild(renderNewChatBtn(course, teacher));
  if (railDataPending()) {
    armRailSettleWatch();
    inner.appendChild(renderSkeletonSection('Chats', 3));
    inner.appendChild(renderSkeletonSection('Homework', 2));
    inner.appendChild(renderSkeletonSection('Projects', 2));
    return;
  }
  inner.appendChild(renderConvsSection(course, teacher));
  inner.appendChild(renderHwSection(course, teacher));
  inner.appendChild(renderProjectsSection(course, teacher));
}

/**
 * Hide the rail (called from home mount / unmount paths). Sibling API to
 * mountRail so classview.js has both mount + unmount handles.
 */
export function unmountRail() {
  const rail = document.getElementById('classViewRail');
  const toggle = document.getElementById('classViewRailToggle');
  closeRailDrawer();
  if (rail) rail.style.display = 'none';
  if (toggle) toggle.style.display = 'none';
}

/**
 * Re-render only the conversation list — used after loadConv() to update the
 * "active" highlight without rebuilding HW/projects. Exposed for the callers
 * that mutate S.currentId (loadConv, openTutor).
 */
export function refreshRail() {
  const ctx = S.tutorCtx;
  if (!ctx || !ctx.course || !ctx.teacher) return;
  const inner = document.getElementById('classViewRailInner');
  if (!inner) return;
  // Only re-render if the rail is actually mounted (visible).
  const rail = document.getElementById('classViewRail');
  if (!rail || rail.style.display === 'none') return;
  mountRail(ctx.course, ctx.teacher);
}
