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
 *   5. '../audio/sequencer-run.js' — TASK 010'S LINE, LOAD-BEARING. It binds the 16-step
 *      sequencer, the four patterns, the chain and the arpeggiator to the clock above, the
 *      kit above and task 3's note path, and constructs the sequencer that subscribes to
 *      the clock's steps. Nothing in this file calls into it, so it is a bare
 *      side-effect import for the same reason the kit's is: a binding import would be an
 *      unused binding and a minifier could drop it. WITHOUT IT THE WHOLE SEQUENCER AND
 *      ARPEGGIATOR ARE ABSENT from the delivered page while a probe that dynamically
 *      imports the module still passes every check — the exact gap
 *      tests/drums-wiring.test.mjs was written for. tests/sequencer.test.mjs asserts this
 *      line exists.
 *   6. '../audio/modulation.js' — TASK 007'S LINE. This, not `../audio/matrix.js`, is the
 *      module that STARTS the modulation: it builds the three LFOs, the 8x8 matrix and the
 *      matrix panel, and calls `startModulation()` at module scope. `matrix.js` on its own
 *      is pure routing arithmetic and mounts nothing, so importing it would wire the graph
 *      without ever switching it on. It mounts its panel on DOMContentLoaded, which is why
 *      it survives the surface being drawn after this module graph has been evaluated.
 *   7. './sequencer-view.js' — TASK 010'S PANEL BEHAVIOUR: the lane grid's clicks and
 *      drags, the chain slots and the playhead attribute. Self-initialising like
 *      ui/paint.js, and it must come after step 5 because its chain-slot click calls the
 *      sequencer's ONE implementation of the order's rules.
 *
 * No global is published from here. The inspection handle belongs to the module
 * that owns it (task 13); until then, anything that needs the engine imports
 * `../audio/engine.js` and gets the same singleton instance.
 */
import '../audio/ramp.js';
import { buildSurface } from './surface.js';
import '../audio/engine.js';
import '../audio/drums.js';
import '../audio/sequencer-run.js';
import '../audio/modulation.js';
import './sequencer-view.js';

buildSurface();