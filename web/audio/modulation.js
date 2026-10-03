/**
 * modulation.js — THE ONE PLACE TASK 7 MEETS THE INSTRUMENT.
 *
 * lfo.js and matrix.js are deliberately free of any import from the audio graph:
 * that is what lets tests/lfo.test.mjs drive three LFOs on a fake AudioContext and
 * tests/matrix.test.mjs sum sixty-four routes over a fake voice pool, with no
 * browser and no audio device. This file is where they meet the real thing — the
 * real context, the real store, the real clock and the real master chain — in the
 * same shape audio/drums.js uses for the clock and the kit.
 *
 *   context.js   the ONE AudioContext, created suspended
 *   params.js    the store every key is read from
 *   drums.js     the clock singleton: THE transport and the only timer
 *   effects.js   the master chain's two modulation seams, and their one write sites
 *   engine.js    the voice pool the per-voice destinations are applied to
 *   lfo.js       three LFOs
 *   matrix.js    sixty-four routes, one vector, eight application points
 *
 * THE BLOCK IS A CLOCK SUBSCRIPTION, AND THAT IS THE WHOLE OF IT
 *   `clock.subscribeToSteps` is the finest event the one clock publishes, so it is
 *   the block. This file owns no timer and schedules nothing: a block reads the
 *   three LFO values NOW and applies the summed vector NOW as a short ramp, which
 *   is why it uses no lookahead — a value sampled 100 ms early and applied 100 ms
 *   late would be half a cycle out of phase with an LFO at 5 Hz.
 *
 *   Two consequences, both deliberate and both the plan's own constraints:
 *
 *     - the matrix moves with the transport, because the transport is the clock.
 *       `global.run` is what starts it and nothing here starts it for the player.
 *       A cell written while the transport is stopped still applies at once,
 *       because a store write re-blocks directly (matrix.js subscribes) — that is
 *       an event, not a second clock.
 *     - the block is 125 ms at 120 BPM, so an LFO above about 4 Hz is stepped. The
 *       plan lists this coarseness as a limitation to document and not to fix, and
 *       fixing it would need either a second timer (forbidden by the single-clock
 *       rule and by tests/clock.test.mjs) or an AudioWorklet (excluded).
 *
 * THE MASTER STAGE IS WRITTEN THROUGH EFFECTS.JS'S OWN SEAMS
 *   `delayTime` and `reverbSend` are one node each, so they are written ONCE per
 *   block from the mean of the sounding voices (see matrix.js for why the mean and
 *   not the loudest). The two entries below are the two master write sites, and
 *   they call the chain's own single write sites rather than touching a gain.
 *
 * SELF-INITIALISING
 *   The audio rig is built at import, because a suspended context costs nothing and
 *   the graph's shape must not depend on what the page has drawn. The PANEL is
 *   mounted on DOMContentLoaded, because ui/main.js runs buildSurface() AFTER its
 *   static imports are evaluated and the matrix grid is drawn by that call. A
 *   deferred module script is evaluated while readyState is still 'interactive', so
 *   'loading' is not the right test to wait on and mounting immediately paints the
 *   panel into a document that has not been drawn — see `mountWhenReady`.
 *
 *   Task 10 (or 11) needs exactly one line in web/ui/main.js:
 *
 *       import '../audio/modulation.js';
 *
 *   which self-initialises. If a call is preferred over a side-effect import,
 *   `startModulation()` is exported and does the same work idempotently.
 *
 * API
 *   lfos / matrix        the bank and the rig
 *   startModulation()    build everything, hook the clock; safe to call again
 *   modulationState()    a snapshot: blocks, voices, sources, routes, the panel
 *   stopModulation()     unhook the clock, for diagnostics and tests
 */

import { audioContext, sampleRate } from './context.js';
import { store } from '../ui/params.js';
import { clock } from './drums.js';
import { modulateDelayTime, modulateReverbSend } from './effects.js';
import { voiceEngine } from './engine.js';
import { createLfoBank } from './lfo.js';
import { APPLICATION_POINTS, buildMatrixPanel, createModulation, MATRIX_CELL_COUNT, mountWhenReady } from './matrix.js';

/**
 * THE MASTER SEAM: two entries, one per master destination, each delegating to the
 * chain's own single write site. Nothing here writes an AudioParam.
 */
const MASTER_SEAM = {
  delayTime: (cents, options) => modulateDelayTime(cents, options),
  reverbSend: (amount, options) => modulateReverbSend(amount, options),
};

let lfos = null;
let matrix = null;
let panel = null;
let offSteps = null;
let offTempo = null;

