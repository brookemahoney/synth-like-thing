/**
 * pitch.js — THE frequency computation. One pure function, no audio in it.
 *
 * WHY ONE FUNCTION
 *   Every pitch-affecting input in the instrument — the keyboard note, a core's
 *   octave and semitone offsets, its fine tune in cents, and the modulation
 *   matrix's contribution — is summed into ONE number of cents here and
 *   converted to Hz exactly once. Nothing else in the codebase is allowed to
 *   turn a note into a frequency, so an octave offset cannot be applied as a
 *   ratio in one place and as an addition somewhere else.
 *
 * WHY PURE
 *   It touches no AudioContext and schedules nothing. That is what makes the
 *   instrument's pitch behaviour checkable in `node --test` (tests/pitch.test.mjs)
 *   instead of only audible.
 *
 *   midiToHz(midi)                              -> Hz
 *   centsToRatio(cents)                         -> multiplier
 *   corePitchCents({ octave, semitone, cents, modCents }) -> one number of cents
 *   computeCoreFrequency({ noteHz, octave, semitone, cents, modCents }, { sampleRate })
 *                                               -> Hz   <-- the single computation
 *   clampFrequency(hz, sampleRate)              -> Hz inside the audible range
 *
 * THE CLAMP
 *   A frequency beyond Nyquist makes an oscillator output nothing at all, and a
 *   modulation route can push an octave + semitone + 50 cents + matrix sum well
 *   past it. The clamp therefore happens here, in the one place a frequency is
 *   produced, rather than at each destination. Task 6 clamps filter cutoffs the
 *   same way for the same reason.
 *
 * CENTS ARE THE UNIT
 *   Octave (1200) and semitone (100) are both cents, so they add. A sign error in
 *   either cannot be masked by a compensating sign error in the other.
 */

/** Concert pitch reference. A4 = 440 Hz = MIDI 69. */
export const A4_MIDI = 69;
export const A4_HZ = 440;

export const OCTAVE_CENTS = 1200;
export const SEMITONE_CENTS = 100;

/** Frequencies are held just under Nyquist so a sum of modulations cannot silence a core. */
const NYQUIST_HEADROOM = 0.999;

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

/** MIDI note number (0..127, fractional allowed) -> Hz, equal temperament, A4 = 440. */
export function midiToHz(midi) {
  return A4_HZ * 2 ** ((finite(midi, A4_MIDI) - A4_MIDI) / 12);
}

/** Cents -> a frequency multiplier. 1200 cents is exactly an octave. */
export function centsToRatio(cents) {
  return 2 ** (finite(cents) / OCTAVE_CENTS);
}

/** Keep a frequency inside what the context can actually render. */
export function clampFrequency(hz, sampleRate = 48000, { floor = 0 } = {}) {
  const v = finite(hz);
  const ceiling = (finite(sampleRate, 48000) / 2) * NYQUIST_HEADROOM;
  if (v < floor) return floor;
  if (v > ceiling) return ceiling;
  return v;
}

/**
 * Every pitch input for one oscillator core, summed into cents.
 * `modCents` is the modulation-matrix contribution for this core; task 7 writes
 * it per block. It is a parameter here rather than a special case so the matrix
 * travels the same road as the panel controls.
 */
export function corePitchCents({ octave = 0, semitone = 0, cents = 0, modCents = 0 } = {}) {
  return (
    finite(octave) * OCTAVE_CENTS +
    finite(semitone) * SEMITONE_CENTS +
    finite(cents) +
    finite(modCents)
  );
}

/**
 * THE function. The absolute frequency one oscillator core should produce for
 * this note. Returns Hz, clamped below Nyquist.
 */
export function computeCoreFrequency(
  { noteHz, octave = 0, semitone = 0, cents = 0, modCents = 0 } = {},
  { sampleRate = 48000 } = {},
) {
  return clampFrequency(finite(noteHz, 0) * centsToRatio(corePitchCents({ octave, semitone, cents, modCents })), sampleRate);
}