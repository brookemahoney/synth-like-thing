/**
 * Structural checks for the page shell and its control inventory: the eight
 * regions exist, in the agreed vertical order, with the agreed sub-sections;
 * every control binds a key the parameter schema declares; no parameter is
 * bound to two controls; and the inventory exercises every control type the
 * parameters in each region can express. Framework-free:
 * `node --test tests/surface.test.mjs`.
 *
 * Later tasks (002-014) fill the regions. These are the assertions that stop
 * two of them re-deriving a different page structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONTROL_TYPES } from '../web/ui/controls.js';
import { SCHEMA } from '../web/ui/params.js';
import { REGION_ORDER, REGIONS, allControls } from '../web/ui/surface.js';

const CONTINUOUS = ['rotary', 'vfader', 'hfader'];
const SWITCH = ['toggle', 'step'];
const HUES = ['sage', 'sky', 'rose', 'ochre', 'lavender'];

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles/base.css', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('../web/styles/controls.css', import.meta.url), 'utf8');

const regionIdsInHtml = [...html.matchAll(/data-region="([^"]+)"/g)].map((m) => m[1]);

test('the page shell declares the eight regions in the agreed vertical order', () => {
  assert.deepEqual(
    REGION_ORDER,
    [
      'global-strip',
      'voice-row',
      'tone-row',
      'modulation-row',
      'effects-row',
      'drum-kit',
      'sequencer',
      'keyboard',
    ],
    'the manifest fixes the vertical order every later task builds into',
  );
  assert.deepEqual(REGIONS.map((r) => r.id), REGION_ORDER, 'manifest order matches REGION_ORDER');
  assert.deepEqual(regionIdsInHtml, REGION_ORDER, 'index.html declares the same regions, same order');
  assert.equal([...html.matchAll(/data-panels/g)].length, REGION_ORDER.length, 'every region has one mount point');
  for (const region of REGIONS) {
    assert.ok(region.title, `${region.id} needs a visible title`);
    assert.ok(region.sections.length > 0, `${region.id} needs at least one panel`);
    /* The shell's visible heading and the manifest's title are the same string,
       so index.html is a faithful outline of the page even with JS off. */
    const shell = html.slice(html.indexOf(`data-region="${region.id}"`));
    const heading = shell.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)[1].replace('&amp;', '&').trim();
    assert.equal(heading, region.title, `${region.id} heading disagrees with the manifest`);
  }
});

test('the sub-sections of each row are the ones the plan names', () => {
  const ids = (regionId) => REGIONS.find((r) => r.id === regionId).sections.map((s) => s.id);
  assert.deepEqual(ids('voice-row'), ['osc1', 'osc2', 'osc3', 'wave']);
  assert.deepEqual(ids('tone-row'), ['mixer', 'filter1', 'filter2', 'env-amp', 'env-filter']);
  assert.deepEqual(ids('modulation-row'), ['lfo1', 'lfo2', 'lfo3', 'matrix']);
  assert.deepEqual(ids('effects-row'), ['eq', 'delay', 'reverb']);
  assert.deepEqual(ids('sequencer'), ['sequencer', 'arp']);
});

test('every control binds a declared key, and no key is bound to two controls', () => {
  const seen = new Map();
  for (const control of allControls()) {
    assert.ok(CONTROL_TYPES.includes(control.type), `${control.key}: unknown type ${control.type}`);
    assert.ok(SCHEMA[control.key], `${control.key} is not in the parameter schema`);
    assert.ok(control.label && control.label.trim(), `${control.key} needs a label (its accessible name)`);
    assert.ok(HUES.includes(control.hue), `${control.key}: unknown hue ${control.hue}`);
    assert.equal(seen.get(control.key), undefined, `${control.key} is bound by two controls`);
    seen.set(control.key, control);
  }
  assert.ok(seen.size > 40, 'the shell is meant to be representative, not two controls');
});

