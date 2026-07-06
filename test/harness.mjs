// Shared helpers for the frontend module suite.
//
// The js/ modules are singletons within a test file's process (node --test runs
// each *.test.mjs in its own child), so mutable module state — the in-memory
// localStorage and the shared `S` / `currentUser` state objects — leaks between
// tests in the same file unless reset. `reset()` returns everything to the
// module-load baseline; call it from beforeEach.

import { S, setCurrentUser } from '../js/state.js';

// Snapshot of S's initial shape (the fields any test might mutate). Kept here
// rather than imported so a test can't accidentally alias-and-mutate it.
function baselineState() {
  return {
    currentId: null,
    messages: [],
    values: new Set(),
    goals: new Set(),
    interests: new Set(),
    exchangeCount: 0,
    ready: false,
    busy: false,
    tutorCtx: null,
    isTestMode: false,
    testSchedule: [],
    testConvs: {},
  };
}

// Reset localStorage + sessionStorage to `seed` (default: empty).
export function resetStorage(seed = {}) {
  globalThis.localStorage.__reset(seed);
  globalThis.sessionStorage.__reset({});
}

// Reset the shared S state object in place (callers hold a live reference to it).
export function resetState() {
  Object.assign(S, baselineState());
  setCurrentUser(null);
}

// One call for beforeEach: clean storage + clean state.
export function reset(seed = {}) {
  resetStorage(seed);
  resetState();
}

// Convenience: seed localStorage from a plain object of JSON-able values.
// Strings are stored verbatim; everything else is JSON.stringified — matching
// how the app writes (localStorage.setItem(k, JSON.stringify(v))).
export function seedLocalStorage(obj) {
  for (const [k, v] of Object.entries(obj)) {
    globalThis.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
}
