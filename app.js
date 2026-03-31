// ─── AUTH GUARD ───────────────────────────────────────────────────────────────
// Runs immediately; if not authenticated the page redirects and nothing else loads
let currentUser = null;

(async () => {
  const user = await requireAuth();
  if (!user) return; // redirect already triggered
  currentUser = user;

  // Hide auth loading screen and show the app
  document.getElementById('authLoading').style.display = 'none';

  // Populate user info (settings drawer + sidebar chip)
  const meta      = currentUser.user_metadata || {};
  const fullName  = meta.full_name || meta.name || 'Student';
  const email     = currentUser.email || '';
  const initials  = fullName[0].toUpperCase();

  // Settings drawer
  document.getElementById('userName').textContent  = fullName;
  document.getElementById('userEmail').textContent = email;
  const avatarEl = document.getElementById('userAvatar');
  if (meta.avatar_url) {
    const img = document.createElement('img'); img.src = meta.avatar_url; img.alt = '';
    avatarEl.appendChild(img);
  } else { avatarEl.textContent = initials; }

  // Sidebar user chip
  document.getElementById('sbUserName').textContent  = fullName;
  document.getElementById('sbUserEmail').textContent = email;
  const sbAvatarEl = document.getElementById('sbUserAvatar');
  if (meta.avatar_url) {
    const img2 = document.createElement('img'); img2.src = meta.avatar_url; img2.alt = '';
    sbAvatarEl.appendChild(img2);
  } else { sbAvatarEl.textContent = initials; }

  // Load profile from Supabase if this is a new device
  await loadProfileFromSupabase();
  // Load conversations from Supabase if localStorage is empty
  if (!localStorage.getItem('lumi_convs')) await loadConvsFromSupabase();

  // Boot the app
  init();
})();

