/**
 * surface.js — the page's declarative layout. This module is the map of the
 * instrument: every functional region, in vertical order, the panels inside it,
 * and the control configurations that occupy those panels. Later tasks add to
 * it; they do not invent a second place to describe the page.
 *
 *   REGIONS         the eight regions, top to bottom
 *   REGION_ORDER    the eight region ids, top to bottom
 *   allControls([region])  every control config on the page (or in one region)
 *   buildSurface([doc][, store])  fill the page shell in index.html
 *
 * A REGION is `{ id, title, sections: [PANEL] }` and must correspond to a
 * `<section data-region="id">` in index.html holding one `[data-panels]` mount
 * point. A PANEL is `{ id, title, controls, caption?, headers?, steps? }`:
 *   controls  control configurations for createControl() — see ui/controls.js.
 *             Empty for a panel whose contents belong to a later task; the
 *             panel is still laid out so nothing has to re-derive the structure.
 *   caption   a one-line description of what the panel will hold.
 *   headers   `{ rows, columns }` for a grid that has no controls yet (matrix).
 *   steps     a step count for a grid that has no controls yet (sequencer).
 *
 * ONE KEY, ONE CONTROL. A parameter key appears exactly once in this file, so
 * there is never a second painted surface for a value: the store in ui/params.js
 * is the only authority, and a control only ever reads it.
 */
import { KIT_VOICES, MATRIX_DESTINATIONS, MATRIX_SOURCES, PATTERNS, SEQUENCER_LANES, STEPS, store as defaultStore } from './params.js';
import { createControl, prettyOption } from './controls.js';

/** The eight regions, top to bottom. The vertical order is a contract. */
export const REGION_ORDER = [
  'global-strip',
  'voice-row',
  'tone-row',
  'modulation-row',
  'effects-row',
  'drum-kit',
  'sequencer',
  'keyboard',
];

/* ------------------------------------------------------------- the sections --- */

/** The row heads for the lane grid: two or three characters, so twelve rows fit a phone. */
const LANE_SHORT = {
  bd: 'BD', sd: 'SD', lt: 'LT', mt: 'MT', ht: 'HT',
  rs: 'RS', cp: 'CP', cb: 'CB', ch: 'CH', oh: 'OH', cy: 'CY',
  melody: 'MEL',
};

/** The melodic lane's own two rows of per-step controls: a chromatic note and a gate. */
const melodicStepControls = (field, label, hue) =>
  Array.from({ length: STEPS }, (_unused, index) => ({
    type: 'hfader',
    key: `seq.melody.${field}.${index + 1}`,
    label: `${label}${index + 1}`,
    hue,
  }));

const VOICE_NAMES = {
  bd: 'Bass Drum',
  sd: 'Snare',
  lt: 'Low Tom',
  mt: 'Mid Tom',
  ht: 'Hi Tom',
  rs: 'Rim Shot',
  cp: 'Clap',
  cb: 'Cowbell',
  ch: 'Closed Hat',
  oh: 'Open Hat',
  cy: 'Cymbal',
};

const oscPanel = (n, hue) => ({
  id: `osc${n}`,
  title: `Osc ${n}`,
  controls: [
    { type: 'choice', key: `osc${n}.waveform`, label: 'Wave', hue },
    { type: 'rotary', key: `osc${n}.octave`, label: 'Octave', hue },
    { type: 'rotary', key: `osc${n}.semitone`, label: 'Semi', hue },
    { type: 'rotary', key: `osc${n}.detune`, label: 'Detune', hue },
    { type: 'vfader', key: `osc${n}.level`, label: 'Level', hue },
    { type: 'rotary', key: `osc${n}.fmAmount`, label: 'FM', hue },
    { type: 'choice', key: `osc${n}.fmSource`, label: 'FM Src', hue },
    { type: 'rotary', key: `osc${n}.unison`, label: 'Unison', hue },
    { type: 'rotary', key: `osc${n}.unisonSpread`, label: 'Spread', hue },
    { type: 'choice', key: `osc${n}.ringMod`, label: 'Ring', hue },
  ],
});

