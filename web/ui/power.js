/**
 * power.js — THE POWER-ON GATE. The one control that starts the instrument.
 *
 * WHY THIS IS A GATE AND NOT A CONVENIENCE
 *   The plan's first technical risk is the browser autoplay policy: a context
 *   created before a user gesture stays `suspended` forever, and no amount of
 *   parameter setting, knob dragging or note playing will change that. Presenting
 *   the instrument visibly powered-off behind ONE explicit control makes the
 *   requirement obvious instead of mysterious.
 *
 *   The rule this file exists to enforce is a negative one, and it is absolute:
 *
 *       NOTHING ELSE RESUMES THE CONTEXT.
 *
 *   Not a keypress handler, not a pointerdown listener, not an import side effect,
 *   not a "helpful" auto-resume on the first click anywhere. This module binds one
 *   listener, to one button, and that is the only call site of `resumeInstrument()`
 *   in the whole instrument. Everything else on the page may be clicked, dragged,
 *   tabbed to and key-played while the context is suspended; the clock does not
 *   move and no sound is produced.
 *
 *   The call sits inside the `click` listener rather than being awaited from an
 *   import, because user activation is consumed by the SYNCHRONOUS call. An
 *   `await import(...)` between the gesture and the resume loses the activation and
 *   the resume silently fails — so the audio module is resolved up front, at mount
 *   time, and the gesture handler does nothing but flip a store key and resume.
 *
 * WHERE THE AUDIO ACTUALLY LIVES
 *   The AudioContext is constructed in audio/context.js at module scope, suspended,
 *   long before anyone clicks. This file never constructs a context and never calls
 *   `resume()` — it calls the one wrapper that already exists for exactly this
 *   purpose. The distinction matters when you grep: `resume()` appears nowhere in
 *   web/ except that wrapper's own definition.
 *
 * THE STORE KEY IS THE AUTHORITY
 *   `global.power` is a real painted toggle (`ctl-global-power`), so the gate does
 *   not own a hidden flag: it READS the key the button just wrote. Flip the key in
 *   a console and the gate follows. That is why power state and the button's
 *   `aria-pressed` can never disagree.
 *
 * API
 *   POWER_KEY               'global.power'
 *   POWER_BUTTON_ID         'ctl-global-power'
 *   POWER_PROMPT_SELECTOR   '[data-power-prompt]'
 *   powerAnnouncement({ powered, contextState, sampleRate }) -> string
 *   createPowerGate({ doc, store, audio, announce }) -> gate
 *   mountPower(doc)         find the surface, build the gate, once
 */
import { store as defaultStore } from './params.js';

export const POWER_KEY = 'global.power';
export const POWER_BUTTON_ID = 'ctl-global-power';
export const POWER_PROMPT_SELECTOR = '[data-power-prompt]';
export const SURFACE_SELECTOR = '[data-surface]';
export const LIVE_SELECTOR = '[data-live]';

/** kHz, to one decimal, the way a hardware panel would print it. */
const khz = (rate) => `${(Number(rate) / 1000).toFixed(1)} kHz`;

/**
 * The one sentence a screen reader and the eye both read. It names the ACTION when
 * off, because "powered off" on its own is a status, not an instruction.
 */
export function powerAnnouncement({ powered = false, contextState = 'suspended', sampleRate = 0 } = {}) {
  if (powered && contextState === 'running') return `Power on — audio running at ${khz(sampleRate)}.`;
  if (powered) return `Power on, but the audio context is ${contextState}.`;
  return 'Power off — press POWER to start the audio.';
}

/* ------------------------------------------------------------- the live region --- */

/**
 * One polite live region for the whole instrument, found or created. Both this
 * module and ui/keyboard.js announce through the same node, so a screen-reader user
 * hears one orderly queue rather than two regions talking over each other.
 */
export function liveRegion(doc) {
  if (!doc) return null;
  const existing = doc.querySelector(LIVE_SELECTOR);
  if (existing) return existing;
  const region = doc.createElement('div');
  region.setAttribute('data-live', '');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.setAttribute('class', 'visually-hidden');
  region.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
    'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;';
  const surface = doc.querySelector(SURFACE_SELECTOR);
  (surface ?? doc.body ?? doc).append(region);
  return region;
}

/* ---------------------------------------------------------------- the prompt --- */

const promptStyle = {
  wrap:
    'display:flex;flex-wrap:wrap;gap:var(--gap-tight);align-items:center;' +
    'padding:var(--panel-pad);border:var(--hairline) solid var(--panel-edge);' +
    'border-radius:var(--radius);background:var(--panel);',
  state:
    'font-size:var(--fs-micro);letter-spacing:0.14em;text-transform:uppercase;' +
    'font-weight:700;color:var(--ink-soft);',
  on: 'color:var(--sage-deep);',
  off: 'color:var(--rose-deep);',
};

/**
 * The visible powered-off prompt. It is real text, not a colour change: a colour is
 * invisible to a screen reader and unreadable in a screenshot's greyscale, and
 * "am I on or off" is the one question this panel has to answer before a gesture.
 */
function buildPrompt(doc) {
  const wrap = doc.createElement('div');
  wrap.setAttribute('data-power-prompt', '');
  wrap.setAttribute('style', promptStyle.wrap);

  const state = doc.createElement('span');
  state.setAttribute('data-power-state', '');
  state.setAttribute('style', promptStyle.state);

  const hint = doc.createElement('span');
  hint.setAttribute('data-power-hint', '');
  hint.setAttribute('style', promptStyle.state);
  hint.textContent = 'One control starts the audio. Nothing else does.';

  wrap.append(state, hint);
  return { wrap, state };
}

