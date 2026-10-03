/**
 * meter.js — the level meter's painted stroke and the instrument's read-only runtime
 * inspection handle. Two things, because they are the two halves of one promise: the
 * instrument LOOKS right, and the instrument can be PROVEN right.
 *
 * THE SPLIT WITH web/audio/meter.js
 *   audio/meter.js owns the arithmetic and imports nothing: RMS, the smoothing, the
 *   decaying peak hold. This file owns the two bindings around it — where the level is
 *   read for painting, and what the handle reports.
 *
 * WHERE THE PAINTED LEVEL COMES FROM — THROUGH THE STORE, AND ONLY THE STORE
 *   The stroke follows `readLevel(store)`, the same read web/ui/paint.js documents as
 *   the contract its dab layer reacts to, and the meter publishes what it measured to
 *   `global.meter`. This file never hands an audio module's number to a painter
 *   directly, because the moment a visual layer reaches past the store it is a second
 *   authority on what a value is. The ONE value passed straight through is the peak
 *   hold, which is not a parameter and has no store key: it is handed to `paint()` as
 *   an argument by the frame loop in this same file.
 *
 * NO AUDIO FUNCTION HERE. Read it as a constraint on the author, not a description:
 *   no node is created, nothing is connected, nothing is started. The analyser is a
 *   READ-ONLY argument to the meter factory; the meter calls exactly one method on it,
 *   getFloatTimeDomainData. tests/meter-handle.test.mjs asserts this over the shipped
 *   source, because a claim like this is worth nothing unless something checks it.
 *
 * THE HANDLE IS A VERIFICATION INSTRUMENT, SO IT MAY NOT BE WRITTEN TO
 *   Every own property is a getter that hands back a FROZEN ACCESSOR, paired with an
 *   INERT SETTER. That combination is the whole design and it is not the obvious one:
 *     - a plain data property, or a settable one, is a second hidden channel into the
 *       instrument's state. A later task will write to it, and then it is no longer a
 *       verification instrument.
 *     - a getter that returned the VALUE would make `handle.rms()` impossible to call,
 *       and the fields that take an argument would have nowhere to put it.
 *     - a getter with no setter, on a frozen object, makes an assignment THROW in
 *       strict mode. The self-validation runs in a page console, which may well be
 *       strict. A handle that throws when you write to it looks like a broken handle.
 *   So: the getter computes the accessor, the setter does nothing, and `Object.freeze`
 *   makes the pair non-configurable. An assignment is silent, inert, and leaves the
 *   accessor itself in place. Every object the handle hands out is frozen too.
 *
 * NOTHING IS HANDED OUT THAT CAN ADVANCE STATE
 *   No getter may mutate, and none may allocate without bound. The counter snapshot,
 *   the error list, the parameter snapshot and the node inventories are all cached
 *   against a cheap version and returned as the SAME frozen object until the
 *   underlying state actually moves, so reading the handle in a loop is free.
 *   `localStorage` is the deliberate exception: it is read on every access, because
 *   self-validation saves a preset and then reads it straight back, and a load-time
 *   snapshot would report a stale slot and fail a check that actually passes.
 *
 * THIS MODULE IMPORTS NO AUDIO MODULE AT IMPORT TIME
 *   The audio graph is resolved inside startMeter(), in the browser, from dynamic
 *   imports — the shape ui/keyboard.js and ui/waveload.js already use, and the reason
 *   `node --test` can import this file and drive the handle with no AudioContext at
 *   all. The handle is installed SYNCHRONOUSLY at module scope and primed when those
 *   imports resolve, so a probe that reads it a millisecond after load gets a handle
 *   rather than `undefined`.
 *
 * THE ERROR LOG IS THE FIRST THING THAT RUNS
 *   The `error` and `unhandledrejection` listeners are installed at module scope,
 *   above everything else in this file, so they are the earliest listeners in the
 *   page. That is why the script tag for this module is the first one in index.html:
 *   a load-time throw in a module evaluated before it would otherwise never be seen.
 *   The array is CAPPED, because a failure loop is exactly the case where an uncapped
 *   capture turns a small defect into a dead tab.
 */

import { store as defaultStore } from './params.js';
import { parseHexColor, readLevel } from './paint.js';
import { METER_LEVEL_KEY, METER_TRACE_LENGTH, createLevelMeter } from '../audio/meter.js';

/* =============================================================================
   1. THE CAPTURED-ERROR LOG
   ========================================================================== */

/** How many errors are kept. Small on purpose: the point is "did anything throw", not
 *  an archive. A capped array is what stops a failure loop from exhausting memory. */
export const ERROR_LOG_CAP = 48;

/** The eleven kit voices. The counters are useless without knowing which eleven. */
export const KIT_VOICE_COUNT = 11;
const KIT_VOICES = Object.freeze(['bd', 'sd', 'lt', 'mt', 'ht', 'rs', 'cp', 'cb', 'ch', 'oh', 'cy']);

