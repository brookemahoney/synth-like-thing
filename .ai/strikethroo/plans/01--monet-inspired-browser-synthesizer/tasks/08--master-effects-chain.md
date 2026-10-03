---
id: 8
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
complexity_score: 6
execution_profile: "complex-architecture"
---
# Master Effects Chain: EQ, Delay, Reverb, Limiter and Analyser

## Objective
Finish the signal with the three stages the work order named explicitly, in order: a 3-band EQ, then the delay, then the reverb, then a safety limiter, then an `AnalyserNode`, then the destination. Master volume sits before the limiter.

## Skills Required
- **web-audio-api** — `BiquadFilterNode` shelves and peaks, `DelayNode` with a feedback loop, `ConvolverNode`, `DynamicsCompressorNode`, `AnalyserNode`, `AudioParam` automation for delay time.
- **audio-dsp** — generated impulse-response construction, feedback-loop stability, convolution cost.

## Acceptance Criteria
- [x] The master chain is in the agreed order: 3-band EQ → delay → reverb → limiter → analyser → destination. Verified by code inspection of the node connection order and by the audible consequences below.
- [x] The EQ is three bands — low shelf at **200 Hz**, peaking band at **800 Hz** with **Q 0.7**, high shelf at **3 kHz** — each with **-18 to +18 dB**, and each is individually audible. Verified by comparing the analyser RMS trace with each band at -18 dB, at 0 dB and at +18 dB, and confirming a distinct change for each. No 6-band or parametric version exists.
- [x] The delay offers time from **1 ms to 2 s**, feedback from **0 to 95%** with a hard ceiling below unity, a tone control (lowpass in the feedback path, **400 Hz to 20 kHz**), a dry/wet mix, and a tempo-synced fraction option. Verified: with mix above zero and feedback above zero, fire a note and confirm repeats are present in the RMS envelope trace; raise the tone lowpass and confirm the repeats darken.
- [x] Delay feedback cannot run away. Verified by setting feedback to its maximum and firing notes continuously for at least 30 seconds, then confirming the post-limiter output is still within range and the instrument remains responsive.
- [x] The reverb is a `ConvolverNode` whose impulse response is generated at startup, with a decay control from **0.3 s to a 12 s ceiling**, a damping lowpass, a pre-delay, and a wet/dry mix. Verified: with mix above zero, confirm a tail is present in the RMS trace after the note is released; set decay to 12 s and confirm the tail persists without CPU collapse.
- [x] The reverb stage is fully bypassed at mix zero. Verified by confirming the tail disappears entirely from the RMS trace.
- [x] The delay sits **before** the reverb, so delay taps feeding into reverb get the wash. Verified by raising delay mix and reverb mix together and confirming the repeats arrive diffused rather than dry.
- [x] The limiter is present and protective: 16 voices with unison spreads and resonant filters peaking together do not produce clipped output. Verified by driving the instrument hard (multiple held chords, resonance high, unison 7 on all cores) and confirming the output RMS does not exceed a sane ceiling and no clipping artefacts appear.
- [x] Master volume sits before the limiter and affects the whole output. Verified by comparing output RMS at 0% and at 100% master volume.
- [x] The `AnalyserNode` is reachable for tasks 12 and 13 and exposes enough data for an RMS reading. Verified by reading an RMS value through `playwright-cli eval` and confirming it is a finite number.

## Technical Requirements
- Master bus gain (from task 3) → EQ → delay → reverb → limiter → master volume → analyser → destination. Confirm the master-volume position: the plan puts it before the limiter.
- EQ: `lowshelf` at 200 Hz, `peaking` at 800 Hz with Q 0.7, `highshelf` at 3 kHz. Gain range -18..+18 dB.
- Delay: `DelayNode` plus a feedback gain plus a lowpass in the feedback path for the tone control. The feedback gain has a hard ceiling below unity (max 95%) so the loop is unconditionally stable. Mix is a wet/dry crossfade.
- Tempo-synced delay time is a fraction of the current beat period supplied by task 9's clock; the automated delay time uses scheduled ramps so tempo changes do not click.
- Reverb impulse response: generated once at startup as a decaying noise burst with an exponential envelope. Regenerated **only** when the decay control actually changes, not per note. Damping lowpass and pre-delay sit in the wet path. The 12 s decay cap is a CPU guard and is a hard ceiling, not a default.
- Limiter: `DynamicsCompressorNode` with a fast attack and a high ratio.
- Analyser: `AnalyserNode` with an `fftSize` sufficient for a stable RMS reading, `getFloatTimeDomainData` used by task 13.

