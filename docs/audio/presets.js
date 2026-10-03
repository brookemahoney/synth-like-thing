/**
 * presets.js — THE INSTRUMENT'S MEMORY. Twelve named slots in `localStorage` under one
 * versioned, namespaced key, one schema-versioned document per slot, and a JSON
 * export/import that round-trips the whole thing exactly.
 *
 *   STORAGE_KEY          'synth-like-thing.synth.presets.v1' — namespaced by application, versioned by
 *                        schema. The version is ALSO inside every document, because the
 *                        version that matters for an exported FILE is the one that travels
 *                        with it, and a key in a URL is not a document.
 *   SCHEMA_VERSION       1
 *   SLOT_COUNT / ids     12, addressed 1..12
 *   INIT_PATCH           defaults() from ui/params.js. ONE definition of the defaults: this
 *                        is a reference to the store's own, not a second copy of it.
 *
 * THE DOCUMENT
 *   {
 *     schemaVersion: 1,
 *     name: 'Patch 6',
 *     params:      { …the flat parameter map, every schema key… },
 *     patterns:    [ …four pattern records, one per pattern… ],
 *     chain:       true,            chainOrder: ['C','A','D','C','B'],
 *     swing:       68.5,            tempo: 173,
 *     wavetables:  [ …only user-loaded tables, as the resampled 2048-point cycle… ],
 *   }
 *
 *   `chain`, `chainOrder`, `swing` and `tempo` are projections of the store keys
 *   `seq.chain`, `seq.chainOrder`, `global.swing` and `global.tempo`, written alongside the
 *   map so the shape is legible to a human reading the file and so validation can insist
 *   they are there. The store is still the only authority: on load they are written BACK
 *   INTO the map before the map is applied, and they are never read as an independent
 *   source of truth.
 *
 *   `patterns` is authoritative for step data; the flat `seq.<lane>.<field>.<n>` keys in
 *   `params` are the editing view of whichever pattern was selected. On load the map is
 *   applied first and the four patterns second, so when the two disagree — which a
 *   hand-edited file can arrange — the patterns win, because they are what the sequencer
 *   plays from.
 *
 *   NO TIMESTAMP, AND WHY THAT IS A DECISION RATHER THAN AN OVERSIGHT
 *   A patch document carries no wall-clock timestamp, and neither does a recorded failure —
 *   a monotonic counter orders those instead. tests/clock.test.mjs fails any wall-clock read
 *   in `web/` outside a three-entry allowlist, on the grounds that in this instrument a
 *   second clock's opinion about time is a defect. A saved-at stamp is not musical time, but
 *   the honest way to have one is to add this module to that allowlist with a reason, and
 *   that list belongs to the task that owns the clock. Until then a person tells two patches
 *   apart by the slot's NAME and by the size the panel quotes, and the file's own
 *   modification date is the timestamp for a file. `now` is still an injectable argument,
 *   so a caller that has a legitimate clock can supply one.
 *
 *   THE THREE KEYS THAT ARE NOT PATCH DATA
 *   `global.power`, `global.run` and `seq.step` are the instrument's runtime: whether the
 *   context is resumed, whether the one clock is running, and where the playhead is. A
 *   patch that carried them would switch the instrument off when you loaded it. They are
 *   excluded from the map at capture time and validated as absent.
 *
 * THE LIVE-EDITING DECISION: COPY ON LOAD, EXPLICIT SAVE
 *   Loading a slot COPIES its values into the store and leaves the stored document exactly
 *   as it was. It does not subscribe to the knobs. So:
 *     - saving is always explicit — nothing you do to a knob can overwrite a patch;
 *     - revert is "load that slot again", which needs no snapshot and no undo stack;
 *     - "the sound I am hearing" and "the patch on disk" can never be quietly different,
 *       because only a SAVE moves the second one.
 *   The other design (a loaded slot tracks further edits, so saving is implicit) needs a
 *   snapshot to make revert work and makes every knob drag a write to localStorage. This
 *   is the simpler and less surprising of the two, and it is the one implemented here.
 *
 *   WHICH SLOT A RELOAD BRINGS BACK
 *   Only `save()` writes storage, and saving sets the envelope's `current` pointer. So a
 *   reload restores the last patch you SAVED. Loading a different slot to audition it does
 *   not change that: coming back from a reload gives you the last save, and pressing LOAD
 *   again on the slot you were auditioning is how you get it. This is the direct
 *   consequence of "a load has no side effects", and it is why `load()` touches no storage.
 *
 * EVERY FAILURE PATH IS VISIBLE, AND EACH HAS ITS OWN REASON
 *   The plan's named risk is a preset that fails quietly. So a failure is never a no-op:
 *   it is recorded in `failures()` (bounded, newest last), warned to the console with a
 *   distinct prefix, and returned to the caller with `ok: false` and a reason.
 *
 *     version-mismatch     the container or the document is a different schema. A
 *                           CONTROLLED FALLBACK to the init patch, never a field-by-field
 *                           merge: a newer document's fields must not half-apply onto an
 *                           older instrument, and the way to guarantee that is to refuse
 *                           the document whole.
 *     parse-error          `JSON.parse` threw. The stored text is not JSON.
 *     invalid-document     it parsed, and its shape is wrong: a missing top-level key, a
 *                           parameter the schema does not declare, a missing parameter, a
 *                           pattern with fifteen steps, a wavetable with 900 samples.
 *                           `detail` names the offending field.
 *     quota-exceeded       `setItem` threw a quota error. The save FAILED and the slot
 *                           kept its previous contents — `localStorage` writes are atomic,
 *                           so there is no half-written document to detect, and the bytes
 *                           that were refused are reported.
 *     write-failed         any other `setItem` failure (a disabled store, a private-mode
 *                           SecurityError).
 *     storage-unavailable  there is no `localStorage` at all.
 *     empty-slot           loading, exporting or saving into a slot with nothing in it.
 *     no-current-slot      the stored `current` pointer names nothing, so there is no
 *                           patch to bring back and the init patch is applied.
 *     not-bound            something asked to capture before the sequencer was attached,
 *                           so the four patterns could not be read. Refused, because a
 *                           document that silently has no patterns is exactly the quiet
 *                           failure this module exists to prevent.
 *
 *   All of them leave the instrument PLAYABLE: the fallback is the init patch, the bank
 *   still has four sixteen-step patterns, and none of them touches `global.power` or
 *   `global.run`.
 *
 * WAVETABLE SIZE, AND WHY IT IS THE RESAMPLED TABLE
 *   `waveSampler.serialize()` hands over the 2048-point cycle as plain numbers — about
 *   19.4 KB of JSON per table, measured, against 265 KB for the one-second 44.1 kHz source
 *   file the user actually loaded. Twelve slots of parameters and four patterns measure
 *   21.6 KB each, so 258.9 KB for twelve of them: a full set of twelve empty-the-instrument
 *   patches fits in a 5 MB `localStorage` quota about twenty times over. One user wavetable
 *   in a patch takes it from 21.6 KB to 41.1 KB, and a patch holding all four slots loaded
 *   would be 99 KB — a hundred of those is 10 MB, which no quota holds. That is why quota
 *   exhaustion is a REPORTED FAILURE carrying the refused byte count rather than a
 *   truncation: at some point the honest answer is "this patch does not fit", and the size
 *   in the message is what tells the person which wavetable to leave out.
 *
 *   ONLY USER-LOADED TABLES ARE STORED. The four factory waves are generated in the
 *   browser from analytic coefficients, so storing them would spend ~76 KB per slot on
 *   data the instrument can rebuild. The consequence is honest and worth stating: a
 *   document that carries no wavetable says nothing about tables, so loading one does not
 *   put a table you loaded by hand back to the factory wave.
 *
 * WHY THE SEQUENCER AND THE SAMPLER ARE INJECTED
 *   `web/audio/context.js` throws at import without an `AudioContext`, so a module that
 *   statically imported `sequencer-run.js` could not be tested in node at all — and this
 *   module is exactly the kind that must be testable without a browser. The bank and the
 *   sampler are therefore arguments with the real singletons as their defaults, and
 *   tests/preset.test.mjs drives the REAL pattern bank over a real isolated store.
 *
 *   The restore path writes patterns through the STORE, not through the bank: writing
 *   `seq.pattern` is what the bank's own subscription acts on, and every subsequent
 *   `seq.<lane>.<field>.<n>` write is captured live into the pattern that write selected.
 *   So loading a document needs the bank to exist but needs no method on it, and there is
 *   no second path into the sequencer's data.
 *
 * THE PUBLIC API
 *   capture(name)                 the current instrument state, as a document
 *   save(slot, {name})            write a slot; sets `current`; the only writer of storage
 *   load(slot)                    validate, then apply. No storage write.
 *   remove(slot) / rename(slot, name) / nextEmptySlot() / current() / name(slot)
 *   read(slot)                    a slot's stored document, or null
 *   slots()                       twelve rows for the UI: { id, name, savedAt, empty, bytes, current }
 *   export(slot)                  { ok, text, filename, bytes } — the document as a file
 *   importText(text, { slot })    validate BEFORE anything is replaced
 *   restore()                     the page-load restore; { source: 'init'|'slot', … }
 *   reset()                       the init patch, on demand
 *   failures() / clearFailures()  the captured reasons, bounded
 *   storageInfo()                 { key, bytes, slotsUsed, perSlot }
 *   bind({ sequencer, sampler })  attach the live singletons; call before restore/save
 */

