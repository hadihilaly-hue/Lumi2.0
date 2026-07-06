import { lookupSubjectForCourse, openTutor } from './conversation.js';
import { dateDiffDays, deleteProject, fmtDateShort, getProjects, showProjectPlanModal, showWorkTypeChooser } from './projects.js';
import { teacherDisplayName } from './prompts.js';
import { addLongPress, renderSidebar } from './sidebar.js';
import { $, S, currentUser } from './state.js';
import { getSchedule } from './storage.js';
import { resolveTeacherEmail, _profileCache, fetchTeacherProfileLambda, rdsFetch } from './teachers.js';
import { closeSidebar, showToast } from './ui.js';


// ─── HOMEWORK PLANNER ────────────────────────────────────────────────────────

// ── Calendar state (session-only, never persisted) ─────────
export let _calEvents  = [];    // [{title, start, end, id}]
let _calFetched = false; // fetched once per session
let _calToken   = null;  // Google provider_token from Supabase session

const HOMEWORK_PRIORITY = {
  TIER_1_CRITICAL: {
    types: ['essay', 'research paper', 'project', 'presentation', 'lab report', 'final', 'portfolio'],
    label: 'Major Work',
    color: 'red',
    reason: 'High stakes, time consuming, needs multiple sessions'
  },
  TIER_2_IMPORTANT: {
    types: ['test', 'exam', 'quiz study', 'midterm'],
    label: 'Assessment Prep',
    color: 'orange',
    reason: 'Needs focused preparation, spaced over multiple days'
  },
  TIER_3_STANDARD: {
    types: ['homework', 'problem set', 'worksheet', 'reading', 'assignment'],
    label: 'Regular Work',
    color: 'yellow',
    reason: 'Complete in one session'
  },
  TIER_4_LIGHT: {
    types: ['review', 'notes', 'vocab', 'flashcards'],
    label: 'Light Work',
    color: 'green',
    reason: 'Can be done in short bursts'
  }
};

const TIER_DOT = {
  TIER_1_CRITICAL: '🔴',
  TIER_2_IMPORTANT: '🟠',
  TIER_3_STANDARD: '🟡',
  TIER_4_LIGHT: '🟢'
};

const TIER_ORDER = { TIER_1_CRITICAL: 0, TIER_2_IMPORTANT: 1, TIER_3_STANDARD: 2, TIER_4_LIGHT: 3 };

function classifyTask(title) {
  const t = (title || '').toLowerCase();
  for (const [tierKey, tier] of Object.entries(HOMEWORK_PRIORITY)) {
    if (tier.types.some(kw => t.includes(kw))) return tierKey;
  }
  return 'TIER_3_STANDARD';
}

export function getStudyStyle() {
  try {
    return JSON.parse(localStorage.getItem('lumi_study_style') || 'null')
      || { work_minutes: 25, break_minutes: 5, label: 'Short Bursts' };
  } catch { return { work_minutes: 25, break_minutes: 5, label: 'Short Bursts' }; }
}
export function saveStudyStyle(style) { localStorage.setItem('lumi_study_style', JSON.stringify(style)); }
export async function syncStudyStyleToSupabase(style) {
  if (!currentUser) return;
  // TM-2: same as syncProfileToSupabase — don't write student-shaped
  // fields into the teacher's auth user record.
  if (S.isTestMode) return;
  try {
    await rdsFetch('profiles', { method: 'POST', body: { study_style: style } });
  } catch (e) {
    // Hardened (§2): this was app.js's only fully-silent catch; now logged + toasted.
    console.warn('Study style sync error:', e);
    showToast('Could not sync your study style — see console');
  }
}

function getPlanStartMinutes() {
  const now = new Date();
  const total = now.getHours() * 60 + now.getMinutes();
  return Math.ceil(total / 5) * 5; // round up to nearest 5 min
}

function fmtPlanAbsTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// ── Google Calendar helpers ────────────────────────────────
function isCalendarConnected() {
  return !!localStorage.getItem('lumi_cal_connected');
}
export function setCalendarConnected(val) {
  if (val) localStorage.setItem('lumi_cal_connected', '1');
  else     localStorage.removeItem('lumi_cal_connected');
}

async function fetchCalendarToken() {
  if (!currentUser) return null;
  try {
    const { data: { session } } = await sb.auth.getSession();
    const token = session?.provider_token || null;
    if (token) _calToken = token;
    return token;
  } catch { return null; }
}

