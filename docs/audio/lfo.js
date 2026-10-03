/**
 * lfo.js — the instrument's three low frequency oscillators, and the six source
 * values a modulation matrix sums from.
 *
 * WHAT EACH LFO IS
 *
 *   oscillator ─┐
 *               ├─> shape sum ─> fade ─> read tap ─> sink ─> destination
 *   s&h source ─┤      ^                            (gain 0)
 *   dc (-1)    ──┘
 *
 *   oscillator   an OscillatorNode that is created once and NEVER restarted: the
 *                browser cannot restart one, so a shape change is a `type` or a
 *                PeriodicWave on the running node rather than a new one. Five of
 *                the six shapes are that node.
 *
 *   They are BUILT at import and STARTED when the context is first allowed to
 *   make sound (see startSources below), so loading the page produces no autoplay
 *   warning and no oscillator sits in the render graph of a powered-off
 *   instrument.
 *   s&h source   an AudioBufferSourceNode over a staircase buffer, looping. The
 *                sixth shape. Explicitly not an AudioWorklet: the plan asks for a
 *                buffer source stepping at the LFO rate, and that is what this is.
 *   dc (-1)      a ConstantSourceNode at -1, gated to zero, whose only job is to
 *                de-bias the native square wave — `type: 'square'` emits 0..1 and
 *                a matrix source has to be able to subtract, so the square is
 *                carried as 2x - 1 and every other shape is carried untouched.
 *   fade         the FADE-IN. A gain, and the only thing `lfo{n}.on` moves.
 *   read tap     an AnalyserNode with the smallest window the API allows, because
 *                the matrix samples each LFO once per scheduling block and a
 *                2048-sample window would be 43 ms of smeared history.
 *   sink         a gain of exactly zero, into the destination. An AnalyserNode that
 *                nothing pulls is not rendered and reads zero forever, so the tap
 *                has to be reachable; at zero gain it is reachable and silent.
 *
 * THE FADE-IN IS A CURVE, NOT A RAMP
 *   `setValueCurveAtTime` from the current level to the target, scheduled at "now".
 *   A ramp would do the same job, but the curve is what the plan names and it has
 *   the one property a ramp does not: it cannot be left half-finished by a second
 *   automation event, because the whole level history of the gain is one object.
 *   Enabling an LFO under a held chord therefore moves the modulation from nothing
 *   to full depth over `lfo{n}.fadeIn` seconds without a discontinuity.
 *
 * THE RATE
 *   Free-running it is `lfo{n}.rate`, clamped to 0.02..30 Hz. Tempo-synced it is
 *   the division's length in BEATS over the beat period — `beatsFor('1/8T')` is a
 *   third of a beat, so 1/8T at 120 BPM is two thirds of a hertz — and it follows
 *   `global.tempo` because the tempo arrives as a function this bank calls. It
 *   never arrives as an event of its own: there is no timer in this file, and
 *   tests/clock.test.mjs asserts that an interval appears in exactly one file of
 *   the instrument, and that this is not it.
 *
 * THE VALUE, AND WHY IT IS READ RATHER THAN COMPUTED
 *   The matrix sums once per scheduling block into one vector and applies that
 *   vector at a small number of defined points, so it needs a NUMBER per LFO per
 *   block, not a connected audio signal: sixty-four audio-rate gains into sixteen
 *   voices is the pile of independent writers the matrix exists to prevent. So the
 *   value is read from the tap. That also means the fade-in is part of the number —
 *   the tap is downstream of the fade, so a fade is visible as the modulation
 *   itself ramping, which is what makes enabling mid-note measurable.
 *
 * API
 *   LFO_COUNT, LFO_SHAPES, SYNC_DIVISIONS, LFO_RATE_MIN/MAX, LFO_FADE_MAX
 *   SAMPLE_HOLD_STEPS, SAMPLE_HOLD_SAMPLES, TAP_FFT_SIZE
 *   clampLfoRate(hz)                     0.02..30, and never NaN
 *   syncRateHz(division, bpm)            beats / beatPeriod
 *   lfoRateHz({ sync, division, rate, bpm })
 *   shapePlan(shape)                     how a shape is realised, or null
 *   sampleHoldTable({ sampleRate, steps, samples, random })   a staircase
 *   sampleHoldPlaybackRate(rateHz, bufferSeconds)
 *   fadeCurvePoints(seconds, points, from, to)
 *   createLfoBank({ context, read, subscribe, bpm, random })
 *     bank.lfos[i]  { oscillator, fade, tap, state(), value(), refresh() }
 *     bank.sourceValues()  { lfo1, lfo2, lfo3 } — the matrix's global sources
 *     bank.refresh()       re-read every key and re-apply
 */

