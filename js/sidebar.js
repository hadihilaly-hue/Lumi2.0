import { initScheduleSetup, renderHwSidebar, showWelcome } from '../app.js';
import { loadConv, lookupSubjectForCourse, openGeneralChat, openTutor } from './conversation.js';
import { SUBJECTS, getTeachers, searchCurriculum } from './data.js';
import { S, SB, messagesEl, sbNav, sbSearch } from './state.js';
import { deleteConvFromSupabase, genId, getConvs, getSchedule, saveConvs, saveCurrentConv, syncConvToSupabase } from './storage.js';
import { TEACHER_EMAIL_MAP, _profileCache, _profileStatusCache } from './teachers.js';
import { closeSidebar, escHtml } from './ui.js';


// ─── HISTORY MENU ────────────────────────────────────────────────────────────
let openMenuId = null;
export let activeDropdownEl = null;

export function closeOpenMenu() {
  if (activeDropdownEl) { activeDropdownEl.remove(); activeDropdownEl = null; }
  if (openMenuId) {
    const btn = document.querySelector(`.hist-menu-btn[data-id="${openMenuId}"]`);
    if (btn) btn.classList.remove('open');
    openMenuId = null;
  }
}

// ── Mobile long-press support ─────────────────────────────
export function addLongPress(el, callback, duration = 500) {
  let timer = null;
  let prevented = false;
  el.addEventListener('touchstart', e => {
    prevented = false;
    timer = setTimeout(() => {
      prevented = true;
      e.preventDefault();
      callback(e);
    }, duration);
  }, { passive: false });
  el.addEventListener('touchend', () => { clearTimeout(timer); });
  el.addEventListener('touchmove', () => { clearTimeout(timer); });
  el.addEventListener('touchcancel', () => { clearTimeout(timer); });
  // Prevent click after long press
  el.addEventListener('click', e => { if (prevented) { e.preventDefault(); e.stopPropagation(); } }, true);
}

// ── Inline confirmation popup ─────────────────────────────
let _activeInlineConfirm = null;

export function showInlineConfirm(anchorEl, text, onConfirm) {
  dismissInlineConfirm();
  const popup = document.createElement('div');
  popup.className = 'inline-confirm';
  popup.innerHTML = `
    <div class="inline-confirm-text">${text}</div>
    <div class="inline-confirm-btns">
      <button class="ic-cancel">Cancel</button>
      <button class="ic-delete">Delete</button>
    </div>`;
  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  document.body.appendChild(popup);
  _activeInlineConfirm = popup;

  popup.querySelector('.ic-cancel').addEventListener('click', e => { e.stopPropagation(); dismissInlineConfirm(); });
  popup.querySelector('.ic-delete').addEventListener('click', e => { e.stopPropagation(); dismissInlineConfirm(); onConfirm(); });

  // Dismiss on outside click (delayed so current click doesn't trigger)
  setTimeout(() => {
    const handler = e => { if (!popup.contains(e.target)) { dismissInlineConfirm(); document.removeEventListener('click', handler, true); } };
    document.addEventListener('click', handler, true);
    popup._outsideHandler = handler;
  }, 10);
}

function dismissInlineConfirm() {
  if (_activeInlineConfirm) {
    if (_activeInlineConfirm._outsideHandler) document.removeEventListener('click', _activeInlineConfirm._outsideHandler, true);
    _activeInlineConfirm.remove();
    _activeInlineConfirm = null;
  }
}

function openHistMenu(convId, menuBtn) {
  if (openMenuId === convId) { closeOpenMenu(); return; }
  closeOpenMenu();
  openMenuId = convId;
  menuBtn.classList.add('open');

  const dd = document.createElement('div');
  dd.className = 'hist-dropdown';
  activeDropdownEl = dd;

  const renameItem = document.createElement('div');
  renameItem.className = 'hist-dd-item';
  renameItem.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Rename`;
  renameItem.addEventListener('click', e => { e.stopPropagation(); closeOpenMenu(); startRename(convId); });

  const deleteItem = document.createElement('div');
  deleteItem.className = 'hist-dd-item danger';
  deleteItem.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg> Delete`;
  deleteItem.addEventListener('click', e => { e.stopPropagation(); closeOpenMenu(); deleteConv(convId, menuBtn); });

  dd.appendChild(renameItem);
  dd.appendChild(deleteItem);

  const rect = menuBtn.getBoundingClientRect();
  dd.style.top   = (rect.bottom + 4) + 'px';
  dd.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(dd);
}

