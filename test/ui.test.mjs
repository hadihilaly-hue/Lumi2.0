// js/ui.js — only escHtml is DOM-free and testable here. The rest of ui.js
// (openSidebar, updateSendBtn, showToast, …) reads live DOM element handles and
// is out of scope for the offline suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escHtml } from '../js/ui.js';

test('escHtml escapes &, <, and > for safe text rendering', () => {
  assert.equal(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escHtml('a & b'), 'a &amp; b');
  assert.equal(escHtml('1 < 2 > 0'), '1 &lt; 2 &gt; 0');
});

test('escHtml escapes ampersands first, so entities are not double-encoded oddly', () => {
  // & is replaced before < and >, so "&lt;" in the input becomes "&amp;lt;".
  assert.equal(escHtml('&lt;'), '&amp;lt;');
});

test('escHtml leaves quotes unescaped (current behavior — text-node use, not attributes)', () => {
  // NOTE: escHtml does NOT escape " or '. It is only safe for text-node content,
  // not for interpolation into an unquoted/quoted HTML attribute value. Pinning
  // current behavior rather than changing it.
  assert.equal(escHtml(`He said "hi" & 'bye'`), `He said "hi" &amp; 'bye'`);
});

test('escHtml is a no-op for strings with no special characters', () => {
  assert.equal(escHtml('plain text 123'), 'plain text 123');
  assert.equal(escHtml(''), '');
});