async function getTodaysCalEvents(accessToken) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(startOfDay)}&timeMax=${encodeURIComponent(endOfDay)}&singleEvents=true&orderBy=startTime`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error('cal_fetch_' + resp.status);
  const data = await resp.json();
  return (data.items || []).map(ev => ({
    id:    ev.id,
    title: ev.summary || 'Event',
    start: new Date(ev.start?.dateTime || ev.start?.date),
    end:   new Date(ev.end?.dateTime   || ev.end?.date),
  }));
}

export async function loadCalendarEvents() {
  if (_calFetched) return;
  if (!isCalendarConnected()) return;
  _calFetched = true;
  try {
    const token = await fetchCalendarToken();
    if (!token) { setCalendarConnected(false); updateCalUi(); return; }
    _calToken  = token;
    _calEvents = await getTodaysCalEvents(token);
  } catch (e) {
    console.warn('Calendar fetch failed, falling back to homework-only plan:', e.message);
    _calEvents = [];
    if (e.message.includes('cal_fetch_401')) { setCalendarConnected(false); updateCalUi(); showToast('Calendar session expired — please reconnect.'); }
  }
}

// Return free blocks between now and 10:30 PM, excluding calendar events
// All times in absolute minutes since midnight
function getFreeTimeBlocks() {
  const now = new Date();
  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const startMin = Math.ceil(nowMin / 5) * 5;
  const endMin   = BEDTIME_MINUTES;

  if (!_calEvents.length) {
    return startMin < endMin ? [{ startMin, endMin, durationMin: endMin - startMin }] : [];
  }

  const busy = _calEvents
    .map(ev => ({
      start: ev.start.getHours() * 60 + ev.start.getMinutes(),
      end:   ev.end.getHours()   * 60 + ev.end.getMinutes(),
    }))
    .filter(b => b.end > startMin && b.start < endMin)
    .sort((a, b) => a.start - b.start);

  const free = [];
  let cursor = startMin;
  busy.forEach(b => {
    if (b.start > cursor && b.start - cursor >= 20) {
      free.push({ startMin: cursor, endMin: b.start, durationMin: b.start - cursor });
    }
    cursor = Math.max(cursor, b.end);
  });
  if (cursor < endMin && endMin - cursor >= 20) {
    free.push({ startMin: cursor, endMin, durationMin: endMin - cursor });
  }
  return free;
}

function getTotalFreeMinutes() {
  return getFreeTimeBlocks().reduce((s, b) => s + b.durationMin, 0);
}

export function updateCalUi() {
  const connected = isCalendarConnected();
  const cs = $('calConnectedState');
  const ds = $('calDisconnectedState');
  if (cs) cs.style.display = connected ? '' : 'none';
  if (ds) ds.style.display = connected ? 'none' : '';
}

export async function connectGoogleCalendar() {
  // TODO(GIS): Cognito never exposes the Google provider access token to the
  // browser, so the old Supabase provider_token flow can't be ported. Rebuild
  // with Google Identity Services initTokenClient (a direct API grant) when
  // calendar connect is prioritized — see MIGRATION_PLAN.md Workstream I.
  showToast('Calendar connect is temporarily unavailable.');
}

export function wireCalListeners() {
  const connectBtn    = $('calConnectBtn');
  const disconnectBtn = $('calDisconnectBtn');
  if (connectBtn)    connectBtn.addEventListener('click', connectGoogleCalendar);
  if (disconnectBtn) disconnectBtn.addEventListener('click', () => {
    setCalendarConnected(false);
    _calEvents  = [];
    _calFetched = false;
    _calToken   = null;
    updateCalUi();
    showToast('Calendar disconnected.', 'ok');
  });
}

// ── Timeline modal ─────────────────────────────────────────
function showTimelineModal() {
  const bd = $('timelineBackdrop');
  const m  = $('timelineModal');
  bd.style.display = 'block';
  requestAnimationFrame(() => bd.classList.add('open'));
  m.style.display = 'flex';
  m.style.flexDirection = 'column';
  requestAnimationFrame(() => m.classList.add('open'));
  renderTimeline();
}

export function closeTimelineModal() {
  const bd = $('timelineBackdrop');
  const m  = $('timelineModal');
  bd.classList.remove('open');
  m.classList.remove('open');
  setTimeout(() => { bd.style.display = 'none'; m.style.display = 'none'; }, 200);
}

function renderTimeline() {
  const body  = $('timelineBody');
  const meta  = $('timelineMeta');
  const title = $('timelineTitle');
  body.innerHTML = '';

  const now    = new Date();
  const today  = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  title.textContent = `Tonight — ${today}`;

  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const startMin = Math.ceil(nowMin / 5) * 5;
  const totalFree = getTotalFreeMinutes();
  const fH = Math.floor(totalFree / 60), fM = totalFree % 60;
  const freeStr = fH > 0 ? `${fH}h ${fM > 0 ? fM + 'm' : ''}`.trim() : `${fM}m`;
  const calTonight = _calEvents.filter(ev => ev.end.getHours() * 60 + ev.end.getMinutes() > startMin);
  meta.textContent = `${fmtPlanAbsTime(startMin)} → 10:30 PM · ${freeStr} free${calTonight.length ? ` · ${calTonight.length} calendar event${calTonight.length !== 1 ? 's' : ''} tonight` : ''}`;

  const tasks = getHwTasks().filter(t => !t.isComplete);
  const plan  = buildStudyPlanWithCalendar(tasks);

  // Now-line
  const nowLine = document.createElement('div');
  nowLine.className = 'tl-now-line';
  const nowLabel = document.createElement('span');
  nowLabel.className = 'tl-now-label';
  nowLabel.textContent = 'NOW';
  nowLine.appendChild(nowLabel);
  body.appendChild(nowLine);

  plan.timeline.forEach(block => {
    if (block.type === 'bedtime') {
      const el = document.createElement('div');
      el.className = 'tl-block bedtime';
      const timeEl = document.createElement('div'); timeEl.className = 'tl-time'; timeEl.textContent = '10:30';
      const bar    = document.createElement('div'); bar.className = 'tl-bar';
      const ct     = document.createElement('div'); ct.className = 'tl-content';
      const t      = document.createElement('div'); t.className = 'tl-title'; t.textContent = '🌙 Bedtime — lights out!';
      const m2     = document.createElement('div'); m2.className = 'tl-meta'; m2.textContent = '8 hours of sleep is non-negotiable.';
      ct.appendChild(t); ct.appendChild(m2);
      el.appendChild(timeEl); el.appendChild(bar); el.appendChild(ct);
      body.appendChild(el);
      return;
    }

    const el = document.createElement('div');
    el.className = 'tl-block ' + block.type;

    const taskDone = block.taskId && getHwTasks().find(t2 => t2.id === block.taskId && t2.isComplete);
    if (taskDone) el.classList.add('done');

    const timeEl = document.createElement('div');
    timeEl.className = 'tl-time';
    timeEl.textContent = fmtPlanAbsTime(block.startMin);

    const bar = document.createElement('div');
    bar.className = 'tl-bar';

    const ct    = document.createElement('div'); ct.className = 'tl-content';
    const titleEl = document.createElement('div'); titleEl.className = 'tl-title';
    const metaEl  = document.createElement('div'); metaEl.className = 'tl-meta';

    if (block.type === 'hw') {
      const dot = TIER_DOT[block.tier] || '⚪';
      const chunk = block.chunkNum ? ` pt ${block.chunkNum}/${block.totalChunks}` : '';
      titleEl.textContent = `${dot} ${block.title}${chunk}`;
      metaEl.textContent  = `${block.duration} min${block.className ? ' · ' + block.className.split(' ').slice(0,2).join(' ') : ''}`;
      el.addEventListener('click', () => {
        const entry = getSchedule().find(s => s.course === block.className);
        if (entry) { openTutor(lookupSubjectForCourse(entry.course).subjectId, entry.course, entry.teacher); closeTimelineModal(); }
      });
    } else if (block.type === 'break') {
      titleEl.textContent = '🔋 Break';
      metaEl.textContent  = block.duration + ' min';
    } else if (block.type === 'cal') {
      titleEl.textContent = '📅 ' + block.title;
      metaEl.textContent  = block.duration + ' min · Calendar';
    } else if (block.type === 'gap') {
      titleEl.textContent = 'Free gap';
      metaEl.textContent  = block.duration + ' min — too short to schedule';
    }

    ct.appendChild(titleEl);
    if (metaEl.textContent) ct.appendChild(metaEl);
    el.appendChild(timeEl); el.appendChild(bar); el.appendChild(ct);
    body.appendChild(el);
  });
}

// Build a calendar-aware study plan, scheduling tasks only in free time gaps
export function buildStudyPlanWithCalendar(tasks) {
  const style    = getStudyStyle();
  const WORK     = style.work_minutes;
  const BREAK    = style.break_minutes;
  const today    = todayStr();
  const startMin = getPlanStartMinutes();
  const warnings = [];

  if (startMin >= BEDTIME_MINUTES) {
    return {
      blocks: [], timeline: [{ type: 'bedtime', startMin: BEDTIME_MINUTES, duration: 0 }],
      warnings: [{ type: 'bedtime', text: "It's 10:30 — time to wrap up and get to sleep." }],
      totalMinutes: 0, startMinutes: startMin, isPastBedtime: true,
    };
  }

  const freeBlocks = getFreeTimeBlocks();
  const totalFree  = freeBlocks.reduce((s, b) => s + b.durationMin, 0);

  if (_calEvents.length > 0 && totalFree < 120) {
    const fH = Math.floor(totalFree / 60), fM = totalFree % 60;
    const fs = fH > 0 ? `${fH}h ${fM > 0 ? fM + 'm' : ''}`.trim() : `${fM}m`;
    warnings.push({ type: 'heavy', text: `You only have ${fs} free tonight between your activities. Let's figure out what's most important.` });
  }

  // Classify and sort tasks: tonight+hardest first
  const classified = tasks.map(t => ({
    ...t, tier: classifyTask(t.title), isTonight: t.dueDate === today || !t.dueDate,
    _rem: t.estimatedMinutes || 30, _chunk: 0,
  })).sort((a, b) => {
    if (a.isTonight !== b.isTonight) return a.isTonight ? -1 : 1;
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    return 0;
  });

  const totalEst = classified.reduce((s, t) => s + (t.estimatedMinutes || 30), 0);
  if (totalEst > totalFree && totalEst > 0 && !warnings.length) {
    const hW = Math.round(totalEst / 60 * 10) / 10, hF = Math.round(totalFree / 60 * 10) / 10;
    warnings.push({ type: 'bedtime-overload', text: `You have ~${hW}hrs of homework but only ~${hF}hrs free tonight. Let's figure out what's most important.` });
  }

  const hwBlocks = [];
  const timeline = [];
  let taskQueue  = classified.map(t => ({ ...t }));

  // Build sorted list of calendar events tonight
  const calTonight = _calEvents
    .map(ev => ({
      title:    ev.title,
      startMin: ev.start.getHours() * 60 + ev.start.getMinutes(),
      endMin:   ev.end.getHours()   * 60 + ev.end.getMinutes(),
    }))
    .filter(ev => ev.endMin > startMin && ev.startMin < BEDTIME_MINUTES)
    .sort((a, b) => a.startMin - b.startMin);

  let timelineCursor = startMin;

  function scheduleIntoFreeBlock(fStart, fEnd) {
    let pos = fStart, workedSince = 0;
    while (pos < fEnd && taskQueue.length > 0) {
      const task = taskQueue[0];
      if (task._rem <= 0) { taskQueue.shift(); continue; }
      const numChunks = Math.ceil((task.estimatedMinutes || 30) / WORK);

      if (workedSince >= WORK) {
        const bd = Math.min(BREAK, fEnd - pos);
        if (bd >= 5) {
          timeline.push({ type: 'break', startMin: pos, duration: bd });
          hwBlocks.push({ type: 'break', duration: bd, startMinute: pos - startMin });
          pos += bd; workedSince = 0;
        } else break;
        continue;
      }

      const available = fEnd - pos;
      if (available <= 0) break;
      const chunkDur  = Math.min(WORK, task._rem);
      const actualDur = Math.min(chunkDur, available);

      timeline.push({
        type: 'hw', taskId: task.id, title: task.title, className: task.className || '',
        tier: task.tier, startMin: pos, duration: actualDur,
        chunkNum:    numChunks > 1 ? task._chunk + 1 : null,
        totalChunks: numChunks > 1 ? numChunks : null,
      });
      hwBlocks.push({
        type: 'task', task: { ...task }, duration: actualDur, startMinute: pos - startMin,
        chunkNum:    numChunks > 1 ? task._chunk + 1 : null,
        totalChunks: numChunks > 1 ? numChunks : null,
        truncated: actualDur < chunkDur,
      });

      task._rem   -= actualDur;
      task._chunk += 1;
      pos         += actualDur;
      workedSince += actualDur;
      if (task._rem <= 0) taskQueue.shift();
    }
    return pos;
  }

  freeBlocks.forEach(fb => {
    // Add any calendar events that fall before this free block
    calTonight
      .filter(ev => ev.startMin >= timelineCursor && ev.startMin < fb.startMin)
      .forEach(ev => timeline.push({
        type: 'cal', title: ev.title,
        startMin: Math.max(ev.startMin, timelineCursor),
        duration: ev.endMin - Math.max(ev.startMin, timelineCursor),
      }));
    timelineCursor = fb.startMin;
    timelineCursor = scheduleIntoFreeBlock(fb.startMin, Math.min(fb.endMin, BEDTIME_MINUTES));
  });

  // Remaining calendar events after all free blocks
  calTonight
    .filter(ev => ev.startMin >= timelineCursor && ev.startMin < BEDTIME_MINUTES)
    .forEach(ev => timeline.push({
      type: 'cal', title: ev.title, startMin: ev.startMin,
      duration: Math.min(ev.endMin, BEDTIME_MINUTES) - ev.startMin,
    }));

  timeline.sort((a, b) => a.startMin - b.startMin);
  timeline.push({ type: 'bedtime', startMin: BEDTIME_MINUTES, duration: 0 });

  const totalMinutes = hwBlocks.filter(b => b.type === 'task').reduce((s, b) => s + b.duration, 0);
  return { blocks: hwBlocks, timeline, warnings, totalMinutes, startMinutes: startMin, isPastBedtime: false };
}

export function getHwTasks() {
  try { return JSON.parse(localStorage.getItem('lumi_hw_tasks') || '[]'); } catch { return []; }
}
export function saveHwTasks(tasks) { localStorage.setItem('lumi_hw_tasks', JSON.stringify(tasks)); }
export function genHwId() { return 'hw_' + Math.random().toString(36).slice(2, 10); }
export function todayStr() { return new Date().toISOString().slice(0, 10); }

// Load teacher profiles for time hints — uses same teacher_email + class_name lookup
const _hwProfileCache = {};
async function getTeacherProfileCached(course, teacherName) {
  const email = resolveTeacherEmail(teacherName);
  if (!email) return null;
  const key = email + '__' + course;
  if (_hwProfileCache[key] !== undefined) return _hwProfileCache[key];
  // Check the main profile cache first (seeded profiles)
  if (_profileCache[key]) { _hwProfileCache[key] = _profileCache[key]; return _profileCache[key]; }
  try {
    const data = await fetchTeacherProfileLambda(email, course);
    _hwProfileCache[key] = data || null;
  } catch (err) {
    console.error('[getTeacherProfileCached] Lambda fetch failed:', course, err);
    _hwProfileCache[key] = null;
  }
  return _hwProfileCache[key];
}

// ── Daily popup check ──────────────────────────────────────
export function checkDailyHwPrompt() {
  if (sessionStorage.getItem('homeworkCheckinShown')) return; // only auto-show once per session
  const lastDate = localStorage.getItem('lumi_hw_date');
  if (lastDate === todayStr()) return;           // already shown today
  const schedule = getSchedule();
  if (!schedule.length) return;                  // no schedule yet
  // Remove stale (past & complete) tasks older than 3 days
  pruneOldTasks();
  showHwPopup();
}

function pruneOldTasks() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const tasks = getHwTasks().filter(t => !t.isComplete || (t.dueDate && t.dueDate >= cutoffStr));
  saveHwTasks(tasks);
}

// ── Show/hide helpers ──────────────────────────────────────
export function openHwBackdrop()  { $('hwBackdrop').classList.add('open'); }
export function closeHwBackdrop() { $('hwBackdrop').classList.remove('open'); }

export function showHwPopup() {
  sessionStorage.setItem('homeworkCheckinShown', 'true');
  localStorage.setItem('lumi_hw_date', todayStr());
  openHwBackdrop();
  const popup = $('hwPopup');
  popup.style.display = 'flex';
  popup.style.flexDirection = 'column';
  requestAnimationFrame(() => popup.classList.add('open'));
  renderHwPopupTasks();
}

export function closeHwPopup() {
  const popup = $('hwPopup');
  popup.classList.remove('open');
  closeHwBackdrop();
  setTimeout(() => { popup.style.display = 'none'; }, 200);
  renderSidebar(); // refresh sidebar checklist
  syncHwToSupabase();
}

export function showHwAddModal(prefillClass) {
  const modal = $('hwAddModal');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));

  // Populate class selector
  const sel = $('hwClassSelect');
  sel.innerHTML = '';
  const schedule = getSchedule();
  schedule.forEach(({ course }) => {
    const opt = document.createElement('option');
    opt.value = course;
    opt.textContent = course;
    sel.appendChild(opt);
  });
  // S9: Default to prefill, current tutor context, or placeholder
  if (prefillClass) {
    sel.value = prefillClass;
  } else if (S.tutorCtx?.course) {
    sel.value = S.tutorCtx.course;
  } else {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a class\u2026';
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.insertBefore(placeholder, sel.firstChild);
  }

  // Default due date = today
  $('hwDueInput').value = todayStr();
  $('hwTitleInput').value = '';
  $('hwTimeInput').value = '';
  $('hwTimeHint').textContent = '';

  // Show teacher time hint when class changes
  sel.addEventListener('change', updateTimeHint);
  updateTimeHint();
}

async function updateTimeHint() {
  const sel    = $('hwClassSelect');
  const course = sel.value;
  const schedule = getSchedule();
  const entry  = schedule.find(s => s.course === course);
  if (!entry) { $('hwTimeHint').textContent = ''; return; }
  const profile = await getTeacherProfileCached(entry.course, entry.teacher);
  if (profile && profile.typical_hw_duration_minutes) {
    $('hwTimeHint').textContent = `${teacherDisplayName(entry.teacher, profile)} typically assigns ~${profile.typical_hw_duration_minutes} min of homework`;
    $('hwTimeInput').placeholder = profile.typical_hw_duration_minutes;
  } else {
    $('hwTimeHint').textContent = '';
    $('hwTimeInput').placeholder = '30';
  }
}

export function closeHwAddModal() {
  const modal = $('hwAddModal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

export function showHwPlanModal() {
  const tasks = getHwTasks().filter(t => !t.isComplete);
  const plan  = _calEvents.length > 0 ? buildStudyPlanWithCalendar(tasks) : buildStudyPlan(tasks);
  renderStudyPlan(plan);
  const modal = $('hwPlanModal');
  const backdrop = $('hwPlanBackdrop');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => {
    modal.classList.add('open');
    backdrop.classList.add('open');
  });
}

export function closeHwPlanModal() {
  const modal = $('hwPlanModal');
  const backdrop = $('hwPlanBackdrop');
  modal.classList.remove('open');
  backdrop.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 300);
}

// ── Render popup task list ─────────────────────────────────
export function renderHwPopupTasks() {
  const list  = $('hwPopupTaskList');
  const tasks = getHwTasks();
  const today = todayStr();
  list.innerHTML = '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-muted);padding:4px 0 12px';
    empty.textContent = 'Nothing yet — add your assignments below.';
    list.appendChild(empty);
    return;
  }
  tasks.forEach(task => {
    const tier      = classifyTask(task.title);
    const dot       = TIER_DOT[tier] || '⚪';
    const isTonight = task.dueDate === today || !task.dueDate;

    const card = document.createElement('div');
    card.className = 'hw-task-card' + (task.isComplete ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'hw-task-check';
    check.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
    check.title = task.isComplete ? 'Mark incomplete' : 'Mark done';
    check.addEventListener('click', () => toggleHwTask(task.id));

    const info = document.createElement('div');
    info.className = 'hw-task-info';
    const title = document.createElement('div');
    title.className = 'hw-task-title';
    title.textContent = `${dot} ${task.title}`;
    const meta = document.createElement('div');
    meta.className = 'hw-task-meta';
    const parts = [];
    if (task.className)        parts.push(task.className.split(' ').slice(0,2).join(' '));
    if (task.estimatedMinutes) parts.push(`~${task.estimatedMinutes} min`);
    if (task.dueDate)          parts.push(isTonight ? '⚡ tonight' : '📅 ' + task.dueDate);
    meta.textContent = parts.join(' · ');
    info.appendChild(title);
    info.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'hw-task-del';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', () => deleteHwTask(task.id));

    card.appendChild(check);
    card.appendChild(info);
    card.appendChild(del);
    list.appendChild(card);
  });
}

function toggleHwTask(id) {
  const tasks = getHwTasks().map(t => t.id === id ? { ...t, isComplete: !t.isComplete } : t);
  saveHwTasks(tasks);
  renderHwPopupTasks();
  renderSidebar();
  syncHwToSupabase();
}

function deleteHwTask(id) {
  const tasks = getHwTasks().filter(t => t.id !== id);
  saveHwTasks(tasks);
  renderHwPopupTasks();
  renderSidebar();
  syncHwToSupabase();
}

export function addHwTask(task) {
  const tasks = getHwTasks();
  tasks.push(task);
  saveHwTasks(tasks);
}

// ── Homework detail view ──────────────────────────────────
function showHwDetail(id) {
  const task = getHwTasks().find(t => t.id === id);
  if (!task) return;
  $('hwDetailTitle').textContent = task.title;
  $('hwDetailClass').textContent = task.className || '—';
  $('hwDetailDue').textContent = task.dueDate || 'No date set';
  $('hwDetailTime').textContent = task.estimatedMinutes ? task.estimatedMinutes + ' min' : '—';
  $('hwDetailStatus').textContent = task.isComplete ? 'Complete' : 'In progress';
  const toggleBtn = $('hwDetailToggleBtn');
  toggleBtn.textContent = task.isComplete ? 'Mark incomplete' : 'Mark complete';
  toggleBtn.onclick = () => { toggleHwTask(id); showHwDetail(id); };
  $('hwDetailBack').onclick = () => { $('hwDetailModal').style.display = 'none'; };
  $('hwDetailCloseBtn').onclick = () => { $('hwDetailModal').style.display = 'none'; };
  $('hwDetailModal').style.display = '';
}

// ── Study plan generator ───────────────────────────────────
const BEDTIME_MINUTES = 22 * 60 + 30; // 10:30 PM

export function buildStudyPlan(tasks) {
  if (!tasks.length) return { blocks: [], totalMinutes: 0, startMinutes: getPlanStartMinutes(), warnings: [], isPastBedtime: false };

  const style = getStudyStyle();
  const WORK = style.work_minutes;
  const BREAK = style.break_minutes;
  const today = todayStr();
  const startMinutes = getPlanStartMinutes();
  const isPastBedtime = startMinutes >= BEDTIME_MINUTES;
  const minutesUntilBedtime = Math.max(0, BEDTIME_MINUTES - startMinutes);
  const warnings = [];

  if (isPastBedtime) {
    warnings.push({ type: 'bedtime', text: "It's 10:30 — time to wrap up and get to sleep. Getting 8 hours of sleep is just as important as finishing your homework. Whatever isn't done can be handled tomorrow morning or during a free period." });
    return { blocks: [], totalMinutes: 0, startMinutes, warnings, isPastBedtime: true };
  }

  // Classify and annotate tasks
  const classified = tasks.map(t => ({
    ...t,
    tier: classifyTask(t.title),
    isTonight: t.dueDate === today || !t.dueDate,
  }));

  // Sort: tonight first, then hardest tier first, then by due date
  const sorted = [...classified].sort((a, b) => {
    if (a.isTonight !== b.isTonight) return a.isTonight ? -1 : 1;
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate)
      return a.dueDate < b.dueDate ? -1 : 1;
    return 0;
  });

  // Overload warnings
  const totalEstimated = sorted.reduce((s, t) => s + (t.estimatedMinutes || 30), 0);
  const tier1Count = sorted.filter(t => t.tier === 'TIER_1_CRITICAL').length;

  if (totalEstimated > minutesUntilBedtime) {
    const hrsWork = Math.round(totalEstimated / 60 * 10) / 10;
    const hrsBed  = Math.round(minutesUntilBedtime / 60 * 10) / 10;
    warnings.push({
      type: 'bedtime-overload',
      text: `You have ~${hrsWork}hrs of work but only ~${hrsBed}hrs before your 10:30 cutoff tonight. Let's figure out what's most important to finish tonight and what can wait.`
    });
  } else if (totalEstimated > 180) {
    warnings.push({
      type: 'heavy',
      text: `This is a heavy night (~${Math.round(totalEstimated / 60)}hrs) — let's talk about what to prioritize.`
    });
  }
  if (tier1Count > 2) {
    warnings.push({
      type: 'overload',
      text: `You have ${tier1Count} major assignments tonight — consider spreading some across tomorrow.`
    });
  }

  // Build blocks by chunking each task into WORK-minute pieces, stopping at bedtime
  const blocks = [];
  let elapsed = 0;
  let workedSinceBreak = 0;
  let hitBedtime = false;

  sorted.forEach((task, taskIdx) => {
    if (hitBedtime) return;
    const dur = task.estimatedMinutes || 30;
    const numChunks = Math.ceil(dur / WORK);

    for (let chunk = 0; chunk < numChunks; chunk++) {
      if (hitBedtime) break;

      // Insert break before this chunk if we've hit the work limit
      if (workedSinceBreak >= WORK && (taskIdx > 0 || chunk > 0)) {
        const breakEnd = elapsed + BREAK;
        if (startMinutes + breakEnd > BEDTIME_MINUTES) { hitBedtime = true; break; }
        blocks.push({ type: 'break', duration: BREAK, startMinute: elapsed });
        elapsed += BREAK;
        workedSinceBreak = 0;
      }

      const chunkDur = Math.min(WORK, dur - chunk * WORK);
      // Cap chunk at bedtime
      const availableMinutes = BEDTIME_MINUTES - startMinutes - elapsed;
      if (availableMinutes <= 0) { hitBedtime = true; break; }
      const actualDur = Math.min(chunkDur, availableMinutes);

      blocks.push({
        type: 'task',
        task,
        duration: actualDur,
        startMinute: elapsed,
        chunkNum:    numChunks > 1 ? chunk + 1 : null,
        totalChunks: numChunks > 1 ? numChunks : null,
        truncated:   actualDur < chunkDur,
      });
      elapsed += actualDur;
      workedSinceBreak += actualDur;
      if (startMinutes + elapsed >= BEDTIME_MINUTES) { hitBedtime = true; break; }
    }
  });

  // Add bedtime block at the end if we hit the limit mid-plan
  if (hitBedtime || startMinutes + elapsed >= BEDTIME_MINUTES) {
    blocks.push({ type: 'bedtime', startMinute: elapsed });
  }

  return { blocks, totalMinutes: elapsed, startMinutes, warnings, isPastBedtime: false };
}

