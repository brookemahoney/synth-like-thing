/**
 * meter.js — the level engine behind the output meter. RMS, its smoothing, and the
 * decaying peak hold, and nothing else: no DOM, no store, no audio node.
 *
 * WHY THIS FILE IS SEPARATE FROM web/ui/meter.js
 *   Because these are the parts that are genuinely algorithmic, and an algorithmic
 *   part is only testable if it can be imported without an AudioContext. This file
 *   imports NOTHING. The analyser is handed in, the level is published through a
 *   callback, and the caller decides where it goes. ui/meter.js binds it to the
 *   chain's analyser and to the parameter store, in the browser.
 *
 * THE METER PUBLISHES THROUGH A CALLBACK, NOT THROUGH THE STORE
 *   The store is the single authority for what a parameter IS; an output LEVEL is a
 *   measurement, not a parameter. ui/meter.js decides where it is published (it is
 *   `global.meter`, the key ui/paint.js documents as the one its dab layer reads), so
 *   this file has no opinion about it and no import that would drag the audio graph
 *   in behind it.
 *
 * NO PER-FRAME ALLOCATION — THE WHOLE POINT
 *   This runs for as long as the page is open, so it is the one thing in the
 *   instrument that never stops. Everything it needs is allocated once, in the
 *   factory:
 *
 *     buffer   one Float32Array, the analyser's time-domain window, filled by
 *              getFloatTimeDomainData every frame. It is replaced ONLY if fftSize
 *              ever changes, which is counted in `allocations()` so a regression is
 *              visible rather than silent.
 *     reading  one mutable object, returned by reference from `update()`. The handle
 *              and the painter read its fields; nobody ever gets a second copy.
 *     trace    one Float32Array ring of the last METER_TRACE_LENGTH levels, for the
 *              self-validation envelope check (plan step 9).
 *
 *   `update()` creates no object, no array and no string. The test asserts the three
 *   buffers keep their identity across five hundred frames.
 *
 * THE MEASUREMENT, AND WHY IT IS IN DECIBELS
 *   RMS of a synthesised note lands around 0.02..0.3 linear. A linear 0..1 meter
 *   spends nine tenths of its travel on silence and reads as broken. So the reported
 *   LEVEL is 20*log10(rms) mapped from METER_FLOOR_DBFS..METER_CEILING_DBFS onto
 *   0..1, and the raw linear rms/peak are reported alongside it, unconverted, for
 *   anyone asserting on real sample values.
 *
 *   The peak hold is held in the same dB space and falls at
 *   METER_HOLD_DECAY_DB_PER_SECOND. A peak that snapped to the current reading would
 *   show nothing: the analyser window is 42.7 ms, so a closed hat is over and gone
 *   inside one window. The hold is what makes a transient visible.
 *
 * SMOOTHING IS TIME-BASED, NOT PER-FRAME
 *   A per-frame coefficient is a frame-rate-dependent meter: the reading changes
 *   meaning when the tab is throttled or a frame is dropped, which is exactly when
 *   the player most wants the meter to be honest. So both the one-pole and the hold
 *   decay take a dt, clamped to METER_MAX_FRAME_SECONDS so a stall (a tab in the
 *   background, a garbage collection) does not teleport the reading.
 *
 * THERE IS NO WALL CLOCK IN THIS FILE
 *   The dt comes from the timestamp requestAnimationFrame already hands the frame
 *   loop, or from an injected clock in a test. No wall-clock read appears here, not
 *   even in the default argument, because tests/clock.test.mjs holds that every one
 *   under web/ is a declared exception with a stated reason — and a meter's idea of
 *   elapsed time is not worth one. It would also be the wrong clock: the frame clock
 *   is the one this smoothing actually models.
 */

/* --------------------------------------------------------------- the constants --- */

/** The store key the level is published under: the one ui/paint.js documents. */
export const METER_LEVEL_KEY = 'global.meter';

/** -60 dBFS is the floor. Silence maps to exactly 0, so "at the floor" is a fact. */
export const METER_FLOOR_DBFS = -60;
/** 0 dBFS is full scale, the top of the travel. */
export const METER_CEILING_DBFS = 0;

/** How fast the reading closes the gap on a rise, per second. Fast enough that a
 *  note attack reads as an attack rather than as a ramp over two seconds. */
export const METER_ATTACK_PER_SECOND = 12;
/** ...and on a fall, per second: slower than the rise, so a released chord fades. */
export const METER_RELEASE_PER_SECOND = 3.2;

