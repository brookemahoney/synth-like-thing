/**
 * osc-mod.js — the three cross-oscillator mechanisms' own arithmetic and their
 * own graph primitives, tested without a voice, a browser or an audio device.
 *
 * What is genuinely algorithmic here, and therefore worth a test:
 *   - the unison detune DISTRIBUTION (symmetric, exact ±spread, one voice at
 *     count 1, and a clean centre for odd counts);
 *   - the FM depth MAPPING (a deviation ratio, so the modulator's own pitch
 *     scales the deviation and the source selection is not cosmetic);
 *   - ring PAIRWISE assignment, including the cases that must resolve to no
 *     pair at all;
 *   - the re-routing discipline on the FM and ring routers: change the source
 *     a hundred times and exactly one connection is ever live.
 *
 * Framework-free, against the recording stand-in in voice-fake-audio.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_COUNT,
  FM_MAX_INDEX,
  UNISON_MAX,
  UNISON_MIN,
  bindOscModulation,
  clampFmAmount,
  clampUnisonCount,
  clampUnisonSpread,
  fmDeviationHz,
  fmSourceIndex,
  fmRouter,
  modTargets,
  registerVoice,
  ringPartnerIndex,
  ringRouter,
  unisonDetuneCents,
  unisonCentreCents,
  unisonCentreIndex,
  unisonCopyCents,
  unisonSumGain,
} from '../web/audio/osc-mod.js';
import { createFakeAudioContext } from './voice-fake-audio.mjs';

/* ------------------------------------------------------------- the clamps --- */

test('the unison count is clamped to the 1..7 the control offers', () => {
  assert.equal(UNISON_MIN, 1);
  assert.equal(UNISON_MAX, 7);
  assert.equal(clampUnisonCount(1), 1);
  assert.equal(clampUnisonCount(7), 7);
  assert.equal(clampUnisonCount(0), 1, 'below the range is the bottom of the range');
  assert.equal(clampUnisonCount(99), 7);
  assert.equal(clampUnisonCount(3.6), 4, 'a rotary drag can land on a fraction');
  assert.equal(clampUnisonCount(undefined), 1, 'an undeclared key is a single voice');
  assert.equal(clampUnisonCount('nonsense'), 1);
});

test('FM amount and unison spread are clamped to the manual control ranges', () => {
  assert.equal(clampFmAmount(0), 0);
  assert.equal(clampFmAmount(1), 1);
  assert.equal(clampFmAmount(-3), 0);
  assert.equal(clampFmAmount(4), 1);
  assert.equal(clampFmAmount(undefined), 0);
  assert.equal(clampUnisonSpread(0), 0);
  assert.equal(clampUnisonSpread(50), 50);
  assert.equal(clampUnisonSpread(-10), 0);
  assert.equal(clampUnisonSpread(120), 50, 'the schema tops spread at 50 cents');
  assert.equal(clampUnisonSpread(undefined), 0);
});

/* ------------------------------------------------------- the unison spread --- */

test('one unison voice is detune 0: the spread control does nothing at count 1', () => {
  assert.deepEqual(unisonDetuneCents(1, 0), [0]);
  assert.deepEqual(unisonDetuneCents(1, 50), [0], 'a spread with one voice cannot move the pitch');
});

test('unison detune is spread SYMMETRICALLY and LINEARLY across exactly ±spread', () => {
  const seven = unisonDetuneCents(7, 50);
  assert.equal(seven.length, 7);
  assert.deepEqual(
    seven.map((c) => Math.round(c * 100) / 100),
    [-50, -33.33, -16.67, 0, 16.67, 33.33, 50],
    'seven voices step evenly from -50 to +50 with the centre at zero',
  );
  assert.equal(seven[0], -50, 'the extreme copy sits exactly at -spread');
  assert.equal(seven[6], 50, 'and the other at +spread');
  assert.equal(seven[3], 0, 'an odd count has one copy exactly on the centre pitch');

  for (const count of [2, 3, 4, 5, 6, 7]) {
    const cents = unisonDetuneCents(count, 24);
    assert.equal(cents.length, count);
    assert.equal(cents[0], -24, `count ${count}: the low extreme is -spread`);
    assert.equal(cents[count - 1], 24, `count ${count}: the high extreme is +spread`);
    for (let i = 0; i < count; i += 1) {
      assert.equal(cents[count - 1 - i].toFixed(9), (-cents[i]).toFixed(9), `count ${count}: entry ${i} mirrors`);
    }
    for (let i = 1; i < count; i += 1) {
      const step = cents[i] - cents[i - 1];
      assert.ok(Math.abs(step - 48 / (count - 1)) < 1e-9, `count ${count}: the steps are equal`);
    }
  }
});

