// My Students: enrollment list per class/block, the block roster, and the
// per-student teacher-notes chat (PATCH /class-enrollments).

import { T } from './state.js';
import { showView, showToast, keyActivate } from './ui.js';
import { fetchTeachingEnrollments, patchEnrollmentNotes } from './profileApi.js';
import { escHtml, parseNotes, sortByLastName, groupBy } from './wizardState.js';

export async function loadAllEnrollments() {
  const profileIds = Object.values(T.profiles).map(p => p.id).filter(Boolean);
  if (!profileIds.length) { T.enrollments = []; return; }
  // Fail-visible (console.error + toast).
  try {
    T.enrollments = await fetchTeachingEnrollments();
  } catch (err) {
    console.error('loadAllEnrollments failed:', err);
    showToast('Could not load your students right now. Refresh the page to try again.', 'error');
    T.enrollments = [];
  }
}

export function renderMyStudents() {
  const label = document.getElementById('tStudentsLabel');
  const section = document.getElementById('tStudentsSection');

  if (!Object.values(T.profiles).length) {
    label.style.display = 'none';
    section.style.display = 'none';
    return;
  }

  label.style.display = '';
  section.style.display = '';
  section.innerHTML = '';

  if (!T.enrollments.length) {
    const empty = document.createElement('div');
    empty.className = 't-students-empty';
    empty.textContent = "No students have enrolled in your classes yet. Once students add you to their schedule, they'll appear here.";
    section.appendChild(empty);
    return;
  }

  const byProfile = groupBy(T.enrollments, e => e.teacher_profile_id);

  Object.values(T.profiles).forEach(profile => {
    const enrollments = byProfile[profile.id] || [];
    const expanded = T.expandedCourse === profile.course_name;
    const card = document.createElement('div');
    card.className = 't-student-class-card' + (expanded ? ' expanded' : '');

    const header = document.createElement('div');
    header.className = 't-student-class-header';
    header.innerHTML = `
      <div class="t-student-class-name">${escHtml(profile.course_name)}</div>
      <div class="t-student-class-meta">
        <span>${enrollments.length} student${enrollments.length === 1 ? '' : 's'}</span>
        <span class="t-student-class-chevron">▸</span>
      </div>
    `;
    keyActivate(header, () => {
      T.expandedCourse = (T.expandedCourse === profile.course_name) ? null : profile.course_name;
      renderMyStudents();
    }, `${profile.course_name}, ${enrollments.length} student${enrollments.length === 1 ? '' : 's'}`);
    header.setAttribute('aria-expanded', String(expanded));
    card.appendChild(header);

    if (expanded) {
      const blockList = document.createElement('div');
      blockList.className = 't-block-list';

      if (!enrollments.length) {
        const none = document.createElement('div');
        none.style.cssText = 'padding:10px 14px;font-size:13px;color:var(--text-2)';
        none.textContent = 'No students enrolled in this class yet.';
        blockList.appendChild(none);
      } else {
        const byBlock = groupBy(enrollments, e => e.block || '?');
        Object.keys(byBlock).sort().forEach(block => {
          const row = document.createElement('div');
          row.className = 't-block-row';
          const n = byBlock[block].length;
          row.innerHTML = `
            <div class="t-block-row-label">Block ${escHtml(block)}</div>
            <div class="t-block-row-count">${n} student${n === 1 ? '' : 's'}</div>
          `;
          keyActivate(row, (ev) => {
            ev?.stopPropagation?.();
            openRoster(profile.id, block);
          }, `Block ${block}, ${n} student${n === 1 ? '' : 's'} — view roster`);
          blockList.appendChild(row);
        });
      }
      card.appendChild(blockList);
    }

    section.appendChild(card);
  });
}

export function openRoster(profileId, block) {
  T.currentRoster = { profileId, block };
  renderRoster();
  showView('rosterView');
}

