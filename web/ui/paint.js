/**
 * paint.js — the impressionist surface, in two parts.
 *
 *   1. THE GROUND. A parchment sheet with broad soft washes and a fine impasto
 *      texture, all generated at runtime: an offscreen canvas per tile, handed to
 *      the stylesheet as a data-URL custom property. The site ships zero binary
 *      media, so nothing here references an image file.
 *
 *   2. THE REACTIVE DAB LAYER. A canvas behind the instrument that lays down dabs
 *      of paint whose number and size follow the output level. This is the one
 *      part of the surface with a real performance failure mode, so it is built to
 *      the constraint the plan states: a FIXED-CAPACITY ring buffer, no per-frame
 *      allocation, no growth over time, driven by requestAnimationFrame, and
 *      switchable off — at which point its rAF loop stops entirely.
 *
 * WHERE THE LEVEL COMES FROM
 *   Through the store, never from an audio module. The schema has no meter key
 *   yet, so the layer reads the first key in LEVEL_KEYS that carries a number
 *   and otherwise follows any write to one of them (params.js notifies on an
 *   undeclared key even though get() cannot read it back). TASK 013 binds the
 *   analyser: set `global.meter` (or `global.level`) to a 0..1 level and this
 *   layer reacts. Until then the level is silence and the layer stays quiet.
 *
 * ALLOCATION
 *   The dab records live in one Float32Array allocated once. Per frame the layer
 *   reuses one scratch array, one unit-circle table, one precomputed rgba string
 *   per palette entry, and writes nothing new. `allocations()` is a tripwire for
 *   anyone who later adds an object literal to the frame loop.
 *
 * This module touches no DOM at import time when there is none (node, tests); in a
 * page it self-initialises, so index.html needs nothing but a script tag.
 */
import { store as defaultStore } from './params.js';

/* =============================================================================
   1. COLOUR — the WCAG maths, so "charcoal legends on parchment clear AA" is a
   computed fact rather than an opinion. Also used by the verification harness.
   ========================================================================== */

/** '#f2ead8' | 'f2ead8' | '#fff' -> {r, g, b} in 0..255. Anything else -> null. */
export function parseHexColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(v) {
  const srgb = v / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance: 0.2126R + 0.7152G + 0.0722B, linearised. */
export function relativeLuminance(rgb) {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio, 1..21. Symmetric. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* =============================================================================
   2. THE IMPASTO FIELD — generated texture. White noise, so it tiles invisibly:
   there is no structure in it that could line up across a tile seam.
   ========================================================================== */

/** A small deterministic PRNG. Same seed, same field — so the ground is stable
 *  across reloads instead of reshuffling itself. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A size x size field of grain, in [-1, 1] with no cast: roughly a quarter of the
 * pixels are light ridges of paint and the rest are the gaps between them. Two
 * octaves, because one octave reads as television static rather than canvas.
 */
export function impastoField(size, { seed = 1 } = {}) {
  const fine = mulberry32(seed);
  const coarse = mulberry32(seed ^ 0x9e3779b9);
  const field = new Float32Array(size * size);
  for (let i = 0; i < field.length; i += 1) {
    field[i] = (fine() + fine() - 1) * 0.7 + (coarse() - 0.5) * 0.6;
  }
  return field;
}

/**
 * A size x size field of broad brush ridges. Every component is a sine whose
 * frequency is an integer number of cycles across the tile, so the tile is
 * seamless and the overlay has no grid to see.
 */
export function brushworkField(size, { seed = 2 } = {}) {
  const random = mulberry32(seed);
  const cycles = [
    [3, 1, 0.5],
    [1, -5, 0.32],
    [7, 2, 0.2],
    [-2, 9, 0.14],
  ].map(([a, b, amp]) => [a, b, amp, random() * Math.PI * 2]);
  const field = new Float32Array(size * size);
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      let value = 0;
      for (const [a, b, amp, phase] of cycles) value += amp * Math.sin(tau * (a * u + b * v) + phase);
      field[y * size + x] = Math.max(-1, Math.min(1, value));
    }
  }
  return field;
}

/* =============================================================================
   3. THE DAB RING — fixed capacity, FIFO overwrite, never grows.
   ========================================================================== */

/** A few hundred dabs: enough to read as a wet surface, few enough that a frame
 *  of painting them is free. */
export const DAB_CAPACITY = 256;
/** x, y, r, hueIndex, lifeMs, bornAt — six numbers per dab, in one flat array. */
export const DAB_STRIDE = 6;

