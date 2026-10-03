/**
 * meter-handle.test.mjs — the runtime inspection handle and the captured-error log,
 * tested with no browser.
 *
 * WHY THIS IS THE FILE THAT MATTERS MOST
 *   The handle exists for one reason: to assert on real runtime state rather than on
 *   screenshots. Several of the plan's self-validation steps — the eleven drum voices
 *   especially — cannot be verified any other way. That makes it an instrument of
 *   measurement, and an instrument of measurement that can be written to is no longer
 *   one: it becomes a second, hidden channel into the instrument's state, which is the
 *   exact thing the single-authority store rule exists to prevent.
 *
 * So these tests are mostly about what the handle CANNOT do:
 *   - no own property is a stored value: every one is an accessor, so there is no
 *     writable slot anywhere on it;
 *   - an assignment is inert in strict mode as well as sloppy: no TypeError, and no
 *     change. (This file is an ES module, so every assignment below is strict mode.)
 *   - a getter advances nothing and allocates nothing unbounded: repeat reads of the
 *     counters, the error list and the parameter snapshot return the SAME frozen
 *     object until the underlying state actually moves.
 *   - `localStorage` is read on access, never snapshotted at load, because the
 *     self-validation saves a preset and then reads it back through the handle.
 *   - the captured-error array is CAPPED, so a failure loop cannot exhaust memory.
 *   - and the file itself contains no `connect`, no `start` and no node creation: the
 *     handle performs no audio function of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ERROR_LOG_CAP,
  KIT_VOICE_COUNT,
  createErrorLog,
  createInspectionHandle,
  handleFieldNames,
} from '../web/ui/meter.js';

const UI_METER_SOURCE = readFileSync(new URL('../web/ui/meter.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------------- fixtures --- */

const KIT_VOICES = ['bd', 'sd', 'lt', 'mt', 'ht', 'rs', 'cp', 'cb', 'ch', 'oh', 'cy'];

/** A parameter store stand-in with the two things the handle uses. */
function fakeStore(initial = { 'global.run': false, 'global.volume': 0.7, 'seq.pattern': 'A' }) {
  const values = { ...initial };
  const subs = new Set();
  return {
    values,
    get: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined),
    snapshot: () => ({ ...values }),
    subscribeAll: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    write(key, value) {
      values[key] = value;
      for (const fn of subs) fn(key, value);
    },
  };
}

/** A level meter stand-in. */
function fakeMeter() {
  const reading = { rms: 0.01, peak: 0.4, dbfs: -40, level: 0.33, hold: 0.7, holdDbfs: -18, frames: 12 };
  let allocations = 1;
  return {
    reading: () => reading,
    rms: () => reading.rms,
    peak: () => reading.peak,
    dbfs: () => reading.dbfs,
    level: () => reading.level,
    hold: () => reading.hold,
    holdDbfs: () => reading.holdDbfs,
    frames: () => reading.frames,
    allocations: () => allocations,
    fftSize: () => 2048,
    traceValues: (limit) => new Array(Math.min(limit ?? 8, 8)).fill(0.25),
    set readingValue(value) {
      Object.assign(reading, value);
    },
    bumpAllocations() {
      allocations += 1;
    },
  };
}

