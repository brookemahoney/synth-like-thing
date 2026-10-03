#!/usr/bin/env node
/**
 * Browser verification helper for the synthesiser. Zero dependencies.
 *
 *   node scripts/verify.mjs keys [pattern]        look up a parameter before you touch it
 *   node scripts/verify.mjs armed [session]       cold-start the page and prove it is loaded
 *   node scripts/verify.mjs rms [session] [probe]  run a probe against a freshly armed page
 *
 * Every probe this project has run has been wrong in one of four ways, and each
 * cost a round of re-deriving the truth:
 *
 *   1. A parameter written from a guessed key name (`filter1.reso` for
 *      `filter1.resonance`) or a guessed unit (`delay.feedback: 0.6` for 60,
 *      the schema being percent). The store rejects the bad key silently, so the
 *      reading looks like a dead feature. -> `keys` and `h.params()`.
 *   2. An AnalyserNode connected but not connected onward to the destination,
 *      so it reads a permanent zero. -> `h.analyser()` wires it correctly.
 *   3. A sampling loop with no `await` between reads, so every sample lands in
 *      the same render quantum and the trace is N identical numbers. ->
 *      `h.sample()` awaits, and refuses a gap of zero.
 *   4. A warm page used to check a cold-start behaviour. The modulation defect
 *      this project shipped for one phase was invisible on a warm page and
 *      total silence on a cold one. -> `rms` always opens a fresh session.
 *
 * The point of the last one: `armed` and `rms` do not take a "reuse my existing
 * browser" path, because that path is how a passing verification ends up
 * measuring a page that is not the delivered one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, WEB_ROOT, webModules } from './lib/modules.mjs';

const SITE = process.env.SITE_URL ?? 'https://synth-like-thing.ddev.site/';
const POWER_SELECTOR = '#ctl-global-power';

function cli(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('playwright-cli', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
  } catch (error) {
    if (allowFailure) return '';
    // playwright-cli echoes the whole generated function source on failure.
    // Keep only the tail, where its own message and the thrown error live.
    const combined = `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim();
    const tail = combined.split('\n').slice(-5).join('\n');
    throw new Error(`playwright-cli failed:\n${tail}`);
  }
}

/**
 * Read a value back from `playwright-cli --raw run-code`.
 *
 * The command prints the returned value as a JSON string containing JSON, and
 * echoes the function source when the body spans lines — so: take the last line
 * that parses, and unwrap one level of string encoding if there is one.
 */
function cliJson(args) {
  const out = cli(args).trim();
  for (const line of out.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  throw new Error(`no JSON on stdout from: playwright-cli ${args.join(' ')}\n${out.slice(0, 400)}`);
}

/**
 * Flatten a generated body to one line so playwright-cli echoes the result
 * rather than the function source. Line comments are stripped first: collapsing
 * a newline would otherwise comment out the rest of the line. The guard
 * requires whitespace before the slashes so a URL in a string literal is safe.
 */
const oneLine = (body) => body.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

/* ------------------------------------------------------------------ *
 * keys — the schema is the source of truth for names, ranges and units
 * ------------------------------------------------------------------ */

async function commandKeys(pattern) {
  const { SCHEMA } = await import(path.join(WEB_ROOT, 'ui', 'params.js'));
  const entries = Object.entries(SCHEMA)
    .filter(([key]) => !pattern || key.includes(pattern))
    .map(([key, spec]) => ({
      key,
      ...(typeof spec === 'object' ? { min: spec.min, max: spec.max, def: spec.def, unit: spec.unit ?? '', curve: spec.curve ?? 'linear' } : { def: spec }),
    }));
  if (entries.length === 0) {
    console.error(`no schema key matches "${pattern}". Run without a pattern to list all ${Object.keys(SCHEMA).length}.`);
    process.exit(1);
  }
  for (const e of entries) {
    const range = e.min !== undefined ? `${e.min}..${e.max}` : typeof e.def === 'boolean' ? 'boolean' : 'enum';
    const unit = e.unit ? ` ${e.unit}` : '';
    const curve = e.curve === 'log' ? ' log' : '';
    console.log(`${e.key.padEnd(34)} ${String(range).padEnd(18)}${unit.padEnd(8)}${curve.padEnd(6)} default=${JSON.stringify(e.def)}`);
  }
  console.log(`\n${entries.length} key(s)${pattern ? ` matching "${pattern}"` : ''}. Values are REAL units, not normalized 0..1.`);
}

/* ------------------------------------------------------------------ *
 * armed — a cold page, and proof that the page loaded what is on disk
 * ------------------------------------------------------------------ */

async function arm(session, viewport) {
  cli(['-s', session, 'open', SITE]);
  // `open` resets the window to playwright-cli's default, so a viewport has to be
  // applied AFTER it or it is silently discarded — which is how a narrow-viewport
  // check ends up measuring 1280px and reporting a false pass.
  if (viewport) {
    const [width, height] = viewport.split('x').map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`--size wants WIDTHxHEIGHT, got "${viewport}"`);
    cli(['-s', session, 'resize', String(width), String(height)]);
  }
  // A real click, never a programmatic resume: a programmatic resume can succeed
  // without a user gesture and would hide a broken power-on gate.
  cli(['-s', session, 'click', POWER_SELECTOR]);
  return cliJson(['-s', session, '--raw', 'run-code', oneLine(`async page => {
    const out = await page.evaluate(async () => {
      const ctx = await import('/audio/context.js');
      await new Promise((r) => setTimeout(r, 300));
      const loaded = performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname);
      const modules = [...new Set(loaded.filter((p) => p.endsWith('.js')))].sort();
      return {
        contextState: ctx.contextState(),
        audioTime: Number(ctx.contextTime().toFixed(4)),
        sampleRate: ctx.sampleRate,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        loadedModules: modules,
      };
    });
    return JSON.stringify(out);
  }`)]);
}

