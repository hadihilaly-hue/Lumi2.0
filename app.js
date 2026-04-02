// ─── AUTH GUARD ───────────────────────────────────────────────────────────────
let currentUser = null;

(async () => {
  // Simple auth check — getSession() reads from localStorage, no network needed
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  if (!isMenloEmail(session.user.email)) {
    await sb.auth.signOut();
    window.location.href = 'index.html';
    return;
  }

  currentUser = session.user;

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
  document.getElementById('sbUserEmail').textContent = email;
  const sbAvatarEl = document.getElementById('sbUserAvatar');
  if (meta.avatar_url) {
    const img2 = document.createElement('img'); img2.src = meta.avatar_url; img2.alt = '';
    sbAvatarEl.appendChild(img2);
  } else { sbAvatarEl.textContent = initials; }

  await loadProfileFromSupabase();
  if (!localStorage.getItem('lumi_convs')) await loadConvsFromSupabase();

  // Show Teacher Mode link only for allowed teacher emails
  const ALLOWED_TEACHER_EMAILS = ['hadi.hilaly@menloschool.org'];
  if (ALLOWED_TEACHER_EMAILS.includes(email.toLowerCase())) {
    const link = document.getElementById('teacherModeLink');
    if (link) link.style.display = 'block';
  }

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
    "Algebra 2 with Trig": ["Rebecca Akers","Jacqueline Arreaga","Richard Harris"],
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

// ─── SHARED TEACHING PHILOSOPHY ──────────────────────────────────────────────
const TEACHING_PHILOSOPHY = `
CRITICAL TEACHING PHILOSOPHY — THIS OVERRIDES EVERYTHING ELSE:

You are a study partner and teacher, NOT an answer provider. Your entire purpose is to help students LEARN and THINK, not to offload their cognitive work for them.

NEVER do these things:
- Never give a direct answer to a homework problem, essay prompt, or test question
- Never write any part of an essay, assignment, or project for the student
- Never solve a math problem and just show the answer
- Never translate a passage they are supposed to translate themselves
- Never summarize a book or chapter they are supposed to have read

ALWAYS do these things instead:
- Ask the student what they already know or have tried
- Break the problem into smaller pieces and guide them through each one
- Ask Socratic questions that lead the student to discover the answer themselves
- When a student is stuck, give a hint or ask a guiding question — not the answer
- When a student gets something right, ask them to explain WHY it's right
- When a student gets something wrong, don't just correct them — ask them to find their own mistake
- Celebrate the thinking process, not just correct answers
- Always make the student do the cognitive work

SPECIFIC EXAMPLES:
- Student: "What's the answer to problem 4?" → You: "Let's work through it together. What's the first step you'd take?"
- Student: "Write me a thesis statement" → You: "What's your argument? Tell me in one sentence what you want to prove."
- Student: "Just tell me what happened in chapter 5" → You: "What do you remember from what you read? Let's start there."
- Student: "Solve this equation for me" → You: "What operation would you do first? Walk me through your thinking."

If a student gets frustrated and says "just give me the answer", respond warmly but firmly:
"I know it's frustrating, but if I just give you the answer you won't actually learn it — and that won't help you on the test or in the future. Let's take it one step at a time. What do you know so far?"

The goal is for every student who uses Lumi to genuinely understand the material better — not just get through their homework faster. A student should finish a session with Lumi feeling like they actually learned something, not like they just got answers handed to them.

Think of yourself as the best teacher you know — patient, encouraging, rigorous, and deeply committed to the student's actual growth.`;

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
${TEACHING_PHILOSOPHY}
${hwContext()}
After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things. Empty arrays if nothing new.
NEVER mention the JSON.`;
}

function buildTutorSystem(subject, course, teacher, teacherProfile) {
  const hasProfile = !!teacherProfile;

  if (hasProfile) {
    const p = teacherProfile;
    const mistakes = Array.isArray(p.common_mistakes)
      ? p.common_mistakes.map(m => `  - ${m}`).join('\n')
      : (p.common_mistakes ? `  - ${p.common_mistakes}` : '');

    return `You are Lumi, acting as a 24/7 digital version of ${teacher} for their ${course} class at Menlo School. ${teacher} has given you a deep briefing on how they teach — your job is to help this student exactly the way ${teacher} would.

${studentCtx()}

═══ ${teacher.toUpperCase()}'S TEACHING PROFILE ═══

TEACHING STYLE:
${p.teaching_style || ''}

WHAT EXCELLENCE LOOKS LIKE IN THIS CLASS:
${p.excellence_criteria || ''}

GRADING PHILOSOPHY:
${p.grading_philosophy || ''}

COMMON MISTAKES TO WATCH FOR:
${mistakes}

HOW ${teacher.split(' ')[0].toUpperCase()} EXPLAINS THINGS:
${p.explanation_methods || ''}

WHAT ${teacher.split(' ')[0].toUpperCase()} CARES ABOUT:
${p.key_values || ''}

CLASS-SPECIFIC NOTES:
${p.class_specific_notes || ''}

${teacher.split(' ')[0].toUpperCase()}'S VOICE & TONE:
${p.teacher_voice || ''}

═══ YOUR INSTRUCTIONS ═══

- Explain things exactly the way ${teacher} would — match their tone, vocabulary, and level of formality as described above
- Catch the same mistakes ${teacher} always catches — if a student is about to make one, flag it the way ${teacher} would
- Hold students to the same standards ${teacher} holds — don't let things slide that ${teacher} wouldn't let slide
- Use the same analogies and examples ${teacher} uses when possible
- Ask the same kinds of questions ${teacher} asks to help students think, rather than just giving answers
- Sound like ${teacher} — same warmth, same rigor, same personality
${TEACHING_PHILOSOPHY}
${hwContext()}
Response length: SHORT — 1-3 sentences for simple questions. Longer only when a concept truly needs it. No essays.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things about the student. Empty arrays if nothing new.
NEVER mention the JSON.`;
  }

  // No profile yet — fallback to generic tutor
  return `You are tutoring a Menlo School student in ${course} with ${teacher}. Be helpful, specific to this subject, and calibrated to high school level.

${studentCtx()}

Your tutoring style:
- Warm, encouraging, and patient
- Ask guiding questions rather than just giving answers
- Break down complex concepts step by step
- Give specific, actionable feedback
${TEACHING_PHILOSOPHY}

Response length: SHORT — 1-3 sentences for simple questions. No essays.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things about the student. Empty arrays if nothing new.
NEVER mention the JSON.`;
}

// ─── SCHEDULE STORAGE ────────────────────────────────────────────────────────
// Schedule: [{ course, teacher, subject }]
function getSchedule() {
  try { return JSON.parse(localStorage.getItem('lumi_schedule') || '[]'); } catch { return []; }
}
function saveScheduleLocal(s) { localStorage.setItem('lumi_schedule', JSON.stringify(s)); }

function syncScheduleToSupabase(schedule) {
  if (!currentUser) return;
  sb.from('profiles').upsert({
    id: currentUser.id,
    schedule,
    schedule_updated_at: new Date().toISOString(),
  }, { onConflict: 'id' })
    .then(({ error }) => { if (error) console.warn('Schedule sync error:', error); });
}

// ─── CURRICULUM SEARCH ───────────────────────────────────────────────────────
// Searches hardcoded MENLO_CURRICULUM data — no Supabase needed.
// The chat checks for a complete profile separately; search shows all teachers.
function searchCurriculum(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results = [];

  Object.entries(MENLO_CURRICULUM).forEach(([subject, courses]) => {
    Object.entries(courses).forEach(([course, teachers]) => {
      teachers.forEach(teacher => {
        if (teacher.toLowerCase().includes(q)) {
          results.push({ type: 'teacher', teacher, course, subject });
        }
      });
      if (course.toLowerCase().includes(q)) {
        results.push({ type: 'class', course, teachers, subject });
      }
    });
  });

  return results;
}

// Maps teacher display name → real @menloschool.org email (mirrors teacher.html)
const TEACHER_EMAIL_MAP = {
  "Rachel Blumenthal":      "rblumenthal@menloschool.org",
  "Whitney Newton":         "wnewton@menloschool.org",
  "Margaret Ramsey":        "mramsey@menloschool.org",
  "Andrew Warren":          "awarren@menloschool.org",
  "Jay Bush":               "jbush@menloschool.org",
  "Lily Chan":              "lchan@menloschool.org",
  "Rebecca Gertmenian":     "rgertmenian@menloschool.org",
  "Meghann Schroers-Martin":"mschroers-martin@menloschool.org",
  "Tom Garvey":             "tgarvey@menloschool.org",
  "Oscar King":             "oking@menloschool.org",
  "Maura Sincoff":          "msincoff@menloschool.org",
  "Cara Plamondon":         "cplamondon@menloschool.org",
  "Bridgett Longust":       "blongust@menloschool.org",
  "Sabahat Adil":           "sadil@menloschool.org",
  "Franco Cruz-Ochoa":      "fcruz-ochoa@menloschool.org",
  "Katharine Hanson":       "khanson@menloschool.org",
  "Nicholas Merlesena":     "nmerlesena@menloschool.org",
  "Miles Bennett-Smith":    "mbennett-smith@menloschool.org",
  "Glenn Davis":            "gdavis@menloschool.org",
  "Trevor McNeil":          "tmcneil@menloschool.org",
  "Joseph Mitchell":        "jmitchell@menloschool.org",
  "Jack Bowen":             "jbowen@menloschool.org",
  "Dylan Citrin Cummins":   "dcitrin-cummins@menloschool.org",
  "Charles Hanson":         "chanson@menloschool.org",
  "Matthew Nelson":         "mnelson@menloschool.org",
  "John Schafer":           "jschafer@menloschool.org",
  "Peter Brown":            "pbrown@menloschool.org",
  "Christine Walters":      "cwalters@menloschool.org",
  "Rebecca Akers":          "rakers@menloschool.org",
  "Joe Rabison":            "jrabison@menloschool.org",
  "Sujata Ganpule":         "sganpule@menloschool.org",
  "Randall Joss":           "rjoss@menloschool.org",
  "Nandhini Namasivayam":   "nnamasivayam@menloschool.org",
  "Jacqueline Arreaga":     "jarreaga@menloschool.org",
  "Danielle Jensen":        "djensen@menloschool.org",
  "Yu-Loung Chang":         "ychang@menloschool.org",
  "Dave Lowell":            "dlowell@menloschool.org",
  "Reeve Garrett":          "rgarrett@menloschool.org",
  "Jude Loeffler":          "jloeffler@menloschool.org",
  "Dennis Millstein":       "dmillstein@menloschool.org",
  "Douglas Kiang":          "dkiang@menloschool.org",
  "Zachary Blickensderfer": "zblickensderfer@menloschool.org",
  "Chrissy Orangio":        "corangio@menloschool.org",
  "Laura Huntley":          "lhuntley@menloschool.org",
  "Mary McKenna":           "mmckenna@menloschool.org",
  "Zachary Eagleton":       "zeagleton@menloschool.org",
  "Eugenia McCauley":       "emccauley@menloschool.org",
  "Nina Arnberg":           "narnberg@menloschool.org",
  "Zane Moore":             "zmoore@menloschool.org",
  "Matthew Varvir":         "mvarvir@menloschool.org",
  "Todd Hardie":            "thardie@menloschool.org",
  "Cristina Weaver":        "cweaver@menloschool.org",
  "Tatyana Buxton":         "tbuxton@menloschool.org",
  "James Dann":             "jdann@menloschool.org",
  "James Formato":          "jformato@menloschool.org",
  "Leo Jaimez":             "ljaimez@menloschool.org",
  "Janet Tennyson":         "jtennyson@menloschool.org",
  "Adolfo Guevara":         "aguevara@menloschool.org",
  "Perla Amaral":           "pamaral@menloschool.org",
  "Patricia Frias":         "pfrias@menloschool.org",
  "Marie Sajja":            "msajja@menloschool.org",
  "Corinne Chung":          "cchung@menloschool.org",
  "Rita Yeh":               "ryeh@menloschool.org",
  "Mingjung Chen":          "mchen@menloschool.org",
  "Jennifer Jordt":         "jjordt@menloschool.org",
  "Richard Harris":         "rharris@menloschool.org",
};

// Fetch teacher profile from Supabase for a given teacher name and course.
// Returns the profile if status=complete, { __notReady: true } if in_progress/not_started, null if not found.
async function getTeacherProfile(teacherName, course) {
  if (!teacherName || !course) return null;
  try {
    const email = TEACHER_EMAIL_MAP[teacherName];
    if (!email) return null;

    const { data, error } = await sb
      .from('teacher_profiles')
      .select('*')
      .eq('teacher_email', email)
      .eq('class_name', course)
      .maybeSingle();
    if (error || !data) return null;

    if (data.status !== 'complete') return { __notReady: true };
    return data;
  } catch {
    return null;
  }
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
  showAllClasses:  false,
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
      .select('name, grade, values_profile, schedule')
      .eq('id', currentUser.id)
      .single();
    if (error || !data) return;
    // Always restore name/grade (overwrite if Supabase is newer)
    if (!hasName && data.name)  localStorage.setItem('lumi_name',  data.name);
    if (!hasName && data.grade) localStorage.setItem('lumi_grade', data.grade);
    if (data.schedule?.length && !localStorage.getItem('lumi_schedule'))
      localStorage.setItem('lumi_schedule', JSON.stringify(data.schedule));
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
async function openTutor(subjectId, course, teacher) {
  clearSearch();
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

  // Fetch teacher profile — check status before using
  const profile = await getTeacherProfile(teacher, course);
  let greeting;
  const firstName = teacher.split(' ')[0];

  if (profile?.__notReady) {
    greeting = `${firstName} hasn't finished setting up their Lumi profile yet. Check back soon — or chat with General Lumi in the meantime!`;
    S.tutorCtx.teacherProfile = null;
  } else if (profile) {
    S.tutorCtx.teacherProfile = profile;
    greeting = `Hey! You're studying ${course} with ${firstName}. I've learned how ${firstName} teaches and what they look for — ask me anything and I'll help you the way ${firstName} would.`;
  } else {
    greeting = `You're now studying ${course} with ${teacher}. What can I help you with?`;
  }
  S.messages.push({ role: 'assistant', content: greeting });
  renderMsg('lumi', greeting, true);
  saveCurrentConv();
  renderSidebar();
  scrollBottom();
  msgInput.focus();
}

