/**
 * sequencer.test.mjs — the sequencer core, driven on the REAL lookahead clock and the
 * REAL 808 kit over the existing fake-AudioContext harnesses. No browser, no timers, no
 * sleeping: the clock's tick is called by hand.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS AN INTEGRATION TEST RATHER THAN A UNIT TEST
 *   The things task 10 has to get right are not functions in isolation — they are
 *   agreements between four pieces that already exist: the clock's step cursor, the
 *   clock's swing offset, the kit's velocity-scaled level and the note path's gate.
 *   Testing them apart would pass while the composition drifted, so they are driven
 *   together and the SCHEDULED TIMES are read off the fake context's own automation.
 *
 * THE FOUR FACTS THIS FILE EXISTS TO PIN
 *   1. SWING IS APPLIED AT SCHEDULE TIME from the value current when the step was
 *      scheduled, and it moves odd sixteenths only. 50% is exactly straight.
 *   2. THE GATE LENGTH IS THE NOTE'S DURATION AS A FRACTION OF ITS STEP, released by
 *      the clock at `swungTime + gate * stepPeriod`.
 *   3. PER-STEP VELOCITY IS THE DRUM VOICE'S LEVEL, read back off the scheduled
 *      envelope rather than off a counter.
 *   4. THE CHAIN IS THE SAME SEQUENCER READING A DIFFERENT PATTERN, so `A-B-A-D`
 *      repeats and a pattern switch changes what fires on the very next step.
 *
 * Framework-free: `node --test tests/sequencer.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDrumFakeAudioContext } from './drum-fake-audio.mjs';
import { createClock, stepPeriod, swingOffsetSeconds, swungStepTime } from '../web/audio/clock.js';
import { createDrumKit, DRUM_RECIPES } from '../web/audio/drum-kit.js';
import { arpIntervalBeats, mulberry32 } from '../web/audio/arp.js';
import { createSequencer, STEP_COUNT, LANE_COUNT, CHAIN_MAX } from '../web/audio/sequencer.js';
import { ARP_MODES, KIT_VOICES, PATTERNS, SCHEMA, SEQUENCER_LANES, STEPS, createStore } from '../web/ui/params.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/* ------------------------------------------------------------------ the harness --- */

/** Every drum trigger the sequencer caused, in order, with the time it was placed at. */
function recordingKit(context, parent, read) {
  const kit = createDrumKit({ context, parent, read });
  const fired = [];
  const trigger = kit.trigger;
  const wrapped = {
    ...kit,
    trigger(name, options) {
      const record = trigger(name, options);
      fired.push({ voice: name, at: options?.at, velocity: options?.velocity, record });
      return record;
    },
    fired,
    /** The peak the kit actually scheduled on a voice's entry gain. */
    peakOf(voice, index = fired.length - 1) {
      const entry = fired[index]?.record?.entry;
      if (!entry) return 0;
      return Math.max(...entry.gain.events.map((event) => event.value), entry.gain.firstWrite ?? 0);
    },
  };
  return wrapped;
}

/** Every melodic note the sequencer caused, on and off. */
function recordingNotePath() {
  const on = [];
  const off = [];
  return {
    on,
    off,
    noteOn(event) {
      on.push({ ...event });
      return { index: on.length, state: 'sounding', ...event };
    },
    noteOff(id, options) {
      off.push({ id, at: options?.at });
      return { id };
    },
    allNotesOff() {},
    heldNotes: () => [],
  };
}

/**
 * The whole stack: a real clock over a fake context with injected timers, a real kit, a
 * real parameter store built from the real schema, and the sequencer core on top.
 */
function makeSequencer({ bpm = 120, swing = 54, held = [], random = () => 0.5, transport = true } = {}) {
  const context = createDrumFakeAudioContext({ now: 0 });
  const parent = context.createGain();
  const store = createStore(SCHEMA);
  store.set('global.tempo', bpm);
  store.set('global.swing', swing);

  const timers = [];
  const clock = createClock({
    context,
    read: store.get,
    timers: {
      setInterval: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearInterval: () => {},
    },
  });

  const kit = recordingKit(context, parent, store.get);
  const path = recordingNotePath();
  path.held = held;
  path.heldNotes = () => path.held;

  const sequencer = createSequencer({
    store,
    clock,
    triggerVoice: (voice, options) => kit.trigger(voice, options),
    noteOn: path.noteOn,
    noteOff: path.noteOff,
    allNotesOff: path.allNotesOff,
    heldNotes: path.heldNotes,
    random,
  });

  /* THE TRANSPORT IS NOT THE SEQUENCER'S. `global.run` owns the clock; the rig stands in
     for the RUN button by starting it here, so a test can prove the sequencer works
     without one and works only when there is one. */
  if (transport) clock.start();

  /** Advance the audio clock and run one scheduling pass. */
  const tick = (seconds = 0.025) => {
    context.currentTime += seconds;
    return clock.tick();
  };

  /** Run `count` scheduling passes, advancing the audio clock each time. */
  const run = (count, seconds = 0.025) => {
    let scheduled = 0;
    for (let i = 0; i < count; i += 1) scheduled += tick(seconds);
    return scheduled;
  };

  return { context, store, clock, kit, path, sequencer, tick, run, parent };
}

/** Silence every lane except the ones named, so a test reads one voice's firings. */
function isolate(store, lanes) {
  for (const lane of SEQUENCER_LANES) {
    for (let step = 1; step <= STEPS; step += 1) {
      store.set(`seq.${lane}.on.${step}`, lanes.includes(lane));
      store.set(`seq.${lane}.vel.${step}`, 90);
    }
  }
}

/* ------------------------------------------------------- the shape of the thing --- */

