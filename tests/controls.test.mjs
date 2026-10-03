/**
 * Integration checks for the painted-control primitive's *value* logic: the
 * position<->value mapping, drag sensitivity, keyboard stepping and readout
 * formatting. Framework-free: `node --test tests/controls.test.mjs`.
 *
 * The DOM half of the primitive (pointer capture, focus, ARIA attributes) is
 * verified in the browser against the running site, not here — there is no DOM
 * in node and no DOM shim is being added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA } from '../web/ui/params.js';
import {
  CONTROL_TYPES,
  DRAG_RANGE_PX,
  dragBy,
  formatValue,
  positionToValue,
  stepValue,
  valueToPosition,
} from '../web/ui/controls.js';

const entry = (key) => SCHEMA[key];

test('the factory covers every control type exactly once', () => {
  assert.deepEqual(
    [...CONTROL_TYPES].sort(),
    ['choice', 'hfader', 'rotary', 'step', 'toggle', 'vfader'],
  );
});

test('a linear range maps position to value and back', () => {
  const e = entry('global.swing'); // 50..75, linear
  assert.equal(positionToValue(e, 0), 50);
  assert.equal(positionToValue(e, 1), 75);
  assert.equal(positionToValue(e, 0.5), 62.5);
  assert.equal(valueToPosition(e, 62.5), 0.5);
});

test('a log range maps geometrically and round-trips', () => {
  const e = entry('filter1.cutoff'); // 20..20000, log
  assert.equal(positionToValue(e, 0), 20);
  assert.equal(positionToValue(e, 1), 20000);
  assert.ok(Math.abs(positionToValue(e, 0.5) - 632.455) < 0.001, 'geometric midpoint');
  for (const v of [20, 137, 1200, 8000, 20000]) {
    const back = positionToValue(e, valueToPosition(e, v));
    assert.ok(Math.abs(back - v) < 1e-9, `round-trip ${v}`);
  }
});

test('rotary/vertical drag moves by pixels, upward increases, and clamps', () => {
  const e = entry('filter1.resonance'); // 0.5..30, linear, def 1.2
  assert.equal(dragBy(e, 15, { dy: -DRAG_RANGE_PX, axis: 'y' }), 30, 'full sweep up clamps at max');
  assert.equal(dragBy(e, 15, { dy: DRAG_RANGE_PX * 2, axis: 'y' }), 0.5, 'full sweep down clamps at min');
  assert.equal(dragBy(e, 15, { dy: -DRAG_RANGE_PX / 4, axis: 'y' }), 22.375);
});

test('shift halves... no: shift makes drag five times finer', () => {
  const e = entry('global.swing');
  const coarse = dragBy(e, 50, { dy: -DRAG_RANGE_PX / 4, axis: 'y' });
  const fine = dragBy(e, 50, { dy: -DRAG_RANGE_PX / 4, axis: 'y', fine: true });
  assert.equal(coarse, 56.25);
  assert.equal(fine, 51.25);
});

test('horizontal faders read horizontal movement', () => {
  const e = entry('global.swing');
  // `axis` names the axis the CONTROL reads, so a horizontal fader passes 'x'
  // and a vertical-only move cannot move it.
  assert.equal(dragBy(e, 50, { dx: DRAG_RANGE_PX / 2, axis: 'x' }), 62.5);
  assert.equal(dragBy(e, 50, { dy: -DRAG_RANGE_PX / 2, axis: 'x' }), 50, 'vertical does nothing');
  assert.equal(
    dragBy(e, 50, { dx: DRAG_RANGE_PX / 2, dy: -DRAG_RANGE_PX / 2, axis: 'x' }),
    62.5,
    'with both components present only the control axis counts',
  );
  assert.equal(dragBy(e, 50, { dx: DRAG_RANGE_PX / 2, axis: 'y' }), 50, 'a vertical control ignores dx');
});

test('drag on a log range moves geometrically', () => {
  const e = entry('filter1.cutoff'); // 20..20000, def 1200
  const quarter = dragBy(e, 1200, { dy: -DRAG_RANGE_PX / 4, axis: 'y' });
  assert.ok(quarter > 1200 && quarter < 40000);
  const again = dragBy(e, quarter, { dy: -DRAG_RANGE_PX / 4, axis: 'y' });
  assert.ok(again > quarter, 'still climbing');
});

test('arrow stepping: one step up/down, shift for fine, page for coarse', () => {
  const e = entry('global.volume'); // 0..1 linear
  assert.equal(stepValue(e, 0.5, 1), 0.51);
  assert.equal(stepValue(e, 0.5, -1), 0.49);
  assert.equal(stepValue(e, 0.5, 1, { fine: true }), 0.502);
  assert.equal(stepValue(e, 0.5, 1, { coarse: true }), 0.6);

  const t = entry('global.tempo'); // int 40..220
  assert.equal(stepValue(t, 120, 1), 121);
  assert.equal(stepValue(t, 120, -1), 119);
  assert.equal(stepValue(t, 220, 1), 220, 'clamps at the schema max');
  assert.equal(stepValue(t, 40, -1), 40, 'clamps at the schema min');

  const g = entry('filter1.cutoff'); // log 20..20000
  const up = stepValue(g, 1000, 1);
  assert.ok(up > 1000);
  const down = stepValue(g, 1000, -1);
  assert.ok(down < 1000);
  assert.ok(Math.abs(up / 1000 - 1000 / down) < 1e-9, 'symmetric in log space');
});

test('readouts are readable: hertz above 1 kHz, milliseconds below 1 s', () => {
  assert.equal(formatValue(entry('filter1.cutoff'), 1200), '1.20 kHz');
  assert.equal(formatValue(entry('filter1.cutoff'), 240), '240 Hz');
  assert.equal(formatValue(entry('filter1.cutoff'), 20000), '20.0 kHz');
  assert.equal(formatValue(entry('envAmp.attack'), 0.01), '10 ms');
  assert.equal(formatValue(entry('envAmp.attack'), 0.001), '1.0 ms');
  assert.equal(formatValue(entry('envAmp.release'), 0.8), '800 ms');
  assert.equal(formatValue(entry('reverb.decay'), 12), '12.0 s');
  assert.equal(formatValue(entry('global.tempo'), 120), '120 BPM');
  assert.equal(formatValue(entry('filter1.resonance'), 1.25), '1.25');
  assert.equal(formatValue(entry('global.swing'), 54), '54%');
  assert.equal(formatValue(entry('kit.bd.pan'), -0.5), '-50%');
  assert.equal(formatValue(entry('global.volume'), 0.7), '70', 'unitless 0..1 reads as a percentage');
});