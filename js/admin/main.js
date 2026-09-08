// Admin console entry (admin.html): auth gate → load profiles → render.

import { fetchAllProfiles } from './adminApi.js';
import {
  indexProfiles, buildTeacherDatabase, lookupSubjectForCourse, getStatus, statusLabel,
  computeStats, filterTeachers, initialsOf, escHtml,
} from './dashboardState.js';
import { ferpaExport, ferpaShowConfirm, ferpaHideConfirm, ferpaConfirmSync, ferpaDelete } from './ferpa.js';

// ─── STATE ────────────────────────────────────────────────────────────────────
let _aUser     = null;
let aProfiles  = {};   // "email|course" → profile row
let aLoaded    = false; // true once any GET ?scope=all has succeeded
let aLastError = null;  // error from the most recent load, if it failed
const aExpanded = new Set();
let aRefreshTimer = null;

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.replace('index.html'); return; }
  // Compliance Phase 2b: fetch the directory before the admin gate reads it.
  // Fail-closed — if the fetch fails, ADMIN_EMAIL stays null and the check below
  // redirects (admin access is not granted on an unverifiable directory).
  try { await window.loadTeacherDirectory(); }
  catch (e) { console.error('[admin] directory load failed:', e); }
  const adminEmail = window.ADMIN_EMAIL;
  if (session.user.email.toLowerCase() !== adminEmail) {
    await sb.auth.signOut();
    window.location.replace('index.html');
    return;
  }
  _aUser = session.user;
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  await loadAndRender();
  startAutoRefresh();
}

// ─── DATA ─────────────────────────────────────────────────────────────────────
async function loadAndRender() {
  aLastError = null;
  try {
    const data = await fetchAllProfiles();
    if (data) { aProfiles = indexProfiles(data); aLoaded = true; }
  } catch (err) {
    console.error('Could not load profiles:', err);
    aLastError = err;
  }
  renderDashboard();
  updateRefreshTime(aLastError);
}

function startAutoRefresh() {
  if (aRefreshTimer) clearInterval(aRefreshTimer);
  aRefreshTimer = setInterval(loadAndRender, 60000);
}

function updateRefreshTime(loadError) {
  const now = new Date();
  const t   = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('refreshInfo').textContent = loadError
    ? `Refresh failed at ${t} (${loadError.message}) · retries every 60s`
    : `Last refreshed ${t} · auto-refreshes every 60s`;
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
// A failed GET /teacher-profile?scope=all must not render as an empty school
// (0 teachers / 0 classes); the error is shown in place of the roster.
function renderDashboard() {
  const loadError = aLastError;
  // Rebuild the roster from the freshly-loaded profile rows each render so
  // auto-refresh picks up new/onboarded classes.
  const teacherDb = buildTeacherDatabase(aProfiles, window.TEACHER_EMAIL_MAP || {});
  const query   = (document.getElementById('teacherSearch')?.value || '').toLowerCase().trim();
  const entries = filterTeachers(teacherDb, query);

  const list = document.getElementById('teacherList');
  list.innerHTML = '';

  // No successful load yet: the cache is not a dataset, so show placeholders
  // rather than zeros. After a later refresh failure the last good data stays.
  if (loadError && !aLoaded) {
    ['statTotal', 'statComplete', 'statInProgress', 'statNotStarted']
      .forEach(id => { document.getElementById(id).textContent = '—'; });
    document.getElementById('teacherCount').textContent = 'Teachers unavailable';
    list.innerHTML = `<div class="empty-text a-empty">Could not load teacher profiles (${escHtml(loadError.message)}). ` +
      'Check that this account is in the Lambda admin list.</div>';
    return;
  }

  const stats = computeStats(teacherDb, aProfiles);
  document.getElementById('statTotal').textContent      = stats.total;
  document.getElementById('statComplete').textContent   = stats.complete;
  document.getElementById('statInProgress').textContent = stats.inProgress;
  document.getElementById('statNotStarted').textContent = stats.notStarted;
  document.getElementById('teacherCount').textContent   =
    query ? `${entries.length} teacher${entries.length !== 1 ? 's' : ''} matching "${query}"` : `All teachers (${entries.length})`;

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-text a-empty">No teachers found.</div>';
    return;
  }

  entries.forEach(([email, teacher]) => {
    const isOpen    = aExpanded.has(email);
    const classes   = teacher.classes;
    const statuses  = classes.map(c => getStatus(aProfiles, email, c));
    const nComplete = statuses.filter(s => s === 'complete').length;
    const nProgress = statuses.filter(s => s === 'in_progress').length;
    const nNot      = statuses.filter(s => s === 'not_started').length;

    // Mini dot row (up to 8 dots)
    const dotsHtml = classes.slice(0, 8).map((c, i) => {
      const s = statuses[i];
      return `<span class="a-status-dot ${s}" title="${escHtml(c)}"></span>`;
    }).join('') + (classes.length > 8 ? `<span class="a-tiny">+${classes.length - 8}</span>` : '');

    const classesHtml = classes.map(course => {
      const s      = getStatus(aProfiles, email, course);
      const label  = statusLabel(s);
      const subject = lookupSubjectForCourse(course);
      const row    = aProfiles[`${email}|${course}`];
      const updated = row?.updated_at
        ? new Date(row.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      return `
        <div class="a-class-row">
          <div>
            <div class="a-class-name">${escHtml(course)}</div>
            <div class="a-class-subject">${escHtml(subject)}</div>
          </div>
          <div class="a-class-status">
            <span class="a-status-dot ${s}"></span>
            <span class="a-status-label ${s}">${label}</span>
          </div>
          ${updated ? `<div class="a-class-updated">${updated}</div>` : '<div class="a-class-updated"></div>'}
        </div>`;
    }).join('');

    const initials = initialsOf(teacher.name);
    const summaryParts = [];
    if (nComplete > 0)  summaryParts.push(`<span class="a-sum complete">${nComplete} complete</span>`);
    if (nProgress > 0)  summaryParts.push(`<span class="a-sum progress">${nProgress} in progress</span>`);
    if (nNot > 0)       summaryParts.push(`<span class="a-sum not">${nNot} not started</span>`);

    const card = document.createElement('div');
    card.className = 'a-teacher-card';
    card.innerHTML = `
      <div class="a-teacher-header" role="button" tabindex="0" aria-expanded="${isOpen}" aria-label="${escHtml(teacher.name)}, show class details" onclick="toggleTeacher('${escHtml(email)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleTeacher('${escHtml(email)}')}">
        <div class="a-teacher-header-left">
          <div class="a-teacher-avatar">${initials}</div>
          <div>
            <div class="a-teacher-name">${escHtml(teacher.name)}</div>
            <div class="a-teacher-email">${escHtml(email)} · ${summaryParts.join(', ')}</div>
          </div>
        </div>
        <div class="a-teacher-header-right">
          <div class="a-mini-dots">${dotsHtml}</div>
          <span class="a-chevron ${isOpen ? 'open' : ''}">▼</span>
        </div>
      </div>
      <div class="a-teacher-classes ${isOpen ? 'open' : ''}">
        ${classesHtml}
      </div>
    `;
    list.appendChild(card);
  });
}

function toggleTeacher(email) {
  if (aExpanded.has(email)) aExpanded.delete(email);
  else aExpanded.add(email);
  renderDashboard();
}

// admin.html's inline on* attributes resolve these on window.
Object.assign(window, {
  renderDashboard, toggleTeacher,
  ferpaExport, ferpaShowConfirm, ferpaHideConfirm, ferpaConfirmSync, ferpaDelete,
});

boot();
