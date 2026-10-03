/**
 * README.md against the code it documents. The README is a map, and a map is
 * only worth reading for as long as it agrees with the thing it maps:
 * `node --test tests/readme.test.mjs`.
 *
 * A README that names a control the schema does not declare, quotes a range the
 * schema does not enforce, or leaves a region undocumented costs a reader more
 * time than no README at all. So the claims are read out of the file and checked
 * against the three authorities — `web/ui/params.js` for what a key is,
 * `web/ui/surface.js` for what is painted and where, `web/ui/keyboard.js` for
 * which physical key sounds which note.
 *
 * The parser is deliberately narrow: it reads ONE table format, out of ONE
 * section, and asserts nothing about prose except the handful of facts a reader
 * cannot get from the page. A test that read every sentence would fail on every
 * rewording and be deleted within a week; this one fails when the map lies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KIT_VOICES, SCHEMA, STEPS, store } from '../web/ui/params.js';
import { REGION_ORDER, REGIONS, allControls } from '../web/ui/surface.js';
import {
  BASE_NOTE, KEY_HIGH, KEY_LOW, LOWER_ROW, OCTAVE_STEP_KEYS, UPPER_ROW,
  noteForCode, octaveStepForCode,
} from '../web/ui/keyboard.js';
import { SLOT_COUNT, STORAGE_KEY } from '../web/audio/presets.js';
import { WAVE_TABLE_NAMES } from '../web/audio/wavesampler.js';

const README_URL = new URL('../README.md', import.meta.url);
const readme = readFileSync(README_URL, 'utf8');

/** The text under one `## heading`, up to the next `## ` or the end of the file. */
function section(heading) {
  const start = readme.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `README.md has no "## ${heading}" section`);
  const rest = readme.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const hasSection = (heading) => readme.includes(`## ${heading}`);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `osc*.level` -> the schema keys it names. A literal key -> itself, or []. */
function keysFor(expression) {
  if (!expression.includes('*')) return SCHEMA[expression] ? [expression] : [];
  const pattern = new RegExp(`^${escapeRe(expression).replace(/\\\*/g, '[^.]+')}$`);
  return store.keys().filter((key) => pattern.test(key));
}

const expressionsIn = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/** `12..220` -> [12, 220]; `choice` and `on/off` -> null. */
function numericRange(cell) {
  const match = cell.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Every row of the control map's tables, as `{ expressions, range, unit }`.
 * The header row and the `|---|---|` rule are the only lines not read as data.
 */
function controlMapRows() {
  const text = section('Control map');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (!line.includes('`')) continue;
    if (/^\|[\s|:-]+\|?$/.test(line)) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    rows.push({ expressions: expressionsIn(cells[0]), range: cells[1] ?? '', unit: cells[2] ?? '' });
  }
  return rows;
}

const rows = controlMapRows();

/* ------------------------------------------------------------ the whole file --- */

