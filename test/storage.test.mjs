// js/storage.js — localStorage persistence for schedule + conversations, plus
// the legacy-data migration. Only the pure/localStorage-backed functions are in
// scope. The Supabase sync functions (syncConvToSupabase, loadProfileFromSupabase,
// loadTestModeSchedule, …) are out of scope: they require currentUser + rdsFetch
// (network). They are gated `if (!currentUser) return`, so with the default null
// currentUser the functions exercised here never touch the network.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  genId,
  getSchedule,
  saveScheduleLocal,
  getConvs,
  saveConvs,
  saveCurrentConv,
  migrateOldData,
} from '../js/storage.js';
import { S } from '../js/state.js';
import { reset } from './harness.mjs';

beforeEach(() => reset());

// ── genId ────────────────────────────────────────────────────────────────────
test('genId returns a conv_<digits>_<3 base36 chars> id', () => {
  const id = genId();
  assert.match(id, /^conv_\d+_[0-9a-z]{3}$/);
});

test('genId is (practically) unique across calls', () => {
  const ids = new Set(Array.from({ length: 50 }, () => genId()));
  // Random suffix + timestamp — collisions in 50 calls would indicate a bug.
  assert.ok(ids.size >= 49);
});

// ── schedule persistence ─────────────────────────────────────────────────────
test('saveScheduleLocal → getSchedule round-trips schedule data', () => {
  const schedule = [
    { course: 'Chemistry', teacher: 'Laura Huntley', subject: 'Science' },
    { course: 'Algebra 2', teacher: 'Randall Joss', subject: 'Math' },
  ];
  saveScheduleLocal(schedule);
  assert.deepEqual(getSchedule(), schedule);
  // And it is actually persisted under the expected key.
  assert.equal(globalThis.localStorage.getItem('lumi_schedule'), JSON.stringify(schedule));
});

test('getSchedule returns [] when no schedule is stored', () => {
  assert.deepEqual(getSchedule(), []);
});

test('getSchedule returns [] on malformed stored JSON (does not throw)', () => {
  globalThis.localStorage.setItem('lumi_schedule', '{not valid json');
  assert.deepEqual(getSchedule(), []);
});

test('getSchedule in test mode returns S.testSchedule and ignores localStorage', () => {
  saveScheduleLocal([{ course: 'Student Class', teacher: 'X', subject: 'Y' }]);
  S.isTestMode = true;
  S.testSchedule = [{ course: 'Teacher Test Class', teacher: 'Me', subject: 'Science' }];
  // Never leak the student-persona localStorage schedule into test mode.
  assert.deepEqual(getSchedule(), S.testSchedule);
  assert.equal(getSchedule()[0].course, 'Teacher Test Class');
});

// ── conversation persistence ─────────────────────────────────────────────────
test('saveConvs → getConvs round-trips the conversation map', () => {
  const convs = { conv_1: { id: 'conv_1', ts: 1, messages: [] } };
  saveConvs(convs);
  assert.deepEqual(getConvs(), convs);
});

test('getConvs returns {} when nothing stored, and {} on malformed JSON', () => {
  assert.deepEqual(getConvs(), {});
  globalThis.localStorage.setItem('lumi_convs', 'not-json');
  assert.deepEqual(getConvs(), {});
});

test('saveConvs/getConvs in test mode use S.testConvs, not localStorage', () => {
  S.isTestMode = true;
  const convs = { conv_t: { id: 'conv_t', ts: 1, messages: [] } };
  saveConvs(convs);
  // Persisted to the in-memory cache, NOT to the student-persona localStorage key.
  assert.equal(globalThis.localStorage.getItem('lumi_convs'), null);
  assert.deepEqual(S.testConvs, convs);
  assert.deepEqual(getConvs(), convs);
});

// ── saveCurrentConv ──────────────────────────────────────────────────────────
test('saveCurrentConv persists the current session with a 60-char preview', () => {
  S.currentId = 'conv_now';
  S.messages = [
    { role: 'user', content: 'x'.repeat(100) },
    { role: 'assistant', content: 'ok' },
  ];
  S.exchangeCount = 1;
  saveCurrentConv();

  const stored = getConvs()['conv_now'];
  assert.ok(stored);
  assert.equal(stored.id, 'conv_now');
  assert.equal(stored.preview.length, 60); // sliced to 60 chars
  assert.equal(stored.exchangeCount, 1);
  assert.equal(stored.sbId, null);
  assert.deepEqual(stored.messages, S.messages);
  // lumi_current is stamped so a reload can restore the open conversation.
  assert.equal(globalThis.localStorage.getItem('lumi_current'), 'conv_now');
});

