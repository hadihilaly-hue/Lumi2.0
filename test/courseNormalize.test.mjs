// js/courseNormalize.js — pure schedule-course → canonical-course resolution.
// The whole point of the module is guarantees, so the tests are the spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COURSE_ALIASES,
  closestCourseCandidates,
  findUnresolvedScheduleCourses,
  normalizeCourseKey,
  resolveCanonicalCourse,
} from '../js/courseNormalize.js';

// A minimal fixture standing in for /available-classes response rows.
const rows = [
  { course_name: 'US History', subject: 'History & Social Sciences' },
  { course_name: 'Algebra II', subject: 'Math' },
  { course_name: 'Biology', subject: 'Science' },
  { course_name: 'English 10', subject: 'English' },
  { course_name: 'Intro to Computer Science', subject: 'Computer Science' },
  { course_name: 'Spanish II', subject: 'World Language' },
  { course_name: 'Music Theory', subject: 'Arts' },
  { course_name: 'Physical Education 9', subject: 'PE' },
  { course_name: 'Global Issues for Global Citizens', subject: 'History & Social Sciences' },
];

// ── normalizeCourseKey ──────────────────────────────────────────────────────
test('normalizeCourseKey lowercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeCourseKey('  US   History  '), 'us history');
});

test('normalizeCourseKey strips a single trailing parenthetical', () => {
  assert.equal(normalizeCourseKey('US History (H)'), 'us history');
  assert.equal(normalizeCourseKey('Chemistry (Honors)'), 'chemistry');
  assert.equal(normalizeCourseKey('Advanced Latin (H) '), 'advanced latin');
});

test('normalizeCourseKey does NOT strip a non-trailing parenthetical', () => {
  assert.equal(normalizeCourseKey('IP (Capstone) Seminar'), 'ip (capstone) seminar');
});

test('normalizeCourseKey handles empty / null input', () => {
  assert.equal(normalizeCourseKey(''), '');
  assert.equal(normalizeCourseKey(null), '');
  assert.equal(normalizeCourseKey(undefined), '');
});

// ── resolveCanonicalCourse: exact tier ──────────────────────────────────────
test('resolveCanonicalCourse returns the row course_name on exact match', () => {
  const res = resolveCanonicalCourse('US History', rows);
  assert.deepEqual(res, { canonicalCourse: 'US History', matchType: 'exact', subject: 'History & Social Sciences' });
});

// ── resolveCanonicalCourse: normalized tier ─────────────────────────────────
test('resolveCanonicalCourse strips trailing "(H)" to hit the DB row', () => {
  const res = resolveCanonicalCourse('US History (H)', rows);
  assert.equal(res && res.canonicalCourse, 'US History');
  assert.equal(res && res.matchType, 'normalized');
});

test('resolveCanonicalCourse is case-insensitive on normalized match', () => {
  const res = resolveCanonicalCourse('biology', rows);
  assert.equal(res && res.canonicalCourse, 'Biology');
  assert.equal(res && res.matchType, 'normalized');
});

test('resolveCanonicalCourse collapses whitespace on normalized match', () => {
  const res = resolveCanonicalCourse('  Music    Theory  ', rows);
  assert.equal(res && res.canonicalCourse, 'Music Theory');
});

// ── resolveCanonicalCourse: alias tier ──────────────────────────────────────
test('resolveCanonicalCourse maps MENLO_CURRICULUM CS names to the DB "Intro to Computer Science"', () => {
  const res = resolveCanonicalCourse('CS1: Intro to Computer Science', rows);
  assert.equal(res && res.canonicalCourse, 'Intro to Computer Science');
  assert.equal(res && res.matchType, 'alias');
});

test('resolveCanonicalCourse resolves arabic "Algebra 2" to roman "Algebra II"', () => {
  const res = resolveCanonicalCourse('Algebra 2', rows);
  assert.equal(res && res.canonicalCourse, 'Algebra II');
  assert.equal(res && res.matchType, 'alias');
});

test('resolveCanonicalCourse alias table is symmetric — roman schedule + arabic DB also resolves', () => {
  const romanRows = [{ course_name: 'Algebra 2', subject: 'Math' }];
  const res = resolveCanonicalCourse('Algebra II', romanRows);
  assert.equal(res && res.canonicalCourse, 'Algebra 2');
  assert.equal(res && res.matchType, 'alias');
});

