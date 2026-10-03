/**
 * filter.js — the per-voice filter bank: five modes, a soft-clipping drive
 * stage, key tracking, and THE CUTOFF CLAMP the plan's risk register asks for.
 *
 * THE CHAIN THIS MODULE DESCRIBES (built by voice.js, between mix and VCA)
 *
 *   voice mix ─> [ stage 1: drive in ─> soft clip ─> drive out ─> section A ─> ┐
 *                                                                   └─> section B ] ─> ─> [ stage 2: ... ] ─> VCA
 *
 *   A stage is bypassed by rewiring AROUND it: the upstream node is
 *   disconnected from the stage's input and connected to the stage's output
 *   instead. Nothing is muted, so a bypassed stage contributes neither its
 *   resonance peak nor its slope, and it stops costing anything downstream.
 *
 * WHY LP24 IS TWO SECTIONS AND THE OTHER FOUR ARE NOT
 *   A `BiquadFilterNode` is a second-order section: 12 dB/octave. LP24 wants
 *   twice that slope, so it runs TWO lowpass sections in cascade and the second
 *   one is only in the path for that mode. The modes that are not LP24 are
 *   12 dB shapes already — a bandpass or a notch is a single section whatever
 *   you cascade, so cascading it would only add phase — so they use section A
 *   alone and section B is disconnected.
 *
 *   The interaction with the drive stage: the drive stage sits AHEAD of both
 *   sections, so it saturates the signal that the filter then shapes. That is
 *   the whole reason it is here — a hot biquad produces a narrow, very loud
 *   peak, and harmonics from the clipper are what make that peak sound like an
 *   instrument rather than a squeal. One drive stage per stage (not one per
 *   section) is deliberate: saturation is a property of the voice, not of the
 *   slope, so a 24 dB filter is not twice as saturated as a 12 dB one.
 *
 *   The RESONANT SECTION IS ONLY ONE OF THE PAIR. For LP24, section A takes the
 *   control's Q and section B is a Butterworth (Q = 1/√2) pole. Two identical
 *   resonant sections would square the resonance peak — +24 dB at Q 30 instead
 *   of +12 — and the plan explicitly refuses to add compensation gain for it.
 *   One resonant pole plus one flat pole is also what an analog 24 dB ladder
 *   does, which is where the Q 0.5..30 range comes from in the first place.
 *
 * THE CUTOFF CLAMP — WHAT TASK 7 MUST CALL
 *
 *   clampCutoff(hz, sampleRate) -> hz   (always finite, always audible)
 *
 *   The plan's named failure: pushing a biquad cutoff to zero or past Nyquist
 *   produces NaN output and can silence a voice PERMANENTLY. The clamp bounds
 *   the result to 20 Hz..20 kHz AND to `sampleRate * NYQUIST_FRACTION` (0.45), so
 *   a 44.1 kHz context tops out at 19845 Hz rather than at an unstable filter.
 *   An infinity clamps to the ceiling, a NaN or a non-number to the 20 Hz floor:
 *   quiet is recoverable, silence is not.
 *
 *   It is exported from here on purpose: ONE clamp, called from every route that
 *   can move a cutoff (the panel, key tracking and every modulation route). Task
 *   7 is forbidden from writing a second one — it calls THIS, with its own
 *   summed route, like this:
 *
 *     import { clampCutoff, clampCutoffModulation } from './filter.js';
 *
 *     const hz = clampCutoff(cutoffWithModulation(panelHz, summedCents), audioContext.sampleRate);
 *
 *   `clampCutoffModulation(cents)` is the companion for the ROUTE itself: a
 *   matrix cell is -100..100 % of ±CUTOFF_MOD_CENTS, and this bounds it before
 *   it is ever applied.
 *
 * THE DRIVE STAGE
 *   A `WaveShaperNode` with a fixed tanh curve, a pre-gain into it and a make-up
 *   gain after it:
 *
 *     curve(u) = tanh(K·u) / tanh(K)     over u in [-1, 1], K = SOFT_CLIP_K
 *     pre      = 1 + drive · DRIVE_MAX_PRE_GAIN
 *     post     = the curve's gain AT DRIVE_REFERENCE_INPUT, divided out
 *
 *   So the stage's transfer function is `T(u) = u0 · tanh(K·pre·u) / tanh(K·pre·u0)`
 *   with `u0 = DRIVE_REFERENCE_INPUT`, which means `T(u0) = u0` at EVERY drive
 *   setting: a signal at the reference level keeps its level while its harmonics
 *   change. That is the difference between a drive control and a volume control,
 *   and it is why this is a WaveShaper and not a gain.
 *
 *   A `Float32Array` curve over [-1, 1] is the Web Audio idiom: a WaveShaperNode
 *   clamps inputs outside the curve's domain to its end points, so the pre-gain
 *   decides how much of the signal is bent and how much is flattened. The curve
 *   is built once and shared by every shaper in the instrument; the node copies
 *   it, so sharing is free.
 *
 * KEY TRACKING
 *   Key tracking is a RATIO, not an offset: at 100% the cutoff moves with the
 *   note by the same interval as the pitch, referenced to MIDI 60 (middle C).
 *   Note 72 doubles the cutoff, note 48 halves it, and 0% leaves it alone. An
 *   offset would make a 20 Hz cutoff unplayable on the top of the keyboard and a
 *   20 kHz cutoff useless at the bottom.
 *
 * API
 *   clampCutoff(hz, sampleRate, options?)      THE clamp (see above)
 *   cutoffWithKeyTrack(baseHz, note, percent)
 *   cutoffWithModulation(baseHz, cents)
 *   clampResonance(q) / clampDrive(d) / clampKeyTrack(percent)
 *   softClipCurve() / softClipSlope() / drivePreGain(d) / drivePostGain(d)
 *   driveTransfer(drive, input) / softClipTransfer(input)  the stage's own curve
 *   filterModeName(mode) / isTwoSectionMode(mode) / sectionCountForMode(mode)
 *   sectionQ(mode, q)                          the per-section Q, LP24 included
 *   createFilterStage({ context, index })       one stage's subgraph
 *   registerFilterVoice(voice) / filterVoiceTargets()
 *   bindFilterModulation()                     the store fan-out
 *   FILTER_KEYS FILTER_MODES
 */

