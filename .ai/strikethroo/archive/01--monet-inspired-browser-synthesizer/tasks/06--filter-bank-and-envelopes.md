---
id: 6
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
complexity_score: 6
owns:
  - web/audio/filter.js
  - web/audio/env.js
  - web/audio/voice.js
  - tests/filter*
  - tests/env*
  - tests/envelope*
  - tests/voice-fake-audio.mjs
execution_profile: "complex-architecture"
---
# Filter Bank, Drive and Amp and Filter Envelopes

## Objective
Complete the per-voice signal chain: cascade two resonant `BiquadFilterNode` stages with a soft-clipping drive stage ahead of each, then the amplifier under an amp ADSR plus a second filter ADSR that feeds the modulation matrix rather than a dedicated knob.

## Skills Required
- **web-audio-api** — `BiquadFilterNode` across all modes, `WaveShaperNode` curve construction, `GainNode` VCA, `AudioParam` envelope scheduling.
- **audio-dsp** — biquad mode behaviour and slope, Q/resonance perception, soft-clip saturation curve design, ADSR shaping on log and linear scales.

## Acceptance Criteria
- [ ] Two cascaded filter stages exist per voice in series: filter 1 feeds filter 2, filter 2 feeds the amplifier. Verified by code inspection and by bypassing filter 1 and confirming the tone changes (proving it is genuinely in the path and not merely constructed).
- [ ] Each filter offers all five modes — LP24, LP12, HP12, BP12, Notch12 — and each is independently selectable. Verified by `playwright-cli eval` enumerating 5 modes per filter section (10 total) and confirming each selection changes the node's `type`.
- [ ] Cutoff spans exactly 20 Hz to 20 kHz on a logarithmic scale. Verified by setting both extremes and reading the resulting `AudioParam.frequency` values, expecting <= 20000 and >= 20.
- [ ] Resonance covers Q 0.5 to 30 and is audible: raising it audibly colours the tone up to Q 30 without the output clipping. Verified by comparing the RMS trace at Q 0.5 against Q 30 on a held note and confirming a change, and confirming the post-limiter output stays within range.
- [ ] The drive control operates a `WaveShaperNode` soft-clip curve, not raw gain. Verified by inspecting the node type and confirming that raising drive increases harmonic content — a comparison of the RMS trace at low and high drive with the level afterwards normalised by the master volume.
- [ ] Each filter is independently bypassable and bypassing genuinely removes it from the chain. Verified by toggling bypass and confirming the tone changes.
- [ ] Amp ADSR works: attack and decay span 1 ms to 5 s on logarithmic scales, sustain 0..100%, release 1 ms to 8 s. Verified by reading the envelope stage of a live voice through the inspection path at each stage and confirming it progresses attack → decay → sustain → release, and that a 1 ms attack is audibly near-instant.
- [ ] A filter ADSR exists and its output is exposed as a modulation-matrix **source** — there is **no dedicated filter-envelope amount knob**. Verified by `playwright-cli eval` counting filter-envelope-amount controls and expecting zero.
- [ ] Key tracking 0..100% is present on both filters. Verified by holding two different notes with tracking at 0 (cutoff unchanged) and at 100% (cutoff moves with pitch).
- [ ] The page captures no errors during load or during a played note.

## Technical Requirements
- Per-voice chain: voice mixer gain → filter 1 drive `WaveShaperNode` → filter 1 → filter 2 drive `WaveShaperNode` → filter 2 → VCA gain → voice output.
- LP24 is two cascaded 12 dB sections for the steeper slope. Implement it so the drive stage and the mode selection interact sensibly, and document the implementation.
- Mode list per stage: LP24, LP12, HP12, BP12, Notch12. BP12 and Notch12 both use `BiquadFilterNode` with a moderate Q default.
- Drive curve: a `Float32Array` soft-clip curve (tanh-shaped) whose drive amount comes from a pre-gain into the shaper and whose output is compensated afterwards so drive changes saturation rather than level.
- Filter envelope: a second ADSR running from note-on to note-off-plus-release, exposed as a bipolar 0..1 shaped value for the matrix to read, with its depth set **only** by the matrix cells for filter 1 cutoff and filter 2 cutoff. No separate amount control exists.
- Voice teardown from task 3 must continue to work: this chain adds nodes inside the voice subtree, and the single-entry-point disconnect covers them all.
- Continuous filter changes (cutoff, resonance, drive, key tracking) use scheduled ramps, not direct assignment, to avoid zipper noise.

## Input Dependencies
- The voice engine, voice mixer, ring-modulator bus and master bus from **Task 3**; the FM and unison values from **Task 4** and the wavesampler from **Task 5** all sum into this chain.
- The parameter store and painted-control factory from **Task 1**.

## Output Artifacts
- The per-voice filter chain: drive shapers, two cascaded biquad stages with bypass, and the VCA.
- The amp ADSR and the filter ADSR, with the filter envelope exposed as a matrix source.
- Rendered filter, drive, key-tracking and amp/filter envelope controls in the tone row regions.

## Implementation Notes

Resonance at Q 30 on a hot biquad produces very loud, very narrow peaks, and 16 voices of that will clip. The cap at Q 30 and the limiter in task 8 are both deliberate. Do not raise the ceiling and do not add a "resonance compensation" gain — the plan chose ears and CPU over headroom here.

The plan's risk register names the failure this task is most exposed to: pushing a biquad cutoff to zero or past Nyquist produces NaN output and can silence a voice **permanently**. Every cutoff-modulating route must be clamped to 20 Hz–20 kHz and to a fraction of the actual sample rate. Task 7 is where the clamp actually matters, so make the clamp a reusable function here that task 7 calls rather than clamping inside task 7's own code.

There is deliberately no dedicated filter-envelope amount knob. If you find yourself wanting one, the correct move is to set the matrix depth in the cell, not to add a control. Adding the knob duplicates a matrix cell and violates the plan's exclusion list.

The amp ADSR must survive a note-off during attack or decay: release starts from wherever the envelope currently is, not from the sustain level. Cancel and re-schedule the automation on note-off.

Every voice parameter this task exposes (cutoff, resonance, drive, key tracking, amp level) is also a modulation-matrix destination or source in task 7. Expose them as readable values and defined application points rather than leaving them as private `set()` calls.