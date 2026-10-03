/**
 * sequencer.js — THE 16-STEP SEQUENCER, THE FOUR PATTERNS, THE CHAIN AND THE
 * ARPEGGIATOR'S BINDING TO THE CLOCK. A subscriber, never a timer.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM THE AUDIO GRAPH
 *   Same reason as `clock.js` and `drum-kit.js`, and for the same reason it matters here
 *   more: the sequencer is the module with the most ways to be subtly wrong (a swing
 *   applied at the wrong moment, a chain that drifts, a gate that does not scale with the
 *   rate) and every one of those is a scheduling fact rather than an audible one. So the
 *   clock, the kit and the note path all arrive as arguments, and
 *   tests/sequencer.test.mjs drives the whole stack on the existing fake-AudioContext
 *   harnesses with the real `createClock` and the real `createDrumKit` — reading the
 *   SCHEDULED AUTOMATION rather than guessing from a level reading. `sequencer-run.js` is
 *   what binds this to the instrument.
 *
 * THE SINGLE CLOCK, AND WHAT THAT FORBIDS
 *   The plan names this its highest-risk-to-violate constraint. Nothing here arms an
 *   interval, a timeout or a requestAnimationFrame: this module subscribes to task 9's
 *   `clock.subscribeToSteps` and is handed one frozen event per step. `global.run` is the
 *   transport, owned by `drums.js`, so the sequencer has no lifecycle to get wrong — when
 *   the clock stops, this stops, because there is nothing left to be called.
 *   `timerCount()` exists so that claim is assertable rather than merely stated.
 *
 *   THE STEP-CURSOR CONTRACT (task 9, and this module depends on all of it):
 *     step          0..15, 0 = downbeat, wraps every bar  -> indexes a lane
 *     absoluteStep  never wraps                          -> counts bars
 *     swungTime     when the step is actually PLACED     -> the only time used to sound
 *     time          the grid position                     -> NEVER used to place a sound
 *     swung         the difference
 *
 * SWING IS APPLIED AT SCHEDULE TIME, AND THAT IS THE WHOLE ARGUMENT
 *   The scheduler runs 100 ms ahead, so a step's audio time is decided up to 100 ms before
 *   it is heard. Therefore the swing value a step is swung BY is the one that was current
 *   when the step was SCHEDULED, and a swing change moves steps from the next scheduled
 *   step onward — never retroactively, because an already-scheduled time is a number
 *   written into the audio thread's timeline and there is no API to move it. That is not a
 *   compromise; it is the only behaviour a lookahead scheduler can have, and it is why the
 *   clock publishes both `time` and `swungTime` on the same event.
 *
 * GATE LENGTH IS A FRACTION OF THE STEP, RELEASED BY THE CLOCK
 *   The melodic lane's note starts at `swungTime` and its release is scheduled for
 *   `swungTime + (gate / 100) * stepPeriod` — a number computed on the scheduling path and
 *   handed to the note path, never a timer. The arpeggiator's gate is a fraction of ITS
 *   interval rather than of the step, which is what lets one gate value work at every rate.
 *
 * FOUR PATTERNS, ONE SET OF STORE KEYS
 *   The schema's per-step keys are flat — `seq.bd.on.5`, not `seq.A.bd.on.5` — because
 *   that is the naming the plan and the painted controls both assume, and because a
 *   painted control must bind exactly one key. So the flat keys are the EDITING VIEW of
 *   whichever pattern is selected, and the bank below holds the four patterns' data. Every
 *   write to a `seq.<lane>.<field>.<n>` key is captured live into the selected pattern, and
 *   selecting a pattern loads that pattern's data into the keys. Editing therefore needs no
 *   explicit save, and a pattern switch needs no explicit load — there is no moment where
 *   the two can disagree.
 *
 *   All four start from the schema's own defaults, so switching to an untouched pattern
 *   gives the init patch rather than silence.
 *
 * THE CHAIN IS NOT A SECOND PLAYBACK PATH
 *   Chain mode advances `seq.pattern` once per bar. That is the entire mechanism: the same
 *   code that fires a step reads whichever pattern `seq.pattern` names, so chain mode and
 *   manual selection cannot drift apart, and a chain of `A-B-A-D` is four ordinary bar
 *   boundaries.
 *
 * THE MELODIC LANE AND THE ARPEGGIATOR SHARE ONE NOTE PATH
 *   Both call the injected `noteOn`/`noteOff` — task 3's path, the same one task 11's
 *   keyboard uses — so they share the allocator and the envelope behaviour. Both pass
 *   `held: false`, which is what keeps the melodic lane's own notes out of the held-note
 *   registry that feeds the arpeggiator; otherwise the arpeggiator would arpeggiate its own
 *   output and a keyboard chord would be polluted by the sequence.
 *
 * ARPEGGIATOR OWNERSHIP OF THE LANE
 *   `arp.followLane` false: the melodic lane plays its steps as written and the
 *   arpeggiator, if on, works from the HELD keyboard notes.
 *   `arp.followLane` true: the lane's steps are not sounded individually — their notes are
 *   gathered once per bar into the chord the arpeggiator walks, and each carries its own
 *   step's accent. That is the "process the lane / bypass the lane" switch, and it is a
 *   switch about WHO OWNS THE LANE, not a second code path: both branches call the same
 *   `noteOn`.
 *
 * THE ARPEGGIATOR'S SLOTS ARE DERIVED FROM THE EVENT, NOT COUNTED
 *   `arpSlotsForStep` returns the arpeggiator slots whose beat position falls inside this
 *   step, in beats, so a triplet rate places notes at 1/3-beat positions inside sixteenths
 *   without an accumulator and therefore without drift. The placement time is
 *   `swungTime + (slotBeats - stepBeats) * beatPeriod`: an offset inside the step measured
 *   from its SWUNG time, which is why the arpeggiator rides the swung grid rather than
 *   replacing it.
 *
 * RANDOM MODE IS DOCUMENTED, NOT ACCIDENTAL
 *   The RNG is an injected argument, `Math.random` by default, so a playing instrument's
 *   Random mode is genuinely different every cycle. For verification, `setArpRandomSeed(n)`
 *   swaps in a seeded `mulberry32` and `arpRandomSeed()` reads back what is active, so a
 *   run can assert an exact sequence. Every firing is recorded in the log either way.
 *
 * THE PUBLIC API
 *   createSequencer({ store, clock, triggerVoice, noteOn, noteOff, allNotesOff,
 *                     heldNotes, random })
 *     .bank                 the four patterns' data
 *     .start() / .stop()    subscribe / unsubscribe to the clock. NOT a transport.
 *     .onStep(fn)           a tap on every step event, for verification
 *     .log()                the last steps, drums and notes, bounded
 *     .state()              the firing step, pattern, chain position, last arp notes
 *     .selectPattern(name)  / .chainAppend(name) / .chainReset(order) / .chainOrder()
 *     .setArpRandomSeed(n) / .arpRandomSeed()
 *     .timerCount()         always 0. Assertable, not a promise.
 */

