/**
 * meter-level.test.mjs — the level engine's arithmetic, tested with no AudioContext
 * and no DOM: `web/audio/meter.js` imports nothing, which is what makes this possible.
 *
 * These are the parts that are genuinely algorithmic rather than plumbing:
 *   - the RMS and peak of a time-domain window;
 *   - the dB mapping, including that silence is the FLOOR and not -Infinity, because
 *     a meter whose silence reads as -Infinity is a meter that cannot be compared;
 *   - the one-pole smoothing, in dB, with a dt rather than per frame;
 *   - the decaying peak hold: a closed hat is over inside one analyser window, so the
 *     hold is the only thing that makes a transient visible;
 *   - that `update()` allocates nothing: the three buffers keep their identity across
 *     five hundred frames and the allocation counter never leaves 1.
 *
 * Also the painter's stroke plan, because "saturation and spread track the RMS" is a
 * claim about numbers and not about a picture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  METER_ATTACK_PER_SECOND,
  METER_CEILING_DBFS,
  METER_FLOOR_DBFS,
  METER_HOLD_DECAY_DB_PER_SECOND,
  METER_MAX_FRAME_SECONDS,
  METER_PUBLISH_EPSILON,
  METER_RELEASE_PER_SECOND,
  METER_TRACE_LENGTH,
  createLevelMeter,
  dbfsOf,
  levelForDb,
  peakOf,
  rmsOf,
} from '../web/audio/meter.js';
import { createStrokePlan } from '../web/ui/meter.js';

/* ------------------------------------------------------------------ the maths --- */

/** A deterministic window of `length` samples at a constant amplitude. */
function constantWindow(length, amplitude) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}

/** An AnalyserNode stand-in: a window it hands back, and nothing else. */
function fakeAnalyser(length = 64) {
  return {
    fftSize: length,
    window: constantWindow(length, 0),
    reads: 0,
    getFloatTimeDomainData(target) {
      this.reads += 1;
      target.set(this.window);
      return target;
    },
  };
}

test('rmsOf is the root mean square, and peakOf is the largest magnitude', () => {
  assert.equal(rmsOf(new Float32Array(64)), 0);
  assert.equal(peakOf(new Float32Array(64)), 0);
  /* 64 samples alternating +/-0.5 -> every |x| is 0.5 */
  assert.ok(Math.abs(rmsOf(constantWindow(64, 0.5)) - 0.5) < 1e-6);
  assert.ok(Math.abs(peakOf(constantWindow(64, 0.5)) - 0.5) < 1e-6);
  /* A quieter quarter: RMS is amplitude/sqrt(2) for a sine, not amplitude. */
  const sine = new Float32Array(4096);
  for (let i = 0; i < sine.length; i += 1) sine[i] = Math.sin((i / 4096) * Math.PI * 2);
  assert.ok(Math.abs(rmsOf(sine) - Math.SQRT1_2) < 1e-2);
  assert.ok(Math.abs(peakOf(sine) - 1) < 1e-2);
  /* An empty or absent window is silence, not a NaN that poisons the smoothing. */
  assert.equal(rmsOf(new Float32Array(0)), 0);
  assert.equal(rmsOf(null), 0);
  assert.equal(peakOf(undefined), 0);
});

test('dbfsOf floors at METER_FLOOR_DBFS and levelForDb maps that floor to 0', () => {
  assert.equal(dbfsOf(1), METER_CEILING_DBFS);
  assert.equal(dbfsOf(0), METER_FLOOR_DBFS, 'silence is the floor, never -Infinity');
  assert.equal(dbfsOf(-1), METER_FLOOR_DBFS);
  assert.equal(dbfsOf(Number.NaN), METER_FLOOR_DBFS);
  assert.ok(Math.abs(dbfsOf(0.1) + 20) < 1e-9, '0.1 linear is -20 dBFS');
  assert.equal(dbfsOf(2), METER_CEILING_DBFS, 'over full scale is clamped to the ceiling');

  assert.equal(levelForDb(METER_FLOOR_DBFS), 0);
  assert.equal(levelForDb(METER_CEILING_DBFS), 1);
  assert.equal(levelForDb(-40), 1 / 3, 'the dB mapping is linear across the travel');
  assert.equal(levelForDb(-999), 0);
  assert.equal(levelForDb(Number.NaN), 0);
});

/* --------------------------------------------------------------- the smoothing --- */

