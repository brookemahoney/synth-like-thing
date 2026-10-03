/**
 * sequencer-view.js — THE SEQUENCER PANEL'S BEHAVIOUR: the lane grid's gestures, the chain
 * slots, and the playhead. Self-initialising, the same shape as ui/paint.js, ui/waveload.js
 * and ui/power.js, so web/index.html needs nothing for it.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
 *   It reads the store and writes the store. Every value a cell shows comes from a store
 *   key — `seq.<lane>.on.<n>`, `seq.<lane>.vel.<n>`, `seq.melody.note.<n>`,
 *   `seq.melody.gate.<n>`, `seq.pattern`, `seq.chain`, `seq.chainOrder` — and every
 *   gesture writes one of those keys. There is no second copy of the sequence anywhere in
 *   the UI, which is why a preset (task 12) that patches the store repaints this panel for
 *   free and why a pattern switch is visible in the grid the instant it is selected.
 *
 *   IT DOES NOT PAINT A PLAYHEAD. Task 2's stylesheet already resolves a glistening step
 *   dab from `[data-playing="true"]`, and the firing step is published as the `seq.step`
 *   store key. So the only integration is: subscribe to `seq.step`, and move the
 *   attribute onto the cell that matches. A second, hand-painted playhead would be two
 *   playheads.
 *
 * THE PLAYHEAD LEADS THE SOUND BY THE CLOCK'S LOOKAHEAD, AND THAT IS CORRECT
 *   The scheduler places every step up to 100 ms before it is heard, so the firing step is
 *   known up to 100 ms early. The dab therefore moves at the moment the step is SCHEDULED.
 *   This is the same lead every lookahead sequencer's UI has; hiding it would need a second
 *   timer, which the plan forbids.
 *
 * THE CELL GESTURES
 *   click             toggle the step
 *   drag up / down    the ACCENT, 0..100%, the same gesture language as every knob here
 *   shift + click     step the accent through four presets (40 / 60 / 90 / 100)
 *   arrow keys        move the accent by one, Home/End to its extremes — so the grid is
 *                     fully operable without a pointer
 *
 * A cell is a real `<button>` with an accessible name that states the lane, the step,
 * whether it is on and its accent, so nothing here depends on colour or hover to be
 * legible.
 */

import { PATTERNS, SEQUENCER_LANES, STEPS, store as defaultStore } from './params.js';
/* The audio sequencer, for the ONE implementation of the chain order's rules. A static
   import, not a dynamic one: both this module and ui/main.js import
   `../audio/sequencer-run.js`, and the module cache guarantees they get the same singleton,
   so a slot click can never call a different sequencer than the one driving the clock. */
import { sequencer } from '../audio/sequencer-run.js';

/** The accessible name for a lane: the kit voice's name, or the melodic lane's own. */
const LANE_TITLES = Object.freeze({
  bd: 'Bass Drum', sd: 'Snare', lt: 'Low Tom', mt: 'Mid Tom', ht: 'Hi Tom',
  rs: 'Rim Shot', cp: 'Clap', cb: 'Cowbell', ch: 'Closed Hat', oh: 'Open Hat',
  cy: 'Cymbal', melody: 'Melodic Synth',
});

/** The accent presets shift-click cycles through, in percent. */
export const ACCENT_PRESETS = [40, 60, 90, 100];

/** One percent of accent per pixel of drag, over the full 0..100 range. */
export const ACCENT_DRAG_RANGE_PX = 160;

/** Read the accent presets out of a cell's `data-preset` marker. */
function presetAt(cell, index) {
  const list = ACCENT_PRESETS;
  const next = Math.max(0, Math.min(list.length - 1, index));
  cell.dataset.preset = String(next);
  return list[next];
}

/**
 * The grid's own view state, with no DOM and no store — so the cell model can be reasoned
 * about (and re-rendered) without touching the document. `mount` below is the only part
 * that builds elements.
 */
