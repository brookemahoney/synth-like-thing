/**
 * main.js — the page's entry point, and nothing else.
 *
 * Import order is load-bearing.
 *
 *   1. '../audio/ramp.js' subscribes the parameter store to the ramp bridge, so
 *      every continuous parameter a gesture touches is applied as a short
 *      scheduled ramp rather than a step at gesture time. It has to happen before
 *      any engine binds its AudioParams.
 *   2. './surface.js' draws the controls: one painted control per store key, all
 *      built from the same schema the audio reads.
 *   3. '../audio/engine.js' owns the AudioContext, the shared noise buffer, the
 *      master bus, the sixteen-voice pool and the note-event path. Importing it
 *      builds the graph — suspended, silent and idle — so nothing has to handle a
 *      context that does not exist yet. Nothing here resumes it: that is task 11's
 *      power-on gesture, and it is the only place a resume may happen.
 *   4. '../audio/drums.js' is LOAD-BEARING, and it has no exports this file calls.
 *      Importing it is the whole of its job here, so it must stay a plain static
 *      side-effect import on this list:
 *        - the drum kit is built on the real AudioContext and the real `mixBus`, so
 *          the eleven voices are only in the graph if this module has been evaluated;
 *        - it owns `global.run` → the clock singleton, which is the instrument's ONE
 *          timer and the transport the RUN button starts. Without it the RUN button
 *          flips a key nobody listens to and the page is inert;
 *        - it is task 8's tempo callback: the clock's `onTempo` is what wires
 *          `syncDelayToTempo`, so the delay chain is un-synced without it either.
 *      It is a side-effect import rather than a binding import on purpose: nothing in
 *      this file consumes a return value, and a bare specifier is the one form a
 *      bundler or minifier has no reason to treat as an unused binding and drop.
 *      tests/drums-wiring.test.mjs asserts this import exists, so the kit cannot
 *      quietly leave the shipped graph again — which is exactly what happened when
 *      task 9 was verified by dynamically importing the module instead.
 *
 * No global is published from here. The inspection handle belongs to the module
 * that owns it (task 13); until then, anything that needs the engine imports
 * `../audio/engine.js` and gets the same singleton instance.
 */
import '../audio/ramp.js';
import { buildSurface } from './surface.js';
import '../audio/engine.js';
import '../audio/drums.js';

buildSurface();