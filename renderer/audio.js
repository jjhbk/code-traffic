let context = null;
let enabled = localStorage.getItem('signal-box-sound') === 'on';

function audioContextClass() {
  return window.AudioContext || window.webkitAudioContext;
}

function createContext() {
  const AudioContextClass = audioContextClass();
  if (!AudioContextClass) return null;
  if (!context) context = new AudioContextClass();
  return context;
}

async function resumeFromGesture() {
  document.removeEventListener('pointerdown', resumeFromGesture, true);
  document.removeEventListener('keydown', resumeFromGesture, true);
  if (enabled && context?.state === 'suspended') {
    try { await context.resume(); } catch (_) { /* The sound button can retry explicitly. */ }
  }
}

function armResumeOnInteraction() {
  document.addEventListener('pointerdown', resumeFromGesture, { capture: true, once: true });
  document.addEventListener('keydown', resumeFromGesture, { capture: true, once: true });
}

function tone(frequency, start, duration, volume) {
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function play(state) {
  if (!enabled || !context || !state) return;
  const now = context.currentTime;
  if (state === 'approval') { tone(660, now, .15, .08); tone(880, now + .16, .15, .08); }
  if (state === 'done') { tone(784, now, .15, .08); tone(523, now + .16, .15, .08); }
  if (state === 'working') tone(440, now, .15, .025);
}

async function toggle() {
  if (!audioContextClass()) throw new Error('WebAudio is unavailable in this Electron runtime.');
  const wasUninitialized = !context;
  createContext();
  if (context.state === 'suspended') await context.resume();
  if (context.state !== 'running') throw new Error(`Audio context is ${context.state}; WSLg did not activate an audio output.`);
  if (wasUninitialized && enabled) {
    tone(660, context.currentTime, .2, .16);
    return enabled;
  }
  enabled = !enabled;
  localStorage.setItem('signal-box-sound', enabled ? 'on' : 'off');
  if (enabled) tone(660, context.currentTime, .2, .16);
  return enabled;
}

if (enabled) {
  createContext();
  if (context?.state === 'suspended') armResumeOnInteraction();
}

window.signalBoxAudio = { toggle, play, isEnabled: () => enabled };