import { PATTERNS, SCHEMA, SEQUENCER_LANES, STEPS, defaults, store as defaultStore } from '../ui/params.js';
import { WAVE_TABLE_LENGTH, WAVE_TABLE_NAMES, waveSampler } from './wavesampler.js';

/* ------------------------------------------------------------- the contract --- */

/** Namespaced by application, versioned by schema. Printed by the UI and the tests. */
export const STORAGE_KEY = 'synth-like-thing.synth.presets.v1';

/** The schema version, in the key and inside every document. Bump together. */
export const SCHEMA_VERSION = 1;

/** Twelve slots, addressed 1..12 — a number is unambiguous where 'A' would collide with
 *  the four pattern names the sequencer already uses. */
export const SLOT_COUNT = 12;
export const SLOT_IDS = Object.freeze(Array.from({ length: SLOT_COUNT }, (_unused, i) => i + 1));

/** The instrument's runtime state, which is not patch data. See the module header. */
export const RUNTIME_KEYS = Object.freeze(['global.power', 'global.run', 'seq.step']);

/** Every top-level key a document must carry. Also the file format's contract. */
export const DOCUMENT_KEYS = Object.freeze([
  'schemaVersion', 'name', 'params', 'patterns',
  'chain', 'chainOrder', 'swing', 'tempo', 'wavetables',
]);

