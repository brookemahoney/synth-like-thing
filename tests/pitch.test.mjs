/**
 * The per-voice frequency computation. Every pitch-affecting input — keyboard
 * note, octave, semitone, fine tune in cents, and the modulation-matrix
 * contribution — resolves through ONE pure function, so it is testable without
 * an AudioContext. This is the function whose correctness the whole instrument
 * rests on: an octave that is off by a half-semitone is audible everywhere.
 *
 * Framework-free: `node --test tests/pitch.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  A4_HZ,
  A4_MIDI,
  OCTAVE_CENTS,
  SEMITONE_CENTS,
  centsToRatio,
  clampFrequency,
  computeCoreFrequency,
  corePitchCents,
  midiToHz,
} from '../web/audio/pitch.js';

const NEAR = 1e-9;

test('a MIDI number resolves to equal-tempered Hz', () => {
  assert.equal(midiToHz(A4_MIDI), A4_HZ);
  assert.equal(midiToHz(A4_MIDI + 12), A4_HZ * 2);
  assert.equal(midiToHz(A4_MIDI - 12), A4_HZ / 2);
  assert.equal(midiToHz(A4_MIDI + 7), A4_HZ * 2 ** (7 / 12));
  assert.equal(midiToHz(0), A4_HZ * 2 ** (-69 / 12));
});

test('cents convert to a frequency ratio, not to an offset', () => {
  assert.equal(centsToRatio(0), 1);
  assert.ok(Math.abs(centsToRatio(1200) - 2) < NEAR);
  assert.ok(Math.abs(centsToRatio(-1200) - 0.5) < NEAR);
  assert.ok(Math.abs(centsToRatio(100) - 2 ** (1 / 12)) < NEAR);
});

test('octave and semitone are the same unit — cents', () => {
  assert.equal(OCTAVE_CENTS, 1200);
  assert.equal(SEMITONE_CENTS, 100);
  assert.equal(corePitchCents({ octave: 1 }), 1200);
  assert.equal(corePitchCents({ semitone: 3 }), 300);
  assert.equal(corePitchCents({ octave: -2, semitone: -12 }), -3600);
});

test('with every offset at zero the core plays the keyboard note unchanged', () => {
  assert.equal(computeCoreFrequency({ noteHz: 440 }), 440);
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: 0, semitone: 0, cents: 0, modCents: 0 }), 440);
});

test('octave offset -2..+2 is exactly 1/4x .. 4x', () => {
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: 2 }), 1760);
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: -2 }), 110);
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: 1 }), 880);
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: -1 }), 220);
});

test('semitone offset -12..+12 is exactly one octave', () => {
  assert.equal(computeCoreFrequency({ noteHz: 440, semitone: 12 }), 880);
  assert.equal(computeCoreFrequency({ noteHz: 440, semitone: -12 }), 220);
  assert.equal(computeCoreFrequency({ noteHz: 440, semitone: 7 }), 440 * 2 ** (7 / 12));
});

test('fine tune in cents is a ratio of 2^(cents/1200)', () => {
  assert.ok(Math.abs(computeCoreFrequency({ noteHz: 440, cents: 50 }) - 440 * 2 ** (50 / 1200)) < NEAR);
  assert.ok(Math.abs(computeCoreFrequency({ noteHz: 440, cents: -50 }) - 440 * 2 ** (-50 / 1200)) < NEAR);
});

test('the modulation-matrix contribution resolves through the same computation', () => {
  const solo = computeCoreFrequency({ noteHz: 440, modCents: 700 });
  assert.ok(Math.abs(solo - 440 * 2 ** (700 / 1200)) < NEAR);
  assert.ok(Math.abs(computeCoreFrequency({ noteHz: 440, modCents: -700 }) - 440 * 2 ** (-700 / 1200)) < NEAR);

  // The matrix contribution is not a separate path: octave, semitone, cents and
  // modCents add into one number of cents before a single conversion happens.
  const all = computeCoreFrequency({ noteHz: 440, octave: 1, semitone: 2, cents: 50, modCents: 100 });
  assert.ok(Math.abs(all - 440 * 2 ** ((1200 + 200 + 50 + 100) / 1200)) < NEAR);
  assert.equal(corePitchCents({ octave: 1, semitone: 2, cents: 50, modCents: 100 }), 1550);
});

test('a missing or non-numeric offset is treated as zero rather than NaN', () => {
  assert.equal(computeCoreFrequency({ noteHz: 440, octave: undefined, semitone: null, cents: NaN }), 440);
  assert.equal(corePitchCents({ octave: 'nonsense' }), 0);
  assert.ok(Number.isFinite(computeCoreFrequency({ noteHz: 220, modCents: Infinity })));
});

test('frequency is clamped just below Nyquist and just above zero', () => {
  const sampleRate = 48000;
  const nyquist = sampleRate / 2;
  assert.ok(clampFrequency(20000, sampleRate) === 20000);
  assert.ok(clampFrequency(50000, sampleRate) < nyquist);
  assert.ok(clampFrequency(-100, sampleRate) >= 0);
  assert.equal(clampFrequency(0, sampleRate), 0);

  const clamped = computeCoreFrequency({ noteHz: 440, octave: 2, semitone: 12 }, { sampleRate });
  assert.ok(clamped < nyquist, 'an unreachable offset must not demand a frequency past Nyquist');
  assert.ok(clamped > 0);
});

test('the clamp defaults to the 48 kHz ceiling when no sample rate is supplied', () => {
  assert.ok(computeCoreFrequency({ noteHz: 440, octave: 2, semitone: 12 }) < 24000);
});