export function createCellModel({ store = defaultStore, doc = document } = {}) {
  const root = doc.querySelector('[data-lane-grid="sequencer"]');
  const slots = doc.querySelector('[data-chain-slots="sequencer"]');
  const chainOut = doc.querySelector('[data-chain-order="sequencer"]');
  if (!root) return null;

  const cells = new Map();
  for (const element of root.querySelectorAll('.step')) {
    const lane = element.dataset.lane;
    const step = Number(element.dataset.step);
    if (!lane || !Number.isFinite(step)) continue;
    cells.set(`${lane}:${step}`, { element, lane, step });
  }

  const unsubscribes = [];
  let playing = null;

  const accentOf = (lane, step) => Number(store.get(`seq.${lane}.vel.${step}`));
  const isOn = (lane, step) => Boolean(store.get(`seq.${lane}.on.${step}`));

  /** Paint one cell from the store. The ONLY place a cell's appearance is decided. */
  function paintCell(lane, step) {
    const cell = cells.get(`${lane}:${step}`);
    if (!cell) return false;
    const on = isOn(lane, step);
    const accent = accentOf(lane, step);
    cell.element.classList.toggle('is-on', on);
    cell.element.dataset.accents = String(Math.round(accent));
    cell.element.setAttribute('aria-pressed', String(on));
    cell.element.setAttribute(
      'aria-label',
      `${LANE_TITLES[lane] ?? lane} step ${step}, ${on ? 'on' : 'off'}, accent ${Math.round(accent)}%`,
    );
    cell.element.title = `${LANE_TITLES[lane] ?? lane} ${step} — ${on ? 'on' : 'off'}, ${Math.round(accent)}%`;
    /* THE ACCENT, VISIBLE WITHOUT A STYLESHEET CHANGE. `.step.is-on` fills the cell with
       the lane hue; the accent is painted as the depth of that fill's lower edge, so a
       100% accent is a full-thickness edge and a 20% accent a hairline. */
    cell.element.style.borderBottomWidth = `${(0.5 + (Math.max(0, Math.min(100, accent)) / 100) * 2.5).toFixed(2)}px`;
    return true;
  }

  function paintAll() {
    for (const lane of SEQUENCER_LANES) {
      for (let step = 1; step <= STEPS; step += 1) paintCell(lane, step);
    }
  }

  function setOn(lane, step, on) {
    store.set(`seq.${lane}.on.${step}`, Boolean(on), { source: 'control', apply: 'direct' });
  }

  function setAccent(lane, step, percent) {
    const next = Math.max(0, Math.min(100, Math.round(percent)));
    store.set(`seq.${lane}.vel.${step}`, next, { source: 'control', apply: 'direct' });
    return next;
  }

  /* ------------------------------------------------------------------- the playhead --- */

  /**
   * Move the playhead. The attribute, not a paint: `styles/paint.css` resolves
   * `[data-playing="true"]` into the vermilion glisten, and exactly one element carries it.
   */
  function setPlayhead(step) {
    if (playing === step) return false;
    /* Clear every lane's cell for the step being left: the playhead is a COLUMN, not one
       dab, so all twelve lanes light together and exactly one column is ever marked. */
    if (playing !== null) {
      for (const lane of SEQUENCER_LANES) {
        cells.get(`${lane}:${playing}`)?.element.removeAttribute('data-playing');
      }
    }
    playing = step;
    if (step === null) return true;
    for (const lane of SEQUENCER_LANES) {
      cells.get(`${lane}:${step}`)?.element.setAttribute('data-playing', 'true');
    }
    return true;
  }

  /* ------------------------------------------------------------------ the gestures --- */

  function bindCell(cell) {
    const lane = cell.lane;
    const step = cell.step;

    let dragging = false;
    let moved = false;
    let startY = 0;
    let startAccent = 0;

    cell.element.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true;
      moved = false;
      startY = event.clientY;
      startAccent = accentOf(lane, step);
      cell.element.setPointerCapture?.(event.pointerId);
      cell.element.classList.add('is-dragging');
      cell.element.focus({ preventScroll: true });
      event.preventDefault();
    });

    cell.element.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dy = event.clientY - startY;
      if (Math.abs(dy) < 2 && !moved) return;
      moved = true;
      const scale = event.shiftKey ? 5 : 1;
      setAccent(lane, step, startAccent - (dy * scale * 100) / ACCENT_DRAG_RANGE_PX);
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      if (cell.element.hasPointerCapture?.(event.pointerId)) cell.element.releasePointerCapture(event.pointerId);
      cell.element.classList.remove('is-dragging');
      if (moved) return;
      /* A drag that moved is an accent gesture; a drag that did not is a toggle. */
      setOn(lane, step, !isOn(lane, step));
    };
    cell.element.addEventListener('pointerup', endDrag);
    cell.element.addEventListener('pointercancel', endDrag);

    cell.element.addEventListener('click', (event) => {
      /* Shift-click steps the accent rather than toggling: on a grid where a plain click is
         a toggle, the modifier is the only place an accent can be set coarsely. */
      if (!event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      setAccent(lane, step, presetAt(cell.element, Number(cell.element.dataset.preset ?? 0) + 1));
    });

    cell.element.addEventListener('keydown', (event) => {
      const key = event.key;
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
        const current = accentOf(lane, step);
        const step10 = event.shiftKey ? 10 : 1;
        const next = key === 'Home' ? 0 : key === 'End' ? 100 : current + (key === 'ArrowUp' ? step10 : -step10);
        setAccent(lane, step, next);
        event.preventDefault();
        return;
      }
      if (key === ' ') {
        setOn(lane, step, !isOn(lane, step));
        event.preventDefault();
      }
    });
  }

  for (const [, cell] of cells) bindCell(cell);

  /* ----------------------------------------------------------------- the chain slots --- */

  const buttons = slots ? [...slots.querySelectorAll('[data-pattern]')] : [];

  function paintSlots() {
    const selected = store.get('seq.pattern');
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.pattern === selected));
    }
    if (!chainOut) return;
    const order = store.get('seq.chainOrder');
    chainOut.textContent = store.get('seq.chain')
      ? `Chain: ${Array.isArray(order) && order.length > 0 ? order.join('-') : 'empty'}`
      : 'Chain off — click the slots to build one';
    chainOut.dataset.chainLength = String(Array.isArray(order) ? order.length : 0);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const pattern = button.dataset.pattern;
      if (!PATTERNS.includes(pattern)) return;
      store.set('seq.pattern', pattern, { source: 'control', apply: 'direct' });
      /* With CHAIN engaged the same click APPENDS to the order — that is the whole
         click-to-build gesture. With it off the click is a plain selection, so the slots
         double as the pattern selector and nothing is unreachable. The appending itself is
         `sequencer.chainAppend`, which is the ONE implementation of the order's rules. */
      if (store.get('seq.chain')) sequencer.chainAppend(pattern);
      paintSlots();
    });
  }

  /* ------------------------------------------------------------------ the wiring --- */

  /* A store-driven repaint of everything this view shows. Subscribing per cell key would be
     416 subscriptions; one `subscribeAll` filter is the same work with one. */
  const CELL = /^seq\.([A-Za-z][A-Za-z0-9]*)\.(on|vel|note|gate)\.(\d{1,2})$/;
  unsubscribes.push(store.subscribeAll((key, value) => {
    const match = CELL.exec(key);
    if (!match) return;
    paintCell(match[1], Number(match[3]));
  }));

  unsubscribes.push(store.subscribe('seq.step', (_key, value) => {
    setPlayhead(Number.isFinite(value) ? value : null);
  }));

  for (const key of ['seq.pattern', 'seq.chain', 'seq.chainOrder']) {
    unsubscribes.push(store.subscribe(key, () => paintSlots()));
  }

  paintAll();
  paintSlots();
  setPlayhead(Number(store.get('seq.step')) || 1);

  return {
    root,
    slots,
    cells,
    /** The view's own readouts, for task 13's inspection handle. */
    cells: () => cells.size,
    playhead: () => playing,
    playingElement: () => (playing === null ? null : root.querySelector(`[data-step="${playing}"][data-playing="true"]`)),
    laneTitles: () => ({ ...LANE_TITLES }),
    chainText: () => (chainOut ? chainOut.textContent : ''),
    dispose() {
      for (const off of unsubscribes) off?.();
      cells.clear();
    },
  };
}

/* ------------------------------------------------------------------- self-initialise --- */

const view = {
  instance: null,
  /** The live view, for a verification probe. */
  get model() {
    return view.instance;
  },
};

/**
 * Mount, idempotently.
 *
 * WHEN IT MOUNTS MATTERS, and this is the one ordering trap in the page. A `<script
 * type="module">` is DEFERRED: it is evaluated after the document is parsed but BEFORE
 * `DOMContentLoaded`, and it is evaluated before `ui/main.js`'s own body — which is where
 * `buildSurface()` runs. So at this module's evaluation time the surface has NOT been
 * drawn, the grid does not exist yet, and a mount that runs immediately finds nothing and
 * silently does nothing.
 *
 * Hence the condition: mount at once only when the document is `complete`, which is the
 * only state that is unambiguously after both the parser and `buildSurface()`. Every other
 * state waits for `DOMContentLoaded`, which `buildSurface()` has already run by.
 */
export function startSequencerView(doc = document) {
  if (view.instance) return view.instance;
  view.instance = createCellModel({ doc });
  return view.instance;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'complete') {
    startSequencerView();
  } else {
    document.addEventListener('DOMContentLoaded', () => startSequencerView(), { once: true });
  }
}
