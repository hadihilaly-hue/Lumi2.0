// js/storage.js — debounced conversation sync (syncConvToRds / flushPendingConvSyncs)
// and the /bootstrap boot path (loadBootstrapFromRds, prefetched loadProfileFromRds /
// loadConvsFromRds). Network is stubbed at the fetch + sb.auth.getSession level
// so the real rdsFetch wire format is exercised.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { S, setCurrentUser } from '../js/state.js';
import {
  CONV_SYNC_DEBOUNCE_MS,
  __resetConvSyncState,
  flushPendingConvSyncs,
  getConvs,
  hasPendingConvSync,
  initConvSyncFlush,
  loadBootstrapFromRds,
  loadConvsFromRds,
  loadProfileFromRds,
  saveConvs,
  syncConvToRds,
} from '../js/storage.js';
import { reset } from './harness.mjs';

const USER = { id: 'uuid-student', email: 'student@menloschool.org' };

// ── fetch stub ───────────────────────────────────────────────────────────────
let calls;        // [{ method, path, body, keepalive }]
let responder;    // (call) => { status, json }

function installFetch() {
  calls = [];
  responder = () => ({ status: 200, json: { id: 'row-1', updated_at: 'now' } });
  globalThis.sb = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      method: init.method || 'GET',
      path: String(url).replace(/^.*?\/([a-z-]+(?:\?.*)?)$/, '$1'),
      body: init.body ? JSON.parse(init.body) : undefined,
      keepalive: !!init.keepalive,
      auth: init.headers?.Authorization,
    };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
}

const patches = () => calls.filter(c => c.method === 'PATCH');
const posts = () => calls.filter(c => c.method === 'POST');
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

function seedConv(id, { sbId = 'row-1', messages, title = null } = {}) {
  const convs = getConvs();
  convs[id] = {
    id, sbId, ts: 1, title, preview: 'x',
    messages: messages || [{ role: 'user', content: 'hi' }],
    values: [], goals: [], interests: [], exchangeCount: 0,
    tutorCtx: { course: 'Algebra 2', teacher: 'Ms. T' },
  };
  saveConvs(convs);
}
function appendMsg(id, text) {
  const convs = getConvs();
  convs[id].messages = [...convs[id].messages, { role: 'assistant', content: text }];
  saveConvs(convs);
}

beforeEach(() => {
  reset();
  __resetConvSyncState();
  installFetch();
  setCurrentUser(USER);
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  __resetConvSyncState();
});

// ── coalescing ───────────────────────────────────────────────────────────────

test('rapid saves to an existing conversation coalesce into ONE trailing PATCH', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  appendMsg('c1', 'a');
  syncConvToRds('c1');
  appendMsg('c1', 'b');
  syncConvToRds('c1');
  await settle();
  assert.equal(patches().length, 0, 'nothing sent before the debounce elapses');
  assert.equal(hasPendingConvSync('c1'), true);

  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS - 1);
  await settle();
  assert.equal(patches().length, 0);

  mock.timers.tick(1);
  await settle();
  assert.equal(patches().length, 1);
  const [p] = patches();
  assert.equal(p.path, 'conversations');
  assert.equal(p.body.id, 'row-1');
  assert.equal(p.body.messages.length, 3, 'the LAST snapshot is what gets written');
  assert.equal(p.keepalive, false);
  assert.equal(p.auth, 'Bearer tok');
  assert.equal(hasPendingConvSync('c1'), false);
});

test('each save restarts the trailing window (true debounce, not throttle)', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS - 100);
  appendMsg('c1', 'a');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS - 100);
  await settle();
  assert.equal(patches().length, 0);
  mock.timers.tick(100);
  await settle();
  assert.equal(patches().length, 1);
});

test('new-conversation creation POSTs immediately (not debounced) and captures sbId', async () => {
  seedConv('c1', { sbId: null });
  responder = () => ({ status: 200, json: { id: 'new-uuid' } });
  syncConvToRds('c1');
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.user_id, USER.id);
  assert.equal(getConvs().c1.sbId, 'new-uuid');
  assert.equal(patches().length, 0);
});

