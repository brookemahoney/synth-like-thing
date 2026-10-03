/**
 * preset-view.js — THE PRESET PANEL: twelve slot buttons, save/load/delete, a next-empty
 * slot, the init patch, and JSON export and import. Self-initialising, the same shape as
 * ui/paint.js, ui/power.js, ui/keyboard.js and ui/waveload.js, so web/index.html needs
 * nothing for it beyond one <script> tag.
 *
 * WHY IT IS ITS OWN MODULE AND WHY IT IS NOT IN surface.js
 *   ui/surface.js declares one painted control per store key, and every key is already
 *   declared. A slot is not a parameter: it has no range, no curve and no value in the
 *   store — it is a place a document can be put. So this module attaches to the panel
 *   surface.js has already built (`[data-panel="master"]`, the global strip) and adds to
 *   the end of it, exactly as ui/waveload.js attaches to the wavesampler panel.
 *
 * WHAT IT DOES AT LOAD TIME, AND WHY IT IS HERE RATHER THAN IN audio/presets.js
 *   The restore needs the sequencer, because the four patterns live in it. So this module
 *   attaches the live singletons to the preset system and asks for the restore once, at
 *   module scope, before it builds anything a person can see. Two consequences worth
 *   stating:
 *
 *     - the store is already patched when this module runs, so a control drawn afterwards
 *       reads the restored value and a control drawn before it is already subscribed
 *       (ui/controls.js subscribes per key), and the page looks the same either way;
 *     - `audio/presets.js` itself imports no audio graph at all, which is why it can be
 *       tested in node without an AudioContext. See its module header.
 *
 *   A restore that fails is not hidden. The outcome of the page-load restore is put in the
 *   status line BEFORE the panel is built, in the same vocabulary `presets.failures()`
 *   uses — so "your patch did not come back, and here is why" is on the page rather than in
 *   a console nobody opens — and the meta line always carries the last recorded failure.
 *
 * THE STATUS LINE IS A LIVE REGION
 *   Every action's outcome goes into one `role="status"` element. This is the difference
 *   between a control that silently does nothing and one that tells you why — which is the
 *   risk the plan names for this whole task. It says, for each action, either what
 *   happened or the recorded reason: `saved to slot 3 (13.4 kB)`, or
 *   `not saved — quota-exceeded: QuotaExceededError … 31384 bytes refused`.
 *
 * "EDITED" IS A FACT ABOUT THE INSTRUMENT, NOT ABOUT THE SLOT
 *   Loading copies a patch in; it does not link the slot to the knobs (see the live-editing
 *   decision in audio/presets.js). So after a load the marker goes to "edited" as soon as
 *   a gesture writes the store, and it is a statement of fact: what you hear is no longer
 *   what is in that slot, and SAVE is the only thing that changes that.
 *
 * STYLING
 *   Every value here is an existing custom property (--sage-deep, --panel, --fs-micro,
 *   --hairline, --radius-paint...). No new colour, no font, no icon file: the site ships
 *   zero binary media and this module does not introduce the first one.
 *
 *   buildPresetPanel(doc, deps) -> the element, wired. deps is { presets, status } so the
 *   whole panel can be driven without a browser; `status` is `{ text, failed }` and is how
 *   the page-load restore's outcome reaches the status line.
 *   mountPresetPanel(doc)     -> find the master panel, build, insert, once.
 */

import { presets } from '../audio/presets.js';
import { sequencer } from '../audio/sequencer-run.js';
import { waveSampler } from '../audio/wavesampler.js';
import { store as defaultStore } from './params.js';

const PANEL_SELECTOR = '[data-panel="master"]';
const NAME_INPUT_ID = 'preset-name';
const FILE_INPUT_ID = 'preset-import-file';
const INPUT_ACCEPT = '.json,application/json';

/** Store writes that are a person editing the instrument, rather than the instrument
 *  writing its own state (the playhead, a pattern switch by the chain). */
const EDIT_SOURCES = new Set(['control', 'keyboard']);

/** One kB, because a byte count in a status line means nothing without a scale. */
const kB = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

