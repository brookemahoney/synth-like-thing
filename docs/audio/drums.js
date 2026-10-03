/**
 * drums.js — the instrument's ONE binding of task 9: the clock singleton and the
 * eleven-voice 808 kit, over the real AudioContext, the real mix bus and the real
 * parameter store.
 *
 * WHY THIS FILE EXISTS AT ALL
 *   Two of them, actually, and both are the same reason: `web/audio/clock.js` and
 *   `web/audio/drum-kit.js` are deliberately free of any import from the audio graph,
 *   which is what lets tests/clock.test.mjs drive the scheduler on a fake context and
 *   tests/808.test.mjs assert the recipes' scheduled automation with no browser. This
 *   file is where they meet the instrument. It is the module the page loads; the other
 *   two are the modules that are testable.
 *
 * THE CLOCK IS THE ONLY TIMER, AND IT STARTS FROM `global.run`
 *   `global.run` is the transport key task 10's RUN button will write, so subscribing
 *   to it here is what makes the sequencer start when the player presses it, with no
 *   second transport anywhere. Task 10 does not need to know how time is kept: it
 *   subscribes to steps and reads the cursor.
 *
 *   What a subscriber is given is one frozen event per step, so every consumer reads
 *   the same numbers for the same step:
 *
 *     { step, absoluteStep, bar, beat, sixteenth,
 *       time, swungTime, swung, tempo, beatPeriod, stepPeriod, swing,
 *       stepsPerBar, stepsPerBeat }
 *
 *     step         0..15, wrapping — what a sequencer indexes a lane by
 *     absoluteStep never wraps — what a bar counter is built from
 *     bar/beat/sixteenth  derived from the grid, so a bar is always exactly 16 steps
 *     time         the grid position, on the beat
 *     swungTime    when the note is actually PLACED, after the swing offset
 *     swung        the difference between the two, so a consumer can tell it applied
 *
 *   A subscriber schedules at `swungTime`. Nothing else in the instrument owns a
 *   timer; task 7's LFOs, task 8's delay (below) and task 10's sequencer and
 *   arpeggiator all come through here.
 *
 * TASK 8'S TEMPO-SYNCED DELAY IS WIRED HERE
 *   `syncDelayToTempo(bpm)` arrived in task 8 with a comment saying "task 9's clock,
 *   once it exists". This is that. It is the tempo callback, not a poll: the delay is
 *   re-derived only when the tempo actually changes, so the chain's one write site for
 *   `delay.delayTime` still has exactly one caller per cause.
 *
 * THE KIT'S FOUR PARAMETERS COME FROM THE STORE, IN THEIR REAL UNITS
 *   `kit.<voice>.tune` is integer semitones (-12..+12), `.decay` is seconds
 *   (0.05..2.0, log curve), `.level` is 0..1 and `.pan` is -1..1. The kit clamps to
 *   those ranges itself as well, because a store read is not a guarantee.
 *
 * THE OPEN HAT IS ALSO A HELD PEDAL
 *   `setPedal(voice, down)` is the pedal API; task 10's sequencer or task 11's
 *   keyboard can drive it. While the pedal is down the hat ignores note-offs and
 *   counts them, and its level and pan are live: a level dragged while the hat rings
 *   is RAMPED into the sounding voice through `rampTo`, the same primitive every other
 *   continuous parameter in the instrument uses, so nothing is stepped during a gesture.
 *
 * THE PUBLIC API TASK 10 AND TASK 13 CONSUME
 *   clock, startClock, stopClock            the scheduler and its transport binding
 *   drumKit, triggerVoice, releaseVoice      the kit and its note path
 *   setPedal, allDrumsOff, drumCounters      the pedal, the panic, the verification
 *                                            instrument
 *   drumNodeReport                          per-voice node accounting
 */

import { audioContext, contextTime } from './context.js';
import { mixBus } from './master.js';
import { syncDelayToTempo } from './effects.js';
import { store } from '../ui/params.js';
import { nodeStats } from './nodes.js';
import { createClock } from './clock.js';
import { createDrumKit } from './drum-kit.js';

/* ------------------------------------------------------------------- the clock --- */

/**
 * THE instrument's one clock. Task 8's delay is the tempo callback, which is how the
 * effects chain hears the transport without owning a clock of its own.
 */