/** The melodic lane's own two per-step fields; every other lane has just two. */
const MELODY_ONLY = ['note', 'gate'];

/** `seq.<lane>.<field>.<n>` — the flat editing view of the selected pattern. */
const CELL_KEY = /^seq\.([A-Za-z][A-Za-z0-9]*)\.(on|vel|note|gate)\.(\d{1,2})$/;

/** Failures kept at most this many, so a page left open cannot grow the array. */
export const MAX_RECORDED_FAILURES = 32;

/** The meta every write from this module carries. Cell writes are direct; ordinary
 *  parameters carry no `apply` hint, so each audio binding decides its own mode and a
 *  patch load glides rather than steps. */
const META = Object.freeze({ source: 'preset' });
const CELL_META = Object.freeze({ source: 'preset', apply: 'direct' });

/** The captured reasons. Distinct strings, because "it didn't work" is not a diagnosis. */
export const FAILURE_REASONS = Object.freeze({
  VERSION_MISMATCH: 'version-mismatch',
  PARSE_ERROR: 'parse-error',
  INVALID_DOCUMENT: 'invalid-document',
  QUOTA_EXCEEDED: 'quota-exceeded',
  WRITE_FAILED: 'write-failed',
  STORAGE_UNAVAILABLE: 'storage-unavailable',
  EMPTY_SLOT: 'empty-slot',
  NO_CURRENT_SLOT: 'no-current-slot',
  NOT_BOUND: 'not-bound',
});

/** Every reason this module can produce, for a test that asserts they stay distinct. */
export const FAILURE_LIST = Object.freeze(Object.values(FAILURE_REASONS));

/** THE INIT PATCH. A reference to ui/params.js's own defaults — one definition only. */
export const INIT_PATCH = Object.freeze(defaults());

/* -------------------------------------------------------------- validation --- */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const invalid = (detail) => ({ ok: false, reason: FAILURE_REASONS.INVALID_DOCUMENT, detail });

/**
 * Every schema key a document must carry: all of them except the three runtime keys.
 * Read from the schema rather than written out, so a new parameter cannot be added to the
 * instrument and quietly left out of every patch.
 */
function patchKeys() {
  const keys = [];
  for (const key of Object.keys(SCHEMA)) {
    if (!RUNTIME_KEYS.includes(key)) keys.push(key);
  }
  return keys;
}

/** One pattern's lanes, read out of a flat parameter map. The mirror of applyPatterns. */
function patternFromParams(params, index) {
  const lanes = {};
  for (const lane of SEQUENCER_LANES) {
    const cell = { on: [], vel: [] };
    for (let step = 1; step <= STEPS; step += 1) {
      cell.on.push(Boolean(params[`seq.${lane}.on.${step}`]));
      cell.vel.push(params[`seq.${lane}.vel.${step}`]);
    }
    if (lane === 'melody') {
      cell.note = [];
      cell.gate = [];
      for (let step = 1; step <= STEPS; step += 1) {
        cell.note.push(params[`seq.${lane}.note.${step}`]);
        cell.gate.push(params[`seq.${lane}.gate.${step}`]);
      }
    }
    lanes[lane] = cell;
  }
  return { pattern: PATTERNS[index], lanes };
}

function validateParams(params) {
  if (!isPlainObject(params)) return invalid('"params" is not an object');
  const expected = patchKeys();
  for (const key of expected) {
    if (!(key in params)) return invalid(`"params" is missing "${key}"`);
  }
  for (const key of Object.keys(params)) {
    if (!SCHEMA[key]) return invalid(`"params" declares "${key}", which the schema does not`);
    if (RUNTIME_KEYS.includes(key)) return invalid(`"params" carries the runtime key "${key}"`);
  }
  return null;
}