import { beatPeriod } from './clock.js';
import { SYNC_BEATS } from './chain.js';
import { sawCoefficients } from './waveforms.js';
import { setNow } from './automation.js';
import { createBufferSource, createConstantSource, createGain, createOscillator } from './nodes.js';
import { LFO_WAVES, store as appStore, SYNC_RATES } from '../ui/params.js';

/* ------------------------------------------------------------- the inventory --- */

/** Three LFOs: the plan's number, and the panel's three panels. */
export const LFO_COUNT = 3;

/** The six shapes, in the order the legend paints them. */
export const LFO_SHAPES = Object.freeze([...LFO_WAVES]);

/** The six sync divisions, in the order the legend paints them. */
export const SYNC_DIVISIONS = Object.freeze([...SYNC_RATES]);

/** The six `lfo{n}.*` keys this module reads. Nothing else. */
export const LFO_KEYS = Object.freeze(['wave', 'rate', 'sync', 'rateSync', 'fadeIn', 'on']);

/** Free-running rate range. The store declares the same bounds; this is the guard. */
export const LFO_RATE_MIN = 0.02;
export const LFO_RATE_MAX = 30;

/** The longest fade-in the store allows, seconds. */
export const LFO_FADE_MAX = 5;

/**
 * Sample and hold: 32 steps, each 512 identical samples, so the buffer is 16384
 * samples (341 ms at 48 kHz) whatever the rate.
 *
 * The plateau WIDTH is what makes the staircase survive resampling: a linear
 * resampler turns the one sample straddling a step edge into a glide of 1/WIDTH of
 * a step, so 512 gives a 0.2% glide — inaudible — at every rate, including the
 * extreme upsampling the slowest LFO needs. The plateau width is therefore the
 * number that must be large; the step COUNT only decides how long the sequence of
 * random values takes to repeat (32 LFO periods: 27 minutes at 0.02 Hz, a second at
 * 30 Hz).
 */
export const SAMPLE_HOLD_STEPS = 32;
export const SAMPLE_HOLD_SAMPLES = 512;

/**
 * The read tap's window, in samples. 32 is a legal FFT size and the smallest that
 * is useful: at 48 kHz it is 0.67 ms, which is 2% of a cycle at 30 Hz and
 * immeasurable at 0.02 Hz. Anything larger would average several cycles of the
 * LFO into one number instead of sampling it.
 */
export const TAP_FFT_SIZE = 32;

/** Points in the fade curve. Short enough to be free, long enough to be smooth. */
export const FADE_CURVE_POINTS = 64;

/** How fast a rate change glides, seconds. A rate step is audible as a pitch jump. */
const RATE_GLIDE_SECONDS = 0.02;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/* ------------------------------------------------------------------ the rate --- */

/**
 * Free-running rate, clamped. A non-number is the floor rather than a wild value:
 * 0.02 Hz is slow and harmless, a NaN frequency is neither.
 */
export function clampLfoRate(hz) {
  const value = Number(hz);
  if (Number.isNaN(value) || value === undefined || value === null) return LFO_RATE_MIN;
  if (value === Number.POSITIVE_INFINITY) return LFO_RATE_MAX;
  if (value === Number.NEGATIVE_INFINITY) return LFO_RATE_MIN;
  return clamp(value, LFO_RATE_MIN, LFO_RATE_MAX);
}

/**
 * A tempo-synced rate, in hertz: how many beats the division is worth, over the
 * seconds a beat is worth. Proportional in tempo by construction, so doubling the
 * tempo doubles the rate rather than shifting it.
 */
