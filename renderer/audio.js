let context = null;
let enabled = localStorage.getItem('signal-box-sound') === 'on';

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
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('WebAudio is unavailable in this Electron runtime.');
  const wasUninitialized = !context;
  if (!context) context = new AudioContextClass();
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

window.signalBoxAudio = { toggle, play, isEnabled: () => enabled };
