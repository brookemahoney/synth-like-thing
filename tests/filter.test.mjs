/**
 * The filter bank's arithmetic: the cutoff clamp, key tracking, the soft-clip
 * drive curve and its level compensation, and the five modes' biquad mapping.
 *
 * Framework-free: `node --test tests/filter.test.mjs`. These are the parts of
 * task 6 that can be wrong without anyone hearing it, so they are tested as
 * numbers rather than as "it sounded fine".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTOFF_MAX_HZ,
  CUTOFF_MIN_HZ,
  DRIVE_MAX_PRE_GAIN,
  NYQUIST_FRACTION,
  RESONANCE_MAX,
  RESONANCE_MIN,
  BUTTERWORTH_Q,
  clampCutoff,
  clampResonance,
  cutoffWithKeyTrack,
  cutoffWithModulation,
  DRIVE_REFERENCE_INPUT,
  drivePostGain,
  drivePreGain,
  driveTransfer,
  filterModeName,
  isTwoSectionMode,
  sectionQ,
  softClipCurve,
  softClipSlope,
} from '../web/audio/filter.js';

test('THE CLAMP: 20 Hz to 20 kHz, and never a fraction of a sample rate away', () => {
  assert.equal(clampCutoff(1000, 48000), 1000, 'a legal cutoff is untouched');

  assert.equal(clampCutoff(0, 48000), CUTOFF_MIN_HZ, 'zero is the NaN case the plan names');
  assert.equal(clampCutoff(-4000, 48000), CUTOFF_MIN_HZ, 'and so is negative');
  assert.equal(clampCutoff(NaN, 48000), CUTOFF_MIN_HZ, 'and a non-number');
  assert.equal(clampCutoff(1e9, 48000), CUTOFF_MAX_HZ, 'and anything past 20 kHz');
  assert.equal(clampCutoff(Infinity, 48000), CUTOFF_MAX_HZ);

  // The sample-rate half of the contract: 20 kHz is above Nyquist-ish territory
  // on a 44.1 kHz context once you take any fraction of it, so the fraction wins.
  assert.equal(clampCutoff(21000, 48000), CUTOFF_MAX_HZ);
  const ceiling = 44100 * NYQUIST_FRACTION;
  assert.equal(clampCutoff(21000, 44100), ceiling, 'a 44.1 kHz context cannot reach 20 kHz');
  assert.equal(clampCutoff(30000, 44100), ceiling);
  assert.ok(clampCutoff(19999, 44100) <= ceiling, 'and never above that ceiling');
});

test('key tracking moves the cutoff by the interval, and 0% moves it not at all', () => {
  assert.equal(cutoffWithKeyTrack(1000, 60, 0), 1000);
  assert.equal(cutoffWithKeyTrack(1000, 81, 0), 1000, 'tracking at 0 is the same cutoff on any note');
  assert.equal(cutoffWithKeyTrack(1000, 48, 0), 1000);

  assert.equal(cutoffWithKeyTrack(1000, 72, 100), 2000, 'an octave up doubles the cutoff');
  assert.equal(cutoffWithKeyTrack(1000, 48, 100), 500, 'an octave down halves it');
  assert.equal(cutoffWithKeyTrack(1000, 66, 100), 1000 * 2 ** (6 / 12), 'a fifth up is a fifth up');
  assert.equal(cutoffWithKeyTrack(1000, 66, 50), 1000 * 2 ** (6 / 24), '50% is half the interval');
  assert.equal(cutoffWithKeyTrack(1000, 60, 50), 1000, 'the reference note never moves the cutoff');
});

test('a cutoff modulation route is in cents and lands on the clamped result', () => {
  assert.equal(cutoffWithModulation(1000, 0), 1000);
  assert.equal(cutoffWithModulation(1000, 1200), 2000);
  assert.equal(cutoffWithModulation(1000, -1200), 500);
  assert.equal(cutoffWithModulation(1000, -4800), 62.5);
  assert.equal(clampCutoff(cutoffWithModulation(20, -4800), 48000), CUTOFF_MIN_HZ, 'a full-depth sweep off a 20 Hz base cannot reach zero');
  assert.equal(clampCutoff(cutoffWithModulation(20000, 4800), 48000), CUTOFF_MAX_HZ, 'nor past 20 kHz');
});

test('resonance is capped at Q 30 — the plan says that ceiling is not negotiable', () => {
  assert.equal(clampResonance(0.5), 0.5);
  assert.equal(clampResonance(1.2), 1.2);
  assert.equal(clampResonance(30), 30);
  assert.equal(clampResonance(0.1), RESONANCE_MIN);
  assert.equal(clampResonance(400), RESONANCE_MAX);
  assert.equal(clampResonance(NaN), RESONANCE_MIN);
  assert.equal(RESONANCE_MAX, 30);
});

test('the drive curve is tanh-shaped, fixed, and maps the curve domain to itself', () => {
  const curve = softClipCurve();
  assert.ok(curve instanceof Float32Array);
  assert.equal(curve.length % 2, 1, 'an odd sample count puts u = 0 on a sample');
  assert.equal(curve[0], -1, 'the domain minimum maps to -1');
  assert.equal(curve[curve.length - 1], 1, 'and the maximum to +1');
  assert.ok(Math.abs(curve[(curve.length - 1) / 2]) < 1e-7, 'with zero in the middle');

  // Odd symmetry and monotonicity: a curve that is neither is not a soft clipper.
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] >= curve[i - 1], `monotonic at ${i}`);
    assert.ok(Math.abs(curve[curve.length - 1 - i] + curve[i]) < 1e-6, `odd at ${i}`);
  }

  // The average slope across the domain is exactly one (the ends map to the
  // ends), and the instantaneous slope FALLS towards both ends. That fall is
  // what compression is: the same input step buys less output at the top.
  const span = curve[curve.length - 1] - curve[0];
  const domain = 2;
  assert.ok(Math.abs(span / domain - 1) < 1e-6, 'unity gain across the domain');
  const u = (fraction) => curve[Math.round(fraction * (curve.length - 1))];
  const step = (fraction) => (u(Math.min(1, fraction + 0.01)) - u(fraction)) / (0.01 * domain);
  const slopeAtZero = step(0.49);
  const slopeAtHalf = step(0.74);
  const slopeAtTop = step(0.95);
  assert.ok(slopeAtZero > slopeAtHalf, `${slopeAtZero} > ${slopeAtHalf}: bending starts near zero`);
  assert.ok(slopeAtHalf > slopeAtTop, `${slopeAtHalf} > ${slopeAtTop}: and keeps bending towards the top`);
  assert.ok(slopeAtZero > 1 && slopeAtTop < 1, 'a gain that is highest in the middle and lowest at the ends');
});

test('drive is a pre-gain into the shaper with an exact level compensation', () => {
  assert.equal(drivePreGain(0), 1, 'drive 0 is unity into the shaper');
  assert.equal(drivePreGain(1), 1 + DRIVE_MAX_PRE_GAIN, 'and drive 1 is the pre-gain ceiling');
  assert.ok(drivePreGain(0.5) > 1 && drivePreGain(0.5) < 1 + DRIVE_MAX_PRE_GAIN);

  // THE COMPENSATION. `post` is the stage's gain at the reference input, divided
  // out, so a signal at the reference level comes out at the reference level at
  // EVERY drive setting — the claim "drive changes saturation, not level".
  for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
    const out = driveTransfer(drive, DRIVE_REFERENCE_INPUT);
    assert.ok(Math.abs(out - DRIVE_REFERENCE_INPUT) < 1e-12, `peak level preserved at drive ${drive} (got ${out})`);
    assert.ok(drivePostGain(drive) > 0 && drivePostGain(drive) <= 1, 'a positive make-up gain that only ever attenuates');
    assert.ok(drivePostGain(1) < drivePostGain(0), 'and it falls as the pre-gain rises');
  }

  // The transfer is monotonic and odd: it bends, it never inverts or clips a lobe.
  let previous = -Infinity;
  for (let u = -1; u <= 1.0001; u += 0.05) {
    const out = driveTransfer(1, u);
    assert.ok(out >= previous - 1e-12, `monotonic at u=${u.toFixed(2)}`);
    previous = out;
    assert.ok(Math.abs(driveTransfer(1, -u) + out) < 1e-12, `odd at u=${u.toFixed(2)}`);
  }

  // More drive means more curvature: the same input is pushed further from
  // linear, and the higher harmonics grow relative to the fundamental.
  let lastError = 0;
  for (const drive of [0, 0.5, 1]) {
    const error = Math.abs(driveTransfer(drive, 0.05) - 0.05);
    assert.ok(error > lastError, `a quiet sample is bent more at drive ${drive} (${error})`);
    lastError = error;
  }
  // Higher drive means more input per unit of output: strictly more curvature.
  assert.ok(drivePreGain(1) > drivePreGain(0.9) && drivePreGain(0.9) > drivePreGain(0.1));
});

test('DRIVE RAISES HARMONIC CONTENT, NOT LEVEL: a sine through the stage', () => {
  // The acceptance property, measured rather than asserted: push a sine through
  // the stage's own transfer function and take a DFT. Harmonics rise with drive;
  // the level does not.
  const N = 4096;
  const peak = DRIVE_REFERENCE_INPUT; // where a voice's mixer output usually sits
  const harmonicsAt = (drive, count = 7) => {
    const out = [];
    for (let h = 1; h <= count; h += 1) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < N; i += 1) {
        const phase = (2 * Math.PI * i) / N;
        const outSample = driveTransfer(drive, peak * Math.sin(phase));
        const angle = (2 * Math.PI * h * i) / N;
        re += outSample * Math.cos(angle);
        im += outSample * Math.sin(angle);
      }
      out.push((2 * Math.sqrt(re * re + im * im)) / N);
    }
    return out;
  };
  const rmsAt = (drive) => {
    let sum = 0;
    for (let i = 0; i < N; i += 1) sum += driveTransfer(drive, peak * Math.sin((2 * Math.PI * i) / N)) ** 2;
    return Math.sqrt(sum / N);
  };

  const clean = harmonicsAt(0);
  const driven = harmonicsAt(1);
  const harmonicSum = (amps) => amps.slice(1).reduce((a, b) => a + b, 0);

  assert.ok(clean[1] < 1e-6 && clean[2] < 0.01, 'an almost-linear stage adds almost nothing to a sine');
  assert.ok(driven[2] > 0.05, `drive 1 puts real third-harmonic content in (${driven[2].toFixed(3)})`);
  assert.ok(
    harmonicSum(driven) > harmonicSum(clean) * 10,
    `harmonics/fundamental: ${(harmonicSum(clean) / clean[0]).toFixed(4)} -> ${(harmonicSum(driven) / driven[0]).toFixed(4)}`,
  );

  // Monotonic, not just "more at the top setting".
  let last = harmonicSum(harmonicsAt(0)) / clean[0];
  for (const drive of [0.25, 0.5, 0.75, 1]) {
    const amps = harmonicsAt(drive);
    const ratio = harmonicSum(amps) / amps[0];
    assert.ok(ratio > last, `drive ${drive} has more harmonic content than the one below it (${ratio.toFixed(4)})`);
    last = ratio;
  }

  // ...while the level stays level: the PEAK of a signal at the reference input
  // is unchanged at every drive setting. A saturated wave is slightly denser at
  // the same peak, so the RMS may rise a little; what it must not do is swing.
  for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(driveTransfer(drive, peak) - peak) < 1e-12, `peak held at drive ${drive}`);
  }
  const levels = [0, 0.25, 0.5, 0.75, 1].map(rmsAt);
  assert.ok(Math.max(...levels) / Math.min(...levels) < 1.5, `RMS across the whole drive range: ${levels.map((v) => v.toFixed(4)).join(', ')}`);
});

test('five modes, and only LP24 is two sections', () => {
  assert.equal(isTwoSectionMode('lp24'), true);
  for (const mode of ['lp12', 'hp12', 'bp12', 'notch12']) {
    assert.equal(isTwoSectionMode(mode), false, `${mode} is one biquad`);
  }

  assert.equal(filterModeName('lp24'), 'lowpass');
  assert.equal(filterModeName('lp12'), 'lowpass');
  assert.equal(filterModeName('hp12'), 'highpass');
  assert.equal(filterModeName('bp12'), 'bandpass');
  assert.equal(filterModeName('notch12'), 'notch');
  assert.equal(filterModeName('nonsense'), 'lowpass', 'an unknown mode is a lowpass, not a broken node');

  // The second pole of an LP24 is never resonant, so Q 30 is a single-section
  // peak rather than a squared one. The plan refuses to compensate for it.
  assert.equal(sectionQ('lp24', 30, 0), 30);
  assert.equal(sectionQ('lp24', 30, 1), BUTTERWORTH_Q);
  assert.equal(sectionQ('lp12', 30, 0), 30);
  assert.equal(sectionQ('lp12', 30, 1), BUTTERWORTH_Q, 'an unused second section is still flat');
  assert.equal(sectionQ('lp24', 400, 0), RESONANCE_MAX, 'and the control cannot exceed Q 30');
});