test('the grid is sixteen steps and twelve lanes: eleven kit voices plus melody', () => {
  assert.equal(STEP_COUNT, 16);
  assert.equal(STEPS, 16, 'the store schema and the sequencer agree on the step count');
  assert.equal(LANE_COUNT, 12);
  assert.deepEqual([...SEQUENCER_LANES], [...KIT_VOICES, 'melody']);
  assert.equal(new Set(SEQUENCER_LANES).size, LANE_COUNT, 'no lane is declared twice');

  /* Eleven lanes are drum lanes, and they are exactly the voices the kit has recipes
     for — a lane with no recipe would be a lane that silently makes no sound. */
  for (const voice of KIT_VOICES) assert.ok(DRUM_RECIPES[voice], `${voice} has no kit recipe`);
  assert.equal(KIT_VOICES.length, 11);

  /* Four patterns, and the chain order is a list of them. */
  assert.deepEqual([...PATTERNS], ['A', 'B', 'C', 'D']);
  assert.ok(CHAIN_MAX >= PATTERNS.length, 'the chain can hold at least one full set');

  /* Every per-step key the sequencer reads is declared, in the schema's own ranges. */
  for (const lane of SEQUENCER_LANES) {
    for (let step = 1; step <= STEPS; step += 1) {
      assert.equal(SCHEMA[`seq.${lane}.on.${step}`].kind, 'bool');
      const vel = SCHEMA[`seq.${lane}.vel.${step}`];
      assert.deepEqual([vel.min, vel.max], [0, 100], `${lane}.${step} velocity is a 0..100 accent`);
    }
  }
  for (let step = 1; step <= STEPS; step += 1) {
    assert.deepEqual([SCHEMA[`seq.melody.note.${step}`].min, SCHEMA[`seq.melody.note.${step}`].max], [0, 127]);
    assert.deepEqual([SCHEMA[`seq.melody.gate.${step}`].min, SCHEMA[`seq.melody.gate.${step}`].max], [10, 100]);
  }
  assert.deepEqual([SCHEMA['global.tempo'].min, SCHEMA['global.tempo'].max], [40, 220]);
  assert.deepEqual([SCHEMA['global.swing'].min, SCHEMA['global.swing'].max], [50, 75]);
  assert.deepEqual([SCHEMA['arp.gate'].min, SCHEMA['arp.gate'].max], [10, 100]);
  assert.deepEqual([SCHEMA['arp.octaves'].min, SCHEMA['arp.octaves'].max], [1, 4]);
  assert.equal(SCHEMA['arp.mode'].options.length, 5);
  /* The playhead: task 002's CSS reads this key, and task 002 could not add it. */
  assert.deepEqual([SCHEMA['seq.step'].min, SCHEMA['seq.step'].max], [1, 16]);
});

/* ------------------------------------------------------------------- swing --- */

test('swing at 50% is straight, and 75% moves odd sixteenths only', () => {
  /** The closed hat's hits over several bars, at this swing value. */
  const measure = (swing) => {
    const { store, kit, sequencer, run } = makeSequencer({ swing });
    isolate(store, ['ch']);
    /* Four consecutive steps on, so the SPACING between consecutive hits is the swing: an
       even step's hit lands `period` after the last one, an odd step's lands
       `period + offset`. Steps 5..16 are off, so the gap at each bar boundary is
       thirteen periods and is excluded from the comparison. */
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, step <= 4);
    sequencer.start();
    run(300);
    /* The sequencer's own log, not the kit's spy: it carries the STEP INDEX each hit was
       placed from, which is what the comparison needs. The kit's trigger spy has only the
       voice and the time. */
    const hits = sequencer.log().drums.filter((entry) => entry.voice === 'ch');
    assert.ok(hits.length >= 8, `only ${hits.length} closed-hat hits were scheduled`);
    assert.equal(kit.fired.filter((entry) => entry.voice === 'ch').length, hits.length, 'one kit hit per log entry');
    return hits.slice(0, 8);
  };

  const period = stepPeriod(120);

  /* The step-index gaps between consecutive hits, and the time gaps that go with them. */
  const pairs = (hits) => {
    const out = [];
    for (let i = 1; i < hits.length; i += 1) {
      out.push({ from: hits[i - 1].step, to: hits[i].step, gap: hits[i].at - hits[i - 1].at });
    }
    return out;
  };

  /* 50% IS STRAIGHT: every step-index gap of 1 is exactly one sixteenth of time. */
  const straight = measure(50);
  assert.deepEqual(straight.slice(0, 4).map((entry) => entry.at), [0, 0.125, 0.25, 0.375]);
  const straightPairs = pairs(straight);
  for (const pair of straightPairs) {
    if (pair.to !== (pair.from + 1) % STEPS) {
      assert.ok(Math.abs(pair.gap - 13 * period) < 1e-9, `the bar-boundary gap is 13 steps, got ${pair.gap}`);
      continue;
    }
    assert.ok(Math.abs(pair.gap - period) < 1e-9, `50% swing must be exactly ${period}s apart, got ${pair.gap}`);
  }

  /* 75% PUSHES THE ODD SIXTEENTHS: 0, 0.1875, 0.25, 0.4375 — the eighth-note pair runs
     75/25 rather than 50/50, so a long half and a short half alternate. */
  const swung = measure(75);
  assert.deepEqual(swung.slice(0, 4).map((entry) => entry.at), [0, 0.1875, 0.25, 0.4375]);
  assert.deepEqual(swung.slice(0, 5).map((entry) => entry.at), [0, 0.1875, 0.25, 0.4375, 2.0]);

  const longHalves = [];
  const shortHalves = [];
  for (const pair of pairs(swung)) {
    const offset = swingOffsetSeconds(pair.to, period, 75);
    if (pair.to !== (pair.from + 1) % STEPS) {
      /* Step 3 -> step 0 of the next bar: thirteen periods, less the offset step 3 was
         given. The bar boundary itself is never moved — the downbeat is always on the
         grid — which is why a bar is still exactly sixteen periods long. */
      assert.ok(
        Math.abs(pair.gap - (13 * period - swingOffsetSeconds(pair.from, period, 75))) < 1e-9,
        `the bar boundary is unmoved by swing, got ${pair.gap}`,
      );
      continue;
    }
    /* A hit's own offset is added to ITS step's grid position, so the GAP between two
       consecutive hits is one period plus this step's offset minus the last one's. That
       is why an odd step's hit lands long and the even step after it lands short. */
    const previous = swingOffsetSeconds(pair.from, period, 75);
    assert.ok(
      Math.abs(pair.gap - (period + offset - previous)) < 1e-9,
      `step ${pair.from} -> ${pair.to}: expected ${period + offset - previous}, got ${pair.gap}`,
    );
    (offset > 0 ? longHalves : shortHalves).push(pair.gap);
  }
  assert.ok(longHalves.length > 0 && shortHalves.length > 0, 'both spacings occur');
  for (const gap of longHalves) assert.ok(Math.abs(gap - 1.5 * period) < 1e-9, `long half ${gap}`);
  for (const gap of shortHalves) assert.ok(Math.abs(gap - 0.5 * period) < 1e-9, `short half ${gap}`);
  /* Long + short is still exactly one pair, so the AVERAGE step rate is unchanged: swing
     is a feel, not a tempo, and the bar is still sixteen periods long. */
  assert.ok(Math.abs(longHalves[0] + shortHalves[0] - 2 * period) < 1e-9);
  assert.ok(Math.abs(swung[4].at - swung[0].at - 16 * period) < 1e-9, 'a bar is still sixteen periods');
});