test('the copies take the distribution either side of the core voice, so the group stays centred', () => {
  // The core's own oscillator owns the CENTRE slot; the copies take the rest in
  // ascending order. That is what stops a unison group sitting a semitone flat.
  assert.equal(unisonCentreIndex(1), 0);
  assert.equal(unisonCentreIndex(2), 1);
  assert.equal(unisonCentreIndex(3), 1);
  assert.equal(unisonCentreIndex(7), 3);

  assert.deepEqual([0, 1].map((k) => unisonCopyCents(3, 24, k)), [-24, 24]);
  assert.deepEqual([0].map((k) => unisonCopyCents(2, 50, k)), [-50]);
  assert.equal(unisonCentreCents(7, 50), 0, 'an odd count puts the core voice on the centre pitch');
  assert.equal(unisonCentreCents(2, 50), 50, 'an even count has no centre, so it takes the upper one');
  assert.equal(unisonCopyCents(1, 50, 0), 0, 'one voice has no copies at all');
  assert.equal(unisonCopyCents(7, 50, 9), 0, 'and a copy index past the count is nothing, not a crash');

  const seven = [0, 1, 2, 3, 4, 5].map((k) => unisonCopyCents(7, 50, k));
  assert.deepEqual(seven.map((c) => Math.round(c * 100) / 100), [-50, -33.33, -16.67, 16.67, 33.33, 50]);
  for (let i = 0; i < seven.length; i += 1) {
    assert.equal(seven[seven.length - 1 - i].toFixed(9), (-seven[i]).toFixed(9), 'the copies mirror');
  }
});

test('a zero spread is unison without detune, and a spread of zero is a single pitch', () => {
  assert.deepEqual(unisonDetuneCents(5, 0), [0, 0, 0, 0, 0]);
  assert.equal(unisonSumGain(1), 1);
  assert.equal(unisonSumGain(4), 0.25, 'the copies sum to one voice worth of level');
  assert.equal(unisonSumGain(7).toFixed(9), (1 / 7).toFixed(9));
});

/* ------------------------------------------------------------------- FM ----- */

test('FM source names resolve to a core index, and only the real ones resolve', () => {
  assert.equal(CORE_COUNT, 3);
  assert.equal(fmSourceIndex('none'), -1);
  assert.equal(fmSourceIndex('osc1'), 0, 'self-modulation is allowed: it is legal feedback FM');
  assert.equal(fmSourceIndex('osc2'), 1);
  assert.equal(fmSourceIndex('osc3'), 2);
  assert.equal(fmSourceIndex(undefined), -1);
  assert.equal(fmSourceIndex('osc9'), -1, 'an undeclared source is no modulator, not a crash');
});

test('FM depth is a DEVIATION RATIO in hertz: it scales with the modulator pitch', () => {
  assert.equal(FM_MAX_INDEX, 8, 'the documented maximum deviation ratio');
  assert.equal(fmDeviationHz(0, 440), 0, 'no amount, no deviation');
  assert.equal(fmDeviationHz(1, 440), 8 * 440, 'at full amount the peak deviation is 8 modulator periods');
  assert.equal(fmDeviationHz(0.5, 440), 4 * 440, 'and the control is linear in the ratio');
  assert.equal(fmDeviationHz(1, 0), 0, 'a silent modulator modulates nothing');

  // The property that makes the source selection real rather than cosmetic: the
  // carrier's pitch excursion is a function of the MODULATOR's pitch.
  assert.ok(
    fmDeviationHz(1, 622.25) > fmDeviationHz(1, 440),
    'moving the modulator up widens the carrier excursion, so the FM source is audible',
  );
  const fifth = 2 ** (7 / 12); // a fifth, in frequency ratio
  const ratio = fmDeviationHz(1, 440 * fifth) / fmDeviationHz(1, 440);
  assert.ok(Math.abs(ratio - fifth) < 1e-9, 'a fifth up in the modulator is a fifth up in the deviation');
});

/* ------------------------------------------------------------------ ring ---- */

