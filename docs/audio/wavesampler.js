/**
 * wavesampler.js — the fourth voice: one PeriodicWave table, a scan position, a
 * level of its own, and a file input that accepts a user `.wav`.
 *
 * WHAT THIS MODULE IS FOR
 *   A wavetable oscillator is an OscillatorNode whose shape is a Fourier series.
 *   Web Audio has no way to load a table into it, so a wavetable has to arrive as
 *   REAL AND IMAGINARY COEFFICIENTS. This module is the whole path from "a wave"
 *   to "coefficients Web Audio will accept", and it owns three things that are
 *   arithmetic rather than wiring, which is why they live here and are unit
 *   tested in node instead of being judged by ear:
 *
 *   1. THE 2048-POINT CONTRACT (WAVE_TABLE_LENGTH). Every table — factory or user
 *      — is exactly 2048 samples long and yields exactly 1025 real and 1025
 *      imaginary coefficients. Not a tuning knob: switching tables never changes
 *      the cost or the allocation, and a table's size cannot be used as a lever on
 *      anything else.
 *
 *   2. A REAL RESAMPLE. A decoded file is almost never 2048 samples, so it is
 *      resampled with a Kaiser-windowed sinc over a CYCLIC read (the table is one
 *      repeating cycle, so index arithmetic wraps). This is not a nicety: a
 *      nearest-neighbour stretch of a short file is a staircase, and a plain linear
 *      DECIMATION of a long one folds energy from above the new Nyquist back down
 *      into audible partials. The kernel is band-limited, so decimation is clean.
 *
 *   3. THE NYQUIST CAP. A PeriodicWave is not band-limited by the browser: it
 *      renders every coefficient you give it, at every frequency. A coefficient at
 *      harmonic index N is zeroed when N * f > 0.5 * sampleRate.
 *
 *   Also here: the four factory coefficient sets, the scan phase rotation, the two
 *   shapes decodeAudioData failure can take, and the per-note oscillator that lands
 *   in a voice's wavesampler slot.
 *
 * THE FOUR FACTORY TABLES — EXACT COEFFICIENT SETS
 *   Web Audio evaluates x(t) = SUM over n of (real[n] cos(n.wt) + imag[n] sin(n.wt)).
 *   Index 0 is DC and is zero everywhere below. The literals in FACTORY_TABLES are
 *   written to six decimal places; the formula that produced each is restated here
 *   and tests/wave-sampler.test.mjs re-derives every number from these formulas, so
 *   this comment cannot drift away from the code without a test failing.
 *
 *   warmSaw   "Warm Saw" — a saw spectrum with rolled-off upper harmonics.
 *             A saw sine series is +2/(n.pi) per harmonic. This one is
 *               imag[n] = (2 / (n.pi)) * taper(n)   for n = 1..32,  real = 0
 *               taper(n) = 1                                    n <= 8
 *               taper(n) = 0.5 * (1 + cos(pi * (n-8) / 24))       8 < n < 32
 *               taper(32) = 0
 *             so the body is a true saw through harmonic 8 and then falls to
 *             nothing at 32 on a raised cosine. That taper is the "warm": no
 *             harsh upper edge, and no partial at all by the 32nd.
 *
 *   softSquare "Soft Square" — odd harmonics with a 1/n falloff.
 *             imag[n] = 4/(n.pi) * taper(n) for ODD n = 1..31, 0 for even, real = 0
 *               taper(n) = 1                                    n <= 15
 *               taper(n) = 0.5 * (1 + cos(pi * (n-15) / 16))    15 < n <= 31
 *             4/(n.pi) is the series of a 50% pulse: no even harmonics at all, and
 *             amplitude falling as 1/n. The same taper as Warm Saw's keeps the top
 *             clean, so it reads as a round square rather than a bright buzzer.
 *
 *   reed      "Reed" — a small harmonic stack, and the ONE definition of it:
 *             the reedCoefficients() series already in audio/waveforms.js
 *             (partials 1, 2, 3, 4, 6, 8 at 1, 0.55, 0.34, 0.2, 0.11, 0.06,
 *             cosine only). Absent odd partials 5 and 7 are what make it hollow
 *             instead of organ-like. It is imported rather than copied so the
 *             wavesampler's reed and the oscillator's reed cannot drift apart.
 *
 *   glass     "Glass" — bright and inharmonic-leaning. PeriodicWave coefficients are
 *             indexed by INTEGER harmonic, so this cannot literally be an
 *             inharmonic ratio list; what it is instead is a struck-glass SPECTRUM,
 *             which is the same perceptual cue. Cosine only, partials and amplitudes:
 *               n:   1    2    3    4    5    7    9   11   13   17   19   23   29   31   37
 *               a: 0.50 0.22 0.30 0.50 0.34 0.26 0.20 0.17 0.14 0.12 0.10 0.085 0.06 0.055 0.045
 *             A weak 2nd, a strong 4th and 5th, a prominent 7th, and a bright cluster
 *             at the primes 17, 19, 23, 29, 31 and 37. Missing low partials with
 *             energy piled into high-order primes is what makes a struck bar sound
 *             inharmonic, and it is audible as inharmonic even though every index is
 *             an integer.
 *
 * THE SCAN POSITION — MECHANISM, AND WHY IT SPANS HALF A CYCLE
 *   OscillatorNode has no phase parameter: you cannot set one, so a per-note phase
 *   offset has to come from somewhere else. Two mechanisms exist.
 *
 *     (a) delay the oscillator's start() by scan * (1 / f). One line, no memory.
 *         But it leaves a gap of up to a full period before the wave sounds — 21 ms
 *         at MIDI 36 — which is an audible hole at the attack of a low note.
 *
 *     (b) rotate the Fourier coefficients. For a phase offset p, each harmonic's
 *         (real, imag) pair is simply rotated by n*p:
 *             real'[n] = real[n] cos(n.p) - imag[n] sin(n.p)
 *             imag'[n] = real[n] sin(n.p) + imag[n] cos(n.p)
 *         Exact, gapless, and free at run time: the rotation happens once, when the
 *         PeriodicWave for a scan position is built and cached. This is what is used.
 *
 *   Two consequences, both intended:
 *     - scan spans HALF a cycle (SCAN_SPAN = 0.5), not a whole one. A whole cycle
 *       returns to the same waveform, so a control whose two ends sound identical is
 *       a control that reads as broken at exactly the two places a user checks.
 *       Half a cycle is the longest travel that always lands on a different part of
 *       the shape.
 *     - a phase offset is audible in the ATTACK, not in the steady state. The RMS of
 *       a periodic signal taken over whole cycles does not depend on the phase at
 *       all — rotating a series leaves SUM(a_n^2 + b_n^2) unchanged — so the honest
 *       measurement of "the wave is read somewhere else" is the first cycles of the
 *       note, not its settled level. tests/wave-sampler.test.mjs asserts the rotation
 *       algebra; the browser check measures the attack window.
 *
 *   Because an OscillatorNode cannot swap its wave after start(), a scan change takes
 *   effect on the NEXT note. That is the same rule the instrument already applies to
 *   a waveform change (see engine.js), so the two controls behave alike.
 *
 * THE SLOTS, AND WHY A LOADED FILE IS NOT A FIFTH OPTION
 *   `wave.table` is an enum of exactly four names in the parameter schema, and
 *   ui/params.js rejects a value outside an enum. Those four names are therefore the
 *   four WAVE SLOTS of a four-slot wavetable unit, and a loaded file takes over the
 *   slot you are on — which is what a hardware wavetable slot does, and what a
 *   loader that must not edit the schema can honestly do. The consequence is
 *   deliberate and visible: the slot keeps its name, and the CONTENT reports its own
 *   name and origin through tableName() ('user:my-tone'), so selecting a different
 *   table and back is observable. restoreFactory(slot) puts the built-in wave back.
 *
 * CHANNEL 0 FOR STEREO, ON PURPOSE
 *   A stereo file is accepted, and channel 0 is taken. Folding to mono is a
 *   resample-and-sum with a gain law of its own, which changes the sound of a
 *   file the user knows; taking one channel is the plainer promise ("your left
 *   channel") and it keeps the resampler doing one thing. The table records
 *   channelUsed and a note saying so.
 *
 * BOTH decodeAudioData FAILURE SHAPES
 *   decodeAudioData has two: it returns a promise that can reject, and it takes a
 *   deprecated error callback. Depending on the browser, a malformed file may do
 *   either — and the callback form may do it while also returning a promise that
 *   rejects, or throw synchronously. decodeAudioBuffer passes BOTH handlers to ONE
 *   call and settles exactly once, so all four paths land in the same place. A load
 *   failure never changes the selected table: the previous one stays, the instrument
 *   keeps playing, and the reason is recorded (errors()) and logged.
 *
 * STORAGE IS TASK 12's, NOT THIS MODULE's
 *   serialize() hands over the 2048-point table as plain numbers — about 18 KB of
 *   JSON for one table, against 265 KB for a one-second 44.1 kHz source file. The
 *   storage itself, the quota failure and the preset slots are task 12's; all this
 *   module owes it is a document it can round-trip, and restore() to read one back.
 */

