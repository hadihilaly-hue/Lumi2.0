// js/data.js — curriculum data + lookups. Fully pure (no imports, no DOM), so
// these tests exercise the real functions with no stubbing beyond the offline
// globals installed by register.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MENLO_CURRICULUM,
  SUBJECT_IDS,
  SUBJECTS,
  getTeachers,
  searchCurriculum,
} from '../js/data.js';

test('SUBJECTS is derived from MENLO_CURRICULUM with mapped ids', () => {
  // One entry per top-level subject, in insertion order.
  assert.deepEqual(
    SUBJECTS.map((s) => s.name),
    Object.keys(MENLO_CURRICULUM),
  );
  // Ids come from SUBJECT_IDS.
  const byName = Object.fromEntries(SUBJECTS.map((s) => [s.name, s]));
  assert.equal(byName['English'].id, 'english');
  assert.equal(byName['History & Social Sciences'].id, 'history');
  assert.equal(byName['Computer Science'].id, 'cs');
  // Each subject's courses list is exactly the curriculum's course keys.
  assert.deepEqual(byName['Math'].courses, Object.keys(MENLO_CURRICULUM['Math']));
});

test('every curriculum subject has a SUBJECT_IDS mapping', () => {
  // Guards against a subject being added without a stable id (which would fall
  // back to a slugified name).
  for (const name of Object.keys(MENLO_CURRICULUM)) {
    assert.ok(SUBJECT_IDS[name], `missing SUBJECT_IDS entry for "${name}"`);
  }
});

test('getTeachers returns the roster for a known subject+course', () => {
  assert.deepEqual(
    getTeachers('English', 'English 2'),
    ['Jay Bush', 'Lily Chan', 'Rebecca Gertmenian', 'Meghann Schroers-Martin'],
  );
});

test('getTeachers returns [] for an unknown subject or course', () => {
  assert.deepEqual(getTeachers('Astrology', 'Star Charts'), []);
  assert.deepEqual(getTeachers('Math', 'Underwater Basket Weaving'), []);
});

test('searchCurriculum matches teacher names (case-insensitive) as type "teacher"', () => {
  const results = searchCurriculum('jay bush');
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.teacher === 'Jay Bush'));
  // Jay Bush teaches multiple classes — each is a separate hit.
  const courses = results.map((r) => r.course);
  assert.ok(courses.includes('English 2'));
  assert.ok(courses.includes('Global Mythologies'));
  for (const r of results) {
    assert.equal(r.type, 'teacher');
    assert.ok(r.course && r.subject);
  }
});

test('searchCurriculum matches course names as type "class" and carries the roster', () => {
  const results = searchCurriculum('Neuroscience');
  const cls = results.find((r) => r.type === 'class' && r.course === 'Neuroscience');
  assert.ok(cls, 'expected a class hit for Neuroscience');
  assert.deepEqual(cls.teachers, ['Cristina Weaver']);
  assert.equal(cls.subject, 'Science');
});

test('searchCurriculum trims and lowercases the query; blank returns []', () => {
  assert.deepEqual(searchCurriculum(''), []);
  assert.deepEqual(searchCurriculum('   '), []);
  // Leading/trailing whitespace does not prevent a match.
  assert.ok(searchCurriculum('  jay bush  ').length > 0);
});

test('searchCurriculum can return both a teacher hit and a class hit', () => {
  // "Latin" appears in course names ("Latin 1".."Advanced Latin (H)") — all
  // class hits — and is not a teacher name substring, so all hits are classes.
  const results = searchCurriculum('Latin');
  assert.ok(results.length >= 5);
  assert.ok(results.every((r) => r.type === 'class'));
});
