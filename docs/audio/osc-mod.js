/**
 * osc-mod.js — the three cross-oscillator mechanisms: FM, ring modulation and
 * unison. Their arithmetic, their two small graph objects, and the store
 * fan-out that gets a control move onto every voice that is sounding.
 *
 * WHAT IS HERE AND WHY IT IS NOT IN voice.js
 *   voice.js owns a voice's lifecycle: note on, note off, teardown. Everything in
 *   this file is per-core MECHANISM with no lifecycle of its own — the mapping
 *   from a control value to a number, and the two routing objects that own a
 *   connection. Keeping them separate is what lets the distribution, the depth
 *   mapping and the re-routing discipline be tested without building a voice
 *   (tests/osc-mod.test.mjs), and it keeps the "one disconnection ends a voice"
 *   rule in voice.js uncontaminated by routing logic.
 *
 * THE THREE MECHANISMS
 *
 *   FM     A modulator core's signal is scaled by a DEPTH GAIN and summed into
 *          the carrier core's `ConstantSourceNode.offset` — the same signal the
 *          note writes, so FM is a pitch excursion on top of the pitch, not a
 *          second pitch path. Depth is a DEVIATION RATIO in hertz: the peak
 *          deviation is `amount x FM_MAX_INDEX x modulatorHz`. See
 *          `fmDeviationHz` for why it is not a fixed fraction of the carrier.
 *
 *   RING   `a * b` is one gain node with `gain.value = 0`, one signal in its
 *          audio input and the other summed into its gain PARAM — the standard
 *          Web Audio ring modulator. The product feeds the voice's ring bus,
 *          which is at zero whenever no pair is assigned. The assignment is
 *          ADDITIVE: the partner core still feeds the mixer directly.
 *
 *   UNISON N detuned copies of a core, spread symmetrically around the centre
 *          pitch by the spread control. One 1/N summing gain per core keeps the
 *          level independent of the count.
 *
 * THE ONE TAP RULE
 *   A modulator — the FM modulator and BOTH signals of a ring pair alike — is
 *   taken from the core's RAW bus, which is the sum of that core's oscillators
 *   BEFORE its level fader. So a level fader means exactly one thing: this
 *   core's direct contribution to the mixer. That is what makes ring modulation
 *   additive (silencing a modulator's level removes its dry path and leaves the
 *   product running) and what makes an FM depth predictable (it is a function of
 *   the modulator's pitch, not of its fader).
 *
 * THE STORE FAN-OUT
 *   The engine (engine.js) fans out the level and pitch keys, and it does not own
 *   these five keys, so the fan-out for them lives here: `createVoice()`
 *   registers each voice with `registerVoice`, and the subscription at the bottom
 *   of this module routes every `osc{n}.fmAmount|fmSource|unison|unisonSpread|
 *   ringMod` write to every registered voice that has been built. One
 *   subscription, bounded by the sixteen-voice pool — not one per voice.
 *
 *   API
 *     clampUnisonCount / clampUnisonSpread / clampFmAmount
 *     unisonDetuneCents(count, spread)        the documented distribution
 *     unisonCentreIndex / unisonCopyCents / unisonCentreCents
 *     unisonSumGain(count)                    1/N
 *     fmSourceIndex(name)                     'osc2' -> 1, 'none' -> -1
 *     fmDeviationHz(amount, modulatorHz)      the depth mapping, in hertz
 *     ringPartnerIndex(core, name, coreCount) the one pair, or -1
 *     fmRouter(context, pitchSource)          the FM routing object
 *     ringRouter(context, bus, coreIndex)     the ring routing object
 *     registerVoice / modTargets / bindOscModulation
 *
 *   Constants: CORE_COUNT UNISON_MIN UNISON_MAX FM_MAX_INDEX SPREAD_MAX_CENTS
 *              RING_BUS_LEVEL MOD_KEYS
 */

import { createGain } from './nodes.js';
import { rampTo, setNow } from './automation.js';
import { store as appStore } from '../ui/params.js';

export const CORE_COUNT = 3;

/** The unison count the control offers. */
export const UNISON_MIN = 1;
export const UNISON_MAX = 7;

