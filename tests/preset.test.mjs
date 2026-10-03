/**
 * Preset system: twelve localStorage slots, the schema-version gate,
 * validate-before-replace, quota-failure handling and the JSON round-trip.
 * Framework-free: `node --test tests/preset.test.mjs`.
 *
 * WHAT IS UNDER TEST HERE, AND WHY IT IS NOT A CRUD TEST
 *   A slot that stores a value and reads it back is not worth a test. What is worth
 *   testing is the four places this system can be WRONG QUIETLY, which is the risk the
 *   plan names:
 *
 *     1. the schema-version gate   — a version mismatch must be a controlled fallback to
 *                                    the init patch, never a field-by-field partial apply;
 *     2. validate-before-replace   — a malformed document must leave the instrument's
 *                                    current state untouched AND still playable;
 *     3. quota exhaustion          — localStorage has a quota and a loaded wavetable is a
 *                                    real size risk, so a full store is a save FAILURE with
 *                                    a visible reason, never a silent truncation;
 *     4. the exact round-trip      — proven with distinctive values, because a
 *                                    default-valued patch round-trips trivially and proves
 *                                    nothing.
 *
 * THE REAL BANK, NOT A FAKE
 *   Pattern capture and restore go through `createPatternBank` — task 10's real bank —
 *   over a real isolated store, because the whole restore mechanism depends on the bank's
 *   live capture of flat `seq.<lane>.<field>.<n>` writes into whichever pattern is
 *   selected. A hand-written stub would have passed against a mechanism that does not
 *   work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA, createStore, defaults } from '../web/ui/params.js';
import { createPatternBank } from '../web/audio/sequencer.js';
import {
  DOCUMENT_KEYS,
  MAX_RECORDED_FAILURES,
  FAILURE_LIST,
  FAILURE_REASONS,
  INIT_PATCH,
  RUNTIME_KEYS,
  SCHEMA_VERSION,
  SLOT_COUNT,
  SLOT_IDS,
  STORAGE_KEY,
  createPresetSystem,
} from '../web/audio/presets.js';

/* ------------------------------------------------------------------ harness --- */

/** A localStorage-shaped object. `quotaBytes` is measured in string length, as a quota is. */
function fakeStorage({ quotaBytes = Infinity } = {}) {
  const map = new Map();
  const bytes = () => [...map.values()].reduce((total, text) => total + text.length, 0);
  const api = {
    /* Settable, so a test can learn a real document's size and then refuse the next one. */
    quotaBytes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, text) {
      const next = bytes() - (map.has(key) ? map.get(key).length : 0) + text.length;
      if (next > api.quotaBytes) {
        const error = new Error(`QuotaExceededError: ${next} bytes over ${api.quotaBytes}`);
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, text);
    },
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    length: map.size,
    bytes,
    raw: () => Object.fromEntries(map),
  };
  return api;
}

/** A wavesampler stand-in that records exactly what the preset system asks of it. */
function fakeSampler() {
  const loaded = new Map();
  const factory = (slot) => ({
    name: ['warmSaw', 'softSquare', 'reed', 'glass'][slot],
    label: 'factory',
    kind: 'factory',
    sourceName: null,
    slot,
    length: 2048,
  });
  return {
    slots: ['warmSaw', 'softSquare', 'reed', 'glass'],
    tables: () => [...loaded.entries()].map(([slot, doc]) => ({ ...doc, kind: 'user', slot })),
    serialize(slot) {
      const doc = loaded.get(slot);
      return doc ? { ...doc, slot } : null;
    },
    restore(doc) {
      loaded.set(doc.slot, { name: doc.name, label: doc.label, sourceName: doc.sourceName, length: doc.samples.length, samples: [...doc.samples] });
      return loaded.get(doc.slot);
    },
    load(slot, { name, sourceName, samples }) {
      loaded.set(slot, { name, label: name, sourceName, length: samples.length, samples: [...samples] });
      return loaded.get(slot);
    },
    factory,
    loaded: () => new Map(loaded),
  };
}

/**
 * One isolated instrument: a real store, the real pattern bank over it, a fake
 * localStorage, a fake wavesampler and the preset system that binds all three.
 */
function harness({ storage = fakeStorage(), sampler = fakeSampler() } = {}) {
  const store = createStore(SCHEMA);
  const bank = createPatternBank({ store });
  const system = createPresetSystem({ store, storage, sampler, sequencer: { bank }, key: STORAGE_KEY });
  return { store, bank, storage, sampler, system };
}

