// Teacher portal entry (teacher.html). Boot: consent gate → auth gate →
// data-driven teacher gate → home. Also exposes the handlers teacher.html's
// inline on* attributes call, since module scope is not global scope.

import { T } from './state.js';
import { showView } from './ui.js';
import { runConsentGate } from './consentGate.js';
import { installTestModeReset, enterStudentMode } from './studentMode.js';
import { bootHome, loadAllTeacherProfiles } from './home.js';
import {
  goHome, nextStep, prevStep, editField, toggleExamples, useTemplate, skipTemplate, isWizardDirty,
} from './wizardUi.js';
import { handleSampleFiles, addTextArtifact } from './workSamples.js';
import {
  handleSyllabusUpload, handleSyllabusDragOver, handleSyllabusDragLeave, handleSyllabusDrop,
} from './syllabus.js';
import { toggleMic } from './speech.js';
import { saveTeacherProfile } from './saveProfile.js';
import { rosterBack, noteChatBack, wireNoteChat } from './roster.js';

Object.assign(window, {
  enterStudentMode,
  goHome, nextStep, prevStep, editField, toggleExamples, useTemplate, skipTemplate,
  handleSampleFiles, addTextArtifact,
  handleSyllabusUpload, handleSyllabusDragOver, handleSyllabusDragLeave, handleSyllabusDrop,
  toggleMic,
  saveTeacherProfile,
  rosterBack, noteChatBack,
});

const GOOGLE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';

function wireSigninBtn() {
  const btn = document.getElementById('tSigninBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `${GOOGLE_SVG} Redirecting…`;
    try {
      const base = window.location.href.replace(/\/[^/]*$/, '/');
      const redirectTo = base + 'teacher.html';
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (error) throw error;
    } catch (_err) {
      btn.disabled = false;
      btn.innerHTML = `${GOOGLE_SVG} Sign in with Google`;
      document.getElementById('tSigninError').textContent = 'Something went wrong. Please try again.';
      document.getElementById('tSigninError').style.display = 'block';
    }
  });
}

async function handleUser(user) {
  T.user = user;
  const email = user.email.toLowerCase();
  // Data-driven teacher gate (replaces the hardcoded TEACHER_DATABASE). Load the
  // caller's own teacher_profiles rows; a caller may enter the portal iff the
  // SERVER already recognizes them as a teacher — they own >=1 such row (a
  // SIS-seeded stub or a prior authorized onboarding, the same standing
  // isProvisionedTeacher trusts) or they are the admin. A student can never mint
  // a teacher_profiles row (POST /teacher-profile is gated by isProvisionedTeacher),
  // so a student always falls through to unknownView. Their class list is exactly
  // those rows' course_names — the classes they were provisioned to onboard.
  await loadAllTeacherProfiles(); // populates T.profiles keyed by course_name
  const classes = Object.keys(T.profiles);
  const isAdmin = window.ADMIN_EMAIL && email === String(window.ADMIN_EMAIL).toLowerCase();
  if (classes.length === 0 && !isAdmin) {
    document.getElementById('unknownEmail').textContent = email;
    showView('unknownView');
    return;
  }
  const meta = user.user_metadata || {};
  T.teacher = { name: meta.full_name || meta.name || email.split('@')[0], classes };
  await bootHome();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function boot() {
  installTestModeReset();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    showView('signinView');
    wireSigninBtn();
    return;
  }
  // Fetch the directory for the admin identity (window.ADMIN_EMAIL) the gate
  // below consults. Fail-open — a missing directory only affects the admin
  // bypass; a real teacher is still admitted by their teacher_profiles rows.
  try { await window.loadTeacherDirectory(); }
  catch (e) { console.error('[teacher] directory load failed:', e); }
  handleUser(session.user);
}

window.addEventListener('beforeunload', (ev) => {
  if (!document.getElementById('wizardView').classList.contains('is-active')) return;
  if (!T.saving && !isWizardDirty()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

// PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

wireNoteChat();
runConsentGate();
boot();
