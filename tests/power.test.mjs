/**
 * power.test.mjs — the power-on gate.
 *
 * The gate is the whole reason this task exists: a context created before a user
 * gesture stays suspended, and no parameter setting fixes it. So what is under
 * test is not that a resume can be called — it is that there is exactly ONE thing
 * that can call it, that it is called only on the off->on transition, and that the
 * page says which state it is in before anyone has clicked anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POWER_KEY,
  POWER_BUTTON_ID,
  POWER_PROMPT_SELECTOR,
  powerAnnouncement,
  createPowerGate,
} from '../web/ui/power.js';
import { createStore, SCHEMA } from '../web/ui/params.js';

/* --------------------------------------------------------------- a tiny DOM --- */

class Node {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; }, cssText: '' };
    this.listeners = new Map();
    this.dataset = {};
    this._text = '';
    this.id = '';
    this.hidden = false;
    this.classList = {
      set: new Set(),
      add: (...n) => n.forEach((x) => this.classList.set.add(x)),
      remove: (...n) => n.forEach((x) => this.classList.set.delete(x)),
      contains: (n) => this.classList.set.has(n),
      toggle: (n, on) => (on ? this.classList.set.add(n) : this.classList.set.delete(n)),
    };
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text !== '' ? this._text : this.children.map((c) => c.textContent).join(''); }
  setAttribute(n, v) { this.attributes.set(n, String(v)); }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  hasAttribute(n) { return this.attributes.has(n); }
  removeAttribute(n) { this.attributes.delete(n); }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    const out = [];
    for (const fn of [...(this.listeners.get(type) ?? [])]) out.push(fn({ type, preventDefault() {}, ...event }));
    return Promise.all(out);
  }
  matches(selector) {
    if (selector.startsWith('#')) return (this.id || this.getAttribute('id')) === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class Doc extends Node {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.body = new Node('body', this);
    this.append(this.body);
  }
  createElement(tag) { return new Node(tag, this); }
}

/* ------------------------------------------------------------------ fakes --- */

function fakeAudio({ state = 'suspended' } = {}) {
  const calls = [];
  return {
    calls,
    state,
    time: 0,
    sampleRate: 48000,
    contextState() { return this.state; },
    contextTime() { return this.time; },
    async resumeInstrument() {
      calls.push('resume');
      this.state = 'running';
      return true;
    },
    async suspendInstrument() {
      calls.push('suspend');
      this.state = 'suspended';
      return true;
    },
    allNotesOff() { calls.push('allNotesOff'); },
  };
}

function page({ powerId = POWER_BUTTON_ID } = {}) {
  const doc = new Doc();
  const surface = doc.createElement('main');
  surface.setAttribute('data-surface', '');
  const masthead = doc.createElement('header');
  const power = doc.createElement('button');
  power.setAttribute('id', powerId);
  power.setAttribute('type', 'button');
  power.setAttribute('aria-pressed', 'false');
  const volume = doc.createElement('input');
  volume.setAttribute('id', 'ctl-global-volume');
  volume.setAttribute('type', 'range');
  const latch = doc.createElement('button');
  latch.setAttribute('id', 'ctl-global-latch');
  latch.setAttribute('type', 'button');
  latch.setAttribute('aria-pressed', 'false');
  surface.append(masthead, power, volume, latch);
  doc.body.append(surface);
  return { doc, surface, power, volume, latch };
}

/* ---------------------------------------------------------------- the text --- */

test('the powered-off state says what to do, not just that it is off', () => {
  const off = powerAnnouncement({ powered: false, contextState: 'suspended' });
  assert.match(off, /off/i);
  assert.match(off, /power/i);
  const on = powerAnnouncement({ powered: true, contextState: 'running', sampleRate: 48000 });
  assert.match(on, /on/i);
  assert.match(on, /48\.0 kHz/);
});

test('a suspended context is never described as running, whatever power says', () => {
  assert.match(powerAnnouncement({ powered: true, contextState: 'suspended' }), /suspended/i);
});

/* ------------------------------------------------------------ the gate --- */

test('the page presents a visible powered-off prompt before any gesture', async () => {
  const { doc, surface } = page();
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  const gate = createPowerGate({ doc, store, audio });
  await gate.refresh();
  const prompt = surface.querySelector(POWER_PROMPT_SELECTOR);
  assert.ok(prompt, 'no powered-off prompt on the page');
  assert.equal(prompt.hidden, false);
  assert.match(prompt.textContent, /power/i);
  assert.equal(gate.powered(), false);
  assert.equal(audio.calls.length, 0, 'constructing the gate resumed the context');
  assert.equal(surface.getAttribute('data-power'), 'off');
});