const style = {
  wrap: 'display:grid;gap:var(--gap-tight);margin-top:var(--panel-pad);',
  slots: 'display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--gap-tight);',
  slot:
    'font-family:var(--font-ui);font-size:var(--fs-micro);letter-spacing:0.04em;padding:0.3rem 0.1rem;'
    + 'border:var(--hairline) solid rgb(var(--sage-deep-rgb) / 0.5);border-radius:var(--radius-paint);'
    + 'background:rgb(var(--panel-rgb) / 0.85);color:var(--ink-soft);cursor:pointer;min-height:2.1rem;',
  slotFilled: 'background:rgb(var(--sage-rgb) / 0.3);color:var(--ink);border-color:rgb(var(--sage-deep-rgb) / 0.75);',
  slotCurrent: 'box-shadow:inset 0 0 0 2px rgb(var(--sage-deep-rgb) / 0.9);color:var(--ink);',
  row: 'display:flex;gap:var(--gap-tight);align-items:center;flex-wrap:wrap;',
  button:
    'font-family:var(--font-ui);font-size:var(--fs-micro);letter-spacing:0.06em;text-transform:uppercase;'
    + 'color:var(--ink);padding:0.25rem 0.5rem;border:var(--hairline) solid rgb(var(--sage-deep-rgb) / 0.55);'
    + 'border-radius:var(--radius-paint);background:rgb(var(--sage-rgb) / 0.22);cursor:pointer;',
  name:
    'font-family:var(--font-ui);font-size:var(--fs-small);color:var(--ink);padding:0.2rem 0.35rem;'
    + 'min-width:9rem;border:var(--hairline) solid rgb(var(--sage-deep-rgb) / 0.55);'
    + `border-radius:var(--radius-paint);background:rgb(var(--panel-rgb) / 0.9);`,
  status: 'margin:0;font-size:var(--fs-micro);color:var(--ink-soft);font-style:italic;',
  failed: 'margin:0;font-size:var(--fs-micro);color:var(--rose-deep);font-style:italic;',
  meta: 'margin:0;font-size:var(--fs-micro);color:var(--ink-faint);font-style:italic;',
};

/**
 * The panel. `deps.presets` is the preset system, so every button here is a thin wrapper
 * over one call and nothing in this module decides anything about a patch.
 */
