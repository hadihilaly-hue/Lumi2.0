import { renderMsg, renderPinnedWelcome, scrollBottom, startLumi } from './chat.js';
import { MENLO_CURRICULUM, SUBJECTS, SUBJECT_IDS } from './data.js';
import { prepareSuggestedPrompts, renderEmptyState, showWelcome } from './emptystate.js';
import { getStudentName, teacherDisplayName, updateTestModeBanner } from './prompts.js';
import { clearSearch, renderSidebar } from './sidebar.js';
import { $, S, SB, _introShownFor, _saveIntroShown, currentUser, messagesEl, msgInput } from './state.js';
import { genId, getConvs, saveCurrentConv } from './storage.js';
import { getTeacherProfile, loadWorkSampleImages } from './teachers.js';


// ─── SUPABASE SYNC ────────────────────────────────────────────────────────────

// Helper: look up subjectId + subjectName for a given course name
export function lookupSubjectForCourse(courseName) {
  for (const [subjectName, courses] of Object.entries(MENLO_CURRICULUM)) {
    if (courses[courseName]) {
      return {
        subjectId:   SUBJECT_IDS[subjectName] || subjectName.toLowerCase().replace(/\s+/g, '-'),
        subjectName,
      };
    }
  }
  return { subjectId: null, subjectName: courseName || null };
}

// ─── LOAD A CONVERSATION ──────────────────────────────────────────────────────
export async function loadConv(id) {
  const conv = getConvs()[id];
  if (!conv) return;
  S.currentId     = id;
  S.messages      = conv.messages || [];
  S.exchangeCount = conv.exchangeCount || 0;
  S.tutorCtx      = conv.tutorCtx || null;
  S.ready         = true;
  S.busy          = false;

  messagesEl.innerHTML = '';
  S.values.clear(); S.goals.clear(); S.interests.clear();

  S.messages.forEach(m => renderMsg(m.role, m.content, false));
  (conv.values    || []).forEach(v => S.values.add(v));
  (conv.goals     || []).forEach(g => S.goals.add(g));
  (conv.interests || []).forEach(i => S.interests.add(i));

  if (S.tutorCtx) {
    SB.mode = 'tutor';
    SB.activeTeacher = { subjectId: S.tutorCtx.subjectId, course: S.tutorCtx.course, teacher: S.tutorCtx.teacher };
    SB.expandedSubject = S.tutorCtx.subjectId;
  } else {
    SB.mode = 'general';
    SB.activeTeacher = null;
  }

  scrollBottom();
  renderSidebar();

  // AUDIT_FRONTEND H1: re-hydrate the teacher persona. Convs loaded from RDS
  // (loadConvsFromSupabase) reconstruct tutorCtx from the teacher/course columns
  // only — teacherProfile/notesInjection/workSamples are absent — so continuing
  // the chat would silently fall back to generic AI. Fetch them now.
  await hydrateTutorProfile();
}

// AUDIT_FRONTEND H1: fetch + attach the teacher persona (profile, notes
// injection, work samples) onto the active S.tutorCtx. Mirrors the fetch half
// of finishOpenTutor without the greeting/banner UI (loadConv already rendered
// the existing thread). No-op when tutorCtx already carries a live profile
// (e.g. convs restored from localStorage within the same session).
async function hydrateTutorProfile() {
  const ctx = S.tutorCtx;
  if (!ctx || !ctx.teacher || !ctx.course) return;
  if (ctx.teacherProfile) return; // already hydrated (localStorage path)

  let profile = null;
  try {
    const profilePromise = getTeacherProfile(ctx.teacher, ctx.course);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 5000));
    profile = await Promise.race([profilePromise, timeoutPromise]);
  } catch (e) {
    console.warn('[loadConv] profile hydrate error:', e);
    profile = null;
  }
  // Bail if the user switched to another class while we were awaiting — never
  // write A's persona onto B's now-current chat (same guard class as H2).
  if (S.tutorCtx !== ctx) return;

  ctx.notesInjection = null;
  if (profile && !profile.__notReady && !profile.__error && profile.id && currentUser && !S.isTestMode) {
    ctx.notesInjection = { teacher_profile_id: profile.id };
  }

  ctx.workSamples = null;
  if (profile && !profile.__notReady && !profile.__error && profile.workSamples) {
    try {
      const wsPromise = loadWorkSampleImages(profile);
      const wsTimeout = new Promise(resolve => setTimeout(() => resolve(null), 8000));
      ctx.workSamples = await Promise.race([wsPromise, wsTimeout]);
    } catch (e) {
      console.warn('[loadConv] work-sample hydrate failed:', e);
      ctx.workSamples = null;
    }
    if (S.tutorCtx !== ctx) return;
  }

  ctx.teacherProfile = (profile && !profile.__error && !profile.__notReady) ? profile : null;
  saveCurrentConv();
}

// ─── NEW CHAT ─────────────────────────────────────────────────────────────────
export function newChat() {
  saveCurrentConv();
  S.currentId     = genId();
  S.messages      = [];
  S.exchangeCount = 0;
  S.tutorCtx      = null;
  S.ready         = false;
  S.values.clear(); S.goals.clear(); S.interests.clear();
  SB.mode = 'all'; SB.activeTeacher = null;
  messagesEl.innerHTML = '';
  showWelcome();
  renderSidebar();
  startLumi();
}

