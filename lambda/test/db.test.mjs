// db.js — the RDS connection helper. Loads the REAL db.js (the resolve hook
// only redirects ./db.js for index.mjs, not for this test). pg and
// @aws-sdk/rds-signer ARE redirected to stubs, so no Postgres/IAM is touched.
//
// db.js exposes only query(); everything else (pool config, IAM-token caching)
// is observed through the pg-stub-captured Pool config and the signer counter.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';

before(() => {
  globalThis.__PG_STUB__ = { pools: [], queryResult: { rows: [{ ok: 1 }], rowCount: 1 } };
  globalThis.__SIGNER_STUB__ = { calls: 0 };
});

test('query() forwards text+params to the pool and returns its result', async () => {
  const r = await query('SELECT $1::int AS n', [42]);
  assert.deepEqual(r, { rows: [{ ok: 1 }], rowCount: 1 });
  const pool = globalThis.__PG_STUB__.pools[0];
  assert.equal(pool.queries.length, 1);
  assert.deepEqual(pool.queries[0], { text: 'SELECT $1::int AS n', params: [42] });
});

test('the pool is a module singleton — reused across query() calls', async () => {
  await query('SELECT 1');
  await query('SELECT 2');
  assert.equal(globalThis.__PG_STUB__.pools.length, 1, 'only one Pool ever constructed');
});

test('pool is configured with the hardening options from the 2026-07 incidents', async () => {
  await query('SELECT 1');
  const cfg = globalThis.__PG_STUB__.pools[0].config;
  assert.equal(cfg.max, 1);
  assert.equal(cfg.query_timeout, 8000);
  assert.equal(cfg.connectionTimeoutMillis, 5000);
  assert.equal(cfg.keepAlive, true);
  assert.equal(cfg.allowExitOnIdle, true); // lets streamifyResponse drain the loop
  assert.equal(cfg.ssl.rejectUnauthorized, false);
  assert.equal(typeof cfg.password, 'function'); // per-checkout IAM token provider
});

test('the password provider mints an IAM token and caches it within its TTL', async () => {
  await query('SELECT 1');
  const cfg = globalThis.__PG_STUB__.pools[0].config;
  const before = globalThis.__SIGNER_STUB__.calls;

  const t1 = await cfg.password();
  const t2 = await cfg.password();
  assert.match(t1, /^iam-token-\d+$/);
  assert.equal(t1, t2, 'second checkout reuses the cached token');
  // Exactly one new Signer.getAuthToken call for the two checkouts (cached).
  assert.equal(globalThis.__SIGNER_STUB__.calls - before, 1);
});
