// ─── AUTH GUARD ───────────────────────────────────────────────────────────────
export let currentUser = null;

// ─── STATE ────────────────────────────────────────────────────────────────────
export const S = {
  currentId:     null,
  messages:      [],
  values:        new Set(),
  goals:         new Set(),
  interests:     new Set(),
  exchangeCount: 0,
  ready:         false,
  busy:          false,
  tutorCtx:      null,   // { subjectId, subjectName, course, teacher } or null
  // TM-2: teacher-test-mode flags. Boot detection sets isTestMode from
  // ?mode=test URL param + sessionStorage stickiness. testSchedule is
  // synthesized from teacher_profiles (NEVER written to localStorage to
  // avoid cross-user pollution on shared browsers). testConvs is the
  // in-memory conversation cache used in test mode (filtered to
  // is_teacher_test=true; never touches lumi_convs localStorage).
  isTestMode:    false,
  testSchedule:  [],
  testConvs:     {},
};

export const SB = {
  mode:            'all',   // 'all' | 'general' | 'tutor'
  expandedSubject: null,
  expandedCourse:  null,
  activeTeacher:   null,
  showAllClasses:  false,
};

// ─── ELEMENTS ─────────────────────────────────────────────────────────────────
export const $ = id => document.getElementById(id);
export const messagesEl    = $('messages');
export const msgInput      = $('msgInput');
export const sendBtn       = $('sendBtn');
export const toast         = $('toast');
export const attachPreview = $('attachPreview');
export const fileInput     = $('fileInput');
export const sbNav         = $('sbNav');
export const sbSearch      = $('sbSearch');
export const themeToggle   = $('themeToggle');
// API key is now server-side (Netlify function); no client-side key needed

export let pendingAttachment = null;

// Tracks which classes have shown the intro slide (persisted across sessions)
export const _introShownFor = new Set(
  (() => { try { return JSON.parse(localStorage.getItem('lumi_intro_shown') || '[]'); } catch { return []; } })()
);
export function _saveIntroShown() { localStorage.setItem('lumi_intro_shown', JSON.stringify([..._introShownFor])); }

export let _currentProjId = null; // tracks which project the plan modal is showing

// ─── MUTABLE-GLOBAL SETTERS ───────────────────────────────────────────────────
// An imported binding is read-only in the importing module, so cross-module
// writes to these shared vars go through setters (behavior-preserving).
export function setCurrentUser(u)       { currentUser = u; }
export function setPendingAttachment(v) { pendingAttachment = v; }
export function setCurrentProjId(id)    { _currentProjId = id; }