function validatePatterns(patterns) {
  if (!Array.isArray(patterns)) return invalid('"patterns" is not an array');
  if (patterns.length !== PATTERNS.length) {
    return invalid(`"patterns" has ${patterns.length} entries, expected ${PATTERNS.length}`);
  }
  for (const [index, pattern] of patterns.entries()) {
    if (!isPlainObject(pattern) || !isPlainObject(pattern.lanes)) {
      return invalid(`pattern ${PATTERNS[index]} has no "lanes" object`);
    }
    for (const lane of SEQUENCER_LANES) {
      const cell = pattern.lanes[lane];
      const fields = ['on', 'vel', ...(lane === 'melody' ? MELODY_ONLY : [])];
      if (!isPlainObject(cell)) return invalid(`pattern ${PATTERNS[index]} lane "${lane}" is missing`);
      for (const field of fields) {
        const column = cell[field];
        if (!Array.isArray(column) || column.length !== STEPS) {
          return invalid(`pattern ${PATTERNS[index]} lane "${lane}" field "${field}" is not ${STEPS} steps`);
        }
        for (const value of column) {
          if (field === 'on') {
            if (typeof value !== 'boolean') return invalid(`pattern ${PATTERNS[index]} lane "${lane}" "${field}" is not booleans`);
          } else if (!finiteNumber(value)) {
            return invalid(`pattern ${PATTERNS[index]} lane "${lane}" "${field}" has a non-number at some step`);
          }
        }
      }
    }
  }
  return null;
}

function validateWavetables(tables) {
  if (!Array.isArray(tables)) return invalid('"wavetables" is not an array');
  for (const [index, table] of tables.entries()) {
    if (!isPlainObject(table)) return invalid(`wavetable ${index} is not an object`);
    if (!WAVE_TABLE_NAMES.includes(table.slot)) {
      return invalid(`wavetable ${index} names slot "${table.slot}", which is not a wave slot`);
    }
    if (!Array.isArray(table.samples) || table.samples.length !== WAVE_TABLE_LENGTH) {
      return invalid(`wavetable ${index} has ${table.samples?.length ?? 0} samples, expected ${WAVE_TABLE_LENGTH}`);
    }
    for (const value of table.samples) {
      if (!finiteNumber(value)) return invalid(`wavetable ${index} has a non-number sample`);
    }
  }
  return null;
}

/**
 * The gate every document passes through — stored or imported, there is no other way in.
 * Returns null when the document is sound, or `{ ok: false, reason, detail }`.
 *
 * Order matters and is part of the contract: the version is checked FIRST, so a document
 * from another schema is reported as a version mismatch and never as a shape complaint
 * about fields that schema did not have.
 */
export function validateDocument(document_) {
  if (!isPlainObject(document_)) return invalid('the document is not an object');
  if (!('schemaVersion' in document_)) return invalid('"schemaVersion" is missing');
  if (document_.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: FAILURE_REASONS.VERSION_MISMATCH,
      detail: `document schemaVersion ${JSON.stringify(document_.schemaVersion)}, this instrument reads ${SCHEMA_VERSION}`,
    };
  }
  for (const key of DOCUMENT_KEYS) {
    if (!(key in document_)) return invalid(`"${key}" is missing`);
  }
  if (typeof document_.name !== 'string' || document_.name.length === 0) return invalid('"name" is not a non-empty string');
  if (typeof document_.chain !== 'boolean') return invalid('"chain" is not a boolean');
  if (!Array.isArray(document_.chainOrder)) return invalid('"chainOrder" is not an array');
  for (const name of document_.chainOrder) {
    if (!PATTERNS.includes(name)) return invalid(`"chainOrder" names "${name}", which is not a pattern`);
  }
  if (!finiteNumber(document_.swing)) return invalid('"swing" is not a finite number');
  if (!finiteNumber(document_.tempo)) return invalid('"tempo" is not a finite number');

  return validateParams(document_.params)
    ?? validatePatterns(document_.patterns)
    ?? validateWavetables(document_.wavetables);
}

/* ------------------------------------------------------------- the system --- */

/**
 * A preset system over an injected store, an injected storage and the injected live
 * singletons. `presets` below is the app's instance; tests build their own.
 */
