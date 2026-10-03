/**
 * chain.js — THE MASTER CHAIN, as a factory over any AudioContext.
 *
 *   createMasterChain(context, options) -> the chain handle
 *
 * This file holds no singleton and imports no AudioContext: it takes the context as
 * an argument, exactly as nodes.js and voice.js do, so `node --test` can drive the
 * whole graph through tests/effects-fake-audio.mjs and assert on real connections
 * and real scheduled automation. web/audio/effects.js is the browser singleton built
 * from it; web/audio/master.js terminates the chain into masterOut.
 *
 * THE ORDER, AND WHY IT IS THE ORDER
 *
 *   input ─ eq.low ─ eq.mid ─ eq.high ─┬─ delay.dry ─────────┐
 *                                        └─ delay.line ─┬─ delay.wet ─┤
 *                                                    │             │
 *                                        delay.line ─┴─ delay.tone ─ delay.feedback
 *                                                              └────── (back into delay.line)
 *   delay.out ─┬─ reverb.dry ─────────────────────────────┐
 *               └─ reverb.send ─ preDelay ─ damping ─ convolver ─ reverb.wet ─┤
 *   reverb.out ─────────────────────────────────────────────────────────────────┘
 *   masterVolume ─ limiter ─ safetyClip ─ analyser (= output) ─> masterOut ─> destination
 *
 *   THE DELAY IS BEFORE THE REVERB. That is the Thor reference order and it is a
 *   signal-flow decision, not an arbitrary one: the delay's taps are then fed by
 *   the reverb wash, so the repeats arrive diffused instead of dry. Reversing the two
 *   sounds like two separate layers instead of one space.
 *
 * MASTER VOLUME BEFORE THE LIMITER
 *   The plan requires the volume to sit ahead of the limiter, so that what the
 *   limiter protects is the level the player chose rather than a level they cannot
 *   pull back. `masterVolume` is therefore a node between the reverb and the
 *   limiter, and `global.volume` is bound to IT — not to the summing input, which is
 *   upstream of the EQ and the delay. effects.js and master.js both say so at the
 *   top of their headers.
 *
 * THE THREE CEILINGS, AND WHERE THEY LIVE
 *   - Delay feedback is capped at 95% in the one function that writes
 *     `delay.feedback.gain`. A loop gain of 1.0 or more, with a wet/dry crossfade
 *     summing the tap back in, diverges. There is deliberately NO other gain inside
 *     the loop: the cap is the whole stability argument.
 *   - The tone filter is a lowpass with Q pinned at 0.7071 — overdamped, so it has
 *     no resonant peak above unity that could undo the cap.
 *   - The impulse response is clamped to 12 s by ir.js before any buffer is built.
 *
 * ONE WRITE SITE PER CONTROL
 *   Every continuous control reaches its AudioParam as a scheduled ramp, and each
 *   target has exactly one function that writes it. That is what lets task 7's
 *   modulation matrix join in without a second writer: `modulateDelayTime(cents)`
 *   and `modulateReverbSend(amount)` move the same state the controls do and go
 *   through the same site, so a gesture and a modulation cannot fight over a param.
 *   The 1:1 keys are bound through the ramp bridge (audio/ramp.js); the keys needing a
 *   transform or a fan-out subscribe here and ramp through audio/automation.js.
 *
 *   Every node is tagged with `effectsLabel`, which is both what these tests walk and
 *   what task 13's runtime handle needs for its constructed-effect-node inventory.
 */

import { rampTo, RAMP_SECONDS } from './automation.js';
import { buildImpulseResponse, clampDecaySeconds, IR_DECAY_DEFAULT, IR_DECAY_MAX } from './ir.js';

/* ------------------------------------------------------------- the constants --- */

/** Three bands, one per lane. There is no 6-band or parametric version of this. */
export const EQ_BANDS = [
  { key: 'eq.low', name: 'low', type: 'lowshelf', frequency: 200, Q: 0.7071 },
  { key: 'eq.mid', name: 'mid', type: 'peaking', frequency: 800, Q: 0.7 },
  { key: 'eq.high', name: 'high', type: 'highshelf', frequency: 3000, Q: 0.7071 },
];

/** The EQ gain range, in dB. Clamped at the write site as well as in the schema. */
export const EQ_GAIN_DB = 18;

