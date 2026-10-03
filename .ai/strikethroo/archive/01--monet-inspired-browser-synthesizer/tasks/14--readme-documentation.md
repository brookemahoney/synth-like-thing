---
id: 14
group: "monet-inspired-browser-synthesizer"
dependencies: [12, 13]
status: "completed"
created: 2026-10-02
skills:
  - technical-writing
  - markdown
complexity_score: 3
owns:
  - README.md
  - tests/readme*
execution_profile: "docs-and-config"
---
# README: Site Purpose, Startup, Control Map and Persistence

## Objective
Fill the currently zero-byte `README.md` so anyone can start the site and understand it: what it is, how to run it, the control map by section, why it needs one click to power on, which sounds are generated in the browser versus user-supplied, and how presets persist.

## Skills Required
- **technical-writing** — clear, task-ordered prose for a reader who has never seen the project.
- **markdown** — README structure, tables, code fences.

## Acceptance Criteria
- [ ] `README.md` is no longer zero bytes and states what the site is in one paragraph: a Monet-impressionist-themed polyphonic browser synthesizer, and that the site lives at `https://soc.ddev.site/`.
- [ ] Startup is documented: `ddev start`, then open `https://soc.ddev.site/`, with the docroot noted as `web/`.
- [ ] A control map by section is present as a table or list, covering all eight regions: global strip, the three oscillator cores, the wavesampler, voice mixer, the two filters, the amp and filter envelopes, the three LFOs, the 8x8 modulation matrix, the effects chain, the 808 kit, the sequencer and patterns, the arpeggiator, and the keyboard.
- [ ] The power-on requirement is stated explicitly with its reason: browsers block audio until a user gesture, so the instrument is presented powered off and the first click resumes the `AudioContext`.
- [ ] It states that the 808 kit and the four factory wavetables are **generated in the browser**, and that wavetable `.wav` files are **user-supplied** — no audio files ship with the site.
- [ ] Preset persistence is documented: twelve slots in `localStorage` under a versioned key, plus JSON export/import.
- [ ] The computer-keyboard tracker mapping is documented, including the octave-shift keys and a note that `Space` is deliberately **not** bound to latch.
- [ ] Verification is documented: how to check the site with the `playwright-cli` skill and what the runtime inspection handle on `window` exposes.
- [ ] Every command in the README is one that actually works in this repository. Verified by running the startup command's non-destructive part and confirming the URL responds.
- [ ] `AGENTS.md` is **not** modified. Verified by `git status` showing no change to that file.

## Technical Requirements
- Plain Markdown, no HTML and no build tooling.
- The URL is `https://soc.ddev.site/`; the DDEV project is `soc`; the docroot is `web/`.
- Read the finished control surfaces and the store's default parameter set before writing, so the control map matches what actually exists rather than what was planned. Names, ranges and mode labels must match the implementation exactly.
- No marketing language. The README answers: what is this, how do I run it, what does each control do, why is it silent until I click, and where is my patch saved.

## Input Dependencies
- The finished instrument from **Tasks 1 through 13**, specifically the control inventory and parameter names from the store, the preset behaviour from **Task 12**, and the inspection handle from **Task 13**.

## Output Artifacts
- A complete `README.md` replacing the zero-byte file.

## Implementation Notes

`README.md` exists but is zero bytes, so the site is currently self-explanatory only to its author. This task fixes that with a README, not with code comments scattered across modules.

Write the control map by **reading the store's parameter list**, not by copying the plan. A README that documents a control that does not exist, or that gives a range the implementation does not enforce, is worse than no README — it costs the reader more time than it saves.

`AGENTS.md` is the auto-generated kenkeep index, not a project-conventions document, and its "no branches" state is accurate for a repository with no curated knowledge. Do not touch it. Nothing in this project establishes a convention that belongs there.

Keep the README short. It is a map, not a manual. The instrument is self-describing: every control has a painted legend. What a reader cannot get from the page itself is the four things above — what it is, how to start it, why it needs a click, and where the patch is saved.