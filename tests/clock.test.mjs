/**
 * clock.test.mjs — the lookahead scheduler's arithmetic, its step cursor, its
 * swing, and the structural guarantee that it is the ONLY timer in the instrument.
 *
 * WHAT IS ASSERTED AND WHY
 *   The plan names the single-clock rule its highest-risk-to-violate constraint, so
 *   two of these tests are about the SOURCE rather than about behaviour:
 *
 *     - "the instrument contains exactly one setInterval, and it is the clock's"
 *     - "no module reads Date.now() or performance.now() to schedule audio"
 *
 *   Those two walk `web/` from disk, which means the guarantee survives every later
 *   task in the plan: task 7's LFOs, task 8's delay, task 10's sequencer and
 *   arpeggiator all run this file, and the first one of them to add a timer fails
 *   here rather than shipping a sequencer that drifts.
 *
 * The rest is pure arithmetic, which is the part worth unit testing: the beat
 * period, the sixteenth grid, the swing offset on odd sixteenths, the cursor's
 * monotonic advance, and the 25 ms / 100 ms lookahead window driven by an explicit
 * clock so the test never sleeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDrumFakeAudioContext } from './drum-fake-audio.mjs';
import {
  DEFAULT_STEPS_PER_BAR,
  DEFAULT_STEPS_PER_BEAT,
  LOOKAHEAD_MS,
  LOOKAHEAD_SECONDS,
  beatPeriod,
  createClock,
  stepPeriod,
  swingOffsetSeconds,
  swungStepTime,
} from '../web/audio/clock.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/* ------------------------------------------------------------- the scheduler --- */

test('the tick is 25 ms and the horizon is 100 ms — the two numbers the plan fixes', () => {
  assert.equal(LOOKAHEAD_MS, 25);
  assert.equal(LOOKAHEAD_SECONDS, 0.1);
});

test('the beat period is 60/BPM, so tempo change moves it proportionally', () => {
  assert.equal(beatPeriod(120), 0.5);
  assert.equal(beatPeriod(60), 1);
  // Doubling the tempo halves the beat: proportionality, not an offset.
  assert.ok(Math.abs(beatPeriod(240) * 2 - beatPeriod(120)) < 1e-12);
  // And 120 BPM -> 90 BPM is exactly 4/3 of the period.
  assert.ok(Math.abs(beatPeriod(90) / beatPeriod(120) - 4 / 3) < 1e-12);
});

test('the step grid is four sixteenths per beat and sixteen per bar', () => {
  assert.equal(DEFAULT_STEPS_PER_BEAT, 4);
  assert.equal(DEFAULT_STEPS_PER_BAR, 16);
  // 120 BPM -> 0.5 s per beat -> 0.125 s per sixteenth.
  assert.equal(stepPeriod(120), 0.125);
  assert.equal(stepPeriod(120) * DEFAULT_STEPS_PER_BAR, 2);
});

test('swing at 50% is no offset at all, and it only moves ODD sixteenths', () => {
  const period = stepPeriod(120); // 0.125
  for (let step = 0; step < DEFAULT_STEPS_PER_BAR; step += 1) {
    assert.equal(swingOffsetSeconds(step, period, 50), 0, `step ${step} must not move at 50%`);
  }
  // At 75% the offbeat 16th is pushed half a sixteenth late: the eighth-note pair
  // runs 75/25 instead of 50/50.
  assert.equal(swingOffsetSeconds(1, period, 75), period * 0.5);
  assert.equal(swingOffsetSeconds(3, period, 75), period * 0.5);
  assert.equal(swingOffsetSeconds(0, period, 75), 0);
  assert.equal(swingOffsetSeconds(2, period, 75), 0);
  // Halfway between straight and full swing.
  assert.equal(swingOffsetSeconds(1, period, 62.5), period * 0.25);
});

