/**
 * controls.js — THE painted-control primitive. One factory, one implementation of
 * pointer capture, drag mapping, value clamping, keyboard stepping, focus and ARIA
 * state, for every control in the instrument. New controls are configurations of
 * this, never new code.
 *
 *   createControl(config[, store]) -> HTMLElement
 *
 *   config.type   'rotary' | 'vfader' | 'hfader' | 'toggle' | 'step' | 'choice'
 *   config.key    REQUIRED. A key declared in the parameter schema; the store is
 *                 the authority for range, curve and unit, so the control reads
 *                 them from there. Throws on an undeclared key.
 *   config.label  REQUIRED. Visible legend, and the accessible name.
 *   config.hue    'sage'|'sky'|'rose'|'ochre'|'lavender' — sets data-hue so CSS
 *                 picks the section's palette entry instead of hard-coding colour.
 *   config.text   painted text for 'toggle'/'step' (defaults to label)
 *   config.units  override the schema unit for the readout only
 *   config.optionLabel (value) => string   label text for 'choice' options
 *   config.valueText  (value) => string    override the readout / aria-valuetext
 *   config.id     override the generated element id
 *
 * INTERACTION (all of it lives here, once)
 *   rotary / vertical / horizontal  pointer capture on the painted element and
 *     movementY (rotary, vertical) or movementX (horizontal); shift = 5x finer;
 *     double-click = back to the configured default; ArrowUp/Down/Left/Right step,
 *     Shift+Arrow fine, PageUp/PageDown coarse, Home/End = range extremes.
 *     Continuous writes go through the store with apply:'ramp'.
 *   toggle / step                   a real <button> that flips aria-pressed;
 *     switch-like writes are direct.
 *   choice                          a real <select> over the schema's enum options.
 *
 * MARKUP
 *   .ctl is the wrapper and carries data-key / data-type / data-hue plus
 *   --ctl-position (0..1 across the range), which is how the paint layer draws
 *   the pointer angle or filled stroke without any JS geometry.
 *   .ctl__paint is the painted surface. For continuous types it wraps a real,
 *   focusable <input type="range"> that is pointer-transparent, so the gesture
 *   lands on the paint while the semantic control keeps focus, keyboard and ARIA.
 *   For 'toggle'/'step' the paint surface IS the <button>.
 *   .ctl__readout is aria-hidden: aria-valuetext already carries the value to a
 *   screen reader, and a visible number should not be announced twice.
 *
 * Pure mapping helpers (positionToValue, valueToPosition, stepValue, dragBy,
 * formatValue) are exported separately because they are the logic worth testing
 * without a DOM. This module touches no DOM at import time.
 */
import { store as defaultStore } from './params.js';

export const CONTROL_TYPES = ['rotary', 'vfader', 'hfader', 'toggle', 'step', 'choice'];

const CONTINUOUS = new Set(['rotary', 'vfader', 'hfader']);
const SWITCH = new Set(['toggle', 'step', 'choice']);

/** Pixels of travel for the full range of a drag. */
export const DRAG_RANGE_PX = 200;
/** Shift makes a drag this many times finer. */
const FINE_DRAG_FACTOR = 5;

const HUES = ['sage', 'sky', 'rose', 'ochre', 'lavender'];

const OPTION_LABELS = {
  pulse25: 'Pulse 25%',
  pulse125: 'Pulse 12.5%',
  sawDown: 'Saw (falling)',
  sawUp: 'Saw (rising)',
  lp24: 'LP 24',
  lp12: 'LP 12',
  hp12: 'HP 12',
  bp12: 'BP 12',
  notch12: 'Notch 12',
  updown: 'Up-Down',
  asplay: 'As Play',
  sampleHold: 'Sample & Hold',
  warmSaw: 'Warm Saw',
  softSquare: 'Soft Square',
};

const takenIds = new Set();

/* ------------------------------------------------------------- pure logic --- */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function prettyOption(value) {
  if (OPTION_LABELS[value]) return OPTION_LABELS[value];
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toUpperCase();
}

