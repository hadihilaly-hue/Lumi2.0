import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexProfiles, emailToName, buildTeacherDatabase, getStatus, statusLabel,
  computeStats, filterTeachers, initialsOf, escHtml,
} from '../js/admin/dashboardState.js';

// Shape of GET /teacher-profile?scope=all rows (lambda/index.mjs).
const ROWS = [
  { teacher_email: 'calc@menloschool.org', course_name: 'Advanced Calculus I (H)', done: true, updated_at: '2026-09-01T00:00:00Z', engagement_rules: 'x', teaching_voice: 'y' },
  { teacher_email: 'calc@menloschool.org', course_name: 'Algebra 2', done: false, updated_at: null, engagement_rules: '', teaching_voice: '' },
  { teacher_email: 'bio@menloschool.org', course_name: 'Biology', done: false, updated_at: null, engagement_rules: 'started typing', teaching_voice: null },
];
const MAP = { 'Cal Culus': 'Calc@menloschool.org' };

test('indexProfiles keys rows by "email|course"', () => {
  const p = indexProfiles(ROWS);
  assert.deepEqual(Object.keys(p).sort(), [
    'bio@menloschool.org|Biology',
    'calc@menloschool.org|Advanced Calculus I (H)',
    'calc@menloschool.org|Algebra 2',
  ]);
  assert.deepEqual(indexProfiles(null), {});
});

test('emailToName inverts the directory case-insensitively, falls back to local part', () => {
  assert.equal(emailToName('calc@menloschool.org', MAP), 'Cal Culus');
  assert.equal(emailToName('bio@menloschool.org', MAP), 'bio');
  assert.equal(emailToName('bio@menloschool.org'), 'bio');
});

test('buildTeacherDatabase groups classes per teacher, sorted, deduped', () => {
  const db = buildTeacherDatabase(indexProfiles(ROWS), MAP);
  assert.deepEqual(Object.keys(db).sort(), ['bio@menloschool.org', 'calc@menloschool.org']);
  assert.deepEqual(db['calc@menloschool.org'], { name: 'Cal Culus', classes: ['Advanced Calculus I (H)', 'Algebra 2'] });
  assert.deepEqual(buildTeacherDatabase({ k: { teacher_email: null, course_name: 'X' } }), {});
});

test('getStatus: done → complete; SIS stub → not_started; first answers → in_progress', () => {
  const p = indexProfiles(ROWS);
  assert.equal(getStatus(p, 'calc@menloschool.org', 'Advanced Calculus I (H)'), 'complete');
  assert.equal(getStatus(p, 'calc@menloschool.org', 'Algebra 2'), 'not_started');
  assert.equal(getStatus(p, 'bio@menloschool.org', 'Biology'), 'in_progress');
  assert.equal(getStatus(p, 'nobody@menloschool.org', 'Nope'), 'not_started');
  assert.equal(statusLabel('complete'), 'Complete');
  assert.equal(statusLabel('in_progress'), 'In Progress');
  assert.equal(statusLabel('anything'), 'Not Started');
});

test('computeStats counts one completed class from a single scope=all row', () => {
  const p = indexProfiles([ROWS[0]]);
  const db = buildTeacherDatabase(p);
  assert.equal(Object.keys(db).length, 1);
  assert.deepEqual(computeStats(db, p), { total: 1, complete: 1, inProgress: 0, notStarted: 0 });
});

test('computeStats across all teachers, independent of search filter', () => {
  const p = indexProfiles(ROWS);
  const db = buildTeacherDatabase(p, MAP);
  assert.deepEqual(computeStats(db, p), { total: 3, complete: 1, inProgress: 1, notStarted: 1 });
  assert.deepEqual(computeStats({}, {}), { total: 0, complete: 0, inProgress: 0, notStarted: 0 });
});

test('filterTeachers matches on display name and sorts by name', () => {
  const db = buildTeacherDatabase(indexProfiles(ROWS), MAP);
  assert.deepEqual(filterTeachers(db, '').map(([e]) => e), ['bio@menloschool.org', 'calc@menloschool.org']);
  assert.deepEqual(filterTeachers(db, 'cal').map(([e]) => e), ['calc@menloschool.org']);
  assert.deepEqual(filterTeachers(db, 'zzz'), []);
});

test('initialsOf / escHtml', () => {
  assert.equal(initialsOf('Cal Culus'), 'CC');
  assert.equal(initialsOf('bio'), 'B');
  assert.equal(escHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(escHtml(null), '');
});
