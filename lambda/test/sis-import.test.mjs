// POST /sis-import happy path (admin-only roster ingest). Spec:
// AUDIT_LAMBDA_BUGS.md route map + synthetic_data/schema.md. Complements the
// admin-gate/validation tests in routes.test.mjs by exercising the multi-table
// idempotent write sequence: school → app_users+sis_map → profiles stub →
// teacher_profiles stub → sections → class_enrollments. Identity here comes from
// the validated roster (sis_map), never from a caller-supplied id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, findQuery, findQueries,
  ADMIN, tokenFor,
} from './harness.mjs';

const res = (rows) => ({ rows, rowCount: rows.length });

// A minimal but schema-valid payload: 1 teacher, 1 student, 1 class, 1 enrollment.
const PAYLOAD = {
  school: { name: 'Test High', term: 'Fall 2026', schema_version: '1.0' },
  teachers: [{ id: 't1', email: 'teach@menloschool.org', title: 'Mr.', first_name: 'Ada', last_name: 'Byte' }],
  students: [{ id: 's1', email: 'stud@menloschool.org', grade_level: 10, first_name: 'Sam', last_name: 'Lee' }],
  classes: [{
    id: 'c1', teacher_id: 't1', course_name: 'Algebra', course_code: 'ALG1',
    subject: 'Math', term: 'Fall 2026', name: 'Algebra – A', period: 1, room: '101', meeting_days: ['M', 'W'],
  }],
  enrollments: [{ student_id: 's1', class_id: 'c1' }],
};

// Standalone router for the full write sequence (NOT makeRouter — its built-in
// app_users INSERT matcher would shadow the roster identity resolution below).
// Admin auth needs only the app_users SELECT; admin bypasses the domain gate,
// and /sis-import never calls isTeacher.
function sisRouter() {
  return (text, params) => {
    if (/SELECT lumi_id FROM public\.app_users WHERE cognito_sub/.test(text)) return res([{ lumi_id: ADMIN.userId }]);
    if (/INSERT INTO public\.schools/.test(text)) return res([{ id: 'school-1', allowed_domains: ['menloschool.org'] }]);
    if (/FROM public\.sis_map WHERE school_id/.test(text)) return res([]); // no prior import
    // ensureAppUser: RETURNING lumi_id, (xmax = 0) AS created. params[0] is the email.
    if (/INSERT INTO public\.app_users/.test(text)) return res([{ lumi_id: `lumi-${params[0]}`, created: true }]);
    if (/INSERT INTO public\.sis_map/.test(text)) return res([]);
    if (/INSERT INTO public\.profiles/.test(text)) return res([]);
    if (/INSERT INTO public\.teacher_profiles/.test(text)) return res([{ id: 'tp-1' }]);
    if (/INSERT INTO public\.sections/.test(text)) return res([{ id: 'sec-1' }]);
    if (/INSERT INTO public\.class_enrollments/.test(text)) return res([{ id: 'enr-1' }]);
    return res([]);
  };
}

test('POST /sis-import (admin) completes the full write sequence', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: sisRouter() });
  const r = await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(ADMIN), body: PAYLOAD,
  });
  assert.equal(r.statusCode, 200);
  const out = r.json();
  assert.equal(out.status, 'complete');
  assert.equal(out.school_id, 'school-1');
  assert.equal(out.progress.sections, 1);
  assert.equal(out.progress.enrollments, 1);
  // Every table in the sequence was written.
  assert.ok(findQuery(ctx, /INSERT INTO public\.schools/));
  assert.ok(findQuery(ctx, /INSERT INTO public\.teacher_profiles/));
  assert.ok(findQuery(ctx, /INSERT INTO public\.sections/));
  assert.ok(findQuery(ctx, /INSERT INTO public\.class_enrollments/));
});

test('POST /sis-import forces teacher_email/student identity from the roster, not the caller', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: sisRouter() });
  await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(ADMIN), body: PAYLOAD,
  });
  // teacher_profiles stub keyed to the roster teacher email (lowercased), not the admin.
  const tp = findQuery(ctx, /INSERT INTO public\.teacher_profiles/);
  assert.equal(tp.params[0], 'teach@menloschool.org');
  assert.notEqual(tp.params[0], ADMIN.email);
  // class_enrollments student_id resolves through sis_map (lumi-<email>), never a body id.
  const enr = findQuery(ctx, /INSERT INTO public\.class_enrollments/);
  assert.equal(enr.params[0], 'lumi-stud@menloschool.org');
});

test('POST /sis-import rejects an unsupported schema_version before any write', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: sisRouter() });
  const r = await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(ADMIN),
    body: { ...PAYLOAD, school: { name: 'X', term: 'Y', schema_version: '9.9' } },
  });
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().errors.some((e) => /schema_version/.test(e)));
  assert.equal(findQueries(ctx, /INSERT INTO public\.schools/).length, 0, 'nothing written on validation failure');
});

test('POST /sis-import flags an enrollment referencing an unknown student (validation)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: sisRouter() });
  const r = await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(ADMIN),
    body: { ...PAYLOAD, enrollments: [{ student_id: 'ghost', class_id: 'c1' }] },
  });
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().errors.some((e) => /unknown student_id ghost/.test(e)));
});