import { reedCoefficients } from './waveforms.js';
import { createOscillator, retireNode } from './nodes.js';
import { setNow } from './automation.js';
import { store } from '../ui/params.js';

const TAU = Math.PI * 2;

/* ------------------------------------------------------------- the contract --- */

/** Every table is exactly this many samples long. A fixed contract, not a knob. */
export const WAVE_TABLE_LENGTH = 2048;

/** A 2048-sample cycle yields 1024 harmonics plus the DC term. */
export const TABLE_HARMONICS = WAVE_TABLE_LENGTH / 2;

/** Coefficients are allocated in blocks of this many harmonics. */
export const HARMONIC_QUANTUM = 4;

/** Scan positions are cached in this many steps across the travel. */
export const SCAN_STEPS = 64;

/** Scan travel, in cycles. Half a cycle, deliberately — see the module header. */
export const SCAN_SPAN = 0.5;

/** The resample kernel: 8 taps either side of each output sample. */
export const KERNEL_HALF_WIDTH = 8;

/** Kaiser window beta. ~-80 dB sidelobes, which is below the noise floor of a wavetable. */
export const KAISER_BETA = 8.6;

/**
 * The highest frequency the default headroom can reach, as a multiple of the note.
 * One octave, which covers a live octave or semitone change and a pitch bend inside
 * it. Two octaves would be "safe" and useless: at +24 semitones the budget collapses
 * to the fundamental and the table becomes a sine.
 */
export const PITCH_HEADROOM_RATIO = 2;

/** The four slots, in the order the schema declares them. */
export const WAVE_TABLE_NAMES = Object.freeze(['warmSaw', 'softSquare', 'reed', 'glass']);

/* ------------------------------------------------------ the factory spectra --- */

