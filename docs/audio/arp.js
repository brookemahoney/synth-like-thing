/**
 * arp.js — THE ARPEGGIATOR'S ORDERING AND ITS TEMPO-SYNCED RATE. Pure arithmetic.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM THE AUDIO GRAPH
 *   Same reason as `clock.js` and `drum-kit.js`: everything the module decides — which
 *   note comes next, in which order, at what beat — is arithmetic over a chord and a
 *   tempo, so tests/arp.test.mjs can assert all five modes and all six rates with no
 *   browser and no audio device. `sequencer-run.js` is what binds it to the clock and
 *   the note path.
 *
 * THE RATE PROBLEM, AND WHY SLOTS ARE COUNTED IN BEATS
 *   The clock's grid is sixteenths: sixteen steps to a bar, four to a beat. A tempo-synced
 *   arpeggiator rate can be any of six divisions, and two of them — `1/8T` and `1/16T` —
 *   are triplets, which are NOT on that grid at all. `1/8T` is three notes per beat,
 *   i.e. one note every 1/3 of a beat, i.e. every 0.75 of a sixteenth.
 *
 *   A step counter cannot express 0.75. What it CAN do is say where a step sits in
 *   beats: the clock's event carries `absoluteStep`, so `absoluteStep / stepsPerBeat` is
 *   the absolute beat position, and a note's beat position is `k * intervalBeats` for an
 *   integer slot index `k`. `arpSlotsForStep` returns exactly the `k` values that fall in
 *   the half-open beat range `[stepBeats, stepBeats + 1/stepsPerBeat)`, and
 *   `arpSlotBeats` turns one into a time. So the arpeggiator places its notes at exact
 *   absolute positions on the beat grid, derived from the clock's own step times, and a
 *   triplet is uniformly spaced in TIME even though the grid it rides on is sixteenths.
 *   There is no accumulator and therefore no drift: slot `k` is at the same beat in bar
 *   1,000 as in bar 1.
 *
 *   `1/16` is the degenerate case that proves the arithmetic agrees with the clock: one
 *   slot per step, at exactly the step's own grid time.
 *
 * SWING AND THE ARPEGGIATOR
 *   Swing is the clock's, not this module's: `clock.js` publishes `swung` per event, and
 *   the runner adds it to every slot time it computes inside that step. The consequence
 *   is deliberate and is documented at the call site in `sequencer-run.js` — an arp
 *   division rides on the swung grid rather than replacing it, so an eighth-note arp at
 *   75% swing is still swung, and a triplet is swung by the same sixteenth-level offset
 *   as everything else on the bar.
 *
 * RANDOM IS SEEDED, AND THAT IS THE POINT
 *   `Math.random()` is the default source, so a playing instrument's Random mode really
 *   is different on every cycle. But an unverifiable random mode is a validation trap, so
 *   the RNG is an injected argument: `mulberry32(seed)` gives a stream that is exactly
 *   reproducible, and `createArpRandom(seed)` wires one. tests/arp.test.mjs asserts an
 *   exact sequence from a fixed seed, the live page asserts the invariants (every fired
 *   note is a member of the pool, more than one note appears), and the runner logs every
 *   firing so the ordering is readable at runtime.
 *
 * The public surface:
 *   ARP_RATE_BEATS               beats per note, per sync rate
 *   ARP_MODE_ORDER               the five modes, in schema order
 *   arpIntervalBeats(rate)       the division, with a sixteenth fallback
 *   arpSlotsForStep({...})       the slot indices firing inside one grid step
 *   arpSlotBeats(k, intervalBeats)  a slot's position in beats from the bar's origin
 *   arpPool(notes, {octaves})    the chord spread over its octave range
 *   arpOrder(mode, notes, opts)  a whole cycle of notes — the verification primitive
 *   createArpCursor(mode)        the stateful walker the runner uses
 *   mulberry32(seed) / createArpRandom(seed)
 */

import { ARP_MODES, SYNC_RATES } from '../ui/params.js';

export { ARP_MODES, SYNC_RATES };

/** The five modes, in the order the schema declares them. */
export const ARP_MODE_ORDER = [...ARP_MODES];

/**
 * BEATS PER NOTE, per sync rate. The two triplets are two thirds of their straight
 * parent, which is the definition of a triplet: three notes in the time of two.
 *
 * `1/4` is one beat, `1/32` an eighth of a beat, so the fastest rate is exactly eight
 * times the slowest — a whole-number ratio of notes per bar (4 .. 32), never a fraction
 * that a step counter would have to accumulate.
 */
export const ARP_RATE_BEATS = Object.freeze({
  '1/4': 1,
  '1/8': 0.5,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
});

/** The fallback for an unknown rate. A sixteenth, never zero: a zero interval would
 *  schedule an unbounded number of notes inside a single step. */
export const ARP_FALLBACK_RATE = '1/16';

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

/** Beats per arpeggiator note at this rate. Unknown or missing -> a sixteenth. */
export function arpIntervalBeats(rate) {
  const interval = ARP_RATE_BEATS[rate];
  return Number.isFinite(interval) ? interval : ARP_RATE_BEATS[ARP_FALLBACK_RATE];
}

