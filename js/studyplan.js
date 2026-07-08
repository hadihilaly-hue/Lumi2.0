// Tonight's Study Plan — v1 deterministic client-side generator.
//
// Companion to the Session-4 home surface described in
// docs/STUDENT_HOME_REDESIGN.md §12.11 (v1 spec — deferred Bedrock work is v2,
// see the same section). v1 is DETERMINISTIC:
//   • No Bedrock, no Lambda, no schema changes.
//   • Uses the same homework source as the home due-strip (getHwTasks()).
//   • Optional "tomorrow classes" argument nudges cards that meet tomorrow to
//     the top within their bucket. The redesign schedule model has no
//     day-of-week rotation today (spec §4.4), so callers pass an empty set;
//     the plumbing is here for when the schema gains a rotation column.
//
// The DOM view (studyplanview.js) and the home-card wiring both consume the
// output of buildStudyPlan() below. Everything in this module is a pure
// function — no localStorage, no DOM, no fetch — so it is exercised by the
// offline unit suite in test/studyplan.test.mjs.

import { isUrgentDue } from './home.js';

// ── Time estimation ─────────────────────────────────────────────────────────

/**
 * Deterministic 30/45-minute estimate for a task title.
 *   • 45 min if the title contains an "essay-shaped" cue (essay, project,
 *     research, paper, report, presentation, portfolio) OR a "read-shaped"
 *     cue (read, reading, chapter, novel).
 *   • 30 min otherwise (the "regular homework" default).
 *
 * Matches the tier-1/tier-4 buckets in js/homework.js at the level a title-
 * only heuristic can — this is not a replacement for the tiered classifier,
 * just a coarse "long task vs short task" call for the tonight-view chip.
 *
 * Kept case-insensitive and whitespace-tolerant. Returns 30 for empty input.
 */
const LONG_TASK_CUES = [
  'essay', 'project', 'research', 'paper', 'report', 'presentation',
  'portfolio', 'read', 'reading', 'chapter', 'novel',
];

export function estimateMinutes(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return 30;
  for (const cue of LONG_TASK_CUES) {
    // Word-ish boundary — matches "read chapter 4" and "Reading" but not
    // "prescreen". Ripgrep-style: cue is bracketed by non-letters or edges.
    const re = new RegExp(`(^|[^a-z])${cue}([^a-z]|$)`);
    if (re.test(t)) return 45;
  }
  return 30;
}

// ── Bucketing ───────────────────────────────────────────────────────────────

/**
 * Bucket a task by its dueDate relative to `now`:
 *   'overdue'  — dueDate < today
 *   'tomorrow' — dueDate is today OR tomorrow (both count as "tonight" work)
 *   'thisWeek' — dueDate ≤ today + 7 days
 *   'later'    — beyond this week (excluded from the plan)
 *   null       — no/invalid dueDate (excluded)
 *
 * The "tomorrow" bucket deliberately includes today: the plan is the
 * student's evening work, and something due at end-of-day today belongs in
 * the same visual tier as something due tomorrow.
 */
export function bucketOf(task, now = new Date()) {
  const raw = task && task.dueDate;
  if (!raw) return null;
  const due = new Date(raw + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / (24 * 60 * 60 * 1000));
  if (days < 0) return 'overdue';
  if (days <= 1) return 'tomorrow';
  if (days <= 7) return 'thisWeek';
  return 'later';
}

const BUCKET_ORDER = { overdue: 0, tomorrow: 1, thisWeek: 2 };

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Sort incomplete tasks for the tonight view:
 *   1. Bucket: overdue → tomorrow → thisWeek. (later + null are dropped by
 *      buildStudyPlan before this runs.)
 *   2. Within a bucket, classes the student has tomorrow first (fed via
 *      `tomorrowCourses` — a Set<string> of course names). When the set is
 *      empty (v1 default — the schedule has no rotation) this rule is a
 *      no-op.
 *   3. Alphabetical by className, then by task title, as final tie-break.
 *
 * `tomorrowCourses` accepts a Set, Array, or falsy value.
 */
