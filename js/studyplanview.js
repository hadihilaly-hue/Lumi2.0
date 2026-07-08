// Tonight's Study Plan — full-surface view for the redesigned home
// (docs/STUDENT_HOME_REDESIGN.md §12.11 v1).
//
// Same nav pattern as classview.js: mount owns show/hide of #studyPlanView,
// #homeView, #chatPanel, and #classViewHeader. Back button routes home via
// the shared router.
//
// Everything mounted here is READ-ONLY relative to real state:
//   • Reads getHwTasks() + getSchedule() (or S.testSchedule in test mode).
//   • Writes ONLY to localStorage under a date-stamped key
//     ('lumi_study_plan_checked_YYYY-MM-DD') via studyplan.saveCheckedMap.
//   • Never mutates lumi_hw_tasks or triggers /homework-tasks writes — the
//     checkboxes are visual only (§ prompt spec: "does NOT mutate real
//     homework — visual only, with a small hint linking to the real
//     homework-complete flow if one exists").

import { unmountHome } from './home.js';
import { showHwPopup, getHwTasks } from './homework.js';
import { navHome } from './router.js';
import { S } from './state.js';
import { getSchedule } from './storage.js';
import {
  buildStudyPlan, planHeader, remainingTotals, formatDuration,
  loadCheckedMap, saveCheckedMap,
} from './studyplan.js';

// ── Tiny DOM helper (mirrors home.js) ───────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k.startsWith('data-') || k === 'aria-label' || k === 'title'
             || k === 'type' || k === 'role') n.setAttribute(k, v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.appendChild(c);
  return n;
}

function displayTeacherLast(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : fullName;
}

// ── Bucket labels ───────────────────────────────────────────────────────────
const BUCKET_LABEL = {
  overdue:  'Overdue',
  tomorrow: 'Due soon',       // covers today + tomorrow
  thisWeek: 'This week',
};

// ── Header wiring ───────────────────────────────────────────────────────────
let _wiredBack = false;

function wireBackOnce() {
  if (_wiredBack) return;
  const back = document.getElementById('studyPlanBack');
  if (!back) return;
  back.addEventListener('click', () => navHome());
  _wiredBack = true;
}

// ── Teacher lookup for the "Class · Teacher" subline ────────────────────────
function teacherForClass(className) {
  const schedule = S.isTestMode ? (S.testSchedule || []) : getSchedule();
  const match = schedule.find(s => s && s.course === className);
  return match ? displayTeacherLast(match.teacher) : '';
}

// ── Render ──────────────────────────────────────────────────────────────────
function updateRemaining(plan, container) {
  const checked = loadCheckedMap();
  const { count, minutes } = remainingTotals(plan, checked);
  const header = container.querySelector('#studyPlanHeader');
  if (header) header.textContent = planHeader(count, minutes);
}

function renderList(plan, container, list) {
  const checked = loadCheckedMap();
  list.innerHTML = '';

  if (!plan.items.length) {
    list.appendChild(el('div', {
      class: 'study-plan-empty',
      text: "Nothing due — you're clear tonight.",
    }));
    return;
  }

  let lastBucket = null;
  for (const item of plan.items) {
    if (item.bucket !== lastBucket) {
      list.appendChild(el('div', {
        class: 'study-plan-bucket-label',
        text: BUCKET_LABEL[item.bucket] || '',
      }));
      lastBucket = item.bucket;
    }

    const task = item.task;
    const id = task.id || '';
    const isChecked = !!checked[id];

    const check = el('button', {
      class: 'study-plan-check' + (isChecked ? ' study-plan-check--on' : ''),
      type: 'button',
      'aria-label': isChecked ? 'Uncheck task' : 'Check task',
    });
    check.innerHTML = isChecked
      ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke="currentColor" aria-hidden="true"><polyline points="5 12 10 17 20 7"/></svg>'
      : '';

    const teacher = teacherForClass(task.className);
    const metaBits = [task.className, teacher].filter(Boolean).join(' · ');

    const dueChip = el('span', {
      class: 'study-plan-due' + (item.urgent ? ' study-plan-due--urgent' : ''),
      text: BUCKET_LABEL[item.bucket] || 'Due',
    });
    const timeChip = el('span', { class: 'study-plan-time', text: formatDuration(item.minutes) });

    const chips = el('div', { class: 'study-plan-chips' }, [dueChip, timeChip]);

    const body = el('div', { class: 'study-plan-item-body' }, [
      el('div', { class: 'study-plan-item-title', text: task.title || 'Task' }),
      metaBits ? el('div', { class: 'study-plan-item-meta', text: metaBits }) : null,
      chips,
    ]);

    const row = el('div', {
      class: 'study-plan-item' + (isChecked ? ' study-plan-item--done' : ''),
      'data-task-id': id,
    }, [check, body]);

    check.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const map = loadCheckedMap();
      if (map[id]) delete map[id]; else map[id] = true;
      saveCheckedMap(map);
      renderList(plan, container, list);
      updateRemaining(plan, container);
    });

    list.appendChild(row);
  }

  // Small hint linking to the real homework-complete flow. Only shown when
  // there are items to complete — the checked-state header handles the empty
  // case.
  const hint = el('button', {
    class: 'study-plan-hint',
    type: 'button',
    title: 'Open the real homework list',
  }, [
    el('span', { class: 'study-plan-hint-text',
      text: 'Checking here is visual only — open your homework list to mark items done for real.' }),
  ]);
  hint.addEventListener('click', () => showHwPopup());
  list.appendChild(hint);
}