// ─── OPEN TUTOR SESSION ───────────────────────────────────────────────────────
export async function openTutor(subjectId, course, teacher) {
  console.log('[openTutor] start:', { subjectId, course, teacher });
  clearSearch();
  saveCurrentConv();
  const subjectName = SUBJECTS.find(s => s.id === subjectId)?.name || subjectId;
  S.currentId     = genId();
  S.messages      = [];
  S.exchangeCount = 0;
  S.tutorCtx      = { subjectId, subjectName, course, teacher };
  // TM-4: refresh the persistent test-mode banner with the new class.
  updateTestModeBanner(course);
  S.ready         = true;
  S.values.clear(); S.goals.clear(); S.interests.clear();
  SB.mode = 'tutor'; SB.activeTeacher = { subjectId, course, teacher };
  messagesEl.innerHTML = '';

  // Show intro slide once per session per class
  const introKey = course + '::' + teacher;
  if (!_introShownFor.has(introKey)) {
    showIntroSlide(course, () => {
      _introShownFor.add(introKey);
      _saveIntroShown();
      finishOpenTutor(subjectId, course, teacher, subjectName);
    });
    return;
  }

  await finishOpenTutor(subjectId, course, teacher, subjectName);
}

function showIntroSlide(course, onGo) {
  const slide = $('introSlide');
  const name = getStudentName();
  $('introGreeting').textContent = name !== 'there'
    ? `Hey ${name}. Your teacher is in.`
    : 'Hey. Your teacher is in.';
  $('introPill').textContent = course;
  slide.style.display = '';
  $('chatPanel').style.display = 'none';

  const goBtn = $('introGoBtn');
  const handler = () => {
    goBtn.removeEventListener('click', handler);
    slide.style.display = 'none';
    $('chatPanel').style.display = '';
    onGo();
  };
  goBtn.addEventListener('click', handler);
}

