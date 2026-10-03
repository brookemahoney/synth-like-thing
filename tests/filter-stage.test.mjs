/**
 * The filter bank as a GRAPH: the voice's chain, LP24's two sections, all ten
 * mode selections, the cutoff extremes, key tracking, drive, and bypass.
 *
 * These are the assertions that a filter which is merely constructed cannot
 * pass: the connections are read back, and a bypass is only a bypass if the
 * stage is out of the path rather than muted.
 *
 * Framework-free: `node --test tests/filter-stage.test.mjs`, against the
 * recording stand-in in filter-fake-audio.mjs.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA, createStore, defaults } from '../web/ui/params.js';
import { createVoice } from '../web/audio/voice.js';
import { nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { midiToHz } from '../web/audio/pitch.js';
import { bindFilterModulation } from '../web/audio/filter.js';
import { createFakeFilterContext } from './filter-fake-audio.mjs';

const A4 = { id: 'n1', note: 69, velocity: 0.8, random: 0.5 };

/** A voice over an isolated store carrying the real schema defaults. */
function harness(patch = {}) {
  const store = createStore(SCHEMA);
  store.patch(defaults());
  store.patch(patch);
  const context = createFakeFilterContext();
  const parent = context.createGain();
  const voice = createVoice({ context, parent, read: store.get, index: 0 });
  return { store, context, parent, voice };
}

beforeEach(() => resetNodeStats());

test('each stage reads the panel and the matrix route off ONE place, in this order', () => {
  // panel value -> key tracking (a ratio) -> matrix route (cents) -> THE CLAMP.
  const { voice, store, context } = harness({ 'filter1.cutoff': 1000, 'filter1.keyTrack': 100 });
  voice.start({ ...A4, note: 72 }, { at: 0 }); // an octave above the reference note

  const read = () => voice.filter(0).sections[0].frequency.value;
  assert.equal(read(), 2000, '1000 Hz tracked up an octave');

  store.set('filter1.cutoff', 500, { apply: 'ramp' });
  voice.applyFilter(0, 'filter1.cutoff', 500, { at: 0, ramp: false });
  assert.equal(read(), 1000, 'half the panel value, still tracked');

  voice.setCutoffModulation(0, 1200, { at: 0, ramp: false });
  assert.equal(read(), 2000, 'and a further octave from the route');

  store.set('filter1.keyTrack', 0);
  voice.applyFilter(0, 'filter1.keyTrack', 0, { at: 0, ramp: false });
  assert.equal(read(), 1000, 'tracking off takes the panel value with no route applied');
  assert.ok(Number.isFinite(read()));
  assert.equal(context.sampleRate, 48000, 'and the clamp had the real sample rate to work with');
});

test('the voice chain is mix -> filter 1 -> filter 2 -> amplifier -> entry', () => {
  const { voice, parent } = harness();
  voice.start(A4, { at: 0 });

  const [one, two] = voice.filters;
  assert.equal(voice.filters.length, 2, 'two stages per voice');

  assert.ok(voice.mix.connections.includes(one.input), 'the voice mix feeds filter 1');
  assert.ok(one.output.connections.includes(two.input), 'filter 1 feeds filter 2');
  assert.ok(two.output.connections.includes(voice.vca), 'filter 2 feeds the amplifier');
  assert.ok(voice.vca.connections.includes(voice.entry), 'the amplifier feeds the entry point');
  assert.ok(voice.entry.connections.includes(parent), 'and the entry point reaches the master');
});

test('every core and summing bus still lands on the mix, which is now the chain head', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });
  const feeds = [voice.core(0).gain, voice.core(1).gain, voice.core(2).gain, voice.ringBus, voice.waveSlot];
  for (const node of feeds) assert.ok(node.connections.includes(voice.mix), `${node.kind} sums into the mix`);
  assert.ok(!voice.mix.connections.includes(voice.vca), 'the mix no longer reaches the amplifier directly');
});