function ensureRig() {
  if (lfos && matrix) {
    wireClock();
    return { lfos, matrix };
  }

  /**
   * Three LFOs on the real context, reading the real store, following the real
   * tempo. `bpm` is a function of the clock's own value, so a synced LFO is on the
   * transport's beat and not on a copy of it.
   */
  lfos = createLfoBank({ context: audioContext, read: store.get, subscribe: store.subscribe, bpm: () => clock.tempo() });

  matrix = createModulation({
    context: audioContext,
    read: store.get,
    subscribe: store.subscribe,
    voices: () => voiceEngine.voices(),
    sampleRate,
    bank: lfos,
    master: MASTER_SEAM,
  });

  wireClock();

  return { lfos, matrix };
}

/**
 * THE CLOCK WIRING, AND WHY IT IS ITS OWN FUNCTION.
 *
 *   `offSteps` and `offTempo` are the ONLY things `stopModulation()` clears, so the
 *   rig itself — the LFOs, the matrix, the panel and the store subscription that
 *   re-blocks on a cell write — survives a stop. That is what makes the pair
 *   `stopModulation()` / `startModulation()` mean STOP and START rather than TEAR DOWN
 *   and REBUILD: before this was its own function, `ensureRig()` returned the existing
 *   rig early and the clock subscription was never restored, so a restart silently left
 *   the rig dead and every measurement taken "with modulation back on" was really taken
 *   with modulation off.
 *
 *   Rebuilding instead would be worse than fixing it: a rebuilt LFO bank makes three
 *   new oscillators that nothing stops, and `stopModulation` exists for diagnostics.
 */
function wireClock() {
  if (offSteps || offTempo) return false;
  /* THE BLOCK. One subscription, one function, no arguments it needs. */
  offSteps = clock.subscribeToSteps(() => matrix.block());

  /* A tempo change is an EVENT, so the synced LFOs re-derive their rates on it
     rather than polling a tempo they could be out of step with. */
  offTempo = clock.subscribeToTempo(() => lfos.refresh());
  return true;
}

function mountPanel() {
  if (panel) return panel;
  panel = buildMatrixPanel({ doc: globalThis.document, store });
  return panel;
}

/**
 * Build everything. Idempotent, and callable from a gesture or from an import; the
 * DOM half waits for the surface if the document is not ready.
 */
export function startModulation() {
  const rig = ensureRig();
  /* `mountWhenReady` waits for DOMContentLoaded unless the page is already loaded,
     which is the only correct test: a deferred module script is evaluated while
     readyState is 'interactive', so anything that mounts on 'interactive' — or on
     anything other than 'complete' — paints the panel before buildSurface() has
     drawn the grid it belongs to. */
  mountWhenReady(globalThis.document, mountPanel);
  return rig;
}

/**
 * Unhook the clock. Diagnostics and tests only — the app never calls it.
 *
 * It unhooks the CLOCK, and nothing else: the rig, its store subscription and the panel
 * all stay, which is what `startModulation()` restores the block from. So a cell write
 * still re-blocks while stopped — the honest behaviour for a diagnostic that wants to
 * move one cell and hear it — and `startModulation()` is an exact inverse rather than a
 * rebuild. (It was disposing the rig as well, and `ensureRig()` then returned the
 * existing rig without re-subscribing, so the pair never actually restarted.)
 */
export function stopModulation() {
  offSteps?.();
  offTempo?.();
  offSteps = null;
  offTempo = null;
}

/**
 * Everything a read-out, an inspection panel or a verification step needs, in one
 * immutable object: which block ran last, how many voices it reached, what the
 * three global sources read, what every route is currently contributing, and
 * whether the panel is mounted.
 */
export function modulationState() {
  const rig = ensureRig();
  const sounding = rig.matrix.active() > 0 ? 0 : null;
  const routes = {};
  for (const row of APPLICATION_POINTS) {
    routes[row.destination] = sounding === null && row.scope === 'master'
      ? rig.matrix.route(row.destination)
      : rig.matrix.route(row.destination, sounding ?? 0);
  }
  return Object.freeze({
    blocks: rig.matrix.blocks(),
    voices: rig.matrix.active(),
    clock: Object.freeze(clock.state()),
    lfos: rig.lfos.state().map((state) => Object.freeze(state)),
    sources: Object.freeze(rig.lfos.sourceValues()),
    vectors: rig.matrix.vectors(),
    routes: Object.freeze(routes),
    panelCells: panel?.cells.length ?? 0,
    panelMounted: Boolean(panel),
    cellCount: MATRIX_CELL_COUNT,
  });
}

/** The mounted panel, or null before the surface exists. */
export function modulationPanel() {
  return panel;
}

startModulation();

export { lfos, matrix };
