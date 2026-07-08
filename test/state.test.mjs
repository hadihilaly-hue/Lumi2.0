// js/state.js — shared mutable state objects + cross-module setters.
// The DOM element handles ($, messagesEl, …) are out of scope: with the offline
// document stub they resolve to null, which is exactly the "element not present"
// case, and there is no behavior to assert on a null handle.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  S,
  SB,
  currentUser,
  setCurrentUser,
  pendingAttachment,
  setPendingAttachment,
  setCurrentProjId,
  _introShownFor,
  _saveIntroShown,
} from '../js/state.js';
import { reset } from './harness.mjs';

beforeEach(() => reset());

test('S has the documented initial shape', () => {
  assert.equal(S.currentId, null);
  assert.deepEqual(S.messages, []);
  assert.ok(S.values instanceof Set && S.values.size === 0);
  assert.ok(S.goals instanceof Set && S.goals.size === 0);
  assert.ok(S.interests instanceof Set && S.interests.size === 0);
  assert.equal(S.exchangeCount, 0);
  assert.equal(S.ready, false);
  assert.equal(S.busy, false);
  assert.equal(S.tutorCtx, null);
  assert.equal(S.isTestMode, false);
  assert.deepEqual(S.testSchedule, []);
  assert.deepEqual(S.testConvs, {});
  // Student-home redesign v1 flag + route (docs/STUDENT_HOME_REDESIGN.md §4.7).
  assert.equal(S.homeRedesign, false);
  assert.deepEqual(S.route, { name: 'home' });
});

test('SB (sidebar state) has the documented initial shape', () => {
  assert.equal(SB.mode, 'all');
  assert.equal(SB.expandedSubject, null);
  assert.equal(SB.expandedCourse, null);
  assert.equal(SB.activeTeacher, null);
  assert.equal(SB.showAllClasses, false);
});

test('setCurrentUser reassigns the live currentUser binding', async () => {
  // currentUser is imported as a live binding; the setter exists because an
  // imported binding is read-only in the importing module.
  assert.equal(currentUser, null);
  setCurrentUser({ email: 'a@menloschool.org' });
  // Re-read through a fresh import to observe the live binding update.
  const state = await import('../js/state.js');
  assert.deepEqual(state.currentUser, { email: 'a@menloschool.org' });
});

test('setPendingAttachment updates the live pendingAttachment binding', async () => {
  assert.equal(pendingAttachment, null);
  setPendingAttachment({ type: 'image', name: 'x.png' });
  const state = await import('../js/state.js');
  assert.deepEqual(state.pendingAttachment, { type: 'image', name: 'x.png' });
  setPendingAttachment(null);
  const state2 = await import('../js/state.js');
  assert.equal(state2.pendingAttachment, null);
});

test('setCurrentProjId updates the live _currentProjId binding', async () => {
  setCurrentProjId('proj_42');
  const state = await import('../js/state.js');
  assert.equal(state._currentProjId, 'proj_42');
});

test('_saveIntroShown persists the intro-shown set as a JSON array', () => {
  // _introShownFor is loaded from localStorage at module-load (empty here);
  // _saveIntroShown writes the current set back under lumi_intro_shown.
  _introShownFor.add('english-1');
  _introShownFor.add('math-algebra-2');
  _saveIntroShown();
  const stored = JSON.parse(globalThis.localStorage.getItem('lumi_intro_shown'));
  assert.deepEqual(stored.sort(), ['english-1', 'math-algebra-2']);
  // Cleanup: keep the module-level Set from leaking into later tests.
  _introShownFor.delete('english-1');
  _introShownFor.delete('math-algebra-2');
});

test('S is a shared singleton: mutations are visible through re-import', async () => {
  S.isTestMode = true;
  S.testSchedule = [{ course: 'Chemistry', teacher: 'Laura Huntley' }];
  const state = await import('../js/state.js');
  assert.equal(state.S.isTestMode, true);
  assert.equal(state.S.testSchedule[0].course, 'Chemistry');
});