function renderStudyPlan(plan) {
  const body = $('hwPlanBody');
  body.innerHTML = '';
  const { blocks, totalMinutes, startMinutes, warnings, isPastBedtime } = plan;

  // Past-bedtime: show only the sleep message
  if (isPastBedtime) {
    const el = document.createElement('div');
    el.className = 'hw-plan-warning bedtime';
    el.style.cssText = 'font-size:14px;line-height:1.6;margin:0';
    el.textContent = "🌙 " + (warnings[0] && warnings[0].text || "It's 10:30 — time to wrap up and get to sleep.");
    body.appendChild(el);
    return;
  }

  // Warnings banner
  warnings.forEach(w => {
    const el = document.createElement('div');
    el.className = 'hw-plan-warning ' + w.type;
    const icon = w.type === 'bedtime-overload' ? '⏰ ' : w.type === 'heavy' ? '⚠️ ' : '🔴 ';
    el.textContent = icon + w.text;
    body.appendChild(el);
  });

  // Summary line
  const uniqueTasks = new Set(blocks.filter(b => b.type === 'task').map(b => b.task.id)).size;
  const totalH = Math.floor(totalMinutes / 60);
  const totalM = totalMinutes % 60;
  const timeStr = totalH > 0 ? `${totalH}h ${totalM > 0 ? totalM + 'm' : ''}`.trim() : `${totalM}m`;
  const style = getStudyStyle();
  const summary = document.createElement('div');
  summary.className = 'hw-plan-summary';
  summary.textContent = `${uniqueTasks} assignment${uniqueTasks !== 1 ? 's' : ''} · ~${timeStr} total · ${style.work_minutes}min on / ${style.break_minutes}min off. Starting now:`;
  body.appendChild(summary);

  // Plan blocks
  blocks.forEach((block, i) => {
    const el = document.createElement('div');
    el.className = 'hw-plan-block' + (block.type === 'break' ? ' break' : block.type === 'bedtime' ? ' bedtime-block' : '');

    if (block.type === 'bedtime') {
      el.style.cssText = 'background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.25)';
      const timeEl = document.createElement('div');
      timeEl.className = 'hw-plan-block-time';
      timeEl.textContent = '10:30 PM';
      const titleEl = document.createElement('div');
      titleEl.className = 'hw-plan-block-title';
      titleEl.textContent = '🌙 Bedtime — lights out!';
      const metaEl = document.createElement('div');
      metaEl.className = 'hw-plan-block-meta';
      metaEl.textContent = '8 hours of sleep is non-negotiable.';
      el.appendChild(timeEl); el.appendChild(titleEl); el.appendChild(metaEl);
      body.appendChild(el);
      return;
    }

    const absMin = startMinutes + block.startMinute;
    const timeEl = document.createElement('div');
    timeEl.className = 'hw-plan-block-time';
    timeEl.textContent = fmtPlanAbsTime(absMin) + ' · ' + block.duration + ' min';

    const titleEl = document.createElement('div');
    titleEl.className = 'hw-plan-block-title';

    if (block.type === 'break') {
      titleEl.textContent = '🔋 Break';
      const metaEl = document.createElement('div');
      metaEl.className = 'hw-plan-block-meta';
      metaEl.textContent = 'Step away, stretch, hydrate.';
      el.appendChild(timeEl); el.appendChild(titleEl); el.appendChild(metaEl);
    } else {
      const dot = TIER_DOT[block.task.tier] || '⚪';
      const chunkLabel = block.chunkNum ? ` (part ${block.chunkNum} of ${block.totalChunks})` : '';
      const truncNote  = block.truncated ? ' ⚠️' : '';
      titleEl.textContent = `${dot} ${block.task.title}${chunkLabel}${truncNote}`;
      const metaEl = document.createElement('div');
      metaEl.className = 'hw-plan-block-meta';
      const parts = [];
      if (block.task.className) parts.push(block.task.className.split(' ').slice(0, 2).join(' '));
      const tierInfo = HOMEWORK_PRIORITY[block.task.tier];
      if (tierInfo) parts.push(tierInfo.label);
      if (block.task.dueDate) parts.push(block.task.isTonight ? '⚡ tonight' : '📅 ' + block.task.dueDate);
      metaEl.textContent = parts.join(' · ');
      el.appendChild(timeEl); el.appendChild(titleEl);
      if (parts.length) el.appendChild(metaEl);

      // Edit pencil button
      const editBtn = document.createElement('button');
      editBtn.className = 'hw-plan-block-edit-btn';
      editBtn.innerHTML = '✏️';
      editBtn.title = 'Edit block';
      const blockIdx = i;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBlockEditMode(el, blockIdx, blocks, startMinutes, plan);
      });
      el.appendChild(editBtn);
    }
    body.appendChild(el);
  });

  // "+ Add block" button
  const addBlockBtn = document.createElement('button');
  addBlockBtn.className = 'hw-plan-add-block';
  addBlockBtn.textContent = '+ Add block';
  addBlockBtn.addEventListener('click', () => {
    addCustomBlock(blocks, startMinutes, plan);
  });
  body.appendChild(addBlockBtn);
}

