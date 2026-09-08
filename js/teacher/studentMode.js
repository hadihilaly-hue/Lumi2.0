// Teacher Test Mode entry/exit (app.html?mode=test).

import { T } from './state.js';
import { tConfirm } from './ui.js';

// Loading the portal ends any student-view test session. Without this a
// teacher who used browser Back to escape student mode kept the tab flagged
// as test mode for every later visit to app.html.
export function clearTestMode() {
  sessionStorage.removeItem('lumi_test_mode');
}

export function installTestModeReset() {
  clearTestMode();
  window.addEventListener('pageshow', clearTestMode);
}

// app.html?mode=test skips the teacher redirect and drops the teacher into the
// student app as themselves. A first-time teacher lands in student onboarding,
// which has no visible way back, so explain the round trip before leaving.
export async function enterStudentMode() {
  const anyReady = Object.values(T.profiles).some(p => p?.done);
  const body = 'You will see Lumi exactly as your students do, signed in as yourself. '
    + 'The first time, Lumi walks you through the short student setup (name, grade, classes) before you can chat. '
    + 'To come back here, use Exit test mode in the student sidebar, or your browser\u2019s Back button during setup.'
    + (anyReady ? '' : ' None of your classes is set up yet, so they will show as Setting Up in the student view.');
  const go = await tConfirm({
    title: 'Preview Lumi as a student',
    body,
    confirmLabel: 'Open student view',
    cancelLabel: 'Stay here',
  });
  if (go) window.location.href = 'app.html?mode=test';
}
