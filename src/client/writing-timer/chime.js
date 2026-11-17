// The short two-note chime when the card-writing timer ends, synthesised with Web Audio: no audio file to load.
export const CHIME_TONES_HZ = Object.freeze([880, 1318.5]);
const TONE_GAP_S = 0.18;
const TONE_LENGTH_S = 0.35;
const PEAK_GAIN = 0.2;
// An exponential fade cannot reach zero; this is inaudible.
const SILENT_GAIN = 0.0001;

const browserAudioContext = () => globalThis.AudioContext ?? globalThis.webkitAudioContext;
// Browsers let a page make sound only after the user has interacted with it. Without the API, try and let resume() decide.
const browserUserActivation = () => globalThis.navigator?.userActivation?.hasBeenActive ?? true;

const staySilent = () => {
  // The browser refused to start audio for this page; the visual "Time's up" still shows.
};

export function createChime({ AudioContextClass = browserAudioContext(), hasUserActivation = browserUserActivation } = {}) {
  let context = null;
  const playTones = () => {
    CHIME_TONES_HZ.forEach((frequencyHz, index) => {
      const startAt = context.currentTime + index * TONE_GAP_S;
      const gain = context.createGain();
      gain.gain.setValueAtTime(PEAK_GAIN, startAt);
      gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, startAt + TONE_LENGTH_S);
      gain.connect(context.destination);
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequencyHz;
      oscillator.connect(gain);
      oscillator.start(startAt);
      oscillator.stop(startAt + TONE_LENGTH_S);
    });
  };
  return {
    play() {
      if (!AudioContextClass || !hasUserActivation()) return;
      context ??= new AudioContextClass();
      context.resume().then(playTones, staySilent);
    },
  };
}
