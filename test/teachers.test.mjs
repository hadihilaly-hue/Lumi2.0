import assert from 'node:assert/strict';
import { test } from 'node:test';

import { signedInDestination } from '../js/teachers.js';

// ── signedInDestination (Session 2b) ─────────────────────────────────────────
// The post-sign-in routing decision. index.html has one button and always
// returns to app.html; this is what sends a teacher on to their portal.
// `allowed` is injected in every case here so the tests never read a global.

const LIST = ['ferraro@lumidemo.test', 'okonkwo@lumidemo.test'];

test('signedInDestination: allowlisted email routes to the teacher portal', () => {
  assert.equal(
    signedInDestination({ email: 'ferraro@lumidemo.test', allowed: LIST }),
    'teacher.html',
  );
});

test('signedInDestination: test mode never forwards, even for a teacher', () => {
  // Load-bearing. Teacher Test Mode sends a teacher to app.html?mode=test on
  // purpose; forwarding here would bounce them back and make it unreachable.
  assert.equal(
    signedInDestination({ email: 'ferraro@lumidemo.test', allowed: LIST, isTestMode: true }),
    null,
  );
});

test('signedInDestination: a non-allowlisted email stays in the student app', () => {
  assert.equal(signedInDestination({ email: 'student@lumidemo.test', allowed: LIST }), null);
});

test('signedInDestination: matching is case-insensitive on both sides', () => {
  assert.equal(
    signedInDestination({ email: 'Ferraro@LumiDemo.Test', allowed: LIST }),
    'teacher.html',
  );
  assert.equal(
    signedInDestination({ email: 'ferraro@lumidemo.test', allowed: ['FERRARO@LUMIDEMO.TEST'] }),
    'teacher.html',
  );
});

test('signedInDestination: surrounding whitespace is trimmed on both sides', () => {
  assert.equal(
    signedInDestination({ email: '  ferraro@lumidemo.test  ', allowed: LIST }),
    'teacher.html',
  );
  assert.equal(
    signedInDestination({ email: 'ferraro@lumidemo.test', allowed: [' ferraro@lumidemo.test '] }),
    'teacher.html',
  );
});

test('signedInDestination: a missing email never forwards', () => {
  for (const email of [null, undefined, '']) {
    assert.equal(signedInDestination({ email, allowed: LIST }), null, `email=${String(email)}`);
  }
});

test('signedInDestination: an empty allowlist never forwards', () => {
  assert.equal(signedInDestination({ email: 'ferraro@lumidemo.test', allowed: [] }), null);
});

test('signedInDestination: an absent allowlist returns null rather than throwing', () => {
  const saved = globalThis.ALLOWED_TEACHER_EMAILS;
  delete globalThis.ALLOWED_TEACHER_EMAILS;
  try {
    assert.equal(signedInDestination({ email: 'ferraro@lumidemo.test' }), null);
    assert.equal(signedInDestination(), null);
  } finally {
    if (saved !== undefined) globalThis.ALLOWED_TEACHER_EMAILS = saved;
  }
});

test('signedInDestination: near-miss addresses do not match', () => {
  for (const email of ['aferraro@lumidemo.test', 'ferraro@lumidemo.test.co', 'ferraro@lumidemo']) {
    assert.equal(signedInDestination({ email, allowed: LIST }), null, email);
  }
});
