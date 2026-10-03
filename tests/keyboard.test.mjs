/**
 * keyboard.test.mjs — the input module's logic, with no browser and no AudioContext.
 *
 * What is actually under test here is the four mapping/latching rules that are
 * otherwise only findable by ear:
 *
 *   1. where on a key the pointer landed  -> velocity
 *   2. which physical key was pressed     -> which pitch (the tracker layout)
 *   3. the OS key auto-repeat             -> suppressed, so one press is one note
 *   4. latch                              -> a note-off is retained, and drained
 *
 * Plus the input core's promise that a note can never be stranded: every path out
 * of "held" is exercised, because a stuck note is the failure a user cannot undo.
 *
 * The DOM build is checked against the same hand-written fake DOM as waveload.js
 * uses — no jsdom, no framework, no dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_LOW,
  KEY_HIGH,
  KEY_COUNT,
  SEMITONE_SPAN,
  WHITE_PCS,
  VELOCITY_TOP,
  VELOCITY_BOTTOM,
  COMPUTER_VELOCITY,
  OCTAVE_STEP_KEYS,
  LOWER_ROW,
  UPPER_ROW,
  COMPUTER_KEYS,
  buildKeys,
  noteName,
  velocityFromOffset,
  velocityFromPoint,
  noteForCode,
  octaveStepForCode,
  isRepeatTrigger,
  isTypingTarget,
  createLatch,
  createInputCore,
  buildKeybed,
  sharedHeldNotes,
} from '../web/ui/keyboard.js';
import { createStore, SCHEMA } from '../web/ui/params.js';

/* --------------------------------------------------------------- the keybed --- */

test('the keybed spans at least three octaves and at least 37 semitones', () => {
  assert.ok(SEMITONE_SPAN >= 37, `span ${SEMITONE_SPAN} is below the 37-semitone floor`);
  assert.ok(Math.floor(SEMITONE_SPAN / 12) >= 3, 'fewer than three octaves');
  assert.equal(KEY_COUNT, KEY_HIGH - KEY_LOW + 1);
  assert.equal(buildKeys(KEY_LOW, KEY_HIGH).length, KEY_COUNT);
  assert.ok(KEY_COUNT >= 37);
});

test('every key carries a visible label, and only the black notes are labelled sharp', () => {
  const keys = buildKeys(KEY_LOW, KEY_HIGH);
  for (const key of keys) {
    assert.equal(key.label, noteName(key.note));
    assert.ok(key.label.length > 0, `note ${key.note} has no label`);
    if (WHITE_PCS.includes(key.pc)) {
      assert.ok(!key.label.includes('#'), `${key.label} is a white key but is labelled sharp`);
    } else {
      assert.ok(key.label.includes('#'), `${key.label} is a black key but is not labelled sharp`);
    }
  }
});

test('the keybed starts and ends on a C, and lays blacks onto the white grid', () => {
  const keys = buildKeys(KEY_LOW, KEY_HIGH);
  assert.equal(noteName(keys[0].note), 'C2');
  assert.equal(noteName(keys[keys.length - 1].note), 'C6');
  // C2..B5 is four whole octaves of seven whites, plus the closing C6.
  assert.equal(keys.filter((k) => k.kind === 'white').length, 29);
  assert.equal(keys.filter((k) => k.kind === 'black').length, 20);
  // Each black key is centred on the boundary between the two whites it splits.
  for (const key of keys) {
    if (key.kind !== 'black') continue;
    assert.equal(key.column, key.whiteIndex, 'a black key is not on the white boundary it belongs to');
  }
});

/* ---------------------------------------------------------- click -> velocity --- */

test('velocity comes from where on the key the click landed: the top is louder', () => {
  const height = 112;
  const top = velocityFromOffset(0, height);
  const middle = velocityFromOffset(height / 2, height);
  const bottom = velocityFromOffset(height, height);
  assert.equal(top, VELOCITY_TOP);
  assert.equal(bottom, VELOCITY_BOTTOM);
  assert.ok(top > middle && middle > bottom, `${top} / ${middle} / ${bottom} is not descending`);
});

