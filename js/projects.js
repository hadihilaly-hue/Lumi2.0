import { fmtBytes, showAttachPreview } from './chat.js';
import { lookupSubjectForCourse, openTutor } from './conversation.js';
import { showWelcome } from './emptystate.js';
import { closeHwAddModal, closeHwBackdrop, getHwTasks, openHwBackdrop, renderHwPopupTasks, saveHwTasks, syncHwToSupabase, todayStr } from './homework.js';
import { renderSidebar, showInlineConfirm } from './sidebar.js';
import { $, S, SB, _currentProjId, currentUser, messagesEl, msgInput, setCurrentProjId, setPendingAttachment } from './state.js';
import { deleteConvFromSupabase, genId, getConvs, getSchedule, saveConvs } from './storage.js';
import { rdsFetch } from './teachers.js';
import { autoGrow, showToast, updateSendBtn } from './ui.js';


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

export function closeWorkTypeChooser() {
  const modal = $('hwTypeChooser');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

export let _projPendingFile = null; // { file, base64, mediaType, isImage, isText }

export function showProjectCreateModal(prefill = {}) {
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

export function clearProjFile() {
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

export function wireProjDropzone() {
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

export function closeProjectCreateModal() {
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

export function closeProjectPlanModal() {
  const modal = $('projPlanModal');
  modal.classList.remove('open');
  setCurrentProjId(null);
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

// ── Render the multi-day plan ────────────────────────────

export function renderProjectPlan(project) {
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

export function createProject(title, className, teacherName, dueDate, requirements, fileData) {
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

export function injectProjectTasksToHomework() {
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

export function clearAllChats() {
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

export function clearCompletedProjects() {
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
export async function loadHwFromSupabase() {
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