// ─── CURRICULUM DATA ──────────────────────────────────────────────────────────
const MENLO_CURRICULUM = {
  "English": {
    "English 1": ["Rachel Blumenthal","Whitney Newton","Margaret Ramsey","Andrew Warren"],
    "English 2": ["Jay Bush","Lily Chan","Rebecca Gertmenian","Meghann Schroers-Martin"],
    "Junior English Seminar": ["Tom Garvey","Oscar King","Maura Sincoff","Lily Chan","Cara Plamondon"],
    "Cafe Society": ["Bridgett Longust"],
    "Contemporary World Literature": ["Lily Chan"],
    "Creative Nonfiction Workshop (H)": ["Whitney Newton"],
    "Dystopian Fiction & Film": ["Cara Plamondon"],
    "East Asian Pop Culture": ["Oscar King"],
    "Fairy Tales": ["Oscar King"],
    "Global Mythologies": ["Jay Bush"],
    "Humanities I: Renaissances": ["Rebecca Gertmenian"],
    "Humanities II: Self-Portraits": ["Rebecca Gertmenian"],
    "Literature & Science": ["Andrew Warren"],
    "Literature in the Age of AI": ["Rachel Blumenthal"],
    "Literature of the American Wilderness (H)": ["Whitney Newton"],
    "Lyric & Lifeline": ["Margaret Ramsey"],
    "Media & Cultural Studies (H)": ["Oscar King"],
    "Medicine & Narrative": ["Rachel Blumenthal"],
    "Modernist Poetry Workshop (H)": ["Jay Bush"],
    "Novella Workshop (H)": ["Oscar King"],
    "On Being": ["Margaret Ramsey"],
    "Science Fiction & the Classics (H)": ["Tom Garvey"],
    "Shakespeare Now (H)": ["Andrew Warren"],
    "5 Months, 4 Books": ["Cara Plamondon"],
    "Argumentation & Communication (H)": ["Maura Sincoff"]
  },
  "History & Social Sciences": {
    "Modern World History": ["Sabahat Adil","Franco Cruz-Ochoa","Katharine Hanson","Nicholas Merlesena"],
    "US History": ["Miles Bennett-Smith","Glenn Davis","Trevor McNeil","Nicholas Merlesena","Joseph Mitchell"],
    "US History (H)": ["Glenn Davis","Trevor McNeil","Nicholas Merlesena","Joseph Mitchell"],
    "Government & Politics (H)": ["Miles Bennett-Smith","Joseph Mitchell","Matthew Nelson"],
    "Modern Europe (H)": ["Katharine Hanson"],
    "Philosophy I": ["Jack Bowen"],
    "Philosophy II": ["Jack Bowen"],
    "Psychology I": ["Dylan Citrin Cummins","Joseph Mitchell"],
    "Psychology II": ["Dylan Citrin Cummins","Joseph Mitchell"],
    "Economic Theory": ["Charles Hanson"],
    "American Economic History": ["Charles Hanson"],
    "Environmental & Development Economics": ["Charles Hanson"],
    "History of US Foreign Relations": ["Charles Hanson"],
    "Ethnic Studies I": ["Glenn Davis"],
    "Ethnic Studies II": ["Glenn Davis"],
    "Gender Studies": ["Matthew Nelson"],
    "Global Issues for Global Citizens": ["Matthew Nelson"],
    "In Gods We Trust": ["Matthew Nelson"],
    "Comparative Legal Systems": ["Trevor McNeil"],
    "Current Affairs & Civil Discourse": ["John Schafer"],
    "Pursuit of Happiness": ["Peter Brown"],
    "Sultans, Shahs, and Sovereigns": ["Sabahat Adil"],
    "Humanities I: Renaissances": ["Rebecca Gertmenian"],
    "Humanities II: Self-Portraits": ["Rebecca Gertmenian"],
    "IP Capstone Seminar (H)": ["Peter Brown","Matthew Nelson"]
  },
  "Math": {
    "Integrated Geometry & Algebra": ["Christine Walters"],
    "Analytic Geometry & Algebra": ["Rebecca Akers","Joe Rabison"],
    "Analytic Geometry & Algebra (H)": ["Sujata Ganpule"],
    "Algebra 2": ["Randall Joss","Nandhini Namasivayam"],
    "Algebra 2 with Trig": ["Rebecca Akers","Jacqueline Arreaga"],
    "Algebra 2 with Trig (H)": ["Danielle Jensen"],
    "Precalculus": ["Yu-Loung Chang","Christine Walters"],
    "Introductory Calculus": ["Jacqueline Arreaga","Dave Lowell"],
    "Introductory Calculus (H)": ["Reeve Garrett"],
    "Calculus": ["Jude Loeffler"],
    "Advanced Calculus I (H)": ["Sujata Ganpule","Dave Lowell"],
    "Advanced Calculus II (H)": ["Yu-Loung Chang","Reeve Garrett"],
    "Advanced Topics in Math (H)": ["Reeve Garrett"],
    "Probability & Statistics (H)": ["Dennis Millstein"],
    "Advanced Topics in Statistics (H)": ["Dennis Millstein"],
    "Applied Statistics & Epidemiology": ["Dennis Millstein"],
    "Intro to Applied Math & Data Science": ["Jude Loeffler"]
  },
  "Computer Science": {
    "CS1: Intro to Computer Science": ["Douglas Kiang","Nandhini Namasivayam"],
    "CS2: Data Structures & Algorithms (H)": ["Nandhini Namasivayam"],
    "Advanced Topics in CS (H)": ["Zachary Blickensderfer"],
    "Principles of Game Design": ["Douglas Kiang"]
  },
  "Science": {
    "Living Systems: Biology in Balance": ["Chrissy Orangio"],
    "Chemistry": ["Laura Huntley","Mary McKenna"],
    "Chemistry (H)": ["Zachary Eagleton","Eugenia McCauley"],
    "Conceptual Physics": ["Zachary Eagleton"],
    "Physics 1": ["Nina Arnberg","Laura Huntley","Zane Moore","Matthew Varvir"],
    "Physics 2 (H)": ["Matthew Varvir"],
    "Molecular Mechanisms in Biology": ["Nina Arnberg","Todd Hardie","Cristina Weaver"],
    "Advanced Biology (H)": ["Tatyana Buxton"],
    "Advanced Chemistry (H)": ["Eugenia McCauley"],
    "Advanced Physics (H)": ["James Dann"],
    "Environmental Science": ["Chrissy Orangio"],
    "Anatomy & Physiology": ["Todd Hardie"],
    "Neuroscience": ["Cristina Weaver"],
    "BioTech Research (H)": ["Tatyana Buxton"]
  },
  "Applied Science & Engineering": {
    "Mechanical & Electrical Engineering": ["James Formato","Leo Jaimez"],
    "Applied Science Research (H)": ["James Dann"],
    "Sustainable Engineering": ["James Dann"],
    "Design": ["James Formato"]
  },
  "World Language": {
    "Spanish 1": ["Janet Tennyson"],
    "Spanish 2": ["Janet Tennyson","Adolfo Guevara"],
    "Heritage Spanish 3": ["Perla Amaral"],
    "Heritage Spanish 4": ["Perla Amaral"],
    "Advanced Spanish (H)": ["Patricia Frias"],
    "French 1": ["Marie Sajja"],
    "French 2": ["Corinne Chung"],
    "French 3": ["Marie Sajja"],
    "French 4": ["Corinne Chung"],
    "Advanced French (H)": ["Corinne Chung"],
    "Mandarin 1": ["Rita Yeh"],
    "Mandarin 2": ["Rita Yeh"],
    "Mandarin 3": ["Mingjung Chen"],
    "Mandarin 4": ["Rita Yeh"],
    "Mandarin 5": ["Mingjung Chen"],
    "Advanced Mandarin (H)": ["Mingjung Chen"],
    "Latin 1": ["Tom Garvey"],
    "Latin 2": ["Jennifer Jordt"],
    "Latin 3": ["Jennifer Jordt"],
    "Latin 4": ["Jennifer Jordt"],
    "Advanced Latin (H)": ["Tom Garvey","Jennifer Jordt"]
  }
};

const SUBJECT_IDS = {
  "English": "english",
  "History & Social Sciences": "history",
  "Math": "math",
  "Computer Science": "cs",
  "Science": "science",
  "Applied Science & Engineering": "applied",
  "World Language": "language"
};
const SUBJECTS = Object.entries(MENLO_CURRICULUM).map(([name, courses]) => ({
  id: SUBJECT_IDS[name] || name.toLowerCase().replace(/\s+/g,'-'),
  name,
  courses: Object.keys(courses)
}));

function getTeachers(subjectName, course) {
  return (MENLO_CURRICULUM[subjectName] && MENLO_CURRICULUM[subjectName][course]) || [];
}

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
function getStudentName() { return localStorage.getItem('lumi_name') || 'there'; }
function getStudentGrade() { return localStorage.getItem('lumi_grade') || null; }
function studentCtx() {
  const name  = localStorage.getItem('lumi_name');
  const grade = localStorage.getItem('lumi_grade');
  if (name && grade) return `The student's name is ${name} and they are in grade ${grade} at Menlo School.`;
  if (name) return `The student's name is ${name} and they attend Menlo School.`;
  return 'The student attends Menlo School.';
}

