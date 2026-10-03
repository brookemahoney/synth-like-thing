/**
 * matrix.js — the 8 x 8 modulation matrix: sixty-four bipolar routes, summed ONCE
 * per voice per scheduling block into a single vector, applied at eight defined
 * points. Plus the panel that paints the sixty-four cells.
 *
 * THE CENTRAL CONSTRAINT, AND HOW IT IS MET
 *   "Modulation is summed once per voice per block into a single vector, then
 *   applied at a small number of defined points." Sixty-four independent writers
 *   would make behaviour untraceable and every parameter a contended resource, so
 *   the shape of this module is: a table of destinations, one generic sum, and ONE
 *   call site that reaches the voice seam and ONE that reaches the master seam.
 *   There is no route object that can write anything — a route is four numbers
 *   (`key`, `source`, `destination`, `index`) and that is the whole of it.
 *
 *   The claim is executable rather than promised: tests/matrix.test.mjs counts the
 *   call sites in this file's own source and fails if there is more than one
 *   statement reaching the voice seam, more than one call for the voice's list of
 *   destinations, or more than one call reaching the master seam. It also asserts
 *   that this file never touches an AudioParam at all.
 *
 *   Per block, per voice, in this order:
 *
 *     1  read the three LFO values ONCE for the whole block   (they are global)
 *     2  read that voice's five own sources ONCE
 *     3  normalise all eight to -1..+1 about their own neutral points
 *     4  sum the sixty-four depths into ONE vector, one number per destination
 *     5  scale by that destination's span and clamp ONCE, at the application point
 *
 * THE BLOCK IS THE CLOCK'S STEP
 *   There is no timer here, and there cannot be: the plan's single-clock rule says
 *   every timing consumer is a subscriber to clock.js, and tests/clock.test.mjs
 *   fails the build if any other file mentions an interval or a musical timeout. So
 *   the finest event available is the clock's step, and that is the block.
 *
 *   The accepted coarseness, stated rather than hidden: at 120 BPM a sixteenth is
 *   125 ms, so an LFO above about 4 Hz is sampled below its own rate and its depth
 *   moves in visible steps instead of smoothly. Below that it behaves as expected.
 *   The plan lists this as a limitation to be documented and NOT to be "fixed" —
 *   fixing it would mean either a second timer (forbidden) or an AudioWorklet
 *   (excluded), so the honest move is to name the number. Every block's value is
 *   applied as a short RAMP to the next block's end rather than as a step, which
 *   is what keeps a stepped value from clicking.
 *
 *   A matrix cell written while the transport is stopped still applies at once:
 *   a store write re-blocks directly. That is an event, not a clock.
 *
 * A VOICE WHOSE NOTE IS STILL SCHEDULED AHEAD IS NOT WRITABLE — THE REGRESSION THIS
 * FILE GUARDS, AND WHY IT IS A CLASS AND NOT AN INCIDENT
 *   A note-on is not a moment, it is a SCHEDULE. clock.js runs a 100 ms horizon
 *   ahead of the audio clock, and sequencer.js places each step with `at: event.time`,
 *   so from the second tick onwards every voice in the pool can be holding note
 *   automation stamped at a time the audio thread has not reached yet. Worse — and this
 *   is the part that makes it easy to get wrong — `playNote` calls `noteOn` and
 *   `noteOff` in the SAME tick, with the note-off at `at + gate`. So a voice whose
 *   note has not begun is already in state RELEASED, and its amp envelope is already
 *   in the release branch. `state !== IDLE` is therefore NOT evidence that a note is
 *   sounding, and it was the only test this file used to make.
 *
 *   Every write the matrix makes is a cancel-and-hold at `context.currentTime` followed
 *   by a short ramp (automation.js's `rampTo`, env.js's `holdAt`). The Web Audio
 *   specification says `cancelAndHoldAtTime(t)` removes every automation event stamped
 *   at or after `t`. So a block that walks a voice whose note is still in flight does
 *   not merely add its own value — it DELETES the note:
 *
 *     ampLevel   `env.setPeak` holds at now and then ramps to `peak`… or, on a voice
 *                already in its release branch, to ZERO. Measured on a fresh load, the
 *                first block after a note was placed removed the voice's instant write
 *                at the note-on, its attack ramp and its decay ramp, and pinned the
 *                amplifier at zero twenty milliseconds later — so a note placed 99 ms in
 *                the future never started at all, and one already sounding lost an
 *                800 ms release and was cut after 20 ms.
 *     pitch      `rampTo(pitchSource.offset, …)` deletes the note-on's pitch write.
 *     cutoff1/2  `rampTo(section.frequency, …)` deletes the note-on's filter write.
 *
 *   The measured cost, on a cold start, melodic lane armed on steps 1 and 5, drums
 *   silenced, RMS over 2.5 s of the first run after a real POWER click:
 *
 *     modulation ON, before this fix              peak 0.1397  mean 0.0035
 *     modulation stopped                         peak 0.6073  mean 0.2024
 *
 *   and, on the same build with `stopModulation()`/`startModulation()` made to actually
 *   restart (see modulation.js), the rig running measured peak 0.0000 mean 0.0000
 *   against peak 0.6491 mean 0.2665 stopped — the lane and the arpeggiator were SILENT.
 *   The "rebuild restores it" reading that first hid this is itself worth recording: the
 *   rebuild did not restore the rig, it killed it, because `ensureRig` returned the
 *   existing rig without re-subscribing to the clock.
 *
 *   A cold start is the only place it shows, which is why 488 tests and every warm-page
 *   verification missed it: it needs a suspended context, a real power-on gesture, and
 *   voices in flight. A warm page has usually already had its notes reallocated.
 *
 *   Same load, same probe, after this fix (RMS over four whole bars, drums silenced):
 *
 *     lane, modulation ON                         peak 0.6195  mean 0.2563
 *     lane, modulation stopped                    peak 0.6504  mean 0.2675   (ratio 0.958)
 *     arp,  modulation ON                         peak 0.4664  mean 0.4260
 *     arp,  modulation stopped                    peak 0.4659  mean 0.4262   (ratio 0.9995)
 *
 *   THE FIX IS THE PREDICATE, NOT A DELAY. `pendingNoteAutomation` below compares the
 *   voice's note-on time AND its note-off time against `context.currentTime`, and a
 *   voice with either still in the future is left alone. That is deliberately a
 *   property of the VOICE and the AUDIO CLOCK, so it holds for every present and
 *   future caller — the sequencer, the arpeggiator, a keyboard held chord, a hand-made
 *   call — rather than for one scheduling path. The alternative fixes were rejected on
 *   the record: skipping the first block (or the first N blocks, or anything behind a
 *   timer) only hides the collision, because the same voice is re-entered on the very
 *   next step; and REBUILDING THE RIG ON `statechange` is not a fix for this at all,
 *   because the collision is between a block and a note, not between the rig and the
 *   context — a rebuilt rig meets the same in-flight voices on its first step.
 *
 *   The cost, stated: a note that starts between two blocks gets no modulation until
 *   the next one, which is at most one step. That is the same as the note having no
 *   route for its first step, which is what the matrix already does to a note that
 *   starts mid-step. The alternative — writing at the voice's own start time — is
 *   strictly worse, because a cancel-and-hold at exactly `startedAt` also removes the
 *   note-on's own writes at that instant.
 *
 * A BLOCK WRITES WHAT MOVED, NOT EVERYTHING AGAIN
 *   The same reasoning, one step further. Every write this module makes is a
 *   cancel-and-hold followed by a short ramp, so a redundant write is not free: it
 *   deletes whatever the destination had scheduled and puts a 20 ms ramp in its place.
 *   With sixty-four cells at their default of zero the rig must be a no-op — the same
 *   principle this file already states for the reverb send, where "a cell at depth 0
 *   has to leave the chain exactly as it found it".
 *
 *   Applied unconditionally, the `ampLevel` destination broke that rule every step.
 *   A bias of zero reaches env.js's `setPeak`, which re-aims a LIVE envelope from
 *   wherever it is — and on a voice already in its release branch it re-aims it to ZERO
 *   over `seconds`. So an unpatched rig with no routes at all cut every note 20 ms after
 *   its note-off instead of letting the 800 ms release play, which is most of a melodic
 *   lane's sound: on the same fresh load, mean RMS 0.1179 with the rig running against
 *   0.2564 with it stopped, at identical peaks.
 *
 *   So a block writes a destination only when the summed route for it differs from what
 *   this rig last wrote for that voice and destination, AND only when there is something
 *   to write at all: a route of zero against a voice that holds no contribution is not
 *   written, because zero means "the matrix contributes nothing here". The door's own
 *   `route()` read-out is the authority on what the voice holds. The first block after a
 *   note always writes (there is no memory yet), a cell drag always writes (the depth
 *   moved), a route going back to zero always writes (something has to be taken back),
 *   and the master stage is still written every block because it is one node per
 *   destination with no note automation to destroy.
 *
 *   Stated rather than hidden: a route that genuinely CHANGES still re-aims a live
 *   envelope, because that is what env.js's `setPeak` is for, and this module is not
 *   going to second-guess a modulation move. The change is that zero now means zero.
 *
 * A FORBIDDEN SECOND WRITER: engine.js's setCoreModulation
 *   `engine.js` exports `setCoreModulation(core, cents, …)`, which applies ONE value
 *   across the whole pool instead of summing each voice's own routes, and whose module
 *   header says "task 7 calls this". Task 7 does not, and must not: the pitch route is
 *   a PER-VOICE SUM, and a single value applied across the pool would both discard that
 *   sum and create a second writer on `pitchSource.offset` — the exact failure this
 *   file's one-write-site rule exists to prevent. It has ZERO callers today, which is
 *   the only reason it is still safe. It is a FORBIDDEN SECOND WRITER for the `pitch`
 *   destination: route through the voice's own `modulationPoints` door and nothing
 *   else. (engine.js is another task's file and is not edited here; the export needs
 *   one line of attention from whoever owns it.)
 *
 * THE MASTER-STAGE RECONCILIATION: THE MEAN
 *   `delayTime` and `reverbSend` are one node each, so they cannot be written per
 *   voice. Two honest options exist — take the loudest active voice's sum, or
 *   average them. This module takes the AVERAGE of the sounding voices' per-voice
 *   source values, then sums the routes once against that one reconciled source
 *   set, then writes once.
 *
 *   Why the mean and not the loudest: the loudest makes the master delay time jump
 *   by a whole voice's worth whenever a note starts or stops, which is audible as a
 *   pitch bend on everybody's repeats, and it makes the value depend on which note
 *   happened to be held. The mean is continuous in the voice count (losing one of
 *   sixteen voices moves it by one sixteenth of that voice, not by a voice) and it
 *   collapses to the identity for a single held note, so a route is demonstrable
 *   with one note down. The cost, stated: a chord of opposing envelopes averages
 *   towards nothing, so a per-voice envelope cannot swing the master effects.
 *
 *   With no note sounding the per-voice sources contribute zero and the LFOs still
 *   move the master, because the LFOs are global and do not belong to a voice.
 *
 * CLAMP EARLY, CLAMP ONCE
 *   Every route lands in `clampRoute`, at the application point, in the
 *   DESTINATION'S OWN UNITS — the only place a value is bounded, so a route cannot
 *   be legal in cents and illegal in hertz. The cutoff clamp is task 6's
 *   `clampCutoffModulation`, imported rather than rewritten, and the reported
 *   cutoff goes back through task 6's `clampCutoff`, because the plan's named risk
 *   is a cutoff at or past zero producing NaN and silencing a voice permanently.
 *
 * SOURCE NEUTRALITY, WHICH IS WHAT MAKES AN ENVELOPE BEHAVE
 *   Every source is normalised about the point at which it contributes NOTHING:
 *   zero for the envelopes, velocity and per-note random; zero for the LFOs; and
 *   UNITY for key tracking, because a tracking ratio of 1 means "already tracking"
 *   and a route has to move from there rather than from silence. So an amp envelope
 *   at rest routes nothing and an open filter envelope routes its full depth, and a
 *   negative depth subtracts the same amount the positive one added.
 *
 * THE CELL IS THREE THINGS AND NOTHING ELSE
 *   Click to activate, drag vertically for a signed -100..+100 depth, show the
 *   number. No routing menu, no per-route curve, no assign-on, no source mixing —
 *   the plan excludes all four, and this file contains none of them. Activation IS
 *   a non-zero depth, so the store stays the single authority for a cell: there is
 *   no separate "on" flag that could disagree with the number beside it.
 *
 * API
 *   MATRIX_SOURCES / MATRIX_DESTINATIONS / MATRIX_CELL_COUNT
 *   matrixRoutes()            the sixty-four records, row-major, legend order
 *   routeKey(source, destination) / SIGNED formatting and activation helpers
 *   DESTINATIONS / APPLICATION_POINTS / clampRoute(destination, value)
 *   normaliseSource / normaliseSourceSet / createVector / reconcileSources
 *   pendingNoteAutomation(voice, now)   is this voice's note still scheduled ahead?
 *   createModulation({...})   the block loop and its read-outs
 *   buildMatrixPanel({ doc, store })   sixty-four painted cells
 */