async function finishOpenTutor(subjectId, course, teacher, subjectName) {
  // AUDIT_FRONTEND H2: capture the class this open is for. openTutor set
  // S.tutorCtx to a fresh object synchronously right before calling us; if the
  // user opens another class while we await below, S.tutorCtx is reassigned and
  // every guard here bails so we never write this class's profile/banner/greeting
  // onto the now-current chat.
  const ctx = S.tutorCtx;

  // Fetch teacher profile — with 5s hard timeout so it never hangs
  let profile = null;
  try {
    const profilePromise = getTeacherProfile(teacher, course);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 5000));
    profile = await Promise.race([profilePromise, timeoutPromise]);
    console.log('[openTutor] profile:', profile ? 'found' : 'none');
  } catch (e) {
    console.warn('[openTutor] profile fetch error:', e);
    profile = null;
  }
  if (S.tutorCtx !== ctx) return; // class switched during the profile fetch

  // Per-student teacher notes are injected SERVER-SIDE (the chat Lambda
  // replaces the <<LUMI_TEACHER_NOTES>> marker) — notes never reach the
  // browser. The client only records WHICH class to inject for.
  // TM-2: in test mode the "student" is the teacher themselves — no notes,
  // no injection request.
  S.tutorCtx.notesInjection = null;
  if (profile && !profile.__notReady && profile.id && currentUser && !S.isTestMode) {
    S.tutorCtx.notesInjection = { teacher_profile_id: profile.id };
  }

  // Q4: load graded work-sample images. Single-source-of-truth gate —
  // partial states resolve to null; both buildTutorSystem and
  // buildApiMessages key off this object. Wrapped against an 8s timeout
  // (heavier than notes' 5s because of multiple image fetches).
  S.tutorCtx.workSamples = null;
  if (profile && !profile.__notReady && profile.workSamples) {
    const wsStart = Date.now();
    try {
      const wsPromise = loadWorkSampleImages(profile);
      const wsTimeout = new Promise(resolve => setTimeout(() => resolve(null), 8000));
      S.tutorCtx.workSamples = await Promise.race([wsPromise, wsTimeout]);
      const loaded = await Promise.race([wsPromise, wsTimeout]);
      if (S.tutorCtx !== ctx) return; // class switched during work-sample load
      S.tutorCtx.workSamples = loaded;
      const ms = Date.now() - wsStart;
      console.log(`[work_samples] loaded in ${ms}ms; mode=${S.tutorCtx.workSamples ? 'with' : 'without'} samples`);
    } catch (e) {
      console.warn('[work_samples] load failed:', e);
      if (S.tutorCtx !== ctx) return;
      S.tutorCtx.workSamples = null;
    }
  }

  let greeting;
  const firstName = teacher.split(' ')[0];
  const dName = teacherDisplayName(teacher, profile);

  if (profile?.__error) {
    // R4 fail-visible: the Lambda fetch failed. Show a small banner in the
    // chat area instead of the misleading "teacher hasn't set up" message.
    console.error('[openTutor] teacher-profile fetch failed:', teacher, course, profile.message);
    const errBanner = document.createElement('div');
    errBanner.className = 'lambda-error-banner';
    errBanner.style.cssText = 'margin:12px;padding:10px 14px;border:1px solid #c0392b;background:#fdecea;color:#902;border-radius:8px;font-size:13px;line-height:1.45';
    errBanner.textContent = `⚠️ Couldn't load ${course}: ${profile.message}. Check the console for details.`;
    messagesEl.appendChild(errBanner);
    S.tutorCtx.teacherProfile = null;
    msgInput.disabled = true;
    msgInput.placeholder = 'Profile fetch failed — see console';
    $('sendBtn').disabled = true;
  } else if (profile?.__notReady) {
    greeting = `${firstName} hasn't finished setting up their Lumi profile yet — their interview is still in progress. Check back soon, or try General Chat in the meantime.`;
    S.tutorCtx.teacherProfile = null;
    msgInput.disabled = true;
    msgInput.placeholder = 'Chat unavailable \u2014 use General Chat until this teacher completes setup';
    $('sendBtn').disabled = true;
    console.warn('[openTutor] profile not ready for:', teacher, course);
  } else if (profile) {
    S.tutorCtx.teacherProfile = profile;
    // Pinned welcome card replaces the auto-intro chat greeting at the top of
    // every new thread. Phase 5b adds the welcome_message column on
    // teacher_profiles; until then renderPinnedWelcome falls back to a
    // class-agnostic placeholder body.
    renderPinnedWelcome(teacher, profile, course);
    msgInput.disabled = false;
    msgInput.placeholder = `Say something to ${dName}\u2026`;
    $('sendBtn').disabled = false;
    await prepareSuggestedPrompts();
    setTimeout(() => renderEmptyState(profile, course), 50);
    if (S.tutorCtx !== ctx) return; // class switched while preparing prompts
    setTimeout(() => { if (S.tutorCtx === ctx) renderEmptyState(profile, course); }, 50);
  } else {
    greeting = `\u26a0\ufe0f ${firstName} hasn't set up their Lumi profile for ${course} yet. Once they complete their setup interview, I'll be able to help you exactly the way ${firstName} teaches. In the meantime, you can use General Chat.`;
    S.tutorCtx.teacherProfile = null;
    msgInput.disabled = true;
    msgInput.placeholder = 'Chat unavailable \u2014 use General Chat until this teacher completes setup';
    $('sendBtn').disabled = true;
    console.error('[openTutor] NO PROFILE for:', teacher, course, '\u2014 student sees warning');
  }
  if (greeting) {
    S.messages.push({ role: 'assistant', content: greeting });
    renderMsg('lumi', greeting, true);
  }
  // Add "Open General Chat" button for pending/missing profiles
  if (!profile || profile.__notReady || profile.__error) {
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'text-align:center;margin:12px 0';
    btnWrap.innerHTML = '<button class="pending-gen-chat-btn" onclick="openGeneralChat()">Open General Chat instead \u2192</button>';
    messagesEl.appendChild(btnWrap);
  }
  saveCurrentConv();
  renderSidebar();
  scrollBottom();
  msgInput.focus();
  console.log('[openTutor] done');
}

// ─── OPEN GENERAL CHAT ───────────────────────────────────────────────────────
export function openGeneralChat() {
  clearSearch();
  saveCurrentConv();
  msgInput.disabled = false;
  msgInput.placeholder = 'Say something\u2026';
  $('sendBtn').disabled = false;
  const name = getStudentName();
  S.currentId     = genId();
  S.messages      = [];
  S.exchangeCount = 0;
  S.tutorCtx      = null;
  S.ready         = true;
  S.values.clear(); S.goals.clear(); S.interests.clear();
  SB.mode = 'general'; SB.activeTeacher = null;
  messagesEl.innerHTML = '';
  const greeting = name !== 'there' ? `Hey ${name}! What's on your mind?` : `Hey! What's on your mind?`;
  S.messages.push({ role: 'assistant', content: greeting });
  renderMsg('lumi', greeting, true);
  // S4: Add suggested prompt cards
  const promptCards = document.createElement('div');
  promptCards.className = 'general-prompt-cards';
  promptCards.id = 'generalPromptCards';
  const prompts = [
    { icon: '\ud83d\udcda', text: 'Help me study for a test' },
    { icon: '\ud83d\udca1', text: 'Explain a concept I\'m stuck on' },
    { icon: '\u270f\ufe0f', text: 'Help me outline an essay' },
    { icon: '\u2705', text: 'Review my homework approach' }
  ];
  prompts.forEach(p => {
    const card = document.createElement('div');
    card.className = 'general-prompt-card';
    card.innerHTML = `<div class="general-prompt-card-icon">${p.icon}</div><div class="general-prompt-card-text">${p.text}</div>`;
    card.addEventListener('click', () => {
      msgInput.value = p.text;
      msgInput.focus();
      promptCards.remove();
    });
    promptCards.appendChild(card);
  });
  messagesEl.appendChild(promptCards);
  saveCurrentConv();
  renderSidebar();
  scrollBottom();
  msgInput.focus();
}
