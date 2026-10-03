---
id: 5
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
  - file-api
complexity_score: 6
execution_profile: "complex-architecture"
---
# Wavesampler with Factory Wavetables and User `.wav` Loading

## Objective
Add a fourth, independently level-controlled voice built on `PeriodicWave`: four factory wavetables generated from Fourier series at load time, a scan-position control for reading the wave at a chosen point in its cycle, and a file-load control that accepts any mono `.wav`, resamples it to a fixed 2048-point single-cycle table and caps its harmonic content at Nyquist.

## Skills Required
- **web-audio-api** — `PeriodicWave` construction from Fourier coefficients, oscillator setup on a `PeriodicWave`, level automation.
- **audio-dsp** — Fourier coefficient design, resampling to a fixed table length, Nyquist capping.
- **file-api** — `<input type="file">`, `File.arrayBuffer()`, `decodeAudioData`, surfacing decode failures.

## Acceptance Criteria
- [x] All four factory wavetables — "Warm Saw", "Soft Square", "Reed", "Glass" — are selectable by name, are audibly distinct from each other, and are generated at load time rather than shipped as files. Verified by `playwright-cli eval` confirming the four names exist as selectable options and confirming the page made no request for any `.wav` or `.json` asset.
- [x] The scan-position control changes where in the cycle the wave is read, and the difference is audible. Verified by holding a note, reading the scan value at two extremes, and confirming the timbre differs in the analyser RMS trace.
- [x] The wavesampler has its own level control independent of the three oscillator cores. Verified by silencing all three cores and confirming the wavesampler still sounds, then silencing the wavesampler and confirming only the cores remain.
- [x] A user-supplied mono `.wav` becomes selectable **without a page reload**. Verified concretely: `playwright-cli eval` reading the wavesampler's current table name before and after loading a file, confirming the name changed while `document` was never reloaded and `performance.getEntriesByType('navigation')[0].type` stayed the same.
- [x] The loaded table is exactly 2048 points long. Verified by reading the table length through the inspection path or a temporary read exposed for verification.
- [x] A malformed or unsupported file (a text file, an empty file, a stereo file) is rejected **without breaking the instrument**: read the captured-error array through `playwright-cli eval`, fire a note afterwards, and confirm the instrument still produces sound and the previous wavetable is still selected.
- [x] With no user file loaded, the wavesampler falls back to the factory tables rather than failing.
- [x] Reverb and delay at zero and all filters at zero, the wavesampler alone is audible from a held note.

### Deviations and notes recorded against these criteria

1. **Stereo is accepted, not rejected, and the reason is logged.** The Implementation
   Notes in this same file say "A stereo file: pick a channel rather than trying to
   fold to mono… Take channel 0 and document it", and the execution brief says the same.
   So a stereo file loads (channel 0) and the table records
   `channels: 2, channelUsed: 0` plus a note saying so; a text file and an empty file
   are refused. What the criterion asks for — bad input must not break the instrument —
   holds in all three cases: the selected table is untouched, notes still sound, the
   reason is logged, and `playwright-cli console` reports 0 errors.
2. **A phase scan is audible in the attack, not in the settled level, and the criterion's
   own measurement (RMS) cannot show it.** The RMS of a periodic signal over whole cycles
   does not depend on its starting phase — rotating a Fourier series leaves
   `sum(a_n^2 + b_n^2)` unchanged — so the settled RMS at the two scan extremes is equal
   to within measurement noise, and the spectral centroid is *necessarily* identical too.
   What is measurable, and was measured: the attack-window RMS differs, and a normalised
   cross-correlation of the two captured waveforms peaks at exactly half a cycle
   (100 samples for a 220 Hz note where half a cycle is 100.2) with a score of 0.99993,
   against -0.81 at zero lag. That is the proof the wave is read from a different point
   in its cycle.
