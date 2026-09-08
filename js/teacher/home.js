// Home view: welcome header, class cards, and the profile/work-sample caches
// the rest of the portal reads from T.

import { REVIEW_STEP } from './config.js';
import { T } from './state.js';
import { showView } from './ui.js';
import { fetchOwnProfiles, fetchWorkSamples, fetchWorkArtifacts } from './profileApi.js';
import {
  classStatus, escHtml, filterClasses, hasAllWorkSampleTiers, missingTiersLabel,
} from './wizardState.js';
import { openWizard } from './wizardUi.js';
import { loadAllEnrollments, renderMyStudents } from './roster.js';

export async function loadAllTeacherProfiles() {
  try {
    const email = T.user?.email;
    if (!email) return;
    const data = await fetchOwnProfiles();
    T.profiles = {};
    data.forEach(row => { T.profiles[row.course_name] = row; });

    // Q4: also load any work-samples rows so we can flag profiles that
    // are still missing tiers and seed the wizard for edits.
    T.samplesByProfile = {};
    T.artifactsByProfile = {};
    const profileIds = data.map(p => p.id).filter(Boolean);
    if (profileIds.length) {
      let sampleRows = null;
      try {
        sampleRows = await fetchWorkSamples(profileIds);
      } catch (sErr) {
        console.warn('Could not load work samples:', sErr);
      }
      (sampleRows || []).forEach(r => {
        (T.samplesByProfile[r.teacher_profile_id] ||= {})[r.tier] = r;
      });
      // Q4 v2: text artifacts (owner-scoped batch). Grouped by profile → tier
      // → [rows]. Used by hasAllWorkSampleTiers and the wizard edit-seed.
      let artifactRows = null;
      try {
        artifactRows = await fetchWorkArtifacts(profileIds);
      } catch (aErr) {
        console.warn('Could not load work artifacts:', aErr);
      }
      (artifactRows || []).forEach(r => {
        const byTier = (T.artifactsByProfile[r.teacher_profile_id] ||= {});
        (byTier[r.tier] ||= []).push(r);
      });
    }
  } catch (err) {
    console.warn('Could not load teacher profiles:', err);
  }
}

// Returns true iff all three tiers are complete for this profile id (Q4 v2,
// Decision D6 — any artifact type counts; description not required).
export function profileHasAllWorkSampleTiers(profileId) {
  if (!profileId) return false;
  return hasAllWorkSampleTiers(T.samplesByProfile[profileId], T.artifactsByProfile[profileId]);
}

// Subject is no longer derivable from a hardcoded curriculum. teacher_profiles
// carries no subject column, so class cards show a neutral label. (Cosmetic only
// — the card's course name and onboarding status are the meaningful fields.)
export function lookupSubjectForCourse(courseName) {
  return 'General';
}

export async function bootHome() {
  const meta = T.user.user_metadata || {};
  const fullName = meta.full_name || meta.name || T.teacher.name;
  const firstName = fullName.split(' ')[0];

  document.getElementById('welcomeHeading').textContent = `Welcome, ${firstName}`;
  document.getElementById('hdrName').textContent = fullName;

  const avatarEl = document.getElementById('hdrAvatar');
  avatarEl.innerHTML = '';
  if (meta.avatar_url) {
    const img = document.createElement('img');
    img.src = meta.avatar_url;
    img.alt = '';
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = firstName[0].toUpperCase();
  }

  // T.profiles was already loaded by the gate in handleUser() — no re-fetch here.
  renderClassCards();
  await loadAllEnrollments();
  renderMyStudents();

  document.getElementById('tClassSearch')?.addEventListener('input', renderClassCards);
  document.querySelectorAll('.t-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      // .active is the only source of pill appearance — the inline writes that
      // used to live here overrode the stylesheet and painted the selected
      // pill's label with --accent, a fourth use of an accent DESIGN.md §1
      // limits to three.
      document.querySelectorAll('.t-filter-pill').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-pressed', 'true');
      renderClassCards();
    });
  });

  const _tmParams = new URLSearchParams(window.location.search);
  const _tmCourse = _tmParams.get('course');

  // TM-4: set the "Back to test mode" banner's visibility BEFORE the
  // openWizard branch below. The banner lives inside homeView markup,
  // so it's invisible while wizardView is showing and becomes visible
  // automatically when goHome → showView('homeView') runs after Save.
  if (_tmParams.get('from') === 'test-mode') {
    const banner = document.getElementById('tBackToTestBanner');
    if (banner) banner.style.display = 'flex';
  }

  // TM-3: if arriving via the locked-class route from the student app's
  // test-mode sidebar (teacher.html?course=...&from=test-mode), jump
  // straight into the wizard for that course instead of showing the
  // home view first. The course must be one this teacher actually
  // teaches — defensive check against URL tampering.
  if (_tmCourse && T.teacher.classes?.includes(_tmCourse)) {
    const subject = lookupSubjectForCourse(_tmCourse);
    openWizard(_tmCourse, subject);
    return;
  }

  showView('homeView');
}

