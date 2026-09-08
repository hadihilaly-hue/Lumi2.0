// Small DOM primitives shared by every teacher-portal view.

// ─── VIEWS ────────────────────────────────────────────────────────────────────
export function showView(name) {
  // Visibility is a class, never an inline style — the stylesheet decides what
  // each view's display value is. Writing display inline is what let the old
  // implementation override #signinView's flex centring without anyone noticing.
  document.querySelectorAll('.t-view').forEach(el => el.classList.remove('is-active'));
  document.getElementById(name).classList.add('is-active');
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
export function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 't-toast show ' + type;
  setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

// ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────
// Resolves true when the teacher confirms. Cancel, Escape and a backdrop click
// all resolve false.
export function tConfirm({ title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel' }) {
  return new Promise(resolve => {
    const root = document.getElementById('tConfirm');
    const ok = document.getElementById('tConfirmOk');
    const cancel = document.getElementById('tConfirmCancel');
    document.getElementById('tConfirmTitle').textContent = title;
    document.getElementById('tConfirmBody').textContent = body;
    ok.textContent = confirmLabel;
    cancel.textContent = cancelLabel;
    const previouslyFocused = document.activeElement;
    const finish = (result) => {
      root.style.display = 'none';
      ok.onclick = cancel.onclick = root.onclick = null;
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      resolve(result);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') finish(false); };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    root.onclick = (ev) => { if (ev.target === root) finish(false); };
    document.addEventListener('keydown', onKey);
    root.style.display = 'flex';
    cancel.focus();
  });
}

// A11y: make a click-only element operable for keyboard users —
// exposes it as a button, makes it focusable, and activates on
// Enter/Space (WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value).
export function keyActivate(el, fn, label) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  });
}

// Re-bind a per-element listener stored under `slot`, so re-opening the wizard
// never stacks duplicate handlers on the long-lived inputs.
export function rebind(el, event, slot, handler) {
  el.removeEventListener(event, el[slot]);
  el[slot] = handler;
  el.addEventListener(event, handler);
}