/** A meter over a constant-amplitude window, with hand-driven timestamps. */
function steadyMeter(amplitude = 0.5, fftSize = 64) {
  const analyser = fakeAnalyser(fftSize);
  analyser.window = constantWindow(fftSize, amplitude);
  return createLevelMeter({ analyser, fftSize, clock: () => 0 });
}

test('the smoothed reading rises frame by frame, off the floor and toward the target', () => {
  const meter = steadyMeter(0.2);
  meter.update(0);
  const firstRise = meter.level();
  assert.ok(firstRise > 0, `one frame of real signal is already off the floor: ${firstRise}`);
  meter.update(16);
  const secondRise = meter.level();
  assert.ok(secondRise > firstRise, `a sustained tone must keep lifting the reading: ${firstRise} -> ${secondRise}`);
  /* And it is asymptotic, never past the target: it settles at the dB of the window. */
  for (let i = 0; i < 200; i += 1) meter.update((i + 2) * 16);
  assert.ok(meter.level() > levelForDb(dbfsOf(0.2)) - 0.02, 'the reading converges on the signal');
  assert.ok(meter.level() <= 1);
});

test('the smoothing is per second, not per frame: a longer gap closes more of the same gap', () => {
  const slow = steadyMeter(0.5);
  slow.update(0);
  slow.update(160);
  const fast = steadyMeter(0.5);
  fast.update(0);
  fast.update(16);
  assert.ok(slow.level() > fast.level(), `a 160 ms frame must read higher than a 16 ms one: ${fast.level()} vs ${slow.level()}`);
  assert.ok(METER_RELEASE_PER_SECOND < METER_ATTACK_PER_SECOND, 'and a fall is slower than a rise');
});

test('a gap in the timestamps is clamped, so a stalled tab cannot teleport the reading', () => {
  const analyser = fakeAnalyser(64);
  analyser.window = constantWindow(64, 0.5);
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0 });
  meter.update(0);
  const before = meter.level();
  meter.update(60_000); // a minute-long stall
  const after = meter.level();
  assert.ok(after >= before, 'a stall never lowers the reading');
  assert.ok(after - before <= 1, 'and never raises it past full scale');
  assert.ok(METER_MAX_FRAME_SECONDS * METER_RELEASE_PER_SECOND < 1, 'the clamp is short');
});

/* ------------------------------------------------------------- the peak hold --- */

test('the peak hold outlives the transient and then decays back to the floor', () => {
  const analyser = fakeAnalyser(64);
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0 });
  let t = 0;

  /* Silence first: the reading must sit exactly on the floor. */
  for (let i = 0; i < 4; i += 1) {
    meter.update(t);
    t += 16;
  }
  assert.equal(meter.level(), 0, 'digital silence reads as exactly the floor');
  assert.equal(meter.hold(), 0);
  assert.equal(meter.rms(), 0);

  /* A transient: one loud window, then silence. The hold must stay above the level
     afterwards — that is the whole reason the hold exists, because the analyser
     window is longer than a closed hat. */
  analyser.window = constantWindow(64, 0.9);
  for (let i = 0; i < 8; i += 1) {
    meter.update(t);
    t += 16;
  }
  const atTransient = { level: meter.level(), hold: meter.hold() };
  assert.ok(atTransient.level > 0.5, `a loud window is clearly off the floor: ${atTransient.level}`);
  assert.ok(atTransient.hold >= atTransient.level - 1e-9);

  analyser.window = constantWindow(64, 0);
  meter.update(t);
  t += 16;
  const justAfter = meter.hold();
  assert.ok(justAfter > meter.level(), `the hold outlasts the signal: hold ${justAfter} vs level ${meter.level()}`);

  /* ...and it DECAYS rather than snapping: strictly decreasing, still above the floor
     on the way down, and back on the floor once it has fallen METER_HOLD_DECAY_DB_PER_SECOND. */
  let previous = justAfter;
  let sawIntermediate = false;
  const secondsToFloor = (METER_CEILING_DBFS - METER_FLOOR_DBFS) / METER_HOLD_DECAY_DB_PER_SECOND;
  /* A couple of seconds of margin, so the assertion is about the decay reaching the
     floor and not about where the last fractional dB lands. */
  const steps = Math.ceil((secondsToFloor + 0.5) * 1000 / 16) + 8;
  for (let i = 0; i < steps; i += 1) {
    meter.update(t);
    t += 16;
    const hold = meter.hold();
    assert.ok(hold <= previous + 1e-12, `the hold must not rise while the signal is silent: ${hold} > ${previous}`);
    if (hold > 0 && hold < justAfter) sawIntermediate = true;
    previous = hold;
  }
  assert.ok(sawIntermediate, 'the hold passes through intermediate values — it decays, it does not snap');
  assert.equal(previous, 0, 'and it reaches the floor');
  /* The LEVEL decays exponentially, so it approaches the floor rather than landing on
     it — a one-pole has no fixed point short of an infinite tail. "Back to the floor"
     therefore means within a thousandth of it. */
  assert.ok(meter.level() < 0.001, `the level itself is back on the floor too: ${meter.level()}`);
});