import { trackNode } from './nodes.js';
import { rampTo, setNow } from './automation.js';
import { store as appStore } from '../ui/params.js';

/* --------------------------------------------------------------- constants --- */

/** The five modes per stage, in the order the panel offers them. */
export const FILTER_MODES = ['lp24', 'lp12', 'hp12', 'bp12', 'notch12'];

/** The mode -> `BiquadFilterNode.type` map. LP24 is a lowpass cascade, so its
 *  section type is 'lowpass' like LP12's; the difference is the second section. */
const MODE_TO_TYPE = {
  lp24: 'lowpass',
  lp12: 'lowpass',
  hp12: 'highpass',
  bp12: 'bandpass',
  notch12: 'notch',
};

/** Cutoff limits, matching the `filter{n}.cutoff` schema entries exactly. */
export const CUTOFF_MIN_HZ = 20;
export const CUTOFF_MAX_HZ = 20000;

/** How close to Nyquist a cutoff may get. A biquad's coefficients go unstable
 *  as the cutoff approaches the sample rate, so the ceiling is a FRACTION of it
 *  even when 20 kHz would nominally fit. */
export const NYQUIST_FRACTION = 0.45;

/** Resonance limits, matching `filter{n}.resonance`. Q 30 is a hard ceiling. */
export const RESONANCE_MIN = 0.5;
export const RESONANCE_MAX = 30;

/** The second section of an LP24 is a plain Butterworth pole, never resonant. */
export const BUTTERWORTH_Q = Math.SQRT1_2;

/** The note key tracking is referenced to: middle C. */
export const KEY_TRACK_REFERENCE_NOTE = 60;

/** How far one modulation cell can move a cutoff, in cents (±4 octaves), the
 *  same span the matrix pitch destination uses. */
export const CUTOFF_MOD_CENTS = 4 * 1200;

/** The pre-gain a fully-open drive control puts in front of the shaper. */
export const DRIVE_MAX_PRE_GAIN = 8;

/** The tanh knee constant of the soft-clip curve. */
export const SOFT_CLIP_K = 0.5;