/** A cycle of `length` distinguishable, in-range samples — a user table's shape. */
const wave = (length = 2048, phase = 0) =>
  Array.from({ length }, (_unused, i) => Number((Math.sin((2 * Math.PI * (i + phase)) / length) * 0.8).toFixed(6)));

/**
 * A patch of DISTINCTIVE values — every family the document owns, all away from their
 * defaults, so a round-trip that quietly fell back to the init patch cannot pass.
 */
function distinctive(store) {
  store.patch({
    'global.volume': 0.375,
    'global.tempo': 173,
    'global.swing': 68.5,
    'global.latch': true,
    'osc1.waveform': 'sawDown',
    'osc1.detune': -13.5,
    'osc2.waveform': 'pulse125',
    'osc3.unison': 5,
    'filter1.type': 'bp12',
    'filter1.cutoff': 735,
    'filter1.resonance': 21.25,
    'envAmp.attack': 1.25,
    'envFilter.release': 6.5,
    'eq.low': -7.5,
    'delay.feedback': 62,
    'delay.mix': 0.44,
    'reverb.decay': 9.5,
    'reverb.mix': 0.28,
    'kit.bd.tune': -5,
    'kit.cy.decay': 1.75,
    'matrix.lfo1.pitch': 44,
    'matrix.filterEnv.reverbSend': -33,
    'lfo2.rate': 0.37,
    'lfo3.on': true,
    'arp.mode': 'random',
    'arp.rate': '1/16T',
    'arp.octaves': 3,
    'wave.level': 0.62,
    'wave.table': 'reed',
    'seq.chain': true,
    'seq.chainOrder': ['C', 'A', 'D', 'C', 'B'],
    'seq.pattern': 'C',
  });
  // Pattern C's own distinctive step, written through the bank like any other gesture.
  store.set('seq.cy.on.7', true);
  store.set('seq.cy.vel.7', 43);
  store.set('seq.melody.note.3', 71);
  store.set('seq.melody.gate.3', 88);
  // A different pattern, so "all four patterns" is a claim with something behind it.
  store.set('seq.pattern', 'D');
  store.set('seq.bd.on.12', true);
  store.set('seq.bd.vel.12', 17);
  store.set('seq.pattern', 'C');
}

/** The values a restore has to bring back, as a comparable object. */
function readBack(store, bank) {
  return {
    params: (() => {
      const snapshot = store.snapshot();
      for (const key of RUNTIME_KEYS) delete snapshot[key];
      return snapshot;
    })(),
    patterns: bank.snapshot(),
    chainOrder: store.get('seq.chainOrder'),
    swing: store.get('global.swing'),
    tempo: store.get('global.tempo'),
    pattern: store.get('seq.pattern'),
  };
}

/* ------------------------------------------------------- the storage contract --- */

test('the storage key is namespaced and versioned, and the version lives in the document too', () => {
  const { system, storage } = harness();
  assert.equal(STORAGE_KEY, 'synth-like-thing.synth.presets.v1');
  assert.ok(STORAGE_KEY.startsWith('synth-like-thing.'), 'namespaced by application');
  assert.ok(STORAGE_KEY.endsWith('.v1'), 'and versioned');
  assert.equal(SCHEMA_VERSION, 1);

  assert.equal(system.key(), STORAGE_KEY);

  system.save(1, { name: 'Versioned' });
  const envelope = JSON.parse(storage.raw()[STORAGE_KEY]);
  assert.equal(envelope.schemaVersion, 1, 'the container carries the version');
  assert.equal(envelope.slots['1'].schemaVersion, 1, 'and so does every document in it');

  // The document names every key the file format requires, and the version is one of them.
  for (const key of DOCUMENT_KEYS) {
    assert.ok(key in envelope.slots['1'], `document is missing "${key}"`);
  }
});

test('the init patch is the store default set, defined once', () => {
  assert.deepEqual(INIT_PATCH, defaults());
  const fresh = createStore(SCHEMA).snapshot();
  for (const key of Object.keys(INIT_PATCH)) {
    assert.deepEqual(INIT_PATCH[key], fresh[key], `${key} differs from the schema default`);
  }
});

/* ------------------------------------------------------------ twelve slots --- */

