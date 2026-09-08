// FERPA data requests (admin erasure + export) UI.

import { adminApi } from './adminApi.js';
import { escHtml } from './dashboardState.js';

function ferpaSetResult(html, kind) {
  const el = document.getElementById('ferpaResult');
  // Tone via class, not an inline colour — 'ok' reads as ordinary text
  // (DESIGN.md allows no success green); only errors take --danger.
  el.classList.remove('is-error', 'is-ok');
  if (kind === 'error') el.classList.add('is-error');
  else if (kind === 'ok') el.classList.add('is-ok');
  el.innerHTML = html;
}

export async function ferpaExport() {
  const email = document.getElementById('ferpaEmail').value.trim();
  if (!email) { ferpaSetResult('Enter a student email first.', 'error'); return; }
  ferpaSetResult('Exporting…');
  try {
    const payload = await adminApi(`/admin/student-data?email=${encodeURIComponent(email)}`);
    const counts = payload && payload.data
      ? Object.entries(payload.data).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : (v ? 1 : 0)}`).join(', ')
      : '';
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    ferpaSetResult(
      `Export ready for <b>${escHtml(email)}</b> — ${escHtml(counts)}. ` +
      `<a href="${url}" download="lumi-export-${encodeURIComponent(email)}.json" class="a-accent-strong">Download JSON</a>`,
      'ok');
  } catch (e) {
    ferpaSetResult(`Export failed: ${escHtml(e.message)}`, 'error');
  }
}

export function ferpaShowConfirm() {
  const email = document.getElementById('ferpaEmail').value.trim();
  if (!email) { ferpaSetResult('Enter a student email first.', 'error'); return; }
  document.getElementById('ferpaConfirmEmail').textContent = email;
  document.getElementById('ferpaConfirmInput').value = '';
  ferpaConfirmSync();
  document.getElementById('ferpaConfirm').style.display = 'block';
}

export function ferpaHideConfirm() { document.getElementById('ferpaConfirm').style.display = 'none'; }

export function ferpaConfirmSync() {
  const ok  = document.getElementById('ferpaConfirmInput').value === 'DELETE';
  const btn = document.getElementById('ferpaConfirmBtn');
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

export async function ferpaDelete() {
  const email = document.getElementById('ferpaConfirmEmail').textContent;
  ferpaHideConfirm();
  ferpaSetResult('Deleting…');
  try {
    const r = await adminApi('/admin/delete-student', { method: 'POST', body: { confirm: 'DELETE', email } });
    const counts = r && r.rows_affected
      ? Object.entries(r.rows_affected).map(([k, v]) => `${k}: ${v}`).join(', ')
      : '';
    const grace = r && r.grace_until ? new Date(r.grace_until).toLocaleDateString() : '';
    ferpaSetResult(
      `Soft-deleted <b>${escHtml(email)}</b> — access revoked now. Rows affected: ${escHtml(counts)}. ` +
      `Permanent removal after ${escHtml(grace)}.`,
      'ok');
  } catch (e) {
    ferpaSetResult(`Deletion failed: ${escHtml(e.message)}`, 'error');
  }
}
