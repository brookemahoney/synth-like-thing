/**
 * clock.js — THE SINGLE LOOKAHEAD SCHEDULER. The one timer in the instrument.
 *
 * WHY A LOOKAHEAD SCHEDULER AT ALL
 *   `setInterval` cannot be trusted with musical time. A timer callback is a
 *   request, not a deadline: it fires late whenever the main thread is busy, and
 *   the lateness accumulates. Schedule a note from inside the callback and every
 *   note inherits every previous delay — that is what makes a browser sequencer
 *   drift within a minute.
 *
 *   The lookahead pattern inverts the responsibility. A coarse timer wakes up four
 *   times per step window and does no timing itself; it walks a cursor forward and
 *   hands each event to Web Audio stamped with an EXACT future `AudioContext`
 *   time. The browser's audio thread then renders those events sample-accurately,
 *   immune to whatever the main thread was doing. The timer's only job is to stay
 *   far enough ahead of the audio clock that it always has time.
 *
 *   Hence the two constants: a 25 ms tick, and a 100 ms horizon. Four ticks of
 *   slack means a single late callback cannot starve the horizon.
 *
 * WHY THE AUDIO CLOCK AND NEVER THE WALL CLOCK
 *   `Date.now` and `performance.now` measure a different thing from the
 *   samples being rendered. They drift against each other, they jump when the tab
 *   is throttled or the machine sleeps, and neither is the clock the sound is
 *   actually played on. Every scheduled time here comes from
 *   `context.currentTime`. There is no fallback path, deliberately: a fallback
 *   would be a second clock with a different opinion, which is the exact failure
 *   this module exists to prevent. tests/clock.test.mjs walks `web/` from disk and
 *   fails if a wall-clock read ever appears there.
 *
 * THE ONE TIMER, AND WHY IT IS THE ONLY ONE
 *   The plan names this the highest-risk-to-violate constraint. Every other
 *   timing consumer — task 7's tempo-synced LFOs, task 8's tempo-synced delay,
 *   task 10's sequencer and arpeggiator — is a SUBSCRIBER here. A consumer that
 *   wants a note every eighth has no timer to own; it has a `subscribeToSteps`
 *   callback that fires when the cursor reaches an eighth. There is exactly one
 *   `setInterval` in `web/`, it is the one in this file, and a test asserts both
 *   facts against the source on disk.
 *
 * THE CURSOR ARITHMETIC, AND WHY SWING IS AN OFFSET RATHER THAN A STEP
 *   The cursor walks a fixed grid: step `n` is at `start + n * stepPeriod`, with
 *   `stepPeriod = (60 / bpm) / 4`. Swing does not bend that grid — it is an
 *   ADDITIVE offset applied only to odd sixteenths at scheduling time.
 *
 *   That is a deliberate choice with two consequences worth stating. First, the
 *   bar length stays exactly 16 periods whatever the swing, so the downbeat never
 *   wanders and the clock's own arithmetic never accumulates error. Second, the
 *   grid time and the played time are separately readable, which is what lets the
 *   clock publish both: a consumer that wants to place something on the beat uses
 *   `time`; one that wants to place something on the swung grid uses `swungTime`.
 *
 *   `swingOffsetSeconds` uses the MPC convention: at 75% the eighth-note pair
 *   runs 75/25 rather than 50/50, so the offbeat sixteenth is pushed half a
 *   sixteenth late. Long and short pairs alternate, so the average step rate is
 *   unchanged.
 *
 * WHY `createClock` TAKES ITS CONTEXT, ITS READER AND ITS TIMERS
 *   This module imports nothing from the audio graph, which is what lets
 *   tests/clock.test.mjs drive the whole scheduler on a fake AudioContext and a
 *   fake interval — no sleeping, no browser, no flakiness — while the same code
 *   runs in the page against the real one. `web/audio/drums.js` is what binds it
 *   to the instrument's own context, store and transport keys.
 *
 * THE API, AND WHO OWNS WHAT
 *   Pure arithmetic, importable anywhere:
 *     beatPeriod(bpm)                     seconds per beat, 60 / bpm
 *     stepPeriod(bpm, stepsPerBeat)       seconds per step
 *     swingOffsetSeconds(step, period, swingPercent)
 *     swungStepTime(base, step, period, swingPercent)
 *
 *   The scheduler:
 *     createClock({ context, read, timers, onTempo, stepsPerBar, stepsPerBeat })
 *     clock.start() / .stop() / .running()
 *     clock.subscribeToSteps(fn)          one call per scheduled step
 *     clock.subscribeToPosition(fn)       the same event, for a playhead
 *     clock.subscribeToTempo(fn)          on a tempo change only
 *     clock.state()                       an immutable snapshot
 *     clock.tempo() / .beatPeriod() / .stepPeriod() / .stepCursor()
 *     clock.position()                    { bar, beat, sixteenth, step, absoluteStep }
 *     clock.nextStepTime() / .audioTime()
 *
 *   A step subscriber is handed ONE frozen event, so every consumer reads the same
 *   numbers for the same step and cannot disagree about when it happened:
 *
 *     { step, absoluteStep, bar, beat, sixteenth,
 *       time, swungTime, swung, tempo, beatPeriod, stepPeriod, swing,
 *       stepsPerBar, stepsPerBeat }
 *
 *   `step` is 0..stepsPerBar-1 and wraps; `absoluteStep` never does, and is what a
 *   bar counter is built from. `time` is the grid time, `swungTime` is when the
 *   note is actually placed, and `swung` is the difference between them.
 *
 *   TEMPO IS READ, NOT PUSHED. `read('global.tempo')` happens once per tick, so a
 *   tempo change takes effect on the next step with no restart and no re-armed
 *   interval — the next step is simply longer or shorter.
 */