test('twelve slots exist and are individually addressable by number', () => {
  const { store, system } = harness();
  assert.equal(SLOT_COUNT, 12);
  assert.deepEqual([...SLOT_IDS], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const slots = system.slots();
  assert.equal(slots.length, 12, 'twelve rows in the UI');
  assert.deepEqual(slots.map((s) => s.id), [...SLOT_IDS]);
  assert.ok(slots.every((s) => s.empty), 'a fresh store has twelve empty slots');

  // A different value in every slot, then all twelve read back.
  const written = [];
  for (const id of SLOT_IDS) {
    const tempo = 60 + id;
    store.set('global.tempo', tempo);
    const result = system.save(id, { name: `Patch ${id}` });
    assert.equal(result.ok, true, `slot ${id} saved: ${result.reason ?? ''}`);
    written.push(tempo);
  }
  for (const id of SLOT_IDS) {
    const doc = system.read(id);
    assert.ok(doc, `slot ${id} reads back`);
    assert.equal(doc.params['global.tempo'], written[id - 1], `slot ${id} holds its own value`);
    assert.equal(doc.name, `Patch ${id}`);
  }
  assert.equal(system.slots().filter((s) => !s.empty).length, 12);
  assert.equal(system.current(), 12, 'the last save is the patch the app returns to');
});

test('a slot can be renamed, deleted, and the next empty slot is found', () => {
  const { store, system } = harness();
  assert.equal(system.nextEmptySlot(), 1, 'the first of twelve is empty');
  store.set('global.tempo', 90);
  system.save(1, { name: 'One' });
  assert.equal(system.nextEmptySlot(), 2);

  system.save(2);
  system.save(3);
  assert.equal(system.rename(2, 'Renamed').ok, true);
  assert.equal(system.name(2), 'Renamed');
  assert.equal(system.nextEmptySlot(), 4, 'renaming does not fill a slot');

  assert.equal(system.remove(2).ok, true);
  assert.equal(system.read(2), null);
  assert.equal(system.nextEmptySlot(), 2, 'a deleted slot is empty again');
  assert.equal(system.remove(2).ok, true, 'and deleting an empty slot is not an error');
});

/* --------------------------------------------------------- the version gate --- */

test('a stored document whose version is bumped is a controlled fallback, never a partial apply', () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  distinctive(first.store);
  first.system.save(4, { name: 'From the future' });

  // Bump the stored document's version, leaving everything else — including the
  // distinctive parameters — exactly as it was.
  const envelope = JSON.parse(storage.raw()[STORAGE_KEY]);
  envelope.slots['4'].schemaVersion = SCHEMA_VERSION + 1;
  envelope.slots['4'].params['filter1.cutoff'] = 4242;
  storage.setItem(STORAGE_KEY, JSON.stringify(envelope));

  const second = harness({ storage });
  const result = second.system.restore();

  assert.equal(result.source, 'init', 'falls back to the init patch');
  assert.equal(result.reason, FAILURE_REASONS.VERSION_MISMATCH, 'with its own reason');
  assert.equal(second.store.get('filter1.cutoff'), defaults()['filter1.cutoff'], 'NOT partially applied');
  assert.notEqual(second.store.get('filter1.cutoff'), 4242);
  assert.equal(second.store.get('global.tempo'), defaults()['global.tempo'], 'no tempo leaked either');
  assert.deepEqual(second.store.get('seq.chainOrder'), defaults()['seq.chainOrder']);
});

test('a version mismatch in the container is refused before any slot is read', () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  distinctive(first.store);
  first.system.save(1);

  const envelope = JSON.parse(storage.raw()[STORAGE_KEY]);
  envelope.schemaVersion = SCHEMA_VERSION + 1;
  storage.setItem(STORAGE_KEY, JSON.stringify(envelope));

  const second = harness({ storage });
  const result = second.system.restore();
  assert.equal(result.source, 'init');
  assert.equal(result.reason, FAILURE_REASONS.VERSION_MISMATCH);
  assert.match(second.system.failures().at(-1).detail, /container|version/i);
  assert.equal(second.store.get('filter1.cutoff'), defaults()['filter1.cutoff']);
});

/* ----------------------------------------------------- the parse-error path --- */

