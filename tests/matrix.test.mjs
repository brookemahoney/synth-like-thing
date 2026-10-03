/**
 * tests/matrix.test.mjs — the 8x8 matrix, tested on its arithmetic, on its single
 * write site and on the panel it paints.
 *
 * The claims worth testing by value rather than by assertion of intent:
 *
 *   - the route inventory is EXACTLY 8 x 8 = 64, in the legend order, and every
 *     key is one the store already declares;
 *   - the per-block sum is one bipolar number per destination, and it is the
 *     sum of the ACTIVE routes only;
 *   - a source is normalised about its own neutral point, so an envelope at
 *     silence contributes nothing and a key track at unity contributes nothing;
 *   - the master vector is the MEAN of the sounding voices' sources, so one
 *     voice equals itself and a sixteenth voice moves it by a sixteenth;
 *   - every clamp is in the destination's own units, and the cutoff clamp IS
 *     task 6's function rather than a second copy of it;
 *   - there is exactly ONE call site that writes a destination, proved against
 *     this module's own source rather than against a promise.
 *
 * `node --test tests/matrix.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACTIVE_DEPTH,
  APPLICATION_POINTS,
  MATRIX_CELL_COUNT,
  MASTER_DESTINATIONS,
  MATRIX_DESTINATIONS,
  MATRIX_SOURCES,
  PITCH_ROUTE_CENTS,
  SOURCE_NEUTRALS,
  VOICE_DESTINATIONS,
  buildMatrixPanel,
  clampRoute,
  createModulation,
  createVector,
  depthIsActive,
  mountWhenReady,
  isActiveDepth,
  matrixRoutes,
  normaliseSource,
  pendingNoteAutomation,
  reconcileSources,
  routeKey,
  signedDepth,
  toggleDepth,
} from '../web/audio/matrix.js';
import { CUTOFF_MOD_CENTS, clampCutoff, clampCutoffModulation } from '../web/audio/filter.js';
import { createVoice } from '../web/audio/voice.js';
import { MATRIX_DESTINATIONS as SCHEMA_DESTINATIONS, MATRIX_SOURCES as SCHEMA_SOURCES, SCHEMA, createStore, defaults } from '../web/ui/params.js';
import { dragBy } from '../web/ui/controls.js';
import { createFakeRead, createFakeDocument, createModFakeContext, parseHeadGrid } from './mod-fake-audio.mjs';

const SOURCE = readFileSync(new URL('../web/audio/matrix.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------- the inventory --- */

test('the matrix is exactly eight sources by eight destinations', () => {
  assert.equal(MATRIX_SOURCES.length, 8);
  assert.equal(MATRIX_DESTINATIONS.length, 8);
  assert.equal(MATRIX_CELL_COUNT, 64);
  assert.equal(matrixRoutes().length, 64);
  assert.equal(new Set(matrixRoutes().map((route) => route.key)).size, 64, 'sixty-four distinct keys');
});

test('the row and column order is the legend order, exactly', () => {
  assert.deepEqual([...MATRIX_SOURCES], [...SCHEMA_SOURCES]);
  assert.deepEqual([...MATRIX_DESTINATIONS], [...SCHEMA_DESTINATIONS]);
  assert.deepEqual([...MATRIX_SOURCES], ['lfo1', 'lfo2', 'lfo3', 'ampEnv', 'filterEnv', 'velocity', 'keyTrack', 'random']);
  assert.deepEqual([...MATRIX_DESTINATIONS], ['pitch', 'fmAmount', 'unisonSpread', 'cutoff1', 'cutoff2', 'ampLevel', 'delayTime', 'reverbSend']);
  /* Row-major: source by source, all eight destinations in legend order. */
  const routes = matrixRoutes();
  assert.deepEqual(routes[0], { key: 'matrix.lfo1.pitch', source: 'lfo1', destination: 'pitch', index: 0 });
  assert.deepEqual(routes[7], { key: 'matrix.lfo1.reverbSend', source: 'lfo1', destination: 'reverbSend', index: 7 });
  assert.deepEqual(routes[8], { key: 'matrix.lfo2.pitch', source: 'lfo2', destination: 'pitch', index: 8 });
  assert.equal(routes[63].key, 'matrix.random.reverbSend');
});

test('every route key is a declared store key, clamped to a bipolar depth', () => {
  for (const route of matrixRoutes()) {
    assert.ok(SCHEMA[route.key], `${route.key} is not in the schema`);
    assert.deepEqual([SCHEMA[route.key].min, SCHEMA[route.key].max], [-100, 100], `${route.key} is bipolar`);
  }
  assert.equal(routeKey('lfo3', 'cutoff2'), 'matrix.lfo3.cutoff2');
});

test('six destinations are per-voice and two are master-stage', () => {
  assert.deepEqual([...VOICE_DESTINATIONS], ['pitch', 'fmAmount', 'unisonSpread', 'cutoff1', 'cutoff2', 'ampLevel']);
  assert.deepEqual([...MASTER_DESTINATIONS], ['delayTime', 'reverbSend']);
  assert.equal(APPLICATION_POINTS.length, 8);
  assert.deepEqual(new Set(APPLICATION_POINTS.map((row) => row.destination)), new Set(MATRIX_DESTINATIONS));
});

/* ---------------------------------------------------------------- the cells --- */