import { VOICE_STATE } from './allocator.js';
import { RAMP_SECONDS } from './automation.js';
import { CUTOFF_MOD_CENTS, clampCutoff, clampCutoffModulation } from './filter.js';
import { CORE_COUNT, SPREAD_MAX_CENTS } from './osc-mod.js';
import { MATRIX_DESTINATIONS, MATRIX_SOURCES, store as appStore } from '../ui/params.js';
import { dragBy, prettyOption, stepValue } from '../ui/controls.js';

/* ------------------------------------------------------------- the inventory --- */

export { MATRIX_SOURCES, MATRIX_DESTINATIONS };

/** Eight by eight. The number the panel is sized for. */
export const MATRIX_CELL_COUNT = MATRIX_SOURCES.length * MATRIX_DESTINATIONS.length;

/** Cents the pitch destination may be moved: four octaves, either way. */
export const PITCH_ROUTE_CENTS = 4 * 1200;

/** Cents the delay-time destination may be moved. effects.js documents ±4800. */
export const DELAY_ROUTE_CENTS = 4 * 1200;

/** The depth a click gives a dead cell. Full scale, in the positive direction. */
export const ACTIVE_DEPTH = 100;

/** How far a pointer may travel and still count as a click rather than a drag. */
const TAP_SLOP_PX = 3;

