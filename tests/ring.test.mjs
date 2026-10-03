/**
 * Ring modulation at the voice level — the part of this task that is a GRAPH
 * change rather than a parameter change, and the part the plan's risk register
 * names: "Frequency-modulation and ring-modulator changes can leave a voice
 * connected to a node it should no longer be routed to".
 *
 * So the assertions here are mostly about the shape of the wiring:
 *   - the product is a gain of zero with one signal in its input and the other
 *     summed into its gain param, which is what `a * b` actually is;
 *   - the assignment is ADDITIVE: the partner still feeds the mixer directly;
 *   - "off" is a disconnect plus a bus level of zero, not merely a low gain;
 *   - a hundred re-routes mid-note leave exactly one carrier and one modulator,
 *     a flat node tally, and a teardown that still cuts one node.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createVoice } from '../web/audio/voice.js';
import { RING_BUS_LEVEL } from '../web/audio/osc-mod.js';
import { nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { createFakeAudioContext, createFakeRead } from './voice-fake-audio.mjs';

function defaultRead(overrides = {}) {
  return createFakeRead({
    'osc1.waveform': 'sawtooth',
    'osc1.octave': 0,
    'osc1.semitone': 0,
    'osc1.detune': 0,
    'osc1.level': 0.8,
    'osc1.fmAmount': 0,
    'osc1.fmSource': 'none',
    'osc1.unison': 1,
    'osc1.unisonSpread': 0,
    'osc1.ringMod': 'none',
    'osc2.waveform': 'square',
    'osc2.octave': 0,
    'osc2.semitone': 0,
    'osc2.detune': 0,
    'osc2.level': 0.5,
    'osc2.fmAmount': 0,
    'osc2.fmSource': 'none',
    'osc2.unison': 1,
    'osc2.unisonSpread': 0,
    'osc2.ringMod': 'none',
    'osc3.waveform': 'sine',
    'osc3.octave': 0,
    'osc3.semitone': 0,
    'osc3.detune': 0,
    'osc3.level': 0.35,
    'osc3.fmAmount': 0,
    'osc3.fmSource': 'none',
    'osc3.unison': 1,
    'osc3.unisonSpread': 0,
    'osc3.ringMod': 'none',
    'mixer.level': 0.8,
    ...overrides,
  });
}

function harness(read = defaultRead()) {
  const context = createFakeAudioContext();
  const parent = context.createGain();
  const voice = createVoice({ context, parent, read, index: 0 });
  return { context, parent, read, voice };
}

const A4 = { id: 'n1', note: 69, velocity: 0.8, random: 0.5 };

/** The node tally is the instrument's own: the fake context's own map is inert. */
const createdOf = (label) => nodeStats().byLabel[label]?.created ?? 0;
const liveOf = (label) => nodeStats().byLabel[label]?.live ?? 0;


beforeEach(() => resetNodeStats());

test('with no assignment the ring bus is a summing input at ZERO, and no product node exists', () => {
  const { context, voice } = harness();
  voice.start(A4, { at: 0 });

  assert.equal(voice.ringBus.gain.value, 0, 'the bus is silent when nothing is assigned to it');
  assert.equal(voice.ringState(0).active, false);
  assert.equal(voice.ringState(0).partner, -1);
  assert.equal(voice.core(0).ring.node, null, 'a product node is built on the first assignment, not before');
  assert.equal(createdOf('ring-product'), 0);
  assert.equal(voice.ringBus.connections.includes(voice.mix), true, 'and the bus is still where task 3 left it');
});

test('an assignment builds ONE product node: gain 0, carrier in the input, modulator in the param', () => {
  const read = defaultRead({ 'osc1.ringMod': 'osc2' });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  const product = voice.core(0).ring.node;
  assert.ok(product, 'one product node for the voice');
  assert.equal(createdOf('ring-product'), 1);
  assert.equal(product.gain.value, 0, '0 + a*b is a product; 1 + a*b would be a mix');
  assert.equal(voice.core(0).raw.connections.includes(product), true, 'the core that asked is the carrier, feeding the product');
  assert.equal(voice.core(1).raw.connections.includes(product), false, 'the modulator is NOT an audio input');
  assert.ok(voice.core(1).raw.connections.includes(product.gain), 'it arrives through the gain PARAM, which is what makes it multiply');
  assert.ok(product.connections.includes(voice.ringBus), 'the product feeds the ring bus');
  assert.equal(voice.ringBus.gain.value, RING_BUS_LEVEL, 'and an active pair opens the bus');
  assert.deepEqual(voice.ringState(0).pairs(), [{ core: 0, partner: 1 }]);
});

