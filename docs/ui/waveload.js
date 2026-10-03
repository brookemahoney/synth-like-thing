/**
 * waveload.js — the wavesampler's file input, mounted into the panel that is already
 * there.
 *
 * WHY IT IS ITS OWN MODULE AND WHY IT IS NOT IN surface.js
 *   ui/surface.js declares one control per store key, and every key in the
 *   wavesampler panel is already declared: `wave.table`, `wave.level`, `wave.scan`.
 *   A file input is not a parameter — it has no range, no curve and no value in the
 *   store — so it is not a control, and putting it in the surface manifest would be
 *   claiming otherwise. So this module attaches to the panel surface.js has already
 *   built, finds it by `[data-panel="wave"]`, and adds to the end of it.
 *
 *   It is mounted from audio/engine.js rather than ui/main.js, because main.js is not
 *   this task's file to edit and engine.js is the module that owns the wavesampler.
 *   The mount is deferred by a microtask so surface.js has drawn the panel first —
 *   the same self-initialising shape as ui/paint.js. If a later task takes ownership of
 *   main.js, moving one import line is the whole change.
 *
 * WHAT IT SHOWS
 *   A label, the file input, a way back to the factory wave, and one line of status.
 *   The status line is a live region, so a screen reader hears both "loaded" and the
 *   reason a load failed — which is the difference between a control that silently
 *   does nothing and one that tells you why.
 *
 * STYLING
 *   Every value here is an existing custom property (--sage-deep, --panel, --fs-micro,
 *   --hairline, --radius-paint...). No new colour, no font and no icon file: the site
 *   ships zero binary media and this module does not introduce the first one.
 *
 * NOTHING HERE DECIDES ANYTHING
 *   It calls waveSampler.load() and reports what came back. The slot, the table, the
 *   level and the scan position all belong to the store; the bytes belong to
 *   audio/wavesampler.js.
 *
 *   buildWaveLoad(doc, deps) -> the element, with the wiring done. deps is
 *   { sampler, getContext } so the wiring can be driven without a browser.
 *   mountWaveLoad(doc)      -> find the panel, build, insert, once.
 */

import { waveSampler } from '../audio/wavesampler.js';

const PANEL_SELECTOR = '[data-panel="wave"]';
const FILE_INPUT_ID = 'wave-waveload-file';
const INPUT_ACCEPT = '.wav,audio/wav,audio/x-wav';

const style = {
  wrap: 'display:grid;gap:var(--gap-tight);margin-top:var(--panel-pad);justify-items:start;',
  row: 'display:flex;gap:var(--gap-tight);align-items:center;flex-wrap:wrap;width:100%;',
  legend: 'font-size:var(--fs-micro);letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-soft);',
  input:
    'font-size:var(--fs-small);color:var(--ink);padding:0.15rem 0.3rem;' +
    `border:var(--hairline) solid rgb(var(--sage-deep-rgb) / 0.55);border-radius:var(--radius-paint);` +
    'background:rgb(var(--panel-rgb) / 0.9);font-family:var(--font-ui);',
  button:
    'font-size:var(--fs-micro);letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);' +
    `padding:0.2rem 0.45rem;border:var(--hairline) solid rgb(var(--sage-deep-rgb) / 0.55);` +
    'border-radius:var(--radius-paint);background:rgb(var(--sage-rgb) / 0.28);cursor:pointer;' +
    'font-family:var(--font-ui);',
  status: 'margin:0;font-size:var(--fs-micro);color:var(--ink-faint);font-style:italic;',
  failed: 'margin:0;font-size:var(--fs-micro);color:var(--rose-deep);font-style:italic;',
  caption: 'margin:var(--gap-tight) 0 0;font-size:var(--fs-micro);color:var(--ink-faint);font-style:italic;',
};

/** One line describing what is in the selected slot right now. */
export function describeTable(table, slot) {
  if (!table) return '—';
  const where = `${table.label} · slot ${slot}`;
  return table.kind === 'factory' ? `${where} · generated in the browser` : `${where} · from ${table.sourceName}`;
}

