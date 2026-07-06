// Per-route authorization + user-scoping. Spec: AUDIT_LAMBDA_BUGS.md route map.
// For every route we assert the three trust-boundary invariants that apply:
//   (a) identity/key columns come from the JWT, never the request body
//   (b) destructive queries (UPDATE/DELETE) are user- or owner-scoped
//   (c) per-route authz (admin-only, teacher-only, 2-step owner checks)
//
// Chat + notes-injection + suggested-prompts live in chat.test.mjs (they arm
// real timers and need fake-timer control).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery, findQueries,
  STUDENT, TEACHER, ADMIN, DOMAIN, tokenFor,
} from './harness.mjs';

const res = (rows) => ({ rows, rowCount: rows.length });

// ============================ /teacher-profile ==============================

test('POST /teacher-profile forces teacher_email from the JWT, ignoring the body', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true, provisionedTeacher: true,
      onRoute: (t) => /INSERT INTO public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/teacher-profile', token: tokenFor(TEACHER),
    body: { teacher_email: 'victim@menloschool.org', course_name: 'Algebra', done: true },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /INSERT INTO public\.teacher_profiles/);
  // teacher_email is $1 and forced to the caller's JWT email — not "victim".
  assert.equal(q.params[0], TEACHER.email);
  assert.ok(/\(teacher_email, course_name/.test(q.text), 'teacher_email is a forced insert column');
  assert.notEqual(q.params[0], 'victim@menloschool.org');
});

test('PATCH /teacher-profile scopes the UPDATE to the caller JWT email', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true, provisionedTeacher: true,
      onRoute: (t) => /UPDATE public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'PATCH', path: '/teacher-profile', token: tokenFor(TEACHER),
    body: { course_name: 'Algebra', title: 'New' },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /UPDATE public\.teacher_profiles/);
  assert.ok(/WHERE teacher_email = \$1 AND course_name = \$2/.test(q.text));
  assert.equal(q.params[0], TEACHER.email);
});

test('GET /teacher-profile?scope=all is admin-only (403 for a teacher)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: TEACHER.userId, isTeacher: true }) });
  const r = await invoke(handler, {
    method: 'GET', path: '/teacher-profile', query: { scope: 'all' }, token: tokenFor(TEACHER),
  });
  assert.equal(r.statusCode, 403);
});

test('GET /teacher-profile?scope=all works for an admin', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: ADMIN.userId, domains: [],
      onRoute: (t) => /FROM public\.teacher_profiles ORDER BY updated_at/.test(t) ? res([{ teacher_email: 'a@b.org' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/teacher-profile', query: { scope: 'all' }, token: tokenFor(ADMIN),
  });
  assert.equal(r.statusCode, 200);
  assert.ok(findQuery(ctx, /FROM public\.teacher_profiles ORDER BY updated_at DESC/));
});

test('GET /teacher-profile cross-teacher read withholds S3 key columns from non-owners (H3 fix)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.teacher_profiles WHERE teacher_email/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/teacher-profile', token: tokenFor(STUDENT),
    query: { teacher_email: 'someteacher@menloschool.org' },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /FROM public\.teacher_profiles WHERE teacher_email = \$1/);
  // Non-owner projection must not leak the download-url key columns (H2 input).
  assert.doesNotMatch(q.text, /syllabus_file_path/);
  assert.doesNotMatch(q.text, /syllabus_paths/);
  assert.match(q.text, /engagement_rules/); // persona columns still returned
});

test('GET /teacher-profile owner read (own email) uses SELECT *', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => /FROM public\.teacher_profiles WHERE teacher_email/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  await invoke(handler, { method: 'GET', path: '/teacher-profile', token: tokenFor(TEACHER) });
  const q = findQuery(ctx, /FROM public\.teacher_profiles WHERE teacher_email = \$1/);
  assert.match(q.text, /SELECT \* FROM public\.teacher_profiles/);
  assert.equal(q.params[0], TEACHER.email); // self
});

