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

// ─── CLAUDE API PROXY ─────────────────────────────────────────────────────────
const CLAUDE_PROXY_URL = 'https://mzrzmfkfjfdwsjwblbzz.supabase.co/functions/v1/claude-proxy';

// Helper to make authenticated API calls to the Claude proxy
async function fetchClaudeProxy(body, options = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated. Please sign in again.');
  }

  const res = await fetch(CLAUDE_PROXY_URL, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
    ...options,
    method: 'POST',
  });

  // Handle rate limiting
  if (res.status === 429) {
    const errData = await res.json().catch(() => ({}));
    const match = errData.error?.match(/\((\d+)\/day\)/);
    const limit = match ? match[1] : '100';
    throw new Error(`You've hit today's Lumi limit (${limit} messages per day). Try again tomorrow!`);
  }

  return res;
}

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
    "IP Capstone Seminar (H)": ["Peter Brown","Matthew Nelson"],
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
  const name       = localStorage.getItem('lumi_name');
  const grade      = localStorage.getItem('lumi_grade');
  const schedule   = getSchedule();
  const style      = getStudyStyle();
  const learning   = localStorage.getItem('lumi_learning_style') || '';
  const hwStart    = localStorage.getItem('lumi_hw_start') || '';
  const activities = localStorage.getItem('lumi_activities') || '';
  const painPts    = (() => { try { return JSON.parse(localStorage.getItem('lumi_pain_points') || '[]'); } catch { return []; } })();

  const learnMap = {
    step_by_step:  'prefers step-by-step walkthroughs',
    socratic:      'learns best through guiding questions',
    example_first: 'learns best by seeing an example first then doing it themselves',
    mixed:         'flexible learning style',
  };

  let ctx = name && grade
    ? `The student's name is ${name} and they are in grade ${grade} at Menlo School.`
    : name ? `The student's name is ${name} and they attend Menlo School.`
    : 'The student attends Menlo School.';

  if (schedule.length) ctx += `\nSchedule: ${schedule.map(s => `${s.course} (${s.teacher})`).join(', ')}.`;
  if (learning && learnMap[learning]) ctx += `\nLearning style: ${learnMap[learning]}.`;
  if (hwStart)    ctx += `\nUsually starts homework around ${hwStart}.`;
  if (activities) ctx += `\nTypical activities: ${activities}.`;
  if (painPts.length) ctx += `\nAreas that need extra support (never make them feel bad about these): ${painPts.join(', ')}.`;
  ctx += `\nStudy style: ${style.work_minutes} min work / ${style.break_minutes} min break (${style.label}).`;
  ctx += `\nBedtime: 10:30 PM — never schedule or encourage work past this time.`;
  return ctx;
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

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up concisely rather than stopping mid-thought.

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
  const firstName = teacher.split(' ')[0];

  if (hasProfile) {
    const p = teacherProfile;

    let prompt = `You are Lumi, acting as a 24/7 digital version of ${teacher} for their ${course} class at Menlo School. ${teacher} has given you a deep briefing on how they teach — your job is to help this student exactly the way ${teacher} would.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up your current point concisely rather than stopping mid-thought.

${studentCtx()}

═══ HOW ${firstName.toUpperCase()} WANTS YOU TO HELP STUDENTS ═══
${p.engagement_rules || '(No rules specified)'}

═══ HOW ${firstName.toUpperCase()} TALKS AND TEACHES ═══
${p.teaching_voice || '(No voice specified)'}

═══ ABOUT THIS COURSE ═══
${p.course_info || '(No course info)'}`;

    // Include syllabus text if available
    if (p.syllabus_text) {
      prompt += `\n\n═══ COURSE SYLLABUS ═══\n${p.syllabus_text}`;
    }

    prompt += `

═══ STUDENT MODE RULES — FOLLOW THESE AT ALL TIMES ═══

NEVER:
- Give direct answers to homework or test questions
- Say "that's wrong" — instead ask the student to walk through their reasoning
- Make more than one correction per response
- Generate analysis on behalf of the student — not even partially disguised as a hint
- Tell students what their conclusions should be
- Validate surface-level thinking to be encouraging — false floors are not kindness

ALWAYS:
- Ask the student to walk through their reasoning BEFORE you respond
- Find the single most important weakness and ask exactly ONE question targeting it
- Push back on reasoning quality, never on conclusions
- Let students find their own inconsistencies
- Match ${firstName}'s voice, tone, and teaching style exactly

FRUSTRATION AND TIME PRESSURE:
When a student expresses frustration or time pressure, acknowledge it in one sentence maximum, then immediately redirect to a single focused question. Never explain at length why you won't give direct answers — just don't give them, and get back to work.

${hwContext()}${activeHwForClass(course)}
Response length: SHORT — 1-3 sentences for simple questions. Longer only when a concept truly needs it. No essays.

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things about the student. Empty arrays if nothing new.
NEVER mention the JSON.`;
    return prompt;
  }

  // No profile yet — fallback to generic tutor
  return `You are tutoring a Menlo School student in ${course} with ${teacher}. Be helpful, specific to this subject, and calibrated to high school level.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up concisely rather than stopping mid-thought.

${studentCtx()}

Your tutoring style:
- Warm, encouraging, and patient
- Ask guiding questions rather than just giving answers
- Break down complex concepts step by step
- Give specific, actionable feedback
${TEACHING_PHILOSOPHY}
${hwContext()}${activeHwForClass(course)}
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
  })
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
  "Test Teacher":            "hadi.hilaly@menloschool.org",
};

// ── Teacher profile system — single source of truth: Supabase ──
// Seed profiles are pushed to Supabase on load; _profileCache is the in-memory fallback.
const _profileCache = {};
const _profileStatusCache = {}; // { 'course::teacher': 'ready' | 'pending' }

async function preloadProfileStatuses() {
  const schedule = getSchedule();
  if (!schedule.length) return;
  const emails = [...new Set(schedule.map(s => TEACHER_EMAIL_MAP[s.teacher]).filter(Boolean))];
  if (!emails.length) return;
  try {
    const { data, error } = await sb
      .from('teacher_profiles')
      .select('teacher_email, course_name, done')
      .in('teacher_email', emails);
    if (error) { console.warn('[preloadProfileStatuses] error:', error); return; }
    // Build a lookup: email__course -> done
    const lookup = {};
    (data || []).forEach(row => { lookup[row.teacher_email + '__' + row.course_name] = row.done; });
    // Map each scheduled class
    schedule.forEach(({ course, teacher }) => {
      const email = TEACHER_EMAIL_MAP[teacher];
      const key = course + '::' + teacher;
      if (!email) { _profileStatusCache[key] = 'pending'; return; }
      const done = lookup[email + '__' + course];
      _profileStatusCache[key] = done === true ? 'ready' : 'pending';
    });
    renderSidebar();
  } catch (e) { console.warn('[preloadProfileStatuses] failed:', e); }
}

// Single lookup function — Supabase first, then in-memory cache.
// Returns profile if complete, { __notReady } if in progress, null if not found.
async function getTeacherProfile(teacherName, course) {
  if (!teacherName || !course) return null;
  const email = TEACHER_EMAIL_MAP[teacherName];
  if (!email) { console.warn('[getTeacherProfile] no email for:', teacherName); return null; }
  const cacheKey = email + '__' + course;
  console.log('[getTeacherProfile] loading:', teacherName, course);

  // Try Supabase first (5s timeout)
  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 5000));
    const query = sb
      .from('teacher_profiles')
      .select('*')
      .eq('teacher_email', email)
      .eq('course_name', course)
      .maybeSingle();
    const result = await Promise.race([query, timeout]);
    if (result) {
      const { data, error } = result;
      if (!error && data) {
        console.log('[getTeacherProfile] Supabase hit, done:', data.done);
        _profileCache[cacheKey] = data; // update cache
        if (!data.done) return { __notReady: true };
        return data;
      }
      if (error) console.warn('[getTeacherProfile] query error:', error.message);
    } else {
      console.log('[getTeacherProfile] Supabase timed out');
    }
  } catch (e) {
    console.warn('[getTeacherProfile] Supabase failed:', e);
  }

  // Fall back to in-memory cache (seeded profiles)
  const cached = _profileCache[cacheKey];
  if (cached) {
    console.log('[getTeacherProfile] using cached profile');
    if (!cached.done) return { __notReady: true };
    return cached;
  }

  console.warn('[getTeacherProfile] NO PROFILE FOUND for:', teacherName, course);
  return null;
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
// API key is now server-side (Netlify function); no client-side key needed

let pendingAttachment = null;

// Tracks which classes have shown the intro slide (persisted across sessions)
const _introShownFor = new Set(
  (() => { try { return JSON.parse(localStorage.getItem('lumi_intro_shown') || '[]'); } catch { return []; } })()
);
function _saveIntroShown() { localStorage.setItem('lumi_intro_shown', JSON.stringify([..._introShownFor])); }

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
  // New onboarding fields
  const learning_style      = localStorage.getItem('lumi_learning_style') || null;
  const typical_activities  = localStorage.getItem('lumi_activities') || null;
  const homework_start_time = localStorage.getItem('lumi_hw_start') || null;
  const onboarding_complete = localStorage.getItem('lumi_onboarding_complete') === 'true';
  let pain_points = [];
  try { pain_points = JSON.parse(localStorage.getItem('lumi_pain_points') || '[]'); } catch {}
  let study_style = null;
  try { study_style = JSON.parse(localStorage.getItem('lumi_study_style') || 'null'); } catch {}

  sb.from('profiles').upsert({
    id:             currentUser.id,
    name:           name  || null,
    grade:          grade || null,
    values_profile,
    learning_style,
    pain_points,
    typical_activities,
    homework_start_time,
    study_style,
    onboarding_complete,
  })
    .then(({ error }) => { if (error) console.warn('Supabase profile sync error:', error); });
}

// Load profile from Supabase on new device (only if localStorage has no name)
async function loadProfileFromSupabase() {
  if (!currentUser) return;
  const hasName = !!localStorage.getItem('lumi_name');
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('name, grade, values_profile, schedule, learning_style, pain_points, typical_activities, homework_start_time, study_style, onboarding_complete')
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
    // Restore new onboarding fields if not already set
    if (data.learning_style && !localStorage.getItem('lumi_learning_style'))
      localStorage.setItem('lumi_learning_style', data.learning_style);
    if (data.pain_points?.length && !localStorage.getItem('lumi_pain_points'))
      localStorage.setItem('lumi_pain_points', JSON.stringify(data.pain_points));
    if (data.typical_activities && !localStorage.getItem('lumi_activities'))
      localStorage.setItem('lumi_activities', data.typical_activities);
    if (data.homework_start_time && !localStorage.getItem('lumi_hw_start'))
      localStorage.setItem('lumi_hw_start', data.homework_start_time);
    if (data.study_style && !localStorage.getItem('lumi_study_style'))
      localStorage.setItem('lumi_study_style', JSON.stringify(data.study_style));
    if (data.onboarding_complete && !localStorage.getItem('lumi_onboarding_complete'))
      localStorage.setItem('lumi_onboarding_complete', 'true');
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
  startLumi();
}

// ─── OPEN TUTOR SESSION ───────────────────────────────────────────────────────
async function openTutor(subjectId, course, teacher) {
  console.log('[openTutor] start:', { subjectId, course, teacher });
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
  let greeting;
  const firstName = teacher.split(' ')[0];

  if (profile?.__notReady) {
    greeting = `${firstName} hasn't finished setting up their Lumi profile yet — their interview is still in progress. Check back soon, or try General Chat in the meantime.`;
    S.tutorCtx.teacherProfile = null;
    msgInput.disabled = true;
    msgInput.placeholder = 'Chat unavailable \u2014 use General Chat until this teacher completes setup';
    $('sendBtn').disabled = true;
    console.warn('[openTutor] profile not ready for:', teacher, course);
  } else if (profile) {
    S.tutorCtx.teacherProfile = profile;
    if (profile.welcome_message) {
      renderTeacherNote(teacher, profile.welcome_message);
      greeting = `I'm ready when you are — ask me anything about ${course}.`;
    } else {
      greeting = `Hey! You're studying ${course} with ${firstName}. I've learned how ${firstName} teaches and what they look for — ask me anything and I'll help you the way ${firstName} would.`;
    }
    msgInput.disabled = false;
    msgInput.placeholder = 'Say something\u2026';
    $('sendBtn').disabled = false;
    // Show suggested prompts for new conversations
    setTimeout(() => renderEmptyState(profile, course), 50);
  } else {
    greeting = `\u26a0\ufe0f ${firstName} hasn't set up their Lumi profile for ${course} yet. Once they complete their setup interview, I'll be able to help you exactly the way ${firstName} teaches. In the meantime, you can use General Chat.`;
    S.tutorCtx.teacherProfile = null;
    msgInput.disabled = true;
    msgInput.placeholder = 'Chat unavailable \u2014 use General Chat until this teacher completes setup';
    $('sendBtn').disabled = true;
    console.error('[openTutor] NO PROFILE for:', teacher, course, '\u2014 student sees warning');
  }
  S.messages.push({ role: 'assistant', content: greeting });
  renderMsg('lumi', greeting, true);
  // Add "Open General Chat" button for pending/missing profiles
  if (!profile || profile.__notReady) {
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
function openGeneralChat() {
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

// ── Mobile long-press support ─────────────────────────────
function addLongPress(el, callback, duration = 500) {
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

function showInlineConfirm(anchorEl, text, onConfirm) {
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

  // Homework section — always visible when schedule is set
  if (schedule.length > 0) {
    renderHwSidebar(sbNav);
  }

  // My Classes section — always pinned, visible even during search
  if (schedule.length > 0) {
    const myHd = document.createElement('div');
    myHd.className = 'sb-my-classes-hd';
    myHd.innerHTML = `<span class="sb-star-hd">★</span> My Classes`;
    sbNav.appendChild(myHd);

    schedule.forEach(({ course, teacher }) => {
      const lastName = teacher ? teacher.split(' ').slice(-1)[0] : '';
      const isActive = SB.activeTeacher &&
        SB.activeTeacher.course === course &&
        SB.activeTeacher.teacher === teacher;
      const item = document.createElement('div');
      item.className = 'sb-my-class-item' + (isActive ? ' active' : '');
      const star = document.createElement('span');
      star.className = 'sb-my-class-star';
      star.textContent = '★';
      const name = document.createElement('span');
      name.className = 'sb-my-class-name';
      name.textContent = course;
      const tch = document.createElement('span');
      tch.className = 'sb-my-class-teacher';
      tch.textContent = lastName;
      const profileStatus = _profileStatusCache[course + '::' + teacher];
      const badge = document.createElement('span');
      badge.className = 'sb-profile-badge ' + (profileStatus === 'ready' ? 'ready' : 'pending');
      badge.textContent = '';
      badge.dataset.tip = profileStatus === 'ready' ? 'Profile ready' : 'Profile pending';
      item.appendChild(star);
      item.appendChild(name);
      item.appendChild(tch);
      item.appendChild(badge);
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
      addLongPress(item, () => openHistMenu(conv.id, menuBtn));
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

// ─── EMPTY STATE WITH SUGGESTED PROMPTS ──────────────────────────────────────
function getHomeworkOverridePrompt(course) {
  const tasks = getHwTasks().filter(t =>
    !t.isComplete &&
    t.className === course &&
    t.dueDate
  );
  if (!tasks.length) return null;

  // Sort by due date, get soonest
  tasks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const task = tasks[0];

  const today = new Date().toISOString().slice(0, 10);
  const daysUntilDue = dateDiffDays(today, task.dueDate);

  // Only override if due in next 3 days
  if (daysUntilDue > 3) return null;

  // Format relative date
  let relativeDate;
  if (daysUntilDue <= 0) relativeDate = 'today';
  else if (daysUntilDue === 1) relativeDate = 'tomorrow';
  else {
    const dueDay = new Date(task.dueDate + 'T12:00:00');
    relativeDate = dueDay.toLocaleDateString('en-US', { weekday: 'long' });
  }

  return `Help me with ${task.title} (due ${relativeDate})`;
}

function renderEmptyState(profile, course) {
  // Get prompts: teacher's custom or fallback
  let prompts = profile?.suggested_prompts;
  if (!prompts || !Array.isArray(prompts) || prompts.length < 3) {
    prompts = [
      "Help me with today's homework",
      "Quiz me on what we've been learning",
      "Explain a concept I'm stuck on"
    ];
  }

  // Check for homework override
  const hwOverride = getHomeworkOverridePrompt(course);
  if (hwOverride) {
    prompts = [hwOverride, prompts[1], prompts[2]];
  }

  const el = document.createElement('div');
  el.className = 'empty-state-prompts';
  el.id = 'emptyStatePrompts';
  el.innerHTML = `
    <div class="esp-heading">Hi! I'm Lumi — what do you want to work on?</div>
    <div class="esp-chips">
      ${prompts.map((p, i) => `<button class="esp-chip" data-index="${i}">${escHtml(p)}</button>`).join('')}
    </div>
  `;

  // Wire chip clicks
  el.querySelectorAll('.esp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      msgInput.value = chip.textContent;
      msgInput.focus();
      autoGrow(msgInput);
      updateSendBtn();
    });
  });

  messagesEl.appendChild(el);
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

  // Steps: 0=grade, 1=classes, 2=teachers, 3=study-style, 4=confirm
  const stepEls = [$('ssStep1'), $('ssStep2'), $('ssStep3'), $('ssStep4'), $('ssStep5')];

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
      showStyleStep();
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
    setStep(4);
  });

  $('ssStep5Back').addEventListener('click', () => {
    setStep(3);
  });

  $('ssStep5Done').addEventListener('click', () => {
    const schedule = getSelectedArray().map(course => {
      const subject = Object.entries(MENLO_CURRICULUM)
        .find(([, courses]) => courses[course])?.[0] || '';
      return { course, teacher: teacherChoices[course] || '', subject };
    });
    saveScheduleLocal(schedule);
    if (chosenGrade) localStorage.setItem('lumi_grade', chosenGrade);
    saveStudyStyle(chosenStyle);
    syncScheduleToSupabase(schedule);
    syncStudyStyleToSupabase(chosenStyle);
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; onDone(); }, 350);
  });

  setStep(0);
}

