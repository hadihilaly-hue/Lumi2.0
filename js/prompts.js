import { activeHwForClass, getStudyStyle, hwContext } from './homework.js';
import { S } from './state.js';
import { getSchedule } from './storage.js';


// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
export function getStudentName() { return localStorage.getItem('lumi_name') || 'there'; }
function getStudentGrade() { return localStorage.getItem('lumi_grade') || null; }

// Sidebar user-card subtitle: "11th · Menlo" if grade is known, else "Menlo".
// Called at initial auth and after Supabase profile load (covers fresh-device case).
export function setSidebarUserSubtitle() {
  const grade = localStorage.getItem('lumi_grade');
  const subtitle = grade ? `${grade}th · Menlo` : 'Menlo';
  const el = document.getElementById('sbUserEmail');
  if (el) el.textContent = subtitle;
}

// TM-4: update the test-mode banner copy with the active class. Called
// from openTutor whenever S.tutorCtx.course is set. No-op when not in
// test mode (the banner element is display:none for student users).
export function updateTestModeBanner(course) {
  if (!S.isTestMode) return;
  const text = document.getElementById('testModeBannerText');
  if (!text) return;
  text.textContent = course
    ? `TEST MODE — you're chatting with your own AI persona for ${course}.`
    : 'TEST MODE — open a class to test your AI persona.';
}
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