test('swing delays an odd sixteenth without moving the bar length', () => {
  const period = stepPeriod(120);
  const base = 10;
  // The even sixteenths stay on the grid, so a bar is still exactly 16 periods long
  // and the next bar's downbeat is unmoved. Swing reshapes the pair, not the bar.
  assert.equal(swungStepTime(base, 0, period, 75), base);
  assert.equal(swungStepTime(base, 15, period, 75), base + 15 * period + 0.5 * period);
  const barEnd = swungStepTime(base, 16, period, 75);
  assert.equal(barEnd, base + 16 * period);

  // Inside one eighth-note pair the two halves are long and short, and together they
  // are exactly one pair — which is why swing changes the feel and not the tempo.
  const longHalf = swungStepTime(base, 1, period, 75) - swungStepTime(base, 0, period, 75);
  const shortHalf = swungStepTime(base, 2, period, 75) - swungStepTime(base, 1, period, 75);
  assert.equal(longHalf, 1.5 * period);
  assert.equal(shortHalf, 0.5 * period);
  assert.equal(longHalf + shortHalf, 2 * period);
});

/* -------------------------------------------------------------- the cursor --- */

/** A clock on a fake context, with an injected timer so the test drives the tick. */
function makeClock({ bpm = 120, swing = 50, now = 0 } = {}) {
  const context = createDrumFakeAudioContext({ now });
  const timers = [];
  const table = { 'global.tempo': bpm, 'global.swing': swing };
  const clock = createClock({
    context,
    read: (key) => table[key],
    timers: {
      setInterval: (fn, ms) => {
        timers.push({ fn, ms, handle: timers.length + 1 });
        return timers.length;
      },
      clearInterval: () => {},
    },
  });
  return { context, clock, timers, table, tick: () => timers[0]?.fn?.() };
}

test('starting the clock arms exactly one interval, at 25 ms', () => {
  const { clock, timers } = makeClock();
  assert.equal(clock.running(), false);
  clock.start();
  assert.equal(clock.running(), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, LOOKAHEAD_MS);
  clock.stop();
  assert.equal(clock.running(), false);
});

test('starting an already-running clock does not arm a second interval', () => {
  const { clock, timers } = makeClock();
  clock.start();
  clock.start();
  assert.equal(timers.length, 1);
});

test('the cursor advances monotonically and only ever schedules AHEAD of the audio clock', () => {
  const { context, clock, tick } = makeClock({ bpm: 120 });
  clock.start();
  const seen = [];
  clock.subscribeToSteps((event) => seen.push(event));

  let previousTime = -Infinity;
  let previousAbsolute = -Infinity;
  // 400 rounds of a 25 ms tick is 10 s of audio time: at 120 BPM that is 80
  // sixteenths, so the cursor must have walked five bars.
  for (let round = 0; round < 400; round += 1) {
    tick();
    for (const event of seen) {
      // Strictly increasing: no step is ever scheduled at or before the last one.
      assert.ok(event.time > previousTime, `time went backwards: ${event.time} <= ${previousTime}`);
      assert.ok(event.absoluteStep > previousAbsolute, 'absolute step went backwards');
      previousTime = event.time;
      previousAbsolute = event.absoluteStep;
    }
    seen.length = 0;
    // The audio clock advances in 25 ms steps, exactly like the real tick.
    context.advance(0.025);
  }

  assert.ok(previousAbsolute >= 78, `expected the cursor to have walked five bars, got ${previousAbsolute}`);
  assert.ok(previousAbsolute <= 82, `the cursor ran away from the audio clock: ${previousAbsolute}`);
  // Every event landed inside the 100 ms horizon ahead of the clock that scheduled it.
  assert.ok(previousTime <= context.currentTime + LOOKAHEAD_SECONDS + 1e-9);
  assert.ok(clock.nextStepTime() > context.currentTime, 'nextStepTime must stay ahead of the audio clock');
  // Nothing was dropped, because the tick kept up with the audio clock exactly.
  assert.equal(clock.skippedCount(), 0);
});