function reportArmed(session, armed) {
  const vp = armed.viewport ? `  viewport=${armed.viewport.width}x${armed.viewport.height} scrollWidth=${armed.scrollWidth}` : '';
  console.log(`session ${session}  context=${armed.contextState}  audioTime=${armed.audioTime}  sampleRate=${armed.sampleRate}${vp}`);
  // The check that would have caught a whole task's worth of dead code: a module
  // on disk that the page never requested is not in the shipped graph, however
  // many probes passed by importing it by hand.
  const loaded = new Set(armed.loadedModules.map((p) => p.replace(/^\//, '')));
  const orphans = webModules().filter((m) => !loaded.has(m.replace(/^web\//, '')));
  if (orphans.length > 0) {
    console.error(`  NOT LOADED BY THE PAGE: ${orphans.join(', ')}`);
    console.error('  These are on disk but absent from the resource timeline: absent from the shipped page.');
    process.exitCode = 1;
  } else {
    console.log(`  all ${armed.loadedModules.length} modules on disk were requested by the page`);
  }
}

/* ------------------------------------------------------------------ *
 * rms — run a probe on a freshly armed page
 * ------------------------------------------------------------------ */

/**
 * A probe file is a single bare arrow-function expression, given `h`:
 *
 *   async (h) => {
 *     h.params({ 'filter1.resonance': 30 });   // schema-checked, real units
 *     await h.hold(57, { ms: 400 });
 *     return { level: h.sample(40) };
 *   }
 */
function probeSource(file) {
  // Strip leading line comments so a probe can document itself.
  const source = fs.readFileSync(file, 'utf8').replace(/^(?:\s*\/\/[^\n]*\n)+/, '').trim();
  if (!/^(async\s*)?(\(|function\b)/.test(source)) {
    throw new Error(`${file} must be a single arrow-function expression receiving h, e.g. "async (h) => ({...})"`);
  }
  // Compile it here, in node, before a browser is launched. A probe is a bare
  // expression rather than a module, so `node --check` cannot read it — but the
  // same syntax errors reach the page as a SyntaxError buried in the middle of
  // playwright-cli's echoed function source, which is a miserable way to learn
  // that you wrote `cutoffs.vel_0.3`.
  try {
    // eslint-disable-next-line no-new-func
    new Function('h', `return (${source});`);
  } catch (error) {
    throw new Error(`${file} is not valid JavaScript: ${error.message}`);
  }
  return source;
}

async function commandRms(session, probeFile, viewport) {
  if (!probeFile) throw new Error('usage: node scripts/verify.mjs rms [session] <probe.mjs>');
  const source = probeSource(probeFile);
  const armed = await arm(session, viewport);
  reportArmed(session, armed);
  if (process.exitCode === 1) {
    console.error('refusing to probe a page that is not fully loaded');
    cli(['-s', session, 'close'], { allowFailure: true });
    return;
  }

  // The probe source is passed as an evaluate argument, never interpolated into
  // the generated body: the body is flattened for playwright-cli, and flattening
  // would rewrite any `//` comment inside the probe.
  const bodyTemplate = `async page => {
    const out = await page.evaluate(async (probeSrc) => {
      const ctx = await import('/audio/context.js');
      const fx = await import('/audio/effects.js');
      const engine = await import('/audio/engine.js');
      const { SCHEMA, store } = await import('/ui/params.js');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      const analyser = ctx.audioContext.createAnalyser();
      analyser.fftSize = fx.ANALYSER_FFT_SIZE ?? 2048;
      analyser.smoothingTimeConstant = 0;
      // Connected onward to the destination, or the node is never pulled and
      // every reading is a silent zero.
      fx.analyser.connect(analyser);
      analyser.connect(ctx.audioContext.destination);

      const timeData = new Float32Array(analyser.fftSize);
      const freqData = new Float32Array(analyser.frequencyBinCount);
      const readRms = () => {
        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (const v of timeData) sum += v * v;
        return Math.sqrt(sum / timeData.length);
      };
      const readPeak = () => {
        analyser.getFloatTimeDomainData(timeData);
        let peak = 0;
        for (const v of timeData) peak = Math.max(peak, Math.abs(v));
        return peak;
      };
      const readBand = (loHz, hiHz) => {
        analyser.getFloatFrequencyData(freqData);
        const binHz = ctx.sampleRate / analyser.fftSize;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < freqData.length; i += 1) {
          const hz = i * binHz;
          if (hz >= loHz && hz <= hiHz) { sum += 10 ** (freqData[i] / 10); n += 1; }
        }
        return n ? 10 * Math.log10(sum / n) : -Infinity;
      };

      const h = {
        wait,
        ctx,
        store,
        rms: readRms,
        peak: readPeak,
        band: readBand,

        /** Set parameters, refusing any key the schema does not declare. */
        params(obj) {
          const applied = {};
          for (const [key, value] of Object.entries(obj)) {
            const spec = SCHEMA[key];
            if (spec === undefined) {
              const near = Object.keys(SCHEMA).filter((k) => k.includes(key.split('.').pop() ?? key)).slice(0, 5);
              throw new Error(
                \`unknown parameter "\${key}" — the store ignores it, so the probe would measure an untouched feature.\` +
                (near.length ? \` Did you mean: \${near.join(', ')}?\` : ''),
              );
            }
            store.set(key, value);
            applied[key] = store.get(key);
          }
          return applied;
        },
        get: (key) => store.get(key),

        /**
         * Awaited sampling. A loop without an await samples one render quantum
         * N times and reports variance 0; this refuses a zero gap outright.
         */
        async sample(count, gapMs = 60) {
          if (gapMs <= 0) throw new Error('sample gap must be > 0, or every reading is the same sample');
          const out = [];
          for (let i = 0; i < count; i += 1) { out.push(Number(readRms().toFixed(5))); await wait(gapMs); }
          const mean = out.reduce((a, b) => a + b, 0) / out.length;
          return {
            n: out.length,
            distinct: new Set(out).size,
            mean: Number(mean.toFixed(5)),
            peak: Number(Math.max(...out).toFixed(5)),
            min: Number(Math.min(...out).toFixed(5)),
            variance: Number((out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length).toFixed(9)),
            trace: out,
          };
        },

        async hold(note, { ms = 400, velocity = 0.85, id } = {}) {
          engine.noteOn({ id: id ?? \`probe-\${note}-\${Math.round(performance.now())}\`, note, velocity });
          await wait(ms);
        },
        async release(id) { engine.noteOff(id); },

        /** global.run is the transport: it owns the one clock. */
        async transport(on = true, { ms = 0 } = {}) {
          store.set('global.run', on);
          if (ms) await wait(ms);
          return store.get('global.run');
        },

        async live() {
          return {
            rms: Number(readRms().toFixed(5)),
            peak: Number(readPeak().toFixed(5)),
            voiceStates: engine.voiceEngine.liveStates().map((v) => ({ note: v.note ?? v.noteId, state: v.state, pitch: v.pitch })),
          };
        },

        silence(ms = 500) { engine.allNotesOff(); store.set('global.run', false); return wait(ms); },
      };

      const probe = new Function('h', \`return (\${probeSrc})\`)(h);
      return JSON.stringify(await probe(h), null, 2);
    }, __PROBE__);
    return out;
  }`;

  // Flatten the harness first, then splice the probe in as a JSON literal: the
  // flattener strips line comments, and a probe is allowed to contain them.
  const body = oneLine(bodyTemplate).replace('__PROBE__', JSON.stringify(source));

  try {
    const raw = cliJson(['-s', session, '--raw', 'run-code', body]);
    console.log(raw);
  } finally {
    cli(['-s', session, 'close'], { allowFailure: true });
  }
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const sizeIndex = argv.indexOf('--size');
const viewport = sizeIndex === -1 ? null : argv[sizeIndex + 1];
if (sizeIndex !== -1) argv.splice(sizeIndex, 2);
const [command, ...rest] = argv;

try {
  if (command === 'keys') await commandKeys(rest[0]);
  else if (command === 'armed') {
    const session = rest[0] ?? 'verify';
    reportArmed(session, await arm(session, viewport));
    cli(['-s', session, 'close'], { allowFailure: true });
  } else if (command === 'rms') await commandRms(rest[0] ?? 'verify', rest[1], viewport);
  else {
    console.log(`usage:
  node scripts/verify.mjs keys [pattern]          schema lookup: names, ranges, units
  node scripts/verify.mjs armed [session]         cold-start the page, prove every module loaded
  node scripts/verify.mjs rms [session] <probe>   run a probe expression against a fresh page

options:
  --size WIDTHxHEIGHT   viewport for the run, applied AFTER the browser opens,
                        because "open" resets the window and discards a resize
                        issued beforehand. The only reliable way to run narrow.

probe files are a single expression receiving h:
  async (h) => { h.params({ 'filter1.resonance': 30 }); await h.hold(57); return h.sample(40); }

site: ${SITE} (override with SITE_URL)`);
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`verify: ${error.message}`);
  process.exit(1);
}