test('unparseable stored data falls back to the init patch, records a reason and stays playable', () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  distinctive(first.store);
  first.system.save(2);

  storage.setItem(STORAGE_KEY, '{"schemaVersion":1,"current":2,"slots":{"2":{"params"');

  const second = harness({ storage });
  const result = second.system.restore();

  assert.equal(result.source, 'init');
  assert.equal(result.reason, FAILURE_REASONS.PARSE_ERROR);
  assert.deepEqual(result.failures.at(-1).reason, FAILURE_REASONS.PARSE_ERROR);
  assert.ok(result.failures.at(-1).detail.length > 0, 'the parser message is kept');

  // The init patch, exactly — and still playable: the transport, the bank and the kit.
  const expected = defaults();
  for (const key of RUNTIME_KEYS) delete expected[key];
  const actual = second.store.snapshot();
  for (const key of RUNTIME_KEYS) delete actual[key];
  assert.deepEqual(actual, expected);
  assert.equal(second.bank.patternCount(), 4, 'all four patterns still exist');
  assert.equal(second.bank.cell(0, 'bd', 0).on.length, 16, 'and still have sixteen steps');
  assert.equal(second.store.get('seq.bd.on.1'), expected['seq.bd.on.1'], 'the default groove is back');
});

/* -------------------------------------------------- validate before replace --- */

test('import validates before replacing anything: garbage leaves the instrument untouched', () => {
  const { store, bank, system } = harness();
  distinctive(store);
  const before = readBack(store, bank);

  const results = [
    system.importText('this is not json at all', { slot: 5 }),
    system.importText('[]', { slot: 5 }),
    system.importText('{"schemaVersion":1}', { slot: 5 }),
    system.importText(JSON.stringify({ ...system.capture('x'), schemaVersion: 99 }), { slot: 5 }),
    system.importText(JSON.stringify({ ...system.capture('x'), params: { 'filter1.cutoff': 900 } }), { slot: 5 }),
    system.importText(JSON.stringify({ ...system.capture('x'), patterns: [] }), { slot: 5 }),
    system.importText(JSON.stringify({ ...system.capture('x'), chainOrder: ['Z'] }), { slot: 5 }),
    system.importText(JSON.stringify({ ...system.capture('x'), wavetables: [{ slot: 'nope', samples: [] }] }), { slot: 5 }),
  ];

  const reasons = results.map((r) => r.reason);
  assert.ok(results.every((r) => r.ok === false), 'every one of them refused');
  assert.equal(reasons[0], FAILURE_REASONS.PARSE_ERROR, 'not JSON at all');
  assert.equal(reasons[3], FAILURE_REASONS.VERSION_MISMATCH, 'a bumped version is its own reason');
  for (const index of [1, 2, 4, 5, 6, 7]) {
    assert.equal(reasons[index], FAILURE_REASONS.INVALID_DOCUMENT, `case ${index}: unexpected reason ${reasons[index]}`);
  }

  // THE ASSERTION THAT MATTERS: not one value moved, and not one note moved either.
  assert.deepEqual(readBack(store, bank), before);
  assert.equal(store.get('filter1.cutoff'), 735);
  assert.equal(system.read(5), null, 'nothing was written to the target slot');
});

test('a valid import is applied in full and is an exact round trip', () => {
  const { store, bank, system } = harness();
  distinctive(store);
  const saved = readBack(store, bank);
  assert.equal(system.save(3, { name: 'Round Trip' }).ok, true);
  const exported = system.export(3);
  assert.equal(exported.ok, true, `export refused: ${exported.reason ?? ''}`);
  assert.match(exported.filename, /^atelier-.*round-trip\.json$/i, 'the filename carries the patch name');

  const document_ = JSON.parse(exported.text);
  assert.equal(document_.schemaVersion, SCHEMA_VERSION);
  assert.equal(document_.params['filter1.resonance'], 21.25);
  assert.equal(document_.tempo, 173);
  assert.equal(document_.swing, 68.5);
  assert.deepEqual(document_.chainOrder, ['C', 'A', 'D', 'C', 'B']);
  assert.equal(document_.patterns.length, 4, 'all four patterns are in the file');

  // Move a lot of things, then import the file back.
  store.patch({
    'global.tempo': 88,
    'global.swing': 51,
    'filter1.cutoff': 60,
    'osc1.waveform': 'sine',
    'eq.low': 12,
    'seq.chainOrder': ['A'],
    'matrix.lfo1.pitch': -100,
  });
  store.set('seq.pattern', 'A');
  store.set('seq.bd.on.1', false);
  assert.notDeepEqual(readBack(store, bank), saved);

  const imported = system.importText(exported.text, { slot: 3 });
  assert.equal(imported.ok, true, `import refused: ${imported.reason ?? ''} ${imported.detail ?? ''}`);
  assert.deepEqual(readBack(store, bank), saved, 'the original values return exactly');
  assert.equal(system.name(3), 'Round Trip');
});