// ─── ONBOARDING (Conversational AI) ──────────────────────────────────────────

// Onboarding conversation state
const OB = {
  messages: [],
  profile: {
    name: '',
    study_style: { work_minutes: 25, break_minutes: 5, label: 'Short Bursts' },
    learning_style: 'mixed', homework_start_time: '18:00',
    typical_activities: '', pain_points: [],
    calendar_connected: false, onboarding_complete: false,
  },
  busy:   false,
  onDone: null,
};

function buildOnboardingSystem() {
  return `You are Lumi, a warm and genuinely curious AI study buddy at Menlo School. This is your first conversation with a new student. Your job: get to know them in 5 quick questions. Do NOT ask about their grade or classes — those are collected separately via a form after this chat.

OPEN WITH THIS EXACT MESSAGE (then wait for a "yes" or "ready" before asking Q1):
"Hey! I'm Lumi — your Menlo study buddy. I'm not like a typical AI assistant. My whole job is to actually help you learn and stay on top of your work. To do that well I need to get to know you a little first. I've got 5 quick questions — takes about 2 minutes. Ready?"

QUESTIONS — ask one at a time, react warmly to each answer before moving on. Use their name from Q1 onward.

Q1: "First — what's your name?"
Q2: "How do you like to study? Shorter bursts with breaks — like 25 on, 5 off? Longer sessions to really get into flow? Or something else?"
Q3: "What does a typical school night look like for you? Any sports, activities, or jobs — and when do you usually start homework?"
Q4: "When you're really stuck on something — what actually helps? Step-by-step walkthrough, guiding questions until you get it yourself, or seeing a worked example and running with it?"
Q5: "Last thing — what's the hardest part of school for you right now? Could be a subject, keeping up with deadlines, test anxiety — anything." If they bring up wanting to connect Google Calendar, include ###SHOW_CAL_BUTTON on its own line.

WRAP UP: After Q5 is answered, say:
"Perfect, [Name]! I've got what I need. Next up I'll have you pick your grade and classes — that'll just take a second.
⏱ Study style: [work_minutes] on, [break_minutes] off
🌙 Bedtime: 10:30pm — I'll never schedule work past that
[📅 Calendar: Connected ✓] (only show this line if they connected it)

Once your classes are set we're good to go. Let's do it! 🎉"

RULES:
- One question at a time — never ask two things at once
- React genuinely before moving on ("Nice, I love that approach!" etc.)
- Do NOT ask about grade or classes — the form handles that
- If they give a vague answer, gently probe once for more detail
- Keep the whole thing warm and under 3 minutes
- The 10:30pm bedtime is non-negotiable — mention it warmly in the wrap-up, don't ask about it
- Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
- Always complete your full response. If approaching length limits, wrap up your current point concisely rather than stopping mid-thought.

After EVERY response (including the opening), append on the very last line:
###PROFILE_UPDATE:{"name":"","study_style":{"work_minutes":25,"break_minutes":5,"label":"Short Bursts"},"learning_style":"mixed","homework_start_time":"18:00","typical_activities":"","pain_points":[],"calendar_connected":false,"onboarding_complete":false}

Only fill in fields you've actually learned. Empty strings/arrays for unknown fields.
learning_style options: "step_by_step" | "socratic" | "example_first" | "mixed"
Set onboarding_complete to true ONLY in the wrap-up message after Q5.
NEVER mention the JSON to the student. NEVER display it.`;
}