export function sortStudyItems(items, tomorrowCourses, now = new Date()) {
  const set = tomorrowCourses instanceof Set
    ? tomorrowCourses
    : new Set(Array.isArray(tomorrowCourses) ? tomorrowCourses : []);
  const alpha = (a, b) => String(a).localeCompare(String(b));
  return [...items].sort((a, b) => {
    const ba = BUCKET_ORDER[a.bucket] ?? 99;
    const bb = BUCKET_ORDER[b.bucket] ?? 99;
    if (ba !== bb) return ba - bb;
    const ta = set.has(a.task.className) ? 0 : 1;
    const tb = set.has(b.task.className) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const cn = alpha(a.task.className || '', b.task.className || '');
    if (cn !== 0) return cn;
    return alpha(a.task.title || '', b.task.title || '');
  });
}

// ── Plan assembly ───────────────────────────────────────────────────────────

/**
 * Assemble the plan from a raw task list (same shape as getHwTasks()):
 *   { id, title, className, dueDate, isComplete, teacher? }
 *
 * Returns:
 *   {
 *     items: [{ task, bucket, minutes, urgent }, ...]  // sorted, plan-shaped
 *     totalMinutes,                                     // sum of item.minutes
 *     taskCount,                                        // items.length
 *   }
 *
 * Filters applied here (not in sortStudyItems — that stays pure-sort):
 *   • task.isComplete → dropped.
 *   • bucket === 'later' or null → dropped (out of tonight's window).
 *
 * `tomorrowCourses` behaves as sortStudyItems documents.
 */
export function buildStudyPlan(tasks, tomorrowCourses, now = new Date()) {
  const raw = Array.isArray(tasks) ? tasks : [];
  const shaped = [];
  for (const task of raw) {
    if (!task || task.isComplete) continue;
    const bucket = bucketOf(task, now);
    if (bucket === null || bucket === 'later') continue;
    shaped.push({
      task,
      bucket,
      minutes: estimateMinutes(task.title),
      urgent: isUrgentDue(task.dueDate, now),
    });
  }
  const items = sortStudyItems(shaped, tomorrowCourses, now);
  const totalMinutes = items.reduce((s, it) => s + it.minutes, 0);
  return { items, totalMinutes, taskCount: items.length };
}

// ── Header formatting ───────────────────────────────────────────────────────

/**
 * "~2 hr 15 min" / "~45 min" / "~1 hr". Deterministic, DOM-free.
 *
 * Returns '' for a non-positive input so the caller can drop the pill.
 */
export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return '';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `~${rem} min`;
  if (rem === 0) return `~${h} hr`;
  return `~${h} hr ${rem} min`;
}

/**
 * Compose the header sentence rendered above the plan list.
 *   0 tasks → 'Nothing due tonight'.
 *   otherwise → 'Tonight: N task(s) · ~X hr Y min'
 */
export function planHeader(taskCount, totalMinutes) {
  if (!taskCount) return 'Nothing due tonight';
  const noun = taskCount === 1 ? 'task' : 'tasks';
  const dur = formatDuration(totalMinutes);
  return dur ? `Tonight: ${taskCount} ${noun} · ${dur}` : `Tonight: ${taskCount} ${noun}`;
}

// ── Per-day checked-state storage ───────────────────────────────────────────
//
// The tonight-plan checkboxes are VISUAL ONLY — checking a box strikes an item
// through and drops it from the remaining-total, but does NOT mutate the real
// homework record (§ prompt spec, "Checking does NOT mutate real homework"). We
// persist the check set under a date-stamped localStorage key so the state
// resets naturally at midnight local time.

const STORAGE_KEY_PREFIX = 'lumi_study_plan_checked_';

/** ISO date (yyyy-mm-dd) for `now`. Kept local so a plan carries across the
 *  timezone the student is actually in. */
export function planDateKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${STORAGE_KEY_PREFIX}${y}-${m}-${d}`;
}

/** Load the { taskId: true } map for today. */
export function loadCheckedMap(now = new Date(), storage = _localStorage()) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(planDateKey(now));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Persist the { taskId: true } map for today. Silent on quota errors — the
 *  view already treats checked-state as best-effort session polish. */
export function saveCheckedMap(map, now = new Date(), storage = _localStorage()) {
  if (!storage) return;
  try {
    storage.setItem(planDateKey(now), JSON.stringify(map || {}));
  } catch {}
}

/** Compute the "remaining" totals given a plan and the checked map. */
export function remainingTotals(plan, checkedMap) {
  const map = checkedMap || {};
  let count = 0;
  let minutes = 0;
  for (const item of plan.items || []) {
    if (map[item.task.id]) continue;
    count += 1;
    minutes += item.minutes;
  }
  return { count, minutes };
}

// localStorage may not exist in some hosts (SSR, test harness edge). Every
// caller in this module guards against null.
function _localStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