/**
 * The input level the drive stage's level compensation is normalised AT.
 *
 * This is the whole difference between a drive control and a volume control. The
 * shaper's small-signal gain is fixed, so as the pre-gain rises the stage gets
 * quieter — normalising at zero would mean "drive down = quieter", which is a
 * volume control with extra steps. Normalising at a reference input instead
 * means a signal SITTING AT that level keeps its level at every drive setting,
 * and what changes is its shape: the harmonics move, the level does not.
 *
 * 0.5 is half scale, which is where a voice's mixer output usually sits with one
 * or two cores open.
 */
export const DRIVE_REFERENCE_INPUT = 0.5;

/** How many points the shared curve is sampled at. Odd, so u = 0 is a sample. */
export const SOFT_CLIP_POINTS = 2049;

/** The six store keys per filter stage. */
export const FILTER_KEYS = ['type', 'cutoff', 'resonance', 'drive', 'keyTrack', 'bypass'];

/* ------------------------------------------------------------------ clamps --- */

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * THE CUTOFF CLAMP. Bounds a cutoff to 20 Hz..20 kHz and to a fraction of the
 * actual sample rate, and turns anything that is not a number into 20 Hz.
 *
 *   clampCutoff(hz, sampleRate)
 *
 * Task 7 calls this for every route that can move a cutoff — the matrix cells,
 * an LFO, anything — instead of clamping in its own code. Passing `sampleRate`
 * is optional but always correct: without it the ceiling is the absolute 20 kHz.
 */
export function clampCutoff(hz, sampleRate, options = {}) {
  const min = Number.isFinite(options.min) ? options.min : CUTOFF_MIN_HZ;
  const max = Number.isFinite(options.max) ? options.max : CUTOFF_MAX_HZ;
  const fraction = Number.isFinite(options.nyquistFraction) ? options.nyquistFraction : NYQUIST_FRACTION;
  const rate = num(sampleRate, 0);
  // A context slower than ~22 kHz would put the fraction below the floor; the
  // floor wins, because 20 Hz is already inaudible but a negative ceiling is not
  // a frequency.
  const ceiling = rate > 0 ? Math.min(max, rate * fraction) : max;
  // A non-number is a program error and lands on the floor, because 20 Hz is
  // quiet rather than silent. An infinity is a runaway sum and lands on the
  // ceiling, because that is what clamping an infinite value means.
  const raw = Number(hz);
  if (Number.isNaN(raw) || raw === undefined || raw === null) return min;
  const value = raw === Infinity ? ceiling : raw === -Infinity ? min : raw;
  if (value < min) return min;
  if (value > ceiling) return ceiling;
  return value;
}

/** Resonance, 0.5..30. The plan's hard ceiling, and not a default. */
export function clampResonance(value) {
  const q = num(value, RESONANCE_MIN);
  if (q < RESONANCE_MIN) return RESONANCE_MIN;
  if (q > RESONANCE_MAX) return RESONANCE_MAX;
  return q;
}

/** Drive, 0..1, matching `filter{n}.drive`. */
export function clampDrive(value) {
  const d = num(value, 0);
  if (d < 0) return 0;
  if (d > 1) return 1;
  return d;
}

/** Key tracking, 0..100 %, matching `filter{n}.keyTrack`. */
export function clampKeyTrack(value) {
  const k = num(value, 0);
  if (k < 0) return 0;
  if (k > 100) return 100;
  return k;
}

/** A modulation route for a cutoff, in cents, clipped to ±CUTOFF_MOD_CENTS. */
export function clampCutoffModulation(cents) {
  const c = num(cents, 0);
  if (c < -CUTOFF_MOD_CENTS) return -CUTOFF_MOD_CENTS;
  if (c > CUTOFF_MOD_CENTS) return CUTOFF_MOD_CENTS;
  return c;
}

/**
 * The cutoff a note plays at: the panel value moved by the interval between the
 * note and middle C, scaled by the tracking percentage. At 0% this is the panel
 * value exactly, which is what makes "tracking off" measurable.
 */