function initOnboarding(onDone) {
  OB.onDone    = onDone;
  OB.messages  = [];
  OB.busy      = false;
  const ob = $('onboarding');
  ob.style.display = '';

  // Pre-fill name from Google account
  const googleName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || '';
  if (googleName) OB.profile.name = googleName.split(' ')[0];

  showObChatUI();
  startObConversation();
}

function showObChatUI() {
  $('obChatWrap').style.display = '';
  const input = $('obInput');
  const btn   = $('obSend');
  input.addEventListener('input', () => {
    obAutoGrow(input);
    btn.disabled = !input.value.trim() || OB.busy;
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !OB.busy) { e.preventDefault(); obSend(); }
  });
  btn.addEventListener('click', obSend);
}

function obAutoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 110) + 'px'; }

function obRenderMsg(role, rawText, animate = false) {
  const msgs = $('obMessages');
  const wrap  = document.createElement('div');
  wrap.className = 'ob-msg ' + role;

  if (role === 'lumi') {
    const av  = document.createElement('div');
    av.className = 'ob-msg-avatar';
    av.textContent = '✦';
    wrap.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = 'ob-msg-bubble';

  const hasCalBtn = rawText.includes('###SHOW_CAL_BUTTON');
  const text = rawText.replace(/###SHOW_CAL_BUTTON\s*/g, '').trim();

  // Basic markdown rendering
  bubble.innerHTML = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,'<em>$1</em>')
    .replace(/\n\n+/g,'</p><p>')
    .replace(/\n/g,'<br>')
    .replace(/^/,'<p>').replace(/$/,'</p>');

  if (hasCalBtn) {
    const calBtn = document.createElement('button');
    calBtn.className = 'ob-cal-btn';
    calBtn.textContent = '📅 Connect Google Calendar';
    calBtn.addEventListener('click', async () => {
      calBtn.disabled = true;
      calBtn.textContent = 'Connecting…';
      await connectGoogleCalendar();
    });
    bubble.appendChild(calBtn);
  }

  wrap.appendChild(bubble);
  if (animate) { wrap.classList.add('ob-msg-enter'); }
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  if (animate) requestAnimationFrame(() => wrap.classList.add('ob-msg-visible'));
}

function obShowTyping() {
  const msgs = $('obMessages');
  const wrap  = document.createElement('div');
  wrap.className = 'ob-msg lumi';
  wrap.id = 'obTyping';
  const av = document.createElement('div'); av.className = 'ob-msg-avatar'; av.textContent = '✦';
  const bubble = document.createElement('div'); bubble.className = 'ob-msg-bubble';
  bubble.innerHTML = '<div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  wrap.appendChild(av); wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}
function obHideTyping() { const t = $('obTyping'); if (t) t.remove(); }

function obParseProfile(text) {
  // Use brace-counting instead of regex to handle nested JSON (e.g. study_style:{...})
  const idx = text.lastIndexOf('###PROFILE_UPDATE:');
  if (idx === -1) return null;
  const jsonStart = text.indexOf('{', idx);
  if (jsonStart === -1) return null;
  let depth = 0, i = jsonStart;
  while (i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  try { return JSON.parse(text.slice(jsonStart, i + 1)); } catch { return null; }
}

function obStripProfile(text) {
  const idx = text.lastIndexOf('###PROFILE_UPDATE:');
  if (idx === -1) return text.trim();
  return text.slice(0, idx).trim();
}

function obApplyProfile(data) {
  if (!data) return;
  if (data.name)                          OB.profile.name               = data.name;
  if (data.study_style?.work_minutes)     OB.profile.study_style        = data.study_style;
  if (data.learning_style && data.learning_style !== 'mixed') OB.profile.learning_style = data.learning_style;
  if (data.homework_start_time && data.homework_start_time !== '18:00') OB.profile.homework_start_time = data.homework_start_time;
  if (data.typical_activities)            OB.profile.typical_activities = data.typical_activities;
  if (data.pain_points?.length)           OB.profile.pain_points        = data.pain_points;
  if (data.calendar_connected)            OB.profile.calendar_connected = data.calendar_connected;
  if (data.onboarding_complete)           OB.profile.onboarding_complete = data.onboarding_complete;

  // Persist to localStorage immediately
  if (OB.profile.name)               localStorage.setItem('lumi_name',           OB.profile.name);
  if (OB.profile.learning_style)     localStorage.setItem('lumi_learning_style', OB.profile.learning_style);
  if (OB.profile.homework_start_time !== '18:00') localStorage.setItem('lumi_hw_start', OB.profile.homework_start_time);
  if (OB.profile.typical_activities) localStorage.setItem('lumi_activities',     OB.profile.typical_activities);
  if (OB.profile.pain_points?.length) localStorage.setItem('lumi_pain_points',  JSON.stringify(OB.profile.pain_points));
  if (OB.profile.study_style?.work_minutes) saveStudyStyle(OB.profile.study_style);
  if (OB.profile.calendar_connected) setCalendarConnected(true);

  // On completion, save personality profile to Supabase (grade/schedule saved later by initScheduleSetup)
  if (OB.profile.onboarding_complete) {
    localStorage.setItem('lumi_onboarding_complete', 'true');
    obSaveFullProfile();
  }
}

function obMatchSchedule(rawList) {
  return rawList.map(({ course, teacher }) => {
    const cNorm = (course || '').toLowerCase();
    for (const [subject, courses] of Object.entries(MENLO_CURRICULUM)) {
      for (const [cName, teachers] of Object.entries(courses)) {
        const cnNorm = cName.toLowerCase();
        const words  = cNorm.split(/\s+/);
        if (cnNorm.includes(cNorm) || words.some(w => w.length > 3 && cnNorm.includes(w))) {
          const tNorm   = (teacher || '').toLowerCase();
          // Try to find a match in the curriculum — if no match, keep what the student said
          const matched = teachers.find(t =>
            t.toLowerCase().includes(tNorm) ||
            tNorm.includes(t.split(' ').slice(-1)[0].toLowerCase())
          ) || teacher || '';
          return { course: cName, teacher: matched, subject };
        }
      }
    }
    return { course: course || '', teacher: teacher || '', subject: 'Other' };
  }).filter(s => s.course);
}

async function obSaveFullProfile() {
  if (!currentUser) return;
  // Save only the personality fields collected during the chat.
  // Grade and schedule are saved separately by initScheduleSetup.
  try {
    await sb.from('profiles').upsert({
      id:                  currentUser.id,
      name:                OB.profile.name  || null,
      study_style:         OB.profile.study_style,
      learning_style:      OB.profile.learning_style  || 'mixed',
      homework_start_time: OB.profile.homework_start_time || '18:00',
      typical_activities:  OB.profile.typical_activities || '',
      pain_points:         OB.profile.pain_points || [],
      calendar_connected:  OB.profile.calendar_connected || false,
      onboarding_complete: true,
    });
  } catch (e) { console.warn('Profile save error:', e); }
}

async function startObConversation() {
  OB.busy = true;
  obShowTyping();

  // Seed with Google name if available so AI uses it immediately
  const seedMsg = OB.profile.name
    ? `Hi! My name is ${OB.profile.name}.`
    : 'Hi!';

  try {
    const res = await fetchClaudeProxy({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: buildOnboardingSystem(),
      messages: [{ role: 'user', content: seedMsg }],
    });
    obHideTyping();
    if (!res.ok) throw new Error('API error ' + res.status);
    const resp = await res.json();
    const full = resp.content?.[0]?.text || '';
    const profileData = obParseProfile(full);
    const clean = obStripProfile(full);
    OB.messages = [
      { role: 'user', content: seedMsg },
      { role: 'assistant', content: clean },
    ];
    obRenderMsg('lumi', clean, true);
    if (profileData) obApplyProfile(profileData);
  } catch (e) {
    obHideTyping();
    obRenderMsg('lumi', "Hey! I'm Lumi — your Menlo study buddy. I'm having a bit of trouble connecting. Please check your API key in settings and refresh the page.", true);
  }
  OB.busy = false;
  const btn = $('obSend');
  if (btn) btn.disabled = false;
}

async function obSend() {
  const input = $('obInput');
  const text  = input.value.trim();
  if (!text || OB.busy) return;

  input.value = '';
  input.style.height = 'auto';
  $('obSend').disabled = true;

  obRenderMsg('student', text);
  OB.messages.push({ role: 'user', content: text });

  OB.busy = true;
  obShowTyping();

  try {
    const res = await fetchClaudeProxy({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: buildOnboardingSystem(),
      messages: OB.messages,
    });
    obHideTyping();
    if (!res.ok) throw new Error('API error ' + res.status);
    const resp = await res.json();
    const full  = resp.content?.[0]?.text || '';
    const profileData = obParseProfile(full);
    const clean = obStripProfile(full);
    OB.messages.push({ role: 'assistant', content: clean });
    obRenderMsg('lumi', clean, true);
    if (profileData) obApplyProfile(profileData);
    if (profileData?.onboarding_complete) {
      setTimeout(() => obFinish(), 2000);
    }
  } catch (e) {
    obHideTyping();
    obRenderMsg('lumi', 'Something went wrong — ' + (e.message || 'please try again.'), true);
  }

  OB.busy = false;
  $('obSend').disabled = !($('obInput').value.trim());
}

function obFinish() {
  const ob = $('onboarding');
  ob.classList.add('hidden');
  setTimeout(() => {
    ob.style.display = 'none';
    if (OB.onDone) OB.onDone();
  }, 400);
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

// ─── VOICE / SPEECH ───────────────────────────────────────────────────────────
let _recognition     = null;
let _voiceMode       = localStorage.getItem('lumi_voice_mode') === 'true';
let _muteTts         = localStorage.getItem('lumi_mute_tts')   === 'true';
let _isRecording     = false;
let _lastWasVoice    = false;
let _silenceTimer    = null;   // 2.5s silence → auto-stop
let _transcript      = '';     // latest transcript text
let _isSpeaking      = false;

function initVoice() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('micBtn');
  if (!SpeechRec) {
    if (micBtn) { micBtn.disabled = true; micBtn.title = 'Voice input not supported — try Chrome'; }
    return;
  }

  _recognition = new SpeechRec();
  _recognition.lang = 'en-US';
  _recognition.interimResults = true;
  _recognition.continuous = true;   // we control when to stop

  _recognition.onstart = () => {
    _isRecording = true;
    _transcript  = '';
    _updateMicBtn();
    _showListeningBar(true);
    _hideConfirmBar();
  };

  _recognition.onresult = (e) => {
    // Collect full transcript (interim + final)
    _transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    msgInput.value = _transcript;
    autoGrow(msgInput);
    updateSendBtn();
    // Reset 2.5s silence timer on every new result
    clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(() => _stopRecording(), 2500);
  };

  _recognition.onend = () => {
    _isRecording = false;
    clearTimeout(_silenceTimer);
    _updateMicBtn();
    _showListeningBar(false);
    // Show confirmation bar if we captured anything
    if (_transcript.trim()) {
      _showConfirmBar(_transcript.trim());
    }
  };

  _recognition.onerror = (e) => {
    _isRecording = false;
    clearTimeout(_silenceTimer);
    _updateMicBtn();
    _showListeningBar(false);
    if (e.error === 'not-allowed') {
      showToast('Please allow microphone access in your browser settings to use voice input.');
    }
    // Keep whatever was transcribed so far — still show confirm if there's text
    if (_transcript.trim()) _showConfirmBar(_transcript.trim());
  };

  if (_voiceMode) {
    document.body.classList.add('voice-mode-on');
    _startRecording();
  }
}

function _startRecording() {
  if (!_recognition) return;
  if (_isRecording) { _stopRecording(); return; }
  _hideConfirmBar();
  msgInput.value = '';
  updateSendBtn();
  try { _recognition.start(); } catch(e) {}
}

function _stopRecording() {
  clearTimeout(_silenceTimer);
  if (_recognition && _isRecording) { try { _recognition.stop(); } catch(e) {} }
  // onend fires next and handles showing the confirm bar
}

function _updateMicBtn() {
  const btn = $('micBtn');
  if (!btn) return;
  btn.classList.toggle('recording',    _isRecording);
  btn.classList.toggle('voice-active', _isRecording && _voiceMode);
}

function _showListeningBar(show) {
  const bar = $('voiceListeningBar');
  if (bar) bar.classList.toggle('active', show);
}

// ── Confirmation bar ──────────────────────────────────────────────────────────
function _showConfirmBar(text) {
  const bar    = $('voiceConfirmBar');
  const textEl = $('voiceConfirmText');
  if (!bar || !textEl) return;
  textEl.textContent = `"${text}"`;
  bar.classList.add('active');
}

function _hideConfirmBar() {
  const bar = $('voiceConfirmBar');
  if (bar) bar.classList.remove('active');
}

function _voiceConfirmSend() {
  _hideConfirmBar();
  _lastWasVoice = true;
  doSend();
}

function _voiceConfirmRerecord() {
  _hideConfirmBar();
  msgInput.value = '';
  updateSendBtn();
  _startRecording();
}

function _voiceConfirmCancel() {
  _hideConfirmBar();
  msgInput.value = '';
  msgInput.style.height = 'auto';
  updateSendBtn();
  _transcript = '';
}

// Speak a Lumi response aloud
function speakResponse(text) {
  if (_muteTts || !text || !window.speechSynthesis) return;
  speechSynthesis.cancel();

  // Strip markdown/HTML so it reads cleanly
  const clean = text
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n\n+/g, '. ')
    .replace(/\n/g, ' ')
    .slice(0, 800)   // cap at ~800 chars so it doesn't drone on
    .trim();

  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate   = 1.0;
  utterance.pitch  = 1.0;
  utterance.volume = 1.0;

  const pickVoice = () => {
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.name.includes('Samantha') ||
      v.name.includes('Karen') ||
      v.name.includes('Google US English') ||
      (v.lang === 'en-US' && v.localService)
    );
    if (preferred) utterance.voice = preferred;
  };
  pickVoice();
  if (!speechSynthesis.getVoices().length) speechSynthesis.onvoiceschanged = pickVoice;

  _isSpeaking = true;
  utterance.onend = () => {
    _isSpeaking = false;
    // In voice mode, restart mic after Lumi finishes speaking
    if (_voiceMode && !_isRecording) setTimeout(_startRecording, 350);
  };
  utterance.onerror = () => { _isSpeaking = false; };

  try { speechSynthesis.speak(utterance); } catch(e) {}
}

// Attach a speaker button to a Lumi message element
function _addSpeakerBtn(msgEl, text) {
  const btn = document.createElement('button');
  btn.className  = 'msg-speak-btn';
  btn.title      = 'Read aloud';
  btn.innerHTML  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  btn.addEventListener('click', () => {
    speechSynthesis.cancel();
    btn.classList.add('speaking');
    speakResponse(text);
    setTimeout(() => btn.classList.remove('speaking'), 300);
  });
  const head = msgEl.querySelector('.msg-head');
  if (head) head.appendChild(btn);
}

function wireVoiceListeners() {
  // Mic button — tap to start, tap again to stop early
  const micBtn = $('micBtn');
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (!_recognition) { showToast('Voice input not supported in this browser — try Chrome'); return; }
      if (_isRecording) { _stopRecording(); }
      else { _startRecording(); }
    });
  }

  // Confirmation bar buttons
  const confirmSend     = $('voiceConfirmSend');
  const confirmRerecord = $('voiceConfirmRerecord');
  const confirmCancel   = $('voiceConfirmCancel');
  if (confirmSend)     confirmSend.addEventListener('click', _voiceConfirmSend);
  if (confirmRerecord) confirmRerecord.addEventListener('click', _voiceConfirmRerecord);
  if (confirmCancel)   confirmCancel.addEventListener('click', _voiceConfirmCancel);

  // Voice Mode toggle
  const vmToggle = $('voiceModeToggle');
  if (vmToggle) {
    vmToggle.checked = _voiceMode;
    vmToggle.addEventListener('change', () => {
      _voiceMode = vmToggle.checked;
      localStorage.setItem('lumi_voice_mode', _voiceMode);
      document.body.classList.toggle('voice-mode-on', _voiceMode);
      if (_voiceMode) {
        _startRecording();
      } else {
        _stopRecording();
        speechSynthesis.cancel();
      }
    });
  }

  // Mute TTS toggle
  const muteToggle = $('muteTtsToggle');
  if (muteToggle) {
    muteToggle.checked = _muteTts;
    muteToggle.addEventListener('change', () => {
      _muteTts = muteToggle.checked;
      localStorage.setItem('lumi_mute_tts', _muteTts);
      if (_muteTts) speechSynthesis.cancel();
    });
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  // Theme
  if (localStorage.getItem('lumi_theme') === 'light') {
    document.documentElement.classList.add('light');
    themeToggle.checked = true;
  }

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
    const light = themeToggle.checked;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('lumi_theme', light ? 'light' : 'dark');
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
            }),
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
    await loadProjectsFromSupabase();
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

