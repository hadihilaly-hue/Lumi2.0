// js/home.js — home grid data pipeline for the student-home redesign v1.
// Pure-logic tests only: buildCards, sortCards, relativeTs, dueLabel,
// isUrgentDue. DOM rendering is covered by boot-smoke + manual verification
// (spec §12.7).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../js/state.js';
import { reset, seedLocalStorage } from './harness.mjs';
import {
  buildCards, sortCards, relativeTs, dueLabel, isUrgentDue,
} from '../js/home.js';

// Fixed "today" for date-math tests. Mid-week so weekday-name output
// (Mon/Tue/…) doesn't collide with the "tomorrow" branch on a Sat/Sun boundary.
const NOW = new Date('2026-07-08T15:00:00');    // Wed
const NOW_MS = NOW.getTime();

// Fixed today's ISO date, and offsets in days.
function iso(dayOffset) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => reset());

// ── relativeTs ───────────────────────────────────────────────────────────────
test('relativeTs: minutes → "Nm ago"', () => {
  assert.equal(relativeTs(NOW_MS - 3 * 60_000, NOW_MS), '3m ago');
});

test('relativeTs: hours → "Nh ago"', () => {
  assert.equal(relativeTs(NOW_MS - 2 * 3600_000, NOW_MS), '2h ago');
});

test('relativeTs: 1 day → "yesterday"', () => {
  assert.equal(relativeTs(NOW_MS - 30 * 3600_000, NOW_MS), 'yesterday');
});

test('relativeTs: 3 days → "3d ago"', () => {
  assert.equal(relativeTs(NOW_MS - 3 * 24 * 3600_000, NOW_MS), '3d ago');
});

test('relativeTs: 2 weeks → "2w ago"', () => {
  assert.equal(relativeTs(NOW_MS - 14 * 24 * 3600_000, NOW_MS), '2w ago');
});

test('relativeTs: past 4 weeks → "" (line dropped)', () => {
  assert.equal(relativeTs(NOW_MS - 60 * 24 * 3600_000, NOW_MS), '');
});

test('relativeTs: null / bad input → ""', () => {
  assert.equal(relativeTs(null, NOW_MS), '');
  assert.equal(relativeTs('nope', NOW_MS), '');
});

// ── dueLabel ─────────────────────────────────────────────────────────────────
test('dueLabel: today / tomorrow / this-week / far-future / overdue', () => {
  assert.equal(dueLabel(iso(0), NOW), 'today');
  assert.equal(dueLabel(iso(1), NOW), 'tomorrow');
  // NOW is Wed 2026-07-08. +2 is Fri.
  assert.equal(dueLabel(iso(2), NOW), 'Fri');
  // +10 days = Jul 18 — beyond week, formatted month/day.
  const far = dueLabel(iso(10), NOW);
  assert.match(far, /Jul\s*18|18 Jul/);
  assert.equal(dueLabel(iso(-1), NOW), 'overdue');
  assert.equal(dueLabel('', NOW), '');
  assert.equal(dueLabel('not a date', NOW), '');
});

// ── isUrgentDue ──────────────────────────────────────────────────────────────
test('isUrgentDue: today, tomorrow, overdue → true; ≥ 2d → false', () => {
  assert.equal(isUrgentDue(iso(0), NOW), true);   // today
  assert.equal(isUrgentDue(iso(1), NOW), true);   // tomorrow
  assert.equal(isUrgentDue(iso(-3), NOW), true);  // overdue
  assert.equal(isUrgentDue(iso(2), NOW), false);  // 2 days out
  assert.equal(isUrgentDue('', NOW), false);
});

// ── buildCards + sortCards ───────────────────────────────────────────────────
test('buildCards: pulls schedule → card entries with default ready=true', () => {
  seedLocalStorage({
    lumi_schedule: [
      { course: 'Algebra II', teacher: 'Ana Ferraro', subject: 'math', block: 'B' },
      { course: 'Biology', teacher: 'Priya Ramaswamy', subject: 'science', block: 'A' },
    ],
  });
  const cards = buildCards(NOW);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].course, 'Algebra II');
  assert.equal(cards[0].block, 'B');
  assert.equal(cards[0].ready, true);
  assert.equal(cards[0].lastConv, null);
  assert.equal(cards[0].nextHw, null);
  assert.equal(cards[0].hasUrgentHw, false);
});