import { KIT_VOICES, PATTERNS, SCHEMA, SEQUENCER_LANES, STEPS, store as defaultStore } from '../ui/params.js';
import { arpIntervalBeats, arpSlotBeats, arpSlotsForStep, arpVoices, createArpCursor, createArpRandom, mulberry32 } from './arp.js';

/** Sixteen steps, read from the schema's own constant so the two cannot disagree. */
export const STEP_COUNT = STEPS;

/** Twelve lanes: the eleven kit voices plus the melodic synth lane. */
export const LANE_COUNT = SEQUENCER_LANES.length;

/** The melodic lane's name. Every drum lane is the name of a kit voice. */
export const MELODY_LANE = 'melody';

/**
 * How long the chain order may grow. A chain is edited by clicking slots in sequence, so
 * an unbounded array would grow for as long as the page was left open; a click past the
 * ceiling replaces the tail instead of appending.
 */
export const CHAIN_MAX = 32;

/** How many entries each of the log's three buckets keeps. Bounded, like the dab ring. */
export const LOG_LIMIT = 96;

/** The shortest gate that can be scheduled, in seconds. A 10% gate at 1/32 and 220 BPM is
 *  3 ms, which is already shorter than most voices' attack; this is only a floor against a
 *  zero-length note. */
export const MIN_GATE_SECONDS = 0.002;

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
const clamp = (n, low, high) => (n < low ? low : n > high ? high : n);

