/**
 * automation.js — the scheduled-automation primitive for PARAMETERS THAT HAVE
 * MORE THAN ONE AudioParam.
 *
 * WHY THIS EXISTS ALONGSIDE audio/ramp.js
 *   ui/controls.js declares how a gesture is applied, and ramp.js decides
 *   continuous-vs-switch and drives the one AudioParam bound to a store key. That
 *   is the right shape for a singleton parameter like master volume.
 *
 *   A per-voice parameter has the opposite shape: one store key, up to
 *   sixteen AudioParams — three core levels times sixteen voices, plus every
 *   pitch-affecting key. A bridge with one param per key cannot express a
 *   fan-out, so this module is the same primitive used over a list: hold the
 *   in-flight ramp, then ramp. Same RAMP_SECONDS, same cancel-and-hold, so the
 *   two paths cannot drift into different behaviour, and neither path ever writes
 *   a value at gesture time.
 *
 *   rampTo(param, value, context[, seconds])   hold the current value, ramp to `value`
 *   setNow(param, value, context)              a scheduled instant write
 *   rampAll(items, apply, context[, seconds])  fan `apply` out over a list
 *
 * WHY HOLD-THEN-RAMP
 *   Assigning `param.value` during a pointer drag steps the parameter once per
 *   pointer event, which is audible as zipper noise. `setTargetAtTime` gives a
 *   smoother exponential approach; a held linear ramp is the short, predictable
 *   version of the same idea and matches what ramp.js does, so a gesture feels
 *   identical whether it is moving the master volume or one core's level.
 */

/** The ramp length, shared with ramp.js so both paths agree on "short". */
export { RAMP_SECONDS } from './ramp.js';
import { RAMP_SECONDS } from './ramp.js';

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

/** The context time a write should be scheduled against. */
function now(context, at) {
  return Number.isFinite(at) ? at : context.currentTime;
}

/** Keep whatever is in flight, then ramp to `value`. The continuous path. */
export function rampTo(param, value, context, { at, seconds = RAMP_SECONDS } = {}) {
  if (!param || !context) return false;
  const t = now(context, at);
  const v = finite(value);
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
  else param.cancelScheduledValues(t);
  param.linearRampToValueAtTime(v, t + seconds);
  return true;
}

/**
 * A scheduled instant write. Used while a voice is silent — at note-on, where
 * there is no signal to click — so nothing is heard step.
 */
export function setNow(param, value, context, { at } = {}) {
  if (!param || !context) return false;
  param.setValueAtTime(finite(value), now(context, at));
  return true;
}

/**
 * Apply one change across many params — one store key, sixteen voices.
 * `apply(param, item, index)` decides what is written; every param is written the
 * same way, so a control cannot accidentally ramp on one voice and step on
 * another.
 */
export function rampAll(items, apply, context, options = {}) {
  let applied = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (apply(items[index], index, context, options)) applied += 1;
  }
  return applied;
}