export function syncRateHz(division, bpm) {
  const beats = SYNC_BEATS[division] ?? SYNC_BEATS[DEFAULT_DIVISION];
  const value = beats / beatPeriod(bpm);
  return Number.isFinite(value) && value > 0 ? value : LFO_RATE_MIN;
}

/** The division a synced LFO uses when its key is missing or unknown. */
const DEFAULT_DIVISION = '1/16';

/** The rate a synced LFO uses when its key is missing or unknown. */
const DEFAULT_RATE = 5;

/**
 * The rate an LFO is actually running at. `sync` chooses between the panel's rate
 * and the transport's beat, and nothing else — a synced LFO does not care what the
 * rate knob says, and a free-running one does not care what the tempo is.
 */
export function lfoRateHz({ sync = false, division, rate, bpm } = {}) {
  if (sync) return syncRateHz(SYNC_DIVISIONS.includes(division) ? division : DEFAULT_DIVISION, bpm);
  return clampLfoRate(Number.isFinite(Number(rate)) ? Number(rate) : DEFAULT_RATE);
}

/* ----------------------------------------------------------------- the shapes --- */

/**
 * How one shape is realised. `null` for a name this module does not know, so an
 * unknown shape is refused rather than approximated.
 *
 *   oscillator  a native OscillatorNode type
 *   periodic    the same node with a Fourier table
 *   buffer      the looping stepped source
 *
 * `bipolar` says the realisation needs the -1 offset stage, which is true of the
 * native square and nothing else.
 */
const SHAPE_PLANS = Object.freeze({
  sine: Object.freeze({ kind: 'oscillator', type: 'sine', bipolar: false }),
  triangle: Object.freeze({ kind: 'oscillator', type: 'triangle', bipolar: false }),
  square: Object.freeze({ kind: 'oscillator', type: 'square', bipolar: true }),
  sawUp: Object.freeze({ kind: 'periodic', type: 'sawtooth', sign: -1, bipolar: false }),
  sawDown: Object.freeze({ kind: 'periodic', type: 'sawtooth', sign: 1, bipolar: false }),
  sampleHold: Object.freeze({ kind: 'buffer', type: 'sine', bipolar: false }),
});

export function shapePlan(shape) {
  const plan = SHAPE_PLANS[shape];
  if (!plan) return null;
  return {
    ...plan,
    /** The Fourier table for a periodic shape. Saw up is saw down negated. */
    coefficients: () => sawCoefficients({ sign: plan.sign ?? 1 }),
  };
}

/* -------------------------------------------------------------- sample & hold --- */

/**
 * The staircase a sample-and-hold LFO plays: `steps` random values, each repeated
 * `samples` times, so the buffer is piecewise constant by construction rather than
 * by convention.
 *
 * The rate is expressed as a playback rate rather than by rebuilding the table at
 * the LFO rate, because a table one step per LFO period at 0.02 Hz would be 2.2
 * million samples per step and would have to be rebuilt on every rate drag.
 *
 * Values are spread across the whole bipolar range, because a matrix source that
 * never goes negative cannot subtract.
 */
export function sampleHoldTable({ sampleRate = 48000, steps = SAMPLE_HOLD_STEPS, samples = SAMPLE_HOLD_SAMPLES, random = Math.random } = {}) {
  const count = Math.max(1, Math.round(steps));
  const width = Math.max(1, Math.round(samples));
  const table = new Float32Array(count * width);
  for (let step = 0; step < count; step += 1) {
    const value = random() * 2 - 1;
    for (let i = 0; i < width; i += 1) table[step * width + i] = value;
  }
  return table;
}

/**
 * The playback rate that makes the stepped source step EXACTLY ONCE PER LFO
 * PERIOD — which is what "stepping at the LFO rate" means, and the whole point of
 * the shape.
 *
 *   one buffer loop lasts  bufferSeconds / playbackRate  seconds
 *   the buffer holds       SAMPLE_HOLD_STEPS            steps
 *   so a step lasts        steps * playbackRate / bufferSeconds
 *
 * Solving for the step rate to equal the rate gives `bufferSeconds * rateHz /
 * steps`: one loop then spans `steps` LFO periods and each step is exactly one
 * period. Getting this wrong by the factor of `steps` is not subtle — it turns the
 * shape into a random staircase hundreds of times too fast, which no longer holds.
 */
