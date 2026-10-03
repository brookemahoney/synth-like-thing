---
id: 1
group: "monet-inspired-browser-synthesizer"
dependencies: []
status: "completed"
created: 2026-10-02
skills:
  - html-css
  - javascript
  - accessibility
complexity_score: 6
owns:
  - web/index.html
  - web/styles/
  - web/ui/
  - web/audio/ramp.js
  - tests/store*
  - tests/controls*
  - tests/surface*
  - tests/ramp*
execution_profile: "complex-architecture"
---
# Instrument Foundation and Painted Control Primitive

## Objective
Land the first files in the empty `web/` docroot so the site stops 403ing, and build the two things every later task depends on: a parameter store that is the single authority for all state, and one reusable painted-control primitive (rotary knob, vertical fader, horizontal fader, toggle, step button) that implements drag, pointer capture, value clamping, keyboard stepping, focus ring and ARIA state exactly once for the whole instrument.

## Skills Required
- **html-css** — semantic markup, CSS custom properties for the palette and layout, no build step.
- **javascript** — native ES modules, a small reactive store with subscribe/notify.
- **accessibility** — real focusable form elements, accessible names, `aria-valuenow`, arrow-key stepping, `aria-pressed` on toggles.

## Acceptance Criteria
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' https://synth-like-thing.ddev.site/` prints `200` (it prints `403` before this task).
- [ ] `web/` contains `index.html`, at least one `styles/` CSS file, and an `audio/` and `ui/` ES module directory. No package.json, no bundler config, no CDN `<script>` or `<link>` tag.
- [ ] The parameter store exposes get / set / subscribe and is the only place a parameter value lives. No component holds a private copy of a control's value.
- [ ] A single control factory creates knobs, vertical faders, horizontal faders, toggles and step buttons from one configuration object (type, range, mapping, hue, label, parameter key). Dragging, keyboard stepping, clamping and ARIA state exist in that one implementation only — grepping for a second `setPointerCapture` or a second arrow-key handler in `ui/` returns nothing.
- [ ] Continuous (rotary/fader) controls apply value changes through a short scheduled ramp rather than by writing a value at gesture time; switch-like toggles may write directly.
- [ ] Every control renders as real semantic markup (a focusable `input`/`button` with a label) whose painted appearance is presentation layered over it. Verified concretely: `playwright-cli open https://synth-like-thing.ddev.site/` then `playwright-cli eval` counting focusable form controls returns a non-zero number, and every one of them reports a non-empty accessible name.
- [ ] Arrow keys change a focused knob's value: `playwright-cli press` `ArrowUp` with a knob focused increases the store value and `ArrowDown` decreases it, confirmed by re-reading the store via `playwright-cli eval`.
- [ ] Toggles and step buttons expose `aria-pressed` and flip it on click.
- [ ] The store and the control factory are documented in one short module header each so later tasks can use them without reading their source.

## Technical Requirements
- Vanilla HTML plus native ES modules loaded with `<script type="module">`. No build step, no package manager, no framework, no third-party or CDN request.
- CSS custom properties for the parchment ground, the five palette hues (sage, atrium sky, rose madder, ochre, lavender) and the charcoal ink, defined once on `:root` so tasks 2 and every later control instance read them rather than hard-coding colours.
- Store shape: `get(key)`, `set(key, value)`, `subscribe(key, fn)` / `subscribeAll(fn)`, plus a flat key namespace with dotted paths (for example `osc1.waveform`, `filter1.cutoff`, `matrix.lfo1.pitch`).
- Control factory: pointer capture on the painted element, vertical drag for rotaries and vertical faders, horizontal drag for horizontal faders, shift for fine adjustment, double-click to return to the configured default, `Home`/`End` for range extremes.
- Mapping: logarithmic mapping for frequency-like and time-like ranges, linear otherwise. The mapping is configuration, not a per-control special case.
- Accessibility: `role="slider"` with `aria-valuemin`/`aria-valuemax`/`aria-valuenow`/`aria-valuetext` for continuous controls; `aria-pressed` for toggles and steps; visible focus ring drawn in the instrument's ink.

## Input Dependencies
None. This is the root task. `example images/Thor.46.2.1.png` is the structural reference for region order but nothing else exists yet.

## Output Artifacts
- `web/index.html` — the page shell with every functional region present as an empty, laid-out section in Thor order (global strip; voice row; tone row; modulation row; effects row; 808 kit; sequencer and arpeggiator; keyboard).
- `web/styles/` — base stylesheet defining the palette and layout custom properties.
- `web/ui/` — the parameter store module and the painted-control factory module.
- A documented default parameter set covering every key later tasks will read, with an init patch as its default values.

## Implementation Notes

The single most important property of the store is that **nothing keeps a second copy of a value**. Later tasks read the store when they need a parameter, and write to it when a control moves. If a module caches a value it read, that is a bug.

The shell must contain **all eight regions as empty sections in the agreed vertical order** even though this task paints nothing into them. Tasks 2 through 11 fill those regions. Leaving the regions out now means every later task has to re-derive the page structure and they will not agree.

The 403 clears as soon as any index document exists in the docroot, so creating `web/index.html` is the whole of the server-side fix. There is no `.ddev` change and no PHP involvement.

The default parameter set is what makes the rest of the instrument audible on first load. Populate it with musically sensible values: three oscillators on saw/square/sine with reasonable levels, filters at a musical cutoff with moderate resonance, amp envelope with a fast attack and a long release, LFOs off, matrix depths all zero, delay and reverb at zero mix. Task 12 layers presets on top of this; do not add preset storage here.

Do not implement drag with `mousemove` on `window`. Use `setPointerCapture` on the control element and read `movementY`/`movementX`, so a drag that leaves the element keeps tracking and never sticks.