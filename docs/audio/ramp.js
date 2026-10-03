/**
 * ramp.js — the single place a parameter store value reaches a live AudioParam,
 * and the only place continuous-vs-switch behaviour is decided.
 *
 * WHY IT EXISTS
 *   Assigning `AudioParam.value` during a pointer gesture steps the parameter
 *   per event and clicks audibly (zipper noise). Continuous parameters are
 *   therefore always applied as a SHORT SCHEDULED RAMP; only switch-like
 *   parameters are assigned directly. ui/controls.js declares which kind of
 *   write a gesture is (`store.set(key, value, { apply })`); this module is
 *   what honours it, so no control and no audio module ever touches an
 *   AudioParam directly.
 *
 * API
 *   rampBridge.bind(key, audioParam, { context, mode })    mode: 'ramp'|'direct'
 *   rampBridge.bindNodeParam(key, node, propName, { mode }) context from node.context
 *   rampBridge.unbind(key) / .keys() / .mode(key) / .dispose()
 *   rampBridge.apply(key, value, mode?)  one-shot, for callers outside a store write
 *   createRampBridge(store, { seconds })  an isolated bridge (tests)
 *   rampBridge  the app-wide bridge, already subscribed to the shared store
 *   RAMP_SECONDS  the default ramp length (20 ms)
 *
 * NOTES
 *   - `context` is required because an AudioParam does not expose its own
 *     context; bindNodeParam supplies it from the node.
 *   - cancelAndHoldAtTime is used where available so an in-flight ramp keeps its
 *     current value; elsewhere it degrades to cancelScheduledValues.
 *   - Boolean values are applied as 0/1. Enum/array/string keys have no numeric
 *     AudioParam binding: a module that needs one subscribes itself and maps the
 *     value (e.g. filter type) however it likes.
 *   - Nothing here is audio-specific beyond the AudioParam shape, so this module
 *     is importable in plain node (see tests/ramp.test.mjs).
 */
import { store } from '../ui/params.js';

/** Default ramp length, seconds. Short enough to feel immediate, long enough
 *  to avoid a step per pointer event. */
export const RAMP_SECONDS = 0.02;

const num = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function createRampBridge(store, { seconds = RAMP_SECONDS } = {}) {
  /** key -> { param, context, mode } */
  const bindings = new Map();

  function apply(key, value, mode) {
    const binding = bindings.get(key);
    if (!binding) return false;
    const { param, context, mode: boundMode } = binding;
    const v = num(value);
    if (v === null || !context) return false;
    const how = mode ?? boundMode;
    const now = context.currentTime;
    if (how === 'direct') {
      param.setValueAtTime(v, now);
      return true;
    }
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
    param.linearRampToValueAtTime(v, now + seconds);
    return true;
  }

  const unsubscribe = store.subscribeAll((key, value, _previous, meta) => apply(key, value, meta?.apply));

  const bridge = {
    bind(key, audioParam, { context, mode = 'ramp' } = {}) {
      bindings.set(key, { param: audioParam, context, mode });
      return bridge;
    },
    bindNodeParam(key, node, prop = 'value', { mode = 'ramp' } = {}) {
      return bridge.bind(key, node[prop], { context: node.context, mode });
    },
    unbind(key) {
      bindings.delete(key);
      return bridge;
    },
    keys: () => [...bindings.keys()],
    mode: (key) => bindings.get(key)?.mode,
    apply,
    dispose: unsubscribe,
  };

  return bridge;
}

/** The app-wide bridge: importing this module is what wires the store to audio. */
export const rampBridge = createRampBridge(store);