/**
 * keyboard.js — THE INPUT. On-screen keys, the computer-keyboard tracker layout,
 * the octave shift, and latch. Everything that starts a note outside the sequencer
 * starts it here.
 *
 * The four rules this module exists to get right
 *   1. VELOCITY FROM WHERE YOU CLICKED. The y-position inside the key maps to
 *      velocity: the top of the key is the loud end. Pure, monotonic, clamped.
 *   2. THE TRACKER LAYOUT. The familiar `A W S E D F T G Y H U J K` lower octave and
 *      `Q 2 W 3 E R 5 T 6 Y 7 U` upper arrangement, plus `Z`/`X` for the octave.
 *   3. KEY REPEAT IS NOT A NOTE. The OS repeats `keydown` at ~30 Hz while a key is
 *      held; acting on it retriggers one note forever and buries the polyphony. Both
 *      the `repeat` flag and a down-set are checked.
 *   4. LATCH IS A RETENTION POLICY, NOT A MODE FLAG. A note-off while latch is
 *      engaged retains the note; disengaging latch releases everything retained.
 *
 * WHY SPACE IS NOT BOUND
 *   It is the obvious key for a sustain pedal and it silently breaks page scrolling
 *   for every keyboard user, in every browser, forever. Latch is a real painted
 *   button with `aria-pressed`, reachable by Tab and operable with Space or Enter
 *   *while it is focused* — which is the platform's own behaviour, not a global
 *   binding. No listener in this file handles Space, and no handler calls
 *   `preventDefault()` on anything it does not own.
 *
 * NO NOTE CAN BE STRANDED
 *   Pointer capture goes on the key that was pressed, so `pointerup` and
 *   `pointercancel` are delivered even when the pointer leaves the window;
 *   `lostpointercapture` is handled as a third release; `window.blur` and
 *   `visibilitychange` release everything. Every path out of "held" is exercised in
 *   tests/keyboard.test.mjs, because a stuck note is the one failure a user cannot
 *   undo by clicking harder.
 *
 * ONE HELD-NOTE REGISTRY
 *   Task 010's arpeggiator needs to know what the player is holding. The plan gives
 *   this task the registry. So `heldNotes()` reads the engine's registry when the
 *   engine publishes one, and publishes this input's list into it when it can, and
 *   only falls back to its own list when there is no shared registry to talk to. It
 *   is keyed by note id — the same id that travels into `noteOn` — so there is never
 *   a second list that can drift from the arpeggiator's view.
 *
 * THIS MODULE TOUCHES NO DOM AT IMPORT TIME, AND IMPORTS NO AUDIO MODULE AT IMPORT
 *   TIME. The audio engine is resolved inside `mountKeybed()`, in the browser, from
 *   a dynamic import — so `node --test` can import this file and drive the whole
 *   input model with a fake engine. The same shape as ui/waveload.js.
 *
 * API
 *   KEY_LOW / KEY_HIGH / KEY_COUNT / SEMITONE_SPAN     the keybed's span
 *   VELOCITY_TOP / VELOCITY_BOTTOM / COMPUTER_VELOCITY the velocity range
 *   LOWER_ROW / UPPER_ROW / COMPUTER_KEYS / OCTAVE_STEP_KEYS   the mapping tables
 *   buildKeys(low, high)          the keybed's geometry
 *   noteName(note)                'C#3'
 *   velocityFromOffset(y, h)      a click height -> a velocity
 *   velocityFromPoint(y, rect)    the same, from a getBoundingClientRect()
 *   noteForCode(code, { base, octave })    a physical key -> a MIDI note, or null
 *   octaveStepForCode(code)       -1 / +1 / 0
 *   isRepeatTrigger({ code, repeat, down })  may this keydown start a note?
 *   isTypingTarget(el)            is this element somewhere the user is typing?
 *   createLatch()                 the retention policy on its own
 *   createInputCore({ engine, store, announce })  the whole input model, DOM-free
 *   buildKeybed(doc, deps)        the markup, wired to a core
 *   mountKeybed(doc, deps)        build it, wire the computer keys, once
 *   heldNotes() / heldPitches() / latchedPitchClasses()   the shared registry
 */
import { store as defaultStore } from './params.js';
import { liveRegion } from './power.js';

/* ------------------------------------------------------------- the keybed's span --- */

