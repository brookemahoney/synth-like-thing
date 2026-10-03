/**
 * engine.js — THE NOTE-EVENT PATH. Everything that makes a sound enters here.
 *
 * A note event is four values and nothing else:
 *
 *   { id, note, velocity, random }
 *
 *   id        identifies the note so its release can find its voice. The keyboard
 *             (task 11) and the sequencer (task 10) each own their own id scheme
 *             and simply pass theirs in; when none is given one is generated.
 *   note      MIDI number, 0..127. The engine does not decide pitch from it —
 *             audio/pitch.js does.
 *   velocity  0..1. Kept on the voice as live state; task 7's matrix reads it as
 *             a source, so it must arrive with the note rather than be guessed.
 *   random    a fresh 0..1 value per note, the per-note modulation source. Also
 *             generated when absent.
 *   at        optional AudioContext time. Absent means "now", i.e.
 *             audioContext.currentTime — the single clock.
 *
 *   noteOn(event)          claim a voice and start it
 *   noteOff(id)            release the voice playing that id
 *   allNotesOff()          release everything (panic)
 *   heldNotes()            the notes currently HELD, in the order they were pressed
 *   noteHeld(note)         is that note held?
 *   clearHeldNotes()       empty the registry (panic, latch off)
 *   setCoreModulation()    the modulation-matrix contribution, per core
 *   waveLevel() / setWaveLevelBias() / waveLevels()
 *                          the wavesampler's level: readable, and a modulation point
 *   voiceEngine            the handle: allocator, voices, live states, stats
 *
 * THE HELD-NOTE REGISTRY, AND WHY IT LIVES HERE
 *   `heldNotes()` is the arpeggiator's keyboard source (task 10) and `noteHeld(note)` /
 *   `clearHeldNotes()` are task 11's latch and panic. All three live in this file, on the
 *   note path, because the plan is explicit that there must be ONE registry keyed by note
 *   and not two lists that can drift: the keyboard, the latch, the panic and the
 *   arpeggiator must agree about what is held, and the only place they cannot disagree is
 *   the one function every note goes through.
 *
 *   THEREFORE: `noteOn` registers the note and `noteOff` unregisters it, automatically.
 *   Task 11 calls `noteOn`/`noteOff` — which it has to call anyway to make a sound — and
 *   the registry is correct with no extra wiring and nothing to forget. THE ONE ESCAPE
 *   HATCH: a caller that passes `held: false` is making a note that must not count as
 *   held. Task 10's sequencer and arpeggiator both do, because a sequenced note that
 *   appeared in the registry would be arpeggiated by its own output, and would pollute a
 *   held keyboard chord. The flag is documented at `normalise` and asserted by
 *   tests/sequencer.test.mjs.
 *
 *   The registry is a Map keyed by note id, and `heldNotes()` returns the VALUES in press
 *   order — As-Play's arpeggiator mode needs the order the notes were played in, which a
 *   sorted MIDI list would have thrown away.
 *
 * WHAT THIS MODULE OWNS
 *   The allocator, the voice factory, the store fan-out, and the note path.
 *   Nothing here decides what a waveform is (waveforms.js), what a frequency is
 *   (pitch.js), which voice to give away (allocator.js) or how a voice is wired
 *   (voice.js). That split is why each of those can be tested on its own.
 *
* THE STORE FAN-OUT
 *   `mixer.level` and `osc{n}.level` and the pitch keys each have up to sixteen
 *   AudioParams behind them, which the ramp bridge cannot express (one param per
 *   key). So the engine subscribes once and fans each write out over the pool with the
 *   same hold-then-ramp primitive, at the same RAMP_SECONDS. A control
 *   therefore behaves identically whether it moves the master volume or one core's
 *   level on sixteen voices at once.
 *
 *   `wave.level` is fanned out the same way, onto each voice's wavesampler slot, which
 *   is the whole reason the wavesampler is a fourth voice rather than a fourth core:
 *   its level is its own gain, so silencing osc1..3 cannot silence it and silencing it
 *   cannot silence them. The additive matrix contribution (task 7) rides on the same
 *   param through `waveLevelBias` below.
 *
 *   A waveform change is NOT applied to a sounding voice: an oscillator's type
 *   cannot be changed after it starts. It takes effect on the next note, which is
 *   what a real instrument does. The same is true of the wavesampler's table and its
 *   scan position: both are baked into the PeriodicWave a note is built with.
 *
 * THE WAVESAMPLER'S HALF OF A NOTE
 *   voice.js owns the graph and knows nothing about the wavesampler beyond leaving a
 *   silent `waveSlot` summing gain behind — which is why the per-note oscillator that
 *   feeds it is started and stopped HERE, from the three places a voice's life changes:
 *
 *     noteOn()     stop whatever the incoming voice was playing, then start its wave
 *     noteOff()    stop that voice's wave beside its own release
 *     allNotesOff()  and every other wave beside every other release
 *
 *   Starting it here rather than inside voice.js is what lets task 5 and task 4 change
 *   the same file's neighbours without either of them touching the other. The oscillator
 *   takes its frequency from the voice's own core-1 pitch source (wavesampler.js), so
 *   there is still exactly one frequency computation in the instrument.
 *
 * THE WAVESAMPLER LEVEL, AS A READABLE VALUE AND A MODULATION POINT
 *   Task 7's matrix writes one bipolar number per destination per block. The wavesampler
 *   level is reached through the same three-step shape the cores use:
 *
 *     waveLevel()                 the store's value — the readable value
 *     setWaveLevelBias(delta)     the matrix's contribution, added to it
 *     waveLevelBias()             what it is set to, for an inspection panel
 *     waveLevels()                the live per-voice result, after the bias
 *
 *   The bias is a SUM, not a multiplier, so a route of -100 % and a level of 0.8 land
 *   on silence and a route of +100 % lands on 1.0 — which is what a level destination
 *   means. Nothing about it is hard-wired to a control: the store value alone is enough
 *   to make a sound, and the bias is zero until something writes to it.
 */

