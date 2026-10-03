/**
 * Task 7's fake Web Audio: the voice harness plus the two pieces an LFO and a
 * modulation block need and a voice never had — `createAnalyser` and
 * `setValueCurveAtTime` — and a fake DOM just large enough to mount the matrix
 * panel into.
 *
 * It EXTENDS tests/voice-fake-audio.mjs rather than repeating it, for the same
 * reason the instrument has one fake: a second fake is a second description of
 * Web Audio, and the two drift.
 *
 * The one simplification the analyser introduces, stated plainly: a fake
 * context renders nothing, so this analyser's time-domain data is whatever the
 * test feeds it. That is exactly the seam the matrix reads, so it is enough to
 * prove the matrix USES a tap correctly. It is NOT enough to prove what a
 * sample-and-hold buffer sounds like — that is proven two ways that do not need
 * a fake: `sampleHoldTable()` is asserted sample by sample, and the live value
 * is read from a real AnalyserNode in the browser.
 */

import { createFakeAudioContext, createFakeRead } from './voice-fake-audio.mjs';

/** Every AudioParam-shaped property the node factories here produce. */
const PARAM_PROPERTIES = ['gain', 'offset', 'frequency', 'detune', 'playbackRate', 'Q', 'constant'];

/** Add the two automation calls task 7 uses to a node's parameters. */
function withValueCurves(node) {
  for (const property of PARAM_PROPERTIES) {
    const param = node[property];
    if (!param || typeof param.setValueAtTime !== 'function' || param.setValueCurveAtTime) continue;
    param.curves = [];
    param.setValueCurveAtTime = function setValueCurve(curve, time, duration) {
      const values = Float32Array.from(curve);
      // A real param interpolates over the curve's duration; a fake lands on the
      // end, which is the value the fade-in is asking for.
      this.value = values.length ? values[values.length - 1] : this.value;
      this.curves.push({ curve: values, time, duration });
      this.events.push({ type: 'setValueCurveAtTime', time, duration });
      return this;
    };
    param.cancelAndHoldAtTime = function cancelAndHold(time) {
      this.events.push({ type: 'cancelAndHoldAtTime', time });
      return this;
    };
  }
  return node;
}

/**
 * A fake AudioContext with analyser taps.
 *
 * `feed(analyser, value)` is how a test says "the LFO is reading this right
 * now"; `taps()` is every analyser made, in creation order.
 */
export function createModFakeContext({ sampleRate = 48000, now = 0 } = {}) {
  const context = createFakeAudioContext({ sampleRate, now });

  for (const factory of ['createGain', 'createConstantSource', 'createOscillator', 'createBufferSource', 'createBiquadFilter']) {
    const original = context[factory];
    context[factory] = (...args) => withValueCurves(original(...args));
  }

  const taps = [];
  context.createAnalyser = () => {
    const node = {
      kind: 'analyser',
      connections: [],
      disconnects: 0,
      disconnectAll: 0,
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      minDecibels: -100,
      maxDecibels: -30,
      /** What `getFloatTimeDomainData` will report. 0 dB = a silent tap. */
      fed: 0,
      reads: 0,
      connect(destination) {
        this.connections.push(destination);
        return destination;
      },
      disconnect(destination) {
        this.disconnects += 1;
        if (destination === undefined) {
          this.disconnectAll += 1;
          this.connections.length = 0;
          return;
        }
        const at = this.connections.indexOf(destination);
        if (at >= 0) this.connections.splice(at, 1);
      },
      getFloatTimeDomainData(array) {
        this.reads += 1;
        for (let i = 0; i < array.length; i += 1) array[i] = this.fed;
        return array;
      },
      getByteTimeDomainData(array) {
        this.reads += 1;
        const scaled = Math.max(0, Math.min(255, Math.round((this.fed + 1) * 127.5)));
        for (let i = 0; i < array.length; i += 1) array[i] = scaled;
        return array;
      },
    };
    taps.push(node);
    context.created.push(node);
    return node;
  };

  /** Every analyser, in creation order. */
  context.taps = () => taps.slice();
  /** Say what a tap is reading now. */
  context.feed = (index, value) => {
    taps[index].fed = value;
    return taps[index];
  };

  return context;
}

export { createFakeRead };

/* ------------------------------------------------------------------ the DOM --- */

/**
 * The smallest DOM that can mount the matrix panel: elements, class lists,
 * datasets, attributes, one inline style object and listeners. No layout, no
 * events — the panel's arithmetic is tested through the store, and the real
 * browser answers what this cannot.
 */
export function createFakeDocument({ html = '' } = {}) {
  const byId = new Map();
  const doc = {
    readyState: 'complete',
    listeners: new Map(),
    createElement(tag) {
      return createFakeElement(tag, doc);
    },
    querySelector(selector) {
      /* The by-id shortcut is a lookup, not an answer: a selector it does not know
         must still fall through to the tree, or a query that works in a browser
         returns null here and the two descriptions of the DOM diverge. */
      const match = /^\[([\w-]+)="([\w-]+)"\]$/.exec(selector);
      if (match) return byId.get(`${match[1]}=${match[2]}`) ?? doc.root.querySelector(selector);
      return doc.root.querySelector(selector);
    },
    addEventListener(type, fn, options = {}) {
      const set = doc.listeners.get(type) ?? new Set();
      set.add({ fn, once: Boolean(options.once) });
      doc.listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      const set = doc.listeners.get(type);
      if (!set) return;
      for (const entry of set) if (entry.fn === fn) set.delete(entry);
    },
    dispatch(type, event = {}) {
      const set = doc.listeners.get(type);
      if (!set) return 0;
      let called = 0;
      /* `once` is honoured, because a fake that ignores it hides a listener that
         mounts the panel twice. */
      for (const entry of [...set]) {
        entry.fn(event);
        called += 1;
        if (entry.once) set.delete(entry);
      }
      return called;
    },
    byId,
  };
  doc.root = createFakeElement('body', doc);
  if (html) doc.root.append(parseHeadGrid(html, doc));
  return doc;
}

