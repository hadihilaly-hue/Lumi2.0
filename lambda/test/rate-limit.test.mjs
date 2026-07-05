// checkRateLimit + logUsage. Spec: AUDIT_LAMBDA_BUGS.md priority #3 + N4
// (rate-limit fail-open on DB error; logUsage is fire-and-forget and swallows
// its own errors). Exercised directly via index.mjs `__test__`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, resetContext, makeRouter, findQuery } from './harness.mjs';

const { __test__ } = await loadHandler();
const { checkRateLimit, logUsage } = __test__;

const STUDENT_LIMIT = 100;
const TEACHER_LIMIT = 500;

test('checkRateLimit allows a student under the daily cap', async () => {
  resetContext({ dbRouter: makeRouter({ usageCount: 50 }) });
  const r = await checkRateLimit('u1', false);
  assert.deepEqual(r, { allowed: true, remaining: 50, limit: STUDENT_LIMIT });
});

test('checkRateLimit blocks a student at the cap (count === limit)', async () => {
  resetContext({ dbRouter: makeRouter({ usageCount: STUDENT_LIMIT }) });
  const r = await checkRateLimit('u1', false);
  assert.equal(r.allowed, false);
  assert.equal(r.remaining, 0);
});

test('checkRateLimit allows the last request below the cap (count === limit - 1)', async () => {
  resetContext({ dbRouter: makeRouter({ usageCount: STUDENT_LIMIT - 1 }) });
  const r = await checkRateLimit('u1', false);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 1);
});

test('checkRateLimit uses the higher teacher cap for teachers', async () => {
  resetContext({ dbRouter: makeRouter({ usageCount: 200 }) });
  const r = await checkRateLimit('u1', true);
  assert.equal(r.limit, TEACHER_LIMIT);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 300);
});

test('checkRateLimit scopes the count query to the given user id and today', async () => {
  const ctx = resetContext({ dbRouter: makeRouter({ usageCount: 0 }) });
  await checkRateLimit('user-xyz', false);
  const q = findQuery(ctx, /count\(\*\)::int AS n FROM public\.api_usage/);
  assert.match(q.text, /WHERE user_id = \$1 AND created_at >= \$2/);
  assert.equal(q.params[0], 'user-xyz');
  // Second param is the UTC start-of-day ISO string.
  assert.match(q.params[1], /T00:00:00\.000Z$/);
});

test('checkRateLimit fails OPEN on a DB error (never blocks chat)', async () => {
  resetContext({ dbRouter: () => { throw new Error('db down'); } });
  const r = await checkRateLimit('u1', false);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, STUDENT_LIMIT);
});

test('logUsage inserts a row with the lowercased email and correct param order', async () => {
  const ctx = resetContext({ dbRouter: makeRouter({}) });
  await logUsage({
    userId: 'u1', email: 'STUDENT@Menlo.org', isTeacherUser: false,
    model: 'global.anthropic.claude', inputTokens: 12, outputTokens: 34,
  });
  const q = findQuery(ctx, /INSERT INTO public\.api_usage/);
  assert.ok(q);
  assert.deepEqual(q.params, ['u1', 'student@menlo.org', false, 'global.anthropic.claude', 12, 34]);
});

test('logUsage swallows DB errors (fire-and-forget must not throw)', async () => {
  resetContext({ dbRouter: () => { throw new Error('insert failed'); } });
  await assert.doesNotReject(() => logUsage({
    userId: 'u1', email: 'a@b.org', isTeacherUser: false, model: 'm', inputTokens: 0, outputTokens: 0,
  }));
});