/**
 * A ring buffer of dab records. `slots` is allocated once and never replaced, so
 * the layer can paint from it every frame without touching the allocator.
 *
 * Insertion order is age order, so the tail is always the oldest dab: that is the
 * one a full ring overwrites, and the only end expiry reclaims from.
 */
export function createDabRing(capacity = DAB_CAPACITY) {
  const slots = new Float32Array(capacity * DAB_STRIDE);
  let head = 0; // next slot to write
  let tail = 0; // oldest live dab
  let count = 0;
  let pushed = 0;

  function dropExpired(now) {
    while (count > 0) {
      const base = tail * DAB_STRIDE;
      const life = slots[base + 4];
      const born = slots[base + 5];
      if (life <= 0 || now - born >= life) {
        tail = (tail + 1) % capacity;
        count -= 1;
      } else break;
    }
  }

  return {
    capacity,
    slots,
    get length() {
      return count;
    },
    get sequence() {
      return pushed;
    },

    /**
     * Add a dab, overwriting the oldest one if the ring is full. Expiry is
     * reclaimed first, so in ordinary use the ring never reaches its ceiling;
     * the ceiling is the guarantee, not the normal case. Never grows.
     *
     * Returns the slot the dab landed in.
     */
    push(x, y, r, hueIndex, lifeMs, now) {
      dropExpired(now);
      const slot = head;
      const base = slot * DAB_STRIDE;
      slots[base] = x;
      slots[base + 1] = y;
      slots[base + 2] = r;
      slots[base + 3] = hueIndex;
      slots[base + 4] = lifeMs;
      slots[base + 5] = now;
      head = (head + 1) % capacity;
      /* Full means head has wrapped onto tail: the write above replaced the
       * oldest dab, and the live count stays at the ceiling. */
      if (count < capacity) count += 1;
      pushed += 1;
      return slot;
    },

    /** Drop every dab whose life has run out. Called once per frame, not only on
     *  a push, so a layer that has gone quiet reports zero live dabs rather than
     *  a frozen count of expired ones. */
    reclaim(now) {
      dropExpired(now);
      return count;
    },

    /** Copy dab `index` (oldest first) into `out`. No allocation. */
    read(index, out) {
      const base = ((tail + index) % capacity) * DAB_STRIDE;
      for (let k = 0; k < DAB_STRIDE; k += 1) out[k] = slots[base + k];
      return out;
    },

    clear() {
      slots.fill(0);
      head = 0;
      tail = 0;
      count = 0;
    },
  };
}

/* =============================================================================
   4. THE LEVEL READ — through the store, and only the store.
   ========================================================================== */

/** Where the output level may arrive. `global.meter` is the intended one; the
 *  others are aliases so a later module is not blocked on a naming decision. */
export const LEVEL_KEYS = ['global.meter', 'global.level', 'ui.level'];

/** store -> its most recent level write. A WeakMap, so a discarded store takes
 *  its subscription with it. */
const mirrors = new WeakMap();

function ensureMirror(store) {
  let mirror = mirrors.get(store);
  if (mirror) return mirror;
  mirror = { value: 0 };
  store.subscribeAll((key, value) => {
    if (!LEVEL_KEYS.includes(key)) return;
    mirror.value = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });
  mirrors.set(store, mirror);
  return mirror;
}

/**
 * The current output level, 0..1. A declared key is read straight from the store;
 * an undeclared one is followed through the mirror, because params.js notifies on
 * an undeclared write even though get() will not hand it back.
 *
 * The mirror is established on the FIRST call, so something must read the level
 * once before the writes arrive. Constructing a dab layer does that.
 */
export function readLevel(store = defaultStore) {
  const mirror = ensureMirror(store);
  for (const key of LEVEL_KEYS) {
    const value = store.get(key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 0 ? 0 : value > 1 ? 1 : value;
    }
  }
  return mirror.value < 0 ? 0 : mirror.value > 1 ? 1 : mirror.value;
}

/* =============================================================================
   5. THE REACTIVE DAB LAYER
   ========================================================================== */

/** Points around a dab's edge. More than a circle, few enough to be free. */
const EDGE_POINTS = 13;
/** The palette entries the dabs are mixed from — the five broken hues. */
const DAB_HUES = ['sky', 'rose', 'ochre', 'lavender', 'sage'];

/** Unit circle + a wobble band, both built once so the frame loop needs no trig. */
const COS = new Float64Array(EDGE_POINTS);
const SIN = new Float64Array(EDGE_POINTS);
for (let i = 0; i < EDGE_POINTS; i += 1) {
  COS[i] = Math.cos((i / EDGE_POINTS) * Math.PI * 2);
  SIN[i] = Math.sin((i / EDGE_POINTS) * Math.PI * 2);
}

