import test from 'node:test';
import assert from 'node:assert/strict';
import { CHIME_TONES_HZ, createChime } from './chime.js';

/** Records the tones a page would hear: one oscillator per tone, each started and stopped. */
function fakeAudio({ resume = () => Promise.resolve() } = {}) {
  const tones = [];
  let contexts = 0;
  class FakeContext {
    constructor() { contexts += 1; this.currentTime = 0; this.destination = {}; }
    resume() { return resume(); }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } };
    }
    createOscillator() {
      const oscillator = {
        frequency: { value: 0 }, started: false, stopped: false,
        connect() { return this; }, start() { oscillator.started = true; }, stop() { oscillator.stopped = true; },
      };
      tones.push(oscillator);
      return oscillator;
    }
  }
  return { FakeContext, tones, contexts: () => contexts };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test('a page the user has interacted with plays the short chime, one oscillator per tone', async () => {
  const audio = fakeAudio();
  const chime = createChime({ AudioContextClass: audio.FakeContext, hasUserActivation: () => true });
  chime.play();
  await settle();
  assert.deepEqual(audio.tones.map((tone) => tone.frequency.value), [...CHIME_TONES_HZ]);
  assert.ok(audio.tones.every((tone) => tone.started && tone.stopped));
  chime.play();
  await settle();
  assert.equal(audio.contexts(), 1, 'one audio context is reused');
});

test('before any user gesture, or without Web Audio, the page stays silent', async () => {
  const audio = fakeAudio();
  createChime({ AudioContextClass: audio.FakeContext, hasUserActivation: () => false }).play();
  createChime({ AudioContextClass: undefined, hasUserActivation: () => true }).play();
  await settle();
  assert.equal(audio.contexts(), 0);
});

test('a browser that refuses to resume audio leaves the page silent without an error', async () => {
  const audio = fakeAudio({ resume: () => Promise.reject(new Error('NotAllowedError')) });
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    createChime({ AudioContextClass: audio.FakeContext, hasUserActivation: () => true }).play();
    await settle();
    await settle();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, []);
  assert.equal(audio.tones.length, 0);
});
