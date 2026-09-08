// Boot guard for the teacher.html and admin.html module graphs (js/teacher/**,
// js/admin/**) — same rationale as test/boot-smoke.test.mjs, which only walks
// the top level of js/. Every non-entry module is dynamically imported (parse +
// link + top-level eval); the two main.js entries boot the page, so they get a
// `node --check` syntax gate only. Also asserts each HTML page loads exactly
// one module entry and no longer carries an inline script body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

for (const [dir, page, minModules] of [['teacher', 'teacher.html', 10], ['admin', 'admin.html', 3]]) {
  const modDir = join(root, 'js', dir);
  const files = readdirSync(modDir).filter(f => f.endsWith('.js')).sort();

  test(`js/${dir}/ contains the split module set`, () => {
    assert.ok(files.length >= minModules, `expected >= ${minModules} modules, found ${files.length}`);
    assert.ok(files.includes('main.js'));
  });

  for (const file of files.filter(f => f !== 'main.js')) {
    test(`js/${dir}/${file} imports cleanly`, async () => {
      await import(pathToFileURL(join(modDir, file)).href);
    });
  }

  test(`js/${dir}/main.js passes node --check (entry, not executed)`, () => {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(modDir, 'main.js')], { stdio: 'pipe' }),
    );
  });

  test(`${page} loads js/${dir}/main.js as its only module script`, () => {
    const html = readFileSync(join(root, page), 'utf8');
    const moduleTags = html.match(/<script type="module"[^>]*>/g) || [];
    assert.deepEqual(moduleTags, [`<script type="module" src="js/${dir}/main.js">`]);
    // Only the tiny <head> shims (stylesheet cache-bust, dark-mode class) may stay
    // inline; the page logic must live in the module graph.
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(m[1])) continue;
      assert.ok(m[2].split('\n').length <= 3, `inline script body found in ${page}: ${m[2].slice(0, 80)}`);
    }
  });
}
