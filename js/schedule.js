import { MENLO_CURRICULUM } from './data.js';
import { getStudyStyle, saveStudyStyle, syncStudyStyleToSupabase } from './homework.js';
import { setSidebarUserSubtitle } from './prompts.js';
import { renderSidebar } from './sidebar.js';
import { $ } from './state.js';
import { getSchedule, saveScheduleLocal, syncScheduleToSupabase } from './storage.js';


// ─── SCHEDULE SETUP ──────────────────────────────────────────────────────────
// Grade-filtered course lists. Courses not listed show to all grades.
const GRADE_COURSES = {
  '9': [
    'English 1','Modern World History','Living Systems: Biology in Balance',
    'Integrated Geometry & Algebra','Analytic Geometry & Algebra','Analytic Geometry & Algebra (H)',
    'Algebra 2','Algebra 2 with Trig','Algebra 2 with Trig (H)',
    'CS1: Intro to Computer Science','Principles of Game Design',
    'Spanish 1','Spanish 2','French 1','French 2','Mandarin 1','Mandarin 2','Latin 1','Latin 2',
    'Mechanical & Electrical Engineering','Design',
  ],
  '10': [
    'English 2','US History','US History (H)','Chemistry','Chemistry (H)','Conceptual Physics','Physics 1',
    'Algebra 2','Algebra 2 with Trig','Algebra 2 with Trig (H)',
    'Precalculus','Introductory Calculus','Introductory Calculus (H)',
    'CS1: Intro to Computer Science','CS2: Data Structures & Algorithms (H)','Principles of Game Design',
    'Spanish 1','Spanish 2','Heritage Spanish 3','French 1','French 2','French 3',
    'Mandarin 1','Mandarin 2','Mandarin 3','Latin 1','Latin 2','Latin 3',
    'Mechanical & Electrical Engineering','Design',
  ],
  '11': [
    'Junior English Seminar','US History','US History (H)',
    'Chemistry (H)','Physics 1','Physics 2 (H)','Molecular Mechanisms in Biology',
    'Precalculus','Introductory Calculus','Introductory Calculus (H)',
    'Calculus','Advanced Calculus I (H)','Probability & Statistics (H)',
    'CS1: Intro to Computer Science','CS2: Data Structures & Algorithms (H)','Advanced Topics in CS (H)','Principles of Game Design',
    'Government & Politics (H)','Modern Europe (H)','Philosophy I','Psychology I','Economic Theory',
    'Spanish 2','Heritage Spanish 3','Heritage Spanish 4','Advanced Spanish (H)',
    'French 2','French 3','French 4','Advanced French (H)',
    'Mandarin 2','Mandarin 3','Mandarin 4','Advanced Mandarin (H)',
    'Latin 2','Latin 3','Latin 4','Advanced Latin (H)',
    'Mechanical & Electrical Engineering','Applied Science Research (H)','Sustainable Engineering',
  ],
  '12': [
    'Cafe Society','Contemporary World Literature','Creative Nonfiction Workshop (H)',
    'Dystopian Fiction & Film','East Asian Pop Culture','Fairy Tales','Global Mythologies',
    'Humanities I: Renaissances','Humanities II: Self-Portraits','Literature & Science',
    'Literature in the Age of AI','Literature of the American Wilderness (H)','Lyric & Lifeline',
    'Media & Cultural Studies (H)','Medicine & Narrative','Modernist Poetry Workshop (H)',
    'Novella Workshop (H)','On Being','Science Fiction & the Classics (H)',
    'Shakespeare Now (H)','5 Months, 4 Books','Argumentation & Communication (H)',
    'Government & Politics (H)','Modern Europe (H)','Philosophy I','Philosophy II',
    'Psychology I','Psychology II','Economic Theory','American Economic History',
    'Environmental & Development Economics','History of US Foreign Relations',
    'Ethnic Studies I','Ethnic Studies II','Gender Studies','Global Issues for Global Citizens',
    'In Gods We Trust','Comparative Legal Systems','Current Affairs & Civil Discourse',
    'Pursuit of Happiness','Sultans, Shahs, and Sovereigns','IP Capstone Seminar (H)',
    'Advanced Calculus I (H)','Advanced Calculus II (H)','Advanced Topics in Math (H)',
    'Probability & Statistics (H)','Advanced Topics in Statistics (H)',
    'Applied Statistics & Epidemiology','Intro to Applied Math & Data Science',
    'CS2: Data Structures & Algorithms (H)','Advanced Topics in CS (H)','Principles of Game Design',
    'Advanced Biology (H)','Advanced Chemistry (H)','Advanced Physics (H)',
    'Environmental Science','Anatomy & Physiology','Neuroscience','BioTech Research (H)',
    'Molecular Mechanisms in Biology','Physics 2 (H)',
    'Heritage Spanish 3','Heritage Spanish 4','Advanced Spanish (H)',
    'French 3','French 4','Advanced French (H)',
    'Mandarin 3','Mandarin 4','Mandarin 5','Advanced Mandarin (H)',
    'Latin 3','Latin 4','Advanced Latin (H)',
    'Applied Science Research (H)','Sustainable Engineering',
  ],
};