/** The three sources that belong to the instrument rather than to a voice. */
export const GLOBAL_SOURCES = Object.freeze(['lfo1', 'lfo2', 'lfo3']);

/** The five sources the voice layer produces. */
export const PER_VOICE_SOURCES = Object.freeze(['ampEnv', 'filterEnv', 'velocity', 'keyTrack', 'random']);

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/**
 * The sixty-four route records. Row-major: source by source, and within a source
 * the eight destinations in legend order. They are DATA — a key, its two names and
 * its index — and nothing else, which is what makes it impossible for a route to
 * write anything.
 */
export function matrixRoutes() {
  const routes = [];
  let index = 0;
  for (const source of MATRIX_SOURCES) {
    for (const destination of MATRIX_DESTINATIONS) {
      routes.push({ key: routeKey(source, destination), source, destination, index });
      index += 1;
    }
  }
  return routes;
}

export function routeKey(source, destination) {
  return `matrix.${source}.${destination}`;
}

/* ------------------------------------------------------------------ the cells --- */

/** A cell is active when its depth is not zero: the depth IS the activation. */
export function isActiveDepth(depth) {
  return Math.abs(finite(depth)) > 0;
}

/** The same test in the words the store uses. */
export function depthIsActive(depth) {
  return isActiveDepth(depth);
}

/**
 * What a click does. A dead cell turns on at full depth; a live cell turns off.
 * The store clamps the result, so this cannot write outside -100..+100.
 */
export function toggleDepth(depth) {
  return isActiveDepth(depth) ? 0 : ACTIVE_DEPTH;
}

/** The painted number: always signed, so a negative depth is not "42". */
export function signedDepth(depth) {
  const value = finite(depth);
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return rounded > 0 ? `+${text}` : text;
}

/* ---------------------------------------------------------------- the sources --- */

/**
 * Every source's neutral point and its span, in the source's OWN units.
 *
 *   neutral  the value at which this source contributes nothing at all
 *   span     the distance from neutral that reads as full depth
 *
 * Key tracking is a RATIO, so its neutral point is unity: a tracking amount of 1
 * is "already tracking", and a route into it has to move from there. Everything
 * else is a level, and a level's neutral point is silence.
 */