// ─── OPEN GENERAL CHAT ───────────────────────────────────────────────────────
function openGeneralChat() {
  clearSearch();
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

// ─── SEARCH DROPDOWN ─────────────────────────────────────────────────────────
function clearSearch() {
  const input = document.getElementById('sbSearch');
  if (input) input.value = '';
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function renderSearchDropdown(query) {
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
function renderSidebar() {
  const query = sbSearch.value.toLowerCase().trim();
  sbNav.innerHTML = '';

  const schedule = getSchedule();

  // Homework section (when schedule is set and not searching)
  if (schedule.length > 0 && !query) {
    renderHwSidebar(sbNav);
  }

  // My Classes section (when schedule is set and not searching)
  if (schedule.length > 0 && !query) {
    const myHd = document.createElement('div');
    myHd.className = 'sb-my-classes-hd';
    myHd.textContent = 'My Classes';
    sbNav.appendChild(myHd);

    schedule.forEach(({ course, teacher }) => {
      const lastName = teacher ? teacher.split(' ').slice(-1)[0] : '';
      const isActive = SB.activeTeacher &&
        SB.activeTeacher.course === course &&
        SB.activeTeacher.teacher === teacher;
      const item = document.createElement('div');
      item.className = 'sb-my-class-item' + (isActive ? ' active' : '');
      const icon = document.createElement('span');
      icon.className = 'sb-my-class-icon';
      icon.textContent = '📚';
      const name = document.createElement('span');
      name.className = 'sb-my-class-name';
      name.textContent = course;
      const tch = document.createElement('span');
      tch.className = 'sb-my-class-teacher';
      tch.textContent = lastName;
      item.appendChild(icon);
      item.appendChild(name);
      item.appendChild(tch);
      item.addEventListener('click', () => {
        const { subjectId } = lookupSubjectForCourse(course);
        openTutor(subjectId, course, teacher);
        closeSidebar();
      });
      sbNav.appendChild(item);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'sb-add-class';
    addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add a class`;
    addBtn.addEventListener('click', () => {
      initScheduleSetup(() => { renderSidebar(); }, getSchedule());
    });
    sbNav.appendChild(addBtn);

    const divMid = document.createElement('div');
    divMid.className = 'sb-divider';
    sbNav.appendChild(divMid);
  }

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

  // When search is active, dropdown handles teacher/class results — skip subjects tree
  if (query) return;

  // Subjects — wrapped in "All Classes" toggle when a schedule exists
  const hasSchedule = schedule.length > 0;

  if (hasSchedule) {
    const allToggle = document.createElement('div');
    allToggle.className = 'sb-all-classes-toggle' + (SB.showAllClasses ? ' open' : '');
    allToggle.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> All Classes`;
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

function initScheduleSetup(onDone, prefill = []) {
  const el = $('schedSetup');
  el.classList.remove('hidden');
  el.style.display = '';

  // State
  let chosenGrade       = localStorage.getItem('lumi_grade') || null;
  const selectedClasses = new Set(prefill.map(p => p.course));
  const teacherChoices  = {};
  prefill.forEach(p => { teacherChoices[p.course] = p.teacher; });
  let teacherIdx = 0;

  // Steps: 0=grade, 1=classes, 2=teachers, 3=confirm
  const stepEls = [$('ssStep1'), $('ssStep2'), $('ssStep3'), $('ssStep4')];

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
      [...selectedClasses].forEach(c => { if (!allAllowed.includes(c)) { selectedClasses.delete(c); delete teacherChoices[c]; } });
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
      buildConfirmList();
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

  // ── Step 4: Confirm ───────────────────────────────────────────────────────
  function buildConfirmList() {
    const list = $('ssConfirmList');
    list.innerHTML = '';
    getSelectedArray().forEach(course => {
      const teacher = teacherChoices[course] || '—';
      const item = document.createElement('div');
      item.className = 'sched-confirm-item';
      const c = document.createElement('span');
      c.className = 'sched-confirm-course';
      c.textContent = course;
      const t = document.createElement('span');
      t.className = 'sched-confirm-teacher';
      t.textContent = teacher.split(' ').slice(-1)[0]; // last name
      item.appendChild(c);
      item.appendChild(t);
      list.appendChild(item);
    });
  }

  $('ssStep4Back').addEventListener('click', () => {
    teacherIdx = Math.max(0, getSelectedArray().length - 1);
    showTeacherStep();
    setStep(2);
  });

  $('ssStep4Done').addEventListener('click', () => {
    const schedule = getSelectedArray().map(course => {
      const subject = Object.entries(MENLO_CURRICULUM)
        .find(([, courses]) => courses[course])?.[0] || '';
      return { course, teacher: teacherChoices[course] || '', subject };
    });
    saveScheduleLocal(schedule);
    if (chosenGrade) localStorage.setItem('lumi_grade', chosenGrade);
    syncScheduleToSupabase(schedule);
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; onDone(); }, 350);
  });

  setStep(0);
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

// ─── SEMESTER BANNER ─────────────────────────────────────────────────────────
function checkSemesterBanner() {
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

  // Onboarding + schedule setup
  const hasName     = !!localStorage.getItem('lumi_name');
  const hasSchedule = getSchedule().length > 0;

  wireListeners(savedKey);

  if (!hasName) {
    $('onboarding').style.display = '';
    initOnboarding(() => {
      if (!getSchedule().length) {
        initScheduleSetup(() => startApp(savedKey));
      } else {
        startApp(savedKey);
      }
    });
    return;
  }

  $('onboarding').style.display = 'none';

  if (!hasSchedule) {
    initScheduleSetup(() => startApp(savedKey));
    return;
  }

  startApp(savedKey);
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

  sbSearch.addEventListener('input', () => renderSearchDropdown(sbSearch.value.trim()));

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
  wireHwListeners();
  loadHwFromSupabase().then(() => {
    renderSidebar();
    checkDailyHwPrompt();
  });
  renderSidebar();
  showWelcome();
  checkSemesterBanner();
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
      ? buildTutorSystem(S.tutorCtx.subjectName, S.tutorCtx.course, S.tutorCtx.teacher, S.tutorCtx.teacherProfile || null)
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

// ─── HOMEWORK PLANNER ────────────────────────────────────────────────────────

function getHwTasks() {
  try { return JSON.parse(localStorage.getItem('lumi_hw_tasks') || '[]'); } catch { return []; }
}
function saveHwTasks(tasks) { localStorage.setItem('lumi_hw_tasks', JSON.stringify(tasks)); }
function genHwId() { return 'hw_' + Math.random().toString(36).slice(2, 10); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Load teacher profiles for all schedule classes (used for time hints)
const _hwProfileCache = {};
async function getTeacherProfileCached(teacherId) {
  if (!teacherId) return null;
  if (_hwProfileCache[teacherId] !== undefined) return _hwProfileCache[teacherId];
  try {
    const { data } = await sb.from('teacher_profiles').select('*').eq('id', teacherId).single();
    _hwProfileCache[teacherId] = data || null;
  } catch { _hwProfileCache[teacherId] = null; }
  return _hwProfileCache[teacherId];
}

function buildTeacherId(course, teacher) {
  // Mirror the ID format used in teacher.html: slugify course + teacher
  return (course + '_' + teacher).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

// ── Daily popup check ──────────────────────────────────────
function checkDailyHwPrompt() {
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
function openHwBackdrop()  { $('hwBackdrop').classList.add('open'); }
function closeHwBackdrop() { $('hwBackdrop').classList.remove('open'); }

function showHwPopup() {
  localStorage.setItem('lumi_hw_date', todayStr());
  openHwBackdrop();
  const popup = $('hwPopup');
  popup.style.display = 'flex';
  popup.style.flexDirection = 'column';
  requestAnimationFrame(() => popup.classList.add('open'));
  renderHwPopupTasks();
}

function closeHwPopup() {
  const popup = $('hwPopup');
  popup.classList.remove('open');
  closeHwBackdrop();
  setTimeout(() => { popup.style.display = 'none'; }, 200);
  renderSidebar(); // refresh sidebar checklist
  syncHwToSupabase();
}

function showHwAddModal(prefillClass) {
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
  if (prefillClass) sel.value = prefillClass;

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
  const tid = buildTeacherId(entry.course, entry.teacher);
  const profile = await getTeacherProfileCached(tid);
  if (profile && profile.typical_hw_duration_minutes) {
    $('hwTimeHint').textContent = `${entry.teacher.split(' ')[0]} typically assigns ~${profile.typical_hw_duration_minutes} min of homework`;
    $('hwTimeInput').placeholder = profile.typical_hw_duration_minutes;
  } else {
    $('hwTimeHint').textContent = '';
    $('hwTimeInput').placeholder = '30';
  }
}

function closeHwAddModal() {
  const modal = $('hwAddModal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

function showHwPlanModal() {
  const tasks = getHwTasks().filter(t => !t.isComplete);
  const plan  = buildStudyPlan(tasks);
  renderStudyPlan(plan);
  const modal = $('hwPlanModal');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));
}

function closeHwPlanModal() {
  const modal = $('hwPlanModal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

// ── Render popup task list ─────────────────────────────────
function renderHwPopupTasks() {
  const list  = $('hwPopupTaskList');
  const tasks = getHwTasks();
  list.innerHTML = '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-muted);padding:4px 0 12px';
    empty.textContent = 'Nothing yet — add your assignments below.';
    list.appendChild(empty);
    return;
  }
  tasks.forEach(task => {
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
    title.textContent = task.title;
    const meta = document.createElement('div');
    meta.className = 'hw-task-meta';
    const parts = [];
    if (task.className)        parts.push(task.className.split(' ').slice(0,2).join(' '));
    if (task.estimatedMinutes) parts.push(`~${task.estimatedMinutes} min`);
    if (task.dueDate)          parts.push('Due ' + task.dueDate);
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

function addHwTask(task) {
  const tasks = getHwTasks();
  tasks.push(task);
  saveHwTasks(tasks);
}

// ── Study plan generator ───────────────────────────────────
function buildStudyPlan(tasks) {
  // Sort: due soonest first, then shortest
  const sorted = [...tasks].sort((a, b) => {
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate)
      return a.dueDate < b.dueDate ? -1 : 1;
    return (a.estimatedMinutes || 30) - (b.estimatedMinutes || 30);
  });

  const plan = [];
  let elapsed = 0; // minutes since start
  const BREAK_INTERVAL = 90;
  let nextBreak = BREAK_INTERVAL;
  let workedSinceBreak = 0;

  sorted.forEach(task => {
    const dur = task.estimatedMinutes || 30;

    // Insert break if needed
    if (workedSinceBreak >= nextBreak && sorted.length > 1) {
      plan.push({ type: 'break', duration: 15, startMinute: elapsed });
      elapsed += 15;
      workedSinceBreak = 0;
    }

    plan.push({
      type: 'task',
      task,
      duration: dur,
      startMinute: elapsed
    });
    elapsed += dur;
    workedSinceBreak += dur;
  });

  return { blocks: plan, totalMinutes: elapsed };
}

function fmtPlanTime(minutesOffset) {
  // Start from 6:00 PM by default
  const start = 18 * 60 + minutesOffset;
  const h = Math.floor(start / 60) % 24;
  const m = start % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function renderStudyPlan(plan) {
  const body = $('hwPlanBody');
  body.innerHTML = '';

  const totalH = Math.floor(plan.totalMinutes / 60);
  const totalM = plan.totalMinutes % 60;
  const timeStr = totalH > 0
    ? `${totalH}h ${totalM > 0 ? totalM + 'm' : ''}`.trim()
    : `${totalM}m`;

  const summary = document.createElement('div');
  summary.className = 'hw-plan-summary';
  summary.textContent = `Here's your study session — ${plan.blocks.filter(b => b.type === 'task').length} assignments, about ${timeStr} total. Starting at 6:00 PM:`;
  body.appendChild(summary);

  plan.blocks.forEach(block => {
    const el = document.createElement('div');
    el.className = 'hw-plan-block' + (block.type === 'break' ? ' break' : '');

    const timeEl = document.createElement('div');
    timeEl.className = 'hw-plan-block-time';
    timeEl.textContent = fmtPlanTime(block.startMinute) + ' · ' + block.duration + ' min';

    const titleEl = document.createElement('div');
    titleEl.className = 'hw-plan-block-title';

    if (block.type === 'break') {
      titleEl.textContent = '☕ Take a break';
      const metaEl = document.createElement('div');
      metaEl.className = 'hw-plan-block-meta';
      metaEl.textContent = 'Step away, stretch, hydrate.';
      el.appendChild(timeEl);
      el.appendChild(titleEl);
      el.appendChild(metaEl);
    } else {
      titleEl.textContent = block.task.title;
      const metaEl = document.createElement('div');
      metaEl.className = 'hw-plan-block-meta';
      const parts = [];
      if (block.task.className) parts.push(block.task.className.split(' ').slice(0, 2).join(' '));
      if (block.task.dueDate)   parts.push('Due ' + block.task.dueDate);
      metaEl.textContent = parts.join(' · ');
      el.appendChild(timeEl);
      el.appendChild(titleEl);
      if (parts.length) el.appendChild(metaEl);
    }
    body.appendChild(el);
  });
}

// ── Sidebar homework checklist ─────────────────────────────
function renderHwSidebar(container) {
  const tasks = getHwTasks();
  const today = todayStr();

  // Header
  const hd = document.createElement('div');
  hd.className = 'sb-hw-hd';
  const hdLabel = document.createElement('span');
  hdLabel.textContent = 'My Homework';
  const hdBtn = document.createElement('button');
  hdBtn.className = 'sb-hw-hd-btn';
  hdBtn.textContent = '+ Add';
  hdBtn.addEventListener('click', () => { showHwAddModal(); closeSidebar(); });
  hd.appendChild(hdLabel);
  hd.appendChild(hdBtn);
  container.appendChild(hd);

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'sb-hw-empty';
    empty.textContent = 'No homework — enjoy the break!';
    container.appendChild(empty);
  } else {
    // Show incomplete first, then completed (max 5 each)
    const incomplete = tasks.filter(t => !t.isComplete);
    const complete   = tasks.filter(t => t.isComplete).slice(0, 3);
    const toShow     = [...incomplete, ...complete].slice(0, 8);

    toShow.forEach(task => {
      const item = document.createElement('div');
      item.className = 'sb-hw-item' + (task.isComplete ? ' done' : '');

      const check = document.createElement('div');
      check.className = 'sb-hw-check' + (task.isComplete ? ' done' : '');
      check.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
      check.addEventListener('click', e => { e.stopPropagation(); toggleHwTask(task.id); });

      const title = document.createElement('div');
      title.className = 'sb-hw-item-title';
      title.textContent = task.title;

      const cls = document.createElement('div');
      cls.className = 'sb-hw-item-class';
      cls.textContent = task.className
        ? task.className.split(' ').slice(0, 2).join(' ')
        : '';

      item.appendChild(check);
      item.appendChild(title);
      item.appendChild(cls);
      container.appendChild(item);
    });
  }

  // "Open planner" button
  const openBtn = document.createElement('div');
  openBtn.className = 'sb-hw-open-btn';
  openBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Open planner`;
  openBtn.addEventListener('click', () => { showHwPopup(); closeSidebar(); });
  container.appendChild(openBtn);

  const div = document.createElement('div');
  div.className = 'sb-divider';
  container.appendChild(div);
}

// ── System prompt homework context ─────────────────────────
function hwContext() {
  const tasks = getHwTasks().filter(t => !t.isComplete);
  if (!tasks.length) return '';
  const lines = tasks.map(t => {
    const parts = [`• ${t.title}`];
    if (t.className)        parts.push(`(${t.className})`);
    if (t.estimatedMinutes) parts.push(`~${t.estimatedMinutes} min`);
    if (t.dueDate)          parts.push(`due ${t.dueDate}`);
    return parts.join(' ');
  });
  return `\n\nSTUDENT'S CURRENT HOMEWORK:\n${lines.join('\n')}\n(Reference this naturally when relevant — e.g. if they mention being stressed or if a class comes up.)`;
}

// ── Supabase sync ──────────────────────────────────────────
async function syncHwToSupabase() {
  if (!currentUser) return;
  const tasks = getHwTasks();
  try {
    await sb.from('profiles').upsert({
      id: currentUser.id,
      hw_tasks: tasks,
      hw_updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
  } catch (e) { /* non-critical */ }
}

async function loadHwFromSupabase() {
  if (!currentUser) return;
  // Only load from remote if local is empty (local is source of truth during session)
  if (getHwTasks().length > 0) return;
  try {
    const { data } = await sb.from('profiles').select('hw_tasks').eq('id', currentUser.id).single();
    if (data && Array.isArray(data.hw_tasks) && data.hw_tasks.length > 0) {
      saveHwTasks(data.hw_tasks);
    }
  } catch (e) { /* ignore */ }
}

// ── Wire all homework event listeners ─────────────────────
function wireHwListeners() {
  $('hwPopupClose').addEventListener('click', closeHwPopup);
  $('hwBackdrop').addEventListener('click', closeHwPopup);

  $('hwPopupAddBtn').addEventListener('click', () => {
    showHwAddModal();
  });

  $('hwPopupSkipBtn').addEventListener('click', closeHwPopup);

  $('hwPopupPlanBtn').addEventListener('click', () => {
    const tasks = getHwTasks().filter(t => !t.isComplete);
    if (!tasks.length) { showToast('Add some homework first!'); return; }
    showHwPlanModal();
  });

  $('hwAddBack').addEventListener('click', () => {
    closeHwAddModal();
    // Re-open popup if it was showing
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
    // Return to popup
    renderHwPopupTasks();
    if (!$('hwPopup').classList.contains('open')) showHwPopup();
    showToast('Added!', 'ok');
  });

  $('hwPlanBack').addEventListener('click', () => {
    closeHwPlanModal();
  });

  $('hwPlanDoneBtn').addEventListener('click', () => {
    closeHwPlanModal();
    closeHwPopup();
  });
}