export function createPresetSystem({
  store = defaultStore,
  storage,
  sampler = null,
  sequencer = null,
  key = STORAGE_KEY,
  now = null,
} = {}) {
  const failures = [];
  /* Monotonic, so recorded failures have a stable order without reading a clock. */
  let sequence = 0;

  function stamp() {
    sequence += 1;
    /* An injected clock is used when the caller has one; there is no default that reads
       the wall clock, because in this instrument that would be a second clock. */
    return typeof now === 'function' ? String(now()) : null;
  }

  /**
   * Record a failure — and do NOT record it twice in a row.
   *
   * A corrupt store is read on every repaint of the preset panel (slots(), current(),
   * storageInfo()), so an undeduplicated read would push the same diagnosis into the log
   * and the console once per read and drown the bounded array in one sentence. An
   * identical consecutive failure is the same fact observed again, so it is dropped; a
   * DIFFERENT reason or a different detail always records, which is what makes the log a
   * log and not a counter.
   */
  function record(reason, detail, slot = null) {
    const last = failures.at(-1);
    if (last && last.reason === reason && last.detail === String(detail ?? '')) return last;
    const entry = { reason, detail: String(detail ?? ''), slot, at: stamp() };
    failures.push(entry);
    while (failures.length > MAX_RECORDED_FAILURES) failures.shift();
    console.warn(`[presets] ${reason}${slot === null ? '' : ` (slot ${slot})`}: ${entry.detail}`);
    return entry;
  }

  const ok = (extra) => ({ ok: true, ...extra });
  const fail = (reason, detail, extra = {}) => ({ ok: false, reason, detail: String(detail ?? ''), ...extra });

  const slotId = (value) => {
    const id = Number(value);
    return SLOT_IDS.includes(id) ? id : null;
  };

  /* --------------------------------------------------------------- storage --- */

  /**
   * The stored envelope, read fresh every time — localStorage is the only authority here,
   * so nothing is cached across a save.
   *
   * `{ missing: true }` means "this browser has never been here", which is NOT a failure.
   * Anything else is: the caller gets null and a recorded reason.
   */
  function readEnvelope() {
    if (!storage) {
      record(FAILURE_REASONS.STORAGE_UNAVAILABLE, 'there is no localStorage in this browser, so nothing can be stored');
      return null;
    }
    let text;
    try {
      text = storage.getItem(key);
    } catch (error) {
      record(FAILURE_REASONS.STORAGE_UNAVAILABLE, `reading the key failed: ${error?.message ?? error}`);
      return null;
    }
    if (text === null || text === undefined) return { missing: true, slots: {}, current: null };

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      record(FAILURE_REASONS.PARSE_ERROR, `stored data is not JSON: ${error?.message ?? error}`);
      return null;
    }
    if (!isPlainObject(parsed)) {
      record(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container is not an object');
      return null;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      record(
        FAILURE_REASONS.VERSION_MISMATCH,
        `stored container schemaVersion ${JSON.stringify(parsed.schemaVersion)}, this instrument reads ${SCHEMA_VERSION}`,
      );
      return null;
    }
    if (!isPlainObject(parsed.slots)) {
      record(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container has no "slots" object');
      return null;
    }
    return { missing: false, slots: parsed.slots, current: parsed.current ?? null };
  }

  /** Write an envelope. The ONLY writer of storage, and it never truncates: a refusal is
   *  a failure with the refused byte count, and the previous contents are still there. */
  function writeEnvelope(envelope, slot = null) {
    if (!storage) {
      const reason = FAILURE_REASONS.STORAGE_UNAVAILABLE;
      const detail = 'there is no localStorage in this browser, so nothing can be stored';
      record(reason, detail, slot);
      return fail(reason, detail);
    }
    const text = JSON.stringify(envelope);
    try {
      storage.setItem(key, text);
    } catch (error) {
      const reason = isQuotaError(error) ? FAILURE_REASONS.QUOTA_EXCEEDED : FAILURE_REASONS.WRITE_FAILED;
      const detail = `${error?.name ?? 'Error'}: ${error?.message ?? error} — ${text.length} bytes refused`;
      record(reason, detail, slot);
      return fail(reason, detail, { bytes: text.length });
    }
    return ok({ bytes: text.length });
  }

  /** Is this the browser's quota error? Three spellings, because there have been three. */
  function isQuotaError(error) {
    if (!error) return false;
    if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    return error.code === 22 || error.code === 1014;
  }

  /**
   * The next envelope: the stored one with one slot changed. `existing` is the envelope
   * the caller has already read, so a save is one read and one write — and no in-memory
   * copy of the stored state exists that could disagree with what is on disk.
   *
   * A write sets `current` to the slot being written, because saving a patch is what makes
   * it the one the next page load brings back. `document_ === null` (a delete) clears the
   * pointer when it pointed at the slot being deleted.
   */
  function envelopeWith(existing, slot, document_, { current } = {}) {
    const slots = { ...(existing && !existing.missing ? existing.slots : {}) };
    if (document_ === null) delete slots[String(slot)];
    else slots[String(slot)] = document_;
    return {
      schemaVersion: SCHEMA_VERSION,
      current: current === undefined ? (document_ === null ? null : slot) : current,
      slots,
    };
  }

  /* -------------------------------------------------------------- applying --- */

  /** The flat parameter map, minus the three runtime keys. */
  function snapshotParams() {
    const params = store.snapshot();
    for (const key of RUNTIME_KEYS) delete params[key];
    return params;
  }

  /**
   * The parameter map, plus the document's top-level projections of chain/swing/tempo.
   * They are written INTO the map here so the store stays the only authority for those
   * four values even on import — nothing else in the instrument reads them.
   */
  function applyParams(params, projections) {
    const patch = {};
    for (const key of patchKeys()) patch[key] = params[key];
    Object.assign(patch, projections ?? {});
    store.patch(patch, META);
    return patch;
  }

  /**
   * Four patterns, through the store.
   *
   * Writing `seq.pattern` is what the bank's own subscription acts on: it selects that
   * pattern and loads its data into the flat keys. Every `seq.<lane>.<field>.<n>` write
   * after that is captured live into the selected pattern, which is how one flat key
   * space can hold four patterns at once. So the loop is: select, write, select the
   * document's own pattern at the end.
   */
  function applyPatterns(patterns, selected) {
    if (!hasBank()) {
      const failure = notBound('apply');
      throw Object.assign(new Error(`presets: ${failure.detail}`), failure);
    }
    for (const [index, pattern] of patterns.entries()) {
      const name = PATTERNS[index];
      store.set('seq.pattern', name, CELL_META);
      const lanes = pattern.lanes;
      for (const lane of SEQUENCER_LANES) {
        const cell = lanes[lane];
        const fields = ['on', 'vel', ...(lane === 'melody' ? MELODY_ONLY : [])];
        for (const field of fields) {
          for (let step = 1; step <= STEPS; step += 1) {
            store.set(`seq.${lane}.${field}.${step}`, cell[field][step - 1], CELL_META);
          }
        }
      }
    }
    store.set('seq.pattern', selected, CELL_META);
    return patterns.length;
  }

  /** Only user-loaded tables. Factory waves are generated in the browser; storing them
   *  would spend ~76 KB per slot on data this instrument can rebuild.
   *
   *  The slot comes from `tables()`, which reports where each table actually sits, rather
   *  than from the serialised document's own `slot` field: `serialize()` fills that field
   *  with the CURRENTLY SELECTED slot, so trusting it would file a table loaded into
   *  slot 1 under whatever slot happened to be selected when the patch was saved — and
   *  `restore()` puts a document back where its `slot` says. */
  function captureWavetables() {
    if (!sampler?.tables || !sampler?.serialize) return [];
    return sampler
      .tables()
      .filter((table) => table.kind !== 'factory')
      .map((table) => {
        const serialised = sampler.serialize(table.slot);
        return serialised ? { ...serialised, slot: table.slot } : null;
      })
      .filter(Boolean);
  }

  function applyWavetables(tables) {
    if (!sampler?.restore) return 0;
    for (const table of tables) sampler.restore(table);
    return tables.length;
  }

  /** A validated document, applied in full: parameters, then the four patterns, then the
   *  tables. The parameter map is applied FIRST so the patterns, which are authoritative
   *  for step data, overwrite it. */
  function applyDocument(document_) {
    const verdict = validateDocument(document_);
    if (verdict) throw Object.assign(new Error(`presets: ${verdict.reason}: ${verdict.detail}`), verdict);
    applyParams(document_.params, {
      'seq.chain': document_.chain,
      'seq.chainOrder': document_.chainOrder,
      'global.swing': document_.swing,
      'global.tempo': document_.tempo,
    });
    applyPatterns(document_.patterns, document_.params['seq.pattern']);
    applyWavetables(document_.wavetables);
    return ok({ document: document_, slot: null });
  }

  /** The init patch, over the whole instrument: every parameter and all four patterns,
   *  so a fallback is TOTAL rather than "the knobs came back and pattern B did not". */
  function applyInitPatch() {
    const init = { ...INIT_PATCH };
    applyParams(init);
    applyPatterns(PATTERNS.map((_name, index) => patternFromParams(init, index)), init['seq.pattern']);
    return ok({ document: null, slot: null });
  }

  /* --------------------------------------------------------------- capture --- */

  /** The current instrument state as a document. Refuses without a bank: a document with
   *  no patterns is the quiet failure this module exists to prevent. */
  function capture(name) {
    if (!hasBank()) return notBound('capture');
    const params = snapshotParams();
    return ok({
      document: {
        schemaVersion: SCHEMA_VERSION,
        name: name ?? `Patch ${current() ?? ''}`.trim(),
        params,
        patterns: sequencer.bank.snapshot(),
        chain: Boolean(params['seq.chain']),
        chainOrder: [...params['seq.chainOrder']],
        swing: params['global.swing'],
        tempo: params['global.tempo'],
        wavetables: captureWavetables(),
      },
    });
  }

  /* ----------------------------------------------------------------- reads --- */

  function read(slot) {
    const id = slotId(slot);
    if (id === null) return null;
    const envelope = readEnvelope();
    if (!envelope || envelope.missing) return null;
    return envelope.slots[String(id)] ?? null;
  }

  function current() {
    const envelope = readEnvelope();
    if (!envelope || envelope.missing) return null;
    const id = slotId(envelope.current);
    return id;
  }

  function name(slot) {
    return read(slot)?.name ?? null;
  }

  function slots() {
    const envelope = readEnvelope();
    const stored = envelope && !envelope.missing ? envelope.slots : {};
    const active = envelope && !envelope.missing ? slotId(envelope.current) : null;
    return SLOT_IDS.map((id) => {
      const document_ = stored[String(id)] ?? null;
      return {
        id,
        name: document_?.name ?? null,
        empty: document_ === null,
        current: id === active,
        bytes: document_ ? JSON.stringify(document_).length : 0,
        wavetables: Array.isArray(document_?.wavetables) ? document_.wavetables.length : 0,
      };
    });
  }

  function nextEmptySlot() {
    return slots().find((slot) => slot.empty)?.id ?? null;
  }

  /* ---------------------------------------------------------------- writes --- */

  function save(slot, { name: wanted } = {}) {
    const id = slotId(slot);
    if (id === null) return emptySlot(slot);
    const captured = capture(wanted);
    if (!captured.ok) return captured;

    /* One read, one write. The envelope is read before the capture so the label can keep
       the name the slot already had, and the same read supplies the other slots. */
    const existing = readEnvelope();
    if (!existing) return fail(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container could not be read, so nothing was overwritten');
    const previous = existing.slots[String(id)] ?? null;
    captured.document.name = wanted ?? previous?.name ?? `Patch ${id}`;
    const result = writeEnvelope(envelopeWith(existing, id, captured.document), id);
    if (!result.ok) return result;
    return ok({ bytes: result.bytes, document: captured.document, slot: id });
  }

  function load(slot) {
    const id = slotId(slot);
    if (id === null) return emptySlot(slot);
    if (!hasBank()) return notBound('load');
    const stored = read(id);
    if (!stored) return emptySlot(slot, `slot ${id} has nothing in it`);
    const verdict = validateDocument(stored);
    if (verdict) {
      record(verdict.reason, verdict.detail, id);
      return fail(verdict.reason, verdict.detail, { slot: id });
    }
    /* Validated first, so a bad slot cannot half-apply on the way in. */
    applyDocument(stored);
    return ok({ slot: id, document: stored });
  }

  const hasBank = () => Boolean(sequencer?.bank);

  /** Everything that writes patterns needs the bank. Refuse loudly rather than write a
   *  document whose four patterns are missing. */
  function notBound(action) {
    const detail = `${action} needs the sequencer attached: the four patterns live in it and cannot be read or written without it`;
    record(FAILURE_REASONS.NOT_BOUND, detail);
    return fail(FAILURE_REASONS.NOT_BOUND, detail);
  }

  /** Loading or exporting a slot with nothing in it is a user action that did not do what
   *  it was asked to, so it is recorded like any other failure rather than returned quietly. */
  function emptySlot(slot, detail) {
    const text = detail ?? `"${slot}" is not one of the twelve slots (1..${SLOT_COUNT})`;
    record(FAILURE_REASONS.EMPTY_SLOT, text);
    return fail(FAILURE_REASONS.EMPTY_SLOT, text);
  }

  function remove(slot) {
    const id = slotId(slot);
    if (id === null) return emptySlot(slot);
    const envelope = readEnvelope();
    if (!envelope) return fail(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container could not be read, so nothing was deleted');
    const existing = read(id);
    const result = writeEnvelope(envelopeWith(envelope, id, null, { current: envelope.current === id ? null : envelope.current }), id);
    if (!result.ok) return result;
    return ok({ bytes: result.bytes, removed: existing !== null });
  }

  function rename(slot, wanted) {
    const id = slotId(slot);
    if (id === null) return emptySlot(slot);
    const stored = read(id);
    if (!stored) return emptySlot(slot, `slot ${id} has nothing in it`);
    const label = String(wanted ?? '').trim();
    if (label.length === 0) return fail(FAILURE_REASONS.INVALID_DOCUMENT, 'a patch needs a name');
    const existing = readEnvelope();
    if (!existing) return fail(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container could not be read, so nothing was renamed');
    const result = writeEnvelope(envelopeWith(existing, id, { ...stored, name: label }), id);
    if (!result.ok) return result;
    return ok({ bytes: result.bytes, name: label });
  }

  /* --------------------------------------------------------- export/import --- */

  /** A filename a person can find again: the application, then the patch name. */
  function filenameFor(patchName) {
    const slug = String(patchName ?? 'patch')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `atelier-${slug.length > 0 ? slug : 'patch'}.json`;
  }

  /** The stored document of a slot, as the bytes of a file. */
  function exportDocument(slot) {
    const id = slotId(slot);
    if (id === null) return emptySlot(slot);
    const stored = read(id);
    if (!stored) return emptySlot(slot, `slot ${id} has nothing in it`);
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    return ok({ text, filename: filenameFor(stored.name), bytes: text.length, document: stored });
  }

  /**
   * Import: parse, validate, and only then replace anything.
   *
   * The order is the whole point. Parsing can fail; validation can fail; a quota can refuse
   * the write. Any of those happens before a single parameter is written, so a malformed
   * file leaves the instrument exactly as it was — and still playing, because nothing here
   * touches `global.power` or `global.run`.
   */
  function importText(text, { slot = null, name: wanted = null } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch (error) {
      const detail = `that file is not JSON: ${error?.message ?? error}`;
      record(FAILURE_REASONS.PARSE_ERROR, detail);
      return fail(FAILURE_REASONS.PARSE_ERROR, detail);
    }

    const verdict = validateDocument(parsed);
    if (verdict) {
      record(verdict.reason, verdict.detail);
      return fail(verdict.reason, verdict.detail);
    }

    /* With a slot named, the document is STORED before it is applied: a quota refusal
       then means the instrument was not touched either, which is the stronger promise. */
    let target = null;
    if (slot !== null) {
      const id = slotId(slot);
      if (id === null) return emptySlot(slot);
      const existing = readEnvelope();
      if (!existing) return fail(FAILURE_REASONS.INVALID_DOCUMENT, 'the stored container could not be read, so nothing was imported');
      const written = writeEnvelope(envelopeWith(existing, id, wanted ? { ...parsed, name: wanted } : parsed), id);
      if (!written.ok) return written;
      target = id;
    }

    applyDocument(parsed);
    return ok({ document: parsed, slot: target });
  }

  /* ---------------------------------------------------------- the page load --- */

  /**
   * The restore that runs on every page load: the stored `current` slot, or the init patch.
   * The first visit to a browser is `source: 'init'` with no reason, because that is not a
   * failure; every other path records why.
   */
  /**
   * The init patch, or a recorded reason why it could not be applied. restore() runs on a
   * page load, before anything can show a return value to a person, so every failure here
   * has to be a returned value and a recorded reason rather than an exception: a throw at
   * load time is the quietest possible failure.
   */
  function applyInitSafely() {
    if (!hasBank()) {
      notBound('restore');
      return FAILURE_REASONS.NOT_BOUND;
    }
    try {
      applyInitPatch();
      return null;
    } catch (error) {
      const reason = error?.reason ?? FAILURE_REASONS.INVALID_DOCUMENT;
      record(reason, error?.detail ?? error?.message ?? error);
      return reason;
    }
  }

  function restore() {
    const envelope = readEnvelope();
    if (envelope && envelope.missing) {
      /* A first visit is not a failure — unless the init patch could not be applied,
         which is the one thing this path can still get wrong. */
      const reason = applyInitSafely() ?? undefined;
      return { source: 'init', slot: null, reason, failures: failures.slice() };
    }
    if (!envelope) {
      const reason = applyInitSafely() ?? failures.at(-1)?.reason;
      return { source: 'init', slot: null, reason, failures: failures.slice() };
    }
    const id = slotId(envelope.current);
    const stored = id === null ? null : envelope.slots[String(id)] ?? null;
    if (!stored) {
      record(FAILURE_REASONS.NO_CURRENT_SLOT, 'the stored patch pointer names a slot with nothing in it, so the init patch was loaded instead');
      applyInitSafely();
      return { source: 'init', slot: null, reason: FAILURE_REASONS.NO_CURRENT_SLOT, failures: failures.slice() };
    }
    const verdict = validateDocument(stored);
    if (verdict) {
      record(verdict.reason, verdict.detail, id);
      applyInitSafely();
      return { source: 'init', slot: null, reason: verdict.reason, failures: failures.slice() };
    }
    try {
      applyDocument(stored);
    } catch (error) {
      const reason = error?.reason ?? FAILURE_REASONS.INVALID_DOCUMENT;
      record(reason, error?.detail ?? error?.message ?? error, id);
      applyInitSafely();
      return { source: 'init', slot: null, reason, failures: failures.slice() };
    }
    return { source: 'slot', slot: id, reason: undefined, failures: failures.slice() };
  }

  /** The init patch on demand — the INIT button. */
  function reset() {
    if (!hasBank()) return notBound('reset');
    applyInitPatch();
    return ok({});
  }

  /** `rows` may be passed in by a caller that already has them: slots() stringifies every
   *  stored document to measure it, which is worth doing once per repaint rather than
   *  twice. */
  function storageInfo(rows = slots()) {
    const used = rows.filter((row) => !row.empty);
    let bytes = 0;
    if (storage) {
      try {
        bytes = String(storage.getItem(key) ?? '').length;
      } catch {
        bytes = 0;
      }
    }
    return {
      key,
      bytes,
      slotsUsed: used.length,
      slotsTotal: SLOT_COUNT,
      perSlot: used.length > 0 ? Math.round(bytes / used.length) : 0,
    };
  }

  return {
    /* the contract */
    key: () => key,
    schemaVersion: SCHEMA_VERSION,
    slotIds: () => [...SLOT_IDS],

    /* the live singletons, attached by the module that owns them */
    bind({ sequencer: next = sequencer, sampler: nextSampler = sampler } = {}) {
      if (next) sequencer = next;
      if (nextSampler) sampler = nextSampler;
      return { bound: Boolean(sequencer?.bank), sampler: Boolean(sampler) };
    },

    /* capture and apply */
    capture,
    load,
    save,
    remove,
    rename,
    reset,
    restore,

    /* reads */
    read,
    current,
    name,
    slots,
    nextEmptySlot,
    storageInfo,
    validate: validateDocument,

    /* the captured reasons */
    failures: () => failures.map((entry) => ({ ...entry })),
    clearFailures: () => {
      const count = failures.length;
      failures.length = 0;
      return count;
    },

    /* export and import */
    exportDocument,
    export: exportDocument,
    importText,
  };
}

/** The app's instance: the real store and the real wavesampler, storage from this browser. */
export const presets = createPresetSystem({
  storage: typeof localStorage === 'undefined' ? null : localStorage,
  sampler: waveSampler,
});