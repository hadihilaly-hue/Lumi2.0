// Route authorization — the auth gate and the three intentionally-public
// routes. Spec: AUDIT_LAMBDA_BUGS.md "Route → auth map" + index.mjs:538-544.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery,
  STUDENT, ADMIN, DOMAIN, tokenFor, authToken,
} from './harness.mjs';

// Every authenticated route sits below the gate; these are representative.
const PROTECTED = [
  { method: 'GET', path: '/teacher-profile' },
  { method: 'GET', path: '/profiles' },
  { method: 'GET', path: '/conversations' },
  { method: 'GET', path: '/homework-tasks' },
  { method: 'GET', path: '/work-samples', query: { teacher_profile_id: 'x' } },
  { method: 'GET', path: '/class-enrollments' },
  { method: 'GET', path: '/suggested-prompts', query: { teacher_profile_id: 'x' } },
  { method: 'POST', path: '/sis-import' },
  { method: 'POST', path: '/upload-url' },
  { method: 'POST', path: '/download-url' },
  { method: 'POST', path: '/chat' },
];

test('every protected route 401s with no Authorization header', async () => {
  const { handler } = await loadHandler();
  for (const r of PROTECTED) {
    resetContext({ dbRouter: makeRouter() });
    const res = await invoke(handler, { ...r }); // no token
    assert.equal(res.statusCode, 401, `${r.method} ${r.path} should be 401`);
    assert.equal(res.json().error, 'Unauthorized');
  }
});

test('a malformed Authorization header (not Bearer) is rejected 401', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter() });
  const res = await invoke(handler, {
    method: 'GET', path: '/profiles', headers: { authorization: 'Basic abc' },
  });
  assert.equal(res.statusCode, 401);
});

test('a token that fails JWT verification is rejected 401', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter(),
    jwtVerify: () => { throw new Error('bad signature'); },
  });
  const res = await invoke(handler, { method: 'GET', path: '/profiles', token: 'garbage' });
  assert.equal(res.statusCode, 401);
});

test('a verified token with email_verified=false is rejected 401', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter() });
  const token = authToken({ email: STUDENT.email, sub: STUDENT.sub, email_verified: false });
  const res = await invoke(handler, { method: 'GET', path: '/profiles', token });
  assert.equal(res.statusCode, 401);
});

test('a verified token from a non-allowed domain is rejected (401 at auth, before any route)', async () => {
  const { handler } = await loadHandler();
  // Domain list does NOT contain the caller's domain; isEmailAllowed inside
  // verifyCognitoAuth fails first, so verifyAuth returns null -> 401.
  resetContext({ dbRouter: makeRouter({ domains: ['otherschool.org'] }) });
  const token = authToken({ email: 'outsider@evil.com', sub: 'sub-x' });
  const res = await invoke(handler, { method: 'GET', path: '/profiles', token });
  assert.equal(res.statusCode, 401);
});

test('email/sub collision (email already bound to a different Cognito sub) fails closed 401', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({ appUserExists: false, insertCollisionSub: 'someone-elses-sub' }),
  });
  const res = await invoke(handler, {
    method: 'GET', path: '/profiles', token: tokenFor(STUDENT),
  });
  assert.equal(res.statusCode, 401);
});

test('when Cognito env is configured the identity comes from the verified JWT, not the body', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  // Body tries to assert a different id/email; route must ignore it.
  const res = await invoke(handler, {
    method: 'GET', path: '/profiles', token: tokenFor(STUDENT),
    body: { id: 'ATTACKER', email: 'attacker@evil.com' },
  });
  // profiles GET selects by the JWT-derived user id.
  const q = findQuery(ctx, /FROM public\.profiles WHERE id = \$1/);
  assert.ok(q, 'profiles select should run');
  assert.equal(q.params[0], STUDENT.userId);
  assert.notEqual(res.statusCode, 401);
});

// ---- Intentionally public routes (above the auth gate) ----------------------

test('GET /db-health works with no token', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: () => ({ rows: [{ ok: 1 }], rowCount: 1 }) });
  const res = await invoke(handler, { method: 'GET', path: '/db-health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('/db-health rejects non-GET with 405', async () => {
  const { handler } = await loadHandler();
  resetContext();
  const res = await invoke(handler, { method: 'POST', path: '/db-health' });
  assert.equal(res.statusCode, 405);
});

test('GET /allowed-domains works with no token and returns sorted domains', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ domains: ['zeta.org', 'alpha.org'] }) });
  const res = await invoke(handler, { method: 'GET', path: '/allowed-domains' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().domains, ['alpha.org', 'zeta.org']);
});

test('/allowed-domains 503s when the domain config is unavailable (fail-closed)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ domains: null }) }); // simulated DB error, no cache
  const res = await invoke(handler, { method: 'GET', path: '/allowed-domains' });
  assert.equal(res.statusCode, 503);
});

test('admin email bypasses the domain check entirely', async () => {
  const { handler } = await loadHandler();
  // Domains list is empty; admin must still authenticate via the adminEmails bypass.
  const ctx = resetContext({ dbRouter: makeRouter({ userId: ADMIN.userId, domains: [] }) });
  const res = await invoke(handler, {
    method: 'GET', path: '/profiles', token: tokenFor(ADMIN),
  });
  assert.notEqual(res.statusCode, 401);
  assert.notEqual(res.statusCode, 403);
  assert.ok(findQuery(ctx, /FROM public\.profiles WHERE id/));
});
