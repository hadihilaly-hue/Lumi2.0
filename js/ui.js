import { $, S, msgInput, pendingAttachment, sendBtn, toast } from './state.js';


// ─── HELPERS ─────────────────────────────────────────────────────────────────
export function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

export function openSidebar()   { $('sidebar').classList.add('open');    $('sbOverlay').classList.add('open'); }
export function closeSidebar()  { $('sidebar').classList.remove('open'); $('sbOverlay').classList.remove('open'); }
export function openSettings()  { $('settingsDrawer').classList.add('open');    $('settingsOverlay').classList.add('open'); }
export function closeSettings() { $('settingsDrawer').classList.remove('open'); $('settingsOverlay').classList.remove('open'); }

export function updateSendBtn() {
  sendBtn.disabled = (!msgInput.value.trim() && !pendingAttachment) || S.busy;
}
export function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

let toastTimer;
export function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = 'toast' + (type === 'ok' ? ' ok' : '');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}