export function sampleHoldPlaybackRate(rateHz, bufferSeconds, steps = SAMPLE_HOLD_STEPS) {
  const seconds = Math.abs(finite(bufferSeconds));
  const hz = Math.abs(finite(rateHz));
  const count = Math.max(1, Math.round(finite(steps, SAMPLE_HOLD_STEPS)));
  return seconds > 0 && hz > 0 ? (seconds * hz) / count : 0;
}

/* ----------------------------------------------------------------- the fade --- */

/**
 * The fade-in curve: `from` to `to` over `seconds`, as a value curve. A zero-length
 * fade is the whole level immediately rather than a division by zero, because
 * "no fade" is a legitimate setting and it must not be the one that throws.
 */
export function fadeCurvePoints(seconds, points = FADE_CURVE_POINTS, from = 0, to = 1) {
  const count = Math.max(2, Math.round(points));
  const start = finite(from);
  const end = finite(to, 1);
  const curve = new Float32Array(count);
  if (!(seconds > 0)) {
    curve.fill(end);
    return curve;
  }
  for (let i = 0; i < count; i += 1) curve[i] = start + (end - start) * (i / (count - 1));
  return curve;
}

/* ---------------------------------------------------------------- the taps --- */

/**
 * The read tap. One AnalyserNode and one buffer, created once per LFO.
 *
 * `getFloatTimeDomainData` fills the buffer with the last `fftSize` samples, so the
 * LAST slot is the most recent one and is what a control-rate read wants; the rest
 * of the window is only there because the API requires it.
 */
function createTap(context) {
  const tap = context.createAnalyser();
  tap.fftSize = TAP_FFT_SIZE;
  tap.smoothingTimeConstant = 0;
  const buffer = new Float32Array(tap.fftSize);
  return {
    node: tap,
    read() {
      tap.getFloatTimeDomainData(buffer);
      const value = Number(buffer[buffer.length - 1]);
      return Number.isFinite(value) ? value : 0;
    },
  };
}

/* --------------------------------------------------------------- one LFO --- */

/**
 * One LFO. It owns its oscillator, its stepped source, its gates, its fade and its
 * tap; it reads nothing and writes nothing — `refresh()` is told what the store
 * says and applies it.
 */
