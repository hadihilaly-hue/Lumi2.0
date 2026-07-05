import { doSend, fmtBytes, handleFileSelect, showAttachPreview } from './js/chat.js';
import { lookupSubjectForCourse, newChat, openTutor } from './js/conversation.js';
import { showWelcome } from './js/emptystate.js';
import { _calEvents, addHwTask, advancePlannerBlock, buildStudyPlan, buildStudyPlanWithCalendar, checkDailyHwPrompt, closeHwAddModal, closeHwBackdrop, closeHwPlanModal, closeHwPopup, closeTimelineModal, genHwId, getHwTasks, loadCalendarEvents, openHwBackdrop, renderHwPopupTasks, saveHwTasks, setCalendarConnected, showHwAddModal, showHwPlanModal, showHwPopup, startPlannerStrip, syncHwToSupabase, todayStr, updateCalUi, wireCalListeners } from './js/homework.js';
import { initOnboarding } from './js/onboarding.js';
import { setSidebarUserSubtitle } from './js/prompts.js';
import { checkSemesterBanner, initScheduleSetup } from './js/schedule.js';
import { activeDropdownEl, closeOpenMenu, renderSearchDropdown, renderSidebar, showInlineConfirm } from './js/sidebar.js';
import { $, S, SB, _currentProjId, currentUser, fileInput, messagesEl, msgInput, sbSearch, sendBtn, setCurrentProjId, setCurrentUser, setPendingAttachment, themeToggle } from './js/state.js';
import { deleteConvFromSupabase, genId, getConvs, getSchedule, loadConvsFromSupabase, loadProfileFromSupabase, loadTestModeSchedule, migrateOldData, saveConvs } from './js/storage.js';
import { preloadProfileStatuses, rdsFetch } from './js/teachers.js';
import { autoGrow, closeSettings, closeSidebar, openSettings, openSidebar, showToast, updateSendBtn } from './js/ui.js';
import { initVoice, wireVoiceListeners } from './js/voice.js';


(async () => {
  // Simple auth check — getSession() reads from localStorage, no network needed
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  if (!(await isAllowedEmail(session.user.email))) {
    await sb.auth.signOut();
    window.location.href = 'index.html';
    return;
  }

  setCurrentUser(session.user);

  // TM-2: teacher-test-mode boot detection. ?mode=test on the URL flips
  // the flag for this tab; sessionStorage stickiness keeps it across
  // refreshes inside the same tab without leaking to other tabs/sessions.
  // Cleared by the exit toggle in TM-4 when the teacher returns to
  // teacher.html.
  const _testModeUrlParam = new URLSearchParams(window.location.search).get('mode');
  if (_testModeUrlParam === 'test') {
    sessionStorage.setItem('lumi_test_mode', 'true');
  }
  S.isTestMode = sessionStorage.getItem('lumi_test_mode') === 'true';

  // TM-4: when in test mode, reveal the persistent banner at the top
  // of the chat panel and the exit-test-mode button under the user
  // card in the sidebar. Both are display:none by default in the
  // markup so student users never see them.
  if (S.isTestMode) {
    const banner = document.getElementById('testModeBanner');
    if (banner) banner.style.display = 'flex';
    const exitBtn = document.getElementById('sbExitTestBtn');
    if (exitBtn) {
      exitBtn.style.display = 'flex';
      exitBtn.addEventListener('click', () => {
        sessionStorage.removeItem('lumi_test_mode');
        window.location.href = 'teacher.html';
      });
    }
  }

  // Hide loading screen and show the app
  document.getElementById('authLoading').style.display = 'none';

  // Populate user info (settings drawer + sidebar chip)
  const meta     = currentUser.user_metadata || {};
  const fullName = meta.full_name || meta.name || 'Student';
  const email    = currentUser.email || '';
  const initials = fullName[0].toUpperCase();

  document.getElementById('userName').textContent  = fullName;
  document.getElementById('userEmail').textContent = email;
  const avatarEl = document.getElementById('userAvatar');
  if (meta.avatar_url) {
    const img = document.createElement('img'); img.src = meta.avatar_url; img.alt = '';
    avatarEl.appendChild(img);
  } else { avatarEl.textContent = initials; }

  document.getElementById('sbUserName').textContent  = fullName;
  setSidebarUserSubtitle();
  const sbAvatarEl = document.getElementById('sbUserAvatar');
  if (meta.avatar_url) {
    const img2 = document.createElement('img'); img2.src = meta.avatar_url; img2.alt = '';
    sbAvatarEl.appendChild(img2);
  } else { sbAvatarEl.textContent = initials; }

  await loadProfileFromSupabase();

  // One-time privacy scrub: earlier builds persisted tutorCtx.teacherNotes
  // (confidential teacher observations) into localStorage via saveCurrentConv.
  // Notes are now injected server-side and never reach the client — purge any
  // copies that older sessions left behind.
  try {
    const rawConvs = localStorage.getItem('lumi_convs');
    if (rawConvs && rawConvs.includes('teacherNotes')) {
      const convs = JSON.parse(rawConvs);
      let scrubbed = 0;
      Object.values(convs).forEach(c => {
        if (c?.tutorCtx && 'teacherNotes' in c.tutorCtx) { delete c.tutorCtx.teacherNotes; scrubbed++; }
      });
      if (scrubbed) {
        localStorage.setItem('lumi_convs', JSON.stringify(convs));
        console.log(`[teacher_notes] scrubbed persisted notes from ${scrubbed} saved conversation(s)`);
      }
    }
  } catch (e) { console.warn('[teacher_notes] scrub failed:', e); }

  // TM-2: in test mode, always load convs fresh from Supabase (filtered
  // to is_teacher_test=true). In student mode, only on fresh device
  // where lumi_convs hasn't been cached.
  if (S.isTestMode || !localStorage.getItem('lumi_convs')) await loadConvsFromSupabase();
  // TM-2: synthesize the teacher's own classes into S.testSchedule.
  if (S.isTestMode) await loadTestModeSchedule();

  // Show Teacher Mode link only for allowed teacher emails
  const ALLOWED_TEACHER_EMAILS = ['hadi.hilaly@menloschool.org'];
  if (ALLOWED_TEACHER_EMAILS.includes(email.toLowerCase())) {
    const link = document.getElementById('teacherModeLink');
    if (link) link.style.display = 'block';
  }

  init();
})();

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // Theme — sync checkbox to match the class that the <head> script may have applied
  const isDark = document.documentElement.classList.contains('dark-mode');
  themeToggle.checked = isDark;
  console.log('[theme] init — saved:', localStorage.getItem('lumi-theme'), 'isDark:', isDark);

  // Onboarding + schedule setup
  // Gate on onboarding_complete so a Supabase-restored name doesn't skip the interview
  const hasOnboarded = localStorage.getItem('lumi_onboarding_complete') === 'true';
  const hasName      = !!localStorage.getItem('lumi_name');
  const hasSchedule  = getSchedule().length > 0;

  wireListeners();

  // Show conversational onboarding for brand-new users (no name at all),
  // then hand off to the class/grade picker box
  if (!hasName) {
    $('onboarding').style.display = '';
    initOnboarding(() => {
      // After the chat, always show the class+grade picker
      initScheduleSetup(() => startApp());
    });
    return;
  }

  // Has name from the new onboarding flow — already completed
  if (hasOnboarded) {
    $('onboarding').style.display = 'none';
    startApp();
    return;
  }

  // Returning old user: has name but never did the new interview — go straight to app
  $('onboarding').style.display = 'none';

  if (!hasSchedule) {
    initScheduleSetup(() => startApp());
    return;
  }

  startApp();
}

