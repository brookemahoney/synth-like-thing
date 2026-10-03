# Contributing

An index, not a manual. Each line below is a fact that cannot be read off the
tree, or a pointer to the command that enforces something.

## Checks

| Command | What it covers |
|---|---|
| `npm test` | The test suite. Runs with `--test-reporter=dot`, so a green run is ~30 lines and a failure still prints its assertion, stack and diff. |
| `npm run check` | Invariants + parallel-dispatch ownership + tests. This is what CI runs. |
| `npm run hooks:install` | Installs the pre-commit guardrail into `.git/hooks/` |
| `node scripts/verify.mjs armed` | Cold-starts the page and proves every module on disk is actually loaded by it |
| `node scripts/verify.mjs rms <probe>` | Runs a probe against a freshly armed page |
| `node scripts/verify.mjs rms <probe> --size 390x844` | The same, at a viewport you choose |

`node --test tests/` does **not** work here — a directory argument is not
resolved. Always pass the glob. Node here is 22, not 24.

To run at a viewport, pass `--size`. `playwright-cli open` resets the window, so a
`resize` issued beforehand is **discarded silently** and a narrow-viewport check
quietly measures 1280px. `verify.mjs` prints the viewport and `scrollWidth` it
actually got, so a wrong one is visible rather than assumed.

## The docroot

`web/` is served as-is. It has no build step, no dependencies and no bundler,
and `scripts/check-invariants.mjs` fails the build if a `package.json`,
`node_modules`, a bundler config or a `tsconfig.json` ever appears inside it.
The root `package.json` is repo tooling only.

Everything audible is generated at runtime: the 808 kit, the factory
wavetables, the reverb impulse response, and the ground's impasto texture. The
same check rejects any asset file under `web/`.

## The parameter store holds real units

`web/ui/params.js` is the single authority for every value, and it stores **real
units, not normalized 0..1**. `delay.feedback` is `0..95` in percent, not `0..1`;
`eq.low` is `-18..18` dB; `filter1.resonance` is spelled out, not `reso`.

A write to an undeclared key is **silently ignored**, which reads exactly like a
feature that stopped working. So look the key up before using it:

```sh
node scripts/verify.mjs keys filter1      # name, range, unit, curve, default
```

Inside a probe, `h.params({...})` refuses an unknown key outright and suggests
near matches.

## The instrument has one clock

All musical timing belongs to the single lookahead scheduler in
`web/audio/clock.js`. The sequencer, the arpeggiator and the tempo-synced LFOs
subscribe to it; none of them owns a timer. A second `setInterval` anywhere under
`web/` fails `check-invariants`, because independent timers are what make a
sequencer drift.

## Every module must be in the page's graph

A module that no entry point imports statically is **not in the shipped page**,
however many checks pass by importing it by hand. `check-invariants` walks the
static import graph from the `<script>` tags in `web/index.html` and fails on any
orphan; `verify.mjs armed` confirms it at runtime against the resource timeline.

Reaching audio from a browser tool goes through the exported singletons in
`web/audio/*.js` and `web/ui/params.js` — never through a second construction
path.

## Verifying in a browser

Use `scripts/verify.mjs`. It exists because every hand-written probe in this
project has been wrong in one of four ways, each of which reads as a real finding:

- a parameter written from a guessed key name or unit, so the reading describes
  an untouched feature;
- an `AnalyserNode` connected but not connected onward to the destination, so
  every sample is a silent zero;
- a sampling loop with no `await`, so all N readings land in one render quantum;
- a warm page used to check a cold-start behaviour. A defect that silenced every
  scheduled note in this instrument was invisible on a warm page and total
  silence on a cold one.

`verify.mjs rms` always opens a fresh session, clicks POWER as a real gesture
rather than calling `resumeInstrument()` programmatically, and refuses to probe a
page that has not loaded everything on disk.

A probe is a single arrow-function expression receiving `h`; see
`probes/example.mjs`. It is compiled in node before a browser is launched, so a
syntax error is reported as a syntax error rather than arriving as a `SyntaxError`
buried in the middle of Playwright's echoed source. `h` provides `params`, `get`, `sample`, `hold`, `release`,
`transport`, `live`, `silence`, and the raw `rms`/`peak`/`band` readers.

## Parallel task dispatch

Tasks in one blueprint phase run in parallel, so each task's frontmatter declares
the files it owns (`owns:`) and the ones it must not touch (`readonly:`). One
file may have exactly one owner per phase.

```sh
node scripts/ownership.mjs 1     # collisions, per phase
```

Two tasks needing the same audio module is a modelling problem, not a race to
win: give one of them a different seam, as `web/audio/engine.js` became the
wiring point for the wavesampler precisely so the voice module stayed with the
task that builds it.

## What is tracked

`.ai/` is committed on purpose. Plans and task files are the record of what was
decided and why, including the tasks that failed and what was found.