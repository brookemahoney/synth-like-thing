---
id: 4
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
complexity_score: 5
owns:
  - web/audio/osc-mod.js
  - web/audio/voice.js
  - tests/osc-mod*
  - tests/fm*
  - tests/unison*
  - tests/ring*
execution_profile: "standard-implementation"
---
# FM, Ring Modulation and Unison Spread

## Objective
Add the three cross-oscillator mechanisms to the voice: per-oscillator frequency modulation with a selectable source, pairwise ring-modulator assignment between cores, and unison voice count of 1 to 7 with a detune-spread control.

## Skills Required
- **web-audio-api** — connecting and disconnecting oscillator nodes in a live graph, per-oscillator `detune` and `frequency` automation.
- **audio-dsp** — FM index versus depth in cents/hertz, ring-modulation sideband behaviour, detune spread distribution.

## Acceptance Criteria
- [ ] Each oscillator core exposes FM amount, FM source selection, unison count (1..7), detune spread and a ring-modulator assignment control. Verified by counting the controls via `playwright-cli eval` and asserting 3 of each exist.
- [ ] FM is audible and its source selection is real: with FM amount at maximum and source set to oscillator 2, changing oscillator 2's frequency audibly changes oscillator 1's pitch. Verified by holding a note, reading oscillator 1's live pitch via `playwright-cli eval` before and after changing oscillator 2's frequency, and confirming the value moved.
- [ ] Unison is audible: with unison count 7 and spread at maximum, holding one note produces a single noticeably thicker, detuned voice rather than one clean pitch. Verified by comparing the analyser RMS trace of unison 1 against unison 7 while holding the same note, and confirming the wider spread raises RMS variance.
- [ ] Ring modulation is pairwise and non-exclusive: assigning core 1 to ring-modulate core 2 adds a ring-modulator output to the voice mix **while core 2 still feeds the mixer directly**. Verified by setting ring mod on, silencing core 2's own level to zero and confirming sound still appears (core 2's contribution now arrives only through the ring product), then restoring core 2's level and confirming the tone changes.
- [ ] Ring modulation off means the ring-modulator bus contributes silence. Verified by reading the ring-mod bus level with the assignment disabled.
- [ ] Teardown survives re-routing: change FM source, unison count and ring assignment repeatedly during a held note and confirm the note keeps playing and no orphan node survives — verified by firing and re-routing 100 times and confirming the live node count is stable.

## Technical Requirements
- FM: a modulator oscillator's output routed into the carrier's `frequency` `AudioParam`. FM amount maps 0..100% onto a musically sensible depth in cents or hertz. FM source selection covers the other oscillator cores plus the wavesampler slot once task 5 lands.
- Unison: unison count N produces N detuned copies of the core. With N above 1, one node plays and the rest are copies whose `detune` is spread around the centre pitch by the spread control (in cents, distributed symmetrically, e.g. linearly across ±spread). Document the distribution you chose.
- Ring modulation: a `GainNode` set to 0 feeds one core's output as its own input, producing the product of the two signals. The ring-mod bus gain from task 3 is the summing point; the product gain feeds it.
- Re-routing must be safe at any time, including mid-note. When an assignment changes, disconnect the old modulator connection and connect the new one rather than accumulating connections.
- Unison copy nodes are created at note-on and stopped at note-off alongside the core's own node, so they cannot outlive the voice.
- Both FM amount and unison spread are modulation-matrix destinations in task 7. Expose them as read values the matrix can read, and clamp matrix contributions to the same ranges as the manual controls.

## Input Dependencies
- The voice engine, the ring-modulator bus placeholder and the master bus from **Task 3**. This task connects into nodes task 3 already created; it does not restructure the voice.

## Output Artifacts
- FM routing per oscillator core, with selectable source and amount.
- Unison voice generation with count and detune spread per core.
- Ring-modulator pairs wired into the voice mixer's ring-mod bus.
- The rendered FM, unison and ring-mod controls in the oscillator regions.

## Implementation Notes

Ring modulation is a graph-topology change, not a parameter change. `a * b` needs both signals in one gain node with one of them fed into its own input. Turning ring mod "off" is therefore a disconnect plus a gain return to 0, not just a gain of 0.

The plan's risk register names the exact failure this task can cause: an oscillator routed to a node it should no longer be routed to, so a voice never stops sounding. Teardown must keep working regardless of what this task connects, which is why task 3's teardown disconnects one entry point rather than unwiring.

Unison count 7 across three cores is 21 oscillator nodes per voice, and 16 voices can therefore reach 336 oscillators plus FM modulators. That is a real load. Do not create unison copies for cores whose level is 0 — skip them and create the copies lazily on the first non-zero level. Keep that optimisation simple and document it.

FM amount feeding `AudioParam.frequency` should use scheduled ramps, not direct writes, for the same reason every other continuous parameter does: direct per-frame assignment during a drag produces zipper noise and FM makes it far more audible.