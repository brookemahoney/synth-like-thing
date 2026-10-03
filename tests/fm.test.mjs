/**
 * FM at the voice level: the routing, the depth, the re-routing discipline and
 * the teardown that has to survive all of it.
 *
 * The plan's named risk for this task is a voice left routed to a node it should
 * no longer reach, so the last test here is the one that matters most: re-route
 * the FM source a hundred times mid-note, then tear the voice down, and assert
 * that exactly one node was ever cut and that the tally came back down.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createVoice } from '../web/audio/voice.js';
import { FM_MAX_INDEX, registerVoice } from '../web/audio/osc-mod.js';
import { nodeLabel, nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { VOICE_STATE } from '../web/audio/allocator.js';
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

beforeEach(() => resetNodeStats());

test('FM amount 0 is no depth at all: nothing connected, nothing to hear', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  const state = voice.fmState(0);
  assert.equal(state.deviationHz, 0);
  assert.equal(state.index, 0);
  assert.equal(state.connected, false);
  assert.equal(state.sourceIndex, -1);
});

test('FM at full amount with source osc2 makes the CARRIER excursion a function of osc2', () => {
  const read = defaultRead({ 'osc1.fmAmount': 1, 'osc1.fmSource': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  const before = voice.livePitchSpan(0);
  assert.equal(voice.livePitch(0), 440, 'the carrier still sits on the note');
  assert.equal(before.hz, 440);
  assert.equal(before.sourceIndex, 1);
  assert.equal(before.modulatorHz, 440);
  assert.equal(before.deviationHz, FM_MAX_INDEX * 440);
  assert.equal(before.minHz, 440 - before.deviationHz, 'the excursion is symmetric about the carrier pitch');
  assert.equal(before.maxHz, 440 + before.deviationHz);
  assert.equal(voice.fmState(0).connected, true);

  // Move the MODULATOR. The carrier's own base pitch cannot move — FM is an
  // audio-rate excursion, not a note change — but its excursion must widen, and
  // that is what "changing osc 2's frequency changes osc 1's pitch" means here.
  read.set('osc2.semitone', 7);
  voice.applyCore(1, { at: 0 });

  const after = voice.livePitchSpan(0);
  assert.equal(after.hz, 440, 'the carrier base is untouched by the modulator moving');
  assert.equal(after.modulatorHz, 659.2551138257398, 'the modulator is now a fifth up (7 semitones)');
  assert.ok(after.deviationHz > before.deviationHz, 'so the carrier swings further');
  assert.equal(after.deviationHz, FM_MAX_INDEX * 659.2551138257398);
  assert.notEqual(after.maxHz, before.maxHz);
  assert.notEqual(after.minHz, before.minHz);
  assert.equal(voice.livePitch(0), 440, 'the pure computation is still the only source of base pitch');
});

test('the FM modulator is tapped BEFORE its own level fader, so a level drag is not a depth drag', () => {
  const read = defaultRead({ 'osc1.fmAmount': 1, 'osc1.fmSource': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  const depthBefore = voice.fmState(0).deviationHz;
  read.set('osc2.level', 0);
  voice.setCoreLevel(1, 0, { at: 0 });

  assert.equal(voice.fmState(0).deviationHz, depthBefore, 'the depth is a function of the modulator PITCH only');
  assert.equal(voice.core(1).gain.gain.value, 0, 'the level fader still governs the dry path');
  assert.equal(nodeLabel(voice.fmState(0).modulatorNode), 'core-raw', 'and the tap is the raw, pre-level bus');
});

test('the modulator feeds the depth gain; the depth gain does not feed the modulator', () => {
  const { voice } = harness(defaultRead({ 'osc1.fmAmount': 1, 'osc1.fmSource': 'osc2' }));
  voice.start(A4, { at: 0 });
  const depth = voice.fmDepth(0);
  const modulator = voice.core(1).raw;

  assert.equal(modulator.connections.includes(depth), true, 'the modulator is an input of the depth gain');
  assert.equal(depth.connections.includes(modulator), false, 'the other way round would be silent, and the bug is invisible in a node list');
  assert.ok(depth.connections.includes(voice.core(0).pitchSource.offset), 'the depth, in hertz, sums into the carrier pitch');
});

test('a core may modulate itself, which is legal feedback FM', () => {
  const { voice } = harness(defaultRead({ 'osc1.fmAmount': 0.5, 'osc1.fmSource': 'osc1' }));
  voice.start(A4, { at: 0 });

  const state = voice.fmState(0);
  assert.equal(state.sourceIndex, 0);
  assert.equal(state.deviationHz, 0.5 * FM_MAX_INDEX * 440);
  assert.equal(voice.fmState(1).connected, false, 'the other cores are untouched');
});

test('FM amount reaches the depth param by a scheduled RAMP, never by writing the value', () => {
  const { voice } = harness();
  voice.start(A4, { at: 7 });

  voice.setFmAmount(0, 0, { at: 7 });
  voice.setFmSource(0, 'osc2', { at: 7 });
  const events = voice.fmDepth(0).gain.events;
  events.length = 0;

  voice.setFmAmount(0, 1, { at: 7 });

  assert.ok(events.length > 0, 'something was scheduled');
  assert.ok(events.some((e) => e.type === 'cancelAndHoldAtTime' && e.time === 7), 'against the audio clock');
  assert.ok(events.some((e) => e.type === 'linearRampToValueAtTime' && e.value === FM_MAX_INDEX * 440), 'ramped to the depth');
  assert.equal(events.filter((e) => e.type === 'setValueAtTime').length, 0, 'no instant step while the control moves');
});

test('the store write path reaches the voice: applyCoreModulation is the one door', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  assert.equal(voice.applyCoreModulation(0, 'osc1.fmSource', 'osc3'), true);
  assert.equal(voice.fmState(0).sourceIndex, 2);
  assert.equal(voice.applyCoreModulation(0, 'osc1.fmAmount', 0.25), true);
  assert.equal(voice.fmState(0).index, 0.25 * FM_MAX_INDEX);
  assert.equal(voice.applyCoreModulation(0, 'osc1.waveform', 'square'), false, 'a key this task does not own is refused');
});

test('MATRIX SEAM: fm amount is a read value with a clamped 0..1 write range', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  const point = voice.modulationPoints().find((p) => p.destination === 'fmAmount');
  assert.ok(point, 'the matrix can find the fm amount destination');
  assert.deepEqual(point.range, [0, 1], 'the same range as the manual control');
  assert.equal(point.read(0), 0);

  point.apply(0, 0.5, { at: 0 });
  assert.equal(point.read(0), 0.5, 'a route writes the amount');
  assert.equal(voice.fmState(0).amount, 0.5);

  point.apply(0, -4, { at: 0 });
  assert.equal(point.read(0), 0, 'and a route cannot push the amount out of the control range');
  point.apply(0, 9, { at: 0 });
  assert.equal(point.read(0), 1);
});

test('a matrix route is a CONTRIBUTION, and the total stays inside the control range', () => {
  const { voice } = harness(defaultRead({ 'osc1.fmAmount': 0.8, 'osc1.fmSource': 'osc2' }));
  voice.start(A4, { at: 0 });

  assert.ok(Math.abs(voice.setFmModulation(0, 0.3, { at: 0 }) - 0.2) < 1e-9, 'the contribution is clipped so the total lands on 1, not on 1.1');
  assert.equal(voice.fmState(0).amount, 1);
  assert.equal(voice.setFmModulation(0, -0.2, { at: 0 }), -0.2, 'a negative route subtracts, and is not clipped');
  assert.ok(Math.abs(voice.fmState(0).amount - 0.6) < 1e-9);
  assert.equal(voice.fmState(0).modulation, -0.2, 'the route is readable on its own, for the matrix UI');
  assert.equal(voice.fmState(0).manual, 0.8, 'and so is the manual value it is added to');
});

test('RE-ROUTING 100x MID-NOTE: one modulator connected, and the tally never moves', () => {
  const { context, voice } = harness();
  voice.start(A4, { at: 0 });

  const tallyBeforeRouting = nodeStats().live;
  // The last iteration (99) lands on 'osc3' straight after 'none' at 98, so the
  // final step is a disconnect followed by a fresh connect.
  const sources = ['osc1', 'osc2', 'none', 'osc3', 'osc2', 'osc1', 'none', 'osc2'];
  let tallyAfterFirst = null;

  for (let i = 0; i < 100; i += 1) {
    const name = sources[i % sources.length];
    const amount = (i % 4) / 3;
    voice.applyCoreModulation(0, 'osc1.fmSource', name);
    voice.applyCoreModulation(0, 'osc1.fmAmount', amount);
    context.advance(0.01);
    if (i === 0) tallyAfterFirst = nodeStats().live;
  }

  const state = voice.fmState(0);
  // The edge lives on the modulator, and points AT the depth gain.
  const depth = voice.fmDepth(0);
  const live = voice.cores.filter((c) => c.raw.connections.includes(depth));
  assert.equal(live.length, 1, 'exactly one modulator is connected after a hundred re-routes');
  assert.equal(live[0], voice.core(2), 'and it is the core the last write named');
  assert.ok(depth.connections.includes(voice.core(0).pitchSource.offset), 'the depth still sums into the carrier pitch');
  assert.equal(state.amount, (99 % 4) / 3, 'the last write is the live value');
  assert.equal(state.sourceIndex, 2, 'the last source is the live route');
  assert.equal(tallyBeforeRouting + 1, tallyAfterFirst, 'the first assignment built the one depth gain');
  assert.equal(nodeStats().live, tallyAfterFirst, 'and ninety-nine more re-routes created nothing at all');
  assert.equal(voice.state, VOICE_STATE.SOUNDING, 'the note is still playing');
  assert.equal(voice.livePitch(0), 440);
});

test('TEARDOWN SURVIVES FM: one disconnection, and the tally returns to the plateau', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({ 'osc1.fmAmount': 1, 'osc1.fmSource': 'osc2', 'osc3.fmSource': 'osc1' });
  const voice = createVoice({ context, parent: context.createGain(), read, index: 0 });
  const off = registerVoice(voice);

  voice.start(A4, { at: 0 });
  for (let i = 0; i < 100; i += 1) {
    voice.applyCoreModulation(0, 'osc1.fmSource', i % 2 ? 'osc3' : 'osc2');
    voice.applyCoreModulation(0, 'osc1.fmAmount', (i % 5) / 4);
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
  ];
  // Re-routing legitimately disconnects a router's OWN input over and over, so
  // what teardown must not do is disconnect anything. Snapshot the counters.
  const before = [...children, voice.core(0).fm.node, voice.core(2).fm.node].map((node) => node.disconnects);

  voice.kill(10);

  assert.equal(voice.entry.disconnects, 1, 'the entry point is the only node cut');
  assert.equal(voice.entry.disconnectAll, 1);
  [...children, voice.core(0).fm.node, voice.core(2).fm.node].forEach((node, i) => {
    assert.equal(node.disconnects, before[i], `${node.kind} is not unwired by teardown, whatever FM connected`);
  });
  for (const node of children) {
    assert.equal(node.disconnectAll, 0, `${node.kind} is not unwired wholesale either`);
  }
  for (const source of liveSources) assert.ok(source.stoppedAt !== null, 'sources are stopped');
  assert.equal(voice.state, VOICE_STATE.IDLE);

  context.advance(11); // past the fade the kill scheduled at t=10
  assert.equal(nodeStats().byLabel.oscillator.live, 0, 'every per-note oscillator retired');
  assert.equal(nodeStats().byLabel['fm-depth'].live, 2, 'the depth gains are voice-persistent, not per-note');
  off();
});

test('a voice re-used after an FM note re-routes from the store, not from the last note', () => {
  const read = defaultRead({ 'osc1.fmAmount': 1, 'osc1.fmSource': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });
  assert.equal(voice.fmState(0).deviationHz, FM_MAX_INDEX * 440);

  voice.kill(1);
  read.set('osc1.fmSource', 'osc3');
  read.set('osc1.fmAmount', 0.5);
  voice.start({ ...A4, id: 'n2' }, { at: 2 });

  const state = voice.fmState(0);
  assert.equal(state.sourceIndex, 2, 'the new note takes the new route');
  assert.equal(state.amount, 0.5);
  const depth = voice.fmDepth(0);
  assert.equal(voice.cores.filter((c) => c.raw.connections.includes(depth)).length, 1, 'one modulator, pointing at the depth gain');
  assert.equal(depth.connections.includes(voice.core(0).pitchSource.offset), true);
});

test('the live state carries the FM state, for the sequencer and the runtime handle', () => {
  const { voice } = harness(defaultRead({ 'osc1.fmAmount': 0.25, 'osc1.fmSource': 'osc2' }));
  voice.start(A4, { at: 0 });

  const state = voice.liveState();
  assert.equal(state.fm.length, 3);
  assert.equal(state.fm[0].sourceIndex, 1);
  assert.equal(state.fm[0].deviationHz, 0.25 * FM_MAX_INDEX * 440);
  assert.equal(state.fm[1].deviationHz, 0);
  assert.deepEqual(state.pitchSpans[0].sourceIndex, 1);
});
