import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { CONFIG } from '../js/config.js';
import { S } from '../js/state.js';
import { DOWNLOAD_URLS_BATCH_MAX, loadWorkSampleImages, signWorkSampleUrls } from '../js/teachers.js';
import { _resetMemoryCache } from '../js/workSampleCache.js';
import { resetState } from './harness.mjs';

// loadWorkSampleImages() against a fully stubbed network: the Lambda signing
// routes (batch + singular) and the signed S3 GETs. No IndexedDB global in this
// file, so the cache is the in-memory layer only — the persistent layer has its
// own suite (workSampleCache.test.mjs).

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

function profile(updatedAt = '2026-09-01T00:00:00Z') {
  const tier = (t, paths) => ({ tier: t, description: `${t} desc`, photo_paths: paths, updated_at: updatedAt });
  return {
    id: 'tp-1',
    workSamples: {
      progressing: tier('progressing', ['teachers/t/c/progressing/1.png', 'teachers/t/c/progressing/2.jpg']),
      proficient:  tier('proficient',  ['teachers/t/c/proficient/1.jpg']),
      exemplary:   tier('exemplary',   ['teachers/t/c/exemplary/1.jpg']),
    },
  };
}

// Records every request; `batchStatus` controls the /download-urls reply.
function stubNetwork({ batchStatus = 200, delayMs = 0 } = {}) {
  const log = { batch: 0, singular: 0, images: 0, calls: [] };
  const wait = () => new Promise(r => setTimeout(r, delayMs));
  globalThis.fetch = async (url, init) => {
    log.calls.push(url);
    await wait();
    if (url.endsWith('/download-urls')) {
      log.batch++;
      if (batchStatus !== 200) return { ok: false, status: batchStatus, json: async () => ({ error: 'x' }) };
      const { paths } = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ urls: paths.map(p => `https://s3/${p}`) }) };
    }
    if (url.endsWith('/download-url')) {
      log.singular++;
      const { key } = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ downloadUrl: `https://s3/${key}` }) };
    }
    if (url.startsWith('https://s3/')) {
      log.images++;
      const png = url.endsWith('.png');
      return { ok: true, status: 200, blob: async () => new Blob([png ? PNG : JPG], { type: png ? 'image/png' : '' }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  return log;
}

const savedDebug = CONFIG.debug;
beforeEach(() => {
  resetState();
  _resetMemoryCache();
  delete globalThis.indexedDB;
  globalThis.sb = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };
});
afterEach(() => {
  CONFIG.debug = savedDebug;
  globalThis.fetch = () => Promise.reject(new Error('fetch() is disabled in the offline test suite'));
});

test('first open: one batch signing call + one GET per image; result shaped per tier', async () => {
  const log = stubNetwork();
  const out = await loadWorkSampleImages(profile());
  assert.equal(log.batch, 1);
  assert.equal(log.singular, 0);
  assert.equal(log.images, 4);
  assert.deepEqual(Object.keys(out), ['progressing', 'proficient', 'exemplary']);
  assert.equal(out.progressing.description, 'progressing desc');
  assert.equal(out.progressing.images.length, 2);
  assert.equal(out.progressing.images[0].mediaType, 'image/png');
  assert.equal(out.progressing.images[0].base64, Buffer.from(PNG).toString('base64'));
  // Blob without a type → sniffed from the extension.
  assert.equal(out.progressing.images[1].mediaType, 'image/jpeg');
  assert.equal(out.proficient.images.length, 1);
  assert.equal(out.exemplary.images.length, 1);
});

test('cached open: no network at all, identical result', async () => {
  stubNetwork();
  const first = await loadWorkSampleImages(profile());
  const log = stubNetwork();
  const second = await loadWorkSampleImages(profile());
  assert.equal(log.calls.length, 0, 'zero fetches on a warm cache');
  assert.deepEqual(second, first);
});

test('a bumped work_samples.updated_at invalidates the cache for that tier only', async () => {
  stubNetwork();
  await loadWorkSampleImages(profile());
  const p = profile();
  p.workSamples.exemplary.updated_at = '2026-09-02T00:00:00Z';
  const log = stubNetwork();
  await loadWorkSampleImages(p);
  assert.equal(log.batch, 1);
  assert.equal(log.images, 1, 'only the re-saved tier is refetched');
  assert.ok(log.calls.some(u => u.includes('/exemplary/')));
});

test('falls back to singular /download-url when the batch route is missing (404)', async () => {
  const log = stubNetwork({ batchStatus: 404 });
  const out = await loadWorkSampleImages(profile());
  assert.ok(out);
  assert.equal(log.batch, 1);
  assert.equal(log.singular, 4);
  assert.equal(log.images, 4);
});

test('falls back to singular when the batch reply is malformed', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/download-urls')) return { ok: true, status: 200, json: async () => ({ urls: ['only-one'] }) };
    if (url.endsWith('/download-url')) return { ok: true, status: 200, json: async () => ({ downloadUrl: 'https://s3/x' }) };
    throw new Error('unexpected ' + url);
  };
  const urls = await signWorkSampleUrls(['a', 'b'], 'tok');
  assert.deepEqual(urls, ['https://s3/x', 'https://s3/x']);
});