test('velocity stays inside 0..1 and copes with a degenerate key height', () => {
  for (const offset of [-40, -1, 0, 1, 55, 111, 112, 400, Number.NaN, undefined]) {
    const v = velocityFromOffset(offset, 112);
    assert.ok(v >= 0 && v <= 1, `velocity ${v} for offset ${offset} escaped 0..1`);
  }
  assert.equal(velocityFromOffset(20, 0), VELOCITY_TOP, 'a zero-height key must not divide by zero');
  assert.equal(velocityFromOffset(20, Number.NaN), VELOCITY_TOP);
});

test('the same key clicked near the top and near the bottom fires different velocities', () => {
  const rect = { top: 300, bottom: 412, height: 112 };
  const loud = velocityFromPoint(rect.top + 4, rect);
  const soft = velocityFromPoint(rect.bottom - 4, rect);
  assert.notEqual(loud, soft);
  assert.ok(loud > soft, `${loud} is not louder than ${soft}`);
});

/* ------------------------------------------------------------ key -> pitch --- */

test('the tracker layout: the home row is the lower octave', () => {
  const expected = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5,
    KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
  };
  for (const [code, semitone] of Object.entries(expected)) {
    assert.equal(noteForCode(code, { base: 48, octave: 0 }), 48 + semitone, `${code} is wrong`);
    assert.equal(LOWER_ROW[code], semitone);
  }
});

test('the tracker layout: the top row is the upper octave', () => {
  const expected = { KeyQ: 0, Digit2: 1, Digit3: 3, KeyR: 5, Digit5: 6, Digit6: 8, Digit7: 10, KeyI: 12 };
  for (const [code, semitone] of Object.entries(expected)) {
    assert.equal(noteForCode(code, { base: 48, octave: 0 }), 60 + semitone, `${code} is wrong`);
    assert.equal(UPPER_ROW[code], semitone);
  }
});

test('the upper arrangement is documented in full, and the five shared keys resolve to one note', () => {
  // The task names the upper arrangement as `Q 2 W 3 E R 5 T 6 Y 7 U`. W, E, T, Y and
  // U also sit on the home row, so a physical key cannot sound both: the home row
  // wins, and the legend says so.
  for (const code of ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU']) {
    assert.equal(typeof UPPER_ROW[code], 'number', `${code} is missing from the upper arrangement`);
  }
  const shared = Object.keys(UPPER_ROW).filter((code) => code in LOWER_ROW);
  assert.deepEqual(shared.sort(), ['KeyE', 'KeyT', 'KeyU', 'KeyW', 'KeyY']);
  for (const code of shared) {
    assert.equal(noteForCode(code, { base: 48, octave: 0 }), 48 + LOWER_ROW[code]);
  }
});

test('every mapped code resolves to exactly one note inside 0..127', () => {
  const codes = Object.keys(COMPUTER_KEYS);
  assert.ok(codes.length >= 20, `only ${codes.length} keys are mapped`);
  const distinct = new Set();
  for (const code of codes) {
    const note = noteForCode(code, { base: 48, octave: 0 });
    assert.ok(Number.isInteger(note) && note >= 0 && note <= 127, `${code} -> ${note}`);
    distinct.add(note);
  }
  assert.equal(codes.length, new Set(codes).size, 'a code is mapped twice');
  assert.equal(codes.length, Object.keys(UPPER_ROW).length + Object.keys(LOWER_ROW).length
    - Object.keys(UPPER_ROW).filter((c) => c in LOWER_ROW).length, 'the mapping table is not the union of the two rows');
  assert.ok(distinct.size >= 20, `only ${distinct.size} distinct notes are reachable`);
});