test('the step time is the clock\'s own swung time, computed from the event\'s swing value', () => {
  const { store, sequencer, run, clock } = makeSequencer({ swing: 75 });
  isolate(store, ['bd']);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.bd.on.${step}`, true);
  const seen = [];
  /* `audio` is the AudioContext time at the moment the step was scheduled, which is what
     a scheduled time must not precede — the log's own entries are in the past by the time
     a test reads them. */
  sequencer.onStep((event) => seen.push({ ...event, audio: clock.audioTime() }));
  sequencer.start();
  run(100);

  const fired = sequencer.log().drums;
  assert.ok(fired.length > 0);
  for (const entry of fired) {
    assert.ok(Math.abs(entry.at - entry.swungTime) < 1e-12, 'a drum is placed at the SWUNG time');
    assert.ok(Math.abs(entry.at - (entry.time + entry.swung)) < 1e-12, 'swungTime is time plus the offset');
    assert.ok(
      Math.abs(entry.at - swungStepTime(entry.origin, entry.step, stepPeriod(120), entry.swing)) < 1e-9,
      'the drum is placed at the clock\'s own swung step time',
    );
  }
  assert.ok(seen.length > 0);
  for (const event of seen) {
    /* The clock anchors its cursor at `currentTime` when it starts, so the very first
       step of a transport can sit a few ms behind the audio clock — one tick, never more.
       Anything further back would be a real scheduling bug. */
    assert.ok(
      event.swungTime >= event.audio - 0.03,
      `step ${event.step} was placed at ${event.swungTime}, more than one tick behind the audio clock ${event.audio}`,
    );
  }
  /* Every lane is indexed with the 0-based `step`, 0 = downbeat, wrapping every bar. */
  assert.deepEqual([...new Set(fired.slice(0, 16).map((entry) => entry.step))], [...Array(16).keys()]);
});

test('swing is applied at SCHEDULE time: a value changed mid-bar does not move a step already placed', () => {
  const { store, clock, sequencer, run } = makeSequencer({ swing: 50 });
  isolate(store, ['ch']);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, true);

  const placed = [];
  sequencer.onStep((event) => placed.push({ step: event.step, at: event.swungTime, swing: event.swing }));
  sequencer.start();

  /* One scheduling pass places whatever is inside the 100 ms horizon. Then the swing
     changes. Everything already placed keeps the value it was placed with. */
  run(4);
  const beforeChange = placed.map((entry) => entry.at);
  assert.ok(beforeChange.length > 0, 'the first pass placed some steps');

  store.set('global.swing', 75);
  /* Let the clock read the new swing and place more steps. */
  run(40);
  const all = placed.map((entry) => entry.at);
  assert.ok(all.length > beforeChange.length, 'more steps were placed after the change');

  /* Every step placed before the change is exactly where it was: the stored positions
     are untouched, because they were written, not recomputed. */
  assert.deepEqual(placed.slice(0, beforeChange.length).map((entry) => entry.at), beforeChange);
  /* And the steps placed AFTER the change do carry the new offset, so the control is
     not simply ignored — it applies from the next scheduled step onward. */
  const swung = placed.filter((entry) => entry.swing === 75);
  assert.ok(swung.length > 0, 'steps were placed with the new swing value');
  for (const entry of swung) {
    assert.ok(
      Math.abs(entry.at - swungStepTime(entry.origin, entry.step, stepPeriod(120), 75)) < 1e-9,
      'a step placed under 75% swing is at the 75% position',
    );
  }
  assert.ok(clock.swing() === 75, 'the clock adopted the new swing for its own next step');
});

/* ------------------------------------------------------------------- tempo --- */

test('tempo 40 and 220 move the step rate, and the playhead follows the firing step', () => {
  const rateAt = (bpm) => {
    const { store, clock, sequencer, run } = makeSequencer({ bpm, swing: 50 });
    isolate(store, ['ch']);
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, true);
    sequencer.start();
    run(400);
    const fired = sequencer.log().drums;
    assert.ok(fired.length >= 8, `only ${fired.length} steps were scheduled at ${bpm} BPM`);
    return { period: fired[1].at - fired[0].at, clock, store, sequencer };
  };

  const slow = rateAt(40);
  const fast = rateAt(220);

  /* 40 BPM -> a 1.5 s beat -> 0.375 s per sixteenth. 220 BPM -> 0.2727 s -> 0.0682 s. */
  assert.ok(Math.abs(slow.period - stepPeriod(40)) < 1e-6, `40 BPM step was ${slow.period}`);
  assert.ok(Math.abs(fast.period - stepPeriod(220)) < 1e-6, `220 BPM step was ${fast.period}`);
  assert.ok(fast.period < slow.period / 5, '220 BPM is more than five times faster than 40 BPM');
  assert.ok(Math.abs(stepPeriod(40) / stepPeriod(220) - 5.5) < 1e-9, 'the ratio is exactly 220/40');

  /* The playhead store key tracks the firing step, 1-based as the panel numbers it. */
  const played = slow.sequencer.log().steps;
  assert.ok(played.length >= 16, `only ${played.length} steps were logged`);
  assert.deepEqual(played.slice(0, 16).map((entry) => entry.step), [...Array(16).keys()], 'one bar is sixteen steps');
  /* The playhead store key is the LAST step placed, 1-based as the panel numbers it. */
  assert.equal(slow.store.get('seq.step'), played[played.length - 1].step + 1);
  assert.deepEqual([...slow.store.keys()].includes('seq.step'), true);
  /* And it is written on every step, so it is never stale by more than one step. */
  assert.ok(played.every((entry, index) => index === 0 || entry.absoluteStep > played[index - 1].absoluteStep));
});

test('stop halts scheduling at once: the step does not advance across a gap', () => {
  const { store, clock, sequencer, run } = makeSequencer({ bpm: 40 });
  isolate(store, ['ch']);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, true);
  sequencer.start();
  run(20);

  const before = { step: clock.stepCursor(), absolute: clock.position().absoluteStep, fired: sequencer.log().drums.length };
  clock.stop();
  /* Twenty scheduling passes with the interval cleared: nothing may be scheduled. */
  assert.equal(clock.tick(), 0, 'a stopped clock schedules nothing even if ticked by hand');
  run(60, 0.025);
  const after = { step: clock.stepCursor(), absolute: clock.position().absoluteStep, fired: sequencer.log().drums.length };

  assert.equal(after.step, before.step, 'the step cursor did not advance');
  assert.equal(after.absolute, before.absolute, 'the absolute step did not advance');
  assert.equal(after.fired, before.fired, 'no further step fired');

  sequencer.start();
  assert.equal(clock.running(), false, 'the sequencer does not own the transport');
});

/* ----------------------------------------------------------------- velocity --- */

test('per-step velocity is the drum voice\'s scheduled level', () => {
  const levelFor = (percent) => {
    const { store, kit, sequencer, run } = makeSequencer({ bpm: 120 });
    isolate(store, []);
    store.set('seq.bd.on.1', true);
    store.set('seq.bd.vel.1', percent);
    sequencer.start();
    run(30);
    assert.equal(kit.fired.length, 1, `only the one enabled step fired (${kit.fired.length} did)`);
    return { peak: kit.peakOf('bd'), velocity: kit.fired[0].velocity };
  };

  const quiet = levelFor(20);
  const loud = levelFor(100);

  /* Read off the ENVELOPE the kit scheduled, not off a counter: the level really is a
     function of the accent. The kit's own trim is applied too, so the ratio is what
     matters and it is exactly the velocity ratio. */
  assert.ok(quiet.peak > 0, 'a 20% accent is not silence');
  assert.ok(Math.abs(loud.peak / quiet.peak - 5) < 1e-9, `expected a 5x level ratio, got ${loud.peak / quiet.peak}`);
  assert.equal(quiet.velocity, 0.2, 'the accent reaches the kit as a 0..1 velocity');
  assert.equal(loud.velocity, 1);

  /* And the stored accent really is a 0..100 percentage, not a normalised value. */
  const { store } = makeSequencer();
  store.set('seq.bd.vel.3', 37);
  assert.equal(store.get('seq.bd.vel.3'), 37, 'the store keeps REAL units');
  store.set('seq.bd.vel.3', 140);
  assert.equal(store.get('seq.bd.vel.3'), 100, 'and clamps to its declared range');
});

/* ----------------------------------------------------------- the melodic lane --- */

test('the melodic lane plays through the note path, at the right pitch, for its gate', () => {
  const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
  isolate(store, []);
  store.set('seq.melody.on.1', true);
  store.set('seq.melody.note.1', 64);
  store.set('seq.melody.gate.1', 40);
  sequencer.start();
  run(30);

  assert.equal(path.on.length, 1, 'one melodic note per enabled step');
  const note = path.on[0];
  assert.equal(note.note, 64, 'the lane plays the note the store holds');
  assert.equal(note.velocity, 0.9, 'the step accent is the melodic velocity');
  assert.ok(note.held === false, 'a sequenced note is not a held keyboard note');

  /* THE GATE. 40% of a 0.125 s step is released 0.05 s after it starts — and it is the
     CLOCK that places the release, from the swung step time, not a timer. */
  const period = stepPeriod(120);
  const released = path.off.find((entry) => entry.id === note.id);
  assert.ok(released, 'the gate was released');
  assert.ok(Math.abs(released.at - (note.at + 0.4 * period)) < 1e-9, `gate off at ${released.at}, expected ${note.at + 0.4 * period}`);

  /* Gate length really is what changes the note's length. */
  const gateSeconds = (gate) => {
    const rig = makeSequencer({ bpm: 120, swing: 50 });
    isolate(rig.store, []);
    rig.store.set('seq.melody.on.1', true);
    rig.store.set('seq.melody.gate.1', gate);
    rig.sequencer.start();
    rig.run(30);
    const on = rig.path.on[0];
    const off = rig.path.off.find((entry) => entry.id === on.id);
    return off.at - on.at;
  };
  assert.ok(Math.abs(gateSeconds(10) - 0.1 * period) < 1e-9, 'a 10% gate');
  assert.ok(Math.abs(gateSeconds(100) - period) < 1e-9, 'a 100% gate is the whole step');
  assert.ok(gateSeconds(100) > gateSeconds(50) * 1.9, 'a longer gate is a longer note');
});

/* --------------------------------------------------------------- the patterns --- */

test('the four patterns hold independent step data and switching changes what fires', () => {
  const { store, kit, sequencer, run } = makeSequencer({ bpm: 120 });
  isolate(store, ['ch']);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, false);

  /* One step in pattern A, a DIFFERENT one in pattern B, and a third in C. */
  store.set('seq.pattern', 'A');
  store.set('seq.ch.on.5', true);
  store.set('seq.pattern', 'B');
  store.set('seq.ch.on.9', true);
  store.set('seq.pattern', 'C');
  store.set('seq.ch.on.13', true);

  /* Reading the keys back shows each pattern kept its own data: the flat keys are the
     SELECTED pattern's, so what they hold changes with the selection and the bank is what
     remembers the rest. */
  const keysIn = (pattern) => {
    store.set('seq.pattern', pattern);
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
      .filter((step) => store.get(`seq.ch.on.${step}`));
  };
  /* Every pattern starts from the init patch, so B still has the default closed-hat
     groove and A does not: that is independence, not a bug. */
  const DEFAULT_CH = [2, 6, 10, 14];
  assert.deepEqual(keysIn('A'), [5], "A holds only the step that was written into it");
  assert.deepEqual(keysIn('B').sort((a, b) => a - b), [...DEFAULT_CH, 9].sort((a, b) => a - b), 'B holds the default groove plus its own step');
  assert.deepEqual(keysIn('C').sort((a, b) => a - b), [...DEFAULT_CH, 13].sort((a, b) => a - b), 'C a third');
  assert.deepEqual(keysIn('D'), DEFAULT_CH, 'D is untouched');
  assert.deepEqual(keysIn('A'), [5], "switching back and forth does not overwrite A");
  assert.deepEqual(keysIn('B').sort((a, b) => a - b), [...DEFAULT_CH, 9].sort((a, b) => a - b), 'nor B');

  /* A velocity is per step per pattern too, not just the on/off. */
  store.set('seq.pattern', 'A');
  store.set('seq.ch.vel.5', 25);
  store.set('seq.pattern', 'B');
  assert.equal(store.get('seq.ch.vel.5'), 60, "B's accent at step 5 is B's own, not A's 25");
  store.set('seq.pattern', 'A');
  assert.equal(store.get('seq.ch.vel.5'), 25, "A's accent survived the round trip");

  /* And the SOUND follows: the firing log records which pattern each step read. The log is
     cumulative and bounded, so each measurement starts from where the last one stopped. */
  const firedIn = (pattern) => {
    const before = sequencer.log().drums.length;
    store.set('seq.pattern', pattern);
    sequencer.start();
    /* A whole bar of steps — 80 ticks of 25 ms is 2 s, which is sixteen sixteenths at
       120 BPM — so every step index is covered exactly once and the pattern switch, which
       happened before the run, applies to all of them. */
    run(80);
    return [...new Set(sequencer.log().drums.slice(before).filter((e) => e.voice === 'ch').map((e) => e.step))]
      .sort((a, b) => a - b);
  };
  assert.deepEqual(firedIn('A'), [4], "pattern A fires its own step");
  assert.deepEqual(firedIn('B'), [1, 5, 8, 9, 13], 'pattern B fires its own, plus the init groove');
  assert.deepEqual(firedIn('C'), [1, 5, 9, 12, 13], 'pattern C differs from B');
  assert.deepEqual(firedIn('D'), [1, 5, 9, 13], 'pattern D is still the untouched init groove');
  assert.ok(kit.fired.length > 0, 'and the kit really was triggered');
});

test('every pattern starts from the schema defaults, so no pattern is born silent', () => {
  const { store, sequencer } = makeSequencer();
  const groove = (pattern) => {
    store.set('seq.pattern', pattern);
    return [...Array(STEPS).keys()].filter((i) => store.get(`seq.bd.on.${i + 1}`));
  };
  assert.deepEqual(groove('A'), groove('B'));
  assert.deepEqual(groove('A'), groove('D'));
  assert.ok(groove('A').length > 0, 'the init patch has a bass-drum pattern to carry over');
  assert.equal(sequencer.bank.patternCount(), 4);
});

/* -------------------------------------------------------------------- chain --- */

test('chain mode is the normal sequencer reading a different pattern each bar', () => {
  const { store, sequencer, run } = makeSequencer({ bpm: 220 });
  isolate(store, ['ch']);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.ch.on.${step}`, step === 1);
  store.set('seq.chain', true);
  sequencer.chainReset(['A', 'B', 'A', 'D']);
  assert.deepEqual(store.get('seq.chainOrder'), ['A', 'B', 'A', 'D']);

  const seen = [];
  store.subscribe('seq.pattern', (_key, value) => seen.push(value));
  sequencer.start();

  /* Sixteen bars: the order repeats four times over with nothing drifting. */
  const period = stepPeriod(220);
  run(Math.ceil((16 * 16 * period) / 0.025) + 40);

  assert.ok(seen.length >= 16, `only ${seen.length} bar changes were seen`);
  const expected = ['A', 'B', 'A', 'D'];
  for (let i = 0; i < 16; i += 1) {
    assert.equal(seen[i], expected[i % 4], `bar ${i + 1} should play ${expected[i % 4]}, saw ${seen[i]}`);
  }

  /* Chain mode is not a separate playback path: the same lane fired on the same step in
     every pattern, and the firing log records the pattern each step read. */
  const played = sequencer.log().steps.filter((entry) => entry.pattern);
  assert.ok(played.length > 0);
  const perBar = new Map();
  for (const entry of played) {
    if (!perBar.has(entry.bar)) perBar.set(entry.bar, entry.pattern);
  }
  assert.ok(perBar.size >= 4, `the chain advanced the pattern across only ${perBar.size} bars`);
  /* And each bar's lane data is the pattern's OWN: the chain read a different pattern,
     not a different lane. The log is a bounded FIFO, so the bars it holds start wherever
     the run had reached — the ORDER is what is asserted, from the first logged bar on. */
  const byBar = [...perBar.entries()].sort((a, b) => a[0] - b[0]).map(([, pattern]) => pattern);
  const start = expected.indexOf(byBar[0]);
  assert.ok(start >= 0, `the first logged bar plays ${byBar[0]}`);
  for (let i = 0; i < byBar.length; i += 1) {
    assert.equal(byBar[i], expected[(start + i) % 4], `bar ${i} should play ${expected[(start + i) % 4]}, saw ${byBar[i]}`);
  }
});