/** C2 to C6. Four octaves: past the three-octave floor with room for the shift. */
export const KEY_LOW = 36;
export const KEY_HIGH = 84;
export const KEY_COUNT = KEY_HIGH - KEY_LOW + 1;
/** Semitone distance from the lowest key to the highest — what "three octaves" means. */
export const SEMITONE_SPAN = KEY_HIGH - KEY_LOW;

/** The white notes' pitch classes. Everything else is black. */
export const WHITE_PCS = Object.freeze([0, 2, 4, 5, 7, 9, 11]);

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* ------------------------------------------------------------------- velocity --- */

/** The loud end of a key: its very top edge. */
export const VELOCITY_TOP = 1;
/** The soft end: the bottom edge, still audible. */
export const VELOCITY_BOTTOM = 0.3;
/** A computer key has no height to strike, so it plays at one fixed level. */
export const COMPUTER_VELOCITY = 0.8;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The engine's own held-note registry, or null when this build's engine does not
 * publish one. Task 010 owns engine.js; this reads it defensively so the input
 * works against an engine with no registry at all — and against one that has it.
 */
export function sharedHeldNotes(engine) {
  if (typeof engine?.heldNotes !== 'function') return null;
  const list = engine.heldNotes();
  return Array.isArray(list) ? list : null;
}

/**
 * How far down the key the pointer landed, as a velocity.
 *
 *   offsetY  distance from the key's top edge, in the key's own pixels
 *   height   the key's height
 *
 * Screen y grows downwards and loudness grows upwards, so this DESCENDS with
 * offsetY: 0 is the top edge and the loudest, `height` is the bottom edge and the
 * quietest. A zero or missing height is the whole key, so it returns the top rather
 * than dividing by zero — the note still sounds.
 */
export function velocityFromOffset(offsetY, height, { top = VELOCITY_TOP, bottom = VELOCITY_BOTTOM } = {}) {
  const hi = clamp01(Number(top));
  const lo = clamp01(Number(bottom));
  const span = Number(height);
  if (!Number.isFinite(span) || span <= 0) return hi;
  const y = Number(offsetY);
  const depth = Number.isFinite(y) ? clamp01(y / span) : 0;
  // Rounded so the extremes are exactly `hi` and `lo` rather than 0.30000000000000004:
  // this number is an amplitude, and float dust in it is noise in a readout.
  return Math.round((hi - (hi - lo) * depth) * 1e6) / 1e6;
}

/** The same mapping, from a live `getBoundingClientRect()` and a viewport y. */
export function velocityFromPoint(clientY, rect) {
  const height = rect?.height ?? (rect ? rect.bottom - rect.top : 0);
  return velocityFromOffset(Number(clientY) - (rect?.top ?? 0), height);
}

/* ------------------------------------------------------------- the key tables --- */