export function cutoffWithKeyTrack(baseHz, note, keyTrackPercent) {
  const base = num(baseHz, CUTOFF_MIN_HZ);
  const track = clampKeyTrack(keyTrackPercent) / 100;
  if (track <= 0) return base;
  const midi = num(note, KEY_TRACK_REFERENCE_NOTE);
  const semitones = (midi - KEY_TRACK_REFERENCE_NOTE) * track;
  return base * 2 ** (semitones / 12);
}

/** A cutoff with a modulation route in cents applied, before the clamp. */
export function cutoffWithModulation(baseHz, cents) {
  return num(baseHz, CUTOFF_MIN_HZ) * 2 ** (clampCutoffModulation(cents) / 1200);
}

/* ------------------------------------------------------------------- modes --- */

/** The `BiquadFilterNode.type` for a mode. An unknown mode is a lowpass. */
export function filterModeName(mode) {
  return MODE_TO_TYPE[mode] ?? MODE_TO_TYPE.lp24;
}

/** LP24 is the only two-section mode. */
export function isTwoSectionMode(mode) {
  return mode === 'lp24';
}

/** How many biquads a mode puts in the path. */
export function sectionCountForMode(mode) {
  return isTwoSectionMode(mode) ? 2 : 1;
}

/**
 * The Q one section should carry. Only the FIRST section is ever resonant; the
 * second pole of an LP24 is Butterworth, so the resonance peak is a
 * single-section peak and Q 30 is as loud as the plan intended. Leaving it flat
 * in the single-section modes costs nothing (it is not in the path) and means
 * switching to LP24 never starts from a stale resonant Q.
 */
export function sectionQ(mode, q, section = 0) {
  return section === 0 ? clampResonance(q) : BUTTERWORTH_Q;
}

/* ------------------------------------------------------------------- drive --- */

/** The curve's small-signal slope: the gain the shaper alone has near zero. */
export function softClipSlope() {
  return SOFT_CLIP_K / Math.tanh(SOFT_CLIP_K);
}

/**
 * The curve's domain, in shaper-input units. It is ALWAYS [-1, 1]: the
 * WaveShaperNode algorithm clamps its input to that range and uses it to INDEX
 * the curve, so the array you hand it is read across its whole length for inputs
 * between -1 and 1, whatever numbers you computed the samples from. Past the
 * domain the curve's end points hold, which is the flattening a drive control is
 * made of.
 */
export const SOFT_CLIP_DOMAIN = 1;

/** What one shaper does to a sample, on its own: the curve sampled at `input`. */
export function softClipTransfer(input) {
  const x = Math.max(-SOFT_CLIP_DOMAIN, Math.min(SOFT_CLIP_DOMAIN, input));
  return Math.tanh(SOFT_CLIP_K * x) / Math.tanh(SOFT_CLIP_K);
}

let sharedCurve = null;

/**
 * The soft-clip curve: tanh-shaped, over the domain [-1, 1], mapped so the ends
 * of the domain are exactly -1 and +1. Built once and shared; a WaveShaperNode
 * copies the array, so every shaper in the instrument gets its own.
 */
export function softClipCurve(points = SOFT_CLIP_POINTS) {
  if (points === SOFT_CLIP_POINTS && sharedCurve) return sharedCurve;
  const n = Math.max(3, Math.round(points) | 1); // odd: u = 0 is a sample
  const norm = Math.tanh(SOFT_CLIP_K * SOFT_CLIP_DOMAIN);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const u = -SOFT_CLIP_DOMAIN + (2 * SOFT_CLIP_DOMAIN * i) / (n - 1);
    curve[i] = Math.tanh(SOFT_CLIP_K * u) / norm;
  }
  if (n === SOFT_CLIP_POINTS) sharedCurve = curve;
  return curve;
}

/** The pre-gain a drive amount puts in front of the shaper. */
export function drivePreGain(drive) {
  return 1 + clampDrive(drive) * DRIVE_MAX_PRE_GAIN;
}

/**
 * The make-up gain after the shaper: the stage's own gain AT THE REFERENCE INPUT,
 * divided out. It is measured on the REAL transfer — pre-gain, curve and the
 * node's own [-1, 1] domain clamp — so
 *
 *   driveTransfer(drive, u0) === u0     for every drive setting
 *
 * A signal sitting at the reference level therefore keeps its PEAK at every drive
 * setting and only its harmonics change. That is what makes this a drive control
 * rather than a volume control: the knob cannot change how loud the voice is, only
 * how thick it is. (Without any make-up gain the same stage loses 11 dB across the
 * drive range on a half-scale sine.)
 */