// Save edited plan to localStorage
function saveEditedPlan(blocks, startMinutes) {
  const data = blocks.filter(b => b.type === 'task').map(b => ({
    title: b.task.title,
    duration: b.duration,
    className: b.task.className || '',
    tier: b.task.tier || ''
  }));
  localStorage.setItem('lumi_edited_plan', JSON.stringify({ date: todayStr(), blocks: data, startMinutes }));
}

function getEditedPlan() {
  try {
    const raw = localStorage.getItem('lumi_edited_plan');
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== todayStr()) { localStorage.removeItem('lumi_edited_plan'); return null; }
    return data;
  } catch { return null; }
}

function toggleBlockEditMode(el, blockIdx, blocks, startMinutes, plan) {
  // If already in edit mode, close it
  const existing = el.querySelector('.hw-plan-edit-row');
  if (existing) { existing.remove(); return; }

  const block = blocks[blockIdx];
  if (!block || block.type !== 'task') return;

  const row = document.createElement('div');
  row.className = 'hw-plan-edit-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = block.task.title;
  nameInput.placeholder = 'Task name';

  const durSelect = document.createElement('select');
  [10, 15, 20, 25, 30, 45, 60].forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m + ' min';
    if (m === block.duration) opt.selected = true;
    durSelect.appendChild(opt);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'hw-plan-edit-del';
  delBtn.title = 'Delete block';
  delBtn.textContent = '🗑️';
  delBtn.addEventListener('click', () => {
    blocks.splice(blockIdx, 1);
    saveEditedPlan(blocks, startMinutes);
    reRenderPlan(blocks, startMinutes, plan);
  });

  // Auto-save on change
  nameInput.addEventListener('change', () => {
    block.task.title = nameInput.value.trim() || block.task.title;
    saveEditedPlan(blocks, startMinutes);
    reRenderPlan(blocks, startMinutes, plan);
  });
  durSelect.addEventListener('change', () => {
    block.duration = parseInt(durSelect.value);
    saveEditedPlan(blocks, startMinutes);
    reRenderPlan(blocks, startMinutes, plan);
  });

  row.appendChild(nameInput);
  row.appendChild(durSelect);
  row.appendChild(delBtn);
  el.appendChild(row);
}

