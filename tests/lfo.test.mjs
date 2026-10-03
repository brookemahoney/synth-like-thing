/**
 * tests/lfo.test.mjs — the three LFOs, tested on their arithmetic and on their
 * structure over a fake AudioContext.
 *
 * What is genuinely algorithmic here, and therefore tested by value rather than
 * by assertion of intent:
 *
 *   - the tempo-synced rate, which is a division's beat fraction over the beat
 *     period, so it moves proportionally with tempo;
 *   - the free-running rate clamp, 0.02..30 Hz;
 *   - the sample-and-hold TABLE, which must be a staircase: every sample of a
 *     step equal to the one before it, and a jump at each boundary. A smooth
 *     ramp here is the bug this file exists to catch;
 *   - the fade-in curve, which must start at zero, end at one and never go
 *     backwards, because it is what stops an enabled LFO clicking;
 *   - the saw Fourier tables, which must carry no DC term.
 *
 * `node --test tests/lfo.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LFO_COUNT,
  LFO_FADE_MAX,
  LFO_RATE_MAX,
  LFO_RATE_MIN,
  LFO_SHAPES,
  SAMPLE_HOLD_SAMPLES,
  SAMPLE_HOLD_STEPS,
  SYNC_DIVISIONS,
  clampLfoRate,
  createLfoBank,
  fadeCurvePoints,
  lfoRateHz,
  sampleHoldPlaybackRate,
  sampleHoldTable,
  shapePlan,
  syncRateHz,
} from '../web/audio/lfo.js';
import { beatPeriod } from '../web/audio/clock.js';
import { SYNC_BEATS } from '../web/audio/chain.js';
import { LFO_WAVES, SYNC_RATES, createStore, SCHEMA, defaults } from '../web/ui/params.js';
import { createFakeRead, createModFakeContext } from './mod-fake-audio.mjs';

/** A deterministic stand-in for Math.random, so a staircase test is repeatable. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const LFO_KEYS = ['wave', 'rate', 'sync', 'rateSync', 'fadeIn', 'on'];

/* ------------------------------------------------------------ the inventory --- */

test('three LFOs, six shapes each and six sync divisions each, enumerable', () => {
  assert.equal(LFO_COUNT, 3);
  /* The legend, the store and the LFO module agree, in the same order. */
  assert.deepEqual([...LFO_SHAPES], [...LFO_WAVES]);
  assert.deepEqual([...SYNC_DIVISIONS], [...SYNC_RATES]);
  assert.equal(LFO_SHAPES.length, 6);
  assert.equal(SYNC_DIVISIONS.length, 6);
  assert.equal(new Set(LFO_SHAPES).size, 6, 'the six shapes are six distinct names');

  for (const shape of LFO_SHAPES) assert.ok(SCHEMA[`lfo1.wave`].options.includes(shape), `${shape} is a declared shape`);
  for (const division of SYNC_DIVISIONS) assert.ok(SCHEMA[`lfo1.rateSync`].options.includes(division));

  const context = createModFakeContext();
  const read = createFakeRead(defaults());
  const bank = createLfoBank({ context, read, bpm: () => 120, random: seeded(7) });
  assert.equal(bank.lfos.length, LFO_COUNT);
  for (const lfo of bank.lfos) {
    assert.deepEqual([...lfo.state().shapes], [...LFO_SHAPES], 'every LFO offers every shape');
    assert.deepEqual([...lfo.state().divisions], [...SYNC_DIVISIONS], 'every LFO offers every division');
    assert.deepEqual(lfo.state().keys, LFO_KEYS, 'an LFO reads exactly the six declared keys');
  }
});

test('every one of the eighteen declared lfo keys is in the schema', () => {
  for (const n of [1, 2, 3]) for (const key of LFO_KEYS) assert.ok(SCHEMA[`lfo${n}.${key}`], `lfo${n}.${key}`);
  assert.deepEqual([SCHEMA['lfo1.rate'].min, SCHEMA['lfo1.rate'].max], [LFO_RATE_MIN, LFO_RATE_MAX]);
  assert.equal(SCHEMA['lfo1.fadeIn'].max, LFO_FADE_MAX);
});

