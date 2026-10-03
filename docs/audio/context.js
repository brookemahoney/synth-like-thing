/**
 * context.js — the ONE AudioContext, owned here and exported for everything else.
 *
 * WHY IT EXISTS AT ALL
 *   The plan's first technical risk is that browsers refuse to start audio
 *   before a user gesture. The instrument is therefore presented powered-off, and
 *   this context is created SUSPENDED at load time rather than lazily on the
 *   first gesture.
 *
 *   Lazy creation is the tempting version and it is worse: every module would
 *   have to cope with "the context does not exist yet", which pushes a null check
 *   through the entire codebase and makes the audio graph's shape depend on user
 *   behaviour. Created-suspended-and-exported is one null check in one place —
 *   here — and every graph below this line can be built, inspected and unit
 *   tested whether or not anyone has clicked anything yet.
 *
 *   `resumeInstrument()` exists so task 11's power-on control has something to
 *   call from inside the gesture. NO PRODUCT CODE CALLS IT: the browser only
 *   allows a resume that happens inside a user gesture, so the call site must be
 *   a real gesture handler, not an import.
 *
 *   audioContext        the context (state 'suspended' until a gesture resumes it)
 *   contextState()      'suspended' | 'running' | 'closed'
 *   contextTime()       currentTime, the clock every audio schedule is written against
 *   resumeInstrument()  call from a user gesture only
 *   sampleRate, nyquist
 *
 * ONE CONTEXT, NOT ONE PER MODULE
 *   A second AudioContext would double the output latency, run its own clock, and
 *   make "is the note scheduled?" ambiguous. The plan's single-clock rule extends
 *   to the context: there is one, it is here, and everyone schedules against it.
 */

const AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext;

if (!AudioContextCtor) {
  throw new Error('context: this browser has no AudioContext, so the instrument cannot start');
}

/**
 * Created immediately and left suspended. `latencyHint: 'interactive'` is a hint,
 * not a request for a specific buffer size, and it keeps voices responsive.
 */
export const audioContext = new AudioContextCtor({ latencyHint: 'interactive' });

/** 'suspended' | 'running' | 'closed' — read rather than cached. */
export function contextState() {
  return audioContext.state;
}

/** The audio clock. Every scheduled value in the instrument is written against it. */
export function contextTime() {
  return audioContext.currentTime;
}

export const sampleRate = audioContext.sampleRate;
export const nyquist = sampleRate / 2;

/**
 * Resume from inside a user gesture. This is the single place the context is
 * ever resumed, and it exists so that exactly one line has to be reached from a
 * gesture handler — task 11's power-on control.
 */
export async function resumeInstrument() {
  if (audioContext.state === 'closed') throw new Error('context: cannot resume a closed context');
  if (audioContext.state === 'running') return true;
  await audioContext.resume();
  return audioContext.state === 'running';
}