/* ---------------------------------------------------------------- the quota --- */

test('quota exhaustion is a save failure with a visible reason, never a silent truncation', () => {
  const storage = fakeStorage();
  const { store, sampler, system } = harness({ storage });
  store.set('filter1.cutoff', 1234);
  const first = system.save(1, { name: 'Fits' });
  assert.equal(first.ok, true, 'the first patch fits');

  // A budget that holds a patch of parameters and nothing else: a loaded wavetable is
  // ~19 KB more on top of it, and the quota is what refuses it.
  storage.quotaBytes = Math.round(first.bytes * 1.5);
  const kept = JSON.parse(storage.raw()[STORAGE_KEY]).slots['1'].params['filter1.cutoff'];
  assert.equal(kept, 1234, 'the earlier slot is intact');

  sampler.load('warmSaw', { name: 'user:bright', sourceName: 'bright.wav', samples: wave() });
  const result = system.save(2, { name: 'Too big' });

  assert.equal(result.ok, false, 'the save failed');
  assert.equal(result.reason, FAILURE_REASONS.QUOTA_EXCEEDED);
  assert.ok(result.bytes > storage.quotaBytes, `the document really was ${result.bytes} bytes over a ${storage.quotaBytes} budget`);
  assert.ok(result.detail.length > 0, 'the reason is visible');

  const failure = system.failures().at(-1);
  assert.equal(failure.reason, FAILURE_REASONS.QUOTA_EXCEEDED);
  assert.equal(failure.slot, 2);

  const envelope = JSON.parse(storage.raw()[STORAGE_KEY]);
  assert.equal(envelope.slots['1'].params['filter1.cutoff'], 1234, 'the earlier slot survived untouched');
  assert.equal(envelope.slots['2'], undefined, 'and nothing was truncated into slot 2');
  assert.equal(system.read(2), null);
});

/* ------------------------------------------------------- reload, in general --- */

test('a saved patch survives a full reload: parameters, four patterns, chain order, swing and tempo', () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  distinctive(first.store);
  first.system.save(6, { name: 'Survivor' });
  const before = readBack(first.store, first.bank);

  /* A reload is a fresh store, a fresh bank and a fresh system over the same
     localStorage — which is exactly what the browser does on F5. */
  const second = harness({ storage });
  const result = second.system.restore();

  assert.equal(result.source, 'slot');
  assert.equal(result.slot, 6);
  assert.deepEqual(readBack(second.store, second.bank), before, 'an exact match, not an approximate one');

  assert.equal(second.store.get('global.tempo'), 173);
  assert.equal(second.store.get('global.swing'), 68.5);
  assert.deepEqual(second.store.get('seq.chainOrder'), ['C', 'A', 'D', 'C', 'B']);
  assert.equal(second.store.get('seq.chain'), true);
  assert.equal(second.store.get('seq.pattern'), 'C');

  // All four patterns, each distinguishable, and the flat keys show pattern C's step.
  /* Patterns A and B were never edited, so each must come back as the init patch's steps
     rather than as one pattern copied four times; C and D each kept their own edit. */
  const init = defaults();
  const initLane = (lane, field) => Array.from({ length: 16 }, (_u, i) => init[`seq.${lane}.${field}.${i + 1}`]);
  const [a, b, c, d] = second.bank.snapshot();
  assert.deepEqual(a.lanes.bd.on, initLane('bd', 'on'), 'pattern A is the init patch');
  assert.deepEqual(b.lanes.bd.on, initLane('bd', 'on'), 'pattern B is the init patch, independently');
  assert.deepEqual(b.lanes.cy.on, initLane('cy', 'on'), 'and pattern B did not pick up C\'s step');
  assert.equal(c.lanes.cy.on[6], true, "pattern C's distinctive step survived");
  assert.equal(c.lanes.cy.vel[6], 43);
  assert.equal(c.lanes.melody.note[2], 71);
  assert.equal(c.lanes.melody.gate[2], 88);
  assert.equal(d.lanes.bd.on[11], true, "pattern D's step survived");
  assert.equal(d.lanes.bd.vel[11], 17);
  assert.equal(b.lanes.bd.on[11], false, "and it did not leak into pattern B");
  assert.equal(second.store.get('seq.cy.on.7'), true, 'and the flat editing view is pattern C');
});