/** The peak hold falls this many dB per second: 0 to the floor in three seconds. */
export const METER_HOLD_DECAY_DB_PER_SECOND = 20;

/** A frame longer than this is treated as this long, so a stall cannot teleport. */
export const METER_MAX_FRAME_SECONDS = 0.25;
/** Assumed frame length for the first update, which has no previous timestamp. */
export const METER_FIRST_FRAME_SECONDS = 1 / 60;

/** How many levels the ring keeps, for the plan's envelope-trace check. */
export const METER_TRACE_LENGTH = 256;

/**
 * The level is only re-published when it has moved this far. A store write notifies
 * every subscriber in the instrument, and the meter does not need 0.1% resolution:
 * this is what keeps a per-frame measurement from becoming a per-frame fan-out.
 */
export const METER_PUBLISH_EPSILON = 0.002;

/* ------------------------------------------------------------------ the maths --- */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Linear amplitude -> dBFS, floored at METER_FLOOR_DBFS. Silence is the floor, not -Infinity. */
export function dbfsOf(amplitude) {
  const n = Number(amplitude);
  if (!Number.isFinite(n) || n <= 0) return METER_FLOOR_DBFS;
  const db = 20 * Math.log10(n);
  return db < METER_FLOOR_DBFS ? METER_FLOOR_DBFS : db > METER_CEILING_DBFS ? METER_CEILING_DBFS : db;
}

/** dBFS -> the 0..1 level the meter paints and publishes. */
export function levelForDb(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return 0;
  return clamp01((n - METER_FLOOR_DBFS) / (METER_CEILING_DBFS - METER_FLOOR_DBFS));
}

/** The linear RMS of a time-domain window. Reads the array; writes nothing. */
export function rmsOf(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i];
    sum += value * value;
  }
  return Math.sqrt(sum / buffer.length);
}

/** The largest absolute sample in a time-domain window. */
export function peakOf(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i] < 0 ? -buffer[i] : buffer[i];
    if (value > peak) peak = value;
  }
  return peak;
}

/** The one-pole step for a dt, from a rate in "gaps closed per second". */
function approach(current, target, ratePerSecond, seconds) {
  return current + (target - current) * (1 - Math.exp(-ratePerSecond * seconds));
}

/* -------------------------------------------------------------------- the meter --- */

/**
 * The level meter. Nothing here creates, connects or starts an audio node: the
 * analyser is a constructor argument and the only thing done to it is
 * getFloatTimeDomainData.
 *
 * @param {object}   options
 * @param {object}   options.analyser   an AnalyserNode — read, never connected
 * @param {number}   options.fftSize    the window size, normally ANALYSER_FFT_SIZE
 * @param {Function} options.publish    (level) => void, called only on a real change
 * @param {Function} options.clock      monotonic ms, only if `update()` is called bare
 */