export const SOURCE_NEUTRALS = Object.freeze({
  lfo1: Object.freeze({ neutral: 0, span: 1 }),
  lfo2: Object.freeze({ neutral: 0, span: 1 }),
  lfo3: Object.freeze({ neutral: 0, span: 1 }),
  ampEnv: Object.freeze({ neutral: 0, span: 1 }),
  filterEnv: Object.freeze({ neutral: 0, span: 1 }),
  velocity: Object.freeze({ neutral: 0, span: 1 }),
  keyTrack: Object.freeze({ neutral: 1, span: 1 }),
  random: Object.freeze({ neutral: 0, span: 1 }),
});

/** One source's raw value as a -1..+1 deviation from its neutral point. */
export function normaliseSource(source, value) {
  const rule = SOURCE_NEUTRALS[source];
  if (!rule) return 0;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  return clamp((raw - rule.neutral) / rule.span, -1, 1);
}

/**
 * A whole source set, normalised. Only the sources actually present are returned:
 * a missing source is absent rather than zero, so the global LFO set and a voice's
 * own set can be merged without one filling in a silence for the other.
 */
export function normaliseSourceSet(values = {}) {
  const set = {};
  for (const source of MATRIX_SOURCES) {
    if (values[source] === undefined) continue;
    set[source] = normaliseSource(source, values[source]);
  }
  return set;
}

/* ---------------------------------------------------------- the summed vector --- */

/**
 * The vector: ONE bipolar number per destination, in normalised units where 1 is
 * full depth of that destination and 0 is no route at all.
 *
 * `depths` is a map of route key to the store's signed -100..+100, so a cell at
 * zero is the same thing as an absent route and needs no activation test here.
 */
export function createVector(depths = {}, sources = {}) {
  const vector = {};
  for (const destination of MATRIX_DESTINATIONS) {
    let sum = 0;
    for (const source of MATRIX_SOURCES) {
      const depth = finite(depths[routeKey(source, destination)]) / 100;
      if (depth === 0) continue;
      sum += depth * finite(sources[source]);
    }
    vector[destination] = sum;
  }
  return vector;
}

/**
 * THE MASTER-STAGE RECONCILIATION. One reconciled source set from every voice's own
 * five sources: the arithmetic mean.
 *
 * The inputs are already NORMALISED — the matrix normalises each voice's sources
 * once, on the way in — and are not normalised again here, because normalising a
 * normalised value twice would shift it twice. Normalisation is affine and
 * identical for every voice, so the mean of the normalised values is also the mean
 * of the raw ones: there is no second convention to remember.
 *
 * The global LFO sources are not here: they are not per voice and are never
 * reconciled, so they move the master effects whether or not a note is held.
 */
export function reconcileSources(sets = []) {
  const reconciled = {};
  for (const source of PER_VOICE_SOURCES) reconciled[source] = 0;
  if (sets.length === 0) return reconciled;
  const totals = {};
  for (const source of PER_VOICE_SOURCES) totals[source] = 0;
  for (const set of sets) {
    for (const source of PER_VOICE_SOURCES) totals[source] += finite(set?.[source]);
  }
  for (const source of PER_VOICE_SOURCES) {
    reconciled[source] = clamp(totals[source] / sets.length, -1, 1);
  }
  return reconciled;
}

/* ---------------------------------------------------------- the destinations --- */

/** Clamp a value into a closed range, treating a non-number as zero. */
const clampRange = (value, low, high) => clamp(finite(value), low, high);

/** The amp level is a BIAS on the envelope's peak, so -1 is silence, not a mute. */
const clampBias = (value) => clampRange(value, -1, 1);

/**
 * THE REVERB SEND IS A BIAS AROUND UNITY, NOT AN ABSOLUTE LEVEL.
 *
 * chain.js's send node rests at 1 — a full send — and every matrix cell's default
 * is 0, so a cell at depth 0 has to leave the chain exactly as it found it. A
 * default that silenced the reverb would be a default that changes the sound, so
 * the excursion here is -1..+1 AROUND 1, the same shape as the amp level's bias on
 * its envelope peak.
 *
 * The consequence, stated rather than hidden: chain.js clamps a send to 0..100% and
 * 100% is where it already rests, so a positive excursion saturates at unity. In
 * practice this destination DUCKS the reverb — which is exactly what a send inside
 * a chain can do without that chain having to grow a send above unity, and it does
 * not own effects.js's single write site to change.
 */
const clampSend = (route) => clampRange(finite(route) + 1, 0, 1);

/**
 * THE APPLICATION POINTS. One row per destination, and this table is the whole of
 * the "one write site each" claim.
 *
 *   destination   the matrix's name for it
 *   scope         'voice' (six per voice, per block) or 'master' (once per block)
 *   span          the destination's full-scale excursion in its own units
 *   cores         which of the voice's three cores a per-core destination reaches
 *   clamp         the bound applied ONCE, at this point
 *
 * `pitch`, `fmAmount` and `unisonSpread` are voice-wide in the legend but per core
 * in the graph — voice.js's pitch is one ConstantSourceNode per core, and there is
 * no "the voice's pitch" node to write. So all three cores take the same summed
 * route, which is what makes LFO-to-pitch bend the note rather than detune one
 * oscillator against the other two.
 *
 * A route's RANGE is not the destination's total range: voice.js and chain.js clip
 * each total into its control's own range, and this table bounds the contribution
 * so a runaway sum cannot be more than four octaves off.
 */
