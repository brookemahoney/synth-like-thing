/**
 * drum-fake-audio.mjs — the shared fake AudioContext (tests/voice-fake-audio.mjs)
 * plus what task 9's recipes need from it and it does not model.
 *
 * WHY A THIN EXTENSION RATHER THAN AN EDIT OF THE SHARED HARNESS
 *   tests/voice-fake-audio.mjs is used by the melodic voice tests and is being
 *   extended in parallel by task 6. Editing one file from two tasks at once is how
 *   a change gets lost, so the extra surface lives here and the shared harness stays
 *   untouched.
 *
 * ONE DEFINITION OF A FAKE NODE, NOT TWO
 *   A drum node is produced by calling the harness's OWN factory and then
 *   re-labelling it, so the connection list, the start/stop state machine, the
 *   `stop()`-twice error, the `ended` queue that `advance()` drains into `onended`, and
 *   the entry in `context.created` are all the harness's. Nothing about a node is
 *   re-implemented here.
 *
 * FOUR ADDITIONS, AND WHY EACH IS NEEDED
 *
 *   1. `createBiquadFilter()` and `createStereoPanner()`. Every 808 voice is filtered
 *      and every one is panned — `StereoPannerNode` is the kit's only positioning
 *      control, the plan has no width control — and the harness models neither.
 *
 *   2. `exponentialRampToValueAtTime` and `setTargetAtTime`. The shared harness's
 *      `AudioParam` implements a SUBSET of the real interface: enough to record that a
 *      value was scheduled, not enough to express every shape the real API accepts. The
 *      808 envelopes are exponential — that is what a struck object does — so the fake
 *      has to be able to express one. This is a gap in the fake, not a drum special
 *      case: any task that schedules an exponential ramp hits it.
 *
 *   3. `connect()` REFUSES a non-node. The shared harness's `connect` pushes whatever
 *      it is given, which is how a bug shipped past this suite once already: the kit
 *      connected its panner to `undefined`, the fake recorded a connection to nothing,
 *      all eleven voices threw on every trigger — and their trigger counters still
 *      incremented, because the counter increments before the graph is built. Every
 *      "this voice fired" assertion passed on a kit that made no sound at all. The
 *      browser caught it; the fake must too.
 *
 *   4. `firstWrite` on every AudioParam — the first value ever assigned to it. The
 *      shared harness's params overwrite `.value` with each scheduled event, so what a
 *      node was set to BEFORE anything was scheduled is otherwise unreadable. That
 *      distinction is the whole point: a GainNode starts at 1, and a scheduled write
 *      only lands AT its own time, so a layer silenced only by a scheduled event is
 *      wide open until then — audible, because the lookahead clock schedules every hit
 *      up to 100 ms ahead. This is how the suite now sees it.
 */

import { createFakeAudioContext } from './voice-fake-audio.mjs';

/** AudioParam methods a real param has and the shared harness's fake does not. */
const MISSING_PARAM_METHODS = {
  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
    return this;
  },
  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.events.push({ type: 'setTargetAtTime', value, time, constant });
    return this;
  },
};

/** Is this one of the harness's fake AudioParams? */
function isFakeParam(value) {
  return Boolean(value)
    && typeof value === 'object'
    && Array.isArray(value.events)
    && typeof value.setValueAtTime === 'function';
}

/** Is this something an AudioNode could be connected to? */
function isAudioNode(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.connections);
}

/** Record the FIRST value assigned to this param, scheduled or not. */
function captureFirstWrite(param) {
  if (param.firstWrite !== undefined) return param;
  let backing = param.value;
  let seen = false;
  Object.defineProperty(param, 'firstWrite', { value: undefined, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(param, 'value', {
    get: () => backing,
    set(next) {
      backing = next;
      if (!seen) {
        seen = true;
        param.firstWrite = next;
      }
    },
    enumerable: true,
    configurable: true,
  });
  return param;
}

/** Add the missing AudioParam methods, in place, keeping the one `events` array. */
function upgradeParams(node) {
  for (const value of Object.values(node)) {
    if (!isFakeParam(value)) continue;
    captureFirstWrite(value);
    for (const [name, method] of Object.entries(MISSING_PARAM_METHODS)) {
      if (typeof value[name] === 'function') continue;
      Object.defineProperty(value, name, { value: method, writable: true, configurable: true });
    }
  }
  return node;
}

/** Make `connect` refuse a non-node, as the real `AudioNode.connect` does. */
function enforceConnect(node) {
  const original = node.connect;
  node.connect = function connect(destination, ...rest) {
    if (!isAudioNode(destination)) {
      throw new TypeError(`fake AudioNode.connect: ${String(destination)} is not an AudioNode`);
    }
    return original.call(node, destination, ...rest);
  };
  return node;
}

const prepare = (node) => enforceConnect(upgradeParams(node));

/** A fresh fake AudioParam with the full method set and the harness's `events`. */
function seededParam(initial) {
  return upgradeParams({
    value: initial,
    events: [],
    setValueAtTime(value, time) {
      this.value = value;
      this.events.push({ type: 'setValueAtTime', value, time });
      return this;
    },
    linearRampToValueAtTime(value, time) {
      this.value = value;
      this.events.push({ type: 'linearRampToValueAtTime', value, time });
      return this;
    },
    cancelScheduledValues(time) {
      this.events.push({ type: 'cancelScheduledValues', time });
      return this;
    },
    cancelAndHoldAtTime(time) {
      this.events.push({ type: 'cancelAndHoldAtTime', time });
      return this;
    },
  });
}

/** A harness gain node, re-labelled: same lifecycle, extra params. */
function asKind(context, kind) {
  return prepare(Object.assign(context.createGain(), { kind }));
}

/**
 * The shared harness's context plus `createBiquadFilter` and `createStereoPanner`, with
 * every AudioParam given the full method set and a `firstWrite` record. Same options as
 * the harness.
 */
export function createDrumFakeAudioContext(options = {}) {
  const context = createFakeAudioContext(options);

  // The template proves the harness still hands back nodes with the properties the drum
  // tests read. If the harness is refactored away from them, this fails loudly here
  // instead of silently producing meaningless assertions.
  const template = asKind(context, 'template');
  if (!Array.isArray(template.connections) || typeof template.stop !== 'function') {
    throw new Error('drum-fake-audio: the shared harness node contract changed');
  }
  if (!isAudioNode(template)) throw new Error('drum-fake-audio: isAudioNode no longer recognises a harness node');

  // Prepare the harness's own factories, so every param it made is complete rather than
  // only the ones this file adds.
  for (const factory of ['createGain', 'createConstantSource', 'createOscillator', 'createBufferSource']) {
    const original = context[factory].bind(context);
    context[factory] = () => prepare(original());
  }

  context.createBiquadFilter = () => {
    const node = asKind(context, 'biquad');
    node.type = 'lowpass';
    node.frequency = seededParam(350);
    node.detune = seededParam(0);
    node.Q = seededParam(1);
    node.gain = seededParam(0);
    return node;
  };

  context.createStereoPanner = () => {
    const node = asKind(context, 'stereoPanner');
    node.pan = seededParam(0);
    return node;
  };

  return context;
}

export { createFakeAudioContext };