test('a cell is inactive at zero and a click activates it at full depth', () => {
  assert.equal(ACTIVE_DEPTH, 100);
  assert.equal(isActiveDepth(0), false);
  /* No dead band: any non-zero depth is a route, so the number painted on the cell
     and what the matrix does can never disagree by a hair. */
  assert.equal(isActiveDepth(0.4), true);
  assert.equal(isActiveDepth(0.5), true);
  assert.equal(isActiveDepth(-0.5), true);
  assert.equal(depthIsActive(0), false);
  assert.equal(depthIsActive(-100), true);
  /* A tap on a dead cell turns it on; a tap on a live one turns it off. */
  assert.equal(toggleDepth(0), ACTIVE_DEPTH);
  assert.equal(toggleDepth(57.5), 0);
  assert.equal(toggleDepth(-57.5), 0);
  /* The store clamps, so a depth outside the range cannot survive a write. */
  const store = createStore(SCHEMA);
  assert.equal(store.set('matrix.lfo1.pitch', 400), 100);
  assert.equal(store.set('matrix.lfo1.pitch', -400), -100);
  assert.equal(store.set('matrix.lfo1.pitch', Number.NaN), 0, 'a non-number falls back to the default');
});

test('a cell shows a signed depth, and a drag is vertical and bipolar', () => {
  assert.equal(signedDepth(100), '+100');
  assert.equal(signedDepth(-100), '-100');
  assert.equal(signedDepth(0), '0');
  assert.equal(signedDepth(57.5), '+57.5');
  /* The same drag maths as every other painted control in the instrument. */
  const entry = SCHEMA['matrix.lfo1.pitch'];
  const up = dragBy(entry, 0, { dy: -200 });
  assert.equal(up, 100, 'dragging up the full range reaches +100');
  assert.equal(dragBy(entry, 0, { dy: 200 }), -100, 'and down reaches -100');
  assert.equal(dragBy(entry, 0, { dx: -200, dy: 0 }), 0, 'a horizontal drag does nothing to a vertical cell');
  const coarse = dragBy(entry, 0, { dy: -20 });
  const fine = dragBy(entry, 0, { dy: -20, fine: true });
  assert.ok(Math.abs(fine * 5 - coarse) < 1e-9, `shift is five times finer: ${fine} x 5 vs ${coarse}`);
});

/* ----------------------------------------------------- the per-block vector --- */

test('a source is normalised about its own neutral point', () => {
  /* Unipolar sources: silence is the neutral point. */
  for (const source of ['ampEnv', 'filterEnv', 'velocity', 'random']) {
    assert.deepEqual(SOURCE_NEUTRALS[source], { neutral: 0, span: 1 }, source);
    assert.equal(normaliseSource(source, 0), 0);
    assert.equal(normaliseSource(source, 1), 1);
    assert.equal(normaliseSource(source, 0.5), 0.5);
  }
  /* Key tracking is a RATIO, so unity is its neutral point and the route moves
     with how far tracking is turned. */
  assert.deepEqual(SOURCE_NEUTRALS.keyTrack, { neutral: 1, span: 1 });
  assert.equal(normaliseSource('keyTrack', 1), 0);
  assert.equal(normaliseSource('keyTrack', 2), 1);
  assert.equal(normaliseSource('keyTrack', 0), -1);
  /* The LFOs are already bipolar about zero. */
  for (const lfo of ['lfo1', 'lfo2', 'lfo3']) {
    assert.deepEqual(SOURCE_NEUTRALS[lfo], { neutral: 0, span: 1 });
    assert.equal(normaliseSource(lfo, -1), -1);
    assert.equal(normaliseSource(lfo, 1), 1);
  }
  assert.equal(normaliseSource('ampEnv', Number.NaN), 0, 'a non-number is silence, never NaN');
});

test('the vector is ONE bipolar number per destination, summed from the active routes', () => {
  const depths = {};
  depths[routeKey('lfo1', 'pitch')] = 100;
  depths[routeKey('velocity', 'pitch')] = -50;
  depths[routeKey('ampEnv', 'cutoff1')] = 100;
  const vector = createVector(depths, { lfo1: 1, lfo2: 0, lfo3: 0, ampEnv: 0.5, filterEnv: 0, velocity: 0.5, keyTrack: 1, random: 0 });

  assert.deepEqual(Object.keys(vector), [...MATRIX_DESTINATIONS], 'one entry per destination, in order');
  assert.equal(vector.pitch, 1 - 0.25, '1.0 from LFO 1 at full, minus a quarter from velocity');
  assert.equal(vector.cutoff1, 0.5);
  for (const destination of ['fmAmount', 'unisonSpread', 'cutoff2', 'ampLevel', 'delayTime', 'reverbSend']) {
    assert.equal(vector[destination], 0, `${destination} has no route`);
  }
  /* An inactive cell contributes nothing at all: the depth IS the activation. */
  const quiet = createVector({}, { lfo1: 1, lfo2: -1, lfo3: 1, ampEnv: 1, filterEnv: 1, velocity: 1, keyTrack: 2, random: 1 });
  assert.ok(Object.values(quiet).every((value) => value === 0), 'sixty-four routes at zero is a silent matrix');
});