test('loading copies the values and leaves the slot untouched — copy-on-load, so revert is load again', () => {
  const { store, system } = harness();
  distinctive(store);
  system.save(1, { name: 'Copy On Load' });
  const stored = system.read(1);

  // Edit after loading, and the stored document must not move.
  store.set('global.tempo', 90);
  store.set('filter1.cutoff', 3000);
  assert.equal(system.read(1).params['global.tempo'], 173, 'the slot did not track the knobs');
  assert.deepEqual(system.read(1), stored);

  const loaded = system.load(1);
  assert.equal(loaded.ok, true);
  assert.equal(store.get('global.tempo'), 173);
  assert.equal(store.get('filter1.cutoff'), 735);
  assert.deepEqual(system.read(1), stored, 'and loading did not rewrite it either');
});

test('the transport, the power switch and the playhead are the clock’s state, not patch data', () => {
  const { store, system } = harness();
  system.save(1);
  assert.ok(!('global.power' in system.read(1).params), 'power is not stored');
  assert.ok(!('global.run' in system.read(1).params), 'the transport is not stored');
  assert.ok(!('seq.step' in system.read(1).params), 'the playhead is not stored');
  assert.deepEqual([...RUNTIME_KEYS], ['global.power', 'global.run', 'seq.step']);

  store.patch({ 'global.power': true, 'global.run': true, 'seq.step': 11 });
  system.load(1);
  assert.equal(store.get('global.power'), true, 'loading a patch never switches the instrument off');
  assert.equal(store.get('global.run'), true, 'and never stops the transport');
  assert.equal(store.get('seq.step'), 11, 'nor rewinds the playhead');
});

/* -------------------------------------------------------- user wavetables --- */

test('user-loaded wavetables are stored as the resampled table and restored into their slot', () => {
  const { store, system, sampler } = harness();
  sampler.load('warmSaw', { name: 'user:bright', sourceName: 'bright.wav', samples: wave(2048, 0) });
  sampler.load('reed', { name: 'user:reed2', sourceName: 'reed2.wav', samples: wave(2048, 90) });
  store.set('wave.level', 0.5);
  const saved = system.save(9, { name: 'With Waves' });

  const doc = system.read(9);
  assert.equal(doc.wavetables.length, 2, 'only the two loaded tables; factory waves are regenerated');
  assert.deepEqual(doc.wavetables.map((t) => t.slot).sort(), ['reed', 'warmSaw']);
  for (const table of doc.wavetables) {
    assert.equal(table.samples.length, 2048, 'the 2048-point resampled table, not the source file');
    assert.ok(table.samples.every((v) => typeof v === 'number' && Number.isFinite(v)));
  }

  const other = harness();
  const imported = other.system.importText(JSON.stringify(doc), { slot: 2 });
  assert.equal(imported.ok, true, `import refused: ${imported.reason ?? ''} ${imported.detail ?? ''}`);
  for (const table of doc.wavetables) {
    const back = other.sampler.serialize(table.slot);
    assert.equal(back.name, table.name, `${table.slot} came back`);
    assert.deepEqual(back.samples, table.samples, `${table.slot} is bit-identical`);
  }
  assert.ok(saved.bytes > 20000, `one two-table document is ${saved.bytes} bytes`);
});

