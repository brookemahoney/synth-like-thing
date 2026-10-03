---
id: 10
group: "monet-inspired-browser-synthesizer"
dependencies: [9]
status: "in-progress"
created: 2026-10-02
skills:
  - web-audio-api
  - timing-scheduling
complexity_score: 7
complexity_notes: "Scored 7 and kept whole. The sequencer, the pattern chain and the arpeggiator share one clock, one step cursor and one lane-rendering path; splitting them produces parts that cannot be verified against the beat. The requirement that all 4 patterns plus an arbitrary chain order loop correctly is only observable with the chain mode in place."
execution_profile: "complex-architecture"
---
# 16-Step Sequencer, Pattern Chain and Arpeggiator

## Objective
Build the rhythmic and note-ordering half of the instrument on the single clock: a 16-step sequencer with 11 drum lanes plus a melodic synth lane carrying per-step on/off and per-step velocity, a melodic note and gate length per step, transport (tempo, swing, run/stop, playhead), 4 patterns A–D with a chain mode over an ordered list, and a 5-mode tempo-synced arpeggiator.

## Skills Required
- **web-audio-api** — scheduled note and drum triggering, gate-length envelope for the melodic lane.
- **timing-scheduling** — swing offsets on odd sixteenths, lookahead step scheduling, chain-order iteration, arpeggiator note ordering.

## Acceptance Criteria
- [ ] Exactly **16 steps**. Verified by `playwright-cli eval` counting 16 step columns.
- [ ] **12 lanes** exist: 11 drum lanes plus 1 melodic synth lane. Verified by counting lanes and matching them against the 11 drum voice names from task 9.
- [ ] Every lane has a per-step on/off and a per-step velocity (accent) of 0..100%, and the melodic lane adds a chromatic note and a gate length of 10..100% per step. Verified by enumerating per-step values through `playwright-cli eval` and confirming the velocity affects audible level on a drum lane and the gate length affects note length on the melodic lane.
- [ ] Tempo runs from **40 to 220 BPM**, and the playhead indicator follows the firing step. Verified by setting both tempo extremes, running, and reading the playhead; at 220 BPM the step rate measurably exceeds the rate at 40 BPM.
- [ ] Swing runs **50% to 75%** applied to odd sixteenths and audibly offsets them. Verified by setting swing to 50% and to 75% and comparing the spacing of odd steps in the timing trace, and confirming 50% is straight.
- [ ] **4 patterns (A–D)** each hold independent step data, and switching patterns changes what plays. Verified by writing a distinct step into pattern A and a different step into pattern B, switching, and confirming the audible result changes.
- [ ] **Chain mode** over an ordered list loops correctly, including a non-trivial order such as `A-B-A-D`. Verified by running the chain and reading the pattern indicator repeatedly, confirming the order repeats indefinitely and matches the configured sequence.
- [ ] Chain order is edited by clicking pattern slots in sequence. Verified by clicking A, then B, then D and confirming the chain reads `A-B-D` through `playwright-cli eval`.
- [ ] The sequencer runs and stops cleanly: stop halts scheduling immediately and no further steps fire. Verified by reading the step index before and after stop with a wait in between and confirming it did not advance.
- [ ] All **5** arpeggiator modes — Up, Down, Up-Down, Random, As-Play — produce their distinct note orderings. Verified by holding a 3-note chord and reading the firing-note readout repeatedly for each mode, confirming the ordering changes per mode.
- [ ] The arpeggiator's rate covers 1/4 down to 1/32 including triplet variants, its octave range is 1..4 and takes effect, and its gate length is 10..100%. Verified by measuring the interval between firing notes at 1/4 and at 1/32 and confirming the 1/32 rate is roughly four times faster; then confirming the octave range widens the note span.
- [ ] The arpeggiator can be set to process the melodic sequencer lane's notes or bypassed so the lane plays as written. Verified by toggling it while the melodic lane runs and confirming the audible result changes accordingly.
- [ ] Held keyboard notes feed the arpeggiator. Verified by holding three keys via `playwright-cli press` and confirming arpeggiator firing notes cycle among them.
- [ ] The sequencer's melodic lane plays notes through the voice engine at the correct pitch. Verified by reading the voice's live pitch on a melodic step and confirming it matches the configured note.

## Technical Requirements
- The sequencer is a subscriber to task 9's lookahead clock. It walks 16 steps per bar and schedules ahead against the clock's tick. It does not own a timer.
- Swing 50%..75% offsets **odd sixteenths**: the odd step's scheduled time is delayed by `(swing - 0.5) * stepDuration`.
- Per-step velocity maps to drum voice level and to melodic lane velocity.
- Melodic lane per step: chromatic note index and gate length; the gate length determines the note's duration as a fraction of the step, released by the clock.
- Patterns A–D each hold 12 lanes × 16 steps of `{on, velocity}` plus the melodic lane's `{note, gate}`.
- Chain mode is an ordered array of pattern indices, iterated indefinitely, advancing when a pattern's bar completes.
- Playhead: a store key the visual layer (task 2) already knows how to render as the glistening step dab. Set the store key; do not paint the playhead here.
- Arpeggiator: modes Up, Down, Up-Down, Random, As-Play; rates 1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32; octave range 1..4; gate 10..100%. It consumes held notes from the keyboard (task 11) or the melodic lane.
- The arpeggiator and the melodic lane both produce note events into the **same** note-event path as the keyboard, so they share voice allocation and envelope behaviour.

## Input Dependencies
- The lookahead clock and the 808 drum engine from **Task 9** (the sequencer triggers drums; the arpeggiator is tempo-synced to the same clock).
- The voice allocator and note-event path from **Task 3** (the melodic lane and the arpeggiator both produce note events).
- The parameter store, painted-control factory and playhead accent key from **Tasks 1 and 2**.

## Output Artifacts
- The 16-step sequencer with 12 lanes, per-step on/off, velocity, melodic note and gate.
- Transport: tempo 40–220, swing 50–75%, run, stop, playhead.
- 4 patterns A–D plus chain mode with click-to-build ordering.
- The 5-mode arpeggiator with rate, octave range and gate length.
- Rendered sequencer, transport, pattern and arpeggiator controls in the sequencer row.

## Implementation Notes

The melodic lane and the arpeggiator must produce notes through the **same** note-event path as the keyboard. Two parallel note paths would mean two envelope behaviours and two allocator interactions, and the audible result would differ depending on whether a note came from the keyboard or the sequencer.

Chain mode is not a special playback path — it is the normal sequencer reading from a different pattern index each bar. Implementing it as a separate code path guarantees the two will drift apart.

Swing is applied at **schedule time**, not at playback time. Because the scheduler runs 100 ms ahead, a swing value changed mid-bar must not retroactively move already-scheduled steps; apply the value that was current when the step was scheduled and document that.

The playhead is a store key, not a painted element. Task 2 already defined the glistening step dab driven by that key. Setting the store key is the whole integration; if this task paints its own playhead there will be two of them.

Arpeggiator **Random** mode needs a note ordering that is reproducible enough to verify but genuinely random per cycle. Seed it or use the voice layer's per-note random, and document the choice — an unverifiable random mode is a validation trap.

This task's arpeggiator reads held notes, which task 11 supplies. Before task 11 lands, verify the arpeggiator against the melodic lane's notes, which are available now.