const warmSawImag = Object.freeze([
  0, 0.63662, 0.31831, 0.212207, 0.159155, 0.127324, 0.106103, 0.090946, 0.079577,
  0.070433, 0.062577, 0.055672, 0.049498, 0.043911, 0.038813, 0.034139, 0.029842,
  0.02589, 0.022261, 0.01894, 0.015915, 0.013179, 0.010724, 0.008543, 0.006631,
  0.004981, 0.003586, 0.002436, 0.001523, 0.000836, 0.000362, 0.000088, 0,
]);

const softSquareImag = Object.freeze([
  0, 1.27324, 0, 0.424413, 0, 0.254648, 0, 0.181891, 0, 0.141471, 0, 0.115749, 0,
  0.097942, 0, 0.084883, 0, 0.072046, 0, 0.057199, 0, 0.041916, 0, 0.027679, 0,
  0.01572, 0, 0.006906, 0, 0.001671, 0, 0,
]);

const glassReal = Object.freeze([
  0, 0.5, 0.22, 0.3, 0.5, 0.34, 0, 0.26, 0, 0.2, 0, 0.17, 0, 0.14, 0, 0, 0,
  0.12, 0, 0.1, 0, 0, 0, 0.085, 0, 0, 0, 0, 0, 0.06, 0, 0.055, 0, 0, 0, 0, 0, 0.045,
]);

/** A frozen run of zeros, as a plain array like every other coefficient list here. */
const zeros = (length) => Object.freeze(new Array(length).fill(0));

/**
 * The four factory tables, by slot name. `real` and `imag` are index 0 (DC) through
 * the highest harmonic; the coefficients below that are zero and are filled in when
 * the table is built. See the module header for the formulas these literals came
 * from, which tests/wave-sampler.test.mjs re-derives.
 */
export const FACTORY_TABLES = Object.freeze({
  warmSaw: Object.freeze({
    label: 'Warm Saw',
    description: 'Saw series with a raised-cosine taper from harmonic 9 to 32.',
    harmonics: 32,
    real: zeros(33),
    imag: warmSawImag,
  }),
  softSquare: Object.freeze({
    label: 'Soft Square',
    description: 'Odd harmonics at 1/n, tapered from 17 to zero at 31.',
    harmonics: 31,
    real: zeros(32),
    imag: softSquareImag,
  }),
  reed: Object.freeze({
    label: 'Reed',
    description: 'Partials 1, 2, 3, 4, 6, 8 — the reed series shared with waveforms.js.',
    harmonics: 8,
    ...reedCoefficients(),
  }),
  glass: Object.freeze({
    label: 'Glass',
    description: 'Struck-glass spectrum: weak 2nd, strong 4th/5th, primes up top.',
    harmonics: 37,
    real: glassReal,
    imag: zeros(38),
  }),
});

const LABELS = Object.freeze({ warmSaw: 'Warm Saw', softSquare: 'Soft Square', reed: 'Reed', glass: 'Glass' });

/** The painted label for a slot name or a loaded file name. */
export function tableLabel(name) {
  if (LABELS[name]) return LABELS[name];
  const bare = String(name ?? '').replace(/^user:/, '').replace(/\.[^.]+$/, '');
  if (!bare) return '—';
  return bare
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------- pure maths --- */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

/** The modified Bessel function of the first kind, order 0, by its defining series
 *  I0(x) = SUM over k of ((x/2)^(2k) / (k!)^2), accumulated by the usual recurrence
 *  so no factorial is ever formed. x never exceeds KAISER_BETA here (8.6), where the
 *  series converges in about eight terms and the largest partial sum is ~2.6e3 —
 *  comfortable in float64, and exact enough that the window is right rather than
 *  approximately right, which matters because a wrong window divides the resample
 *  by a wrong weight. */
export function besselI0(x) {
  const t = (Math.abs(x) / 2) ** 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 64; k += 1) {
    term *= t / (k * k);
    sum += term;
    if (term <= sum * 1e-18) break;
  }
  return sum;
}

/** The Kaiser window: 1 at the centre, 0 at the edge, `beta` sets the sidelobes. */
export function kaiserWindow(offset, halfWidth, beta) {
  if (halfWidth <= 0) return 1;
  const u = Math.abs(offset) / halfWidth;
  if (u >= 1) return 0;
  const inner = Math.sqrt(Math.max(0, 1 - u * u));
  return besselI0(beta * inner) / besselI0(beta);
}

/** sinc(t) = sin(pi t) / (pi t), with sinc(0) = 1. */
const sinc = (t) => (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t));

/**
 * The series -> 2048 samples, one cycle. The inverse of samplesToCoefficients: the
 * factory tables know their coefficients analytically, and synthesising the cycle is
 * what gives them their 2048-point sample table (the same table a user file gets).
 * Only non-zero terms are summed, so a table with eight partials costs eight
 * multiplies per sample rather than a thousand.
 */
export function synthesiseCycle(series, length = WAVE_TABLE_LENGTH) {
  const { real = [], imag = [] } = series ?? {};
  const terms = [];
  const highest = Math.max(real.length, imag.length) - 1;
  for (let n = 1; n <= highest; n += 1) {
    const re = finite(real[n]);
    const im = finite(imag[n]);
    if (re !== 0 || im !== 0) terms.push([n, re, im]);
  }
  const out = new Float32Array(length);
  const step = TAU / length;
  for (let k = 0; k < length; k += 1) {
    const phase = step * k;
    let sum = 0;
    for (let t = 0; t < terms.length; t += 1) {
      const [n, re, im] = terms[t];
      const angle = phase * n;
      sum += re * Math.cos(angle) + im * Math.sin(angle);
    }
    out[k] = sum;
  }
  return out;
}