/**
 * A beats value from either spelling: a rate NAME ('1/8T') or an already-resolved
 * number. Every function below takes this rather than a bare number, so a caller can
 * pass `store.get('arp.rate')` straight through without resolving it first — and
 * cannot accidentally resolve it twice, which would silently fall back to a sixteenth.
 */
function resolveInterval(value) {
  if (typeof value === 'string') return arpIntervalBeats(value);
  const n = finite(value, Number.NaN);
  return Number.isFinite(n) && n > 0 ? n : ARP_RATE_BEATS[ARP_FALLBACK_RATE];
}

/**
 * THE SCALE EVERYTHING BELOW IS COUNTED IN: 1/24 of a beat.
 *
 * A step's beat position and a note's beat position both have to be compared for
 * equality — "is this slot exactly on this step's boundary?" — and in floating point
 * `3 * (1/3)` is not always `1`. Counting in twenty-fourths makes every declared rate
 * exact (1/8 = 3/24, 1/8T = 8/24, 1/16 = 6/24, 1/16T = 4/24, 1/32 = 3/24, 1/4 = 24/24)
 * and makes a sixteenth step exactly six units wide, so the boundary case is decided by
 * integer comparison instead of by an epsilon. This is the difference between an
 * arpeggiator that fires twelve notes a bar at 1/8T and one that fires sixteen.
 */
export const ARP_UNIT = 24;

/**
 * The slot indices that fire inside one grid step.
 *
 * A step covers the half-open beat range `[b, b + span)` where `b = absoluteStep /
 * stepsPerBeat` and `span = 1 / stepsPerBeat`. Slot `k` is at `k * intervalBeats`, so
 * the answer is every integer `k` with `b <= k*interval < b + span` — in units of
 * 1/24 beat that is every `k` with `start <= k*intervalUnits < end`.
 *
 * A slot that lands exactly on a step's boundary belongs to the LATER step, so a note is
 * never fired twice and never twice inside the same bar.
 *
 * `absoluteStep` never wraps (that is the clock's contract — `step` wraps, this does
 * not), so slot numbers stay monotonic across bars and the pattern repeats exactly.
 */
export function arpSlotsForStep({ absoluteStep = 0, stepsPerBeat = 4, intervalBeats = ARP_FALLBACK_RATE } = {}) {
  const perBeat = Math.max(1, Math.round(finite(stepsPerBeat, 4)));
  const intervalUnits = Math.max(1, Math.round(resolveInterval(intervalBeats) * ARP_UNIT));
  const width = Math.max(1, Math.round(ARP_UNIT / perBeat));
  const start = Math.round(finite(absoluteStep, 0)) * width;
  const end = start + width;
  const slots = [];
  for (let k = Math.ceil(start / intervalUnits); k * intervalUnits < end && slots.length < 64; k += 1) {
    slots.push(k);
  }
  return slots;
}

/** A slot's position in beats from the bar's grid origin. */
export function arpSlotBeats(slot, intervalBeats = ARP_FALLBACK_RATE) {
  return finite(slot) * resolveInterval(intervalBeats);
}

/* -------------------------------------------------------------------- the pool --- */

const clampNote = (n) => Math.max(0, Math.min(127, Math.round(finite(n, 60))));

/**
 * The held notes, deduplicated, clamped, and — for every mode except As-Play — sorted.
 *
 * As-Play is the one mode whose ORDER IS DATA, so its list is left in press order. That
 * is why a chord played as C E G and one played as G E C arpeggiate identically in Up
 * and oppositely in As-Play.
 */
function orderedNotes(notes, preserveOrder) {
  const list = Array.isArray(notes) ? notes : [];
  /* A held-note RECORD is accepted as well as a bare MIDI number, because the keyboard's
     registry publishes records and a probe may publish numbers — and because the melodic
     lane's gathered steps are records too. One spelling here means the two sources cannot
     disagree about what a note is. */
  const values = list
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.note : entry))
    .filter((n) => Number.isFinite(Number(n)))
    .map(clampNote);
  const base = [...new Set(values)];
  return preserveOrder ? base : base.sort((a, b) => a - b);
}

/** The declared octave range: 1..4, as the schema declares it. */
function spreadOf(octaves) {
  return Math.max(1, Math.min(4, Math.round(finite(octaves, 1))));
}

/**
 * The notes the arpeggiator walks, each with the VELOCITY of the note it came from — so a
 * quiet held key stays quiet an octave up, and a lane's accent survives being arpeggiated.
 *
 * `source` is the original held or lane note the entry was derived from, which is what
 * `velocity` is asked about: the octaves above a note are the same note's accent, not a
 * new one.
 *
 * A note above 108 has no octave above it inside 127, so the upper octaves are simply
 * clipped. That is a MIDI-range fact, not a special case.
 */
