---
id: 7
group: "monet-inspired-browser-synthesizer"
dependencies: [6]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - audio-dsp
complexity_score: 7
owns:
  - web/audio/matrix.js
  - web/audio/lfo.js
  - web/audio/modulation.js
  - tests/matrix*
  - tests/lfo*
  - tests/mod-*
readonly:
  - web/audio/filter.js
  - web/audio/effects.js
  - web/audio/voice.js
complexity_notes: "Scored 7 and kept whole. Splitting the LFOs from the matrix would leave an intermediate state with an unconsumed source list and no way to verify either half in isolation; the matrix is what makes the LFOs observable, and the LFOs are what make the matrix non-trivial. Its correctness constraint — 64 routes must be summed into one vector per voice and clamped at a small number of defined points — is a property of the pair, not of either part."
execution_profile: "complex-architecture"
---
# LFOs and the 8x8 Modulation Matrix

## Objective
Supply continuous and per-note movement and give it somewhere to go: three LFOs with free-running or tempo-synced rates, six shapes including sample-and-hold, and a fade-in; plus the 8x8 modulation matrix where 64 bipolar routes are summed once per voice per scheduling block into a single vector and applied at a small number of defined points.

## Skills Required
- **web-audio-api** — `OscillatorNode`-based LFOs, scheduled rate changes, `setValueCurveAtTime` for fade-in, connecting modulation outputs to `AudioParam` offsets.
- **audio-dsp** — bipolar modulation scaling, per-block summation, Nyquist and range clamping of modulated values.

## Acceptance Criteria
- [ ] Three LFOs exist, each with free-running rate **0.02 Hz to 30 Hz**, a tempo-sync toggle across 1/4, 1/8, 1/8T, 1/16, 1/16T and 1/32, a shape across sine, triangle, saw up, saw down, square and sample-and-hold, a fade-in, and an enable toggle. Verified by `playwright-cli eval` counting 3 LFOs × 6 shapes and 6 sync divisions per LFO.
- [ ] All 6 LFO shapes are individually audible. Verified by enabling one LFO routed to oscillator pitch at full depth and comparing the RMS trace across all 6 shapes.
- [ ] Sample-and-hold actually holds: its output is a stepped signal, not a smooth ramp. Verified by reading the LFO output value repeatedly and confirming consecutive reads are equal across the majority of pairs, then jumping.
- [ ] Tempo sync reads from the **single** lookahead clock from task 9 — the LFO rate changes with tempo and no LFO owns a `setInterval` of its own. Verified by code inspection: `playwright-cli eval` searching the loaded modules' source for a second scheduling timer returns nothing, and changing tempo changes the synced rate.
- [ ] Enabling an LFO on a held chord does not click: fade-in is present and audible as no transient. Verified by enabling an LFO mid-held-note and confirming no error and no discontinuity in the pitch readout beyond the ramp.
- [ ] The matrix is exactly **8 sources x 8 destinations = 64 cells**, each a single painted control that clicks to activate and drags vertically for a bipolar depth of -100..+100. Verified by `playwright-cli eval` counting 64 cells and asserting each exposes a signed depth.
- [ ] Sources are exactly LFO 1, LFO 2, LFO 3, amp envelope, filter envelope, velocity, key tracking, per-note random. Destinations are exactly oscillator pitch, FM amount, unison detune spread, filter 1 cutoff, filter 2 cutoff, amp level, delay time, reverb send. Verified by enumerating both lists through `playwright-cli eval`.
- [ ] No route writes a parameter directly. Each destination has exactly **one** application point, and all 64 routes sum into one vector before reaching it. Verified by code inspection: grepping for more than one write site per destination returns one site each.
- [ ] At least eight representative routes are individually demonstrable and audible: LFO 1 → oscillator pitch, LFO 2 → filter 1 cutoff, LFO 3 → filter 2 cutoff, amp envelope → amp level, filter envelope → filter 1 cutoff, velocity → filter 1 cutoff, key tracking → oscillator pitch, per-note random → unison detune spread, plus LFO 1 → delay time and LFO 2 → reverb send. Each is verified by reading the destination's live value while the route is engaged and confirming it moves.
- [ ] Negative depth genuinely inverts: a source with depth -100 produces the opposite deviation from depth +100. Verified by comparing the live cutoff under both.
- [ ] Modulating filter cutoff at full depth never produces NaN or silence. Verified by driving LFO 3 → filter 2 cutoff to full positive and full negative depth on a held note, holding for several cycles, and confirming the voice keeps sounding and the captured-error array stays empty.
- [ ] Modulation is summed **per scheduling block**, not per sample — accepted coarseness at high LFO rates, documented, not "fixed".