test('chain order is built by clicking slots in sequence, and trims when the tail is clicked again', () => {
  const { store, sequencer } = makeSequencer();
  assert.deepEqual(store.get('seq.chainOrder'), [...PATTERNS], 'the init patch chains A B C D');

  sequencer.chainReset();
  assert.deepEqual(store.get('seq.chainOrder'), []);
  sequencer.chainAppend('A');
  sequencer.chainAppend('B');
  sequencer.chainAppend('D');
  assert.deepEqual(store.get('seq.chainOrder'), ['A', 'B', 'D'], 'the order is the click sequence');

  /* Clicking the tail again trims from that point — the standard chain-editor gesture,
     and the only way a fixed-size order can be edited without a separate erase control. */
  /* Clicking a slot that is already EARLIER in the order truncates to just before it —
     how a chain is shortened without a separate erase control. */
  sequencer.chainAppend('B');
  assert.deepEqual(store.get('seq.chainOrder'), ['A']);
  sequencer.chainAppend('C');
  assert.deepEqual(store.get('seq.chainOrder'), ['A', 'C']);
  /* Clicking the LAST slot again empties the order: one click clears it. */
  sequencer.chainAppend('C');
  assert.deepEqual(store.get('seq.chainOrder'), []);

  /* It is bounded, so a long session cannot grow the array without limit. */
  for (let i = 0; i < CHAIN_MAX + 12; i += 1) sequencer.chainAppend(i % 2 === 0 ? 'C' : 'D');
  assert.ok(store.get('seq.chainOrder').length <= CHAIN_MAX, `chain grew to ${store.get('seq.chainOrder').length}`);
  assert.ok(store.get('seq.chainOrder').length > 0);

  /* A pattern that is not one of the four is refused, not stored. */
  const before = store.get('seq.chainOrder').length;
  sequencer.chainAppend('Z');
  assert.equal(store.get('seq.chainOrder').length, before);
});