export function renderClassCards() {
  const grid = document.getElementById('classCards');
  const filterBar = document.getElementById('tFilterBar');
  grid.innerHTML = '';

  if (!T.teacher.classes || T.teacher.classes.length === 0) {
    if (filterBar) filterBar.style.display = 'none';
    grid.innerHTML = `
      <div class="empty t-grid-empty">
        <div class="empty-title">No classes yet</div>
        <div class="empty-text">Your classes will appear here once an administrator adds them to your account.</div>
      </div>`;
    return;
  }
  if (filterBar) filterBar.style.display = 'flex';

  const search = document.getElementById('tClassSearch')?.value || '';
  const status = document.querySelector('.t-filter-pill.active')?.dataset.status || 'all';

  filterClasses(T.teacher.classes, T.profiles, { search, status, subjectFor: lookupSubjectForCourse })
    .forEach(course => {
      const subject = lookupSubjectForCourse(course);
      const profile = T.profiles[course];
      const complete = classStatus(profile) === 'complete';

      const dotClass = complete ? 'complete' : 'not_started';
      const statusLabel = complete ? 'Complete' : 'Not Started';
      const btnLabel = complete ? 'View & Edit' : 'Set up profile';

      const previewText = profile?.engagement_rules || profile?.teaching_voice || '';

      // Q4: if a "complete" profile is still missing any of the 3 work-sample
      // tiers, surface a banner inside the card and offer a click-through that
      // jumps directly to the work-samples step. The profile itself stays
      // usable in the meantime — we don't reset done.
      const needsSamples = complete && !profileHasAllWorkSampleTiers(profile?.id);
      // Phase 5b: same treatment for the new welcome_message step.
      const needsWelcome = complete && !(profile?.welcome_message || '').trim();

      // The card is a plain container composing .card / .card--interactive; each
      // action is a real button. Previously the whole card was role="button" and
      // the notices were nested clickable divs — which meant keyActivate always
      // fired with e.target === the card, so closest('[data-add-samples]') was
      // never non-null and the jump-to-step actions were reachable by mouse only.
      const card = document.createElement('div');
      card.className = 'card card--interactive t-card';
      card.innerHTML = `
        <div class="t-card-subject">${escHtml(subject)}</div>
        <div class="t-card-course">${escHtml(course)}</div>
        <div class="t-card-meta">
          <span class="t-status-dot ${dotClass}"></span>
          <span class="card-meta">${statusLabel}</span>
        </div>
        ${previewText ? `<div class="t-card-preview">${escHtml(previewText)}</div>` : ''}
        ${needsWelcome ? `
          <div class="t-card-notice">
            <div class="t-card-notice-head">Missing welcome message</div>
            <div class="t-card-notice-body">Add a welcome message so students see your voice when they open the class.</div>
          </div>` : ''}
        ${needsSamples ? `
          <div class="t-card-notice">
            <div class="t-card-notice-head">Optional: ${escHtml(missingTiersLabel(T.samplesByProfile[profile?.id], T.artifactsByProfile[profile?.id]))}</div>
            <div class="t-card-notice-body">Add a photo or written example for each level so Lumi can match your feedback voice.</div>
          </div>` : ''}
        <div class="t-card-actions"></div>
      `;

      // One ghost button per action, each its own tab stop with its own name.
      const actions = card.querySelector('.t-card-actions');
      const addAction = (label, jumpStep) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost';
        btn.textContent = label;
        btn.setAttribute('aria-label', `${label} — ${course}`);
        btn.addEventListener('click', () => {
          openWizard(course, subject, jumpStep ? { jumpToStep: jumpStep } : {});
        });
        actions.appendChild(btn);
      };
      // A completed class opens on the review summary so the teacher sees what
      // students get before editing; a fresh class starts at step 1.
      addAction(btnLabel, complete ? REVIEW_STEP : null);
      if (needsWelcome) addAction('Add welcome message', 4);
      if (needsSamples) addAction('Add samples', 5);

      grid.appendChild(card);
    });
}