const stepKey = (lane, field, step) => `seq.${lane}.${field}.${step}`;

/** `seq.<lane>.<field>.<n>` — the store keys the bank owns. `seq.step`, `seq.pattern`,
 *  `seq.chain` and `seq.chainOrder` deliberately do NOT match. */
const CELL_KEY = /^seq\.([A-Za-z][A-Za-z0-9]*)\.(on|vel|note|gate)\.(\d{1,2})$/;

const FIELD_DEFAULT = (lane, field, step) => SCHEMA[stepKey(lane, field, step)]?.def;

/* ------------------------------------------------------------------ the bank --- */

/** One pattern, indexed 0..15 like the clock's `step` (the store keys are 1-based). */
function emptyPattern() {
  const lanes = {};
  for (const lane of SEQUENCER_LANES) {
    const on = [];
    const vel = [];
    for (let step = 0; step < STEP_COUNT; step += 1) {
      on.push(Boolean(FIELD_DEFAULT(lane, 'on', step + 1)));
      vel.push(finite(FIELD_DEFAULT(lane, 'vel', step + 1), 60));
    }
    const cell = { on, vel };
    if (lane === MELODY_LANE) {
      cell.note = [];
      cell.gate = [];
      for (let step = 0; step < STEP_COUNT; step += 1) {
        cell.note.push(Math.round(finite(FIELD_DEFAULT(lane, 'note', step + 1), 60)));
        cell.gate.push(finite(FIELD_DEFAULT(lane, 'gate', step + 1), 50));
      }
    }
    lanes[lane] = cell;
  }
  return { lanes };
}

/**
 * The four patterns, and the flat store keys that edit whichever one is selected.
 *
 * `load(index)` writes a pattern into the keys; `write` captures every key change into the
 * selected pattern. `loading` suppresses capture during a load, so a load cannot feed the
 * pattern it is reading from.
 */
export function createPatternBank({ store = defaultStore, patterns = PATTERNS } = {}) {
  const slots = patterns.map(() => emptyPattern());
  let loading = false;
  let selected = Math.max(0, patterns.indexOf(store.get('seq.pattern')));

  function writeCell(lane, field, step, value) {
    if (!slots[selected].lanes[lane] || !(field in slots[selected].lanes[lane])) return false;
    if (step < 0 || step >= STEP_COUNT) return false;
    slots[selected].lanes[lane][field][step] = value;
    return true;
  }

  /* The init patch IS pattern A's data: whatever the store holds when the bank is built
     belongs to the pattern that is already selected. */
  function captureFromStore(index) {
    const target = slots[index];
    for (const lane of SEQUENCER_LANES) {
      for (let step = 0; step < STEP_COUNT; step += 1) {
        const cell = target.lanes[lane];
        for (const field of ['on', 'vel', 'note', 'gate']) {
          if (!(field in cell)) continue;
          const value = store.get(stepKey(lane, field, step + 1));
          if (value !== undefined) cell[field][step] = value;
        }
      }
    }
  }

  function load(index) {
    loading = true;
    try {
      const cell = slots[index].lanes;
      for (const lane of SEQUENCER_LANES) {
        for (let step = 0; step < STEP_COUNT; step += 1) {
          for (const field of ['on', 'vel', 'note', 'gate']) {
            if (!(field in cell[lane])) continue;
            store.set(stepKey(lane, field, step + 1), cell[lane][field][step], { source: 'sequencer', apply: 'direct' });
          }
        }
      }
    } finally {
      loading = false;
    }
  }

  captureFromStore(selected);
  load(selected);

  const offStore = store.subscribeAll((key, value) => {
    if (loading) return;
    const match = CELL_KEY.exec(key);
    if (!match) return;
    writeCell(match[1], match[2], Number(match[3]) - 1, value);
  });

  const offPattern = store.subscribe('seq.pattern', (_key, value) => {
    const next = patterns.indexOf(value);
    if (next < 0 || next === selected) return;
    selected = next;
    load(selected);
  });

  return {
    patterns: () => patterns,
    patternCount: () => slots.length,
    /** The selected pattern's index into PATTERNS. */
    index: () => selected,
    selected: () => patterns[selected],

    /**
     * One step of one lane of one pattern. `step` is 0-based like the clock's, so the
     * caller never has to convert.
     */
    cell(patternIndex, lane, step) {
      const pattern = slots[Math.max(0, Math.min(slots.length - 1, patternIndex))];
      return pattern?.lanes[lane] ?? null;
    },

    /** The melodic lane's sounding notes for one bar: what the arpeggiator walks. */
    laneNotes(patternIndex) {
      const cell = slots[Math.max(0, Math.min(slots.length - 1, patternIndex))]?.lanes[MELODY_LANE];
      if (!cell) return [];
      const out = [];
      for (let step = 0; step < STEP_COUNT; step += 1) {
        if (!cell.on[step]) continue;
        out.push({ note: cell.note[step], velocity: clamp(finite(cell.vel[step], 60) / 100, 0, 1), step });
      }
      return out;
    },

    /** Select a pattern and load it into the store keys. */
    select(nameOrIndex) {
      const index = typeof nameOrIndex === 'number' ? nameOrIndex : patterns.indexOf(nameOrIndex);
      if (index < 0 || index >= slots.length) return false;
      selected = index;
      store.set('seq.pattern', patterns[index], { source: 'sequencer', apply: 'direct' });
      /* The subscription above loads on the change; call it directly too so `select` is
         correct when the store already held this pattern. */
      if (store.get('seq.pattern') === patterns[index]) load(index);
      return true;
    },

    /** A deep copy of all four patterns — the shape a preset slot stores. */
    snapshot: () => slots.map((pattern) => structuredClone(pattern)),

    dispose() {
      offStore();
      offPattern();
    },
  };
}