function startRename(convId) {
  const titleEl = document.querySelector(`.hist-title[data-id="${convId}"]`);
  const itemEl  = titleEl?.closest('.hist-item');
  if (!titleEl || !itemEl) return;
  const convs = getConvs();
  const conv  = convs[convId];
  if (!conv) return;

  titleEl.classList.add('renaming');
  const inp = document.createElement('input');
  inp.className = 'hist-rename-input';
  inp.value = conv.title || conv.preview || '';
  inp.maxLength = 80;
  itemEl.insertBefore(inp, titleEl.nextSibling);
  inp.focus(); inp.select();

  const finish = () => {
    const newTitle = inp.value.trim();
    inp.remove();
    titleEl.classList.remove('renaming');
    if (newTitle) {
      const c2 = getConvs();
      if (c2[convId]) {
        c2[convId].title = newTitle;
        saveConvs(c2);
        syncConvToSupabase(convId);
        renderSidebar();
      }
    }
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { inp.value = ''; finish(); }
  });
}

function deleteConv(convId, anchorEl) {
  const doDelete = () => {
    // Animate out the sidebar item
    const itemEl = document.querySelector(`.hist-title[data-id="${convId}"]`)?.closest('.hist-item');
    if (itemEl) {
      itemEl.classList.add('item-removing');
      setTimeout(() => {
        const convs = getConvs();
        delete convs[convId];
        saveConvs(convs);
        deleteConvFromSupabase(convId);
        if (S.currentId === convId) {
          S.currentId = genId(); S.messages = []; S.exchangeCount = 0; S.tutorCtx = null;
          S.ready = false; S.values.clear(); S.goals.clear(); S.interests.clear();
          SB.mode = 'all'; SB.activeTeacher = null;
          messagesEl.innerHTML = '';
          showWelcome();
        }
        renderSidebar();
      }, 250);
    } else {
      const convs = getConvs();
      delete convs[convId];
      saveConvs(convs);
      deleteConvFromSupabase(convId);
      if (S.currentId === convId) {
        S.currentId = genId(); S.messages = []; S.exchangeCount = 0; S.tutorCtx = null;
        S.ready = false; S.values.clear(); S.goals.clear(); S.interests.clear();
        SB.mode = 'all'; SB.activeTeacher = null;
        messagesEl.innerHTML = '';
        showWelcome();
      }
      renderSidebar();
    }
  };

  if (anchorEl) {
    showInlineConfirm(anchorEl, "Delete this chat? This can't be undone.", doDelete);
  } else {
    doDelete();
  }
}

