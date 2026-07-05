import { doSend, handleFileSelect } from './js/chat.js';
import { newChat } from './js/conversation.js';
import { showWelcome } from './js/emptystate.js';
import { _calEvents, addHwTask, advancePlannerBlock, buildStudyPlan, buildStudyPlanWithCalendar, checkDailyHwPrompt, closeHwAddModal, closeHwBackdrop, closeHwPlanModal, closeHwPopup, closeTimelineModal, genHwId, getHwTasks, loadCalendarEvents, renderHwPopupTasks, setCalendarConnected, showHwAddModal, showHwPlanModal, showHwPopup, startPlannerStrip, todayStr, updateCalUi, wireCalListeners } from './js/homework.js';
import { initOnboarding } from './js/onboarding.js';
import { _projPendingFile, clearAllChats, clearCompletedProjects, clearProjFile, closeProjectCreateModal, closeProjectPlanModal, closeWorkTypeChooser, createProject, getProjects, injectProjectTasksToHomework, loadHwFromSupabase, renderProjectPlan, showProjectCreateModal, showWorkTypeChooser, wireProjDropzone } from './js/projects.js';
import { setSidebarUserSubtitle } from './js/prompts.js';
import { checkSemesterBanner, initScheduleSetup } from './js/schedule.js';
import { activeDropdownEl, closeOpenMenu, renderSearchDropdown, renderSidebar, showInlineConfirm } from './js/sidebar.js';
import { $, S, SB, currentUser, fileInput, msgInput, sbSearch, sendBtn, setCurrentProjId, setCurrentUser, themeToggle } from './js/state.js';
import { genId, getSchedule, loadConvsFromSupabase, loadProfileFromSupabase, loadTestModeSchedule, migrateOldData } from './js/storage.js';
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