/* ------------------------------------------------------------------- the chain --- */

/** Only real pattern names go in an order. */
const validPatterns = (order) =>
  (Array.isArray(order) ? order : []).filter((name) => PATTERNS.includes(name)).slice(0, CHAIN_MAX);

export function createChain({ store = defaultStore, patterns = PATTERNS } = {}) {
  const order = () => validPatterns(store.get('seq.chainOrder'));
  /* -1 means "nothing has played yet": the first bar boundary advances it onto the FIRST
     entry rather than the second, so a chain of A-B-A-D starts on A. */
  let cursor = -1;

  /** Start the chain at its first entry. Called whenever the transport starts. */
  const rewind = () => {
    cursor = -1;
  };

  /** The cursor as an index into the order, never negative. */
  const position = () => {
    const length = order().length;
    if (length === 0) return 0;
    return ((cursor % length) + length) % length;
  };

  return {
    enabled: () => Boolean(store.get('seq.chain')),
    order,
    cursor: position,
    rewind,

    /** Advance one bar and return the pattern to play, or null when chain mode is off. */
    advance() {
      const list = order();
      if (!store.get('seq.chain') || list.length === 0) {
        cursor = -1;
        return null;
      }
      cursor = (cursor + 1) % list.length;
      return list[cursor];
    },

    /** The pattern the chain is ABOUT to play, without advancing. */
    peek() {
      const list = order();
      return list.length === 0 ? null : list[position()];
    },

    reset(next = []) {
      cursor = -1;
      store.set('seq.chainOrder', validPatterns(next), { source: 'sequencer', apply: 'direct' });
      return order();
    },

    /**
     * Append a pattern to the chain — the click-a-slot gesture.
     *
     *   - a pattern already in the order truncates it to just before that entry, which is
     *     how a chain is shortened without a separate erase control;
     *   - the pattern that is already LAST clears the order, so one click empties it;
     *   - anything else is appended;
     *   - at the ceiling the tail is replaced rather than appended, so the order is bounded.
     *
     * A name that is not one of the four is refused, not stored.
     */
    append(pattern) {
      if (!patterns.includes(pattern)) return order();
      const list = order();
      const at = list.indexOf(pattern);
      let next;
      if (at >= 0) next = at === list.length - 1 ? [] : list.slice(0, at);
      else if (list.length < CHAIN_MAX) next = [...list, pattern];
      else next = [...list.slice(0, CHAIN_MAX - 1), pattern];
      cursor = -1;
      store.set('seq.chainOrder', next, { source: 'sequencer', apply: 'direct' });
      return next;
    },
  };
}

/* --------------------------------------------------------------- the sequencer --- */