function addCustomBlock(blocks, startMinutes, plan) {
  const lastBlock = blocks[blocks.length - 1];
  const lastEnd = lastBlock ? lastBlock.startMinute + (lastBlock.duration || 0) : 0;
  const newBlock = {
    type: 'task',
    task: { title: 'New task', className: '', tier: 'TIER_3_REVIEW', id: 'custom_' + Date.now() },
    duration: 25,
    startMinute: lastEnd,
    chunkNum: null,
    totalChunks: null,
    truncated: false
  };
  // Insert before bedtime block if present
  const bedIdx = blocks.findIndex(b => b.type === 'bedtime');
  if (bedIdx >= 0) blocks.splice(bedIdx, 0, newBlock);
  else blocks.push(newBlock);
  saveEditedPlan(blocks, startMinutes);
  reRenderPlan(blocks, startMinutes, plan);
}

function reRenderPlan(blocks, startMinutes, plan) {
  // Recalculate start minutes for each block
  let elapsed = 0;
  blocks.forEach(b => { b.startMinute = elapsed; elapsed += (b.duration || 0); });
  plan.blocks = blocks;
  plan.totalMinutes = elapsed;
  renderStudyPlan(plan);
}

// ── Planner floating strip state ───────────────────────────
let _plannerBlocks = [];
let _plannerBlockIdx = 0;
let _plannerTimerInterval = null;
let _plannerStartedAt = null;

