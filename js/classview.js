// Class view (Session 1 slice per docs/STUDENT_HOME_REDESIGN.md §4.1.2 + §4.8).
// Reuses the existing #chatPanel pipeline verbatim - streaming, message
// rendering, work-sample vision, notes/artifacts/progress-note markers all
// unchanged. This module only adds the back-button/header chrome above the
// panel and delegates the chat startup to openTutor().
//
// Deferred to later sessions:
//   Session 3: left rail (convs / homework / projects panels).
//   Session 7: voice V-A restructure (mic + input at document scope).

import { openGeneralChat, openTutor } from './conversation.js';
import { closestCourseCandidates, resolveCanonicalCourse } from './courseNormalize.js';
import { unmountHome } from './home.js';
import { navHome } from './router.js';
import { S, SB } from './state.js';
import { mountRail, unmountRail } from './classviewrail.js';
import { getAvailableClassesSync } from './teachers.js';

// Look up subjectId for a course name. Mirrors the same lookup the sidebar's
// openTutor callers do — we import lookupSubjectForCourse from conversation.js
// to keep the resolution in one place.
import { lookupSubjectForCourse } from './conversation.js';

let _wiredBack = false;

function wireBackOnce() {
  if (_wiredBack) return;
  const back = document.getElementById('classViewBack');
  if (!back) return;
  back.addEventListener('click', () => navHome());
  _wiredBack = true;
}

/**
 * Mount a class view. Shows #classViewHeader + #chatPanel, hides #homeView.
 * Skips the openTutor call when the same class is already active (route was
 * re-entered via hashchange, back/forward, or a redundant nav).
 */
export function mountClass(route) {
  const { course, teacher } = route;
  if (!course || !teacher) { navHome(); return; }

  wireBackOnce();
  unmountHome();

  // Session 4 (Study Plan): make sure the plan surface is hidden when the
  // router hands us the class route directly (deep-link case).
  const planView = document.getElementById('studyPlanView');
  if (planView) planView.style.display = 'none';

  const header = document.getElementById('classViewHeader');
  const chat = document.getElementById('chatPanel');
  const body = document.getElementById('classViewBody');
  const courseEl = document.getElementById('classViewCourse');
  const teacherEl = document.getElementById('classViewTeacher');

  if (courseEl) courseEl.textContent = course;
  if (teacherEl) {
    // Display teacher last name only (matches teacherDisplayName() fallback
    // without a hydrated profile — kept consistent with home.js).
    const parts = String(teacher).trim().split(/\s+/).filter(Boolean);
    teacherEl.textContent = parts.length > 1 ? parts[parts.length - 1] : teacher;
  }

  if (header) header.style.display = '';
  if (chat) chat.style.display = '';
  // mountHome/mountPlan/mountGeneral now hide #classViewBody so a hidden-child
  // flex:1 wrapper doesn't compete for column-flex space. Restore it here so
  // the rail + chatPanel render inside their flex:1 wrapper as before.
  if (body) body.style.display = '';

  // Session 3: mount the left rail (convs / HW / projects, scoped to this
  // class). No-op under flag-off — the old sidebar handles nav. Mounting
  // BEFORE the openTutor short-circuit below so a re-nav to the same class
  // still refreshes the rail (e.g. after loadConv from the rail).
  mountRail(course, teacher);

  // Skip openTutor if the same class is already the active tutor context
  // (route re-mount, hashchange no-op, or Session 1 second visit).
  const ctx = S.tutorCtx;
  if (ctx && ctx.course === course && ctx.teacher === teacher) return;

  const { subjectId } = lookupSubjectForCourse(course);
  // Diagnostic: subjectId is null when the scheduled course name can't be
  // reconciled to a live /available-classes row AND isn't in the static
  // MENLO_CURRICULUM. Not a chat blocker — profile fetch is keyed off
  // (email, canonical course), which resolveCanonicalCourse handles
  // independently — but a silent mismatch here can mask a wider
  // schedule/catalog drift, so surface the closest DB candidates to make
  // a rename/alias decision cheap.
  if (!subjectId) {
    const rows = getAvailableClassesSync();
    const resolved = rows ? resolveCanonicalCourse(course, rows) : null;
    const candidates = rows ? closestCourseCandidates(course, rows, 3) : [];
    console.warn(
      `[classview] lookupSubjectForCourse returned null subjectId for course "${course}". ` +
      `Chat will still open; the profile fetch may still succeed via alias resolution ` +
      `(matchType=${resolved ? resolved.matchType : 'null'}). ` +
      `Closest DB candidates: ${candidates.length ? candidates.map(c => `"${c}"`).join(', ') : '(none)'}.`
    );
  }
  openTutor(subjectId, course, teacher);
}

/**
 * Mount General Chat. Reuses #classViewHeader + #chatPanel (same DOM as
 * mountClass) so the top-left back arrow returns to home identically. The
 * header carries a lighter "General Chat" / "Across your classes" label
 * instead of course/teacher — General Chat is not a class view, it just
 * shares the shell chrome. The rail is scoped to a class view and is hidden.
 *
 * Router entry: initRouter { onGeneral: mountGeneral } in app.js. Also
 * covers deep-link refresh at `#general` and browser back/forward.
 */
export function mountGeneral() {
  wireBackOnce();
  unmountHome();

  const planView = document.getElementById('studyPlanView');
  if (planView) planView.style.display = 'none';

  const header = document.getElementById('classViewHeader');
  const chat = document.getElementById('chatPanel');
  const body = document.getElementById('classViewBody');
  const rail = document.getElementById('classViewRail');
  const railToggle = document.getElementById('classViewRailToggle');
  const courseEl = document.getElementById('classViewCourse');
  const teacherEl = document.getElementById('classViewTeacher');

  if (courseEl) courseEl.textContent = 'General Chat';
  if (teacherEl) teacherEl.textContent = 'Across your classes';

  if (header) header.style.display = '';
  if (chat) chat.style.display = '';
  if (body) body.style.display = '';
  if (rail) rail.style.display = 'none';
  if (railToggle) railToggle.style.display = 'none';
  unmountRail();

  // Mirror mountClass's re-entry short-circuit: if a General Chat session
  // is already active (tutorCtx null + SB.mode==='general' + a session id),
  // skip openGeneralChat() so browser back/forward and hashchange no-ops
  // preserve the conversation. openGeneralChat() is otherwise a fresh reset.
  if (SB.mode === 'general' && S.tutorCtx === null && S.currentId) return;
  openGeneralChat();
}
