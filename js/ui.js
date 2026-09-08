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

// ─── Mobile viewport (composer above the on-screen keyboard) ───────────────
// On mobile, 100vh/100dvh don't always shrink when the keyboard opens —
// visualViewport does. Track vv.height into --vv-height; CSS consumes it at
// ≤768px so .content/.main (and the pinned composer) stay inside the visible
// region. Idempotent; safe to call from every chat-surface mount.
let _vvWired = false;
export function wireMobileViewport() {
  if (_vvWired) return;
  _vvWired = true;
  if (typeof window === 'undefined' || !window.visualViewport) return;
  const vv = window.visualViewport;
  const apply = () => {
    document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