export const APPLICATION_POINTS = Object.freeze([
  Object.freeze({ destination: 'pitch', scope: 'voice', unit: 'cents', span: PITCH_ROUTE_CENTS, cores: Object.freeze([0, 1, 2]), clamp: (v) => clampRange(v, -PITCH_ROUTE_CENTS, PITCH_ROUTE_CENTS) }),
  Object.freeze({ destination: 'fmAmount', scope: 'voice', unit: 'ratio', span: 1, cores: Object.freeze([0, 1, 2]), clamp: (v) => clampRange(v, -1, 1) }),
  Object.freeze({ destination: 'unisonSpread', scope: 'voice', unit: 'cents', span: SPREAD_MAX_CENTS, cores: Object.freeze([0, 1, 2]), clamp: (v) => clampRange(v, -SPREAD_MAX_CENTS, SPREAD_MAX_CENTS) }),
  Object.freeze({ destination: 'cutoff1', scope: 'voice', unit: 'cents', span: CUTOFF_MOD_CENTS, cores: Object.freeze([0]), clamp: (v) => clampCutoffModulation(v) }),
  Object.freeze({ destination: 'cutoff2', scope: 'voice', unit: 'cents', span: CUTOFF_MOD_CENTS, cores: Object.freeze([1]), clamp: (v) => clampCutoffModulation(v) }),
  Object.freeze({ destination: 'ampLevel', scope: 'voice', unit: 'bias', span: 1, cores: Object.freeze([0]), clamp: (v) => clampBias(v) }),
  Object.freeze({ destination: 'delayTime', scope: 'master', unit: 'cents', span: DELAY_ROUTE_CENTS, cores: null, clamp: (v) => clampRange(v, -DELAY_ROUTE_CENTS, DELAY_ROUTE_CENTS) }),
  Object.freeze({ destination: 'reverbSend', scope: 'master', unit: 'send', span: 1, cores: null, clamp: (v) => clampSend(v) }),
]);

/** The six written once per voice, per block. */
export const VOICE_DESTINATIONS = Object.freeze(
  APPLICATION_POINTS.filter((row) => row.scope === 'voice').map((row) => row.destination),
);

/** The two written once per block, for the whole instrument. */
export const MASTER_DESTINATIONS = Object.freeze(
  APPLICATION_POINTS.filter((row) => row.scope === 'master').map((row) => row.destination),
);

const POINT_BY_DESTINATION = new Map(APPLICATION_POINTS.map((row) => [row.destination, row]));

/**
 * THE CLAMP. One function, at the application point, in the destination's own
 * units. The two cutoff rows are task 6's helper verbatim: this module does not
 * hold a second opinion about how far a cutoff may be moved.
 */
export function clampRoute(destination, value) {
  const row = POINT_BY_DESTINATION.get(destination);
  return row ? row.clamp(value) : 0;
}

/* ------------------------------------------------------------------ the block --- */

/** The destinations a voice owns, as one lookup table rather than eight searches. */
function doorsOf(voice) {
  const doors = {};
  const points = typeof voice.modulationPoints === 'function' ? voice.modulationPoints() : [];
  for (const point of points) doors[point.destination] = point;
  return doors;
}

/** One voice's five own sources. Normalised ONCE, by normaliseSourceSet below. */
function voiceSources(voice) {
  const values = {};
  const sources = typeof voice.modulationSources === 'function' ? voice.modulationSources() : [];
  for (const entry of sources) {
    if (!PER_VOICE_SOURCES.includes(entry.source)) continue;
    values[entry.source] = entry.read();
  }
  return normaliseSourceSet(values);
}

/** A voice is worth modulating when it is not idle and it has the task-6 seams. */
const isModulable = (voice) =>
  Boolean(voice) && voice.state !== VOICE_STATE.IDLE && typeof voice.modulationPoints === 'function';

/**
 * IS THERE ANYTHING TO WRITE TO THIS DESTINATION AT ALL?
 *
 * A summed route of zero means the matrix is contributing NOTHING here, which is the
 * same thing this file already insists on for the reverb send: "a cell at depth 0 has
 * to leave the chain exactly as it found it." A default that changed the sound would
 * not be a default. So a zero route is only worth writing when the voice is still
 * HOLDING a contribution that has to be taken back — and the door's own `route()`
 * read-out is the authority on that, per core, because it is the value the voice stored
 * when the matrix last wrote to it.
 *
 * This matters because the destinations are not plain numbers. `ampLevel` reaches
 * env.js's `setPeak`, which re-aims a live envelope from wherever it is, and on a voice
 * already in its release branch it re-aims it to ZERO over `seconds`. Writing a bias of
 * zero every block therefore cut every note 20 ms after its note-off instead of letting
 * the 800 ms release play. Not writing it leaves the release alone, which is what a cell
 * at depth 0 is supposed to mean.
 *
 * A door with no `route()` read-out is treated as HAVING something to write: the
 * conservative direction, because a rig that under-writes is silent and a rig that
 * over-writes is the defect this fixes.
 */
function doorHasSomethingToWrite(door, route, core) {
  if (route !== 0) return true;
  if (typeof door?.route !== 'function') return true;
  return Number(door.route(core)) !== 0;
}