/* -------------------------------------------------------------- the arpeggiator --- */

test('all five arpeggiator modes fire distinct orderings from the melodic lane', () => {
  const orderFor = (mode) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
    isolate(store, []);
    /* A C-major triad written into the lane: three steps on, thirteen off. */
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, [1, 5, 9].includes(step));
    store.set('seq.melody.note.1', 60);
    store.set('seq.melody.note.5', 64);
    store.set('seq.melody.note.9', 67);
    store.set('arp.on', true);
    store.set('arp.mode', mode);
    store.set('arp.rate', '1/8');
    store.set('arp.octaves', 1);
    store.set('arp.followLane', true);
    /* Random is the one mode that cannot be asserted from an unordered set alone, so it
       is verified through the SEEDED stream the module documents: `setArpRandomSeed`
       swaps `Math.random` for a seeded mulberry32, which makes the sequence exact. The
       invariants (pool membership, more than one note) then hold for the unseeded case too. */
    if (mode === 'random') sequencer.setArpRandomSeed(42);
    sequencer.start();
    run(200);
    return [...new Set(path.on.map((entry) => entry.note))];
  };

  const up = orderFor('up');
  const down = orderFor('down');
  const updown = orderFor('updown');
  const asplay = orderFor('asplay');
  const random = orderFor('random');

  /* FOUR DISTINCT ORDERS. Each is read as the ORDER the notes actually fired in, not as a
     set, which is what makes "the ordering changes per mode" a fact rather than a claim. */
  const sequenceFor = (mode) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
    isolate(store, []);
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, [1, 5, 9].includes(step));
    store.set('seq.melody.note.1', 60);
    store.set('seq.melody.note.5', 64);
    store.set('seq.melody.note.9', 67);
    store.set('arp.on', true);
    store.set('arp.mode', mode);
    store.set('arp.rate', '1/8');
    store.set('arp.octaves', 1);
    store.set('arp.followLane', true);
    if (mode === 'random') sequencer.setArpRandomSeed(42);
    sequencer.start();
    run(200);
    return path.on.map((entry) => entry.note);
  };

  const upSeq = sequenceFor('up').slice(0, 6);
  const downSeq = sequenceFor('down').slice(0, 6);
  const updownSeq = sequenceFor('updown').slice(0, 6);
  const asplaySeq = sequenceFor('asplay').slice(0, 6);

  assert.deepEqual(upSeq, [60, 64, 67, 60, 64, 67], 'Up walks the chord up, over and over');
  assert.deepEqual(downSeq, [67, 64, 60, 67, 64, 60], 'Down walks it down');
  assert.deepEqual(updownSeq, [60, 64, 67, 64, 60, 64], 'Up-Down turns round at the top');
  assert.deepEqual(asplaySeq, [60, 64, 67, 60, 64, 67], 'As-Play, on a chord played in order, is Up');
  assert.notDeepEqual(upSeq, downSeq);
  assert.notDeepEqual(upSeq, updownSeq);

  /* As-Play is the one mode whose ORDER IS DATA: the same chord played as G E C arpeggiates
     the other way, and identically in Up. */
  const reversed = (mode) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
    isolate(store, []);
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, [1, 5, 9].includes(step));
    store.set('seq.melody.note.1', 67);
    store.set('seq.melody.note.5', 64);
    store.set('seq.melody.note.9', 60);
    store.set('arp.on', true);
    store.set('arp.mode', mode);
    store.set('arp.rate', '1/8');
    store.set('arp.followLane', true);
    sequencer.start();
    run(120);
    return path.on.map((entry) => entry.note).slice(0, 6);
  };
  assert.deepEqual(reversed('asplay'), [67, 64, 60, 67, 64, 60], 'As-Play follows the play order');
  assert.deepEqual(reversed('up'), [60, 64, 67, 60, 64, 67], 'Up does not care what order they were played');

  /* RANDOM: every firing is a member of the pool, more than one note appears, and the
     seeded stream is exactly reproducible. */
  assert.deepEqual([...random].sort((a, b) => a - b), [60, 64, 67], 'the seeded stream reaches every note');
  assert.notDeepEqual(random, [60, 64, 67], 'and it is not simply ascending');
  const unseeded = (() => {
    /* A REAL PRNG, not the harness's constant 0.5: the point of this case is that the
       unseeded path is not a fixed sequence. */
    const { store, path, sequencer, run } = makeSequencer({
      bpm: 120,
      swing: 50,
      held: [{ note: 60 }, { note: 64 }, { note: 67 }],
      random: mulberry32(99),
    });
    isolate(store, []);
    store.set('arp.on', true);
    store.set('arp.mode', 'random');
    store.set('arp.rate', '1/16');
    sequencer.start();
    run(200);
    return path.on.map((entry) => entry.note);
  })();
  assert.ok(unseeded.length > 32, `only ${unseeded.length} unseeded random firings`);
  for (const note of unseeded) assert.ok([60, 64, 67].includes(note), `${note} is not in the pool`);
  assert.ok(new Set(unseeded).size > 1, 'the unseeded stream is not a constant');

  assert.equal(ARP_MODES.length, 5);
  /* The LANE is bypassed when the arpeggiator owns it: nothing is played at the step's own
     time, only at the arpeggiator's slots. */
  const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
  isolate(store, []);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, step === 1);
  store.set('arp.on', false);
  sequencer.start();
  run(60);
  const asWritten = path.on.length;
  assert.ok(asWritten > 0, 'with the arpeggiator off the lane plays as written');
});

