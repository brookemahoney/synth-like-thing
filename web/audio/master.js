/**
 * master.js — the master bus, and the three nodes every other audio task joins.
 *
 * THE CHAIN, AND WHO OWNS WHAT
 *
 *   voice mixers ─┐
 *   drum voices  ─┴─> mixBus ─> masterBus ─> masterOut ─> destination
 *
 *   mixBus      the summing point. Every voice's entry point and (task 9) every
 *               drum voice connects here. Nothing else in the instrument writes
 *               to the output.
 *   masterBus   the level stage, bound to `global.volume` through the ramp bridge
 *               so a volume drag ramps instead of stepping.
 *   masterOut   the terminal that reaches the speakers. Task 8 inserts its
 *               3-band EQ -> delay -> reverb -> limiter chain BETWEEN masterBus
 *               and masterOut, and terminates the chain into masterOut. That
 *               means the effects chain lands without this file changing and
 *               without any voice being rewired.
 *
 * WHY THE LEVEL STAGE IS BEFORE THE CHAIN
 *   The plan puts master volume before the limiter so that a volume change is
 *   what the limiter protects, rather than something that can push the limiter
 *   into permanent limiting.
 *
 *   MIX_BUS        the summing gain every voice feeds
 *   MASTER_BUS     the gain bound to global.volume
 *   MASTER_OUT     the node the effects chain terminates into
 *   destination    the context's real destination
 */

import { audioContext } from './context.js';
import { rampBridge } from './ramp.js';
import { store } from '../ui/params.js';
import { createGain } from './nodes.js';

/** The summing point for voices and drums. */
export const mixBus = createGain(audioContext, 'master-mix');

/** Master level. Ramped by the bridge, never assigned at gesture time. */
export const masterBus = createGain(audioContext, 'master-bus');
masterBus.gain.value = store.get('global.volume') ?? 1;

/** The terminal the effects chain ends in. Task 8 fills the space above it. */
export const masterOut = createGain(audioContext, 'master-out');
masterOut.gain.value = 1;

mixBus.connect(masterBus);
masterBus.connect(masterOut);
masterOut.connect(audioContext.destination);

/* The one singleton parameter in the instrument, bound through the bridge that
 * ui/controls.js expects. Every other parameter with more than one AudioParam
 * behind it is fanned out by its own module through audio/automation.js, which
 * uses the same ramp length. */
rampBridge.bind('global.volume', masterBus.gain, { context: audioContext, mode: 'ramp' });

/**
 * A side tap on the signal leaving the chain. Task 13's level meter hangs off
 * this; task 8 terminates its chain INTO masterOut rather than off it.
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