import { audioContext, contextTime } from './context.js';
import { mixBus } from './master.js';
import { store } from '../ui/params.js';
import { VOICE_CAPACITY, VOICE_STATE, createAllocator } from './allocator.js';
import { createVoice } from './voice.js';
import { RAMP_SECONDS } from './ramp.js';
import { rampTo, setNow } from './automation.js';
import { startWaveVoice, stopWaveVoice, stopAllWaveVoices, waveVoices } from './wavesampler.js';
// The wavesampler's file input is part of the note path, and ui/main.js is not this
// task's to edit — so the loader mounts itself from the graph the engine already
// enters. It is the same self-initialising shape as ui/paint.js: a deferred mount, so
// surface.js has already drawn the panel it attaches to.
import '../ui/waveload.js';

export const CORE_COUNT = 3;
export { VOICE_CAPACITY, VOICE_STATE };

/** The pitch-affecting keys per core, and the level key. */
const PITCH_KEYS = ['octave', 'semitone', 'detune'];

/** How long a released wavesampler source is given before it is stopped. Matches the
 *  voice's own release fade so the two sources die together. */
const WAVE_RELEASE_FADE_SECONDS = 0.03;

const allocator = createAllocator({
  capacity: VOICE_CAPACITY,
  createVoice: (index) => createVoice({ context: audioContext, parent: mixBus, read: store.get, index }),
});

let noteCounter = 0;

/**
 * THE HELD-NOTE REGISTRY. One entry per sounding note the player is HOLDING, keyed by the
 * note id `noteOn` was given, and carrying the press order so As-Play has something to
 * preserve. Written only by `noteOn` / `noteOff` / `clearHeldNotes` below.
 *
 * Insertion order IS press order, so `heldNotes()` needs no sort — and Map iteration order
 * is insertion order by definition, which is why this is a Map and not an object.
 */
const held = new Map();

/**
 * The currently-held notes, in the order they were pressed:
 *   [{ id, note, velocity, random, at, order }]
 *
 * A fresh array and a fresh record per entry, so a caller cannot mutate the registry
 * through the result. This is task 10's arpeggiator's keyboard source and task 13's
 * inspection readout — the same numbers, from the same place.
 */
export function heldNotes() {
  return [...held.values()].map((entry) => ({ ...entry }));
}

/** Is that MIDI note currently held? Keyed by NOTE, so any id's note answers for itself. */
export function noteHeld(note) {
  const wanted = Number(note);
  for (const entry of held.values()) if (entry.note === wanted) return true;
  return false;
}