test('ADDITIVE, NOT EXCLUSIVE: the partner still feeds the mixer directly', () => {
  const read = defaultRead({ 'osc1.ringMod': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(voice.core(1).gain.connections.includes(voice.mix), true, 'osc 2 is still a plain mixer input');
  assert.equal(voice.core(0).gain.connections.includes(voice.mix), true, 'and so is the core that owns the assignment');
  assert.equal(voice.core(1).gain.gain.value, 0.5, 'its own level is untouched by the ring assignment');

  // The criterion's scenario: silence the PARTNER's own level. Its direct
  // contribution goes, the ring product stays, so the voice is still sounding.
  voice.setCoreLevel(1, 0, { at: 0 });

  assert.equal(voice.core(1).gain.gain.value, 0, 'the dry path is gone');
  assert.equal(voice.ringState(0).active, true, 'and the product survives, because a modulator is tapped pre-level');
  assert.ok(voice.core(1).raw.connections.includes(voice.core(0).ring.node.gain), 'the ring input is the raw bus, not the level');
  assert.equal(voice.ringBus.gain.value, RING_BUS_LEVEL, 'the bus is still open, so the product is still audible');

  voice.setCoreLevel(1, 0.5, { at: 0 });
  assert.equal(voice.ringState(0).active, true, 'restoring the level changes the tone, not the routing');
});

test('turning the assignment off DISCONNECTS the pair and returns the bus to zero', () => {
  const read = defaultRead({ 'osc1.ringMod': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });
  const product = voice.core(0).ring.node;

  read.set('osc1.ringMod', 'none');
  voice.applyCoreModulation(0, 'osc1.ringMod', 'none');

  assert.equal(voice.core(0).raw.connections.includes(product), false, 'the carrier input is cut');
  assert.equal(voice.core(1).raw.connections.includes(product.gain), false, 'the modulator is cut');
  assert.ok(product.connections.includes(voice.ringBus), 'the product node itself stays inside the voice');
  assert.equal(voice.ringBus.gain.value, 0, 'and the bus contributes silence');
  assert.equal(voice.ringState(0).active, false);
  assert.equal(voice.ringState(0).partner, -1);
  assert.equal(voice.core(1).gain.connections.includes(voice.mix), true, 'osc 2 is back to being just a mixer input');
});

test('the bus is shared: two pairs sum into it, and the last one standing keeps it open', () => {
  const read = defaultRead({ 'osc1.ringMod': 'osc2', 'osc2.ringMod': 'osc3' });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(createdOf('ring-product'), 2, 'one product node per active core');
  assert.deepEqual(voice.ringState(0).pairs(), [{ core: 0, partner: 1 }, { core: 1, partner: 2 }]);
  assert.equal(voice.ringBus.gain.value, RING_BUS_LEVEL);

  voice.applyCoreModulation(0, 'osc1.ringMod', 'none');
  assert.equal(voice.ringBus.gain.value, RING_BUS_LEVEL, 'one pair is still live, so the bus stays open');

  voice.applyCoreModulation(1, 'osc2.ringMod', 'none');
  assert.equal(voice.ringBus.gain.value, 0, 'and with the last pair gone the bus is silent again');
  assert.deepEqual(voice.ringState(0).pairs(), []);
});

test('a core cannot ring-modulate itself, and that is not an error', () => {
  const read = defaultRead({ 'osc1.ringMod': 'osc1' });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(voice.ringState(0).active, false);
  assert.equal(voice.ringState(0).partner, -1);
  assert.equal(voice.ringBus.gain.value, 0);
  assert.equal(createdOf('ring-product'), 0, 'a self-pair would be a signal squared, not a ring modulator');
});

test('the ring bus level is a scheduled RAMP, so opening and closing a pair cannot click', () => {
  const { voice } = harness();
  voice.start(A4, { at: 5 });

  const busEvents = voice.ringBus.gain.events;
  busEvents.length = 0;
  voice.applyCoreModulation(0, 'osc1.ringMod', 'osc3', { at: 5 });

  assert.ok(busEvents.some((e) => e.type === 'cancelAndHoldAtTime' && e.time === 5));
  assert.ok(busEvents.some((e) => e.type === 'linearRampToValueAtTime' && e.value === RING_BUS_LEVEL));
  assert.equal(busEvents.filter((e) => e.type === 'setValueAtTime').length, 0, 'no step at gesture time');
});

test('RE-ROUTING 100x MID-NOTE: one carrier, one modulator, a flat tally, and a note that keeps playing', () => {
  const read = defaultRead();
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  const after = nodeStats().live;
  // Index 4 is 'osc2', so the last iteration (99 -> core 0) leaves a live pair,
  // and it lands straight after a 'none' at 98, so it is a disconnect and a
  // fresh connect. A core naming ITSELF resolves to no pair at all.
  const options = ['none', 'osc2', 'osc3', 'osc1', 'osc2'];

  for (let i = 0; i < 100; i += 1) {
    const core = i % 3;
    voice.applyCoreModulation(core, `osc${core + 1}.ringMod`, options[i % options.length]);
    context.advance(0.01);
  }

  const liveProducts = voice.cores.map((c) => c.ring.node).filter(Boolean);
  assert.equal(liveProducts.length, 3, 'a product node per core that has ever been assigned, and no more');
  for (const product of liveProducts) {
    const carriers = voice.cores.filter((core) => core.raw.connections.includes(product));
    const params = voice.cores.filter((core) => core.raw.connections.includes(product.gain));
    assert.ok(carriers.length <= 1, 'never more than one carrier, whatever the hundred re-routes did');
    assert.ok(params.length <= 1, 'never more than one modulator');
    assert.equal(product.connections.filter((c) => c === voice.ringBus).length, 1, 'and one path to the bus');
  }
  const carriersOfCore0 = voice.cores.filter((core) => core.raw.connections.includes(voice.core(0).ring.node));
  assert.equal(carriersOfCore0.length, 1, 'and the core that ended with an assignment has exactly one carrier');
  assert.equal(nodeStats().live, after + 3, 're-routing created three product nodes once and nothing since');
  assert.equal(voice.state, 'sounding', 'the note is still playing');
  assert.equal(voice.livePitch(0), 440);
  assert.equal(voice.liveState().soundingSources, 3);
  assert.equal(voice.ringBus.gain.value, RING_BUS_LEVEL, 'the last assignment was live');
});

test('TEARDOWN SURVIVES RING: one disconnection, whatever the pair was doing', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({ 'osc1.ringMod': 'osc2', 'osc2.ringMod': 'osc3' });
  const voice = createVoice({ context, parent: context.createGain(), read, index: 0 });

  voice.start(A4, { at: 0 });
  for (let i = 0; i < 100; i += 1) {
    voice.applyCoreModulation(i % 3, `osc${(i % 3) + 1}.ringMod`, ['none', 'osc2', 'osc3', 'osc1'][i % 4]);
  }

  const liveSources = voice.cores.map((core) => core.source);
  const children = [
    voice.mix,
    voice.vca,
    voice.ringBus,
    voice.waveSlot,
    ...voice.cores.map((c) => c.gain),
    ...voice.cores.map((c) => c.pitchSource),
    ...voice.cores.map((c) => c.raw),
    ...liveSources,
    ...voice.cores.map((c) => c.ring.node).filter(Boolean),
  ];
  // Re-routing legitimately disconnects a product's own inputs over and over, so
  // what teardown must not do is disconnect anything. Snapshot the counters.
  const before = children.map((node) => node.disconnects);

  voice.kill(10);

  assert.equal(voice.entry.disconnects, 1, 'the entry point is the one node cut');
  assert.equal(voice.entry.disconnectAll, 1);
  children.forEach((node, i) => {
    assert.equal(node.disconnects, before[i], `${node.kind} is not unwired by teardown, whatever the ring was connected to`);
    assert.equal(node.disconnectAll, 0, `${node.kind} is not unwired wholesale either`);
  });
  for (const source of liveSources) assert.ok(source.stoppedAt !== null, 'the sources are stopped');
  assert.equal(voice.state, 'idle');

  context.advance(11); // past the fade the kill scheduled at t=10
  assert.equal(nodeStats().byLabel.oscillator.live, 0);
  assert.equal(liveOf('ring-product'), 3, 'the product gains are voice-persistent, and unreachable');
});

test('a stolen voice keeps exactly one pair, not the union of every note it played', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({ 'osc1.ringMod': 'osc2' });
  const voice = createVoice({ context, parent: context.createGain(), read, index: 0 });
  const counts = [];

  for (let n = 0; n < 30; n += 1) {
    const at = context.currentTime;
    voice.kill(at);
    read.set('osc1.ringMod', ['none', 'osc2', 'osc3', 'none'][n % 4]);
    read.set('osc2.ringMod', ['none', 'osc1', 'none', 'osc3'][n % 4]);
    voice.start({ ...A4, id: `n${n}` }, { at });
    context.advance(0.2);
    const product = voice.core(0).ring.node;
    if (product) {
      counts.push(voice.cores.filter((core) => core.raw.connections.includes(product)).length);
    }
  }

  assert.ok(counts.length > 0);
  assert.ok(counts.every((c) => c <= 1), 'never more than one carrier on a product, across thirty notes');
  voice.kill(context.currentTime);
  context.advance(1);
  assert.equal(nodeStats().byLabel['ring-product'].live, 2, 'two product nodes for the whole life of the voice');
});
