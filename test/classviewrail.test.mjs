// js/classviewrail.js — pure-logic tests for the class-view left rail.
// The DOM render + wire-up (mountRail, unmountRail) touches the live document
// and is covered by boot smoke + manual verification (spec §12.7).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listConvsForClass,
  listHwForClass,
  listProjectsForClass,
  railRelativeTs,
} from '../js/classviewrail.js';

const NOW_MS = new Date('2026-07-08T15:00:00').getTime();

// ── listConvsForClass ───────────────────────────────────────────────────────
test('listConvsForClass: filters by (course, teacher) and drops title-less convs', () => {
  const convs = {
    a: { id: 'a', ts: 1000, title: 'Alg thread',
         tutorCtx: { course: 'Algebra 2', teacher: 'Mr. Harris' } },
    b: { id: 'b', ts: 2000, title: 'Wrong class',
         tutorCtx: { course: 'Chemistry', teacher: 'Ms. Huntley' } },
    c: { id: 'c', ts: 3000, preview: 'preview-only',
         tutorCtx: { course: 'Algebra 2', teacher: 'Mr. Harris' } },
    d: { id: 'd', ts: 4000, tutorCtx: { course: 'Algebra 2', teacher: 'Mr. Harris' } },  // no title/preview → dropped
    e: { id: 'e', ts: 5000, title: 'no ctx' },  // no tutorCtx → dropped
  };
  const out = listConvsForClass(convs, 'Algebra 2', 'Mr. Harris');
  assert.deepEqual(out.map(c => c.id), ['c', 'a']);  // newest first, no d/e
});

test('listConvsForClass: sorts newest first by ts', () => {
  const convs = {
    a: { id: 'a', ts: 100, title: 'old', tutorCtx: { course: 'X', teacher: 'T' } },
    b: { id: 'b', ts: 300, title: 'new', tutorCtx: { course: 'X', teacher: 'T' } },
    c: { id: 'c', ts: 200, title: 'mid', tutorCtx: { course: 'X', teacher: 'T' } },
  };
  assert.deepEqual(listConvsForClass(convs, 'X', 'T').map(c => c.id), ['b', 'c', 'a']);
});

test('listConvsForClass: missing course or teacher → []', () => {
  assert.deepEqual(listConvsForClass({}, '', 'T'), []);
  assert.deepEqual(listConvsForClass({}, 'C', ''), []);
  assert.deepEqual(listConvsForClass(null, 'C', 'T'), []);
});

test('listConvsForClass: tolerates malformed conv rows without throwing', () => {
  const convs = { a: null, b: undefined, c: { tutorCtx: null } };
  assert.doesNotThrow(() => listConvsForClass(convs, 'C', 'T'));
  assert.deepEqual(listConvsForClass(convs, 'C', 'T'), []);
});

// ── listHwForClass ──────────────────────────────────────────────────────────
test('listHwForClass: filters incomplete tasks for the given class, dueDate asc', () => {
  const tasks = [
    { id: '1', className: 'Algebra 2', title: 'ps 3', dueDate: '2026-07-10' },
    { id: '2', className: 'Chemistry', title: 'lab',  dueDate: '2026-07-09' },
    { id: '3', className: 'Algebra 2', title: 'done', dueDate: '2026-07-08', isComplete: true },
    { id: '4', className: 'Algebra 2', title: 'ps 2', dueDate: '2026-07-08' },
    { id: '5', className: 'Algebra 2', title: 'no date' },  // missing dueDate sorts last
  ];
  const out = listHwForClass(tasks, 'Algebra 2');
  assert.deepEqual(out.map(t => t.id), ['4', '1', '5']);
});

test('listHwForClass: no matches → []', () => {
  assert.deepEqual(listHwForClass([], 'C'), []);
  assert.deepEqual(listHwForClass(null, 'C'), []);
  assert.deepEqual(listHwForClass([{ className: 'X' }], 'C'), []);
});

// ── listProjectsForClass ────────────────────────────────────────────────────
test('listProjectsForClass: filters by className, incomplete before complete', () => {
  const projects = [
    { id: 'p1', className: 'Algebra 2', title: 'done proj',  isComplete: true,  dueDate: '2026-07-01' },
    { id: 'p2', className: 'Algebra 2', title: 'active a',   isComplete: false, dueDate: '2026-07-15' },
    { id: 'p3', className: 'Chemistry', title: 'wrong',      isComplete: false, dueDate: '2026-07-05' },
    { id: 'p4', className: 'Algebra 2', title: 'active b',   isComplete: false, dueDate: '2026-07-10' },
  ];
  const out = listProjectsForClass(projects, 'Algebra 2');
  // active (b then a by dueDate), then completed.
  assert.deepEqual(out.map(p => p.id), ['p4', 'p2', 'p1']);
});

test('listProjectsForClass: missing course / null projects → []', () => {
  assert.deepEqual(listProjectsForClass(null, 'C'), []);
  assert.deepEqual(listProjectsForClass([], 'C'), []);
  assert.deepEqual(listProjectsForClass([{ className: 'X' }], ''), []);
});

// ── railRelativeTs ──────────────────────────────────────────────────────────
test('railRelativeTs: minutes / hours / yesterday / days / weeks', () => {
  assert.equal(railRelativeTs(NOW_MS - 5 * 60_000, NOW_MS), '5m ago');
  assert.equal(railRelativeTs(NOW_MS - 3 * 3_600_000, NOW_MS), '3h ago');
  assert.equal(railRelativeTs(NOW_MS - 30 * 3_600_000, NOW_MS), 'yesterday');
  assert.equal(railRelativeTs(NOW_MS - 4 * 24 * 3_600_000, NOW_MS), '4d ago');
  assert.equal(railRelativeTs(NOW_MS - 15 * 24 * 3_600_000, NOW_MS), '2w ago');
});

test('railRelativeTs: past 4 weeks → falls through to a locale date (non-empty)', () => {
  const out = railRelativeTs(NOW_MS - 90 * 24 * 3_600_000, NOW_MS);
  // Unlike home.js:relativeTs which drops the line at 4w, the rail wants a
  // date fallback so ancient chats still show a hint of when they were.
  assert.ok(out.length > 0, `expected a date fallback, got "${out}"`);
});

test('railRelativeTs: bad input → ""', () => {
  assert.equal(railRelativeTs(null, NOW_MS), '');
  assert.equal(railRelativeTs('nope', NOW_MS), '');
});