const lfoPanel = (n, hue) => ({
  id: `lfo${n}`,
  title: `LFO ${n}`,
  controls: [
    { type: 'toggle', key: `lfo${n}.on`, label: `${n}`, text: `LFO ${n}`, hue },
    { type: 'choice', key: `lfo${n}.wave`, label: 'Shape', hue },
    { type: 'rotary', key: `lfo${n}.rate`, label: 'Rate', hue },
    { type: 'step', key: `lfo${n}.sync`, label: 'Sync', text: 'SYNC', hue },
    { type: 'choice', key: `lfo${n}.rateSync`, label: 'Div', hue },
    { type: 'rotary', key: `lfo${n}.fadeIn`, label: 'Fade', hue },
  ],
});

const envPanel = (id, title, prefix, hue) => ({
  id,
  title,
  controls: [
    { type: 'rotary', key: `${prefix}.attack`, label: 'Attack', hue },
    { type: 'rotary', key: `${prefix}.decay`, label: 'Decay', hue },
    { type: 'rotary', key: `${prefix}.sustain`, label: 'Sustain', hue },
    { type: 'rotary', key: `${prefix}.release`, label: 'Release', hue },
  ],
});

const filterPanel = (n, hue) => ({
  id: `filter${n}`,
  title: `Filter ${n}`,
  controls: [
    { type: 'toggle', key: `filter${n}.bypass`, label: `${n}`, text: `FILTER ${n} ON`, hue },
    { type: 'choice', key: `filter${n}.type`, label: 'Type', hue },
    { type: 'vfader', key: `filter${n}.cutoff`, label: 'Cutoff', hue },
    { type: 'rotary', key: `filter${n}.resonance`, label: 'Reso', hue },
    { type: 'rotary', key: `filter${n}.drive`, label: 'Drive', hue },
    { type: 'rotary', key: `filter${n}.keyTrack`, label: 'Key Trk', hue },
  ],
});

/* ------------------------------------------------------------------ regions --- */

