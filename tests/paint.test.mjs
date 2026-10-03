/**
 * paint.test.mjs — the logic behind the impressionist visual layer, tested
 * without a DOM: the WCAG contrast maths and the palette it is applied to, the
 * fixed-capacity dab ring buffer, the store->level read, and the generated
 * impasto field.
 *
 * Framework-free: `node --test tests/paint.test.mjs`.
 *
 * The claims these tests defend are the ones that silently degrade:
 *   - a ring buffer that grows (or an array replaced per frame) is the failure
 *     mode the plan names explicitly for the reactive dab layer;
 *   - a palette that drifts below 4.5:1 puts the legends on the exact text
 *     that explains the instrument;
 *   - a level read that reaches past the store, or allocates to do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DAB_CAPACITY,
  DAB_STRIDE,
  LEVEL_KEYS,
  contrastRatio,
  createDabLayer,
  createDabRing,
  impastoField,
  mulberry32,
  parseHexColor,
  readLevel,
  relativeLuminance,
} from '../web/ui/paint.js';
import { createStore, SCHEMA } from '../web/ui/params.js';

/* --------------------------------------------------------------- the palette --- */

const baseCss = readFileSync(new URL('../web/styles/base.css', import.meta.url), 'utf8');

function token(name, file = baseCss) {
  const root = file.slice(file.indexOf(':root'), file.indexOf('\n}', file.indexOf(':root')));
  const found = root.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(found, `--${name} must be defined in the :root block`);
  return found[1].trim();
}

test('parseHexColor reads 3- and 6-digit hex, with or without the hash', () => {
  assert.deepEqual(parseHexColor('#f2ead8'), { r: 242, g: 234, b: 216 });
  assert.deepEqual(parseHexColor('f2ead8'), { r: 242, g: 234, b: 216 });
  assert.deepEqual(parseHexColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.equal(parseHexColor('rgb(1,2,3)'), null, 'only hex is accepted; anything else returns null');
  assert.equal(parseHexColor('#12345'), null, 'a malformed hex returns null rather than throwing');
});

test('relativeLuminance follows the WCAG sRGB transfer function', () => {
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  /* Worked by hand: 0.5 -> ((0.5+0.055)/1.055)^2.4 */
  assert.ok(Math.abs(relativeLuminance({ r: 128, g: 128, b: 128 }) - 0.2158605) < 1e-6);
});

test('contrastRatio is symmetric and matches the WCAG definition', () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(black, white), 21);
  /* (L1 + 0.05) / (L2 + 0.05) — the +0.05 is the part that is easy to drop */
  assert.ok(Math.abs(contrastRatio(black, black) - 1) < 1e-12);
});

test('every ink token clears WCAG AA against the ground and the panel', () => {
  const ground = parseHexColor(token('ground'));
  const panel = parseHexColor(token('panel'));
  assert.ok(ground, '--ground must be a hex this module can read');
  for (const name of ['ink', 'ink-soft', 'ink-faint']) {
    const ink = parseHexColor(token(name));
    const onGround = contrastRatio(ink, ground);
    const onPanel = contrastRatio(ink, panel);
    assert.ok(onGround >= 4.5, `--${name} on --ground is ${onGround.toFixed(2)}:1, needs >= 4.5`);
    assert.ok(onPanel >= 4.5, `--${name} on --panel is ${onPanel.toFixed(2)}:1, needs >= 4.5`);
  }
});

test('the ground is a warm parchment around #f2ead8, and nothing in the palette is dark', () => {
  const { r, g, b } = parseHexColor(token('ground'));
  assert.ok(r > 220 && g > 200 && b > 170, `ground is too dark to be parchment: ${r},${g},${b}`);
  assert.ok(g <= r && b < g, 'a warm parchment is red > green > blue');
  const luma = relativeLuminance({ r, g, b });
  assert.ok(luma > 0.6, `a parchment ground is bright; luminance ${luma.toFixed(3)}`);
  /* The Thor reference is dark brushed metal. Nothing here may read as charcoal. */
  for (const name of ['panel', 'ground-deep', 'sage', 'sky', 'rose', 'ochre', 'lavender']) {
    assert.ok(relativeLuminance(parseHexColor(token(name))) > 0.25, `--${name} is too dark to be a wash`);
  }
});

/* ------------------------------------------------------------- the dab ring --- */

/** Every live dab, oldest first, as [x, y, r, hueIndex]. */
function dabs(ring) {
  const scratch = new Float64Array(DAB_STRIDE);
  const rows = [];
  for (let i = 0; i < ring.length; i += 1) {
    ring.read(i, scratch);
    rows.push([...scratch].slice(0, 4));
  }
  return rows;
}