/**
 * Resample any cycle to exactly `length` points. A REAL resample: a Kaiser-windowed
 * sinc kernel read with CYCLIC index arithmetic, because the table is one repeating
 * cycle and index 2047 wraps to index 0.
 *
 * The kernel is band-limited to `min(1, length / input.length)` cycles per output
 * sample. When the input is longer than the table that cutoff is below 1, which is
 * the anti-aliasing: a partial that was legal in the input and is illegal in the
 * output is attenuated rather than folded down into an audible one. When the input
 * is shorter, the cutoff is 1 and this is plain high-quality interpolation — no
 * nearest-neighbour steps, so a four-sample file still produces a smooth cycle.
 *
 * Each output sample is divided by the sum of the kernel weights that produced it,
 * which is what keeps a constant input constant (exactly, not approximately) and
 * stops the window taper from dipping the waveform near the seam.
 */
export function resampleCycle(samples, length = WAVE_TABLE_LENGTH, { halfWidth = KERNEL_HALF_WIDTH, beta = KAISER_BETA } = {}) {
  const count = samples?.length ?? 0;
  const out = new Float32Array(length);
  if (count === 0) return out;
  const at = (k) => {
    const wrapped = ((k % count) + count) % count;
    const v = Number(samples[wrapped]);
    return Number.isFinite(v) ? v : 0;
  };
  if (count === 1) {
    out.fill(at(0));
    return out;
  }

  const ratio = length / count;
  const cutoff = Math.min(1, ratio);
  for (let j = 0; j < length; j += 1) {
    const centre = j / ratio;
    const first = Math.ceil(centre - halfWidth);
    const last = Math.floor(centre + halfWidth);
    let acc = 0;
    let weight = 0;
    for (let k = first; k <= last; k += 1) {
      const offset = k - centre;
      const coefficient = sinc(cutoff * offset) * kaiserWindow(offset, halfWidth, beta);
      acc += at(k) * coefficient;
      weight += coefficient;
    }
    out[j] = weight !== 0 ? acc / weight : 0;
  }
  return out;
}

/**
 * 2048 samples -> the Fourier coefficients of the wave they sample. The direct
 * transform, because a table is built once (a file load, or the first note on a
 * factory table) and clarity is worth more here than speed: 1025 harmonics over 2048
 * samples is about 45 ms, once, and after that the coefficients are cached on the
 * table and every note is a rotation and a truncation.
 *
 * real[n] = (2/N) SUM x_k cos(2 pi n k / N)      imag[n] = (2/N) SUM x_k sin(2 pi n k / N)
 *
 * The DC term is averaged rather than doubled (it is not a sinusoid) and is zeroed
 * later anyway: Web Audio ignores index 0.
 */
export function samplesToCoefficients(samples, { harmonics = Math.floor((samples?.length ?? 0) / 2) } = {}) {
  const count = samples?.length ?? 0;
  const real = new Float64Array(harmonics + 1);
  const imag = new Float64Array(harmonics + 1);
  if (count === 0) return { real, imag };
  const last = Math.min(harmonics, count - 1);
  for (let n = 0; n <= last; n += 1) {
    let sumReal = 0;
    let sumImag = 0;
    for (let k = 0; k < count; k += 1) {
      const angle = (TAU * n * k) / count;
      const value = Number(samples[k]);
      if (!Number.isFinite(value)) continue;
      sumReal += value * Math.cos(angle);
      sumImag += value * Math.sin(angle);
    }
    real[n] = n === 0 ? sumReal / count : (2 * sumReal) / count;
    imag[n] = (2 * sumImag) / count;
  }
  return { real, imag };
}

/**
 * THE NYQUIST CAP. A coefficient at harmonic index N is zeroed when N * f exceeds
 * half the sample rate — the rule, applied exactly, with no quantisation. The result
 * is a new series: a table is never edited in place, because the same table has to
 * serve every frequency the instrument can play it at.
 *
 * `limit` is an additional ceiling for the caller that has already decided how many
 * harmonics it is willing to allocate (harmonicBudget's quantised block count).
 *
 * The result reports `ceiling` (the true Nyquist limit at this frequency), `cappedAt`
 * (the highest harmonic actually kept — the lower of the two ceilings) and `zeroed`
 * (how many coefficients the cap removed in all), so a caller can tell "illegal at this
 * frequency" apart from "not allocated".
 *
 * A frequency of zero, or one past Nyquist, yields no harmonics at all rather than an
 * exception: a voice with no pitch must not be able to fail a note-on.
 */
export function capHarmonics(series, { frequency, sampleRate = 48000, limit = TABLE_HARMONICS } = {}) {
  const { real = [], imag = [] } = series ?? {};
  const length = Math.min(real.length, imag.length);
  const rate = finite(sampleRate, 48000);
  const hz = finite(frequency, 0);
  const ceiling = hz > 0 ? Math.floor((0.5 * rate) / hz) : limit;
  const cappedAt = Math.max(0, Math.min(limit, ceiling, length - 1));
  const outReal = new Float64Array(length);
  const outImag = new Float64Array(length);
  let zeroed = 0;
  for (let n = 0; n < length; n += 1) {
    if (n <= cappedAt) {
      outReal[n] = n === 0 ? 0 : finite(real[n]); // index 0 is DC: always zero
      outImag[n] = finite(imag[n]);
    } else {
      zeroed += 1;
    }
  }
  return { real: outReal, imag: outImag, ceiling, cappedAt, zeroed };
}

