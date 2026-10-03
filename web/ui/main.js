/**
 * main.js — the page's entry point, and nothing else.
 *
 * Import order is load-bearing. Importing `../audio/ramp.js` is what subscribes
 * the parameter store to the ramp bridge, so every continuous parameter a
 * gesture touches is applied as a short scheduled ramp rather than a step at
 * gesture time. It has to happen before the first control exists, and before any
 * engine binds its AudioParams.
 *
 * No global is published from here. Later tasks add their engines to this
 * module; the inspection handle belongs to the module that owns it.
 */
import '../audio/ramp.js';
import { buildSurface } from './surface.js';

buildSurface();
