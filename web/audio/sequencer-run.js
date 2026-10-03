/**
 * sequencer-run.js — THE INSTRUMENT'S BINDING OF THE SEQUENCER. One module, one
 * singleton, imported for its side effect by web/ui/main.js.
 *
 * WHY A SECOND FILE
 *   `sequencer.js` and `arp.js` import nothing from the audio graph, which is what lets
 *   tests/sequencer.test.mjs drive the whole stack — the real lookahead clock, the real
 *   808 kit, the real store — on the fake-AudioContext harnesses with no browser. This is
 *   the file that binds them to the real `AudioContext`, the real `mixBus` and the real
 *   note path, and it is the mirror image of `clock.js`/`drums.js` and
 *   `drum-kit.js`/`drums.js`: the module that is testable, and the module that is shipped.
 *
 * WHAT IT WIRES, AND WHY EACH THING IS THE ONE IT IS
 *
 *   clock / triggerVoice   from `drums.js`, which owns the ONE lookahead scheduler and the
 *                          kit. `global.run` is the transport and `drums.js` is what starts
 *                          and stops it, so this file starts NOTHING: it constructs the
 *                          sequencer, which subscribes, and then does nothing at all until
 *                          the player presses RUN.
 *
 *   noteOn / noteOff       from `engine.js` — task 3's note path, the same one task 11's
 *   allNotesOff            keyboard uses. The melodic lane and the arpeggiator both go
 *                          through it, so they share the allocator and the envelope
 *                          behaviour and the instrument has exactly one envelope. Two
 *                          parallel paths would mean the same note sounding different
 *                          depending on whether it came from a key or from a step.
 *
 *   heldNotes              from `engine.js`'s registry. The arpeggiator reads held keyboard
 *                          notes through it; task 11 is what fills it, by calling `noteOn`
 *                          and `noteOff` and nothing else. Until then the arpeggiator
 *                          works from the melodic lane (`arp.followLane`), which is
 *                          available now.
 *
 *   store                  from `ui/params.js`, the single authority. The sequencer writes
 *                          `seq.pattern`, `seq.step` and `seq.chainOrder` to it and reads
 *                          every lane, the transport and the arpeggiator from it. It keeps
 *                          no private copy of a value.
 *
 * THE PUBLIC API — what task 13's inspection handle reads
 *   sequencer        the instance: .log() / .state() / .bank / .chainAppend / ...
 *   sequencerState() a plain snapshot, safe to serialise
 *   playingPattern() the pattern the next step will read
 *   chainOrder()     the chain as an ordered array
 *   arpFirings()     the arpeggiator's recent notes in order — the "firing-note readout"
 *   arpVoiceReadout()  the same, as text, for a human-readable check
 *   setArpRandomSeed(seed)  make Random mode exactly reproducible
 *   resetArpRandom()  hand Random mode back to Math.random
 */

import { clock, startClock, stopClock, triggerVoice, releaseVoice, setPedal, allDrumsOff } from './drums.js';
import { allNotesOff, heldNotes, noteOn, noteOff } from './engine.js';
import { store } from '../ui/params.js';
import { createSequencer } from './sequencer.js';
import { arpOrder } from './arp.js';

/**
 * THE SEQUENCER. Constructed here, at import time, and subscribed to the clock for the
 * rest of the page's life. It owns no timer, so there is nothing to start and nothing to
 * tear down: `global.run` is the transport and the clock is the only scheduler.
 */
export const sequencer = createSequencer({
  store,
  clock,
  triggerVoice,
  noteOn,
  noteOff,
  allNotesOff,
  heldNotes,
});

/* -------------------------------------------------------- the inspection surface --- */

/** A plain, serialisable snapshot. Read-only by construction: it is a fresh object. */
export function sequencerState() {
  const state = sequencer.state();
  return {
    ...state,
    playing: clock.running(),
    stepCursor: clock.stepCursor(),
    absoluteStep: clock.position().absoluteStep,
    bar: clock.position().bar,
    audioTime: clock.audioTime(),
    tempo: clock.tempo(),
    swing: clock.swing(),
  };
}

/** The pattern the next step will read — in chain mode, the chain's next entry. */
export function playingPattern() {
  return store.get('seq.pattern');
}

/** The chain as an ordered array of pattern names. */
export function chainOrder() {
  return sequencer.chainOrder();
}

/**
 * THE FIRING-NOTE READOUT: the arpeggiator's recent notes, in the order they fired. This is
 * what the arpeggiator's five modes are verified against — read it repeatedly and the
 * ordering is a fact rather than a claim.
 */
export function arpFirings(limit = 24) {
  return sequencer.state().arp.firings.slice(-Math.max(1, limit));
}

/** The same, as note names, for a human-readable read. */
export function arpVoiceReadout(limit = 12) {
  return arpFirings(limit).map((entry) => `${entry.note}/${noteName(entry.note)}`).join(' ');
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** A MIDI number as a note name, e.g. 60 -> 'C4'. */
export function noteName(note) {
  const n = Math.round(Number(note));
  if (!Number.isFinite(n)) return '?';
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** The ordering a mode would produce over a chord, without running it. */
export function arpeggiatorPreview(mode, notes, options = {}) {
  return arpOrder(mode, notes, { octaves: store.get('arp.octaves'), ...options });
}

/** Make Random mode exactly reproducible; `null` hands it back to `Math.random`. */
export const setArpRandomSeed = (seed) => sequencer.setArpRandomSeed(seed);
export const arpRandomSeed = () => sequencer.arpRandomSeed();

/** Reset every sounding note and release the hat's pedal — the transport halt. */
export function allNotesOffNow(options) {
  setPedal('oh', false, options);
  allDrumsOff(options);
  allNotesOff(options);
  return true;
}

export { startClock, stopClock, triggerVoice, releaseVoice, clock, store, heldNotes };
export { createSequencer, CHAIN_MAX, LANE_COUNT, MELODY_LANE, STEP_COUNT } from './sequencer.js';
export { ARP_MODES, ARP_RATE_BEATS, arpIntervalBeats, arpOrder, arpPool, arpVoices } from './arp.js';
