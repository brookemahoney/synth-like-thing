/**
 * The ten waveforms and how each one is built. Half of them are native
 * OscillatorNode types; the rest are PeriodicWaves whose Fourier coefficients
 * are computed here. The coefficient maths is the part that can be silently
 * wrong (a pulse 12.5% that is really a square is inaudible; a reverse saw that
 * comes out forwards is very audible), so it is tested as arithmetic on the
 * series rather than only by ear.
 *
 * Framework-free: `node --test tests/wave.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WAVEFORMS } from '../web/ui/params.js';
import {
  NATIVE_WAVEFORMS,
  PERIODIC_WAVEFORMS,
  PULSE_DUTIES,
  REED_PARTIALS,
  SAWT_HARMONICS,
  buildPeriodicWave,
  isNativeWaveform,
  nativeWaveform,
  periodicWaveName,
  pulseCoefficients,
  reedCoefficients,
  sawCoefficients,
  waveKind,
} from '../web/audio/waveforms.js';

const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

/** Evaluate a Fourier series as Web Audio does: x(t) = sum a_n cos + b_n sin. */
function seriesAt({ real = [], imag = [] }, t, fundamental = 1) {
  let x = 0;
  for (let n = 1; n < Math.max(real.length, imag.length); n += 1) {
    const a = real[n] ?? 0;
    const b = imag[n] ?? 0;
    if (a === 0 && b === 0) continue;
    x += a * Math.cos(2 * Math.PI * fundamental * n * t) + b * Math.sin(2 * Math.PI * fundamental * n * t);
  }
  return x;
}

/** The fraction of one cycle the series spends above zero — the duty cycle of a
 *  pulse, and 0.5 for any saw. Truncation is 64 harmonics, so it is asserted with
 *  a tolerance rather than exactly. */
function positiveFraction(wave, samples = 8192) {
  let count = 0;
  for (let i = 0; i < samples; i += 1) {
    if (seriesAt(wave, (i + 0.5) / samples) > 0) count += 1;
  }
  return count / samples;
}

test('there are exactly ten waveforms, and every one is buildable', () => {
  assert.equal(WAVEFORMS.length, 10);
  assert.equal(new Set(WAVEFORMS).size, 10);
  for (const name of WAVEFORMS) {
    const kind = waveKind(name);
    assert.ok(['native', 'periodic', 'noise'].includes(kind), `${name} has no implementation`);
  }
  assert.equal(Object.keys(NATIVE_WAVEFORMS).length, 4);
  assert.equal(PERIODIC_WAVEFORMS.length, 5, 'the other four of the nine oscillators, plus the reed');
  assert.equal(WAVEFORMS.filter((name) => waveKind(name) === 'noise').length, 1);
});

test('the four native waveforms map to the four native OscillatorNode types', () => {
  assert.equal(nativeWaveform('sine'), 'sine');
  assert.equal(nativeWaveform('triangle'), 'triangle');
  assert.equal(nativeWaveform('sawtooth'), 'sawtooth');
  assert.equal(nativeWaveform('square'), 'square');
  assert.equal(nativeWaveform('reed'), null);
  assert.equal(nativeWaveform('noise'), null, 'noise is a buffer source, not an oscillator type');
  assert.equal(isNativeWaveform('sine'), true);
  assert.equal(isNativeWaveform('pulse25'), false);
});

test('a falling-ramp saw has +2/(n.pi) sine coefficients; the reverse saw is negated', () => {
  const down = sawCoefficients({ sign: 1 });
  const up = sawCoefficients({ sign: -1 });
  for (let n = 1; n < 12; n += 1) {
    assert.ok(near(down.imag[n], 2 / (n * Math.PI)), `harmonic ${n}`);
    assert.ok(near(up.imag[n], -down.imag[n]), `reverse saw harmonic ${n} is the negated series`);
  }
  assert.equal(down.real.length, down.imag.length, 'real and imag are the same length: [0, ...]');
  assert.ok(down.real.slice(1).every((v) => v === 0), 'a saw is a sine series');
  assert.equal(down.imag.length - 1, SAWT_HARMONICS);
});

test('the falling saw actually falls, and the reverse saw is exactly its negation', () => {
  const down = sawCoefficients({ sign: 1 });
  const up = sawCoefficients({ sign: -1 });

  assert.ok(seriesAt(down, 0.25) > 0.4, 'a quarter of the way through it is still high');
  assert.ok(seriesAt(down, 0.75) < -0.4, 'three quarters of the way through it has fallen');
  for (const t of [0.1, 0.25, 0.4, 0.75, 0.9]) {
    assert.ok(near(seriesAt(up, t), -seriesAt(down, t), 1e-12), `the reverse saw is mirrored at t=${t}`);
  }
  assert.equal(positiveFraction(down), 0.5);
  assert.equal(positiveFraction(up), 0.5);
});

