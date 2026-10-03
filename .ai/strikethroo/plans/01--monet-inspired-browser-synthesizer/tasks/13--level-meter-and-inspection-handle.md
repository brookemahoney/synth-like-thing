---
id: 13
group: "monet-inspired-browser-synthesizer"
dependencies: [8, 9, 10]
status: "pending"
created: 2026-10-02
skills:
  - web-audio-api
  - javascript
  - canvas-rendering
complexity_score: 5
owns:
  - web/ui/meter.js
  - web/audio/meter.js
  - tests/meter*
readonly:
  - web/audio/effects.js
  - web/ui/paint.js
execution_profile: "standard-implementation"
---
# Level Meter and Runtime Inspection Handle

## Objective
Make the instrument provably working: a single output level meter driven by the `AnalyserNode`, rendered as a paint stroke whose saturation and spread track the measured RMS, and a small read-only inspection object on `window` exposing live runtime state so the plan's self-validation steps can assert on real values instead of screenshots alone.

## Skills Required
- **web-audio-api** — `AnalyserNode` `getFloatTimeDomainData`, RMS computation.
- **javascript** — a read-only accessor object, captured-error capture, monotonic counters.
- **canvas-rendering** — painting the meter stroke.

## Acceptance Criteria
- [ ] The level meter is driven by the `AnalyserNode` and tracks the measured RMS. Verified concretely: with the instrument idle the meter reports a near-floor value; with a note held it reports a clearly higher value; after release it returns to the floor. Read all three through `playwright-cli eval` and through the visual meter's reported value.
- [ ] The meter's **saturation and spread** track the RMS — it is a paint stroke, not a bar chart. Verified by screenshotting the meter at idle and while a loud chord is held and confirming the visual change.
- [ ] The meter includes a short-window peak hold so a transient is visible. Verified by firing a short percussive hit and confirming the held peak decays back rather than snapping instantly.
- [ ] The inspection handle is on `window`, is **read-only**, and exposes: the `AudioContext` state and current time, the constructed effect and voice node inventory, current parameter values, the firing sequencer step and pattern, the analyser RMS plus peak hold, a monotonically increasing trigger counter per drum voice, captured runtime errors, and the `localStorage` contents.
- [ ] The handle exposes **all 11** drum trigger counters. Verified by `playwright-cli eval` enumerating them and confirming the count is 11 and each is an integer.
- [ ] A captured-error array is populated by an `error` listener and by unhandled promise rejections, and is **empty** on a clean load. Verified by `playwright-cli eval` reading it after load and after playing notes.
- [ ] The per-drum trigger counters are sufficient to verify every drum voice individually: enabling a single step on one lane, running the sequencer, and confirming that lane's counter increments while the other 10 do not.
- [ ] The handle performs **no audio function of its own**. Verified by code inspection: it contains no `connect`, no `start`, and no node creation.
- [ ] Attempting to write to a handle property does not mutate instrument state. Verified by attempting an assignment through `playwright-cli eval` and confirming the value did not change and no error was thrown.
- [ ] Reading the handle is cheap enough to call repeatedly. Verified by reading it several times in quick succession and confirming no audio glitch is audible.

## Technical Requirements
- Level meter: `getFloatTimeDomainData` into a reusable `Float32Array` (no per-frame allocation), compute RMS, smooth it, and expose both the smoothed RMS and a decaying peak hold.
- Render the meter as a paint stroke in the instrument's own visual language, consistent with task 2's palette and brushwork. The meter belongs in the global strip or just above the keyboard.
- Inspection handle: a single object on `window` with **getters only** — use `Object.freeze` on nested objects and `Object.defineProperty` getters, so a write attempt is inert rather than silently ignored or throwing.
- The handle is read-only **and** side-effect-free: no getter may advance state or allocate unbounded memory.
- Captured errors: register `window.addEventListener('error', ...)` and `unhandledrejection` into an array, capped at a small size so a failure loop cannot exhaust memory.
- `localStorage` contents in the handle must be **read on access**, not snapshotted at load, so self-validation step 12 can read a slot saved after the page loaded.
- Drum trigger counters increment on the actual audio scheduling path (from task 9), never on a UI path.
- Expose the firing sequencer step and pattern from task 10, and the node inventory from tasks 3, 6 and 8.

## Input Dependencies
- The `AnalyserNode`, its `fftSize` and the master chain from **Task 8**.
- The 11 drum trigger counters from **Task 9**.
- The firing step, pattern and chain state from **Task 10**.
- The visual language and palette from **Task 2**.

## Output Artifacts
- The level meter: RMS computation, smoothing, peak hold, and its painted rendering.
- The read-only runtime inspection handle with every field the plan's self-validation steps require.
- The captured-error array wired to `error` and `unhandledrejection`.

## Implementation Notes

The handle exists for one reason: **to assert on real runtime state rather than on screenshots**. Several of the plan's self-validation steps — especially the eleven drum voices — cannot be verified any other way. A closed hat, cowbell or rimshot is shorter than an evaluation round-trip, so sampling analyser RMS for them produces a false failure. The trigger counters are the answer to that, and they must be the reason this object is allowed to exist at all. It performs no audio function of its own.

Make it genuinely read-only with getters and `Object.freeze`. A handle that is quietly writable is a handle that will be written to by a later task, and then it is no longer a verification instrument — it is a second, hidden channel into the instrument's state, which is precisely the thing the plan's single-authority store rule exists to prevent.

`localStorage` contents must be read on access, not captured at load. Self-validation saves a preset and then reads it back through the handle; a load-time snapshot would report a stale value and fail a check that actually passes.

`fftSize` was chosen in task 8. Do not change it here — changing it changes the time-domain window and invalidates readings taken against the previous value.

The meter must not allocate per frame. A meter that allocates is the plan's named frame-rate risk, and it is the one thing running continuously during play. Reuse the analysis buffer and write into a pre-allocated array.