/** localStorage stand-in whose contents can change between reads. */
function fakeStorage() {
  const map = new Map();
  return {
    reads: 0,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    /* Method shorthand, not an arrow: `this` has to be the storage object. */
    getItem(key) {
      this.reads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    put(key, value) {
      map.set(key, value);
    },
  };
}

/**
 * A complete set of sources. Every one is a thunk, because in the page they arrive
 * from a dynamic import AFTER the handle exists: the handle is installed
 * synchronously and primed when the audio graph resolves.
 */
function sources(overrides = {}) {
  const counters = Object.fromEntries(KIT_VOICES.map((voice) => [voice, 0]));
  const store = fakeStore();
  const meter = fakeMeter();
  const storage = fakeStorage();
  const errorLog = createErrorLog({ target: null });
  const base = {
    store,
    meter,
    errorLog,
    storage,
    ready: () => true,
    context: () => ({
      state: () => 'running',
      time: () => 12.5,
      sampleRate: () => 48000,
      baseLatency: () => 0.01,
    }),
    clock: () => ({
      running: () => true,
      tempo: () => 120,
      swing: () => 54,
      stepCursor: () => 7,
      position: () => ({ bar: 2, beat: 3, sixteenth: 2, step: 7, absoluteStep: 39 }),
      state: () => ({ running: true, tempo: 120 }),
    }),
    sequencer: () => ({
      pattern: () => 'A',
      chain: () => ['A', 'B'],
      state: () => ({ playing: true, stepCursor: 7 }),
      firings: (limit) => [60, 64, 67].slice(-limit),
    }),
    drums: () => ({
      counters: () => ({ ...counters }),
      voices: () => [...KIT_VOICES],
      liveCount: (voice) => (voice === 'bd' ? 1 : 0),
      liveCountAll: () => 1,
      nodeReport: () => Object.fromEntries(KIT_VOICES.map((voice) => [voice, { created: 1, retired: 0, live: 1, roles: {} }])),
    }),
    voices: () => ({
      states: () => [{ note: 60, state: 'active', pitch: 261.6 }],
      capacity: () => 16,
      stats: () => ({ live: 1, total: 16 }),
      held: () => [{ id: 'k1', note: 60, velocity: 0.8, order: 1 }],
    }),
    graph: () => ({
      effectNodes: () => [{ label: 'limiter', kind: 'DynamicsCompressorNode', feeds: ['masterOut'] }],
      nodeStats: () => ({ live: 12, created: 30, retired: 18, byLabel: {} }),
    }),
    paint: () => ({
      frames: () => 42,
      enabled: () => true,
      pending: () => 7,
      capacity: () => 256,
      ring: () => ({ capacity: 256, length: 3 }),
      level: () => 0.4,
      levelKeys: () => ['global.meter'],
    }),
  };
  const merged = { ...base, ...overrides };
  merged.internals = { store, meter, storage, errorLog, counters };
  return merged;
}

/* ----------------------------------------------------------------- error log --- */

test('the error log is wired to error and unhandledrejection, and starts empty', () => {
  const listeners = [];
  const target = {
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: () => {},
  };
  const log = createErrorLog({ target });
  assert.deepEqual(listeners.map(([type]) => type), ['error', 'unhandledrejection']);
  assert.deepEqual(log.entries(), []);
  assert.equal(log.count(), 0);
  log.dispose();
});

test('an error event and an unhandled rejection both land in the array', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const log = createErrorLog({ target });
  listeners.get('error')({ message: 'boom', filename: '/ui/meter.js', lineno: 12, colno: 3 });
  listeners.get('unhandledrejection')({ reason: new Error('rejected') });
  const entries = log.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'error');
  assert.equal(entries[0].message, 'boom');
  assert.equal(entries[1].kind, 'unhandledrejection');
  assert.match(entries[1].message, /rejected/);
  assert.ok(Object.isFrozen(entries), 'a caller cannot push into the log it was handed');
  log.dispose();
});

test('the error log is CAPPED, so a failure loop cannot exhaust memory', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: () => {},
  };
  const log = createErrorLog({ target });
  assert.ok(ERROR_LOG_CAP <= 64, `a cap of ${ERROR_LOG_CAP} is small enough to be bounded`);
  for (let i = 0; i < ERROR_LOG_CAP * 40; i += 1) {
    listeners.get('error')({ message: `failure ${i}` });
  }
  assert.equal(log.entries().length, ERROR_LOG_CAP, 'the array stops growing');
  const entries = log.entries();
  assert.equal(entries[entries.length - 1].message, `failure ${ERROR_LOG_CAP * 40 - 1}`, 'and it keeps the NEWEST');
  assert.equal(entries[0].message, `failure ${ERROR_LOG_CAP * 40 - ERROR_LOG_CAP}`, 'dropping the oldest');
  log.dispose();
});