test('the dab ring has a fixed capacity and never grows', () => {
  const ring = createDabRing();
  assert.equal(ring.capacity, DAB_CAPACITY);
  assert.ok(ring.capacity >= 100 && ring.capacity <= 1000, 'a few hundred dabs, not thousands');
  for (let i = 0; i < DAB_CAPACITY * 5; i += 1) ring.push(i, i, 10, 0, 1000, i);
  assert.equal(ring.length, DAB_CAPACITY, 'the live count is capped at the capacity');
  assert.equal(ring.slots.length, DAB_CAPACITY * DAB_STRIDE, 'the backing store is allocated once');
});

test('the dab ring overwrites the oldest entry when it is full', () => {
  const ring = createDabRing(4);
  for (let i = 0; i < 4; i += 1) ring.push(i, 0, 10, 0, 1000, i);
  assert.deepEqual(dabs(ring), [[0, 0, 10, 0], [1, 0, 10, 0], [2, 0, 10, 0], [3, 0, 10, 0]]);

  ring.push(99, 0, 10, 0, 1000, 4);
  assert.equal(ring.length, 4, 'still exactly at capacity');
  assert.deepEqual(
    dabs(ring),
    [[99, 0, 10, 0], [1, 0, 10, 0], [2, 0, 10, 0], [3, 0, 10, 0]],
    'the oldest dab is the one the new one replaced; the rest keep their order',
  );
  assert.equal(ring.slots.length, 4 * DAB_STRIDE, 'overwriting did not reallocate the backing store');
});

test('the dab ring reclaims expired slots from the oldest end', () => {
  const ring = createDabRing(4);
  ring.push(0, 0, 10, 0, 100, 0);
  ring.push(1, 0, 10, 0, 100, 10);
  ring.push(2, 0, 10, 0, 1000, 20);
  assert.equal(ring.length, 3);
  ring.push(3, 0, 10, 0, 1000, 200); // pushes past both expired entries
  assert.equal(ring.length, 2, 'the two dabs whose life ran out are gone');
  assert.deepEqual(dabs(ring), [[2, 0, 10, 0], [3, 0, 10, 0]]);
});

test('the dab ring clears and survives a read into a caller-owned array', () => {
  const ring = createDabRing(3);
  ring.push(5, 6, 7, 1, 50, 0);
  const out = new Float64Array(DAB_STRIDE);
  ring.read(0, out);
  assert.deepEqual([...out], [5, 6, 7, 1, 50, 0]);
  ring.clear();
  assert.equal(ring.length, 0);
  ring.read(0, out);
  assert.deepEqual([...out], new Array(DAB_STRIDE).fill(0), 'reading an empty slot yields zeroes, not stale data');
});

/* -------------------------------------------------------------- the level read --- */

test('readLevel prefers a declared store key', () => {
  const store = createStore({ ...SCHEMA, 'global.meter': { kind: 'number', min: 0, max: 1, def: 0 } });
  store.set('global.meter', 0.42);
  assert.equal(readLevel(store), 0.42);
});

test('readLevel mirrors a write to an undeclared key and clamps it', () => {
  /* The meter key does not exist in the schema yet; params.js stores an
   * undeclared key verbatim and notifies, so the layer can still follow it —
   * provided something has read the level once to open the mirror. */
  const store = createStore(SCHEMA);
  assert.equal(readLevel(store), 0, 'the first read is what opens the mirror');
  store.set('global.meter', 5);
  assert.equal(readLevel(store), 1, 'clamped to the top of the range');
  store.set('global.meter', -3);
  assert.equal(readLevel(store), 0, 'clamped to the floor');
  store.set('global.meter', 'loud');
  assert.equal(readLevel(store), 0, 'a non-number is silence, not NaN');
});

test('readLevel accepts any of the keys the level may arrive on', () => {
  assert.ok(LEVEL_KEYS.length >= 1);
  for (const key of LEVEL_KEYS) {
    const fresh = createStore(SCHEMA);
    readLevel(fresh);
    fresh.set(key, 0.75);
    assert.equal(readLevel(fresh), 0.75, `${key} must be readable as the level`);
  }
  assert.equal(readLevel(createStore(SCHEMA)), 0, 'nothing published yet is silence, not an error');
});

/* ------------------------------------------------------------ the dab layer --- */

function fakeClock() {
  const raf = [];
  const cancelled = [];
  return {
    raf,
    cancelled,
    rafFn: (fn) => raf.push(fn) && raf.length,
    cafFn: (handle) => cancelled.push(handle),
    nowFn: () => 0,
  };
}