/** One shared frozen empty array, so reading a clean log allocates nothing. */
const NO_ENTRIES = Object.freeze([]);

/**
 * Capture runtime errors. `target` is normally `window`; tests pass a stand-in, and
 * `null` means "no target in this environment" (node), which is not an error.
 *
 * Entries are plain frozen records: { seq, kind, message, source, line, column }. `seq`
 * is this log's own monotonic count, not a wall clock: the array's order already says
 * which failure came first, and a timestamp would only add a second clock to read.
 */
export function createErrorLog({ target = null, cap = ERROR_LOG_CAP } = {}) {
  const limit = Math.max(1, Math.round(Number(cap) || ERROR_LOG_CAP));

  /* The live buffer is capped by construction: at most `limit` records exist, and the
     oldest is dropped when a new one arrives. It is never grown without bound. */
  let live = [];
  let snapshot = NO_ENTRIES;
  let sequence = 0;
  let disposed = false;

  function push(kind, message, source = null, line = null, column = null) {
    if (disposed) return 0;
    sequence += 1;
    live.push(Object.freeze({ seq: sequence, kind, message, source, line, column }));
    while (live.length > limit) live.shift();
    snapshot = Object.freeze([...live]);
    return snapshot.length;
  }

  const onError = (event) => {
    push('error', String(event?.message ?? 'unknown error'), event?.filename ?? null, event?.lineno ?? null, event?.colno ?? null);
  };
  const onRejection = (event) => {
    const reason = event?.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'unhandled rejection');
    push('unhandledrejection', message);
  };

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
  }

  return {
    /** The frozen array, cached: the same instance until a failure arrives. */
    entries: () => snapshot,
    count: () => snapshot.length,
    cap: () => limit,
    /** Used by the page itself, to record a boot failure the listeners could not see.
     *  Note the argument order: the public form is (message, kind). */
    push: (message, kind = 'error') => push(String(kind), message === undefined ? 'unknown error' : String(message)),
    dispose() {
      if (disposed) return false;
      disposed = true;
      if (target && typeof target.removeEventListener === 'function') {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
      }
      return true;
    },
  };
}

/* =============================================================================
   2. THE STROKE PLAN — saturation and spread, as numbers
   ========================================================================== */

/** Ramp stops. The stroke is mixed from a cool low to a hot high as the level rises,
 *  so a loud chord is not merely bigger but more saturated AND differently hued. */
export const STROKE_RAMP_STOPS = 7;

/**
 * The meter's geometry, as a pre-allocated record the frame loop mutates in place.
 *
 * This is the whole of "saturation and spread track the RMS", stated as arithmetic so
 * it can be asserted on rather than admired:
 *
 *   length       how far the brush travelled — SPREAD along the stroke
 *   thickness    how loaded the brush is — SPREAD across it
 *   saturation   the pigment density — SATURATION
 *   dabRadius    the wet highlight at the leading edge, which grows with both
 *   holdX/holdAlpha  the peak-hold mark: a dry tick at the held peak, fading with it
 *   rampIndex    which of the precomputed ramp colours the level selects
 *
 * `compute()` allocates nothing and returns the same object every frame, which is why
 * tests/meter-level.test.mjs can assert the identity instead of guessing.
 */
export function createStrokePlan() {
  const values = {
    length: 0,
    thickness: 0,
    saturation: 0,
    dabRadius: 0,
    dabX: 0,
    dabY: 0,
    holdX: 0,
    holdAlpha: 0,
    rampIndex: 0,
    level: 0,
    hold: 0,
    width: 0,
    height: 0,
  };

  const clamp01 = (n) => (Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0);

  function compute(level, hold, width, height) {
    const w = Number.isFinite(width) ? Math.max(1, width) : 1;
    const h = Number.isFinite(height) ? Math.max(1, height) : 1;
    const lv = clamp01(level);
    const hd = clamp01(hold);

    values.width = w;
    values.height = h;
    values.level = lv;
    values.hold = hd;
    /* SPREAD: a short dry mark at the floor, a stroke across the sheet at the ceiling. */
    values.length = w * (0.05 + 0.9 * lv);
    values.thickness = h * (0.1 + 0.42 * lv);
    /* SATURATION: the glaze thickens with the level, and never vanishes at silence —
       an idle meter must still read as a floor rather than as an absence. */
    values.saturation = 0.22 + 0.68 * lv;
    values.dabRadius = values.thickness * (0.42 + 0.5 * lv);
    values.dabX = values.length;
    values.dabY = h * 0.5;
    /* THE PEAK HOLD: a tick at the held peak, fading as the hold decays, so a
       transient leaves a mark that then dries. */
    values.holdX = w * hd;
    values.holdAlpha = hd <= 0 ? 0 : 0.08 + 0.42 * hd;
    values.rampIndex = Math.min(STROKE_RAMP_STOPS - 1, Math.floor(lv * STROKE_RAMP_STOPS));
    return values;
  }

  return { compute, values: () => values };
}