export function buildPresetPanel(doc, deps = {}) {
  const system = deps.presets ?? presets;
  const store = deps.store ?? defaultStore;
  const makeUrl = deps.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));

  const wrap = doc.createElement('div');
  wrap.className = 'preset-panel';
  wrap.setAttribute('data-preset-panel', '');

  /* --- the twelve slots --- */
  const slots = doc.createElement('div');
  slots.className = 'preset-slots';
  slots.setAttribute('style', style.slots);
  slots.setAttribute('role', 'group');
  slots.setAttribute('aria-label', 'Preset slots');
  const slotButtons = new Map();
  for (const row of system.slots()) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.presetSlot = String(row.id);
    button.setAttribute('style', style.slot);
    button.textContent = String(row.id);
    button.addEventListener('click', () => selectSlot(row.id));
    slotButtons.set(row.id, button);
    slots.append(button);
  }
  wrap.append(slots);

  /* --- the actions --- */
  const row = doc.createElement('div');
  row.setAttribute('style', style.row);

  const name = doc.createElement('input');
  name.id = NAME_INPUT_ID;
  name.type = 'text';
  name.placeholder = 'Patch name';
  name.setAttribute('data-preset-name', '');
  name.setAttribute('aria-label', 'Patch name');
  name.setAttribute('style', style.name);

  const action = (text, handler, testid) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset[testid] = '';
    button.setAttribute('style', style.button);
    button.addEventListener('click', handler);
    row.append(button);
    return button;
  };

  const save = action('Save', () => {
    const id = selected;
    const result = report(system.save(id, { name: wantedName() }), (r) => `Saved to slot ${id}${r.document.name !== `Patch ${id}` ? ` as “${r.document.name}”` : ''} (${kB(r.bytes)}).`);
    if (result.ok) selectSlot(system.current() ?? id);
    return result;
  }, 'presetSave');
  const load = action('Load', () => report(system.load(selected), (r) => `Loaded slot ${r.slot} — ${r.document.name}.`), 'presetLoad');
  const del = action('Delete', () => {
    const id = selected;
    const result = report(system.remove(id), (r) => (r.removed ? `Deleted slot ${id}.` : `Slot ${id} was already empty.`));
    selectSlot(system.current() ?? system.nextEmptySlot() ?? id);
    return result;
  }, 'presetDelete');
  action('Next', () => {
    const next = system.nextEmptySlot();
    if (next === null) return say('Every slot has a patch in it.', false);
    selectSlot(next);
    return say(`Slot ${next} selected.`);
  }, 'presetNext');
  action('Init', () => report(system.reset(), () => 'Init patch loaded.'), 'presetInit');
  const exportButton = action('Export', () => doExport(), 'presetExport');

  const importInput = doc.createElement('input');
  importInput.id = FILE_INPUT_ID;
  importInput.type = 'file';
  importInput.accept = INPUT_ACCEPT;
  importInput.setAttribute('data-preset-import', '');
  importInput.setAttribute('aria-label', 'Import a preset');
  importInput.setAttribute('style', style.name);
  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files.length ? importInput.files[0] : null;
    if (!file) return;
    try {
      const id = selected;
      const result = report(system.importText(await file.text(), { slot: id }), (r) => `Imported into slot ${id} — ${r.document.name} (${kB(JSON.stringify(r.document).length)}).`);
      if (result.ok) selectSlot(system.current() ?? id);
    } catch (error) {
      say(`Not imported: ${error?.message ?? error}`, true);
    } finally {
      importInput.value = '';
    }
  });

  row.append(name, importInput);
  wrap.append(row);

  /* --- the outcome --- */
  const status = doc.createElement('p');
  status.className = 'preset-status';
  status.setAttribute('data-preset-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('style', style.status);

  const meta = doc.createElement('p');
  meta.className = 'preset-meta';
  meta.setAttribute('data-preset-meta', '');
  meta.setAttribute('style', style.meta);
  wrap.append(status, meta);

  /* --- the view state --- */
  let selected = system.current() ?? system.nextEmptySlot() ?? 1;
  let edited = false;
  const unsubscribe = store.subscribeAll((_key, _value, _previous, writeMeta) => {
    if (!EDIT_SOURCES.has(writeMeta?.source)) return;
    if (edited) return;
    edited = true;
    refresh();
  });

  /** Move the selection. Every path that changes which slot is current goes through this,
   *  so the pressed button and the actions can never disagree about which slot they mean. */
  function selectSlot(id) {
    selected = id;
    refresh();
  }

  function wantedName() {
    const typed = name.value.trim();
    return typed.length > 0 ? typed : undefined;
  }

  function say(text, failed = false) {
    status.textContent = text;
    status.setAttribute('style', failed ? style.failed : style.status);
  }

  /** One line for the outcome of an action: what happened, or the recorded reason.
   *  `done` is what to say on success; without one, the bare outcome. There is no path
   *  through here that leaves the status line saying something stale. */
  function report(result, done) {
    if (result.ok) {
      edited = false;
      say(typeof done === 'function' ? done(result) : 'Done.');
      refresh();
      return result;
    }
    const failure = system.failures().at(-1);
    say(`Not done — ${result.reason}: ${failure?.detail ?? result.detail ?? 'no reason recorded'}`, true);
    refresh();
    return result;
  }

  function doExport() {
    const result = system.export(selected);
    if (!result.ok) return report(result);
    const blob = new Blob([result.text], { type: 'application/json' });
    const url = makeUrl(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.rel = 'noopener';
    doc.body.append(link);
    link.click();
    link.remove();
    revokeUrl(url);
    return report(result, (r) => `Exported ${r.filename} (${kB(r.bytes)}).`);
  }

  function refresh() {
    const rows = system.slots();
    const lastFailure = system.failures().at(-1);
    for (const row_ of rows) {
      const button = slotButtons.get(row_.id);
      if (!button) continue;
      button.setAttribute('style', `${style.slot}${row_.empty ? '' : style.slotFilled}${row_.current ? style.slotCurrent : ''}`);
      button.setAttribute('aria-pressed', String(row_.id === selected));
      button.setAttribute(
        'aria-label',
        row_.empty
          ? `Preset slot ${row_.id}, empty`
          : `Preset slot ${row_.id}, ${row_.name}${row_.wavetables > 0 ? `, ${row_.wavetables} wavetable${row_.wavetables === 1 ? '' : 's'}` : ''}`,
      );
      button.textContent = row_.empty ? String(row_.id) : `${row_.id}·${row_.name}`;
      button.title = row_.empty
        ? `Slot ${row_.id} — empty`
        : `Slot ${row_.id} — ${row_.name}, ${kB(row_.bytes)}${row_.wavetables > 0 ? `, ${row_.wavetables} wavetable(s)` : ''}`;
    }
    if (doc.activeElement !== name) {
      const typed = wantedName();
      if (typed === undefined) name.value = system.name(selected) ?? '';
    }
    const info = system.storageInfo(rows);
    const here = rows.find((r) => r.id === selected);
    const where = here?.empty ? 'empty' : here.name;
    meta.textContent =
      `${info.key} · ${info.slotsUsed}/${info.slotsTotal} slots · ${kB(info.bytes)} stored`
      + `${info.slotsUsed > 0 ? ` · ${kB(info.perSlot)} per slot` : ''}`
      + ` · slot ${selected} is ${where}${edited ? ' · edited since load or save' : ''}`
      + `${lastFailure ? ` · last failure: ${lastFailure.reason}` : ''}`;
    save.setAttribute('aria-label', `Save the instrument into preset slot ${selected}`);
    load.setAttribute('aria-label', `Load preset slot ${selected}`);
    del.setAttribute('aria-label', `Delete preset slot ${selected}`);
    exportButton.setAttribute('aria-label', `Export preset slot ${selected} as a JSON file`);
  }

  refresh();
  if (deps.status?.text) say(deps.status.text, Boolean(deps.status.failed));
  wrap.refresh = refresh;
  wrap.dispose = unsubscribe;
  wrap.selectedSlot = () => selected;
  wrap.selectSlot = selectSlot;
  return wrap;
}

/**
 * Attach the panel to the global strip, once. Returns the element, or null if the panel
 * is not on the page — which is not an error worth throwing over, because the instrument
 * still plays without it.
 */
export function mountPresetPanel(doc = typeof document === 'undefined' ? null : document, deps = {}) {
  if (!doc) return null;
  const panel = doc.querySelector(PANEL_SELECTOR);
  if (!panel) return null;
  const existing = panel.querySelector('[data-preset-panel]');
  if (existing) return existing;
  const element = buildPresetPanel(doc, deps);
  const grid = panel.querySelector('.panel__grid');
  if (grid) grid.after(element);
  else panel.append(element);
  return element;
}

/* ------------------------------------------------- attach and restore, once --- */

if (typeof document !== 'undefined') {
  /* The live singletons, before anything asks for a capture or a restore. Both are static
     imports above, so by the time this module body runs they have been evaluated and the
     bank the sequencer owns is the same one the sequencer plays from. */
  presets.bind({ sequencer, sampler: waveSampler });
  const restored = presets.restore();
  const failure = restored.reason ? presets.failures().at(-1) : null;
  if (failure) {
    console.warn(`[presets] page load fell back to the init patch: ${failure.reason}: ${failure.detail}`);
  }
  const status = failure
    ? { text: `Init patch loaded — ${failure.reason}: ${failure.detail}`, failed: true }
    : restored.source === 'slot'
      ? { text: `Patch ${restored.slot} — ${presets.name(restored.slot) ?? 'unnamed'} — restored from this browser.`, failed: false }
      : { text: 'Init patch loaded. Nothing saved in this browser yet.', failed: false };

  const run = () => {
    if (mountPresetPanel(document, { status })) return;
    requestAnimationFrame(() => {
      if (!mountPresetPanel(document, { status })) {
        console.warn(`[preset-view] no ${PANEL_SELECTOR} on the page; the preset panel is not available`);
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else queueMicrotask(run);
}

export { PANEL_SELECTOR, FILE_INPUT_ID, INPUT_ACCEPT, NAME_INPUT_ID };