/* ------------------------------------------------------------ the rate maths --- */

test('a synced rate is the division in beats over the beat period', () => {
  /* 120 BPM is half a second to the beat. */
  for (const division of SYNC_DIVISIONS) {
    const expected = SYNC_BEATS[division] / beatPeriod(120);
    assert.ok(Math.abs(syncRateHz(division, 120) - expected) < 1e-12, `${division} at 120 BPM`);
  }
  /* And every number, not just the intuition: 1/4 is 2 Hz at 120 BPM. */
  assert.ok(Math.abs(syncRateHz('1/4', 120) - 2) < 1e-12);
  assert.ok(Math.abs(syncRateHz('1/8', 120) - 1) < 1e-12);
  assert.ok(Math.abs(syncRateHz('1/8T', 120) - 2 / 3) < 1e-12);
  assert.ok(Math.abs(syncRateHz('1/16', 120) - 0.5) < 1e-12);
  assert.ok(Math.abs(syncRateHz('1/16T', 120) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(syncRateHz('1/32', 120) - 0.25) < 1e-12);
});

test('doubling the tempo doubles every synced rate, for all six divisions', () => {
  for (const division of SYNC_DIVISIONS) {
    assert.ok(Math.abs(syncRateHz(division, 240) / syncRateHz(division, 120) - 2) < 1e-12, division);
  }
});

test('the free-running rate is clamped to 0.02..30 Hz and nothing else moves', () => {
  assert.equal(clampLfoRate(0.0001), LFO_RATE_MIN);
  assert.equal(clampLfoRate(1000), LFO_RATE_MAX);
  assert.equal(clampLfoRate(4.2), 4.2);
  assert.equal(clampLfoRate(Number.NaN), LFO_RATE_MIN, 'a non-number is the floor, never a wild value');
  assert.equal(clampLfoRate(undefined), LFO_RATE_MIN);
  assert.equal(clampLfoRate(Number.POSITIVE_INFINITY), LFO_RATE_MAX);

  /* Free-running ignores the division entirely; synced ignores the rate. */
  assert.equal(lfoRateHz({ sync: false, division: '1/32', rate: 7, bpm: 120 }), 7);
  assert.equal(lfoRateHz({ sync: true, division: '1/8', rate: 7, bpm: 120 }), 1);
  assert.equal(lfoRateHz({ sync: true, division: '1/8', rate: 0.02, bpm: 60 }), 0.5);
  assert.equal(lfoRateHz({}), clampLfoRate(SCHEMA['lfo1.rate'].def));
});

/* --------------------------------------------------------------- the shapes --- */

test('every shape has exactly one realisation, and the saws are DC-free tables', () => {
  const plans = LFO_SHAPES.map((shape) => shapePlan(shape));
  assert.equal(plans.length, 6);
  assert.equal(new Set(plans.map((plan) => plan.kind)).size <= 3, true);

  assert.equal(shapePlan('sine').kind, 'oscillator');
  assert.equal(shapePlan('sine').type, 'sine');
  assert.equal(shapePlan('triangle').type, 'triangle');
  assert.equal(shapePlan('square').type, 'square');
  /* Native square is 0..1, so it is de-biased on the way out; the flag is what
     makes that stage exist at all. */
  assert.equal(shapePlan('square').bipolar, true, 'a square must be shifted to -1..1');
  assert.equal(shapePlan('sine').bipolar, false);

  assert.equal(shapePlan('sawUp').kind, 'periodic');
  assert.equal(shapePlan('sawDown').kind, 'periodic');
  assert.equal(shapePlan('sawUp').sign, -1);
  assert.equal(shapePlan('sawDown').sign, 1);
  assert.equal(shapePlan('sampleHold').kind, 'buffer');

  assert.equal(shapePlan('nonsense'), null, 'an unknown shape has no realisation, it is not a guess');
});

test('the two saws are mirror images of each other and carry no DC term', () => {
  const context = createModFakeContext();
  const up = shapePlan('sawUp').coefficients();
  const down = shapePlan('sawDown').coefficients();
  assert.equal(up.real.length, down.real.length);
  assert.ok(up.real.every((value) => value === 0), 'no cosine terms, so no DC and no offset');
  assert.ok(down.real.every((value) => value === 0));
  assert.ok(up.imag.every((value) => Math.abs(value) < 1), 'a saw is bounded');
  for (let n = 1; n < up.imag.length; n += 1) {
    assert.ok(Math.abs(up.imag[n] + down.imag[n]) < 1e-15, `harmonic ${n} must be an exact negation`);
  }
  /* Saw up is a rising ramp: its first harmonic is negative, as -2/pi is. */
  assert.ok(up.imag[1] < 0);
  assert.ok(down.imag[1] > 0);
  /* The browser's own sawtooth is the falling one. */
  const built = context.createPeriodicWave(up.real, up.imag);
  assert.equal(built.real.length, up.real.length);
});

/* --------------------------------------------------- sample and hold, stepped --- */

test('sample and hold is a STAIRCASE: consecutive samples equal, and it jumps', () => {
  const table = sampleHoldTable({ sampleRate: 48000, steps: 64, samples: 32, random: seeded(11) });
  /* The same shape at a test-local size; the buffer's real size is above. */
  assert.equal(table.length, 64 * 32);
  assert.ok(table instanceof Float32Array);

  /* Equal inside a step. */
  let equalPairs = 0;
  let pairs = 0;
  for (let step = 0; step < 64; step += 1) {
    const base = step * 32;
    for (let i = base + 1; i < base + 32; i += 1) {
      pairs += 1;
      if (table[i] === table[i - 1]) equalPairs += 1;
    }
  }
  assert.equal(equalPairs, pairs, 'every sample inside a step equals the one before it');

  /* A jump at every boundary, and a different value each step. */
  const values = [];
  for (let step = 0; step < 64; step += 1) values.push(table[step * 32]);
  for (let step = 1; step < 64; step += 1) {
    assert.notEqual(values[step], values[step - 1], `step ${step} must not repeat the one before it`);
  }
  assert.equal(new Set(values).size, 64, 'sixty-four steps and sixty-four values');

  /* Bipolar, because a matrix source has to be able to subtract. */
  for (const value of values) {
    assert.ok(value >= -1 && value <= 1, `${value} out of range`);
  }
  assert.ok(Math.min(...values) < -0.5, 'the table must reach the negative half');
  assert.ok(Math.max(...values) > 0.5, 'the table must reach the positive half');
});

test('a sample-and-hold buffer steps EXACTLY ONCE per LFO period', () => {
  /* The property that matters: the rate of the jumps is the LFO rate, so the shape
     holds for a period and then moves. Off by the step count it would be a random
     staircase hundreds of times too fast, and no longer sample and hold at all. */
  const table = sampleHoldTable({ sampleRate: 48000, steps: SAMPLE_HOLD_STEPS, samples: SAMPLE_HOLD_SAMPLES, random: seeded(3) });
  assert.equal(table.length, SAMPLE_HOLD_STEPS * SAMPLE_HOLD_SAMPLES);
  const bufferSeconds = table.length / 48000;
  for (const rate of [0.02, 1, 5, 30]) {
    const playback = sampleHoldPlaybackRate(rate, bufferSeconds);
    assert.ok(playback > 0, `${rate} Hz must not become a silent source`);
    const stepRate = (SAMPLE_HOLD_STEPS * playback) / bufferSeconds;
    assert.ok(Math.abs(stepRate - rate) < 1e-9, `${rate} Hz steps at ${stepRate} Hz`);
    /* And so one buffer loop spans exactly SAMPLE_HOLD_STEPS periods. */
    assert.ok(Math.abs(bufferSeconds / playback - SAMPLE_HOLD_STEPS / rate) < 1e-9, `${rate} Hz loop length`);
  }
  /* The slowest rate must not ask for a playback rate a browser would refuse. */
  const slowest = sampleHoldPlaybackRate(LFO_RATE_MIN, bufferSeconds);
  assert.ok(slowest > 1e-4, `a 0.02 Hz LFO asks for playback rate ${slowest}, under the 1e-4 floor`);
  /* The resampled step edge is 1/SAMPLE_HOLD_SAMPLES of a step, at every rate. */
  assert.ok(1 / SAMPLE_HOLD_SAMPLES < 0.005, 'a step edge must stay a step, not a glide');
});

/* -------------------------------------------------------------- the fade-in --- */

test('the fade-in is a curve from zero to one that never goes backwards', () => {
  const curve = fadeCurvePoints(0.25, 64);
  assert.equal(curve.length, 64);
  assert.equal(curve[0], 0, 'an enabled LFO starts at nothing, or it clicks');
  assert.equal(curve[curve.length - 1], 1);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] >= curve[i - 1], `index ${i} went backwards`);
    assert.ok(curve[i] <= 1 && curve[i] >= 0);
  }
  /* A linear ramp: the midpoint really is the midpoint. */
  assert.ok(Math.abs(curve[32] - 0.5) < 0.02);
  /* No fade at all is still a valid single-step curve rather than an error. */
  const instant = fadeCurvePoints(0, 8);
  assert.equal(instant.length, 8);
  assert.ok(instant.every((value) => value === 1), 'a zero fade-in arrives immediately');
});