/**
 * The FM deviation ratio at 100% amount: the peak deviation is this many times
 * the MODULATOR's own frequency. At an index of 1 the deviation is one modulator
 * period, which is the classic two-operator FM tone; by 4..8 it is bell-like.
 * Chosen as a ratio rather than as a fixed number of cents precisely so that the
 * FM source selection is audible — see `fmDeviationHz`.
 */
export const FM_MAX_INDEX = 8;

/** The spread control's range, matching the `osc{n}.unisonSpread` schema entry. */
export const SPREAD_MAX_CENTS = 50;

/** The ring bus level while at least one pair is assigned. Zero otherwise. */
export const RING_BUS_LEVEL = 1;

/** The five keys per core this module fans out. */
export const MOD_KEYS = ['fmAmount', 'fmSource', 'unison', 'unisonSpread', 'ringMod'];

/* ----------------------------------------------------------------- clamps --- */

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Unison count, clamped to the control's integer 1..7. */
export function clampUnisonCount(value) {
  const n = Math.round(num(value, UNISON_MIN));
  if (n < UNISON_MIN) return UNISON_MIN;
  if (n > UNISON_MAX) return UNISON_MAX;
  return n;
}

/** Unison spread in cents, clamped to the control's 0..50. */
export function clampUnisonSpread(value) {
  const n = num(value, 0);
  if (n < 0) return 0;
  if (n > SPREAD_MAX_CENTS) return SPREAD_MAX_CENTS;
  return n;
}

