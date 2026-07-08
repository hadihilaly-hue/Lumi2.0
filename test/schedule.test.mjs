// js/schedule.js — the pure catalog-transform helpers behind the data-driven
// class picker (GET /available-classes → MENLO_CURRICULUM-shaped map). The
// wizard body itself is DOM-bound and out of scope for the offline harness, but
// these two transforms are pure and carry the backward-compat guarantee, so they
// are worth pinning.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERIC_SUBJECT,
  buildCurriculumFromRows,
  mergePrefillCourses,
} from '../js/schedule.js';

test('buildCurriculumFromRows groups rows into { subject: { course: [teachers] } }', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Algebra 2', teacher_name: 'A Teacher', teacher_email: 'a@menloschool.org', subject: 'Math' },
    { course_name: 'Biology', teacher_name: 'B Teacher', teacher_email: 'b@menloschool.org', subject: 'Science' },
  ]);
  assert.deepEqual(cur, {
    Math: { 'Algebra 2': ['A Teacher'] },
    Science: { Biology: ['B Teacher'] },
  });
});

test('buildCurriculumFromRows accumulates multiple teachers for the same course', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Algebra 2', teacher_name: 'A Teacher', subject: 'Math' },
    { course_name: 'Algebra 2', teacher_name: 'Second Teacher', subject: 'Math' },
    { course_name: 'Algebra 2', teacher_name: 'A Teacher', subject: 'Math' }, // dup ignored
  ]);
  assert.deepEqual(cur.Math['Algebra 2'], ['A Teacher', 'Second Teacher']);
});

test('buildCurriculumFromRows buckets a null subject under the generic header', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Democratic Backsliding', teacher_name: 'C Teacher', subject: null },
  ]);
  assert.deepEqual(cur, { [GENERIC_SUBJECT]: { 'Democratic Backsliding': ['C Teacher'] } });
});

test('buildCurriculumFromRows falls back to the email local-part when name is absent', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Chemistry', teacher_email: 'jdoe@menloschool.org', subject: 'Science' },
  ]);
  assert.deepEqual(cur.Science.Chemistry, ['jdoe']);
});

test('buildCurriculumFromRows skips rows with no course_name and tolerates empty/nullish input', () => {
  assert.deepEqual(buildCurriculumFromRows([{ teacher_name: 'X', subject: 'Math' }]), {});
  assert.deepEqual(buildCurriculumFromRows([]), {});
  assert.deepEqual(buildCurriculumFromRows(null), {});
});

test('mergePrefillCourses adds an enrolled class missing from the DB list (backward compat)', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Algebra 2', teacher_name: 'A Teacher', subject: 'Math' },
  ]);
  mergePrefillCourses(cur, [{ course: 'US History', teacher: 'H Teacher', subject: 'History & Social Sciences' }]);
  assert.deepEqual(cur['History & Social Sciences'], { 'US History': ['H Teacher'] });
  // The DB-sourced class is untouched.
  assert.deepEqual(cur.Math, { 'Algebra 2': ['A Teacher'] });
});

test('mergePrefillCourses does not duplicate a course already present in the map', () => {
  const cur = buildCurriculumFromRows([
    { course_name: 'Algebra 2', teacher_name: 'A Teacher', subject: 'Math' },
  ]);
  mergePrefillCourses(cur, [{ course: 'Algebra 2', teacher: 'Different Name', subject: 'Math' }]);
  // Still exactly one teacher — the prefill did not append to an already-listed course.
  assert.deepEqual(cur.Math['Algebra 2'], ['A Teacher']);
});

test('mergePrefillCourses buckets a subject-less prefill entry under the generic header', () => {
  const cur = {};
  mergePrefillCourses(cur, [{ course: 'Mystery Elective', teacher: 'Z Teacher' }]);
  assert.deepEqual(cur, { [GENERIC_SUBJECT]: { 'Mystery Elective': ['Z Teacher'] } });
});