test('the dab layer counts frames only while it is enabled', () => {
  const clock = fakeClock();
  const layer = createDabLayer({ store: createStore(SCHEMA), raf: clock.rafFn, caf: clock.cafFn });
  assert.equal(layer.frames(), 0, 'nothing runs before start()');
  assert.equal(layer.enabled(), false);

  layer.start();
  layer.tick(16);
  layer.tick(32);
  assert.equal(layer.frames(), 2, 'the frame counter advances while the loop runs');
  assert.equal(layer.enabled(), true);

  layer.stop();
  layer.tick(48);
  assert.equal(layer.frames(), 2, 'the frame counter is frozen once the layer is off');
  assert.ok(clock.cancelled.length >= 1, 'stopping cancels the outstanding rAF handle');
  assert.equal(layer.pending(), 0, 'no orphaned requestAnimationFrame is left behind');
});

test('starting the dab layer twice does not leave two loops running', () => {
  const clock = fakeClock();
  const layer = createDabLayer({ store: createStore(SCHEMA), raf: clock.rafFn, caf: clock.cafFn });
  layer.start();
  layer.start();
  assert.equal(clock.raf.length, 1, 'exactly one rAF outstanding');
  layer.tick(16);
  assert.equal(clock.raf.length, 2, 'still one chain, not two');
  layer.stop();
  assert.equal(layer.pending(), 0);
});

test('the dab layer never reallocates its buffers, and holds to its capacity', () => {
  const store = createStore(SCHEMA);
  const layer = createDabLayer({ store, raf: () => 1, caf: () => {} });
  layer.start();
  const before = layer.buffers();
  for (let i = 0; i < 600; i += 1) layer.tick(i * 16);
  const after = layer.buffers();
  assert.equal(after.slots, before.slots, 'the dab backing store was replaced — that is an allocation per frame');
  assert.equal(after.scratch, before.scratch, 'the read buffer was replaced');
  assert.equal(after.fills, before.fills, 'the palette strings were rebuilt');
  assert.equal(layer.ring.capacity, DAB_CAPACITY);
  assert.ok(layer.ring.length <= DAB_CAPACITY, 'the live dab count stays inside the capacity');
  layer.stop();
});

test('a louder level grows the dab layer and silence empties it', () => {
  const store = createStore(SCHEMA);
  const layer = createDabLayer({ store, raf: () => 1, caf: () => {} });
  layer.start();
  store.set('global.meter', 0);
  for (let i = 0; i < 240; i += 1) layer.tick(i * 16);
  const quiet = layer.ring.length;

  store.set('global.meter', 1);
  for (let i = 240; i < 400; i += 1) layer.tick(i * 16);
  assert.ok(layer.ring.length > quiet, `a loud meter should paint more dabs (${quiet} -> ${layer.ring.length})`);

  store.set('global.meter', 0);
  for (let i = 400; i < 400 + 4000; i += 1) layer.tick(i * 16);
  assert.equal(layer.ring.length, 0, 'every dab expires once the level falls to silence');
  layer.stop();
});

/* ------------------------------------------------------------ the impasto field --- */

test('mulberry32 is deterministic for a seed and bounded', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 64; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1, `${value} is outside [0, 1)`);
  }
  assert.notEqual(mulberry32(7)(), mulberry32(8)(), 'a different seed is a different field');
});

test('the impasto field is a fixed-size, deterministic, centred grain', () => {
  const size = 32;
  const field = impastoField(size, { seed: 3 });
  assert.ok(field instanceof Float32Array);
  assert.equal(field.length, size * size);
  assert.deepEqual([...field.subarray(0, 16)], [...impastoField(size, { seed: 3 }).subarray(0, 16)]);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of field) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  assert.ok(max <= 1.0000001 && min >= -1.0000001, `grain outside [-1, 1]: ${min}..${max}`);
  assert.ok(max > 0.05, 'the field must actually carry texture, not a flat fill');
  const mean = sum / field.length;
  assert.ok(Math.abs(mean) < 0.15, `a wash of grain with no cast: mean ${mean.toFixed(3)}`);
});

/* ------------------------------------------------------ the stylesheet contract --- */