function buildCompanionSystem() {
  return `You are Lumi — not an assistant, but a warm and genuinely curious companion who cares deeply about the people you talk with.

${studentCtx()}

Your personality:
- Think of yourself as that rare friend who truly listens, remembers, and makes people feel seen
- You're unhurried, warm, and non-judgmental. Never clinical or performatively upbeat.
- You pick up on what matters to people from how they talk, not just the words
- You remember everything within our conversation and weave it back in naturally

Response length:
- MAX 1-2 sentences for casual messages. Hard limit.
- Match the length of what the person sent.
- No filler, no affirmations. You are texting a friend.

Every 2–3 messages, weave in one organic question to understand them better.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things. Empty arrays if nothing new.
NEVER mention the JSON.`;
}

function buildTutorSystem(subject, course, teacher) {
  return `You are tutoring a Menlo School student in ${course}. You are helping them in the style of ${teacher}, a real teacher at Menlo School. Be helpful, specific to this subject, and calibrated to high school level.

${studentCtx()}

Your tutoring style:
- Warm, encouraging, and patient — you believe every student can succeed
- Ask guiding questions rather than just giving answers
- Break down complex concepts step by step
- Connect new ideas to things the student already understands
- Give specific, actionable feedback

Response length: Keep it SHORT — 1-3 sentences for simple questions. Go longer only when a concept genuinely needs it. No essays.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things about the student (academic interests, learning goals, strengths). Empty arrays if nothing new.
NEVER mention the JSON.`;
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const S = {
  currentId:     null,
  messages:      [],
  values:        new Set(),
  goals:         new Set(),
  interests:     new Set(),
  exchangeCount: 0,
  ready:         false,
  busy:          false,
  tutorCtx:      null,   // { subjectId, subjectName, course, teacher } or null
};

const SB = {
  mode:            'all',   // 'all' | 'general' | 'tutor'
  expandedSubject: null,
  expandedCourse:  null,
  activeTeacher:   null,
};

// ─── ELEMENTS ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messagesEl    = $('messages');
const msgInput      = $('msgInput');
const sendBtn       = $('sendBtn');
const toast         = $('toast');
const attachPreview = $('attachPreview');
const fileInput     = $('fileInput');
const sbNav         = $('sbNav');
const sbSearch      = $('sbSearch');
const themeToggle   = $('themeToggle');
const keyInput      = $('keyInput');

let pendingAttachment = null;

// ─── SUPABASE SYNC ────────────────────────────────────────────────────────────

// Helper: look up subjectId + subjectName for a given course name
function lookupSubjectForCourse(courseName) {
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

// Load all conversations from Supabase into localStorage (called once on fresh device)
async function loadConvsFromSupabase() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb
      .from('conversations')
      .select('id, title, messages, teacher, course, created_at, updated_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error || !data || !data.length) return;

    const convs = {};
    data.forEach(row => {
      const msgs = row.messages || [];
      // Derive preview from first user message
      const firstUser = msgs.find(m => m.role === 'user');
      const preview   = typeof firstUser?.content === 'string'
        ? firstUser.content.slice(0, 60)
        : (Array.isArray(firstUser?.content)
            ? (firstUser.content.find(p => p.type === 'text')?.text || '').slice(0, 60)
            : '');
      // Count exchanges from message pairs
      const exchangeCount = msgs.filter(m => m.role === 'assistant').length;
      // Reconstruct tutorCtx from teacher/course columns
      const tutorCtx = row.teacher && row.course
        ? { ...lookupSubjectForCourse(row.course), course: row.course, teacher: row.teacher }
        : null;

      // Use Supabase UUID as both local ID and sbId
      const localId = 'sb_' + row.id.replace(/-/g, '').slice(0, 16);
      convs[localId] = {
        id:           localId,
        sbId:         row.id,
        ts:           new Date(row.created_at).getTime(),
        title:        row.title || null,
        preview:      preview || 'Chat',
        messages:     msgs,
        values:       [],
        goals:        [],
        interests:    [],
        exchangeCount,
        tutorCtx,
      };
    });
    saveConvs(convs);
  } catch (err) {
    console.warn('Supabase conversation load failed (using localStorage):', err);
  }
}

// Sync a single conversation to Supabase — INSERT first time, UPDATE after
function syncConvToSupabase(convId) {
  if (!currentUser) return;
  _doSyncConv(convId).catch(err => console.warn('Supabase conv sync:', err));
}

async function _doSyncConv(convId) {
  const convs = getConvs();
  const conv  = convs[convId];
  if (!conv || !conv.messages.length) return;

  const row = {
    user_id:    currentUser.id,
    title:      conv.title   || null,
    messages:   conv.messages,
    teacher:    conv.tutorCtx?.teacher || null,
    course:     conv.tutorCtx?.course  || null,
    updated_at: new Date().toISOString(),
  };

  if (conv.sbId) {
    // Already exists in Supabase — update
    const { error } = await sb
      .from('conversations')
      .update(row)
      .eq('id', conv.sbId)
      .eq('user_id', currentUser.id);
    if (error) console.warn('Supabase update error:', error);
  } else {
    // New conversation — insert and capture the UUID
    const { data, error } = await sb
      .from('conversations')
      .insert(row)
      .select('id')
      .single();
    if (error) { console.warn('Supabase insert error:', error); return; }
    if (data?.id) {
      // Store sbId back into local storage
      const c2 = getConvs();
      if (c2[convId]) { c2[convId].sbId = data.id; saveConvs(c2); }
    }
  }
}

// Delete a conversation from Supabase by its sbId
function deleteConvFromSupabase(convId) {
  if (!currentUser) return;
  const convs = getConvs();
  const sbId  = convs[convId]?.sbId;
  if (!sbId) return;
  sb.from('conversations')
    .delete()
    .eq('id', sbId)
    .eq('user_id', currentUser.id)
    .then(({ error }) => { if (error) console.warn('Supabase delete error:', error); });
}

// Sync user profile (name, grade, accumulated values) to Supabase
function syncProfileToSupabase() {
  if (!currentUser) return;
  const name  = localStorage.getItem('lumi_name');
  const grade = localStorage.getItem('lumi_grade');
  const values_profile = {
    values:    [...S.values],
    goals:     [...S.goals],
    interests: [...S.interests],
  };
  sb.from('profiles').upsert({
    id:             currentUser.id,
    name:           name  || null,
    grade:          grade || null,
    values_profile,
  }, { onConflict: 'id' })
    .then(({ error }) => { if (error) console.warn('Supabase profile sync error:', error); });
}

// Load profile from Supabase on new device (only if localStorage has no name)
async function loadProfileFromSupabase() {
  if (!currentUser) return;
  const hasName = !!localStorage.getItem('lumi_name');
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('name, grade, values_profile')
      .eq('id', currentUser.id)
      .single();
    if (error || !data) return;
    // Always restore name/grade (overwrite if Supabase is newer)
    if (!hasName && data.name)  localStorage.setItem('lumi_name',  data.name);
    if (!hasName && data.grade) localStorage.setItem('lumi_grade', data.grade);
    // Seed global values/goals/interests from profile (loaded conv will override for current session)
    if (data.values_profile) {
      const vp = data.values_profile;
      (vp.values    || []).forEach(v => S.values.add(v));
      (vp.goals     || []).forEach(g => S.goals.add(g));
      (vp.interests || []).forEach(i => S.interests.add(i));
    }
  } catch (err) {
    console.warn('Supabase profile load failed:', err);
  }
}