/* ----------------------------------------------------------- the node wiring --- */

test('the bank builds one oscillator, one sample-hold source and a read tap per LFO', () => {
  const context = createModFakeContext({ sampleRate: 48000 });
  const read = createFakeRead(defaults());
  const bank = createLfoBank({ context, read, bpm: () => 120, random: seeded(5) });

  const created = context.created.filter((node) => node.kind === 'oscillator');
  assert.equal(created.length, 3, 'three LFO oscillators and nothing else');
  const sources = context.created.filter((node) => node.kind === 'bufferSource');
  assert.equal(sources.length, 3, 'one looping sample-and-hold source per LFO');
  for (const source of sources) {
    assert.equal(source.loop, true, 'sample and hold must loop, or it is a one-shot click');
    assert.ok(source.buffer, 'the sample-and-hold source has a stepped buffer');
  }
  /* One tap per LFO, and each tap is reachable from the destination so the
     browser renders it — a tap nothing pulls reads zero forever. */
  assert.equal(context.taps().length, 3);
  for (const tap of context.taps()) assert.equal(tap.connections.length, 1);
  const sink = context.created.find((node) => node.kind === 'gain' && node.gain.value === 0);
  assert.ok(sink, 'the taps end in a zero-gain sink');
  assert.equal(sink.connections.length, 1);
  assert.equal(sink.connections[0].kind, 'destination');
});