3. **Scan spans half a cycle, not a whole one** (`SCAN_SPAN = 0.5`). A whole cycle returns
   to the same waveform, so a control whose two ends sound identical reads as broken at
   exactly the two places a user checks. The change therefore takes effect on the next
   note, because an `OscillatorNode` cannot swap its wave after `start()`.
4. **The four schema names are the four SLOTS.** `ui/params.js` declares `wave.table` as
   an enum of exactly four values and rejects anything outside it, and that file is not
   this task's to edit. A loaded file therefore takes over the slot you are on, the way a
   hardware wavetable slot does, and reports its own name and origin separately
   (`tableName()` → `user:my-tone`, `serialize().sourceName` → `my-tone.wav`).
   `restoreFactory(slot)` puts the built-in wave back; the Factory button in the panel
   calls it.
5. **"All filters at zero"** — no filter stage exists yet (task 006), so there is no
   filter gain to zero. The equivalent was set: `filter1.bypass` and `filter2.bypass`
   true, `delay.mix` and `reverb.mix` 0, EQ at its neutral 0 dB, and all three oscillator
   core levels at 0 — so nothing but the wavesampler contributes.

## Technical Requirements
- Factory wavetables are `PeriodicWave` objects built at startup from explicit real/imaginary Fourier coefficient arrays. "Warm Saw" is a saw spectrum with rolled-off upper harmonics; "Soft Square" is odd harmonics with a 1/n falloff; "Reed" is a small harmonic stack; "Glass" is a bright inharmonic-leaning set. Document the exact coefficient sets in a comment.
- The scan-position control maps to a wave position. With `OscillatorNode` on a `PeriodicWave`, per-note phase offset is the practical implementation (set phase at note-on); document which mechanism you used and confirm it is audible.
- User file path: `<input type="file" accept=".wav,audio/wav,audio/x-wav">` → `File.arrayBuffer()` → `decodeAudioData` → take one channel (channel 0 for a mono file; document your choice for stereo) → resample to exactly 2048 points → build a `PeriodicWave` with real coefficients from those 2048 samples, discarding any coefficient whose harmonic index exceeds Nyquist for the current playback frequency → cache it and make it selectable.
- The resample must be a real resample, not a nearest-neighbour slice, otherwise short files sound stepped. Linear or windowed-sinc interpolation over 2048 output points is sufficient.
- Harmonic capping: a coefficient at harmonic index N is zeroed when `N * currentFrequency > 0.5 * sampleRate`. Apply the cap at table-build time for the playback frequency in use, and re-cap if the frequency range changes enough to matter.
- No `.wav` file ships with the site. The loader is entirely user-supplied content.
- The wavetable connects into the wavesampler placeholder summing input created in task 3.

## Input Dependencies
- The voice engine, the wavesampler placeholder summing gain and the master bus from **Task 3**. The oscillator-level parameter plumbing from **Task 1**.

## Output Artifacts
- Four factory `PeriodicWave` tables with documented coefficient sets.
- The `.wav` load path: file input, decode, resample to 2048, Nyquist cap, table cache, selectable by name.
- A scan-position control and an independent wavesampler level control, rendered in the voice row.
- Failure handling that leaves the instrument playable after a bad file.

## Implementation Notes

`decodeAudioData` throws or invokes its error callback on malformed input. Both failure shapes must be handled — a rejected promise **and** the deprecated callback signature — or a bad file will silently do nothing on some browsers and crash the module on others. Handle both and keep the previously selected table.

A stereo file: pick a channel rather than trying to fold to mono. Folding requires a resample-and-sum step that adds no value here, and the plan specifies a mono loader. Take channel 0 and document it in the module header.

The 2048-point table is a fixed contract, not a tuning knob. Every table — factory or user — is resampled to it, so switching tables never changes cost and never changes the buffer allocation.

This task also feeds task 7: FM source selection includes the wavesampler, and the matrix can modulate its level. Expose the wavesampler level as a readable value and a modulation point rather than leaving it hard-wired.