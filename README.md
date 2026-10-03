# Synth-Like-Thing

A Monet-impressionist-themed polyphonic browser synthesiser, served from the `web/`
docroot of a DDEV project named `synth-like-thing` and reachable at <https://synth-like-thing.ddev.site/>: three
oscillator cores plus a wavetables voice, cascaded resonant filters, an 8×8 modulation
matrix, a synthesized eleven-voice 808 kit, a sixteen-step sequencer, an arpeggiator, EQ,
delay and reverb, painted as impasto dabs and brush strokes on a parchment ground. There
is no build step and no dependency: `web/` is served as it sits on disk.

## Running it

```sh
ddev start
```

Then open <https://synth-like-thing.ddev.site/>. The docroot is `web/`, so `web/index.html` is the
site root; nothing is compiled, bundled or installed to serve it. `ddev` must be
installed and the project's containers running for that URL to answer.

## Power on

The instrument arrives **powered off**, and one control — `global.power`, the POWER
toggle in the Global strip — starts it. Browsers will not let an `AudioContext` produce
sound until a user gesture, so a context created on page load stays suspended no matter
what you do to the knobs. Presenting that as an explicit switch makes the requirement
visible instead of mysterious. Every other control on the page works while it is
suspended; nothing else resumes the context, so the first click on POWER is the gesture
that makes the instrument audible. Powering off silences the voices before it suspends.

## Control map

Eight regions, top to bottom, each with the panels painted into it. Every control
carries its own legend on the page, so this is the map, not the manual.

A row is a key — or a `*`-wildcard family of keys — from `web/ui/params.js`, the range
the store enforces for it, and its unit. `log` means the knob's travel is geometric
across the range, not linear. `choice` is a dropdown over an enum, `on/off` a switch.

### `global-strip` — Global

Master and chorus.

| Keys | Range | Unit |
|---|---|---|
| `global.power`, `global.run`, `global.latch`, `global.chorus.on`, `global.chorus.highPass` | on/off | |
| `global.volume`, `global.chorus.mix`, `global.chorus.depth` | 0..1 | |
| `global.tempo` | 40..220 | BPM |
| `global.swing` | 50..75 | % |
| `global.chorus.rate` | 0.02..30 | Hz log |
| `global.polyphony` | choice | |