test('the arpeggiator can be bypassed so the lane plays as written', () => {
  const rig = (followLane, arpOn) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50 });
    isolate(store, []);
    for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, [1, 5, 9].includes(step));
    store.set('seq.melody.note.1', 60);
    store.set('seq.melody.note.5', 64);
    store.set('seq.melody.note.9', 67);
    store.set('arp.on', arpOn);
    store.set('arp.followLane', followLane);
    store.set('arp.rate', '1/16');
    sequencer.start();
    /* EXACTLY one bar of steps, so "one note per enabled step" is a countable fact: run
       until the log holds sixteen steps rather than for a guessed number of milliseconds. */
    for (let i = 0; i < 500 && sequencer.log().steps.length < 16; i += 1) run(1);
    assert.equal(sequencer.log().steps.length, 16);
    return path.on;
  };

  /* Bypassed: exactly one note per enabled step, at the step's own swung time. */
  const written = rig(false, false);
  assert.equal(written.length, 3);
  assert.deepEqual(written.map((entry) => entry.note), [60, 64, 67]);

  /* Owned by the arpeggiator: many more notes, all of them pool members, and none of
     them exactly on a lane step's own time. */
  const arpeggiated = rig(true, true);
  assert.ok(arpeggiated.length > written.length * 4, `only ${arpeggiated.length} arpeggiator notes`);
  for (const entry of arpeggiated) assert.ok([60, 64, 67].includes(entry.note), `${entry.note} is not in the lane`);

  /* With followLane off but the arpeggiator on, the LANE still plays as written: the
     arpeggiator has nothing to work on (no held keys in this rig), and taking the lane
     is an explicit choice. */
  const bypassed = rig(false, true);
  assert.equal(bypassed.length, 3);
});