test('the octave shift moves the whole keyboard and clamps at the ends', () => {
  assert.equal(noteForCode('KeyA', { base: 48, octave: 1 }), 60);
  assert.equal(noteForCode('KeyA', { base: 48, octave: -2 }), 24);
  assert.equal(noteForCode('KeyQ', { base: 48, octave: -2 }), 36);
  assert.equal(noteForCode('KeyQ', { base: 48, octave: 2 }), 84);
  assert.equal(noteForCode('KeyQ', { base: 48, octave: 9 }), 127, 'must not run off the top of MIDI');
  assert.equal(noteForCode('KeyA', { base: 48, octave: -9 }), 0, 'must not run off the bottom of MIDI');
});

test('Space is not bound to anything, and the octave keys are not notes', () => {
  assert.equal(noteForCode('Space', { base: 48, octave: 0 }), null);
  assert.equal(octaveStepForCode('Space'), 0);
  assert.equal(noteForCode('Enter', { base: 48, octave: 0 }), null);
  assert.equal(noteForCode('ArrowUp', { base: 48, octave: 0 }), null);
  assert.ok(!('Space' in COMPUTER_KEYS), 'Space is mapped to a note');
  assert.deepEqual(OCTAVE_STEP_KEYS, { KeyZ: -1, KeyX: 1 });
  assert.equal(noteForCode('KeyZ', { base: 48, octave: 0 }), null, 'the octave key must not also be a note');
});

/* --------------------------------------------------------- repeat suppression --- */

test('the OS auto-repeat does not retrigger the note', () => {
  assert.equal(isRepeatTrigger({ code: 'KeyA', repeat: false, down: new Set() }), true);
  assert.equal(isRepeatTrigger({ code: 'KeyA', repeat: true, down: new Set() }), false, 'repeat flag ignored');
  assert.equal(isRepeatTrigger({ code: 'KeyA', repeat: false, down: new Set(['KeyA']) }), false, 'already down');
  assert.equal(isRepeatTrigger({ code: '', repeat: false, down: new Set() }), false);
});

test('typing into a field never plays a note', () => {
  const fake = (tag, type) => ({ tagName: tag, type: type ?? '', isContentEditable: false });
  assert.equal(isTypingTarget(fake('INPUT', 'text')), true);
  assert.equal(isTypingTarget(fake('INPUT', 'number')), true);
  assert.equal(isTypingTarget(fake('SELECT')), true);
  assert.equal(isTypingTarget(fake('TEXTAREA')), true);
  assert.equal(isTypingTarget(fake('DIV')), false);
  assert.equal(isTypingTarget(fake('INPUT', 'range')), false, 'a painted knob is not a text field');
  assert.equal(isTypingTarget(fake('BUTTON')), false);
  assert.equal(isTypingTarget(fake('INPUT', 'file')), false);
  assert.equal(isTypingTarget(null), false);
});

/* -------------------------------------------------------------- the latch --- */

test('an idle latch retains nothing', () => {
  const latch = createLatch();
  assert.equal(latch.engaged, false);
  assert.equal(latch.retain('a'), false);
  assert.deepEqual(latch.retained(), []);
});

test('an engaged latch retains the note-off and hands the ids back on release', () => {
  const latch = createLatch();
  latch.engage();
  assert.equal(latch.engaged, true);
  assert.equal(latch.retain('key:60'), true);
  assert.equal(latch.retain('key:64'), true);
  assert.equal(latch.retain('key:60'), true, 'retaining twice must not duplicate');
  assert.deepEqual(latch.retained().sort(), ['key:60', 'key:64']);
  assert.deepEqual(latch.disengage().sort(), ['key:60', 'key:64']);
  assert.deepEqual(latch.retained(), [], 'drained on release');
  assert.equal(latch.engaged, false);
});

test('retaining the same note twice keeps one id', () => {
  const latch = createLatch();
  latch.engage();
  latch.retain('x');
  latch.retain('x');
  assert.equal(latch.retained().length, 1);
});

/* ------------------------------------------------------- the input core --- */

