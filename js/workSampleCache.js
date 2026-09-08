// ─── WORK-SAMPLE IMAGE CACHE ─────────────────────────────────────────────────
// Two-layer cache for the base64 work-sample photos loadWorkSampleImages()
// feeds into the vision blocks: an in-memory Map for the tab's lifetime plus an
// IndexedDB object store that survives reloads. Entries are keyed by
// (teacher_profile_id, s3_path, work_samples.updated_at), so re-saving a tier
// in the wizard bumps updated_at and naturally invalidates every photo of that
// tier — no explicit eviction call is needed.
//
// The IndexedDB layer is best-effort: any failure (private mode, quota, no
// indexedDB global) degrades to memory-only and never throws to the caller.
// The store is capped at MAX_ENTRIES / MAX_AGE_MS; the oldest entries are
// evicted on write.

export const DB_NAME = 'lumi_work_samples';
export const STORE = 'images';
export const MAX_ENTRIES = 50;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const _memory = new Map();

export function cacheKey(teacherProfileId, s3Path, updatedAt) {
  return `${teacherProfileId || ''}|${s3Path}|${updatedAt || ''}`;
}

// Pure: given every stored entry, return the keys that must go so the store
// fits the cap and carries nothing older than MAX_AGE_MS. Oldest first.
export function selectEvictions(entries, { now = Date.now(), max = MAX_ENTRIES, maxAge = MAX_AGE_MS } = {}) {
  const evict = [];
  const live = [];
  for (const e of entries) {
    if (!e || typeof e.storedAt !== 'number' || now - e.storedAt > maxAge) evict.push(e.key);
    else live.push(e);
  }
  live.sort((a, b) => a.storedAt - b.storedAt);
  const excess = live.length - max;
  for (let i = 0; i < excess; i++) evict.push(live[i].key);
  return evict;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve(null);
  _dbPromise = new Promise((resolve) => {
    let r;
    try { r = idb.open(DB_NAME, 1); } catch { resolve(null); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    return (await req(tx.objectStore(STORE).get(key))) || null;
  } catch { return null; }
}

async function idbPutAndPrune(entry) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await req(store.put(entry));
    const all = await req(store.getAll());
    const doomed = selectEvictions(all.map(e => ({ key: e.key, storedAt: e.storedAt })));
    for (const k of doomed) store.delete(k);
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
  } catch { /* best-effort */ }
}

/** Returns `{ base64, mediaType }` or null. Checks memory first, then IndexedDB
 *  (unless `persistent` is false); an IndexedDB hit is promoted to memory. */
export async function getCachedImage(key, { persistent = true } = {}) {
  const mem = _memory.get(key);
  if (mem) return mem;
  if (!persistent) return null;
  const row = await idbGet(key);
  if (!row || typeof row.base64 !== 'string' || !row.mediaType) return null;
  if (Date.now() - (row.storedAt || 0) > MAX_AGE_MS) return null;
  const img = { base64: row.base64, mediaType: row.mediaType };
  memorySet(key, img);
  return img;
}

// Memory layer is bounded like the store: insertion-ordered Map, oldest out
// once MAX_ENTRIES is exceeded.
function memorySet(key, img) {
  _memory.delete(key);
  _memory.set(key, img);
  while (_memory.size > MAX_ENTRIES) _memory.delete(_memory.keys().next().value);
}

/** Stores in memory always; in IndexedDB only when `persistent` is true. */
export async function putCachedImage(key, img, { persistent = true } = {}) {
  memorySet(key, img);
  if (!persistent) return;
  await idbPutAndPrune({ key, base64: img.base64, mediaType: img.mediaType, storedAt: Date.now() });
}

export function _memorySize() { return _memory.size; }

// Test-only: forget the in-memory layer and the cached DB handle.
export function _resetMemoryCache() {
  _memory.clear();
  _dbPromise = null;
}