function createLfo({ context, index, prefix, sink, sampleHoldBuffer }) {
  const label = (role) => `${prefix}.${role}`;

  const oscillator = createOscillator(context, label('oscillator'));
  const oscillatorGain = createGain(context, label('oscillatorGain'));
  const sourceGain = createGain(context, label('sourceGain'));
  const dc = createConstantSource(context, label('dc'));
  const dcGain = createGain(context, label('dcGain'));
  const shapeSum = createGain(context, label('shapeSum'));
  const fade = createGain(context, label('fade'));

  const source = createBufferSource(context, label('sampleHold'));
  source.loop = true;
  /* One buffer, shared by the three LFOs: same rate, same shape, same steps. */
  const bufferSeconds = sampleHoldBuffer.length / context.sampleRate;
  source.buffer = sampleHoldBuffer;

  /* Initial levels, before any key has been read: silent, and shaped as sine. */
  fade.gain.value = 0;
  sourceGain.gain.value = 0;
  dc.offset.value = -1;
  dcGain.gain.value = 0;
  oscillatorGain.gain.value = 1;

  oscillator.connect(oscillatorGain);
  oscillatorGain.connect(shapeSum);
  source.connect(sourceGain);
  sourceGain.connect(shapeSum);
  dc.connect(dcGain);
  dcGain.connect(shapeSum);
  shapeSum.connect(fade);
  /**
   * The three sources start when the context is ALLOWED to make sound, not when
   * they are built. Chrome logs an autoplay warning per source started on a
   * suspended context — nine of them on every page load — and there is nothing to
   * hear before a gesture anyway. `statechange` is an event, not a clock, so this
   * costs no timer and the oscillators do not exist in the render graph until the
   * instrument is powered on. Idempotent, so a context that is already running
   * starts them immediately.
   */
  let started = false;
  const startSources = () => {
    if (started) return false;
    started = true;
    dc.start(context.currentTime);
    source.start(context.currentTime);
    oscillator.start(context.currentTime);
    return true;
  };
  if (context.state !== 'suspended') startSources();
  else if (typeof context.addEventListener === 'function') {
    context.addEventListener('statechange', () => {
      if (context.state !== 'suspended') startSources();
    });
  }

  const tap = createTap(context);
  fade.connect(tap.node);
  tap.node.connect(sink);

  let shape = null;
  let rateHz = 0;
  let enabled = false;
  let fadeIn = 0;
  let synced = false;
  let division = DEFAULT_DIVISION;
  let tempoBpm = 120;
  /* The fade gain's own level, tracked rather than read back: the curve it is
     carrying is mid-flight most of the time, and what a new curve has to start
     from is where the last one was going, not what the browser is rendering. */
  let level = 0;

  /** Point the oscillator's `frequency` (or the source's `playbackRate`) at a rate. */
  function applyRate(next) {
    rateHz = next;
    const when = context.currentTime;
    const glide = RATE_GLIDE_SECONDS;
    oscillator.frequency.setTargetAtTime(next, when, glide);
    const playback = sampleHoldPlaybackRate(next, bufferSeconds);
    if (playback > 0) source.playbackRate.setTargetAtTime(playback, when, glide);
  }

  /**
   * The fade-in. Cancels whatever is in flight and lays one curve over it, so the
   * level history of this gain is always a single object and never two overlapping
   * automations — which is the thing that clicks. From the tracked level, so
   * "already off" is a no-op rather than a curve back to where it already is.
   */
  function applyEnabled(on, seconds) {
    const at = context.currentTime;
    const from = level;
    const to = on ? 1 : 0;
    if (from === to) return to;
    level = to;
    fade.gain.cancelScheduledValues(at);
    if (seconds > 0) fade.gain.setValueCurveAtTime(fadeCurvePoints(seconds, FADE_CURVE_POINTS, from, to), at, seconds);
    else setNow(fade.gain, to, context, { at });
    return to;
  }

  /**
   * The shape. A gate change is a program event rather than a gesture, so it is
   * written immediately: ramping a gate would cross-fade two shapes and smear both.
   */
  function applyShape(next) {
    if (!shapePlan(next)) return shape;
    const plan = shapePlan(next);
    const at = context.currentTime;
    shape = next;
    if (plan.kind === 'buffer') {
      setNow(oscillatorGain.gain, 0, context, { at });
      setNow(sourceGain.gain, 1, context, { at });
      setNow(dcGain.gain, 0, context, { at });
      return shape;
    }
    setNow(sourceGain.gain, 0, context, { at });
    setNow(oscillatorGain.gain, plan.bipolar ? 2 : 1, context, { at });
    setNow(dcGain.gain, plan.bipolar ? 1 : 0, context, { at });
    oscillator.type = plan.type;
    if (plan.kind === 'periodic') {
      const { real, imag } = plan.coefficients();
      oscillator.setPeriodicWave(context.createPeriodicWave(real, imag));
    }
    return shape;
  }

  /** Where the current rate came from, for a read-out and for a check. */
  function rateSource() {
    if (!synced) return `free:${rateHz}Hz`;
    return `sync:${division}@${tempoBpm}BPM`;
  }

  /** Read the six keys and apply all of them. Cheap; safe to call on any event. */
  function refresh(read, bpm) {
    applyShape(read(`${prefix}.wave`) ?? LFO_SHAPES[0]);
    tempoBpm = Number.isFinite(Number(bpm)) ? Number(bpm) : 120;
    synced = Boolean(read(`${prefix}.sync`));
    division = SYNC_DIVISIONS.includes(read(`${prefix}.rateSync`)) ? read(`${prefix}.rateSync`) : DEFAULT_DIVISION;
    applyRate(lfoRateHz({ sync: synced, division, rate: read(`${prefix}.rate`), bpm: tempoBpm }));
    const seconds = clamp(finite(read(`${prefix}.fadeIn`)), 0, LFO_FADE_MAX);
    const on = Boolean(read(`${prefix}.on`));
    if (on !== enabled || seconds !== fadeIn) {
      enabled = on;
      fadeIn = seconds;
      applyEnabled(on, seconds);
    }
    return state();
  }

  function state() {
    return {
      index,
      prefix,
      shape,
      rateHz,
      on: enabled,
      fadeIn,
      fade: fade.gain.value,
      /** Where the rate came from, in one string: `free:5Hz` or `sync:1/8@120BPM`. */
      source: rateSource(),
      oscillatorType: oscillator.type,
      periodic: oscillator.periodicWave ? true : false,
      stepping: shape === 'sampleHold',
      /** False until the context is allowed to make sound; see startSources. */
      started,
      bufferSeconds,
      shapes: LFO_SHAPES,
      divisions: SYNC_DIVISIONS,
      keys: LFO_KEYS,
      tapWindow: TAP_FFT_SIZE,
    };
  }

  return {
    index,
    prefix,
    oscillator,
    oscillatorGain,
    sourceGain,
    dcGain,
    fade,
    source,
    tap: tap.node,
    value: () => tap.read(),
    refresh,
    state,
    read: tap.read,
  };
}