/* =============================================================================
   3. THE PAINTER — a brush stroke, from the level the store carries
   ========================================================================== */

/** Points around the stroke's edge: more than a rectangle, few enough to be free. */
const EDGE_POINTS = 15;
const TAU = Math.PI * 2;

/** The ends and middle of the colour ramp, read from task 2's custom properties. */
const RAMP_LOW = '--sage-deep';
const RAMP_MID = '--ochre-deep';
const RAMP_HIGH = '--rose-deep';
const RAMP_ANNOTATION = '--ink-soft';

/**
 * The painted meter. Everything it draws from is allocated here, once:
 *   path    EDGE_POINTS*4 coordinates for the stroke's outline
 *   cos/sin the unit circle, so the frame loop needs no trig for the edge
 *   ramp    one rgb() string per ramp stop — no colour is ever built per frame
 *
 * `paint(hold)` takes the peak hold as an argument. The LEVEL comes from the store,
 * through readLevel(), because that is the contract web/ui/paint.js set out; the hold
 * is not a parameter and has no store key, so the frame loop hands it over.
 */
export function createMeterPainter({ canvas = null, store = defaultStore, plan = null } = {}) {
  const geometry = plan ?? createStrokePlan();
  const context = canvas ? canvas.getContext('2d') : null;
  const path = new Float64Array(EDGE_POINTS * 4);
  const cos = new Float64Array(EDGE_POINTS);
  const sin = new Float64Array(EDGE_POINTS);
  for (let i = 0; i < EDGE_POINTS; i += 1) {
    cos[i] = Math.cos((i / EDGE_POINTS) * TAU);
    sin[i] = Math.sin((i / EDGE_POINTS) * TAU);
  }

  const ramp = new Array(STROKE_RAMP_STOPS).fill('#000');
  const glint = new Array(STROKE_RAMP_STOPS).fill('#000');
  /** The peak-hold annotation colour. Read from the stylesheet with the ramp. */
  let annotationColor = '#000';
  let width = 1;
  let height = 1;
  let strokes = 0;

  /** Read the stylesheet's palette once. Everything the eye sees is mixed from task 2's
   *  custom properties at mount, so a repaint of the palette is a change to those and
   *  not to this file. The numeric triples are only fallbacks for a document whose
   *  stylesheet has not loaded. */
  function readPalette(doc) {
    const view = doc?.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    const style = view.getComputedStyle(doc.documentElement);
    const read = (token) => parseHexColor(style.getPropertyValue(token).trim());
    const low = read(RAMP_LOW) ?? { r: 90, g: 105, b: 85 };
    const mid = read(RAMP_MID) ?? { r: 143, g: 106, b: 31 };
    const high = read(RAMP_HIGH) ?? { r: 142, g: 92, b: 88 };
    const annotation = read(RAMP_ANNOTATION) ?? { r: 107, g: 97, b: 83 };
    for (let i = 0; i < STROKE_RAMP_STOPS; i += 1) {
      const t = i / (STROKE_RAMP_STOPS - 1);
      const from = t < 0.5 ? low : mid;
      const to = t < 0.5 ? mid : high;
      const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const r = Math.round(from.r + (to.r - from.r) * k);
      const g = Math.round(from.g + (to.g - from.g) * k);
      const b = Math.round(from.b + (to.b - from.b) * k);
      ramp[i] = `rgb(${r}, ${g}, ${b})`;
      glint[i] = `rgb(${Math.min(255, r + 80)}, ${Math.min(255, g + 74)}, ${Math.min(255, b + 62)})`;
    }
    /* The peak-hold tick is charcoal thinned twice: it is an annotation, not paint. */
    annotationColor = `rgb(${annotation.r}, ${annotation.g}, ${annotation.b})`;
    return true;
  }

  function measure() {
    if (!canvas) return false;
    const view = canvas.ownerDocument?.defaultView ?? globalThis;
    const ratio = Math.min(2, (view.devicePixelRatio ?? 1) || 1);
    const nextWidth = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const nextHeight = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (nextWidth === canvas.width && nextHeight === canvas.height) return false;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    width = nextWidth;
    height = nextHeight;
    return true;
  }

  /** One frame. Reads the level from the store and paints it. Allocation-free. */
  function paint(hold = 0) {
    /* THE READ. Through the store, by the key web/ui/paint.js documents. */
    const level = readLevel(store);
    const p = geometry.compute(level, hold, width, height);
    if (!context) return p;

    const midY = height * 0.5;
    const radius = p.thickness * 0.5;
    const phase = p.length * 0.0137;
    const floorThickness = Math.max(1, height * 0.035);

    context.clearRect(0, 0, width, height);

    /* THE FLOOR: a permanent thin wash along the bottom edge. An idle meter has to
       read as a level at the bottom of its travel, never as a broken widget. */
    context.globalAlpha = 0.16;
    context.fillStyle = ramp[0];
    context.fillRect(0, height - floorThickness, width, floorThickness);

    /* THE STROKE: one loaded brush mark — an ellipse whose long axis is the level's
       travel, so it is fat where the brush touched down at the left and tapers to the
       tip it was drawn out to. A bar chart would be a rectangle whose height is the
       reading; this is a mark whose SPREAD is the reading. The wobble comes from the
       stroke's own length, so it is a brush and not a shape, and it costs no state:
       both edges read one precomputed unit circle. */
    context.globalAlpha = p.saturation;
    context.fillStyle = ramp[p.rampIndex];
    context.beginPath();
    for (let i = 0; i < EDGE_POINTS; i += 1) {
      const wobble = 1 + 0.14 * Math.sin(i * 2.3 + phase) + 0.07 * Math.sin(i * 5.1 + phase * 1.7);
      const x = cos[i] * p.length;
      const y = midY + sin[i] * radius * wobble;
      path[i * 2] = x;
      path[i * 2 + 1] = y;
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    for (let i = EDGE_POINTS - 1; i >= 0; i -= 1) {
      const wobble = 1 + 0.14 * Math.sin(i * 2.3 + phase) + 0.07 * Math.sin(i * 5.1 + phase * 1.7);
      const x = cos[i] * p.length;
      const y = midY - sin[i] * radius * wobble;
      path[EDGE_POINTS * 2 + i * 2] = x;
      path[EDGE_POINTS * 2 + i * 2 + 1] = y;
      context.lineTo(x, y);
    }
    context.closePath();
    context.fill();

    /* THE WET DAB at the leading edge: the paint that has not dried yet. */
    if (p.dabRadius > 0.5) {
      context.globalAlpha = 0.2 + 0.45 * p.level;
      context.fillStyle = glint[p.rampIndex];
      context.beginPath();
      context.ellipse(
        p.dabX - p.dabRadius * 0.25,
        midY - p.dabRadius * 0.3,
        p.dabRadius,
        p.dabRadius * 0.72,
        phase,
        0,
        TAU,
      );
      context.fill();
    }

    /* THE PEAK HOLD: a dry tick where the last transient's peak is still held. */
    if (p.holdAlpha > 0) {
      context.globalAlpha = p.holdAlpha;
      context.fillStyle = annotationColor;
      const tick = Math.max(2, width * 0.004);
      context.fillRect(p.holdX - tick * 0.5, midY - radius, tick, radius * 2);
    }

    context.globalAlpha = 1;
    strokes += 1;
    return p;
  }

  return {
    paint,
    measure,
    readPalette,
    /** The buffers the frame loop draws from. Their identity must never change. */
    buffers: () => ({ path, cos, sin, ramp, glint, geometry }),
    strokes: () => strokes,
    size: () => ({ width, height }),
  };
}

/* =============================================================================
   4. THE INSPECTION HANDLE
   ========================================================================== */

/** Every field, in the order they are defined. handleFieldNames() hands this out so a
 *  test can walk the whole surface rather than trusting a list it wrote by hand. */
export const HANDLE_FIELDS = Object.freeze([
  /* --- the AudioContext ---------------------------------------------------- */
  'contextState', 'contextTime', 'sampleRate', 'latency',
  /* --- the analyser: RMS and the decaying peak hold ------------------------ */
  'rms', 'peak', 'dbfs', 'level', 'peakHold', 'peakHoldDbfs', 'meterFrames',
  'meterWindow', 'meterAllocations', 'meterTrace', 'levelKey',
  /* --- current parameter values -------------------------------------------- */
  'param', 'params', 'volume', 'tempo', 'swing', 'power', 'run',
  /* --- the firing sequencer step and pattern ------------------------------- */
  'step', 'absoluteStep', 'bar', 'pattern', 'chain', 'playing', 'sequencerState', 'firingNotes',
  /* --- drum voices: a trigger counter each --------------------------------- */
  'drums', 'drumCount', 'drumVoices', 'drumLive', 'drumLiveCount', 'drumNodes',
  /* --- the constructed effect and voice node inventory --------------------- */
  'effectNodes', 'nodeStats', 'voiceStates', 'voiceCount', 'voiceCapacity', 'heldNotes',
  /* --- diagnostics --------------------------------------------------------- */
  'errors', 'errorCount', 'errorCap', 'storage', 'paint', 'paintFrames', 'paintLevel', 'paintRing', 'ready',
]);

/** The published list. A copy, so a caller cannot edit the handle's own vocabulary. */
export function handleFieldNames() {
  return [...HANDLE_FIELDS];
}

/** The global the handle is published under. */
export const HANDLE_NAME = '__instrument';

/**
 * Build the inspection handle.
 *
 * `sources` is a bag of thunks, each optional, because in the page the audio graph is
 * resolved after the handle exists. A thunk returns the module (or nothing), never a
 * snapshot of it, so a field never caches a value that has since moved.
 *
 * Every accessor below: compute, freeze, return. Every setter: do nothing.
 */
export function createInspectionHandle(sources = {}) {
  /* --- caches, each keyed on a cheap version of what it caches -------------- */

  let drumCache = Object.freeze({});
  let drumVersion = -1;
  let paramCache = null;
  let paramVersion = -1;
  let paramSeen = -1;
  let errorCache = NO_ENTRIES;
  let errorVersion = -1;
  let inventoryCache = null;
  let inventorySignature = '';
  let storageCache = Object.freeze({});
  let storageCount = -1;

  /* A store write is the only thing that can change the parameter snapshot, and the
     store announces every write. So one subscription keeps the cache honest, with no
     poll and no snapshot of the snapshot. */
  const store = sources.store ?? null;
  if (store && typeof store.subscribeAll === 'function') {
    store.subscribeAll(() => {
      paramVersion += 1;
    });
  }

  /* --- resolution helpers -------------------------------------------------- */

  /* A source is either a value or a thunk returning one. The browser wiring passes
     thunks, because the audio graph is resolved after the handle is installed and a
     field must never cache a module that has since been replaced; a test can pass the
     value directly. Either way the field reads it NOW. */
  const resolve = (name) => {
    const source = sources[name];
    if (typeof source === 'function') {
      try {
        return source() ?? null;
      } catch {
        /* A source that throws is a source that is not ready. The handle must never be
           the thing that turns a half-wired page into a failed eval. */
        return null;
      }
    }
    return source ?? null;
  };

  const call = (module, name, fallback = null) => {
    if (!module || typeof module[name] !== 'function') return fallback;
    try {
      const value = module[name]();
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  const callOn = (module, name, argument, fallback = null) => {
    if (!module || typeof module[name] !== 'function') return fallback;
    try {
      const value = module[name](argument);
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  /* Some members of an existing module are plain values rather than functions — the
     paint handle's `capacity` and `levelKeys`, the voice engine's `capacity`. A read
     that insisted on a function would report a real number as absent, which is exactly
     the kind of quiet wrong answer this handle exists to avoid. */
  const readValue = (module, name, fallback = null) => {
    if (!module) return fallback;
    const member = module[name];
    if (typeof member === 'function') {
      try {
        return member() ?? fallback;
      } catch {
        return fallback;
      }
    }
    return member ?? fallback;
  };

  const freezeAll = (list) => (Array.isArray(list) ? Object.freeze([...list]) : Object.freeze([]));
  const frozen = (value) => (value && typeof value === 'object' ? Object.freeze({ ...value }) : Object.freeze({}));

  /* --- localStorage: READ ON ACCESS, never snapshotted ---------------------- */

  /**
   * The self-validation saves a preset and reads it straight back through the handle,
   * so a load-time snapshot would report a stale slot and fail a check that actually
   * passes. It is therefore read here, every time — and compared against the cache
   * key by key so a repeat read still hands back the same frozen object.
   */
  function readStorage() {
    const backing = resolve('storage') ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
    if (!backing || typeof backing.getItem !== 'function') return Object.freeze({});
    let count = 0;
    let next = null;
    try {
      count = Number(backing.length) || 0;
      next = {};
      for (let i = 0; i < count; i += 1) {
        const key = backing.key(i);
        if (key === null) continue;
        next[key] = backing.getItem(key);
      }
    } catch {
      /* Storage can refuse to be read at all: disabled cookies, a sandboxed frame. */
      return Object.freeze({});
    }
    if (count === storageCount && Object.keys(next).length === count) {
      let same = true;
      for (const key of Object.keys(storageCache)) {
        if (storageCache[key] !== next[key]) {
          same = false;
          break;
        }
      }
      if (same) return storageCache;
    }
    storageCount = count;
    storageCache = Object.freeze(next);
    return storageCache;
  }

  /** The captured errors, cached on the log's own count. */
  function readErrors() {
    const log = sources.errorLog ?? null;
    if (!log || typeof log.entries !== 'function') return NO_ENTRIES;
    const count = typeof log.count === 'function' ? log.count() : null;
    if (count !== null && count === errorVersion) return errorCache;
    errorVersion = count === null ? -1 : count;
    errorCache = freezeAll(log.entries());
    return errorCache;
  }

  /** The effect, node and voice inventories, cached against a cheap signature. */
  function readInventories() {
    const graph = resolve('graph');
    const effects = freezeAll(call(graph, 'effectNodes', []));
    const stats = frozen(call(graph, 'nodeStats', null));
    const voices = freezeAll(call(resolve('voices'), 'states', []));
    const signature = `${effects.length}|${stats.live ?? -1}|${stats.created ?? -1}|${voices.length}`;
    if (inventoryCache && inventorySignature === signature) return inventoryCache;
    inventorySignature = signature;
    inventoryCache = Object.freeze({ effects, stats, voices });
    return inventoryCache;
  }

  const drumKit = () => resolve('drums');
  const meter = () => resolve('meter');
  const clockModule = () => resolve('clock');
  const sequencerModule = () => resolve('sequencer');

  /* --- the fields, in handleFieldNames() order ----------------------------- */

  const fields = {
    /* the AudioContext */
    contextState: () => call(resolve('context'), 'state'),
    contextTime: () => call(resolve('context'), 'time'),
    sampleRate: () => call(resolve('context'), 'sampleRate'),
    latency: () => call(resolve('context'), 'baseLatency'),

    /* the analyser */
    rms: () => call(meter(), 'rms', 0),
    peak: () => call(meter(), 'peak', 0),
    dbfs: () => call(meter(), 'dbfs'),
    level: () => call(meter(), 'level', 0),
    peakHold: () => call(meter(), 'hold', 0),
    peakHoldDbfs: () => call(meter(), 'holdDbfs'),
    meterFrames: () => call(meter(), 'frames', 0),
    meterWindow: () => call(meter(), 'fftSize', 0),
    meterAllocations: () => call(meter(), 'allocations', 0),
    meterTrace: (limit) => {
      const m = meter();
      return m && typeof m.traceValues === 'function' ? m.traceValues(limit ?? METER_TRACE_LENGTH) : [];
    },
    levelKey: () => METER_LEVEL_KEY,

    /* parameter values */
    param: (key) => (store && typeof store.get === 'function' && typeof key === 'string' ? (store.get(key) ?? null) : null),
    params: () => {
      if (!store || typeof store.snapshot !== 'function') return Object.freeze({});
      if (paramCache !== null && paramVersion === paramSeen) return paramCache;
      paramSeen = paramVersion;
      paramCache = frozen(store.snapshot());
      return paramCache;
    },
    volume: () => fields.param('global.volume'),
    tempo: () => fields.param('global.tempo'),
    swing: () => fields.param('global.swing'),
    power: () => fields.param('global.power'),
    run: () => fields.param('global.run'),

    /* the firing step and pattern */
    step: () => call(clockModule(), 'stepCursor'),
    absoluteStep: () => call(clockModule(), 'position')?.absoluteStep ?? null,
    bar: () => call(clockModule(), 'position')?.bar ?? null,
    pattern: () => call(sequencerModule(), 'pattern', fields.param('seq.pattern')),
    chain: () => freezeAll(call(sequencerModule(), 'chain', [])),
    playing: () => call(clockModule(), 'running'),
    sequencerState: () => frozen(call(sequencerModule(), 'state', null)),
    firingNotes: (limit) => {
      const s = sequencerModule();
      return s && typeof s.firings === 'function' ? freezeAll(s.firings(limit ?? 24)) : [];
    },

    /* the eleven drum counters */
    drums: () => {
      const raw = call(drumKit(), 'counters', null);
      if (!raw || typeof raw !== 'object') return drumCache;
      /* The counters are monotonic, so their sum is monotonic too: an unchanged sum
         means nothing moved, and the frozen snapshot from last time is still true. */
      let sum = 0;
      for (const voice of KIT_VOICES) sum += Number(raw[voice]) || 0;
      if (sum !== drumVersion) {
        drumVersion = sum;
        drumCache = Object.freeze({ ...raw });
      }
      return drumCache;
    },
    drumCount: (voice) => {
      if (!KIT_VOICES.includes(voice)) return null;
      const raw = call(drumKit(), 'counters', null);
      const value = raw ? raw[voice] : null;
      return Number.isInteger(value) ? value : null;
    },
    drumVoices: () => freezeAll(call(drumKit(), 'voices', KIT_VOICES)),
    drumLive: (voice) => (KIT_VOICES.includes(voice) ? callOn(drumKit(), 'liveCount', voice, 0) : null),
    drumLiveCount: () => call(drumKit(), 'liveCountAll', 0),
    drumNodes: () => frozen(call(drumKit(), 'nodeReport', null)),

    /* the constructed effect and voice node inventory */
    effectNodes: () => readInventories().effects,
    nodeStats: () => readInventories().stats,
    voiceStates: () => readInventories().voices,
    voiceCount: () => freezeAll(call(resolve('voices'), 'states', [])).length,
    voiceCapacity: () => readValue(resolve('voices'), 'capacity'),
    heldNotes: () => freezeAll(call(resolve('voices'), 'held', [])),

    /* diagnostics */
    errors: () => readErrors(),
    errorCount: () => readErrors().length,
    errorCap: () => readValue(sources.errorLog, 'cap', 0),
    storage: () => readStorage(),
    /* The absorbed paint layer, projected read-only. ui/paint.js's own handle is not
       reproduced here — it can also switch the layer off, and this handle must not be
       able to. */
    paint: () => {
      const source = resolve('paint');
      if (!source) return null;
      return Object.freeze({
        frames: readValue(source, 'frames', 0),
        enabled: readValue(source, 'enabled', false),
        pending: readValue(source, 'pending', 0),
        capacity: readValue(source, 'capacity', 0),
        ring: frozen(readValue(source, 'ring', null)),
        level: readValue(source, 'level', 0),
        levelKeys: freezeAll(readValue(source, 'levelKeys', [])),
      });
    },
    paintFrames: () => call(resolve('paint'), 'frames', 0),
    paintLevel: () => call(resolve('paint'), 'level', 0),
    paintRing: () => frozen(call(resolve('paint'), 'ring', null)),
    ready: () => Boolean(resolve('ready')),
  };

  /* --- assemble: getter, inert setter, non-configurable -------------------- */

  const handle = {};
  for (const field of HANDLE_FIELDS) {
    const get = fields[field];
    if (typeof get !== 'function') throw new Error(`meter: handle field "${field}" has no accessor`);
    /* The property's GETTER HANDS BACK A FROZEN ACCESSOR, not the value. Two reasons,
       and the second is the important one:
         1. `handle.rms()` reads at the moment of the call. A handle that returned the
            value itself would go stale the moment it was read, and a stale
            verification instrument reports the wrong thing confidently.
         2. The fields that take an argument — drumCount, param, meterTrace — have to be
            callable. A getter returning a value cannot be called.
       Zero-argument fields get an allocation-free accessor; the few that take one get
       a forwarding accessor, whose argument array is bounded by what the caller passed.
    */
    const accessor = get.length === 0 ? Object.freeze(() => get()) : Object.freeze((...args) => get(...args));
    Object.defineProperty(handle, field, {
      get: () => accessor,
      /* THE INERT SETTER. Not an omission: it is what makes an assignment silent in
         strict mode instead of a TypeError. It writes nothing, ever. */
      set: () => {},
      enumerable: true,
      configurable: false,
    });
  }
  return Object.freeze(handle);
}

/* =============================================================================
   5. THE BROWSER BINDING — the only place audio is reached for
   ========================================================================== */

/** The global the paint layer published, which this module absorbs and removes. */
const PAINT_HANDLE_NAME = '__paint';

/** The paint layer's handle, kept here so the global can go while its data survives. */
let absorbedPaint = null;

/** Everything the handle reads once the audio graph has resolved. */
const boot = {
  meter: null,
  context: null,
  clock: null,
  sequencer: null,
  drums: null,
  voices: null,
  graph: null,
  ready: false,
};

function mountCanvas(doc) {
  const region = doc.querySelector('[data-region="global-strip"]') ?? doc.body;
  const canvas = doc.createElement('canvas');
  canvas.className = 'level-meter';
  canvas.dataset.meter = 'level';
  canvas.setAttribute('aria-hidden', 'true');
  /* Inline, because this task does not own the stylesheet: the stroke needs a real box
     to paint into, and it must never take a gesture from the controls above it. */
  canvas.style.cssText = 'display:block;width:100%;height:4rem;margin-top:0.5rem;pointer-events:none;touch-action:none;';
  region.append(canvas);
  return canvas;
}

/**
 * Absorb the paint layer's own global and remove it.
 *
 * Task 002 published `window.__paint` because the inspection handle did not exist yet.
 * It does now, and its read-only fields are reachable through `handle.paint()` /
 * `handle.paintFrames()`, so the second global goes. ui/paint.js is not this task's
 * file, so the removal happens from here rather than by editing it.
 */
function absorbPaintHandle() {
  const source = globalThis[PAINT_HANDLE_NAME];
  if (!source) return false;
  absorbedPaint = source;
  try {
    delete globalThis[PAINT_HANDLE_NAME];
  } catch {
    globalThis[PAINT_HANDLE_NAME] = undefined;
  }
  return true;
}

/**
 * Wire the meter and the handle into a page. Called from the module's own tail, so
 * index.html needs nothing but a script tag.
 */
export async function startMeter(doc = globalThis.document) {
  if (!doc) return null;

  /* Absorb immediately if paint.js has already run, and once more on DOMContentLoaded
     if it has not: both modules are deferred, and which evaluates first depends on
     nothing more reliable than their order in the document. */
  if (!absorbPaintHandle() && typeof doc.addEventListener === 'function') {
    doc.addEventListener('DOMContentLoaded', () => absorbPaintHandle(), { once: true });
  }

  const canvas = mountCanvas(doc);
  const painter = createMeterPainter({ canvas, store: defaultStore });
  painter.measure();
  painter.readPalette(doc);

  /* --- the frame loop ------------------------------------------------------- */

  const view = doc.defaultView ?? globalThis;
  const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let running = false;
  let rafHandle = 0;
  let frames = 0;

  function paintFrame(timestamp) {
    if (!running) return;
    rafHandle = 0;
    /* One measurement per frame. It publishes the level to the store itself, gated by
       its own epsilon, so the painted stroke and the dab layer behind it read one
       number from one authority. */
    boot.meter.update(timestamp);
    frames += 1;
    /* Under prefers-reduced-motion the READING still runs at full rate — it is data,
       not motion — but the repaint drops to ~10 Hz, which is where a moving image
       stops reading as an animation. */
    if (!reducedMotion || frames % 6 === 0) painter.paint(boot.meter.hold());
    if (running) rafHandle = view.requestAnimationFrame(paintFrame);
  }

  function begin() {
    if (running) return false;
    running = true;
    painter.measure();
    rafHandle = view.requestAnimationFrame(paintFrame);
    return true;
  }

  function end() {
    if (!running) return false;
    running = false;
    if (rafHandle !== 0 && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    return true;
  }

  if (typeof view.addEventListener === 'function') {
    view.addEventListener('resize', () => painter.measure(), { passive: true });
  }

  /* --- resolve the audio graph, then begin measuring ------------------------ */

  /* Dynamic imports, reached only here and only in a browser. Each of these modules
     is a READ from here: the analyser is handed to the meter factory and the meter
     calls one method on it. Nothing in this file creates or connects a node. */
  const [effects, drums, engine, contextModule, nodesModule, sequencerRun] = await Promise.all([
    import('../audio/effects.js'),
    import('../audio/drums.js'),
    import('../audio/engine.js'),
    import('../audio/context.js'),
    import('../audio/nodes.js'),
    import('../audio/sequencer-run.js'),
  ]);

  /* The context, projected onto the four reads the handle names. Nothing here writes
     to it and nothing schedules on it. */
  boot.context = {
    state: () => contextModule.contextState(),
    time: () => contextModule.contextTime(),
    sampleRate: () => contextModule.sampleRate,
    baseLatency: () => contextModule.audioContext?.baseLatency ?? null,
  };
  boot.clock = drums.clock;
  boot.sequencer = {
    pattern: () => defaultStore.get('seq.pattern'),
    chain: () => sequencerRun.chainOrder(),
    state: () => sequencerRun.sequencerState(),
    firings: (limit) => sequencerRun.arpFirings(limit),
  };
  boot.drums = {
    counters: () => drums.drumCounters(),
    voices: () => drums.drumKit.voices(),
    liveCount: (voice) => drums.drumKit.liveCount(voice),
    liveCountAll: () => drums.drumKit.liveCountAll(),
    nodeReport: () => drums.drumNodeReport(),
  };
  /* Projected onto the four reads the handle names. It is a projection rather than the
     engine object itself, so the handle's source contract is stated here and cannot
     drift if the engine renames a member. */
  boot.voices = {
    states: () => engine.voiceEngine.liveStates(),
    capacity: engine.voiceEngine.capacity,
    stats: () => engine.voiceEngine.stats(),
    held: () => engine.heldNotes(),
  };
  boot.graph = {
    effectNodes: () => effects.effectNodes(),
    nodeStats: () => nodesModule.nodeStats(),
  };

  boot.meter = createLevelMeter({
    analyser: effects.analyser,
    fftSize: effects.ANALYSER_FFT_SIZE,
    /* The level goes to the store under the key web/ui/paint.js documents, so the dab
       layer and this meter agree on one number read from one authority. */
    publish: (level) => defaultStore.set(METER_LEVEL_KEY, level, { source: 'meter' }),
  });

  boot.ready = true;
  painter.measure();
  begin();

  return Object.freeze({ painter, frames: () => frames, enabled: () => running, begin, end });
}

/* =============================================================================
   6. SELF-INITIALISE — and the error listeners, first of all
   ========================================================================== */

/* Installed at module scope, above everything else on purpose: these are the earliest
   listeners in the page, so a throw during any later module's evaluation is captured
   and self-validation step 3 can report it. */
export const errorLog = createErrorLog({
  target: typeof globalThis.addEventListener === 'function' ? globalThis : null,
});

/** The handle's sources. Fixed at module scope so the handle and the binding share it. */
const handleSources = {
  store: defaultStore,
  meter: () => boot.meter,
  errorLog,
  storage: () => (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null),
  paint: () => absorbedPaint,
  ready: () => boot.ready,
  context: () => boot.context,
  clock: () => boot.clock,
  sequencer: () => boot.sequencer,
  drums: () => boot.drums,
  voices: () => boot.voices,
  graph: () => boot.graph,
};

if (typeof globalThis.document !== 'undefined') {
  /* Installed synchronously, so a probe that reads the global a millisecond after load
     gets a handle and not `undefined`. The audio fields answer null until the dynamic
     imports above resolve. */
  globalThis[HANDLE_NAME] = createInspectionHandle(handleSources);
  startMeter(globalThis.document).catch((error) => {
    errorLog.push(`meter: boot failed: ${error && error.message ? error.message : error}`, 'error');
  });
}

export { METER_LEVEL_KEY, METER_TRACE_LENGTH };