export const LOOKAHEAD_MS = 25;
export const LOOKAHEAD_SECONDS = 0.1;
export const DEFAULT_STEPS_PER_BEAT = 4;
export const DEFAULT_STEPS_PER_BAR = 16;

/**
 * The fallback tempo, and the floor on it. `ui/params.js` already clamps
 * `global.tempo` to 40..220 BPM; this clamp is not a second policy but a guard
 * against a division by a zero or a negative period reaching the cursor. It is
 * deliberately NOT the store's range: the arithmetic stays honest for any positive
 * BPM, and params.js owns ranges.
 */
export const TEMPO_FALLBACK = 120;
const TEMPO_FLOOR = 1;

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

const clamp = (n, low, high) => (n < low ? low : n > high ? high : n);

/** Seconds per beat: 60 / BPM. 120 BPM is 0.5 s. */
export function beatPeriod(bpm) {
  const tempo = finite(bpm, TEMPO_FALLBACK);
  return 60 / (tempo > TEMPO_FLOOR ? tempo : TEMPO_FLOOR);
}

/** Seconds per step. Four steps to the beat, so a sixteenth at 120 BPM is 0.125 s. */
export function stepPeriod(bpm, stepsPerBeat = DEFAULT_STEPS_PER_BEAT) {
  const per = Math.max(1, Math.round(finite(stepsPerBeat, DEFAULT_STEPS_PER_BEAT)));
  return beatPeriod(bpm) / per;
}

/**
 * The swing offset for one step, in seconds. ZERO for an even sixteenth.
 *
 * At 50% nothing moves. At 75% the offbeat sixteenth is delayed half a sixteenth,
 * which is exactly the MPC convention: the eighth-note pair runs 75/25 instead of
 * 50/50. The store's `global.swing` range is 50..75%, so that is the clamp here.
 */