test('signWorkSampleUrls chunks the batch route at DOWNLOAD_URLS_BATCH_MAX and preserves order', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith('/download-urls'));
    const { paths } = JSON.parse(init.body);
    seen.push(paths.length);
    return { ok: true, status: 200, json: async () => ({ urls: paths.map(p => 'u:' + p) }) };
  };
  const paths = Array.from({ length: DOWNLOAD_URLS_BATCH_MAX + 2 }, (_, i) => `p${i}`);
  const urls = await signWorkSampleUrls(paths, 'tok');
  assert.deepEqual(seen, [DOWNLOAD_URLS_BATCH_MAX, 2]);
  assert.deepEqual(urls, paths.map(p => 'u:' + p));
});

test('returns null (no cache writes) when an image GET fails', async () => {
  stubNetwork();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.startsWith('https://s3/') && url.endsWith('exemplary/1.jpg')) return { ok: false, status: 500 };
    return base(url, init);
  };
  assert.equal(await loadWorkSampleImages(profile()), null);
  const log = stubNetwork();
  await loadWorkSampleImages(profile());
  assert.equal(log.images, 4, 'a failed load leaves nothing cached');
});

test('gate: missing tier / photos / description → null before any network', async () => {
  const log = stubNetwork();
  const p1 = profile(); delete p1.workSamples.exemplary;
  const p2 = profile(); p2.workSamples.proficient.photo_paths = [];
  const p3 = profile(); p3.workSamples.progressing.description = '  ';
  for (const p of [p1, p2, p3]) assert.equal(await loadWorkSampleImages(p), null);
  assert.equal(await loadWorkSampleImages(null), null);
  assert.equal(log.calls.length, 0);
});

test('Test Mode still serves from the per-tab memory cache', async () => {
  S.isTestMode = true;
  stubNetwork();
  await loadWorkSampleImages(profile());
  const log = stubNetwork();
  await loadWorkSampleImages(profile());
  assert.equal(log.calls.length, 0);
});

test('timing log is emitted only behind CONFIG.debug', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    CONFIG.debug = false;
    stubNetwork();
    await loadWorkSampleImages(profile());
    assert.ok(!lines.some(l => l.includes('[work_samples][timing]')));

    CONFIG.debug = true;
    _resetMemoryCache();
    await loadWorkSampleImages(profile());
    const t = lines.find(l => l.includes('[work_samples][timing]'));
    assert.match(t, /images=4 cacheHits=0/);
    await loadWorkSampleImages(profile());
    assert.match(lines.at(-1), /images=4 cacheHits=4 .*network=0ms/);
  } finally {
    console.log = orig;
  }
});