test('saves during an in-flight POST do not double-insert; they become one PATCH after creation', async () => {
  seedConv('c1', { sbId: null });
  let release;
  responder = (c) => c.method === 'POST'
    ? ({ status: 200, json: { id: 'new-uuid' } })
    : ({ status: 200, json: { id: 'new-uuid', updated_at: 'now' } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') await new Promise(r => { release = r; });
    return origFetch(url, init);
  };
  syncConvToRds('c1');
  await tick();
  appendMsg('c1', 'a');
  syncConvToRds('c1');
  appendMsg('c1', 'b');
  syncConvToRds('c1');
  await settle();
  release();
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(patches().length, 0);
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].body.id, 'new-uuid');
  assert.equal(patches()[0].body.messages.length, 3);
});

// ── metadata changes bypass the debounce ─────────────────────────────────────

test('a title change (generated title / rename) PATCHes promptly without waiting for the debounce', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);

  const convs = getConvs(); convs.c1.title = 'Quadratics'; saveConvs(convs);
  syncConvToRds('c1');
  await settle();
  assert.equal(patches().length, 2, 'title save is immediate');
  assert.equal(patches()[1].body.title, 'Quadratics');
});

// ── no-op when unchanged ─────────────────────────────────────────────────────

test('skips the PATCH when the serialized payload is unchanged since the last successful write', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);

  syncConvToRds('c1');           // same messages, same title
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1, 'no second PATCH');
  assert.equal(hasPendingConvSync('c1'), false);

  appendMsg('c1', 'changed');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 2, 'a real change writes again');
});

// ── flush on hide / pagehide ─────────────────────────────────────────────────

test('flushPendingConvSyncs sends pending writes immediately with keepalive and cancels the timer', async () => {
  seedConv('c1');
  seedConv('c2', { sbId: 'row-2' });
  syncConvToRds('c1');
  syncConvToRds('c2');
  await flushPendingConvSyncs();
  assert.equal(patches().length, 2);
  assert.ok(patches().every(p => p.keepalive === true));
  assert.deepEqual(patches().map(p => p.body.id).sort(), ['row-1', 'row-2']);
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS * 2);
  await settle();
  assert.equal(patches().length, 2, 'the debounce timer was cancelled — no duplicate write');
});

test('initConvSyncFlush flushes on visibilitychange→hidden and on pagehide', async () => {
  const docHandlers = {}; const winHandlers = {};
  const doc = { visibilityState: 'visible', addEventListener: (ev, fn) => { docHandlers[ev] = fn; } };
  const win = { addEventListener: (ev, fn) => { winHandlers[ev] = fn; } };
  initConvSyncFlush(doc, win);

  seedConv('c1');
  syncConvToRds('c1');
  doc.visibilityState = 'visible';
  docHandlers.visibilitychange();
  await settle();
  assert.equal(patches().length, 0, 'becoming visible does not flush');

  doc.visibilityState = 'hidden';
  docHandlers.visibilitychange();
  await settle();
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].keepalive, true);

  appendMsg('c1', 'more');
  syncConvToRds('c1');
  winHandlers.pagehide();
  await settle();
  assert.equal(patches().length, 2);
  assert.equal(patches()[1].keepalive, true);
});

// ── failure keeps the payload pending ────────────────────────────────────────

test('a failed PATCH leaves the payload pending; the next flush retries it', async () => {
  seedConv('c1');
  responder = () => ({ status: 500, json: { error: 'boom' } });
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);
  assert.equal(hasPendingConvSync('c1'), true, 'still pending after failure');

  responder = () => ({ status: 200, json: { id: 'row-1', updated_at: 'now' } });
  await flushPendingConvSyncs();
  assert.equal(patches().length, 2);
  assert.deepEqual(patches()[1].body.messages, patches()[0].body.messages);
  assert.equal(hasPendingConvSync('c1'), false);
});

test('a network error (fetch rejects) also keeps the payload pending', async () => {
  seedConv('c1');
  responder = () => new Error('offline');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(hasPendingConvSync('c1'), true);
  responder = () => ({ status: 200, json: { id: 'row-1' } });
  await flushPendingConvSyncs({ keepalive: false });
  assert.equal(patches().length, 2);
  assert.equal(patches()[1].keepalive, false);
});