// AUDIT_LAMBDA_BUGS H1: teacher status must not be self-asserted. A caller with
// no server-controlled teacher standing (not admin, no sis_map teacher row, no
// existing/seeded teacher_profiles row) cannot create a teacher profile — so
// they cannot set done=true and self-promote.
test('POST /teacher-profile rejects a non-provisioned caller (H1: no self-promotion via done=true)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, provisionedTeacher: false,
      onRoute: (t) => /INSERT INTO public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/teacher-profile', token: tokenFor(STUDENT),
    body: { course_name: 'Fake Class', done: true },
  });
  assert.equal(r.statusCode, 403);
  // Nothing was written — the self-promotion INSERT never ran.
  assert.equal(findQuery(ctx, /INSERT INTO public\.teacher_profiles/), undefined);
});

test('POST /teacher-profile allows a provisioned teacher (roster / seeded profile)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, provisionedTeacher: true,
      onRoute: (t) => /INSERT INTO public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/teacher-profile', token: tokenFor(TEACHER),
    body: { course_name: 'Algebra', done: true },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /INSERT INTO public\.teacher_profiles/);
  assert.ok(q, 'the upsert runs for an authorized teacher');
  assert.equal(q.params[0], TEACHER.email);
});

test('PATCH /teacher-profile rejects a non-provisioned caller (H1)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, provisionedTeacher: false,
      onRoute: (t) => /UPDATE public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'PATCH', path: '/teacher-profile', token: tokenFor(STUDENT),
    body: { course_name: 'Algebra', done: true },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(findQuery(ctx, /UPDATE public\.teacher_profiles/), undefined);
});

test('POST /teacher-profile: an admin is always authorized (adminEmails bypass)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: ADMIN.userId, domains: [], provisionedTeacher: false,
      onRoute: (t) => /INSERT INTO public\.teacher_profiles/.test(t) ? res([{ id: 'tp1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/teacher-profile', token: tokenFor(ADMIN),
    body: { course_name: 'Algebra', done: true },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(findQuery(ctx, /INSERT INTO public\.teacher_profiles/));
});

// ================================ /profiles =================================

test('POST /profiles forces id from the JWT and ignores body.id', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /INSERT INTO public\.profiles/.test(t) ? res([{ id: STUDENT.userId }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/profiles', token: tokenFor(STUDENT),
    body: { id: 'ATTACKER-UUID', name: 'Sam' },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /INSERT INTO public\.profiles/);
  assert.match(q.text, /INSERT INTO public\.profiles \(id, name\)/);
  assert.equal(q.params[0], STUDENT.userId, 'id bound to JWT user id');
  assert.ok(!q.params.includes('ATTACKER-UUID'), 'body.id never reaches SQL');
});

test('PATCH /profiles scopes the UPDATE to the JWT user id', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /UPDATE public\.profiles/.test(t) ? res([{ id: STUDENT.userId }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'PATCH', path: '/profiles', token: tokenFor(STUDENT),
    body: { id: 'ATTACKER-UUID', name: 'Sam' },
  });
  const q = findQuery(ctx, /UPDATE public\.profiles/);
  assert.match(q.text, /WHERE id = \$1/);
  assert.equal(q.params[0], STUDENT.userId);
});

// ============================== /conversations ==============================

test('POST /conversations forces user_id from the JWT', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /INSERT INTO public\.conversations/.test(t) ? res([{ id: 'conv1' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'POST', path: '/conversations', token: tokenFor(STUDENT),
    body: { user_id: 'ATTACKER', title: 'hi', messages: [{ role: 'user', content: 'x' }] },
  });
  const q = findQuery(ctx, /INSERT INTO public\.conversations/);
  assert.equal(q.params[0], STUDENT.userId);
  assert.ok(!q.params.includes('ATTACKER'));
});

test('PATCH /conversations UPDATE is scoped by (id, user_id)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /UPDATE public\.conversations/.test(t) ? res([{ id: 'conv1', updated_at: 't' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'PATCH', path: '/conversations', token: tokenFor(STUDENT),
    body: { id: 'conv1', title: 'renamed' },
  });
  const q = findQuery(ctx, /UPDATE public\.conversations/);
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  // params are [id ($1), user_id ($2), ...set-vals] — user_id forced to the JWT.
  assert.equal(q.params[0], 'conv1');
  assert.equal(q.params[1], STUDENT.userId);
});

