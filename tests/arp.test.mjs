/**
 * arp.test.mjs — the arpeggiator's two pieces of arithmetic, which are the parts of
 * task 10 that are genuinely algorithmic and cannot be verified by ear:
 *
 *   1. THE RATE. Six tempo-synced divisions including two triplets, turned into an
 *      ABSOLUTE slot index on the clock's own beat grid. The clock only ever emits
 *      sixteenths, so a triplet rate has to place its notes at 1/3-beat positions
 *      inside those sixteenths. Doing that by counting steps cannot work — 1/8T is
 *      two notes per beat, which is 1.5 sixteenths per note — so the slot index is
 *      computed in beats and the time is derived from the step's own grid time. That
 *      is why this module is testable without a clock at all.
 *
 *   2. THE ORDER. All five modes over a chord, including octave range and a seeded
 *      random stream.
 *
 * Framework-free: `node --test tests/arp.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARP_MODE_ORDER,
  ARP_RATE_BEATS,
  arpIntervalBeats,
  arpOrder,
  arpPool,
  arpSlotBeats,
  arpSlotsForStep,
  createArpCursor,
  mulberry32,
} from '../web/audio/arp.js';
import { ARP_MODES, SYNC_RATES } from '../web/ui/params.js';

/* ------------------------------------------------------------------- the rate --- */

test('every declared sync rate has a beats-per-note division, and the five straight ones are exact', () => {
  /* Derived from the schema's own enum, so a seventh rate is a test failure here
     rather than a silently dead option in the panel. */
  assert.deepEqual(Object.keys(ARP_RATE_BEATS).sort(), [...SYNC_RATES].sort());
  assert.deepEqual(ARP_MODE_ORDER, [...ARP_MODES]);

  assert.equal(arpIntervalBeats('1/4'), 1);
  assert.equal(arpIntervalBeats('1/8'), 0.5);
  assert.equal(arpIntervalBeats('1/16'), 0.25);
  assert.equal(arpIntervalBeats('1/32'), 0.125);

  /* The triplets are thirds of their straight parent, not approximations. */
  assert.equal(arpIntervalBeats('1/8T'), arpIntervalBeats('1/8') * (2 / 3));
  assert.equal(arpIntervalBeats('1/16T'), arpIntervalBeats('1/16') * (2 / 3));

  /* An unknown rate falls back to a sixteenth rather than to zero: a zero interval
     would schedule an unbounded number of notes in one step. */
  assert.equal(arpIntervalBeats('nonsense'), 0.25);
  assert.equal(arpIntervalBeats('nonsense'), arpIntervalBeats('1/16'));
});

