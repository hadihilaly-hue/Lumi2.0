// js/studyplan.js — pure-logic core for the Tonight's Study Plan v1.
//
// Covers: estimateMinutes, bucketOf, sortStudyItems, buildStudyPlan,
// formatDuration, planHeader, planDateKey, load/saveCheckedMap,
// remainingTotals.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { reset } from './harness.mjs';
import {
  estimateMinutes, bucketOf, sortStudyItems, buildStudyPlan,
  formatDuration, planHeader, planDateKey, loadCheckedMap, saveCheckedMap,
  remainingTotals,
} from '../js/studyplan.js';

const NOW = new Date('2026-07-08T20:00:00');   // Wed evening — typical study time

function iso(dayOffset) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}
function mkTask(overrides = {}) {
  return { id: 't', title: 't', className: 'Algebra II', dueDate: iso(1), isComplete: false, ...overrides };
}

beforeEach(() => reset());

// ── estimateMinutes ─────────────────────────────────────────────────────────
test('estimateMinutes: default 30 for short work', () => {
  assert.equal(estimateMinutes('Problem Set 8'), 30);
  assert.equal(estimateMinutes('worksheet 3'), 30);
  assert.equal(estimateMinutes('vocab quiz'), 30);
  assert.equal(estimateMinutes(''), 30);
  assert.equal(estimateMinutes(null), 30);
});

test('estimateMinutes: 45 for essay-shaped cues', () => {
  assert.equal(estimateMinutes('First-draft essay on Gatsby'), 45);
  assert.equal(estimateMinutes('History research paper'), 45);
  assert.equal(estimateMinutes('Group project outline'), 45);
  assert.equal(estimateMinutes('Lab REPORT week 3'), 45);
  assert.equal(estimateMinutes('Portfolio piece'), 45);
  assert.equal(estimateMinutes('Presentation slides'), 45);
});

test('estimateMinutes: 45 for read/reading/chapter/novel cues', () => {
  assert.equal(estimateMinutes('Read Chapter 4'), 45);
  assert.equal(estimateMinutes('Reading response'), 45);
  assert.equal(estimateMinutes('Finish the novel'), 45);
  assert.equal(estimateMinutes('CHAPTER review outline'), 45);
});

test('estimateMinutes: cues are word-boundary matched — no substring false positives', () => {
  // "prescreen" contains "read" as a substring but not as a word.
  assert.equal(estimateMinutes('prescreen the deck'), 30);
  // "operation" contains "report" as a substring? No, but "reported" would.
  // Guard the common one: "screening" (no cue).
  assert.equal(estimateMinutes('screening notes'), 30);
});

// ── bucketOf ────────────────────────────────────────────────────────────────
test('bucketOf: overdue / tomorrow / thisWeek / later / null', () => {
  assert.equal(bucketOf({ dueDate: iso(-1) }, NOW), 'overdue');
  assert.equal(bucketOf({ dueDate: iso(-5) }, NOW), 'overdue');
  assert.equal(bucketOf({ dueDate: iso(0) },  NOW), 'tomorrow');    // today counts
  assert.equal(bucketOf({ dueDate: iso(1) },  NOW), 'tomorrow');
  assert.equal(bucketOf({ dueDate: iso(3) },  NOW), 'thisWeek');
  assert.equal(bucketOf({ dueDate: iso(7) },  NOW), 'thisWeek');
  assert.equal(bucketOf({ dueDate: iso(8) },  NOW), 'later');
  assert.equal(bucketOf({ dueDate: '' },      NOW), null);
  assert.equal(bucketOf({ dueDate: 'nope' },  NOW), null);
  assert.equal(bucketOf(null,                  NOW), null);
});

// ── sortStudyItems ──────────────────────────────────────────────────────────
test('sortStudyItems: overdue bubbles above tomorrow above thisWeek', () => {
  const items = [
    { task: mkTask({ id: 'w', dueDate: iso(3), className: 'History' }), bucket: 'thisWeek' },
    { task: mkTask({ id: 't', dueDate: iso(1), className: 'Biology' }), bucket: 'tomorrow' },
    { task: mkTask({ id: 'o', dueDate: iso(-2), className: 'Algebra II' }), bucket: 'overdue' },
  ];
  const s = sortStudyItems(items, null, NOW);
  assert.deepEqual(s.map(i => i.task.id), ['o', 't', 'w']);
});