test('enabling an LFO is a value CURVE on its fade gain, and disabling ramps it to zero', () => {
  const context = createModFakeContext();
  const read = createFakeRead(defaults());
  const bank = createLfoBank({ context, read, bpm: () => 120, random: seeded(2) });

  const lfo = bank.lfos[0];
  assert.equal(lfo.fade.gain.value, 0, 'an LFO starts silent');
  read.set('lfo1.fadeIn', 0.4);
  read.set('lfo1.on', true);
  bank.refresh();
  assert.equal(lfo.fade.gain.curves.length, 1, 'enabling schedules a curve, not an assignment');
  const [curve] = lfo.fade.gain.curves;
  assert.equal(curve.time, context.currentTime, 'the curve starts now: a held chord must not click');
  assert.ok(Math.abs(curve.duration - 0.4) < 1e-12);
  assert.equal(curve.curve[0], 0);
  assert.equal(lfo.state().on, true);

  read.set('lfo1.on', false);
  bank.refresh();
  assert.equal(lfo.fade.gain.curves.length, 2);
  assert.ok(Math.abs(lfo.fade.gain.curves[1].curve[lfo.fade.gain.curves[1].curve.length - 1]) < 1e-12, 'off is zero');
  assert.equal(lfo.state().on, false);
});

test('a shape change swaps the realisation and never restarts the oscillator', () => {
  const context = createModFakeContext();
  const read = createFakeRead(defaults());
  const bank = createLfoBank({ context, read, bpm: () => 120, random: seeded(4) });
  const lfo = bank.lfos[0];
  const osc = lfo.oscillator;

  read.set('lfo1.wave', 'sawUp');
  bank.refresh();
  assert.equal(lfo.state().shape, 'sawUp');
  assert.equal(lfo.oscillator, osc, 'the same node: an OscillatorNode cannot be restarted');
  assert.ok(osc.periodicWave, 'a saw is a Fourier table on the same oscillator');

  read.set('lfo1.wave', 'sampleHold');
  bank.refresh();
  assert.equal(lfo.sourceGain.gain.value, 1, 'the stepped source takes over');
  assert.ok(lfo.oscillatorGain.gain.value === 0, 'the oscillator is gated off, not stopped');

  read.set('lfo1.wave', 'sine');
  bank.refresh();
  assert.equal(osc.type, 'sine');
});