export const DELAY_TIME_MIN = 0.001;
export const DELAY_TIME_MAX = 2;
export const DELAY_TONE_MIN = 400;
export const DELAY_TONE_MAX = 20000;

/** Hard ceiling on the feedback loop gain. Below unity, always. */
export const DELAY_FEEDBACK_MAX = 0.95;

/** Overdamped on purpose: a resonant peak here would undo the feedback cap. */
export const DELAY_TONE_Q = 0.7071;

export const REVERB_DAMPING_MIN = 200;
export const REVERB_DAMPING_MAX = 20000;
export const REVERB_PREDELAY_MAX = 0.2;

/** Beats per note value, for the tempo-synced delay. A quarter note is one beat. */
export const SYNC_BEATS = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
};

/**
 * The limiter. A safety device, not a tone control: a high ratio, a hard knee and a
 * fast attack, with the threshold low enough that normal playing never engages it.
 * If it is constantly squashing output, the levels upstream are wrong — lower those
 * rather than loosening this.
 *
 * MEASURED, NOT ASSUMED: Chrome's DynamicsCompressorNode applies a fixed output gain
 * of about +1.7 dB in its passband at these settings, whatever the input level — at
 * an input 11 dB below the threshold it still comes out 1.7 dB louder. So the whole
 * chain measures +1.7 dB from the limiter plus whatever master volume is set to: at
 * the 0.7 default that is -1.35 dB overall. That headroom is deliberate.
 *
 * WHY THERE IS ALSO A CLIPPER AFTER IT
 *   A DynamicsCompressorNode is not a brickwall limiter, and measurement is what
 *   settled this. Ten voices at velocity 0.9, all three cores, peak the SUMMING bus
 *   at 8.8-9.2 (+19 dBFS) before any of this chain sees them, and with that much
 *   overshoot the post-limiter peak measured 1.22-1.35 — hard digital clipping, in
 *   the one situation the stage exists to prevent. Shortening the compressor's
 *   attack from 3 ms to 0.1 ms changed it by 0.13, so the attack was never the
 *   problem: the node's gain reduction is smoothed per block and a transient simply
 *   gets through.
 *
 *   So the limiter does the musical work and a one-node WaveShaper after it is the
 *   brickwall: identity below -3.1 dBFS, smooth to exactly 1.0, and |out| <= 1.0
 *   always. It is transparent at any level a player will actually reach, and it is
 *   the only thing in the chain that can promise the output does not clip.
 *
 *   The upstream gain is still the real problem — +19 dBFS at the summing bus comes
 *   from `mixer.level`, the per-core levels and the voice count in ui/params.js,
 *   which this task does not own. That is reported rather than silently absorbed.
 */
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.15 };

/**
 * Where the safety clipper starts to bend: transparent below it. 0.7 is -3.1 dBFS,
 * the same place the limiter starts working, so during normal playing this node
 * does nothing at all.
 */
export const SAFETY_CLIP_KNEE = 0.7;

/**
 * The curve's asymptote. Note it is NOT 1.0, and the reason is worth stating:
 * a limiter curve that is transparent up to the knee can only reach full scale at
 * full scale if it is the identity line — anything that bends below 1.0 must arrive
 * at something under it. So the ceiling is set just under full scale and the
 * exponential below reaches it asymptotically. In practice a full-scale input comes
 * out at about 0.89, which is -1 dBFS of headroom: the same margin a mastering
 * limiter is normally given, and a hard guarantee that the output cannot clip.
 */
export const SAFETY_CLIP_CEILING = 0.99;

/**
 * The safety clipper's curve: identity below the knee, then a C1 roll-off towards
 * the ceiling. The rate is chosen so the slope leaving the knee is exactly 1 — the
 * curve enters and leaves the knee at the same gradient, so there is no kink to
 * generate harmonics — and the slope then falls off exponentially to zero.
 *
 * A WaveShaperNode clamps its input to the curve's domain before looking it up, so
 * an input of 9 comes out as the same value an input of 1 does: this node cannot
 * emit a sample beyond SAFETY_CLIP_CEILING no matter what is fed into it.
 */