/**
 * The scan phase: rotate every harmonic by its own multiple of the phase, which is
 * what shifts the whole wave within its cycle. A whole turn is the identity; a half
 * turn inverts the odd harmonics and leaves the even ones alone. New series out.
 */
export function rotateCoefficients(series, turns = 0) {
  const { real = [], imag = [] } = series ?? {};
  const length = Math.min(real.length, imag.length);
  const outReal = new Float64Array(length);
  const outImag = new Float64Array(length);
  const phase = finite(turns, 0) * TAU;
  for (let n = 0; n < length; n += 1) {
    const angle = phase * n;
    const re = n === 0 ? 0 : finite(real[n]);
    const im = finite(imag[n]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    outReal[n] = re * c - im * s;
    outImag[n] = re * s + im * c;
  }
  outReal[0] = 0;
  outImag[0] = 0;
  return { real: outReal, imag: outImag };
}

/**
 * How many harmonics a table may carry at this frequency.
 *
 * The true ceiling is floor(0.5 * sampleRate / f) for the frequency IN USE, which is
 * re-evaluated for every note — so a table is never handed to an oscillator at a
 * frequency it was not capped for.
 *
 * One octave of headroom (PITCH_HEADROOM_RATIO) is added on top, because a note's
 * pitch can still move while it sounds: engine.js re-resolves a core's frequency when
 * octave, semitone or detune changes, and this oscillator follows the same pitch
 * source, so a table capped for exactly f would alias as soon as the note went up.
 * One octave covers a live octave or semitone change and a bend inside it.
 *
 * The count is rounded DOWN to a multiple of HARMONIC_QUANTUM, which is what keeps
 * the number of distinct PeriodicWaves bounded: quantising downward can only ever
 * drop a harmonic, never admit an illegal one, and the harmonics it drops are above
 * 10 kHz at any note where the difference is audible. The remainder is the task 7
 * matrix's business: a modulation route that pushes a voice by more than an octave
 * can still alias, and no table-level cap can prevent that without capping the wave
 * to a sine.
 */
export function harmonicBudget(frequency, sampleRate = 48000, { ratio = PITCH_HEADROOM_RATIO } = {}) {
  const rate = finite(sampleRate, 48000);
  const reach = Math.max(finite(frequency, 0), 1e-6) * Math.max(1, finite(ratio, 1));
  const ceiling = Math.floor((0.5 * rate) / reach);
  if (ceiling <= 0) return 1;
  return Math.max(1, Math.min(TABLE_HARMONICS, Math.floor(ceiling / HARMONIC_QUANTUM) * HARMONIC_QUANTUM));
}

/* ------------------------------------------------------------- the tables --- */

const tableCache = new Map();
const waveCaches = new WeakMap();

/** How many built PeriodicWaves to keep per context before evicting the oldest. */
export const MAX_CACHED_WAVES = 192;

/**
 * One table: its name, its kind, its 2048-point sample table, and the coefficients
 * those samples are. `coefficients` always carries TABLE_HARMONICS + 1 of each; the
 * Nyquist cap is applied when a note is played, not here, because one table serves
 * every note.
 */
function makeTable({ id, name, label, kind, samples, coefficients, sourceName = null, channels = null, channelUsed = 0, notes = [] }) {
  return {
    id,
    name,
    label,
    kind,
    length: samples.length,
    samples,
    coefficients,
    sourceName,
    channels,
    channelUsed,
    notes,
  };
}

function paddedSeries({ real, imag }, harmonics) {
  const outReal = new Float64Array(harmonics + 1);
  const outImag = new Float64Array(harmonics + 1);
  for (let n = 0; n < harmonics + 1; n += 1) {
    outReal[n] = n < real.length ? finite(real[n]) : 0;
    outImag[n] = n < imag.length ? finite(imag[n]) : 0;
  }
  outReal[0] = 0;
  outImag[0] = 0;
  return { real: outReal, imag: outImag };
}

/**
 * A factory table, built on first use and cached after. Its samples are synthesised
 * from the analytic coefficients (so the table is exactly 2048 points, as a user
 * table's is) and its coefficients are those literals padded out to the full length —
 * no transform needed, and no approximation.
 */
export function buildTable({ name }) {
  const cached = tableCache.get(name);
  if (cached) return cached;
  const spec = FACTORY_TABLES[name];
  if (!spec) return null;
  const table = makeTable({
    id: `factory:${name}`,
    name,
    label: spec.label,
    kind: 'factory',
    samples: synthesiseCycle(spec),
    coefficients: paddedSeries(spec, TABLE_HARMONICS),
    sourceName: null,
  });
  tableCache.set(name, table);
  return table;
}

/**
 * A table from 2048 (or any) samples of a loaded cycle. The samples are resampled to
 * the contract length first, then transformed into coefficients, so a loaded file and
 * a factory table are the same kind of object by the time anything plays them. The
 * caller's samples are expected to be centred already; centring again here is
 * harmless and keeps the table's DC at zero whatever it is handed.
 */
export function createWaveTable({ name, samples, sourceName = null, channels = null, notes = [] }) {
  const table = resampleCycle(samples);
  const mean = table.reduce((sum, v) => sum + v, 0) / table.length;
  const centred = Float32Array.from(table, (v) => v - mean); // no DC: DC would step on every cycle
  return makeTable({
    id: `user:${sourceName ?? name}`,
    name,
    label: tableLabel(name),
    kind: 'user',
    samples: centred,
    coefficients: samplesToCoefficients(centred, { harmonics: TABLE_HARMONICS }),
    sourceName,
    channels,
    channelUsed: 0,
    notes,
  });
}

/* ------------------------------------------------------- the built waves --- */

/**
 * The PeriodicWave for a table at a frequency and a scan position, capped and
 * rotated. Cached per context by (table, scan step, harmonic budget): the same note
 * twice builds the wave once, a scan sweep builds at most SCAN_STEPS + 1 per harmonic
 * block, and the cache is bounded rather than growing for the life of the page.
 */
export function buildWave(context, table, { frequency = 440, sampleRate, scan = 0 } = {}) {
  if (!context || !table) return null;
  const rate = Number.isFinite(sampleRate) ? sampleRate : context.sampleRate ?? 48000;
  const budget = harmonicBudget(frequency, rate);
  const step = Math.round(clamp01(scan) * SCAN_STEPS);
  const key = `${table.id}|${step}|${budget}`;

  let cache = waveCaches.get(context);
  if (!cache) {
    cache = new Map();
    waveCaches.set(context, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;

  const rotated = rotateCoefficients(table.coefficients, (step / SCAN_STEPS) * SCAN_SPAN);
  const capped = capHarmonics(rotated, { frequency, sampleRate: rate, limit: budget });
  const wave = context.createPeriodicWave(
    Array.from(capped.real.slice(0, budget + 1)),
    Array.from(capped.imag.slice(0, budget + 1)),
  );
  cache.set(key, wave);
  if (cache.size > MAX_CACHED_WAVES) {
    const oldest = cache.keys().next().value;
    if (oldest !== key) cache.delete(oldest);
  }
  return wave;
}

/* ------------------------------------------------------------- the files --- */

/** A load failure that the instrument is expected to survive. */
export class WaveLoadError extends Error {
  constructor(message, { stage = 'decode', fileName = null, cause = null } = {}) {
    super(message);
    this.name = 'WaveLoadError';
    this.stage = stage;
    this.fileName = fileName;
    if (cause) this.cause = cause;
  }
}

/**
 * decodeAudioData, handling BOTH of its failure shapes and settling exactly once.
 *
 * The browser has two ways to report a bad file and they are not exclusive: the
 * returned promise can reject, the deprecated error callback can fire, the callback
 * form can throw synchronously, and some implementations both call the callback and
 * return a rejected promise. One call carries both handlers; whichever arrives first
 * wins and the rest are ignored. A file that decoded through the callback form alone
 * still resolves, which is the whole point of passing the callbacks at all.
 */
export function decodeAudioBuffer(context, buffer, { fileName = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!context || typeof context.decodeAudioData !== 'function') {
      reject(new WaveLoadError('no AudioContext to decode with', { stage: 'decode', fileName }));
      return;
    }
    let settled = false;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      const detail = reason instanceof Error ? reason.message : String(reason ?? 'decode failed');
      reject(new WaveLoadError(`could not decode "${fileName ?? 'file'}" as audio: ${detail}`, { stage: 'decode', fileName, cause: reason }));
    };
    let returned;
    try {
      returned = context.decodeAudioData(buffer, succeed, fail);
    } catch (error) {
      fail(error);
      return;
    }
    if (returned && typeof returned.then === 'function') returned.then(succeed, fail);
    else if (returned === undefined && !settled && context.decodeAudioData.length < 3) {
      // A callback-only implementation that ignored the error callback: nothing left
      // to wait on, so the load cannot succeed. Reject rather than hang.
      fail('decodeAudioData neither resolved nor reported an error');
    }
  });
}