// ── resolveCanonicalCourse: safety — never fuzzy across distinct courses ────
test('resolveCanonicalCourse does NOT silently coerce "English 2" into "English 10"', () => {
  // The alias table maps "English 2" ↔ "English II". Neither exists in `rows`,
  // so no match is allowed — even though "English 10" is present.
  const res = resolveCanonicalCourse('English 2', rows);
  assert.equal(res, null);
});

test('resolveCanonicalCourse returns null when nothing matches (no fallback)', () => {
  const res = resolveCanonicalCourse('Underwater Basket Weaving', rows);
  assert.equal(res, null);
});

test('resolveCanonicalCourse returns null on empty inputs', () => {
  assert.equal(resolveCanonicalCourse('', rows), null);
  assert.equal(resolveCanonicalCourse('US History', []), null);
  assert.equal(resolveCanonicalCourse('US History', null), null);
});

test('resolveCanonicalCourse prefers exact over normalized when both would match', () => {
  const dupRows = [
    { course_name: 'us history', subject: 'lower' },
    { course_name: 'US History', subject: 'canonical' },
  ];
  // Exact 'US History' beats the case-insensitive normalized hit on 'us history'.
  const res = resolveCanonicalCourse('US History', dupRows);
  assert.equal(res.canonicalCourse, 'US History');
  assert.equal(res.matchType, 'exact');
});

// ── COURSE_ALIASES sanity: no self-referential or duplicate entries ─────────
test('COURSE_ALIASES entries are all normalized (roundtrip-safe)', () => {
  for (const [k, v] of COURSE_ALIASES) {
    assert.equal(normalizeCourseKey(k), k, `alias key not normalized: ${k}`);
    assert.equal(normalizeCourseKey(v), v, `alias value not normalized: ${v}`);
    assert.notEqual(k, v, `alias key equals value (no-op): ${k}`);
  }
});

// ── closestCourseCandidates ─────────────────────────────────────────────────
test('closestCourseCandidates ranks by normalized-word overlap', () => {
  // "Global Issues for Global Citizenship" (schedule typo) → the row
  // "Global Issues for Global Citizens" shares 4 of 5 words.
  const cands = closestCourseCandidates('Global Issues for Global Citizenship', rows, 3);
  assert.equal(cands[0], 'Global Issues for Global Citizens');
});

test('closestCourseCandidates returns [] when there is no character overlap at all', () => {
  const cands = closestCourseCandidates('Underwater Basket Weaving', [
    { course_name: 'Latin III' },
    { course_name: 'Advanced Chemistry' },
  ]);
  assert.deepEqual(cands, []);
});

// ── findUnresolvedScheduleCourses ───────────────────────────────────────────
test('findUnresolvedScheduleCourses returns only the entries that did NOT resolve', () => {
  const schedule = [
    { course: 'US History (H)', teacher: 'Trevor McNeil' },       // resolves (normalized)
    { course: 'Algebra 2', teacher: 'Randall Joss' },              // resolves (alias)
    { course: 'English 2', teacher: 'Jay Bush' },                  // does NOT resolve
    { course: 'Global Issues for Global Citizenship', teacher: 'Matthew Nelson' }, // does NOT resolve
    { course: 'Biology', teacher: 'Chrissy Orangio' },             // resolves (exact)
  ];
  const unresolved = findUnresolvedScheduleCourses(schedule, rows);
  assert.equal(unresolved.length, 2);
  assert.equal(unresolved[0].scheduleCourse, 'English 2');
  assert.equal(unresolved[0].teacher, 'Jay Bush');
  assert.equal(unresolved[1].scheduleCourse, 'Global Issues for Global Citizenship');
  assert.ok(unresolved[1].candidates.includes('Global Issues for Global Citizens'));
});

test('findUnresolvedScheduleCourses tolerates missing schedule / rows', () => {
  assert.deepEqual(findUnresolvedScheduleCourses([], rows), []);
  assert.deepEqual(findUnresolvedScheduleCourses(null, rows), []);
  const schedule = [{ course: 'Biology', teacher: 'X' }];
  // With no rows, EVERY entry is unresolved.
  const res = findUnresolvedScheduleCourses(schedule, []);
  assert.equal(res.length, 1);
  assert.deepEqual(res[0].candidates, []);
});