test('the gate binds to the power button and to nothing else', async () => {
  const { doc, power, volume, latch } = page();
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  const gate = createPowerGate({ doc, store, audio });
  assert.equal(gate.button, power);

  // A gesture on any other control must not start audio. This is the behaviour the
  // task forbids being "helped up", so it is asserted rather than trusted.
  for (const other of [volume, latch]) {
    store.set(POWER_KEY, false, { source: 'control' });
    await other.dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(audio.calls.length, 0, `${other.getAttribute('id')} resumed the context`);
    assert.equal(gate.powered(), false);
  }
  assert.equal(power.getAttribute('aria-pressed'), 'false');
});

test('one click on the power control resumes the context exactly once', async () => {
  const { doc, power, surface } = page();
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  const gate = createPowerGate({ doc, store, audio });
  // The painted control flips the store key on its own click. It is registered AFTER
  // the gate's here, deliberately: the gate must not depend on listener order to
  // know which way the button was pressed.
  power.addEventListener('click', () => {
    store.set(POWER_KEY, !store.get(POWER_KEY), { source: 'control', apply: 'direct' });
    power.setAttribute('aria-pressed', String(store.get(POWER_KEY)));
  });

  await power.dispatch('click', {});
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(audio.calls, ['resume']);
  assert.equal(gate.powered(), true);
  assert.equal(surface.getAttribute('data-power'), 'on');
  const prompt = surface.querySelector(POWER_PROMPT_SELECTOR);
  assert.match(prompt.textContent, /on/i);
});

test('a bare power button — nothing to flip the key — still powers on', async () => {
  const { doc, power } = page();
  const audio = fakeAudio();
  createPowerGate({ doc, store: createStore(SCHEMA), audio });
  await power.dispatch('click', {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(audio.calls, ['resume']);
});

test('a second click powers the instrument back down and silences it', async () => {
  const { doc, power } = page();
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  createPowerGate({ doc, store, audio });
  power.addEventListener('click', () => {
    store.set(POWER_KEY, !store.get(POWER_KEY), { source: 'control', apply: 'direct' });
  });
  await power.dispatch('click', {});
  await power.dispatch('click', {});
  assert.deepEqual(audio.calls, ['resume', 'allNotesOff', 'suspend']);
  assert.equal(audio.state, 'suspended');
});

test('engaging an already-running context does not resume it again', async () => {
  const { doc } = page();
  const audio = fakeAudio({ state: 'running' });
  const gate = createPowerGate({ doc, store: createStore(SCHEMA), audio });
  await gate.refresh();
  await gate.engage();
  assert.deepEqual(audio.calls, ['resume'], 'resumeInstrument was called twice for one gesture');
  assert.equal(gate.powered(), true);
});

test('the power state is announced politely, once per change', async () => {
  const { doc, power } = page();
  const announced = [];
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  createPowerGate({ doc, store, audio, announce: (text) => announced.push(text) });
  power.addEventListener('click', () => store.set(POWER_KEY, !store.get(POWER_KEY), { source: 'control' }));
  await power.dispatch('click', {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(announced.length, 1, `announced ${announced.length} times`);
  assert.match(announced[0], /on/i);
});

test('a page with no power control degrades instead of throwing', async () => {
  const { doc } = page({ powerId: 'something-else' });
  const audio = fakeAudio();
  const gate = createPowerGate({ doc, store: createStore(SCHEMA), audio });
  await gate.refresh();
  assert.equal(gate.button, null);
  assert.equal(gate.powered(), false);
  assert.equal(audio.calls.length, 0);
  assert.equal(await gate.engage(), false, 'a gate with nothing to click must not resume');
  assert.deepEqual(audio.calls, []);
});

test('the store key is the single authority for the power state', async () => {
  const { doc } = page();
  const audio = fakeAudio();
  const store = createStore(SCHEMA);
  const gate = createPowerGate({ doc, store, audio });
  assert.equal(gate.powered(), store.get(POWER_KEY));
  store.set(POWER_KEY, false, { source: 'test' });
  assert.equal(gate.powered(), false);
});