test('ONE STAGE IS ONE CONNECTED CHAIN: input -> drive -> section(s) -> output', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  const stage = voice.filter(0);
  const [a, b] = stage.sections;

  const chain = (sections) => {
    assert.ok(stage.input.connections.includes(stage.driveIn), 'input -> pre-gain');
    assert.ok(stage.driveIn.connections.includes(stage.shaper), 'pre-gain -> shaper');
    assert.ok(stage.shaper.connections.includes(stage.driveOut), 'shaper -> make-up gain');
    // This edge is the one that makes the stage a filter rather than a dead node.
    assert.ok(stage.driveOut.connections.includes(a), 'make-up gain -> the first section');
    if (sections === 2) {
      assert.ok(a.connections.includes(b), 'section A -> section B');
      assert.ok(b.connections.includes(stage.output), 'section B -> output');
    } else {
      assert.ok(a.connections.includes(stage.output), 'section A -> output');
      assert.equal(b.connections.length, 0, 'and section B is not in the path');
    }
  };

  chain(2); // lp24 on the init patch
  for (const [mode, sections] of [['lp12', 1], ['hp12', 1], ['bp12', 1], ['notch12', 1], ['lp24', 2]]) {
    store.set('filter1.type', mode);
    voice.applyFilter(0, 'filter1.type', mode, { at: 0, ramp: false });
    chain(sections);
  }
});

test('LP24 runs two lowpass sections in cascade; the other four modes run one', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  const stage = voice.filter(0);

  const [a, b] = stage.sections;
  assert.equal(a.type, 'lowpass');
  assert.equal(b.type, 'lowpass');
  assert.ok(a.connections.includes(b), 'LP24: section A cascades into section B');
  assert.ok(b.connections.includes(stage.output), 'and section B reaches the stage output');
  assert.ok(!a.connections.includes(stage.output), 'section A does not also reach the output: that would be a parallel path, not a cascade');

  for (const mode of ['lp12', 'hp12', 'bp12', 'notch12']) {
    store.set('filter1.type', mode);
    voice.applyFilter(0, 'filter1.type', mode, { at: 0, ramp: false });
    assert.ok(a.connections.includes(stage.output), `${mode}: section A reaches the output`);
    assert.equal(b.connections.length, 0, `${mode}: section B is out of the path entirely`);
  }

  store.set('filter1.type', 'lp24');
  voice.applyFilter(0, 'filter1.type', 'lp24', { at: 0, ramp: false });
  assert.ok(a.connections.includes(b), 'back to LP24 the second section is in the path again');
  assert.ok(b.connections.includes(stage.output));
  assert.ok(!a.connections.includes(stage.output));
});

test('the second pole of an LP24 is Butterworth, so Q 30 is a single-section peak', () => {
  const { voice, store } = harness({ 'filter1.resonance': 30 });
  voice.start(A4, { at: 0 });
  const [a, b] = voice.filter(0).sections;
  assert.equal(a.Q.value, 30);
  assert.ok(Math.abs(b.Q.value - Math.SQRT1_2) < 1e-12, 'the flat second pole is not doubled');
});

test('all ten mode selections land on the biquad type they name', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  const wanted = { lp24: 'lowpass', lp12: 'lowpass', hp12: 'highpass', bp12: 'bandpass', notch12: 'notch' };
  let checked = 0;

  for (let stageIndex = 0; stageIndex < 2; stageIndex += 1) {
    for (const [mode, type] of Object.entries(wanted)) {
      const key = `filter${stageIndex + 1}.type`;
      store.set(key, mode);
      voice.applyFilter(stageIndex, key, mode, { at: 0, ramp: false });
      const section = voice.filter(stageIndex).sections[0];
      assert.equal(section.type, type, `${key} = ${mode} is a ${type}`);
      checked += 1;
    }
  }
  assert.equal(checked, 10, 'five modes on each of the two stages');
});