test('saveCurrentConv derives preview text from array (multimodal) content', () => {
  S.currentId = 'conv_mm';
  S.messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: {} },
        { type: 'text', text: 'Help me with this photo' },
      ],
    },
    { role: 'assistant', content: 'sure' },
  ];
  saveCurrentConv();
  assert.equal(getConvs()['conv_mm'].preview, 'Help me with this photo');
});

test('saveCurrentConv falls back to "New chat" preview when first user text is empty', () => {
  S.currentId = 'conv_empty';
  S.messages = [
    { role: 'user', content: '' },
    { role: 'assistant', content: 'hi' },
  ];
  saveCurrentConv();
  assert.equal(getConvs()['conv_empty'].preview, 'New chat');
});

test('saveCurrentConv is a no-op with no currentId or no messages', () => {
  S.currentId = null;
  S.messages = [{ role: 'user', content: 'hi' }];
  saveCurrentConv();
  assert.deepEqual(getConvs(), {});

  S.currentId = 'conv_x';
  S.messages = [];
  saveCurrentConv();
  assert.deepEqual(getConvs(), {});
});

test('saveCurrentConv preserves existing sbId and ts across re-saves', () => {
  saveConvs({ conv_keep: { id: 'conv_keep', sbId: 'uuid-123', ts: 777, messages: [] } });
  S.currentId = 'conv_keep';
  S.messages = [{ role: 'user', content: 'follow-up' }];
  saveCurrentConv();
  const stored = getConvs()['conv_keep'];
  assert.equal(stored.sbId, 'uuid-123');
  assert.equal(stored.ts, 777);
});

test('saveCurrentConv caps stored conversations at 50, evicting the oldest', () => {
  // Seed 50 existing conversations with ascending timestamps.
  const seeded = {};
  for (let i = 0; i < 50; i++) {
    seeded[`old_${i}`] = { id: `old_${i}`, ts: i + 1, messages: [{ role: 'user', content: 'm' }] };
  }
  saveConvs(seeded);

  // Save a fresh 51st conversation (ts defaults to Date.now() — newest).
  S.currentId = 'conv_new';
  S.messages = [{ role: 'user', content: 'newest' }];
  saveCurrentConv();

  const stored = getConvs();
  assert.equal(Object.keys(stored).length, 50);
  assert.ok(stored['conv_new'], 'newest conversation is kept');
  assert.ok(!stored['old_0'], 'oldest conversation (ts=1) is evicted');
  assert.ok(stored['old_1'], 'second-oldest survives');
});

// ── migrateOldData (legacy single-conversation → conversation map) ────────────
test('migrateOldData converts legacy lumi_data into a lumi_convs entry', () => {
  const legacy = {
    messages: [
      { role: 'user', content: 'legacy question' },
      { role: 'assistant', content: 'legacy answer' },
    ],
    values: ['curiosity'],
    goals: ['pass'],
    interests: ['space'],
    exchangeCount: 3,
  };
  globalThis.localStorage.setItem('lumi_data', JSON.stringify(legacy));

  migrateOldData();

  const convs = getConvs();
  const keys = Object.keys(convs);
  assert.equal(keys.length, 1);
  const conv = convs[keys[0]];
  assert.deepEqual(conv.messages, legacy.messages);
  assert.deepEqual(conv.values, ['curiosity']);
  assert.equal(conv.exchangeCount, 3);
  assert.equal(conv.preview, 'legacy question');
  assert.equal(conv.tutorCtx, null);
  // Legacy key removed; current pointer set.
  assert.equal(globalThis.localStorage.getItem('lumi_data'), null);
  assert.equal(globalThis.localStorage.getItem('lumi_current'), keys[0]);
});

test('migrateOldData is a no-op when lumi_convs already exists', () => {
  saveConvs({ existing: { id: 'existing', ts: 1, messages: [] } });
  globalThis.localStorage.setItem('lumi_data', JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }));
  migrateOldData();
  // Existing convs untouched; legacy data left in place (not migrated).
  assert.deepEqual(Object.keys(getConvs()), ['existing']);
  assert.ok(globalThis.localStorage.getItem('lumi_data'));
});

test('migrateOldData is a no-op with no legacy data', () => {
  migrateOldData();
  assert.deepEqual(getConvs(), {});
});

test('migrateOldData tolerates malformed legacy JSON without throwing', () => {
  globalThis.localStorage.setItem('lumi_data', '{broken');
  assert.doesNotThrow(() => migrateOldData());
  assert.deepEqual(getConvs(), {});
});

test('migrateOldData skips legacy data with no messages (leaves it in place)', () => {
  globalThis.localStorage.setItem('lumi_data', JSON.stringify({ values: ['x'] }));
  migrateOldData();
  assert.deepEqual(getConvs(), {});
  // Current behavior: returns before removing lumi_data when there are no messages.
  assert.ok(globalThis.localStorage.getItem('lumi_data'));
});