## Input Dependencies
- The `AudioContext` and master bus from **Task 3**.
- The delay-time and reverb-send modulation points from **Task 7** for the tempo-sync fraction and the master-stage matrix destinations.

## Output Artifacts
- The full master effects chain in the agreed order.
- A generated impulse-response builder with the exponential decay envelope and the 12 s cap.
- Rendered EQ, delay and reverb controls in the effects row.

## Implementation Notes

The convolution reverb is the most expensive node in the graph and it runs continuously once started. The plan's mitigations are non-negotiable: cap decay at 12 s, generate the impulse response once and regenerate it only when decay changes, and give the stage a dry/wet control that removes it from the cost when unused. A naive implementation that rebuilds the impulse response on every control tick will stall the audio thread.

Delay feedback must have a **hard** ceiling below unity. A feedback gain that reaches or exceeds 1.0 in a loop with a wet/dry crossfade will run away. Cap the parameter at 95% and do not add any other gain inside the loop.

The delay-before-reverb order is a deliberate signal-flow choice, not an arbitrary one: it matches the Thor reference and means delay taps receive the reverb wash. Reversing the two changes the character noticeably — the wash will sound like a separate layer rather than part of the space.

The limiter is doing safety work, not tone shaping. Master volume should default low enough that the limiter is not engaged during normal playing. If it is constantly squashing normal output, the default levels elsewhere are wrong — fix those rather than loosening the limiter.

`fftSize` here is chosen for task 13's RMS meter and task 12's envelope verification. Pick a value now and document it; changing it later changes the time-domain window and invalidates readings.
## Implementation Notes (from execution)

Two deviations from the node list above, both forced by measurement and both in the
files this task owns:

1. **`global.volume` moved from `masterBus.gain` to `masterVolume`, a node between
   the reverb and the limiter.** `masterBus` sits upstream of the whole chain, so it
   could not satisfy "master volume before the limiter" as written. `masterBus` is now
   a unity sum and the binding lives on the new node. Still the ramp bridge, still a ramp.

2. **A one-node `WaveShaperNode` safety clipper sits between the limiter and the
   analyser.** A `DynamicsCompressorNode` is not a brickwall: with the summing bus
   driven to 8.8-11.7 by 16 voices at unison 7 and resonance 30, the post-limiter peak
   measured **1.22-3.10** (hard clipping) and shortening its attack from 3 ms to 0.1 ms
   moved it by 0.13. The clipper is identity below -3.1 dBFS and cannot emit a sample
   above 0.89; the post-chain peak now measures 0.88693 under the same load.

The reported upstream gain is the underlying problem: +19 to +21 dBFS at the summing bus
comes from `mixer.level`, the per-core levels and the voice count in `ui/params.js`,
which this task does not own. That is reported, not silently absorbed.

A third thing worth recording: a bypassed `ConvolverNode` retains its convolution
history, so re-arming the reverb after a loud passage replayed 0.26 RMS of phantom
output from silence and sustained itself. Re-arming now builds a fresh node reusing the
already-built response (26-40 ms at the 12 s ceiling, paid once per arm/disarm).

## API for tasks 7 and 13

From `web/audio/effects.js`: `analyser`, `ANALYSER_FFT_SIZE` (2048 — a 42.7 ms window
at 48 kHz, fixed and written nowhere else), `readLevels() -> { rms, peak }`,
`effectNodes() -> [{ label, kind, feeds, connected }]`, `modulateDelayTime(cents)`,
`modulateReverbSend(amount)`, `syncDelayToTempo(bpm)`, `reverbIrStats()`,
`setDelayTime`, `setDelayFeedback`, `setDelayMix`, `setReverbMix`, `setMasterVolume`,
`flushIrRebuild`, plus the node handles `eq`, `delay`, `reverb`, `masterVolume`,
`limiter`, `safetyClip`. `reverb.convolver` is a getter, because re-arming replaces it.
`master.js` still exports `connectToOutput(node)` for a meter tap.