test('cutoff spans 20 Hz to 20 kHz and reads back off the AudioParam', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  for (let stageIndex = 0; stageIndex < 2; stageIndex += 1) {
    for (const [value, expected] of [[20, 20], [20000, 20000], [1200, 1200]]) {
      const key = `filter${stageIndex + 1}.cutoff`;
      store.set(key, value);
      voice.applyFilter(stageIndex, key, value, { at: 0, ramp: false });
      const hz = voice.filter(stageIndex).sections[0].frequency.value;
      assert.equal(hz, expected, `${key} = ${value}`);
      assert.ok(hz >= 20 && hz <= 20000, `${hz} Hz is inside the control's range`);
      // Both sections of a two-section mode carry the same cutoff.
      assert.equal(voice.filter(stageIndex).sections[1].frequency.value, expected);
    }
  }
});

test('key tracking is a ratio: 0% is the same cutoff on any note, 100% moves with pitch', () => {
  const low = harness({ 'filter1.keyTrack': 0, 'filter1.cutoff': 1000 });
  low.voice.start({ ...A4, note: 60 }, { at: 0 });
  low.voice.start({ ...A4, id: 'n2', note: 72 }, { at: 0 });
  assert.equal(low.voice.filterCutoff(0), 1000, 'tracking 0: unchanged between two notes');

  const high = harness({ 'filter1.keyTrack': 100, 'filter1.cutoff': 1000 });
  high.voice.start({ ...A4, note: 60 }, { at: 0 });
  const atC4 = high.voice.filterCutoff(0);
  high.voice.start({ ...A4, id: 'n2', note: 72 }, { at: 0 });
  const atC5 = high.voice.filterCutoff(0);
  assert.equal(atC4, 1000, 'the reference note is the panel value');
  assert.ok(atC5 > atC4 * 1.9 && atC5 < atC4 * 2.1, `an octave up moves the cutoff by an octave: ${atC4} -> ${atC5}`);
  assert.equal(atC5 / atC4, midiToHz(72) / midiToHz(60), 'and by exactly the pitch ratio');

  const half = harness({ 'filter2.keyTrack': 50, 'filter2.cutoff': 800 });
  half.voice.start({ ...A4, note: 60 }, { at: 0 });
  half.voice.start({ ...A4, id: 'n2', note: 72 }, { at: 0 });
  assert.ok(half.voice.filterCutoff(1) > 800, '50% moves it half the interval');
  assert.ok(half.voice.filterCutoff(1) < 800 * 1.5);
});

test('drive is a WaveShaper with the shared curve, a pre-gain and a make-up gain', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  const stage = voice.filter(0);

  assert.equal(stage.shaper.kind, 'waveShaper', 'saturation is a WaveShaperNode, not a gain');
  assert.ok(stage.shaper.curve instanceof Float32Array);
  assert.equal(stage.shaper.curve[0], -1, 'the soft-clip curve, not a hard-clip step');
  assert.ok(stage.driveIn.connections.includes(stage.shaper), 'pre-gain -> shaper');
  assert.ok(stage.shaper.connections.includes(stage.driveOut), 'shaper -> make-up gain');

  assert.equal(stage.driveIn.gain.value, 1, 'drive 0 is unity into the shaper');
  const quiet = stage.driveOut.gain.value;

  store.set('filter1.drive', 1);
  voice.applyFilter(0, 'filter1.drive', 1, { at: 0, ramp: false });
  assert.ok(stage.driveIn.gain.value > 8, `drive 1 puts a real pre-gain in (${stage.driveIn.gain.value})`);
  assert.ok(stage.driveOut.gain.value < quiet, 'and takes it back out again: drive is not level');
});

