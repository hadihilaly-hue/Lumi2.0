// adminSql direct-invoke branch (index.mjs). Spec: AUDIT_LAMBDA_BUGS.md N6 +
// route map row 1. This path runs arbitrary SQL BY DESIGN and is reachable only
// via `aws lambda invoke` (IAM-gated) — Function URL events always carry
// requestContext.http, so it must be unreachable over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, resetContext, invoke, findQuery } from './harness.mjs';

test('direct invoke (no requestContext.http) executes adminSql', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: () => ({ rows: [{ ok: 1 }], rowCount: 1 }) });
  const r = await invoke(handler, {
    omitHttp: true,
    extraEvent: { adminSql: 'SELECT 1 AS ok', params: [] },
  });
  const out = r.json();
  assert.equal(out.rowCount, 1);
  assert.deepEqual(out.rows, [{ ok: 1 }]);
  assert.ok(findQuery(ctx, /SELECT 1 AS ok/));
});

test('a Function-URL request carrying adminSql does NOT execute it (HTTP-unreachable)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: () => ({ rows: [{ leaked: true }], rowCount: 1 }) });
  // requestContext.http present (normal HTTP), adminSql smuggled in the event.
  const r = await invoke(handler, {
    method: 'POST', path: '/', extraEvent: { adminSql: 'DROP TABLE public.profiles' },
    // no token
  });
  // Falls through to the normal pipeline → unauthenticated → 401, and the
  // smuggled SQL is never run.
  assert.equal(r.statusCode, 401);
  assert.equal(findQuery(ctx, /DROP TABLE/), undefined);
});

test('direct invoke rejects a non-string adminSql', async () => {
  const { handler } = await loadHandler();
  resetContext();
  const r = await invoke(handler, { omitHttp: true, extraEvent: { adminSql: 123 } });
  assert.match(r.json().error, /adminSql must be a non-empty string/);
});

test('direct invoke rejects non-array params', async () => {
  const { handler } = await loadHandler();
  resetContext();
  const r = await invoke(handler, {
    omitHttp: true, extraEvent: { adminSql: 'SELECT 1', params: { not: 'array' } },
  });
  assert.match(r.json().error, /params must be an array/);
});

test('when ADMIN_INVOKE_SECRET is set, a missing/wrong secret is forbidden', async () => {
  const { handler } = await loadHandler();
  const prev = process.env.ADMIN_INVOKE_SECRET;
  process.env.ADMIN_INVOKE_SECRET = 's3cret';
  try {
    const ctx = resetContext({ dbRouter: () => ({ rows: [], rowCount: 0 }) });
    const r = await invoke(handler, {
      omitHttp: true, extraEvent: { adminSql: 'SELECT 1', adminSecret: 'wrong' },
    });
    assert.equal(r.json().error, 'forbidden');
    assert.equal(findQuery(ctx, /SELECT 1/), undefined, 'SQL must not run without the secret');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_INVOKE_SECRET;
    else process.env.ADMIN_INVOKE_SECRET = prev;
  }
});

test('when ADMIN_INVOKE_SECRET is set, the correct secret allows execution', async () => {
  const { handler } = await loadHandler();
  const prev = process.env.ADMIN_INVOKE_SECRET;
  process.env.ADMIN_INVOKE_SECRET = 's3cret';
  try {
    const ctx = resetContext({ dbRouter: () => ({ rows: [{ ok: 1 }], rowCount: 1 }) });
    const r = await invoke(handler, {
      omitHttp: true, extraEvent: { adminSql: 'SELECT 1 AS ok', adminSecret: 's3cret' },
    });
    assert.equal(r.json().rowCount, 1);
    assert.ok(findQuery(ctx, /SELECT 1 AS ok/));
  } finally {
    if (prev === undefined) delete process.env.ADMIN_INVOKE_SECRET;
    else process.env.ADMIN_INVOKE_SECRET = prev;
  }
});