test('a ring assignment resolves to exactly one PAIR, and the impossible ones to none', () => {
  assert.equal(ringPartnerIndex(0, 'none', CORE_COUNT), -1);
  assert.equal(ringPartnerIndex(0, 'osc2', CORE_COUNT), 1);
  assert.equal(ringPartnerIndex(1, 'osc3', CORE_COUNT), 2);
  assert.equal(ringPartnerIndex(2, 'osc1', CORE_COUNT), 0);
  assert.equal(ringPartnerIndex(0, 'osc1', CORE_COUNT), -1, 'a core cannot ring-modulate itself');
  assert.equal(ringPartnerIndex(0, 'osc9', CORE_COUNT), -1);
  assert.equal(ringPartnerIndex(0, undefined, CORE_COUNT), -1);
  assert.equal(ringPartnerIndex(0, 'osc3', 2), -1, 'a partner outside the voice is not a pair');
});

/* --------------------------------------------------------------- the FM router */

test('the FM depth gain is connected to the carrier pitch param, once, for good', () => {
  const context = createFakeAudioContext();
  const pitchSource = context.createConstantSource();
  const router = fmRouter(context, pitchSource);

  assert.equal(router.node, null, 'no depth node until FM is asked for');
  router.apply({ modulator: null, index: -1, amount: 0, modulatorHz: 440, at: 0, ramp: false });
  assert.equal(router.node, null, 'and a core that modulates nothing builds nothing at all');

  router.apply({ modulator: context.createGain(), index: 0, amount: 0, modulatorHz: 440, at: 0, ramp: false });

  assert.ok(router.node, 'the first assignment creates it');
  assert.ok(
    router.node.connections.includes(pitchSource.offset),
    'the depth is summed into the carrier pitch in hertz, the same signal the note writes',
  );

  for (let i = 0; i < 50; i += 1) router.apply({ modulator: null, index: -1, amount: 0, modulatorHz: 440, at: i, ramp: false });
  assert.equal(router.node.connections.filter((c) => c === pitchSource.offset).length, 1, 'fifty writes, one connection');
});

test('re-routing FM disconnects the old modulator before connecting the new one', () => {
  const context = createFakeAudioContext();
  const pitchSource = context.createConstantSource();
  const one = context.createGain();
  const two = context.createGain();
  const router = fmRouter(context, pitchSource);

  // The modulator is an INPUT of the depth gain, so the edge lives on the
  // modulator. Asserting it on the depth gain's own list would pass with the
  // connection pointing the wrong way, which is silent.
  router.apply({ modulator: one, index: 0, amount: 1, modulatorHz: 440, at: 0, ramp: false });
  assert.equal(one.connections.includes(router.node), true);
  assert.equal(router.node.connections.includes(one), false, 'and definitely not the other way round');

  for (let i = 0; i < 100; i += 1) {
    const toTwo = i % 2 === 0;
    router.apply({ modulator: toTwo ? two : one, index: toTwo ? 1 : 0, amount: 1, modulatorHz: 440, at: i, ramp: false });
  }

  const live = [one, two].filter((mod) => mod.connections.includes(router.node));
  assert.deepEqual(live, [one], 'a hundred re-routes leave exactly ONE modulator connected');
  assert.equal(router.state().sourceIndex, 0);
  assert.equal(router.state().connected, true);
});

test('FM amount reaches the depth param by a RAMP, never by writing the value', () => {
  const context = createFakeAudioContext();
  const pitchSource = context.createConstantSource();
  const mod = context.createGain();
  const router = fmRouter(context, pitchSource);

  router.apply({ modulator: mod, index: 0, amount: 0, modulatorHz: 440, at: 3, ramp: false });
  const events = router.node.gain.events;
  events.length = 0;

  router.apply({ modulator: mod, index: 0, amount: 1, modulatorHz: 440, at: 3, ramp: true });

  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.type !== 'setValueAtTime' || e.value === 0), 'no instant step during the drag');
  assert.ok(events.some((e) => e.type === 'linearRampToValueAtTime' && e.value === 8 * 440), 'ramped to the full deviation');
  assert.ok(events.some((e) => e.type === 'cancelAndHoldAtTime' && e.time === 3), 'against the audio clock');
});

test('FM amount 0 returns the depth gain to 0, so a connected modulator is silent', () => {
  const context = createFakeAudioContext();
  const router = fmRouter(context, context.createConstantSource());
  const mod = context.createGain();

  router.apply({ modulator: mod, index: 0, amount: 1, modulatorHz: 440, at: 0, ramp: false });
  assert.equal(router.node.gain.value, 8 * 440);

  router.apply({ modulator: mod, index: 0, amount: 0, modulatorHz: 440, at: 0, ramp: false });
  assert.equal(router.node.gain.value, 0);
  assert.equal(router.state().index, 0, 'and the deviation ratio reads zero');
});