test('the step cursor wraps the bar while the absolute step keeps counting', () => {
  const { context, clock, tick } = makeClock({ bpm: 240 }); // 0.0625 s per step
  clock.start();
  const positions = [];
  clock.subscribeToSteps((event) => positions.push(event));
  for (let i = 0; i < 40; i += 1) {
    tick();
    context.advance(0.025);
  }
  const steps = positions.map((event) => event.step);
  assert.ok(steps.includes(0), 'the cursor must come back round to the downbeat');
  // Beat and sixteenth are derived from the grid, so bar 1 beat 2 is reachable.
  assert.ok(positions.some((event) => event.bar === 0 && event.beat === 1 && event.sixteenth === 0));
  // Absolute step is monotonic and larger than the wrapped step.
  assert.ok(positions[positions.length - 1].absoluteStep > positions[0].absoluteStep);
  assert.ok(clock.stepCursor() >= 0 && clock.stepCursor() < DEFAULT_STEPS_PER_BAR);
});

test('the clock schedules against AudioContext.currentTime and never a wall clock', () => {
  const { context, clock, tick } = makeClock({ bpm: 120, now: 5 });
  clock.start();
  const times = [];
  clock.subscribeToSteps((event) => times.push(event.time));
  tick();
  // The downbeat is placed at wherever the audio clock stood when the clock started —
  // so the first step is audible within one tick. At 120 BPM a sixteenth is 125 ms
  // and the horizon is 100 ms, so exactly one step fits in the first pass.
  assert.deepEqual(times, [5]);
  context.advance(0.05);
  tick();
  assert.deepEqual(times, [5, 5 + stepPeriod(120)], 'the second step is one period later, still inside the horizon');
  assert.ok(times.every((time) => time >= 5 && time <= context.currentTime + LOOKAHEAD_SECONDS + 1e-9));
  assert.equal(context.currentTime, 5.05, 'scheduling must not advance the audio clock itself');
});

test('a tempo change moves the beat period proportionally, from the store, with no restart', () => {
  const { context, clock, tick, table, timers } = makeClock({ bpm: 120 });
  clock.start();
  tick();
  const before = clock.state();
  assert.equal(before.beatPeriod, 0.5);

  table['global.tempo'] = 60;
  tick();
  const after = clock.state();
  assert.equal(after.tempo, 60);
  assert.equal(after.beatPeriod, 1);
  assert.ok(Math.abs(after.beatPeriod / before.beatPeriod - 2) < 1e-12);
  // The interval was never re-armed: a tempo change is a value read, not a restart.
  assert.equal(timers.length, 1);
  context.advance(0.025);
});

test('a tempo change is published to tempo subscribers, which also get the current tempo on subscribing', () => {
  const { clock, tick, table } = makeClock({ bpm: 120 });
  clock.start();
  const seen = [];
  clock.subscribeToTempo((info) => seen.push(info));
  // Delivered on subscribe, so a consumer never has to read the tempo separately.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tempo, 120);
  tick();
  assert.equal(seen.length, 1, 'an unchanged tempo must not publish again');
  table['global.tempo'] = 90;
  tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].tempo, 90);
  assert.ok(Math.abs(seen[1].beatPeriod - 2 / 3) < 1e-12);
});

test('position subscribers see bar/beat, and unsubscribing really stops the callbacks', () => {
  const { context, clock, tick } = makeClock();
  clock.start();
  const steps = [];
  const positions = [];
  const stopSteps = clock.subscribeToSteps((event) => steps.push(event.step));
  clock.subscribeToPosition((position) => positions.push(position));
  tick();
  context.advance(0.025);
  tick();
  const afterTwo = steps.length;
  assert.ok(afterTwo > 0);
  assert.equal(positions.length, afterTwo, 'both subscribers see the same events');
  assert.deepEqual(positions[0].stepsPerBar, DEFAULT_STEPS_PER_BAR);

  stopSteps();
  tick();
  context.advance(0.025);
  assert.equal(steps.length, afterTwo, 'an unsubscribed step handler must stop firing');
});

/* ------------------------------------------------- the single-clock guarantee --- */