function fakeEngine({ withHeld = false } = {}) {
  const calls = [];
  const sounding = new Map();
  const engine = {
    calls,
    sounding,
    noteOn(event) {
      calls.push(['on', event.id, event.note, event.velocity]);
      sounding.set(event.id, event);
      return { index: sounding.size - 1 };
    },
    noteOff(id) {
      calls.push(['off', id]);
      const was = sounding.get(id);
      sounding.delete(id);
      return was ?? null;
    },
    allNotesOff() {
      calls.push(['allOff']);
      sounding.clear();
    },
  };
  if (withHeld) {
    engine.registry = [];
    engine.heldNotes = () => engine.registry;
    engine.setHeldNotes = (list) => {
      engine.registry = list;
      return engine.registry;
    };
  }
  return engine;
}

const newCore = (options = {}) => {
  const engine = options.engine ?? fakeEngine();
  const store = options.store ?? createStore(SCHEMA);
  const announcements = [];
  const core = createInputCore({ engine, store, announce: (text) => announcements.push(text) });
  return { engine, store, core, announcements };
};

test('a computer key press starts one note and its release stops it', () => {
  const { engine, core } = newCore();
  assert.equal(core.keyDown('KeyA'), 48);
  assert.equal(engine.sounding.size, 1);
  assert.equal(core.keyUp('KeyA'), 48);
  assert.equal(engine.sounding.size, 0);
  assert.deepEqual(engine.calls, [['on', 'kbd:KeyA', 48, COMPUTER_VELOCITY], ['off', 'kbd:KeyA']]);
});

test('holding a key down does not retrigger it — the OS repeat is ignored', () => {
  const { engine, core } = newCore();
  core.keyDown('KeyA');
  for (let i = 0; i < 40; i += 1) {
    assert.equal(core.keyDown('KeyA', { repeat: true }), null, 'a repeat must start no note');
  }
  const ons = engine.calls.filter((call) => call[0] === 'on');
  assert.equal(ons.length, 1, `${ons.length} note-ons for one physical press`);
  assert.equal(engine.sounding.size, 1);
});