/* -------------------------------------------------------------- the ring router */

test('the ring product is a gain of ZERO with one signal in its input and the other in its param', () => {
  const context = createFakeAudioContext();
  const bus = context.createGain();
  const carrier = context.createGain();
  const modulator = context.createGain();
  const router = ringRouter(context, bus, 0);

  router.apply({ carrier, modulator, partner: 1, on: true, at: 0, ramp: false });

  assert.equal(router.node.gain.value, 0, '0 + a*b, not 1 + a*b');
  assert.equal(carrier.connections.includes(router.node), true, 'the carrier is an INPUT of the product');
  assert.equal(router.node.connections.includes(carrier), false, 'not an output of it: that would be silent');
  assert.equal(modulator.connections.includes(router.node.gain), true, 'the modulator is summed into the gain param');
  assert.ok(router.node.connections.includes(bus), 'and the product does go out to the ring bus');
  assert.equal(router.state().active, true);
  assert.equal(router.state().partner, 1);
});

test('ring off is a DISCONNECT plus silence, not just a gain of zero', () => {
  const context = createFakeAudioContext();
  const bus = context.createGain();
  const carrier = context.createGain();
  const modulator = context.createGain();
  const router = ringRouter(context, bus, 0);

  router.apply({ carrier, modulator, partner: 1, on: true, at: 0, ramp: false });
  router.apply({ carrier, modulator, partner: 1, on: false, at: 0, ramp: false });

  assert.equal(carrier.connections.includes(router.node), false, 'the carrier input is cut');
  assert.equal(modulator.connections.includes(router.node.gain), false, 'the modulator param is cut');
  assert.ok(router.node.connections.includes(bus), 'but the product node itself stays in the voice');
  assert.equal(router.state().active, false);
});

test('changing the ring pair a hundred times leaves exactly one carrier and one modulator', () => {
  const context = createFakeAudioContext();
  const bus = context.createGain();
  const carriers = [context.createGain(), context.createGain(), context.createGain()];
  const modulators = [context.createGain(), context.createGain(), context.createGain()];
  const router = ringRouter(context, bus, 0);

  for (let i = 0; i < 100; i += 1) {
    const partner = i % 3;
    router.apply({
      carrier: carriers[partner],
      modulator: modulators[(partner + 1) % 3],
      partner,
      on: true,
      at: i,
      ramp: false,
    });
  }

  const last = 99 % 3;
  assert.deepEqual(carriers.filter((c) => c.connections.includes(router.node)), [carriers[last]]);
  assert.equal(modulators.filter((m) => m.connections.includes(router.node.gain)).length, 1);
  assert.ok(router.node.connections.includes(bus), 'and exactly one path to the bus');
});

/* ---------------------------------------------------- the store fan-out seam --- */

test('the FM / unison / ring keys fan out to every registered voice that is built', () => {
  const context = createFakeAudioContext();
  const calls = [];
  const fakeStore = {
    subscribed: [],
    subscribe(key, fn) {
      this.subscribed.push(key);
      fn(key);
      return () => {};
    },
  };
  const targets = [
    { cores: [{}, {}, {}], context, applyCoreModulation: (core, key, value) => calls.push(['built', core, key, value]) },
    { cores: null, context, applyCoreModulation: () => calls.push(['unbuilt']) },
  ];

  const stop = bindOscModulation({ store: fakeStore, list: () => targets });

  const keys = fakeStore.subscribed;
  assert.equal(keys.length, 15, 'three cores x five keys, and not one more');
  for (const name of ['fmAmount', 'fmSource', 'unison', 'unisonSpread', 'ringMod']) {
    assert.equal(keys.filter((k) => k.endsWith(`.${name}`)).length, 3, `three ${name} keys`);
  }
  assert.equal(calls.filter((c) => c[0] === 'unbuilt').length, 0, 'a voice with no cores yet is skipped, not crashed');
  assert.equal(calls.filter((c) => c[0] === 'built' && c[2].endsWith('.fmAmount')).length, 3);
  assert.equal(typeof stop, 'function');
  assert.equal(stop(), undefined, 'the binding can be undone');
});

test('the module-level registry is what the binding fans out to, and a voice registers once', () => {
  const before = modTargets().length;
  const voice = { name: 'probe' };
  const off = registerVoice(voice);
  assert.equal(modTargets().length, before + 1);
  assert.ok(modTargets().includes(voice));
  off();
  assert.equal(modTargets().length, before, 'and unregisters cleanly, so a disposed voice stops receiving');
});