test('the control inventory exercises every type each region can express', () => {
  const used = new Set();
  for (const region of REGIONS) {
    const controls = allControls(region);
    assert.ok(controls.length > 0, `${region.id} has no controls at all`);
    const kinds = new Set(controls.map((c) => SCHEMA[c.key].kind));
    const types = new Set(controls.map((c) => c.type));
    for (const type of types) used.add(type);

    if ([...kinds].some((k) => k === 'number' || k === 'int')) {
      assert.ok(
        [...types].some((t) => CONTINUOUS.includes(t)),
        `${region.id} has numeric parameters but no continuous control`,
      );
    }
    if (kinds.has('bool')) {
      assert.ok(
        [...types].some((t) => SWITCH.includes(t)),
        `${region.id} has boolean parameters but no toggle/step control`,
      );
    }
    if (kinds.has('enum')) {
      assert.ok(types.has('choice'), `${region.id} has an enum parameter but no choice control`);
    }
  }
  assert.deepEqual([...used].sort(), [...CONTROL_TYPES].sort(), 'the page must use all six control types');
});

test('the global strip alone covers all six control types', () => {
  const types = new Set(allControls(REGIONS[0]).map((c) => c.type));
  assert.deepEqual([...types].sort(), [...CONTROL_TYPES].sort());
});

test('the page makes no third-party request and ships no webfont', () => {
  for (const file of [html, css, controlCss]) {
    assert.ok(!/["'(]\s*(https?:)?\/\//.test(file.replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '')), `external URL in ${file.slice(0, 40)}`);
    assert.ok(!/@import/.test(file), 'no CSS @import');
    assert.ok(!/@font-face/.test(file), 'no webfont: system font stacks only');
  }
  /* Module scripts, all of them local, all of them real files: main.js builds the
     surface, paint.js self-initialises the ground and the reactive dab layer, and
     task 011 added power.js (the power-on gate) and keyboard.js (the input). None is
     inline and none is third-party — which is the invariant this test is for. The
     COUNT is deliberately not asserted: every task that owns a module adds one, so
     pinning a number only ever breaks on legitimate work. What must hold is that
     every script tag names a first-party module file. */
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, 'the page needs its module entry points');
  for (const attributes of scripts) {
    assert.match(attributes, /type="module"/, 'native ES modules only');
    assert.match(attributes, /src="\.\/ui\/[a-z-]+\.js"/, 'a first-party module file, not inline code');
    assert.doesNotMatch(attributes, /https?:|cdn|unpkg|jsdelivr/i, 'no third-party origin');
    assert.doesNotMatch(attributes, />\s*\S/, 'no inline script body');
  }
  assert.match(html, /<script type="module" src="\.\/ui\/main\.js">/, 'native ES module entry point');
  assert.match(html, /<script type="module" src="\.\/ui\/paint\.js">/, 'the painted layer initialises itself');
  assert.match(html, /<script type="module" src="\.\/ui\/power\.js">/, 'the power-on gate initialises itself');
  assert.match(html, /<script type="module" src="\.\/ui\/keyboard\.js">/, 'the input initialises itself');
  assert.equal([...html.matchAll(/rel="stylesheet"/g)].length, 3, 'base, controls and paint');
  for (const href of [...html.matchAll(/rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1])) {
    assert.match(href, /^\.\/styles\/[a-z-]+\.css$/, `${href} must be a first-party stylesheet`);
  }
});

test('the palette is defined once on :root and every hue is used by the inventory', () => {
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  for (const token of ['--ground', '--ink', '--sage', '--sky', '--rose', '--ochre', '--lavender']) {
    assert.match(rootBlock, new RegExp(`${token}:`), `${token} must be defined on :root`);
  }
  const usedHues = new Set(allControls().map((c) => c.hue));
  for (const hue of HUES) assert.ok(usedHues.has(hue), `hue ${hue} is defined but unused`);
  assert.ok(controlCss.includes('var(--'), 'the control skin must read the palette from custom properties');
});