test('the master vector is the MEAN of the sounding voices, so one voice equals itself', () => {
  /* The inputs are NORMALISED source values — the matrix normalises each voice's
     five sources once, then reconciles — so key tracking arrives as a deviation
     from unity and a voice at full tracking reads 1, not 2. */
  const one = reconcileSources([{ ampEnv: 0.2, filterEnv: 0.4, velocity: 1, keyTrack: 1, random: 0 }]);
  assert.deepEqual(one, { ampEnv: 0.2, filterEnv: 0.4, velocity: 1, keyTrack: 1, random: 0 }, 'one voice is its own mean');
  /* A sixteenth of a voice moves the master by a sixteenth, not a sixteenth of
     a different voice's contribution — which is the reason for the mean. */
  const sixteenth = reconcileSources([
    { ampEnv: 0, filterEnv: 0, velocity: 0, keyTrack: 0, random: 0 },
    ...Array.from({ length: 15 }, () => ({ ampEnv: 1, filterEnv: 1, velocity: 1, keyTrack: 1, random: 1 })),
  ]);
  assert.ok(Math.abs(sixteenth.ampEnv - 15 / 16) < 1e-12);
  assert.ok(Math.abs(sixteenth.keyTrack - 15 / 16) < 1e-12);
  /* No voices at all: the per-voice sources contribute nothing, and the LFOs
     still move the master effects, because they are global. */
  assert.deepEqual(reconcileSources([]), { ampEnv: 0, filterEnv: 0, velocity: 0, keyTrack: 0, random: 0 });
});

/* ---------------------------------------------------------------- the clamps --- */

test('every clamp is in the destination own units', () => {
  /* Cutoff: task 6 helper, not a second copy. */
  assert.equal(clampRoute('cutoff1', 1e9), CUTOFF_MOD_CENTS);
  assert.equal(clampRoute('cutoff1', -1e9), -CUTOFF_MOD_CENTS);
  assert.equal(clampRoute('cutoff2', 1e9), clampCutoffModulation(1e9));
  assert.equal(clampRoute('cutoff2', Number.NaN), 0);
  /* Pitch, four octaves either way. */
  assert.equal(clampRoute('pitch', 99999), 4800);
  assert.equal(clampRoute('pitch', -99999), -4800);
  /* Amp level is a BIAS: -1 is silence, so the sum can never invert the amp. */
  assert.equal(clampRoute('ampLevel', 99), 1);
  assert.equal(clampRoute('ampLevel', -99), -1);
  assert.equal(1 + clampRoute('ampLevel', -99), 0, 'the amp envelope peak bottoms out at zero, never below');
  /* Delay time is cents, and the chain clamps the seconds it produces. */
  assert.equal(clampRoute('delayTime', 99999), 4800);
  /* Reverb send is a BIAS around unity, because chain.js's send rests at 1 and a
     cell at depth 0 must be a no-op. So the excursion is -1..+1 around 1: */
  assert.equal(clampRoute('reverbSend', 0), 1, 'a cell at depth 0 leaves the send exactly where it was');
  assert.equal(clampRoute('reverbSend', -0.5), 0.5, 'a negative excursion ducks the send');
  assert.equal(clampRoute('reverbSend', -1), 0);
  assert.equal(clampRoute('reverbSend', -4), 0);
  assert.equal(clampRoute('reverbSend', 4), 1, 'and a positive one saturates at a full send');
  /* A non-number is "no modulation" everywhere, which for a unity-biased
     destination means "leave it alone" rather than zero. */
  for (const destination of MATRIX_DESTINATIONS) {
    if (destination === 'reverbSend') continue;
    assert.equal(clampRoute(destination, Number.NaN), 0, destination);
  }
  assert.equal(clampRoute('reverbSend', Number.NaN), 1, 'an unreadable send route leaves the send alone');
  assert.equal(clampRoute('delayTime', Number.NaN), 0);
});

test('a modulated cutoff is reported through task 6 clamp, so it is always audible', () => {
  /* Whatever a route asks for, the number the matrix reports is finite, inside
     20 Hz..20 kHz and inside a fraction of the sample rate. */
  for (const hz of [0, -1, NaN, Infinity, 20, 48000, 1e9]) {
    const reported = clampCutoff(hz, 48000);
    assert.ok(Number.isFinite(reported), `${hz} must not read back as ${reported}`);
    assert.ok(reported >= 20);
    assert.ok(reported <= 20000);
  }
  assert.equal(clampCutoff(1e9, 48000), 20000);
  assert.equal(clampCutoff(1e9, 44100), 44100 * 0.45, 'a slower context gets a lower ceiling');
  assert.equal(clampCutoff(NaN, 48000), 20);
});

/* --------------------------------------------------- the one write site rule --- */