export function startPlannerStrip(blocks) {
  _plannerBlocks = blocks.filter(b => b.type === 'task');
  if (!_plannerBlocks.length) return;
  _plannerBlockIdx = 0;
  _plannerStartedAt = Date.now();
  updatePlannerStrip();
  $('plannerStrip').style.display = 'flex';
  if (_plannerTimerInterval) clearInterval(_plannerTimerInterval);
  _plannerTimerInterval = setInterval(updatePlannerStripTimer, 1000);
}

function updatePlannerStrip() {
  if (_plannerBlockIdx >= _plannerBlocks.length) {
    closePlannerStrip();
    showToast('All blocks done! 🎉', 'ok');
    return;
  }
  const block = _plannerBlocks[_plannerBlockIdx];
  const taskName = block.task ? block.task.title : 'Study block';
  const chunkLabel = block.chunkNum ? ` (part ${block.chunkNum}/${block.totalChunks})` : '';
  $('plannerStripTask').textContent = taskName + chunkLabel;
  _plannerStartedAt = Date.now();
  updatePlannerStripTimer();
}

function updatePlannerStripTimer() {
  if (_plannerBlockIdx >= _plannerBlocks.length) return;
  const block = _plannerBlocks[_plannerBlockIdx];
  const dur = (block.duration || 25) * 60 * 1000;
  const elapsed = Date.now() - _plannerStartedAt;
  const remaining = Math.max(0, dur - elapsed);
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  $('plannerStripTimer').textContent = `${mins}:${secs.toString().padStart(2, '0')} remaining`;
  if (remaining <= 0) {
    $('plannerStripTimer').textContent = 'Time\'s up!';
  }
}

export function advancePlannerBlock() {
  _plannerBlockIdx++;
  if (_plannerBlockIdx >= _plannerBlocks.length) {
    closePlannerStrip();
    showToast('All blocks done! 🎉', 'ok');
    return;
  }
  _plannerStartedAt = Date.now();
  updatePlannerStrip();
}