/** Gesture position (0..1) -> real value, honouring the schema curve. */
export function positionToValue(entry, position) {
  const p = clamp01(position);
  if (entry.curve === 'log' && entry.min > 0) return entry.min * (entry.max / entry.min) ** p;
  return entry.min + (entry.max - entry.min) * p;
}

/** Real value -> gesture position (0..1). */
export function valueToPosition(entry, value) {
  const v = Math.min(Math.max(value, entry.min), entry.max);
  if (entry.curve === 'log' && entry.min > 0) return Math.log(v / entry.min) / Math.log(entry.max / entry.min);
  return entry.max === entry.min ? 0 : (v - entry.min) / (entry.max - entry.min);
}

function finish(entry, candidate) {
  let v = candidate;
  if (entry.kind === 'int') v = Math.round(v);
  if (v < entry.min) v = entry.min;
  if (v > entry.max) v = entry.max;
  return v;
}

/** One keyboard step from `value`. `direction` is +1 / -1. */
export function stepValue(entry, value, direction, { fine = false, coarse = false } = {}) {
  const size = coarse ? 10 : fine ? 1 / FINE_DRAG_FACTOR : 1;
  let next;
  if (entry.curve === 'log' && entry.min > 0) {
    const ratio = (entry.max / entry.min) ** (size / 100);
    next = value * (direction > 0 ? ratio : 1 / ratio);
  } else if (entry.kind === 'int') {
    next = value + (coarse ? 10 : 1) * direction;
  } else {
    next = value + ((entry.max - entry.min) / 100) * size * direction;
  }
  return finish(entry, next);
}

/** A drag delta in pixels -> the new value. Reads the CURRENT value, so the
 *  caller accumulates one move at a time.
 *
 *  AXIS CONTRACT: `axis` names the axis *this control reads* ('x' for a
 *  horizontal fader, 'y' for a rotary or a vertical fader) — not the axis the
 *  pointer happened to move on. The other component is therefore discarded: a
 *  horizontal fader that receives only dy cannot move, and a rotary that
 *  receives only dx cannot move. Positive movement on the control's own axis
 *  always means "towards the maximum", which is why only the vertical read is
 *  negated (screen y grows downwards, value grows upwards). */
export function dragBy(entry, value, { dx = 0, dy = 0, axis = 'y', fine = false } = {}) {
  const pixels = axis === 'x' ? dx : -dy;
  const span = DRAG_RANGE_PX * (fine ? FINE_DRAG_FACTOR : 1);
  return positionToValue(entry, valueToPosition(entry, value) + pixels / span);
}

/** The readout string. Same text as aria-valuetext, so what is read out is what
 *  is painted.
 *
 *  CONVENTION: where a value has a unit that implies a scale (Hz, s, ms, cents)
 *  the painted number keeps a FIXED number of decimals, so the readout does not
 *  change width as the control moves — '1.20 kHz', never '1.2 kHz'; '1.0 ms',
 *  never '1 ms'. A bare number with no scale is trimmed instead. A unipolar
 *  0..1 depth reads as plain 0-100 digits; a bipolar one carries its sign, so it
 *  is painted as a signed percentage. */
