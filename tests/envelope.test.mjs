/**
 * The two ADSRs: the stage machine, the log-scale ranges, and — the part that is
 * easy to get quietly wrong — a note-off DURING the attack or the decay, which
 * must release from where the envelope is rather than from the sustain level.
 *
 * The harness in filter-fake-audio.mjs interpolates its params the way a browser
 * does, so these are assertions about the envelope's real value at real times
 * rather than about what was scheduled and hoped for.
 *
 * Framework-free: `node --test tests/envelope.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MATRIX_SOURCES, SCHEMA, createStore, defaults } from '../web/ui/params.js';
import { createVoice } from '../web/audio/voice.js';
import {
  ATTACK_DECAY_MAX,
  ATTACK_DECAY_MIN,
  ENV_STAGE,
  RELEASE_MAX,
  RELEASE_MIN,
  bindEnvelopeModulation,
  clampAttackDecay,
  clampRelease,
  clampSustain,
  createEnvelope,
} from '../web/audio/env.js';
import { createFakeFilterContext } from './filter-fake-audio.mjs';

const A4 = { id: 'n1', note: 69, velocity: 0.8, random: 0.5 };

function harness(patch = {}) {
  const store = createStore(SCHEMA);
  store.patch(defaults());
  store.patch(patch);
  const context = createFakeFilterContext();
  const parent = context.createGain();
  const voice = createVoice({ context, parent, read: store.get, index: 0 });
  return { store, context, parent, voice };
}

test('the amp envelope walks attack -> decay -> sustain -> release', () => {
  const { voice, context } = harness({
    'envAmp.attack': 0.2,
    'envAmp.decay': 0.3,
    'envAmp.sustain': 0.5,
    'envAmp.release': 0.4,
  });
  voice.start(A4, { at: 0 });

  assert.equal(voice.envelopeStage('amp'), ENV_STAGE.ATTACK, 'at the note it is attacking');
  assert.equal(voice.envelopeStage('filter'), ENV_STAGE.ATTACK, 'and so is the filter envelope');

  context.advance(0.1);
  assert.equal(voice.envelopeStage('amp'), 'attack');
  assert.ok(Math.abs(voice.ampEnvValue() - 0.5) < 1e-9, 'halfway through a 0.2 s attack is half way up');

  context.advance(0.2); // t = 0.3: the attack (0.2 s) has ended
  assert.equal(voice.envelopeStage('amp'), 'decay');

  context.advance(0.05); // t = 0.35: half way down the 0.3 s decay
  assert.equal(voice.envelopeStage('amp'), 'decay');
  assert.ok(Math.abs(voice.ampEnvValue() - 0.75) < 1e-9, 'half way down to sustain');

  context.advance(0.3); // t = 0.65: the decay has ended
  assert.equal(voice.envelopeStage('amp'), 'sustain');
  assert.equal(voice.ampEnvValue(), 0.5, 'and it holds the sustain level');

  voice.release(0.7);
  assert.equal(voice.envelopeStage('amp'), 'release');
  context.advance(0.2); // t = 0.85, three eighths of the way down the 0.4 s release
  assert.ok(Math.abs(voice.ampEnvValue() - 0.3125) < 1e-9, 'falling from the sustain level, 5/8 of it left');
  context.advance(0.3); // t = 1.15: the release is over
  assert.equal(voice.envelopeStage('amp'), 'idle', 'a spent envelope is idle, not stuck');
  assert.equal(voice.ampEnvValue(), 0);
});

test('a 1 ms attack is near-instant, and a 5 s attack is not', () => {
  const fast = harness({ 'envAmp.attack': 0.001, 'envAmp.decay': 0.001, 'envAmp.sustain': 1 });
  fast.voice.start(A4, { at: 0 });
  fast.context.advance(0.002);
  assert.equal(fast.voice.envelopeStage('amp'), 'sustain', 'two ms is past a 1 ms attack');
  assert.equal(fast.voice.ampEnvValue(), 1, 'and it is at full level');
  assert.equal(fast.voice.vca.gain.valueAt(0.001), 1, 'the amp param itself is at full level by then');

  const slow = harness({ 'envAmp.attack': 5, 'envAmp.decay': 5 });
  slow.voice.start(A4, { at: 0 });
  slow.context.advance(1);
  assert.equal(slow.voice.envelopeStage('amp'), 'attack');
  assert.ok(Math.abs(slow.voice.ampEnvValue() - 0.2) < 1e-9, 'one second into a five second attack is a fifth up');
});

test('RELEASE FROM MID-ATTACK: it leaves from where it is, not from the sustain level', () => {
  const { voice, context } = harness({
    'envAmp.attack': 1,
    'envAmp.decay': 1,
    'envAmp.sustain': 0.7,
    'envAmp.release': 0.5,
  });
  voice.start(A4, { at: 0 });
  context.advance(0.25);

  const level = voice.vca.gain.value;
  assert.ok(Math.abs(level - 0.25) < 1e-9, 'a quarter of the way up the attack');
  voice.release(0.25);

  const events = voice.vca.gain.events;
  const held = events.find((event) => event.type === 'cancelAndHoldAtTime' && event.time === 0.25);
  assert.ok(held, 'the in-flight attack is cancelled and held');
  assert.ok(Math.abs(held.value - 0.25) < 1e-9, 'held at the level the envelope had reached');
  // Everything scheduled AFTER the hold is the release itself; the attack and
  // decay ramps scheduled before it were cancelled by the hold.
  const after = events.slice(events.indexOf(held));
  const down = after.filter((event) => event.type === 'linearRampToValueAtTime');
  assert.equal(down.length, 1, 'exactly one ramp after the release');
  assert.equal(down[0].value, 0, 'and it ramps to silence');
  assert.equal(down[0].time, 0.75, 'over the release time');
  assert.ok(!after.some((event) => event.type === 'setValueAtTime'), 'nothing re-aims it at sustain');
  assert.equal(voice.ampEnv.valueAt(0.75), 0, 'and the model agrees the release has landed');

  context.advance(0.25); // t = 0.5: half way down the release
  const halfway = voice.vca.gain.value;
  assert.ok(Math.abs(halfway - 0.125) < 1e-9, `0.25 falling by half, not from 0.7 (got ${halfway})`);
  assert.ok(halfway < 0.7 * 0.25, 'a quarter of the way from where it was, which is far below sustain');

  context.advance(0.25); // t = 0.75
  assert.equal(voice.vca.gain.value, 0);
});

test('RELEASE FROM MID-DECAY: the same, one stage later', () => {
  const { voice, context } = harness({
    'envAmp.attack': 0.2,
    'envAmp.decay': 0.8,
    'envAmp.sustain': 0.6,
    'envAmp.release': 0.4,
  });
  voice.start(A4, { at: 0 });
  context.advance(0.6); // 0.2 of attack done, 0.4 into the decay: 1 -> 0.6
  assert.equal(voice.envelopeStage('amp'), 'decay');
  const level = voice.vca.gain.value;
  assert.ok(Math.abs(level - 0.8) < 1e-9, 'four fifths of the way down the decay');

  voice.release(0.6);
  context.advance(0.2); // half way down the release
  assert.ok(Math.abs(voice.vca.gain.value - 0.4) < 1e-9, 'so it is halved from 0.8, not from 0.6');
});

test('the envelope value IS the param value, at every sampled instant', () => {
  const { voice, context } = harness({
    'envAmp.attack': 0.3,
    'envAmp.decay': 0.7,
    'envAmp.sustain': 0.4,
    'envAmp.release': 0.5,
  });
  voice.start(A4, { at: 0 });

  const times = [];
  for (let t = 0; t <= 1.05; t += 0.05) times.push(t);
  voice.release(1);
  for (let t = 1.05; t <= 1.6; t += 0.05) times.push(t);

  for (const t of times) {
    const model = voice.ampEnv.valueAt(t);
    const param = voice.vca.gain.valueAt(t);
    assert.ok(Math.abs(model - param) < 1e-9, `at t=${t.toFixed(2)} the model says ${model} and the param says ${param}`);
  }
});

test('the shape ranges are the plan\'s: 1 ms..5 s, 0..1, 1 ms..8 s', () => {
  assert.equal(clampAttackDecay(0.0001), ATTACK_DECAY_MIN);
  assert.equal(clampAttackDecay(0.001), 0.001);
  assert.equal(clampAttackDecay(5), 5);
  assert.equal(clampAttackDecay(50), ATTACK_DECAY_MAX);
  assert.equal(clampRelease(0.0001), RELEASE_MIN);
  assert.equal(clampRelease(8), 8);
  assert.equal(clampRelease(80), RELEASE_MAX);
  assert.equal(clampSustain(-1), 0);
  assert.equal(clampSustain(2), 1);
  assert.equal(clampSustain(0.7), 0.7);

  // And the store agrees, so the panel cannot ask for more than the ceiling.
  const store = createStore(SCHEMA);
  store.patch(defaults());
  assert.equal(store.set('envAmp.attack', 99), 5);
  assert.equal(store.set('envAmp.release', 99), 8);
  assert.equal(store.set('envFilter.decay', 0), 0.001);
});

test('a voice\'s sources outlive the envelope release, or the release is silent', () => {
  const { voice } = harness({ 'envAmp.release': 1.5 });
  voice.start(A4, { at: 0 });
  const source = voice.core(0).source;
  voice.release(2);
  assert.ok(source.stoppedAt > 2 + 1.5, `the oscillator keeps running through the release (stopped at ${source.stoppedAt})`);
  assert.ok(source.stoppedAt <= 2 + 1.5 + 0.03, 'and is not left hanging after it either');
});

test('THE FILTER ENVELOPE IS A SOURCE, and there is no filter-envelope amount knob', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  const sources = voice.modulationSources().map((entry) => entry.source);
  for (const wanted of ['ampEnv', 'filterEnv', 'velocity', 'random', 'keyTrack']) {
    assert.ok(sources.includes(wanted), `${wanted} is a matrix source`);
  }
  assert.ok(MATRIX_SOURCES.includes('filterEnv'), 'and it is one of the plan\'s eight sources');

  // THE COUNT. Zero filter-envelope amount controls, in the schema and on the page.
  const store = createStore(SCHEMA);
  store.patch(defaults());
  const keys = store.keys();
  // (The matrix CELLS are called matrix.filterEnv.* — a depth cell in the matrix
  // is the plan's replacement for the knob, not the knob itself.)
  const amountish = keys.filter(
    (key) => !key.startsWith('matrix.') && /filterenv/i.test(key) && /(amount|depth|intensity|level)/i.test(key),
  );
  assert.deepEqual(amountish, [], 'no filter-envelope amount control exists');
  assert.deepEqual(
    keys.filter((key) => key.startsWith('envFilter.')),
    ['envFilter.attack', 'envFilter.decay', 'envFilter.sustain', 'envFilter.release'],
    'the filter envelope has a shape and nothing else',
  );

  // Its value is a plain 0..1 level the matrix can read, and nothing more.
  const filterEnv = voice.modulationSources().find((entry) => entry.source === 'filterEnv');
  assert.deepEqual(filterEnv.range, [0, 1]);
  assert.equal(filterEnv.read(), 0, 'at the note-on instant');
  const destinations = voice.modulationPoints().map((point) => point.destination);
  assert.ok(destinations.includes('cutoff1') && destinations.includes('cutoff2'), 'and the cells it feeds');
});

test('the cutoff destinations task 7 needs are cents, with a range and a write', () => {
  const { voice } = harness({ 'filter1.cutoff': 1000 });
  voice.start(A4, { at: 0 });
  const points = voice.modulationPoints();

  for (const name of ['cutoff1', 'cutoff2']) {
    const point = points.find((entry) => entry.destination === name);
    assert.ok(point, `${name} is a destination`);
    assert.equal(point.unit, 'cents');
    assert.deepEqual(point.range, [-4800, 4800], 'a full cell is four octaves, like the pitch cell');
    assert.equal(point.route(), 0, 'and nothing is routed until task 7 writes');
    point.apply(0, 1200, { at: 0, ramp: false });
  }
  assert.equal(voice.filterCutoff(0), 2000);
  assert.equal(voice.filterCutoff(1), 8000, 'the second stage took the same route over its own panel value');
});

test('the ampLevel destination is an additive bias, not a replacement', () => {
  const { voice, context } = harness({ 'envAmp.attack': 0.001, 'envAmp.sustain': 1 });
  voice.start(A4, { at: 0 });
  context.advance(0.01);
  assert.equal(voice.ampLevelBias(), 0, 'zero bias means the panel value');
  assert.ok(voice.vca.gain.value > 0.99);

  assert.equal(voice.setAmpLevelBias(-1, { at: context.currentTime, ramp: false }), -1);
  assert.equal(voice.ampLevelBias(), -1);
  assert.equal(voice.ampEnv.peak, 0, 'a bias of -1 is silence');
  assert.equal(voice.setAmpLevelBias(0.5, { at: context.currentTime, ramp: false }), 0.5);
  assert.equal(voice.ampEnv.peak, 1.5, 'and a bias of +0.5 lifts the envelope');
  assert.equal(voice.setAmpLevelBias(9, { at: context.currentTime, ramp: false }), 1, 'the bias itself is clamped to -1..1');
});

test('the envelope store fan-out reaches every live voice', () => {
  const store = createStore(SCHEMA);
  store.patch(defaults());
  const context = createFakeFilterContext();
  const first = createVoice({ context, parent: context.createGain(), read: store.get, index: 0 });
  const second = createVoice({ context, parent: context.createGain(), read: store.get, index: 1 });
  const unbind = bindEnvelopeModulation({ store });
  try {
    first.start(A4, { at: 0 });
    second.start({ ...A4, id: 'n2' }, { at: 0 });

    store.set('envAmp.attack', 2.5);
    store.set('envFilter.release', 3);
    for (const voice of [first, second]) {
      assert.equal(voice.ampEnv.times.attack, 2.5);
      assert.equal(voice.filterEnv.times.release, 3);
    }

    // A release drag while the note is fading re-schedules the fade.
    store.set('envAmp.release', 0.2);
    voice_release: {
      const when = context.currentTime;
      first.start({ ...A4, id: 'n3' }, { at: when });
      first.release(when + 0.05);
      store.set('envAmp.release', 0.9);
      const down = first.vca.gain.events.filter((event) => event.type === 'linearRampToValueAtTime');
      assert.ok(down.at(-1).time > when + 0.05 + 0.8, `the release re-scheduled over the new time (ends at ${down.at(-1).time})`);
      break voice_release;
    }
  } finally {
    unbind();
  }
});

test('an envelope with no param is a pure value, which is what a matrix source is', () => {
  const context = createFakeFilterContext();
  const env = createEnvelope({ context, param: null, times: { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.1 } });
  env.start(0);
  context.advance(0.2);
  assert.equal(env.stage(), 'sustain');
  assert.equal(env.value(), 0.5);
  assert.equal(env.state().hasParam, false);
  env.release(0.2);
  context.advance(0.15);
  assert.equal(env.stage(), 'idle');
  assert.equal(env.value(), 0);
});