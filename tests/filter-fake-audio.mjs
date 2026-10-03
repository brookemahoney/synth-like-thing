/**
 * filter-fake-audio.mjs — the shared fake AudioContext plus the two node
 * factories the filter bank needs, PLUS a param that actually interpolates.
 *
 * WHY A THIRD FILE AND NOT AN EDIT
 *   tests/voice-fake-audio.mjs is the voice engine's harness and
 *   tests/effects-fake-audio.mjs belongs to the effects chain; both are being
 *   used by tasks running in parallel. This harness *builds on* the shared one
 *   and adds to it. Nothing in either existing harness is modified.
 *
 * WHY THIS ONE INTERPOLATES
 *   The shared harness deliberately cheats: a scheduled
 *   `linearRampToValueAtTime` sets `param.value` immediately, because a real
 *   param cannot be waited out in a unit test. That cheat is fine for "was a
 *   ramp scheduled, and what did it target", and fatal for an ADSR — an
 *   envelope is defined by where its value is *between* events, and "release
 *   from wherever the envelope currently is" is exactly such a claim.
 *
 *   So this harness's params keep the event list and answer `value` by
 *   evaluating it at `context.currentTime`, the way a browser does:
 *
 *     - setValueAtTime(v, t)      a step to v, held until the next event
 *     - linearRampToValueAtTime   a straight line from the previous value
 *     - exponentialRampToValueAtTime / setTargetAtTime
 *     - cancelScheduledValues(t)  drop everything after t
 *     - cancelAndHoldAtTime(t)    pin the CURRENT value at t, then drop the rest
 *
 *   `events` is still recorded, so tests can assert on what was scheduled as
 *   well as on what it sounds like afterwards.
 */

import { createFakeAudioContext } from './voice-fake-audio.mjs';

/**
 * An AudioParam that evaluates its event list at a given time.
 * `at(time)` is the value; `value` is the value at `clock()`.
 */
function makeInterpolatingParam(clock, initial) {
  let schedule = [{ type: 'set', time: 0, value: initial }];

  /** The value the automation has reached at `time`, ignoring later events. */
  function at(time) {
    let value = initial;
    for (const event of schedule) {
      if (event.type === 'set') {
        if (event.time > time) break;
        value = event.value;
      } else if (event.type === 'target') {
        if (event.time > time) break;
        const elapsed = Math.max(0, time - event.time);
        value = event.value + (event.from - event.value) * 2 ** (-elapsed / event.constant);
      } else if (event.type === 'linear') {
        // A ramp that SPANS `time` is evaluated there; only a ramp that has not
        // started yet is ignored. Getting this backwards is what makes an
        // envelope look like it jumps from zero to its end point.
        if (event.time <= time) {
          value = event.value;
          continue;
        }
        const span = event.time - event.fromTime;
        const k = span <= 0 ? 1 : (time - event.fromTime) / span;
        return event.from + (event.value - event.from) * Math.min(Math.max(k, 0), 1);
      } else if (event.type === 'exponential') {
        if (event.time <= time) {
          value = event.value;
          continue;
        }
        const span = event.time - event.fromTime;
        const k = span <= 0 ? 1 : (time - event.fromTime) / span;
        const from = Math.abs(event.from) < 1e-9 ? 1e-9 * Math.sign(event.from || 1) : event.from;
        return Math.sign(event.value || 1) * Math.abs(from) * (Math.abs(event.value) / Math.abs(from)) ** k;
      }
    }
    return value;
  }

  /** Where the automation was when `time` was reached — for a hold. */
  function holdAt(time) {
    const value = at(time);
    schedule = schedule.filter((event) => event.time <= time);
    schedule.push({ type: 'set', time, value });
    return value;
  }

  /** Where the automation was when `time` was reached. A new ramp starts from
   *  THIS, which is why it cannot be a "last set value" lookup: the previous
   *  segment is usually a ramp that ENDS at that instant. */
  function lastValueAt(time) {
    return at(time);
  }

  const param = {
    events: [],
    /** Recorded so a test can assert the shape of the schedule, not just its end. */
    scheduled: schedule,
    valueAt: at,
    at(time) {
      return at(time);
    },
    /** The live schedule, for a test that needs to see what is still pending. */
    dump: () => schedule.map((event) => ({ ...event })),
    setValueAtTime(value, time) {
      schedule.push({ type: 'set', time, value });
      param.events.push({ type: 'setValueAtTime', value, time });
      return param;
    },
    linearRampToValueAtTime(value, time) {
      const fromTime = schedule.length ? schedule[schedule.length - 1].time : 0;
      schedule.push({ type: 'linear', time, value, from: lastValueAt(fromTime), fromTime });
      param.events.push({ type: 'linearRampToValueAtTime', value, time });
      return param;
    },
    exponentialRampToValueAtTime(value, time) {
      const fromTime = schedule.length ? schedule[schedule.length - 1].time : 0;
      schedule.push({ type: 'exponential', time, value, from: lastValueAt(fromTime), fromTime });
      param.events.push({ type: 'exponentialRampToValueAtTime', value, time });
      return param;
    },
    setTargetAtTime(value, time, constant) {
      const fromTime = schedule.length ? schedule[schedule.length - 1].time : 0;
      schedule.push({ type: 'target', time, value, constant, from: lastValueAt(fromTime) });
      param.events.push({ type: 'setTargetAtTime', value, time, constant });
      return param;
    },
    cancelScheduledValues(time) {
      schedule = schedule.filter((event) => event.time <= time);
      param.events.push({ type: 'cancelScheduledValues', time });
      return param;
    },
    cancelAndHoldAtTime(time) {
      const held = holdAt(time);
      param.events.push({ type: 'cancelAndHoldAtTime', time, value: held });
      return param;
    },
  };

  Object.defineProperty(param, 'value', {
    get: () => at(clock()),
    set: (next) => {
      schedule = [{ type: 'set', time: 0, value: next }];
    },
    enumerable: true,
  });

  return param;
}

/** The fake context, with biquads, shapers, and an interpolating `value`. */
export function createFakeFilterContext({ sampleRate = 48000, now = 0 } = {}) {
  const context = createFakeAudioContext({ sampleRate, now });
  const clock = () => context.currentTime;
  const param = (initial) => makeInterpolatingParam(clock, initial);

  /** Replace a factory's params with interpolating ones. */
  const reparam = (node, extras) => {
    for (const [name, initial] of Object.entries(extras)) node[name] = param(initial);
    return node;
  };

  const makeGain = context.createGain;
  context.createGain = () => {
    const node = makeGain();
    node.gain = param(node.gain.value);
    return node;
  };

  const makeConstantSource = context.createConstantSource;
  context.createConstantSource = () => {
    const node = makeConstantSource();
    node.offset = param(node.offset.value);
    return node;
  };

  const makeOscillator = context.createOscillator;
  context.createOscillator = () => {
    const node = makeOscillator();
    return reparam(node, { frequency: 440, detune: 0 });
  };

  const makeBufferSource = context.createBufferSource;
  context.createBufferSource = () => {
    const node = makeBufferSource();
    return reparam(node, { playbackRate: 1 });
  };

  context.createBiquadFilter = () => {
    const node = makeGain();
    node.kind = 'biquad';
    node.type = 'lowpass';
    return reparam(node, { frequency: 350, detune: 0, Q: 1, gain: 0 });
  };

  context.createWaveShaper = () => {
    const node = makeGain();
    node.kind = 'waveShaper';
    node.curve = null;
    node.oversample = 'none';
    return node;
  };

  return context;
}
