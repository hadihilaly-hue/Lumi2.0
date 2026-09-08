// Wizard DOM: open/seed, step navigation, live word/char gates, the review
// summary, template borrowing, and the dirty-check that guards leaving.

import { TIERS, TOTAL_STEPS, WORK_SAMPLES_STEP, REVIEW_STEP } from './config.js';
import { T, emptyWorkSamples } from './state.js';
import { showView, showToast, tConfirm, rebind } from './ui.js';
import { fetchDownloadUrl, fetchTemplateForCourse } from './profileApi.js';
import {
  wordCountStatus, charCountStatus, nextStepFrom, prevStepFrom, summarizeTier,
  syllabusSummaryText, escHtml,
} from './wizardState.js';
import { renderTierUI, renderTierArtifacts, validateStep4 } from './workSamples.js';
import { renderSyllabusList } from './syllabus.js';
import { renderClassCards } from './home.js';

// Snapshot of every wizard field, compared by isWizardDirty() before the
// header Back button or a page unload can discard unsaved edits.
export function wizardSnapshot() {
  const tiers = TIERS.map(tier => {
    const s = T.workSamples[tier];
    return {
      description: s.description || '',
      photos: s.photos.length,
      existing: s.existingPaths.slice(),
      text: (s.textArtifacts || []).map(a => `${a.type}|${a.label}|${a.text}`),
    };
  });
  return JSON.stringify({
    title: document.getElementById('titleSelect').value,
    rules: document.getElementById('engagementRulesInput').value,
    voice: document.getElementById('teachingVoiceInput').value,
    course: document.getElementById('courseInfoInput').value,
    welcome: document.getElementById('welcomeMessageInput').value,
    share: document.getElementById('shareCourseInfoCheckbox').checked,
    syllabusNew: T.syllabusNewFiles.length,
    syllabusExisting: T.syllabusExistingPaths.slice(),
    tiers,
  });
}

export function isWizardDirty() {
  return T.wizardSnapshot !== null && wizardSnapshot() !== T.wizardSnapshot;
}