// ─── CONVERSATION STORAGE ─────────────────────────────────────────────────────
function genId() { return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2,5); }
function getConvs() { try { return JSON.parse(localStorage.getItem('lumi_convs') || '{}'); } catch { return {}; } }
function saveConvs(c) { localStorage.setItem('lumi_convs', JSON.stringify(c)); }

function saveCurrentConv() {
  if (!S.currentId) return;
  if (!S.messages.length) return;
  const convs   = getConvs();
  const existing = convs[S.currentId] || {};
  const firstUserMsg = S.messages.find(m => m.role === 'user');
  const previewText  = typeof firstUserMsg?.content === 'string'
    ? firstUserMsg.content
    : (Array.isArray(firstUserMsg?.content)
        ? (firstUserMsg.content.find(p => p.type === 'text')?.text || '')
        : '');
  convs[S.currentId] = {
    id:           S.currentId,
    sbId:         existing.sbId || null,    // preserve Supabase UUID across saves
    ts:           existing.ts || Date.now(),
    title:        existing.title || null,
    preview:      previewText.slice(0, 60) || 'New chat',
    messages:     S.messages,
    values:       [...S.values],
    goals:        [...S.goals],
    interests:    [...S.interests],
    exchangeCount: S.exchangeCount,
    tutorCtx:     S.tutorCtx,
  };
  // Cap at 50 conversations — remove oldest
  const keys = Object.keys(convs).sort((a, b) => convs[a].ts - convs[b].ts);
  if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete convs[k]);
  saveConvs(convs);
  localStorage.setItem('lumi_current', S.currentId);
  syncConvToSupabase(S.currentId);
}

function migrateOldData() {
  if (localStorage.getItem('lumi_convs')) return;
  const old = localStorage.getItem('lumi_data');
  if (!old) return;
  try {
    const data = JSON.parse(old);
    if (!data.messages?.length) return;
    const id = genId();
    const convs = {};
    convs[id] = {
      id, ts: Date.now(),
      preview: data.messages.find(m => m.role === 'user')?.content?.slice(0, 55) || 'Chat',
      messages: data.messages,
      values: data.values || [], goals: data.goals || [], interests: data.interests || [],
      exchangeCount: data.exchangeCount || 0, tutorCtx: null,
    };
    saveConvs(convs);
    localStorage.setItem('lumi_current', id);
    localStorage.removeItem('lumi_data');
  } catch {}
}

// ─── LOAD A CONVERSATION ──────────────────────────────────────────────────────
function loadConv(id) {
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
}

// ─── NEW CHAT ─────────────────────────────────────────────────────────────────
function newChat() {
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
  if (localStorage.getItem('lumi_key')) startLumi();
}