test('DELETE /conversations?id scopes by (id, user_id) — cannot delete another user row', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, onRoute: () => res([]) }) });
  await invoke(handler, {
    method: 'DELETE', path: '/conversations', token: tokenFor(STUDENT), query: { id: 'someone-elses-conv' },
  });
  const q = findQuery(ctx, /DELETE FROM public\.conversations/);
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(q.params, ['someone-elses-conv', STUDENT.userId]);
});

test('DELETE /conversations?all=true wipes only the caller rows (user-scoped)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, onRoute: () => res([]) }) });
  await invoke(handler, {
    method: 'DELETE', path: '/conversations', token: tokenFor(STUDENT), query: { all: 'true' },
  });
  const q = findQuery(ctx, /DELETE FROM public\.conversations/);
  assert.match(q.text, /WHERE user_id = \$1$/);
  assert.deepEqual(q.params, [STUDENT.userId]);
});

// ============================== /homework-tasks =============================

test('POST /homework-tasks forces user_id per row and guards the upsert conflict arm', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /INSERT INTO public\.homework_tasks/.test(t) ? res([{ id: 'h1' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'POST', path: '/homework-tasks', token: tokenFor(STUDENT),
    body: [{ id: 'h1', user_id: 'ATTACKER', title: 'HW' }],
  });
  const q = findQuery(ctx, /INSERT INTO public\.homework_tasks/);
  // Per-row values are [id, user_id, ...cols]; user_id (params[1]) forced to JWT.
  assert.equal(q.params[0], 'h1');
  assert.equal(q.params[1], STUDENT.userId);
  assert.ok(!q.params.includes('ATTACKER'));
  // The conflict arm refuses to overwrite another user's row.
  assert.match(q.text, /WHERE homework_tasks\.user_id = EXCLUDED\.user_id/);
});

test('DELETE /homework-tasks?id scopes by (id, user_id)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, onRoute: () => res([]) }) });
  await invoke(handler, {
    method: 'DELETE', path: '/homework-tasks', token: tokenFor(STUDENT), query: { id: 'h-other' },
  });
  const q = findQuery(ctx, /DELETE FROM public\.homework_tasks/);
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(q.params, ['h-other', STUDENT.userId]);
});

// =============================== /work-samples ==============================

test('POST /work-samples denies a non-owning teacher (2-step owner check → 403)', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => /SELECT teacher_email FROM public\.teacher_profiles WHERE id/.test(t)
        ? res([{ teacher_email: 'owner@menloschool.org' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/work-samples', token: tokenFor(TEACHER),
    body: { teacher_profile_id: 'tp-not-mine', tier: 'proficient', description: 'x' },
  });
  assert.equal(r.statusCode, 403);
});

test('POST /work-samples 404s when the target profile does not exist', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: () => res([]), // owner lookup returns nothing
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/work-samples', token: tokenFor(TEACHER),
    body: { teacher_profile_id: 'ghost', tier: 'proficient', description: 'x' },
  });
  assert.equal(r.statusCode, 404);
});

test('POST /work-samples succeeds for the owning teacher and writes the sample', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => {
        if (/SELECT teacher_email FROM public\.teacher_profiles WHERE id/.test(t)) return res([{ teacher_email: TEACHER.email }]);
        if (/INSERT INTO public\.teacher_work_samples/.test(t)) return res([{ id: 'ws1' }]);
        return res([]);
      },
    }),
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/work-samples', token: tokenFor(TEACHER),
    body: { teacher_profile_id: 'tp-mine', tier: 'proficient', description: 'great work' },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(findQuery(ctx, /INSERT INTO public\.teacher_work_samples/));
});