test('sortStudyItems: within a bucket, tomorrow-class items come first', () => {
  const items = [
    { task: mkTask({ id: 'a', className: 'Algebra II' }), bucket: 'tomorrow' },
    { task: mkTask({ id: 'b', className: 'Biology' }),    bucket: 'tomorrow' },
    { task: mkTask({ id: 'c', className: 'History' }),    bucket: 'tomorrow' },
  ];
  // Biology + History have class tomorrow.
  const s = sortStudyItems(items, new Set(['Biology', 'History']), NOW);
  assert.deepEqual(s.map(i => i.task.id), ['b', 'c', 'a']);
});

test('sortStudyItems: alphabetical tie-break — className then title', () => {
  const items = [
    { task: mkTask({ id: 'z', className: 'Zoology', title: 'a' }),    bucket: 'thisWeek' },
    { task: mkTask({ id: 'a', className: 'Algebra II', title: 'p2' }), bucket: 'thisWeek' },
    { task: mkTask({ id: 'b', className: 'Algebra II', title: 'p1' }), bucket: 'thisWeek' },
  ];
  const s = sortStudyItems(items, null, NOW);
  assert.deepEqual(s.map(i => i.task.id), ['b', 'a', 'z']);   // Algebra p1, p2 → Zoology
});

test('sortStudyItems: tomorrowCourses accepts a Set OR an Array', () => {
  const items = [
    { task: mkTask({ id: 'a', className: 'X' }), bucket: 'tomorrow' },
    { task: mkTask({ id: 'b', className: 'Y' }), bucket: 'tomorrow' },
  ];
  const asArray = sortStudyItems(items, ['Y'], NOW).map(i => i.task.id);
  const asSet = sortStudyItems(items, new Set(['Y']), NOW).map(i => i.task.id);
  assert.deepEqual(asArray, ['b', 'a']);
  assert.deepEqual(asSet, ['b', 'a']);
});

// ── buildStudyPlan ──────────────────────────────────────────────────────────
test('buildStudyPlan: drops complete, dateless, and >week tasks; keeps 3-bucket window', () => {
  const tasks = [
    mkTask({ id: '1', dueDate: iso(-2), title: 'Late worksheet' }),                  // overdue → keep
    mkTask({ id: '2', dueDate: iso(0),  title: 'Today reading', className: 'Bio' }), // tomorrow → keep
    mkTask({ id: '3', dueDate: iso(1),  title: 'PS8' }),                              // tomorrow → keep
    mkTask({ id: '4', dueDate: iso(5),  title: 'Lab' }),                              // thisWeek → keep
    mkTask({ id: '5', dueDate: iso(9),  title: 'Later essay' }),                     // later → drop
    mkTask({ id: '6', dueDate: '',      title: 'No date' }),                          // no date → drop
    mkTask({ id: '7', dueDate: iso(0),  title: 'Done', isComplete: true }),          // complete → drop
  ];
  const plan = buildStudyPlan(tasks, null, NOW);
  assert.equal(plan.taskCount, 4);
  // Alpha tie-break inside `tomorrow` bucket: "Algebra II" (id 3) < "Bio" (id 2).
  assert.deepEqual(plan.items.map(i => i.task.id), ['1', '3', '2', '4']);
  // Bucket labels correctly assigned.
  assert.equal(plan.items[0].bucket, 'overdue');
  assert.equal(plan.items[1].bucket, 'tomorrow');
  assert.equal(plan.items[3].bucket, 'thisWeek');
});