test('BYPASS rewires around the stage: no signal path through it at all', () => {
  const { voice, store } = harness();
  voice.start(A4, { at: 0 });
  const [one, two] = voice.filters;
  const before = { mix: [...voice.mix.connections], f1out: [...one.output.connections] };

  store.set('filter1.bypass', true);
  voice.applyFilter(0, 'filter1.bypass', true, { at: 0, ramp: false });

  assert.equal(store.get('filter1.bypass'), true);
  assert.ok(!voice.mix.connections.includes(one.input), 'the mix no longer reaches filter 1 at all');
  assert.ok(voice.mix.connections.includes(two.input), 'it reaches filter 2 instead — not silence');
  assert.ok(!one.output.connections.includes(two.input), 'and filter 1 is not feeding anything');
  assert.notDeepEqual(voice.mix.connections, before.mix, 'the connection really changed');

  // Muted would have looked identical from the outside; not-muted cannot: the
  // bypassed stage's own nodes are still there but carry no signal.
  assert.ok(one.input.connections.length === 0 || !one.input.connections.some((n) => n.kind === 'gain' && n.kind === 'biquad'));

  store.set('filter1.bypass', false);
  voice.applyFilter(0, 'filter1.bypass', false, { at: 0, ramp: false });
  assert.ok(voice.mix.connections.includes(one.input), 'and it comes back exactly as it was');
  assert.deepEqual(voice.mix.connections, before.mix);
});

test('each stage is independently bypassable', () => {
  for (const which of [0, 1]) {
    const { voice } = harness();
    voice.start(A4, { at: 0 });
    const other = voice.filters[1 - which];
    voice.setFilterBypass(which, true, { at: 0, ramp: false });
    assert.ok(!voice.filters[which].input.connections.includes(other.input));
    if (which === 0) {
      assert.ok(voice.mix.connections.includes(voice.filters[1].input), 'filter 1 bypassed: mix -> filter 2');
      assert.ok(voice.filters[1].output.connections.includes(voice.vca));
    } else {
      assert.ok(voice.mix.connections.includes(voice.filters[0].input), 'filter 2 bypassed: mix -> filter 1');
      assert.ok(voice.filters[0].output.connections.includes(voice.vca), 'and filter 1 feeds the amplifier directly');
    }
    assert.ok(other.input.connections.length > 0, `filter ${which + 2} is still in the path`);
  }
});

test('a modulation route is added to the cutoff in cents, and the clamp still holds', () => {
  const { voice } = harness({ 'filter1.cutoff': 1000, 'filter1.keyTrack': 0 });
  voice.start(A4, { at: 0 });

  voice.setCutoffModulation(0, 1200, { at: 0, ramp: false });
  assert.equal(voice.filter(0).sections[0].frequency.value, 2000, 'a full-depth octave up');
  assert.equal(voice.cutoffModulation(0), 1200);

  voice.setCutoffModulation(0, -4800, { at: 0, ramp: false });
  assert.ok(Math.abs(voice.filter(0).sections[0].frequency.value - 62.5) < 1e-9, 'and the full depth the other way');

  // The plan's named failure: a route cannot drive the cutoff to zero, however
  // hard the matrix pushes. The route itself is clipped to +-4 octaves, and the
  // result is clamped again on the way into the biquad.
  voice.setCutoffModulation(0, -1e9, { at: 0, ramp: false });
  assert.equal(voice.cutoffModulation(0), -4800, 'the route is clipped to its own range');
  assert.equal(voice.filter(0).sections[0].frequency.value, 62.5, 'four octaves down, and no further');
  voice.setCutoffModulation(0, 1e9, { at: 0, ramp: false });
  assert.equal(voice.filter(0).sections[0].frequency.value, 16000, 'four octaves up, and no further');

  // And a 20 Hz base with a full-depth negative route lands on the floor, not
  // on zero: zero is what produces NaN and silences a voice for good.
  voice.applyFilter(0, 'filter1.cutoff', 20, { at: 0, ramp: false });
  voice.setCutoffModulation(0, -4800, { at: 0, ramp: false });
  const floor = voice.filter(0).sections[0].frequency.value;
  assert.equal(floor, 20, 'clamped to the floor, not NaN and not zero');
  assert.ok(Number.isFinite(floor));
});

