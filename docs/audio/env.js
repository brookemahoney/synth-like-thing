/**
 * env.js — the two ADSRs on every voice: the amp envelope on the amplifier, and
 * the filter envelope, which is a modulation-matrix SOURCE and nothing else.
 *
 * AN ADSR IS A SCHEDULE, NOT A PARAMETER
 *   An envelope is the value of one AudioParam as a function of time, so it is
 *   scheduled: a step to zero at the note, a ramp up over the attack, a ramp to
 *   the sustain level over the decay, and — at note-off — a hold and a ramp to
 *   zero over the release. Nothing here ever assigns `param.value`, so there is
 *   nothing to zipper.
 *
 * RELEASE FROM WHEREVER THE ENVELOPE IS — THE PART THAT IS EASY TO GET WRONG
 *   A note-off during the attack (a fast repeated note, a MIDI controller
 *   bouncing, an arpeggio at 1/32) must release from the value the envelope has
 *   reached, NOT from the sustain level. Ramping to zero "from sustain" produces
 *   an audible jump up on every fast note. So `release()` CANCELS the automation
 *   in flight with `cancelAndHoldAtTime` — which pins the current value — and
 *   re-schedules a single ramp to zero from there. The cancel-and-reschedule is
 *   the whole fix; there is no second path.
 *
 *   `valueAt(time)` models the same segments in plain arithmetic, so the stage
 *   can be read back for an inspection panel (and asserted in a test) without
 *   trusting a param's `.value`. It is the same piecewise line the AudioParam
 *   automation is, which tests/envelope.test.mjs checks against a param that
 *   really interpolates.
 *
 * THERE IS NO FILTER-ENVELOPE AMOUNT KNOB, AND THAT IS THE POINT
 *   The plan's exclusion list says the filter envelope's depth lives in the
 *   modulation-matrix cells for filter 1 and filter 2 cutoff, so this envelope
 *   owns a shape (attack / decay / sustain / release) and NOTHING else. It has no
 *   amount, no depth, no intensity and no destination of its own: `value()` is a
 *   matrix SOURCE and the cutoff cells are the destinations. If you find
 *   yourself wanting an amount control here, the correct move is to set the
 *   matrix depth in the cell.
 *
 * TIME RANGES (matching the `envAmp.*` and `envFilter.*` schema entries)
 *   attack 1 ms .. 5 s, decay 1 ms .. 5 s, sustain 0 .. 1, release 1 ms .. 8 s
 *   The panel's curves are logarithmic; this module only ever sees the value the
 *   store already resolved, and clamps it defensively so a matrix write or a
 *   hand-set store cannot produce an envelope that never finishes.
 *
 * API
 *   createEnvelope({ context, param, peak, times })  -> envelope
 *   envelope.start(at)      the note-on schedule
 *   envelope.release(at)    cancel-and-hold, then ramp to zero; returns seconds
 *   envelope.stop(at, sec)  a forced fade (the allocator's kill path)
 *   envelope.setTimes(patch, options)     a control move; re-ramps a live release
 *   envelope.setPeak(peak, options)       task 7's `ampLevel` destination
 *   envelope.stage()       'idle'|'attack'|'decay'|'sustain'|'release'
 *   envelope.value() / valueAt(t) / times() / state() / reset()
 *   clampAttackDecay / clampRelease / clampSustain
 *   ENV_STAGE ENV_KEYS ATTACK_DECAY_MIN ATTACK_DECAY_MAX RELEASE_MIN RELEASE_MAX
 */

import { setNow } from './automation.js';
import { store as appStore } from '../ui/params.js';

/** The five stages an ADSR can report. */
export const ENV_STAGE = {
  IDLE: 'idle',
  ATTACK: 'attack',
  DECAY: 'decay',
  SUSTAIN: 'sustain',
  RELEASE: 'release',
};

/** Attack and decay, in seconds, matching `env*.attack` / `env*.decay`. */
export const ATTACK_DECAY_MIN = 0.001;
export const ATTACK_DECAY_MAX = 5;

/** Release, in seconds, matching `env*.release`. */
export const RELEASE_MIN = 0.001;
export const RELEASE_MAX = 8;

/** The four shape keys per envelope. There is no fifth. */
export const ENV_KEYS = ['attack', 'decay', 'sustain', 'release'];

/** The values used when a store key is absent — the schema's init patch. */
const DEFAULT_TIMES = { attack: 0.01, decay: 0.6, sustain: 0.7, release: 0.8 };

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Attack or decay, 1 ms .. 5 s. */
export function clampAttackDecay(value) {
  const n = num(value, DEFAULT_TIMES.attack);
  if (n < ATTACK_DECAY_MIN) return ATTACK_DECAY_MIN;
  if (n > ATTACK_DECAY_MAX) return ATTACK_DECAY_MAX;
  return n;
}