export function drivePostGain(drive) {
  const pre = drivePreGain(drive);
  return DRIVE_REFERENCE_INPUT / softClipTransfer(pre * DRIVE_REFERENCE_INPUT);
}

/**
 * The stage's transfer function at an input level — pre-gain, curve INCLUDING the
 * node's own domain clamp, and make-up gain. This is what the sound actually
 * does, and tests/filter.test.mjs pushes a sine through it and takes a DFT.
 */
export function driveTransfer(drive, input = DRIVE_REFERENCE_INPUT) {
  const pre = drivePreGain(drive);
  return softClipTransfer(pre * input) * drivePostGain(drive);
}

/* ------------------------------------------------------------- the stage --- */

/** Disconnect one destination, and treat "not connected" as a no-op. */
const dropConnection = (node, destination) => {
  try {
    node.disconnect(destination);
  } catch {
    /* already disconnected, or a destination this node never had */
  }
};

/** How many nodes one stage is built from: input, pre-gain, shaper, make-up gain,
 *  two biquads, output. Counted in tests as a leak guard. */
export const NODES_PER_STAGE = 6;

/**
 * One filter stage: its drive stage and its two biquad sections.
 *
 * The stage owns its OWN subgraph and nothing else. It does not know what feeds
 * it or what comes after, which is what lets voice.js wire the pair in series
 * and rewire AROUND either of them for bypass without the stage knowing. It also
 * does not decide what the cutoff is: key tracking, modulation and the clamp all
 * live in the voice, and arrive here as a resolved frequency in hertz.
 */