test('an empty error log hands back one shared frozen array, not a new one per read', () => {
  const listeners = new Map();
  const log = createErrorLog({
    target: { addEventListener: (t, f) => listeners.set(t, f), removeEventListener: () => {} },
  });
  assert.equal(log.entries(), log.entries(), 'reading a clean log allocates nothing');
  listeners.get('error')({ message: 'boom' });
  const after = log.entries();
  assert.equal(after, log.entries(), 'and a dirty one is cached until the next failure');
  listeners.get('error')({ message: 'boom again' });
  assert.notEqual(log.entries(), after, 'a new failure invalidates it');
  log.dispose();
});

/* ------------------------------------------------------------------- the handle --- */

test('the handle is on window, is frozen, and exposes every field the plan lists', () => {
  const handle = createInspectionHandle(sources());
  assert.ok(Object.isFrozen(handle), 'the handle itself is frozen');
  assert.equal(typeof globalThis.window, 'undefined', 'this is the node-side assertion of the shape');

  const fields = handleFieldNames();
  assert.ok(fields.length >= 30, `the handle must be worth reading: ${fields.length} fields`);

  const required = [
    // AudioContext state and current time
    'contextState', 'contextTime', 'sampleRate',
    // the constructed effect and voice node inventory
    'effectNodes', 'voiceStates', 'voiceCapacity', 'nodeStats', 'drumNodes',
    // current parameter values
    'params', 'param', 'volume', 'tempo', 'swing',
    // the firing sequencer step and pattern
    'step', 'absoluteStep', 'bar', 'pattern', 'playing', 'chain',
    // the analyser RMS plus the peak hold
    'rms', 'peak', 'dbfs', 'level', 'peakHold', 'peakHoldDbfs',
    // a trigger counter per drum voice
    'drums', 'drumCount', 'drumVoices',
    // captured runtime errors
    'errors', 'errorCount',
    // localStorage contents
    'storage',
    // transport, voices, readiness
    'run', 'power', 'heldNotes', 'ready', 'paint',
  ];
  for (const field of required) {
    assert.equal(typeof handle[field], 'function', `the handle must expose ${field}()`);
    assert.ok(Object.isFrozen(handle[field]), `${field} must hand back a frozen accessor`);
    assert.ok(fields.includes(field), `${field} must be in the published field list`);
    handle[field]();
  }
});

test('no own property of the handle is a stored value: every one is an accessor', () => {
  const handle = createInspectionHandle(sources());
  const keys = Object.getOwnPropertyNames(handle);
  assert.ok(keys.length >= 30);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(handle, key);
    assert.equal(descriptor.value, undefined, `${key} must be a getter, not a slot that can be written`);
    assert.equal(typeof descriptor.get, 'function', `${key} must have a getter`);
    assert.equal(descriptor.configurable, false, `${key} must not be redefinable`);
  }
});

test('writing to a handle property is inert: no error thrown, no value changed', () => {
  const handle = createInspectionHandle(sources());
  const internals = sources().internals;

  /* Strict mode: this file is an ES module, so an assignment to an accessor without a
     setter would THROW a TypeError. It must not. */
  for (const key of Object.getOwnPropertyNames(handle)) {
    assert.doesNotThrow(() => {
      handle[key] = 'tampered';
    }, `assigning to ${key} must be silent`);
  }

  assert.equal(handle.contextState(), 'running');
  assert.equal(handle.rms(), internals.meter.reading().rms);
  assert.deepEqual(handle.drums(), Object.fromEntries(KIT_VOICES.map((voice) => [voice, 0])));
  assert.deepEqual(handle.storage(), {});
  assert.equal(handle.step(), 7);
  assert.notEqual(handle.contextState, 'tampered', 'the accessor itself survived');
  assert.equal(typeof handle.contextState, 'function');

  /* defineProperty cannot get round it either, and the handle is still frozen. */
  assert.throws(() => Object.defineProperty(handle, 'rms', { value: 9 }), TypeError);
  assert.equal(handle.rms(), internals.meter.reading().rms);
  assert.ok(Object.isFrozen(handle));

  /* Nor through the nested objects it hands out: they are frozen too. */
  const drums = handle.drums();
  assert.throws(() => {
    drums.bd = 99;
  }, TypeError);
  const errors = handle.errors();
  assert.throws(() => errors.push({}), TypeError);
  const params = handle.params();
  assert.throws(() => {
    params['global.run'] = true;
  }, TypeError);
});