export function swingOffsetSeconds(step, period, swingPercent) {
  const grid = finite(period);
  if (!(grid > 0)) return 0;
  if (Math.abs(Math.round(finite(step))) % 2 === 0) return 0;
  const percent = clamp(finite(swingPercent, 50), 50, 75);
  return ((percent - 50) / 100) * 2 * grid;
}

/** When a step is actually placed: its grid time plus its swing offset. */
export function swungStepTime(base, step, period, swingPercent) {
  const from = finite(base);
  const index = finite(step);
  return from + index * period + swingOffsetSeconds(index, period, swingPercent);
}

/* ----------------------------------------------------------------- the clock --- */

/**
 * A lookahead scheduler over `context`.
 *
 * @param {object}   options
 * @param {object}   options.context  anything with a numeric `currentTime`.
 * @param {Function} options.read     reads a parameter key. Used for `global.tempo`
 *                                   and `global.swing`, so the clock tracks the
 *                                   store rather than holding a copy of it.
 * @param {object}   [options.timers] { setInterval, clearInterval }. Injected so a
 *                                   test can drive the tick by hand.
 * @param {Function} [options.onTempo] called with { tempo, beatPeriod, ... } whenever
 *                                   the tempo changes. Task 8's tempo-synced delay
 *                                   is wired here.
 */
