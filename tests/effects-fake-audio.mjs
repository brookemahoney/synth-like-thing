/**
 * effects-fake-audio.mjs — the fake AudioContext from tests/voice-fake-audio.mjs,
 * extended with the node factories the master effects chain needs.
 *
 * WHY A SECOND FILE AND NOT AN EDIT
 *   tests/voice-fake-audio.mjs belongs to the voice engine and is being used by
 *   tasks running in parallel. Extending it here would be a shared-file edit with
 *   a real chance of clashing, so this harness *builds on* it instead: it calls
 *   createFakeAudioContext() and adds the biquad / delay / convolver / compressor /
 *   analyser factories on top. Nothing in voice-fake-audio.mjs is modified.
 *
 * THE ONE PLACE IT DEVIATES FROM THE SHARED HARNESS
 *   createBuffer() in the shared harness returns a FRESH Float32Array on every
 *   getChannelData() call. That is fine for a test that only checks the call was
 *   made, and fatal for the impulse-response generator, which writes a buffer and
 *   then reads it back. This harness caches the channel arrays exactly as a real
 *   AudioBuffer does, so ir.js can be tested honestly rather than against a lie.
 *
 *   Everything else behaves as the shared harness does: a scheduled
 *   linearRampToValueAtTime sets `value` immediately, and every node records the
 *   connections it was given.
 */

import { createFakeAudioContext } from './voice-fake-audio.mjs';

/** One throwaway gain supplies the AudioParam prototype every param inherits. */
const PARAM_PROTOTYPE = createFakeAudioContext().createGain().gain;

export function createFakeEffectsContext({ sampleRate = 48000, now = 0 } = {}) {
  const context = createFakeAudioContext({ sampleRate, now });

  /** A harness node — reached through createGain, then retyped. */
  function makeNode(kind, extras = {}) {
    const node = context.createGain();
    node.kind = kind;
    Object.assign(node, extras);
    return node;
  }

  /** An AudioParam cloned from the harness's own param prototype. */
  function makeParam(initial) {
    return Object.create(PARAM_PROTOTYPE, {
      value: { value: initial, writable: true },
      events: { value: [], writable: true },
    });
  }

  /* --------------------------------------------------------- the factories --- */

  context.createBiquadFilter = () =>
    makeNode('biquad', {
      type: 'lowpass',
      frequency: makeParam(350),
      detune: makeParam(0),
      Q: makeParam(1),
      gain: makeParam(0),
    });

  context.createDelay = (maxDelayTime = 1) =>
    makeNode('delay', { maxDelayTime, delayTime: makeParam(0) });

  context.createConvolver = () => makeNode('convolver', { buffer: null, normalize: true });

  context.createDynamicsCompressor = () =>
    makeNode('compressor', {
      threshold: makeParam(-24),
      knee: makeParam(30),
      ratio: makeParam(12),
      attack: makeParam(0.003),
      release: makeParam(0.25),
      reduction: -20,
    });

  context.createWaveShaper = () => makeNode('waveShaper', { curve: null, oversample: 'none' });

  context.createAnalyser = () => {
    const fftSize = 2048;
    return makeNode('analyser', {
      fftSize,
      smoothingTimeConstant: 0.8,
      minDecibels: -100,
      maxDecibels: -30,
      frequencyBinCount: fftSize / 2,
      timeDomainData: new Float32Array(fftSize),
      frequencyData: new Float32Array(fftSize / 2),
      getFloatTimeDomainData(array) {
        array.fill(0);
        return array;
      },
      getFloatFrequencyData(array) {
        array.fill(-100);
        return array;
      },
      getByteTimeDomainData(array) {
        array.fill(128);
        return array;
      },
    });
  };

  /** The real caching behaviour, unlike the shared harness's fresh-array version. */
  context.createBuffer = (channels = 1, length, rate = context.sampleRate) => {
    context.createBufferCalls += 1;
    const data = [];
    for (let channel = 0; channel < channels; channel += 1) data.push(new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: (channel) => data[channel],
    };
  };

  return context;
}