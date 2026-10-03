---
id: 3
group: "monet-inspired-browser-synthesizer"
dependencies: [1]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
complexity_score: 7
complexity_notes: "Scored 7 and kept whole rather than split. Splitting the allocator from the oscillator cores would produce an intermediate state that allocates voices but makes no sound, so nothing could be verified between the halves. It is already atomic in the sense that matters: one module, one deliverable, the raw note-producing layer. Acceptance criteria were sharpened instead — each one names a concrete command and expected output."
execution_profile: "complex-architecture"
---
# Voice Engine Core: Allocator, Oscillator Cores and Mixer

## Objective
Build the raw sound-generating layer: a 16-voice allocator that steals voices predictably, three oscillator cores per voice offering all 10 waveforms with octave, semitone, fine-tune and level control, a shared looping noise buffer, a voice mixer, and a master bus that later audio tasks plug into.

## Skills Required
- **web-audio-api** — `AudioContext` ownership, `OscillatorNode` types, `PeriodicWave`, `AudioBufferSourceNode` looping, `GainNode` summing, `AudioParam` scheduled automation.
- **audio-dsp** — pitch/frequency computation across octave, semitone, cents and modulation contributions; soft-clip curve construction where needed.

## Acceptance Criteria
- [ ] The instrument can play a note and produce measurable output. Verified concretely: click the on-screen key or press a computer key, then read the analyser RMS through `playwright-cli eval` and confirm it rises well above the idle floor; release, wait, and confirm it returns to the floor. (If the meter from task 13 is not yet available, read `AudioContext` output through a temporary `AnalyserNode` you attach during verification and remove afterwards.)
- [ ] All 10 waveform options exist and are individually selectable per oscillator. Verified: `playwright-cli eval` counts 10 distinct waveform options per oscillator section (30 across three sections) and enumerates their values.
- [ ] Octave range is exactly -2..+2, semitone offset exactly -12..+12, fine tune in cents, and level 0..100% per oscillator. Verified by setting each to an extreme through the store and reading the resulting `AudioParam` value back.
- [ ] A held note at the default init patch produces sound with the filters, LFOs, matrix, delay and reverb all at zero — proving this task alone is audible.
- [ ] The allocator hands out at most 16 concurrent voices and steals the **oldest released** voice first, falling back to the **oldest sounding** voice when all 16 are busy. Verified by firing 20 overlapping notes and confirming the live voice count never exceeds 16 and that the released-first ordering is observed.
- [ ] Voice teardown disconnects the voice's entire subtree from a single entry point rather than unwiring individual nodes. Verified by code inspection of the teardown path and by firing/stopping 200 notes and confirming the live node count does not grow monotonically.
- [ ] All pitch-affecting inputs — keyboard note, octave, semitone, fine tune, and the modulation-matrix contribution — resolve through one per-voice frequency computation and are applied via scheduled automation, never by writing a frequency value directly during a gesture.
- [ ] The page fetches no audio file. Verified by `playwright-cli eval` listing every network request the page made and expecting only first-party requests to the site itself.
- [ ] `playwright-cli eval` reading the captured-error array after load and after playing notes returns an empty array.

## Technical Requirements
- `AudioContext` is created once, owned by this layer, and exported for later tasks. It may be created in the suspended state; the power-on gesture in task 11 is what resumes it.
- Voice structure per voice: three oscillator core gain nodes feeding a voice mixer gain, and the voice mixer feeding a master bus gain.
- Waveforms: Sine, Triangle, Sawtooth, Square (50% duty), Pulse 25%, Pulse 12.5%, Reverse saw (rising ramp), Saw (falling ramp), White noise, and an additive "reed" `PeriodicWave` summing harmonics 1, 2, 3, 4, 6 and 8 at decreasing amplitude. Pulse widths beyond those three are out of scope.
- Pulse waves are built as `PeriodicWave` Fourier pairs; reverse saw is a saw `PeriodicWave` with the coefficients negated.
- White noise comes from a single looping `AudioBufferSourceNode` over a white-noise buffer created once at startup and **reused by every noise voice and every drum voice** — do not allocate a noise buffer per note.
- Per-voice mixer and oscillator level gains are separate nodes so task 7 can apply summed modulation without touching structure.
- Placeholder summing inputs: create dedicated gain nodes for the **ring-modulator bus** and the **wavesampler slot** now, so tasks 4 and 5 connect into them without rewiring the mixer. The wavesampler placeholder is a gain node with no source feeding it and a level of 0.
- Voice allocator policy: steal oldest released, then oldest sounding. Track note identifier, release time and voice start time per voice.
- Note events carry pitch, velocity, a note identifier and a fresh per-note random value for per-note modulation. The voice exposes its live pitch, live filter cutoff and current amplitude for tasks 10, 13 and self-validation.
- `AudioParam` changes use `setTargetAtTime` or `linearRampToValueAtTime` with a short ramp; direct `.value` assignment is reserved for changes made while the voice is silent.

## Input Dependencies
- The parameter store and the section skeleton from **Task 1** (this task renders its controls into the three oscillator regions plus the mixer region).

## Output Artifacts
- The audio engine module owning the `AudioContext`, the shared noise buffer and the master bus gain, exported for tasks 5, 6, 8, 9 and 11.
- The voice allocator with its documented stealing policy.
- The oscillator core module with all 10 waveforms and per-core parameter application.
- The voice mixer with the ring-mod bus and wavesampler placeholder summing inputs.
- Per-voice live-state readouts: pitch, per-oscillator level, envelope stage.
- Rendered controls in the three oscillator regions and the mixer region.

## Implementation Notes

**This task is the trunk of the instrument.** Tasks 4, 5, 6, 7 and the melodic lane of task 10 all build on the structures created here. Everything they need must exist as a node by the end of this task — not created later by rewriting this module.

The three oscillator cores and their controls live in the **Voice** row regions that Task 1 already laid out. Do not move region boundaries.

Voice teardown is the highest-risk routine in the instrument. A `WaveShaperNode`-free path is not the issue; the issue is that an oscillator left connected somewhere keeps sounding forever. The mitigation is structural: each voice exposes **one entry-point node**, and teardown disconnects that single node from its parent. Never walk the graph unwiring individual children.

A stopped `OscillatorNode` cannot be restarted. Each note-on therefore creates fresh oscillator nodes and note-off schedules their stop and hands them to `onended` for disconnect. Do not try to recycle oscillator nodes.

The `AudioContext` is created suspended, not lazily. Creating it lazily on the first gesture means every module has to handle "the context does not exist yet", which pushes null checks through the entire codebase. Suspended-and-exported is one null check in one place.

Noise-as-waveform is not band-limited and will hiss at high pitches. That trade-off is accepted by the plan. Do not attempt to fix it — there is no `AudioWorklet` in this project.