export const REGIONS = [
  {
    id: 'global-strip',
    title: 'Global',
    sections: [
      {
        id: 'master',
        title: 'Master',
        controls: [
          { type: 'toggle', key: 'global.power', label: 'Power', hue: 'rose' },
          { type: 'step', key: 'global.run', label: 'Run', text: 'RUN', hue: 'sage' },
          { type: 'toggle', key: 'global.latch', label: 'Latch', hue: 'sage' },
          { type: 'hfader', key: 'global.volume', label: 'Volume', hue: 'sage' },
          { type: 'rotary', key: 'global.tempo', label: 'Tempo', hue: 'ochre' },
          { type: 'rotary', key: 'global.swing', label: 'Swing', hue: 'ochre' },
          { type: 'choice', key: 'global.polyphony', label: 'Voices', hue: 'ochre' },
          { type: 'toggle', key: 'global.chorus.on', label: 'Chorus', hue: 'lavender' },
          { type: 'rotary', key: 'global.chorus.rate', label: 'Rate', hue: 'lavender' },
          { type: 'rotary', key: 'global.chorus.depth', label: 'Depth', hue: 'lavender' },
          { type: 'vfader', key: 'global.chorus.mix', label: 'Mix', hue: 'lavender' },
          { type: 'toggle', key: 'global.chorus.highPass', label: 'HPF', hue: 'lavender' },
        ],
      },
    ],
  },
  {
    id: 'voice-row',
    title: 'Voices',
    sections: [
      oscPanel(1, 'sky'),
      oscPanel(2, 'sky'),
      oscPanel(3, 'sky'),
      {
        id: 'wave',
        title: 'Wavesampler',
        controls: [
          { type: 'choice', key: 'wave.table', label: 'Table', hue: 'sage' },
          { type: 'vfader', key: 'wave.level', label: 'Level', hue: 'sage' },
          { type: 'hfader', key: 'wave.scan', label: 'Scan', hue: 'sage' },
        ],
      },
    ],
  },
  {
    id: 'tone-row',
    title: 'Tone',
    sections: [
      {
        id: 'mixer',
        title: 'Mixer',
        controls: [{ type: 'vfader', key: 'mixer.level', label: 'Voice', hue: 'ochre' }],
      },
      filterPanel(1, 'ochre'),
      filterPanel(2, 'ochre'),
      envPanel('env-amp', 'Amp Envelope', 'envAmp', 'rose'),
      envPanel('env-filter', 'Filter Envelope', 'envFilter', 'rose'),
    ],
  },
  {
    id: 'modulation-row',
    title: 'Modulation',
    sections: [
      lfoPanel(1, 'lavender'),
      lfoPanel(2, 'lavender'),
      lfoPanel(3, 'lavender'),
      {
        id: 'matrix',
        title: 'Modulation Matrix',
        controls: [],
        caption: 'Eight sources into eight destinations, bipolar depth.',
        headers: { rows: MATRIX_SOURCES, columns: MATRIX_DESTINATIONS },
        className: 'panel--matrix',
      },
    ],
  },
  {
    id: 'effects-row',
    title: 'Effects',
    sections: [
      {
        id: 'eq',
        title: '3-Band EQ',
        controls: [
          { type: 'rotary', key: 'eq.low', label: 'Low', hue: 'sage' },
          { type: 'rotary', key: 'eq.mid', label: 'Mid', hue: 'sage' },
          { type: 'rotary', key: 'eq.high', label: 'High', hue: 'sage' },
        ],
      },
      {
        id: 'delay',
        title: 'Delay',
        controls: [
          { type: 'step', key: 'delay.sync', label: 'Sync', text: 'SYNC', hue: 'sky' },
          { type: 'rotary', key: 'delay.time', label: 'Time', hue: 'sky' },
          { type: 'choice', key: 'delay.timeSync', label: 'Div', hue: 'sky' },
          { type: 'rotary', key: 'delay.feedback', label: 'Fdbk', hue: 'sky' },
          { type: 'rotary', key: 'delay.tone', label: 'Tone', hue: 'sky' },
          { type: 'hfader', key: 'delay.mix', label: 'Mix', hue: 'sky' },
        ],
      },
      {
        id: 'reverb',
        title: 'Reverb',
        controls: [
          { type: 'rotary', key: 'reverb.decay', label: 'Decay', hue: 'lavender' },
          { type: 'rotary', key: 'reverb.damping', label: 'Damp', hue: 'lavender' },
          { type: 'rotary', key: 'reverb.preDelay', label: 'Pre', hue: 'lavender' },
          { type: 'vfader', key: 'reverb.mix', label: 'Mix', hue: 'lavender' },
        ],
      },
    ],
  },
  {
    id: 'drum-kit',
    title: '808 Kit',
    sections: KIT_VOICES.map((voice) => ({
      id: `kit-${voice}`,
      title: VOICE_NAMES[voice],
      /* The kit's four parameters, all four rendered: tune, decay, level and pan. Pan
         is the one that was missing, which left a parameter wired all the way to every
         voice's StereoPannerNode with no way to reach it from the page. `hfader` is
         the control for it because pan is a left/right position — the same control this
         page uses for every other horizontal parameter (master volume, wave scan,
         delay mix) — and it carries aria-orientation="horizontal" to say so. The
         control factory reads -1..1, and the unit and the centred default, from the
         schema in ui/params.js: this file declares a key, a legend and a hue and
         nothing else. `.panel__grid` is a wrapping flex row, so the fourth control
         costs no stylesheet change. */
      controls: [
        { type: 'rotary', key: `kit.${voice}.tune`, label: 'Tune', hue: 'rose' },
        { type: 'rotary', key: `kit.${voice}.decay`, label: 'Decay', hue: 'rose' },
        { type: 'vfader', key: `kit.${voice}.level`, label: 'Level', hue: 'rose' },
        { type: 'hfader', key: `kit.${voice}.pan`, label: 'Pan', hue: 'rose' },
      ],
    })),
  },
  {
    id: 'sequencer',
    title: 'Sequencer & Arpeggiator',
    sections: [
      {
        id: 'sequencer',
        title: 'Pattern',
        controls: [
          { type: 'step', key: 'seq.chain', label: 'Chain', text: 'CHAIN', hue: 'sage' },
          { type: 'choice', key: 'seq.pattern', label: 'Pattern', hue: 'sage' },
          /* THE MELODIC LANE'S OWN PER-STEP PARAMETERS. They are painted here rather than
             left to the grid because a parameter with no control is unreachable from the
             page, which is the exact gap tests/drums-wiring.test.mjs guards for the kit.
             Sixteen of each is a lot of small faders; they are deliberately horizontal,
             so the two rows read as two compact strips. */
          ...melodicStepControls('note', 'N', 'ochre'),
          ...melodicStepControls('gate', 'G', 'ochre'),
        ],
        lanes: [...SEQUENCER_LANES],
        slots: [...PATTERNS],
        caption:
          'Sixteen steps, twelve lanes. Click a cell to toggle it, drag it up and down for its '
          + 'accent (shift-click steps through four presets), or press it to move the playhead to '
          + 'that step. With CHAIN on, the four pattern slots build the chain in the order you '
          + 'click them; click the last one again to clear it. N1-N16 are the melodic lane\'s '
          + 'notes, G1-G16 its gate lengths.',
        className: 'panel--steps',
      },
      {
        id: 'arp',
        title: 'Arpeggiator',
        controls: [
          { type: 'toggle', key: 'arp.on', label: 'Arp', hue: 'sky' },
          { type: 'choice', key: 'arp.mode', label: 'Mode', hue: 'sky' },
          { type: 'choice', key: 'arp.rate', label: 'Rate', hue: 'sky' },
          { type: 'rotary', key: 'arp.octaves', label: 'Oct', hue: 'sky' },
          { type: 'rotary', key: 'arp.gate', label: 'Gate', hue: 'sky' },
          { type: 'toggle', key: 'arp.followLane', label: 'Follow', hue: 'sky' },
        ],
      },
    ],
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    sections: [
      {
        id: 'range',
        title: 'Range',
        controls: [
          { type: 'rotary', key: 'global.octave', label: 'Octave', hue: 'ochre' },
          { type: 'rotary', key: 'global.bendRange', label: 'Bend', hue: 'ochre' },
        ],
      },
      {
        id: 'modes',
        title: 'Modes',
        controls: [
          { type: 'choice', key: 'global.keyboardMode', label: 'Key Mode', hue: 'ochre' },
          { type: 'choice', key: 'global.triggerMode', label: 'Trig', hue: 'ochre' },
        ],
      },
    ],
  },
];