/**
 * Build the view content into #studyPlanView. Idempotent — safe to call from
 * mountPlan on every route entry so per-day resets and new homework land.
 */
function renderPlan() {
  const container = document.getElementById('studyPlanView');
  if (!container) return;

  // Test mode: home strip suppresses HW because the teacher isn't actually
  // enrolled (§4.5). The plan surface follows the same rule — the button is
  // hidden in test mode, but if a stale hash routes here, render the empty
  // state so we never leak student data or confuse the tester.
  const tasks = S.isTestMode ? [] : getHwTasks();
  // Tomorrow's schedule is not derivable client-side today (spec §4.4 — no
  // day-of-week rotation on the schedule model). Pass an empty set; the
  // ordering rule cleanly no-ops until the schema gains rotation.
  const tomorrowCourses = null;
  const plan = buildStudyPlan(tasks, tomorrowCourses);

  container.innerHTML = '';

  const back = el('button', {
    class: 'study-plan-back',
    id: 'studyPlanBack',
    type: 'button',
    title: 'Back to home',
    'aria-label': 'Back to home',
    text: '←',
  });
  const header = el('header', { class: 'study-plan-header' }, [
    back,
    el('div', { class: 'study-plan-title' }, [
      el('div', { class: 'study-plan-eyebrow', text: "Tonight's Study Plan" }),
      el('h1', { class: 'study-plan-h1', id: 'studyPlanHeader',
        text: planHeader(plan.taskCount, plan.totalMinutes) }),
    ]),
  ]);
  const list = el('div', { class: 'study-plan-list', id: 'studyPlanList' });
  const shell = el('div', { class: 'study-plan-shell' }, [header, list]);
  container.appendChild(shell);

  // Wire back (idempotent guard against re-mount).
  _wiredBack = false;
  wireBackOnce();

  renderList(plan, container, list);
}

/** Router 'plan' handler. Shows #studyPlanView, hides everything else. */
export function mountPlan() {
  const home = document.getElementById('homeView');
  const chat = document.getElementById('chatPanel');
  const classHeader = document.getElementById('classViewHeader');
  const classBody = document.getElementById('classViewBody');
  const view = document.getElementById('studyPlanView');

  unmountHome();
  if (home) home.style.display = 'none';
  if (chat) chat.style.display = 'none';
  if (classHeader) classHeader.style.display = 'none';
  // Hide the class-view body wrapper too — it's a flex:1 sibling of
  // #studyPlanView (also flex:1) in the .main column-flex, so leaving it
  // visible with hidden children split the 100vh column in half and clipped
  // the plan into the top ~50vh of the viewport (Bug 1). Hiding it lets
  // #studyPlanView take the full flex:1 space and use its own overflow-y:auto
  // for the internal scroll — same fixed-viewport model as class view.
  if (classBody) classBody.style.display = 'none';
  if (view) view.style.display = '';

  renderPlan();
}

/** Router-side hide (called by home/class mount paths — currently home takes
 *  care of its own show/hide; this stays exported for symmetry). */
export function unmountPlan() {
  const view = document.getElementById('studyPlanView');
  if (view) view.style.display = 'none';
}