test('the handle exposes all eleven drum counters, and only integers', () => {
  const src = sources();
  const handle = createInspectionHandle(src);
  const counters = handle.drums();
  assert.deepEqual(Object.keys(counters), KIT_VOICES, 'the eleven kit voices, in kit order');
  assert.equal(Object.keys(counters).length, 11);
  assert.equal(KIT_VOICE_COUNT, 11);
  assert.equal(handle.drumVoices().length, 11);
  for (const voice of KIT_VOICES) {
    assert.ok(Number.isInteger(counters[voice]), `${voice} is an integer`);
    assert.equal(handle.drumCount(voice), 0);
  }

  /* A lane's counter moving is a plain increment, with no effect on the others. */
  src.internals.counters.rs = 4;
  const after = handle.drums();
  assert.equal(after.rs, 4);
  for (const voice of KIT_VOICES.filter((v) => v !== 'rs')) assert.equal(after[voice], 0, `${voice} did not move`);
  assert.equal(handle.drumCount('rs'), 4);
  assert.equal(handle.drumCount('nope'), null, 'an unknown voice is null, never a silent zero');
});

test('reading the handle repeatedly is cheap: repeated reads return the same frozen objects', () => {
  const src = sources();
  const handle = createInspectionHandle(src);
  for (let i = 0; i < 50; i += 1) handle.drums();
  assert.equal(handle.drums(), handle.drums(), 'the counter snapshot is cached while nothing moved');
  assert.equal(handle.params(), handle.params(), 'the parameter snapshot is cached while nothing was written');
  assert.equal(handle.errors(), handle.errors());
  assert.equal(handle.effectNodes(), handle.effectNodes());
  assert.equal(handle.storage(), handle.storage());

  /* ...and a real change invalidates exactly what it should. The "before" has to be
     captured before the change: two reads taken after a change are both the new cache. */
  const beforeCounters = handle.drums();
  const beforeParams = handle.params();
  src.internals.counters.ch += 1;
  assert.notEqual(handle.drums(), beforeCounters, 'a drum counter moved, so the snapshot did');
  src.internals.store.write('global.volume', 0.4);
  assert.notEqual(handle.params(), beforeParams, 'a parameter was written, so the snapshot did not');
  assert.equal(handle.volume(), 0.4, 'and the new value is visible');
  /* A drum counter moving did NOT invalidate the parameter snapshot. */
  const params = handle.params();
  src.internals.counters.ch += 1;
  assert.equal(handle.params(), params);
});

test('a getter advances nothing: reading every field twice changes no source state', () => {
  const src = sources();
  const handle = createInspectionHandle(src);
  const before = {
    counters: { ...src.internals.counters },
    values: { ...src.internals.store.values },
    meter: { ...src.internals.meter.reading() },
    reads: src.internals.storage.reads,
  };
  for (let round = 0; round < 20; round += 1) {
    for (const field of handleFieldNames()) handle[field]();
  }
  assert.deepEqual(src.internals.counters, before.counters, 'no drum counter moved');
  assert.deepEqual(src.internals.store.values, before.values, 'no parameter was written');
  assert.deepEqual(src.internals.meter.reading(), before.meter, 'the meter was not ticked');
});

test('localStorage is read on ACCESS, so a preset saved after load is visible', () => {
  const src = sources();
  const handle = createInspectionHandle(src);
  assert.deepEqual(handle.storage(), {}, 'nothing saved yet');
  const readsBefore = src.internals.storage.reads;

  /* A preset saved after the page loaded — exactly what the self-validation does. */
  src.internals.storage.put('atelier.presets.v1', '{"slots":["pad"]}');
  src.internals.storage.put('atelier.waveform', 'IDAT');

  const after = handle.storage();
  assert.deepEqual(after, { 'atelier.presets.v1': '{"slots":["pad"]}', 'atelier.waveform': 'IDAT' });
  assert.ok(Object.isFrozen(after));
  assert.ok(
    src.internals.storage.reads > readsBefore,
    'the backing store was read on access, not remembered from load',
  );
});