function wireListeners() {
  $('newChatBtn').addEventListener('click', () => {
    if (S.messages.length > 0) {
      if (confirm('Start a new chat? Your current conversation will be saved.')) newChat();
    } else newChat();
  });

  document.addEventListener('click', e => {
    if (activeDropdownEl && !activeDropdownEl.contains(e.target)) closeOpenMenu();
  });

  sbSearch.addEventListener('input', () => renderSearchDropdown(sbSearch.value.trim()));

  $('hamburger').addEventListener('click', openSidebar);
  $('sbOverlay').addEventListener('click', closeSidebar);

  $('gearBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsOverlay').addEventListener('click', closeSettings);

  themeToggle.addEventListener('change', () => {
    const dark = themeToggle.checked;
    document.documentElement.classList.toggle('dark-mode', dark);
    localStorage.setItem('lumi-theme', dark ? 'dark' : 'light');
    console.log('[theme] toggled — dark:', dark, 'classes:', document.documentElement.className);
  });

  $('updateScheduleBtn').addEventListener('click', () => {
    closeSettings();
    initScheduleSetup(() => { renderSidebar(); }, getSchedule());
  });

  $('signOutBtn').addEventListener('click', async () => {
    if (confirm('Sign out of Lumi?')) {
      await doSignOut();
    }
  });

  $('clearMemBtn').addEventListener('click', async () => {
    if (confirm('Are you sure? This will erase all conversations and memory.')) {
      // Delete server-side data (both tables, for this user)
      if (currentUser) {
        try {
          const profileReset = {
            name: null, grade: null,
            values_profile: { values: [], goals: [], interests: [] },
          };
          await Promise.all([
            rdsFetch('conversations?all=true', { method: 'DELETE' }),
            rdsFetch('profiles', { method: 'POST', body: profileReset }),
          ]);
        } catch (e) {
          console.warn('Server memory clear failed:', e);
          showToast('Could not clear server memory — see console');
        }
      }
      localStorage.removeItem('lumi_convs');
      localStorage.removeItem('lumi_current');
      localStorage.removeItem('lumi_name');
      localStorage.removeItem('lumi_grade');
      SB.mode = 'all'; SB.activeTeacher = null; SB.expandedSubject = null; SB.expandedCourse = null;
      closeSettings();
      location.reload();
    }
  });

  $('clearAllChatsBtn').addEventListener('click', e => {
    showInlineConfirm(e.target, 'Delete ALL chats? This can\'t be undone.', () => {
      clearAllChats();
      closeSettings();
    });
  });

  $('clearDoneProjectsBtn').addEventListener('click', e => {
    showInlineConfirm(e.target, 'Remove all completed projects?', () => {
      clearCompletedProjects();
      closeSettings();
    });
  });

  $('attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFileSelect(fileInput.files[0]));

  // Drag & drop
  const chatPanel   = $('chatPanel');
  const dropOverlay = $('dropOverlay');
  let dragCounter = 0;

  chatPanel.addEventListener('dragenter', e => {
    e.preventDefault(); dragCounter++;
    dropOverlay.classList.add('active');
  });
  chatPanel.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
  });
  chatPanel.addEventListener('dragover', e => { e.preventDefault(); });
  chatPanel.addEventListener('drop', e => {
    e.preventDefault(); dragCounter = 0;
    dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ok = file.type.startsWith('image/') || file.type === 'application/pdf' || file.type === 'text/plain' || file.name.endsWith('.txt');
    if (!ok) { showToast('Only images, PDFs, and text files are supported.'); return; }
    handleFileSelect(file);
  });

  msgInput.addEventListener('input', () => { autoGrow(msgInput); updateSendBtn(); });
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) doSend(); }
  });
  sendBtn.addEventListener('click', doSend);
}

