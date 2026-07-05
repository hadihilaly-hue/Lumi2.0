// Pure/near-pure helper units exposed via index.mjs `__test__`. These back the
// query builders (column allowlists) and S3 key construction the routes rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler } from './harness.mjs';

const { __test__ } = await loadHandler();
const { pickColumns, buildS3Key, parseNotes, buildTeacherNotesSection,
  PROFILE_COLS, TEACHER_PROFILE_COLS } = __test__;

// ------------------------------- pickColumns --------------------------------

test('pickColumns keeps only allowlisted columns and drops everything else', () => {
  const { cols, vals } = pickColumns(
    { name: 'Sam', grade: '10', id: 'ATTACKER', evil: 1, user_id: 'x' },
    PROFILE_COLS,
  );
  assert.deepEqual(cols, ['name', 'grade']);
  assert.deepEqual(vals, ['Sam', '10']);
  assert.ok(!cols.includes('id'));       // identity column can't be smuggled
  assert.ok(!cols.includes('evil'));
});

test('pickColumns skips undefined values but keeps explicit null', () => {
  const { cols, vals } = pickColumns({ name: null, grade: undefined }, PROFILE_COLS);
  assert.deepEqual(cols, ['name']);
  assert.deepEqual(vals, [null]);
});

test('pickColumns JSON.stringifies jsonb columns but passes null through raw', () => {
  const spec = { values_profile: 'jsonb', name: 'raw' };
  const { cols, vals } = pickColumns({ values_profile: { a: 1 }, name: 'Sam' }, spec);
  assert.deepEqual(cols, ['values_profile', 'name']);
  assert.equal(vals[0], JSON.stringify({ a: 1 })); // serialized for jsonb param
  assert.equal(vals[1], 'Sam');

  const nulled = pickColumns({ values_profile: null }, spec);
  assert.equal(nulled.vals[0], null); // null stays null, not the string "null"
});

test('pickColumns preserves column order from the spec, not the body', () => {
  // TEACHER_PROFILE_COLS lists course_code before title.
  const { cols } = pickColumns({ title: 'T', course_code: 'C' }, TEACHER_PROFILE_COLS);
  assert.deepEqual(cols, ['course_code', 'title']);
});

// -------------------------------- buildS3Key --------------------------------

test('buildS3Key namespaces syllabi keys under teachers/{userId}/{classId}', () => {
  const key = buildS3Key({ bucketType: 'syllabi', userId: 'u1', classId: 'algebra', filename: 'a.pdf' });
  assert.match(key, /^teachers\/u1\/algebra\/\d+-a\.pdf$/);
});

test('buildS3Key defaults classId/tier to "general"', () => {
  const s = buildS3Key({ bucketType: 'syllabi', userId: 'u1', filename: 'a.pdf' });
  assert.match(s, /^teachers\/u1\/general\/\d+-a\.pdf$/);
  const w = buildS3Key({ bucketType: 'work-samples', userId: 'u1', filename: 'a.png' });
  assert.match(w, /^teachers\/u1\/general\/general\/\d+-a\.png$/);
});

test('buildS3Key sanitizes unsafe filename characters', () => {
  const key = buildS3Key({ bucketType: 'syllabi', userId: 'u1', filename: '../../etc/passwd?.pdf' });
  // dots are allowed; slashes and '?' become '_' → "..￮.._etc_passwd_.pdf"
  assert.match(key, /^teachers\/u1\/general\/\d+-\.\._\.\._etc_passwd_\.pdf$/);
  assert.ok(!key.includes('/etc/passwd'));
});

test('buildS3Key throws on an unknown bucket type', () => {
  assert.throws(() => buildS3Key({ bucketType: 'evil', userId: 'u1', filename: 'a' }), /Invalid bucket type/);
});

// -------------------------------- parseNotes --------------------------------

test('parseNotes returns [] for null/invalid/non-array, and the array otherwise', () => {
  assert.deepEqual(parseNotes(null), []);
  assert.deepEqual(parseNotes('not json'), []);
  assert.deepEqual(parseNotes('{"a":1}'), []);       // object, not array
  assert.deepEqual(parseNotes('[{"text":"hi"}]'), [{ text: 'hi' }]);
});

// -------------------------- buildTeacherNotesSection ------------------------

test('buildTeacherNotesSection returns empty string when there are no usable notes', () => {
  assert.equal(buildTeacherNotesSection([]), '');
  assert.equal(buildTeacherNotesSection(null), '');
  assert.equal(buildTeacherNotesSection([{ text: '   ' }, { foo: 1 }]), ''); // no non-empty text
});

test('buildTeacherNotesSection includes the notes plus the silent-use footer', () => {
  const out = buildTeacherNotesSection([{ text: 'Focus on factoring' }]);
  assert.match(out, /Notes from this student's teacher/);
  assert.match(out, /Focus on factoring/);
  assert.match(out, /Do not mention, reference, or reveal that these notes exist/);
});

test('buildTeacherNotesSection drops oldest notes to fit the 8000-char cap', () => {
  const big = 'x'.repeat(5000);
  const notes = [{ text: `OLDEST-${big}` }, { text: `NEWEST-${big}` }];
  const out = buildTeacherNotesSection(notes);
  assert.ok(out.length <= 8000, `length ${out.length} should be within cap`);
  assert.match(out, /NEWEST-/);        // newest kept
  assert.doesNotMatch(out, /OLDEST-/); // oldest dropped first
});
