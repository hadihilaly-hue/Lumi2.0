import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  MAX_AGE_MS, MAX_ENTRIES, _memorySize, _resetMemoryCache, cacheKey, getCachedImage, putCachedImage, selectEvictions,
} from '../js/workSampleCache.js';

// ── Minimal in-memory IndexedDB double ───────────────────────────────────────
// Only the surface js/workSampleCache.js touches: open/onupgradeneeded/onsuccess,
// transaction → objectStore → get/put/getAll/delete, tx.oncomplete. Requests
// resolve asynchronously like the real thing so callback ordering is exercised.
function fakeIndexedDB() {
  const rows = new Map();
  const request = (fn) => {
    const r = {};
    queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } });
    return r;
  };
  const store = {
    get: (k) => request(() => rows.get(k)),
    put: (v) => request(() => { rows.set(v.key, v); return v.key; }),
    getAll: () => request(() => [...rows.values()]),
    delete: (k) => request(() => { rows.delete(k); }),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const tx = { objectStore: () => store };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  return {
    rows,
    open: () => {
      const r = { result: db };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  };
}

beforeEach(() => {
  _resetMemoryCache();
  globalThis.indexedDB = fakeIndexedDB();
});

test('cacheKey composes (teacher_profile_id, s3_path, updated_at)', () => {
  assert.equal(cacheKey('tp1', 'teachers/x/a.jpg', '2026-09-01T00:00:00Z'), 'tp1|teachers/x/a.jpg|2026-09-01T00:00:00Z');
  // Bumping updated_at (tier re-saved) yields a different key → natural invalidation.
  assert.notEqual(cacheKey('tp1', 'a.jpg', '1'), cacheKey('tp1', 'a.jpg', '2'));
  assert.notEqual(cacheKey('tp1', 'a.jpg', '1'), cacheKey('tp2', 'a.jpg', '1'));
});

test('selectEvictions drops expired entries and the oldest beyond the cap', () => {
  const now = 1_000_000_000_000;
  const entries = [];
  for (let i = 0; i < MAX_ENTRIES + 3; i++) entries.push({ key: `k${i}`, storedAt: now - i * 1000 });
  entries.push({ key: 'stale', storedAt: now - MAX_AGE_MS - 1 });
  entries.push({ key: 'broken' }); // no storedAt → treated as expired
  const doomed = selectEvictions(entries, { now });
  assert.ok(doomed.includes('stale'));
  assert.ok(doomed.includes('broken'));
  // Three oldest live entries (highest i) go.
  for (const k of [`k${MAX_ENTRIES}`, `k${MAX_ENTRIES + 1}`, `k${MAX_ENTRIES + 2}`]) assert.ok(doomed.includes(k), k);
  assert.equal(doomed.length, 5);
  assert.ok(!doomed.includes('k0'));
});

test('put → get round-trips through memory and IndexedDB', async () => {
  const img = { base64: 'QUJD', mediaType: 'image/jpeg' };
  await putCachedImage('k', img);
  assert.deepEqual(await getCachedImage('k'), img);
  assert.equal(globalThis.indexedDB.rows.get('k').base64, 'QUJD');

  // A fresh tab (memory cleared) still hits IndexedDB and promotes to memory.
  _resetMemoryCache();
  assert.deepEqual(await getCachedImage('k'), img);
  assert.equal(await getCachedImage('missing'), null);
});

test('persistent:false keeps the entry in memory only (Test Mode posture)', async () => {
  await putCachedImage('tm', { base64: 'QUJD', mediaType: 'image/png' }, { persistent: false });
  assert.ok(await getCachedImage('tm', { persistent: false }));
  assert.equal(globalThis.indexedDB.rows.size, 0, 'nothing written to IndexedDB');
  _resetMemoryCache();
  assert.equal(await getCachedImage('tm', { persistent: false }), null);
});

test('IndexedDB writes are pruned to MAX_ENTRIES', async () => {
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await putCachedImage(`k${i}`, { base64: 'QUJD', mediaType: 'image/jpeg' });
  }
  assert.equal(globalThis.indexedDB.rows.size, MAX_ENTRIES);
  assert.ok(!globalThis.indexedDB.rows.has('k0'), 'oldest evicted');
  assert.ok(globalThis.indexedDB.rows.has(`k${MAX_ENTRIES + 4}`), 'newest kept');
});

test('the in-memory layer is bounded to MAX_ENTRIES, oldest first', async () => {
  delete globalThis.indexedDB;
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await putCachedImage(`k${i}`, { base64: 'x', mediaType: 'image/png' }, { persistent: false });
  }
  assert.equal(_memorySize(), MAX_ENTRIES);
  assert.equal(await getCachedImage('k0', { persistent: false }), null);
  assert.equal(await getCachedImage('k4', { persistent: false }), null);
  assert.ok(await getCachedImage('k5', { persistent: false }));
  assert.ok(await getCachedImage(`k${MAX_ENTRIES + 4}`, { persistent: false }));
});

test('a stale IndexedDB row is ignored on read', async () => {
  globalThis.indexedDB.rows.set('old', { key: 'old', base64: 'QUJD', mediaType: 'image/jpeg', storedAt: Date.now() - MAX_AGE_MS - 1 });
  assert.equal(await getCachedImage('old'), null);
});

test('without an indexedDB global the cache degrades to memory-only without throwing', async () => {
  delete globalThis.indexedDB;
  _resetMemoryCache();
  await putCachedImage('m', { base64: 'QUJD', mediaType: 'image/jpeg' });
  assert.ok(await getCachedImage('m'));
  _resetMemoryCache();
  assert.equal(await getCachedImage('m'), null);
});