/** A bounded FIFO, like the dab ring: a verification log that cannot grow for ever. */
function bucket(limit = LOG_LIMIT) {
  const entries = [];
  return {
    entries,
    push(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      return entry;
    },
    read: () => [...entries],
  };
}

/**
 * The sequencer. Everything musical arrives as an argument, so this is testable with no
 * browser and no audio device.
 *
 * @param {object}   options
 * @param {object}   options.store        the parameter store: { get, set, subscribe, subscribeAll }
 * @param {object}   options.clock        task 9's clock: `subscribeToSteps(fn)` at least
 * @param {Function} options.triggerVoice (voice, { at, velocity }) — the kit's note path
 * @param {Function} options.noteOn        ({ id, note, velocity, random, at }) — task 3's
 * @param {Function} options.noteOff       (id, { at })
 * @param {Function} [options.allNotesOff] ({ at })
 * @param {Function} [options.heldNotes]   () => held notes: numbers, or { note, velocity }
 * @param {Function} [options.random]      the per-note random source, and the arpeggiator's
 */
export function createSequencer({
  store = defaultStore,
  clock,
  triggerVoice,
  noteOn,
  noteOff,
  allNotesOff = () => {},
  heldNotes = () => [],
  random = Math.random,
} = {}) {
  if (!clock || typeof clock.subscribeToSteps !== 'function') {
    throw new Error('sequencer: createSequencer needs the lookahead clock');
  }
  if (typeof triggerVoice !== 'function') throw new Error('sequencer: createSequencer needs triggerVoice');
  if (typeof noteOn !== 'function') throw new Error('sequencer: createSequencer needs noteOn');

  const bank = createPatternBank({ store });
  const chain = createChain({ store });

  const stepLog = bucket();
  const drumLog = bucket();
  const noteLog = bucket();
  const taps = new Set();

  let unsubscribe = null;
  let lastStep = 0;
  let lastAbsolute = 0;
  let lastPattern = bank.selected();
  let laneCache = { pattern: null, notes: [] };
  let arpCursor = createArpCursor('up', { random });
  let arpState = { mode: 'up', seed: null };
  let arpRandom = random;
  const arpFirings = [];

  /* ------------------------------------------------------------- the note path --- */

  /** One melodic note, released by the clock at its gate. `id` is unique per firing. */
  function playNote(note, { at, id, velocity, gateSeconds, source, arp = false }) {
    const release = Math.max(MIN_GATE_SECONDS, gateSeconds);
    noteOn({
      id,
      note,
      velocity: clamp(finite(velocity, 0.8), 0, 1),
      random: random(),
      at,
      /* A sequenced note is NEVER a held note: it must not appear in the registry the
         arpeggiator reads, or the arpeggiator would arpeggiate its own output. */
      held: false,
      source,
      arp,
    });
    noteOff(id, { at: at + release });
    const entry = noteLog.push({ id, note, velocity, at, release, off: at + release, source, arp, gateSeconds: release });
    if (arp) {
      arpFirings.push(entry);
      if (arpFirings.length > LOG_LIMIT) arpFirings.shift();
    }
    return entry;
  }

  /* -------------------------------------------------------------- the arpeggiator --- */

  /** The notes the arpeggiator walks: the lane's, or the held keys'. */
  function arpSource() {
    if (store.get('arp.followLane')) {
      const pattern = bank.index();
      if (laneCache.pattern !== pattern) laneCache = { pattern, notes: bank.laneNotes(pattern) };
      return laneCache.notes;
    }
    const held = heldNotes();
    if (!Array.isArray(held)) return [];
    /* Both spellings are accepted: a bare MIDI number, or a held-note record. A keyboard
       that publishes records and a probe that publishes numbers must not disagree. */
    return held
      .map((entry) => (typeof entry === 'number' ? { note: entry, velocity: 0.8 } : entry))
      .filter((entry) => Number.isFinite(Number(entry?.note)))
      .map((entry) => ({ note: Number(entry.note), velocity: clamp(finite(entry.velocity, 0.8), 0, 1) }));
  }

  /**
   * The arpeggiator's notes inside one grid step.
   *
   * The slot's beat position minus the step's own beat position, times the beat period, is
   * an offset INSIDE the step — measured from `swungTime`, never from `time`. So an eighth
   * at 75% swing is still swung, and a triplet is swung by the same sixteenth-level offset
   * as everything else on the bar.
   */
  function runArp(event) {
    if (!store.get('arp.on')) return [];
    const mode = store.get('arp.mode');
    const rate = store.get('arp.rate');
    const octaves = store.get('arp.octaves');
    const gatePercent = store.get('arp.gate');
    const source = arpSource();
    if (source.length === 0) return [];

    /* The cursor's cycle is rebuilt when the mode changes or the chord's size changes, so
       a mode switch takes effect on the next note rather than needing a restart. */
    if (arpState.mode !== mode) {
      arpState = { ...arpState, mode };
      arpCursor = createArpCursor(mode, { random: arpRandom });
    }

    const voices = arpVoices(source, {
      octaves,
      preserveOrder: mode === 'asplay',
      velocity: (note) => source.find((entry) => Number(entry.note) === note)?.velocity ?? 0.8,
    });
    if (voices.length === 0) return [];

    const intervalBeats = arpIntervalBeats(rate);
    const slots = arpSlotsForStep({
      absoluteStep: event.absoluteStep,
      stepsPerBeat: event.stepsPerBeat,
      intervalBeats,
    });
    if (slots.length === 0) return [];

    const intervalSeconds = intervalBeats * event.beatPeriod;
    const gateSeconds = (clamp(finite(gatePercent, 50), 0, 100) / 100) * intervalSeconds;
    const stepBeats = event.absoluteStep / event.stepsPerBeat;
    const fired = [];

    for (const slot of slots) {
      const inside = Math.max(0, (arpSlotBeats(slot, intervalBeats) - stepBeats) * event.beatPeriod);
      const index = arpCursor.next(voices);
      const voice = voices[index];
      if (!voice) continue;
      fired.push(
        playNote(voice.note, {
          at: event.swungTime + inside,
          id: `arp-${event.absoluteStep}-${slot}`,
          velocity: voice.velocity,
          gateSeconds,
          source: voice.source,
          arp: true,
        }),
      );
    }
    return fired;
  }

  /* ------------------------------------------------------------------- a step --- */

  function onStep(event) {
    const patternIndex = bank.index();

    /* THE BAR BOUNDARY. The chain advances here, by writing the pattern it lands on — the
       one and only difference between chain mode and manual selection. */
    if (event.step === 0) {
      const next = chain.advance();
      if (next) store.set('seq.pattern', next, { source: 'sequencer', apply: 'direct' });
      laneCache = { pattern: null, notes: [] };
    }

    /* THE PLAYHEAD. A store key, never a painted element: task 2's stylesheet already
       resolves a glistening step dab from this key and from `data-playing="true"`.
       It is written on the scheduling path, so it leads the sound by up to the clock's
       own 100 ms horizon — the same lead every lookahead sequencer's UI has, and the only
       honest answer without a second timer. */
    store.set('seq.step', event.step + 1, { source: 'sequencer', apply: 'direct' });

    const playing = bank.index();
    const origin = event.time - event.step * event.stepPeriod;

    stepLog.push({
      step: event.step,
      absoluteStep: event.absoluteStep,
      bar: event.bar,
      pattern: bank.patterns()[playing],
      at: event.swungTime,
      time: event.time,
      swungTime: event.swungTime,
      swung: event.swung,
      origin,
    });

    /* THE DRUM LANES. Eleven lanes, indexed by the clock's 0-based `step`, placed at
       `swungTime` — never at `time`. The per-step accent is the kit's level. */
    for (const voice of KIT_VOICES) {
      const cell = bank.cell(playing, voice, event.step);
      if (!cell || !cell.on[event.step]) continue;
      const velocity = clamp(finite(cell.vel[event.step], 60) / 100, 0, 1);
      triggerVoice(voice, { at: event.swungTime, velocity });
      drumLog.push({
        voice,
        step: event.step,
        absoluteStep: event.absoluteStep,
        bar: event.bar,
        pattern: bank.patterns()[playing],
        at: event.swungTime,
        time: event.time,
        swungTime: event.swungTime,
        swung: event.swung,
        swing: event.swing,
        origin,
        velocity,
      });
    }

    /* THE MELODIC LANE. When the arpeggiator owns the lane (`arp.followLane`) the steps
       are not sounded here — their notes are the arpeggiator's chord, gathered once per
       bar. Otherwise the lane plays as written. */
    const melodic = bank.cell(playing, MELODY_LANE, event.step);
    if (melodic?.on[event.step]) {
      const owns = Boolean(store.get('arp.on')) && Boolean(store.get('arp.followLane'));
      if (!owns) {
        playNote(Math.round(finite(melodic.note[event.step], 60)), {
          at: event.swungTime,
          id: `mel-${event.absoluteStep}`,
          velocity: clamp(finite(melodic.vel[event.step], 60) / 100, 0, 1),
          gateSeconds: (clamp(finite(melodic.gate[event.step], 50), 0, 100) / 100) * event.stepPeriod,
          source: 'lane',
        });
      }
    }

    runArp(event);

    lastStep = event.step;
    lastAbsolute = event.absoluteStep;
    lastPattern = bank.selected();
    for (const fn of [...taps]) fn(event);
  }

  const api = {
    bank,
    chain,

    /**
     * Subscribe to the clock. NOT a transport: this arms no timer, and it does not start
     * or stop `global.run`. The clock calls this subscriber; that is the whole lifecycle.
     */
    start() {
      if (unsubscribe) return false;
      chain.rewind();
      unsubscribe = clock.subscribeToSteps(onStep);
      return true;
    },

    stop() {
      if (!unsubscribe) return false;
      unsubscribe();
      unsubscribe = null;
      return true;
    },

    /** A tap on every step event. Verification only; returns an unsubscribe. */
    onStep(fn) {
      taps.add(fn);
      return () => taps.delete(fn);
    },

    log: () => ({ steps: stepLog.read(), drums: drumLog.read(), notes: noteLog.read() }),

    /**
     * How many timers this module owns. Always zero, and returned rather than asserted so
     * the claim is checkable at runtime as well as against the source on disk.
     */
    timerCount: () => 0,

    state: () => ({
      running: Boolean(unsubscribe) && Boolean(clock.running?.()),
      step: lastStep,
      absoluteStep: lastAbsolute,
      pattern: lastPattern,
      chain: Boolean(store.get('seq.chain')),
      chainOrder: chain.order(),
      chainCursor: chain.cursor(),
      playhead: store.get('seq.step'),
      arp: {
        on: Boolean(store.get('arp.on')),
        mode: store.get('arp.mode'),
        rate: store.get('arp.rate'),
        octaves: store.get('arp.octaves'),
        gate: store.get('arp.gate'),
        followLane: Boolean(store.get('arp.followLane')),
        source: store.get('arp.followLane') ? 'lane' : 'held',
        seed: arpState.seed,
        firings: arpFirings.map((entry) => ({ note: entry.note, at: entry.at })),
      },
    }),

    selectPattern: (name) => bank.select(name),
    chainAppend: (name) => chain.append(name),
    chainReset: (order) => chain.reset(order),
    chainOrder: () => chain.order(),
    /** Stop every sound this sequencer started — the panic, for a transport halt. */
    panic: (options) => allNotesOff(options ?? {}),

    /**
     * Make the arpeggiator's Random mode reproducible. With no seed it uses the injected
     * `random` (Math.random by default), so a playing instrument's Random is genuinely
     * different every cycle; a seed swaps in mulberry32 and a verification run can assert
     * an exact sequence.
     */
    setArpRandomSeed(seed) {
      if (seed === null || seed === undefined) {
        arpRandom = random;
        arpState = { ...arpState, seed: null };
      } else {
        arpRandom = mulberry32(Number(seed));
        arpState = { ...arpState, seed: Number(seed) };
      }
      arpCursor = createArpCursor(arpState.mode, { random: arpRandom });
      return arpState.seed;
    },
    arpRandomSeed: () => arpState.seed,
    setArpRandom: (fn) => {
      arpRandom = typeof fn === 'function' ? fn : random;
      arpCursor = createArpCursor(arpState.mode, { random: arpRandom });
      return arpRandom;
    },
    /** The note ordering for a mode over a chord — the verification primitive. */
    arpVoices,
  };

  /* Subscribed at construction: a subscriber is inert until the clock runs, so there is no
     reason to make it a lifecycle this module could get wrong. */
  api.start();

  return api;
}