/** Release, 1 ms .. 8 s. */
export function clampRelease(value) {
  const n = num(value, DEFAULT_TIMES.release);
  if (n < RELEASE_MIN) return RELEASE_MIN;
  if (n > RELEASE_MAX) return RELEASE_MAX;
  return n;
}

/** Sustain, 0 .. 1. */
export function clampSustain(value) {
  const n = num(value, DEFAULT_TIMES.sustain);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** A whole set of times, clamped. Anything absent keeps its default. */
export function clampTimes(patch = {}) {
  return {
    attack: clampAttackDecay(patch.attack),
    decay: clampAttackDecay(patch.decay),
    sustain: clampSustain(patch.sustain),
    release: clampRelease(patch.release),
  };
}

const clampPeak = (value) => {
  const n = num(value, 1);
  if (n < 0) return 0;
  if (n > 4) return 4;
  return n;
};

/**
 * One envelope. `param` is the AudioParam it drives — the VCA's gain for the amp
 * envelope, and nothing at all for the filter envelope, which is a source the
 * matrix reads rather than a destination the graph applies.
 */
export function createEnvelope({ context, param = null, peak = 1, times = {} } = {}) {
  if (!context) throw new Error('createEnvelope needs a context');

  const env = {
    context,
    param,
    peak: clampPeak(peak),
    times: clampTimes({ ...DEFAULT_TIMES, ...times }),
    /** The schedule, or null while the envelope has never run. */
    schedule: null,
  };

  /* ------------------------------------------------------------- the value --- */

  /** The envelope's level at an arbitrary time — the same piecewise line the
   *  param automation describes, computed rather than read back. */
  function valueAt(time) {
    const s = env.schedule;
    if (!s) return 0;
    const { attack, decay } = env.times;
    if (s.released && time >= s.releaseAt) {
      const span = s.releaseEnd - s.releaseAt;
      const k = span <= 0 ? 1 : (time - s.releaseAt) / span;
      return s.releaseFrom * Math.max(0, 1 - Math.min(1, k));
    }
    if (time < s.attackEnd) {
      const span = s.attackEnd - s.at;
      const k = span <= 0 ? 1 : (time - s.at) / span;
      return env.peak * Math.min(1, Math.max(0, k));
    }
    if (time < s.decayEnd) {
      const span = s.decayEnd - s.attackEnd;
      const k = span <= 0 ? 1 : (time - s.attackEnd) / span;
      const level = env.times.sustain * env.peak;
      return env.peak + (level - env.peak) * Math.min(1, Math.max(0, k));
    }
    return env.times.sustain * env.peak;
  }

  /** Where the envelope is right now. */
  function stage() {
    const s = env.schedule;
    if (!s) return ENV_STAGE.IDLE;
    const now = context.currentTime;
    if (s.released) return now < s.releaseEnd ? ENV_STAGE.RELEASE : ENV_STAGE.IDLE;
    if (now < s.attackEnd) return ENV_STAGE.ATTACK;
    if (now < s.decayEnd) return ENV_STAGE.DECAY;
    return ENV_STAGE.SUSTAIN;
  }

  /* --------------------------------------------------------- the automation --- */

  /**
   * A scheduled ramp to an absolute time. `automation.js`'s rampTo() ramps from
   * "now", which is wrong for an envelope: its segments are anchored at the
   * note time, so a value must be written for a specific instant. It is still a
   * scheduled write, never an assignment, so there is no zipper.
   */
  function scheduleTo(value, time) {
    if (!param) return false;
    param.linearRampToValueAtTime(value, time);
    return true;
  }

  function holdAt(time) {
    if (!param) return;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else param.cancelScheduledValues(time);
  }

  /** The note-on schedule: zero, attack up to the peak, decay to the sustain. */
  function writeStart(at) {
    if (!param) return;
    // Cancel first: a reused voice may still be finishing the previous note's
    // release, and a leftover ramp would fight the new one.
    param.cancelScheduledValues(at);
    setNow(param, 0, context, { at });
    scheduleTo(env.peak, env.schedule.attackEnd);
    scheduleTo(env.times.sustain * env.peak, env.schedule.decayEnd);
  }

  /** The note-off schedule: hold the current value, then ramp down from it. */
  function writeRelease(at) {
    if (!param) return;
    holdAt(at);
    scheduleTo(0, env.schedule.releaseEnd);
  }

  /* --------------------------------------------------------------- the API --- */

  env.start = (at) => {
    const when = Number.isFinite(at) ? at : context.currentTime;
    env.schedule = {
      at: when,
      attackEnd: when + env.times.attack,
      decayEnd: when + env.times.attack + env.times.decay,
      released: false,
      releaseAt: when,
      releaseEnd: when,
      releaseFrom: 0,
    };
    writeStart(when);
    return env;
  };

  /**
   * The note-off. Returns the release length in seconds, because the caller
   * needs it: a voice's oscillators must keep running for the whole release or
   * an 8 s release would be an 8 s release of silence.
   */
  env.release = (at) => {
    const when = Number.isFinite(at) ? at : context.currentTime;
    const seconds = env.times.release;
    if (!env.schedule || env.schedule.released) {
      env.schedule = {
        at: when,
        attackEnd: when,
        decayEnd: when,
        released: true,
        releaseAt: when,
        releaseEnd: when + seconds,
        releaseFrom: 0,
      };
      return seconds;
    }
    // From HERE, not from sustain: this is the value the envelope has reached.
    // It has to be read BEFORE the schedule is marked released, or the read
    // would take the release branch and return the release's own starting value.
    const releaseFrom = valueAt(when);
    env.schedule.released = true;
    env.schedule.releaseAt = when;
    env.schedule.releaseEnd = when + seconds;
    env.schedule.releaseFrom = releaseFrom;
    writeRelease(when);
    return seconds;
  };

  /** A forced fade to zero, for the allocator's kill path. */
  env.stop = (at, seconds = 0.02) => {
    if (!param) return env;
    const when = Number.isFinite(at) ? at : context.currentTime;
    holdAt(when);
    scheduleTo(0, when + seconds);
    env.schedule = {
      ...(env.schedule ?? { at: when, attackEnd: when, decayEnd: when }),
      released: true,
      releaseAt: when,
      releaseEnd: when + seconds,
      releaseFrom: valueAt(when),
    };
    return env;
  };

  /**
   * A control move. The shape is remembered for the next note; the one time it
   * takes effect immediately is the release, because a release drag while the
   * note is fading should change how long it fades.
   */
  env.setTimes = (patch = {}, options = {}) => {
    env.times = clampTimes({ ...env.times, ...patch });
    const current = stage();
    if (current === ENV_STAGE.RELEASE && patch.release !== undefined && env.schedule) {
      // Re-schedule the release from where it has got to, over the new time.
      env.schedule.releaseFrom = valueAt(options.at ?? context.currentTime);
      env.schedule.releaseEnd = (options.at ?? context.currentTime) + env.times.release;
      writeRelease(options.at ?? context.currentTime);
    }
    return { ...env.times };
  };

  /**
   * The envelope's peak. Task 7's `ampLevel` destination writes here: a bias of
   * zero leaves the envelope alone, and a live envelope re-aims at the new peak
   * from wherever it is rather than jumping.
   */
  env.setPeak = (value, options = {}) => {
    env.peak = clampPeak(value);
    const at = Number.isFinite(options.at) ? options.at : context.currentTime;
    const current = stage();
    if (!param || current === ENV_STAGE.IDLE) return env.peak;
    if (options.ramp === false) {
      setNow(param, env.value(), context, { at });
    } else {
      holdAt(at);
      scheduleTo(current === ENV_STAGE.RELEASE ? 0 : env.peak, at + (options.seconds ?? 0.02));
    }
    return env.peak;
  };

  /** Forget the schedule. Bookkeeping only — it writes nothing to the graph. */
  env.reset = () => {
    env.schedule = null;
    return env;
  };

  env.stage = stage;
  env.value = () => valueAt(context.currentTime);
  env.valueAt = valueAt;
  env.state = () => ({
    stage: stage(),
    value: valueAt(context.currentTime),
    peak: env.peak,
    hasParam: Boolean(param),
    ...env.times,
  });

  return env;
}

/* -------------------------------------------------------- the store fan-out --- */

/** The voices the envelope keys are fanned out to. Bounded by the pool. */
const targets = new Set();

export function registerEnvelopeVoice(voice) {
  targets.add(voice);
  return () => targets.delete(voice);
}

export function envelopeVoiceTargets() {
  return [...targets];
}

/**
 * One store key -> every live voice, through `applyEnvelope`, which returns
 * false for a key this task does not own. Mirrors osc-mod.js: the engine does
 * not fan these out and is not edited to, because the voice re-reads the store
 * and decides what to do about it.
 */
export function bindEnvelopeModulation({ store = appStore, list = envelopeVoiceTargets } = {}) {
  const unsubscribes = [];
  for (const prefix of ['envAmp', 'envFilter']) {
    for (const name of ENV_KEYS) {
      const key = `${prefix}.${name}`;
      unsubscribes.push(
        store.subscribe(key, (_key, value) => {
          for (const voice of list()) {
            if (!voice.filters) continue;
            voice.applyEnvelope(prefix, name, value, { at: voice.context.currentTime });
          }
        }),
      );
    }
  }
  return () => {
    for (const off of unsubscribes) off();
  };
}

bindEnvelopeModulation();