export function renderRoster() {
  const { profileId, block } = T.currentRoster;
  if (!profileId || !block) return;

  const profile = Object.values(T.profiles).find(p => p.id === profileId);
  document.getElementById('rosterCourseName').textContent = profile ? profile.course_name : '';
  document.getElementById('rosterBlockLabel').textContent = `Block ${block}`;

  const list = document.getElementById('rosterList');
  list.innerHTML = '';

  const students = sortByLastName(
    T.enrollments.filter(e => e.teacher_profile_id === profileId && e.block === block)
  );

  if (!students.length) {
    const none = document.createElement('div');
    none.className = 'empty-text t-roster-empty';
    none.textContent = 'No students in this block yet.';
    list.appendChild(none);
    return;
  }

  students.forEach(e => {
    const row = document.createElement('div');
    row.className = 't-roster-item';
    const name = document.createElement('span');
    name.className = 't-roster-name';
    name.textContent = e.student_name || 'Unknown Student';
    const meta = document.createElement('span');
    meta.className = 't-roster-meta';
    const n = parseNotes(e.teacher_notes).length;
    meta.textContent = n === 0 ? 'Add a note' : `${n} note${n === 1 ? '' : 's'}`;
    const chevron = document.createElement('span');
    chevron.className = 't-roster-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
    meta.appendChild(chevron);
    row.append(name, meta);
    keyActivate(row, () => openNoteChat(e.id), `${e.student_name || 'Unknown Student'} — open notes`);
    list.appendChild(row);
  });
}

export function rosterBack() { showView('homeView'); }

export function openNoteChat(enrollmentId) {
  T.currentEnrollmentId = enrollmentId;
  renderNoteChat();
  showView('noteChatView');
  setTimeout(() => { document.getElementById('noteChatInput')?.focus(); }, 0);
}

export function renderNoteChat() {
  const enrollment = T.enrollments.find(e => e.id === T.currentEnrollmentId);
  if (!enrollment) return;

  const name = enrollment.student_name || 'Unknown Student';
  const profile = Object.values(T.profiles).find(p => p.id === enrollment.teacher_profile_id);
  const contextLine = profile ? `${profile.course_name} · Block ${enrollment.block}` : '';

  document.getElementById('noteChatStudentName').textContent = name;
  document.getElementById('noteChatContext').textContent = contextLine;

  const msgs = document.getElementById('noteChatMessages');
  msgs.innerHTML = '';

  const notes = parseNotes(enrollment.teacher_notes);

  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 't-note-empty';
    empty.textContent = `No notes yet. Anything you write here about ${name} is private to you and shapes how Lumi works with them.`;
    msgs.appendChild(empty);
  } else {
    notes.forEach(note => {
      const bubble = document.createElement('div');
      bubble.className = 't-note-bubble';
      const when = note.timestamp ? new Date(note.timestamp) : null;
      if (when && !isNaN(when)) {
        const time = document.createElement('div');
        time.className = 't-note-time';
        time.textContent = when.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
        bubble.appendChild(time);
      }
      const text = document.createElement('div');
      text.textContent = note.text || '';
      bubble.appendChild(text);
      msgs.appendChild(bubble);
    });
    requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  }

  const input = document.getElementById('noteChatInput');
  const sendBtn = document.getElementById('noteChatSend');
  sendBtn.disabled = !(input.value || '').trim();
}

export async function sendNote() {
  const input = document.getElementById('noteChatInput');
  const sendBtn = document.getElementById('noteChatSend');
  const text = (input.value || '').trim();
  if (!text) return;
  const enrollment = T.enrollments.find(e => e.id === T.currentEnrollmentId);
  if (!enrollment) return;

  const notes = parseNotes(enrollment.teacher_notes);
  notes.push({ timestamp: new Date().toISOString(), text });
  const serialized = JSON.stringify(notes);

  input.disabled = true;
  sendBtn.disabled = true;

  let error = null;
  // PATCH authz is server-side (caller must own the linked class); a 404/403
  // throws in apiFetch and lands in the error toast below.
  try {
    const res = await patchEnrollmentNotes(enrollment.id, serialized);
    if (!res) error = new Error('enrollment not found (404)');
  } catch (err) { error = err; }

  input.disabled = false;

  if (error) {
    console.error('Save note failed:', error);
    showToast('Could not save note. Please try again.', 'error');
    sendBtn.disabled = !(input.value || '').trim();
    return;
  }

  enrollment.teacher_notes = serialized;
  input.value = '';
  sendBtn.disabled = true;
  renderNoteChat();
  input.focus();
}

export function noteChatBack() {
  showView('rosterView');
  renderRoster();
}

// Wire note chat input + send button (elements are in the DOM by the time this runs)
export function wireNoteChat() {
  const input = document.getElementById('noteChatInput');
  const sendBtn = document.getElementById('noteChatSend');
  if (!input || !sendBtn) return;
  input.addEventListener('input', () => {
    sendBtn.disabled = !(input.value || '').trim();
  });
  input.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      sendNote();
    }
  });
  sendBtn.addEventListener('click', sendNote);
}