/**
 * A File -> a table. Channel 0 is taken for a stereo file, the whole file is
 * resampled to one cycle of 2048 points, and the reasons a file is refused are all
 * WaveLoadError, so a caller can catch one thing.
 */
export async function wavetableFromBuffer(file, { context } = {}) {
  const fileName = typeof file?.name === 'string' && file.name ? file.name : null;
  let bytes;
  try {
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new Error('not a file');
    }
    bytes = await file.arrayBuffer();
  } catch (error) {
    throw new WaveLoadError(`could not read "${fileName ?? 'file'}": ${error.message}`, { stage: 'read', fileName, cause: error });
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new WaveLoadError(`"${fileName ?? 'file'}" is empty`, { stage: 'read', fileName });
  }

  const decoded = await decodeAudioBuffer(context, bytes, { fileName });
  const channels = decoded?.numberOfChannels ?? 0;
  const length = decoded?.length ?? 0;
  if (channels < 1 || !decoded.getChannelData) {
    throw new WaveLoadError(`"${fileName ?? 'file'}" decoded to no channels`, { stage: 'decode', fileName });
  }
  if (length < 2) {
    throw new WaveLoadError(`"${fileName ?? 'file'}" decoded to ${length} sample${length === 1 ? '' : 's'}; a single cycle needs at least 2 samples`, {
      stage: 'decode',
      fileName,
    });
  }

  const notes = [];
  if (channels > 1) notes.push(`stereo file: channel 0 taken, ${channels - 1} other channel${channels === 2 ? '' : 's'} ignored`);

  const raw = decoded.getChannelData(0);
  const samples = new Float32Array(length);
  let mean = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Number(raw[i]);
    mean += Number.isFinite(v) ? v : 0;
  }
  mean /= length;
  // The DC offset comes out BEFORE the "is this actually a wave" question, because a
  // constant file has a large mean and no signal at all: without subtracting first, a
  // flat file passes an RMS test and then becomes a table of zeroes.
  let spread = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Number(raw[i]);
    samples[i] = (Number.isFinite(v) ? v : 0) - mean;
    const magnitude = Math.abs(samples[i]);
    if (magnitude > spread) spread = magnitude;
  }
  if (spread <= 1e-6) {
    throw new WaveLoadError(`"${fileName ?? 'file'}" is silent — a flat cycle is not a wave`, { stage: 'decode', fileName });
  }

  const base = (fileName ?? 'loaded').replace(/\.[^.]*$/, '');
  return createWaveTable({ name: `user:${base}`, samples, sourceName: fileName, channels, notes });
}