test('DELETE /work-samples denies a non-owner (403)', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: () => res([{ teacher_email: 'owner@menloschool.org' }]),
    }),
  });
  const r = await invoke(handler, {
    method: 'DELETE', path: '/work-samples', token: tokenFor(TEACHER),
    query: { teacher_profile_id: 'tp-not-mine', tier: 'proficient' },
  });
  assert.equal(r.statusCode, 403);
});

test('GET /work-samples is readable by any authenticated user (documented auth_read)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.teacher_work_samples/.test(t) ? res([{ id: 'ws1' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/work-samples', token: tokenFor(STUDENT),
    query: { teacher_profile_id: 'tp1' },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /FROM public\.teacher_work_samples/);
  assert.match(q.text, /teacher_profile_id = ANY\(\$1::uuid\[\]\)/);
});

// ============================ /class-enrollments ============================

test('POST /class-enrollments forces student_id from the JWT on every row', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /INSERT INTO public\.class_enrollments/.test(t) ? res([{ id: 'e1' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'POST', path: '/class-enrollments', token: tokenFor(STUDENT),
    body: [{ teacher_profile_id: 'tp1', block: 'A', student_name: 'Sam', student_id: 'ATTACKER' }],
  });
  const q = findQuery(ctx, /INSERT INTO public\.class_enrollments/);
  // Row values are [student_id, teacher_profile_id, block, student_name].
  assert.equal(q.params[0], STUDENT.userId);
  assert.ok(!q.params.includes('ATTACKER'));
});

test('PATCH /class-enrollments (teacher note) requires the owning teacher — 403 otherwise', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => /JOIN public\.teacher_profiles/.test(t) ? res([{ teacher_email: 'other@menloschool.org' }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'PATCH', path: '/class-enrollments', token: tokenFor(TEACHER),
    body: { id: 'e1', teacher_notes: 'note' },
  });
  assert.equal(r.statusCode, 403);
});

test('PATCH /class-enrollments succeeds for the owning teacher', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => {
        if (/JOIN public\.teacher_profiles/.test(t)) return res([{ teacher_email: TEACHER.email }]);
        if (/UPDATE public\.class_enrollments/.test(t)) return res([{ id: 'e1', updated_at: 't' }]);
        return res([]);
      },
    }),
  });
  const r = await invoke(handler, {
    method: 'PATCH', path: '/class-enrollments', token: tokenFor(TEACHER),
    body: { id: 'e1', teacher_notes: 'note' },
  });
  assert.equal(r.statusCode, 200);
});

test('GET /class-enrollments (student scope) reads only the caller rows and hides teacher_notes', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.class_enrollments WHERE student_id/.test(t) ? res([{ id: 'e1' }]) : res([]),
    }),
  });
  await invoke(handler, { method: 'GET', path: '/class-enrollments', token: tokenFor(STUDENT) });
  const q = findQuery(ctx, /FROM public\.class_enrollments WHERE student_id = \$1/);
  assert.equal(q.params[0], STUDENT.userId);
  assert.doesNotMatch(q.text, /teacher_notes/); // never returned to a student
});

test('GET /class-enrollments?scope=teaching scopes the roster to the caller-owned classes', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: TEACHER.userId, isTeacher: true,
      onRoute: (t) => /JOIN public\.teacher_profiles tp/.test(t) ? res([{ id: 'e1' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'GET', path: '/class-enrollments', token: tokenFor(TEACHER), query: { scope: 'teaching' },
  });
  const q = findQuery(ctx, /WHERE tp\.teacher_email = \$1/);
  assert.ok(q);
  assert.equal(q.params[0], TEACHER.email);
});

// ================================ /sis-import ===============================

test('POST /sis-import is admin-only (403 for a teacher)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: TEACHER.userId, isTeacher: true }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(TEACHER), body: { school: {} },
  });
  assert.equal(r.statusCode, 403);
});

