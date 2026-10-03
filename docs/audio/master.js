/**
 * master.js — the master bus, and the three nodes every other audio task joins.
 *
 * THE CHAIN, AND WHO OWNS WHAT
 *
 *   voice mixers ─┐
 *   drum voices  ─┴─> mixBus ─> masterBus ─> chainInput ─> chainOutput ─> masterOut ─> destination
 *
 *   mixBus      the summing point. Every voice's entry point and (task 9) every
 *               drum voice connects here. Nothing else in the instrument writes
 *               to the output.
 *   masterBus   a unity summing stage. It used to be the level stage: task 3 bound
 *               `global.volume` to its gain, with a ramp so a volume drag would not
 *               step. Task 8 needs master volume BEFORE the limiter, and the
 *               limiter lives inside the effects chain, so the binding moved
 *               downstream to `masterVolume` — the node the chain places between
 *               the reverb and the limiter. This one is back to being a plain sum.
 *               See the header of audio/effects.js for the full reasoning.
 *   chainInput  the head of the chain task 8 owns: 3-band EQ, delay, reverb,
 *               master volume, limiter, analyser.
 *   chainOutput the tail of that chain — the analyser, the last node before the
 *               speakers.
 *   masterOut   the terminal that reaches the speakers, and the side tap task 13's
 *               level meter hangs off.
 *
 * WHY THE CHAIN LANDS WITHOUT ANY VOICE BEING REWIRED
 *   Task 3 deliberately left masterOut as a node to terminate into rather than
 *   pointing masterBus straight at the destination. Task 8's chain sits between
 *   masterBus and masterOut, so the effects arrive with no change to any voice, no
 *   change to any entry point, and no second path to the speakers.
 *
 *   MIX_BUS        the summing gain every voice feeds
 *   MASTER_BUS     the unity sum between the voices and the chain
 *   CHAIN_INPUT    audio/effects.js — the effects chain's head
 *   CHAIN_OUTPUT   audio/effects.js — the effects chain's tail
 *   MASTER_OUT     the node the chain terminates into, and the meter's tap
 *   destination    the context's real destination
 */

import { audioContext } from './context.js';
import { chainInput, chainOutput } from './effects.js';
import { createGain } from './nodes.js';

/** The summing point for voices and drums. */
export const mixBus = createGain(audioContext, 'master-mix');

/**
 * A unity summing stage. `global.volume` is NOT bound to it any more: master volume
 * has to sit before the limiter, and the limiter lives inside the effects chain, so
 * the binding now lives on `masterVolume` in audio/effects.js, downstream of the
 * reverb. It stays a real node rather than being deleted so every voice's entry
 * point keeps a stable parent.
 */
export const masterBus = createGain(audioContext, 'master-bus');
masterBus.gain.value = 1;

/** The terminal the effects chain ends in. */
export const masterOut = createGain(audioContext, 'master-out');
masterOut.gain.value = 1;

mixBus.connect(masterBus);
masterBus.connect(chainInput);
chainOutput.connect(masterOut);
masterOut.connect(audioContext.destination);

/**
 * A side tap on the signal leaving the chain. Task 13's level meter hangs off this.
 * It is parallel to the destination, so a meter connected here does not change what
 * the speakers receive — and an analyser connected here but not connected onward
 * reads zero, which is why the tap returns the node and expects the caller to
 * terminate it.
 */
export function connectToOutput(node) {
  masterOut.connect(node);
  return node;
}

/** Disconnect a node from that tap. Used by verification, not by the app. */
export function disconnectFromOutput(node) {
  try {
    masterOut.disconnect(node);
  } catch {
    /* not connected */
  }
}