function everySourceFile(dir = WEB_DIR, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everySourceFile(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Which files in web/ mention `pattern` at all. */
function filesMentioning(pattern) {
  return everySourceFile()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(WEB_DIR, file).split(sep).join('/'))
    .sort();
}

/** Every occurrence of `pattern` in web/, as { file, line, text }. */
function findAll(pattern) {
  const hits = [];
  for (const file of everySourceFile()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (pattern.test(text)) {
        hits.push({ file: relative(WEB_DIR, file).split(sep).join('/'), line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

/**
 * The single-clock guarantee, stated as the strongest thing that can be checked
 * without running the instrument: only the clock module mentions an interval at all,
 * and within it exactly one call ARMS one.
 *
 * The distinction matters. `audio/clock.js` names the global twice — once as the
 * default implementation of the INJECTED timer dependency, which is the seam a test
 * replaces, and once at the arming site. A second module doing either of those things
 * would be a second clock, which is what this asserts against.
 */
test('the whole instrument mentions setInterval in exactly one file, and it is the clock', () => {
  assert.deepEqual(
    filesMentioning(/\bsetInterval\b/),
    ['audio/clock.js'],
    'a module other than the clock mentions setInterval, which means a second timer',
  );

  const source = readFileSync(join(WEB_DIR, 'audio/clock.js'), 'utf8');
  const arming = source.match(/\bsetInterval\(\s*tick\s*,\s*LOOKAHEAD_MS\s*\)/g) ?? [];
  assert.equal(arming.length, 1, `the clock must arm exactly one interval, found ${arming.length}`);
});

test('the only setTimeout in web/ is the reverb-impulse debounce, which is an injected scheduler default', () => {
  const hits = findAll(/\bsetTimeout\s*\(/);
  // web/audio/chain.js holds the IR rebuild debounce, and it arrives as an
  // INJECTABLE `scheduler.defer` — the default implementation of a parameter tests
  // replace. It is a debounce on a parameter change, not a musical timer: it never
  // decides when a note happens. Any setTimeout anywhere else is a second clock.
  const musical = hits.filter((hit) => hit.file !== 'audio/chain.js');
  assert.deepEqual(musical, [], `a setTimeout outside chain.js is a musical timer:\n${JSON.stringify(musical, null, 2)}`);
});

/**
 * The wall-clock call sites that already exist in `web/`, each with WHY it is not a
 * musical clock. Anything else that reads the wall clock fails the test below, so a
 * later task that reaches for one has to argue with this list rather than slip past it.
 */
const WALL_CLOCK_ALLOWLIST = {
  'ui/paint.js': 'dab lifetimes in the reactive paint layer — a visual clock, never an audio one',
  'audio/ir.js': 'elapsed-time comparison behind the impulse-response rebuild debounce',
  'audio/wavesampler.js': 'an ISO timestamp on the loaded-wavetable status line',
};

test('nothing in web/ schedules audio off the wall clock', () => {
  const patterns = [/\bDate\s*\.\s*now\s*\(/, /\bperformance\s*\.\s*now\s*\(/, /\bnew\s+Date\s*\(/];
  const unexpected = [];
  for (const pattern of patterns) {
    for (const hit of findAll(pattern)) {
      if (!WALL_CLOCK_ALLOWLIST[hit.file]) unexpected.push({ ...hit, pattern: String(pattern) });
    }
  }
  assert.deepEqual(
    unexpected,
    [],
    `a wall-clock read outside the allowlist is a second clock's opinion:\n${JSON.stringify(unexpected, null, 2)}`,
  );
});

test('the clock and the drum engine never read the wall clock at all', () => {
  // The two modules task 9 owns, called out by name rather than left to the allowlist:
  // these are the ones that decide WHEN a drum hit happens.
  const owned = findAll(/\bDate\s*\.\s*now\s*\(|\bperformance\s*\.\s*now\s*\(|\bnew\s+Date\s*\(/)
    .filter((hit) => /^audio\/(clock|drums|drum-)/.test(hit.file));
  assert.deepEqual(owned, [], `task 9 must schedule only against AudioContext.currentTime:\n${JSON.stringify(owned, null, 2)}`);
});

test('every audio module schedules against the context clock', () => {
  // The clock is the only thing allowed to own musical time, and it has to own it by
  // reading currentTime. Guard the one module that could quietly grow its own idea
  // of time.
  const source = readFileSync(join(WEB_DIR, 'audio/clock.js'), 'utf8');
  assert.match(source, /currentTime/, 'the clock must read AudioContext.currentTime');
  assert.match(source, /setInterval/, 'the clock must own the one interval');
});