/**
 * drums-wiring.test.mjs — the two ways the 808 kit can be completely built and still
 * be unreachable from the delivered page, guarded at the source level.
 *
 * WHY THESE ARE SOURCE-LEVEL ASSERTIONS AND NOT BEHAVIOUR TESTS
 *   Task 9 verified its work by dynamically importing `web/audio/drums.js` from a
 *   browser probe. That bypasses the entry point: `import('/audio/drums.js')` loads
 *   the module whether or not the shipped page ever asks for it, so every measurement
 *   passed while the page itself carried no clock and no kit. The module graph is a
 *   fact about the source, and the only assertion that can catch the kit silently
 *   dropping out of it is one that reads the import list.
 *
 *   The second gap is the same shape: a parameter can be declared, clamped, read at
 *   trigger time and ramped all the way to a `StereoPannerNode` and still have no
 *   painted control, so nothing on the page can reach it. `web/audio/drum-kit.js`
 *   cannot catch that — it never learns whether a control exists. Only the rendered
 *   inventory can, and it has to be generalised over the whole kit so the same gap
 *   cannot reopen for one voice or one parameter.
 *
 * Framework-free, no DOM: `node --test tests/drums-wiring.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KIT_VOICES, SCHEMA } from '../web/ui/params.js';
import { REGIONS, allControls } from '../web/ui/surface.js';

const mainSource = readFileSync(new URL('../web/ui/main.js', import.meta.url), 'utf8');

/**
 * Every static import declaration in a module, in source order, as
 * `{ specifier, bindings, bare, index }` — `bare` being a side-effect import with no
 * bindings, which is the only form that survives being read as "is this module really
 * in the graph".
 *
 * `import(...)` is deliberately NOT matched. A dynamic import loads a module at
 * runtime whether or not the page asked for it, and that is the exact escape hatch
 * these two tests exist to close off.
 */
function staticImports(source) {
  const pattern = /^[ \t]*import[ \t]+(?:([^'";]*?)[ \t]+from[ \t]+)?["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
  return [...source.matchAll(pattern)].map((match) => ({
    specifier: match[2],
    bindings: (match[1] ?? '').trim(),
    bare: match[1] === undefined,
    index: match.index,
  }));
}

const IMPORTS = staticImports(mainSource);
const GRAPH_ROOTS = IMPORTS.filter((entry) => entry.specifier.startsWith('../audio/'));

/* ------------------------------------ gap 1: the clock and the kit are in the graph --- */

test("the entry point statically imports '../audio/drums.js' as a side-effect graph root", () => {
  const drumImport = IMPORTS.find((entry) => entry.specifier === '../audio/drums.js');
  assert.ok(
    drumImport,
    'web/ui/main.js must statically import ../audio/drums.js — without it the transport RUN button and the whole 808 kit are inert in the delivered page, while a probe that dynamically imports the module still passes',
  );

  /* A side-effect import, not a binding import. Nothing in main.js calls into the kit,
     so a binding import would be an unused binding — the one form a bundler or a
     minifier is entitled to drop, which would reintroduce this gap silently. */
  assert.ok(
    drumImport.bare,
    'the drums import must be a plain side-effect import (\'import "../audio/drums.js";\'), not a binding import whose value main.js never reads',
  );

  /* Asserted as a set of graph roots so a later entry-point edit cannot quietly drop
     any of them — engine.js and ramp.js were load-bearing before this one was. */
  const roots = GRAPH_ROOTS.map((entry) => entry.specifier);
  for (const root of ['../audio/ramp.js', '../audio/engine.js', '../audio/drums.js']) {
    assert.ok(roots.includes(root), `main.js must statically import ${root} as a graph root`);
  }
  for (const entry of GRAPH_ROOTS) {
    assert.ok(entry.bare, `${entry.specifier} is a graph root and must be a side-effect import`);
  }

  /* ES module semantics hoist every static import above every statement, so "before
     first use" is structural rather than positional — but a bare import written below
     the statement that depends on it reads as an afterthought, and this file's header
     claims the order is load-bearing. */
  const firstUse = mainSource.search(/\bbuildSurface\s*\(/);
  assert.ok(firstUse !== -1, 'main.js still calls buildSurface()');
  assert.ok(
    drumImport.index < firstUse,
    'the drums import must be written above buildSurface(), beside the other graph roots',
  );
});

/* ------------------------------------------ gap 2: every kit parameter is painted --- */

test('every declared kit.<voice>.<param> — tune, decay, level and pan for all 11 — has a rendered control', () => {
  const rendered = allControls().map((control) => control.key);
  const painted = new Set(rendered);

  /* Derived from the schema rather than a hard-coded list, so a twelfth parameter or a
     twelfth voice is covered the day it is declared instead of the day someone
     remembers to extend this assertion. */
  const kitKeys = Object.keys(SCHEMA).filter((key) => key.startsWith('kit.'));
  assert.equal(
    kitKeys.length,
    KIT_VOICES.length * 4,
    'the kit declares four parameters per voice: tune, decay, level and pan',
  );

  const missing = kitKeys.filter((key) => !painted.has(key));
  assert.deepEqual(
    missing,
    [],
    `declared kit parameters with no control, so unreachable from the page: ${missing.join(', ')}`,
  );
  assert.equal(new Set(rendered).size, rendered.length, 'no key is painted by two controls');

  /* Per voice, so a failure names the voice whose knob is missing. Also pins the
     control order inside each panel, which is the drum-kit layout contract. */
  const region = REGIONS.find((r) => r.id === 'drum-kit');
  assert.ok(region, 'the drum-kit region exists');
  assert.deepEqual(
    region.sections.map((panel) => panel.id),
    KIT_VOICES.map((voice) => `kit-${voice}`),
    'one panel per kit voice, in schema order',
  );

  const ORDER = ['tune', 'decay', 'level', 'pan'];
  for (const panel of region.sections) {
    const voice = panel.id.replace('kit-', '');
    assert.deepEqual(
      panel.controls.map((control) => control.key),
      ORDER.map((param) => `kit.${voice}.${param}`),
      `${panel.id} must render tune, decay, level and pan for ${voice}, in that order`,
    );
    for (const control of panel.controls) {
      assert.ok(control.label?.trim(), `${control.key} needs a label (its accessible name)`);
    }
  }

  /* The surface declares a key, a legend and a hue and nothing else: the range, curve,
     unit and default are the schema's, read by the control factory. A pan control that
     carried its own min/max would be a second source of truth for the parameter. */
  const pan = region.sections.flatMap((panel) => panel.controls).find((c) => c.key.endsWith('.pan'));
  assert.ok(
    pan,
    'a pan control is rendered',
  );
  assert.ok(
    ['rotary', 'vfader', 'hfader'].includes(pan.type),
    `pan is a continuous -1..1 parameter and needs a continuous control, got ${pan.type}`,
  );
  for (const smuggled of ['min', 'max', 'def', 'default', 'unit', 'curve', 'step']) {
    assert.equal(pan[smuggled], undefined, `${pan.key} must not carry ${smuggled}; the schema owns it`);
  }
  assert.deepEqual(
    { min: SCHEMA[pan.key].min, max: SCHEMA[pan.key].max, def: SCHEMA[pan.key].def },
    { min: -1, max: 1, def: 0 },
    'pan keeps the schema range and default: -1..1, centred',
  );
});