test('tempo changes move the synced rate and leave the free-running one alone', () => {
  const context = createModFakeContext();
  const read = createFakeRead(defaults());
  let bpm = 120;
  const bank = createLfoBank({ context, read, bpm: () => bpm, random: seeded(9) });

  read.set('lfo1.sync', true);
  read.set('lfo1.rateSync', '1/8');
  read.set('lfo2.rate', 5);
  bank.refresh();
  assert.ok(Math.abs(bank.lfos[0].oscillator.frequency.value - 1) < 1e-12, '1/8 at 120 BPM is 1 Hz');
  assert.equal(bank.lfos[1].oscillator.frequency.value, 5);

  bpm = 60;
  bank.refresh();
  assert.ok(Math.abs(bank.lfos[0].oscillator.frequency.value - 0.5) < 1e-12, '1/8 at 60 BPM is 0.5 Hz');
  assert.equal(bank.lfos[1].oscillator.frequency.value, 5, 'a free-running LFO does not care about tempo');
  assert.equal(bank.lfos[0].state().rateHz, 0.5);
  assert.equal(bank.lfos[0].state().source, 'sync:1/8@60BPM');
});

test('the LFO value is read from a tap, one read per LFO per block', () => {
  const context = createModFakeContext();
  const read = createFakeRead(defaults());
  const bank = createLfoBank({ context, read, bpm: () => 120, random: seeded(6) });
  context.feed(0, 0.5);
  context.feed(1, -0.25);
  context.feed(2, 1);

  const values = bank.sourceValues();
  assert.deepEqual(values, { lfo1: 0.5, lfo2: -0.25, lfo3: 1 });
  for (const tap of context.taps()) assert.equal(tap.reads, 1, 'one read per LFO, not one per route');

  /* A tap with no value in it is silence, never NaN. */
  context.feed(0, Number.NaN);
  assert.equal(bank.sourceValues().lfo1, 0);
});

test('the LFO module owns no timer of any kind', () => {
  const source = readFileSync(new URL('../web/audio/lfo.js', import.meta.url), 'utf8');
  for (const forbidden of [/\bsetInterval\b/, /\bsetTimeout\s*\(/, /requestAnimationFrame/, /\bDate\.now\b/, /performance\.now/]) {
    assert.equal(forbidden.test(source), false, `lfo.js mentions ${forbidden}`);
  }
  /* It is a subscriber, not a scheduler: the tempo arrives through a callback. */
  assert.match(source, /subscribe/, 'lfo.js reads tempo through the clock, not on its own');
});

test('the store is the authority: writing a key moves the LFO through the bank', () => {
  const context = createModFakeContext();
  const store = createStore(SCHEMA);
  const bank = createLfoBank({ context, read: store.get, subscribe: store.subscribe.bind(store), bpm: () => 120, random: seeded(8) });
  const before = context.taps()[0].reads;
  store.set('lfo2.wave', 'triangle');
  assert.equal(bank.lfos[1].state().shape, 'triangle', 'the bank subscribes; no polling');
  bank.sourceValues();
  assert.ok(context.taps()[0].reads > before);
});