function closePlannerStrip() {
  $('plannerStrip').style.display = 'none';
  if (_plannerTimerInterval) { clearInterval(_plannerTimerInterval); _plannerTimerInterval = null; }
  _plannerBlocks = [];
  _plannerBlockIdx = 0;
}

// ── Sidebar homework checklist ─────────────────────────────
export function renderHwSidebar(container) {
  const tasks = getHwTasks();
  const today = todayStr();

  // Header
  const hd = document.createElement('div');
  hd.className = 'sb-hw-hd';
  const hdLabel = document.createElement('span');
  hdLabel.textContent = 'My Homework';
  const hdBtns = document.createElement('div');
  hdBtns.style.cssText = 'display:flex;align-items:center;gap:6px';
  const hdBtn = document.createElement('button');
  hdBtn.className = 'sb-hw-hd-btn';
  hdBtn.textContent = '+ Add';
  hdBtn.addEventListener('click', () => { showWorkTypeChooser(); closeSidebar(); });
  const planBtn = document.createElement('button');
  planBtn.className = 'sb-hw-planner-btn';
  planBtn.title = 'Open planner';
  planBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  planBtn.addEventListener('click', () => {
    const tasks = getHwTasks().filter(t => !t.isComplete);
    if (!tasks.length) { showToast('Add some homework first!'); return; }
    showHwPlanModal();
    closeSidebar();
  });
  hdBtns.appendChild(hdBtn);
  hdBtns.appendChild(planBtn);
  hd.appendChild(hdLabel);
  hd.appendChild(hdBtns);
  container.appendChild(hd);

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'sb-hw-empty';
    empty.textContent = 'No homework — enjoy the break!';
    container.appendChild(empty);
  } else {
    const incomplete = tasks
      .filter(t => !t.isComplete)
      .map(t => ({ ...t, tier: classifyTask(t.title), isTonight: t.dueDate === today || !t.dueDate }))
      .sort((a, b) => {
        if (a.isTonight !== b.isTonight) return a.isTonight ? -1 : 1;
        return (TIER_ORDER[a.tier] || 3) - (TIER_ORDER[b.tier] || 3);
      });
    const complete = tasks.filter(t => t.isComplete).slice(0, 2);
    const toShow = [...incomplete, ...complete].slice(0, 7);

    toShow.forEach(task => {
      const tier      = task.tier || classifyTask(task.title);
      const dot       = TIER_DOT[tier] || '⚪';
      const isTonight = task.isTonight !== undefined ? task.isTonight : (task.dueDate === today || !task.dueDate);

      const item = document.createElement('div');
      item.className = 'sb-hw-item' + (task.isComplete ? ' done' : '');

      const check = document.createElement('div');
      check.className = 'sb-hw-check' + (task.isComplete ? ' done' : '');
      check.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
      check.addEventListener('click', e => { e.stopPropagation(); toggleHwTask(task.id); });

      const dotEl = document.createElement('span');
      dotEl.className = 'sb-hw-tier-dot';
      dotEl.textContent = dot;

      const titleEl = document.createElement('div');
      titleEl.className = 'sb-hw-item-title';
      titleEl.textContent = task.title;

      // Colored urgency badge based on due date proximity
      const urgencyEl = document.createElement('span');
      let urgencyClass = 'later', urgencyText = 'Due later';
      if (!task.dueDate) {
        urgencyClass = 'nodate'; urgencyText = 'No date';
      } else {
        const daysLeft = dateDiffDays(today, task.dueDate);
        if (daysLeft <= 0) { urgencyClass = 'in-progress'; urgencyText = 'In Progress'; }
        else if (daysLeft <= 1) { urgencyClass = 'tomorrow'; urgencyText = 'Due tomorrow'; }
        else if (daysLeft <= 7) { urgencyClass = 'week'; urgencyText = 'Due this week'; }
      }
      urgencyEl.className = 'sb-hw-urgency ' + urgencyClass;
      urgencyEl.textContent = urgencyText;

      item.appendChild(check);
      item.appendChild(dotEl);
      item.appendChild(titleEl);
      item.appendChild(urgencyEl);
      item.addEventListener('click', e => {
        if (e.target.closest('.sb-hw-check')) return;
        showHwDetail(task.id);
      });
      container.appendChild(item);
    });
  }

  // "Open planner" button removed — now in header as icon button

  if (isCalendarConnected() || _calEvents.length > 0) {
    const tlBtn = document.createElement('div');
    tlBtn.className = 'sb-hw-open-btn';
    tlBtn.style.marginTop = '4px';
    tlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> View tonight's timeline`;
    tlBtn.addEventListener('click', () => { showTimelineModal(); closeSidebar(); });
    container.appendChild(tlBtn);
  }

  // ── Active projects ────────────────────────────────────
  const projects = getProjects().filter(p => !p.isComplete);
  if (projects.length > 0) {
    const projHd = document.createElement('div');
    projHd.className = 'sb-hw-hd';
    projHd.style.marginTop = '8px';
    const projLabel = document.createElement('span');
    projLabel.textContent = 'Projects';
    projHd.appendChild(projLabel);
    container.appendChild(projHd);

    projects.forEach(proj => {
      const today = todayStr();
      const daysLeft = dateDiffDays(today, proj.dueDate);
      const completedDays = proj.plan.filter(d => d.isComplete).length;
      const totalDays = proj.plan.length;

      const item = document.createElement('div');
      item.className = 'sb-hw-item';
      item.style.cursor = 'pointer';

      const dot = document.createElement('span');
      dot.className = 'sb-hw-tier-dot';
      dot.textContent = '📝';

      const titleEl = document.createElement('div');
      titleEl.className = 'sb-hw-item-title';
      titleEl.textContent = proj.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'sb-hw-item-urgency';
      metaEl.textContent = daysLeft <= 2 ? '🔴' : daysLeft <= 5 ? '🟠' : '📅';
      metaEl.title = `Due ${fmtDateShort(proj.dueDate)} · ${completedDays}/${totalDays} done`;

      const delBtn = document.createElement('button');
      delBtn.className = 'sb-proj-del';
      delBtn.title = 'Delete project';
      delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        deleteProject(proj.id, delBtn);
      });

      item.appendChild(dot);
      item.appendChild(titleEl);
      item.appendChild(delBtn);
      item.appendChild(metaEl);
      item.addEventListener('click', () => {
        showProjectPlanModal(proj);
        openHwBackdrop();
        closeSidebar();
      });
      addLongPress(item, () => deleteProject(proj.id, item));
      container.appendChild(item);
    });
  }

  const div = document.createElement('div');
  div.className = 'sb-divider';
  container.appendChild(div);
}