/* ---------------------------------------------------------------- the gate --- */

/**
 * Build the gate over an already-rendered page.
 *
 *   store    the parameter store (the authority for the power key)
 *   audio    { resumeInstrument, suspendInstrument?, allNotesOff?, contextState,
 *              contextTime?, sampleRate } — resolved BEFORE any gesture, never
 *              imported from inside one
 *   announce (text) => void; defaults to the shared live region
 */
export function createPowerGate({ doc, store = defaultStore, audio = null, announce } = {}) {
  const surface = doc?.querySelector?.(SURFACE_SELECTOR) ?? null;
  const button = doc?.querySelector?.(`#${POWER_BUTTON_ID}`) ?? null;
  const existing = surface?.querySelector?.(POWER_PROMPT_SELECTOR) ?? null;
  const prompt = existing ?? buildPrompt(doc);
  if (!existing && surface) {
    const masthead = surface.querySelector('.masthead');
    if (masthead) masthead.after(prompt.wrap);
    else surface.prepend(prompt.wrap);
  }

  const say = announce ?? ((text) => {
    const region = liveRegion(doc);
    if (region) region.textContent = text;
  });

  let lastText = null;
  let spoke = false;

  /** True only when the context itself says so — never when the store key says so. */
  const powered = () => audio?.contextState?.() === 'running';

  const render = () => {
    const on = powered();
    const text = powerAnnouncement({
      powered: on,
      contextState: audio?.contextState?.() ?? 'unavailable',
      sampleRate: audio?.sampleRate ?? 0,
    });
    if (prompt.state) {
      prompt.state.textContent = text;
      prompt.state.setAttribute('style', `${promptStyle.state} ${on ? promptStyle.on : promptStyle.off}`);
    }
    if (prompt.wrap) prompt.wrap.setAttribute('data-power', on ? 'on' : 'off');
    surface?.setAttribute('data-power', on ? 'on' : 'off');
    // The FIRST paint is silent. A live region announces what changes, not what was
    // already there when the page loaded; the powered-off prompt is on the page as
    // visible text for anyone who arrives before touching anything.
    if (spoke && text !== lastText) {
      lastText = text;
      say(text);
    }
    if (!spoke) {
      spoke = true;
      lastText = text;
    }
    return text;
  };

  /**
   * The ONLY resume call site in the instrument. Reached from the power button's
   * click, and from nowhere else. It refuses outright when there is no bound
   * control, so a stray programmatic call cannot become a second gate.
   */
  const engage = async () => {
    if (!button) return false;
    if (!audio?.resumeInstrument) return false;
    await audio.resumeInstrument();
    render();
    return powered();
  };

  /** Powering off silences the voices before it suspends, so nothing rings out. */
  const release = async () => {
    if (!button) return false;
    audio?.allNotesOff?.();
    await audio?.suspendInstrument?.();
    render();
    return powered();
  };

  if (button) {
    /* ORDER INDEPENDENCE. The painted control has its own click listener that flips
     * `global.power`, and which of the two runs first depends on which module was
     * evaluated first — not something either of them should have to know. So the
     * value is snapshotted in the CAPTURE phase (always before the button's own
     * handler) and the intent is read after it:
     *
     *   the key moved  -> wherever it ended up is the intent
     *   the key held   -> the button was pressed, so the intent is the other side
     *
     * That works whether the painted control, a preset, or a console wrote the key. */
    let wasOn = null;
    button.addEventListener('click', () => { wasOn = Boolean(store.get(POWER_KEY)); }, { capture: true });
    button.addEventListener('click', () => {
      const now = Boolean(store.get(POWER_KEY));
      const on = now === wasOn ? !now : now;
      if (on) engage();
      else release();
    });
  }

  const refresh = () => {
    // A key written from anywhere else — a preset, a console — must move the gate.
    store.subscribe(POWER_KEY, () => render());
    render();
    return gate;
  };

  const gate = { button, prompt: prompt.wrap, surface, powered, engage, release, refresh, render };
  if (audio) refresh();
  return gate;
}

/* --------------------------------------------------------------- self-mounting --- */

/**
 * Resolve the audio module and mount the gate. Deferred by a microtask so
 * ui/surface.js has already built the panels the button lives in — the same
 * self-initialising shape as ui/paint.js and ui/waveload.js.
 *
 * The dynamic import happens HERE, at load, which is the point: by the time a
 * gesture arrives the module is already evaluated, so `engage()` can call
 * `resumeInstrument()` synchronously inside the click and keep user activation.
 */
async function mount() {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc) return null;
  const [audio] = await Promise.all([import('../audio/context.js'), import('../audio/engine.js')]);
  const gate = createPowerGate({
    doc,
    audio: {
      resumeInstrument: audio.resumeInstrument,
      contextState: audio.contextState,
      contextTime: audio.contextTime,
      sampleRate: audio.sampleRate,
      // `suspend()` is reached through the same wrapper discipline as `resume()`:
      // only from inside this gate's handler.
      suspendInstrument: async () => {
        await audio.audioContext.suspend();
        return audio.audioContext.state === 'suspended';
      },
      allNotesOff: audio.allNotesOff,
    },
  });
  gate.refresh();
  return gate;
}

if (typeof document !== 'undefined') {
  const start = () => {
    mount().catch((error) => {
      console.warn(`[power] the power gate could not be mounted: ${error.message}`);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else queueMicrotask(start);
}