function openSidebar()   { $('sidebar').classList.add('open');    $('sbOverlay').classList.add('open'); }
function closeSidebar()  { $('sidebar').classList.remove('open'); $('sbOverlay').classList.remove('open'); }
function openSettings()  { $('settingsDrawer').classList.add('open');    $('settingsOverlay').classList.add('open'); }
function closeSettings() { $('settingsDrawer').classList.remove('open'); $('settingsOverlay').classList.remove('open'); }

function updateSendBtn() {
  sendBtn.disabled = (!msgInput.value.trim() && !pendingAttachment) || S.busy;
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
  // Remove prompt cards and empty state on first send
  const pc = $('generalPromptCards'); if (pc) pc.remove();
  const esp = $('emptyStatePrompts'); if (esp) esp.remove();
  if (S.busy) return;
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
  if (!firstUserMsg) return;
  const convs = getConvs();
  if (!convs[convId] || convs[convId].title) return;
  try {
    const prompt = `Generate a short 4-6 word title for this conversation. Just the title, nothing else, no punctuation at the end: ${firstUserMsg.slice(0, 300)}`;
    const res = await fetchClaudeProxy({ model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: prompt }] });
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

  try {
    let system = S.tutorCtx
      ? buildTutorSystem(S.tutorCtx.subjectName, S.tutorCtx.course, S.tutorCtx.teacher, S.tutorCtx.teacherProfile || null)
      : buildCompanionSystem();

    // Inject active project context if the student is working on a project
    if (_currentProjId) {
      const proj = getProjects().find(p => p.id === _currentProjId);
      if (proj) {
        const today = todayStr();
        const todayTask = proj.plan.find(d => d.date === today && !d.isComplete);
        const taskLabel = todayTask ? todayTask.label : proj.plan[0]?.label || 'getting started';
        system += `\n\nACTIVE PROJECT CONTEXT:
The student is working on: ${proj.title}
Class: ${proj.className}
Due date: ${proj.dueDate}
Today's task: ${taskLabel}
${proj.requirements ? 'Requirements: ' + proj.requirements : ''}

If they uploaded a rubric or project instructions it will be attached to their first message — read it carefully and use it to guide your help throughout the conversation.

Remember: help them THINK through the project, never do it for them. Ask guiding questions, help them brainstorm, review their work, but the thinking must be theirs.`;
      }
    }
    const { clean, data } = await callAPI(S.messages, system);
    typing.remove();
    S.messages.push({ role: 'assistant', content: clean });
    S.exchangeCount++;
    saveCurrentConv();
    renderMsg('lumi', clean, true);
    // Speak aloud if voice was used OR voice mode is on
    if (_lastWasVoice || _voiceMode) { speakResponse(clean); _lastWasVoice = false; }
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
async function callAPI(msgs, system) {
  const res = await fetchClaudeProxy({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    stream: true,
    system,
    messages: msgs,
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

// ─── RENDER TEACHER NOTE ────────────────────────────────────────────────────
function renderTeacherNote(teacher, message) {
  const firstName = teacher.split(' ')[0];
  const el = document.createElement('div');
  el.className = 'teacher-note';
  const label = document.createElement('div');
  label.className = 'teacher-note-label';
  label.textContent = `A note from ${firstName}`;
  const bubble = document.createElement('div');
  bubble.className = 'teacher-note-bubble';
  bubble.textContent = message;
  el.append(label, bubble);
  messagesEl.appendChild(el);
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
    // Speaker button added after bubble is built (needs text) — deferred below
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

  // Add speaker button to Lumi messages after bubble is in the DOM
  if (role === 'lumi') {
    const plainText = typeof content === 'string' ? content
      : (Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '');
    if (plainText) _addSpeakerBtn(el, plainText);
  }
}

function fmtText(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') return marked.parse(text, { breaks: true });
  // Fallback if marked hasn't loaded
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

// ── Calendar state (session-only, never persisted) ─────────
let _calEvents  = [];    // [{title, start, end, id}]
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

function getStudyStyle() {
  try {
    return JSON.parse(localStorage.getItem('lumi_study_style') || 'null')
      || { work_minutes: 25, break_minutes: 5, label: 'Short Bursts' };
  } catch { return { work_minutes: 25, break_minutes: 5, label: 'Short Bursts' }; }
}
function saveStudyStyle(style) { localStorage.setItem('lumi_study_style', JSON.stringify(style)); }
async function syncStudyStyleToSupabase(style) {
  if (!currentUser) return;
  try {
    await sb.from('profiles').upsert({ id: currentUser.id, study_style: style });
  } catch {}
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
function setCalendarConnected(val) {
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

async function loadCalendarEvents() {
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

function updateCalUi() {
  const connected = isCalendarConnected();
  const cs = $('calConnectedState');
  const ds = $('calDisconnectedState');
  if (cs) cs.style.display = connected ? '' : 'none';
  if (ds) ds.style.display = connected ? 'none' : '';
}

async function connectGoogleCalendar() {
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/calendar.readonly',
        redirectTo: window.location.href,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    if (error) showToast('Calendar connection failed: ' + error.message);
  } catch { showToast('Calendar connection failed.'); }
}

function wireCalListeners() {
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

function closeTimelineModal() {
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
function buildStudyPlanWithCalendar(tasks) {
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

function getHwTasks() {
  try { return JSON.parse(localStorage.getItem('lumi_hw_tasks') || '[]'); } catch { return []; }
}
function saveHwTasks(tasks) { localStorage.setItem('lumi_hw_tasks', JSON.stringify(tasks)); }
function genHwId() { return 'hw_' + Math.random().toString(36).slice(2, 10); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Load teacher profiles for time hints — uses same teacher_email + class_name lookup
const _hwProfileCache = {};
async function getTeacherProfileCached(course, teacherName) {
  const email = TEACHER_EMAIL_MAP[teacherName];
  if (!email) return null;
  const key = email + '__' + course;
  if (_hwProfileCache[key] !== undefined) return _hwProfileCache[key];
  // Check the main profile cache first (seeded profiles)
  if (_profileCache[key]) { _hwProfileCache[key] = _profileCache[key]; return _profileCache[key]; }
  try {
    const { data } = await sb.from('teacher_profiles').select('*')
      .eq('teacher_email', email).eq('course_name', course).maybeSingle();
    _hwProfileCache[key] = data || null;
  } catch { _hwProfileCache[key] = null; }
  return _hwProfileCache[key];
}

// ── Daily popup check ──────────────────────────────────────
function checkDailyHwPrompt() {
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
function openHwBackdrop()  { $('hwBackdrop').classList.add('open'); }
function closeHwBackdrop() { $('hwBackdrop').classList.remove('open'); }

function showHwPopup() {
  sessionStorage.setItem('homeworkCheckinShown', 'true');
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

function closeHwPlanModal() {
  const modal = $('hwPlanModal');
  const backdrop = $('hwPlanBackdrop');
  modal.classList.remove('open');
  backdrop.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 300);
}

// ── Render popup task list ─────────────────────────────────
function renderHwPopupTasks() {
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

function addHwTask(task) {
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

function buildStudyPlan(tasks) {
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

function startPlannerStrip(blocks) {
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

function advancePlannerBlock() {
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
function renderHwSidebar(container) {
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
function hwContext() {
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
function activeHwForClass(course) {
  const tasks = getHwTasks().filter(t => !t.isComplete && t.className === course);
  if (!tasks.length) return '';
  tasks.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1);
  const t = tasks[0];
  const dueStr = t.dueDate || 'no specific date';
  return `\nThe student is currently working on: ${t.title}, due ${dueStr}. Tailor your guidance toward helping them complete this assignment.`;
}

// ── Supabase sync ──────────────────────────────────────────
function syncHwToSupabase() {
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
    sb.from('homework_tasks').delete().eq('user_id', currentUser.id).then(() => {});
    return;
  }
  sb.from('homework_tasks').upsert(rows, { onConflict: 'id' })
    .then(({ error }) => { if (error) console.warn('[syncHw] upsert error:', error); });
}

// ══════════════════════════════════════════════════════════
// ── PROJECT / MULTI-DAY PLAN SYSTEM ──────────────────────
// ══════════════════════════════════════════════════════════

function getProjects() {
  try { return JSON.parse(localStorage.getItem('lumi_projects') || '[]'); } catch { return []; }
}
function saveProjects(projects) { localStorage.setItem('lumi_projects', JSON.stringify(projects)); }
function genProjId() { return 'proj_' + Math.random().toString(36).slice(2, 10); }

function fmtDateShort(dateStr) {
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

function dateDiffDays(a, b) {
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

function showWorkTypeChooser() {
  openHwBackdrop();
  const modal = $('hwTypeChooser');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));
}

function closeWorkTypeChooser() {
  const modal = $('hwTypeChooser');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

let _projPendingFile = null; // { file, base64, mediaType, isImage, isText }

function showProjectCreateModal(prefill = {}) {
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

function clearProjFile() {
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

function wireProjDropzone() {
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

function closeProjectCreateModal() {
  const modal = $('projCreateModal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

let _currentProjId = null; // tracks which project the plan modal is showing

function showProjectPlanModal(project) {
  _currentProjId = project.id;
  const modal = $('projPlanModal');
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  requestAnimationFrame(() => modal.classList.add('open'));
  renderProjectPlan(project);
}

function closeProjectPlanModal() {
  const modal = $('projPlanModal');
  modal.classList.remove('open');
  _currentProjId = null;
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

// ── Render the multi-day plan ────────────────────────────

function renderProjectPlan(project) {
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

function createProject(title, className, teacherName, dueDate, requirements, fileData) {
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

function injectProjectTasksToHomework() {
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
          pendingAttachment = {
            file: { name: att.name, size: 0, type: att.mediaType },
            base64: att.base64,
            mediaType: att.mediaType,
            isImage: !!att.isImage,
            isText: !!att.isText
          };
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

// ── Sync projects to Supabase ────────────────────────────

// Projects are stored in localStorage only (no Supabase column exists)
function syncProjectsToSupabase() {
  // no-op: projects live in localStorage only
}

function deleteProject(projId, anchorEl) {
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

function clearAllChats() {
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

function clearCompletedProjects() {
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

// Projects are stored in localStorage only (no Supabase column exists)
function loadProjectsFromSupabase() {
  // no-op: projects live in localStorage only
}

// hw_tasks column does not exist in profiles table — localStorage only
async function loadHwFromSupabase() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb
      .from('homework_tasks')
      .select('*')
      .eq('user_id', currentUser.id);
    if (error) { console.warn('[loadHw] error:', error); return; }
    if (!data || !data.length) return;
    const tasks = data.map(row => ({
      id: row.id,
      title: row.title,
      className: row.class_name || '',
      teacherName: row.teacher_name || '',
      dueDate: row.due_date || '',
      estimatedMinutes: row.estimated_minutes || null,
      isComplete: !!row.is_complete,
      createdAt: row.created_at,
    }));
    saveHwTasks(tasks);
  } catch (e) { console.warn('[loadHw] failed:', e); }
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
      _currentProjId = project.id;
      console.log('Set current project:', project.id);
      renderProjectPlan(project);
      syncProjectsToSupabase();
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
