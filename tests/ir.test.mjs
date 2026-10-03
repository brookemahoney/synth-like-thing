/**
 * ir.test.mjs — the impulse-response generator, which is genuinely algorithmic
 * code and therefore tested rather than eyeballed.
 *
 * What is asserted here is the behaviour the plan makes non-negotiable: an
 * exponential noise decay, a 0.3 s floor, and a 12 s ceiling that is a HARD clamp
 * rather than a default. Everything is computed from the buffer that comes back,
 * not from a stub, so a generator that returned silence would fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeEffectsContext } from './effects-fake-audio.mjs';
import {
  IR_DECAY_MAX,
  IR_DECAY_MIN,
  IR_DECAY_DEFAULT,
  IR_TAIL_DB,
  buildImpulseResponse,
  clampDecaySeconds,
} from '../web/audio/ir.js';

/** Deterministic noise, so a failure is reproducible. */
function sequenceRandom(seed = 1) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 4294967296;
  };
}

/** Root-mean-square amplitude of a slice. */
function rms(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

test('a decay below the floor is raised to 0.3 s', () => {
  assert.equal(clampDecaySeconds(0.05), IR_DECAY_MIN);
  assert.equal(clampDecaySeconds(0), IR_DECAY_MIN);
});

test('the 12 s ceiling is a clamp, not a suggestion', () => {
  assert.equal(IR_DECAY_MAX, 12);
  assert.equal(clampDecaySeconds(30), 12);
  assert.equal(clampDecaySeconds(12.0001), 12);
  // A non-finite request is a bug in the caller, not "very long", so it falls back.
  assert.equal(clampDecaySeconds(Infinity), IR_DECAY_DEFAULT);
  assert.equal(clampDecaySeconds(Number.NaN), IR_DECAY_DEFAULT);
});

test('a clamped 12 s decay produces a buffer of exactly twelve seconds', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const ir = buildImpulseResponse(context, { decaySeconds: 999, random: sequenceRandom() });
  assert.equal(ir.decaySeconds, 12);
  assert.equal(ir.frames, 12 * 48000);
  assert.equal(ir.seconds, 12);
  assert.equal(ir.buffer.length, 576000);
});

test('the response is a noise burst under an exponential decay envelope', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const ir = buildImpulseResponse(context, { decaySeconds: 2, random: sequenceRandom() });
  const data = ir.buffer.getChannelData(0);

  assert.ok(data.length === 96000);
  // A noise burst, not a sine: consecutive samples are uncorrelated.
  assert.ok(Math.abs(data[10] - data[11]) > 0.1, 'adjacent samples should be uncorrelated');

  // Successive windows get quieter, monotonically, by a wide margin.
  const window = 9600;
  const levels = [];
  for (let start = 0; start + window <= data.length; start += window) levels.push(rms(data.slice(start, start + window)));
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i] < levels[i - 1], `window ${i} should be quieter than ${i - 1}`);
  }
  assert.ok(levels[0] / levels[levels.length - 1] > 100, 'the decay should span at least 100x');
});

test('the decay lands on the advertised -60 dB point', () => {
  const context = createFakeEffectsContext({ sampleRate: 8000 });
  const decay = 1;
  const ir = buildImpulseResponse(context, { decaySeconds: decay, random: sequenceRandom(), taperSeconds: 0 });
  const data = ir.buffer.getChannelData(0);
  // A single sample of the exponential is very noisy; compare RMS of the first
  // 10 ms against the RMS of the 10 ms ending at the decay point.
  const head = rms(data.slice(0, 80));
  const atDecay = rms(data.slice(data.length - 80 - 20, data.length - 20));
  const db = 20 * Math.log10(atDecay / head);
  assert.ok(db > -IR_TAIL_DB - 4 && db < -IR_TAIL_DB + 4, `expected about -${IR_TAIL_DB} dB, measured ${db.toFixed(1)} dB`);
});

test('the tail tapers to silence so the buffer never ends on a step', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const ir = buildImpulseResponse(context, { decaySeconds: 0.5, random: sequenceRandom() });
  for (let channel = 0; channel < ir.channels; channel += 1) {
    const data = ir.buffer.getChannelData(channel);
    assert.ok(data[data.length - 1] === 0, 'the last sample must be exactly zero');
    assert.ok(Math.abs(data[data.length - 2]) < 1e-3, 'the second-to-last sample should already be near zero');
  }
});

test('each channel decays independently, so the reverb is not a mono blob', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const ir = buildImpulseResponse(context, { decaySeconds: 0.5, random: sequenceRandom(7) });
  assert.equal(ir.channels, 2);
  const left = ir.buffer.getChannelData(0);
  const right = ir.buffer.getChannelData(1);
  assert.notEqual(left[500], right[500]);
  // Independent noise disagrees about sign about half the time; the same sequence
  // played twice would disagree 0% of the time.
  let differences = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (Math.sign(left[i]) !== Math.sign(right[i])) differences += 1;
  }
  assert.ok(differences > 400, `expected roughly half of 2000 samples to differ in sign, got ${differences}`);
});

test('a mono response is available without changing the length', () => {
  const context = createFakeEffectsContext({ sampleRate: 44100 });
  const ir = buildImpulseResponse(context, { decaySeconds: 3, channels: 1, random: sequenceRandom() });
  assert.equal(ir.channels, 1);
  assert.equal(ir.frames, 132300);
  assert.equal(ir.buffer.numberOfChannels, 1);
});

test('the build reports its own cost and its own length', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const ir = buildImpulseResponse(context, { decaySeconds: 12, random: sequenceRandom() });
  assert.ok(Number.isFinite(ir.buildMs) && ir.buildMs >= 0, 'buildMs must be a real measurement');
  assert.equal(ir.seconds, ir.frames / context.sampleRate);
  assert.ok(ir.buildMs < 1000, 'a 12 s response must not cost a second to build');
});

test('a longer decay costs more than a shorter one, which is the CPU argument', () => {
  const context = createFakeEffectsContext({ sampleRate: 48000 });
  const short = buildImpulseResponse(context, { decaySeconds: 0.3, random: sequenceRandom() });
  const long = buildImpulseResponse(context, { decaySeconds: 12, random: sequenceRandom() });
  assert.equal(short.frames * 40, long.frames);
  assert.ok(long.buildMs >= short.buildMs);
});