test('a wavetable is stored under the slot it occupies, not the selected one', () => {
  /* `waveSampler.serialize(slot)` fills its document's own `slot` field with the
     CURRENTLY SELECTED slot, so a capture that trusted that field would file a table
     loaded into slot 1 under whichever slot the patch happened to be auditioning — and
     `restore()` puts a document back exactly where its `slot` says. `tables()` is the
     authority on where a table sits. */
  const { store, sampler, system } = harness();
  sampler.load('warmSaw', { name: 'user:first', sourceName: 'first.wav', samples: wave() });
  sampler.load('glass', { name: 'user:fourth', sourceName: 'fourth.wav', samples: wave(2048, 45) });
  store.set('wave.table', 'reed');            // a third slot, selected, holding a factory wave
  system.save(2);

  const doc = system.read(2);
  assert.deepEqual(doc.wavetables.map((t) => t.slot).sort(), ['glass', 'warmSaw']);
  assert.deepEqual(doc.wavetables.map((t) => t.name).sort(), ['user:first', 'user:fourth']);

  // And they come back into the slots they left, not into the selected one.
  const other = harness();
  assert.equal(other.system.importText(JSON.stringify(doc), { slot: 5 }).ok, true);
  assert.equal(other.sampler.serialize('warmSaw').name, 'user:first');
  assert.equal(other.sampler.serialize('glass').name, 'user:fourth');
  assert.equal(other.sampler.serialize('reed'), null, 'the selected slot was never holding one');
});

test('a document with no user table says nothing about tables, so a hand-loaded wave is left alone', () => {
  const storage = fakeStorage();
  const { store, system } = harness({ storage });
  store.set('global.tempo', 100);
  system.save(1);
  assert.equal(system.read(1).wavetables.length, 0, 'nothing was loaded, so nothing is stored');

  // A browser with a table in a slot, importing a document that carries none: the wave
  // stays. Storing factory waves instead would cost ~76 KB per slot to save the trouble.
  const other = harness();
  other.sampler.load('glass', { name: 'user:keep', sourceName: 'keep.wav', samples: wave() });
  const result = other.system.importText(JSON.stringify(system.read(1)), { slot: 4 });
  assert.equal(result.ok, true, `import refused: ${result.reason ?? ''} ${result.detail ?? ''}`);
  assert.equal(other.sampler.serialize('glass').name, 'user:keep', 'the hand-loaded wave is untouched');
  assert.equal(other.sampler.serialize('warmSaw'), null, 'and no slot was invented');
});

/* ------------------------------------------------------- reasons are distinct --- */

test('every failure path records a distinct, visible reason', () => {
  const storage = fakeStorage();
  const { system } = harness({ storage });
  const seen = new Map();

  const record = (which, result) => {
    if (result.ok) return;
    const failure = which.failures().at(-1);
    assert.equal(failure.reason, result.reason, 'the returned reason and the recorded one agree');
    assert.equal(seen.has(failure.reason), false, `reason "${failure.reason}" is not distinct`);
    seen.set(failure.reason, failure.detail);
  };

  // 1. schema-version mismatch
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 99, current: 1, slots: {} }));
  const mismatched = harness({ storage }).system;
  record(mismatched, mismatched.restore());

  // 2. JSON parse error
  storage.setItem(STORAGE_KEY, 'not json');
  const unparseable = harness({ storage }).system;
  record(unparseable, unparseable.restore());

  // 3. structurally invalid
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, current: 1, slots: { 1: { schemaVersion: 1 } } }));
  const malformed = harness({ storage }).system;
  record(malformed, malformed.restore());

  // 4. quota exhaustion
  const tiny = harness({ storage: fakeStorage({ quotaBytes: 10 }) });
  record(tiny.system, tiny.system.save(1));

  // 5. no storage at all — the sequencer is attached, so this is only a storage failure
  const none = harness({ storage: null }).system;
  record(none, none.restore());

  // 6. no sequencer attached: patterns are unreachable, so it is refused, not guessed at
  const unbound = createPresetSystem({ store: createStore(SCHEMA), storage: fakeStorage(), sampler: fakeSampler(), key: STORAGE_KEY });
  record(unbound, unbound.restore());

  assert.deepEqual(
    [...seen.keys()].sort(),
    [
      FAILURE_REASONS.INVALID_DOCUMENT,
      FAILURE_REASONS.NOT_BOUND,
      FAILURE_REASONS.PARSE_ERROR,
      FAILURE_REASONS.QUOTA_EXCEEDED,
      FAILURE_REASONS.STORAGE_UNAVAILABLE,
      FAILURE_REASONS.VERSION_MISMATCH,
    ].sort(),
    'six failure paths, six reasons, none of them "something went wrong"',
  );

  // 7. a store that refuses writes for a reason that is not a quota
  const hostile = fakeStorage();
  hostile.setItem = () => {
    const error = new Error('The operation is insecure.');
    error.name = 'SecurityError';
    throw error;
  };
  const denied = harness({ storage: hostile }).system;
  record(denied, denied.save(1));

  // 8. the stored pointer naming a slot with nothing in it
  const pointer = fakeStorage();
  const pointed = harness({ storage: pointer });
  pointed.store.set('global.tempo', 140);
  pointed.system.save(5);
  pointed.system.remove(5);
  const afterDelete = harness({ storage: pointer }).system;
  record(afterDelete, afterDelete.restore());

  // 9. loading an empty slot is its own thing too.
  record(system, system.load(11));

  /* Every reason in the vocabulary is exercised above, so the list cannot grow a member
     without someone noticing that nothing records it, and each one is its own string. */
  assert.deepEqual([...seen.keys()].sort(), [...FAILURE_LIST].sort());
  assert.equal(seen.size, FAILURE_LIST.length, 'one scenario per reason, no reason unrecorded');
  for (const detail of seen.values()) assert.ok(detail.length > 0, 'a reason carries a detail');
});