export async function goHome(opts) {
  const force = !!(opts && opts.force);
  if (!force && T.saving) {
    showToast('Still saving — one moment.', '');
    return;
  }
  if (!force && isWizardDirty()) {
    const leave = await tConfirm({
      title: 'Leave without saving?',
      body: `Your changes to ${T.currentClass?.course || 'this class'} have not been saved. To keep them, continue to step 6 and click Save and Finish.`,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    if (!leave) return;
  }
  T.wizardSnapshot = null;
  showView('homeView');
  renderClassCards();
  window.scrollTo(0, 0);
}

// ─── WIZARD ────────────────────────────────────────────────────────────────────
export async function openWizard(course, subject, opts) {
  opts = opts || {};
  T.currentClass = { course, subject };
  T.currentStep = 1;
  T.syllabusNewFiles = [];
  T.syllabusExistingPaths = [];
  T.templateData = null;
  T.workSamples = emptyWorkSamples();
  T.existingSamplesByTier = {};
  T.existingArtifactsByTier = {};

  document.getElementById('wizardClassName').textContent = course;
  document.getElementById('wizardClassSubject').textContent = subject;

  // Load existing profile if any
  const profile = T.profiles[course];
  document.getElementById('titleSelect').value = profile?.title || '';
  document.getElementById('engagementRulesInput').value = profile?.engagement_rules || '';
  document.getElementById('teachingVoiceInput').value = profile?.teaching_voice || '';
  document.getElementById('courseInfoInput').value = profile?.course_info || '';
  document.getElementById('welcomeMessageInput').value = profile?.welcome_message || '';

  // Edit-flow seed for work samples. T.samplesByProfile is populated by
  // loadAllTeacherProfiles. Done BEFORE showStep so renderTierUI has data.
  const existingForProfile = profile?.id ? (T.samplesByProfile[profile.id] || {}) : {};
  const existingArtifactsForProfile = profile?.id ? (T.artifactsByProfile[profile.id] || {}) : {};
  TIERS.forEach(tier => {
    const row = existingForProfile[tier];
    if (row) {
      T.workSamples[tier].existingPaths = Array.isArray(row.photo_paths) ? [...row.photo_paths] : [];
      T.workSamples[tier].description = row.description || '';
      T.existingSamplesByTier[tier] = { photo_paths: [...(row.photo_paths || [])] };
    }
    // Q4 v2: seed written-example editors from the batch artifact cache. Snapshot
    // the original ids so the save handler can soft-delete any the teacher removes.
    const arts = (existingArtifactsForProfile[tier] || []).filter(a => a.artifact_type !== 'photo');
    T.workSamples[tier].textArtifacts = arts.map(a => ({
      id: a.id, type: a.artifact_type, text: a.text_content || '', label: a.label || '',
    }));
    T.existingArtifactsByTier[tier] = arts.map(a => ({ id: a.id }));
  });

  // Fire-and-forget signed-URL fetch for thumbnails. We don't await here
  // because Step 5 isn't visible yet; the URLs land before the user gets
  // there in the typical flow. If they jump to Step 5 immediately the
  // thumbs may flash in late — acceptable for an edit-flow.
  const allPaths = TIERS.flatMap(tier => T.workSamples[tier].existingPaths.map(path => ({ tier, path })));
  if (allPaths.length) {
    (async () => {
      try {
        const urls = await Promise.all(allPaths.map(p => fetchDownloadUrl('work-samples', p.path)));
        // Group results back by tier in path order — same shape as before.
        TIERS.forEach(tier => { T.workSamples[tier].existingThumbUrls = []; });
        urls.forEach((url, i) => {
          const meta = allPaths[i];
          if (!meta) return;
          T.workSamples[meta.tier].existingThumbUrls.push(url);
        });
        // Re-render if the work-samples step is currently visible.
        if (T.currentStep === WORK_SAMPLES_STEP) {
          TIERS.forEach(renderTierUI);
        }
      } catch (err) {
        console.warn('signed URL fetch error:', err);
      }
    })();
  }

  T.syllabusExistingPaths = Array.isArray(profile?.syllabus_paths) ? [...profile.syllabus_paths] : [];
  renderSyllabusList();

  document.getElementById('shareCourseInfoCheckbox').checked = profile?.share_course_info || false;

  // Check for templates
  await checkForTemplate();

  // Update word counts
  updateWordCount('engagementRulesInput', 'engagementRulesCount', 'step1NextBtn');
  updateWordCount('teachingVoiceInput', 'teachingVoiceCount', 'step2NextBtn');
  updateWordCount('courseInfoInput', 'courseInfoCount', 'step3NextBtn');
  updateCharCount('welcomeMessageInput', 'welcomeMessageCount', 'step4NextBtn');

  // Re-check step 1 button when title changes
  rebind(document.getElementById('titleSelect'), 'change', '_titleHandler',
    () => updateWordCount('engagementRulesInput', 'engagementRulesCount', 'step1NextBtn'));

  // Wire up input listeners (word-count-gated steps 1/2/3)
  ['engagementRulesInput', 'teachingVoiceInput', 'courseInfoInput'].forEach(id => {
    const el = document.getElementById(id);
    rebind(el, 'input', '_wordCountHandler', () => {
      const countId = id.replace('Input', 'Count');
      const btnId = id === 'engagementRulesInput' ? 'step1NextBtn' :
                    id === 'teachingVoiceInput' ? 'step2NextBtn' : 'step3NextBtn';
      updateWordCount(id, countId, btnId);
    });
  });

  // Wire up the welcome-message char-count gate (step 4).
  rebind(document.getElementById('welcomeMessageInput'), 'input', '_charCountHandler',
    () => updateCharCount('welcomeMessageInput', 'welcomeMessageCount', 'step4NextBtn'));

  // Wire tier description textareas
  TIERS.forEach(tier => {
    const el = document.getElementById('tierDesc-' + tier);
    rebind(el, 'input', '_descHandler', () => { T.workSamples[tier].description = el.value; validateStep4(); });
  });

  showStep(opts.jumpToStep || 1);
  showView('wizardView');
  T.wizardSnapshot = wizardSnapshot();
}

// Scroll the wizard back to its top on a step change. The portal's scroll
// container is <body class="t-portal"> (html/body are overflow:hidden and body
// is overflow:auto), so a bare window.scrollTo() is a no-op here; reset every
// candidate container.
export function scrollWizardToTop() {
  const wizard = document.getElementById('wizardView');
  const body = wizard?.querySelector('.wizard-body');
  if (body) body.scrollTop = 0;
  if (wizard) wizard.scrollTop = 0;
  if (document.body) document.body.scrollTop = 0;
  if (document.documentElement) document.documentElement.scrollTop = 0;
  window.scrollTo(0, 0);
}

export function showStep(n) {
  if (T.saving) {
    showToast('Still saving — one moment.', '');
    return;
  }
  T.currentStep = n;
  document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
  document.querySelector(`.wizard-step[data-step="${n}"]`).classList.add('active');
  scrollWizardToTop();

  document.getElementById('wizardStepLabel').textContent = `STEP ${n} OF ${TOTAL_STEPS}`;

  // Re-render Step 5 (work samples) when entering it — handles edit-flow
  // pre-population and ensures thumbs/counts/validation are fresh.
  if (n === WORK_SAMPLES_STEP) {
    TIERS.forEach(tier => {
      renderTierUI(tier);
      renderTierArtifacts(tier);
      const ta = document.getElementById('tierDesc-' + tier);
      ta.value = T.workSamples[tier].description || '';
    });
    validateStep4();
  }

  // Update summary on step 6
  if (n === REVIEW_STEP) {
    document.getElementById('summaryTitle').textContent = document.getElementById('titleSelect').value || '(Not selected)';
    document.getElementById('summaryEngagementRules').textContent = document.getElementById('engagementRulesInput').value || '(Not filled)';
    document.getElementById('summaryTeachingVoice').textContent = document.getElementById('teachingVoiceInput').value || '(Not filled)';
    document.getElementById('summaryCourseInfo').textContent = document.getElementById('courseInfoInput').value || '(Not filled)';
    document.getElementById('summaryWelcomeMessage').textContent = document.getElementById('welcomeMessageInput').value || '(Not filled)';
    updateWorkSamplesSummary();

    const syllabusText = syllabusSummaryText(T.syllabusExistingPaths, T.syllabusNewFiles);
    if (syllabusText) {
      document.getElementById('summarySyllabusCard').style.display = 'block';
      document.getElementById('summarySyllabusName').textContent = syllabusText;
    } else {
      document.getElementById('summarySyllabusCard').style.display = 'none';
    }
  }
}

export function nextStep() {
  if (T.currentStep === WORK_SAMPLES_STEP && !validateStep4()) return;
  const next = nextStepFrom(T.currentStep);
  if (next !== T.currentStep) showStep(next);
}

export function prevStep() {
  const prev = prevStepFrom(T.currentStep);
  if (prev !== T.currentStep) showStep(prev);
}

export function editField(step) {
  showStep(step);
}

// ─── WORD / CHAR COUNT ───────────────────────────────────────────────────────
export function updateWordCount(inputId, countId, btnId) {
  const text = document.getElementById(inputId).value;
  const countEl = document.getElementById(countId);
  const btn = document.getElementById(btnId);
  // Step 1 also requires title selection
  const status = wordCountStatus(text, {
    requireTitle: btnId === 'step1NextBtn',
    titleValue: document.getElementById('titleSelect').value,
  });
  countEl.textContent = status.label;
  btn.disabled = !status.enabled;
}

export function updateCharCount(inputId, countId, btnId, softLimit, minRequired) {
  const text = document.getElementById(inputId).value;
  const countEl = document.getElementById(countId);
  const btn = document.getElementById(btnId);
  if (!countEl || !btn) return;
  const status = charCountStatus(text, softLimit, minRequired);
  countEl.textContent = status.label;
  btn.disabled = !status.enabled;
}

export function updateWorkSamplesSummary() {
  const target = document.getElementById('summaryWorkSamples');
  if (!target) return;
  target.innerHTML = TIERS.map(tier => {
    const { description, countStr } = summarizeTier(T.workSamples[tier]);
    const safe = escHtml(description);
    return `<div style="margin-bottom:8px"><strong style="text-transform:capitalize">${tier}</strong>: ${countStr} — ${safe || '<em style="color:var(--text-3)">no description</em>'}</div>`;
  }).join('');
}

// ─── EXAMPLES TOGGLE ─────────────────────────────────────────────────────────
export function toggleExamples(btn) {
  btn.classList.toggle('open');
  const examples = btn.nextElementSibling;
  examples.classList.toggle('open');
  btn.querySelector('span:first-child').textContent = examples.classList.contains('open') ? 'Hide examples' : 'Show examples';
}

// ─── TEMPLATE BORROWING ─────────────────────────────────────────────────────
export async function checkForTemplate() {
  const course = T.currentClass.course;
  try {
    const data = await fetchTemplateForCourse(course);
    if (data && data.length > 0 && data[0].course_info) {
      T.templateData = data[0];
      document.getElementById('templateCourseName').textContent = course;
      document.getElementById('templateBanner').classList.add('show');
    } else {
      document.getElementById('templateBanner').classList.remove('show');
    }
  } catch (err) {
    console.warn('Template check failed:', err);
  }
}

export function useTemplate() {
  if (!T.templateData) return;

  document.getElementById('courseInfoInput').value = T.templateData.course_info;
  document.getElementById('courseInfoInput').dispatchEvent(new Event('input'));

  // Multi-syllabus model intentionally drops the template's syllabus_text
  // auto-import. The shared template only seeds course_info; teachers upload
  // their own PDFs into the file list, which becomes the canonical source of
  // syllabus_text via per-file extraction.

  document.getElementById('templateBanner').classList.remove('show');

  // Show notice about using shared content
  const notice = document.createElement('div');
  notice.className = 'template-notice';
  notice.textContent = 'Using shared course info. Upload your own PDFs below if you want Lumi to read your syllabus too.';
  const uploadArea = document.querySelector('.syllabus-upload-area');
  if (uploadArea && !document.querySelector('.template-notice')) {
    uploadArea.parentNode.insertBefore(notice, uploadArea);
  }

  showToast('Shared course info loaded.', 'success');
}

export function skipTemplate() {
  document.getElementById('templateBanner').classList.remove('show');
}
