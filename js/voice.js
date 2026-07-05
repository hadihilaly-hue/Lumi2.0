import { doSend } from './chat.js';
import { $, msgInput } from './state.js';
import { autoGrow, showToast, updateSendBtn } from './ui.js';


// ─── VOICE / SPEECH ───────────────────────────────────────────────────────────
let _recognition     = null;
// MIGRATION (pre-MVP polish bundle): single voice setting replaces
// the old `lumi_voice_mode` + `lumi_mute_tts` boolean pair.
//   lumi_mute_tts === 'true'                   → 'off'
//   lumi_voice_mode === 'true' (and not muted) → 'full'
//   otherwise                                  → 'hear'
//
// TODO (cleanup): the voice-setting migration and the segmented control
// in settings are now vestigial. After the TTS auto-play removal,
// _voiceSetting reads/writes affect nothing — manual speaker clicks
// always play, and there's no auto-play path. When anyone next touches
// voice-mode code, simplify to a single boolean (or remove the setting
// entirely) and remove the segmented control from the settings UI.
function _readVoiceSetting() {
  const stored = localStorage.getItem('lumi_voice_setting');
  if (stored === 'off' || stored === 'hear' || stored === 'full') return stored;
  const oldMute  = localStorage.getItem('lumi_mute_tts')   === 'true';
  const oldVoice = localStorage.getItem('lumi_voice_mode') === 'true';
  const migrated = oldMute ? 'off' : (oldVoice ? 'full' : 'hear');
  localStorage.setItem('lumi_voice_setting', migrated);
  return migrated;
}
let _voiceSetting    = _readVoiceSetting();
let _voiceMode       = _voiceSetting === 'full';   // derived flag for existing call sites
let _isRecording     = false;
let _lastWasVoice    = false;
let _silenceTimer    = null;   // 2.5s silence → auto-stop
let _transcript      = '';     // latest transcript text
let _isSpeaking      = false;

export function initVoice() {
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
  // No _voiceSetting gate: this function is now only reached via a
  // student clicking the speaker icon. Manual clicks always play,
  // regardless of any global voice-mode toggle state.
  if (!text || !window.speechSynthesis) return;
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
export function _addSpeakerBtn(msgEl, text) {
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

export function wireVoiceListeners() {
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

  // Voice mode segmented control (Off / Hear Lumi / Voice mode)
  const segControl = $('voiceModeSelect');
  if (segControl) {
    const setActive = (val) => {
      segControl.querySelectorAll('.seg-opt').forEach(b => {
        const a = b.dataset.value === val;
        b.classList.toggle('active', a);
        b.setAttribute('aria-checked', a ? 'true' : 'false');
      });
    };
    setActive(_voiceSetting);
    segControl.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-opt');
      if (!btn) return;
      const newValue = btn.dataset.value;
      if (newValue === _voiceSetting) return;
      _voiceSetting = newValue;
      _voiceMode = (_voiceSetting === 'full');
      localStorage.setItem('lumi_voice_setting', _voiceSetting);
      setActive(_voiceSetting);
      document.body.classList.toggle('voice-mode-on', _voiceMode);
      if (_voiceMode) {
        _startRecording();
      } else {
        _stopRecording();
        if (_voiceSetting === 'off') speechSynthesis.cancel();
      }
    });
  }
}