export function buildSafetyClipCurve(knee = SAFETY_CLIP_KNEE, ceiling = SAFETY_CLIP_CEILING, steps = 2049) {
  const curve = new Float32Array(steps);
  const span = ceiling - knee;
  for (let i = 0; i < steps; i += 1) {
    const x = (i / (steps - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const shaped =
      magnitude <= knee ? magnitude : ceiling - span * Math.exp(-(magnitude - knee) / span);
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}

/**
 * The analyser's fftSize, chosen once and not to be changed afterwards.
 *
 * 2048 samples is a 42.7 ms window at 48 kHz: long enough for a stable RMS reading
 * that a ~20 fps meter can use without flickering, short enough that a note attack
 * and the short end of a drum voice both register as a step rather than being
 * averaged into the past. Changing it changes the time-domain window and invalidates
 * every reading task 12 and task 13 take against it, which is why nothing else here
 * writes it.
 */
export const ANALYSER_FFT_SIZE = 2048;

/** How long a decay drag is allowed to keep moving before one response is rebuilt. */
export const IR_REBUILD_DEBOUNCE_MS = 150;

/** One curve, built once and shared: a WaveShaper only ever reads it. */
const SAFETY_CLIP_CURVE = buildSafetyClipCurve();

const DEFAULTS = {
  'global.volume': 0.7,
  'global.tempo': 120,
  'eq.low': 0,
  'eq.mid': 0,
  'eq.high': 0,
  'delay.time': 0.25,
  'delay.sync': false,
  'delay.timeSync': '1/8',
  'delay.feedback': 0,
  'delay.tone': 4000,
  'delay.mix': 0,
  'reverb.decay': IR_DECAY_DEFAULT,
  'reverb.damping': 6000,
  'reverb.preDelay': 0.02,
  'reverb.mix': 0,
};

const clamp = (value, low, high) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return low;
  return n < low ? low : n > high ? high : n;
};

const clamp01 = (value) => clamp(value, 0, 1);

/**
 * An equal-power crossfade, [dry, wet]. Linear would dip by 3 dB in the middle,
 * which on a delay is audible as a hole at mid-mix.
 */
function crossfade(mix) {
  const m = clamp01(mix);
  const wet = Math.sin((m * Math.PI) / 2);
  return [Math.cos((m * Math.PI) / 2), wet];
}

/** Beats per note value; an unknown division falls back to an eighth note. */
export function beatsFor(division) {
  return SYNC_BEATS[division] ?? SYNC_BEATS['1/8'];
}

/* ---------------------------------------------------------------- the factory --- */

export function createMasterChain(context, {
  store = null,
  bridge = null,
  scheduler = {
    defer: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle),
  },
  irDebounceMs = IR_REBUILD_DEBOUNCE_MS,
} = {}) {
  if (!context) throw new Error('createMasterChain needs an AudioContext');

  /** Tag every node, for the graph walk in tests and task 13's node inventory. */
  const tag = (node, label) => {
    node.effectsLabel = label;
    return node;
  };

  const read = (key, fallback) => {
    const value = store ? store.get(key) : DEFAULTS[key];
    return value === undefined || value === null ? (fallback ?? DEFAULTS[key]) : value;
  };

  /* ----------------------------------------------------------------- the nodes --- */

  const input = tag(context.createGain(), 'input');
  input.gain.value = 1;

  const eq = {};
  let upstream = input;
  for (const band of EQ_BANDS) {
    const node = tag(context.createBiquadFilter(), `eq.${band.name}`);
    node.type = band.type;
    node.frequency.value = band.frequency;
    node.Q.value = band.Q;
    node.gain.value = 0;
    upstream.connect(node);
    upstream = node;
    eq[band.name] = node;
  }

  const delayDry = tag(context.createGain(), 'delay.dry');
  const delayWet = tag(context.createGain(), 'delay.wet');
  const delayLine = tag(context.createDelay(DELAY_TIME_MAX), 'delay.line');
  const delayTone = tag(context.createBiquadFilter(), 'delay.tone');
  const delayFeedback = tag(context.createGain(), 'delay.feedback');
  const delayOut = tag(context.createGain(), 'delay.out');

  delayDry.gain.value = 1;
  delayWet.gain.value = 0;
  delayFeedback.gain.value = 0;
  delayOut.gain.value = 1;

  delayTone.type = 'lowpass';
  delayTone.frequency.value = DELAY_TONE_MAX;
  delayTone.Q.value = DELAY_TONE_Q;

  upstream.connect(delayDry);
  upstream.connect(delayLine);
  delayLine.connect(delayTone);
  delayTone.connect(delayFeedback);
  delayFeedback.connect(delayLine);
  delayLine.connect(delayWet);
  delayDry.connect(delayOut);
  delayWet.connect(delayOut);

  const reverbDry = tag(context.createGain(), 'reverb.dry');
  const reverbWet = tag(context.createGain(), 'reverb.wet');
  const reverbSend = tag(context.createGain(), 'reverb.send');
  const reverbPreDelay = tag(context.createDelay(REVERB_PREDELAY_MAX), 'reverb.preDelay');
  const reverbDamping = tag(context.createBiquadFilter(), 'reverb.damping');
  const reverbOut = tag(context.createGain(), 'reverb.out');

  reverbDry.gain.value = 1;
  reverbWet.gain.value = 0;
  reverbSend.gain.value = 1;
  reverbOut.gain.value = 1;
  reverbDamping.type = 'lowpass';
  reverbDamping.Q.value = DELAY_TONE_Q;

  delayOut.connect(reverbDry);
  delayOut.connect(reverbSend);
  reverbSend.connect(reverbPreDelay);
  reverbPreDelay.connect(reverbDamping);
  // The convolver itself is wired further down, immediately after its response has
  // been built — see setReverbActive above for why it is created rather than reused.
  reverbWet.connect(reverbOut);
  reverbDry.connect(reverbOut);

  const masterVolume = tag(context.createGain(), 'masterVolume');
  const limiter = tag(context.createDynamicsCompressor(), 'limiter');
  // The brickwall behind the limiter. See LIMITER above for the measurement that
  // put it here. `oversample: 'none'` deliberately: the curve is monotone, so the
  // 2x/4x resampling a WaveShaper would otherwise do buys nothing and costs time.
  const safetyClip = tag(context.createWaveShaper(), 'safetyClip');
  const analyser = tag(context.createAnalyser(), 'analyser');
  const output = analyser;

  safetyClip.curve = SAFETY_CLIP_CURVE;
  safetyClip.oversample = 'none';

  masterVolume.gain.value = clamp01(read('global.volume', DEFAULTS['global.volume']));
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0; // the meter reads the time domain, not the spectrum

  reverbOut.connect(masterVolume);
  masterVolume.connect(limiter);
  limiter.connect(safetyClip);
  safetyClip.connect(analyser);

  /* ------------------------------------------------------- the reverb bypass --- */

  // Starts TRUE because the wet branch is wired above; the initial mix decides
  // whether it stays. Starting it false would leave the branch connected at a mix
  // of zero, which is exactly the cost the plan asks to avoid.
  let reverbActive = true;

  // A ConvolverNode that is disconnected keeps its convolution history, so re-arming
  // a bypassed stage replays whatever it last heard. Measured, not guessed: after a
  // loud passage, bypassing at mix 0 and re-arming from silence produced 0.26 RMS
  // of phantom output with nothing playing, and because that output is written back
  // into the node's own history it sustains itself rather than decaying. That is
  // worse than the CPU the bypass saves, so re-arming builds a fresh node instead.
  //
  // A fresh ConvolverNode re-partitions the kernel, which was measured at 26-40 ms
  // with the 12 s response — paid once per arm or disarm, a deliberate user action,
  // and it re-uses the response that was already built. Nothing is regenerated and
  // nothing is rebuilt per control tick, which is the cost the plan actually names.
  let convolver = null;

  function makeConvolver() {
    const node = tag(context.createConvolver(), 'convolver');
    node.buffer = ir.buffer;
    node.normalize = true;
    return node;
  }

  /** Disconnect or reconnect the whole wet branch. Nothing else touches these links. */
  function setReverbActive(active) {
    if (active === reverbActive) return reverbActive;
    reverbActive = active;
    try {
      if (active) {
        // A fresh node has to be wired at both ends; the old one is left with no
        // edges at all, so it is unreachable and stops being rendered.
        convolver = makeConvolver();
        reverbDamping.connect(convolver);
        convolver.connect(reverbWet);
        delayOut.connect(reverbSend);
        reverbWet.connect(reverbOut);
      } else {
        delayOut.disconnect(reverbSend);
        reverbWet.disconnect(reverbOut);
        // Drop the convolver's own edges too, so the node it is holding is left
        // unreachable — not rendered, and not keeping the response alive in memory.
        reverbDamping.disconnect();
        convolver.disconnect();
      }
    } catch {
      /* an edge that was not connected — the state below is still the truth */
    }
    return reverbActive;
  }

  let pendingCut = null;

  /* --------------------------------------------- the impulse-response rebuild --- */

  const ir = {
    /** What the convolver is carrying right now. */
    loadedSeconds: null,
    /** What has been asked for but not built yet. */
    pendingSeconds: null,
    timer: null,
    builds: 0,
    lastBuildMs: 0,
    lastFrames: 0,
    lastSeconds: 0,
    channels: 0,
    buffer: null,
  };

  function rebuildIr() {
    if (ir.pendingSeconds === null) return null;
    const seconds = ir.pendingSeconds;
    ir.pendingSeconds = null;
    const result = buildImpulseResponse(context, { decaySeconds: seconds });
    ir.buffer = result.buffer;
    // At startup there is no convolver yet — it is created just after this first
    // build and takes the response from `ir`. Every later rebuild swaps the buffer
    // on the node that is carrying it.
    if (convolver) convolver.buffer = result.buffer;
    ir.loadedSeconds = result.decaySeconds;
    ir.builds += 1;
    ir.lastBuildMs = result.buildMs;
    ir.lastFrames = result.frames;
    ir.lastSeconds = result.seconds;
    ir.channels = result.channels;
    return result;
  }

  function flushIrRebuild() {
    if (ir.timer !== null) {
      scheduler.cancel(ir.timer);
      ir.timer = null;
    }
    return rebuildIr();
  }

  /**
   * The ONLY entry point to a rebuild. A value equal to the one already loaded is
   * ignored outright, and a value already queued replaces the queued one instead of
   * adding to it, so dragging the decay knob builds one response, not one per event.
   */
  function requestIrRebuild(value) {
    const seconds = clampDecaySeconds(value);
    if (seconds === ir.pendingSeconds) return false;
    if (ir.pendingSeconds === null && seconds === ir.loadedSeconds) return false;
    ir.pendingSeconds = seconds;
    if (ir.timer !== null) scheduler.cancel(ir.timer);
    ir.timer = scheduler.defer(() => {
      ir.timer = null;
      rebuildIr();
    }, irDebounceMs);
    return true;
  }

  /* ---------------------------------------------------------- delay-time state --- */

  const state = {
    timeSeconds: clamp(read('delay.time', DEFAULTS['delay.time']), DELAY_TIME_MIN, DELAY_TIME_MAX),
    sync: Boolean(read('delay.sync', DEFAULTS['delay.sync'])),
    syncDivision: String(read('delay.timeSync', DEFAULTS['delay.timeSync'])),
    beatPeriod: 60 / clamp(read('global.tempo', DEFAULTS['global.tempo']), 40, 220),
    cents: 0,
    reverbSend: 1,
    delaySeconds: 0,
    feedback: 0,
    masterVolume: clamp01(read('global.volume', DEFAULTS['global.volume'])),
  };

  /** Base time from the control or the beat, with the matrix's cents on top. */
  function resolveDelaySeconds() {
    const base = state.sync ? state.beatPeriod * beatsFor(state.syncDivision) : state.timeSeconds;
    return clamp(base * Math.pow(2, state.cents / 1200), DELAY_TIME_MIN, DELAY_TIME_MAX);
  }

  /* ------------------------------------------------------------- write sites --- */

  function applyDelayTime({ at } = {}) {
    const seconds = resolveDelaySeconds();
    state.delaySeconds = seconds;
    rampTo(delayLine.delayTime, seconds, context, { at });
    return seconds;
  }

  /** THE ONLY FUNCTION THAT WRITES `delay.delayTime`. */
  function setDelayTime(seconds, options) {
    state.timeSeconds = clamp(seconds, DELAY_TIME_MIN, DELAY_TIME_MAX);
    return applyDelayTime(options);
  }

  /** Task 7's matrix destination, in cents: 1200 doubles the time. */
  function modulateDelayTime(cents, options) {
    const value = Number(cents);
    state.cents = Number.isFinite(value) ? value : 0;
    return applyDelayTime(options);
  }

  function resetDelayTimeModulation(options) {
    return modulateDelayTime(0, options);
  }

  /** Task 9's clock: tell the delay what a beat is worth and it re-times itself. */
  function syncDelayToTempo(bpm, options) {
    const tempo = Number(bpm);
    state.beatPeriod = 60 / clamp(Number.isFinite(tempo) ? tempo : 120, 40, 220);
    return state.sync ? applyDelayTime(options) : state.delaySeconds;
  }

  /** THE ONLY FUNCTION THAT WRITES THE FEEDBACK GAIN, and where the 95% cap lives. */
  function applyDelayFeedback({ at } = {}) {
    const gain = clamp(read('delay.feedback', DEFAULTS['delay.feedback']) / 100, 0, DELAY_FEEDBACK_MAX);
    state.feedback = gain;
    rampTo(delayFeedback.gain, gain, context, { at });
    return gain;
  }

  /** A fraction, 0..1. Clamped to the hard ceiling however it is asked for. */
  function setDelayFeedback(value, options) {
    const gain = clamp(value, 0, DELAY_FEEDBACK_MAX);
    state.feedback = gain;
    rampTo(delayFeedback.gain, gain, context, options);
    return gain;
  }

  function applyDelayMix(value, { at } = {}) {
    const [dry, wet] = crossfade(value);
    rampTo(delayDry.gain, dry, context, { at });
    rampTo(delayWet.gain, wet, context, { at });
    return { dry, wet };
  }

  function setDelayMix(value, options) {
    return applyDelayMix(value, options);
  }

  /** THE ONLY FUNCTION THAT WRITES THE REVERB SEND: the matrix's `reverbSend`. */
  function applyReverbSend(value, { at } = {}) {
    const send = clamp01(value);
    state.reverbSend = send;
    rampTo(reverbSend.gain, send, context, { at });
    return send;
  }

  function modulateReverbSend(amount, options) {
    return applyReverbSend(amount, options);
  }

  function applyReverbMix(value, { at } = {}) {
    const [dry, wet] = crossfade(value);
    rampTo(reverbDry.gain, dry, context, { at });
    rampTo(reverbWet.gain, wet, context, { at });
    if (wet > 0) {
      if (pendingCut !== null) {
        scheduler.cancel(pendingCut);
        pendingCut = null;
      }
      setReverbActive(true);
    } else if (reverbActive && pendingCut === null) {
      // Let the wet gain finish its ramp to zero before the branch is cut, so the
      // tail ends on silence rather than on a step.
      pendingCut = scheduler.defer(() => {
        pendingCut = null;
        setReverbActive(false);
      }, Math.round(RAMP_SECONDS * 1000) + 30);
    }
    return { dry, wet };
  }

  function setReverbMix(value, options) {
    return applyReverbMix(value, options);
  }

  function setMasterVolume(value, options) {
    const gain = clamp01(value);
    state.masterVolume = gain;
    rampTo(masterVolume.gain, gain, context, options);
    return gain;
  }

  /* ------------------------------------------------------------ the analyser --- */

  let levelBuffer = new Float32Array(ANALYSER_FFT_SIZE);

  /**
   * { rms, peak } over the analyser's window. rms is what task 13's meter paints;
   * peak is the short-window hold the runtime handle reports. The buffer is grown if
   * anything ever changed fftSize, so a reading cannot silently come back wrong.
   */
  function readLevels() {
    if (levelBuffer.length !== analyser.fftSize) levelBuffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(levelBuffer);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < levelBuffer.length; i += 1) {
      const value = levelBuffer[i];
      sum += value * value;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
    }
    return { rms: Math.sqrt(sum / levelBuffer.length), peak };
  }

  /* ---------------------------------------------------------- the initial state --- */

  for (const band of EQ_BANDS) {
    eq[band.name].gain.value = clamp(read(band.key, 0), -EQ_GAIN_DB, EQ_GAIN_DB);
    if (bridge) bridge.bind(band.key, eq[band.name].gain, { context, mode: 'ramp' });
  }

  // The tone lowpass: one key, one param, so the bridge is the right tool.
  delayTone.frequency.value = clamp(read('delay.tone', DEFAULTS['delay.tone']), DELAY_TONE_MIN, DELAY_TONE_MAX);
  if (bridge) bridge.bind('delay.tone', delayTone.frequency, { context, mode: 'ramp' });

  // Master volume: the binding moved here, to the node before the limiter.
  if (bridge) bridge.bind('global.volume', masterVolume.gain, { context, mode: 'ramp' });

  // Damping frequency and the pre-delay are 1:1 too.
  reverbDamping.frequency.value = clamp(
    read('reverb.damping', DEFAULTS['reverb.damping']),
    REVERB_DAMPING_MIN,
    REVERB_DAMPING_MAX,
  );
  reverbPreDelay.delayTime.value = clamp(read('reverb.preDelay', DEFAULTS['reverb.preDelay']), 0, REVERB_PREDELAY_MAX);
  if (bridge) {
    bridge.bind('reverb.damping', reverbDamping.frequency, { context, mode: 'ramp' });
    bridge.bind('reverb.preDelay', reverbPreDelay.delayTime, { context, mode: 'ramp' });
  }

  delayLine.delayTime.value = resolveDelaySeconds();
  state.delaySeconds = delayLine.delayTime.value;
  delayFeedback.gain.value = clamp(read('delay.feedback', DEFAULTS['delay.feedback']) / 100, 0, DELAY_FEEDBACK_MAX);
  state.feedback = delayFeedback.gain.value;

  const [delayDryLevel, delayWetLevel] = crossfade(read('delay.mix', DEFAULTS['delay.mix']));
  delayDry.gain.value = delayDryLevel;
  delayWet.gain.value = delayWetLevel;

  const [reverbDryLevel, reverbWetLevel] = crossfade(read('reverb.mix', DEFAULTS['reverb.mix']));
  reverbDry.gain.value = reverbDryLevel;
  reverbWet.gain.value = reverbWetLevel;

  // Generated ONCE here, and again only when the decay control actually changes.
  // The convolver is created straight after, because it needs this response.
  ir.pendingSeconds = clampDecaySeconds(read('reverb.decay', DEFAULTS['reverb.decay']));
  rebuildIr();
  convolver = makeConvolver();
  reverbDamping.connect(convolver);
  convolver.connect(reverbWet);

  // A mix of zero means the stage is out of the graph from the first sample.
  setReverbActive(reverbWetLevel > 0);

  /* -------------------------------------------------------- the store fan-out --- */

  const unsubscribes = [];

  if (store) {
    const subscribe = (key, fn) => {
      unsubscribes.push(store.subscribe(key, fn));
    };

    // delay.time is only the base time: sync and the matrix also feed this param.
    subscribe('delay.time', (key, value) => setDelayTime(value));
    subscribe('delay.sync', (key, value) => {
      state.sync = Boolean(value);
      applyDelayTime();
    });
    subscribe('delay.timeSync', (key, value) => {
      state.syncDivision = String(value);
      applyDelayTime();
    });
    subscribe('global.tempo', (key, value) => syncDelayToTempo(value));

    // The feedback percentage and the two crossfades are not 1:1 with a param.
    subscribe('delay.feedback', () => applyDelayFeedback());
    subscribe('delay.mix', (key, value) => applyDelayMix(value));
    subscribe('reverb.mix', (key, value) => applyReverbMix(value));
    subscribe('reverb.decay', (key, value) => requestIrRebuild(value));

    if (!bridge) {
      subscribe('global.volume', (key, value) => setMasterVolume(value));
    }
  }

  /* ----------------------------------------------------------------- the stats --- */

  /**
   * The chain's own description of itself: label -> the nodes it feeds, in signal
   * order, including the delay's feedback loop and the reverb's bypass. Stated
   * rather than introspected because a real AudioNode does not report its outgoing
   * connections — only the fake harness does — and task 13's runtime handle needs
   * this list to be true in a browser.
   *
   * `connected` reports whether the edge is actually made, which is how the bypass
   * shows up: at a mix of zero the convolver branch is cut, so its edges read false.
   */
  const topology = () => [
    { label: 'input', node: input, feeds: [eq.low] },
    { label: 'eq.low', node: eq.low, feeds: [eq.mid] },
    { label: 'eq.mid', node: eq.mid, feeds: [eq.high] },
    { label: 'eq.high', node: eq.high, feeds: [delayDry, delayLine] },
    { label: 'delay.dry', node: delayDry, feeds: [delayOut] },
    { label: 'delay.line', node: delayLine, feeds: [delayTone, delayWet] },
    { label: 'delay.tone', node: delayTone, feeds: [delayFeedback] },
    { label: 'delay.feedback', node: delayFeedback, feeds: [delayLine] },
    { label: 'delay.wet', node: delayWet, feeds: [delayOut] },
    { label: 'delay.out', node: delayOut, feeds: [reverbDry, reverbSend], connected: reverbActive },
    { label: 'reverb.dry', node: reverbDry, feeds: [reverbOut] },
    { label: 'reverb.send', node: reverbSend, feeds: [reverbPreDelay], connected: reverbActive },
    { label: 'reverb.preDelay', node: reverbPreDelay, feeds: [reverbDamping], connected: reverbActive },
    { label: 'reverb.damping', node: reverbDamping, feeds: [convolver], connected: reverbActive },
    { label: 'convolver', node: convolver, feeds: [reverbWet], connected: reverbActive },
    { label: 'reverb.wet', node: reverbWet, feeds: [reverbOut], connected: reverbActive },
    { label: 'reverb.out', node: reverbOut, feeds: [masterVolume] },
    { label: 'masterVolume', node: masterVolume, feeds: [limiter] },
    { label: 'limiter', node: limiter, feeds: [safetyClip] },
    { label: 'safetyClip', node: safetyClip, feeds: [analyser] },
    { label: 'analyser', node: analyser, feeds: [] },
  ];

  /** The constructed effect-node inventory, in signal order, for the runtime handle. */
  function nodeInventory() {
    return topology().map(({ label, node, feeds, connected = true }) => ({
      label,
      kind: node.constructor?.name ?? 'AudioNode',
      feeds: feeds.map((next) => next.effectsLabel),
      connected,
    }));
  }

  function reverbIrStats() {
    return {
      /** The decay the convolver is carrying. */
      decaySeconds: ir.loadedSeconds,
      loadedSeconds: ir.loadedSeconds,
      /** What has been asked for and not built yet, if anything. */
      targetSeconds: ir.pendingSeconds,
      pending: ir.pendingSeconds !== null,
      builds: ir.builds,
      lastBuildMs: ir.lastBuildMs,
      lastFrames: ir.lastFrames,
      lastSeconds: ir.lastSeconds,
      channels: ir.channels,
      buffer: ir.buffer,
      /** True when the convolver branch is in the graph rather than cut out. */
      active: reverbActive,
      maxSeconds: IR_DECAY_MAX,
    };
  }

  /* -------------------------------------------------------------------- the API --- */

  return {
    context,
    input,
    output,
    analyser,
    eq,
    delay: {
      dry: delayDry,
      wet: delayWet,
      line: delayLine,
      tone: delayTone,
      feedback: delayFeedback,
      out: delayOut,
    },
    reverb: {
      dry: reverbDry,
      wet: reverbWet,
      send: reverbSend,
      preDelay: reverbPreDelay,
      damping: reverbDamping,
      out: reverbOut,
      /** A getter, because re-arming the bypass replaces the node. */
      get convolver() {
        return convolver;
      },
      get active() {
        return reverbActive;
      },
    },
    masterVolume,
    limiter,
    safetyClip,
    state,

    // one write site per target
    applyDelayTime,
    setDelayTime,
    modulateDelayTime,
    resetDelayTimeModulation,
    syncDelayToTempo,
    applyDelayFeedback,
    setDelayFeedback,
    setDelayMix,
    setReverbMix,
    modulateReverbSend,
    setMasterVolume,
    // the rebuild policy
    requestIrRebuild,
    flushIrRebuild,
    reverbIrStats,
    nodeInventory,
    setReverbActive,
    readLevels,

    dispose() {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      if (bridge) {
        for (const key of ['eq.low', 'eq.mid', 'eq.high', 'delay.tone', 'global.volume', 'reverb.damping', 'reverb.preDelay']) {
          bridge.unbind(key);
        }
      }
    },
  };
}