/**
 * IS THIS VOICE'S NOTE STILL SCHEDULED AHEAD OF THE AUDIO CLOCK?
 *
 * True means a write to this voice's AudioParams would DELETE part of its note rather
 * than add to it, so `block()` must leave it alone this block. See the header for the
 * measured cost and for why the alternative fixes are worse.
 *
 *   startedAt    when the note-on is stamped. `voice.start` records it verbatim,
 *                including a time up to the clock's 100 ms horizon in the future.
 *   releasedAt   when the note-off is stamped. `playNote` schedules it in the same tick
 *                as the note-on, so a sequenced voice carries this while it is still
 *                silent — which is why a RELEASED voice is not a safe one to write to.
 *
 * A voice that reports no time at all is treated as having nothing pending: there is no
 * evidence a note is in flight, and a fake pool or a hand-built voice must not be
 * silently excluded from modulation because it does not volunteer its schedule.
 */
export function pendingNoteAutomation(voice, now) {
  const startedAt = Number(voice?.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  if (!(Number(now) >= startedAt)) return true;
  const releasedAt = Number(voice.releasedAt);
  return Number.isFinite(releasedAt) && releasedAt > Number(now);
}

/**
 * THE MODULATION RIG.
 *
 * Every dependency is injected, so this is testable against a fake context and a
 * fake voice pool with no browser, and so this module never imports the context, the
 * clock or the effects chain — the single place that wires them together is
 * modulation.js.
 *
 *   context      anything with a `currentTime`
 *   read         the parameter store's reader
 *   subscribe    an all-subscriptions reader, so a cell write re-blocks at once
 *   voices       the pool, or a function returning it
 *   sampleRate   the ACTUAL rate, for the cutoff read-out's ceiling
 *   bank         the LFO bank; its sourceValues() are the three global sources
 *   master       { delayTime(cents, options), reverbSend(amount, options) }
 */
export function createModulation({
  context,
  read = appStore.get,
  subscribe = appStore.subscribe,
  voices = () => [],
  sampleRate = context?.sampleRate ?? 48000,
  bank = null,
  master = null,
  rampSeconds = RAMP_SECONDS,
} = {}) {
  if (!context) throw new Error('matrix: createModulation needs a context to schedule against');

  const pool = typeof voices === 'function' ? voices : () => voices;
  const vectors = new Map();
  /**
   * WHAT THE LAST BLOCK WROTE, per voice, per destination. The memory that makes a
   * block write WHAT MOVED rather than write everything again — see the header's
   * "WRITE WHAT MOVED" section for why a redundant write is not free.
   */
  const written = new Map();
  const masterRoutes = {};
  const masterApplied = {};
  let blockCount = 0;
  let depthStamp = null;

  /** The sixty-four depths, read ONCE per block: they are global, not per voice. */
  function readDepths() {
    const depths = {};
    for (const route of matrixRoutes()) depths[route.key] = finite(read(route.key));
    return depths;
  }

  /**
   * The three GLOBAL sources for this block, normalised. Named one by one rather
   * than spread, so a bank that is missing one contributes silence for it instead
   * of silently shifting the merge.
   */
  function globalSources() {
    const values = bank?.sourceValues?.() ?? {};
    const globals = {};
    for (const source of GLOBAL_SOURCES) globals[source] = normaliseSource(source, values[source]);
    return globals;
  }

  /** The voices worth writing to right now. */
  function activeVoices() {
    return pool().filter(isModulable);
  }

  /**
   * THE WRITABLE SET: the non-idle voices MINUS the ones whose note is still scheduled
   * ahead. One `context.currentTime` read for the whole block, so every voice in a
   * block is judged against the same instant — which is what the audio thread will
   * judge them against too.
   */
  function writableVoices() {
    const now = context.currentTime;
    return activeVoices().filter((voice) => !pendingNoteAutomation(voice, now));
  }

  /**
   * ONE BLOCK.
   *
   * Step 0: take the writable set — every voice whose note is still scheduled ahead of
   * the audio clock is left alone, because writing one would delete its note-on rather
   * than modulate it. Step 1-4 for every remaining voice, writing only what moved;
   * step 5 once, for the master. The voice seams are reached through one statement and
   * the master seam through one statement, whatever the destination, which is the whole
   * of the one-write-site claim.
   */
  function block() {
    const depths = readDepths();
    depthStamp = depths;
    const globals = globalSources();
    const applyOptions = { ramp: true, seconds: rampSeconds };
    const sounding = writableVoices();
    const ownSets = [];

    for (const voice of sounding) {
      const own = voiceSources(voice);
      ownSets.push(own);
      const vector = createVector(depths, { ...globals, ...own });
      vectors.set(voice.index, vector);
      const doors = doorsOf(voice);
      const last = written.get(voice.index) ?? {};
      for (const row of APPLICATION_POINTS) {
        if (row.scope !== 'voice') continue;
        const door = doors[row.destination];
        if (!door) continue;
        const route = clampRoute(row.destination, vector[row.destination] * row.span);
        /* WRITE WHAT MOVED: this is the single voice-seam call in the file, guarded by
           the value it last wrote for this voice and this destination, and by whether
           there is anything at all to write. */
        if (last[row.destination] === route) continue;
        for (const core of row.cores) {
          if (!doorHasSomethingToWrite(door, route, core)) continue;
          door.apply(core, route, applyOptions);
        }
        last[row.destination] = route;
      }
      written.set(voice.index, last);
    }

    for (const index of [...vectors.keys()]) {
      if (!sounding.some((voice) => voice.index === index)) {
        vectors.delete(index);
        written.delete(index);
      }
    }

    /* The master stage: one reconciled source set, one sum, one write each. */
    if (master) {
      const reconciled = reconcileSources(ownSets);
      const vector = createVector(depths, { ...globals, ...reconciled });
      for (const row of APPLICATION_POINTS) {
        if (row.scope !== 'master') continue;
        const route = clampRoute(row.destination, vector[row.destination] * row.span);
        masterRoutes[row.destination] = route;
        masterApplied[row.destination] = master[row.destination](route, applyOptions);
      }
    }

    blockCount += 1;
    return { block: blockCount, voices: sounding.length, vectors };
  }

  /** Re-block on any matrix key write, so a drag is heard as it happens. */
  const off = typeof subscribe === 'function' ? subscribe((key) => {
    if (typeof key === 'string' && key.startsWith('matrix.')) block();
  }) : null;

  const voiceByIndex = (index) => activeVoices().find((voice) => voice.index === index) ?? null;

  return {
    block,
    blocks: () => blockCount,
    /** How many voices the last block was allowed to write to, pending ones excluded. */
    active: () => writableVoices().length,
    /** The non-idle voices, pending ones included: a diagnostic, never a write list. */
    pooled: () => activeVoices().length,
    depths: () => depthStamp ?? readDepths(),
    /** The whole per-voice vector map, for an inspection panel. */
    vectors: () => Object.fromEntries([...vectors.entries()].map(([index, vector]) => [index, { ...vector }])),
    vector: (index) => (vectors.get(index) ? { ...vectors.get(index) } : null),
    /** What the matrix contributed to a destination, in that destination's units. */
    route: (destination, voiceIndex = 0) => {
      const row = POINT_BY_DESTINATION.get(destination);
      if (!row) return 0;
      if (row.scope === 'master') return masterRoutes[destination] ?? 0;
      const vector = vectors.get(voiceIndex);
      return vector ? clampRoute(destination, vector[destination] * row.span) : 0;
    },
    /**
     * The destination's LIVE value, as the audio graph currently has it. Cutoffs go
     * back through task 6's clamp, so what is reported is always a frequency that
     * can be heard rather than a number that can only be diagnosed.
     */
    read: (destination, voiceIndex = 0) => {
      const row = POINT_BY_DESTINATION.get(destination);
      if (!row) return null;
      if (row.scope === 'master') return masterApplied[destination] ?? null;
      const voice = voiceByIndex(voiceIndex);
      if (!voice) return null;
      if (destination === 'pitch') return finite(voice.livePitch?.(0));
      const door = doorsOf(voice)[destination];
      const value = finite(door?.read(0));
      if (destination === 'cutoff1' || destination === 'cutoff2') return clampCutoff(value, sampleRate);
      return value;
    },
    master: () => ({ ...masterApplied }),
    dispose: () => (typeof off === 'function' ? off() : null),
  };
}

/* ----------------------------------------------------------------- the panel --- */

/**
 * Run `mount` when the surface it paints onto exists.
 *
 * A deferred module script is evaluated BEFORE `DOMContentLoaded`, with
 * `document.readyState === 'interactive'`, and ui/main.js calls `buildSurface()`
 * AFTER its static imports are evaluated. So a module that mounts on anything other
 * than 'complete' paints its panel into a document that has not been drawn yet —
 * which is how the first version of this file ended up building a second, orphan
 * matrix grid on `document.body`.
 *
 * So the test is 'complete', not 'loading'. Anything else waits for
 * DOMContentLoaded, which cannot fire before the deferred scripts have run and
 * therefore cannot fire before buildSurface() has returned.
 */
export function mountWhenReady(doc, mount) {
  if (!doc || typeof doc.addEventListener !== 'function') return false;
  if (doc.readyState === 'complete') {
    mount();
    return true;
  }
  doc.addEventListener('DOMContentLoaded', mount, { once: true });
  return true;
}

/** Every cell in document order, whichever way the host exposes a collection. */
function cellsIn(root) {
  if (typeof root?.querySelectorAll === 'function') return [...root.querySelectorAll('.headgrid__cell')];
  if (typeof root?.all === 'function') return root.all('headgrid__cell');
  return [];
}

/**
 * The grid surface.js laid out, and the panel it belongs to.
 *
 * No panel means NOTHING: an earlier version invented a grid and appended it to
 * `document.body` when it could not find the panel, which left an orphan matrix
 * floating at the foot of the page. Mounting nothing is the honest answer — the
 * panel is either there or it is not.
 */
function findGrid(doc) {
  const panel = doc.querySelector('[data-panel="matrix"]') ?? doc.querySelector('.panel--matrix');
  if (!panel) return { panel: null, grid: null, placeholders: [] };
  const existing = cellsIn(panel).length === MATRIX_CELL_COUNT ? panel.querySelector('.headgrid') : null;
  if (existing) return { panel, grid: existing, placeholders: cellsIn(existing) };
  /* A panel with no grid yet: build the shell the plan describes, inside the
     panel, rather than paint 64 cells onto nothing. */
  const grid = doc.createElement('div');
  grid.className = 'headgrid';
  const corner = doc.createElement('span');
  corner.className = 'headgrid__corner';
  grid.append(corner);
  for (const destination of MATRIX_DESTINATIONS) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--column';
    head.textContent = prettyOption(destination);
    grid.append(head);
  }
  const placeholders = [];
  for (const source of MATRIX_SOURCES) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--row';
    head.textContent = prettyOption(source);
    grid.append(head);
    for (let column = 0; column < MATRIX_DESTINATIONS.length; column += 1) {
      const cell = doc.createElement('span');
      cell.className = 'headgrid__cell';
      grid.append(cell);
      placeholders.push(cell);
    }
  }
  panel.append?.(grid);
  return { panel, grid, placeholders };
}