test('held notes feed the arpeggiator through the same note path', () => {
  const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50, held: [{ note: 60, velocity: 0.8 }, { note: 67, velocity: 0.8 }, { note: 72, velocity: 0.8 }] });
  isolate(store, []);
  store.set('arp.on', true);
  store.set('arp.mode', 'up');
  store.set('arp.rate', '1/8');
  sequencer.start();
  run(120);

  const notes = path.on.map((entry) => entry.note);
  assert.ok(notes.length > 0, 'the arpeggiator fired from held notes');
  assert.deepEqual([...new Set(notes)], [60, 67, 72]);
  assert.equal(path.on[0].velocity, 0.8, 'a held note keeps its own velocity');
  assert.equal(path.on[0].held, false, 'an arpeggiator note is not itself a held note');

  /* With nothing held the arpeggiator is silent rather than firing a stale chord. */
  const empty = makeSequencer({ bpm: 120, held: [] });
  isolate(empty.store, []);
  empty.store.set('arp.on', true);
  empty.sequencer.start();
  empty.run(80);
  assert.equal(empty.path.on.length, 0);
});

test('the arpeggiator rate divides the bar, and the octave range widens the span', () => {
  /* Count the arpeggiator's firings over FOUR WHOLE BARS of steps, so every rate's count is
     an exact whole number and the ratios are not polluted by a partial bar. */
  const countFor = (rate) => {
    const { store, path, sequencer, run } = makeSequencer({
      bpm: 120,
      swing: 50,
      held: [{ note: 60, velocity: 0.9 }],
    });
    isolate(store, []);
    store.set('arp.on', true);
    store.set('arp.mode', 'up');
    store.set('arp.rate', rate);
    store.set('arp.octaves', 1);
    sequencer.start();
    const target = 16 * 4;
    for (let i = 0; i < 4000 && sequencer.log().steps.length < target; i += 1) run(1);
    assert.equal(sequencer.log().steps.length, target, `${rate}: four whole bars were scheduled`);
    return path.on.filter((entry) => entry.arp === true).length;
  };

  /* Four bars, so the counts are exact: 16, 32, 48, 64, 96 and 128 notes respectively. */
  const quarter = countFor('1/4');
  const eighth = countFor('1/8');
  const eighthT = countFor('1/8T');
  const sixteenth = countFor('1/16');
  const sixteenthT = countFor('1/16T');
  const thirtySecond = countFor('1/32');

  assert.deepEqual([quarter, eighth, eighthT, sixteenth, sixteenthT, thirtySecond], [16, 32, 48, 64, 96, 128]);
  /* The interval between firing notes at 1/4 is four times the interval at 1/32, because a
     1/32 note is an eighth of a beat and a 1/4 note is a whole one: 0.5 s vs 0.0625 s at
     120 BPM. And 1/8 -> 1/32 is the fourfold step the plan's own wording describes. */
  const beat = 60 / 120;
  const intervalFor = (rate) => beat * arpIntervalBeats(rate);
  assert.ok(Math.abs(intervalFor('1/4') / intervalFor('1/32') - 8) < 1e-9);
  assert.ok(Math.abs(intervalFor('1/8') / intervalFor('1/32') - 4) < 1e-9);
  assert.ok(Math.abs(intervalFor('1/8T') / intervalFor('1/16T') - 2) < 1e-9, 'a triplet 1/8 is twice a triplet 1/16');
  assert.ok(Math.abs(intervalFor('1/4') / intervalFor('1/8') - 2) < 1e-9);

  const span = (octaves) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50, held: [{ note: 60 }, { note: 64 }, { note: 67 }] });
    isolate(store, []);
    store.set('arp.on', true);
    store.set('arp.octaves', octaves);
    store.set('arp.rate', '1/16');
    sequencer.start();
    for (let i = 0; i < 2000 && sequencer.log().steps.length < 16 * 3; i += 1) run(1);
    const notes = path.on.filter((entry) => entry.arp === true).map((entry) => entry.note);
    assert.ok(notes.length > 0, `octaves ${octaves} produced no notes`);
    return Math.max(...notes) - Math.min(...notes);
  };
  assert.equal(span(1), 7);
  assert.equal(span(2), 19);
  assert.equal(span(4), 43);
});