test('flush during an in-flight creation waits for the POST and then PATCHes what was saved meanwhile', async () => {
  seedConv('c1', { sbId: null });
  let release;
  responder = (c) => ({ status: 200, json: c.method === 'POST' ? { id: 'new-uuid' } : { id: 'new-uuid' } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') await new Promise(r => { release = r; });
    return origFetch(url, init);
  };
  syncConvToRds('c1');
  await tick();
  appendMsg('c1', 'typed while creating');
  syncConvToRds('c1');
  let flushed = false;
  const flush = flushPendingConvSyncs({ keepalive: false }).then(() => { flushed = true; });
  await settle();
  assert.equal(flushed, false, 'sign-out flush does not resolve while the POST is in flight');
  release();
  await flush;
  assert.equal(posts().length, 1);
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].body.id, 'new-uuid');
  assert.equal(patches()[0].body.messages.length, 2);
  assert.equal(hasPendingConvSync('c1'), false);
});

test('PATCHes are serialized per conversation: a newer save waits for the in-flight request and wins', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);

  // Second write (metadata change → immediate) is held in flight …
  const gates = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await origFetch(url, init);
    if (init.method === 'PATCH') await new Promise(r => gates.push(r));
    return res;
  };
  const convs = getConvs(); convs.c1.title = 'Renamed'; saveConvs(convs);
  syncConvToRds('c1');
  await settle();
  assert.equal(patches().length, 2);
  // … while a third save (newer messages) is requested and its timer fires.
  appendMsg('c1', 'newest');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 2, 'third write is queued, not overlapped');
  gates.shift()();
  await settle();
  assert.equal(patches().length, 3, 'queued write sent after the earlier one settled');
  assert.equal(patches()[2].body.messages.length, 2);
  assert.equal(patches()[2].body.title, 'Renamed');
  gates.shift()();
  await settle();
  assert.equal(hasPendingConvSync('c1'), false);
});

test('payloads above the 64 KiB keepalive quota are flushed with a normal (non-keepalive) request', async () => {
  seedConv('c1', { messages: [{ role: 'user', content: 'x'.repeat(70 * 1024) }] });
  syncConvToRds('c1');
  await flushPendingConvSyncs({ keepalive: true });
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].keepalive, false);
  assert.equal(hasPendingConvSync('c1'), false);
});

test('keepalive size check uses UTF-8 bytes, not string length', async () => {
  // 35k 3-byte chars: 35k JS chars (< 60 KiB) but ~105 KiB on the wire.
  seedConv('c1', { messages: [{ role: 'user', content: '€'.repeat(35 * 1024) }] });
  syncConvToRds('c1');
  await flushPendingConvSyncs({ keepalive: true });
  assert.equal(patches().length, 1);
  assert.equal(patches()[0].keepalive, false);
});

test('the 64 KiB keepalive quota is shared across a multi-conversation flush', async () => {
  seedConv('c1', { messages: [{ role: 'user', content: 'a'.repeat(40 * 1024) }] });
  seedConv('c2', { sbId: 'row-2', messages: [{ role: 'user', content: 'b'.repeat(40 * 1024) }] });
  syncConvToRds('c1');
  syncConvToRds('c2');
  await flushPendingConvSyncs({ keepalive: true });
  assert.equal(patches().length, 2);
  assert.deepEqual(patches().map(p => p.keepalive).sort(), [false, true], 'only one fits the shared budget');
  assert.equal(hasPendingConvSync('c1'), false);
  assert.equal(hasPendingConvSync('c2'), false);
});

test('unload flush does not wait behind an unresolved in-page PATCH', async () => {
  seedConv('c1');
  syncConvToRds('c1');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(patches().length, 1);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await origFetch(url, init);
    if (init.method === 'PATCH' && !init.keepalive) await new Promise(() => {}); // never settles
    return res;
  };
  const convs = getConvs(); convs.c1.title = 'Renamed'; saveConvs(convs);
  syncConvToRds('c1');                       // immediate PATCH, stuck in flight
  await settle();
  assert.equal(patches().length, 2);
  appendMsg('c1', 'newest');
  syncConvToRds('c1');
  await flushPendingConvSyncs({ keepalive: true });  // pagehide
  assert.equal(patches().length, 3);
  assert.equal(patches()[2].keepalive, true);
  assert.equal(patches()[2].body.messages.length, 2);
});

