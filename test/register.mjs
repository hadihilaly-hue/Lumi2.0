// Loaded via `node --import ./test/register.mjs` before any test module.
//
// The Lumi frontend modules are browser ES modules. They reference two browser
// globals AT MODULE-LOAD TIME:
//   - localStorage  (js/state.js reads `lumi_intro_shown` when it evaluates)
//   - document.getElementById  (js/state.js caches element handles via `$()`)
// Everything else the modules touch (fetch, classList, addEventListener, …)
// lives inside function bodies, so it only matters when a test actually calls
// that function — and the pure-logic functions under test never do.
//
// So this file installs the SMALLEST set of globals that let the whole module
// graph import cleanly and lets the pure functions run fully offline. It is NOT
// a DOM implementation: getElementById returns null (every caller null-guards),
// there is no element tree, and fetch throws so an accidental network call in a
// test fails loudly instead of hanging. DOM-heavy modules (sidebar, chat, voice)
// are imported as a side effect of the graph but never exercised.

// ── localStorage / sessionStorage: real in-memory Web Storage ────────────────
class MemoryStorage {
  #map = new Map();
  getItem(k) { return this.#map.has(String(k)) ? this.#map.get(String(k)) : null; }
  setItem(k, v) { this.#map.set(String(k), String(v)); }
  removeItem(k) { this.#map.delete(String(k)); }
  clear() { this.#map.clear(); }
  key(i) { return [...this.#map.keys()][i] ?? null; }
  get length() { return this.#map.size; }
  // Test-only escape hatch so the harness can reset/seed without going through
  // the Web Storage API one key at a time.
  __reset(seed = {}) {
    this.#map.clear();
    for (const [k, v] of Object.entries(seed)) this.#map.set(String(k), String(v));
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

// ── document: enough to import, nothing more ─────────────────────────────────
// getElementById returns null (the "not found" case every caller already
// handles). querySelector* mirror that. No real elements are ever created.
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => { throw new Error('document.createElement is not stubbed — this module is out of scope for these tests'); },
  addEventListener: () => {},
  body: null,
};

// ── window: bare stand-in referenced only inside functions ───────────────────
// (navigator is already a read-only Node global; the modules don't need more.)
globalThis.window = globalThis;

// ── fetch: fail loudly. The suite runs fully offline; any function that would
// hit the network is out of scope, and reaching this is a bug in the test. ────
globalThis.fetch = () => Promise.reject(new Error('fetch() is disabled in the offline test suite'));