function startApp() {
  migrateOldData();
  S.currentId = genId();
  wireHwListeners();
  wireCalListeners();
  updateCalUi();

  // If we just returned from Google OAuth, mark calendar as connected
  sb.auth.getSession().then(({ data: { session } }) => {
    if (session?.provider_token && session?.user?.app_metadata?.provider === 'google') {
      setCalendarConnected(true);
      updateCalUi();
    }
  });

  initVoice();
  wireVoiceListeners();

  preloadProfileStatuses(); // fetch teacher profile statuses for sidebar badges (non-blocking)
  loadHwFromSupabase().then(async () => {
    injectProjectTasksToHomework();
    await loadCalendarEvents();
    renderSidebar();
    checkDailyHwPrompt();
  });
  renderSidebar();
  showWelcome();
  checkSemesterBanner();

  // Wire timeline modal close buttons
  const tlClose   = $('timelineClose');
  const tlBackdrop = $('timelineBackdrop');
  if (tlClose)    tlClose.addEventListener('click', closeTimelineModal);
  if (tlBackdrop) tlBackdrop.addEventListener('click', closeTimelineModal);
}

// ══════════════════════════════════════════════════════════
// ── PROJECT / MULTI-DAY PLAN SYSTEM ──────────────────────
// ══════════════════════════════════════════════════════════

export function getProjects() {
  try { return JSON.parse(localStorage.getItem('lumi_projects') || '[]'); } catch { return []; }
}
function saveProjects(projects) { localStorage.setItem('lumi_projects', JSON.stringify(projects)); }
function genProjId() { return 'proj_' + Math.random().toString(36).slice(2, 10); }

export function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
}

function fmtDateDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[d.getDay()];
}

export function dateDiffDays(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Generate multi-day project plan ──────────────────────
// Distributes work across available days with a buffer day before due date
function generateProjectPlan(title, className, dueDate, requirements, unavailableDays = []) {
  const today = todayStr();
  const totalDays = dateDiffDays(today, dueDate);

  if (totalDays <= 1) {
    // Due today or tomorrow — treat as single-night task
    return [{
      date: today,
      label: title,
      estimatedMinutes: 60,
      isComplete: false,
      isBuffer: false
    }];
  }

  // Determine project type from title/requirements
  const t = (title + ' ' + (requirements || '')).toLowerCase();
  const isEssay = /essay|paper|writing|composition|literary analysis/.test(t);
  const isResearch = /research|report|study/.test(t);
  const isPresentation = /presentation|slides|slideshow|keynote/.test(t);
  const isLab = /lab report|lab write|experiment/.test(t);

  // Build phase templates based on type
  let phases;
  if (isEssay) {
    phases = [
      { label: 'Brainstorm + develop thesis', fraction: 0.15, minMinutes: 20 },
      { label: 'Research + gather evidence', fraction: 0.20, minMinutes: 25 },
      { label: 'Create outline', fraction: 0.10, minMinutes: 15 },
      { label: 'Draft body paragraphs', fraction: 0.25, minMinutes: 40 },
      { label: 'Write intro + conclusion', fraction: 0.15, minMinutes: 25 },
      { label: 'Revise, edit + proofread', fraction: 0.15, minMinutes: 20 },
    ];
  } else if (isResearch) {
    phases = [
      { label: 'Choose topic + initial research', fraction: 0.15, minMinutes: 25 },
      { label: 'Deep research + take notes', fraction: 0.25, minMinutes: 40 },
      { label: 'Create outline + organize sources', fraction: 0.15, minMinutes: 20 },
      { label: 'Write first draft', fraction: 0.25, minMinutes: 45 },
      { label: 'Revise + add citations', fraction: 0.12, minMinutes: 25 },
      { label: 'Final proofread + formatting', fraction: 0.08, minMinutes: 15 },
    ];
  } else if (isPresentation) {
    phases = [
      { label: 'Research + gather content', fraction: 0.20, minMinutes: 25 },
      { label: 'Plan slide structure + outline', fraction: 0.15, minMinutes: 20 },
      { label: 'Design slides + add content', fraction: 0.30, minMinutes: 40 },
      { label: 'Add visuals + polish design', fraction: 0.15, minMinutes: 25 },
      { label: 'Practice run-through', fraction: 0.20, minMinutes: 20 },
    ];
  } else if (isLab) {
    phases = [
      { label: 'Review data + organize results', fraction: 0.20, minMinutes: 20 },
      { label: 'Write methods + results sections', fraction: 0.30, minMinutes: 35 },
      { label: 'Write analysis + discussion', fraction: 0.30, minMinutes: 35 },
      { label: 'Write intro + conclusion, proofread', fraction: 0.20, minMinutes: 20 },
    ];
  } else {
    // Generic project
    phases = [
      { label: 'Plan + gather materials', fraction: 0.15, minMinutes: 20 },
      { label: 'Begin core work', fraction: 0.30, minMinutes: 30 },
      { label: 'Continue building', fraction: 0.30, minMinutes: 30 },
      { label: 'Refine + finalize', fraction: 0.15, minMinutes: 20 },
      { label: 'Review + polish', fraction: 0.10, minMinutes: 15 },
    ];
  }

  // Build list of available dates (exclude unavailable, keep buffer day)
  const unavailSet = new Set(unavailableDays);
  const bufferDate = addDays(dueDate, -1); // day before due = buffer/review
  const availableDates = [];
  for (let i = 0; i < totalDays - 1; i++) { // -1 to reserve buffer
    const d = addDays(today, i);
    if (!unavailSet.has(d)) availableDates.push(d);
  }

  // If buffer date is unavailable, use last available date as buffer
  const bufferAvailable = !unavailSet.has(bufferDate);

  // Distribute phases across available dates
  // If more phases than dates, merge some; if more dates than phases, spread out
  const plan = [];
  if (availableDates.length === 0) {
    // No available days — cram everything into today
    plan.push({
      date: today,
      label: phases.map(p => p.label).join(' + '),
      estimatedMinutes: phases.reduce((s, p) => s + p.minMinutes, 0),
      isComplete: false,
      isBuffer: false
    });
  } else if (availableDates.length >= phases.length) {
    // More dates than phases — assign one phase per date, starting from the first
    const step = availableDates.length / phases.length;
    phases.forEach((phase, i) => {
      const dateIdx = Math.min(Math.floor(i * step), availableDates.length - 1);
      plan.push({
        date: availableDates[dateIdx],
        label: phase.label,
        estimatedMinutes: phase.minMinutes,
        isComplete: false,
        isBuffer: false
      });
    });
  } else {
    // Fewer dates than phases — merge phases into available dates
    const phasesPerDay = Math.ceil(phases.length / availableDates.length);
    let phaseIdx = 0;
    availableDates.forEach((date, dayIdx) => {
      const endIdx = Math.min(phaseIdx + phasesPerDay, phases.length);
      const dayPhases = phases.slice(phaseIdx, endIdx);
      if (dayPhases.length === 0) return;
      plan.push({
        date,
        label: dayPhases.map(p => p.label).join(' + '),
        estimatedMinutes: dayPhases.reduce((s, p) => s + p.minMinutes, 0),
        isComplete: false,
        isBuffer: false
      });
      phaseIdx = endIdx;
    });
  }

  // Add buffer day
  const bufferDay = bufferAvailable ? bufferDate : (availableDates.length > 0 ? addDays(availableDates[availableDates.length - 1], 1) : dueDate);
  plan.push({
    date: bufferDay,
    label: 'Final review + polish (buffer day)',
    estimatedMinutes: 20,
    isComplete: false,
    isBuffer: true
  });

  return plan;
}

// ── Show/hide project modals ─────────────────────────────

export function showWorkTypeChooser() {
  openHwBackdrop();
  const modal = $('hwTypeChooser');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));
}

