/**
 * waveload.test.mjs — the file-load control's wiring, against a minimal fake DOM.
 *
 * No jsdom, no framework, no dependency: the loader touches eight DOM properties and
 * three of them are the behaviour under test — it must mount into the panel that
 * surface.js already built, it must accept only wav files, and a failed load must say
 * why without disturbing what is selected. Those are exactly the things that would
 * otherwise only be findable by clicking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWaveLoad, mountWaveLoad, describeTable, PANEL_SELECTOR, INPUT_ACCEPT } from '../web/ui/waveload.js';

/* --------------------------------------------------------------- a tiny DOM --- */

function makeElement(tag, doc) {
  const listeners = new Map();
  const element = {
    tagName: tag,
    className: '',
    id: '',
    type: '',
    textContent: '',
    value: '',
    disabled: false,
    files: [],
    attributes: {},
    children: [],
    listeners,
    style: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === 'style') this.style.cssText = value;
    },
    getAttribute: (name) => element.attributes[name] ?? null,
    append(...kids) {
      for (const kid of kids) {
        kid.parent = this;
        this.children.push(kid);
      }
    },
    after(node) {
      this.placedAfter = node;
      const siblings = this.parent?.children;
      if (siblings) {
        node.parent = this.parent;
        siblings.splice(siblings.indexOf(this) + 1, 0, node);
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) ?? []).map((fn) => fn(event)));
    },
    querySelector(selector) {
      return query(this, selector);
    },
  };
  return element;
}

function query(root, selector) {
  const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  const match = (node) => {
    if (attribute) {
      if (!Object.hasOwn(node.attributes, attribute[1])) return false;
      return attribute[2] === undefined || node.attributes[attribute[1]] === attribute[2];
    }
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    return node.tagName === selector;
  };
  for (const child of root.children ?? []) {
    if (match(child)) return child;
    const deeper = query(child, selector);
    if (deeper) return deeper;
  }
  return null;
}

function makeDoc() {
  const doc = {
    createElement: (tag) => makeElement(tag, doc),
    querySelector: (selector) => query(doc.body, selector),
  };
  const panel = makeElement('section', doc);
  panel.setAttribute('data-panel', 'wave');
  const grid = makeElement('div', doc);
  grid.className = 'panel__grid';
  panel.append(grid);
  doc.body = { children: [panel] };
  return { doc, panel, grid };
}

/** A stand-in for the audio module's facade: same shape, no audio. */
function fakeSampler(overrides = {}) {
  const state = {
    slot: 'warmSaw',
    tables: [
      { slot: 'warmSaw', name: 'warmSaw', label: 'Warm Saw', kind: 'factory', length: 2048, sourceName: null },
      { slot: 'softSquare', name: 'softSquare', label: 'Soft Square', kind: 'factory', length: 2048, sourceName: null },
      { slot: 'reed', name: 'reed', label: 'Reed', kind: 'factory', length: 2048, sourceName: null },
      { slot: 'glass', name: 'glass', label: 'Glass', kind: 'factory', length: 2048, sourceName: null },
    ],
    loaded: [],
    restored: [],
    ...overrides,
  };
  return {
    state,
    slot: () => state.slot,
    tables: () => state.tables,
    async load(file) {
      state.loaded.push(file);
      if (state.fail) {
        const error = new Error(state.fail);
        throw error;
      }
      state.slot = state.slot;
      return { name: `user:${file.name}`, label: file.name, kind: 'user', length: 2048, sourceName: file.name };
    },
    restoreFactory(slot) {
      state.restored.push(slot ?? state.slot);
      return {};
    },
  };
}

/* ------------------------------------------------------------------ the tests --- */

test('the loader mounts into the wavesampler panel, after the controls', () => {
  const { doc, grid } = makeDoc();
  const element = mountWaveLoad(doc);
  assert.ok(element, 'it mounted');
  assert.equal(mountWaveLoad(doc), element, 'mounting twice is the same element, not a second control');
  assert.equal(grid.placedAfter, element, 'it goes after the painted controls, inside the panel');
});

test('the file input only accepts wav files, and it is a real labelled control', () => {
  const { doc } = makeDoc();
  const element = mountWaveLoad(doc);
  const input = element.querySelector('[data-waveload-input]');
  assert.equal(input.type, 'file');
  assert.equal(input.getAttribute('accept'), INPUT_ACCEPT);
  assert.match(INPUT_ACCEPT, /^\.wav,/, 'the extension comes first so a file picker filters on it');
  const label = element.children[0].children[0];
  assert.equal(label.getAttribute('for'), input.id, 'the label names the input');
  assert.ok(label.textContent.length > 0);
});

