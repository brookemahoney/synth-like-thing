/**
 * allocator.js — the bounded voice pool and its STEALING POLICY.
 *
 * THE POLICY (a contract, not an implementation detail)
 *   1. An idle voice is always preferred; nothing is stolen to get it.
 *   2. Otherwise the voice that was released EARLIEST is stolen. A released voice
 *      is already silent, so stealing it is inaudible — this is what stops a held
 *      chord from cutting itself off when the sixteenth note arrives.
 *   3. Only when every voice is still sounding is the voice that started EARLIEST
 *      stolen, which is the one the ear is least likely to be listening to.
 *
 *   Ties fall back to pool order, so the sequence is deterministic and testable.
 *
 * WHY THE POLICY IS A SEPARATE MODULE
 *   It is the one routine whose correctness is invisible by ear and obvious in a
 *   test: a stolen voice that is one note too old or too new is a subtle wrong
 *   note, not a crash. So the decision is a pure function over recorded start and
 *   release times (`pickVoice`) and the pool is a thin owner of it.
 *
 *   VOICE_CAPACITY  16 concurrent voices
 *   VOICE_STATE      idle | sounding | released
 *   pickVoice(voices) -> { voice, reason }    'idle' | 'released' | 'sounding'
 *   createAllocator({ capacity, createVoice }) -> the pool
 *        .acquire(note, at)   claim a voice for a note (steals + tears down if needed)
 *        .noteOff(id, at)     release by note id
 *        .allNotesOff(at)     release everything sounding
 *        .voiceFor(id) / .stats() / .voices / .capacity
 *
 *   The pool NEVER grows past `capacity`, and never creates a voice before one is
 *   asked for, so an idle instrument costs no nodes at all.
 *
 *   `at` is always an AudioContext time in seconds, supplied by the caller: the
 *   allocator owns no clock of its own (the plan's single-clock rule).
 */

/** The instrument's polyphony ceiling. */
export const VOICE_CAPACITY = 16;

export const VOICE_STATE = Object.freeze({
  IDLE: 'idle',
  SOUNDING: 'sounding',
  RELEASED: 'released',
});

const time = (v) => (Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);

/**
 * The policy as a pure function. Given the pool, which voice should the next
 * note take, and why.
 */
export function pickVoice(voices) {
  if (!voices || voices.length === 0) return { voice: null, reason: 'empty' };

  let idle = null;
  let oldestReleased = null;
  let oldestSounding = null;

  for (const voice of voices) {
    if (voice.state === VOICE_STATE.IDLE) {
      if (idle === null || voice.index < idle.index) idle = voice;
      continue;
    }
    if (voice.state === VOICE_STATE.RELEASED) {
      if (oldestReleased === null) oldestReleased = voice;
      else if (earlier(voice, oldestReleased, 'releasedAt')) oldestReleased = voice;
      continue;
    }
    if (oldestSounding === null) oldestSounding = voice;
    else if (earlier(voice, oldestSounding, 'startedAt')) oldestSounding = voice;
  }

  if (idle) return { voice: idle, reason: 'idle' };
  if (oldestReleased) return { voice: oldestReleased, reason: 'released' };
  if (oldestSounding) return { voice: oldestSounding, reason: 'sounding' };
  return { voice: null, reason: 'empty' };
}

/** Earlier timestamp wins; pool order breaks a tie so the choice is deterministic. */
function earlier(candidate, incumbent, field) {
  const a = time(candidate[field]);
  const b = time(incumbent[field]);
  if (a !== b) return a < b;
  return candidate.index < incumbent.index;
}

/** The sounding voice holding `noteId`; the last claim wins, so a stolen note
 *  resolves to the voice that is actually playing it. */
function soundingWithNote(pool, noteId) {
  let found = null;
  for (const voice of pool) {
    if (voice.state === VOICE_STATE.SOUNDING && voice.noteId === noteId) found = voice;
  }
  return found;
}

export function createAllocator({ capacity = VOICE_CAPACITY, createVoice } = {}) {
  if (typeof createVoice !== 'function') throw new Error('createAllocator needs a createVoice factory');
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('createAllocator needs a positive integer capacity');

  /** Pool slots, in creation order. Index is the deterministic tie-break. */
  const pool = [];
  let steals = 0;
  let reuses = 0;

  function take(note, at) {
    // Under capacity there is always room, so nothing is ever stolen to grow the pool.
    if (pool.length < capacity) {
      const fresh = createVoice(pool.length);
      fresh.index = pool.length;
      fresh.state = VOICE_STATE.IDLE;
      fresh.startedAt = null;
      fresh.releasedAt = null;
      fresh.noteId = null;
      pool.push(fresh);
      return { voice: fresh, stolen: false, reason: 'new' };
    }

    const { voice, reason } = pickVoice(pool);
    // A steal cuts a voice that was still audible; a reuse takes one that was
    // already released. Both are counted separately so "how loud did this get?"
    // and "how often was a live note cut?" are different questions.
    const stolen = reason === 'sounding';
    if (stolen) steals += 1;
    else if (reason === 'released') reuses += 1;
    if (reason !== 'idle') {
      // The ONE teardown path, used whether the victim was released or still
      // sounding. Keeping a single path means there is no second way a voice can
      // be taken apart, and every reuse exercises the same disconnection.
      voice.kill(at);
    }
    return { voice, stolen, reason };
  }

  return {
    get capacity() {
      return capacity;
    },
    get voices() {
      return pool;
    },

    /** Claim a voice for `note` (which carries { id, note, velocity, random }). */
    acquire(note, at) {
      const { voice, stolen, reason } = take(note, at);
      voice.start(note, { at });
      voice.reason = reason;
      voice.stolen = stolen;
      return voice;
    },

    /** Release the sounding voice playing `noteId`. Returns it, or null. */
    noteOff(noteId, at) {
      const found = soundingWithNote(pool, noteId);
      if (!found) return null;
      found.release(at);
      return found;
    },

    /** The sounding voice playing `noteId`, or null. */
    voiceFor(noteId) {
      return soundingWithNote(pool, noteId);
    },

    /** Release everything sounding. Released-at values are identical, so pool
     *  order decides the next steal — deterministic, and audible in a chord test. */
    allNotesOff(at) {
      for (const voice of pool) {
        if (voice.state === VOICE_STATE.SOUNDING) voice.release(at);
      }
    },

    stats() {
      let sounding = 0;
      let released = 0;
      for (const voice of pool) {
        if (voice.state === VOICE_STATE.SOUNDING) sounding += 1;
        else if (voice.state === VOICE_STATE.RELEASED) released += 1;
      }
      return { capacity, pool: pool.length, live: pool.length, sounding, released, idle: pool.length - sounding - released, steals, reuses };
    },
  };
}