/**
 * effects.js — the master effects chain as the app has it: one instance, built at
 * import time on the one AudioContext.
 *
 * THE CHAIN, IN THE ORDER THE PLAN STATES
 *
 *   mixBus ─> masterBus ─> EQ ─> delay ─> reverb ─> masterVolume ─> limiter
 *                                                       ─> safetyClip ─> analyser ─> masterOut
 *
 *   The three stages the work order named explicitly come first, in that order: a
 *   three-band EQ, then the delay, then the reverb. Then the safety limiter, the
 *   brickwall behind it, the analyser, then the destination. The delay is upstream of the reverb so
 *   that the delay's taps receive the reverb wash — the Thor reference order, and
 *   the reason the repeats arrive diffused rather than dry.
 *
 * MASTER VOLUME: WHERE THE EXISTING BINDING WENT
 *   Task 3 bound `global.volume` to `masterBus.gain`, and masterBus sits UPSTREAM of
 *   this chain — before the EQ, the delay and the reverb. The plan requires master
 *   volume BEFORE the limiter. So the binding moved: `global.volume` now drives
 *   `masterChain.masterVolume`, a gain node between the reverb and the limiter, and
 *   `masterBus` is a unity summing stage again. The requirement is then satisfied
 *   exactly rather than approximately: what the limiter protects is the level the
 *   player chose, with every effect stage upstream of it, and a volume change moves
 *   the whole output rather than only its post-effects tail. Nothing else changed
 *   about the binding — it is still the ramp bridge, still a ramp, never an
 *   assignment at gesture time. Task 3's `master.js` header records the same thing.
 *
 * WHAT THIS MODULE OWNS
 *   The construction of the chain and the public seam for everything that touches
 *   it. The construction itself lives in chain.js, which takes the context as an
 *   argument so the whole graph can be unit-tested; this file is the singleton, in
 *   the same shape as audio/ramp.js's `rampBridge` and its `createRampBridge`.
 *
 * THE MODULATION SEAMS TASK 7 AND TASK 13 NEED
 *   modulateDelayTime(cents)   the matrix's `delayTime` destination. Cents, ±4800.
 *   modulateReverbSend(amount) the matrix's `reverbSend` destination, 0..1.
 *   syncDelayToTempo(bpm)      task 9's clock, once it exists.
 *   analyser / ANALYSER_FFT_SIZE / readLevels()  the data source for the meter.
 *
 *   Each has ONE write site inside the chain, shared with its own control, so a
 *   gesture and a modulation can never write the same AudioParam from two places.
 *
 * THE CPU GUARD, IN ONE PLACE
 *   The impulse response is generated once here, at import, and again only when
 *   `reverb.decay` actually changes — never per note, never per control tick, which
 *   is what stalls the audio thread. The decay is clamped to 12 s by audio/ir.js, and
 *   a wet/dry mix of zero disconnects the convolver branch from the graph entirely
 *   rather than merely muting it. reverbIrStats() reports all of it.
 */

import { audioContext } from './context.js';
import { rampBridge } from './ramp.js';
import { store } from '../ui/params.js';
import {
  ANALYSER_FFT_SIZE,
  DELAY_FEEDBACK_MAX,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  DELAY_TONE_MAX,
  DELAY_TONE_MIN,
  EQ_BANDS,
  EQ_GAIN_DB,
  IR_REBUILD_DEBOUNCE_MS,
  LIMITER,
  SAFETY_CLIP_CEILING,
  SAFETY_CLIP_KNEE,
  buildSafetyClipCurve,
  REVERB_DAMPING_MAX,
  REVERB_DAMPING_MIN,
  REVERB_PREDELAY_MAX,
  SYNC_BEATS,
  beatsFor,
  createMasterChain,
} from './chain.js';

/** The one chain. Built suspended and silent, like every other node here. */
export const masterChain = createMasterChain(audioContext, { store, bridge: rampBridge });

/** What master.js connects the summing bus to, and what it terminates into. */
export const chainInput = masterChain.input;
export const chainOutput = masterChain.output;

/* --------------------------------------------------------------- the nodes --- */

/** { low, mid, high } — three BiquadFilterNodes, one per lane, in series. */
export const eq = masterChain.eq;

export const delay = masterChain.delay;
export const reverb = masterChain.reverb;

/** The level stage: `global.volume` is bound to THIS, not to the summing bus. */
export const masterVolume = masterChain.masterVolume;

/** The safety compressor. Fast attack, ratio 20, hard knee. */
export const limiter = masterChain.limiter;

/**
 * The one-node brickwall after the limiter: identity below -3.1 dBFS, rolling off
 * towards a ceiling just under full scale, so no input can produce a clipped sample.
 * It is here because measurement put it here — see the LIMITER comment in chain.js:
 * a DynamicsCompressorNode let a peak of 1.35 through when the summing bus was
 * driven to 8.8, and shortening its attack did not help.
 */
export const safetyClip = masterChain.safetyClip;

/**
 * The chain's analyser, and the reading task 13's meter paints.
 *
 * ANALYSER_FFT_SIZE is 2048: a 42.7 ms window at 48 kHz, chosen so an RMS reading
 * is stable at a ~20 fps meter refresh without smearing a note attack. It is fixed
 * here and written nowhere else — changing it changes the time-domain window and
 * invalidates every reading taken against it.
 */
export const analyser = masterChain.analyser;

/* ------------------------------------------------------- the write sites --- */

export const setDelayTime = masterChain.setDelayTime;
export const modulateDelayTime = masterChain.modulateDelayTime;
export const resetDelayTimeModulation = masterChain.resetDelayTimeModulation;
export const syncDelayToTempo = masterChain.syncDelayToTempo;
export const setDelayFeedback = masterChain.setDelayFeedback;
export const setDelayMix = masterChain.setDelayMix;
export const setReverbMix = masterChain.setReverbMix;
export const modulateReverbSend = masterChain.modulateReverbSend;
export const setMasterVolume = masterChain.setMasterVolume;

/** { rms, peak } over the analyser's window. The RMS/peak source for task 13. */
export const readLevels = masterChain.readLevels;

/** The rebuild policy, and what it has cost so far. */
export const reverbIrStats = masterChain.reverbIrStats;
export const flushIrRebuild = masterChain.flushIrRebuild;

/**
 * The constructed effect-node inventory task 13's runtime handle reports:
 * [{ label, kind, feeds: [...] }] in signal order, with the delay's feedback loop
 * and the reverb's bypass visible as what they are.
 */
export const effectNodes = masterChain.nodeInventory;

export {
  ANALYSER_FFT_SIZE,
  DELAY_FEEDBACK_MAX,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  DELAY_TONE_MAX,
  DELAY_TONE_MIN,
  EQ_BANDS,
  EQ_GAIN_DB,
  IR_REBUILD_DEBOUNCE_MS,
  LIMITER,
  SAFETY_CLIP_CEILING,
  SAFETY_CLIP_KNEE,
  buildSafetyClipCurve,
  REVERB_DAMPING_MAX,
  REVERB_DAMPING_MIN,
  REVERB_PREDELAY_MAX,
  SYNC_BEATS,
  beatsFor,
};