function closeWorkTypeChooser() {
  const modal = $('hwTypeChooser');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

let _projPendingFile = null; // { file, base64, mediaType, isImage, isText }

function showProjectCreateModal(prefill = {}) {
  const modal = $('projCreateModal');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));

  // Populate class selector
  const sel = $('projClassSelect');
  sel.innerHTML = '';
  const schedule = getSchedule();
  schedule.forEach(({ course }) => {
    const opt = document.createElement('option');
    opt.value = course;
    opt.textContent = course;
    sel.appendChild(opt);
  });
  if (prefill.className) sel.value = prefill.className;

  // Defaults
  $('projTitleInput').value = prefill.title || '';
  $('projDueInput').value = prefill.dueDate || '';
  $('projReqInput').value = prefill.requirements || '';

  // Set min date to tomorrow
  const tomorrow = addDays(todayStr(), 1);
  $('projDueInput').min = tomorrow;

  // Reset file upload
  clearProjFile();
}

// ── Project file upload (drag & drop + click) ────────────

function clearProjFile() {
  _projPendingFile = null;
  $('projFileInput').value = '';
  $('projDropzoneEmpty').style.display = '';
  $('projDropzonePreview').style.display = 'none';
  $('projDropzone').classList.remove('drag-over');
}

function handleProjFile(file) {
  if (!file) return;
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'];
  if (!allowed.includes(file.type)) {
    showToast('Please upload a PDF, image, or text file');
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result.split(',')[1];
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    const isText = file.type === 'text/plain';
    _projPendingFile = { file, base64, mediaType: file.type, isImage, isText, isPdf };

    // Show preview
    $('projDropzoneEmpty').style.display = 'none';
    $('projDropzonePreview').style.display = 'flex';
    $('projFileName').textContent = file.name;
    $('projFileSize').textContent = fmtBytes(file.size);
    $('projFileIcon').textContent = isPdf ? '📕' : isImage ? '🖼️' : '📄';
  };
  reader.readAsDataURL(file);
}

function wireProjDropzone() {
  const zone = $('projDropzone');
  const fileInput = $('projFileInput');
  if (!zone || !fileInput) return;

  // Prevent browser from opening file on drop — at document AND zone level
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    document.addEventListener(evt, e => e.preventDefault());
    zone.addEventListener(evt, e => e.preventDefault());
  });

  // Highlight on drag over
  zone.addEventListener('dragenter', () => zone.classList.add('drag-over'));
  zone.addEventListener('dragover',  () => zone.classList.add('drag-over'));
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));

  // Handle drop
  zone.addEventListener('drop', e => {
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleProjFile(file);
  });

  // Handle click to browse
  zone.addEventListener('click', e => {
    if (e.target.closest('#projFileRemove')) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleProjFile(fileInput.files[0]);
  });

  // Remove button
  $('projFileRemove').addEventListener('click', e => {
    e.stopPropagation();
    clearProjFile();
  });
}

function closeProjectCreateModal() {
  const modal = $('projCreateModal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

export function showProjectPlanModal(project) {
  setCurrentProjId(project.id);
  const modal = $('projPlanModal');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));
  renderProjectPlan(project);
}