test('pressing many keys and releasing them all leaves nothing sounding', () => {
  const { engine, core } = newCore();
  for (const code of ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ']) core.keyDown(code);
  assert.equal(engine.sounding.size, 7);
  for (const code of ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ']) core.keyUp(code);
  assert.equal(engine.sounding.size, 0);
  assert.equal(core.heldNotes().length, 0);
});

test('a key release with no matching press is harmless', () => {
  const { engine, core } = newCore();
  assert.equal(core.keyUp('KeyQ'), null);
  assert.equal(engine.sounding.size, 0);
});

test('losing the window releases every note, so no note can be stranded', () => {
  const { engine, core } = newCore();
  core.keyDown('KeyA');
  core.keyDown('KeyD');
  core.pointerDown('p1', { note: 72, velocity: 0.9 });
  core.releaseAll();
  assert.equal(engine.sounding.size, 0);
  assert.equal(core.heldNotes().length, 0);
  // And a later keyup for an already-released key must not throw or re-fire.
  assert.equal(core.keyUp('KeyA'), null);
});

test('a held note survives focus moving elsewhere: keyUp is keyed by code, not by target', () => {
  const { engine, core } = newCore();
  core.keyDown('KeyA');
  assert.equal(engine.sounding.size, 1);
  // Nothing about "focus moved" reaches the core, which is the point: the release is
  // driven by the physical key's own keyup wherever focus now is.
  assert.equal(core.keyUp('KeyA'), 48);
  assert.equal(engine.sounding.size, 0);
});

/* ---------------------------------------------------------------- the latch --- */

test('with latch off a note-off releases immediately', () => {
  const { engine, core } = newCore();
  core.keyDown('KeyA');
  core.keyUp('KeyA');
  assert.equal(engine.sounding.size, 0);
  assert.equal(core.latchedIds().length, 0);
});

test('with latch on the note is retained, and stays sounding until latch is released', () => {
  const { engine, core } = newCore();
  core.setLatch(true);
  core.keyDown('KeyA');
  core.keyDown('KeyD');
  core.keyUp('KeyA');
  core.keyUp('KeyD');
  assert.equal(engine.sounding.size, 2, 'a latched note was released early');
  assert.equal(core.latchedIds().length, 2);
  core.setLatch(false);
  assert.equal(engine.sounding.size, 0, 'releasing the latch did not release the notes');
  assert.equal(core.latchedIds().length, 0);
});

test('latch drives the store key, and the store key drives the latch', () => {
  const { store, core, announcements } = newCore();
  core.setLatch(true);
  assert.equal(store.get('global.latch'), true);
  assert.ok(announcements.some((text) => /latch on/i.test(text)), 'the latch change was not announced');
  store.set('global.latch', false, { source: 'control' });
  // A write from the latch button on the page must release the retained notes too,
  // so the button and the store cannot disagree.
  assert.equal(core.latchEngaged(), false);
});

test('the latch button turning off releases notes retained by a store write', () => {
  const { engine, store, core } = newCore();
  store.set('global.latch', true, { source: 'control' });
  core.keyDown('KeyA');
  core.keyUp('KeyA');
  assert.equal(engine.sounding.size, 1);
  store.set('global.latch', false, { source: 'control' });
  assert.equal(engine.sounding.size, 0);
});

test('a latched note is released by the panic path even with latch still engaged', () => {
  const { engine, core } = newCore();
  core.setLatch(true);
  core.keyDown('KeyA');
  core.keyUp('KeyA');
  assert.equal(engine.sounding.size, 1);
  core.releaseAll();
  assert.equal(engine.sounding.size, 0);
});

/* -------------------------------------------------------------- pointer input --- */

test('the pointer starts the note at the velocity its height on the key implies', () => {
  const { engine, core } = newCore();
  const rect = { top: 0, bottom: 112, height: 112 };
  core.pointerDown('p1', { note: 60, velocity: velocityFromPoint(0, rect) });
  assert.equal(engine.calls[0][3], VELOCITY_TOP, 'a strike at the top edge is not the loud end');
  core.pointerUp('p1');
  core.pointerDown('p2', { note: 60, velocity: velocityFromPoint(112, rect) });
  assert.equal(engine.calls[2][3], VELOCITY_BOTTOM, 'a strike at the bottom edge is not the soft end');
  assert.notEqual(engine.calls[0][3], engine.calls[2][3]);
  core.pointerUp('p2');
});

test('a drag across the keybed retargets the note — glissando — and never strands one', () => {
  const { engine, core } = newCore();
  core.pointerDown('p1', { note: 60, velocity: 0.8 });
  core.pointerMove('p1', { note: 64, velocity: 0.8 });
  core.pointerMove('p1', { note: 67, velocity: 0.8 });
  const ons = engine.calls.filter((call) => call[0] === 'on').map((call) => call[2]);
  assert.deepEqual(ons, [60, 64, 67], 'each new key should have started its note');
  assert.equal(engine.sounding.size, 1, 'the old note was not released as the drag moved');
  core.pointerUp('p1');
  assert.equal(engine.sounding.size, 0);
});

test('a pointer that leaves the keybed and is cancelled still releases its note', () => {
  const { engine, core } = newCore();
  core.pointerDown('p1', { note: 60, velocity: 0.8 });
  core.pointerMove('p1', { note: null, velocity: 0 });   // off the bed entirely
  assert.equal(engine.sounding.size, 1, 'the note died when the pointer left the keybed');
  core.pointerCancel('p1');
  assert.equal(engine.sounding.size, 0);
});

test('two pointers play two notes at once and release independently', () => {
  const { engine, core } = newCore();
  core.pointerDown('p1', { note: 60, velocity: 0.8 });
  core.pointerDown('p2', { note: 64, velocity: 0.8 });
  assert.equal(engine.sounding.size, 2);
  core.pointerUp('p1');
  assert.equal(engine.sounding.size, 1);
  core.pointerUp('p2');
  assert.equal(engine.sounding.size, 0);
});

test('mono and legato release the note the previous key was holding', () => {
  for (const mode of ['mono', 'legato']) {
    const store = createStore(SCHEMA);
    store.set('global.keyboardMode', mode, { source: 'test' });
    const { engine, core } = newCore({ store });
    core.keyDown('KeyA');
    core.keyDown('KeyD');
    assert.equal(engine.sounding.size, 1, `${mode} played two notes at once`);
    core.keyUp('KeyD');
    assert.equal(engine.sounding.size, 0);
  }
  const store = createStore(SCHEMA);
  const { engine, core } = newCore({ store });
  core.keyDown('KeyA');
  core.keyDown('KeyD');
  assert.equal(engine.sounding.size, 2, 'poly must not release anything');
  core.releaseAll();
});

test('a latched note is not stolen away by mono mode releasing "the previous key"', () => {
  const store = createStore(SCHEMA);
  store.set('global.keyboardMode', 'mono', { source: 'test' });
  const { engine, core } = newCore({ store });
  core.setLatch(true);
  core.keyDown('KeyA');
  core.keyUp('KeyA');                       // retained by latch
  core.keyDown('KeyD');
  assert.equal(engine.sounding.size, 2, 'mono released a latched note');
  core.setLatch(false);
  assert.equal(engine.sounding.size, 0);
});

/* ------------------------------------------------- the shared held-note registry --- */

test('held notes are published as note ids, not as a parallel pitch list', () => {
  const { core } = newCore();
  core.keyDown('KeyA');
  core.keyDown('KeyD');
  const held = core.heldNotes();
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((row) => row.note).sort((a, b) => a - b), [48, 52]);
  for (const row of held) {
    assert.equal(typeof row.id, 'string');
    assert.ok(row.id.length > 0);
  }
});

test('the input\'s notes and the engine\'s other notes share ONE registry', () => {
  const engine = fakeEngine({ withHeld: true });
  const { core } = newCore({ engine });
  // A note from somewhere else — the melodic lane, say — is already in the registry.
  engine.setHeldNotes([{ id: 'seq:1', note: 72, velocity: 0.5 }]);
  core.keyDown('KeyA');
  const held = core.heldNotes();
  assert.equal(held.length, 2, `only ${held.length} notes in the shared registry`);
  assert.deepEqual(held.map((row) => row.id).sort(), ['kbd:KeyA', 'seq:1']);
  // Releasing this input's note must remove exactly that row and nothing else.
  core.keyUp('KeyA');
  assert.deepEqual(core.heldNotes().map((row) => row.id), ['seq:1']);
});

test('the input\'s own row wins over a stale published copy of the same id', () => {
  const engine = fakeEngine({ withHeld: true });
  const { core } = newCore({ engine });
  core.keyDown('KeyA');
  // The registry drifts behind us: it still claims a note we have already released.
  engine.setHeldNotes([{ id: 'kbd:KeyA', note: 48, velocity: 0.8 }]);
  core.keyUp('KeyA');
  assert.deepEqual(core.heldNotes(), [], 'a stale registry row kept a released note alive');
});

test('a row of ANOTHER source is never filtered by this input\'s retire list', () => {
  const engine = fakeEngine({ withHeld: true });
  const { core } = newCore({ engine });
  core.keyDown('KeyA');
  core.keyUp('KeyA');
  // A note from somewhere else that happens to share an id shape must survive: the
  // retire list only ever names ids this input minted.
  engine.setHeldNotes([{ id: 'seq-3', note: 72, velocity: 0.5 }, { id: 'kbd:KeyA', note: 48, velocity: 0.8 }]);
  assert.deepEqual(core.heldNotes().map((r) => r.id), ['seq-3']);
});

test('without an engine registry the input publishes its own list into one', () => {
  const engine = fakeEngine();
  let published = null;
  engine.heldNotes = () => published ?? [];
  engine.setHeldNotes = (list) => {
    published = list;
    return list;
  };
  const { core } = newCore({ engine });
  core.keyDown('KeyA');
  assert.equal(sharedHeldNotes(engine).length, 1, 'the note was not published into the shared registry');
  assert.equal(sharedHeldNotes(engine)[0].note, 48);
  core.keyUp('KeyA');
  assert.equal(sharedHeldNotes(engine).length, 0);
});

/* ---------------------------------------------------- the octave shift key --- */

test('Z and X shift the octave through the store key, not through private state', () => {
  const { store, core } = newCore();
  assert.equal(store.get('global.octave'), 0);
  assert.equal(core.octaveStep('KeyX'), 1);
  assert.equal(core.octaveStep('KeyZ'), -1);
  assert.equal(core.octaveStep('KeyA'), 0);
  // Six discrete presses of a key that only moves two octaves: the shift clamps at
  // the schema range rather than running off the end of MIDI.
  for (let i = 0; i < 6; i += 1) { core.keyDown('KeyX'); core.keyUp('KeyX'); }
  assert.equal(store.get('global.octave'), 2, 'the shift must clamp at the schema range');
  for (let i = 0; i < 6; i += 1) { core.keyDown('KeyZ'); core.keyUp('KeyZ'); }
  assert.equal(store.get('global.octave'), -2);
  // A held shift key does not machine-gun through the range: one press, one octave.
  core.keyDown('KeyX');
  core.keyDown('KeyX', { repeat: true });
  core.keyDown('KeyX', { repeat: true });
  assert.equal(store.get('global.octave'), -1);
  core.keyUp('KeyX');
});

/* --------------------------------------------------------------- the DOM build --- */

function fakeDoc() {
  return new FakeDocument();
}

class FakeNode {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; }, cssText: '' };
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.classList = {
      set: new Set(),
      add: (...names) => names.forEach((n) => this.classList.set.add(n)),
      remove: (...names) => names.forEach((n) => this.classList.set.delete(n)),
      contains: (name) => this.classList.set.has(name),
      toggle: (name, on) => (on ? this.classList.set.add(name) : this.classList.set.delete(name)),
    };
    this.className = '';
    this.id = '';
    this._tabIndex = null;
    this.rect = { top: 0, bottom: 100, height: 100, left: 0, right: 40, width: 40 };
    this.captured = new Set();
    this.focused = false;
  }

  set className(value) { this._className = value; }
  get className() { return this._className ?? ''; }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text !== undefined && this._text !== '' ? this._text : this.children.map((c) => c.textContent).join('');
  }

  get tabIndex() { return this._tabIndex; }
  set tabIndex(value) {
    this._tabIndex = Number(value);
    if (this._tabIndex === 0) this.setAttribute('tabindex', '0');
    else if (this._tabIndex === -1) this.setAttribute('tabindex', '-1');
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  }
  after(node) {
    const siblings = this.parent?.children;
    if (!siblings) return;
    node.parent = this.parent;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...event });
  }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  focus() { this.focused = true; }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  matches(selector) {
    if (selector === '.key') return this.classList.contains('key');
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches?.(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.activeElement = null;
  }
  createElement(tag) {
    return new FakeNode(tag, this);
  }
  createTextNode(text) {
    const node = new FakeNode('#text', this);
    node.textContent = text;
    return node;
  }
}

