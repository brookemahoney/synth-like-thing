/**
 * params.js — THE parameter store. The single authority for every value in the
 * instrument. Nothing else keeps a copy: UI reads/writes here, audio reads
 * here, presets read/write here. If a module caches a value it read, that is a bug.
 *
 * API
 *   store.get(key)            -> value
 *   store.set(key, value, meta?) -> the value actually stored (clamped/coerced)
 *        meta = { source, apply }  `source` labels the writer ('control', 'preset',
 *        'test'...); `apply` is 'ramp' | 'direct', a hint consumed by the audio ramp
 *        bridge (audio/ramp.js) and ignored by the store itself. Absent `apply`
 *        means "the bridge's binding decides".
 *   store.subscribe(key, fn)  -> unsubscribe   fn(key, value, previous, meta)
 *   store.subscribe(fn)       -> unsubscribe   subscribeAll(fn): fn(key, value, previous, meta)
 *   store.subscribeAll(fn)    -> unsubscribe
 *   store.patch({key: value}) -> write a whole patch (presets, init patches)
 *   store.keys()              -> string[]      every declared key, in schema order
 *   store.schema(key)         -> the schema entry (range, curve, unit, kind, options)
 *   store.has(key)            -> boolean
 *   store.snapshot()          -> { key: value } fresh flat object (presets, inspection)
 *   defaults()                -> { key: default } fresh init patch
 *   createStore(schema)       -> an isolated store with the same behaviour (tests)
 *
 * RANGE / CLAMPING
 *   The schema owns ranges, curves and units. `set` is the only writer and it
 *   always clamps, rounds and coerces, so a control physically cannot put a
 *   value outside its declared range. A value outside an enum is rejected and
 *   the previous value is kept. An undeclared key is stored verbatim (warned
 *   once) so a later task can add a key without a coordinated edit.
 *
 * KEY NAMESPACE (flat, dotted — every key lives in this list)
 *   global.*            power, volume, tempo, swing, run, latch, polyphony,
 *                       keyboardMode, triggerMode, octave, bendRange, chorus.*
 *   osc1|2|3.*          waveform, octave, semitone, detune, level, fmAmount,
 *                       fmSource, unison, unisonSpread, ringMod
 *   wave.*              table, level, scan                (wavesampler)
 *   mixer.level
 *   filter1|2.*         type, cutoff, resonance, drive, keyTrack, bypass
 *   envAmp.*            attack, decay, sustain, release
 *   envFilter.*         attack, decay, sustain, release   (NO amount knob: the
 *                       modulation-matrix route is the filter-env amount)
 *   lfo1|2|3.*          wave, rate, sync, rateSync, fadeIn, on
 *   matrix.<src>.<dst>  8 x 8 = 64 bipolar depths -100..100.
 *                       src: lfo1 lfo2 lfo3 ampEnv filterEnv velocity keyTrack random
 *                       dst: pitch fmAmount unisonSpread cutoff1 cutoff2 ampLevel
 *                            delayTime reverbSend
 *   eq.low|eq.mid|eq.high
 *   delay.*             time, sync, timeSync, feedback, tone, mix
 *   reverb.*            decay, damping, preDelay, mix
 *   kit.<voice>.*       tune, decay, level, pan for
 *                       bd sd lt mt ht rs cp cb ch oh cy
 *   seq.pattern | seq.chain | seq.chainOrder
 *   seq.<lane>.on.<n>   1..16 for the 11 kit voices and 'melody'
 *   seq.<lane>.vel.<n>  per-step accent 0..100
 *   seq.melody.note.<n> | seq.melody.gate.<n>
 *   arp.*               on, mode, rate, octaves, gate, followLane
 *
 * CURVE
 *   'linear' or 'log' (min > 0). It is configuration, read by the control
 *   factory in ui/controls.js — never a per-control special case. 'log' means
 *   the *displayed/gesture* position is geometric across the range.
 *
 * NO PRESET STORAGE HERE. defaults() is the baked init patch; task 12 layers
 * preset slots on top of it.
 */

/* ---------------------------------------------------------------- schema ---
 * Builders keep the table below readable. num(min, max, def, opts) etc.
 */

const num = (min, max, def, opts = {}) => ({ kind: 'number', min, max, def, curve: 'linear', unit: '', ...opts });
const int = (min, max, def, opts = {}) => ({ kind: 'int', min, max, def, curve: 'linear', unit: '', ...opts });
const bool = (def, opts = {}) => ({ kind: 'bool', def, ...opts });
const list = (options, def, opts = {}) => ({ kind: 'enum', options, def, ...opts });
const rows = (def, opts = {}) => ({ kind: 'array', def, ...opts });

