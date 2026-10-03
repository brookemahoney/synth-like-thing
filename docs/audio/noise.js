/**
 * noise.js — ONE white-noise buffer for the whole instrument.
 *
 * WHY ONE BUFFER
 *   A two-second stereo-mono noise buffer is ~380 KB. Allocating one per note
 *   would be the fastest way to make a browser tab run out of memory during a
 *   held chord, and the loop would restart audibly on every note because the
 *   noise is uncorrelated between buffers. So the buffer is built once per
 *   context, on first use, and every noise voice and every 808 drum voice
 *   (task 9) loops the same one. Two seconds at 48 kHz is long enough that the
 *   repeat is not heard as a pattern.
 *
 * WHY IT IS NOT BAND-LIMITED
 *   A buffer source is not an oscillator and cannot be band-limited without an
 *   AudioWorklet, which the plan excludes. Noise used as a waveform therefore
 *   hisses at high pitches. That is an accepted trade-off (see the plan's
 *   accepted rough edges) and the voice's own filters mask most of it.
 *
 *   NOISE_SECONDS        length of the shared buffer
 *   noiseBuffer(context) the buffer for that context, built on first call
 *   createNoiseSource(context) a looping source over the shared buffer
 *   noiseBufferCount(context) how many buffers exist for that context (1)
 *
 * The cache is keyed by context so tests can build a throwaway context and get
 * its own buffer; within the instrument there is exactly one context.
 */

import { createBufferSource } from './nodes.js';

export const NOISE_SECONDS = 2;

const buffers = new WeakMap();

/** White noise: uniform over -1..1, so no DC offset and no audible hum. */
function fill(buffer) {
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i += 1) channel[i] = Math.random() * 2 - 1;
  // A mono buffer is used even where the context is stereo: white noise has no
  // spatial information to give up, and half the memory is worth more.
  return buffer;
}

/** The shared buffer for this context, built on first use and cached after. */
export function noiseBuffer(context) {
  let buffer = buffers.get(context);
  if (!buffer) {
    const frames = Math.floor(NOISE_SECONDS * context.sampleRate);
    buffer = fill(context.createBuffer(1, frames, context.sampleRate));
    buffers.set(context, buffer);
  }
  return buffer;
}

/** How many noise buffers exist for this context. Always 1; asserted in tests. */
export function noiseBufferCount(context) {
  return buffers.has(context) ? 1 : 0;
}

/**
 * A fresh looping source over the SHARED buffer. The source is per note (a
 * buffer source cannot be restarted) but the buffer behind it is not.
 */
export function createNoiseSource(context) {
  const source = createBufferSource(context, 'bufferSource');
  source.buffer = noiseBuffer(context);
  source.loop = true;
  return source;
}