/** Every control configuration on the page, or in one region / one panel. */
export function allControls(region = null) {
  const regions = region ? [region] : REGIONS;
  return regions.flatMap((r) => r.sections.flatMap((p) => p.controls ?? []));
}

/* --------------------------------------------------------------- the renderer --- */

/**
 * Fill the page shell declared in index.html. Every region and panel exists in
 * the HTML first; this only populates them, so the structure is readable
 * without JavaScript and cannot drift from REGIONS.
 */
export function buildSurface(doc = document, store = defaultStore) {
  for (const region of REGIONS) {
    const host = doc.querySelector(`[data-region="${region.id}"]`);
    if (!host) throw new Error(`surface: index.html has no [data-region="${region.id}"]`);
    const heading = host.querySelector('h2');
    if (heading) heading.textContent = region.title;
    const mount = host.querySelector('[data-panels]');
    if (!mount) throw new Error(`surface: [data-region="${region.id}"] has no [data-panels] mount point`);
    for (const panel of region.sections) mount.append(buildPanel(panel, doc, store));
  }
  return doc.querySelector('[data-surface]');
}

function buildPanel(panel, doc, store) {
  const section = doc.createElement('section');
  section.className = panel.className ? `panel ${panel.className}` : 'panel';
  section.id = `panel-${panel.id}`;
  section.dataset.panel = panel.id;

  const heading = doc.createElement('h3');
  heading.className = 'panel__title';
  heading.textContent = panel.title;
  section.append(heading);

  const grid = doc.createElement('div');
  grid.className = 'panel__grid';
  for (const config of panel.controls ?? []) grid.append(createControl(config, store));
  section.append(grid);

  if (panel.headers) section.append(buildHeaderGrid(panel.headers, doc));
  if (panel.lanes) section.append(buildLaneGrid(panel.lanes, doc));
  if (panel.slots) section.append(buildChainSlots(panel.slots, doc));
  if (panel.steps) section.append(buildStepRuler(panel.steps, doc));

  if (panel.caption) {
    const caption = doc.createElement('p');
    caption.className = 'panel__caption';
    caption.textContent = panel.caption;
    section.append(caption);
  }
  return section;
}

/** An empty, headed grid: the shape of a panel whose cells arrive with the
 *  module that drives them. */
function buildHeaderGrid({ rows, columns }, doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'headgrid';
  wrap.setAttribute('aria-hidden', 'true');

  const corner = doc.createElement('span');
  corner.className = 'headgrid__corner';
  wrap.append(corner);

  for (const column of columns) {
    const cell = doc.createElement('span');
    cell.className = 'headgrid__head headgrid__head--column';
    cell.textContent = prettyOption(column);
    wrap.append(cell);
  }
  for (const row of rows) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--row';
    head.textContent = prettyOption(row);
    wrap.append(head);
    for (let column = 0; column < columns.length; column += 1) {
      const cell = doc.createElement('span');
      cell.className = 'headgrid__cell';
      wrap.append(cell);
    }
  }
  return wrap;
}