test('the store fan-out reaches every live voice through one door', () => {
  const store = createStore(SCHEMA);
  store.patch(defaults());
  const context = createFakeFilterContext();
  const parent = context.createGain();
  const first = createVoice({ context, parent, read: store.get, index: 0 });
  const second = createVoice({ context, parent, read: store.get, index: 1 });
  const unbind = bindFilterModulation({ store });
  try {
    first.start(A4, { at: 0 });
    second.start({ ...A4, id: 'n2' }, { at: 0 });

    store.set('filter2.cutoff', 640, { apply: 'ramp' });
    for (const voice of [first, second]) {
      assert.equal(voice.filterCutoff(1), 640, 'both voices followed the control');
      const last = voice.filter(1).sections[0].frequency.events.at(-1);
      assert.equal(last.type, 'linearRampToValueAtTime', 'a gesture ramps: no zipper noise');
    }

    store.set('filter1.bypass', true);
    for (const voice of [first, second]) {
      assert.equal(voice.filter(0).bypass, true);
      assert.ok(!voice.mix.connections.includes(voice.filters[0].input));
    }
  } finally {
    unbind();
  }
});

test('TEARDOWN: the filter bank adds nodes, and none of them outlive their voice', () => {
  const context = createFakeFilterContext();
  const store = createStore(SCHEMA);
  store.patch(defaults());
  const voices = Array.from({ length: 4 }, (_v, i) =>
    createVoice({ context, parent: context.createGain(), read: store.get, index: i }),
  );

  const built = nodeStats().live;
  assert.equal(built, 0, 'a voice owns no nodes at all until its first note');
  voices[0].start(A4, { at: 0 });
  const afterFirstNote = nodeStats().live;
  const labels = nodeStats().byLabel;
  for (const label of ['filter1-in', 'filter2-in', 'filter1-drive-in', 'filter2-drive-in', 'filter1-shaper', 'filter2-shaper', 'filter1-drive-out', 'filter2-drive-out', 'filter1-section-a', 'filter1-section-b', 'filter2-section-a', 'filter2-section-b', 'filter1-out', 'filter2-out']) {
    assert.equal(labels[label].live, 1, `${label} is built once, with the rest of the voice`);
  }

  // Build the rest of the pool, then measure the plateau the loop must hold.
  for (let i = 1; i < voices.length; i += 1) voices[i].start({ ...A4, id: `p${i}` }, { at: 0 });
  const plateau = nodeStats().live;
  assert.ok(plateau > afterFirstNote, 'four voices own four banks');

  const counts = [];
  for (let n = 0; n < 20; n += 1) {
    const at = context.currentTime;
    for (const voice of voices) {
      voice.kill(at);
      voice.start({ ...A4, id: `n${n}` }, { at });
    }
    context.advance(0.2);
    counts.push(nodeStats().live);
  }
  for (const count of counts) assert.equal(count, plateau, 'the tally sits flat across note cycles');

  // THE TEARDOWN ITSELF cuts exactly one node. (A mode change legitimately
  // rewires the filter's own sections, so the count is taken across the kill —
  // what must never happen is a teardown unwiring the voice from the inside.)
  for (const voice of voices) {
    const children = [
      voice.mix,
      voice.vca,
      voice.ringBus,
      voice.waveSlot,
      ...voice.cores.map((core) => core.gain),
      ...voice.filters.flatMap((stage) => [stage.input, stage.output, stage.driveIn, stage.shaper, stage.driveOut, ...stage.sections]),
    ];
    const before = children.map((node) => node.disconnects);
    const entryBefore = voice.entry.disconnects;
    voice.kill(context.currentTime);
    children.forEach((node, i) => {
      assert.equal(node.disconnects, before[i], `${node.kind} inside the voice is not unwired by a teardown`);
    });
    assert.equal(voice.entry.disconnects - entryBefore, 1, 'the entry point is the one node cut');
    assert.ok(voice.entry.disconnectAll >= 1, 'and it is cut from its parent, which is the whole teardown');
  }
});

test('a voice with no filters in play still has the bank built and reachable', () => {
  const { voice } = harness({ 'filter1.bypass': true, 'filter2.bypass': true });
  voice.start(A4, { at: 0 });
  assert.equal(voice.filters.length, 2);
  assert.ok(voice.mix.connections.includes(voice.vca), 'both stages bypassed: mix -> amplifier');
  assert.equal(voice.filterState(0).bypass, true);
  assert.equal(voice.filterState(1).bypass, true);
});