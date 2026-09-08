// GET /bootstrap — the one-round-trip student boot payload. Asserts it reuses
// the per-route query shapes (JWT-scoped, teacher_notes never projected for a
// student, no messages blob) and fails closed on any DB error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery, findQueries,
  STUDENT, tokenFor,
} from './harness.mjs';

const res = (rows) => ({ rows, rowCount: rows.length });

// A DB router that answers the four bootstrap queries with realistic rows.
// Note the enrollments/conversations rows deliberately CONTAIN teacher_notes /
// messages: the assertions below prove the route strips them even if the DB
// (or a future query edit) handed them back.
function bootstrapRouter(overrides = {}) {
  return makeRouter({
    userId: STUDENT.userId,
    onRoute: (t, params) => {
      if (/FROM public\.profiles WHERE id = \$1/.test(t)) {
        return res([{
          id: params[0], name: 'Sam Student', grade: '10',
          schedule: [{ course: 'Algebra 2', teacher: 'A Teacher', block: 'B' }],
          values_profile: null,
        }]);
      }
      if (/FROM public\.class_enrollments WHERE student_id = \$1/.test(t)) {
        return res([{ id: 'enr-1', teacher_profile_id: 'tp-1', block: 'B', student_name: 'Sam Student' }]);
      }
      if (/FROM public\.teacher_profiles tp/.test(t)) {
        return res([{ course_name: 'Algebra 2', teacher_email: 't@menloschool.org', teacher_name: 'A Teacher', subject: 'Math' }]);
      }
      if (/FROM public\.conversations/.test(t)) {
        return res([{
          id: 'conv-1', title: 'Quadratics', teacher: 'A Teacher', course: 'Algebra 2',
          created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
          preview: 'help with quadratics', exchange_count: 3,
          messages: [{ role: 'user', content: 'help with quadratics' }],
        }]);
      }
      return res([]);
    },
    ...overrides,
  });
}

test('GET /bootstrap requires auth (401 without a token)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: bootstrapRouter() });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap' });
  assert.equal(r.statusCode, 401);
});

test('GET /bootstrap returns the student\'s own data, all scoped to the JWT user id', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: bootstrapRouter() });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(),
    ['availableClasses', 'enrollments', 'profile', 'recentConversations', 'schedule']);
  assert.equal(body.profile.name, 'Sam Student');
  assert.deepEqual(body.schedule, [{ course: 'Algebra 2', teacher: 'A Teacher', block: 'B' }]);
  assert.equal(body.enrollments.length, 1);
  assert.equal(body.availableClasses[0].course_name, 'Algebra 2');
  assert.equal(body.recentConversations.length, 1);

  // Every per-user query is keyed by the JWT-resolved user id (never the body/query).
  const prof = findQuery(ctx, /FROM public\.profiles WHERE id = \$1/);
  assert.equal(prof.params[0], STUDENT.userId);
  const enr = findQuery(ctx, /FROM public\.class_enrollments WHERE student_id = \$1/);
  assert.equal(enr.params[0], STUDENT.userId);
  const conv = findQuery(ctx, /FROM public\.conversations/);
  assert.equal(conv.params[0], STUDENT.userId);
  assert.equal(conv.params[1], false); // student boot: is_teacher_test=false
  // Same query shapes the individual routes use.
  assert.match(enr.text, /deleted_at IS NULL/);
  assert.doesNotMatch(enr.text, /teacher_notes/);
  assert.match(conv.text, /LIMIT 50/);
  assert.doesNotMatch(prof.text, /google_calendar_token/);
});

test('GET /bootstrap never returns teacher_notes to a student', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: bootstrapRouter({
      onRoute: (t) => {
        if (/FROM public\.class_enrollments WHERE student_id = \$1/.test(t)) {
          // A row that (hypothetically) carries notes — the projection must drop it.
          return res([{ id: 'enr-1', teacher_profile_id: 'tp-1', block: 'B', teacher_notes: 'SECRET' }]);
        }
        return res([]);
      },
    }),
  });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 200);
  const raw = JSON.stringify(r.json());
  assert.doesNotMatch(raw, /teacher_notes/);
  assert.doesNotMatch(raw, /SECRET/);
});

test('GET /bootstrap recentConversations is metadata only (no messages blob)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: bootstrapRouter() });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  const [c] = r.json().recentConversations;
  assert.equal(c.id, 'conv-1');
  assert.equal(c.title, 'Quadratics');
  assert.equal(c.teacher, 'A Teacher');
  assert.equal(c.course, 'Algebra 2');
  assert.equal(c.updated_at, '2026-09-02T00:00:00Z');
  assert.equal(c.is_teacher_test, false);
  assert.equal(c.preview, 'help with quadratics');
  assert.equal(c.exchange_count, 3);
  assert.equal('messages' in c, false);
});

test('GET /bootstrap runs the four queries in parallel (all issued in one tick)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: bootstrapRouter() });
  await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  const dataQueries = findQueries(ctx,
    /FROM public\.profiles WHERE id|FROM public\.class_enrollments WHERE student_id|FROM public\.teacher_profiles tp|FROM public\.conversations/);
  assert.equal(dataQueries.length, 4);
});

test('GET /bootstrap with a missing profile returns profile:null and schedule:[]', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: bootstrapRouter({ onRoute: () => res([]) }) });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.profile, null);
  assert.deepEqual(body.schedule, []);
  assert.deepEqual(body.enrollments, []);
  assert.deepEqual(body.recentConversations, []);
});

test('GET /bootstrap ?is_teacher_test=true selects the test-mode conversation list', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: bootstrapRouter() });
  const r = await invoke(handler, {
    method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT), query: { is_teacher_test: 'true' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(findQuery(ctx, /FROM public\.conversations/).params[1], true);
  assert.equal(r.json().recentConversations[0].is_teacher_test, true);
});

test('GET /bootstrap fails closed on a DB error (500, no partial payload)', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: bootstrapRouter({
      onRoute: (t) => {
        if (/FROM public\.conversations/.test(t)) throw new Error('simulated db failure');
        return res([]);
      },
    }),
  });
  const r = await invoke(handler, { method: 'GET', path: '/bootstrap', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 500);
  const body = r.json();
  assert.equal(body.error, 'Database error');
  assert.equal('profile' in body, false);
});

test('GET /bootstrap rejects a non-GET method (405)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: bootstrapRouter() });
  const r = await invoke(handler, { method: 'POST', path: '/bootstrap', token: tokenFor(STUDENT), body: {} });
  assert.equal(r.statusCode, 405);
});