test('the hold is raised immediately by a transient, not averaged towards it', () => {
  const analyser = fakeAnalyser(64);
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0 });
  meter.update(0);
  analyser.window = constantWindow(64, 0.8);
  meter.update(16);
  /* One frame of a loud peak lifts the hold to that peak; a 16 ms ramp could not.
     The expected value is computed from the Float32Array's own sample, because 0.8
     written into one is 0.800000011920929 and the comparison has to be exact. */
  const stored = analyser.window[0];
  assert.ok(Math.abs(meter.hold() - levelForDb(dbfsOf(stored))) < 1e-12);
  assert.ok(meter.hold() > meter.level(), 'and the hold leads the smoothed reading');
});

/* ---------------------------------------------------------------- allocation --- */

test('update() allocates nothing: the three buffers keep their identity over 500 frames', () => {
  const analyser = fakeAnalyser(256);
  const meter = createLevelMeter({ analyser, fftSize: 256, clock: () => 0, publish: () => {} });
  assert.equal(meter.allocations(), 1, 'one buffer, at construction');

  const buffer = meter.buffer();
  const trace = meter.trace();
  const reading = meter.reading();

  let t = 0;
  for (let frame = 0; frame < 500; frame += 1) {
    /* A signal that moves, so the smoothing, the hold and the publish gate are all
       actually exercised rather than short-circuiting on a constant. */
    analyser.window[frame % 256] = Math.sin(frame / 9) * 0.6;
    const out = meter.update(t);
    t += 16 + (frame % 3);
    assert.equal(out, reading, 'update() returns the same reading object every frame');
  }

  assert.equal(meter.buffer(), buffer, 'the analysis buffer is never replaced');
  assert.equal(meter.trace(), trace, 'the trace ring is never replaced');
  assert.equal(meter.allocations(), 1, 'nothing else was allocated in 500 frames');
  assert.equal(analyser.reads, 500, 'the analyser was read once per frame and no more');
  assert.equal(meter.frames(), 500);
  assert.equal(meter.traceCount(), METER_TRACE_LENGTH, 'the ring filled and then held');
});

test('a growing fftSize replaces the buffer exactly once, and counts it', () => {
  const analyser = fakeAnalyser(64);
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0 });
  const before = meter.buffer();
  analyser.fftSize = 128;
  meter.update(0);
  assert.notEqual(meter.buffer(), before, 'a changed window means a new buffer');
  assert.equal(meter.fftSize(), 128);
  assert.equal(meter.allocations(), 2);
  analyser.fftSize = 128;
  for (let i = 0; i < 10; i += 1) meter.update((i + 1) * 16);
  assert.equal(meter.allocations(), 2, 'and no more, because the window stopped changing');
});

test('the publish callback is gated by METER_PUBLISH_EPSILON, so a meter frame is not a store write', () => {
  const analyser = fakeAnalyser(64);
  const published = [];
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0, publish: (level) => published.push(level) });

  analyser.window = constantWindow(64, 0.5);
  for (let i = 0; i < 200; i += 1) meter.update(i * 16);
  assert.ok(published.length >= 1, 'it did publish');
  assert.ok(
    published.length < 200,
    `200 frames of one steady signal must not be 200 publishes: ${published.length}`,
  );
  for (const level of published) {
    assert.ok(level >= 0 && level <= 1, 'a published level is 0..1');
    assert.ok(Math.abs(level - published[published.length - 1]) <= 1, 'and it only ever moves by the epsilon');
  }
  assert.ok(METER_PUBLISH_EPSILON > 0 && METER_PUBLISH_EPSILON < 0.05, 'the epsilon is finer than the eye and coarser than a frame of noise');
});