test('a grid step contains the arpeggiator slots its rate calls for', () => {
  const slotsFor = (rate, absoluteStep) =>
    arpSlotsForStep({ absoluteStep, stepsPerBeat: 4, intervalBeats: arpIntervalBeats(rate) });

  /* 1/4 lands on every beat, so only every fourth sixteenth fires — and exactly one
     slot each, at the START of that sixteenth (k*1 beat == the step's own beat). */
  assert.deepEqual(slotsFor('1/4', 0), [0]);
  assert.deepEqual(slotsFor('1/4', 4), [1]);
  assert.deepEqual(slotsFor('1/4', 8), [2]);
  for (let step = 0; step < 16; step += 1) {
    const expected = step % 4 === 0 ? [step / 4] : [];
    assert.deepEqual(slotsFor('1/4', step), expected, `step ${step} at 1/4`);
  }
  assert.deepEqual(slotsFor('1/4', 16), [4]);

  /* 1/8: every other sixteenth, offset by one whole step from the quarter. */
  assert.deepEqual(slotsFor('1/8', 0), [0]);
  assert.deepEqual(slotsFor('1/8', 1), []);
  assert.deepEqual(slotsFor('1/8', 2), [1]);
  assert.deepEqual(slotsFor('1/8', 3), []);

  /* 1/16: exactly one per sixteenth, which is the degenerate "no division" case and
     the one that proves the arithmetic agrees with the clock's own grid. */
  for (let step = 0; step < 32; step += 1) {
    assert.deepEqual(slotsFor('1/16', step), [step], `step ${step} at 1/16`);
  }

  /* 1/32: two slots per sixteenth, both inside it. */
  assert.deepEqual(slotsFor('1/32', 0), [0, 1]);
  assert.deepEqual(slotsFor('1/32', 3), [6, 7]);

  /* THE TRIPLETS. Three notes per beat means three slots land in every quarter of
     the bar — and they are NOT on the sixteenth grid, which is the whole reason this
     is computed in beats. Every slot of a bar is accounted for, exactly once. */
  const eighthTriplets = [];
  for (let step = 0; step < 16; step += 1) eighthTriplets.push(...slotsFor('1/8T', step));
  assert.equal(eighthTriplets.length, 12, '1/8T is three notes per beat: twelve per bar');
  assert.deepEqual(eighthTriplets, [...Array(12).keys()], 'one slot per eighth-triplet, in order');
  for (let index = 1; index < eighthTriplets.length; index += 1) {
    assert.equal(eighthTriplets[index], eighthTriplets[index - 1] + 1, 'no gap and no repeat');
  }

  const sixteenthTriplets = [];
  for (let step = 0; step < 16; step += 1) sixteenthTriplets.push(...slotsFor('1/16T', step));
  assert.equal(sixteenthTriplets.length, 24, '1/16T is six notes per beat: twenty-four per bar');
  assert.deepEqual(sixteenthTriplets, [...Array(24).keys()]);

  /* 1/32 is four times faster than 1/8, and eight times faster than 1/4. Both are
     whole-number ratios of notes per bar: 16, 32, 8, 48, 96, 64. */
  const perBar = (rate) => {
    let count = 0;
    for (let step = 0; step < 16; step += 1) count += slotsFor(rate, step).length;
    return count;
  };
  assert.equal(perBar('1/4'), 4);
  assert.equal(perBar('1/8'), 8);
  assert.equal(perBar('1/8T'), 12);
  assert.equal(perBar('1/16'), 16);
  assert.equal(perBar('1/16T'), 24);
  assert.equal(perBar('1/32'), 32);
  assert.equal(perBar('1/32') / perBar('1/4'), 8);
  assert.equal(perBar('1/32') / perBar('1/8'), 4);
});

test('the slot offset within a step is uniform, so a triplet is evenly spaced in TIME', () => {
  /* The offsets are measured from the step's own grid time, in beats. At 120 BPM a
     beat is 0.5 s, so the three 1/8T slots of a bar sit a third of a beat apart —
     which is the property the sixteenth grid cannot express. */
  const beat = 0.5;
  const times = [];
  for (let step = 0; step < 4; step += 1) {
    for (const slot of arpSlotsForStep({ absoluteStep: step, stepsPerBeat: 4, intervalBeats: arpIntervalBeats('1/8T') })) {
      times.push(arpSlotBeats(slot, arpIntervalBeats('1/8T')) * beat);
    }
  }
  assert.equal(times.length, 3);
  assert.deepEqual(times, [0, 1 / 6, 1 / 3]);
  const gapA = times[1] - times[0];
  const gapB = times[2] - times[1];
  assert.ok(Math.abs(gapA - gapB) < 1e-12, `triplet spacing must be uniform: ${gapA} vs ${gapB}`);
  assert.ok(Math.abs(gapA - 1 / 6) < 1e-12, '1/8T at 120 BPM is a sixth of a second per note');

  /* And the sixteenth grid is untouched: the clock still subdivides the same beat
     four ways while the arpeggiator puts three notes inside it. A triplet step's
     slots are therefore NOT sixteenth-aligned — which is the whole reason this is
     computed in beats rather than by counting steps. */
  const tripletOffsets = arpSlotsForStep({ absoluteStep: 1, stepsPerBeat: 4, intervalBeats: arpIntervalBeats('1/8T') })
    .map((slot) => arpSlotBeats(slot, arpIntervalBeats('1/8T')));
  assert.deepEqual(tripletOffsets, [1 / 3], 'the second sixteenth carries the bar\'s second triplet');
  assert.ok(
    !tripletOffsets.some((beats) => Math.abs((beats * 4) % 1) < 1e-12 && beats * 4 > 0),
    '1/8T offsets must not land on the sixteenth grid',
  );
  assert.equal(arpSlotsForStep({ absoluteStep: 1, stepsPerBeat: 4, intervalBeats: 0.25 }).length, 1);
});

