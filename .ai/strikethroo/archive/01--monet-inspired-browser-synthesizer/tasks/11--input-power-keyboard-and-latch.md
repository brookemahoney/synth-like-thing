---
id: 11
group: "monet-inspired-browser-synthesizer"
dependencies: [3]
status: "completed"
created: 2026-10-02
skills:
  - web-audio-api
  - accessibility
  - event-handling
complexity_score: 6
owns:
  - web/ui/keyboard.js
  - web/ui/power.js
  - web/index.html
  - tests/keyboard*
  - tests/power*
  - tests/surface.test.mjs
execution_profile: "standard-implementation"
---
# Input: Power-On Gate, On-Screen Keyboard, Computer Keys and Latch

## Objective
Make the instrument playable and operable without a mouse: a single explicit power-on control that gates the whole instrument, an on-screen piano keyboard spanning at least three octaves with velocity derived from where on the key the click lands, computer-keyboard mapping in the standard tracker layout, a latch/hold mode, and full keyboard and screen-reader operation of every painted control.

## Skills Required
- **web-audio-api** — resuming a suspended `AudioContext` from a user gesture.
- **accessibility** — accessible names, `aria-pressed`, focus order, focus management, live-region announcements.
- **event-handling** — pointer events on keys, `keydown`/`keyup` with repeat suppression, focus vs. typing disambiguation.

## Acceptance Criteria
- [ ] Before any user gesture the instrument is **visibly powered off** and makes no sound. Verified by screenshot at load showing the powered-off prompt state, and by confirming no audible output.
- [ ] One power-on gesture resumes the `AudioContext` and its reported state becomes `running`, with `currentTime` advancing between two successive reads. Verified: `playwright-cli snapshot` to find the power-on control, `playwright-cli click` it, then `playwright-cli eval` reading the context state and time twice.
- [ ] The power-on control is the only thing that constructs and resumes audio. Verified by code inspection: grepping for `resume()` and context construction finds it only behind the power handler.
- [ ] The on-screen keyboard spans **at least three octaves**, with a visible label on each key. Verified by counting keys and confirming the span is >= 37 semitones.
- [ ] Velocity is derived from where on the key the click lands: a click near the top of a key produces a higher velocity than a click near the bottom. Verified by clicking the same key at two heights and confirming the fired velocity differs.
- [ ] Computer-keyboard mapping follows the standard tracker layout, and a key press produces sound. Verified by `playwright-cli press` of a mapped key and confirming the analyser RMS rises, then releasing and confirming it returns to the floor.
- [ ] Latch/hold mode sustains notes so a chord stays held while the hands are freed. Verified by enabling latch, striking two notes, releasing the keys, and confirming the RMS stays elevated until latch is disengaged.
- [ ] A dedicated latch button replaces the space bar, so page scrolling is not stolen. Verified by `playwright-cli press` `Space` and confirming the page does **not** scroll.
- [ ] Every painted control is a real focusable form element with an accessible name, an accessible value, arrow-key stepping, and explicit pressed state on toggles and steps. Verified concretely: `playwright-cli eval` walking every focusable form control and reporting any with an empty accessible name or missing `aria-valuenow`/`aria-pressed` returns an empty list.
- [ ] Arrow keys operate a focused knob and change its value. Verified by `playwright-cli press` `ArrowUp`/`ArrowDown` with a knob focused and re-reading its value.
- [ ] Tab order follows the visual region order (global strip, voice, tone, modulation, effects, kit, sequencer, keyboard). Verified by tabbing and recording the sequence of control labels.
- [ ] Releasing the computer-keyboard keys stops the notes; a stuck note is impossible from a key release. Verified by pressing several keys, releasing them all, and confirming the RMS returns to floor.
- [ ] A key held while focus moves to another control still sounds until released. Verified by pressing a mapped key, then tabbing away, and confirming the note continues.

## Technical Requirements
- The `AudioContext` is created suspended by task 3. This task's power-on control calls `resume()` and flips a store key that the visual layer renders as the powered-off/powered-on state.
- On-screen keyboard: pointer events per key, with the y-position within the key mapped to velocity. Use `setPointerCapture` so a drag off the key does not strand a note. Support glissando by retargeting the note to the key under the pointer while dragging.
- Computer-keyboard mapping in the standard tracker layout (the familiar `A W S E D F T G Y H U J K` lower octave and `Q 2 W 3 E R 5 T 6 Y 7 U` upper arrangement). Include octave shift (for example `Z`/`X`) documented in the README task.
- `keydown` repeat must be suppressed — the OS auto-repeat would retrigger the same note continuously.
- Latch: notes struck while latch is engaged are retained on note-off and released when latch is disengaged.
- Space must not be bound to latch; scrolling must remain available. The dedicated latch button is a real focusable control.
- Focus management: no key or control may trap focus. A focused control must not consume keys that belong to another focused control.
- Use a polite `aria-live` region to announce transport and latch state changes.

## Input Dependencies
- The `AudioContext`, the note-event path and the voice allocator from **Task 3** (notes fired here go into the same path the sequencer and arpeggiator use).
- The painted-control factory from **Task 1** and the keyboard region plus per-section hues from **Task 2**.

## Output Artifacts
- The power-on gate and its powered-off/on visual states.
- The on-screen piano keyboard with click-position velocity and glissando.
- The computer-keyboard tracker mapping and octave shift.
- Latch/hold mode with a dedicated focusable latch control.
- Full keyboard and screen-reader operability of every painted control, plus a polite live region for transport state.

## Implementation Notes

The browser autoplay policy is the reason this task exists as a gate rather than a convenience. A context created before a user gesture stays suspended, and no amount of parameter setting fixes it. Presenting the instrument powered-off behind one explicit control makes the requirement obvious rather than mysterious — that is the plan's stated mitigation, so do not "helpfully" auto-resume on any gesture.

Velocity from click position is a nicety that must not break the note model. If a drag leaves a key, the note must not stick; pointer capture plus a `pointerup`/`pointercancel` handler that always releases is the whole requirement.

The arpeggiator in task 10 reads held notes from this task's keyboard. Both must agree on what a "held note" is — one shared note registry keyed by note identifier, not two lists that can drift.

Screen-reader and keyboard operation of a knob-heavy interface is a classic failure mode. The mitigation is that the painted appearance is **presentation over semantic markup**, never a replacement for it. The knob is a real focusable element with a role, a name and a value; CSS paints the dab. If a control is a `<div>`, that is a bug regardless of how it looks.

Do not bind `Space` globally. It is a common instinct for a latch control and it silently breaks page scrolling for every keyboard user.