/* ------------------------------------------------------------ the facade --- */

const slots = new Map();
const errorLog = [];
const voiceHandles = new Map();

/** Errors kept at most this many, so a user dropping a folder of junk cannot grow it. */
export const MAX_RECORDED_ERRORS = 20;

const serialise = (table, slot) => ({
  name: table.name,
  label: table.label,
  kind: table.kind,
  sourceName: table.sourceName,
  slot: slot ?? currentSlot(),
  length: table.length,
  // Array.from, not Float32Array.map: a typed array's map returns a typed array, which
  // JSON.stringify writes as an object of indices rather than as an array.
  samples: Array.from(table.samples, (v) => Number(v.toFixed(6))),
});

const currentSlot = () => {
  const value = store.get('wave.table');
  return WAVE_TABLE_NAMES.includes(value) ? value : WAVE_TABLE_NAMES[0];
};

/** The table currently in a slot: the factory wave, or the last file loaded into it. */
export function tableForSlot(slot) {
  const name = WAVE_TABLE_NAMES.includes(slot) ? slot : currentSlot();
  if (!slots.has(name)) slots.set(name, buildTable({ name }));
  return slots.get(name);
}

function recordError(error, fileName) {
  const entry = {
    name: fileName ?? error?.fileName ?? null,
    stage: error?.stage ?? 'load',
    reason: error?.message ?? String(error),
    at: new Date().toISOString(),
  };
  errorLog.push(entry);
  while (errorLog.length > MAX_RECORDED_ERRORS) errorLog.shift();
  console.warn(`[wavesampler] ${entry.stage} failed for ${entry.name ?? 'file'}: ${entry.reason}`);
  return entry;
}

export const waveSampler = {
  /** The four slot names, which are also the schema's enum options. */
  slots: () => [...WAVE_TABLE_NAMES],

  /** The selected slot, straight from the store: it is the authority, not this module. */
  slot: currentSlot,

  /** Select a slot. The store refuses anything outside the schema's enum. */
  setSlot(name) {
    return store.set('wave.table', name, { source: 'wavesampler', apply: 'direct' });
  },

  /** The CONTENT currently selected: a slot name, or 'user:<file stem>'. */
  tableName: () => tableForSlot(currentSlot()).name,

  tableLabel: () => tableForSlot(currentSlot()).label,

  table: () => tableForSlot(currentSlot()),

  /** Every table the instrument holds, with the slot it currently occupies. */
  tables: () =>
    WAVE_TABLE_NAMES.map((slot) => {
      const table = tableForSlot(slot);
      return {
        slot,
        name: table.name,
        label: table.label,
        kind: table.kind,
        length: table.length,
        sourceName: table.sourceName,
        channels: table.channels,
        channelUsed: table.channelUsed,
        notes: table.notes,
      };
    }),

  /**
   * Load a file into a slot (the selected one by default). Returns the table.
   * On failure: throws a WaveLoadError, records the reason, and changes nothing —
   * the previously selected table stays selected and stays sounding.
   */
  async load(file, { context, slot } = {}) {
    const target = WAVE_TABLE_NAMES.includes(slot) ? slot : currentSlot();
    try {
      const table = await wavetableFromBuffer(file, { context });
      slots.set(target, table);
      return table;
    } catch (error) {
      recordError(error, typeof file?.name === 'string' ? file.name : null);
      throw error;
    }
  },

  /** Every failure this session, newest last. The UI shows the last one. */
  errors: () => errorLog.map((entry) => ({ ...entry })),

  clearErrors: () => {
    errorLog.length = 0;
    return 0;
  },

  /** Put the built-in wave back in a slot (the selected one by default). */
  restoreFactory(slot) {
    const target = WAVE_TABLE_NAMES.includes(slot) ? slot : currentSlot();
    const table = buildTable({ name: target });
    slots.set(target, table);
    return table;
  },

  /**
   * The hand-off to task 12. A table as plain JSON-safe numbers: name, kind, source
   * file name, the 2048-point sample table, and which slot holds it. Six decimal
   * places is far below the noise floor of a wavetable and keeps one table near 18 KB,
   * which is what makes a dozen preset slots fit inside a localStorage quota. The
   * source FILE is never serialised: a one-second 44.1 kHz wav is 15x the size of
   * everything this document needs.
   */
  serialize(name) {
    if (!name) return serialise(tableForSlot(currentSlot()));
    if (WAVE_TABLE_NAMES.includes(name)) return serialise(tableForSlot(name));
    for (const slot of WAVE_TABLE_NAMES) {
      const table = tableForSlot(slot);
      if (table.name === name) return serialise(table, slot);
    }
    return null;
  },

  /** Read a serialize() document back, without a File and without a decode. */
  restore(document_) {
    if (!document_ || !Array.isArray(document_.samples) || document_.samples.length === 0) {
      throw new WaveLoadError('that saved wavetable has no samples in it', { stage: 'restore' });
    }
    const slot = WAVE_TABLE_NAMES.includes(document_.slot) ? document_.slot : currentSlot();
    const table = createWaveTable({
      name: document_.name ?? `user:${document_.sourceName ?? 'restored'}`,
      samples: Float32Array.from(document_.samples, (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)),
      sourceName: document_.sourceName ?? null,
      notes: ['restored from a stored table'],
    });
    slots.set(slot, table);
    return table;
  },

  /**
   * Everything a verification step or an inspection panel needs, in one object. Pass
   * the context's real `frequency` and `sampleRate` to see the harmonic budget that
   * sample rate and pitch would actually use; the defaults are A4 at 48 kHz.
   */
  diagnostics({ frequency = 440, sampleRate = 48000 } = {}) {
    const table = tableForSlot(currentSlot());
    const budget = harmonicBudget(frequency, sampleRate);
    return {
      slot: currentSlot(),
      tableName: table.name,
      label: table.label,
      kind: table.kind,
      sourceName: table.sourceName,
      length: table.length,
      samples: table.samples.length,
      coefficients: table.coefficients.real.length,
      scan: store.get('wave.scan'),
      level: store.get('wave.level'),
      harmonicBudget: budget,
      coefficientsUsed: budget + 1,
      slots: WAVE_TABLE_NAMES.map((slot) => ({ slot, name: tableForSlot(slot).name, kind: tableForSlot(slot).kind })),
      errors: waveSampler.errors().length,
    };
  },
};