export function noteName(note) {
  const n = Math.round(Number(note));
  if (!Number.isFinite(n)) return '—';
  return `${PITCH_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * The tracker layout, as DATA.
 *
 * The home row is the lower octave: `A W S E D F T G Y H U J K` = C..C. The top row
 * is the upper arrangement: `Q 2 W 3 E R 5 T 6 Y 7 U` = C..B an octave up.
 *
 * FIVE KEYS APPEAR IN BOTH ROWS — W, E, T, Y and U. A physical key cannot sound two
 * notes at once, so the home row wins for those five and `noteForCode()` resolves
 * them to the lower octave. Every other top-row key is unambiguous. `UPPER_ROW`
 * documents the full arrangement (it is what the page prints as the legend);
 * `COMPUTER_KEYS` is the resolved result and is what the input actually plays.
 */
export const LOWER_ROW = Object.freeze({
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5,
  KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
});

export const UPPER_ROW = Object.freeze({
  KeyQ: 0, Digit2: 1, KeyW: 2, Digit3: 3, KeyE: 4, KeyR: 5,
  Digit5: 6, KeyT: 7, Digit6: 8, KeyY: 9, Digit7: 10, KeyU: 11, KeyI: 12,
});

/** `Z` and `X`, the documented octave shift. They are NOT notes. */
export const OCTAVE_STEP_KEYS = Object.freeze({ KeyZ: -1, KeyX: 1 });

/** The note at which the lower octave's C sits when `global.octave` is 0. */
export const BASE_NOTE = 48;

/** Lower row first, so a key on both rows lands on the home row. */
export const COMPUTER_KEYS = Object.freeze(
  Object.assign({}, Object.fromEntries(
    Object.entries(UPPER_ROW).map(([code, semi]) => [code, semi + 12]),
  ), LOWER_ROW),
);

const clampNote = (n) => (n < 0 ? 0 : n > 127 ? 127 : n);

/**
 * A physical key -> a MIDI note, with the octave shift applied, or null when the key
 * is not a note key at all. Space, Enter, the arrows and the octave keys are null,
 * which is why none of them can start a note by accident.
 */
export function noteForCode(code, { base = BASE_NOTE, octave = 0 } = {}) {
  const semitone = COMPUTER_KEYS[code];
  if (semitone === undefined) return null;
  return clampNote(base + 12 * Math.round(Number(octave) || 0) + semitone);
}

/** -1 for the octave-down key, +1 for octave-up, 0 for everything else. */
export function octaveStepForCode(code) {
  return OCTAVE_STEP_KEYS[code] ?? 0;
}

/**
 * May this keydown start a note? Two independent reasons to say no:
 *
 *   `event.repeat`  the OS auto-repeat firing again for a key already down. Acting on
 *                   it retriggers the same note at ~30 Hz and eats a voice each time.
 *   `down`          our own record that the key is already down. Belt and braces: a
 *                   synthesised event with no `repeat` flag must not double-trigger
 *                   either.
 */
export function isRepeatTrigger({ code, repeat = false, down = null } = {}) {
  if (typeof code !== 'string' || code === '') return false;
  if (repeat === true) return false;
  if (down && typeof down.has === 'function' && down.has(code)) return false;
  return true;
}

/**
 * Is the key event aimed at something the user is TYPING into? A painted knob is not
 * a text field — a letter must still play a note with a knob focused — but a select,
 * a text input and a content-editable region must keep every key they own.
 */
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type ?? 'text').toLowerCase();
    return !['range', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color'].includes(type);
  }
  return false;
}

/* ------------------------------------------------------------------- geometry --- */

/**
 * The keybed's geometry: one entry per semitone, in pitch order, each carrying
 * where it sits. `column` is the 1-based white-key index a black key straddles, so
 * the layout is pure data and CSS does the arithmetic.
 */
export function buildKeys(low = KEY_LOW, high = KEY_HIGH) {
  const keys = [];
  let whiteIndex = 0;
  for (let note = low; note <= high; note += 1) {
    const pc = ((note % 12) + 12) % 12;
    const white = WHITE_PCS.includes(pc);
    keys.push({
      note,
      pc,
      octave: Math.floor(note / 12) - 1,
      name: PITCH_NAMES[pc],
      label: noteName(note),
      kind: white ? 'white' : 'black',
      whiteIndex,
      // A black key straddles the boundary BETWEEN two whites, so it sits on the
      // grid column of the white key to its right and is nudged half a track right.
      column: white ? whiteIndex + 1 : whiteIndex,
      isC: pc === 0,
    });
    if (white) whiteIndex += 1;
  }
  return keys;
}

/* ---------------------------------------------------------------- the latch --- */

/**
 * The retention policy, on its own: engaged or not, which notes are retained, and the
 * drain that hands them back when the pedal comes up.
 *
 * A retained note is NOT released on note-off, so it is deliberately absent from
 * `disengage()`'s empty state until it is either drained or panicked. Keeping this
 * separate from the engine means the policy can be tested without audio.
 */
export function createLatch() {
  const retained = new Set();
  let engaged = false;
  return {
    get engaged() { return engaged; },
    engage() { engaged = true; },
    /** Release the pedal: the retained ids come back so the caller can stop them. */
    disengage() {
      engaged = false;
      const ids = [...retained];
      retained.clear();
      return ids;
    },
    /** True when the note-off was retained, i.e. the caller must NOT release it. */
    retain(id) {
      if (!engaged) return false;
      retained.add(id);
      return true;
    },
    retained: () => [...retained],
    clear() { retained.clear(); },
  };
}

/* ----------------------------------------------------------------- the core --- */

const POINTER = 'pointer';
const KEYBOARD = 'keyboard';

/**
 * The whole input model with no DOM in it: what is held, what latch did, what the
 * last octave shift was. The DOM layer in `buildKeybed` is a set of event sources
 * that call into this, and nothing more.
 */
export function createInputCore({ engine = null, store = defaultStore, announce } = {}) {
  /** id -> { id, note, velocity, source }  the notes this input is holding. */
  const held = new Map();
  /** Ids this input has started and then released, so the merge can drop them. */
  const retired = new Set();
  const latch = createLatch();
  /** Physical keys currently down, for repeat suppression. */
  const down = new Set();
  /** pointerId -> the id of the note it is playing. */
  const pointers = new Map();
  const changeListeners = new Set();

  const say = announce ?? (() => {});
  const notify = (event) => { for (const fn of [...changeListeners]) fn(event); };

/** The two id namespaces this input mints. Nothing else's rows are ever filtered. */
const isMine = (id) => typeof id === 'string' && (id.startsWith('kbd:') || id.startsWith('ptr:'));

/**
 * Publish the held notes into ONE registry, keyed by note id.
 *
 * This input is the authority for the notes IT is holding — only it knows whether a
 * release arrived or was retained by latch — so its own record wins for those ids.
 * Notes from anywhere else (the sequencer, the arpeggiator) come from the engine's
 * registry. The two are merged by id on every read, so a stale published list can
 * never keep a released note alive: this input's row is re-written, not inherited.
 */
const emitHeld = () => {
    const shared = sharedHeldNotes(engine) ?? [];
    const merged = new Map();
    for (const row of shared) {
      if (!row || row.id === undefined) continue;
      // An id of OURS that we have released is dropped even if the engine's copy
      // still lists it: the merge is idempotent, so a stale row cannot keep a dead
      // note alive in the arpeggiator's view. Another source's ids are never touched.
      if (isMine(row.id) && retired.has(row.id)) continue;
      merged.set(row.id, row);
    }
    for (const row of held.values()) merged.set(row.id, { ...row });
    const list = [...merged.values()];
    if (typeof engine?.setHeldNotes === 'function') {
      try { engine.setHeldNotes(list.map((row) => ({ ...row }))); } catch { /* a readonly registry is fine */ }
    }
    return list;
  };

  /* --------------------------------------------------------------- note on --- */

  const noteOn = ({ id, note, velocity = COMPUTER_VELOCITY, source = KEYBOARD }) => {
    const pitch = clampNote(Math.round(Number(note)));

    // mono / legato: one note at a time. A LATCHED note is exempt — it is a
    // decision the player already made by engaging the pedal, and swallowing it to
    // make room for the next key would silently discard it.
    const mode = store.get('global.keyboardMode');
    if (mode === 'mono' || mode === 'legato') {
      for (const [otherId, row] of [...held]) {
        if (otherId === id || row.source !== source) continue;
        if (latch.retained().includes(otherId)) continue;
        noteOff(otherId);
      }
    }

    if (held.has(id)) noteOff(id);
    retired.delete(id);
    engine?.noteOn?.({ id, note: pitch, velocity, at: undefined });
    held.set(id, { id, note: pitch, velocity, source, latched: false });
    notify({ type: 'note-on', id, note: pitch, velocity });
    emitHeld();
    return pitch;
  };

  /* -------------------------------------------------------------- note off --- */

  /** Release one note. While latch is engaged the note-off is RETAINED instead. */
  const noteOff = (id, { force = false } = {}) => {
    const row = held.get(id);
    if (!row) return null;
    if (!force && latch.retain(id)) {
      row.latched = true;
      notify({ type: 'latched', id, note: row.note });
      return row.note;
    }
    held.delete(id);
    retired.add(id);
    engine?.noteOff?.(id);
    notify({ type: 'note-off', id, note: row.note });
    emitHeld();
    return row.note;
  };

  /* ----------------------------------------------------------------- latch --- */

  const setLatch = (on) => {
    const want = Boolean(on);
    if (want === latch.engaged) return latch.engaged;
    if (want) {
      latch.engage();
      store.set('global.latch', true, { source: 'keyboard', apply: 'direct' });
      say(`Latch on. ${held.size} note${held.size === 1 ? '' : 's'} will be held.`);
    } else {
      latch.disengage(); // clears the retained set
      for (const id of [...held.keys()]) {
        const row = held.get(id);
        row.latched = false;
        held.delete(id);
        retired.add(id);
        engine?.noteOff?.(id);
        notify({ type: 'note-off', id, note: row.note });
      }
      store.set('global.latch', false, { source: 'keyboard', apply: 'direct' });
      say('Latch off. Held notes released.');
    }
    emitHeld();
    return latch.engaged;
  };

  // The latch button on the page writes the store key; so does a preset. Either way
  // the retention has to follow, or the button and the audio would disagree.
  store.subscribe('global.latch', (_key, value) => {
    if (Boolean(value) === latch.engaged) return;
    setLatch(value);
  });

  const latchEngaged = () => latch.engaged;
  const latchedIds = () => latch.retained();
  const latchedNotes = () => latch.retained().map((id) => held.get(id)?.note).filter((n) => n !== undefined);

  /* ------------------------------------------------------- the computer keys --- */

  const octaveStep = (code) => octaveStepForCode(code);

  const keyDown = (code, { repeat = false } = {}) => {
    if (!isRepeatTrigger({ code, repeat, down })) return null;
    const step = octaveStep(code);
    if (step !== 0) {
      down.add(code);
      const next = (Number(store.get('global.octave')) || 0) + step;
      store.set('global.octave', next, { source: 'keyboard', apply: 'direct' });
      return null;
    }
    const note = noteForCode(code, { base: BASE_NOTE, octave: store.get('global.octave') });
    if (note === null) return null;
    down.add(code);
    noteOn({ id: `kbd:${code}`, note, velocity: COMPUTER_VELOCITY, source: KEYBOARD });
    return note;
  };

  const keyUp = (code) => {
    down.delete(code);
    return noteOff(`kbd:${code}`);
  };

  /* ---------------------------------------------------------------- pointer --- */

  const pointerDown = (pointerId, { note, velocity = COMPUTER_VELOCITY } = {}) => {
    const id = `ptr:${pointerId}`;
    if (pointers.has(pointerId)) pointerUp(pointerId);
    pointers.set(pointerId, id);
    return noteOn({ id, note, velocity, source: POINTER });
  };

  /** Glissando: retarget the SAME id to the key now under the pointer. */
  const pointerMove = (pointerId, { note = null, velocity } = {}) => {
    const id = pointers.get(pointerId);
    if (!id) return null;
    const row = held.get(id);
    if (!row) return null;
    if (note === null || note === row.note) {
      if (velocity !== undefined && velocity !== row.velocity) {
        row.velocity = velocity;
        emitHeld();
      }
      return row.note;
    }
    noteOff(id, { force: true });
    pointers.set(pointerId, id);
    return noteOn({ id, note, velocity: velocity ?? row.velocity, source: POINTER });
  };

  const endPointer = (pointerId) => {
    const id = pointers.get(pointerId);
    if (id === undefined) return null;
    pointers.delete(pointerId);
    down.delete(String(pointerId));
    return noteOff(id);
  };
  const pointerUp = endPointer;
  const pointerCancel = endPointer;

  /* ------------------------------------------------------------------ panic --- */

  /** Everything off, including retained notes: the panic path, and the blur path. */
  const releaseAll = () => {
    const ids = [...held.keys()];
    latch.clear();
    for (const id of ids) {
      const row = held.get(id);
      held.delete(id);
      retired.add(id);
      engine?.noteOff?.(id);
      notify({ type: 'note-off', id, note: row?.note });
    }
    down.clear();
    pointers.clear();
    emitHeld();
    return ids.length;
  };

  /** The id the engine should be publishing. Exported for the test that reads it. */
  const publish = () => emitHeld();

  return {
    noteOn,
    noteOff,
    setLatch,
    latchEngaged,
    latchedIds,
    latchedNotes,
    keyDown,
    keyUp,
    octaveStep,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    releaseAll,
    publish,
    heldNotes: () => emitHeld().map((row) => ({ ...row })),
    heldCount: () => held.size,
    down: () => new Set(down),
    onChange: (fn) => {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
  };
}

/* ------------------------------------------------------------- the DOM layer --- */

/** Every value here is a custom property or a unit the page already uses. The
 *  stylesheets are not this task's to edit, so the few declarations the real bed
 *  needs that the placeholder keybed did not are set inline here — the same way
 *  ui/waveload.js styles its own controls. */
const keyStyle = {
  bed: 'touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer;',
  dimmed: 'opacity:0.42;filter:saturate(0.35);',
  label: 'font-family:var(--font-ui);letter-spacing:0;pointer-events:none;user-select:none;white-space:nowrap;',
  whiteLabel: 'font-size:0.5rem;line-height:1;',
  blackLabel: 'font-size:0.4rem;line-height:1;color:var(--key-ivory);opacity:0.78;',
  hint: 'margin:var(--gap-tight) 0 0;font-size:var(--fs-micro);color:var(--ink-faint);line-height:1.55;',
  strong: 'color:var(--ink);',
  off: 'margin:var(--gap-tight) 0 0;font-size:var(--fs-micro);color:var(--rose-deep);font-style:italic;',
};

const KIND_WORD = { white: 'white key', black: 'black key' };

const classed = (el, ...names) => {
  el.classList.add(...names);
  return el;
};

/**
 * Build the keybed and wire it to a core. Returns the wrapper element, with the
 * keybed hung off it as `wrapper.bed`, the core as `wrapper.core` and the key table
 * as `wrapper.keys` — so a caller (or a test) can read all three without a query.
 */
export function buildKeybed(doc, { engine = null, store = defaultStore, announce, low = KEY_LOW, high = KEY_HIGH } = {}) {
  const core = createInputCore({
    engine,
    store,
    announce: announce ?? ((text) => {
      const region = liveRegion(doc);
      if (region) region.textContent = text;
    }),
  });
  const keys = buildKeys(low, high);
  const whiteCount = keys.filter((key) => key.kind === 'white').length;

  /* ------------------------------------------------------------- the markup --- */

  const wrapper = doc.createElement('div');
  classed(wrapper, 'keybed-wrap');
  wrapper.setAttribute('data-keybed-wrap', '');

  const offNote = doc.createElement('p');
  classed(offNote, 'keybed__off');
  offNote.setAttribute('data-keybed-off', '');
  offNote.setAttribute('style', keyStyle.off);

  const bed = doc.createElement('div');
  classed(bed, 'keybed');
  bed.setAttribute('data-keybed', '');
  bed.setAttribute('role', 'group');
  bed.setAttribute('aria-label',
    `On-screen piano keyboard, ${noteName(low)} to ${noteName(high)}, ${keys.length} keys. ` +
    'Press or click a key to play it; the higher up the key you press, the louder.');
  bed.setAttribute('style', keyStyle.bed);

  const whites = classed(doc.createElement('div'), 'keybed__whites');
  const blacks = classed(doc.createElement('div'), 'keybed__blacks');
  // base.css lays the black keys onto a 15-column grid sized for the placeholder
  // keybed. The real bed has one column per white key, so the track count is stated
  // here and each black key names the white boundary it straddles.
  blacks.style.setProperty('grid-template-columns', `repeat(${whiteCount}, 1fr)`);
  /* base.css positions `.keybed__blacks` as a full-width absolute layer over the top
   * 62% of the bed, so the LAYER — not just the keys on it — sits on top of the white
   * keys and swallows every click on their upper half. The layer stops taking
   * pointer events; the keys on it take them back. This is the difference between a
   * keybed you can only play the bottom of and one you can play. */
  blacks.style.setProperty('pointer-events', 'none');

  /* ----------------------------------------------------------- one key each --- */

  /** note -> the button for it. Filled first, so the glissando lookup can use it. */
  const elements = new Map();

  for (const key of keys) {
    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    classed(button, 'key', `key--${key.kind}`);
    button.setAttribute('data-key-note', '');
    button.setAttribute('data-note', String(key.note));
    button.setAttribute('data-kind', key.kind);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `${key.label}, ${KIND_WORD[key.kind]}, octave ${key.octave}`);
    button.tabIndex = key === keys[0] ? 0 : -1;
    if (key.kind === 'black') {
      /* A black key straddles the boundary BETWEEN two whites, so it is placed on the
       * grid column of the white key to its LEFT — the stylesheet centres it in that
       * column — and then nudged right by half a column with `left: 50%`, which is a
       * percentage of the grid AREA. (A `translateX(50%)` percentage is of the
       * element's own width, which is 62 % of a column and therefore lands the key
       * halfway across the wrong white. Measured, not guessed: every black key's
       * centre sits on the midpoint between its two neighbours.) */
      button.style.setProperty('grid-column', String(key.column));
      button.style.setProperty('position', 'relative');
      button.style.setProperty('left', '50%');
      button.style.setProperty('pointer-events', 'auto');
    }

    // The visible label. aria-hidden because aria-label already carries the name —
    // announcing the same text twice is the classic screen-reader noise bug.
    const label = doc.createElement('span');
    classed(label, 'key__label');
    label.setAttribute('aria-hidden', 'true');
    label.setAttribute('style', keyStyle.label + (key.kind === 'black' ? keyStyle.blackLabel : keyStyle.whiteLabel));
    label.textContent = key.label;
    button.append(label);

    elements.set(key.note, button);
    (key.kind === 'black' ? blacks : whites).append(button);
  }
  bed.append(whites, blacks);

  /* ------------------------------------------------------------ the pointer --- */

  /** The button under the pointer right now, or null when it is off the keybed. */
  const keyUnderPointer = (event) => {
    const target = doc.elementFromPoint?.(event.clientX, event.clientY) ?? null;
    const note = target?.getAttribute?.('data-note');
    if (note === null || note === undefined) return null;
    return elements.get(Number(note)) ?? null;
  };

  for (const key of keys) {
    const button = elements.get(key.note);
    let pointerId = null;

    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointerId = event.pointerId;
      /* Capture on the KEY that was struck. This is the whole reason a drag that
       * runs off the key still delivers its pointerup here instead of stranding the
       * note in the air. */
      button.setPointerCapture(event.pointerId);
      core.pointerDown(event.pointerId, {
        note: key.note,
        velocity: velocityFromPoint(event.clientY, button.getBoundingClientRect()),
      });
      event.preventDefault();
    });

    button.addEventListener('pointermove', (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const under = keyUnderPointer(event);
      // `under === null` means the pointer has left the keybed: KEEP SOUNDING. A
      // glissando that runs off the end of the bed must not cut the note off.
      if (!under) return;
      core.pointerMove(event.pointerId, {
        note: Number(under.getAttribute('data-note')),
        velocity: velocityFromPoint(event.clientY, under.getBoundingClientRect()),
      });
    });

    /* Three ways a pointer gesture ends, and all three release. `lostpointercapture`
     * is the backstop for the browser taking the capture away from us. */
    const release = (event) => {
      if (pointerId === null) return;
      if (event.pointerId !== undefined && event.pointerId !== pointerId) return;
      pointerId = null;
      if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
      core.pointerUp(event.pointerId);
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);

    /* ROVING FOCUS. The whole bed is ONE tab stop, so Tab order still follows the
     * region order and a screen-reader user is not walked through 49 keys. The arrow
     * keys move within it — and every other key, Space included, is left to the page. */
    button.addEventListener('keydown', (event) => {
      const index = keys.indexOf(key);
      let next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = keys[index + 1] ?? null;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = keys[index - 1] ?? null;
      else if (event.key === 'Home') next = keys[0];
      else if (event.key === 'End') next = keys[keys.length - 1];
      else return;
      if (!next) return;
      event.preventDefault();
      roveTo(elements.get(next.note));
    });
  }

  /** One tab stop, moved: the old stop gives up its place and the new one takes it. */
  const roveTo = (next) => {
    if (!next) return;
    for (const button of elements.values()) button.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };

  /* ---------------------------------------------------------- sounding state --- */

  // aria-pressed follows the CORE, never the DOM, so it cannot disagree with the audio.
  core.onChange(({ type, note }) => {
    const button = elements.get(note);
    if (!button) return;
    if (type === 'note-on' || type === 'latched') button.setAttribute('aria-pressed', 'true');
    else if (type === 'note-off') button.setAttribute('aria-pressed', 'false');
  });

  /* ---------------------------------------------------------- powered off/on --- */

  /* Powered off is a state of the INSTRUMENT, and the keybed is where a player
   * looks first, so it says so here too: dimmed, with a line of text under it. The
   * dimming is presentation over the real buttons, which stay real buttons. */
  const paintPower = () => {
    const on = Boolean(store.get('global.power'));
    bed.setAttribute('data-powered', on ? 'on' : 'off');
    bed.setAttribute('style', on ? keyStyle.bed : keyStyle.bed + keyStyle.dimmed);
    offNote.textContent = on ? '' : 'Powered off — press POWER in the Global strip to start the audio.';
    offNote.hidden = on;
  };
  paintPower();
  store.subscribe('global.power', paintPower);

  /* ------------------------------------------------------------------ legend --- */

  const hint = classed(doc.createElement('p'), 'keybed__hint');
  hint.setAttribute('data-keybed-hint', '');
  hint.setAttribute('style', keyStyle.hint);

  const text = (content) => hint.append(doc.createTextNode(content));
  const code = (content) => {
    const span = classed(doc.createElement('span'), 'keybed__kbd');
    span.setAttribute('style', keyStyle.strong);
    span.textContent = content;
    hint.append(span);
    return span;
  };

  text('Computer keys — lower octave: ');
  code('A W S E D F T G Y H U J K');
  text('. Upper octave: ');
  code('Q 2 3 R 5 6 7 I');
  text(' — W, E, T, Y and U sit on both rows, and one key cannot sound two notes, so they play the lower octave. ');
  text('Octave: ');
  code('Z');
  text(' down, ');
  code('X');
  text(' up; the Octave knob in the Range panel does the same. ');
  const octaveReadout = classed(doc.createElement('span'), 'keybed__octave');
  octaveReadout.setAttribute('data-keybed-octave', '');
  octaveReadout.setAttribute('style', keyStyle.strong);
  const paintOctave = () => {
    const n = Number(store.get('global.octave')) || 0;
    octaveReadout.textContent = `Now ${n > 0 ? `+${n}` : n}.`;
  };
  paintOctave();
  store.subscribe('global.octave', paintOctave);
  hint.append(octaveReadout);
  text(' Space is deliberately not bound, so the page still scrolls.');

  wrapper.append(offNote, bed, hint);
  wrapper.bed = bed;
  wrapper.core = core;
  wrapper.keys = keys;
  wrapper.hint = hint;
  return wrapper;
}

/* ------------------------------------------------------- the shared registry --- */

/* There is exactly ONE live input core in the page. It is published here so a module
 * that needs the held notes — task 010's arpeggiator — can import a stable name from
 * the module that OWNS the registry, rather than keeping a second copy of it.
 *
 * The three shapes, so no caller has to guess which one the arp wants:
 *
 *   heldNotes()    [{ id, note, velocity, source, latched }]  keyed by note id
 *   heldPitches()  [60, 64, 67]                               in press order
 *   latchedPitchClasses()  the retained ones, for a "what is sustaining" readout
 */
let activeCore = null;

export function heldNotes() {
  return activeCore ? activeCore.heldNotes() : [];
}

export function heldPitches() {
  return heldNotes().map((row) => row.note).filter((n) => Number.isFinite(n));
}

export function latchedPitchClasses() {
  return activeCore ? activeCore.latchedNotes() : [];
}

/** The live core, for a caller that needs more than the read-only views above. */
export function inputCore() {
  return activeCore;
}

/* --------------------------------------------------------------- self-mounting --- */

/**
 * Build the keybed, wire the computer keys to the window, and release everything if
 * the page goes away. `deps.engine` defaults to the real engine, resolved HERE and
 * not at import time, which is what keeps this file importable in node.
 */
export async function mountKeybed(doc = typeof document === 'undefined' ? null : document, deps = {}) {
  if (!doc) return null;
  const mount = doc.querySelector('[data-keybed-mount]');
  if (!mount) {
    console.warn('[keyboard] no [data-keybed-mount] on the page; the on-screen keyboard is not available');
    return null;
  }
  const existing = mount.querySelector('[data-keybed-wrap]');
  if (existing) return existing;

  const store = deps.store ?? (await import('./params.js')).store;
  const engine = deps.engine ?? (await import('../audio/engine.js'));

  const wrap = buildKeybed(doc, { engine, store });
  mount.append(wrap);
  const core = wrap.core;
  activeCore = core;

  /* KEYBOARD LISTENERS LIVE ON THE WINDOW, so a note keeps sounding when focus moves
   * to another control and its keyup still arrives wherever focus now is. */
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    if (isTypingTarget(event.target)) return;
    core.keyDown(event.code, { repeat: event.repeat });
  };
  /* `keyup` deliberately does NOT filter by target: a release can only ever stop a
   * note, and filtering it would strand one when focus moved into a text field. */
  const onKeyUp = (event) => core.keyUp(event.code);

  /* A window that loses focus still has keys down, and a tab that is hidden still has
   * notes sounding. Both are release-everything. */
  const onBlur = () => core.releaseAll();
  const onVisibility = () => { if (doc.visibilityState === 'hidden') core.releaseAll(); };

  const win = doc.defaultView ?? globalThis;
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  wrap.release = () => core.releaseAll();
  wrap.detach = () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
  return wrap;
}

if (typeof document !== 'undefined') {
  const start = () => {
    mountKeybed(document).catch((error) => {
      console.warn(`[keyboard] the keybed could not be mounted: ${error.message}`);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else queueMicrotask(start);
}