/**
 * waveforms.js — the instrument's ten waveforms, and the Fourier maths for the
 * six of them that are not native OscillatorNode types.
 *
 * WHY A TABLE AT ALL
 *   Four waveforms are free: an OscillatorNode has sine, triangle, sawtooth and
 *   square built in, and those are used directly. Five more are built as
 *   PeriodicWave tables from their Fourier series, which means the shapes are
 *   arithmetic rather than samples: no audio file, nothing to download, and the
 *   coefficients can be asserted in a unit test instead of only heard. The tenth,
 *   white noise, is not an oscillator at all — it is a looping buffer source
 *   (noise.js), which is why it is not band-limited and is not meant to be.
 *
 *   1 sine            native
 *   2 triangle        native
 *   3 sawtooth        native
 *   4 square (50%)    native — the same series as a 50% pulse
 *   5 pulse 25%       periodic
 *   6 pulse 12.5%     periodic
 *   7 saw (falling)   periodic — the series that falls, matching native sawtooth
 *   8 saw (rising)    periodic — the same series negated: the reverse saw
 *   9 white noise     NOT an oscillator: a looping buffer source, see noise.js
 *  10 reed            periodic — harmonics 1, 2, 3, 4, 6, 8 at falling amplitude
 *
 * THE FOUR RESERVED NAMES
 *   The schema in ui/params.js is the list of ten (WAVEFORMS). This module maps
 *   each name to how it is realised, and `waveKind` says which: 'native',
 *   'periodic', or 'noise'. A name with no entry here would be a silently dead
 *   waveform, so tests/wave.test.mjs asserts all ten are covered.
 *
 *   nativeWaveform(name)          -> 'sine'|'triangle'|'sawtooth'|'square'|null
 *   waveKind(name)                -> 'native'|'periodic'|'noise'|null
 *   periodicWaveName(name)        -> the periodic-wave key, or null
 *   buildPeriodicWave(name, ctx)  -> a PeriodicWave for ctx, or null if native
 *   sawCoefficients / pulseCoefficients / reedCoefficients   (pure)
 *
 * THE SERIES CONVENTION
 *   Web Audio evaluates x(t) = sum over n of (real[n] cos(n.wt) + imag[n] sin(n.wt)),
 *   where index 0 is the DC term and is ignored here. A sawtooth is therefore a
 *   pure sine series at -2/(n.pi) per harmonic (rising ramp) or +2/(n.pi)
 *   (falling ramp), and a duty-cycle pulse carries both parts:
 *
 *     real[n] = 2 sin(2.pi.n.d) / (n.pi)
 *     imag[n] = 2 (1 - cos(2.pi.n.d)) / (n.pi)
 *
 *   At d = 0.5 the real part vanishes and the odd harmonics come out at 4/(n.pi),
 *   which is exactly a square wave — so 'square' and 'pulse25' are the same code
 *   path at different duties rather than two separate implementations.
 *
 * NORMALISATION
 *   Tables are created with Web Audio's default normalisation (disableNormalization
 *   false), so every waveform is normalised to a peak of 1. Per-core LEVEL gains
 *   are therefore comparable across waveforms, which is what a level control has
 *   to be.
 */

import { WAVEFORMS } from '../ui/params.js';

export { WAVEFORMS };

/** The four shapes an OscillatorNode produces by itself. */
export const NATIVE_WAVEFORMS = Object.freeze({
  sine: 'sine',
  triangle: 'triangle',
  sawtooth: 'sawtooth',
  square: 'square',
});

/** The duty cycles built as PeriodicWaves. 50% is the native square. */
export const PULSE_DUTIES = Object.freeze([0.5, 0.25, 0.125]);

/** Harmonics per sawtooth table. 64 is far past anything audible and cheap. */
export const SAWT_HARMONICS = 64;

/** The additive reed: harmonics 1, 2, 3, 4, 6, 8 — the odd 5 and 7 are absent,
 *  which is what makes it hollow rather than organ-like. */
export const REED_PARTIALS = Object.freeze({
  partials: Object.freeze([1, 2, 3, 4, 6, 8]),
  amplitudes: Object.freeze([1, 0.55, 0.34, 0.2, 0.11, 0.06]),
});

