/**
 * ir.js — the reverb's impulse response, generated rather than loaded.
 *
 * WHAT IT IS
 *   A decaying noise burst: white noise under an exponential envelope, built
 *   straight into an AudioBuffer. No audio file is fetched — the plan forbids
 *   binary media, and a generated response has a known length and a known decay.
 *
 *   The envelope is 10^(-3t/D), i.e. it reaches -60 dB at t = D. `D` is therefore
 *   the RT60 the control asks for, which is the number a reverb decay control means
 *   everywhere else in the world. The envelope is applied as a per-sample
 *   MULTIPLY rather than a per-sample Math.pow: one multiply per sample instead of
 *   one logarithm, which is the difference between a 12 s response costing tens of
 *   milliseconds and costing hundreds.
 *
 * THE 12 s CEILING IS A HARD CLAMP, NOT A DEFAULT
 *   Convolution cost scales with the length of the response, and a ConvolverNode
 *   keeps running for the life of the page. The plan names this the most expensive
 *   node in the graph and the mitigation is explicit: cap the decay at 12 s. So
 *   `clampDecaySeconds()` is applied on the way in, and a caller asking for 30 s
 *   gets 12 s of buffer rather than a 30 s buffer that would tax the machine. The
 *   default (1.8 s) is a separate, much smaller number — the cap is not the default.
 *
 * WHO CALLS IT
 *   web/audio/chain.js, once at startup and again only when `reverb.decay` actually
 *   changes. Nothing here is per-note: a generator invoked on every control tick
 *   would stall the audio thread, which is the failure mode the plan warns about.
 *
 *   buildImpulseResponse(context, options) -> { buffer, decaySeconds, frames,
 *                                              seconds, channels, buildMs }
 *
 *   It takes the context as an argument, so tests drive it with the fake harness in
 *   tests/effects-fake-audio.mjs and assert on the samples that come back.
 */

export const IR_DECAY_MIN = 0.3;
export const IR_DECAY_MAX = 12;
export const IR_DECAY_DEFAULT = 1.8;
export const IR_CHANNELS = 2;
export const IR_TAPER_SECONDS = 0.01;

/** The envelope falls this many dB over the decay time — RT60 by definition. */
export const IR_TAIL_DB = 60;

/** Force a decay into [0.3 s, 12 s]. A non-finite value falls back to the default. */
export function clampDecaySeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return IR_DECAY_DEFAULT;
  if (seconds < IR_DECAY_MIN) return IR_DECAY_MIN;
  if (seconds > IR_DECAY_MAX) return IR_DECAY_MAX;
  return seconds;
}

/** A clock that exists in both a browser and node. */
function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Build one impulse response.
 *
 *   decaySeconds    requested RT60; clamped to [0.3, 12] before anything is allocated
 *   channels        2 by default: two decorrelated decays, so the tail has width.
 *                   A mono response halves both the memory and the convolution cost
 *                   and is available for a lower-powered machine.
 *   random          the noise source, injectable so tests are reproducible
 *   taperSeconds    length of the linear fade to zero at the end of the buffer, so
 *                   the response never ends on a step (which would click)
 */
export function buildImpulseResponse(context, {
  decaySeconds = IR_DECAY_DEFAULT,
  channels = IR_CHANNELS,
  random = Math.random,
  taperSeconds = IR_TAPER_SECONDS,
} = {}) {
  const decay = clampDecaySeconds(decaySeconds);
  const rate = context.sampleRate;
  const count = Math.max(1, Math.round(decay * rate));
  const channelCount = Math.max(1, Math.round(channels));
  const started = clock();

  const buffer = context.createBuffer(channelCount, count, rate);

  // Amplitude is 20*log10, not 10*log10: one multiply per sample puts the envelope
  // exactly at -IR_TAIL_DB after `count` samples, i.e. at the end of the decay.
  const step = Math.pow(10, -IR_TAIL_DB / 20 / count);
  const taper = Math.min(count - 1, Math.max(0, Math.round(taperSeconds * rate)));

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = buffer.getChannelData(channel);
    let amplitude = 1;
    for (let i = 0; i < count; i += 1) {
      data[i] = (random() * 2 - 1) * amplitude;
      amplitude *= step;
    }
    if (taper > 0) {
      const first = count - taper;
      for (let i = 0; i < taper; i += 1) data[first + i] *= 1 - (i + 1) / taper;
    }
  }

  return {
    buffer,
    /** What the caller asked for, after the clamp. */
    decaySeconds: decay,
    /** What it was actually allowed to be. */
    frames: count,
    seconds: count / rate,
    channels: channelCount,
    /** The measured cost of this build, for the runtime handle and for verification. */
    buildMs: clock() - started,
  };
}