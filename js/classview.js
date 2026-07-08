// Class view (Session 1 slice per docs/STUDENT_HOME_REDESIGN.md §4.1.2 + §4.8).
// Reuses the existing #chatPanel pipeline verbatim - streaming, message
// rendering, work-sample vision, notes/artifacts/progress-note markers all
// unchanged. This module only adds the back-button/header chrome above the
// panel and delegates the chat startup to openTutor().
//
// Deferred to later sessions:
//   Session 3: left rail (convs / homework / projects panels).
//   Session 7: voice V-A restructure (mic + input at document scope).

import { openTutor } from './conversation.js';
import { unmountHome } from './home.js';
import { navHome } from './router.js';
import { S } from './state.js';

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

  const header = document.getElementById('classViewHeader');
  const chat = document.getElementById('chatPanel');
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

  // Skip openTutor if the same class is already the active tutor context
  // (route re-mount, hashchange no-op, or Session 1 second visit).
  const ctx = S.tutorCtx;
  if (ctx && ctx.course === course && ctx.teacher === teacher) return;

  const { subjectId } = lookupSubjectForCourse(course);
  openTutor(subjectId, course, teacher);
}