// ─── SEARCH DROPDOWN ─────────────────────────────────────────────────────────
export function clearSearch() {
  const input = document.getElementById('sbSearch');
  if (input) input.value = '';
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

export function renderSearchDropdown(query) {
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;

  if (!query) {
    dropdown.style.display = 'none';
    renderSidebar();
    return;
  }

  const results = searchCurriculum(query);

  dropdown.innerHTML = '';
  dropdown.style.display = 'block';

  if (results.length === 0) {
    dropdown.innerHTML = '<div class="sr-empty">No teachers or classes found</div>';
    renderSidebar();
    return;
  }

  // Group teacher-type results: teacher → [courses]
  const teacherMatches = {};  // teacher name → { courses: [] }
  // Group class-type results: course → { teachers: [] }
  const courseMatches  = {};

  results.forEach(r => {
    if (r.type === 'teacher') {
      if (!teacherMatches[r.teacher]) teacherMatches[r.teacher] = { courses: [] };
      if (!teacherMatches[r.teacher].courses.includes(r.course))
        teacherMatches[r.teacher].courses.push(r.course);
    } else {
      if (!courseMatches[r.course]) courseMatches[r.course] = { teachers: [] };
      r.teachers.forEach(t => {
        if (!courseMatches[r.course].teachers.includes(t))
          courseMatches[r.course].teachers.push(t);
      });
    }
  });

  const teacherEntries = Object.entries(teacherMatches);
  const courseEntries  = Object.entries(courseMatches);

  // ── Teachers section ──
  if (teacherEntries.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'sr-section-label';
    lbl.textContent = 'Teachers';
    dropdown.appendChild(lbl);

    teacherEntries.forEach(([name, { courses }]) => {
      const groupEl = document.createElement('div');
      const nameEl  = document.createElement('div');
      nameEl.className   = 'sr-group-name';
      nameEl.textContent = name;
      groupEl.appendChild(nameEl);

      courses.forEach(course => {
        const btn = document.createElement('button');
        btn.className = 'sr-result-item';
        btn.innerHTML = `<span class="sr-arrow">└──</span>${escHtml(course)}`;
        btn.addEventListener('click', () => {
          const { subjectId } = lookupSubjectForCourse(course);
          openTutor(subjectId, course, name);
          closeSidebar();
        });
        groupEl.appendChild(btn);
      });
      dropdown.appendChild(groupEl);
    });
  }

  // ── Classes section ──
  if (courseEntries.length > 0) {
    if (teacherEntries.length > 0) {
      const div = document.createElement('div');
      div.className = 'sr-divider';
      dropdown.appendChild(div);
    }
    const lbl = document.createElement('div');
    lbl.className = 'sr-section-label';
    lbl.textContent = 'Classes';
    dropdown.appendChild(lbl);

    courseEntries.forEach(([course, { teachers }]) => {
      const groupEl = document.createElement('div');
      const nameEl  = document.createElement('div');
      nameEl.className   = 'sr-group-name';
      nameEl.textContent = course;
      groupEl.appendChild(nameEl);

      teachers.forEach(teacher => {
        const btn = document.createElement('button');
        btn.className = 'sr-result-item';
        btn.innerHTML = `<span class="sr-arrow">└──</span>${escHtml(teacher)}`;
        btn.addEventListener('click', () => {
          const { subjectId } = lookupSubjectForCourse(course);
          openTutor(subjectId, course, teacher);
          closeSidebar();
        });
        groupEl.appendChild(btn);
      });
      dropdown.appendChild(groupEl);
    });
  }

  renderSidebar();
}

// ─── SIDEBAR RENDERING ───────────────────────────────────────────────────────
export function renderSidebar() {
  const query = sbSearch.value.toLowerCase().trim();
  sbNav.innerHTML = '';

  const schedule = getSchedule();

  // My Classes — first so the most-clicked nav lives above the fold.
  // Homework/Projects and Today follow below.
  if (schedule.length > 0) {
    const myHd = document.createElement('div');
    myHd.className = 'sb-section-label';
    myHd.textContent = 'My Classes';
    sbNav.appendChild(myHd);

    schedule.forEach(({ course, teacher, ready }) => {
      const email = TEACHER_EMAIL_MAP[teacher];
      const cachedProfile = email ? _profileCache[email + '__' + course] : null;
      const lastName = teacher ? teacher.split(' ').slice(-1)[0] : '';
      const sidebarName = cachedProfile?.title ? cachedProfile.title + ' ' + lastName : lastName;
      const isActive = SB.activeTeacher &&
        SB.activeTeacher.course === course &&
        SB.activeTeacher.teacher === teacher;
      // TM-3: in test mode, lock items whose teacher_profile is not
      // fully onboarded. Locked click routes to teacher.html for the
      // teacher to finish that profile; ready click opens a chat as
      // normal.
      const isLocked = S.isTestMode && ready === false;
      const item = document.createElement('div');
      item.className = 'sb-my-class-item'
        + (isActive ? ' active' : '')
        + (isLocked ? ' locked' : '');
      const name = document.createElement('span');
      name.className = 'sb-my-class-name';
      name.textContent = course;
      const tch = document.createElement('span');
      tch.className = 'sb-my-class-teacher';
      tch.textContent = isLocked ? 'Finish your profile to test' : sidebarName;
      item.appendChild(name);
      item.appendChild(tch);
      // The student-side profile-status badge is meaningless in test
      // mode (the lock state already signals readiness). Skip it.
      if (!S.isTestMode) {
        const profileStatus = _profileStatusCache[course + '::' + teacher];
        const badge = document.createElement('span');
        badge.className = 'sb-profile-badge ' + (profileStatus === 'ready' ? 'ready' : 'pending');
        badge.textContent = '';
        badge.dataset.tip = profileStatus === 'ready' ? 'Profile ready' : 'Profile pending';
        item.appendChild(badge);
      }
      item.addEventListener('click', () => {
        if (isLocked) {
          // Route back to teacher.html with the course preselected so
          // the wizard opens at Step 1 for completion. ?from=test-mode
          // is preserved for TM-4 to wire a "back to test mode" link
          // after onboarding completes.
          window.location.href = `teacher.html?course=${encodeURIComponent(course)}&from=test-mode`;
          return;
        }
        const { subjectId } = lookupSubjectForCourse(course);
        openTutor(subjectId, course, teacher);
        closeSidebar();
      });
      sbNav.appendChild(item);
    });

    // TM-3: when in test mode and zero classes are ready, surface a
    // small explanatory note. Visual styling lives in TM-4's banner
    // work — for TM-3 plain text via the existing .sb-empty class is
    // enough.
    if (S.isTestMode && !schedule.some(c => c.ready)) {
      const note = document.createElement('div');
      note.className = 'sb-empty';
      note.textContent = 'Complete a class profile to start testing.';
      sbNav.appendChild(note);
    }

    // "+ Add a class" is a student-onboarding affordance — hide in
    // test mode (the teacher's classes come from teacher_profiles,
    // not from the student schedule wizard).
    if (!S.isTestMode) {
      const addBtn = document.createElement('div');
      addBtn.className = 'sb-add-class';
      addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add a class`;
      addBtn.addEventListener('click', () => {
        initScheduleSetup(() => { renderSidebar(); }, getSchedule());
      });
      sbNav.appendChild(addBtn);
    }

    const divMid = document.createElement('div');
    divMid.className = 'sb-divider';
    sbNav.appendChild(divMid);
  }

  // Homework + Projects (rendered together by renderHwSidebar).
  if (schedule.length > 0) {
    renderHwSidebar(sbNav);
  }

  // Recents list — labeled "Today" in the sidebar to match the design
  const convs = getConvs();
  const allConvs = Object.values(convs).sort((a, b) => b.ts - a.ts);
  const filtered = query
    ? allConvs.filter(c => (c.title || c.preview || '').toLowerCase().includes(query))
    : allConvs;

  if (filtered.length > 0) {
    const recLabel = document.createElement('div');
    recLabel.className = 'sb-section-label';
    recLabel.textContent = query ? 'Matching chats' : 'Today';
    sbNav.appendChild(recLabel);

    filtered.forEach(conv => {
      const displayTitle = conv.title || conv.preview || 'Untitled';
      const isActive = conv.id === S.currentId;

      const item = document.createElement('div');
      item.className = 'hist-item' + (isActive ? ' active' : '');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'hist-title';
      titleSpan.dataset.id = conv.id;
      titleSpan.textContent = displayTitle;

      const menuBtn = document.createElement('button');
      menuBtn.className = 'hist-menu-btn';
      menuBtn.dataset.id = conv.id;
      menuBtn.title = 'Options';
      menuBtn.textContent = '···';

      item.appendChild(titleSpan);
      item.appendChild(menuBtn);

      item.addEventListener('click', e => {
        if (e.target === menuBtn || menuBtn.contains(e.target)) return;
        closeOpenMenu();
        saveCurrentConv();
        SB.activeTeacher = conv.tutorCtx
          ? { subjectId: conv.tutorCtx.subjectId, course: conv.tutorCtx.course, teacher: conv.tutorCtx.teacher }
          : null;
        SB.mode = conv.tutorCtx ? 'tutor' : 'general';
        loadConv(conv.id);
        closeSidebar();
      });

      menuBtn.addEventListener('click', e => { e.stopPropagation(); openHistMenu(conv.id, menuBtn); });
      addLongPress(item, () => openHistMenu(conv.id, menuBtn));
      sbNav.appendChild(item);
    });
  } else if (!query) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = 'No conversations yet';
    sbNav.appendChild(empty);
  }

  // General Chat button
  const genRow = document.createElement('div');
  genRow.className = 'sb-general' + (SB.mode === 'general' && !S.tutorCtx ? ' active' : '');
  genRow.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> General Chat`;
  genRow.addEventListener('click', () => { openGeneralChat(); closeSidebar(); });
  sbNav.appendChild(genRow);

  // When search is active, dropdown handles teacher/class results — skip subjects tree
  if (query) return;

  // Subjects — wrapped in "All Classes" toggle when a schedule exists
  const hasSchedule = schedule.length > 0;

  if (hasSchedule) {
    const allToggle = document.createElement('div');
    allToggle.className = 'sb-all-classes-toggle' + (SB.showAllClasses ? ' open' : '');
    allToggle.innerHTML = `
      <span class="sb-all-classes-icon">
        <svg viewBox="0 0 24 24" stroke-width="2" fill="none" stroke="currentColor" width="13" height="13"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </span>
      <span class="sb-all-classes-label">All Menlo Classes</span>
      <span class="sb-all-classes-arrow">
        <svg viewBox="0 0 24 24" stroke-width="2.5" fill="none" stroke="currentColor" width="11" height="11"><polyline points="9 18 15 12 9 6"/></svg>
      </span>`;
    allToggle.addEventListener('click', () => { SB.showAllClasses = !SB.showAllClasses; renderSidebar(); });
    sbNav.appendChild(allToggle);
    if (!SB.showAllClasses) return;
    const divSub = document.createElement('div');
    divSub.className = 'sb-divider';
    sbNav.appendChild(divSub);
  } else {
    const div = document.createElement('div');
    div.className = 'sb-divider';
    sbNav.appendChild(div);
  }

  const lbl = document.createElement('div');
  lbl.className = 'sb-section-label';
  lbl.textContent = 'Subjects';
  sbNav.appendChild(lbl);

  SUBJECTS.forEach(subject => {
    const isOpen = SB.expandedSubject === subject.id;
    const coursesToShow = subject.courses;

    const subjectEl = document.createElement('div');
    subjectEl.className = 'sb-subject' + (isOpen ? ' open' : '');

    const hd = document.createElement('div');
    hd.className = 'sb-subj-hd';
    hd.innerHTML = `<span style="flex:1">${escHtml(subject.name)}</span>
      <svg class="sb-subj-arrow" viewBox="0 0 24 24" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
    hd.addEventListener('click', () => {
      SB.expandedSubject = SB.expandedSubject === subject.id ? null : subject.id;
      SB.expandedCourse  = null;
      renderSidebar();
    });
    subjectEl.appendChild(hd);

    const coursesEl = document.createElement('div');
    coursesEl.className = 'sb-courses';

    coursesToShow.forEach(course => {
      const isCourseOpen = SB.expandedCourse === `${subject.id}::${course}`;
      const courseEl = document.createElement('div');
      courseEl.className = 'sb-course' + (isCourseOpen ? ' open' : '');

      const chd = document.createElement('div');
      chd.className = 'sb-course-hd';
      chd.innerHTML = `<span style="flex:1">${escHtml(course)}</span>
        <svg class="sb-course-arrow" viewBox="0 0 24 24" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
      chd.addEventListener('click', () => {
        const key = `${subject.id}::${course}`;
        SB.expandedCourse = SB.expandedCourse === key ? null : key;
        renderSidebar();
      });
      courseEl.appendChild(chd);

      const teachersEl = document.createElement('div');
      teachersEl.className = 'sb-teachers';
      getTeachers(subject.name, course).forEach(teacher => {
        const isActive = SB.activeTeacher &&
          SB.activeTeacher.subjectId === subject.id &&
          SB.activeTeacher.course === course &&
          SB.activeTeacher.teacher === teacher;
        const btn = document.createElement('button');
        btn.className = 'sb-teacher' + (isActive ? ' active' : '');
        btn.innerHTML = `<span class="sb-teacher-dot"></span>${escHtml(teacher)}`;
        btn.addEventListener('click', () => { openTutor(subject.id, course, teacher); closeSidebar(); });
        teachersEl.appendChild(btn);
      });
      courseEl.appendChild(teachersEl);
      coursesEl.appendChild(courseEl);
    });

    subjectEl.appendChild(coursesEl);
    sbNav.appendChild(subjectEl);
  });
}
