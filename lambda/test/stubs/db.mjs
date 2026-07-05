// Stub for lambda/db.js as seen by index.mjs. Records every query and delegates
// the answer to the per-test router installed on globalThis.__LUMI_TEST__.
// Throwing from the router simulates a DB error (used to exercise fail-open /
// fail-closed branches).
export async function query(text, params) {
  const ctx = globalThis.__LUMI_TEST__;
  if (!ctx) throw new Error('db stub called with no __LUMI_TEST__ context set');
  ctx.queries.push({ text, params });
  const out = ctx.dbRouter(text, params);
  return out && typeof out.then === 'function' ? out : out;
}
