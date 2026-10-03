/**
 * Unison at the voice level: how many copies, what detune, when they exist, and
 * the node arithmetic that decides whether 16 voices x 3 cores x 7 is a load the
 * browser can carry.
 *
 * Three things here are decisions rather than plumbing, and each is asserted:
 *   - the DISTRIBUTION (symmetric across exactly ±spread, centre voice on the
 *     centre pitch) and the fact that the spread control cannot move a single
 *     voice's pitch;
 *   - the LAZY CREATION rule: a silent core builds no copies, and they appear on
 *     the first non-zero level;
 *   - LEVEL INDEPENDENCE: seven voices must be as loud as one, which is why the
 *     copies share one 1/N summing gain and why the core's own oscillator moves
 *     onto that sum as soon as the count goes above one.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createVoice } from '../web/audio/voice.js';
import { UNISON_MAX, clampUnisonCount, unisonDetuneCents, unisonSumGain } from '../web/audio/osc-mod.js';
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

test('unison 1 is one oscillator per core, unchanged from task 3', () => {
  const { context, voice } = harness();
  voice.start(A4, { at: 0 });

  assert.equal(createdOf('unison-copy'), 0, 'no copies exist at all');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(voice.unisonState(i).count, 1);
    assert.equal(voice.unisonState(i).copies, 0);
    assert.deepEqual(voice.unisonState(i).detuneCents, [0]);
    assert.equal(voice.core(i).source.connections.includes(voice.core(i).gain), true, 'the core plays straight into its level');
  }
});

test('unison 7 makes six copies, spread symmetrically, and they sum to ONE voice of level', () => {
  const read = defaultRead({ 'osc1.unison': 7, 'osc1.unisonSpread': 50 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  const state = voice.unisonState(0);
  assert.equal(state.count, 7);
  assert.equal(state.copies, 6);
  assert.equal(createdOf('unison-copy'), 6, 'only the core that asked for unison pays for copies');

  const expected = unisonDetuneCents(7, 50);
  assert.deepEqual(state.detuneCents.map((c) => Math.round(c * 100) / 100), expected.map((c) => Math.round(c * 100) / 100));
  assert.equal(expected[0], -50);
  assert.equal(expected[3], 0, 'the centre voice is exactly on the pitch');
  assert.equal(expected[6], 50);

  // Every copy plays the SAME pitch signal, displaced by its own detune — that is
  // the whole trick, and it is why there is no second pitch source.
  for (const copy of voice.core(0).copies) {
    assert.ok(voice.core(0).pitchSource.connections.includes(copy.source.frequency));
    assert.equal(copy.source.frequency.value, 0, 'the copy is silent on its own too');
  }

  const sum = voice.core(0).unisonSum;
  assert.equal(sum.gain.value, 1 / 7, 'the copies are normalised so unison is not a volume control');
  assert.equal(voice.core(0).source.connections.includes(sum), true, 'the core voice moved onto the same sum');
  assert.equal(voice.core(0).source.connections.includes(voice.core(0).gain), false, 'and no longer bypasses it');
  assert.equal(sum.connections.includes(voice.core(0).gain), true, 'the sum is what reaches the level');
  assert.equal(unisonSumGain(7).toFixed(9), sum.gain.value.toFixed(9));

  assert.equal(voice.unisonState(1).count, 1, 'the other cores are untouched');
  assert.equal(voice.core(1).unisonSum, null, 'and a core that never asked for unison owns no sum node');
});

test('dropping back to one voice moves the core oscillator off the sum again', () => {
  const read = defaultRead({ 'osc1.unison': 7 });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });
  const sum = voice.core(0).unisonSum;

  voice.applyCoreModulation(0, 'osc1.unison', 1);

  assert.equal(voice.unisonState(0).count, 1);
  assert.equal(voice.core(0).source.connections.includes(sum), false, 'the core is back on its own level');
  assert.equal(voice.core(0).source.connections.includes(voice.core(0).gain), true);
  assert.equal(voice.unisonState(0).connectedCopies, 0, 'the copies are disconnected, not stopped mid-note');
  assert.equal(sum.gain.value, 1, 'the sum returns to unity so the move is level-neutral');
  assert.equal(voice.core(0).copies.length, 6, 'the copy nodes are kept for the note, so a climb costs no nodes');
});

test('the spread control moves the copies and ONLY the copies', () => {
  const read = defaultRead({ 'osc1.unison': 3, 'osc1.unisonSpread': 0 });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.deepEqual(voice.unisonState(0).detuneCents, [-0, 0, 0].map((c) => c + 0));

  read.set('osc1.unisonSpread', 24);
  voice.applyCoreModulation(0, 'osc1.unisonSpread', 24);

  assert.deepEqual(voice.unisonState(0).detuneCents, [-24, 0, 24]);
  assert.equal(voice.core(0).copies[0].source.detune.value, -24);
  assert.equal(voice.core(0).copies[1].source.detune.value, 24);
  assert.equal(voice.core(0).source.detune.value, 0, 'the centre voice stays on the centre pitch');
  assert.equal(voice.livePitch(0), 440, 'and the core frequency is not detuned by a spread');
});

test('a copy feeds the RAW tap only while it is part of the group', () => {
  const read = defaultRead({ 'osc1.unison': 7, 'osc1.unisonSpread': 50 });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });
  const raw = voice.core(0).raw;

  const inRaw = () => voice.core(0).copies.filter((c) => c.source.connections.includes(raw)).length;

  assert.equal(inRaw(), 6, 'at count 7 every copy is part of the core, raw tap included');

  voice.applyCoreModulation(0, 'osc1.unison', 1);

  assert.equal(voice.unisonState(0).count, 1);
  assert.equal(inRaw(), 0, 'at count 1 a copy that is not playing must not drive the raw tap either');
  assert.equal(voice.core(0).source.connections.includes(raw), true, 'the core voice itself is always in the raw tap');

  voice.applyCoreModulation(0, 'osc1.unison', 7);
  assert.equal(inRaw(), 6, 'and climbing back re-connects them');
});

test('spread changes are RAMPED, and the copies cannot be pushed past the control range', () => {
  const { voice } = harness(defaultRead({ 'osc1.unison': 3 }));
  voice.start(A4, { at: 4 });

  const detune = voice.core(0).copies[0].source.detune;
  detune.events.length = 0;
  voice.applyCoreModulation(0, 'osc1.unisonSpread', 10, { at: 4 });

  assert.ok(detune.events.some((e) => e.type === 'linearRampToValueAtTime' && e.value === -10));
  assert.equal(detune.events.filter((e) => e.type === 'setValueAtTime').length, 0, 'a drag must not step');

  voice.applyCoreModulation(0, 'osc1.unisonSpread', 500);
  assert.equal(voice.unisonState(0).spreadCents, 50, 'clamped to the manual control range');
  voice.applyCoreModulation(0, 'osc1.unisonSpread', -20);
  assert.equal(voice.unisonState(0).spreadCents, 0);
});

test('LAZY: a core at level 0 builds no copies, and the first non-zero level builds them', () => {
  const read = defaultRead({ 'osc1.unison': 7, 'osc1.unisonSpread': 50, 'osc1.level': 0, 'osc2.unison': 7, 'osc2.level': 0 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(createdOf('unison-copy'), 0, 'sixteen silent cores would be 288 wasted oscillators');
  assert.equal(voice.unisonState(0).count, 7, 'the requested count is still the live value');
  assert.equal(voice.unisonState(0).copies, 0, 'and no copies exist for it yet');

  read.set('osc1.level', 0.5);
  voice.setCoreLevel(0, 0.5, { at: 0 });

  assert.equal(createdOf('unison-copy'), 6, 'the first non-zero level is where they appear');
  assert.equal(voice.unisonState(0).copies, 6);
  assert.equal(voice.core(0).source.connections.includes(voice.core(0).unisonSum), true);

  voice.setCoreLevel(0, 0, { at: 0 });
  assert.equal(voice.unisonState(0).copies, 6, 'silencing a core does not tear its copies down mid-note');
  assert.equal(voice.core(0).gain.gain.value, 0, 'the level is what silences it');
});

test('a noise core gets no unison copies: a buffer source cannot be retuned as a waveform', () => {
  const read = defaultRead({ 'osc1.waveform': 'noise', 'osc1.unison': 7, 'osc1.unisonSpread': 50 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(createdOf('unison-copy'), 0);
  assert.equal(voice.unisonState(0).copies, 0);
  assert.equal(voice.unisonState(0).count, 1, 'the count reads as one, so the readout never lies');
  assert.equal(voice.core(0).source.kind, 'bufferSource');
  assert.equal(voice.core(0).source.connections.includes(voice.core(0).gain), true);
});

test('a unison change on a RELEASED voice builds no copies: a per-note node needs a note', () => {
  const read = defaultRead({ 'osc1.unison': 1, 'osc2.unison': 1, 'osc3.unison': 1 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });
  voice.release(1);
  context.advance(2); // every source of that note has ended
  assert.equal(voice.core(0).copies.length, 0, 'the note took no copies with it');
  assert.equal(liveOf('unison-copy'), 0);

  // A control moved after the note has gone must not conjure per-note nodes: they
  // would have nothing to stop them, and that is a voice that never stops sounding.
  for (let i = 0; i < 20; i += 1) {
    voice.applyCoreModulation(0, 'osc1.unison', 7);
    voice.applyCoreModulation(1, 'osc2.unison', 7);
    voice.setCoreLevel(0, 0.5, { ramp: false });
  }

  assert.equal(voice.core(0).copies.length, 0, 'no copies on a voice that is not sounding');
  assert.equal(voice.core(1).copies.length, 0);
  assert.equal(createdOf('unison-copy'), 0, 'and none were ever created');
  assert.equal(voice.liveState().soundingSources, 0);
  assert.equal(voice.state, 'released');

  // The next note still picks the control up: the store is read again at note-on,
  // and a direct applyCoreModulation override lasts only for the note it was made in.
  voice.start({ ...A4, id: 'n2' }, { at: 5 });
  assert.equal(voice.core(0).copies.length, 0, 'the store still says 1, so this note is a single voice');
  assert.equal(voice.unisonState(0).count, 1);

  read.set('osc1.unison', 7);
  read.set('osc2.unison', 7);
  voice.kill(6);
  voice.start({ ...A4, id: 'n3' }, { at: 7 });
  assert.equal(voice.core(0).copies.length, 6, 'and a store change is picked up by the following note');
  assert.equal(voice.unisonState(0).count, 7);
});

test('unison copies are stopped at note-off and retired, so they cannot outlive the note', () => {
  const read = defaultRead({ 'osc1.unison': 7, 'osc1.unisonSpread': 30, 'osc2.unison': 5 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });
  assert.equal(nodeStats().byLabel['unison-copy'].live, 10);

  assert.equal(voice.liveState().soundingSources, 13, 'three core voices plus ten copies, all running');

  const copies = voice.core(0).copies.map((c) => c.source);
  voice.release(1);

  assert.equal(voice.state, 'released');
  for (const copy of copies) assert.ok(copy.stoppedAt > 1, 'a copy is stopped after the fade, like the core voice');
  assert.equal(voice.liveState().soundingSources, 0, 'and nothing is left running once the note is released');

  context.advance(1.1); // past the release fade at t=1.03
  assert.equal(liveOf('unison-copy'), 0, 'and every one retired');
  assert.equal(liveOf('oscillator'), 0);
});

test('a stolen voice retires its copies before the next note builds its own', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({ 'osc1.unison': 7, 'osc2.unison': 7, 'osc3.unison': 7 });
  const voice = createVoice({ context, parent: context.createGain(), read, index: 0 });
  const live = [];

  for (let n = 0; n < 20; n += 1) {
    const at = context.currentTime;
    voice.kill(at);
    voice.start({ ...A4, id: `n${n}` }, { at });
    context.advance(0.2);
    live.push(nodeStats().byLabel['unison-copy'].live);
  }

  assert.equal(Math.max(...live), 18, 'one note of eighteen copies: 3 cores x 6');
  assert.ok(
    live.slice(2).every((n) => n === 18),
    'and the tally sits at that plateau, so a re-note never accumulates copies',
  );
  voice.kill(context.currentTime);
  context.advance(1);
  assert.equal(nodeStats().byLabel['unison-copy'].live, 0);
});

test('RE-ROUTING 100x MID-NOTE: the tally never moves and exactly count-1 copies are connected', () => {
  const read = defaultRead({ 'osc1.unison': 1 });
  const { context, voice } = harness(read);
  voice.start(A4, { at: 0 });

  const after = nodeStats().live;
  let maxCreated = 0;

  for (let i = 0; i < 100; i += 1) {
    const count = 1 + (i % UNISON_MAX);
    voice.applyCoreModulation(0, 'osc1.unison', count);
    voice.applyCoreModulation(0, 'osc1.unisonSpread', (i % 51));
    context.advance(0.01);
    maxCreated = Math.max(maxCreated, nodeStats().byLabel['unison-copy']?.created ?? 0);
  }

  const state = voice.unisonState(0);
  assert.equal(state.count, 1 + (99 % UNISON_MAX));
  assert.equal(state.connectedCopies, state.count - 1, 'exactly the copies the count calls for are connected');
  assert.equal(maxCreated, UNISON_MAX - 1, 'the whole climb cost six copy nodes, once');
  assert.equal(nodeStats().live, after + 6 + 1, 'and the tally is the same on every later iteration');
  assert.equal(voice.livePitch(0), 440, 'the note is still playing and still in tune');
  assert.equal(voice.state, 'sounding');
});

test('THE LOAD: 16 voices x 3 cores x 7 is 288 copies, and only for the cores that are audible', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({
    'osc1.unison': 7,
    'osc2.unison': 7,
    'osc3.unison': 7,
    'osc3.level': 0,
    'osc2.unisonSpread': 20,
  });
  const voices = Array.from({ length: 16 }, (_u, i) => createVoice({ context, parent: context.createGain(), read, index: i }));

  for (const voice of voices) voice.start(A4, { at: 0 });

  assert.equal(createdOf('unison-copy'), 16 * 2 * 6, 'the silent third core costs nothing');
  assert.equal(liveOf('unison-copy'), 192);
  assert.equal(liveOf('core-unison-sum'), 32, 'one summing gain per active core, not one per copy');
  assert.equal(liveOf('oscillator'), 16 * 3, 'the cores themselves, one per voice');
  assert.equal(liveOf('unison-copy') + liveOf('oscillator'), 240, '240 oscillators for the loudest 16-voice unison patch');

  for (const voice of voices) voice.release(0.5);
  context.advance(1.1); // past the release fade
  assert.equal(liveOf('unison-copy'), 0);
  assert.equal(liveOf('oscillator'), 0);
});

test('MATRIX SEAM: unison spread is a read value with a clamped 0..50 write range', () => {
  const { voice } = harness(defaultRead({ 'osc1.unison': 3, 'osc1.unisonSpread': 8 }));
  voice.start(A4, { at: 0 });

  const point = voice.modulationPoints().find((p) => p.destination === 'unisonSpread');
  assert.ok(point, 'the matrix can find the spread destination');
  assert.deepEqual(point.range, [0, 50], 'cents, the same range as the manual control');
  assert.equal(point.unit, 'cents');
  assert.equal(point.read(0), 8);

  point.apply(0, 20, { at: 0 });
  assert.equal(point.route(0), 20, 'the route is the matrix contribution, readable on its own');
  assert.equal(point.read(0), 28, 'a route is ADDED to the manual spread, not substituted for it');
  assert.equal(voice.unisonState(0).spreadCents, 28, '8 + 20');
  assert.deepEqual(voice.unisonState(0).detuneCents.map((c) => Math.round(c)), [-28, 0, 28]);

  point.apply(0, 999, { at: 0 });
  assert.equal(point.read(0), 50, 'the clamped contribution cannot take the total past the control range');
  assert.equal(voice.unisonState(0).spreadCents, 50);

  voice.setUnisonSpreadModulation(0, 10, { at: 0 });
  assert.equal(voice.unisonState(0).modulation, 10);
  assert.equal(voice.unisonState(0).manual, 8);
});

test('the live state carries the unison state, and the store write path reaches it', () => {
  const { voice } = harness(defaultRead({ 'osc1.unison': 4, 'osc1.unisonSpread': 12 }));
  voice.start(A4, { at: 0 });

  assert.equal(voice.liveState().unison[0].count, 4);
  assert.equal(voice.liveState().unison[0].copies, 3);
  assert.equal(voice.liveState().unison[2].count, 1);

  voice.applyCoreModulation(0, 'osc1.unison', clampUnisonCount(9));
  assert.equal(voice.unisonState(0).count, 7, 'an out-of-range count clamps rather than breaking');
});