export function buildCompanionSystem() {
  return `You are Lumi — not an assistant, but a warm and genuinely curious companion who cares deeply about the people you talk with.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up concisely rather than stopping mid-thought.
When writing any math, always use LaTeX: inline math in $…$ and display math in $$…$$. Never use plain-text math like sqrt(x) or x^2 — always $\\sqrt{x}$ or $x^2$.

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

// Build a student-facing display name: "Mr. Harris" when title exists, else "Richard"
export function teacherDisplayName(fullName, profile) {
  if (profile?.title) {
    const lastName = fullName.split(' ').slice(-1)[0];
    return profile.title + ' ' + lastName;
  }
  // Last-name fallback when title isn't set on the row (older profiles
  // pre-dating the title column, or in-progress onboarding). More formal
  // than first-name and gender-neutral.
  return fullName.split(' ').slice(-1)[0];
}

// Two-letter initials for the avatar circle next to teacher messages.
// "Richard Harris" → "RH", "Madonna" → "M", empty → "✦".
export function teacherInitials(fullName) {
  if (!fullName || typeof fullName !== 'string') return '✦';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '✦';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function buildTutorSystem(subject, course, teacher, teacherProfile, workSamples = null) {
  const hasProfile = !!teacherProfile;
  const firstName = teacher.split(' ')[0];
  const displayName = teacherDisplayName(teacher, teacherProfile);

  // Q4: single boolean drives both this section AND buildApiMessages's
  // synthetic-exchange decision. False if any tier is missing description
  // OR loaded images. When false, ZERO bytes of work-samples wiring land
  // in the prompt (no header, no placeholder) — the prompt is byte-
  // identical to the pre-Q4 prompt for that concern. Per D5 descriptions
  // are OPTIONAL at save; graceful skip here when any tier's description
  // is empty is intentional (artifacts still inject via <<LUMI_WORK_ARTIFACTS>>).
  const ws = workSamples;
  const tiersAll = ['progressing','proficient','exemplary'];
  const hasAllTiers = !!ws
    && tiersAll.every(t => ws[t] && (ws[t].description || '').trim() && Array.isArray(ws[t].images) && ws[t].images.length > 0);

  if (hasProfile) {
    const p = teacherProfile;

    // Feature H (prompt caching): the profile branch returns an ARRAY of two
    // content blocks so a single cache_control breakpoint can sit at their
    // boundary (the companion + no-profile branches stay plain strings).
    //   SEG1 — static per teacher/class (+ static-global rules): identity,
    //          formatting, engagement rules, teaching voice, course info,
    //          syllabus, work-sample feedback descriptions, the teacher-stable
    //          <<LUMI_WORK_ARTIFACTS>> marker, and STUDENT MODE RULES. This is
    //          byte-identical across every student of the same class, so the
    //          Lambda's cache_control breakpoint can cache it cross-student.
    //   SEG2 — dynamic per student/day: student context, homework, the
    //          per-student <<LUMI_TEACHER_NOTES>> / <<LUMI_PROGRESS_NOTE>>
    //          markers, and the JSON footer.
    // studentCtx() USED to sit near the top (between the formatting rules and
    // the teacher sections); it is moved down into SEG2 so the static prefix is
    // contiguous. That single reorder is the only content move (docs/H_READINESS.md).
    let seg1 = `You are Lumi, ${displayName}'s 24/7 digital stand-in for their ${course} class at Menlo School. ${displayName} has given you a deep briefing on how they teach, and your job is to help this student exactly the way ${displayName} would — so teach in the FIRST PERSON, as ${displayName}. Do NOT talk about ${displayName} in the third person: never say "${displayName} would ask…", "${displayName}'s approach is…", or "here's how ${displayName} teaches." Just say it and do it directly, as them. Only name ${displayName} in the third person if the student explicitly asks who their teacher is.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up your current point concisely rather than stopping mid-thought.
When writing any math, always use LaTeX: inline math in $…$ and display math in $$…$$. Never use plain-text math like sqrt(x) or x^2 — always $\\sqrt{x}$ or $x^2$.

═══ HOW ${firstName.toUpperCase()} WANTS YOU TO HELP STUDENTS ═══
${p.engagement_rules || '(No rules specified)'}

═══ HOW ${firstName.toUpperCase()} TALKS AND TEACHES ═══
${p.teaching_voice || '(No voice specified)'}

═══ ABOUT THIS COURSE ═══
${p.course_info || '(No course info)'}`;

    // Include syllabus text if available
    if (p.syllabus_text) {
      seg1 += `\n\n═══ COURSE SYLLABUS ═══\n${p.syllabus_text}`;
    }

    // Q4: graded work-samples section. Gated on hasAllTiers — partial
    // states emit zero bytes here (and buildApiMessages also skips the
    // synthetic exchange in that case, so the "actual photos appear in
    // the conversation above" claim is never made without backing).
    if (hasAllTiers) {
      seg1 += `

═══ HOW ${firstName.toUpperCase()} GIVES FEEDBACK ═══
${displayName} has shared real examples of how they grade student work at three levels. The actual photos appear in the conversation above as evidence — study them carefully, especially their tone, word choice, comment length, and what they choose to flag vs. let pass. When you give feedback to this student, match how ${displayName} writes.

PROGRESSING-level (students still developing the skill):
${ws.progressing.description}

PROFICIENT-level (students meeting expectations):
${ws.proficient.description}

EXEMPLARY-level (students exceeding expectations):
${ws.exemplary.description}`;
    }

    // Q4 v2: teacher-stable text-artifact section is injected SERVER-SIDE
    // (Decision P1-A — text never reaches the browser). Emit the marker here in
    // the cacheable prefix, BEFORE <<LUMI_TEACHER_NOTES>> (per-student) below.
    // The chat Lambda replaces it with the built section or strips it to ''
    // (stray-marker safe → byte-identical when the teacher has no text artifacts).
    //
    // GATE POSTURE (Decision D7-A, docs/Q4V2_SPEC.md): text artifacts are gated
    // PER-TIER on the server (any tier with text emits; other tiers stay silent).
    // The PHOTO vision gate above is UNCHANGED — hasAllTiers still requires all
    // three tiers to have both a description and loaded images before the
    // "═══ HOW … GIVES FEEDBACK ═══" photo section and the synthetic image
    // exchange emit. The two gates are deliberately independent: a teacher with
    // one written example on "proficient" contributes text-only feedback voice
    // without pretending to have photo evidence for the other tiers.
    seg1 += `<<LUMI_WORK_ARTIFACTS>>`;

    seg1 += `

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
- Match ${displayName}'s voice, tone, and teaching style exactly
- When you have multiple feedback points, deliver ONE AT A TIME. List them as headlines first, then expand only the first one.
- If the student asks for everything at once, gently push back: "Let's tackle these one at a time so each one actually sticks. Start with [first point] — what would you change?" Wait for them to attempt a revision OR explain the point in their own words before moving to the next one.

FRUSTRATION AND TIME PRESSURE:
When a student expresses frustration or time pressure, acknowledge it in one sentence maximum, then immediately redirect to a single focused question. Never explain at length why you won't give direct answers — just don't give them, and get back to work.`;

    // SEG2 — dynamic per student/day. studentCtx() is moved here from the top
    // of the prompt so SEG1 above stays a contiguous, class-stable, cacheable
    // prefix. The <<LUMI_TEACHER_NOTES>> / <<LUMI_PROGRESS_NOTE>> markers live in
    // this dynamic block; the Lambda swaps them per-block server-side. The
    // leading blank line reproduces the paragraph break that previously sat
    // between STUDENT MODE RULES and the homework context.
    const seg2 = `

${studentCtx()}

${hwContext()}${activeHwForClass(course)}
Response length: SHORT — 1-3 sentences for simple questions. Longer only when a concept truly needs it. No essays.<<LUMI_TEACHER_NOTES>><<LUMI_PROGRESS_NOTE>>

After EVERY reply, append this JSON on its own line at the very end (stripped before display):
{"values":["..."],"goals":["..."],"interests":["..."]}
Only include NEWLY learned things about the student. Empty arrays if nothing new.
NEVER mention the JSON.`;

    // One cache_control breakpoint at the SEG1/SEG2 boundary. The Lambda
    // forwards this array to Bedrock's native `system` field unchanged.
    return [
      { type: 'text', text: seg1, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: seg2 },
    ];
  }

  // No profile yet — fallback to generic tutor
  return `You are tutoring a Menlo School student in ${course} with ${displayName}. Be helpful, specific to this subject, and calibrated to high school level.

Never begin a response with a code block or markdown formatting. Always start with plain conversational text.
Always complete your full response. If approaching length limits, wrap up concisely rather than stopping mid-thought.
When writing any math, always use LaTeX: inline math in $…$ and display math in $$…$$. Never use plain-text math like sqrt(x) or x^2 — always $\\sqrt{x}$ or $x^2$.

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