export const WAVEFORMS = [
  'sine', 'triangle', 'sawtooth', 'square', 'pulse25', 'pulse125',
  'sawDown', 'sawUp', 'noise', 'reed',
];

export const FILTER_TYPES = ['lp24', 'lp12', 'hp12', 'bp12', 'notch12'];
export const LFO_WAVES = ['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'sampleHold'];
export const SYNC_RATES = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const ARP_MODES = ['up', 'down', 'updown', 'random', 'asplay'];
export const PATTERNS = ['A', 'B', 'C', 'D'];
export const KIT_VOICES = ['bd', 'sd', 'lt', 'mt', 'ht', 'rs', 'cp', 'cb', 'ch', 'oh', 'cy'];
export const MATRIX_SOURCES = ['lfo1', 'lfo2', 'lfo3', 'ampEnv', 'filterEnv', 'velocity', 'keyTrack', 'random'];
export const MATRIX_DESTINATIONS = ['pitch', 'fmAmount', 'unisonSpread', 'cutoff1', 'cutoff2', 'ampLevel', 'delayTime', 'reverbSend'];
export const STEPS = 16;
export const SEQUENCER_LANES = [...KIT_VOICES, 'melody'];

/* 808 defaults: tune, decay (s), level, pan. Per-voice so the kit is playable. */
const KIT_DEFAULTS = {
  bd: { decay: 0.45, level: 1.0 },
  sd: { decay: 0.22, level: 0.8 },
  lt: { decay: 0.35, level: 0.7 },
  mt: { decay: 0.32, level: 0.7 },
  ht: { decay: 0.28, level: 0.7 },
  rs: { decay: 0.06, level: 0.6 },
  cp: { decay: 0.18, level: 0.6 },
  cb: { decay: 0.3, level: 0.5 },
  ch: { decay: 0.055, level: 0.45 },
  oh: { decay: 0.4, level: 0.4 },
  cy: { decay: 1.2, level: 0.4 },
};

/* A restrained four-on-the-floor-ish groove so the first load is not silent.
 * Steps are 1-based, matching what the sequencer UI shows. */
const KIT_DEFAULT_STEPS = {
  bd: [1, 5, 9, 13],
  sd: [5, 13],
  rs: [7],
  cp: [13],
  ch: [2, 6, 10, 14],
  oh: [15],
  cy: [11],
};
const KIT_ACCENTS = { bd: { 1: 100 }, sd: { 13: 100 }, ch: { 14: 85 } };

const OSC_LEVELS = { 1: 0.8, 2: 0.5, 3: 0.35 };
const OSC_WAVES = { 1: 'sawtooth', 2: 'square', 3: 'sine' };

/* -------------------------------------------------------------- the table */

function buildSchema() {
  const s = {};

  // --- global strip -------------------------------------------------------
  s['global.power'] = bool(false);
  s['global.volume'] = num(0, 1, 0.7);
  s['global.tempo'] = int(40, 220, 120, { unit: 'BPM' });
  s['global.swing'] = num(50, 75, 54, { unit: '%' });
  s['global.run'] = bool(false);
  s['global.latch'] = bool(false);
  s['global.polyphony'] = list(['mono', 'poly'], 'poly');
  s['global.keyboardMode'] = list(['poly', 'legato', 'mono'], 'poly');
  s['global.triggerMode'] = list(['free', 'gate', 'all'], 'all');
  s['global.octave'] = int(-2, 2, 0);
  s['global.bendRange'] = int(0, 12, 2, { unit: 'st' });
  s['global.chorus.on'] = bool(false);
  s['global.chorus.mix'] = num(0, 1, 0.4);
  s['global.chorus.highPass'] = bool(false);
  s['global.chorus.rate'] = num(0.02, 30, 4, { curve: 'log', unit: 'Hz' });
  s['global.chorus.depth'] = num(0, 1, 0.5);

  // --- three oscillator cores --------------------------------------------
  for (const n of [1, 2, 3]) {
    const p = `osc${n}`;
    s[`${p}.waveform`] = list(WAVEFORMS, OSC_WAVES[n]);
    s[`${p}.octave`] = int(-2, 2, 0);
    s[`${p}.semitone`] = int(-12, 12, 0, { unit: 'st' });
    s[`${p}.detune`] = num(-50, 50, 0, { unit: 'ct' });
    s[`${p}.level`] = num(0, 1, OSC_LEVELS[n]);
    s[`${p}.fmAmount`] = num(0, 1, 0);
    s[`${p}.fmSource`] = list(['none', 'osc1', 'osc2', 'osc3'], 'none');
    s[`${p}.unison`] = int(1, 7, 1);
    s[`${p}.unisonSpread`] = num(0, 50, 8, { unit: 'ct' });
    s[`${p}.ringMod`] = list(['none', 'osc1', 'osc2', 'osc3'], 'none');
  }

  // --- wavesampler --------------------------------------------------------
  s['wave.table'] = list(['warmSaw', 'softSquare', 'reed', 'glass'], 'warmSaw');
  s['wave.level'] = num(0, 1, 0);
  s['wave.scan'] = num(0, 1, 0);

  // --- voice mixer --------------------------------------------------------
  s['mixer.level'] = num(0, 1, 0.8);

  // --- cascaded filters ---------------------------------------------------
  const filters = { filter1: { type: 'lp24', cutoff: 1200, res: 1.2 }, filter2: { type: 'lp12', cutoff: 4000, res: 0.8 } };
  for (const [name, d] of Object.entries(filters)) {
    s[`${name}.type`] = list(FILTER_TYPES, d.type);
    s[`${name}.cutoff`] = num(20, 20000, d.cutoff, { curve: 'log', unit: 'Hz' });
    s[`${name}.resonance`] = num(0.5, 30, d.res);
    s[`${name}.drive`] = num(0, 1, 0);
    s[`${name}.keyTrack`] = num(0, 100, 0, { unit: '%' });
    s[`${name}.bypass`] = bool(false);
  }

  // --- envelopes ----------------------------------------------------------
  s['envAmp.attack'] = num(0.001, 5, 0.01, { curve: 'log', unit: 's' });
  s['envAmp.decay'] = num(0.001, 5, 0.6, { curve: 'log', unit: 's' });
  s['envAmp.sustain'] = num(0, 1, 0.7);
  s['envAmp.release'] = num(0.001, 8, 0.8, { curve: 'log', unit: 's' });
  s['envFilter.attack'] = num(0.001, 5, 0.005, { curve: 'log', unit: 's' });
  s['envFilter.decay'] = num(0.001, 5, 0.4, { curve: 'log', unit: 's' });
  s['envFilter.sustain'] = num(0, 1, 0.4);
  s['envFilter.release'] = num(0.001, 8, 0.5, { curve: 'log', unit: 's' });

  // --- three LFOs ---------------------------------------------------------
  for (const n of [1, 2, 3]) {
    const p = `lfo${n}`;
    s[`${p}.wave`] = list(LFO_WAVES, 'sine');
    s[`${p}.rate`] = num(0.02, 30, 5, { curve: 'log', unit: 'Hz' });
    s[`${p}.sync`] = bool(false);
    s[`${p}.rateSync`] = list(SYNC_RATES, '1/16');
    s[`${p}.fadeIn`] = num(0, 5, 0.1, { curve: 'log', unit: 's' });
    s[`${p}.on`] = bool(false);
  }

  // --- 8 x 8 modulation matrix -------------------------------------------
  for (const src of MATRIX_SOURCES) {
    for (const dst of MATRIX_DESTINATIONS) {
      s[`matrix.${src}.${dst}`] = num(-100, 100, 0);
    }
  }

  // --- master effects chain ----------------------------------------------
  s['eq.low'] = num(-18, 18, 0, { unit: 'dB' });
  s['eq.mid'] = num(-18, 18, 0, { unit: 'dB' });
  s['eq.high'] = num(-18, 18, 0, { unit: 'dB' });
  s['delay.time'] = num(0.001, 2, 0.25, { curve: 'log', unit: 's' });
  s['delay.sync'] = bool(false);
  s['delay.timeSync'] = list(SYNC_RATES, '1/8');
  s['delay.feedback'] = num(0, 95, 0, { unit: '%' });
  s['delay.tone'] = num(400, 20000, 4000, { curve: 'log', unit: 'Hz' });
  s['delay.mix'] = num(0, 1, 0);
  s['reverb.decay'] = num(0.3, 12, 1.8, { unit: 's' });
  s['reverb.damping'] = num(200, 20000, 6000, { curve: 'log', unit: 'Hz' });
  s['reverb.preDelay'] = num(0, 0.2, 0.02, { unit: 's' });
  s['reverb.mix'] = num(0, 1, 0);

  // --- 808 kit ------------------------------------------------------------
  for (const voice of KIT_VOICES) {
    const d = KIT_DEFAULTS[voice];
    s[`kit.${voice}.tune`] = int(-12, 12, 0, { unit: 'st' });
    s[`kit.${voice}.decay`] = num(0.05, 2, d.decay, { curve: 'log', unit: 's' });
    s[`kit.${voice}.level`] = num(0, 1, d.level);
    s[`kit.${voice}.pan`] = num(-1, 1, 0);
  }

  // --- sequencer ----------------------------------------------------------
  s['seq.pattern'] = list(PATTERNS, 'A');
  s['seq.chain'] = bool(false);
  s['seq.chainOrder'] = rows([...PATTERNS]);
  for (const lane of SEQUENCER_LANES) {
    for (let step = 1; step <= STEPS; step += 1) {
      const on = (KIT_DEFAULT_STEPS[lane] ?? []).includes(step);
      s[`seq.${lane}.on.${step}`] = bool(on);
      s[`seq.${lane}.vel.${step}`] = num(0, 100, KIT_ACCENTS[lane]?.[step] ?? (on ? 90 : 60), { unit: '%' });
    }
  }
  for (let step = 1; step <= STEPS; step += 1) {
    s[`seq.melody.note.${step}`] = int(0, 127, 60);
    s[`seq.melody.gate.${step}`] = num(10, 100, 50, { unit: '%' });
  }

  // --- arpeggiator --------------------------------------------------------
  s['arp.on'] = bool(false);
  s['arp.mode'] = list(ARP_MODES, 'up');
  s['arp.rate'] = list(SYNC_RATES, '1/16');
  s['arp.octaves'] = int(1, 4, 1);
  s['arp.gate'] = num(10, 100, 50, { unit: '%' });
  s['arp.followLane'] = bool(false);

  return s;
}

/** The instrument's parameter schema: the range/curve/unit contract per key. */
export const SCHEMA = buildSchema();

/** The baked init patch. A fresh flat object every call. */
export function defaults() {
  const patch = {};
  for (const [key, entry] of Object.entries(SCHEMA)) patch[key] = copy(entry.def);
  return patch;
}

function copy(value) {
  return Array.isArray(value) ? [...value] : value;
}

function coerce(entry, value) {
  switch (entry.kind) {
    case 'bool':
      return Boolean(value);
    case 'int': {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return entry.def;
      return clamp(n, entry);
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return entry.def;
      return clamp(n, entry);
    }
    case 'enum':
      return entry.options.includes(value) ? value : undefined;
    case 'array':
      return Array.isArray(value) ? [...value] : undefined;
    default:
      return undefined;
  }
}

function clamp(n, entry) {
  const min = Number.isFinite(entry.min) ? entry.min : -Infinity;
  const max = Number.isFinite(entry.max) ? entry.max : Infinity;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Create a store over a schema. The module-level `store` below is the app's
 * single instance; tests create their own.
 */
export function createStore(schema = SCHEMA) {
  const entries = Object.entries(schema);
  const keySet = new Set(entries.map(([key]) => key));
  const values = new Map();
  const warned = new Set();
  for (const [key, entry] of entries) values.set(key, copy(entry.def));

  const keySubs = new Map();
  const allSubs = new Set();

  function warnOnce(key) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[params] set("${key}") is not declared in the schema; storing it verbatim.`);
  }

  return {
    get(key) {
      if (!keySet.has(key)) return undefined;
      return values.get(key);
    },

    set(key, value, meta = { source: 'control' }) {
      const entry = schema[key];
      if (!entry) {
        warnOnce(key);
        values.set(key, copy(value));
        notify(key, copy(value), undefined, meta);
        return values.get(key);
      }
      const previous = values.get(key);
      const coerced = coerce(entry, value);
      const stored = coerced === undefined ? previous : coerced;
      values.set(key, stored);
      notify(key, stored, previous, meta);
      return stored;
    },

    /** Write a {key: value} patch. The one path presets and init patches use. */
    patch(object, meta = { source: 'patch', apply: 'direct' }) {
      for (const [key, value] of Object.entries(object)) this.set(key, value, meta);
      return this;
    },

    subscribe(keyOrFn, maybeFn) {
      const all = typeof keyOrFn === 'function' && maybeFn === undefined;
      if (all) {
        const fn = keyOrFn;
        allSubs.add(fn);
        return () => allSubs.delete(fn);
      }
      const fn = maybeFn;
      const set = keySubs.get(keyOrFn) ?? new Set();
      set.add(fn);
      keySubs.set(keyOrFn, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) keySubs.delete(keyOrFn);
      };
    },

    subscribeAll(fn) {
      allSubs.add(fn);
      return () => allSubs.delete(fn);
    },

    has: (key) => keySet.has(key),
    keys: () => entries.map(([key]) => key),
    schema: (key) => schema[key],
    snapshot() {
      const out = {};
      for (const [key] of entries) out[key] = copy(values.get(key));
      return out;
    },
  };

  function notify(key, value, previous, meta) {
    const subs = keySubs.get(key);
    if (subs) for (const fn of [...subs]) fn(key, value, previous, meta);
    for (const fn of [...allSubs]) fn(key, value, previous, meta);
  }
}

/** The application-wide store. This is the instance every other module uses. */
export const store = createStore(SCHEMA);