import { fetchClaudeProxy } from './api.js';
import { MENLO_CURRICULUM } from './data.js';
import { connectGoogleCalendar, saveStudyStyle, setCalendarConnected } from './homework.js';
import { $, currentUser } from './state.js';
import { rdsFetch } from './teachers.js';
import { showToast } from './ui.js';


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

export function initOnboarding(onDone) {
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
  const obRow = {
    name:                OB.profile.name  || null,
    study_style:         OB.profile.study_style,
    learning_style:      OB.profile.learning_style  || 'mixed',
    homework_start_time: OB.profile.homework_start_time || '18:00',
    typical_activities:  OB.profile.typical_activities || '',
    pain_points:         OB.profile.pain_points || [],
    calendar_connected:  OB.profile.calendar_connected || false,
    onboarding_complete: true,
  };
  try {
    await rdsFetch('profiles', { method: 'POST', body: obRow });
  } catch (e) {
    // Hardened (§2): onboarding continues, but the failure is now user-visible.
    console.warn('Profile save error:', e);
    showToast('Could not save your profile — see console');
  }
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