function buildFakeBed(doc, { engine } = {}) {
  const mount = doc.createElement('div');
  mount.setAttribute('data-keybed-mount', '');
  doc.append(mount);
  const bed = buildKeybed(doc, { engine: engine ?? fakeEngine(), store: createStore(SCHEMA) });
  mount.append(bed);
  return { mount, bed };
}

test('the keybed is built from real <button> elements, never a painted <div>', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  const keys = bed.querySelectorAll('.key');
  assert.equal(keys.length, KEY_COUNT);
  for (const key of keys) {
    assert.equal(key.tagName, 'BUTTON');
    assert.equal(key.getAttribute('type'), 'button');
  }
});

test('every key has an accessible name, a pressed state and a visible label', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  for (const key of bed.querySelectorAll('.key')) {
    const name = key.getAttribute('aria-label');
    assert.ok(name && name.length > 3, `key ${key.getAttribute('data-note')} has no accessible name`);
    assert.ok(name.includes(noteName(Number(key.getAttribute('data-note')))), 'the name does not name the note');
    assert.equal(key.getAttribute('aria-pressed'), 'false');
    const label = key.querySelector('.key__label');
    assert.ok(label, 'no label element');
    assert.equal(label.textContent, noteName(Number(key.getAttribute('data-note'))));
  }
});