export const clock = createClock({
  context: audioContext,
  read: store.get,
  onTempo: (info) => syncDelayToTempo(info.tempo),
});

/** Start the transport. Idempotent: a second call does not arm a second interval. */
export function startClock() {
  return clock.start();
}

export function stopClock() {
  return clock.stop();
}

/**
 * `global.run` IS the transport. Task 10's RUN control writes that key and nothing else
 * has to know how the scheduler is kept alive; a sequencer that needs to run under a
 * different control reads or writes the same key.
 */
store.subscribe('global.run', (_key, run) => {
  if (run) startClock();
  else stopClock();
});

/* --------------------------------------------------------------------- the kit --- */

/**
 * The kit. Its voices connect to `mixBus` like every other voice in the instrument —
 * task 3 put the summing point there for exactly this, and nothing in this file writes
 * anywhere else.
 */
export const drumKit = createDrumKit({
  context: audioContext,
  parent: mixBus,
  read: store.get,
});

/**
 * The pedal. Only the open hat has one, and `createDrumKit` refuses every other voice,
 * so this cannot be used to invent a second held-pedal voice.
 */
export function setPedal(voice, down, options) {
  return down ? drumKit.pedalDown(voice) : drumKit.pedalUp(voice, options);
}

/**
 * A held open hat's level and pan are live, so a control drag during a ring is heard.
 * Subscribed rather than polled, and routed through the ramp primitive: an assignment
 * during a pointer drag steps the gain per event and clicks. Returns false when
 * nothing is held, which is the normal case.
 */
const liveLevel = store.subscribe('kit.oh.level', (_key, value) => drumKit.applyLiveLevel(value));
const livePan = store.subscribe('kit.oh.pan', (_key, value) => drumKit.applyLivePan(value));

/** Detach the live-hold subscriptions. Diagnostics only — the app never calls it. */
export function disposeDrumBindings() {
  liveLevel();
  livePan();
}

/**
 * Trigger one voice at an AudioContext time. `at` is always an audio time: callers on
 * the clock's step path pass `event.swungTime`, and anything else passing a wall-clock
 * number would be the bug this module exists to make impossible.
 */
export function triggerVoice(voice, options = {}) {
  const at = Number.isFinite(options.at) ? options.at : contextTime();
  return drumKit.trigger(voice, { ...options, at });
}

export function releaseVoice(voice, options = {}) {
  const at = Number.isFinite(options.at) ? options.at : contextTime();
  return drumKit.release(voice, { ...options, at });
}

/** The panic: every drum voice off, every pedal released, nothing left ringing. */
export function allDrumsOff(options = {}) {
  return drumKit.allNotesOff(options);
}

/**
 * THE VERIFICATION INSTRUMENT. A monotonically increasing count per voice, incremented
 * on the audio scheduling path inside `trigger` and nowhere else.
 *
 * It exists because a closed hat is 55 ms and a rimshot 60 ms: both are shorter than an
 * evaluation round-trip, so sampling analyser RMS for them reports a false failure. The
 * counter can only move if the voice really was scheduled, which is exactly what
 * per-voice verification needs to assert. It is not a feature and it performs no audio
 * function — but it must NEVER be incremented from a UI path, or it proves nothing.
 */
export function drumCounters() {
  return drumKit.counters();
}

/** Per-voice node accounting, attributed by the `drum-<voice>-<role>` labels. */
export function drumNodeReport() {
  return drumKit.nodeReport(nodeStats());
}

/* --------------------------------------------------- the beats the kit defaults to --- */

/**
 * The kit is not sequenced here. The step cursor, the patterns and the arpeggiator are
 * task 10's, and they subscribe to the clock above — this file deliberately contains no
 * pattern storage and no per-step logic, so there is exactly one place a step becomes a
 * sound.
 */

export { createClock, LOOKAHEAD_MS, LOOKAHEAD_SECONDS, beatPeriod, stepPeriod, swingOffsetSeconds, swungStepTime } from './clock.js';
export { createDrumKit, DRUM_RECIPES, TUNE_RANGE, DECAY_RANGE, LEVEL_RANGE, PAN_RANGE } from './drum-kit.js';