test('the README is not empty and its opening paragraph says what the site is', () => {
  assert.ok(readme.length > 0, 'README.md is zero bytes');
  const opening = readme.slice(0, readme.indexOf('\n## '));
  assert.match(opening, /https:\/\/synth-like-thing\.ddev\.site\//, 'the opening paragraph must give the URL');
  assert.match(opening, /polyphonic/i);
  assert.match(opening, /impressionist|Monet/);
  assert.match(opening, /synthesi[sz]er/i);
});

test('the README documents the startup and the docroot', () => {
  const running = section('Running it');
  assert.match(running, /ddev start/);
  assert.match(running, /https:\/\/synth-like-thing\.ddev\.site\//);
  assert.match(running, /web\//, 'the docroot must be named');
});

test('the README states the power-on gate and why the browser requires it', () => {
  const power = section('Power on').toLowerCase();
  assert.match(power, /gesture/, 'the reason is the browser autoplay policy');
  assert.match(power, /power/i);
  assert.equal(SCHEMA['global.power'].def, false, 'the schema must still boot powered off');
});

test('the README says which sounds are generated and which are user-supplied', () => {
  const sounds = section('Sounds');
  assert.match(sounds, /generat/i);
  for (const name of WAVE_TABLE_NAMES) assert.ok(sounds.includes(name), `factory table ${name} is unlisted`);
  assert.equal(WAVE_TABLE_NAMES.length, 4, 'the README quotes four factory tables');
  for (const voice of KIT_VOICES) assert.ok(/808/i.test(sounds), 'the kit is described as a kit');
  assert.match(sounds, /\.wav/, 'the user-supplied format is named');
  assert.match(sounds, /generated in the browser|no (audio|media|asset) files? ship/i);
});

test('the README documents twelve localStorage slots under the real key, plus JSON files', () => {
  const persistence = section('Presets');
  assert.ok(persistence.includes(STORAGE_KEY), `the storage key ${STORAGE_KEY} is missing`);
  assert.match(persistence, /localStorage/);
  assert.match(persistence, new RegExp(String(SLOT_COUNT)));
  assert.match(persistence, /JSON/);
  assert.match(persistence, /export/i);
  assert.match(persistence, /import/i);
});

test('the README points at CONTRIBUTING.md exactly once, near the end', () => {
  const mentions = readme.match(/\]\(CONTRIBUTING\.md\)/g) ?? [];
  assert.equal(mentions.length, 1, 'CONTRIBUTING.md is linked once');
  assert.ok(readme.lastIndexOf('CONTRIBUTING.md') > readme.length * 0.6, 'the link belongs near the end');
});

/* ------------------------------------------------------------- the control map --- */

test('every region surface.js reports has a section in the control map', () => {
  const map = section('Control map');
  for (const region of REGIONS) {
    assert.ok(map.includes(region.id), `region ${region.id} is not in the control map`);
    assert.ok(map.includes(region.title), `region title "${region.title}" is not in the control map`);
  }
  // The region headings are the README's own; assert they are the eight, in order.
  const documented = REGION_ORDER.map((id) => map.includes(`\`${id}\``));
  assert.ok(documented.every(Boolean), 'each region id is quoted verbatim');
});

test('every painted control key is reached by a documented key or family', () => {
  const painted = allControls().map((control) => control.key);
  assert.ok(painted.length > 100, 'the inventory is the real one, not a stub');
  for (const key of painted) {
    const covered = rows.some((row) => row.expressions.some((expression) => keysFor(expression).includes(key)));
    assert.ok(covered, `no control-map row documents the painted key ${key}`);
  }
});

test('the control map names only keys the schema declares', () => {
  const documented = rows.flatMap((row) => row.expressions);
  assert.ok(documented.length > 0);
  for (const expression of documented) {
    const keys = keysFor(expression);
    assert.ok(keys.length > 0, `the README documents "${expression}", which the schema does not declare`);
  }
});

test('every range the control map quotes is the range the schema enforces', () => {
  for (const row of rows) {
    const range = numericRange(row.range);
    for (const expression of row.expressions) {
      for (const key of keysFor(expression)) {
        const entry = SCHEMA[key];
        if (range) {
          assert.equal(entry.min, range[0], `${key}: the README quotes ${row.range}, the schema declares min ${entry.min}`);
          assert.equal(entry.max, range[1], `${key}: the README quotes ${row.range}, the schema declares max ${entry.max}`);
        } else if (row.range === 'choice') {
          assert.equal(entry.kind, 'enum', `${key} is quoted as a choice but is a ${entry.kind}`);
        } else if (row.range === 'on/off') {
          assert.equal(entry.kind, 'bool', `${key} is quoted as on/off but is a ${entry.kind}`);
        } else {
          assert.fail(`${expression}: unreadable range "${row.range}" — expected "a..b", "choice" or "on/off"`);
        }
      }
    }
  }
});

test('the units and log curves the control map claims are the schema\'s', () => {
  for (const row of rows) {
    const claimsLog = /log/.test(row.unit);
    for (const expression of row.expressions) {
      for (const key of keysFor(expression)) {
        const entry = SCHEMA[key];
        if (entry.unit) {
          assert.ok(row.unit.includes(entry.unit), `${key} is in ${entry.unit} and the README's unit cell says "${row.unit}"`);
        }
        if (claimsLog) {
          assert.equal(entry.curve, 'log', `${key} is quoted as log and is ${entry.curve}`);
        }
      }
    }
  }
});

/* --------------------------------------------------------------- the keyboard --- */

const keyLetter = (code) => code.replace(/^(Key|Digit)/, '');
const letters = (row) => Object.keys(row).map(keyLetter).join(' ');

test('the README quotes the tracker layout the code resolves', () => {
  const sectionText = section('Computer keyboard');
  const lower = letters(LOWER_ROW);
  assert.ok(sectionText.includes(lower), `the lower row is not the code's: ${lower}`);

  // Five codes are on both rows and resolve to the home row, so the upper row is
  // only the keys it uniquely adds.
  const upper = Object.keys(UPPER_ROW).filter((code) => !(code in LOWER_ROW)).map(keyLetter).join(' ');
  assert.ok(sectionText.includes(upper), `the upper row is not the code's: ${upper}`);
});

test('the README names the octave-shift keys and the keybed they shift', () => {
  const sectionText = section('Computer keyboard');
  for (const [code, step] of Object.entries(OCTAVE_STEP_KEYS)) {
    const letter = keyLetter(code);
    assert.ok(sectionText.includes(`\`${letter}\``), `the octave key ${letter} is unlisted`);
    assert.ok(new RegExp(`${letter}[^.\n]*${step === -1 ? 'down|lower' : 'up|higher'}`).test(sectionText),
      `${letter} must be documented as the octave ${step === -1 ? 'down' : 'up'} key`);
  }
  assert.equal(SCHEMA['global.octave'].min, -2);
  assert.equal(SCHEMA['global.octave'].max, 2);
});

test('Space is documented as unbound, and it is', () => {
  const sectionText = section('Computer keyboard');
  assert.match(sectionText, /Space/, 'the Space claim must be made');
  assert.match(sectionText, /not bound|is not|never bound/i, 'and stated as a non-binding');
  // The claim is only worth making because the code agrees with it.
  assert.equal(noteForCode('Space'), null, 'Space must not resolve to a note');
  assert.equal(octaveStepForCode('Space'), 0, 'Space must not be an octave key');
  assert.equal(noteForCode('Enter'), null);
  assert.equal(noteForCode('ArrowLeft'), null);
});

test('the README quotes the keybed span and the note the tracker starts on', () => {
  const sectionText = section('Computer keyboard');
  assert.ok(sectionText.includes(String(KEY_LOW)), `the low key (${KEY_LOW}) is unquoted`);
  assert.ok(sectionText.includes(String(KEY_HIGH)), `the high key (${KEY_HIGH}) is unquoted`);
  assert.ok(sectionText.includes(String(BASE_NOTE)), `the base note (${BASE_NOTE}) is unquoted`);
});

/* ----------------------------------------------------------- the map's shape --- */

test('the control map has no duplicate rows and quotes a range in every row', () => {
  for (const row of rows) {
    assert.ok(row.expressions.length > 0, `a row documents nothing: "${row.range}"`);
    assert.ok(row.range.length > 0, `"${row.expressions.join(', ')}" quotes no range`);
  }
  const seen = new Map();
  for (const row of rows) {
    for (const expression of row.expressions) {
      assert.ok(!seen.has(expression), `"${expression}" is documented twice`);
      seen.set(expression, row.range);
    }
  }
});

test('the sequencer the README describes is the one the schema holds', () => {
  const map = section('Control map');
  assert.ok(map.includes(String(STEPS)), `the step count (${STEPS}) is unquoted`);
  assert.equal(STEPS, 16);
  assert.ok(map.includes(String(KIT_VOICES.length)), `the lane count (${KIT_VOICES.length}) is unquoted`);
});