## Technical Requirements
- Three LFO oscillators feeding per-destination gain scalers. Shapes are built with the native nodes available: sine/triangle/square from `OscillatorNode`, saw up/down from `PeriodicWave` or a ramped value curve, sample-and-hold from a buffer source stepping at the LFO rate (explicitly **not** an `AudioWorklet`).
- Tempo-synced rate is computed from the clock's beat period; free-running rate is 0.02–30 Hz.
- Fade-in: `setValueCurveAtTime` ramp on the LFO output gain so an enabled LFO does not click.
- Per-voice modulation vector: one object per destination holding the summed bipolar contribution. Summed once per scheduling block for every active voice, then applied.
- Application points — exactly one write site each: oscillator pitch, FM amount, unison detune spread, filter 1 cutoff, filter 2 cutoff, amp level, delay time, reverb send.
- Clamping at each application point: cutoff clamped to 20 Hz–20 kHz **and** to a fraction of the actual sample rate (call the clamp helper task 6 provides); amp level clamped to a non-negative ceiling; delay time clamped to 1 ms–2 s; reverb send clamped to 0..100%.
- Velocity, key tracking and per-note random are produced by the voice layer and enter the same matrix as the LFOs.
- Delay time and reverb send are **master-stage** destinations, so their modulation is applied once globally rather than per voice. Document how the per-voice sum is reconciled with a single master node — the plan's constraint is one application point, not 64.

## Input Dependencies
- The filter chain, drive, amp and filter envelopes from **Task 6** — two of the eight destinations and two of the eight sources live there.
- The oscillator cores, FM amount and unison spread from **Tasks 3 and 4**, the wavesampler level from **Task 5**, the parameter store and painted-control factory from **Task 1**.

## Output Artifacts
- Three LFO modules with rate, sync, shape, fade-in and enable.
- The 8x8 matrix module: 64 route records with activation and signed depth, the per-voice summed modulation vector, and the eight application points.
- 64 painted matrix cells rendered as one compact panel in the modulation row, with legends naming the 8 sources (rows) and 8 destinations (columns).
- The master-stage modulation path for delay time and reverb send.

## Implementation Notes

This is where the plan's central structural constraint lives: **modulation is summed once per voice per block into a single vector, then applied at a small number of defined points**. Sixty-four independent writers would make behaviour untraceable and undebuggable, and would turn every parameter into a contended resource. If you find yourself wanting to write a route straight to an `AudioParam`, that is the mistake this component exists to prevent.

Two destinations — delay time and reverb send — are master-stage, not per-voice. The honest resolution that preserves the one-application-point rule: maintain one master-level vector for those two, summed from the LFO and envelope sources with the active voices' contributions averaged or the loudest taken. Pick one, document the choice in the module header, and keep it to a single write site. Do not fan out one write per voice.

The matrix is a **single compact panel with no routing menus**, no source-mix stage, no per-route curve editor and no assign-on workflow. Those are explicitly excluded. A cell is: click to activate, drag vertically for depth, show a signed numeric value. Building anything richer is scope creep.

Row/column order must match the legend order exactly, or the panel becomes unreadable. Sources as rows, destinations as columns, in the order the plan lists them.

Clamp early and clamp once. The plan names this risk explicitly: a cutoff pushed to zero or past Nyquist produces NaN output and can silence a voice permanently. The clamp helper already exists from task 6 — use it rather than writing a second one here.