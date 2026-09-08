// Dictation into the wizard textareas via the Web Speech API.

import { T } from './state.js';
import { showToast } from './ui.js';

function initSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    return null;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  return recognition;
}

export function toggleMic(inputId) {
  const btn = document.querySelector(`#${inputId}`).parentElement.querySelector('.wizard-mic-btn');
  const input = document.getElementById(inputId);

  if (T.recordingField === inputId && T.recognition) {
    T.recognition.stop();
    btn.classList.remove('recording');
    T.recordingField = null;
    return;
  }

  // Stop any existing recording
  if (T.recognition && T.recordingField) {
    const prevBtn = document.querySelector(`#${T.recordingField}`).parentElement.querySelector('.wizard-mic-btn');
    prevBtn.classList.remove('recording');
    T.recognition.stop();
  }

  T.recognition = initSpeechRecognition();
  if (!T.recognition) {
    showToast('Speech recognition not supported in this browser', 'error');
    return;
  }

  T.recordingField = inputId;
  btn.classList.add('recording');

  let finalTranscript = input.value;
  if (finalTranscript && !finalTranscript.endsWith(' ')) finalTranscript += ' ';

  T.recognition.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    input.value = finalTranscript + interimTranscript;
    input.dispatchEvent(new Event('input'));
  };

  T.recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    btn.classList.remove('recording');
    T.recordingField = null;
    if (event.error === 'not-allowed') {
      showToast('Microphone access denied', 'error');
    }
  };

  T.recognition.onend = () => {
    btn.classList.remove('recording');
    T.recordingField = null;
  };

  T.recognition.start();
}