test('buildStudyPlan: minutes + urgent flags reflect estimateMinutes + isUrgentDue', () => {
  const tasks = [
    mkTask({ id: 'e', title: 'Persuasive essay draft', dueDate: iso(1) }),
    mkTask({ id: 'p', title: 'Problem Set 8',           dueDate: iso(1) }),
    mkTask({ id: 'r', title: 'Chapter 3 reading',       dueDate: iso(3) }),
    mkTask({ id: 'q', title: 'vocab quiz',              dueDate: iso(5) }),
  ];
  const plan = buildStudyPlan(tasks, null, NOW);
  const byId = Object.fromEntries(plan.items.map(i => [i.task.id, i]));
  assert.equal(byId.e.minutes, 45);
  assert.equal(byId.p.minutes, 30);
  assert.equal(byId.r.minutes, 45);
  assert.equal(byId.q.minutes, 30);
  assert.equal(byId.e.urgent, true);   // due tomorrow
  assert.equal(byId.r.urgent, false);  // +3d
  assert.equal(plan.totalMinutes, 45 + 30 + 45 + 30);
});

test('buildStudyPlan: empty task list → { taskCount:0, totalMinutes:0, items:[] }', () => {
  const plan = buildStudyPlan([], null, NOW);
  assert.equal(plan.taskCount, 0);
  assert.equal(plan.totalMinutes, 0);
  assert.deepEqual(plan.items, []);
});

test('buildStudyPlan: non-array input → empty plan (defensive; matches getHwTasks() edge)', () => {
  const plan = buildStudyPlan(null, null, NOW);
  assert.equal(plan.taskCount, 0);
  assert.equal(plan.totalMinutes, 0);
});

// ── formatDuration + planHeader ─────────────────────────────────────────────
test('formatDuration: minutes / hours-only / hours-and-minutes', () => {
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(30), '~30 min');
  assert.equal(formatDuration(60), '~1 hr');
  assert.equal(formatDuration(75), '~1 hr 15 min');
  assert.equal(formatDuration(150), '~2 hr 30 min');
});

test('formatDuration: garbage input → ""', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration('foo'), '');
  assert.equal(formatDuration(-15), '');
});

test('planHeader: composes the tonight sentence with correct pluralization', () => {
  assert.equal(planHeader(0, 0), 'Nothing due tonight');
  assert.equal(planHeader(1, 30), 'Tonight: 1 task · ~30 min');
  assert.equal(planHeader(3, 105), 'Tonight: 3 tasks · ~1 hr 45 min');
});

// ── per-day checked-state storage ───────────────────────────────────────────
test('planDateKey: encodes local date into a key that resets at midnight', () => {
  const wed = new Date('2026-07-08T23:59:00');
  const thu = new Date('2026-07-09T00:01:00');
  assert.notEqual(planDateKey(wed), planDateKey(thu));
  assert.match(planDateKey(wed), /2026-07-08$/);
});

test('load/saveCheckedMap: round-trip via injected storage', () => {
  const store = new Map();
  const shim = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const now = new Date('2026-07-08T20:00:00');
  assert.deepEqual(loadCheckedMap(now, shim), {});
  saveCheckedMap({ a: true, b: true }, now, shim);
  assert.deepEqual(loadCheckedMap(now, shim), { a: true, b: true });
  // A different day starts empty even with data from yesterday.
  const tomorrow = new Date('2026-07-09T08:00:00');
  assert.deepEqual(loadCheckedMap(tomorrow, shim), {});
});

test('loadCheckedMap: corrupt JSON → {} (never throws)', () => {
  const shim = {
    getItem: () => '{not json',
    setItem: () => {},
  };
  assert.deepEqual(loadCheckedMap(new Date(), shim), {});
});

test('remainingTotals: skips checked items in both count and minutes', () => {
  const plan = {
    items: [
      { task: { id: 'a' }, minutes: 30 },
      { task: { id: 'b' }, minutes: 45 },
      { task: { id: 'c' }, minutes: 30 },
    ],
    taskCount: 3, totalMinutes: 105,
  };
  assert.deepEqual(remainingTotals(plan, {}), { count: 3, minutes: 105 });
  assert.deepEqual(remainingTotals(plan, { b: true }), { count: 2, minutes: 60 });
  assert.deepEqual(remainingTotals(plan, { a: true, b: true, c: true }), { count: 0, minutes: 0 });
});
