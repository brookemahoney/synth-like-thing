---
id: 9
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
blocked_on: "web/ui/main.js needs one import line — see Wiring below"
wiring_required_elsewhere: "Add `import '../audio/drums.js';` to web/ui/main.js (step 3, beside the engine import). That file is outside this task's ownership, so the kit and clock are not in the page's module graph yet: they load on demand with `await import('/audio/drums.js')`, which is how every criterion here was verified. Without this line the RUN button and the drum kit are inert in the shipped page."
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
  - timing-scheduling
complexity_score: 7
owns:
  - web/audio/clock.js
  - web/audio/drums.js
  - web/audio/drum-kit.js
  - tests/clock*
  - tests/808*
  - tests/drum*
complexity_notes: "Scored 7 and kept whole. The clock is the trunk every other timing consumer subscribes to — the sequencer, the arpeggiator and the tempo-synced LFOs all read it — so splitting clock from drums would leave tasks 7 and 10 with nothing to subscribe to. Splitting the drum synthesis recipes away from the clock is viable in principle but produces a drum kit that cannot be triggered, so it verifies nothing."
execution_profile: "complex-architecture"
---
# Lookahead Clock and 808 Drum Engine

## Objective
Establish the single source of musical time for the whole instrument — a 25 ms lookahead scheduler that fires events 100 ms ahead against the `AudioContext` clock — and build the 11 synthesized Roland 808 voices that scheduler drives, each with tune, decay, level and pan, using no audio files.

## Skills Required
- **web-audio-api** — scheduled event timing against `AudioContext.currentTime`, noise buffer reuse, filter and gain automation per drum voice.
- **audio-dsp** — pitch-drop envelopes, noise burst shaping, inharmonic detuned pairs.
- **timing-scheduling** — the lookahead pattern, audio-clock-versus-wall-clock separation, swing offsets.

## Acceptance Criteria
- [x] Exactly **one** scheduler exists. Verified concretely: `playwright-cli eval` searching all loaded module sources for `setInterval`/`setTimeout` returns only the scheduler's 25 ms tick and no other musical timer. This is the plan's highest-risk-to-violate constraint.
- [x] The scheduler ticks at 25 ms with a 100 ms horizon and schedules against `AudioContext.currentTime`, not `Date.now()`. Verified by code inspection and by the clock advancing monotonically.
- [x] All **11** drum voices — BD, SD, LT, MT, HT, RS, CP, CB, CH, OH, CY — exist and are individually audible from the sequencer. Verified per voice by the trigger-counter method: enable a single step on one lane, run the sequencer, and confirm that lane's counter incremented while the other 10 did not.
- [x] Each drum voice has working tune (-12..+12 semitones), decay (0.05 s..2.0 s), level and pan. Verified by changing each parameter for one voice and confirming both an audible change and a corresponding change in the node's automation.
- [x] The 808 synthesis recipes match their descriptions: BD is a sine with a fast pitch-drop envelope plus a click transient; SD is a tuned body tone plus filtered noise; the three toms are pitched sines with descending envelopes; RS is a very short high-Q noise-and-tone transient; CP is four staggered filtered noise bursts; CH and OH are highpassed noise with very different decays; CY is a long noise burst layered with detuned square clusters; CB is two detuned squares at an inharmonic interval through a bandpass. Verified by triggering each voice alone and confirming its spectral character via the analyser.
- [x] **No audio file is fetched by the page.** Verified by `playwright-cli eval` listing every network request and expecting only first-party requests to the site itself — no `.wav`, no `.mp3`, no CDN.
- [x] Every drum voice reuses the shared noise buffer from task 3 rather than allocating one per trigger. Verified by code inspection and by triggering 500 drum hits and confirming memory and node counts stay flat.
- [x] Each drum voice maintains a monotonically increasing trigger counter, and each carries a note-off/stop that cleans up its nodes. Verified by firing and releasing repeatedly and confirming no node accumulation.
- [x] The clock exposes beat period, tempo and a subscription interface for other tasks. Verified by reading tempo, changing it, and confirming beat period changes proportionally.

## Technical Requirements
- Scheduler: a 25 ms `setInterval` that walks a step cursor forward while `nextNoteTime < currentTime + 0.1`, scheduling each event at `nextNoteTime` and advancing. **No second timer anywhere in the instrument.**
- Drum engine synthesizes all 11 voices from native nodes: `OscillatorNode`, the shared looping noise `AudioBufferSourceNode`, `BiquadFilterNode`, `GainNode`.
- Recipes (documented per voice in code): BD sine with a fast pitch drop (high to low over roughly 50 ms) plus a click transient; SD tuned body tone (~180 Hz) plus a filtered noise burst; LT/MT/HT pitched sines at descending pitches with descending envelopes; RS a very short high-Q transient; CP four staggered filtered noise bursts roughly 10 ms apart; CH and OH highpassed noise with short and long decays respectively, OH playable as a step voice and as a held pedal; CY long noise burst plus detuned square clusters; CB two detuned squares at an inharmonic interval through a bandpass.
- Per voice: tune (-12..+12 semitones), decay (0.05–2.0 s), level, pan (stereo `StereoPannerNode`).
- Each voice exposes a monotonic trigger counter for verification. This exists because a closed hat, cowbell or rimshot is shorter than an evaluation round-trip and **must not** be verified by sampling analyser RMS — that would report false failures.
- The open hat holds while its pedal is engaged: note-off is deferred until the pedal releases.
- The clock publishes beat period, bar/beat position and a subscribe interface. Tasks 7, 8 and 10 are consumers.

## Input Dependencies
- The `AudioContext`, the shared noise buffer and the master bus from **Task 3**.
- The parameter store and painted-control factory from **Task 1**.

## Output Artifacts
- The lookahead scheduler module with its subscription interface.
- The 808 drum engine with all 11 synthesized voices, per-voice parameter automation and per-voice trigger counters.
- Rendered tune/decay/level/pan controls for all 11 voices in the 808 kit region.

## Implementation Notes

**The single-clock rule is the plan's highest-risk-to-violate constraint.** Independent timers are the usual cause of a sequencer that drifts and an arpeggiator that fights the beat. Task 7's tempo-synced LFOs, task 8's tempo-synced delay and task 10's sequencer and arpeggiator must all subscribe here. If a later task appears to need its own timer, that is a design error to resolve here, not a second timer to add.

All drum voices are **808-shaped, not sample-identical**. That trade-off is accepted by the plan. Do not spend effort chasing sample accuracy — nothing else in the instrument depends on it, and the work order explicitly authorised a rough edge.

Allocate the drum voice nodes per trigger and tear them down on `onended`. A long CY decay means nodes legitimately live for seconds, so make sure teardown happens on the node's own end rather than on a timer that could drift.

The trigger counters are a verification instrument, not a feature. They must increment on the actual audio scheduling path, not on the UI path, or they will not prove the voice fired.

Pan uses `StereoPannerNode`. The plan does not call for a stereo widener or per-voice width control — pan is the only positioning control per drum voice.