/* ---------------------------------------------------------------- the bank --- */

/**
 * The three LFOs, bound to the store.
 *
 * `bpm` is a function, not a value: the tempo is the transport's, and the transport
 * is the clock's, and this module does not get a clock of its own. The wiring in
 * modulation.js hands it `clock.tempo` and calls `refresh()` from the clock's tempo
 * subscription — an event, never a poll.
 *
 * Both node-injection seams (`read`, `subscribe`) exist so tests can drive the
 * bank against an isolated store and a fake context; the app passes the real ones.
 */
export function createLfoBank({
  context,
  read = appStore.get,
  subscribe = appStore.subscribe,
  bpm = () => 120,
  random = Math.random,
} = {}) {
  if (!context) throw new Error('lfo: createLfoBank needs a context to build the oscillators on');

  /**
   * The zero-gain sink the taps end in. Shared by the three of them, because it has
   * exactly one purpose and one of them per LFO would be three ways to make the
   * same mistake.
   */
  const sink = createGain(context, 'lfo.tapSink');
  sink.gain.value = 0;
  sink.connect(context.destination);

  /* The staircase is generated ONCE for the bank and shared by the three
     sources: three LFOs set to the same shape and rate then step through the same
     values, which is what a player expects, and it costs one buffer. */
  const steps = sampleHoldTable({ sampleRate: context.sampleRate, random });
  const sampleHoldBuffer = context.createBuffer(1, steps.length, context.sampleRate);
  sampleHoldBuffer.getChannelData(0).set(steps);

  const lfos = [];
  for (let index = 0; index < LFO_COUNT; index += 1) {
    lfos.push(createLfo({ context, index, prefix: `lfo${index + 1}`, sink, sampleHoldBuffer }));
  }

  const tempo = () => bpm();

  const refresh = () => {
    const now = tempo();
    for (const lfo of lfos) lfo.refresh(read, now);
    return lfos.map((lfo) => lfo.state());
  };

  /* The store is the authority: a key change moves the LFO through here. */
  const unsubscribes = [];
  if (typeof subscribe === 'function') {
    for (const lfo of lfos) {
      for (const key of LFO_KEYS) {
        unsubscribes.push(subscribe(`${lfo.prefix}.${key}`, () => refresh()));
      }
    }
  }

  refresh();

  return {
    lfos,
    sink,
    refresh,
    tempo,
    /** The three global matrix sources, read once each. */
    sourceValues() {
      const values = {};
      lfos.forEach((lfo, index) => {
        values[`lfo${index + 1}`] = lfo.value();
      });
      return values;
    },
    /** One LFO's live value, for a read-out or a check. */
    value: (index = 0) => lfos[index]?.value() ?? 0,
    state: () => lfos.map((lfo) => lfo.state()),
    shapes: () => [...LFO_SHAPES],
    divisions: () => [...SYNC_DIVISIONS],
    dispose() {
      for (const off of unsubscribes) off?.();
    },
  };
}