// ─── OPEN TUTOR SESSION ───────────────────────────────────────────────────────
function openTutor(subjectId, course, teacher) {
  saveCurrentConv();
  const subjectName = SUBJECTS.find(s => s.id === subjectId)?.name || subjectId;
  S.currentId     = genId();
  S.messages      = [];
  S.exchangeCount = 0;
  S.tutorCtx      = { subjectId, subjectName, course, teacher };
  S.ready         = true;
  S.values.clear(); S.goals.clear(); S.interests.clear();
  SB.mode = 'tutor'; SB.activeTeacher = { subjectId, course, teacher };
  messagesEl.innerHTML = '';
  const greeting = `You're now studying ${course} with ${teacher}. What can I help you with?`;
  S.messages.push({ role: 'assistant', content: greeting });
  renderMsg('lumi', greeting, true);
  saveCurrentConv();
  renderSidebar();
  scrollBottom();
  msgInput.focus();
}

// ─── OPEN GENERAL CHAT ───────────────────────────────────────────────────────
function openGeneralChat() {
  saveCurrentConv();
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
  saveCurrentConv();
  renderSidebar();
  scrollBottom();
  msgInput.focus();
}

// ─── HISTORY MENU ────────────────────────────────────────────────────────────
let openMenuId = null;
let activeDropdownEl = null;

