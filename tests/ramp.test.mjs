/**
 * The ramp bridge is the single place a store value reaches a live AudioParam.
 * Continuous controls must ramp (no zipper); switch-like controls may assign.
 * Framework-free: `node --test tests/ramp.test.mjs` — fakes stand in for the
 * AudioParam and the AudioContext so the contract is checkable without audio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore, SCHEMA } from '../web/ui/params.js';
import { RAMP_SECONDS, createRampBridge } from '../web/audio/ramp.js';

function fakeContext(now = 1) {
  return { currentTime: now };
}

function fakeParam(context) {
  const calls = [];
  return {
    calls,
    cancelAndHoldAtTime(t) { calls.push(['cancelAndHoldAtTime', t]); },
    cancelScheduledValues(t) { calls.push(['cancelScheduledValues', t]); },
    setValueAtTime(v, t) { calls.push(['setValueAtTime', v, t]); },
    linearRampToValueAtTime(v, t) { calls.push(['linearRampToValueAtTime', v, t]); },
    set value(v) { calls.push(['value', v]); },
    get value() { return 0; },
  };
}

test('a continuous control ramps instead of assigning at gesture time', () => {
  const store = createStore(SCHEMA);
  const context = fakeContext(2);
  const param = fakeParam(context);
  createRampBridge(store).bind('filter1.cutoff', param, { context });

  store.set('filter1.cutoff', 800, { source: 'control', apply: 'ramp' });

  assert.deepEqual(param.calls.map((c) => c[0]), [
    'cancelAndHoldAtTime',
    'linearRampToValueAtTime',
  ]);
  assert.equal(param.calls[1][1], 800);
  assert.equal(param.calls[1][2], 2 + RAMP_SECONDS);
  assert.ok(!param.calls.some((c) => c[0] === 'setValueAtTime'), 'never assigned directly');
});

test('falls back to cancelScheduledValues where cancelAndHoldAtTime is missing', () => {
  const store = createStore(SCHEMA);
  const param = { ...fakeParam(fakeContext(3)), cancelAndHoldAtTime: undefined };
  createRampBridge(store).bind('filter1.cutoff', param, { context: fakeContext(3) });
  store.set('filter1.cutoff', 900, { source: 'control', apply: 'ramp' });
  assert.deepEqual(param.calls.map((c) => c[0]), ['cancelScheduledValues', 'linearRampToValueAtTime']);
});

test('a switch-like control is assigned directly', () => {
  const store = createStore(SCHEMA);
  const context = fakeContext(0);
  const param = fakeParam(context);
  createRampBridge(store).bind('filter1.bypass', param, { context, mode: 'direct' });

  store.set('filter1.bypass', true, { source: 'control', apply: 'direct' });
  assert.deepEqual(param.calls, [['setValueAtTime', 1, 0]]);
});

test('the binding mode decides when the writer does not say', () => {
  const store = createStore(SCHEMA);
  const param = fakeParam(fakeContext(1));
  createRampBridge(store).bind('lfo1.rate', param, { context: fakeContext(1), mode: 'direct' });
  store.set('lfo1.rate', 5); // no meta hint at all
  assert.deepEqual(param.calls.map((c) => c[0]), ['setValueAtTime']);
});

test('writing an unbound key is harmless: nothing to apply yet', () => {
  const store = createStore(SCHEMA);
  const bridge = createRampBridge(store);
  assert.doesNotThrow(() => store.set('envAmp.attack', 0.4));
  assert.equal(bridge.keys().length, 0);
});

test('unbind stops application, and binding a node parameter works', () => {
  const store = createStore(SCHEMA);
  const context = fakeContext(0);
  const param = fakeParam(context);
  const node = { context, gain: param };
  const bridge = createRampBridge(store);

  bridge.bindNodeParam('mixer.level', node, 'gain', { mode: 'ramp' });
  store.set('mixer.level', 0.4, { source: 'control', apply: 'ramp' });
  assert.equal(param.calls.length, 2);

  bridge.unbind('mixer.level');
  store.set('mixer.level', 0.8, { source: 'control', apply: 'ramp' });
  assert.equal(param.calls.length, 2, 'no further calls after unbind');
  assert.equal(bridge.keys().length, 0);
});