test('with no file loaded the status says what is playing and where it came from', () => {
  const { doc } = makeDoc();
  const sampler = fakeSampler();
  const element = buildWaveLoad(doc, { sampler, getContext: async () => ({}) });
  const status = element.querySelector('[data-waveload-status]');
  assert.match(status.textContent, /Warm Saw/);
  assert.match(status.textContent, /slot warmSaw/);
  assert.match(status.textContent, /generated in the browser/);
  assert.equal(status.getAttribute('aria-live'), 'polite', 'the failure reason has to be announced');
  assert.equal(status.getAttribute('role'), 'status');
});

test('a loaded file is reported with its name and its table length', async () => {
  const { doc } = makeDoc();
  const sampler = fakeSampler();
  const element = buildWaveLoad(doc, { sampler, getContext: async () => ({ kind: 'context' }) });
  const input = element.querySelector('[data-waveload-input]');
  const file = { name: 'bell.wav', arrayBuffer: async () => new ArrayBuffer(8) };
  input.files = [file];

  await input.dispatch('change');
  assert.deepEqual(sampler.state.loaded, [file], 'the file went to the audio module');
  assert.match(element.querySelector('[data-waveload-status]').textContent, /bell\.wav/);
  assert.match(element.querySelector('[data-waveload-status]').textContent, /2048 points/);
  assert.equal(input.disabled, false, 'the input is usable again afterwards');
});

test('a failed load says why, and leaves the input ready for another try', async () => {
  const { doc } = makeDoc();
  const sampler = fakeSampler({ fail: 'could not decode "notes.txt" as audio: Unable to decode audio data' });
  const element = buildWaveLoad(doc, { sampler, getContext: async () => ({}) });
  const input = element.querySelector('[data-waveload-input]');
  input.files = [{ name: 'notes.txt', arrayBuffer: async () => new ArrayBuffer(8) }];

  await input.dispatch('change');
  const status = element.querySelector('[data-waveload-status]');
  assert.match(status.textContent, /Not loaded/);
  assert.match(status.textContent, /Unable to decode audio data/, 'the reason is the browser\'s own');
  assert.equal(input.value, '', 'the same file can be picked again');
  assert.equal(input.disabled, false);
  assert.equal(sampler.state.slot, 'warmSaw', 'the slot was never touched');
});

test('a file picker cancelled fires change with nothing in it, and does nothing', async () => {
  const { doc } = makeDoc();
  const sampler = fakeSampler();
  const element = buildWaveLoad(doc, { sampler, getContext: async () => ({}) });
  const input = element.querySelector('[data-waveload-input]');
  input.files = [];
  await input.dispatch('change');
  assert.deepEqual(sampler.state.loaded, [], 'nothing was loaded');
  assert.match(element.querySelector('[data-waveload-status]').textContent, /Warm Saw/);
});

test('the factory button puts the built-in wave back', () => {
  const { doc } = makeDoc();
  const sampler = fakeSampler();
  const element = buildWaveLoad(doc, { sampler, getContext: async () => ({}) });
  const reset = element.querySelector('[data-waveload-reset]');
  assert.equal(reset.type, 'button', 'never a submit: a form control that submits reloads the page');
  reset.dispatch('click');
  assert.deepEqual(sampler.state.restored, ['warmSaw']);
  assert.match(element.querySelector('[data-waveload-status]').textContent, /generated in the browser/);
});

test('mounting without a panel is null rather than an exception', () => {
  const doc = { createElement: (tag) => makeElement(tag, doc), querySelector: () => null };
  assert.equal(mountWaveLoad(doc), null);
  assert.equal(PANEL_SELECTOR, '[data-panel="wave"]');
});

test('the status line describes a loaded table differently from a generated one', () => {
  assert.match(describeTable({ label: 'Warm Saw', kind: 'factory' }, 'warmSaw'), /generated in the browser/);
  assert.match(describeTable({ label: 'My Tone', kind: 'user', sourceName: 'my-tone.wav' }, 'reed'), /from my-tone\.wav/);
  assert.equal(describeTable(null, 'warmSaw'), '—');
});