/**
 * The reactive paint layer.
 *
 * @param {object}   options
 * @param {object}   options.canvas  an HTMLCanvasElement, or nothing for tests
 * @param {object}   options.store   the parameter store the level is read from
 * @param {Function} options.raf     requestAnimationFrame (injectable for tests)
 * @param {Function} options.caf     cancelAnimationFrame
 * @param {Function} options.now     Date.now, for the dab lifetimes
 */
export function createDabLayer({ canvas = null, store = defaultStore, raf, caf, now } = {}) {
  const requestFrame = raf ?? ((fn) => globalThis.requestAnimationFrame(fn));
  const cancelFrame = caf ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  const clock = now ?? (() => Date.now());

  const ring = createDabRing();
  const scratch = new Float64Array(DAB_STRIDE); // reused by every read
  const context = canvas ? canvas.getContext('2d') : null;
  const random = mulberry32(0x5eed);

  let handle = 0;
  let running = false;
  let frames = 0;
  let width = 1;
  let height = 1;
  let sinceSpawn = 0;

  /* Read once at construction so the store's mirror exists before task 013 has
   * anything to publish. */
  readLevel(store);

  /* The dab colours are the stylesheet's palette, read once. One colour string per
   * entry; per-dab fading is globalAlpha, so the frame loop builds no colours. */
  const fills = new Array(DAB_HUES.length).fill('#000');
  const glints = new Array(DAB_HUES.length).fill('#000');
  function readPalette() {
    const root = getComputedStyle(document.documentElement);
    for (let i = 0; i < DAB_HUES.length; i += 1) {
      const rgb = parseHexColor(root.getPropertyValue(`--${DAB_HUES[i]}`).trim());
      if (!rgb) continue;
      fills[i] = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
      glints[i] = `rgb(${Math.min(255, rgb.r + 90)}, ${Math.min(255, rgb.g + 90)}, ${Math.min(255, rgb.b + 70)})`;
    }
  }

  function measure() {
    if (!canvas) return;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const nextWidth = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const nextHeight = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (nextWidth === canvas.width && nextHeight === canvas.height) return;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    width = nextWidth;
    height = nextHeight;
    ring.clear();
  }

  function spawn(level, stamp) {
    const hueIndex = Math.floor(random() * DAB_HUES.length);
    const x = random() * width;
    const y = height * (0.28 + random() * 0.66);
    const r = (0.006 + random() * 0.02) * Math.min(width, height) * (0.45 + level);
    const life = 700 + random() * 1100 + level * 900;
    ring.push(x, y, r, hueIndex, life, stamp);
  }

  function draw(level, stamp) {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const count = ring.length;
    for (let i = 0; i < count; i += 1) {
      ring.read(i, scratch);
      const life = scratch[4];
      const age = stamp - scratch[5];
      if (life <= 0 || age >= life) continue;
      const fade = 1 - age / life;
      const x = scratch[0];
      const y = scratch[1];
      const r = scratch[2];
      const hueIndex = scratch[3] | 0;
      /* The wobble phase is derived from the dab's own position, so every dab has
       * its own edge without storing a per-dab phase. */
      const phase = x * 0.0137 + y * 0.0211;

      context.globalAlpha = fade * (0.2 + level * 0.5);
      context.fillStyle = fills[hueIndex];
      context.beginPath();
      for (let p = 0; p < EDGE_POINTS; p += 1) {
        const wobble = 1 + 0.16 * Math.sin(p * 2.3 + phase) + 0.09 * Math.sin(p * 5.1 + phase * 1.7);
        const px = x + COS[p] * r * wobble;
        const py = y + SIN[p] * r * wobble;
        if (p === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.closePath();
      context.fill();

      /* the wet highlight: the light that says the paint has not dried */
      context.globalAlpha = fade * fade * (0.24 + level * 0.46);
      context.fillStyle = glints[hueIndex];
      context.beginPath();
      context.ellipse(x - r * 0.28, y - r * 0.32, r * 0.42, r * 0.3, phase, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  /** The frame loop is entered only by a live rAF. A callback that was already
   *  queued when the layer was switched off does nothing at all — that is what
   *  makes the frame counter a proof the loop stopped. */
  function tick(timestamp) {
    if (!running) return;
    handle = 0;
    frames += 1;
    const level = readLevel(store);
    const stamp = Number.isFinite(timestamp) ? timestamp : clock();
    ring.reclaim(stamp);

    sinceSpawn += 1;
    const cadence = Math.max(2, Math.round(10 - level * 8));
    if (level > 0.02 && sinceSpawn >= cadence) {
      sinceSpawn = 0;
      spawn(level, stamp);
    }
    draw(level, stamp);

    if (running) handle = requestFrame(tick);
  }

  const layer = {
    ring,
    tick,
    measure,

    frames: () => frames,
    pending: () => handle,
    enabled: () => running,

    /** The three buffers the frame loop draws from. Their object identity must
     *  never change: that is the allocation-free guarantee, checkable. */
    buffers: () => ({ slots: ring.slots, scratch, fills }),

    start() {
      if (running && handle !== 0) return layer;
      running = true;
      measure();
      handle = requestFrame(tick);
      return layer;
    },

/** Switch the layer off. The rAF chain is cancelled outright — no orphaned
   *  loop survives, which is the whole point of the switch — and the paint it
   *  laid down is cleared, so the ground goes back to bare parchment. */
    stop() {
      running = false;
      if (handle !== 0) {
        cancelFrame(handle);
        handle = 0;
      }
      ring.clear();
      sinceSpawn = 0;
      if (context) context.clearRect(0, 0, width, height);
      return layer;
    },

    setEnabled(on) {
      return on ? layer.start() : layer.stop();
    },
  };

  if (context) readPalette();
  return layer;
}

/* =============================================================================
   6. THE GROUND — runtime-generated texture handed to the stylesheet
   ========================================================================== */

/** One tile: a field drawn as light ridges on dark, or the reverse. */
function tileToDataUrl(field, size, { light = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  const data = image.data;
  for (let i = 0; i < field.length; i += 1) {
    const value = field[i];
    const ridge = light ? value : -value;
    const alpha = ridge > 0 ? ridge * 255 : 0;
    const target = ridge > 0 ? 255 : 43;
    const at = i * 4;
    data[at] = target;
    data[at + 1] = target;
    data[at + 2] = light ? target : 39;
    data[at + 3] = alpha > 255 ? 255 : alpha;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Generate the two ground tiles and publish them as custom properties. */
export function installImpasto(doc = document) {
  const grain = tileToDataUrl(impastoField(128, { seed: 1 }), 128, { light: true });
  const brush = tileToDataUrl(brushworkField(192, { seed: 2 }), 192, { light: false });
  doc.documentElement.style.setProperty('--impasto-grain', `url("${grain}")`);
  doc.documentElement.style.setProperty('--impasto-brush', `url("${brush}")`);
  return true;
}

/* =============================================================================
   7. SELF-INITIALISE
   ========================================================================== */

/** The dab layer's canvas: behind the instrument, never a pointer target. */
function mountCanvas(doc) {
  const canvas = doc.createElement('canvas');
  canvas.className = 'paint-layer';
  canvas.dataset.paintLayer = 'dabs';
  canvas.setAttribute('aria-hidden', 'true');
  (doc.body ?? doc.documentElement).append(canvas);
  return canvas;
}

export function startPainting(doc = document) {
  installImpasto(doc);
  const canvas = mountCanvas(doc);
  const layer = createDabLayer({ canvas, store: defaultStore });
  const root = doc.documentElement;

  const paint = {
    layer,
    frames: () => layer.frames(),
    enabled: () => layer.enabled(),
    setEnabled(on) {
      layer.setEnabled(Boolean(on));
      root.dataset.paintLayerOn = String(layer.enabled());
      return layer.enabled();
    },
    pending: () => layer.pending(),
    capacity: DAB_CAPACITY,
    ring: () => ({ capacity: layer.ring.capacity, length: layer.ring.length }),
    level: () => readLevel(defaultStore),
    levelKeys: LEVEL_KEYS,
    contrast: (a, b) => contrastRatio(parseHexColor(a), parseHexColor(b)),
    luminance: (hex) => relativeLuminance(parseHexColor(hex)),
  };

  /* Task 002's verification handle. Read-mostly, and scoped to the paint layer
   * only — task 013 folds this into the instrument-wide inspection handle. */
  globalThis.__paint = paint;

  globalThis.addEventListener('resize', () => layer.measure(), { passive: true });
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reducedMotion) {
    root.dataset.paintLayerOn = 'false';
    paint.setEnabled(false);
  } else {
    root.dataset.paintLayerOn = 'true';
    layer.start();
  }
  return paint;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startPainting(), { once: true });
  } else {
    startPainting();
  }
}