function getCoursesForGrade(grade) {
  const allowed = GRADE_COURSES[grade];
  if (!allowed) return MENLO_CURRICULUM; // show all if grade unknown
  const filtered = {};
  Object.entries(MENLO_CURRICULUM).forEach(([subject, courses]) => {
    const matching = {};
    Object.entries(courses).forEach(([course, teachers]) => {
      if (allowed.includes(course)) matching[course] = teachers;
    });
    if (Object.keys(matching).length) filtered[subject] = matching;
  });
  return filtered;
}

export function initScheduleSetup(onDone, prefill = []) {
  const el = $('schedSetup');
  el.classList.remove('hidden');
  el.style.display = '';

  // State
  let chosenGrade       = localStorage.getItem('lumi_grade') || null;
  const selectedClasses = new Set(prefill.map(p => p.course));
  const teacherChoices  = {};
  const blockChoices    = {};
  prefill.forEach(p => {
    teacherChoices[p.course] = p.teacher;
    if (p.block) blockChoices[p.course] = p.block;
  });
  let teacherIdx = 0;
  let blockIdx = 0;

  // Steps: 0=grade, 1=classes, 2=teachers, 3=block, 4=study-style, 5=confirm
  const stepEls = [$('ssStep1'), $('ssStep2'), $('ssStep3'), $('ssStepBlock'), $('ssStep4'), $('ssStep5')];

  function setStep(n) {
    stepEls.forEach((s, i) => s.classList.toggle('active', i === n));
    document.querySelectorAll('.sched-dot').forEach((d, i) => {
      d.classList.toggle('active', i === n);
      d.classList.toggle('done', i < n);
    });
    el.scrollTop = 0;
  }

  // ── Step 1: Grade ─────────────────────────────────────────────────────────
  if (chosenGrade) {
    const card = el.querySelector(`.sched-grade-card[data-grade="${chosenGrade}"]`);
    if (card) card.classList.add('selected');
  }

  el.querySelectorAll('.sched-grade-card').forEach(card => {
    card.addEventListener('click', () => {
      el.querySelectorAll('.sched-grade-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      chosenGrade = card.dataset.grade;
      // Remove any previously selected classes that aren't in new grade
      const allowed = getCoursesForGrade(chosenGrade);
      const allAllowed = Object.values(allowed).flatMap(c => Object.keys(c));
      [...selectedClasses].forEach(c => { if (!allAllowed.includes(c)) { selectedClasses.delete(c); delete teacherChoices[c]; delete blockChoices[c]; } });
      // Auto-advance after brief highlight
      setTimeout(() => { buildClassGrid(''); setStep(1); }, 180);
    });
  });

  // ── Step 2: Classes ───────────────────────────────────────────────────────
  function makePill(course) {
    const pill = document.createElement('div');
    pill.className = 'sched-class-pill' + (selectedClasses.has(course) ? ' selected' : '');
    pill.textContent = course;
    pill.addEventListener('click', () => {
      if (selectedClasses.has(course)) {
        selectedClasses.delete(course);
        delete teacherChoices[course];
        delete blockChoices[course];
        pill.classList.remove('selected');
      } else {
        selectedClasses.add(course);
        pill.classList.add('selected');
      }
      updateClassHint();
    });
    return pill;
  }

  function addSubjectSection(grid, subject, courses, isFirst) {
    const div = document.createElement('div');
    div.className = 'sched-subj-divider' + (isFirst ? ' first' : '');
    div.textContent = subject;
    grid.appendChild(div);
    courses.forEach(course => grid.appendChild(makePill(course)));
  }

  function buildClassGrid(filter) {
    const grid = $('ssClassGrid');
    grid.innerHTML = '';
    const q = (filter || '').toLowerCase().trim();

    // When searching, show everything across the full catalog
    if (q) {
      let first = true;
      Object.entries(MENLO_CURRICULUM).forEach(([subject, courses]) => {
        const matching = Object.keys(courses).filter(c =>
          c.toLowerCase().includes(q) || subject.toLowerCase().includes(q));
        if (!matching.length) return;
        addSubjectSection(grid, subject, matching, first);
        first = false;
      });
      if (!grid.children.length) {
        const empty = document.createElement('div');
        empty.className = 'sched-subj-divider first';
        empty.textContent = 'No classes found';
        grid.appendChild(empty);
      }
      return;
    }

    // No search — show grade-filtered classes, then "All Electives" section
    const gradeCurriculum = chosenGrade ? getCoursesForGrade(chosenGrade) : MENLO_CURRICULUM;
    const gradeCoursesSet = new Set(
      Object.values(gradeCurriculum).flatMap(c => Object.keys(c))
    );

    // Grade section
    let first = true;
    Object.entries(gradeCurriculum).forEach(([subject, courses]) => {
      const list = Object.keys(courses);
      if (!list.length) return;
      addSubjectSection(grid, subject, list, first);
      first = false;
    });

    // Electives divider + all remaining courses not already shown
    const electiveDivider = document.createElement('div');
    electiveDivider.className = 'sched-subj-divider sched-electives-hd';
    electiveDivider.textContent = 'All Electives';
    grid.appendChild(electiveDivider);

    const electivesToggle = document.createElement('div');
    electivesToggle.className = 'sched-electives-toggle';
    electivesToggle.textContent = 'Show all Menlo classes ▸';
    let expanded = false;

    const electivesBody = document.createElement('div');
    electivesBody.className = 'sched-electives-body';
    electivesBody.style.display = 'none';

    // Build full catalog minus grade-filtered ones
    Object.entries(MENLO_CURRICULUM).forEach(([subject, courses]) => {
      const electives = Object.keys(courses).filter(c => !gradeCoursesSet.has(c));
      if (!electives.length) return;
      const hdr = document.createElement('div');
      hdr.className = 'sched-subj-divider first';
      hdr.textContent = subject;
      electivesBody.appendChild(hdr);
      electives.forEach(course => electivesBody.appendChild(makePill(course)));
    });

    // Also add a search hint inside electives
    const searchHint = document.createElement('div');
    searchHint.className = 'sched-electives-search-hint';
    searchHint.textContent = '💡 Use the search bar above to find any class instantly';

    electivesToggle.addEventListener('click', () => {
      expanded = !expanded;
      electivesBody.style.display = expanded ? '' : 'none';
      electivesToggle.textContent = expanded ? 'Hide ▾' : 'Show all Menlo classes ▸';
    });

    grid.appendChild(electivesToggle);
    grid.appendChild(searchHint);
    grid.appendChild(electivesBody);
  }

  function updateClassHint() {
    const n = selectedClasses.size;
    $('ssSelectionHint').textContent = n === 0
      ? 'Tap your classes to select them'
      : `${n} class${n !== 1 ? 'es' : ''} selected`;
    $('ssStep2Next').disabled = n === 0;
  }

  buildClassGrid('');
  updateClassHint();

  $('ssClassSearch').addEventListener('input', function() { buildClassGrid(this.value); });

  $('ssStep2Back').addEventListener('click', () => setStep(0));

  $('ssStep2Next').addEventListener('click', () => {
    teacherIdx = 0;
    showTeacherStep();
    setStep(2);
  });

  // ── Step 3: Teachers ──────────────────────────────────────────────────────
  function getSelectedArray() { return [...selectedClasses]; }

  function showTeacherStep() {
    const arr = getSelectedArray();
    if (teacherIdx >= arr.length) {
      blockIdx = 0;
      showBlockStep();
      setStep(3);
      return;
    }
    const course = arr[teacherIdx];
    $('ssTeacherProg').textContent   = `${course} — ${teacherIdx + 1} of ${arr.length} classes`;
    $('ssTeacherCourseName').textContent = '';

    let teachers = [];
    for (const [, courses] of Object.entries(MENLO_CURRICULUM)) {
      if (courses[course]) { teachers = courses[course]; break; }
    }

    // If only one teacher, skip and auto-advance
    if (teachers.length === 1) {
      teacherChoices[course] = teachers[0];
      teacherIdx++;
      showTeacherStep();
      return;
    }

    const grid = $('ssTeacherGrid');
    grid.innerHTML = '';
    teachers.forEach(t => {
      const card = document.createElement('div');
      card.className = 'sched-teacher-card' + (teacherChoices[course] === t ? ' selected' : '');
      card.textContent = t.split(' ').slice(-1)[0]; // last name only for compact display
      card.title = t;
      card.addEventListener('click', () => {
        grid.querySelectorAll('.sched-teacher-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        teacherChoices[course] = t;
        setTimeout(() => { teacherIdx++; showTeacherStep(); }, 200);
      });
      grid.appendChild(card);
    });
  }

  $('ssStep3Back').addEventListener('click', () => {
    if (teacherIdx === 0) {
      buildClassGrid($('ssClassSearch').value);
      updateClassHint();
      setStep(1);
    } else {
      teacherIdx--;
      showTeacherStep();
    }
  });

  // ── Step 4: Block (A–G section) ───────────────────────────────────────────
  function showBlockStep() {
    const arr = getSelectedArray();
    if (blockIdx >= arr.length) {
      showStyleStep();
      setStep(4);
      return;
    }
    const course = arr[blockIdx];
    const teacher = teacherChoices[course] || '';
    $('ssBlockProg').textContent = `${course} — ${blockIdx + 1} of ${arr.length} classes`;
    $('ssBlockCourseName').textContent = course;
    $('ssBlockTeacherName').textContent = teacher.split(' ').slice(-1)[0];

    const grid = $('ssBlockGrid');
    grid.innerHTML = '';
    ['A','B','C','D','E','F','G'].forEach(letter => {
      const card = document.createElement('div');
      card.className = 'sched-block-card' + (blockChoices[course] === letter ? ' selected' : '');
      card.textContent = letter;
      card.addEventListener('click', () => {
        grid.querySelectorAll('.sched-block-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        blockChoices[course] = letter;
        setTimeout(() => { blockIdx++; showBlockStep(); }, 200);
      });
      grid.appendChild(card);
    });
  }

  $('ssStepBlockBack').addEventListener('click', () => {
    if (blockIdx === 0) {
      teacherIdx = Math.max(0, getSelectedArray().length - 1);
      showTeacherStep();
      setStep(2);
    } else {
      blockIdx--;
      showBlockStep();
    }
  });

  // ── Step 5: Confirm ───────────────────────────────────────────────────────
  function buildConfirmList() {
    const list = $('ssConfirmList');
    list.innerHTML = '';
    getSelectedArray().forEach(course => {
      const teacher = teacherChoices[course] || '—';
      const block = blockChoices[course] || '';
      const lastName = teacher.split(' ').slice(-1)[0];
      const item = document.createElement('div');
      item.className = 'sched-confirm-item';
      const c = document.createElement('span');
      c.className = 'sched-confirm-course';
      c.textContent = course;
      const t = document.createElement('span');
      t.className = 'sched-confirm-teacher';
      t.textContent = block ? `${lastName} · ${block}` : lastName;
      item.appendChild(c);
      item.appendChild(t);
      list.appendChild(item);
    });
  }

  $('ssStep4Back').addEventListener('click', () => {
    blockIdx = Math.max(0, getSelectedArray().length - 1);
    showBlockStep();
    setStep(3);
  });

  // ── Step 4: Study Style ──────────────────────────────────
  let chosenStyle = getStudyStyle();

  function showStyleStep() {
    // Pre-select saved style
    $('ssStyleGrid').querySelectorAll('.sched-style-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.label === chosenStyle.label);
    });
    const isCustom = chosenStyle.label === 'Custom';
    $('ssStyleCustom').style.display = isCustom ? '' : 'none';
    if (isCustom) {
      $('ssWorkSlider').value = chosenStyle.work_minutes;
      $('ssBreakSlider').value = chosenStyle.break_minutes;
      $('ssWorkVal').textContent = chosenStyle.work_minutes;
      $('ssBreakVal').textContent = chosenStyle.break_minutes;
    }
    $('ssStep4Next').disabled = false; // always pre-enabled (default style exists)
  }

  $('ssStyleGrid').querySelectorAll('.sched-style-card').forEach(card => {
    card.addEventListener('click', () => {
      $('ssStyleGrid').querySelectorAll('.sched-style-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const isCustom = card.dataset.work === 'custom';
      $('ssStyleCustom').style.display = isCustom ? '' : 'none';
      if (!isCustom) {
        chosenStyle = {
          work_minutes: parseInt(card.dataset.work, 10),
          break_minutes: parseInt(card.dataset.break, 10),
          label: card.dataset.label
        };
      } else {
        chosenStyle = {
          work_minutes: parseInt($('ssWorkSlider').value, 10),
          break_minutes: parseInt($('ssBreakSlider').value, 10),
          label: 'Custom'
        };
      }
      $('ssStep4Next').disabled = false;
    });
  });

  $('ssWorkSlider').addEventListener('input', function() {
    $('ssWorkVal').textContent = this.value;
    chosenStyle = { work_minutes: parseInt(this.value, 10), break_minutes: parseInt($('ssBreakSlider').value, 10), label: 'Custom' };
  });

  $('ssBreakSlider').addEventListener('input', function() {
    $('ssBreakVal').textContent = this.value;
    chosenStyle = { work_minutes: parseInt($('ssWorkSlider').value, 10), break_minutes: parseInt(this.value, 10), label: 'Custom' };
  });

  $('ssStep4Next').addEventListener('click', () => {
    buildConfirmList();
    setStep(5);
  });

  $('ssStep5Back').addEventListener('click', () => {
    setStep(4);
  });

  $('ssStep5Done').addEventListener('click', () => {
    const schedule = getSelectedArray().map(course => {
      const subject = Object.entries(MENLO_CURRICULUM)
        .find(([, courses]) => courses[course])?.[0] || '';
      return {
        course,
        teacher: teacherChoices[course] || '',
        subject,
        block: blockChoices[course] || '',
      };
    });
    saveScheduleLocal(schedule);
    if (chosenGrade) localStorage.setItem('lumi_grade', chosenGrade);
    setSidebarUserSubtitle();
    saveStudyStyle(chosenStyle);
    syncScheduleToSupabase(schedule);
    syncStudyStyleToSupabase(chosenStyle);
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; onDone(); }, 350);
  });

  setStep(0);
}

// ─── SEMESTER BANNER ─────────────────────────────────────────────────────────
export function checkSemesterBanner() {
  const existing = document.getElementById('semesterBanner');
  if (existing) existing.remove();

  // Don't show if no schedule set yet
  if (!getSchedule().length) return;

  const now = new Date();
  const m = now.getMonth() + 1; // 1-12
  const d = now.getDate();

  // Check dismiss (within 30 days)
  const dismissed = localStorage.getItem('lumi_banner_dismissed');
  if (dismissed && (Date.now() - parseInt(dismissed, 10)) < 30 * 24 * 60 * 60 * 1000) return;

  let type = null, icon = '', text = '', dismissLabel = 'Dismiss';

  // Add/drop window (more specific) takes priority
  if ((m === 9 && d >= 1 && d <= 14) || (m === 2 && d >= 1 && d <= 14)) {
    type = 'add-drop'; icon = '📋';
    text = 'Add/drop period is open — did your schedule change?';
    dismissLabel = 'No changes';
  } else if ((m === 8 && d >= 1) || m === 9 || m === 1 || (m === 2 && d <= 15)) {
    type = 'new-sem'; icon = '🎒';
    text = 'New semester starting — is your schedule still accurate?';
  }

  if (!type) return;

  const banner = document.createElement('div');
  banner.id = 'semesterBanner';
  banner.className = `semester-banner ${type}`;
  banner.innerHTML = `
    <div class="semester-banner-text">${icon} ${text}</div>
    <div class="semester-banner-btns">
      <button class="semester-banner-btn primary" id="bannerUpdate">Update Schedule</button>
      <button class="semester-banner-btn ghost" id="bannerDismiss">${dismissLabel}</button>
    </div>`;

  const main = document.querySelector('.main');
  if (main) main.insertBefore(banner, main.firstChild);

  document.getElementById('bannerUpdate').addEventListener('click', () => {
    banner.remove();
    initScheduleSetup(() => { renderSidebar(); }, getSchedule());
  });
  document.getElementById('bannerDismiss').addEventListener('click', () => {
    localStorage.setItem('lumi_banner_dismissed', Date.now().toString());
    banner.remove();
  });
}