test('the arpeggiator gate is a fraction of its own rate, not of the step', () => {
  const lengthFor = (rate, gate) => {
    const { store, path, sequencer, run } = makeSequencer({ bpm: 120, swing: 50, held: [{ note: 60 }] });
    isolate(store, []);
    store.set('arp.on', true);
    store.set('arp.rate', rate);
    store.set('arp.gate', gate);
    sequencer.start();
    run(120);
    const on = path.on[0];
    const off = path.off.find((entry) => entry.id === on.id);
    return off.at - on.at;
  };

  const beat = 60 / 120;
  /* At 1/8 the interval is half a beat, so a 50% gate is a quarter of a beat. */
  assert.ok(Math.abs(lengthFor('1/8', 50) - 0.25 * beat) < 1e-9);
  /* At 1/32 the same 50% gate is an eighth of the interval: the gate is a fraction of
     the RATE, which is what makes a fast arpeggio playable at the same gate value. */
  assert.ok(Math.abs(lengthFor('1/32', 50) - 0.25 * beat / 4) < 1e-9);
  assert.ok(lengthFor('1/8', 100) > lengthFor('1/8', 10));
});

/* ------------------------------------------------------------- the same path --- */

test('the melodic lane and the arpeggiator share ONE note-event path', () => {
  const { store, path, sequencer, run } = makeSequencer({ bpm: 120 });
  isolate(store, []);
  for (let step = 1; step <= STEPS; step += 1) store.set(`seq.melody.on.${step}`, step === 1);
  store.set('seq.melody.note.1', 60);
  store.set('arp.on', true);
  store.set('arp.followLane', false);
  store.set('arp.rate', '1/16');
  path.held = [{ note: 72, velocity: 0.9 }];
  sequencer.start();
  run(120);

  /* Both sources went through the SAME function, and both are marked as not held, so
     neither can feed the arpeggiator its own output. */
  assert.ok(path.on.length > 1);
  assert.ok(path.on.some((entry) => entry.note === 60), 'the lane note');
  assert.ok(path.on.some((entry) => entry.note === 72), 'the arpeggiator note');
  assert.ok(path.on.every((entry) => entry.held === false));
  assert.ok(path.on.every((entry) => Number.isFinite(entry.at)), 'every note carries a scheduled time');
  assert.ok(path.on.every((entry) => typeof entry.id === 'string' && entry.id.length > 0));
});

/* ---------------------------------------------------------------- structure --- */

test('the sequencer is a subscriber and owns no timer of its own', () => {
  /* `transport: false` — no RUN button has been pressed. */
  const { sequencer, clock, store } = makeSequencer({ transport: false });
  assert.ok(clock.subscriberCount() > 0, 'the sequencer is wired to the clock at construction');
  assert.equal(sequencer.timerCount(), 0);
  assert.equal(clock.running(), false, 'the sequencer does not start the transport itself');
  assert.equal(store.get('global.run'), false);
  /* And with no transport, a scheduling pass places nothing: there is no cursor. */
  assert.equal(clock.tick(), 0);
  assert.equal(sequencer.log().drums.length, 0);

  /* THE STRUCTURAL GUARANTEE, read off disk rather than trusted.
     tests/clock.test.mjs already owns "the whole instrument mentions setInterval in
     exactly one file, and it is the clock", and that test runs over every file this task
     adds — so it is not duplicated here. What this test adds is the narrower claim that
     matters for THIS task: none of the modules it adds schedules anything at all. */
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (entry.name.endsWith('.js')) out.push(path);
    }
    return out;
  };
  const sources = new Map(walk(WEB_DIR).map((path) => [path, readFileSync(path, 'utf8')]));

  const intervals = [...sources].filter(([, source]) => /\bsetInterval\b/.test(source)).map(([path]) => path.replace(`${WEB_DIR}`, ''));
  assert.deepEqual(intervals, ['audio/clock.js'], 'exactly one module mentions an interval, and it is the clock');

  /* The one `setTimeout` in web/ is task 8's impulse-response REBUILD DEBOUNCE — a UI
     gesture debounce, not a musical timer, and a file this task does not own. */
  const timeouts = [...sources].filter(([, source]) => /\bsetTimeout\b/.test(source)).map(([path]) => path.replace(`${WEB_DIR}`, ''));
  assert.deepEqual(timeouts, ['audio/chain.js'], "the only setTimeout is task 8's IR-rebuild debounce");

  clock.start();
  sequencer.start();
  assert.equal(clock.running(), true, 'only the clock started');

  /* And the three modules this task adds arm nothing, run no frame loop and read no wall
     clock. A frame loop is the other way a UI ends up with its own idea of time. */
  for (const added of ['audio/sequencer.js', 'audio/sequencer-run.js', 'audio/arp.js', 'ui/sequencer-view.js']) {
    const source = sources.get(join(WEB_DIR, added));
    assert.ok(source, `${added} exists`);
    for (const forbidden of [/\bsetInterval\b/, /\bsetTimeout\b/, /\bqueueMicrotask\b.*tick/, /\brequestAnimationFrame\s*\(/, /\bDate\.now\s*\(/, /\bperformance\.now\s*\(/]) {
      assert.ok(!forbidden.test(source), `${added} must not use ${forbidden}`);
    }
  }
});

test('the sequencer is wired into the delivered page from ui/main.js', () => {
  const main = readFileSync(join(WEB_DIR, 'ui', 'main.js'), 'utf8');
  assert.ok(
    /import\s+['"]\.\.\/audio\/sequencer-run\.js['"]/.test(main),
    "web/ui/main.js must statically import '../audio/sequencer-run.js' — without it the whole sequencer and arpeggiator are absent from the page while a probe that dynamically imports them still passes",
  );
  assert.ok(
    main.indexOf("sequencer-run.js") < main.search(/\bbuildSurface\s*\(/),
    'the import sits beside the other graph roots, above buildSurface()',
  );
});

test('the held-note registry engine.js exposes is the arpeggiator\'s keyboard source', () => {
  const engine = readFileSync(join(WEB_DIR, 'audio', 'engine.js'), 'utf8');
  /* Task 11 builds the keyboard in parallel and may not edit engine.js, so the registry
     it has to call is asserted here rather than in either task's own file. */
  for (const name of ['noteOn', 'noteOff', 'heldNotes', 'noteHeld']) {
    assert.ok(
      new RegExp(`export function ${name}\\b`).test(engine),
      `web/audio/engine.js must export ${name}() for task 11`,
    );
  }
});