test('a 50% pulse is a square wave: no even harmonics, odd ones at 4/(n.pi)', () => {
  const square = pulseCoefficients({ duty: 0.5 });
  for (let n = 1; n < 20; n += 1) {
    const expected = n % 2 === 1 ? 4 / (n * Math.PI) : 0;
    assert.ok(near(square.imag[n], expected), `pulse 50% harmonic ${n}`);
    assert.ok(near(square.real[n], 0, 1e-12), `a 50% pulse has no cosine content at harmonic ${n}`);
  }
  assert.equal(positiveFraction(square), 0.5);
});

test('narrower pulses really are narrower, and their cosine terms differ', () => {
  const p50 = pulseCoefficients({ duty: 0.5 });
  const p25 = pulseCoefficients({ duty: 0.25 });
  const p125 = pulseCoefficients({ duty: 0.125 });

  assert.ok(Math.abs(positiveFraction(p50) - 0.5) < 0.01);
  assert.ok(Math.abs(positiveFraction(p25) - 0.25) < 0.02, 'a quarter of the cycle is high');
  assert.ok(Math.abs(positiveFraction(p125) - 0.125) < 0.02, 'an eighth of the cycle is high');

  // A 25% duty cancels the second harmonic (sin(pi) = 0) but not the third.
  assert.ok(near(p25.real[2], 0, 1e-12));
  assert.ok(near(p25.real[3], -2 / (3 * Math.PI), 1e-12));
  // A 12.5% duty cancels the fourth and restores the second.
  assert.ok(near(p125.real[2], 1 / Math.PI, 1e-12));
  assert.ok(near(p125.real[4], 0, 1e-12));
  // Every pulse rises to its high value just inside the origin. (Exactly AT the
  // origin the series is 0, the midpoint of the jump — that is correct Fourier
  // behaviour, not a broken wave.)
  assert.ok(seriesAt(p25, 0.0625) > 0.5);
  assert.ok(seriesAt(p125, 0.03125) > 0.5);
});

test('a pulse is high for its duty and low for the rest of the cycle', () => {
  for (const duty of [0.5, 0.25, 0.125]) {
    const wave = pulseCoefficients({ duty });
    assert.ok(seriesAt(wave, duty / 4) > 0, `duty ${duty} is high inside its high part`);
    assert.ok(seriesAt(wave, (1 + duty) / 2) < 0, `duty ${duty} is low after its high part`);
  }
});

test('the reed sums harmonics 1, 2, 3, 4, 6 and 8 at decreasing amplitude', () => {
  const reed = reedCoefficients();
  assert.deepEqual(REED_PARTIALS.partials, [1, 2, 3, 4, 6, 8]);
  assert.equal(REED_PARTIALS.amplitudes.length, 6);
  for (let i = 1; i < REED_PARTIALS.amplitudes.length; i += 1) {
    assert.ok(
      REED_PARTIALS.amplitudes[i] < REED_PARTIALS.amplitudes[i - 1],
      `partial ${REED_PARTIALS.partials[i]} must be quieter than ${REED_PARTIALS.partials[i - 1]}`,
    );
  }
  for (const partial of [1, 2, 3, 4, 6, 8]) {
    assert.ok(reed.real[partial] > 0, `partial ${partial} is missing`);
  }
  for (const partial of [5, 7, 9, 10]) {
    assert.equal(reed.real[partial] ?? 0, 0, `partial ${partial} is not in the reed`);
  }
  assert.ok(reed.imag.slice(1).every((v) => v === 0), 'the reed is a cosine series');
  assert.ok(seriesAt(reed, 0) > 1, 'the partials sum, so it peaks above the fundamental');
});

test('buildPeriodicWave hands Web Audio the coefficients, keyed by waveform name', () => {
  const built = [];
  const fakeContext = { createPeriodicWave: (real, imag) => ({ real: [...real], imag: [...imag], built }) };

  const pulse = buildPeriodicWave('pulse125', fakeContext);
  assert.deepEqual(pulse.imag, pulseCoefficients({ duty: 0.125 }).imag);
  assert.deepEqual(pulse.real, pulseCoefficients({ duty: 0.125 }).real);

  assert.deepEqual(periodicWaveName('sawUp'), 'sawUp');
  assert.equal(periodicWaveName('sine'), null);
  assert.equal(buildPeriodicWave('sine', fakeContext), null);
  assert.equal(built.length, 0, 'nothing was requested from the context for a native type');
});

test('an out-of-range duty is rejected rather than producing a silent wave', () => {
  assert.throws(() => pulseCoefficients({ duty: 0 }));
  assert.throws(() => pulseCoefficients({ duty: 1 }));
  assert.throws(() => pulseCoefficients({ duty: -0.5 }));
  assert.throws(() => pulseCoefficients({ duty: Number.NaN }));
  assert.deepEqual([...PULSE_DUTIES], [0.5, 0.25, 0.125], 'the instrument ships exactly these three');
});