test('no wash re-wraps a hex token in rgb()', () => {
  /* `rgb(var(--hue) / 0.4)` is invalid: --hue is a hex, and a hex cannot be
   * re-wrapped in rgb(). Chromium drops the ENTIRE background shorthand when one
   * colour function in it is invalid, which silently unpaints a control — the
   * dab loses its pigment, its glint and its tick ring all at once. The channel
   * tokens end in -rgb and are the only ones legal here. */
  const offenders = [];
  for (const name of ['base.css', 'controls.css', 'paint.css']) {
    const css = readFileSync(new URL(`../web/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/rgb\(\s*var\((--[a-z-]+)\)\s*\//g)) {
      if (!match[1].endsWith('-rgb')) offenders.push(`${name}: rgb(var(${match[1]}) / …)`);
    }
  }
  assert.deepEqual(offenders, [], 'these washes are silently dropped by the browser');
});

test('the impressionist stylesheet is first-party and names no image file', () => {
  const paintCss = readFileSync(new URL('../web/styles/paint.css', import.meta.url), 'utf8');
  const paintJs = readFileSync(new URL('../web/ui/paint.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

  assert.ok(!/@import/.test(paintCss), 'no CSS @import');
  assert.ok(!/@font-face/.test(paintCss), 'no webfont');
  assert.ok(!/@font-face/.test(baseCss), 'no webfont in the base either');
  for (const [name, file] of [['paint.css', paintCss], ['paint.js', paintJs], ['index.html', html]]) {
    const withoutComments = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !/(https?:)?\/\/(?!synth-like-thing\.ddev\.site)/.test(withoutComments),
      `${name} must not reference a remote origin`,
    );
  }
  assert.ok(
    !/url\(\s*['"]?(?!\$\{|var\()['"]?[^)'"]*\.(png|jpe?g|gif|webp|svg|avif)/i.test(paintCss),
    'the shipped stylesheet references no image file — the texture is generated',
  );
  assert.ok(
    /createElement\('canvas'\)/.test(paintJs) && /toDataURL/.test(paintJs),
    'the impasto texture is generated at runtime and exposed as a data URL',
  );
});

test('every region carries a section hue, and the playhead accent is its own token', () => {
  const paintCss = readFileSync(new URL('../web/styles/paint.css', import.meta.url), 'utf8');
  for (const id of [
    'global-strip',
    'voice-row',
    'tone-row',
    'modulation-row',
    'effects-row',
    'drum-kit',
    'sequencer',
    'keyboard',
  ]) {
    assert.match(
      paintCss,
      new RegExp(`\\[data-region="${id}"\\]\\s*\\{[^}]*--section-rgb`),
      `${id} needs a section hue so colour carries section membership`,
    );
  }
  const root = paintCss.slice(0, paintCss.indexOf('\n}'));
  assert.match(root, /--playhead:/, 'the playing-step accent is a token of its own');
  assert.match(root, /--playhead-rgb:/, 'the playing-step accent exposes its channels for washes');
  assert.ok(
    !/--(playhead)[\s:]*[^;]*var\(--(sage|sky|rose|ochre|lavender)\)/.test(root),
    'the playhead accent must not be one of the five lane hues',
  );
});

/*
 * This asserts the stylesheet DECLARES the narrow-viewport rules. It does not
 * assert the layout does not overflow, and must not claim to: it reads source,
 * so it cannot see a rendered result. It passed straight through a regression
 * where the page scrolled 218px sideways at 390px, because the keybed had no
 * bounded scroll container — a fact no amount of grepping the CSS reveals.
 *
 * The rendered guarantee lives in tests/responsive.test.mjs, which drives a real
 * browser at 390px and 1600px. This test's job is narrower: keep the rules this
 * file owns honest about what they are.
 */
test('the narrow-viewport rules this stylesheet owns are declared', () => {
  const paintCss = readFileSync(new URL('../web/styles/paint.css', import.meta.url), 'utf8');
  const narrow = paintCss.match(/@media\s*\(max-width:\s*56\.25rem\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'the stack breakpoint is declared at 900px');
  assert.match(paintCss, /min-width:\s*0/, 'panels are allowed to shrink rather than force a min width');

  // The two rules whose absence caused the real regression: without a bounded
  // scroller the keybed's intrinsic width propagates up to the document.
  assert.match(narrow[1], /\.keybed-wrap\b[^{]*\{[^}]*overflow-x:\s*auto/, 'the keybed is bounded by a scroller at narrow widths');
  assert.match(narrow[1], /\.keybed\b[^{]*\{[^}]*width:\s*max-content/, 'the bed is content-width so the wrapper is what is bounded');
});

test('the rendered narrow-viewport guarantee is covered by a browser test, not by this one', () => {
  const responsive = readFileSync(new URL('./responsive.test.mjs', import.meta.url), 'utf8');
  assert.match(responsive, /scrollWidth/, 'a rendered test measures scrollWidth rather than grepping the stylesheet');
  assert.match(responsive, /390/, 'and it does so at the narrow width that regressed');
});