test('syncConvToRds is a no-op without a signed-in user or an empty conversation', async () => {
  seedConv('c1', { messages: [] });
  syncConvToRds('c1');
  setCurrentUser(null);
  seedConv('c2');
  syncConvToRds('c2');
  mock.timers.tick(CONV_SYNC_DEBOUNCE_MS);
  await settle();
  assert.equal(calls.length, 0);
});

// ── /bootstrap boot path ─────────────────────────────────────────────────────

const BOOT = {
  profile: { id: USER.id, name: 'Sam', grade: '10', schedule: [{ course: 'Algebra 2', teacher: 'Ms. T', block: 'B' }], onboarding_complete: true },
  schedule: [{ course: 'Algebra 2', teacher: 'Ms. T', block: 'B' }],
  enrollments: [],
  availableClasses: [],
  recentConversations: [{
    id: '11111111-2222-3333-4444-555555555555', title: 'Quadratics', teacher: 'Ms. T', course: 'Algebra 2',
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', is_teacher_test: false,
    preview: 'help with quadratics', exchange_count: 3,
  }],
};

test('loadBootstrapFromRds returns the payload from GET /bootstrap', async () => {
  responder = () => ({ status: 200, json: BOOT });
  const boot = await loadBootstrapFromRds();
  assert.deepEqual(boot, BOOT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, 'bootstrap');
});

test('loadBootstrapFromRds returns null on 404 (older Lambda) and on failure, and in test mode', async () => {
  responder = () => ({ status: 404, json: {} });
  assert.equal(await loadBootstrapFromRds(), null);
  responder = () => ({ status: 500, json: {} });
  assert.equal(await loadBootstrapFromRds(), null);
  S.isTestMode = true;
  responder = () => ({ status: 200, json: BOOT });
  assert.equal(await loadBootstrapFromRds(), null);
  assert.equal(calls.length, 2, 'test mode never calls /bootstrap');
});

test('loadProfileFromRds({prefetched}) restores profile state without a GET /profiles', async () => {
  await loadProfileFromRds({ prefetched: BOOT.profile });
  assert.equal(calls.length, 0);
  assert.equal(localStorage.getItem('lumi_name'), 'Sam');
  assert.equal(localStorage.getItem('lumi_grade'), '10');
  assert.deepEqual(JSON.parse(localStorage.getItem('lumi_schedule')), BOOT.schedule);
  assert.equal(localStorage.getItem('lumi_onboarding_complete'), 'true');
});

test('loadProfileFromRds({prefetched: null}) means "no row yet" and does NOT fall back to a GET', async () => {
  await loadProfileFromRds({ prefetched: null });
  assert.equal(calls.length, 0);
  assert.equal(localStorage.getItem('lumi_name'), null);
});

test('loadProfileFromRds() without prefetched data still GETs /profiles (fallback path)', async () => {
  responder = () => ({ status: 200, json: BOOT.profile });
  await loadProfileFromRds();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'profiles');
  assert.equal(localStorage.getItem('lumi_name'), 'Sam');
});

test('loadConvsFromRds({prefetched}) builds the local conv map from metadata, no GET, no messages', async () => {
  await loadConvsFromRds({ prefetched: BOOT.recentConversations });
  assert.equal(calls.length, 0);
  const convs = getConvs();
  const [c] = Object.values(convs);
  assert.equal(c.sbId, BOOT.recentConversations[0].id);
  assert.equal(c.title, 'Quadratics');
  assert.equal(c.preview, 'help with quadratics');
  assert.equal(c.exchangeCount, 3);
  assert.deepEqual(c.messages, [], 'bodies load lazily on open');
  assert.equal(c.tutorCtx.course, 'Algebra 2');
});

test('loadConvsFromRds() without prefetched data GETs /conversations?is_teacher_test=false (fallback path)', async () => {
  responder = () => ({ status: 200, json: BOOT.recentConversations });
  await loadConvsFromRds();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'conversations?is_teacher_test=false');
  assert.equal(Object.keys(getConvs()).length, 1);
});