test('every destination has exactly ONE application point', () => {
  /* The table has one row per destination, no duplicates, and covers all eight. */
  const names = APPLICATION_POINTS.map((row) => row.destination);
  assert.equal(names.length, 8);
  assert.equal(new Set(names).size, 8);
  assert.deepEqual(new Set(names), new Set(MATRIX_DESTINATIONS));

  /* And the file that writes them writes them from exactly one place: the voice
     seam is reached once, and the master seam once, whatever the destination. */
  const seamCalls = SOURCE.match(/\.apply\(/g) ?? [];
  assert.equal(seamCalls.length, 1, `matrix.js must reach the voice seam once, found ${seamCalls.length}`);
  assert.equal((SOURCE.match(/modulationPoints\(\)/g) ?? []).length, 1, 'the destinations are read once, through one door');
  assert.equal((SOURCE.match(/master\[/g) ?? []).length, 1, 'the master seam is written through one door');

  /* No route writes a parameter: the file never touches an AudioParam itself. */
  for (const forbidden of [/\.gain\.value\s*=/, /setValueAtTime/, /linearRampToValueAtTime/, /setTargetAtTime/]) {
    assert.equal(forbidden.test(SOURCE), false, `matrix.js reaches an AudioParam: ${forbidden}`);
  }
});

test('the matrix owns no timer, and no route writes a destination directly', () => {
  for (const forbidden of [/\bsetInterval\b/, /\bsetTimeout\s*\(/, /requestAnimationFrame/, /\bDate\.now\b/, /performance\.now/]) {
    assert.equal(forbidden.test(SOURCE), false, `matrix.js mentions ${forbidden}`);
  }
  /* Sixty-four route records, and not one of them carries an apply function. */
  for (const route of matrixRoutes()) {
    assert.deepEqual(Object.keys(route).sort(), ['destination', 'index', 'key', 'source']);
  }
});

/* ------------------------------------------------------------- the block loop --- */

/** Two sounding voices with the task-6 seams, over the fake context. */
function fakeVoice(index, { velocity = 0.8, random = 0.5, ampEnv = 0.5, filterEnv = 0.25, hz = 261.63 } = {}) {
  const calls = [];
  const core = () => ({
    setCoreModulation: (i, cents) => calls.push({ destination: 'pitch', core: i, cents }),
    setFmModulation: (i, route) => calls.push({ destination: 'fmAmount', core: i, route }),
    setUnisonSpreadModulation: (i, cents) => calls.push({ destination: 'unisonSpread', core: i, cents }),
  });
  const cores = [core(), core(), core()];
  const points = [
    { destination: 'pitch', unit: 'cents', range: [-4800, 4800], read: () => 1234, apply: (i, cents) => cores[i].setCoreModulation(i, cents) },
    { destination: 'fmAmount', unit: 'ratio', range: [0, 1], read: () => 0.5, apply: (i, route) => cores[i].setFmModulation(i, route) },
    { destination: 'unisonSpread', unit: 'cents', range: [0, 50], read: () => 8, apply: (i, cents) => cores[i].setUnisonSpreadModulation(i, cents) },
    { destination: 'cutoff1', unit: 'cents', range: [-4800, 4800], read: () => 1200, apply: (_i, cents) => calls.push({ destination: 'cutoff1', cents }) },
    { destination: 'cutoff2', unit: 'cents', range: [-4800, 4800], read: () => 4000, apply: (_i, cents) => calls.push({ destination: 'cutoff2', cents }) },
    { destination: 'ampLevel', unit: 'bias', range: [-1, 1], read: () => 0.7, apply: (_i, bias) => calls.push({ destination: 'ampLevel', bias }) },
  ];
  return {
    index,
    state: 'sounding',
    note: 60,
    calls,
    cores,
    hz,
    velocity,
    random,
    modulationPoints: () => points,
    modulationSources: () => [
      { source: 'ampEnv', unit: 'level', range: [0, 1], read: () => ampEnv },
      { source: 'filterEnv', unit: 'level', range: [0, 1], read: () => filterEnv },
      { source: 'velocity', unit: 'level', range: [0, 1], read: () => velocity },
      { source: 'random', unit: 'level', range: [0, 1], read: () => random },
      { source: 'keyTrack', unit: 'ratio', range: [0, 2], read: () => 1.25 },
    ],
    livePitch: () => hz,
  };
}

function harness({ depth = {}, lfoValues = {} } = {}) {
  const context = createModFakeContext();
  const store = createStore(SCHEMA);
  store.patch(defaults());
  store.patch(depth, { source: 'test', apply: 'direct' });
  const voices = [fakeVoice(0), fakeVoice(1, { velocity: 0.4, random: 0.9, ampEnv: 0.25 })];
  const masterCalls = [];
  const bank = {
    sourceValues: () => ({ lfo1: lfoValues.lfo1 ?? 0, lfo2: lfoValues.lfo2 ?? 0, lfo3: lfoValues.lfo3 ?? 0 }),
  };
  const modulation = createModulation({
    context,
    read: store.get,
    subscribe: store.subscribe.bind(store),
    voices: () => voices,
    sampleRate: context.sampleRate,
    bank,
    master: {
      delayTime: (cents) => {
        masterCalls.push({ destination: 'delayTime', cents });
        return 0.25 * 2 ** (cents / 1200);
      },
      reverbSend: (amount) => {
        masterCalls.push({ destination: 'reverbSend', amount });
        return amount;
      },
    },
  });
  return { context, store, voices, masterCalls, modulation, bank };
}

test('one block writes each destination once per voice, and the master once', () => {
  const { voices, masterCalls, modulation } = harness({
    depth: {
      'matrix.lfo1.pitch': 100,
      'matrix.lfo2.cutoff1': 100,
      'matrix.lfo3.cutoff2': -100,
      'matrix.ampEnv.ampLevel': 100,
      'matrix.filterEnv.cutoff1': 100,
      'matrix.velocity.cutoff1': 100,
      'matrix.keyTrack.pitch': 100,
      'matrix.random.unisonSpread': 100,
      'matrix.lfo1.delayTime': 100,
      'matrix.lfo2.reverbSend': 100,
    },
    lfoValues: { lfo1: 1, lfo2: -1, lfo3: 1 },
  });

  modulation.block();

  /* Pitch reaches all three cores of each voice, once each. */
  const pitchCalls = voices[0].calls.filter((call) => call.destination === 'pitch');
  assert.equal(pitchCalls.length, 3, 'one write per core');
  assert.deepEqual(pitchCalls.map((call) => call.core), [0, 1, 2]);
  /* LFO 1 at +1 and full depth, plus key tracking at 1.25 (a quarter of full):
     1.25 x 4800 = 6000 cents, which the single clamp at the application point
     brings back to the 4800 the pitch destination allows. */
  assert.equal(clampRoute('pitch', 1.25 * 4800), 4800, 'a sum over the range is clamped once, at the point');
  assert.equal(pitchCalls[0].cents, 4800);

  const cutoff1 = voices[0].calls.filter((call) => call.destination === 'cutoff1');
  assert.equal(cutoff1.length, 1, 'one write, not one per route');
  const own = (voice, destination) => voice.calls.filter((call) => call.destination === destination)[0];
  assert.ok(Math.abs(own(voices[0], 'cutoff1').cents - 240) < 1e-9, 'LFO 2 at -1, filter env at 0.25, velocity at 0.8: (-1 + 0.25 + 0.8) x 4800');

  /* The second voice gets its OWN sum from its own sources, not a copy of the first. */
  assert.ok(Math.abs(own(voices[1], 'cutoff1').cents - -1680) < 1e-9, '(-1 + 0.25 + 0.4) x 4800');

  /* The master destinations are written once each, from the mean. */
  assert.equal(masterCalls.length, 2);
  assert.equal(masterCalls.find((call) => call.destination === 'delayTime').cents, 4800);
  assert.equal(masterCalls.find((call) => call.destination === 'reverbSend').amount, 0, 'a negative send clamps to silence');
});

test('a silent matrix still writes every destination exactly once, at zero', () => {
  const { voices, masterCalls, modulation } = harness();
  modulation.block();
  /* Zeros included, deliberately: a route that has decayed to nothing has to be
     written as nothing, or the last value it had would stay applied for ever. And
     the count is the claim — one write per destination per voice per block, never
     one per route. */
  const counts = new Map();
  for (const call of voices[0].calls) counts.set(call.destination, (counts.get(call.destination) ?? 0) + 1);
  assert.deepEqual(
    [...counts.entries()].sort(),
    [['ampLevel', 1], ['cutoff1', 1], ['cutoff2', 1], ['fmAmount', 3], ['pitch', 3], ['unisonSpread', 3]],
  );
  for (const call of voices[0].calls) {
    const written = call.cents ?? call.route ?? call.bias;
    assert.equal(written, 0, `${call.destination} wrote ${written}`);
  }
  assert.equal(masterCalls.length, 2, 'the master is written every block, with zero');
  assert.deepEqual(masterCalls.map((call) => call.destination), ['delayTime', 'reverbSend']);
});

test('a full-depth cutoff route at both signs stays inside task 6 range and never NaNs', () => {
  for (const sign of [100, -100]) {
    const { voices, modulation } = harness({
      depth: {
        'matrix.lfo3.cutoff2': sign,
        'matrix.ampEnv.cutoff2': sign,
        'matrix.velocity.cutoff2': sign,
        'matrix.random.cutoff2': sign,
      },
      lfoValues: { lfo3: 1 },
    });
    for (let block = 0; block < 8; block += 1) modulation.block();
    const calls = voices[0].calls.filter((call) => call.destination === 'cutoff2');
    /* EIGHT IDENTICAL BLOCKS WRITE ONCE. A block write is a cancel-and-hold on the
       voice's AudioParams, so writing a value that did not move destroys whatever the
       destination had scheduled — see matrix.js's "WRITE WHAT MOVED". The next test
       covers the other half: a vector that DOES move is written again. */
    assert.equal(calls.length, 1, 'a route that did not move is written once, not once a block');
    for (const call of calls) {
      assert.ok(Number.isFinite(call.cents), 'NaN reached a cutoff');
      assert.ok(Math.abs(call.cents) <= CUTOFF_MOD_CENTS, `${call.cents} escaped the clamp`);
      assert.equal(clampRoute('cutoff2', call.cents), call.cents, 'what was applied is already clamped');
    }
    /* Four sources at full depth can only ever be clamped to the same ceiling. */
    assert.equal(calls[0].cents, sign > 0 ? CUTOFF_MOD_CENTS : -CUTOFF_MOD_CENTS);
    /* And the reported hertz is always audible. */
    const reported = modulation.read('cutoff2');
    assert.ok(Number.isFinite(reported) && reported >= 20 && reported <= 20000, `read back ${reported}`);
  }
});

test('a route that MOVES is written again, and one that does not is not written twice', () => {
  /* The LFO values are read once per block from this object, so moving one between
     blocks is a vector that changed under a route that did not. */
  const live = { lfo1: 0.5 };
  const { voices, modulation } = harness({ depth: { 'matrix.lfo1.pitch': 100 }, lfoValues: live });
  const pitch = () => voices[0].calls.filter((call) => call.destination === 'pitch');

  modulation.block();
  assert.equal(pitch().length, 3, 'the first block writes whatever the value — three cores, one value');
  assert.equal(pitch()[0].cents, 0.5 * PITCH_ROUTE_CENTS);

  modulation.block();
  modulation.block();
  assert.equal(pitch().length, 3, 'three blocks over one vector is one write, not three');

  live.lfo1 = 0.25;
  modulation.block();
  assert.equal(pitch().length, 6, 'a vector that moved is written again — the guard is not a latch');
  assert.equal(pitch()[3].cents, 0.25 * PITCH_ROUTE_CENTS);
});

test('the vector is readable per voice, so a route is demonstrable one at a time', () => {
  const { voices, modulation } = harness({ depth: { 'matrix.lfo1.pitch': 100 }, lfoValues: { lfo1: 0.5 } });
  modulation.block();
  assert.equal(modulation.vector(voices[0].index).pitch, 0.5);
  assert.equal(modulation.route('pitch', voices[0].index), 0.5 * 4800);
  assert.equal(modulation.read('pitch', voices[0].index), 261.63, 'the live value is the voice own pitch');
  assert.equal(modulation.blocks(), 1);
});

test('a store write to a cell re-blocks immediately, because a drag must be heard', () => {
  const { store, voices, modulation } = harness();
  assert.equal(modulation.blocks(), 0);
  store.set('matrix.lfo1.pitch', 100, { source: 'control', apply: 'ramp' });
  assert.equal(modulation.blocks(), 1, 'the cell wrote on the store write, not at the next step');
  assert.ok(voices[0].calls.length > 0);
  assert.equal(voices[0].calls[0].cents, 0, 'the LFO reads zero here, so the route is written as zero');
  store.set('matrix.lfo1.pitch', -100, { source: 'control', apply: 'ramp' });
  assert.equal(modulation.blocks(), 2, 'and every following drag re-blocks');
});

/* ---------------------------------------------------------------- the panel --- */

test('the panel paints sixty-four cells in row and column order', () => {
  const doc = createFakeDocument();
  const store = createStore(SCHEMA);
  const panel = doc.createElement('section');
  panel.className = 'panel panel--matrix';
  panel.setAttribute('data-panel', 'matrix');
  panel.append(parseHeadGrid({ rows: [...MATRIX_SOURCES], columns: [...MATRIX_DESTINATIONS] }, doc));
  doc.root.append(panel);

  const built = buildMatrixPanel({ doc, store });
  assert.equal(built.cells.length, 64);
  assert.equal(built.cells[0].cell.dataset.source, 'lfo1');
  assert.equal(built.cells[0].cell.dataset.destination, 'pitch');
  assert.equal(built.cells[0].cell.dataset.key, 'matrix.lfo1.pitch');
  assert.equal(built.cells[8].cell.dataset.source, 'lfo2');
  assert.equal(built.cells[63].cell.dataset.source, 'random');
  assert.equal(built.cells[63].cell.dataset.destination, 'reverbSend');
  /* The empty grid surface.js rendered is interactive now, so it cannot be hidden
     from assistive technology any more. */
  const grid = panel.first('headgrid');
  assert.equal(grid.getAttribute('aria-hidden'), null, 'an interactive grid must not be aria-hidden');
  for (const { cell } of built.cells) {
    assert.equal(cell.getAttribute('role'), 'slider');
    assert.equal(cell.getAttribute('tabindex'), '0');
    assert.equal(cell.getAttribute('aria-valuemin'), '-100');
    assert.equal(cell.getAttribute('aria-valuemax'), '100');
    assert.ok(cell.getAttribute('aria-valuenow'), 'every cell publishes its depth');
    assert.ok(cell.getAttribute('aria-label'), 'every cell names its route');
    assert.equal(cell.textContent, '0', 'every cell shows a signed number');
  }
});

test('the panel mounts only once the SURFACE EXISTS, not when the module is evaluated', () => {
  /* A deferred module script runs BEFORE DOMContentLoaded, with readyState
     'interactive' — and ui/main.js calls buildSurface() AFTER its static imports.
     So a module that mounts on anything other than 'complete' mounts before the
     grid it is meant to paint exists, and paints onto nothing. This is the test
     that failure wrote. */
  for (const readyState of ['loading', 'interactive']) {
    const doc = createFakeDocument();
    doc.readyState = readyState;
    let mounted = 0;
    mountWhenReady(doc, () => { mounted += 1; });
    assert.equal(mounted, 0, `${readyState}: must not mount before the document is ready`);
    assert.equal(doc.dispatch('DOMContentLoaded'), 1);
    assert.equal(mounted, 1, `${readyState}: mounts once the surface has been drawn`);
    assert.equal(doc.dispatch('DOMContentLoaded'), 0, `${readyState}: and only once`);
  }
  /* Already complete — the verification path, where an import lands on a loaded page. */
  const done = createFakeDocument();
  done.readyState = 'complete';
  let mounted = 0;
  mountWhenReady(done, () => { mounted += 1; });
  assert.equal(mounted, 1);
});

test('no matrix panel means no cells, and nothing is painted onto the page', () => {
  /* The failure mode above left an orphan grid on document.body. A module that
     cannot find the panel it belongs to must mount nothing rather than invent a
     place to put 64 cells. */
  const doc = createFakeDocument();
  const store = createStore(SCHEMA);
  const built = buildMatrixPanel({ doc, store });
  assert.deepEqual(built.cells, []);
  assert.equal(built.grid, null);
  assert.equal(doc.root.children.length, 0, 'nothing was appended anywhere');
});

test('a panel with no grid yet gets one, rather than 64 cells painted onto nothing', () => {
  const doc = createFakeDocument();
  const store = createStore(SCHEMA);
  const panel = doc.createElement('section');
  panel.setAttribute('data-panel', 'matrix');
  doc.root.append(panel);
  const built = buildMatrixPanel({ doc, store });
  assert.equal(built.cells.length, 64);
  assert.equal(built.grid.parentNode, panel, 'the grid it built belongs to the panel');
  assert.equal(panel.all('matrix-cell').length, 64);
});

test('the cells really replace the placeholders surface.js drew', () => {
  /* The panel is only mounted if the cells LAND in the document. Reading `.parent`
     instead of `.parentNode` works perfectly against a fake and silently does
     nothing in a browser, so this is the test that would have caught it. */
  const doc = createFakeDocument();
  const store = createStore(SCHEMA);
  const panel = doc.createElement('section');
  panel.setAttribute('data-panel', 'matrix');
  panel.append(parseHeadGrid({ rows: [...MATRIX_SOURCES], columns: [...MATRIX_DESTINATIONS] }, doc));
  doc.root.append(panel);
  const built = buildMatrixPanel({ doc, store });
  assert.equal(panel.all('headgrid__cell').length, 64, 'sixty-four cells, in place');
  assert.equal(panel.all('matrix-cell').length, 64, 'and every one of them is a matrix cell');
  for (const { cell } of built.cells) assert.equal(cell.parentNode, panel.first('headgrid'));
});

test('a cell click activates it and a cell drag writes a signed depth to the store', () => {
  const doc = createFakeDocument();
  const store = createStore(SCHEMA);
  const panel = doc.createElement('section');
  panel.setAttribute('data-panel', 'matrix');
  panel.append(parseHeadGrid({ rows: [...MATRIX_SOURCES], columns: [...MATRIX_DESTINATIONS] }, doc));
  doc.root.append(panel);
  const built = buildMatrixPanel({ doc, store });
  const cell = built.cells[0].cell;

  /* A tap: down, no movement, up. */
  cell.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
  cell.dispatch('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
  assert.equal(store.get('matrix.lfo1.pitch'), 100, 'a click activates the cell at full depth');
  assert.equal(cell.getAttribute('aria-valuenow'), '100');
  assert.equal(cell.textContent, '+100');
  assert.equal(cell.classList.contains('is-active'), true);

  /* A drag up the full range from the top, with movement recorded. */
  cell.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 10, clientY: 100 });
  cell.dispatch('pointermove', { pointerId: 2, movementX: 0, movementY: -200 });
  cell.dispatch('pointerup', { pointerId: 2, clientX: 10, clientY: -100 });
  assert.equal(store.get('matrix.lfo1.pitch'), 100, 'already at the top');

  /* And a drag down is negative: the depth is bipolar, not a magnitude. Cell 8 is
     LFO 2 to pitch — the ninth cell, because the panel is row-major. */
  const other = built.cells[8].cell;
  assert.equal(other.dataset.key, 'matrix.lfo2.pitch');
  other.dispatch('pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 10, clientY: 100 });
  other.dispatch('pointermove', { pointerId: 3, movementX: 0, movementY: 200 });
  other.dispatch('pointerup', { pointerId: 3, clientX: 10, clientY: 300 });
  assert.equal(store.get('matrix.lfo2.pitch'), -100);
  assert.equal(other.textContent, '-100');

  /* Keyboard: arrows step it, which is what every other painted control does. */
  cell.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(store.get('matrix.lfo1.pitch'), 98);
  cell.dispatch('keydown', { key: 'Home' });
  assert.equal(store.get('matrix.lfo1.pitch'), -100);
  cell.dispatch('keydown', { key: 'End' });
  assert.equal(store.get('matrix.lfo1.pitch'), 100);
  /* A double click is the way back to the default, as everywhere else. */
  cell.dispatch('dblclick');
  assert.equal(store.get('matrix.lfo1.pitch'), 0);
});

/* ------------------------------------- the pending-voice regression (the defect) --- */

/**
 * An AudioParam that ACTUALLY CANCELS.
 *
 * The shared fake in tests/voice-fake-audio.mjs only RECORDS events, because everything
 * it was written for is about which calls were made. The defect this section guards is a
 * CANCELLATION: the Web Audio specification says `cancelAndHoldAtTime(t)` removes every
 * automation event stamped at or after `t`, and every write the matrix makes is a
 * cancel-and-hold followed by a short ramp. A fake that never removes anything therefore
 * cannot see this class of bug at all, which is exactly why 488 tests passed with it in
 * place. So this one implements the removal, and keeps the surviving timeline so a test
 * can ask what the audio thread would still render.
 */
function makeCancellingParam(initial = 0) {
  return {
    value: initial,
    /** The surviving automation, in order. */
    events: [],
    /** Every call, for counting what a block did. */
    calls: [],
    setValueAtTime(value, time) {
      this.calls.push({ op: 'setValueAtTime', value, time });
      this.value = value;
      this.events.push({ type: 'set', value, time });
      return this;
    },
    linearRampToValueAtTime(value, time) {
      this.calls.push({ op: 'linearRampToValueAtTime', value, time });
      this.value = value;
      this.events.push({ type: 'ramp', value, time });
      return this;
    },
    setTargetAtTime(value, time) {
      this.calls.push({ op: 'setTargetAtTime', value, time });
      this.value = value;
      this.events.push({ type: 'target', value, time });
      return this;
    },
    /* The specification: remove every automation event stamped at or after `time`. */
    cancelScheduledValues(time) {
      this.calls.push({ op: 'cancelScheduledValues', time });
      this.events = this.events.filter((event) => event.time < time);
      return this;
    },
    cancelAndHoldAtTime(time) {
      this.calls.push({ op: 'cancelAndHoldAtTime', time });
      this.events = this.events.filter((event) => event.time < time);
      return this;
    },
  };
}

/** Swap every AudioParam the fake context hands out for a cancelling one. */
function withCancellingParams(context) {
  const props = ['gain', 'frequency', 'Q', 'detune', 'offset', 'playbackRate'];
  for (const factory of ['createGain', 'createConstantSource', 'createOscillator', 'createBufferSource', 'createBiquadFilter']) {
    const original = context[factory].bind(context);
    context[factory] = (...args) => {
      const node = original(...args);
      for (const prop of props) {
        if (node[prop] && typeof node[prop].linearRampToValueAtTime === 'function') {
          node[prop] = makeCancellingParam(node[prop].value);
        }
      }
      return node;
    };
  }
  return context;
}

/** A real voice on the fake context, in the store the panel would be driving. */
function realVoice(context, store, index = 0) {
  return createVoice({ context, parent: context.destination, read: store.get, index });
}

/** A rig over one voice, on a bank whose LFO values the test controls. */
function rigOver(context, store, voice, lfoValues = {}) {
  return createModulation({
    context,
    read: store.get,
    subscribe: () => () => {},
    voices: () => [voice],
    sampleRate: context.sampleRate,
    bank: { sourceValues: () => ({ lfo1: 0, lfo2: 0, lfo3: 0, ...lfoValues }) },
  });
}

test('pendingNoteAutomation is the note schedule against the audio clock', () => {
  const sounding = { startedAt: 1, releasedAt: null };
  assert.equal(pendingNoteAutomation({ startedAt: 1, releasedAt: null }, 1), false, 'begun, still held');
  assert.equal(pendingNoteAutomation({ startedAt: 1, releasedAt: 1.5 }, 2), false, 'begun, note-off behind us');
  /* The two cases the defect lived in. */
  assert.equal(pendingNoteAutomation({ startedAt: 1, releasedAt: null }, 0.9), true, 'note-on still ahead');
  assert.equal(pendingNoteAutomation({ startedAt: 1, releasedAt: 1.5 }, 1.2), true, 'note-off still ahead');
  /* No evidence of a pending note is not evidence of a pending note. */
  assert.equal(pendingNoteAutomation({}, 10), false);
  assert.equal(pendingNoteAutomation({ startedAt: null, releasedAt: null }, 10), false);
});

test('REGRESSION: a block must not delete the note automation of a voice scheduled ahead', () => {
  const context = withCancellingParams(createModFakeContext());
  const store = createStore(SCHEMA);
  store.patch(defaults(), { source: 'test', apply: 'direct' });
  const voice = realVoice(context, store);
  const modulation = rigOver(context, store, voice);

  /* THE COLD START, EXACTLY AS THE CLOCK PRODUCES IT: a lookahead step places the note
     100 ms in the future, and playNote schedules the note-off in the SAME tick. So the
     voice is RELEASED before it has ever made a sound — which is why `state !== IDLE`
     was not evidence that a note was sounding. */
  voice.start({ id: 'mel-1', note: 60, velocity: 0.8, random: 0.5 }, { at: 0.1 });
  voice.release(0.16);
  assert.equal(context.currentTime, 0);
  assert.ok(voice.startedAt > context.currentTime, 'the note-on is in the future');

  const vca = voice.vca.gain;
  const before = vca.events.map((event) => ({ ...event }));
  const callsBefore = vca.calls.length;
  assert.ok(before.some((event) => event.time === 0.1), 'the note-on is scheduled on the amplifier');

  modulation.block();

  assert.equal(vca.calls.length, callsBefore, 'the block wrote nothing to an amplifier whose note has not begun');
  assert.deepEqual(vca.events.map((event) => ({ ...event })), before, 'the note-on automation survived the block intact');

  /* Every segment of the note is still on the amplifier, at the times env.js scheduled
     them: the attack to the peak, the decay to the sustain, and the note-off's release. */
  const times = vca.events.map((event) => event.time);
  const shape = voice.ampEnv.state();
  assert.ok(times.includes(0.1), 'the note-on instant write');
  assert.ok(times.includes(0.1 + shape.attack), 'the attack to the peak');
  assert.ok(times.includes(0.16 + shape.release), 'and the release the note-off scheduled');
  assert.ok(vca.events.some((event) => event.value === 1 && event.type === 'ramp'), 'the attack still reaches the peak');
  /* The decay ramp is absent, and it is absent for the right reason: the note-off's own
     cancel-and-hold at 0.16 removes everything after it, which is what the specification
     says and what the browser does. It was already gone before the block ran. */

  /* And the other five destinations carry pending note-on automation of their own, which
     a block must leave alone just as much: the pitch source, both cutoffs and the FM
     depth are all stamped at the note time. */
  const pitch = voice.core(0).pitchSource.offset;
  assert.ok(pitch.events.some((event) => event.time === 0.1), 'the pitch source keeps its note-on write');
});

test('REGRESSION: once the note has begun and its note-off is behind us, the block writes', () => {
  const context = withCancellingParams(createModFakeContext());
  const store = createStore(SCHEMA);
  store.patch(defaults(), { source: 'test', apply: 'direct' });
  store.patch({ 'matrix.lfo1.pitch': 100 }, { source: 'test', apply: 'direct' });
  const voice = realVoice(context, store);
  const modulation = rigOver(context, store, voice, { lfo1: 0.5 });

  voice.start({ id: 'mel-2', note: 60, velocity: 0.8, random: 0.5 }, { at: 0.1 });
  voice.release(0.16);
  const pitch = voice.core(0).pitchSource.offset;
  const callsBefore = pitch.calls.length;
  modulation.block();
  assert.equal(pitch.calls.length, callsBefore, 'still pending: no write');

  /* The audio clock reaches the note, and then its note-off. */
  context.currentTime = 0.5;
  modulation.block();
  assert.ok(pitch.calls.length > callsBefore, 'a voice that has begun IS written — the guard is not a blanket skip');
  assert.ok(pitch.calls.some((call) => call.op === 'cancelAndHoldAtTime'), 'and it is written the way every write is');
  assert.equal(modulation.route('pitch', voice.index), 0.5 * PITCH_ROUTE_CENTS, 'with the summed route');
});
