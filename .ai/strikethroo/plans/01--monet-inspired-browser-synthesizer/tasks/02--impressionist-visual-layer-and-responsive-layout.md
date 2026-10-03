---
id: 2
group: "monet-inspired-browser-synthesizer"
dependencies: [1]
status: "completed"
created: 2026-10-02
skills:
  - css
  - canvas-rendering
complexity_score: 6
execution_profile: "standard-implementation"
---
# Impressionist Visual Layer and Responsive Layout

## Objective
Repaint the shell from Component 1 in the manner of Claude Monet: a warm parchment ground with broad brushwork washes and a fine impasto texture, a broken palette assigned per functional section so colour carries meaning, desktop-first region layout mirroring the Thor reference with vertical stacking below roughly 900 px, painterly legend typography, and a bounded reactive paint layer of dabs driven by `requestAnimationFrame`.

## Skills Required
- **css** — custom properties, gradients, layered backgrounds, responsive grid/flex regions, container queries or media queries.
- **canvas-rendering** — Canvas 2D for the impasto texture and the reactive dab ring buffer.

## Acceptance Criteria
- [ ] The page ground is a warm parchment base around `#f2ead8` with at least two broad soft gradient washes and a fine noise/impasto texture layered over it; no region reads as flat digital fill. Verified: `playwright-cli open https://soc.ddev.site/` then `playwright-cli screenshot` — the ground is visible, textured, and painted.
- [ ] No dark brushed-metal styling appears anywhere. Verified by screenshot at desktop width: no dark metallic panel, no machined-screw aesthetic, no charcoal-on-black region.
- [ ] The five palette hues (sage, atrium sky, rose madder, ochre, lavender) are assigned per functional section via CSS custom properties — oscillator hues, drum-lane hues, and a distinct step-playhead accent — so colour identifies section membership rather than decorating.
- [ ] Region order at desktop width matches Thor: global strip across the top, then voice row, tone row, modulation row, effects row, 808 kit, full-width sequencer and arpeggiator, on-screen keyboard. Verified by screenshot.
- [ ] At a phone viewport (for example 390x844) the regions stack vertically in the same order with no clipped control and no horizontal scroll. Verified concretely: resize to the narrow viewport, screenshot, then `playwright-cli eval` comparing `document.documentElement.scrollWidth` against `document.documentElement.clientWidth` — expect them equal.
- [ ] Legends are set in a serif display face and readouts in a system sans; charcoal ink is used for legends and readouts only and clears WCAG AA contrast against the parchment ground. Verified: `playwright-cli eval` computing the contrast ratio of the legend colour against the ground returns at least 4.5.
- [ ] The reactive paint layer draws at most a few hundred dabs from a fixed-capacity ring buffer, allocates nothing per frame, and is driven by `requestAnimationFrame`.
- [ ] The reactive paint layer can be switched off without any change in audio behaviour, and switching it off stops its `requestAnimationFrame` loop entirely (no orphaned loop: verified by reading a frame counter through `playwright-cli eval` before and after toggling).

## Technical Requirements
- All colour, spacing and radius values come from CSS custom properties already defined in Task 1. Do not hard-code a hex value in a component.
- Ground and washes: layered `radial-gradient` / `linear-gradient` backgrounds on the document plus a low-opacity canvas or generated-noise texture layer. Texture must be generated at runtime — no image files ship with the site.
- Impasto dab rendering: irregular circular edge, a radial highlight suggesting wet paint, a tick ring of small daubs, and a single brush-stroke pointer from the dab centre toward the current value.
- Painted fader: vertical brush stroke in a lighter wash, filled portion as a denser loaded stroke in the section hue, handle as a small rectangular impasto dab.
- Painted button/step: thick square of wet pigment with softened edges; inactive is a thin outline wash, active is loaded with the lane hue, the currently playing step visibly glistens. The glistening state is driven by a store key so task 10 can set it without touching this module.
- Reactive dab layer: fixed-capacity ring buffer (a few hundred entries) of dab records, drawn each frame, no per-frame allocation, no growth over time. It reacts to the output level and must read that level through the store rather than reaching into an audio module directly.
- Typography: legends in a serif stack (no webfont download — the site must work offline), readouts in a system sans stack.
- Breakpoint at roughly 900 px for the vertical stack; above it, the Thor row arrangement.

## Input Dependencies
- The page shell, the palette custom properties and the control factory from **Task 1**. The painted knob/fader/button styling defined here is what makes the factory's output look like paint rather than like default form controls.

## Output Artifacts
- The complete Component 1 stylesheet: ground, washes, impasto texture, region layout, per-section hues, legend and readout typography, focus rings, responsive stacking.
- The reactive dab ring-buffer module and its on/off switch, wired to the level the store exposes.
- CSS custom properties for the "currently playing step" accent, consumed by task 10.

## Implementation Notes

The reference screenshot `example images/Thor.46.2.1.png` supplies the **structure only**. Nothing about its material survives: its dark brushed panels, machined knobs and painted-nail-head screws are replaced by parchment, dabs and brush strokes. Read the image for region order and grouping, not for finish.

Colour must be **semantic**. If the same hue appears on two unrelated sections, colour stops carrying meaning and the surface turns into decorative noise. Assign one hue family per functional section and let the playhead accent be the single exception that must not be confused with a lane hue.

The dab ring buffer is the one part of the surface with a real performance failure mode: an unbounded collection that allocates and repaints without limit drops frames, and a dropped frame rate makes the whole instrument feel broken. Keep the capacity fixed, overwrite the oldest entry when full, and never grow the array.

Noise for the impasto texture must be generated at runtime (an offscreen canvas or a tiled data URL built in JS). Do not reference an image file — the site ships zero binary media and must function with the network offline.

This task paints the surface; it does not populate it. Regions stay empty apart from whatever the control factory renders. Tasks 3 through 11 fill them.