const PULSE_BY_NAME = Object.freeze({ pulse25: 0.25, pulse125: 0.125 });

/** Every non-native waveform name, and how to build it. */
const PERIODIC_BUILDERS = Object.freeze({
  pulse25: () => pulseCoefficients({ duty: PULSE_BY_NAME.pulse25 }),
  pulse125: () => pulseCoefficients({ duty: PULSE_BY_NAME.pulse125 }),
  sawDown: () => sawCoefficients({ sign: 1 }),
  sawUp: () => sawCoefficients({ sign: -1 }),
  reed: () => reedCoefficients(),
});

/** The periodic waveforms, in schema order. */
export const PERIODIC_WAVEFORMS = Object.freeze(['pulse25', 'pulse125', 'sawDown', 'sawUp', 'reed']);

/* --------------------------------------------------------------- pure maths --- */

const emptySeries = (harmonics) => new Array(harmonics + 1).fill(0);

/**
 * A sawtooth's sine series. `sign: 1` is the FALLING ramp (native sawtooth):
 * +2/(n.pi). `sign: -1` negates every coefficient, which is the RISING ramp —
 * the reverse saw. Negation is exact, so the two are guaranteed to be mirror
 * images of each other.
 */
export function sawCoefficients({ harmonics = SAWT_HARMONICS, sign = 1 } = {}) {
  const imag = emptySeries(harmonics);
  for (let n = 1; n <= harmonics; n += 1) imag[n] = (sign * 2) / (n * Math.PI);
  return { real: emptySeries(harmonics), imag };
}

/**
 * A pulse of the given duty cycle, high for the first `duty` of the cycle and
 * low for the rest. Duty 0.5 is a square wave; duty 0.125 is a narrow pulse
 * whose low harmonics are cancelled by the cosine terms.
 */
export function pulseCoefficients({ duty = 0.5, harmonics = SAWT_HARMONICS } = {}) {
  if (!Number.isFinite(duty) || duty <= 0 || duty >= 1) {
    throw new RangeError(`pulseCoefficients: duty must be between 0 and 1 exclusive, got ${duty}`);
  }
  const real = emptySeries(harmonics);
  const imag = emptySeries(harmonics);
  for (let n = 1; n <= harmonics; n += 1) {
    const angle = 2 * Math.PI * n * duty;
    real[n] = (2 * Math.sin(angle)) / (n * Math.PI);
    imag[n] = (2 * (1 - Math.cos(angle))) / (n * Math.PI);
  }
  return { real, imag };
}

/** The additive reed: a cosine series over six partials at falling amplitude. */
export function reedCoefficients({ partials = REED_PARTIALS.partials, amplitudes = REED_PARTIALS.amplitudes } = {}) {
  const highest = Math.max(...partials);
  const real = emptySeries(highest);
  const imag = emptySeries(highest);
  partials.forEach((partial, i) => {
    real[partial] = amplitudes[i];
  });
  return { real, imag };
}

/* ------------------------------------------------------------- the registry --- */

/** The native OscillatorNode type for a waveform name, or null. */
export function nativeWaveform(name) {
  return NATIVE_WAVEFORMS[name] ?? null;
}

/** Is this waveform one of the four the browser builds for free? */
export function isNativeWaveform(name) {
  return Object.hasOwn(NATIVE_WAVEFORMS, name);
}

/** The PeriodicWave key for a waveform name, or null if it is not periodic. */
export function periodicWaveName(name) {
  return Object.hasOwn(PERIODIC_BUILDERS, name) ? name : null;
}

/** 'native' | 'periodic' | 'noise' | null (no such waveform). */
export function waveKind(name) {
  if (isNativeWaveform(name)) return 'native';
  if (name === 'noise') return 'noise';
  if (periodicWaveName(name)) return 'periodic';
  return null;
}

/**
 * Build the PeriodicWave for `name` on `context`, or null when the waveform is
 * native (or unknown) and no table is needed. Tables are rebuilt per call
 * because they are cheap, per-context, and caching them would put a second
 * lifetime in the middle of a voice's teardown.
 */
export function buildPeriodicWave(name, context) {
  const key = periodicWaveName(name);
  if (!key || !context) return null;
  const { real, imag } = PERIODIC_BUILDERS[key]();
  return context.createPeriodicWave(real, imag);
}