/* --------------------------------------------------------- the per-note voice --- */

/**
 * The whole load path in one call: bytes -> decode -> channel 0 -> 2048 points ->
 * Fourier -> capped on use. Shorthand for `waveSampler.load(file, options)`, which is
 * where the slot bookkeeping and the failure recording live.
 */
export function loadWaveFile(file, options = {}) {
  return waveSampler.load(file, options);
}

/**
 * One note's wavesampler: an oscillator on the built wave, into the voice's
 * wavesampler slot, at the voice's own core-1 pitch.
 *
 * The pitch is NOT computed here. The oscillator's frequency starts at zero and is
 * driven by the voice's core-1 ConstantSourceNode, the same signal that drives core
 * 1's oscillator, which means the wavesampler tracks the note, the octave, the
 * semitone, the detune and (once task 7 exists) the modulation matrix through the one
 * pitch path in the instrument — there is no second frequency computation anywhere.
 * The frequency the table is capped for is the one that path produced for this note.
 *
 * The level is the voice's wavesampler slot, so the three oscillator cores and the
 * wavesampler are independent by construction: silencing osc1..3 levels cannot touch
 * this gain.
 */
export function startWaveVoice({ voice, context, at, frequency, level = 0 }) {
  if (!voice?.waveSlot || !context) return null;
  const table = tableForSlot(currentSlot());
  const scan = store.get('wave.scan') ?? 0;
  const hz = Number.isFinite(frequency) ? frequency : 0;
  const wave = buildWave(context, table, { frequency: hz, sampleRate: context.sampleRate, scan });

  const oscillator = createOscillator(context, 'wavesampler-oscillator');
  oscillator.setPeriodicWave(wave);
  setNow(oscillator.frequency, 0, context, { at });
  oscillator.connect(voice.waveSlot);
  setNow(voice.waveSlot.gain, Math.max(0, Number(level) || 0), context, { at });

  const core = voice.cores?.[0];
  if (core?.pitchSource) core.pitchSource.connect(oscillator.frequency);
  else setNow(oscillator.frequency, hz, context, { at });

  oscillator.start(at);
  const handle = { node: oscillator, voice, table: table.name, hz, scan, slot: currentSlot(), stopping: false };
  oscillator.onended = () => {
    retireNode(oscillator);
    try {
      oscillator.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      core?.pitchSource?.disconnect(oscillator.frequency);
    } catch {
      /* already disconnected */
    }
    if (voiceHandles.get(voice.index)?.node === oscillator) voiceHandles.delete(voice.index);
  };
  voiceHandles.set(voice.index, handle);
  return handle;
}

/**
 * Stop a voice's wavesampler source. The voice releases its own three cores; nothing
 * in voice.js knows this oscillator exists, so the note path calls this beside every
 * release and before every note-on that may steal the voice. The fade matches the
 * voice's own release fade so the two sources die together.
 */
export function stopWaveVoice(voiceIndex, { at = 0, fade = 0.03 } = {}) {
  const handle = voiceHandles.get(voiceIndex);
  if (!handle) return false;
  // Tracked here rather than read off the node: an AudioScheduledSourceNode exposes no
  // "has it been stopped" flag, so only this module can answer that.
  handle.stopping = true;
  try {
    handle.node.stop(at + fade);
  } catch {
    /* already stopped */
  }
  return true;
}

/** Stop every sounding wavesampler source. Beside `allNotesOff`. */
export function stopAllWaveVoices({ at = 0, fade = 0.03 } = {}) {
  let stopped = 0;
  for (const voiceIndex of [...voiceHandles.keys()]) {
    if (stopWaveVoice(voiceIndex, { at, fade })) stopped += 1;
  }
  return stopped;
}

/** The per-note wavesampler sources still running, for the inspection handle. */
export function waveVoices() {
  return [...voiceHandles.values()].map((handle) => ({
    voice: handle.voice?.index ?? null,
    table: handle.table,
    hz: handle.hz,
    scan: handle.scan,
    stopping: handle.stopping,
  }));
}