function closeOpenMenu() {
  if (activeDropdownEl) { activeDropdownEl.remove(); activeDropdownEl = null; }
  if (openMenuId) {
    const btn = document.querySelector(`.hist-menu-btn[data-id="${openMenuId}"]`);
    if (btn) btn.classList.remove('open');
    openMenuId = null;
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
  deleteItem.addEventListener('click', e => { e.stopPropagation(); closeOpenMenu(); deleteConv(convId); });

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

function deleteConv(convId) {
  if (!confirm('Delete this conversation?')) return;
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

// ─── SIDEBAR RENDERING ───────────────────────────────────────────────────────
function renderSidebar() {
  const query = sbSearch.value.toLowerCase().trim();
  sbNav.innerHTML = '';

  // General Chat button
  const genRow = document.createElement('div');
  genRow.className = 'sb-general' + (SB.mode === 'general' && !S.tutorCtx ? ' active' : '');
  genRow.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> General Chat`;
  genRow.addEventListener('click', () => { openGeneralChat(); closeSidebar(); });
  sbNav.appendChild(genRow);

  // Recents list
  const convs = getConvs();
  const allConvs = Object.values(convs).sort((a, b) => b.ts - a.ts);
  const filtered = query
    ? allConvs.filter(c => (c.title || c.preview || '').toLowerCase().includes(query))
    : allConvs;

  if (filtered.length > 0) {
    const recLabel = document.createElement('div');
    recLabel.className = 'sb-section-label';
    recLabel.textContent = query ? 'Matching chats' : 'Recents';
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
      sbNav.appendChild(item);
    });
  } else if (!query) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = 'No conversations yet';
    sbNav.appendChild(empty);
  }

  // Divider + Subjects
  if (!query) {
    const div = document.createElement('div');
    div.className = 'sb-divider';
    sbNav.appendChild(div);
  }
  const lbl = document.createElement('div');
  lbl.className = 'sb-section-label';
  lbl.textContent = 'Subjects';
  sbNav.appendChild(lbl);

  SUBJECTS.forEach(subject => {
    const matchedCourses = query
      ? subject.courses.filter(c => c.toLowerCase().includes(query) || subject.name.toLowerCase().includes(query))
      : subject.courses;

    if (query && matchedCourses.length === 0 && !subject.name.toLowerCase().includes(query)) return;

    const isOpen = SB.expandedSubject === subject.id || (query && matchedCourses.length > 0);
    const coursesToShow = query ? matchedCourses : subject.courses;

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
      const isCourseOpen = SB.expandedCourse === `${subject.id}::${course}` || (query && course.toLowerCase().includes(query));
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showWelcome() {
  if (document.getElementById('welcome')) return;
  messagesEl.innerHTML = '';
  const name = getStudentName();
  const greeting = name !== 'there' ? `Welcome back, ${escHtml(name)}!` : `Hi, I'm Lumi!`;
  const w = document.createElement('div');
  w.className = 'empty-state'; w.id = 'welcome';
  w.innerHTML = `
    <div class="empty-orb">✦</div>
    <div class="empty-greeting">${greeting}</div>
    <div class="empty-sub">Pick up where you left off, or start something new.</div>
    <div class="empty-cards">
      <div class="empty-card" id="emptyGenBtn">
        <div class="empty-card-icon">💬</div>
        <div class="empty-card-title">General Chat</div>
        <div class="empty-card-sub">Just talk to Lumi about anything</div>
      </div>
      <div class="empty-card" id="emptyStudyBtn">
        <div class="empty-card-icon">📚</div>
        <div class="empty-card-title">Study with a Teacher</div>
        <div class="empty-card-sub">Pick a subject from the sidebar</div>
      </div>
    </div>`;
  messagesEl.appendChild(w);
  w.querySelector('#emptyGenBtn').addEventListener('click', openGeneralChat);
  w.querySelector('#emptyStudyBtn').addEventListener('click', () => {
    if (window.innerWidth <= 768) openSidebar();
    else { SB.expandedSubject = null; renderSidebar(); }
  });
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function initOnboarding(onDone) {
  const ob      = $('onboarding');
  const step1   = $('obStep1');
  const step2   = $('obStep2');
  const nameIn  = $('obNameInput');
  const nameBtn = $('obNameNext');
  const gradeQ  = $('obGradeQ');
  const gradeBtn = $('obGradeNext');
  let chosenGrade = null;

  // Pre-fill name from Google profile — if we have it, skip straight to grade step
  const googleName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || '';
  const firstName  = googleName.split(' ')[0] || '';
  if (firstName) {
    nameIn.value     = firstName;
    nameBtn.disabled = false;
    // Auto-advance to grade step so user only has to pick a grade
    goToStep2();
  }

  nameIn.addEventListener('input', () => { nameBtn.disabled = !nameIn.value.trim(); });
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter' && nameIn.value.trim()) goToStep2(); });
  nameBtn.addEventListener('click', goToStep2);

  function goToStep2() {
    const name = nameIn.value.trim();
    if (!name) return;
    gradeQ.innerHTML = `Nice to meet you, ${escHtml(name)}!<span class="ob-q-sub">What grade are you in?</span>`;
    step1.classList.remove('active');
    step2.classList.add('active');
  }

  step2.querySelectorAll('.ob-grade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      step2.querySelectorAll('.ob-grade-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      chosenGrade = btn.dataset.grade;
      gradeBtn.disabled = false;
    });
  });

  gradeBtn.addEventListener('click', () => {
    if (!chosenGrade) return;
    const name = nameIn.value.trim();
    localStorage.setItem('lumi_name',  name);
    localStorage.setItem('lumi_grade', chosenGrade);
    syncProfileToSupabase();
    ob.classList.add('hidden');
    setTimeout(() => { ob.style.display = 'none'; onDone(); }, 500);
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // Theme
  if (localStorage.getItem('lumi_theme') === 'light') {
    document.documentElement.classList.add('light');
    themeToggle.checked = true;
  }

  // API key
  const savedKey = localStorage.getItem('lumi_key');
  if (savedKey) keyInput.value = savedKey;

  // Onboarding
  const onboarded = localStorage.getItem('lumi_name');
  if (!onboarded) {
    $('onboarding').style.display = '';
    initOnboarding(() => { wireListeners(savedKey); startApp(savedKey); });
    return;
  }
  $('onboarding').style.display = 'none';
  startApp(savedKey);
  wireListeners(savedKey);
}

function wireListeners(savedKey) {
  $('newChatBtn').addEventListener('click', () => {
    if (S.messages.length > 0) {
      if (confirm('Start a new chat? Your current conversation will be saved.')) newChat();
    } else newChat();
  });

  document.addEventListener('click', e => {
    if (activeDropdownEl && !activeDropdownEl.contains(e.target)) closeOpenMenu();
  });

  sbSearch.addEventListener('input', renderSidebar);

  $('hamburger').addEventListener('click', openSidebar);
  $('sbOverlay').addEventListener('click', closeSidebar);

  $('gearBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsOverlay').addEventListener('click', closeSettings);

  themeToggle.addEventListener('change', () => {
    const light = themeToggle.checked;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('lumi_theme', light ? 'light' : 'dark');
  });

  $('saveKeyBtn').addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (key) {
      localStorage.setItem('lumi_key', key);
      showToast('API key saved. You\'re ready to chat!', 'ok');
      closeSettings();
      updateSendBtn();
      if (!S.ready) startLumi();
    } else {
      showToast('Please enter a valid API key (starts with sk-ant-).');
    }
  });

  $('signOutBtn').addEventListener('click', async () => {
    if (confirm('Sign out of Lumi?')) {
      await doSignOut();
    }
  });

  $('clearMemBtn').addEventListener('click', async () => {
    if (confirm('Are you sure? This will erase all conversations and memory.')) {
      // Delete from Supabase (both tables, for this user)
      if (currentUser) {
        try {
          await Promise.all([
            sb.from('conversations').delete().eq('user_id', currentUser.id),
            sb.from('profiles').upsert({
              id: currentUser.id,
              name: null, grade: null,
              values_profile: { values: [], goals: [], interests: [] },
            }, { onConflict: 'id' }),
          ]);
        } catch (e) { console.warn('Supabase clear failed:', e); }
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

function startApp(savedKey) {
  migrateOldData();
  S.currentId = genId();
  renderSidebar();
  showWelcome();
  if (!savedKey) showNoKeyBanner();
}

function showNoKeyBanner() {
  if ($('noKeyBanner')) return;
  const b = document.createElement('div');
  b.id = 'noKeyBanner';
  b.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a0a00;border:1px solid rgba(255,160,50,.3);color:#ffb060;font-size:13px;padding:10px 18px;border-radius:10px;z-index:300;text-align:center;max-width:340px;line-height:1.5;cursor:pointer;';
  b.innerHTML = '🔑 <strong>Add your Anthropic API key</strong> to start chatting.<br><span style="font-size:11px;opacity:.8">Click Settings (bottom-left) → API Key</span>';
  b.addEventListener('click', () => { openSettings(); b.remove(); });
  document.body.appendChild(b);
  // Auto-hide when key is saved
  const observer = new MutationObserver(() => {
    if (localStorage.getItem('lumi_key') && $('noKeyBanner')) $('noKeyBanner').remove();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function openSidebar()   { $('sidebar').classList.add('open');    $('sbOverlay').classList.add('open'); }
function closeSidebar()  { $('sidebar').classList.remove('open'); $('sbOverlay').classList.remove('open'); }
function openSettings()  { $('settingsDrawer').classList.add('open');    $('settingsOverlay').classList.add('open'); }
function closeSettings() { $('settingsDrawer').classList.remove('open'); $('settingsOverlay').classList.remove('open'); }

function updateSendBtn() {
  sendBtn.disabled = !localStorage.getItem('lumi_key') || (!msgInput.value.trim() && !pendingAttachment) || S.busy;
}
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ─── START LUMI (companion greeting) ────────────────────────────────────────
async function startLumi() {
  if (S.ready) return;
  S.ready = true;
  const w = document.getElementById('welcome');
  if (w) w.remove();
  if (S.messages.length === 0) await fetchLumi();
}

// ─── ATTACHMENT HANDLING ─────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

function clearAttachment() {
  pendingAttachment = null;
  fileInput.value   = '';
  attachPreview.innerHTML = '';
  attachPreview.classList.remove('visible');
  updateSendBtn();
}

function showAttachPreview(file, base64, mediaType, isImage) {
  attachPreview.innerHTML = '';
  if (isImage) {
    const img = document.createElement('img');
    img.className = 'attach-thumb';
    img.src = `data:${mediaType};base64,${base64}`;
    attachPreview.appendChild(img);
  } else {
    const ext  = file.name.split('.').pop().toUpperCase().slice(0, 4);
    const icon = document.createElement('div');
    icon.className = 'attach-file-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="attach-file-ext">${ext}</span>`;
    attachPreview.appendChild(icon);
  }
  const info = document.createElement('div');
  info.className = 'attach-info';
  info.innerHTML = `<div class="attach-name">${escHtml(file.name)}</div><div class="attach-size">${fmtBytes(file.size)}</div>`;
  const removeBtn = document.createElement('button');
  removeBtn.className = 'attach-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', clearAttachment);
  attachPreview.appendChild(info);
  attachPreview.appendChild(removeBtn);
  attachPreview.classList.add('visible');
}

function handleFileSelect(file) {
  if (!file) return;
  const maxMB = file.type === 'application/pdf' ? 32 : 5;
  if (file.size > maxMB * 1024 * 1024) { showToast(`File too large. Max ${maxMB}MB.`); return; }
  const isImage = file.type.startsWith('image/');
  const isText  = file.type === 'text/plain' || file.name.endsWith('.txt');
  if (!isImage && file.type !== 'application/pdf' && !isText) { showToast('Unsupported file type.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const base64    = e.target.result.split(',')[1];
    const mediaType = file.type || 'text/plain';
    pendingAttachment = { file, base64, mediaType, isImage, isText };
    showAttachPreview(file, base64, mediaType, isImage);
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

// ─── SEND ────────────────────────────────────────────────────────────────────
async function doSend() {
  const text = msgInput.value.trim();
  if (!text && !pendingAttachment) return;
  if (S.busy) return;
  if (!localStorage.getItem('lumi_key')) { showToast('Add your API key in Settings.'); openSettings(); return; }

  if (!S.ready) { S.ready = true; const w = document.getElementById('welcome'); if (w) w.remove(); }

  const att = pendingAttachment;
  let contentParts = [];
  if (att) {
    if (att.isImage) {
      contentParts.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.base64 } });
    } else if (att.isText) {
      const decoded = atob(att.base64);
      contentParts.push({ type: 'text', text: `[Attached file: ${att.file.name}]\n${decoded}` });
    } else {
      contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.base64 } });
    }
  }
  if (text) contentParts.push({ type: 'text', text });

  const msgContent = contentParts.length === 1 && contentParts[0].type === 'text'
    ? contentParts[0].text
    : contentParts;

  msgInput.value = ''; msgInput.style.height = 'auto';
  const sentAtt = att;
  clearAttachment();
  updateSendBtn();

  S.messages.push({ role: 'user', content: msgContent });
  saveCurrentConv();
  renderMsg('user', text, true, sentAtt);
  renderSidebar();
  await fetchLumi();
}

// ─── GENERATE TITLE ──────────────────────────────────────────────────────────
async function generateTitle(convId, firstUserMsg) {
  const apiKey = localStorage.getItem('lumi_key');
  if (!apiKey || !firstUserMsg) return;
  const convs = getConvs();
  if (!convs[convId] || convs[convId].title) return;
  try {
    const prompt = `Generate a short 4-6 word title for this conversation. Just the title, nothing else, no punctuation at the end: ${firstUserMsg.slice(0, 300)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return;
    const data  = await res.json();
    const title = data.content?.[0]?.text?.trim().replace(/[.!?]$/, '');
    if (title) {
      const c2 = getConvs();
      if (c2[convId]) {
        c2[convId].title = title;
        saveConvs(c2);
        syncConvToSupabase(convId);
        renderSidebar();
      }
    }
  } catch { /* non-critical */ }
}

// ─── FETCH LUMI RESPONSE ─────────────────────────────────────────────────────
async function fetchLumi() {
  S.busy = true; updateSendBtn();
  const typing = makeTyping();
  messagesEl.appendChild(typing);
  scrollBottom();

  const apiKey = localStorage.getItem('lumi_key');
  if (!apiKey) {
    typing.remove();
    renderError('No API key found. Open Settings (bottom-left) and paste your Anthropic API key.');
    S.busy = false; updateSendBtn();
    return;
  }

  try {
    const system = S.tutorCtx
      ? buildTutorSystem(S.tutorCtx.subjectName, S.tutorCtx.course, S.tutorCtx.teacher)
      : buildCompanionSystem();
    const { clean, data } = await callAPI(apiKey, S.messages, system);
    typing.remove();
    S.messages.push({ role: 'assistant', content: clean });
    S.exchangeCount++;
    saveCurrentConv();
    renderMsg('lumi', clean, true);
    renderSidebar();
    if (data) applyProfile(data);
    if (S.exchangeCount === 1) {
      const firstUser = S.messages.find(m => m.role === 'user');
      const msgText = typeof firstUser?.content === 'string'
        ? firstUser.content
        : (Array.isArray(firstUser?.content) ? (firstUser.content.find(p => p.type === 'text')?.text || '') : '');
      if (msgText) generateTitle(S.currentId, msgText);
    }
  } catch (err) {
    typing.remove();
    const errMsg = err.message || 'Something went wrong.';
    renderError(`API error: ${errMsg}`);
    showToast(errMsg);
    console.error('Lumi API error:', err);
  } finally {
    S.busy = false; updateSendBtn();
  }
}

// Render a visible error bubble in the chat
function renderError(msg) {
  const el = document.createElement('div');
  el.className = 'msg lumi';
  el.innerHTML = `<div class="msg-bubble" style="background:rgba(255,80,80,.08);border-color:rgba(255,80,80,.25);color:#ff8585;">⚠️ ${escHtml(msg)}</div>`;
  messagesEl.appendChild(el);
  scrollBottom();
}

// ─── API CALL ────────────────────────────────────────────────────────────────
async function callAPI(apiKey, msgs, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      stream: true,
      system,
      messages: msgs,
    }),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6); if (raw === '[DONE]') continue;
      try { const ev = JSON.parse(raw); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') full += ev.delta.text; } catch {}
    }
  }
  return parseResponse(full);
}

// ─── PARSE ───────────────────────────────────────────────────────────────────
function parseResponse(text) {
  const lb = text.lastIndexOf('\n{');
  if (lb !== -1) {
    const cand = text.slice(lb + 1).trim();
    try {
      const p = JSON.parse(cand);
      if ('values' in p && 'goals' in p && 'interests' in p)
        return { clean: text.slice(0, lb).trim(), data: p };
    } catch {}
  }
  const m = text.match(/\n?\{"values"\s*:[\s\S]*?\}(?:\s*)$/);
  if (m) { try { return { clean: text.slice(0, text.length - m[0].length).trim(), data: JSON.parse(m[0].trim()) }; } catch {} }
  return { clean: text.trim(), data: null };
}

// ─── PROFILE ─────────────────────────────────────────────────────────────────
function applyProfile({ values = [], goals = [], interests = [] }) {
  let anyNew = false;
  const add = (arr, set) => {
    arr.forEach(raw => {
      if (!raw) return; const k = raw.toLowerCase().trim();
      if (!set.has(k)) { set.add(k); anyNew = true; }
    });
  };
  add(values, S.values); add(goals, S.goals); add(interests, S.interests);
  if (anyNew) saveCurrentConv();
}

// ─── RENDER MESSAGE ──────────────────────────────────────────────────────────
function renderMsg(role, content, animate, att) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (!animate) el.style.animation = 'none';

  if (role === 'lumi') {
    const hd = document.createElement('div'); hd.className = 'msg-head';
    const av = document.createElement('div'); av.className = 'msg-avatar'; av.textContent = '✦';
    const nm = document.createElement('span'); nm.className = 'msg-name';
    nm.textContent = S.tutorCtx ? S.tutorCtx.teacher : 'Lumi';
    hd.append(av, nm); el.appendChild(hd);
  }

  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';

  if (Array.isArray(content)) {
    content.forEach(part => {
      if (part.type === 'image' && part.source?.data) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = `data:${part.source.media_type};base64,${part.source.data}`;
        bubble.appendChild(img);
      } else if (part.type === 'document') {
        const chip = document.createElement('div');
        chip.className = 'msg-file-chip';
        chip.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF document`;
        bubble.appendChild(chip);
      } else if (part.type === 'text' && part.text) {
        const textNode = document.createElement('div');
        textNode.innerHTML = fmtText(part.text);
        bubble.appendChild(textNode);
      }
    });
  } else {
    if (att) {
      if (att.isImage) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.src = `data:${att.mediaType};base64,${att.base64}`;
        bubble.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'msg-file-chip';
        chip.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escHtml(att.file.name)}`;
        bubble.appendChild(chip);
      }
    }
    if (content) {
      const textNode = document.createElement('div');
      textNode.innerHTML = fmtText(content);
      bubble.appendChild(textNode);
    }
  }

  el.appendChild(bubble);
  messagesEl.appendChild(el);
  if (animate) scrollBottom();
}

function fmtText(text) {
  if (!text) return '';
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code>$1</code>');
  const ps = s.split(/\n\n+/);
  if (ps.length > 1) return ps.map(p => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
  return `<p>${s.replace(/\n/g,'<br>')}</p>`;
}

function makeTyping() {
  const wrap = document.createElement('div'); wrap.className = 'msg lumi';
  const hd   = document.createElement('div'); hd.className = 'msg-head';
  const av   = document.createElement('div'); av.className = 'msg-avatar'; av.textContent = '✦';
  const nm   = document.createElement('span'); nm.className = 'msg-name';
  nm.textContent = S.tutorCtx ? S.tutorCtx.teacher : 'Lumi';
  hd.append(av, nm);
  const ind = document.createElement('div'); ind.className = 'typing';
  for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.className = 'typing-dot'; ind.appendChild(d); }
  wrap.append(hd, ind); return wrap;
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

let toastTimer;
function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = 'toast' + (type === 'ok' ? ' ok' : '');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}