export function arpVoices(notes, { octaves = 1, preserveOrder = false, velocity } = {}) {
  const ordered = orderedNotes(notes, preserveOrder);
  if (ordered.length === 0) return [];
  const spread = spreadOf(octaves);
  const velOf = typeof velocity === 'function' ? velocity : () => 0.8;
  const voices = [];
  for (let octave = 0; octave < spread; octave += 1) {
    for (const note of ordered) {
      const shifted = note + 12 * octave;
      if (shifted > 127) continue;
      voices.push({ note: shifted, source: note, velocity: velOf(note) });
    }
  }
  return voices;
}

/**
 * The notes as bare MIDI numbers — the same list `arpVoices` builds, without the velocity.
 * A note above 108 has no octave above it inside 127.
 */
export function arpPool(notes, { octaves = 1, preserveOrder = false } = {}) {
  return arpVoices(notes, { octaves, preserveOrder }).map((voice) => voice.note);
}

/* ------------------------------------------------------------------- the order --- */

/**
 * The INDEX CYCLE for a mode over a pool of `length` notes. Every mode except Random is
 * a fixed walk, so it is built once and indexed modulo its length.
 *
 *   up        0 1 2 ... n-1
 *   down      n-1 ... 1 0
 *   updown    0 1 ... n-1 n-2 ... 1     — turns round at both ends, repeats neither
 *   asplay    0 1 ... n-1               — the pool is already in press order
 *
 * One note and two notes are the degenerate cases worth stating: Up-Down on a single
 * note is that note, and on a pair it is the pair (there is nowhere to turn round to).
 */
function cycleFor(mode, length) {
  const n = Math.max(0, Math.round(length));
  if (n === 0) return [];
  const ascending = Array.from({ length: n }, (_, i) => i);
  switch (mode) {
    case 'down':
      return ascending.slice().reverse();
    case 'updown':
      return ascending.concat(ascending.slice(1, -1).reverse());
    case 'up':
    case 'asplay':
    default:
      return ascending;
  }
}

/**
 * A whole cycle of NOTES for a mode — the verification primitive. The runner uses
 * `createArpCursor` instead, because it walks a stream; this answers "what is the order"
 * in one call, which is what tests/arp.test.mjs and the runtime readout both want.
 *
 * Random draws `length` notes (default: two full pool walks) from the injected `random`,
 * so a seeded caller gets an exact sequence.
 */
export function arpOrder(mode, notes, { octaves = 1, random = Math.random, length = 0 } = {}) {
  const pool = arpPool(notes, { octaves, preserveOrder: mode === 'asplay' });
  if (pool.length === 0) return [];
  if (mode === 'random') {
    const draws = Math.max(0, Math.round(finite(length, pool.length * 2)));
    const out = [];
    for (let i = 0; i < draws; i += 1) out.push(pool[randomIndex(pool.length, random)]);
    return out;
  }
  return cycleFor(mode, pool.length).map((index) => pool[index]);
}

/** A safe integer in `[0, length)`, even from an RNG at either extreme. */
function randomIndex(length, random) {
  const value = typeof random === 'function' ? finite(random(), 0) : 0;
  const index = Math.floor(Math.min(Math.max(value, 0), 0.9999999999) * length);
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * The stateful walker. `next(pool)` returns the next INDEX into the pool, where `pool` is
 * the note array itself (a bare length is accepted too). It rebuilds its cycle when the
 * pool's size changes, which is exactly what happens when a key is added to or taken off
 * a held chord — the arpeggiator follows the chord without being restarted.
 */
export function createArpCursor(mode = 'up', { random = Math.random } = {}) {
  let size = -1;
  let cycle = [];
  let position = 0;

  /** A pool array or a length, as a length. */
  const sizeOf = (poolOrSize) => {
    const raw = Array.isArray(poolOrSize) ? poolOrSize.length : finite(poolOrSize, 0);
    return Math.max(0, Math.round(raw));
  };

  function rebuild(nextSize) {
    size = nextSize;
    cycle = cycleFor(mode, nextSize);
    if (position >= cycle.length) position = 0;
  }

  return {
    mode: () => mode,
    reset() {
      position = 0;
      return this;
    },
    /** The cycle length for a pool (or a length), without advancing. */
    length: (poolOrSize = size) => (sizeOf(poolOrSize) === size ? cycle.length : cycleFor(mode, sizeOf(poolOrSize)).length),
    next(poolOrSize = 0) {
      const n = sizeOf(poolOrSize);
      if (n === 0) return 0;
      if (n !== size) rebuild(n);
      if (cycle.length === 0) return 0;
      if (mode === 'random') return randomIndex(n, random);
      const index = cycle[position % cycle.length];
      position = (position + 1) % cycle.length;
      return index;
    },
  };
}

/* ------------------------------------------------------------------ the random --- */

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG. The seeding primitive for
 * Random mode's verification, and deterministic for a given seed — which is what makes
 * an "unverifiable random mode" verifiable rather than a validation trap.
 */
export function mulberry32(seed) {
  let a = (Number.isFinite(Number(seed)) ? Number(seed) : 0) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded 0..1 stream. An absent seed uses `Math.random`, i.e. genuinely fresh. */
export function createArpRandom(seed) {
  return Number.isFinite(Number(seed)) ? mulberry32(Number(seed)) : Math.random;
}