/**
 * THE LANE GRID: one row per lane, sixteen cells each, on the same `.headgrid` primitives
 * the modulation matrix uses — the layout is the stylesheet's, only the contents are this
 * module's. The seventeen columns are declared inline because the stylesheet's `.headgrid`
 * is fixed at the matrix's eight and there is no `.lanegrid` rule to add to; the cells
 * themselves take `data-lane`, `data-step` and the `.step` class that
 * `styles/paint.css` already paints, including the `[data-playing="true"]` glisten.
 *
 * Every cell is a real `<button>` with an accessible name that states the lane, the step,
 * whether it is on and its accent — so the grid is operable by keyboard and legible to a
 * screen reader without a single ARIA grid role, which would require the full
 * row/rowgroup/gridcell structure to be honest.
 */
function buildLaneGrid(lanes, doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'headgrid lanegrid';
  wrap.dataset.laneGrid = 'sequencer';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Sequencer: sixteen steps by twelve lanes');
  /* One lane-name column then one column per step. minmax(0, …) throughout so the grid
     fits the panel at a phone width instead of forcing the page to scroll. */
  wrap.style.gridTemplateColumns = `minmax(0, 4.25rem) repeat(${STEPS}, minmax(0, 1fr))`;

  const corner = doc.createElement('span');
  corner.className = 'headgrid__corner';
  wrap.append(corner);

  for (let step = 1; step <= STEPS; step += 1) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--column';
    head.textContent = String(step);
    wrap.append(head);
  }

  for (const lane of lanes) {
    const head = doc.createElement('span');
    head.className = 'headgrid__head headgrid__head--row';
    head.dataset.laneHead = lane;
    head.textContent = LANE_SHORT[lane] ?? String(lane).toUpperCase();
    head.title = VOICE_NAMES[lane] ?? (lane === 'melody' ? 'Melodic Synth' : lane);
    wrap.append(head);

    for (let step = 1; step <= STEPS; step += 1) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'step';
      cell.dataset.lane = lane;
      cell.dataset.step = String(step);
      cell.dataset.accents = STEPS;
      cell.dataset.preset = '1';
      cell.setAttribute('aria-pressed', 'false');
      cell.setAttribute('aria-label', `${VOICE_NAMES[lane] ?? 'Melodic synth'} step ${step}, off`);
      wrap.append(cell);
    }
  }
  return wrap;
}

/**
 * THE CHAIN SLOTS: one painted button per pattern, plus the order they have built.
 *
 * These are buttons and NOT painted controls on purpose. A painted control owns one store
 * key and writes it on every gesture; a chain slot is a click that APPENDS to an ordered
 * list, which is a different shape entirely. They reuse the control factory's own button
 * classes so they are painted like every other switch on the page, and they carry
 * `data-pattern` for the view module to bind.
 */
function buildChainSlots(patterns, doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'panel__grid';
  wrap.dataset.chainSlots = 'sequencer';

  for (const pattern of patterns) {
    const root = doc.createElement('div');
    root.className = 'ctl ctl--step';
    root.dataset.patternSlot = pattern;
    root.dataset.hue = 'sage';

    const paint = doc.createElement('div');
    paint.className = 'ctl__paint ctl__paint--button';

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ctl__input ctl__button';
    button.dataset.pattern = pattern;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `Pattern ${pattern}`);
    const text = doc.createElement('span');
    text.className = 'ctl__legend';
    text.textContent = pattern;
    button.append(text);
    paint.append(button);
    root.append(paint);
    wrap.append(root);
  }

  const order = doc.createElement('output');
  order.className = 'panel__caption';
  order.dataset.chainOrder = 'sequencer';
  order.setAttribute('aria-live', 'polite');
  order.textContent = 'Chain: A-B-C-D';
  wrap.append(order);
  return wrap;
}

function buildStepRuler(count, doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'stepruler';
  wrap.setAttribute('aria-hidden', 'true');
  for (let step = 1; step <= count; step += 1) {
    const cell = doc.createElement('span');
    cell.className = 'stepruler__step';
    cell.textContent = String(step);
    wrap.append(cell);
  }
  return wrap;
}