export function createLevelMeter({ analyser = null, fftSize = 2048, publish = null, clock = null } = {}) {
  const size = Math.max(2, Math.round(Number(fftSize) || 2048));

  /* --- the three buffers, allocated once ------------------------------------ */

  let buffer = new Float32Array(size);
  let allocations = 1;
  let liveSize = size;

  const reading = { rms: 0, peak: 0, dbfs: METER_FLOOR_DBFS, level: 0, hold: 0, holdDbfs: METER_FLOOR_DBFS, frames: 0 };
  const trace = new Float32Array(METER_TRACE_LENGTH);
  let traceAt = 0;
  let traceCount = 0;

  /* --- the state ------------------------------------------------------------- */

  let smoothedDb = METER_FLOOR_DBFS;
  let holdDb = METER_FLOOR_DBFS;
  let frames = 0;
  let published = 0;
  let previousStamp = null;

  /** The window the analyser is actually using, grown if it ever differs. */
  function syncWindow() {
    const actual = analyser && Number.isFinite(analyser.fftSize) ? analyser.fftSize : liveSize;
    if (actual === liveSize) return false;
    liveSize = Math.max(2, Math.round(actual));
    buffer = new Float32Array(liveSize);
    allocations += 1;
    return true;
  }

  /**
   * One frame. Fills the reusable buffer, measures, smooths, decays the hold,
   * appends to the trace and publishes if the published level has moved.
   *
   * Returns the SAME `reading` object every time. It is mutated in place and must
   * not be retained across frames by a caller that wants a history — the trace ring
   * is the history.
   */
  function update(timestamp) {
    const stamp = Number.isFinite(timestamp) ? timestamp : (typeof clock === 'function' ? clock() : null);
    let seconds = METER_FIRST_FRAME_SECONDS;
    if (stamp !== null && Number.isFinite(stamp)) {
      if (previousStamp !== null) {
        const delta = (stamp - previousStamp) / 1000;
        if (delta > 0) seconds = delta > METER_MAX_FRAME_SECONDS ? METER_MAX_FRAME_SECONDS : delta;
      }
      previousStamp = stamp;
    }

    syncWindow();
    if (analyser && typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(buffer);
    }

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < liveSize; i += 1) {
      const value = buffer[i];
      sum += value * value;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
    }
    const rms = Math.sqrt(sum / liveSize);
    const rmsDb = dbfsOf(rms);

    smoothedDb = approach(smoothedDb, rmsDb, rmsDb > smoothedDb ? METER_ATTACK_PER_SECOND : METER_RELEASE_PER_SECOND, seconds);

    /* THE PEAK HOLD. Decay first, then take the higher of what is left and this
       window's peak: so the hold is the highest peak of the last ~3 s, and a new
       transient lifts it immediately. */
    holdDb -= METER_HOLD_DECAY_DB_PER_SECOND * seconds;
    if (holdDb < METER_FLOOR_DBFS) holdDb = METER_FLOOR_DBFS;
    const peakDb = dbfsOf(peak);
    if (peakDb > holdDb) holdDb = peakDb;

    frames += 1;
    trace[traceAt] = levelForDb(smoothedDb);
    traceAt = (traceAt + 1) % METER_TRACE_LENGTH;
    if (traceCount < METER_TRACE_LENGTH) traceCount += 1;

    reading.rms = rms;
    reading.peak = peak;
    reading.dbfs = smoothedDb;
    reading.level = levelForDb(smoothedDb);
    reading.holdDbfs = holdDb;
    reading.hold = levelForDb(holdDb);
    reading.frames = frames;

    if (publish && Math.abs(reading.level - published) > METER_PUBLISH_EPSILON) {
      published = reading.level;
      publish(reading.level);
    }

    return reading;
  }

  /** The level history, oldest first, at most `limit` entries. The one copying read. */
  function traceValues(limit = METER_TRACE_LENGTH) {
    const count = Math.min(traceCount, Math.max(0, Math.min(METER_TRACE_LENGTH, Math.round(limit) || 0)));
    const out = new Array(count);
    const start = (traceAt - count + METER_TRACE_LENGTH * 2) % METER_TRACE_LENGTH;
    for (let i = 0; i < count; i += 1) out[i] = trace[(start + i) % METER_TRACE_LENGTH];
    return out;
  }

  return {
    /** The analyser's time-domain window. Its identity must never change. */
    buffer: () => buffer,
    /** The per-frame reading. Mutated in place; never copied per frame. */
    reading: () => reading,
    /** The level history ring. Its identity must never change. */
    trace: () => trace,
    traceCount: () => traceCount,
    traceValues,

    update,
    reset() {
      smoothedDb = METER_FLOOR_DBFS;
      holdDb = METER_FLOOR_DBFS;
      published = 0;
      previousStamp = null;
      trace.fill(0);
      traceAt = 0;
      traceCount = 0;
      reading.rms = 0;
      reading.peak = 0;
      reading.dbfs = METER_FLOOR_DBFS;
      reading.level = 0;
      reading.holdDbfs = METER_FLOOR_DBFS;
      reading.hold = 0;
      return true;
    },

    /** Raw, unsmoothed linear RMS over the last window. A direct measurement. */
    rms: () => reading.rms,
    /** Raw, unsmoothed linear peak over the last window. */
    peak: () => reading.peak,
    /** The smoothed reading in dBFS. */
    dbfs: () => reading.dbfs,
    /** The smoothed reading as 0..1. This is the level the painter follows. */
    level: () => reading.level,
    /** The decaying peak hold as 0..1. Above `level()` right after a transient. */
    hold: () => reading.hold,
    holdDbfs: () => reading.holdDbfs,
    frames: () => frames,
    /** How many buffers have ever been allocated. 1 after construction is correct. */
    allocations: () => allocations,
    fftSize: () => liveSize,
    published: () => published,
  };
}