test('POST /sis-import passes the admin gate (reaches validation, not 403)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: ADMIN.userId, domains: [] }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/sis-import', token: tokenFor(ADMIN), body: { school: {} },
  });
  assert.notEqual(r.statusCode, 403);
  assert.equal(r.statusCode, 400); // validation errors, admin was allowed through
});

// ================================ /upload-url ===============================

test('POST /upload-url is teacher-only (403 for a student)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, isTeacher: false }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/upload-url', token: tokenFor(STUDENT),
    body: { bucket: 'syllabi', filename: 'x.pdf' },
  });
  assert.equal(r.statusCode, 403);
});

test('POST /upload-url signs a key namespaced to the JWT user id (not a body-supplied id)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: TEACHER.userId, isTeacher: true }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/upload-url', token: tokenFor(TEACHER),
    body: { bucket: 'syllabi', filename: 'syllabus.pdf', userId: 'ATTACKER', classId: 'c1' },
  });
  assert.equal(r.statusCode, 200);
  const out = r.json();
  assert.ok(out.key.startsWith(`teachers/${TEACHER.userId}/`), out.key);
  assert.ok(!out.key.includes('ATTACKER'));
  assert.equal(ctx.signRequests.length, 1);
  assert.equal(ctx.signRequests[0].command.Bucket, 'lumi-syllabi-613136968914');
});

// =============================== /download-url ==============================

// AUDIT_LAMBDA_BUGS H2: /download-url must not sign a syllabus URL for a key the
// caller does not own. This previously PINNED the broken "signs any key" behavior;
// it is flipped here to assert the fix (403 + no sign for a non-owned syllabus key).
test('POST /download-url refuses a syllabus key the caller does not own (H2 fix)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(STUDENT),
    body: { bucket: 'syllabi', key: 'teachers/some-other-teacher/general/1-file.pdf' },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(ctx.signRequests.length, 0, 'no URL signed for a non-owned syllabus key');
});

test('POST /download-url signs a syllabus URL for the key owner (H2)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: TEACHER.userId }) });
  const key = `teachers/${TEACHER.userId}/general/1-file.pdf`;
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(TEACHER),
    body: { bucket: 'syllabi', key },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(ctx.signRequests.length, 1);
  assert.equal(ctx.signRequests[0].command.Key, key);
});

test('POST /download-url lets an admin sign any syllabus key (H2 admin bypass)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: ADMIN.userId, domains: [] }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(ADMIN),
    body: { bucket: 'syllabi', key: 'teachers/some-other-teacher/general/1-file.pdf' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(ctx.signRequests.length, 1);
});

// work-samples download is intentionally open to any authed caller (the runtime
// vision pipeline fetches a teacher's work-sample photos for enrolled students).
test('POST /download-url still signs work-sample keys for any authed caller (documented)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const key = 'teachers/some-teacher/algebra/proficient/1-photo.jpg';
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(STUDENT),
    body: { bucket: 'work-samples', key },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(ctx.signRequests[0].command.Key, key);
});

test('POST /download-url 400s on an unknown bucket', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(STUDENT),
    body: { bucket: 'evil', key: 'teachers/x/y/z.pdf' },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(ctx.signRequests.length, 0);
});

test('POST /download-url 400s without bucket/key', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/download-url', token: tokenFor(STUDENT), body: { bucket: 'syllabi' },
  });
  assert.equal(r.statusCode, 400);
});

// ============================== method fallthrough ==========================

test('unsupported method on a data route returns 405', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, { method: 'DELETE', path: '/profiles', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 405);
});

// ------------------- additional user-scoping / validation --------------------

test('GET /conversations scopes the read to the JWT user id', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.conversations/.test(t) ? res([{ id: 'c1' }]) : res([]),
    }),
  });
  await invoke(handler, { method: 'GET', path: '/conversations', token: tokenFor(STUDENT) });
  const q = findQuery(ctx, /FROM public\.conversations\s+WHERE user_id = \$1/);
  assert.ok(q);
  assert.equal(q.params[0], STUDENT.userId);
});