The preset panel — twelve slots, save/load/delete, export, import — is added to the end
of this same panel; see [Presets](#presets).

### `voice-row` — Voices

Three identical oscillator cores, then the Wavesampler.

| Keys | Range | Unit |
|---|---|---|
| `osc*.waveform` | choice | |
| `osc*.octave` | -2..2 | |
| `osc*.semitone` | -12..12 | st |
| `osc*.detune` | -50..50 | ct |
| `osc*.level` | 0..1 | |
| `osc*.fmAmount` | 0..1 | |
| `osc*.fmSource`, `osc*.ringMod` | choice | |
| `osc*.unison` | 1..7 | |
| `osc*.unisonSpread` | 0..50 | ct |
| `wave.table` | choice | |
| `wave.level` | 0..1 | |
| `wave.scan` | 0..1 | |

### `tone-row` — Tone

Voice mixer, the two cascaded filters, and the two envelopes. The filter envelope has no
amount knob: its depth into the filters is a modulation-matrix route, not a second dial.

| Keys | Range | Unit |
|---|---|---|
| `mixer.level` | 0..1 | |
| `filter*.type` | choice | |
| `filter*.cutoff` | 20..20000 | Hz log |
| `filter*.resonance` | 0.5..30 | |
| `filter*.drive` | 0..1 | |
| `filter*.keyTrack` | 0..100 | % |
| `filter*.bypass` | on/off | |
| `env*.attack`, `env*.decay` | 0.001..5 | s log |
| `env*.sustain` | 0..1 | |
| `env*.release` | 0.001..8 | s log |

### `modulation-row` — Modulation

Three LFOs and the 8×8 matrix. The matrix is a grid of painted cells rather than knobs;
its 64 depths are bipolar, negative meaning the inverted source.

| Keys | Range | Unit |
|---|---|---|
| `lfo*.on`, `lfo*.sync` | on/off | |
| `lfo*.wave` | choice | |
| `lfo*.rate` | 0.02..30 | Hz log |
| `lfo*.rateSync` | choice | |
| `lfo*.fadeIn` | 0..5 | s log |
| `matrix.*.*` | -100..100 | |

### `effects-row` — Effects

The master chain, in signal order: EQ, then delay, then reverb.

| Keys | Range | Unit |
|---|---|---|
| `eq.low`, `eq.mid`, `eq.high` | -18..18 | dB |
| `delay.sync` | on/off | |
| `delay.time` | 0.001..2 | s log |
| `delay.timeSync` | choice | |
| `delay.feedback` | 0..95 | % |
| `delay.tone` | 400..20000 | Hz log |
| `delay.mix` | 0..1 | |
| `reverb.decay` | 0.3..12 | s |
| `reverb.damping` | 200..20000 | Hz log |
| `reverb.preDelay` | 0..0.2 | s |
| `reverb.mix` | 0..1 | |

### `drum-kit` — 808 Kit

11 voices, four controls each: tune, decay, level, pan.

| Keys | Range | Unit |
|---|---|---|
| `kit.*.tune` | -12..12 | st |
| `kit.*.decay` | 0.05..2 | s log |
| `kit.*.level` | 0..1 | |
| `kit.*.pan` | -1..1 | |

### `sequencer` — Sequencer & Arpeggiator

16 steps across 12 lanes — the 11 kit voices plus a melodic lane whose own `N1`–`N16`
notes and `G1`–`G16` gate lengths are painted as two rows of faders. Four pattern slots,
chainable. The grid cells toggle on click, drag for accent, and shift-click through four
accent presets.

| Keys | Range | Unit |
|---|---|---|
| `seq.chain` | on/off | |
| `seq.pattern` | choice | |
| `seq.melody.note.*` | 0..127 | |
| `seq.melody.gate.*` | 10..100 | % |
| `arp.on`, `arp.followLane` | on/off | |
| `arp.mode`, `arp.rate` | choice | |
| `arp.octaves` | 1..4 | |
| `arp.gate` | 10..100 | % |

### `keyboard` — Keyboard

Two panels: the range the bed and the computer keys cover, and how the bed responds to
the hands.

| Keys | Range | Unit |
|---|---|---|
| `global.octave` | -2..2 | |
| `global.bendRange` | 0..12 | st |
| `global.keyboardMode`, `global.triggerMode` | choice | |

## Computer keyboard

The tracker layout, as `web/ui/keyboard.js` resolves it, over the on-screen bed's
36 to 84 (C2 to C6):

- **Lower octave (the home row):** `A W S E D F T G Y H U J K`, starting on 48 (C3).
- **Upper octave, uniquely:** `Q 2 3 R 5 6 7 I`. Five codes — `W`, `E`, `T`, `Y`, `U` —
  are on both rows; one physical key cannot sound two notes, so those five play the
  lower octave.
- **Octave:** `Z` down and `X` up, which write `global.octave`; the Octave knob in the
  keyboard region's Range panel does the same.
- **`Space` is deliberately not bound.** It is the obvious sustain-pedal key, and it
  would silently break page scrolling for every keyboard user in every browser. Latch is
  a painted switch instead: tab to it and press Space or Enter while it is focused, which
  is the platform's own button behaviour, not a global binding.

Computer keys play at one fixed velocity. The on-screen bed is velocity-sensitive: the
higher up a key you press, the louder. Losing window focus releases everything, so a
key held while you alt-tab cannot stick.

## Sounds

**No audio file ships with the site.** Everything audible is synthesised at runtime:

- **ten waveforms** per oscillator core — sine, triangle, sawtooth, square, two narrower
  pulse widths, a falling and a rising saw, white noise, and an additive reed built from
  harmonics 1, 2, 3, 4, 6 and 8. The `Wave` control on each core lists them; the
  recipes are in `web/audio/waveforms.js`;
- the eleven 808 voices, from recipes in `web/audio/drum-kit.js` — a pitch-dropping sine,
  staggered noise bursts, inharmonic squares — 808-shaped, not sample-identical;
- the four factory wavetables `warmSaw`, `softSquare`, `reed` and `glass`, built from
  analytic Fourier coefficients into 2048-point cycles in `web/audio/wavesampler.js`;
- the reverb impulse response and the ground's impasto texture.

**User-supplied:** the `.wav` file input in the Wavesampler panel. A single-cycle `.wav`
you choose is resampled to a 2048-point table and fills that slot; the Factory button
puts the generated wave back. A file that will not decode is refused with the reason in
the panel's status line, and the slot keeps whatever it was playing.

## Presets

Twelve slots, addressed 1 to 12, in `localStorage` under one versioned key:
`synth-like-thing.synth.presets.v1`. A slot holds one schema-versioned document — every parameter, all
four sequencer patterns, the chain order, swing, tempo, and any user-loaded wavetable.
`global.power`, `global.run` and `seq.step` are the instrument's runtime and are never
saved, so loading a patch cannot switch you off.

Saving is explicit. Loading a slot copies its values in and leaves the stored document
untouched, so no knob drag can overwrite a patch, and reverting is loading that slot
again. Only a reload restores the last slot you **saved**.

Export writes the selected document out as JSON, to a `.json` file; the import input
validates a JSON file before anything is replaced. Every outcome — saved, loaded,
refused — appears in the panel's status line with a reason: a wrong schema version,
unparseable text, a bad shape, or a `localStorage` quota that the refused byte count is
quoted for.

## Checking it in a browser

Use the `playwright-cli` skill: `playwright-cli open https://synth-like-thing.ddev.site/`, then
`snapshot`, `click` and `eval` against the refs it hands back. Nothing resumes the audio
context but the POWER click, so an automated page stays silent until that click — verify
the graph and the state rather than expecting to hear it.

For deeper inspection the page publishes `window.__instrument`, a read-only handle whose
fields cover the `AudioContext` state and sample rate, the meter's RMS/peak/dBFS, any
parameter by key, the firing sequencer step, the drum voices' counters and live counts,
the constructed node inventory, and the page's own error log. Its full field list is
`handleFieldNames()` in `web/ui/meter.js`.

## Contributing

Checks, ownership rules and the non-obvious facts about this codebase are indexed in
[CONTRIBUTING.md](CONTRIBUTING.md). Read it before editing `web/`.