/** Inline styling for a cell. No stylesheet is added: web/styles is another task's. */
const CELL_STYLE = [
  ['position', 'relative'],
  ['overflow', 'hidden'],
  ['cursor', 'ns-resize'],
  ['touch-action', 'none'],
  ['user-select', 'none'],
].map(([name, value]) => `${name}:${value}`).join(';');

/**
 * Paint the sixty-four cells.
 *
 * Each cell is a slider with a signed depth: a bar that fills from the centre up
 * or down, and the number. Pointer capture is on the cell, so a drag that wanders
 * off it keeps tracking and a drag that ends elsewhere still ends — the same
 * gesture contract as every other painted control in the instrument, with the same
 * drag and step arithmetic, imported rather than re-implemented.
 */
export function buildMatrixPanel({ doc = globalThis.document, store = appStore } = {}) {
  const empty = { cells: [], grid: null, panel: null };
  if (!doc || typeof doc.createElement !== 'function') return empty;
  const { panel, grid, placeholders } = findGrid(doc);
  if (placeholders.length !== MATRIX_CELL_COUNT) return empty;

  /* The empty grid surface.js renders is interactive from here on, so it must not
     be hidden from assistive technology. */
  grid?.removeAttribute?.('aria-hidden');

  const cells = [];
  const unsubscribes = [];
  const routes = matrixRoutes();

  routes.forEach((route, index) => {
    const placeholder = placeholders[index];
    const entry = store.schema(route.key);
    const cell = doc.createElement('div');
    cell.className = 'headgrid__cell matrix-cell';
    cell.dataset.key = route.key;
    cell.dataset.source = route.source;
    cell.dataset.destination = route.destination;
    cell.setAttribute('role', 'slider');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('aria-valuemin', String(entry.min));
    cell.setAttribute('aria-valuemax', String(entry.max));
    cell.setAttribute('aria-label', `${prettyOption(route.source)} to ${prettyOption(route.destination)}, depth`);
    cell.setAttribute('style', CELL_STYLE);

    const bar = doc.createElement('span');
    bar.className = 'matrix-cell__bar';
    bar.setAttribute('aria-hidden', 'true');
    bar.setAttribute('style', 'position:absolute;left:0;right:0;background:currentColor;opacity:0.55');

    const readout = doc.createElement('span');
    readout.className = 'matrix-cell__value';
    readout.setAttribute('aria-hidden', 'true');
    readout.setAttribute('style', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:0.5625rem;font-variant-numeric:tabular-nums;pointer-events:none');

    cell.append(bar, readout);
    /* `parentNode`, not a property this module invented: the real DOM has no
       `parent`, and a fake that does would hide exactly this bug. */
    placeholder?.parentNode?.replaceChild?.(cell, placeholder);

    const render = (value) => {
      const depth = clamp(finite(value), entry.min, entry.max);
      const text = signedDepth(depth);
      const height = `${Math.abs(depth) / 2}%`;
      cell.setAttribute('aria-valuenow', String(depth));
      cell.setAttribute('aria-valuetext', text);
      cell.setAttribute('data-depth', text);
      cell.classList.toggle('is-active', isActiveDepth(depth));
      cell.classList.toggle('is-negative', depth < 0);
      readout.textContent = text;
      /* Fill from the centre outwards, so the sign is the direction it grew. */
      bar.style.setProperty('height', height);
      bar.style.setProperty('bottom', depth < 0 ? 'auto' : '50%');
      bar.style.setProperty('top', depth < 0 ? '50%' : 'auto');
    };

    const write = (value) => {
      const stored = store.set(route.key, value, { source: 'control', apply: 'ramp' });
      render(stored);
      return stored;
    };

    render(store.get(route.key));

    let dragging = false;
    let travelled = 0;
    let lastX = 0;
    let lastY = 0;

    cell.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true;
      travelled = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      cell.setPointerCapture?.(event.pointerId);
      cell.classList.add('is-dragging');
      cell.focus?.({ preventScroll: true });
      event.preventDefault?.();
    });

    cell.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.movementX || event.clientX - lastX;
      const dy = event.movementY || event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      travelled += Math.abs(dx) + Math.abs(dy);
      write(dragBy(entry, store.get(route.key), { dx, dy, axis: 'y', fine: event.shiftKey }));
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      if (cell.hasPointerCapture?.(event.pointerId)) cell.releasePointerCapture?.(event.pointerId);
      cell.classList.remove('is-dragging');
      /* A tap, rather than a drag, activates or deactivates the cell. */
      if (travelled <= TAP_SLOP_PX) write(toggleDepth(store.get(route.key)));
    };

    cell.addEventListener('pointerup', endDrag);
    cell.addEventListener('pointercancel', endDrag);
    cell.addEventListener('dblclick', () => write(entry.def));

    cell.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          write(stepValue(entry, store.get(route.key), 1, { fine: event.shiftKey }));
          break;
        case 'ArrowDown':
        case 'ArrowLeft':
          write(stepValue(entry, store.get(route.key), -1, { fine: event.shiftKey }));
          break;
        case 'PageUp':
          write(stepValue(entry, store.get(route.key), 1, { coarse: true }));
          break;
        case 'PageDown':
          write(stepValue(entry, store.get(route.key), -1, { coarse: true }));
          break;
        case 'Home':
          write(entry.min);
          break;
        case 'End':
          write(entry.max);
          break;
        default:
          return; // every other key belongs to the page
      }
      event.preventDefault?.();
    });

    unsubscribes.push(store.subscribe(route.key, (_key, value) => render(value)));
    cells.push({ ...route, cell, bar, readout, entry });
  });

  return {
    grid,
    panel,
    cells,
    /** The store key a source/destination pair is stored under. */
    key: (source, destination) => routeKey(source, destination),
    dispose() {
      for (const off of unsubscribes) off?.();
    },
  };
}