function closeProjectPlanModal() {
  const modal = $('projPlanModal');
  modal.classList.remove('open');
  setCurrentProjId(null);
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

// ── Render the multi-day plan ────────────────────────────

function renderProjectPlan(project) {
  const title = $('projPlanTitle');
  const body = $('projPlanContent');
  const loading = $('projPlanLoading');
  const footer = $('projPlanFooter');

  loading.style.display = 'none';
  footer.style.display = 'flex';
  body.innerHTML = '';

  title.textContent = project.title;

  // Header
  const hd = document.createElement('div');
  hd.className = 'proj-plan-header';
  const hdName = document.createElement('div');
  hdName.className = 'proj-plan-name';
  hdName.textContent = `${project.className} — due ${fmtDateShort(project.dueDate)}`;
  const hdMeta = document.createElement('div');
  hdMeta.className = 'proj-plan-meta';
  const totalMin = project.plan.reduce((s, d) => s + d.estimatedMinutes, 0);
  const totalH = Math.floor(totalMin / 60);
  const totalM = totalMin % 60;
  const timeStr = totalH > 0 ? `${totalH}h ${totalM > 0 ? totalM + 'm' : ''}`.trim() : `${totalM}m`;
  hdMeta.textContent = `${project.plan.length} sessions · ~${timeStr} total`;
  if (project.requirements) {
    hdMeta.textContent += ` · ${project.requirements}`;
  }
  hd.appendChild(hdName);
  hd.appendChild(hdMeta);
  body.appendChild(hd);

  // Check for carry-over (incomplete past days)
  const today = todayStr();
  const incompletePast = project.plan.filter(d => d.date < today && !d.isComplete);
  if (incompletePast.length > 0) {
    const banner = document.createElement('div');
    banner.className = 'proj-carryover-banner';
    banner.textContent = `⚠️ You have ${incompletePast.length} missed session${incompletePast.length > 1 ? 's' : ''}. Remaining work has been redistributed to upcoming days.`;
    body.appendChild(banner);
  }

  // Adjust bar (remove a day)
  const adjustBar = document.createElement('div');
  adjustBar.className = 'proj-adjust-bar';
  const adjustLabel = document.createElement('label');
  adjustLabel.textContent = "Can't work on a day?";
  const adjustSelect = document.createElement('select');
  adjustSelect.id = 'projAdjustSelect';
  // Only show future, incomplete dates
  const futureDates = project.plan.filter(d => d.date >= today && !d.isComplete && !d.isBuffer);
  if (futureDates.length > 1) {
    futureDates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.date;
      opt.textContent = `${fmtDateDay(d.date)} (${fmtDateShort(d.date)})`;
      adjustSelect.appendChild(opt);
    });
    const adjustBtn = document.createElement('button');
    adjustBtn.className = 'proj-adjust-btn';
    adjustBtn.textContent = 'Skip this day';
    adjustBtn.addEventListener('click', () => {
      const skipDate = adjustSelect.value;
      if (skipDate) adjustProjectPlan(project.id, skipDate);
    });
    adjustBar.appendChild(adjustLabel);
    adjustBar.appendChild(adjustSelect);
    adjustBar.appendChild(adjustBtn);
    body.appendChild(adjustBar);
  }

  // Day cards
  project.plan.forEach(day => {
    const card = document.createElement('div');
    card.className = 'proj-day-card';
    if (day.date === today) card.classList.add('today');
    if (day.isComplete) card.classList.add('completed');
    if (day.isBuffer) card.classList.add('buffer');

    const head = document.createElement('div');
    head.className = 'proj-day-head';
    const dateEl = document.createElement('div');
    dateEl.className = 'proj-day-date';
    dateEl.textContent = `${fmtDateDay(day.date)} — ${fmtDateShort(day.date)}`;

    const badge = document.createElement('span');
    badge.className = 'proj-day-badge';
    if (day.isComplete) {
      badge.classList.add('done-badge');
      badge.textContent = 'Done';
    } else if (day.date === today) {
      badge.classList.add('today-badge');
      badge.textContent = 'Today';
    } else if (day.date < today) {
      badge.classList.add('overdue-badge');
      badge.textContent = 'Missed';
    } else if (day.isBuffer) {
      badge.classList.add('buffer-badge');
      badge.textContent = 'Buffer';
    }

    head.appendChild(dateEl);
    if (badge.textContent) head.appendChild(badge);
    card.appendChild(head);

    const taskEl = document.createElement('div');
    taskEl.className = 'proj-day-task';
    taskEl.textContent = day.label;
    card.appendChild(taskEl);

    const timeEl = document.createElement('div');
    timeEl.className = 'proj-day-time';
    timeEl.textContent = `~${day.estimatedMinutes} min`;
    card.appendChild(timeEl);

    // Checkbox for today or past
    if (!day.isComplete && day.date <= today) {
      const checkWrap = document.createElement('div');
      checkWrap.className = 'proj-day-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'projcheck_' + day.date;
      cb.addEventListener('change', () => {
        toggleProjectDayComplete(project.id, day.date);
      });
      const lbl = document.createElement('label');
      lbl.htmlFor = cb.id;
      lbl.textContent = 'Mark as done';
      checkWrap.appendChild(cb);
      checkWrap.appendChild(lbl);
      card.appendChild(checkWrap);
    }

    body.appendChild(card);
  });

  // Due date line
  const dueLine = document.createElement('div');
  dueLine.className = 'proj-day-card';
  dueLine.style.cssText = 'background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.25);text-align:center';
  dueLine.innerHTML = `<div class="proj-day-date" style="color:var(--accent)">📅 ${fmtDateShort(project.dueDate)} — Submit to ${project.teacherName.split(' ')[0]}</div>`;
  body.appendChild(dueLine);

  // Delete project button at bottom
  const delBtn = document.createElement('button');
  delBtn.className = 'proj-delete-btn';
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Delete this project`;
  delBtn.addEventListener('click', () => deleteProject(project.id, delBtn));
  body.appendChild(delBtn);
}

// ── Toggle a day complete ────────────────────────────────

function toggleProjectDayComplete(projId, dateStr) {
  const projects = getProjects();
  const proj = projects.find(p => p.id === projId);
  if (!proj) return;

  const day = proj.plan.find(d => d.date === dateStr);
  if (day) day.isComplete = !day.isComplete;

  // Progress carry-over: redistribute incomplete past work to future days
  applyCarryOver(proj);

  saveProjects(projects);
  renderProjectPlan(proj);
  injectProjectTasksToHomework();
  syncHwToSupabase();
}

// ── Progress carry-over ──────────────────────────────────
// Redistribute incomplete past-day work into future days

function applyCarryOver(project) {
  const today = todayStr();
  const incompletePast = project.plan.filter(d => d.date < today && !d.isComplete && !d.isBuffer);
  if (incompletePast.length === 0) return;

  // Gather leftover work labels
  const leftoverLabels = incompletePast.map(d => d.label);
  const leftoverMinutes = incompletePast.reduce((s, d) => s + d.estimatedMinutes, 0);

  // Find future incomplete non-buffer days
  const futureDays = project.plan.filter(d => d.date >= today && !d.isComplete && !d.isBuffer);
  if (futureDays.length === 0) return;

  // Add extra time to the first future day and note the carry-over
  const firstFuture = futureDays[0];
  const extraPerDay = Math.ceil(leftoverMinutes / futureDays.length);
  futureDays.forEach(d => {
    d.estimatedMinutes += extraPerDay;
  });
  // Prepend carry-over note to first day
  if (!firstFuture.label.includes('(+ catch up')) {
    firstFuture.label = firstFuture.label + ' (+ catch up on missed work)';
  }
}

// ── Adjust plan: skip a day ──────────────────────────────

function adjustProjectPlan(projId, skipDate) {
  const projects = getProjects();
  const proj = projects.find(p => p.id === projId);
  if (!proj) return;

  const skipDay = proj.plan.find(d => d.date === skipDate && !d.isComplete);
  if (!skipDay) return;

  // Remove the skipped day and redistribute its work
  const skippedLabel = skipDay.label;
  const skippedMinutes = skipDay.estimatedMinutes;
  proj.plan = proj.plan.filter(d => d.date !== skipDate);

  // Find remaining future incomplete non-buffer days
  const today = todayStr();
  const futureDays = proj.plan.filter(d => d.date >= today && !d.isComplete && !d.isBuffer);

  if (futureDays.length > 0) {
    const extraPerDay = Math.ceil(skippedMinutes / futureDays.length);
    futureDays.forEach(d => {
      d.estimatedMinutes += extraPerDay;
    });
    // Note on first available day
    futureDays[0].label += ` (+ ${skippedLabel.split(' ').slice(0, 3).join(' ')}…)`;
  }

  // Track unavailable days
  if (!proj.unavailableDays) proj.unavailableDays = [];
  proj.unavailableDays.push(skipDate);

  saveProjects(projects);
  renderProjectPlan(proj);
  injectProjectTasksToHomework();
  showToast(`Skipped ${fmtDateDay(skipDate)} — work redistributed`);
}

// ── Create a new project ─────────────────────────────────

function createProject(title, className, teacherName, dueDate, requirements, fileData) {
  const plan = generateProjectPlan(title, className, dueDate, requirements);

  const project = {
    id: genProjId(),
    title,
    className,
    teacherName,
    dueDate,
    requirements: requirements || '',
    rubricFile: fileData || null,
    createdAt: new Date().toISOString(),
    plan,
    unavailableDays: [],
    isComplete: false
  };

  const projects = getProjects();
  projects.push(project);
  saveProjects(projects);

  // Auto-inject today's project tasks into homework
  injectProjectTasksToHomework();

  return project;
}

// ── Convert tonight's homework to project ────────────────

function convertHwToProject(taskId) {
  const tasks = getHwTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  // Pre-fill project modal with task info
  closeHwAddModal();
  showProjectCreateModal({
    className: task.className,
    title: task.title,
    dueDate: '',
    requirements: ''
  });

  // Remove from tonight's homework
  const filtered = tasks.filter(t => t.id !== taskId);
  saveHwTasks(filtered);
  renderHwPopupTasks();
}

// ── Inject today's project tasks into homework ───────────
// Adds today's project tasks as hw items so they show in the nightly planner

function injectProjectTasksToHomework() {
  const projects = getProjects();
  const today = todayStr();
  const tasks = getHwTasks();

  projects.forEach(proj => {
    if (proj.isComplete) return;
    proj.plan.forEach(day => {
      if (day.date !== today || day.isComplete) return;
      // Check if already in homework (by project-linked ID)
      const linkedId = 'pj_' + proj.id + '_' + day.date;
      if (tasks.find(t => t.id === linkedId)) return;
      // Add to homework
      tasks.push({
        id: linkedId,
        title: `${proj.title}: ${day.label}`,
        className: proj.className,
        teacherName: proj.teacherName,
        dueDate: today,
        estimatedMinutes: day.estimatedMinutes,
        isComplete: false,
        isProjectTask: true,
        projectId: proj.id,
        createdAt: new Date().toISOString()
      });
    });
  });

  saveHwTasks(tasks);
}

// ── Open tutor for project's class ───────────────────────

function handleStartWorking() {
  console.log('START WORKING CLICKED');

  const projId = _currentProjId;
  const proj = getProjects().find(p => p.id === projId);
  if (!proj) { console.log('No project found'); return; }
  console.log('Project:', proj.title, proj.className);

  // Close all modals immediately
  document.querySelectorAll('.hw-modal, .hw-popup, #hwPopup, #hwBackdrop').forEach(el => {
    el.style.display = 'none';
    el.classList.remove('open');
  });
  console.log('Modals closed');

  // Find matching schedule entry for this class
  const schedule = getSchedule();
  const entry = schedule.find(s => s.course === proj.className);
  console.log('Schedule entry:', entry ? entry.course : 'NOT FOUND');

  // Build context message
  const today = todayStr();
  const todayTask = proj.plan.find(d => d.date === today && !d.isComplete);
  const taskLabel = todayTask ? todayTask.label : proj.plan[0]?.label || 'getting started';
  const contextMsg = `I'm working on my ${proj.title} for ${proj.className}, due ${proj.dueDate}. Today I need to: ${taskLabel}. Can you help me get started?`;

  // If we have a matching teacher, open that tutor chat with a 3s safety timeout
  if (entry) {
    const { subjectId } = lookupSubjectForCourse(entry.course);
    const safeOpen = Promise.race([
      openTutor(subjectId, entry.course, entry.teacher),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    safeOpen.then(() => {
      setTimeout(() => {
        // Attach rubric file if one was uploaded with the project
        if (proj.rubricFile) {
          const att = proj.rubricFile;
          setPendingAttachment({
            file: { name: att.name, size: 0, type: att.mediaType },
            base64: att.base64,
            mediaType: att.mediaType,
            isImage: !!att.isImage,
            isText: !!att.isText
          });
          showAttachPreview({ name: att.name, size: 0 }, att.base64, att.mediaType, !!att.isImage);
          console.log('Rubric attached:', att.name);
        }
        msgInput.value = contextMsg;
        msgInput.focus();
        autoGrow(msgInput);
        updateSendBtn();
        console.log('Input filled — ready to send');
      }, 300);
    });
    return;
  }

  // No matching class — just fill the input in the current chat
  setTimeout(() => {
    msgInput.value = contextMsg;
    msgInput.focus();
    autoGrow(msgInput);
    updateSendBtn();
    console.log('Input filled (no class match)');
  }, 100);
}

export function deleteProject(projId, anchorEl) {
  const doDelete = () => {
    // Remove from projects
    const projects = getProjects().filter(p => p.id !== projId);
    saveProjects(projects);

    // Remove associated hw tasks injected from this project
    const tasks = getHwTasks().filter(t => t.projectId !== projId);
    saveHwTasks(tasks);

    // Close plan modal if viewing this project
    if (_currentProjId === projId) {
      closeProjectPlanModal();
      closeHwBackdrop();
    }

    syncHwToSupabase();
    renderSidebar();
    showToast('Project deleted');
  };

  if (anchorEl) {
    showInlineConfirm(anchorEl, "Delete this project and its plan? This can't be undone.", doDelete);
  } else {
    doDelete();
  }
}

function clearAllChats() {
  const convs = getConvs();
  // Delete each from Supabase
  Object.keys(convs).forEach(id => deleteConvFromSupabase(id));
  // Clear local
  saveConvs({});
  S.currentId = genId(); S.messages = []; S.exchangeCount = 0; S.tutorCtx = null;
  S.ready = false; S.values.clear(); S.goals.clear(); S.interests.clear();
  SB.mode = 'all'; SB.activeTeacher = null;
  messagesEl.innerHTML = '';
  showWelcome();
  renderSidebar();
  showToast('All chats cleared');
}

function clearCompletedProjects() {
  const projects = getProjects();
  const completed = projects.filter(p => p.isComplete);
  if (!completed.length) { showToast('No completed projects to clear.'); return; }
  // Remove associated hw tasks
  const completedIds = new Set(completed.map(p => p.id));
  const tasks = getHwTasks().filter(t => !completedIds.has(t.projectId));
  saveHwTasks(tasks);
  // Keep only incomplete projects
  saveProjects(projects.filter(p => !p.isComplete));
  syncHwToSupabase();
  renderSidebar();
  showToast(`${completed.length} completed project${completed.length > 1 ? 's' : ''} cleared`);
}

// hw_tasks column does not exist in profiles table — localStorage only
async function loadHwFromSupabase() {
  if (!currentUser) return;
  try {
    const data = await rdsFetch('homework-tasks');
    if (!data || !data.length) return;
    const tasks = data.map(row => ({
      id: row.id,
      title: row.title,
      className: row.class_name || '',
      teacherName: row.teacher_name || '',
      // RDS returns date columns as full ISO timestamps; Supabase returned
      // YYYY-MM-DD. slice(0,10) normalizes both to the app's date-only shape.
      dueDate: (row.due_date || '').slice(0, 10),
      estimatedMinutes: row.estimated_minutes || null,
      isComplete: !!row.is_complete,
      createdAt: row.created_at,
    }));
    saveHwTasks(tasks);
  } catch (e) { console.warn('[loadHw] failed:', e); }
}

// ── Wire all homework event listeners ─────────────────────
function wireHwListeners() {
  $('hwPopupClose').addEventListener('click', closeHwPopup);
  $('hwBackdrop').addEventListener('click', () => {
    closeHwPopup();
    closeWorkTypeChooser();
    closeProjectCreateModal();
    closeProjectPlanModal();
  });

  // ── "+ Add homework" now opens type chooser ────────────
  $('hwPopupAddBtn').addEventListener('click', () => {
    showWorkTypeChooser();
  });

  // ── Type chooser: Project vs Tonight's Homework ────────
  $('hwTypeBack').addEventListener('click', () => {
    closeWorkTypeChooser();
  });
  $('hwTypeProject').addEventListener('click', () => {
    closeWorkTypeChooser();
    showProjectCreateModal();
  });
  $('hwTypeHomework').addEventListener('click', () => {
    closeWorkTypeChooser();
    showHwAddModal();
  });

  $('hwPopupSkipBtn').addEventListener('click', closeHwPopup);

  $('hwPopupPlanBtn').addEventListener('click', () => {
    const tasks = getHwTasks().filter(t => !t.isComplete);
    if (!tasks.length) { showToast('Add some homework first!'); return; }
    showHwPlanModal();
  });

  // ── Tonight's Homework modal ───────────────────────────
  $('hwAddBack').addEventListener('click', () => {
    closeHwAddModal();
    if ($('hwPopup').classList.contains('open')) { /* already open */ }
    else { showHwPopup(); }
  });

  $('hwAddSaveBtn').addEventListener('click', () => {
    const title = $('hwTitleInput').value.trim();
    if (!title) { showToast('Please enter an assignment name.'); return; }
    const course = $('hwClassSelect').value;
    const schedule = getSchedule();
    const entry = schedule.find(s => s.course === course) || {};
    const mins = parseInt($('hwTimeInput').value, 10) || null;
    addHwTask({
      id:               genHwId(),
      title,
      className:        course,
      teacherName:      entry.teacher || '',
      dueDate:          $('hwDueInput').value || todayStr(),
      estimatedMinutes: mins,
      isComplete:       false,
      createdAt:        new Date().toISOString()
    });
    closeHwAddModal();
    renderHwPopupTasks();
    if (!$('hwPopup').classList.contains('open')) showHwPopup();
    showToast('Added!', 'ok');
  });

  // ── "Convert to project" from tonight's homework ───────
  $('hwConvertToProject').addEventListener('click', () => {
    const title = $('hwTitleInput').value.trim();
    const course = $('hwClassSelect').value;
    closeHwAddModal();
    showProjectCreateModal({
      className: course,
      title: title,
      dueDate: '',
      requirements: ''
    });
  });

  // ── Project creation modal ─────────────────────────────
  $('projCreateBack').addEventListener('click', () => {
    closeProjectCreateModal();
  });

  $('projCreateBtn').addEventListener('click', () => {
    const title = $('projTitleInput').value.trim();
    if (!title) { showToast('Please name your project.'); return; }
    const dueDate = $('projDueInput').value;
    if (!dueDate) { showToast('Please set a due date.'); return; }
    if (dueDate <= todayStr()) { showToast('Due date must be in the future.'); return; }

    const course = $('projClassSelect').value;
    const schedule = getSchedule();
    const entry = schedule.find(s => s.course === course) || {};
    const requirements = $('projReqInput').value.trim();

    // Show loading state
    closeProjectCreateModal();
    const planModal = $('projPlanModal');
    planModal.style.display = 'flex';
    planModal.style.flexDirection = 'column';
    requestAnimationFrame(() => planModal.classList.add('open'));
    $('projPlanLoading').style.display = 'flex';
    $('projPlanContent').innerHTML = '';
    $('projPlanFooter').style.display = 'none';
    $('projPlanTitle').textContent = 'Building your plan…';

    // Capture file before clearing
    const fileData = _projPendingFile ? {
      name: _projPendingFile.file.name,
      base64: _projPendingFile.base64,
      mediaType: _projPendingFile.mediaType,
      isImage: _projPendingFile.isImage,
      isText: _projPendingFile.isText,
      isPdf: _projPendingFile.isPdf
    } : null;
    clearProjFile();

    // Small delay for the loading animation to feel real
    setTimeout(() => {
      const project = createProject(title, course, entry.teacher || '', dueDate, requirements, fileData);
      setCurrentProjId(project.id);
      console.log('Set current project:', project.id);
      renderProjectPlan(project);
    }, 600);
  });

  // ── Project plan modal ─────────────────────────────────
  $('projPlanBack').addEventListener('click', () => {
    closeProjectPlanModal();
  });

  // projStartBtn now uses inline onclick="handleStartWorking()"

  $('projSaveBtn').addEventListener('click', () => {
    closeProjectPlanModal();
    closeHwPopup();
    closeHwBackdrop();
    showToast('Project plan saved!', 'ok');
    renderSidebar();
  });

  // ── Study plan panel (slide-in drawer) ──────────────────
  $('hwPlanBack').addEventListener('click', () => {
    closeHwPlanModal();
  });
  $('hwPlanClose').addEventListener('click', () => {
    closeHwPlanModal();
  });
  $('hwPlanBackdrop').addEventListener('click', () => {
    closeHwPlanModal();
  });

  $('hwPlanDoneBtn').addEventListener('click', () => {
    // Collapse planner to floating strip with timer
    const tasks = getHwTasks().filter(t => !t.isComplete);
    const plan = _calEvents.length > 0 ? buildStudyPlanWithCalendar(tasks) : buildStudyPlan(tasks);
    closeHwPlanModal();
    closeHwPopup();
    startPlannerStrip(plan.blocks);
  });

  // Floating strip: click info area to re-expand planner
  $('plannerStripInfo').addEventListener('click', () => {
    showHwPlanModal();
  });
  // Floating strip: "Done" button advances to next block
  $('plannerStripDone').addEventListener('click', (e) => {
    e.stopPropagation();
    advancePlannerBlock();
  });

  // ── Project file dropzone ──────────────────────────────
  wireProjDropzone();
}

// ── Debug: test startProjectTutor from console ───────────
window.testProjectButton = async function() {
  console.log('Testing startProjectTutor...');
  const projects = getProjects();
  console.log('Projects found:', projects.length, projects.map(p => ({ id: p.id, title: p.title, class: p.className })));
  if (projects.length > 0) {
    const proj = projects[0];
    console.log('Testing with project:', proj.id, proj.title);
    await startProjectTutor(proj.id);
    console.log('Done — no freeze!');
  } else {
    console.log('No projects found to test with');
  }
};
console.log('Run window.testProjectButton() in console to test the Start Working button');