test('buildCards: last-conv filter uses tutorCtx.course + tutorCtx.teacher (§2.1)', () => {
  const convs = {
    // Wrong course — should be skipped.
    a: { id: 'a', ts: NOW_MS - 1000, title: 'other', tutorCtx: { course: 'Bio', teacher: 'Ana Ferraro' } },
    // Correct — but older.
    b: { id: 'b', ts: NOW_MS - 3600_000, title: 'first draft', tutorCtx: { course: 'Algebra II', teacher: 'Ana Ferraro' } },
    // Correct + newest — should win.
    c: { id: 'c', ts: NOW_MS - 60_000, title: 'factoring quadratics', tutorCtx: { course: 'Algebra II', teacher: 'Ana Ferraro' } },
    // Correct course but wrong teacher — should be skipped.
    d: { id: 'd', ts: NOW_MS - 10, title: 'zzz', tutorCtx: { course: 'Algebra II', teacher: 'Somebody Else' } },
  };
  seedLocalStorage({
    lumi_schedule: [{ course: 'Algebra II', teacher: 'Ana Ferraro', block: 'B' }],
    lumi_convs: convs,
  });
  const cards = buildCards(NOW);
  assert.equal(cards[0].lastConv?.id, 'c');
  assert.equal(cards[0].lastConv?.title, 'factoring quadratics');
});

test('buildCards: next-due HW is filtered by className and picks the soonest', () => {
  seedLocalStorage({
    lumi_schedule: [{ course: 'Algebra II', teacher: 'Ana Ferraro', block: 'B' }],
    lumi_hw_tasks: [
      { id: 't1', title: 'Wrong class', className: 'Biology', dueDate: iso(0), isComplete: false },
      { id: 't2', title: 'Problem Set 8', className: 'Algebra II', dueDate: iso(4), isComplete: false },
      { id: 't3', title: 'Problem Set 7', className: 'Algebra II', dueDate: iso(1), isComplete: false },
      { id: 't4', title: 'Old work', className: 'Algebra II', dueDate: iso(-2), isComplete: true },
    ],
  });
  const cards = buildCards(NOW);
  assert.equal(cards[0].nextHw?.id, 't3');
  assert.equal(cards[0].hasUrgentHw, true);   // due tomorrow → urgent
});

test('sortCards: urgent-HW cards bubble to the top, then by dueDate asc', () => {
  const mk = (course, hasUrgentHw, dueDate, ts) => ({
    course, teacher: 'x', block: '', ready: true,
    lastConv: ts ? { ts } : null,
    nextHw: dueDate ? { title: 't', dueDate } : null,
    hasUrgentHw,
  });
  const cards = [
    mk('Zebra', false, null, NOW_MS - 1000),
    mk('Bio', true, iso(1), null),          // urgent tomorrow
    mk('Algebra', true, iso(0), null),      // urgent today — should win
    mk('History', false, iso(3), NOW_MS - 5000),
  ];
  const sorted = sortCards(cards, false);
  assert.equal(sorted[0].course, 'Algebra');
  assert.equal(sorted[1].course, 'Bio');
  // Non-urgent tail — recency wins over alpha.
  assert.equal(sorted[2].course, 'Zebra');
  assert.equal(sorted[3].course, 'History');
});

test('sortCards: no urgent → most-recently-used first, then alpha', () => {
  const mk = (course, ts) => ({
    course, teacher: 'x', block: '', ready: true,
    lastConv: ts ? { ts } : null,
    nextHw: null,
    hasUrgentHw: false,
  });
  const cards = [
    mk('Zebra', NOW_MS - 100),
    mk('Algebra', null),
    mk('Bio', NOW_MS - 10),
    mk('English', null),
  ];
  const sorted = sortCards(cards, false);
  // Recency: Bio, Zebra (both have ts); then alpha for the ts=null tail.
  assert.equal(sorted[0].course, 'Bio');
  assert.equal(sorted[1].course, 'Zebra');
  assert.equal(sorted[2].course, 'Algebra');
  assert.equal(sorted[3].course, 'English');
});

test('sortCards test mode: D10-B — ready first, locked second, alpha within', () => {
  const mk = (course, ready) => ({
    course, teacher: 'x', block: '', ready,
    lastConv: null, nextHw: null, hasUrgentHw: false,
  });
  const cards = [
    mk('Zebra', true),
    mk('Algebra', false),
    mk('Bio', false),
    mk('English', true),
  ];
  const sorted = sortCards(cards, true);
  assert.equal(sorted[0].course, 'English');   // ready + alpha-first among ready
  assert.equal(sorted[1].course, 'Zebra');
  assert.equal(sorted[2].course, 'Algebra');   // locked + alpha-first among locked
  assert.equal(sorted[3].course, 'Bio');
});

test('buildCards: test mode ignores HW rows (spec §4.2 test-mode override)', () => {
  // Seed HW that WOULD light up a card in student mode, then flip isTestMode.
  seedLocalStorage({
    lumi_hw_tasks: [
      { id: 't1', title: 'Urgent!', className: 'Algebra II', dueDate: iso(0), isComplete: false },
    ],
  });
  S.isTestMode = true;
  S.testSchedule = [{ course: 'Algebra II', teacher: 'Ana Ferraro', block: 'B', ready: true }];
  const cards = buildCards(NOW);
  assert.equal(cards[0].nextHw, null);
  assert.equal(cards[0].hasUrgentHw, false);
});