// ── System prompt homework context ─────────────────────────
export function hwContext() {
  const tasks = getHwTasks().filter(t => !t.isComplete);
  const today = todayStr();
  if (!tasks.length) return '';
  const style = getStudyStyle();
  const lines = tasks.map(t => {
    const tier     = classifyTask(t.title);
    const tierInfo = HOMEWORK_PRIORITY[tier];
    const dot      = TIER_DOT[tier] || '⚪';
    const isTonight = t.dueDate === today || !t.dueDate;
    const parts = [`${dot} ${t.title}`];
    if (t.className)        parts.push(`(${t.className})`);
    if (t.estimatedMinutes) parts.push(`~${t.estimatedMinutes} min`);
    if (t.dueDate)          parts.push(isTonight ? '[DUE TONIGHT]' : `due ${t.dueDate}`);
    if (tierInfo)           parts.push(`[${tierInfo.label}]`);
    return parts.join(' ');
  });
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const isPastBedtime = nowMinutes >= BEDTIME_MINUTES;
  const minutesUntilBed = Math.max(0, BEDTIME_MINUTES - nowMinutes);
  const totalTonight = tasks
    .filter(t => t.dueDate === today || !t.dueDate)
    .reduce((s, t) => s + (t.estimatedMinutes || 30), 0);
  const overload = totalTonight > 180 ? `\n⚠️ Tonight's workload is ~${Math.round(totalTonight/60)}hrs — help them prioritize.` : '';
  const bedtimeNote = isPastBedtime
    ? `\n🌙 IT IS PAST 10:30 PM. Do NOT help with homework. Encourage the student to sleep immediately and tackle remaining work tomorrow morning or during a free period.`
    : minutesUntilBed < 60
    ? `\n⏰ Less than ${minutesUntilBed} minutes until the 10:30 PM bedtime cutoff — flag this and help them focus on only the most critical work.`
    : '';

  // Calendar context
  let calContext = '';
  if (_calEvents.length > 0) {
    const evLines = _calEvents.map(ev => {
      const st = ev.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const et = ev.end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `  • ${ev.title} (${st} – ${et})`;
    });
    const fb   = getFreeTimeBlocks();
    const fbLines = fb.map(b => {
      const dH = Math.floor(b.durationMin / 60), dM = b.durationMin % 60;
      const ds = dH > 0 ? `${dH}h ${dM > 0 ? dM + 'm' : ''}`.trim() : `${dM}m`;
      return `  • ${fmtPlanAbsTime(b.startMin)} – ${fmtPlanAbsTime(b.endMin)} (${ds})`;
    });
    const tf = getTotalFreeMinutes();
    const tfH = Math.floor(tf / 60), tfM = tf % 60;
    const tfStr = tfH > 0 ? `${tfH}h ${tfM > 0 ? tfM + 'm' : ''}`.trim() : `${tfM}m`;
    calContext = `

STUDENT'S CALENDAR FOR TODAY:
${evLines.join('\n')}

FREE TIME AVAILABLE TONIGHT:
${fbLines.length ? fbLines.join('\n') : '  • No free blocks of 20+ min before 10:30 PM'}

Total free time tonight: ${tfStr}
Homework cutoff: 10:30 PM

Plan homework only within free time blocks. Never schedule during calendar events.
If free time is tight, be honest with the student about what is realistic tonight.`;
  }

  // Active projects context
  let projContext = '';
  const activeProjects = getProjects().filter(p => !p.isComplete);
  if (activeProjects.length > 0) {
    const projLines = activeProjects.map(p => {
      const today = todayStr();
      const daysLeft = dateDiffDays(today, p.dueDate);
      const completedDays = p.plan.filter(d => d.isComplete).length;
      const totalDays = p.plan.length;
      const todayTask = p.plan.find(d => d.date === today && !d.isComplete);
      const behindDays = p.plan.filter(d => d.date < today && !d.isComplete).length;
      let line = `📝 ${p.title} (${p.className}) — due ${p.dueDate} [${daysLeft} days left, ${completedDays}/${totalDays} sessions done]`;
      if (todayTask) line += `\n    Today's task: ${todayTask.label} (~${todayTask.estimatedMinutes} min)`;
      if (behindDays > 0) line += `\n    ⚠️ Behind by ${behindDays} session${behindDays > 1 ? 's' : ''} — needs catch-up`;
      return line;
    });
    projContext = `

ACTIVE PROJECTS:
${projLines.join('\n')}
- Help the student stay on track with their project plans
- If they're behind, help them prioritize catch-up work
- Reference their specific project plan when discussing upcoming work`;
  }

  return `

HOMEWORK PRIORITY SYSTEM:
You have access to the student's full homework list with priority tiers and due dates. Use this intelligently:

Current homework:
${lines.join('\n')}

Student study style: ${style.work_minutes} min work / ${style.break_minutes} min break (${style.label})${overload}${bedtimeNote}${calContext}${projContext}

Rules you must always follow:
- The student's bedtime is 10:30 PM. Never schedule or encourage work past this time.
- Always prioritize 8 hours of sleep as non-negotiable for student wellbeing.
- If it is past 10:30 PM and a student asks for help with homework, gently but firmly say: "I really think you should get some sleep — a rested brain will do better tomorrow than a tired one trying to push through tonight. Can this wait until morning?"
- Essays and projects should NEVER be left entirely to the night before — proactively suggest spreading them out
- If a student has a test in 3+ days, suggest starting review tonight even if nothing else is due
- If tonight's workload exceeds 3 hours, warn them and help prioritize what matters most
- Always schedule hardest, most important work first while energy is high
- Light review and vocab can be done during break times between bigger tasks
- If a student asks to work on low-priority tasks when they have urgent Tier 1 work, gently redirect: "You have your [assignment] due [when] — want to tackle that first?"
- Celebrate when students work ahead on big projects
- Be realistic and encouraging — never make the student feel overwhelmed
- If nothing is due tonight but Tier 1 work is due soon, proactively suggest working on it now`;
}

// ── Class-specific homework context for tutor system prompt ──
export function activeHwForClass(course) {
  const tasks = getHwTasks().filter(t => !t.isComplete && t.className === course);
  if (!tasks.length) return '';
  tasks.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1);
  const t = tasks[0];
  const dueStr = t.dueDate || 'no specific date';
  return `\nThe student is currently working on: ${t.title}, due ${dueStr}. Tailor your guidance toward helping them complete this assignment.`;
}

// ── Supabase sync ──────────────────────────────────────────
export function syncHwToSupabase() {
  if (!currentUser) return;
  const tasks = getHwTasks();
  const rows = tasks.map(t => ({
    id: t.id,
    user_id: currentUser.id,
    title: t.title,
    class_name: t.className || null,
    teacher_name: t.teacherName || null,
    due_date: t.dueDate || null,
    estimated_minutes: t.estimatedMinutes || null,
    is_complete: !!t.isComplete,
  }));
  if (!rows.length) {
    // Hardened (§2/§3): the empty-list wipe was the codebase's only fully
    // silent destructive write — now logged AND toasted on failure.
    rdsFetch('homework-tasks?all=true', { method: 'DELETE' }).catch(err => {
      console.warn('[syncHw] delete error:', err);
      showToast('Could not sync homework — see console');
    });
    return;
  }
  // user_id in each row is ignored server-side (always the JWT user).
  rdsFetch('homework-tasks', { method: 'POST', body: rows }).then(res => {
    if (res && res.upserted !== rows.length) {
      console.warn('[syncHw] upsert error:', `only ${res.upserted}/${rows.length} rows written (foreign id skipped)`);
    }
  }).catch(err => {
    console.warn('[syncHw] upsert error:', err);
    showToast('Could not sync homework — see console');
  });
}