// AUDIT_LAMBDA_PERF #3: the list must not ship every conversation's full
// `messages` jsonb. It selects metadata + a computed preview + exchange_count.
test('GET /conversations list is lightweight (no messages blob; computes preview + count)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.conversations/.test(t)
        ? res([{ id: 'c1', title: 't', preview: 'hi', exchange_count: 2 }]) : res([]),
    }),
  });
  const r = await invoke(handler, { method: 'GET', path: '/conversations', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /FROM public\.conversations\s+WHERE user_id = \$1/);
  // The list SELECT does NOT project the raw messages column (old shape was
  // `SELECT id, title, messages, teacher, ...`). `messages` now appears only
  // inside the jsonb_array_elements() subqueries that compute preview/count.
  assert.doesNotMatch(q.text, /SELECT id, title, messages/);
  // ...but it DOES compute the two fields the sidebar needs.
  assert.match(q.text, /AS exchange_count/);
  assert.match(q.text, /AS preview/);
});

test('GET /conversations?id= returns one owned conversation with its full messages', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /FROM public\.conversations\s+WHERE id = \$1 AND user_id = \$2/.test(t)
        ? res([{ id: 'c1', messages: [{ role: 'user', content: 'hi' }] }]) : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/conversations', query: { id: 'c1' }, token: tokenFor(STUDENT),
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.messages), 'single-conversation fetch includes messages');
  const q = findQuery(ctx, /FROM public\.conversations\s+WHERE id = \$1 AND user_id = \$2/);
  assert.match(q.text, /\bmessages\b/);
  assert.deepEqual(q.params, ['c1', STUDENT.userId]); // scoped to the caller
});

test('GET /conversations?id= 404s a conversation the caller does not own', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId, onRoute: () => res([]) }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/conversations', query: { id: 'someone-elses' }, token: tokenFor(STUDENT),
  });
  assert.equal(r.statusCode, 404);
});

test('PATCH /homework-tasks scopes the UPDATE by (id, user_id)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (t) => /UPDATE public\.homework_tasks/.test(t) ? res([{ id: 'h1' }]) : res([]),
    }),
  });
  await invoke(handler, {
    method: 'PATCH', path: '/homework-tasks', token: tokenFor(STUDENT),
    body: { id: 'h1', is_complete: true },
  });
  const q = findQuery(ctx, /UPDATE public\.homework_tasks/);
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.equal(q.params[0], 'h1');
  assert.equal(q.params[1], STUDENT.userId);
});

test('DELETE /homework-tasks?all=true wipes only the caller rows', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, onRoute: () => res([]) }) });
  await invoke(handler, {
    method: 'DELETE', path: '/homework-tasks', token: tokenFor(STUDENT), query: { all: 'true' },
  });
  const q = findQuery(ctx, /DELETE FROM public\.homework_tasks/);
  assert.match(q.text, /WHERE user_id = \$1$/);
  assert.deepEqual(q.params, [STUDENT.userId]);
});

test('POST /class-enrollments rejects an invalid block letter (400, no write)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/class-enrollments', token: tokenFor(STUDENT),
    body: [{ teacher_profile_id: 'tp1', block: 'Z', student_name: 'Sam' }],
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /block must be A-G/);
  assert.equal(findQuery(ctx, /INSERT INTO public\.class_enrollments/), undefined);
});

test('POST /homework-tasks rejects more than 200 tasks (400)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const tasks = Array.from({ length: 201 }, (_, i) => ({ id: `h${i}`, title: 't' }));
  const r = await invoke(handler, {
    method: 'POST', path: '/homework-tasks', token: tokenFor(STUDENT), body: tasks,
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Too many tasks/);
});

test('a valid JSON body is required (400 on malformed JSON)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/profiles', token: tokenFor(STUDENT), rawBody: '{not json',
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'Invalid JSON');
});
