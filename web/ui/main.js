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
 *
 * No global is published from here. The inspection handle belongs to the module
 * that owns it (task 13); until then, anything that needs the engine imports
 * `../audio/engine.js` and gets the same singleton instance.
 */
import '../audio/ramp.js';
import { buildSurface } from './surface.js';
import '../audio/engine.js';

buildSurface();