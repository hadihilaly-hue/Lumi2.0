// Student home grid (Session 1 slice per docs/STUDENT_HOME_REDESIGN.md §4.1.1
// and §4.8). Renders one card per enrolled class; tapping a ready card
// routes to that class's view.
//
// Deferred to later sessions (do not add here — the spec's session boundaries
// exist so each PR reviews cleanly):
//   Session 2: "Where you left off" line, "next due" line, priority sort,
//              red dot on urgent-HW cards.
//   Session 4: Planner card, General Chat card, due-soon strip.
//   Session 6: tomorrow-schedule peek (D4-A hidden silently until then).
//
// Session 1 sort:
//   - Student mode: alphabetical by course name.
//   - Test mode (D10-B): ready first, then locked, alphabetical within each.

import { navClass } from './router.js';
import { S } from './state.js';
import { getSchedule } from './storage.js';
import { _profileStatusCache, resolveTeacherEmail } from './teachers.js';
import { showToast } from './ui.js';

// ── Utilities ───────────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k.startsWith('data-')) n.setAttribute(k, v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.appendChild(c);
  return n;
}

// Cheap teacher display line for cards. Not the same as prompts.js's
// teacherDisplayName, which needs a hydrated profile with a `title`. Cards
// render from schedule/directory only, so we fall back to last-name-only —
// which is what teacherDisplayName also returns without a profile.
function displayTeacher(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName;
  return parts[parts.length - 1];
}

// ── Data collection ─────────────────────────────────────────────────────────

/**
 * Build the card list from S.schedule (or S.testSchedule in test mode).
 * Each entry: {course, teacher, block, ready}.
 *
 * `ready` sourcing (spec §2.3):
 *  - Test mode: honor the `ready` flag baked onto each S.testSchedule entry
 *    by loadTestModeSchedule (it knows the teacher's own profile.done state).
 *  - Student mode: use _profileStatusCache from teachers.js
 *    (preloadProfileStatuses fills it — 'ready' | 'pending'). Missing entries
 *    default to READY so a cold cache doesn't lock every card.
 */
export function buildCards() {
  const schedule = S.isTestMode ? (S.testSchedule || []) : getSchedule();
  return schedule.map(entry => {
    const ready = S.isTestMode
      ? entry.ready !== false
      : (_profileStatusCache[`${entry.course}::${entry.teacher}`] !== 'pending');
    return {
      course: entry.course,
      teacher: entry.teacher,
      block: entry.block || '',
      ready,
    };
  });
}

/** Session 1 sort per §4.2 + D10-B. */
export function sortCards(cards, isTestMode) {
  const byCourse = (a, b) => String(a.course).localeCompare(String(b.course));
  if (!isTestMode) return [...cards].sort(byCourse);
  // Test-mode D10-B: ready-first then locked-then, alphabetical within each.
  return [...cards].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return byCourse(a, b);
  });
}

// ── Card rendering ──────────────────────────────────────────────────────────

function renderCard(card) {
  const node = el('button', {
    class: 'home-card' + (card.ready ? '' : ' home-card--locked'),
    'data-course': card.course,
    'data-teacher': card.teacher,
    type: 'button',
  }, [
    el('div', { class: 'home-card-course', text: card.course }),
    el('div', { class: 'home-card-teacher', text: displayTeacher(card.teacher) }),
    card.block ? el('div', { class: 'home-card-block', text: 'Block ' + card.block }) : null,
    card.ready ? null : el('div', { class: 'home-card-lock', text: 'Setting up' }),
  ]);

  node.addEventListener('click', () => {
    if (card.ready) {
      // Ready card → route into the class view.
      navClass(card.course, card.teacher);
      return;
    }
    // Locked card behavior — spec §4.5 TM-3 vs §9 D12-A.
    if (S.isTestMode) {
      // Test mode: route the teacher to their own onboarding for this class.
      const params = new URLSearchParams({ course: card.course, from: 'test-mode' });
      window.location.href = `teacher.html?${params.toString()}`;
      return;
    }
    // Student mode: quiet toast; the card stays visible so enrollment isn't
    // silently dropped from the student's mental model.
    showToast('Your teacher is still setting up.');
  });

  return node;
}

// ── Screen mount ────────────────────────────────────────────────────────────

/** (Re)render the grid inside #homeGrid. */
export function renderHome() {
  const grid = document.getElementById('homeGrid');
  if (!grid) return;
  const cards = sortCards(buildCards(), S.isTestMode);
  grid.innerHTML = '';

  if (cards.length === 0) {
    // Empty-schedule state. Session-1-minimal: a single hint. The wizard
    // launch button is deferred to Session 3+ (the spec's empty-state affordance
    // is a full "Let's set up your classes" hero — Session 1 keeps this quiet
    // because in practice the boot flow already routes new users through the
    // schedule wizard before app.js hands off to the router.
    grid.appendChild(el('div', { class: 'home-empty', text: 'No classes on your schedule yet.' }));
    return;
  }

  for (const card of cards) grid.appendChild(renderCard(card));
}

/** Show the home view and render it. Called by the router on 'home' route. */
export function mountHome() {
  const home = document.getElementById('homeView');
  const chat = document.getElementById('chatPanel');
  const header = document.getElementById('classViewHeader');
  if (home) home.style.display = '';
  if (chat) chat.style.display = 'none';
  if (header) header.style.display = 'none';
  renderHome();
}

/** Hide the home view. The router calls this before mounting a class view. */
export function unmountHome() {
  const home = document.getElementById('homeView');
  if (home) home.style.display = 'none';
}