test('the keybed is one tab stop with a roving tabindex, so Tab order is not 49 stops', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  const keys = bed.querySelectorAll('.key');
  const stops = keys.filter((key) => key.tabIndex === 0);
  assert.equal(stops.length, 1, `${stops.length} keys are in the tab order`);
  assert.equal(keys.filter((key) => key.tabIndex === -1).length, KEY_COUNT - 1);
});

test('the keybed names itself for a screen reader', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  assert.equal(bed.bed.getAttribute('role'), 'group');
  const name = bed.bed.getAttribute('aria-label');
  assert.ok(name.includes('C2') && name.includes('C6'));
  assert.ok(name.includes(String(KEY_COUNT)));
});

test('pointerdown on a key starts the note at the height-derived velocity and captures the pointer', () => {
  const doc = fakeDoc();
  const engine = fakeEngine();
  const { bed } = buildFakeBed(doc, { engine });
  const key = bed.querySelectorAll('.key').find((k) => k.getAttribute('data-note') === '60');
  key.rect = { top: 200, bottom: 312, height: 112, left: 0, right: 40, width: 40 };
  key.dispatch('pointerdown', { pointerId: 7, pointerType: 'mouse', button: 0, clientY: 203 });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0][2], 60);
  assert.ok(key.hasPointerCapture(7), 'the pointer was not captured, so a drag off the key would strand the note');
  assert.equal(key.getAttribute('aria-pressed'), 'true');
  key.dispatch('pointerup', { pointerId: 7 });
  assert.equal(key.getAttribute('aria-pressed'), 'false');
  assert.equal(engine.sounding.size, 0);
});