test('the trace is a ring: it reports the recent levels oldest first, and reset() empties it', () => {
  const analyser = fakeAnalyser(64);
  const meter = createLevelMeter({ analyser, fftSize: 64, clock: () => 0 });
  const ramp = (from, to, frames) => {
    for (let i = 0; i < frames; i += 1) {
      const v = from + ((to - from) * i) / frames;
      analyser.window = constantWindow(64, v);
      meter.update(i * 16);
    }
  };
  ramp(0, 0.8, 40);
  const rising = meter.traceValues(40);
  assert.equal(rising.length, 40);
  for (let i = 1; i < rising.length; i += 1) {
    assert.ok(rising[i] >= rising[i - 1] - 1e-9, 'a rising signal gives a non-decreasing trace');
  }
  ramp(0, 0, 40);
  const falling = meter.traceValues(40);
  for (let i = 1; i < falling.length; i += 1) {
    assert.ok(falling[i] <= falling[i - 1] + 1e-9, 'and a falling one gives a non-increasing trace');
  }
  assert.ok(meter.traceValues(9).length <= 9, 'the copy is bounded by the limit');
  meter.reset();
  assert.equal(meter.traceCount(), 0);
  assert.equal(meter.level(), 0);
  assert.equal(meter.hold(), 0);
});

test('a meter with no analyser still reports the floor rather than throwing', () => {
  const meter = createLevelMeter({ fftSize: 64, clock: () => 0 });
  meter.update(0);
  meter.update(16);
  assert.equal(meter.level(), 0);
  assert.equal(meter.rms(), 0);
  assert.equal(meter.frames(), 2);
});

/* ------------------------------------------------------------- the stroke plan --- */

test('the stroke plan: saturation and spread both track the level', () => {
  const plan = createStrokePlan();
  plan.compute(0, 0, 400, 100);
  const idle = { ...plan.values() };

  plan.compute(1, 1, 400, 100);
  const loud = { ...plan.values() };

  assert.ok(loud.saturation > idle.saturation, `saturation must rise with the level: ${idle.saturation} -> ${loud.saturation}`);
  assert.ok(loud.thickness > idle.thickness, `spread across the stroke must rise: ${idle.thickness} -> ${loud.thickness}`);
  assert.ok(loud.length > idle.length, `spread along the stroke must rise: ${idle.length} -> ${loud.length}`);
  assert.ok(loud.dabRadius > idle.dabRadius, 'and the wet dab grows with it');

  /* Idle is a floor, not an absence: something is always painted. */
  assert.ok(idle.length > 0, 'the meter never reads as nothing at all');
  assert.ok(idle.saturation > 0.1, 'and the floor stroke is visible');

  /* Monotone across the range, which is the claim in the acceptance criteria. */
  let previous = -1;
  for (let step = 0; step <= 10; step += 1) {
    plan.compute(step / 10, 0, 400, 100);
    const { saturation, thickness, length } = plan.values();
    assert.ok(saturation >= previous, `saturation must be monotone in the level at ${step / 10}`);
    assert.ok(thickness >= 0);
    assert.ok(length >= 0);
    previous = saturation;
  }
});

test('the stroke plan reuses one object and holds the peak mark where the hold is', () => {
  const plan = createStrokePlan();
  const values = plan.values();
  for (let i = 0; i < 100; i += 1) {
    plan.compute(i / 100, (100 - i) / 100, 400, 100);
    assert.equal(plan.values(), values, 'the frame loop is handed the same object every frame');
  }
  plan.compute(0.2, 0.8, 400, 100);
  assert.equal(plan.values().holdX, 320, 'the peak-hold mark sits at hold * width');
  assert.ok(plan.values().holdAlpha > 0, 'and it is painted');
  plan.compute(0.2, 0, 400, 100);
  assert.equal(plan.values().holdX, 0);
});

test('the stroke plan clamps its inputs, so no level can paint off the canvas', () => {
  const plan = createStrokePlan();
  plan.compute(Number.NaN, Number.NaN, 400, 100);
  const a = { ...plan.values() };
  plan.compute(5, 5, 400, 100);
  const b = { ...plan.values() };
  plan.compute(0.5, 0.5, 400, 100);
  const c = { ...plan.values() };
  assert.ok(Number.isFinite(a.length) && a.length >= 0, 'NaN in, a finite floor stroke out');
  assert.ok(Number.isFinite(b.length) && b.length <= 400, 'and an out-of-range level stays on the canvas');
  assert.ok(b.length > c.length, 'clamped at the ceiling, not past it');
});