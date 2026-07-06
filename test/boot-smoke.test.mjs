// Boot guard for the app.html module graph.
//
// In one week, app boot broke THREE times from the same class of defect that a
// unit test of behavior never catches:
//   - a duplicate `export function loadConv` (SyntaxError, PR #17),
//   - a duplicate `import` of js/projects.js in app.js (SyntaxError, PR #16),
//   - and adjacent frontend-fragility fixes.
// None changed logic — the files simply stopped parsing/linking, so the whole
// `<script type="module">` graph failed and the app rendered nothing.
//
// This guard reproduces exactly that failure surface, offline and in CI:
//   1. Every js/*.js module is dynamically imported. A dynamic import runs the
//      FULL module job — parse (SyntaxError), link (a missing/renamed named
//      export in ANY module it pulls in), and top-level evaluation. That is a
//      strict superset of `node --check`, and it is precisely what the browser
//      does when it loads the graph.
//   2. The entry scripts the browser loads but we must NOT execute here
//      (app.js runs the auth guard + DOM boot; cognito-auth.js is a classic
//      script) get a standalone `node --check` syntax gate — enough to catch
//      the duplicate-import SyntaxError that took down app.js boot.
//
// Data-driven: it reads js/ at runtime, so a newly-split module is guarded
// automatically with no edit here. The offline globals (localStorage, a
// null-returning document, a throwing fetch) come from test/register.mjs, so
// top-level module evaluation succeeds without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const jsDir = join(root, 'js');

const jsModules = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();

test('js/ contains the split module set (guard is actually seeing files)', () => {
  // Sanity floor: if the directory ever comes back empty (bad checkout, moved
  // path), fail loudly instead of "passing" by testing nothing.
  assert.ok(jsModules.length >= 10, `expected the split js/ modules, found ${jsModules.length}`);
});

for (const file of jsModules) {
  test(`js/${file} imports cleanly (parse + cross-module link + top-level eval)`, async () => {
    await import(pathToFileURL(join(jsDir, file)).href);
  });
}

// Entry scripts: syntax-gate only (do not execute — they boot the app).
for (const entry of ['app.js', 'cognito-auth.js']) {
  test(`${entry} passes node --check (syntax gate, not executed)`, () => {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(root, entry)], { stdio: 'pipe' }),
      `${entry} failed to parse — this breaks app boot`,
    );
  });
}
