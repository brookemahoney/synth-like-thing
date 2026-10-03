/**
 * Integration checks for the parameter store — the instrument's single authority
 * for state. Framework-free: `node --test tests/store.test.mjs`.
 *
 * These cover the logic later tasks depend on (clamping/coercion, notification
 * order, subscriber lifecycle, the documented key namespace). DOM behaviour of
 * the control factory is verified in the browser, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA,
  createStore,
  defaults,
  store,
} from '../web/ui/params.js';

test('get() returns the documented init-patch value for representative keys', () => {
  assert.equal(store.get('global.volume'), 0.7);
  assert.equal(store.get('global.tempo'), 120);
  assert.equal(store.get('osc1.waveform'), 'sawtooth');
  assert.equal(store.get('osc2.waveform'), 'square');
  assert.equal(store.get('osc3.waveform'), 'sine');
  assert.equal(store.get('filter1.cutoff'), 1200);
  assert.equal(store.get('filter1.resonance'), 1.2);
  assert.equal(store.get('envAmp.attack'), 0.01);
  assert.equal(store.get('lfo1.on'), false);
  assert.equal(store.get('matrix.lfo1.pitch'), 0);
  assert.equal(store.get('delay.mix'), 0);
  assert.equal(store.get('reverb.mix'), 0);
});

test('set() clamps numbers into the schema range and returns the stored value', () => {
  const s = createStore(SCHEMA);
  assert.equal(s.set('filter1.cutoff', 1e9), 20000);
  assert.equal(s.get('filter1.cutoff'), 20000);
  assert.equal(s.set('filter1.cutoff', 1), 20);
  assert.equal(s.get('filter1.cutoff'), 20);
  assert.equal(s.set('global.swing', 100), 75);
  assert.equal(s.set('global.swing', 0), 50);
});

test('set() rounds integers and rejects values outside an enum', () => {
  const s = createStore(SCHEMA);
  assert.equal(s.set('osc1.unison', 3.6), 4);
  assert.equal(s.set('osc1.unison', 9), 7, 'clamped to schema max');
  assert.equal(s.set('osc1.unison', 0), 1, 'clamped to schema min');

  s.set('osc1.waveform', 'square');
  assert.equal(s.set('osc1.waveform', 'not-a-wave'), 'square', 'enum violation keeps the old value');
  assert.equal(s.set('osc1.waveform', 'noise'), 'noise');
});

test('set() coerces booleans and stores unknown keys verbatim (warning once)', () => {
  const s = createStore(SCHEMA);
  assert.equal(s.set('global.run', 1), true);
  assert.equal(s.set('global.run', 0), false);
  assert.equal(s.get('global.run'), false);

  const warnings = [];
  const real = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.equal(s.set('task999.thing', 1234.5), 1234.5);
    s.set('task999.thing', 99);
  } finally {
    console.warn = real;
  }
  assert.equal(warnings.length, 1, 'warns once per unknown key');
});

test('set() does not retain a live reference to an array value', () => {
  const s = createStore(SCHEMA);
  const order = ['A', 'B'];
  s.set('seq.chainOrder', order);
  order.push('C');
  assert.deepEqual(s.get('seq.chainOrder'), ['A', 'B']);
});

test('subscribe(key, fn) fires with (key, value, previous, meta) and unsubscribes', () => {
  const s = createStore(SCHEMA);
  const seen = [];
  const off = s.subscribe('global.volume', (...args) => seen.push(args));

  s.set('global.volume', 0.5);
  s.set('global.tempo', 100, { source: 'test' }); // other key: no per-key call
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ['global.volume', 0.5, 0.7, { source: 'control' }]);

  off();
  s.set('global.volume', 0.2);
  assert.equal(seen.length, 1);
});

test('subscribeAll(fn) sees every key; single-argument subscribe is subscribeAll', () => {
  const s = createStore(SCHEMA);
  const all = [];
  const both = [];
  s.subscribeAll((key) => all.push(key));
  s.subscribe((key) => both.push(key));

  s.set('global.run', true);
  s.set('osc1.level', 0.9);
  assert.deepEqual(all, ['global.run', 'osc1.level']);
  assert.deepEqual(both, all);
});

test('the store is the only authority: two subscribers of the same key agree', () => {
  const s = createStore(SCHEMA);
  const a = [];
  const b = [];
  s.subscribe('filter1.cutoff', (k, v) => a.push(v));
  s.subscribe('filter1.cutoff', (k, v) => b.push(v));
  s.set('filter1.cutoff', 4000);
  assert.deepEqual(a, [4000]);
  assert.deepEqual(b, [4000]);
  assert.equal(a.at(-1), b.at(-1), 'no divergent private copies');
});

test('defaults() is the init patch and matches a freshly created store', () => {
  const patch = defaults();
  const s = createStore(SCHEMA);
  assert.deepEqual(s.snapshot(), patch);
  assert.notEqual(patch, s.snapshot(), 'snapshot is a fresh object each call');

  s.set('global.volume', 0.1);
  assert.equal(defaults()['global.volume'], 0.7, 'defaults() is not mutated by a live store');
});

test('the namespace covers every family later tasks read', () => {
  const keys = store.keys();
  const has = (k) => keys.includes(k);

  // Global strip
  for (const k of ['global.power', 'global.volume', 'global.tempo', 'global.swing', 'global.run', 'global.latch']) {
    assert.ok(has(k), `missing ${k}`);
  }
  // Three oscillator cores, ten waveforms each
  for (const n of [1, 2, 3]) {
    for (const p of ['waveform', 'octave', 'semitone', 'detune', 'level', 'fmAmount', 'fmSource', 'unison', 'unisonSpread', 'ringMod']) {
      assert.ok(has(`osc${n}.${p}`), `missing osc${n}.${p}`);
    }
    assert.equal(store.schema(`osc${n}.waveform`).options.length, 10, 'ten waveforms');
  }
  // Two cascaded filters
  for (const n of [1, 2]) {
    for (const p of ['type', 'cutoff', 'resonance', 'drive', 'keyTrack', 'bypass']) {
      assert.ok(has(`filter${n}.${p}`), `missing filter${n}.${p}`);
    }
  }
  // Envelopes — no dedicated filter-env amount (the matrix route is the amount)
  for (const e of ['envAmp', 'envFilter']) {
    for (const p of ['attack', 'decay', 'sustain', 'release']) {
      assert.ok(has(`${e}.${p}`), `missing ${e}.${p}`);
    }
  }
  assert.ok(!has('envFilter.amount'), 'no dedicated filter-envelope amount knob');
  // Three LFOs
  for (const n of [1, 2, 3]) {
    for (const p of ['wave', 'rate', 'sync', 'rateSync', 'fadeIn', 'on']) {
      assert.ok(has(`lfo${n}.${p}`), `missing lfo${n}.${p}`);
    }
  }
  // 8 x 8 modulation matrix
  const sources = ['lfo1', 'lfo2', 'lfo3', 'ampEnv', 'filterEnv', 'velocity', 'keyTrack', 'random'];
  const destinations = ['pitch', 'fmAmount', 'unisonSpread', 'cutoff1', 'cutoff2', 'ampLevel', 'delayTime', 'reverbSend'];
  assert.equal(sources.length * destinations.length, 64);
  for (const src of sources) {
    for (const dst of destinations) {
      assert.ok(has(`matrix.${src}.${dst}`), `missing matrix.${src}.${dst}`);
    }
  }
  // Effects chain
  for (const k of ['eq.low', 'eq.mid', 'eq.high', 'delay.time', 'delay.feedback', 'delay.tone', 'delay.mix', 'reverb.decay', 'reverb.mix']) {
    assert.ok(has(k), `missing ${k}`);
  }
  // 11 808 voices x tune/decay/level/pan
  const kit = ['bd', 'sd', 'lt', 'mt', 'ht', 'rs', 'cp', 'cb', 'ch', 'oh', 'cy'];
  assert.equal(kit.length, 11);
  for (const v of kit) {
    for (const p of ['tune', 'decay', 'level', 'pan']) {
      assert.ok(has(`kit.${v}.${p}`), `missing kit.${v}.${p}`);
    }
  }
  // 16-step sequencer: 11 drum lanes + melodic lane
  for (const lane of [...kit, 'melody']) {
    for (let step = 1; step <= 16; step += 1) {
      assert.ok(has(`seq.${lane}.on.${step}`), `missing seq.${lane}.on.${step}`);
      assert.ok(has(`seq.${lane}.vel.${step}`), `missing seq.${lane}.vel.${step}`);
    }
  }
  for (let step = 1; step <= 16; step += 1) {
    assert.ok(has(`seq.melody.note.${step}`), `missing seq.melody.note.${step}`);
    assert.ok(has(`seq.melody.gate.${step}`), `missing seq.melody.gate.${step}`);
  }
  // Arpeggiator
  for (const p of ['on', 'mode', 'rate', 'octaves', 'gate', 'followLane']) {
    assert.ok(has(`arp.${p}`), `missing arp.${p}`);
  }
  assert.equal(store.schema('arp.mode').options.length, 5, 'five arpeggiator modes');

  assert.equal(keys.length, Object.keys(SCHEMA).length, 'keys() matches the schema exactly');
});

test('the init patch is musically sane and silent where it should be', () => {
  const patch = defaults();
  for (const n of [1, 2, 3]) {
    assert.equal(patch[`lfo${n}.on`], false, `lfo${n} defaults off`);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('matrix.')) assert.equal(v, 0, `${k} depth should default to zero`);
  }
  assert.equal(patch['delay.mix'], 0);
  assert.equal(patch['reverb.mix'], 0);
  assert.equal(patch['global.run'], false);
  assert.ok(patch['envAmp.attack'] < 0.1, 'fast attack');
  assert.ok(patch['envAmp.release'] > 0.5, 'long release');
  assert.ok(patch['osc1.level'] >= patch['osc2.level'], 'osc1 at least as loud as osc2');
  assert.ok(patch['osc2.level'] >= patch['osc3.level'], 'osc2 at least as loud as osc3');
  assert.ok(patch['filter1.cutoff'] > 20 && patch['filter1.cutoff'] < 20000);
});