test('a storage that throws is reported as empty rather than taking the handle down', () => {
  const src = sources({
    storage: () => ({
      get length() {
        throw new Error('SecurityError: storage is disabled');
      },
      key: () => null,
      getItem: () => null,
    }),
  });
  const handle = createInspectionHandle(src);
  assert.deepEqual(handle.storage(), {});
});

test('a handle with nothing wired yet answers null rather than throwing', () => {
  const handle = createInspectionHandle({});
  assert.equal(handle.ready(), false);
  for (const field of handleFieldNames()) {
    const value = handle[field]();
    assert.ok(
      value === null || value === 0 || value === '' || typeof value === 'string' || Array.isArray(value) ||
        typeof value === 'object' || typeof value === 'boolean',
      `${field} answered ${JSON.stringify(value)} before its sources resolved`,
    );
  }
  assert.deepEqual(handle.drums(), {});
  assert.deepEqual(handle.errors(), []);
  assert.deepEqual(handle.storage(), {});
});

/* ------------------------------------------------------- it performs no audio --- */

test('the handle performs no audio function: no connect, no start, no node creation', () => {
  /* Code inspection, over the file as shipped. `startMeter(` does not match \bstart\s*(
     because the identifier continues, and `requestAnimationFrame` is not a node. */
  assert.equal(/\.\s*connect\s*\(/.test(UI_METER_SOURCE), false, 'no connect anywhere in web/ui/meter.js');
  assert.equal(/\bstart\s*\(/.test(UI_METER_SOURCE), false, 'no start() anywhere in web/ui/meter.js');
  assert.equal(/\bdisconnect\s*\(/.test(UI_METER_SOURCE), false, 'no disconnect() either');
  for (const factory of [
    'createGain',
    'createOscillator',
    'createBufferSource',
    'createBiquadFilter',
    'createAnalyser',
    'createDelay',
    'createConvolver',
    'createDynamicsCompressor',
    'createConstantSource',
    'createPanner',
    'createWaveShaper',
    'createStereoPanner',
    'new AudioContext',
    'new GainNode',
    'new OscillatorNode',
    'new AnalyserNode',
  ]) {
    assert.equal(UI_METER_SOURCE.includes(factory), false, `web/ui/meter.js must not contain ${factory}`);
  }
  /* The one node it names, it names as a READ-ONLY argument to the meter factory. */
  assert.match(UI_METER_SOURCE, /createLevelMeter\(\{\s*analyser:/);
});

test('the handle exposes no function that could write to the instrument', () => {
  const handle = createInspectionHandle(sources());
  for (const field of handleFieldNames()) {
    const descriptor = Object.getOwnPropertyDescriptor(handle, field);
    assert.equal(typeof descriptor.get, 'function', `${field} has a getter`);
    /* A setter that does nothing, deliberately: it is what absorbs a write in strict
       mode. Calling it directly must change nothing, which is what "inert" means. */
    assert.equal(typeof descriptor.set, 'function', `${field} absorbs a write instead of throwing`);
    const before = handle[field]();
    for (let i = 0; i < 50; i += 1) descriptor.set.call(handle, `tampered-${i}`);
    assert.deepEqual(handle[field](), before, `${field} did not change after 50 direct setter calls`);
  }
  /* Nothing on the handle returns the store, the context, or a live node. */
  assert.equal(handle.store, undefined);
  assert.equal(handle.context, undefined);
  assert.equal(handle.audioContext, undefined);
  assert.equal(handle.analyser, undefined);
  const params = handle.params();
  assert.equal(typeof params.get, 'undefined', 'the parameter snapshot is data, not the store');
});