test('a secondary mouse button does not play', () => {
  const doc = fakeDoc();
  const engine = fakeEngine();
  const { bed } = buildFakeBed(doc, { engine });
  const key = bed.querySelectorAll('.key')[0];
  key.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientY: 250 });
  assert.equal(engine.calls.length, 0);
});

test('arrow keys inside the keybed move the roving focus one SEMITONE at a time', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  const byNote = new Map(bed.querySelectorAll('.key').map((k) => [Number(k.getAttribute('data-note')), k]));
  const start = byNote.get(36); // C2
  start.focus();
  start.dispatch('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
  const next = byNote.get(37); // C#2 — a black key, so this is not DOM order
  assert.equal(next.tabIndex, 0, 'focus did not move to the next semitone');
  assert.equal(start.tabIndex, -1, 'the old stop did not give its place up');
  assert.ok(next.focused, 'focus was not actually moved');
  next.dispatch('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.equal(start.tabIndex, 0, 'ArrowLeft did not come back');
  assert.ok(start.focused);
});

test('a key the keybed does not own is left alone', () => {
  const doc = fakeDoc();
  const { bed } = buildFakeBed(doc);
  const key = bed.querySelectorAll('.key')[0];
  let prevented = false;
  key.dispatch('keydown', { key: 'a', code: 'KeyA', preventDefault() { prevented = true; } });
  key.dispatch('keydown', { key: ' ', code: 'Space', preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'the keybed consumed a key that is not its own');
});

test('a key marked pressed while it sounds is what the core reports', () => {
  const doc = fakeDoc();
  const engine = fakeEngine();
  const { bed } = buildFakeBed(doc, { engine });
  const key = bed.querySelectorAll('.key').find((k) => k.getAttribute('data-note') === '64');
  key.dispatch('pointerdown', { pointerId: 3, pointerType: 'touch', button: 0, clientY: 260 });
  assert.equal(key.getAttribute('aria-pressed'), 'true');
  key.dispatch('pointercancel', { pointerId: 3 });
  assert.equal(key.getAttribute('aria-pressed'), 'false');
});