/**
 * Empty the registry. The panic and the latch-off path: a voice can be released by a
 * stolen allocation or a hand-placed `noteOff`, and this is the one call that makes the
 * held set agree with what is actually sounding. Returns how many entries it dropped.
 */
export function clearHeldNotes() {
  const dropped = held.size;
  held.clear();
  return dropped;
}

/** How many notes are held. Cheap; for diagnostics. */
export function heldNoteCount() {
  return held.size;
}

/** The additive, bipolar matrix contribution to `wave.level`. Zero until task 7. */
let waveLevelBiasValue = 0;

const voiceEngine = {
  allocator,
  /** The pool. A voice is created on its first note and reused from then on. */
  voices: () => allocator.voices,
  capacity: VOICE_CAPACITY,
  stats: () => allocator.stats(),
  /** Live per-voice state, for the sequencer, the meter and the inspection handle. */
  liveStates: () => allocator.voices.filter((voice) => voice.state !== VOICE_STATE.IDLE).map((voice) => voice.liveState()),
  voiceFor: (noteId) => allocator.voiceFor(noteId),
  noteOn,
  noteOff,
  allNotesOff,
  setCoreModulation,
};

/* ------------------------------------------------------------- the note path --- */

/** Fill in whatever the caller left out, so every note event has all four values. */
function normalise(event = {}) {
  noteCounter += 1;
  const note = Number.isFinite(event.note) ? Math.max(0, Math.min(127, Math.round(event.note))) : 60;
  return {
    id: event.id ?? `note-${noteCounter}`,
    note,
    velocity: Number.isFinite(event.velocity) ? Math.max(0, Math.min(1, event.velocity)) : 0.8,
    random: Number.isFinite(event.random) ? event.random : Math.random(),
    at: Number.isFinite(event.at) ? event.at : contextTime(),
    /* THE ONE FLAG THE HELD-NOTE REGISTRY HONOURS. Absent means "a player is holding
       this", which is the keyboard's case; `false` means "a machine is playing this and it
       must not count as held" — task 10's melodic lane and arpeggiator both pass it. */
    held: event.held !== false,
    order: noteCounter,
  };
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The level a voice's wavesampler slot should hold: the store's value plus the
 *  matrix's bipolar bias, held inside 0..1 because that is the gain's range. */
function effectiveWaveLevel(base = store.get('wave.level')) {
  return clamp01((Number(base) || 0) + waveLevelBiasValue);
}

/** Write one voice's wavesampler level. Ramps on a gesture, assigns at note-on. */
function applyWaveLevel(voice, value, { at, ramp = true } = {}) {
  if (!voice?.waveSlot) return false;
  const level = clamp01(Number(value) || 0);
  if (ramp) rampTo(voice.waveSlot.gain, level, audioContext, { at, seconds: RAMP_SECONDS });
  else setNow(voice.waveSlot.gain, level, audioContext, { at });
  return true;
}

/** Claim a voice and start it. Returns the voice, so a caller can read its state. */
export function noteOn(event = {}) {
  const note = normalise(event);
  /* THE REGISTRY. Before the allocator, so a note that is immediately stolen is still
     recorded as pressed — the arpeggiator's chord is what the PLAYER is holding, not what
     the pool could spare. Re-pressing the same id moves it rather than duplicating it. */
  if (note.held) held.set(note.id, { id: note.id, note: note.note, velocity: note.velocity, random: note.random, at: note.at, order: note.order });
  const voice = allocator.acquire(note, note.at);
  // The incoming voice may have been stolen mid-note, so its previous wavesampler
  // source is still running and has to go before this note's one starts.
  stopWaveVoice(voice.index, { at: note.at, fade: WAVE_RELEASE_FADE_SECONDS });
  // Core 1's frequency, as the voice's own pitch path computed it. Not a second
  // computation: this is the value the cores are already playing.
  startWaveVoice({
    voice,
    context: audioContext,
    at: note.at,
    frequency: voice.cores?.[0]?.hz ?? 0,
    level: effectiveWaveLevel(),
  });
  return voice;
}

/** Release the voice playing `id`. Harmless if it is already gone. */
export function noteOff(id, { at } = {}) {
  const when = Number.isFinite(at) ? at : contextTime();
  held.delete(id);
  const voice = allocator.noteOff(id, when);
  if (voice) stopWaveVoice(voice.index, { at: when, fade: WAVE_RELEASE_FADE_SECONDS });
  return voice;
}

/** Panic: release every sounding voice, and empty the held-note registry with it. */
export function allNotesOff({ at } = {}) {
  const when = Number.isFinite(at) ? at : contextTime();
  clearHeldNotes();
  allocator.allNotesOff(when);
  stopAllWaveVoices({ at: when, fade: WAVE_RELEASE_FADE_SECONDS });
}

/**
 * The modulation-matrix contribution for one core, in cents. Task 7 sums its
 * routes once per voice per block and calls this; nothing else writes to it.
 */
export function setCoreModulation(core, cents, { voiceIndex, at } = {}) {
  let touched = 0;
  for (const voice of allocator.voices) {
    if (voiceIndex !== undefined && voice.index !== voiceIndex) continue;
    if (!voice.cores) continue;
    voice.setCoreModulation(core, cents, { at, ramp: true, seconds: RAMP_SECONDS });
    touched += 1;
  }
  return touched;
}

/* ---------------------------------------------- the wavesampler level, exposed --- */

/** The wavesampler's level as the store has it: the readable value task 7 reads. */
export function waveLevel() {
  return store.get('wave.level');
}

/**
 * The modulation-matrix contribution to the wavesampler level, in the same -1..1 units
 * as a bipolar matrix depth and ADDED to the store value. Task 7 calls this once per
 * block with the sum of its `*.ampLevel` routes; zero means "no modulation", so the
 * control on the panel is the whole of the level until something routes to it.
 */
export function setWaveLevelBias(bias, { at } = {}) {
  const next = Number.isFinite(Number(bias)) ? Number(bias) : 0;
  if (next === waveLevelBiasValue) return waveLevelBiasValue;
  waveLevelBiasValue = next;
  applyWaveLevelBias({ at });
  return waveLevelBiasValue;
}

function applyWaveLevelBias({ at } = {}) {
  const when = Number.isFinite(at) ? at : contextTime();
  const level = effectiveWaveLevel();
  for (const voice of allocator.voices) applyWaveLevel(voice, level, { at: when });
  return level;
}

/** What the matrix is currently contributing. */
export function waveLevelBias() {
  return waveLevelBiasValue;
}

/** The live per-voice wavesampler level, after the matrix's contribution. */
export function waveLevels() {
  const sounding = waveVoices();
  return allocator.voices
    .filter((voice) => voice.waveSlot)
    .map((voice) => {
      const source = sounding.find((row) => row.voice === voice.index);
      return {
        voice: voice.index,
        state: voice.state,
        table: source?.table ?? null,
        hz: source?.hz ?? 0,
        scan: source?.scan ?? 0,
        level: voice.waveSlot.gain.value,
        bias: waveLevelBiasValue,
      };
    });
}

/* ------------------------------------------------------------- the fan-out --- */

const liveVoices = () => allocator.voices.filter((voice) => voice.cores !== null);

const fanOut = (apply) => {
  for (const voice of liveVoices()) apply(voice);
};

/**
 * One store write -> every AudioParam behind it. All of these are continuous
 * gesture parameters, so every one ramps; none is assigned at gesture time.
 */
function bindStoreToVoices() {
  const at = () => contextTime();

  store.subscribe('mixer.level', (_key, value) => fanOut((voice) => voice.setMixLevel(value, { at: at() })));

  store.subscribe('wave.level', (_key, value) => {
    const level = effectiveWaveLevel(value);
    fanOut((voice) => applyWaveLevel(voice, level, { at: at() }));
  });

  for (let core = 0; core < CORE_COUNT; core += 1) {
    store.subscribe(`osc${core + 1}.level`, (_key, value) =>
      fanOut((voice) => voice.setCoreLevel(core, value, { at: at() })),
    );

    for (const key of PITCH_KEYS) {
      store.subscribe(`osc${core + 1}.${key}`, () => fanOut((voice) => voice.applyCore(core, { at: at() })));
    }
  }
}

bindStoreToVoices();

export { voiceEngine };