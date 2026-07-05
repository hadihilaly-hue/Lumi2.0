// Stub for pg (used only by db.test.mjs, which loads the REAL db.js). Captures
// the Pool config so a test can assert on it (max, ssl, allowExitOnIdle, the
// password token function, ...) and records/answers query() calls. State is
// exposed on globalThis.__PG_STUB__ for inspection.
function state() {
  return (globalThis.__PG_STUB__ ||= { pools: [], queryResult: { rows: [{ ok: 1 }], rowCount: 1 } });
}

class Pool {
  constructor(config) {
    this.config = config;
    this.queries = [];
    this.errorHandlers = [];
    state().pools.push(this);
  }
  on(event, handler) {
    if (event === 'error') this.errorHandlers.push(handler);
    return this;
  }
  async query(text, params) {
    this.queries.push({ text, params });
    const s = state();
    if (s.queryError) throw s.queryError;
    return s.queryResult;
  }
}

export default { Pool };
