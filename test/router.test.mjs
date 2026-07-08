// js/router.js — hash router for the student-home redesign v1.
// Pure surface only: parseHash, buildHash, buildRouteUrl. The DOM-side wire-up
// (initRouter, navHome, navClass) touches window/history/location and is not
// covered here — it's exercised at boot time in the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash, buildRouteUrl } from '../js/router.js';

// ── parseHash ────────────────────────────────────────────────────────────────
test('parseHash: empty hash resolves to home', () => {
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#'), { name: 'home' });
  assert.deepEqual(parseHash('#home'), { name: 'home' });
});

test('parseHash: accepts the leading # or omits it', () => {
  assert.deepEqual(parseHash('home'), { name: 'home' });
});

test('parseHash: class route decodes course and teacher email', () => {
  // btoa('Algebra 2') = QWxnZWJyYSAy → base64url identical (no + / /)
  // btoa('rharris@menloschool.org') = cmhhcnJpc0BtZW5sb3NjaG9vbC5vcmc=
  //   base64url: strip trailing = -> cmhhcnJpc0BtZW5sb3NjaG9vbC5vcmc
  const h = '#class/QWxnZWJyYSAy/cmhhcnJpc0BtZW5sb3NjaG9vbC5vcmc';
  assert.deepEqual(parseHash(h), {
    name: 'class',
    course: 'Algebra 2',
    teacher: 'rharris@menloschool.org',
  });
});

test('parseHash: non-ASCII course names round-trip through base64url', () => {
  // "Modernist Poetry Workshop (H)" survives — nothing weird here, but the
  // encoder path uses UTF-8 percent-escaping so this exercises that branch.
  const encoded = buildHash({
    name: 'class',
    course: 'Modernist Poetry Workshop (H)',
    teacher: 'jane@school.org',
  });
  const back = parseHash('#' + encoded);
  assert.equal(back.name, 'class');
  assert.equal(back.course, 'Modernist Poetry Workshop (H)');
  assert.equal(back.teacher, 'jane@school.org');
});

test('parseHash: malformed class route (wrong segment count) falls back to home', () => {
  assert.deepEqual(parseHash('#class/onlyone'), { name: 'home' });
  assert.deepEqual(parseHash('#class/a/b/c'), { name: 'home' });
});

test('parseHash: garbage base64 segments fall back to home (no throw)', () => {
  // Non-base64 chars inside a class segment.
  assert.doesNotThrow(() => parseHash('#class/!!!/@@@'));
  assert.deepEqual(parseHash('#class/!!!/@@@'), { name: 'home' });
});

test('parseHash: unknown hash falls back to home', () => {
  assert.deepEqual(parseHash('#totallyunknown'), { name: 'home' });
});

// ── buildHash ────────────────────────────────────────────────────────────────
test('buildHash: home route serializes to "home"', () => {
  assert.equal(buildHash({ name: 'home' }), 'home');
  assert.equal(buildHash(null), 'home');
  assert.equal(buildHash(undefined), 'home');
});

test('buildHash: class route serializes to class/<b64>/<b64>', () => {
  const s = buildHash({ name: 'class', course: 'Algebra 2', teacher: 'rharris@menloschool.org' });
  assert.match(s, /^class\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  // Round-trip.
  assert.deepEqual(parseHash('#' + s), {
    name: 'class',
    course: 'Algebra 2',
    teacher: 'rharris@menloschool.org',
  });
});

test('buildHash: unknown route name falls back to home', () => {
  assert.equal(buildHash({ name: 'somethingelse' }), 'home');
});

// ── plan route (Tonight's Study Plan, Session 4) ─────────────────────────────
test('parseHash: #plan resolves to { name: "plan" }', () => {
  assert.deepEqual(parseHash('#plan'), { name: 'plan' });
  assert.deepEqual(parseHash('plan'), { name: 'plan' });
});

test('buildHash: plan route serializes to "plan"', () => {
  assert.equal(buildHash({ name: 'plan' }), 'plan');
});

test('buildRouteUrl: preserves a plan URL AND the query string', () => {
  const url = buildRouteUrl({ name: 'plan' }, '?mode=test');
  assert.equal(url, '?mode=test#plan');
});

// ── general route (General Chat) ─────────────────────────────────────────────
test('parseHash: #general resolves to { name: "general" }', () => {
  assert.deepEqual(parseHash('#general'), { name: 'general' });
  assert.deepEqual(parseHash('general'), { name: 'general' });
});

test('buildHash: general route serializes to "general"', () => {
  assert.equal(buildHash({ name: 'general' }), 'general');
});

test('buildRouteUrl: preserves a general URL AND the query string', () => {
  const url = buildRouteUrl({ name: 'general' }, '?mode=test');
  assert.equal(url, '?mode=test#general');
});

// ── buildRouteUrl — the ?mode=test-preservation contract ─────────────────────
test('buildRouteUrl: preserves the leading query string (mode=test survives)', () => {
  const url = buildRouteUrl({ name: 'home' }, '?mode=test');
  assert.equal(url, '?mode=test#home');
});

test('buildRouteUrl: preserves a class URL AND the query string', () => {
  const url = buildRouteUrl({ name: 'class', course: 'Algebra 2', teacher: 'rh@m.o' }, '?mode=test');
  assert.ok(url.startsWith('?mode=test#class/'));
  // The rest must be a valid class hash.
  const hash = url.slice(url.indexOf('#'));
  assert.deepEqual(parseHash(hash), { name: 'class', course: 'Algebra 2', teacher: 'rh@m.o' });
});

test('buildRouteUrl: adds a ? if the caller passes a bare query string', () => {
  // Legacy callers might pass `mode=test` without the ?. Handle it forgivingly.
  const url = buildRouteUrl({ name: 'home' }, 'mode=test');
  assert.equal(url, '?mode=test#home');
});

test('buildRouteUrl: empty search string emits just #hash (no bare ?)', () => {
  assert.equal(buildRouteUrl({ name: 'home' }, ''), '#home');
  assert.equal(buildRouteUrl({ name: 'home' }, undefined), '#home');
  assert.equal(buildRouteUrl({ name: 'home' }, null), '#home');
});