export function createClock({
  context,
  read = () => undefined,
  timers = {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  },
  onTempo = null,
  stepsPerBar = DEFAULT_STEPS_PER_BAR,
  stepsPerBeat = DEFAULT_STEPS_PER_BEAT,
} = {}) {
  if (!context) throw new Error('clock: createClock needs a context to schedule against');

  const perBar = Math.max(1, Math.round(stepsPerBar));
  const perBeat = Math.max(1, Math.round(stepsPerBeat));

  const stepSubscribers = new Set();
  const positionSubscribers = new Set();
  const tempoSubscribers = new Set();

  let handle = null;
  let absoluteStep = 0;
  let nextStepTime = context.currentTime;
  let tempo = 0;
  let swing = 50;
  let period = 0;
  let ticks = 0;
  let scheduled = 0;
  let skipped = 0;

  /** Read the transport keys once per tick and publish a tempo change if any. */
  function syncTempo() {
    const bpm = read('global.tempo');
    const next = tempoValue(bpm);
    const nextSwing = clamp(finite(read('global.swing'), 50), 50, 75);
    const changed = next !== tempo;
    tempo = next;
    swing = nextSwing;
    period = stepPeriod(next, perBeat);
    if (!changed) return null;
    const info = tempoInfo();
    if (typeof onTempo === 'function') onTempo(info);
    for (const fn of [...tempoSubscribers]) fn(info);
    return info;
  }

  const tempoValue = (bpm) => {
    const value = finite(bpm, TEMPO_FALLBACK);
    return value > TEMPO_FLOOR ? value : TEMPO_FALLBACK;
  };

  // The clock knows its tempo from the moment it exists rather than from its first
  // tick, so `beatPeriod()` is answerable before the transport is started and a
  // tempo subscriber never has to wait for a step to be told where the beat is.
  syncTempo();

  function tempoInfo() {
    return Object.freeze({
      tempo,
      beatPeriod: beatPeriod(tempo),
      stepPeriod: period,
      swing,
      stepsPerBar: perBar,
      stepsPerBeat: perBeat,
    });
  }

  function position() {
    const step = absoluteStep % perBar;
    return Object.freeze({
      step,
      absoluteStep,
      bar: Math.floor(absoluteStep / perBar),
      beat: Math.floor((step % perBar) / perBeat),
      sixteenth: (step % perBar) % perBeat,
    });
  }

  /** One frozen event per step. Every consumer reads the same numbers. */
  function stepEvent() {
    const where = position();
    const time = nextStepTime;
    const swung = swingOffsetSeconds(where.step, period, swing);
    return Object.freeze({
      ...where,
      time,
      swungTime: time + swung,
      swung,
      tempo,
      beatPeriod: beatPeriod(tempo),
      stepPeriod: period,
      swing,
      stepsPerBar: perBar,
      stepsPerBeat: perBeat,
    });
  }

  function publish(event) {
    for (const fn of [...stepSubscribers]) fn(event);
    for (const fn of [...positionSubscribers]) fn(event);
  }

  /**
   * Walk the cursor forward while the next step is still inside the horizon.
   * Returns how many events were scheduled, which is 0 when the clock is caught up
   * and therefore idle in practice — the tick costs a Map lookup and nothing else.
   */
  function tick() {
    if (handle === null) return 0;
    ticks += 1;
    syncTempo();

    const now = context.currentTime;

    // A tab that was backgrounded, or a main thread that stalled, leaves the cursor
    // behind the audio clock. Catching up would fire the whole backlog in one burst,
    // so the skipped steps are counted and dropped instead: the cursor re-anchors
    // and the grid keeps its phase relative to now.
    if (nextStepTime < now - LOOKAHEAD_SECONDS) {
      skipped += Math.ceil((now - nextStepTime) / period);
      nextStepTime = now;
    }

    const horizon = now + LOOKAHEAD_SECONDS;
    let count = 0;
    while (nextStepTime < horizon) {
      publish(stepEvent());
      nextStepTime += period;
      absoluteStep += 1;
      count += 1;
    }
    scheduled += count;
    return count;
  }

  return {
    start() {
      if (handle !== null) return false;
      // Re-anchor rather than resume: the audio clock moved while the clock was
      // stopped, and scheduling into the past would fire everything at once.
      nextStepTime = context.currentTime;
      handle = timers.setInterval(tick, LOOKAHEAD_MS);
      return true;
    },

    stop() {
      if (handle === null) return false;
      timers.clearInterval(handle);
      handle = null;
      return true;
    },

    /** Run one scheduling pass by hand. Used by tests; harmless in the app. */
    tick,

    running: () => handle !== null,
    tempo: () => tempo,
    beatPeriod: () => beatPeriod(tempo),
    stepPeriod: () => period,
    swing: () => swing,
    stepCursor: () => absoluteStep % perBar,
    position,
    nextStepTime: () => nextStepTime,
    audioTime: () => context.currentTime,
    ticks: () => ticks,
    scheduledCount: () => scheduled,
    /** Steps dropped by a stall, rather than fired in a burst. */
    skippedCount: () => skipped,
    stepsPerBar: () => perBar,
    stepsPerBeat: () => perBeat,

    subscribeToSteps(fn) {
      stepSubscribers.add(fn);
      return () => stepSubscribers.delete(fn);
    },

    subscribeToPosition(fn) {
      positionSubscribers.add(fn);
      return () => positionSubscribers.delete(fn);
    },

    /**
     * Subscribe to tempo CHANGES. The current tempo is delivered immediately, so a
     * subscriber never has to read `clock.tempo()` first to know where it starts.
     */
    subscribeToTempo(fn) {
      tempoSubscribers.add(fn);
      if (tempo) fn(tempoInfo());
      return () => tempoSubscribers.delete(fn);
    },

    subscriberCount: () => stepSubscribers.size + positionSubscribers.size + tempoSubscribers.size,

    /** An immutable snapshot of everything the clock believes right now. */
    state() {
      return Object.freeze({
        running: handle !== null,
        tempo,
        beatPeriod: beatPeriod(tempo),
        stepPeriod: period,
        swing,
        ...position(),
        nextStepTime,
        audioTime: context.currentTime,
        ticks,
        scheduledCount: scheduled,
        skippedCount: skipped,
        lookaheadMs: LOOKAHEAD_MS,
        lookaheadSeconds: LOOKAHEAD_SECONDS,
        stepsPerBar: perBar,
        stepsPerBeat: perBeat,
        subscribers: stepSubscribers.size + positionSubscribers.size + tempoSubscribers.size,
      });
    },
  };
}