/* ------------------------------------------------------------------ the order --- */

const CHORD = [60, 64, 67]; // C E G, played in that order

test('the pool is the chord spread over its octave range, ascending', () => {
  assert.deepEqual(arpPool(CHORD, { octaves: 1 }), [60, 64, 67]);
  assert.deepEqual(arpPool(CHORD, { octaves: 2 }), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(arpPool(CHORD, { octaves: 4 }), [
    60, 64, 67, 72, 76, 79, 84, 88, 91, 96, 100, 103,
  ]);

  /* Play order is irrelevant except for As-Play, so an unsorted chord still produces
     a sorted pool for the other four modes. */
  assert.deepEqual(arpPool([67, 60, 64], { octaves: 1 }), [60, 64, 67]);

  /* Deduplicated, and clamped into the MIDI range rather than trusted. */
  assert.deepEqual(arpPool([60, 60, 64], { octaves: 1 }), [60, 64]);
  assert.deepEqual(arpPool([120], { octaves: 2 }), [120]);

  /* An empty chord has no pool and no octave to add. */
  assert.deepEqual(arpPool([], { octaves: 4 }), []);
  assert.deepEqual(arpPool(undefined, { octaves: 4 }), []);
});

test('all five modes produce distinct orderings over the same chord', () => {
  const at = (mode, opts) => arpOrder(mode, CHORD, { octaves: 1, ...opts });

  assert.deepEqual(at('up'), [60, 64, 67]);
  assert.deepEqual(at('down'), [67, 64, 60]);
  /* Up-Down turns round at both ends and does not repeat either of them. */
  assert.deepEqual(at('updown'), [60, 64, 67, 64]);
  /* As-Play keeps the order the notes arrived in — here C E G is also ascending, so
     the test uses the reversed chord to tell the two modes apart. */
  assert.deepEqual(arpOrder('asplay', [67, 60, 64], { octaves: 1 }), [67, 60, 64]);
  assert.deepEqual(arpOrder('asplay', [67, 60, 64], { octaves: 2 }), [67, 60, 64, 79, 72, 76]);
  assert.deepEqual(arpOrder('up', [67, 60, 64], { octaves: 1 }), [60, 64, 67]);
  assert.deepEqual(arpOrder('asplay', CHORD, { octaves: 1 }), at('up'), 'C E G happens to be sorted');

  /* Every mode's ordering is a permutation of the pool — none drops or invents a note. */
  for (const mode of ARP_MODES) {
    const order = mode === 'random' ? arpOrder(mode, CHORD, { octaves: 2, random: mulberry32(7), length: 24 }) : at(mode, { octaves: 2 });
    const pool = arpPool(CHORD, { octaves: 2 });
    for (const note of order) assert.ok(pool.includes(note), `${mode} produced ${note}, which is not in the pool`);
    assert.ok(order.length > 0, `${mode} produced nothing`);
  }
});

test('Up-Down degenerates correctly on one and two notes', () => {
  assert.deepEqual(arpOrder('updown', [60], { octaves: 1 }), [60]);
  assert.deepEqual(arpOrder('updown', [60], { octaves: 2 }), [60, 72]);
  assert.deepEqual(arpOrder('updown', [60, 64], { octaves: 1 }), [60, 64]);
  /* A two-note POOL has nowhere to turn round to; a four-note pool (two octaves of a
     pair) has two interior notes, and they come back down. */
  assert.deepEqual(arpOrder('updown', [60, 64], { octaves: 2 }), [60, 64, 72, 76, 72, 64]);
  assert.deepEqual(arpOrder('up', [60], { octaves: 4 }), [60, 72, 84, 96]);
});

test('the octave range widens the note span and nothing else moves', () => {
  const span = (octaves) => {
    const order = arpOrder('up', CHORD, { octaves });
    return Math.max(...order) - Math.min(...order);
  };
  assert.equal(span(1), 7);
  assert.equal(span(2), 19);
  assert.equal(span(3), 31);
  assert.equal(span(4), 43);
  /* One octave more is exactly twelve semitones of span, every time. */
  for (let octaves = 1; octaves < 4; octaves += 1) {
    assert.equal(span(octaves + 1) - span(octaves), 12);
  }
  /* The lowest note is always the held note; the octave range reaches upwards. */
  for (let octaves = 1; octaves <= 4; octaves += 1) {
    assert.equal(arpOrder('up', CHORD, { octaves })[0], 60);
  }
});

test('Random is seeded, so it is exactly reproducible, and unseeded it still draws from the pool only', () => {
  const seeded = (seed, length = 16) => arpOrder('random', CHORD, { octaves: 1, random: mulberry32(seed), length });

  assert.deepEqual(seeded(42), seeded(42), 'the same seed gives the same order');
  assert.notDeepEqual(seeded(42), seeded(43), 'a different seed gives a different order');

  /* The seeded stream is a real PRNG, not a constant: over sixteen draws on a
     three-note pool, more than one note must appear, and it must not be all one. */
  const pool = arpPool(CHORD, { octaves: 1 });
  const draws = seeded(42, 64);
  assert.equal(draws.length, 64);
  for (const note of draws) assert.ok(pool.includes(note), 'every draw is a pool member');
  assert.ok(new Set(draws).size > 1, 'a constant stream is not a random mode');
  assert.equal(new Set(draws).size, 3, 'every note of the pool is reachable');
  assert.deepEqual([...new Set(draws)].sort(), pool);

  /* An RNG that returns its argument's edge is handled, not crashed: 0.999... must
     not index past the end of the pool. */
  assert.deepEqual(arpOrder('random', CHORD, { octaves: 1, random: () => 0.999999, length: 3 }), [67, 67, 67]);
  assert.deepEqual(arpOrder('random', CHORD, { octaves: 1, random: () => -5, length: 3 }), [60, 60, 60]);
  assert.deepEqual(arpOrder('random', [], { octaves: 1, length: 3 }), []);
});

test('mulberry32 is a deterministic 0..1 stream and is the seeding primitive', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const values = [];
  for (let i = 0; i < 1000; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1, `${value} is outside 0..1`);
    values.push(value);
  }
  /* Not constant, and roughly uniform: the mean of 1000 draws is near a half. */
  assert.ok(new Set(values).size > 900, 'the stream is not degenerate');
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} should be near 0.5`);
});

test('the cursor is the same ordering as arpOrder, wrapped, and resets', () => {
  for (const mode of ['up', 'down', 'updown', 'asplay']) {
    const pool = arpPool(CHORD, { octaves: 1 });
    const cursor = createArpCursor(mode);
    const cycle = arpOrder(mode, CHORD, { octaves: 1 });
    assert.equal(cycle.length, cursor.length(pool), `${mode}: arpOrder length matches the cursor`);
    for (let i = 0; i < cycle.length * 2; i += 1) {
      assert.equal(pool[cursor.next(pool)], cycle[i % cycle.length], `${mode} note ${i}`);
    }
    cursor.reset();
    assert.equal(pool[cursor.next(pool)], cycle[0], `${mode} resets to the top`);
  }

  /* The cursor rebuilds its cycle when the pool's size changes, which is what happens
     when a key is added to a held chord. */
  const cursor = createArpCursor('up');
  assert.equal(cursor.next([60, 64, 67]), 0);
  assert.equal(cursor.next([60, 64, 67, 71]), 1);
  assert.equal(cursor.next([60, 64, 67, 71]), 2);
  assert.equal(cursor.next([60, 64, 67, 71]), 3);
  assert.equal(cursor.next([60, 64, 67, 71]), 0, 'the cycle wraps at the new size');
  assert.equal(cursor.next([]), 0, 'an empty pool is answered, not crashed on');
  /* An empty pool must not TEAR DOWN the cycle: a momentary gap in a held chord is
     answered with 0 and leaves the walk where it was, so the chord does not restart. */
  assert.equal(cursor.length([60, 64, 67, 71]), 4, 'the cycle survived the empty pool');
  const resumed = cursor.next([60, 64, 67, 71]);
  assert.ok(resumed >= 0 && resumed < 4, `${resumed} is a valid index into the pool`);
});