export function createFilterStage({ context, index = 0 } = {}) {
  if (!context) throw new Error('createFilterStage needs a context');
  const label = `filter${index + 1}`;

  const input = trackNode(context.createGain(), `${label}-in`);
  const driveIn = trackNode(context.createGain(), `${label}-drive-in`);
  const shaper = trackNode(context.createWaveShaper(), `${label}-shaper`);
  const driveOut = trackNode(context.createGain(), `${label}-drive-out`);
  const sections = [
    trackNode(context.createBiquadFilter(), `${label}-section-a`),
    trackNode(context.createBiquadFilter(), `${label}-section-b`),
  ];
  const output = trackNode(context.createGain(), `${label}-out`);

  // One shared curve for the whole instrument; the node copies it.
  shaper.curve = softClipCurve();
  // 2x oversampling is the cheap half of a clipper's aliasing problem: the curve
  // is smooth but the signal reaching it is not, and it is being bent hard.
  shaper.oversample = '2x';
  driveIn.gain.value = 1;
  driveOut.gain.value = drivePostGain(0);
  output.gain.value = 1;

  input.connect(driveIn);
  driveIn.connect(shaper);
  shaper.connect(driveOut);
  // The drive stage FEEDS the first section. This edge is the difference between
  // a filter and a dead node, and it is the one no amount of reading `type` and
  // `frequency` back would reveal — so tests/filter-stage.test.mjs walks the
  // whole chain from input to output.
  driveOut.connect(sections[0]);

  const stage = {
    index,
    label,
    input,
    output,
    driveIn,
    driveOut,
    shaper,
    sections,
    mode: 'lp24',
    /** Set by the voice, which owns the chain around this stage. */
    bypass: false,
    /** The last values written, so a mode change can re-apply them. */
    written: { frequency: 350, q: 1, drive: 0 },
    secondInPath: null,
  };

  /**
   * Put the second section in the path, or take it out. A single-section mode
   * must not merely mute the second pole: leaving both poles fed by one signal
   * would be a 24 dB filter wearing a 12 dB name.
   */
  function routeSections() {
    const wantTwo = isTwoSectionMode(stage.mode);
    if (stage.secondInPath === wantTwo) return;
    if (wantTwo) {
      // A single-section mode left section A wired straight to the output; that
      // edge has to go, or the two-section mode is a 12 dB path in parallel with
      // a 24 dB one rather than a cascade.
      dropConnection(sections[0], output);
      sections[0].connect(sections[1]);
      sections[1].connect(output);
    } else {
      dropConnection(sections[1], output);
      dropConnection(sections[0], sections[1]);
      sections[0].connect(output);
    }
    stage.secondInPath = wantTwo;
  }

  /** Both sections carry the same frequency; only section A carries the Q. */
  function writeFrequency(hz, { at, ramp = true, seconds } = {}) {
    for (const section of sections) {
      if (ramp) rampTo(section.frequency, hz, context, { at, seconds });
      else setNow(section.frequency, hz, context, { at });
    }
    stage.written.frequency = hz;
  }

  function writeResonance(q, { at, ramp = true, seconds } = {}) {
    sections.forEach((section, i) => {
      const value = sectionQ(stage.mode, q, i);
      if (ramp) rampTo(section.Q, value, context, { at, seconds });
      else setNow(section.Q, value, context, { at });
    });
    stage.written.q = clampResonance(q);
  }

  function writeDrive(drive, { at, ramp = true, seconds } = {}) {
    if (ramp) {
      rampTo(driveIn.gain, drivePreGain(drive), context, { at, seconds });
      rampTo(driveOut.gain, drivePostGain(drive), context, { at, seconds });
    } else {
      setNow(driveIn.gain, drivePreGain(drive), context, { at });
      setNow(driveOut.gain, drivePostGain(drive), context, { at });
    }
    stage.written.drive = clampDrive(drive);
  }

  /**
   * A mode is a SWITCH, not a gesture: the type is assigned, and the frequency,
   * Q and drive are re-written from what they already were rather than ramped —
   * a mode change should be instant, the way a switch is.
   */
  stage.setMode = (mode, options = {}) => {
    const next = FILTER_MODES.includes(mode) ? mode : 'lp24';
    const changed = next !== stage.mode;
    stage.mode = next;
    const type = filterModeName(next);
    for (const section of sections) section.type = type;
    routeSections();
    if (changed || options.force) {
      writeFrequency(stage.written.frequency, { at: options.at, ramp: false });
      writeResonance(stage.written.q, { at: options.at, ramp: false });
    }
    return stage.mode;
  };

  stage.setFrequency = writeFrequency;
  stage.setResonance = writeResonance;
  stage.setDrive = writeDrive;

  stage.state = () => ({
    index: stage.index,
    mode: stage.mode,
    type: sections[0].type,
    sections: stage.secondInPath ? 2 : 1,
    bypass: Boolean(stage.bypass),
    frequencyHz: stage.written.frequency,
    q: sections[0].Q.value,
    secondQ: sections[1].Q.value,
    drive: stage.written.drive,
    preGain: driveIn.gain.value,
    postGain: driveOut.gain.value,
    shaper: stage.shaper.kind === 'waveShaper',
    curvePoints: stage.shaper.curve ? stage.shaper.curve.length : 0,
  });

  // Built in LP24, which is the init patch for filter 1.
  stage.setMode('lp24', { force: true });

  return stage;
}

/* -------------------------------------------------------- the store fan-out --- */

/** The voices the filter keys are fanned out to. Bounded by the pool. */
const targets = new Set();

export function registerFilterVoice(voice) {
  targets.add(voice);
  return () => targets.delete(voice);
}

export function filterVoiceTargets() {
  return [...targets];
}

/**
 * One store key -> every live voice, through `applyFilter`, which returns false
 * for a key this task does not own. Same shape as osc-mod.js's binding, and for
 * the same reason: engine.js does not fan these keys out and is not edited to.
 */
export function bindFilterModulation({ store = appStore, list = filterVoiceTargets } = {}) {
  const unsubscribes = [];
  for (let n = 1; n <= 2; n += 1) {
    for (const name of FILTER_KEYS) {
      const key = `filter${n}.${name}`;
      unsubscribes.push(
        store.subscribe(key, (_key, value) => {
          for (const voice of list()) {
            if (!voice.filters) continue;
            voice.applyFilter(n - 1, key, value, { at: voice.context.currentTime });
          }
        }),
      );
    }
  }
  return () => {
    for (const off of unsubscribes) off();
  };
}

// The app-wide binding, established once at import — importing voice.js (and so
// the engine) is enough, which is why nothing in ui/main.js has to change.
bindFilterModulation();