/** Build the eight-headed, sixty-four-cell grid surface.js renders. */
export function parseHeadGrid({ rows, columns }, doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'headgrid';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.append(doc.createElement('span'));
  for (const column of columns) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--column';
    head.textContent = column;
    wrap.append(head);
  }
  for (const row of rows) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--row';
    head.textContent = row;
    wrap.append(head);
    for (let column = 0; column < columns.length; column += 1) {
      const cell = doc.createElement('span');
      cell.className = 'headgrid__cell';
      wrap.append(cell);
    }
  }
  return wrap;
}

function createFakeElement(tag, doc) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    classes: new Set(),
    dataset: {},
    attributes: new Map(),
    listeners: new Map(),
    value: '',
    /* Real textContent aggregates descendants once there are any, which is what a
       cell's signed number has to do when it lives in a child span. */
    get textContent() {
      if (element.children.length === 0) return element.ownText;
      return element.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      element.ownText = String(value);
    },
    ownText: '',
    style: {
      properties: {},
      setProperty(name, value) {
        element.style.properties[name] = value;
      },
      removeProperty(name) {
        delete element.style.properties[name];
      },
    },
    get className() {
      return [...element.classes].join(' ');
    },
    set className(value) {
      element.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    },
    classList: {
      add(...names) {
        names.forEach((name) => element.classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => element.classes.delete(name));
      },
      contains(name) {
        return element.classes.has(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !element.classes.has(name) : Boolean(force);
        if (on) element.classes.add(name);
        else element.classes.delete(name);
        return on;
      },
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parent = element;
        element.children.push(node);
      }
      return element;
    },
    replaceChild(next, previous) {
      const at = element.children.indexOf(previous);
      if (at < 0) return null;
      next.parent = element;
      element.children[at] = next;
      previous.parent = null;
      return previous;
    },
    replaceWith(...nodes) {
      const parent = element.parent;
      if (!parent) return element;
      const at = parent.children.indexOf(element);
      nodes.forEach((node, offset) => {
        node.parent = parent;
        parent.children[at + offset] = node;
      });
      parent.children.length = at + nodes.length + parent.children.slice(at + nodes.length).length;
      element.parent = null;
      return element;
    },
    remove() {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
      element.parent = null;
    },
    /** The standard spelling, which is the one production code may use. */
    get parentNode() {
      return element.parent;
    },
    get parentElement() {
      return element.parent;
    },
    setAttribute(name, value) {
      element.attributes.set(name, String(value));
      if (name === 'id') doc?.byId?.set(`id=${value}`, element);
    },
    getAttribute(name) {
      return element.attributes.has(name) ? element.attributes.get(name) : null;
    },
    removeAttribute(name) {
      element.attributes.delete(name);
    },
    hasAttribute(name) {
      return element.attributes.has(name);
    },
    addEventListener(type, fn, options = {}) {
      const set = element.listeners.get(type) ?? new Set();
      set.add({ fn, once: Boolean(options.once) });
      element.listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      const set = element.listeners.get(type);
      if (!set) return;
      for (const entry of set) if (entry.fn === fn) set.delete(entry);
    },
    dispatch(type, event = {}) {
      const set = element.listeners.get(type);
      if (!set) return 0;
      let called = 0;
      for (const entry of [...set]) {
        entry.fn({ preventDefault() {}, target: element, ...event });
        called += 1;
        if (entry.once) set.delete(entry);
      }
      return called;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() {
      return false;
    },
    focus() {},
    /** Every descendant with this class, in document order. */
    all(className) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.classes.has(className)) found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
    /** The deepest first descendant with this class. */
    first(className) {
      return this.all(className)[0] ?? null;
    },
    querySelector(selector) {
      const byClass = /^\.([\w-]+)$/.exec(selector);
      if (byClass) return this.first(byClass[1]);
      const byAttr = /^\[([\w-]+)="([\w-]+)"\]$/.exec(selector);
      if (byAttr) {
        for (const node of walkAll(element)) {
          if (node.attributes.get(byAttr[1]) === byAttr[2]) return node;
        }
      }
      return null;
    },
    querySelectorAll(selector) {
      const byClass = /^\.([\w-]+)$/.exec(selector);
      if (byClass) return this.all(byClass[1]);
      const byAttr = /^\[([\w-]+)="([\w-]+)"\]$/.exec(selector);
      if (byAttr) return walkAll(element).filter((node) => node.attributes.get(byAttr[1]) === byAttr[2]);
      return [];
    },
  };
  return element;
}

function walkAll(node) {
  const out = [node];
  for (const child of node.children) out.push(...walkAll(child));
  return out;
}