/**
 * The control: a file input, a way back to the factory wave, and a status line.
 * `deps.getContext()` is awaited at load time rather than imported at module scope,
 * so this module stays importable in node and never creates a context by being read.
 */
export function buildWaveLoad(doc, deps = {}) {
  const sampler = deps.sampler ?? waveSampler;
  const getContext = deps.getContext ?? (async () => (await import('../audio/context.js')).audioContext);

  const wrap = doc.createElement('div');
  wrap.className = 'waveload';
  wrap.setAttribute('data-waveload', '');
  wrap.setAttribute('style', style.wrap);

  const row = doc.createElement('div');
  row.setAttribute('style', style.row);

  const label = doc.createElement('label');
  label.className = 'waveload__label';
  label.setAttribute('for', FILE_INPUT_ID);
  label.setAttribute('style', style.legend);
  label.textContent = 'Table .wav';

  const input = doc.createElement('input');
  input.className = 'waveload__input';
  input.id = FILE_INPUT_ID;
  input.type = 'file';
  input.setAttribute('accept', INPUT_ACCEPT);
  input.setAttribute('data-waveload-input', '');
  input.setAttribute('style', style.input);

  const reset = doc.createElement('button');
  reset.className = 'waveload__reset';
  reset.type = 'button';
  reset.setAttribute('data-waveload-reset', '');
  reset.setAttribute('style', style.button);
  reset.textContent = 'Factory';

  row.append(label, input, reset);

  const status = doc.createElement('p');
  status.className = 'waveload__status';
  status.setAttribute('data-waveload-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('style', style.status);

  const caption = doc.createElement('p');
  caption.className = 'waveload__caption';
  caption.setAttribute('style', style.caption);
  caption.textContent = 'Factory tables are generated in the browser. Load a single-cycle .wav to fill this slot.';

  wrap.append(row, status, caption);

  const show = (text, failed = false) => {
    status.textContent = text;
    status.setAttribute('style', failed ? style.failed : style.status);
  };

  const refresh = () => {
    const slot = sampler.slot();
    show(describeTable(sampler.tables().find((row_) => row_.slot === slot), slot));
  };

  input.addEventListener('change', async () => {
    const file = input.files && input.files.length ? input.files[0] : null;
    if (!file) return;
    input.disabled = true;
    show(`Reading ${file.name}…`);
    try {
      const table = await sampler.load(file, { context: await getContext() });
      show(`${table.label} · slot ${sampler.slot()} · ${table.length} points from ${table.sourceName}`);
    } catch (error) {
      // The slot was not touched, so the instrument is still playing whatever it was
      // playing. All this does is say so out loud.
      show(`Not loaded: ${error.message}`, true);
      input.value = '';
    } finally {
      input.disabled = false;
    }
  });

  reset.addEventListener('click', () => {
    sampler.restoreFactory();
    input.value = '';
    refresh();
  });

  refresh();
  wrap.refresh = refresh;
  return wrap;
}

/**
 * Attach the loader to the wavesampler panel, once. Returns the element, or null if
 * the panel is not on the page (which is not an error worth throwing over: the audio
 * still works without the input).
 */
export function mountWaveLoad(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return null;
  const panel = doc.querySelector(PANEL_SELECTOR);
  if (!panel) return null;
  const existing = panel.querySelector('[data-waveload]');
  if (existing) return existing;

  const element = buildWaveLoad(doc);
  const grid = panel.querySelector('.panel__grid');
  if (grid) grid.after(element);
  else panel.append(element);
  return element;
}

/* ------------------------------------------------------------ self-mounting --- */

if (typeof document !== 'undefined') {
  const run = () => {
    if (mountWaveLoad(document)) return;
    // The surface may not be drawn yet if this module were ever reached before
    // ui/surface.js. One retry on the next frame, then give up quietly: the input is a
    // convenience, and an instrument with no file input is still an instrument.
    requestAnimationFrame(() => {
      if (!mountWaveLoad(document)) {
        console.warn(`[waveload] no ${PANEL_SELECTOR} on the page; the file input is not available`);
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else queueMicrotask(run);
}

export { FILE_INPUT_ID, INPUT_ACCEPT, PANEL_SELECTOR };