test('a corrupt store does not fill the log with the same sentence once per read', () => {
  /* The preset panel re-reads the store on every repaint, so an undeduplicated read would
     push the same diagnosis into a bounded log and drown it. */
  const storage = fakeStorage();
  storage.setItem(STORAGE_KEY, 'not json');
  const { system } = harness({ storage });
  system.restore();
  for (let i = 0; i < 40; i += 1) system.slots();
  assert.equal(system.failures().length, 1, 'one diagnosis, not forty');
  assert.equal(system.failures()[0].reason, FAILURE_REASONS.PARSE_ERROR);

  // A DIFFERENT diagnosis always records, so the log still tells you what changed.
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 9, slots: {} }));
  system.slots();
  assert.deepEqual(system.failures().map((f) => f.reason), [FAILURE_REASONS.PARSE_ERROR, FAILURE_REASONS.VERSION_MISMATCH]);
});

test('failures are bounded, cleared on request, and read back newest-last', () => {
  const { system } = harness();
  system.importText('nope', {});
  system.importText('still nope', {});
  assert.equal(system.failures().length, 2);
  assert.equal(system.failures().at(-1).detail.includes('still nope'), true, 'newest last');

  /* No wall clock. tests/clock.test.mjs fails any wall-clock read in web/ outside a
     three-entry allowlist, so nothing here stamps a date it would have to invent — the
     order is the array's, and `at` is null unless a caller injects a clock. */
  assert.equal(system.failures().every((entry) => entry.at === null), true, 'no invented timestamp');
  let tick = 0;
  const stamped = createPresetSystem({
    store: createStore(SCHEMA),
    storage: fakeStorage(),
    key: STORAGE_KEY,
    now: () => `t${(tick += 1)}`,
  });
  stamped.importText('nope', {});
  assert.equal(stamped.failures().at(-1).at, 't1', 'and an injected clock is used when there is one');

  for (let i = 0; i < 60; i += 1) system.importText(`nope ${i}`, {});
  assert.equal(system.failures().length, MAX_RECORDED_FAILURES, 'bounded, so a page left open cannot grow it');
  assert.equal(system.clearFailures(), MAX_RECORDED_FAILURES);
  assert.equal(system.failures().length, 0);
});

test('a restore with nothing stored loads the init patch and is not called a failure', () => {
  const { store, system } = harness();
  const result = system.restore();
  assert.equal(result.source, 'init');
  assert.equal(result.reason, undefined, 'a first visit is not a failure');
  assert.equal(system.failures().length, 0);
  assert.equal(store.get('global.tempo'), 120);
});

test('saving before anything is bound is refused, not silently written without patterns', () => {
  const system = createPresetSystem({ store: createStore(SCHEMA), storage: fakeStorage(), key: STORAGE_KEY });
  const result = system.save(1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, FAILURE_REASONS.NOT_BOUND);
  assert.equal(system.read(1), null);
});

test('storageInfo reports the key and the bytes in use', () => {
  const { store, system } = harness();
  store.set('global.tempo', 150);
  system.save(1);
  const info = system.storageInfo();
  assert.equal(info.key, STORAGE_KEY);
  assert.equal(info.slotsUsed, 1);
  assert.ok(info.bytes > 1000, `one patch is ${info.bytes} bytes`);
  assert.ok(info.perSlot, 'and the per-slot figure is what the UI quotes');
});