export function formatValue(entry, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const unit = entry.unit ?? '';
  if (unit === 'Hz') return v >= 1000 ? `${painted(v / 1000, v % 1000 === 0 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (unit === 's') {
    if (v < 1) return `${painted(v * 1000, v * 1000 < 10 ? 1 : 0)} ms`;
    return `${painted(v, 1)} s`;
  }
  if (unit === '%') return `${Math.round(v)}%`;
  if (unit === 'BPM') return `${Math.round(v)} BPM`;
  if (unit === 'dB') return `${v > 0 ? '+' : ''}${Math.round(v)} dB`;
  if (unit === 'st' || unit === 'ct') {
    const n = entry.kind === 'int' ? String(Math.round(v)) : painted(v, Math.abs(v) < 10 ? 2 : 1);
    return `${v > 0 ? '+' : ''}${n} ${unit}`;
  }
  if (!unit && entry.min >= 0 && entry.max <= 1) return String(Math.round(v * 100));
  if (!unit && entry.min < 0 && entry.max <= 1) {
    const n = Math.round(v * 100);
    return `${n < 0 ? '-' : ''}${Math.abs(n)}%`;
  }
  return tidy(v, 4);
}

/** Fixed decimals — the trailing zero is kept so the painted field keeps its
 *  width while the value moves. */
function painted(v, decimals) {
  return v.toFixed(decimals);
}

/** Trailing zeros dropped — for a bare number there is no scale to align to. */
function tidy(v, decimals) {
  return String(Number(v.toFixed(decimals)));
}

function uniqueId(wanted) {
  let id = wanted;
  let n = 1;
  while (takenIds.has(id)) {
    n += 1;
    id = `${wanted}-${n}`;
  }
  takenIds.add(id);
  return id;
}

/* --------------------------------------------------------------- the factory --- */

/**
 * Build one painted control. Returns the `.ctl` wrapper element, already bound to
 * the store and already painted at the store's current value.
 */
export function createControl(config, store = defaultStore) {
  const { type, key, label } = config;
  if (!CONTROL_TYPES.includes(type)) {
    throw new Error(`createControl: unknown type "${type}" (expected one of ${CONTROL_TYPES.join(', ')})`);
  }
  if (!key) throw new Error(`createControl: "${type}" needs a key`);
  if (!label) throw new Error(`createControl: "${type}" ${key} needs a label`);

  const entry = store.schema(key);
  if (!entry) throw new Error(`createControl: "${key}" is not declared in the parameter schema`);
  if (CONTINUOUS.has(type) && entry.kind !== 'number' && entry.kind !== 'int') {
    throw new Error(`createControl: ${key} is a ${entry.kind}, so it cannot be a ${type}`);
  }

  const entryForDisplay = config.units ? { ...entry, unit: config.units } : entry;
  const hue = HUES.includes(config.hue) ? config.hue : 'sage';
  const id = uniqueId(config.id ?? `ctl-${key.replace(/[^\w]+/g, '-')}`);

  const root = document.createElement('div');
  root.className = `ctl ctl--${type}`;
  root.dataset.key = key;
  root.dataset.type = type;
  root.dataset.hue = hue;

  const paint = document.createElement('div');
  paint.className = 'ctl__paint';

  const dab = document.createElement('span');
  dab.className = 'ctl__dab';
  dab.setAttribute('aria-hidden', 'true');
  paint.append(dab);

  const readoutOf = (value) => (config.valueText ? config.valueText(value) : formatValue(entryForDisplay, value));

  if (CONTINUOUS.has(type)) {
    const input = document.createElement('input');
    input.className = 'ctl__input';
    input.type = 'range';
    input.id = id;
    input.min = String(entry.min);
    input.max = String(entry.max);
    input.step = 'any';
    input.setAttribute('role', 'slider');
    input.setAttribute('aria-valuemin', String(entry.min));
    input.setAttribute('aria-valuemax', String(entry.max));
    if (type !== 'rotary') input.setAttribute('aria-orientation', type === 'vfader' ? 'vertical' : 'horizontal');
    paint.append(input);

    const legend = document.createElement('label');
    legend.className = 'ctl__legend';
    legend.htmlFor = id;
    legend.textContent = label;

    const readout = document.createElement('span');
    readout.className = 'ctl__readout';
    readout.setAttribute('aria-hidden', 'true');

    root.append(paint, legend, readout);
    wireContinuous({ root, paint, input, readout, config, entry, store, readoutOf });
  } else if (type === 'choice') {
    root.append(paint);
    /* An enum has no numeric scale, so the readout is the option's own painted
     * name — never formatValue's '—'. */
    const choiceReadout = (value) => (config.optionLabel ? config.optionLabel(value) : prettyOption(value));
    return buildChoice({ root, paint, config, entry, store, readoutOf: choiceReadout });
  } else {
    const button = document.createElement('button');
    button.className = 'ctl__input ctl__button';
    button.type = 'button';
    button.id = id;
    button.setAttribute('aria-pressed', 'false');

    const text = document.createElement('span');
    text.className = 'ctl__legend';
    text.textContent = config.text ?? label;
    button.append(text);
    paint.append(button);
    paint.classList.add('ctl__paint--button');
    root.append(paint);

    const view = { root, button };
    button.addEventListener('click', () => commit(config, store, !store.get(key), true));
    store.subscribe(key, (_k, value) => renderButton(view, value));
    renderButton(view, store.get(key));
  }

  return root;
}

function buildChoice({ root, paint, config, entry, store, readoutOf }) {
  const select = document.createElement('select');
  select.className = 'ctl__select';
  select.id = `${root.dataset.key.replace(/[^\w]+/g, '-')}-select`;
  for (const option of entry.options) {
    const el = document.createElement('option');
    el.value = option;
    el.textContent = config.optionLabel ? config.optionLabel(option) : prettyOption(option);
    select.append(el);
  }
  paint.append(select);

  const legend = document.createElement('label');
  legend.className = 'ctl__legend';
  legend.htmlFor = select.id;
  legend.textContent = config.label;

  const readout = document.createElement('span');
  readout.className = 'ctl__readout';
  readout.setAttribute('aria-hidden', 'true');

  root.append(legend, readout);
  const view = { select, readout };
  select.addEventListener('change', () => commit(config, store, select.value, true));
  store.subscribe(config.key, (_k, value) => renderChoice(view, value, readoutOf));
  renderChoice(view, store.get(config.key), readoutOf);
  return root;
}

/* ------------------------------------------------------------- the one impl --- */

function commit(config, store, value, direct) {
  store.set(config.key, value, { source: 'control', apply: direct ? 'direct' : 'ramp' });
}

function renderButton({ root, button }, value) {
  const on = Boolean(value);
  button.setAttribute('aria-pressed', String(on));
  root.classList.toggle('is-on', on);
}

function renderChoice({ select, readout }, value, readoutOf) {
  if (select.value !== value) select.value = String(value);
  readout.textContent = readoutOf(value);
}

function renderContinuous({ root, input, readout }, value, entry, readoutOf) {
  root.style.setProperty('--ctl-position', valueToPosition(entry, value).toFixed(4));
  input.value = String(value);
  input.setAttribute('aria-valuenow', String(value));
  input.setAttribute('aria-valuetext', readoutOf(value));
  readout.textContent = readoutOf(value);
}

function wireContinuous({ root, paint, input, readout, config, entry, store, readoutOf }) {
  const key = config.key;
  const axis = config.type === 'hfader' ? 'x' : 'y';
  const view = { root, input, readout };
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  /* Pointer capture lives on the painted element, so a drag that wanders off the
   * control keeps tracking and a drag that ends elsewhere still ends. */
  paint.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    paint.setPointerCapture(event.pointerId);
    paint.classList.add('is-dragging');
    input.focus({ preventScroll: true });
    event.preventDefault();
  });

  paint.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.movementX || event.clientX - lastX;
    const dy = event.movementY || event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    commit(config, store, dragBy(entry, store.get(key), { dx, dy, axis, fine: event.shiftKey }), false);
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    if (paint.hasPointerCapture(event.pointerId)) paint.releasePointerCapture(event.pointerId);
    paint.classList.remove('is-dragging');
  };
  paint.addEventListener('pointerup', endDrag);
  paint.addEventListener('pointercancel', endDrag);

  paint.addEventListener('dblclick', () => commit(config, store, entry.def, false));

  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        commit(config, store, stepValue(entry, store.get(key), 1, { fine: event.shiftKey }), false);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        commit(config, store, stepValue(entry, store.get(key), -1, { fine: event.shiftKey }), false);
        break;
      case 'PageUp':
        commit(config, store, stepValue(entry, store.get(key), 1, { coarse: true }), false);
        break;
      case 'PageDown':
        commit(config, store, stepValue(entry, store.get(key), -1, { coarse: true }), false);
        break;
      case 'Home':
        commit(config, store, entry.min, false);
        break;
      case 'End':
        commit(config, store, entry.max, false);
        break;
      default:
        return; // every other key belongs to the page
    }
    event.preventDefault(); // never let the native range step as well
  });

  store.subscribe(key, (_k, value) => renderContinuous(view, value, entry, readoutOf));
  renderContinuous(view, store.get(key), entry, readoutOf);
}