/** FM amount, clamped to the control's 0..1. */
export function clampFmAmount(value) {
  const n = num(value, 0);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/* ------------------------------------------------------------------ unison --- */

/**
 * THE DISTRIBUTION. `count` detunes, evenly spaced, symmetrically around zero,
 * with the two extremes exactly at -spread and +spread. One voice is 0 — a
 * spread control has nothing to spread when there is nothing to spread. An odd
 * count therefore has one voice exactly on the centre pitch, and the step is
 * `2 * spread / (count - 1)`.
 *
 *   count 7, spread 50 -> -50, -33.33, -16.67, 0, +16.67, +33.33, +50
 *   count 3, spread 24 -> -24, 0, +24
 */
export function unisonDetuneCents(count, spreadCents) {
  const n = clampUnisonCount(count);
  const spread = clampUnisonSpread(spreadCents);
  if (n === 1) return [0];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(-spread + (2 * spread * i) / (n - 1));
  return out;
}

/**
 * Which of the `count` slots the core's OWN oscillator takes: the middle one for
 * an odd count, the upper-middle for an even count. Keeping the centre pitch on
 * the core's own voice is what makes the group sound centred rather than
 * lopsided once the copies take the remaining slots.
 */
export function unisonCentreIndex(count) {
  return Math.floor(clampUnisonCount(count) / 2);
}

/** The detune of the core's own oscillator for a group of `count` voices. */
export function unisonCentreCents(count, spreadCents) {
  return unisonDetuneCents(count, spreadCents)[unisonCentreIndex(count)];
}

/**
 * The detune of one unison COPY. `copyIndex` is 0..count-2, in ascending order,
 * and the copy takes the distribution entry either side of the centre slot — so
 * the copies come out symmetric even though the core's own voice owns the middle.
 */
export function unisonCopyCents(count, spreadCents, copyIndex) {
  const n = clampUnisonCount(count);
  const k = Math.round(num(copyIndex, -1));
  if (k < 0 || k > n - 2) return 0;
  const cents = unisonDetuneCents(n, spreadCents);
  const centre = unisonCentreIndex(n);
  return cents[k < centre ? k : k + 1];
}

/** The gain a core's unison summing bus carries: one voice worth of level. */
export function unisonSumGain(count) {
  return 1 / clampUnisonCount(count);
}

/* ---------------------------------------------------------------------- FM --- */

const SOURCE_INDEX = { osc1: 0, osc2: 1, osc3: 2 };

/**
 * Which core a modulator name means. 'none' — and any name this voice does not
 * have — is -1, i.e. no modulator, rather than an error. A core MAY name itself:
 * that is feedback FM, and the depth gain in the loop puts a node between the
 * output and the pitch param, so the cycle still has a render quantum of delay.
 */
export function fmSourceIndex(name) {
  const index = SOURCE_INDEX[String(name)];
  return index === undefined ? -1 : index;
}

/**
 * THE DEPTH MAPPING, in hertz.
 *
 * `deviationHz = amount * FM_MAX_INDEX * modulatorHz`
 *
 * The alternative — a fixed number of cents of the CARRIER's pitch — is simpler
 * and was rejected: under it, turning the modulator's octave switch changes
 * nothing you can hear, so the FM source selection would be cosmetic and the
 * plan's "the source selection is real" criterion would be unfalsifiable. Tying
 * the deviation to the modulator's own pitch is the classic FM deviation ratio
 * (index = deviation / modulator frequency), it makes a fifth up in the
 * modulator widen the carrier's excursion by the same fifth, and it is
 * self-limiting: the depth is proportional to a frequency the voice is already
 * playing rather than to a raw knob value.
 *
 * A depth of 0 means no depth, whatever is connected: the gain is what is
 * ramped, so an assigned-but-zero modulator is silent rather than merely quiet.
 */
export function fmDeviationHz(amount, modulatorHz, { maxIndex = FM_MAX_INDEX } = {}) {
  const a = clampFmAmount(amount);
  if (a === 0) return 0;
  const hz = num(modulatorHz, 0);
  if (hz <= 0) return 0;
  return a * maxIndex * hz;
}

/* -------------------------------------------------------------------- ring --- */

/**
 * THE ONE PAIR. `osc{n}.ringMod = 'osc{m}'` means core n's signal is the
 * carrier and core m's is the modulator; the product is the same either way, so
 * the choice is only about which core's control owns the assignment. A core may
 * not pair with itself — that is a signal squared, not a ring modulator — and a
 * name outside this voice is no pair at all.
 */
export function ringPartnerIndex(coreIndex, name, coreCount = CORE_COUNT) {
  const partner = fmSourceIndex(name);
  if (partner < 0) return -1;
  if (partner === coreIndex) return -1;
  if (partner >= coreCount) return -1;
  return partner;
}

const dropConnection = (node, destination) => {
  try {
    node.disconnect(destination);
  } catch {
    /* already disconnected, or a param this node never had */
  }
};

/* -------------------------------------------------------------- the FM router --- */

/**
 * Owns one core's frequency-modulation depth gain and the one modulator
 * connection into it.
 *
 * The depth gain is connected to the carrier's pitch param ONCE, when it is
 * first needed, and is never disconnected: it is a member of the voice's
 * subtree, and the teardown that matters is the one at `entry`. What DOES come
 * and go is the modulator, and `apply` always cuts the previous one before
 * taking a new one, so a hundred source changes leave exactly one connection.
 */
export function fmRouter(context, pitchSource, { label = 'fm-depth' } = {}) {
  let node = null;
  let modulator = null;
  let sourceIndex = -1;
  let amount = 0;
  let deviationHz = 0;

  function ensureNode() {
    if (node) return node;
    node = createGain(context, label);
    setNow(node.gain, 0, context, { at: context.currentTime });
    // The depth, in hertz, is summed into the same signal the note writes.
    node.connect(pitchSource.offset);
    return node;
  }

  return {
    get node() {
      return node;
    },
    /** The live modulator, for assertions and the runtime handle. */
    get modulator() {
      return modulator;
    },
    /**
     * Route and set the depth. Every field is optional; omitted modulator means
     * "no modulator", which disconnects whatever was there.
     */
    apply({
      modulator: nextModulator = null,
      index = -1,
      amount: nextAmount = 0,
      modulatorHz = 0,
      at,
      ramp = true,
      seconds,
    } = {}) {
      amount = clampFmAmount(nextAmount);
      // Nothing to modulate and no node yet: build nothing. A patch that never
      // uses frequency modulation should not carry three depth gains per voice.
      if (!nextModulator && !node) {
        sourceIndex = -1;
        deviationHz = 0;
        return 0;
      }
      if (nextModulator) ensureNode();
      if (nextModulator !== modulator || index !== sourceIndex) {
        // The modulator's OUTPUT is an input of the depth gain. Connecting it the
        // other way round is the easy mistake here: the depth gain would then have
        // no input at all, and the graph would look right in a connection list.
        if (modulator) dropConnection(modulator, node);
        modulator = nextModulator;
        sourceIndex = index;
        if (modulator) modulator.connect(node);
      }
      deviationHz = modulator && index >= 0 ? fmDeviationHz(amount, modulatorHz) : 0;
      if (ramp) rampTo(node.gain, deviationHz, context, { at, seconds });
      else setNow(node.gain, deviationHz, context, { at });
      return deviationHz;
    },
    state() {
      return {
        connected: modulator !== null,
        sourceIndex,
        modulator,
        amount,
        index: modulator ? amount * FM_MAX_INDEX : 0,
        deviationHz,
      };
    },
  };
}

/* ------------------------------------------------------------ the ring router --- */

/**
 * Owns one core's ring-modulator product node. There is at most one product per
 * core, so an assignment is a re-route of two connections rather than a second
 * node: that is what keeps the tally flat when the assignment is changed
 * mid-note a hundred times.
 *
 * The node's own gain stays at 0 for its whole life, because that 0 is what
 * makes `input x (0 + modulator)` a PRODUCT. Turning the pair off is a
 * disconnect; the bus level is the voice's business.
 */
export function ringRouter(context, bus, coreIndex, { label = 'ring-product' } = {}) {
  let node = null;
  let carrier = null;
  let modulator = null;
  let partner = -1;

  function ensureNode() {
    if (node) return node;
    node = createGain(context, label);
    setNow(node.gain, 0, context, { at: context.currentTime });
    node.connect(bus);
    return node;
  }

  function detach() {
    if (node) {
      // Disconnect from the SOURCE node, not the product: `disconnect(destination)`
      // only removes that one edge, and `product.disconnect()` with no argument
      // would cut the product's own output to the bus as well.
      if (carrier) dropConnection(carrier, node);
      if (modulator) dropConnection(modulator, node.gain);
    }
    carrier = null;
    modulator = null;
    partner = -1;
  }

  return {
    get node() {
      return node;
    },
    get carrier() {
      return carrier;
    },
    get modulator() {
      return modulator;
    },
    apply({ carrier: nextCarrier = null, modulator: nextModulator = null, partner: nextPartner = -1, on = false } = {}) {
      if (!on || !nextCarrier || !nextModulator) {
        detach();
        return false;
      }
      ensureNode();
      // Same direction trap as the FM router: the carrier is an INPUT of the
      // product. `node.connect(carrier)` would send the product into the carrier
      // and leave the product with nothing to multiply.
      if (carrier !== nextCarrier) {
        if (carrier) dropConnection(carrier, node);
        nextCarrier.connect(node);
        carrier = nextCarrier;
      }
      if (modulator !== nextModulator) {
        if (modulator) dropConnection(modulator, node.gain);
        nextModulator.connect(node.gain);
        modulator = nextModulator;
      }
      partner = nextPartner;
      return true;
    },
    detach,
    state() {
      return { coreIndex, hasNode: node !== null, active: node !== null && partner >= 0, partner, carrier, modulator };
    },
  };
}

/* --------------------------------------------------------- the store fan-out --- */

/** The voices the FM / unison / ring keys are fanned out to. Bounded by the pool. */
const targets = new Set();

export function registerVoice(voice) {
  targets.add(voice);
  return () => targets.delete(voice);
}

export function modTargets() {
  return [...targets];
}

/**
 * One store key -> every live voice. The voice re-reads the store for itself,
 * so the subscribed value is the authority on what changed and the voice decides
 * what to do about it; `applyCoreModulation` is the one door, and it returns
 * false for a key this task does not own.
 */
export function bindOscModulation({ store = appStore, list = modTargets } = {}) {
  const unsubscribes = [];
  for (let core = 0; core < CORE_COUNT; core += 1) {
    for (const name of MOD_KEYS) {
      const key = `osc${core + 1}.${name}`;
      unsubscribes.push(
        store.subscribe(key, (_key, value) => {
          for (const voice of list()) {
            if (!voice.cores) continue;
            voice.applyCoreModulation(core, key, value, { at: voice.context.currentTime });
          }
        }),
      );
    }
  }
  return () => {
    for (const off of unsubscribes) off();
  };
}

// The app-wide binding, established once at import. voice.js imports this module,
// and engine.js imports voice.js, so importing the engine is enough — which is
// why this does not have to be wired from main.js, and why the engine's own
// fan-out is left exactly as task 3 wrote it.
bindOscModulation();
