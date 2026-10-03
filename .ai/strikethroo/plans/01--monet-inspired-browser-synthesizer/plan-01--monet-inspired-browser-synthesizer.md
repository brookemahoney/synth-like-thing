---
id: 1
summary: "A Monet-impressionist-themed polyphonic browser synthesizer with 3 oscillator cores, 10 waveforms, cascaded resonant filters, an 8x8 modulation matrix, synthesized 808 drums, a 16-step sequencer, arpeggiator, EQ, delay and reverb."
created: 2026-10-02
---

# Plan: Impressionist Control Surface — A Monet-Themed Polyphonic Browser Synthesizer

## Original Work Order

> This is a codebase for a website. The website is new and hasn't been created yet. The website docroot is ./web . The site can be viewed at https://soc.ddev.site/ but right now it shows a 403 because there are no files in the web folder. There is a playwright-cli skill that can be used to verify changes to the site. You should hardly think at all and just build stuff really fast. I don't care if it's a little bit buggy. Make the site look like something Claude Monet inspired. I imagine a site that behaves like a music synthesizer with at least three oscillators, a step sequencer with a full set of Roland 808 type drum sounds, some way to arpeggiate, 10 different waveforms, reverb, delay, and some filters with resonance and adjustments for frequency. There should be an eq section as well. take inspiration from [Thor.46.2.1.png](example%20images/Thor.46.2.1.png) .

## Plan Clarifications

| # | Question | Answer | Consequence for the plan | Source |
|---|----------|--------|---------------------------|--------|
| 1 | Where do the 808 drum sounds come from, given the empty docroot and no audio assets in the repo? | Synthesize all 11 voices in Web Audio. | The plan ships **zero binary media**. Every drum voice, every wavetable, and the reverb impulse response is generated at runtime. The site is fully self-contained and works offline. | user |
| 2 | Monet is a light, pastel impressionist palette; the Thor reference is dark brushed metal with machined knobs. Which wins? | Monet wins. Painted dabs on a parchment canvas; charcoal reserved for legends only. | The information architecture is copied from Thor, but the entire visual treatment is impressionist: impasto dabs for knobs, brush strokes for faders, thick paint squares for sequencer steps, painted nail-heads where Thor has panel screws. No dark brushed-metal panel anywhere. | user |
| 3 | Initial scope excluded LFO, FM/ring-mod/unison, wavesampler, audio-file loading, preset save/load, multi-pattern chaining and a modulation matrix. | All of them are wanted. | Scope expands to the full list. The modulation matrix and preset system became first-class components rather than deferred follow-ups. | user |
| 4 | How deep should the modulation matrix be? | 8 sources x 8 destinations, one compact panel, no routing menus. | 64 bipolar routes (depth -100..+100) resolved as a single per-voice modulation sum applied at defined points, not as scattered parameter writes. | user |
| 5 | How should presets and loaded wavetables persist? | localStorage, plus JSON export/import. | No server, no upload, no URL-hash sharing. Presets and user-loaded single-cycle wavetables round-trip through a versioned JSON document. | user |
| 6 | Is backwards compatibility required? | Not applicable, and this is stated explicitly rather than assumed. | The `web/` docroot is empty; the 403 response is the only current behaviour. There is no persisted state, no API, no URL surface, and no consumer to break. Nothing needs to be migrated or kept working. | user |
| 7 | Quality bar? | "I don't care if it's a little bit buggy"; build fast. | Known trade-offs are accepted and listed in *Notes* rather than engineered away. Band-limiting shortcuts, mild aliasing at high pitches, and approximate 808 voicing fidelity are in scope. Adding an AudioWorklet purely to fix aliasing is **not** in scope. | user |
| 8 | Is the scope expansion from #3 binding, or should some of it be trimmed? | Binding. All 7 components stay at full breadth. | Nothing from #3 is trimmed. The work order's "build really fast" directive is honoured through the plain-vanilla technical approach (no build step, native nodes only, no `AudioWorklet`), not by reducing feature count. | auto-resolved — restates the user's expansion from their own prior turn; no new decision was taken. |
| 9 | Are the facts the work order states still true? | Yes, both verified against the working tree and a live request. | `example images/Thor.46.2.1.png` is present at `./example images/Thor.46.2.1.png`, so it is the structural blueprint for Component 1 while the impressionist treatment overrides its material. `web/` is empty and returns 403, which resolves as soon as any index file lands there. | auto-resolved — a fact check against the filesystem and a live `curl`, never put to the user. |
| 10 | Can the *Notes* exclusion list be tightened into a precise contract? | Yes, and the redundant "included by design" list is removed. | The exclusions become an explicit nine-item list. The previous Notes did **not** contradict Components 2, 4 or 7 — each of those cases already carried its own parenthetical — so this is a precision edit, not a conflict resolution. | auto-resolved — a drafting improvement found during review; not a user decision. |

## Executive Summary

This plan builds the first content of an empty DDEV site — a single-page polyphonic synthesizer at `https://soc.ddev.site/`, served as static files from the `web/` docroot. The instrument's information architecture is lifted directly from the supplied Roland Thor screenshot: a top global strip, a left bank of oscillator strips, a central tone-shaping column, a right-hand effects column, and a full-width step sequencer across the bottom. The entire visual treatment is repainted in the manner of Claude Monet: a warm parchment ground, visible brushwork and impasto, a broken palette of sage, sky, rose madder, ochre and lavender, and charcoal used only for the painted legends — like a signature in the corner of a canvas. Knobs are dabs of paint with a single pointer stroke; faders are vertical brush strokes; sequencer steps are thick squares of wet pigment.

The technical approach is deliberately plain. Vanilla HTML, CSS and native ES modules, with no build step, no package manager, no framework, and no CDN — every byte is first-party and served from the docroot. All sound is generated by the Web Audio API using native nodes only: `OscillatorNode` types, `PeriodicWave` for derived waveforms and the wavetable oscillator, a looping white-noise buffer for noise waveforms and percussion, `BiquadFilterNode` for both filters and the EQ bands, `WaveShaperNode` for filter drive and the limiter, `DelayNode` for the delay, and `ConvolverNode` fed a procedurally generated impulse response for the reverb. There is no `AudioWorklet` anywhere, which removes an entire class of module-loading and cross-origin-origin failure modes and is the main reason this is buildable quickly and reliably.

The instrument ships 3 oscillator cores per voice with 10 selectable waveforms, per-oscillator FM, pairwise ring modulation and unison detune spreading, plus a wavesampler whose four factory wavetables are generated from Fourier series and can be replaced by the user from a single-cycle `.wav` file. Two cascaded resonant filters per voice, a voice mixer, an amp ADSR, three LFOs and an 8x8 modulation matrix feed a master chain of 3-band EQ, delay and reverb. A synthesized 11-voice Roland 808 kit, a 16-step sequencer with four patterns and a chain mode, and a five-mode arpeggiator all run off a single lookahead scheduler. Twelve preset slots persist to `localStorage` and round-trip through JSON export/import. Several of these — the modulation matrix, FM/ring modulation/unison, the wavesampler, preset save/load and pattern chaining — go beyond the work order as written; they are in scope because the user asked for them explicitly during clarification (rows 3–5 of the Q&A table), not because the plan expanded on its own.

## Context

### Current State vs Target State

| Current State | Target State | Why? |
|---------------|--------------|-------|
| `web/` docroot is empty; `https://soc.ddev.site/` returns **403 Forbidden** | Returns **200** with a full instrument UI | The site does not exist yet; this is its first content. |
| No application code, no assets, no styles, no audio | One page plus a module-per-concern ES module tree, all first-party | The work order asks for a synth. Something has to render. |
| No audio capability of any kind | Polyphonic Web Audio instrument, 16 voices, continuous while running | "Behaves like a music synthesizer". |
| No way to make a sound | 3 oscillator cores, 10 waveforms, FM, ring mod, unison, wavesampler | Explicitly requested (3+ oscillators, 10 waveforms), then expanded to the modulation sources. |
| No filtering | 2 cascaded filters per voice with cutoff, resonance, drive, key tracking | "some filters with resonance and adjustments for frequency". |
| No rhythmic instrument | 16-step sequencer driving a synthesized 11-voice 808 kit, 4 patterns + chain + swing | "a step sequencer with a full set of Roland 808 type drum sounds". |
| No note-ordering device | 5-mode arpeggiator with tempo-synced rate, octave range and gate | "some way to arpeggiate". |
| No spatial or tonal finishing | 3-band EQ, delay, generated-impulse reverb, limiter | "reverb, delay" and "There should be an eq section as well". |
| No dynamic control | 3 LFOs + amp env + filter env + velocity + keytrack + random routed through an 8x8 modulation matrix | Requested during clarification. |
| No way to keep a patch | 12 localStorage preset slots + JSON export/import | Requested during clarification. |
| No visual identity | Monet impressionist control surface modelled on the Thor layout | "Make the site look like something Claude Monet inspired... take inspiration from Thor". |
| No way to confirm it works | A read-only runtime inspection handle plus a `playwright-cli` verification path | The work order names `playwright-cli` as the verification mechanism. |

### Background

The repository is a bare DDEV project named `soc`, PHP 8.4, `nginx-fpm`, `docroot: web`, with MariaDB 11.8 available but not needed by this work. Node 24 is available in the image. `README.md` exists but is zero bytes. `AGENTS.md` is the auto-generated kenkeep index and contains no branches yet. The kenkeep knowledge base is empty (node count 0), so there are no project conventions to inherit.

The site currently 403s purely because nginx has nothing to serve from the docroot. Adding any index document resolves that immediately; the 403 is not a permissions or configuration problem and no `.ddev` change is required.

The visual reference is a screenshot of the Roland Thor polysynth interface. Its structure — three oscillator strips on the left, a central ladder-filter/mixer/shaper column, delay and reverb on the right, a two-band EQ, three LFOs, and a full-width 16-step sequencer along the bottom — is the blueprint for the page layout. Its *material* is discarded entirely in favour of the impressionist treatment agreed in clarification #2.

The work order explicitly authorises a rough edge: "I don't care if it's a little bit buggy" and "just build stuff really fast". The plan is therefore shaped so that every feature is reachable and audible before any of it is polished, and the accepted trade-offs are enumerated in *Notes* rather than quietly engineered around.

## Architectural Approach

The instrument is a single page driven by one parameter store, one painted-control primitive, and one lookahead clock. The store is the sole authority for state — the UI reflects it and audio reads from it, so nothing has a second, private copy of a value. The clock owns all musical timing; the sequencer, the arpeggiator and tempo-synced LFOs are subscribers rather than independent timers. Everything else follows from those three decisions.

```mermaid
flowchart LR
    NS["Note events<br/>on-screen keyboard · computer keys ·<br/>melodic sequencer lane · arpeggiator"] --> VA["Voice allocator<br/>16 voices · oldest-released stealing"]
    subgraph VOICE["Voice (x16)"]
        direction TB
        OSC["3 oscillator cores<br/>10 waveforms · FM · ring mod · unison"] --> VMIX["Voice mixer"]
        WAV["Wavesampler<br/>4 factory tables + user .wav"] --> VMIX
        VMIX --> F1["Filter 1<br/>LP24 / LP12 / HP / BP / notch<br/>cutoff · resonance · drive"]
        F1 --> F2["Filter 2<br/>same model, bypassable"]
        F2 --> VCA["VCA + amp ADSR"]
    end
    VA --> OSC
    MOD["Modulation matrix<br/>8 sources x 8 destinations<br/>summed once per block"] -.-> OSC
    MOD -.-> WAV
    MOD -.-> F1
    MOD -.-> F2
    MOD -.-> VCA
    VCA --> BUS["Master bus"]
    DRUM["808 drum engine<br/>11 synthesized voices"] --> BUS
    BUS --> FX["Master chain<br/>3-band EQ -> delay -> reverb -> limiter"]
    FX --> ANA["Analyser -> level meter"]
    ANA --> DEST["Audio destination"]
    CLK["Lookahead clock<br/>25 ms tick · 100 ms horizon<br/>THE single source of musical time"] --> SEQ["16-step sequencer<br/>16 steps · 4 patterns · chain · swing"]
    CLK --> ARP["Arpeggiator"]
    CLK --> LFOS["LFOs when tempo-synced"]
    SEQ --> DRUM
    SEQ --> ARP
    ARP --> NS
    STORE["Parameter store<br/>the only authority for state"] --- UI["Painted control surface"]
    STORE --- VA
    STORE --- MOD
    STORE --- FX
    PRESETS["12 preset slots<br/>localStorage + JSON import/export"] -.-> STORE
    DBG["Read-only inspection handle<br/>for verification only"] -.-> STORE
```

### Component 1 — The Painted Control Surface

**Objective**: Establish the whole-page visual system — ground, palette, brushwork, and the one reusable painted-control primitive that every knob, fader and step button in the other six components is built from.

The page is a single canvas of painted sections rather than a set of framed panels. The ground is warm parchment (a cream/chalk base around `#f2ead8`), overlaid with a low-contrast brushwork layer: broad soft gradient washes that read as skies and water, plus a fine impasto/noise texture so the surface never reads as flat digital fill. The broken palette is sage green, atrium sky blue, rose madder, ochre gold, and lavender, assigned per functional section so that colour carries meaning (oscillator hues, drum-lane hues, step-playhead accent) rather than being decorative noise.

Three primitives cover every interactive element in the instrument:

- **Painted knob** — a circular impasto dab with a slightly irregular edge, a radial highlight that suggests wet paint, a tick ring of small daubs, and a pointer drawn as a single brush stroke from the dab's centre toward the current value. Values are readable from pointer angle and the dab's radius; there is no digit-first readout dependency.
- **Painted fader** — a vertical brush stroke in a lighter wash, with the filled portion rendered in the section's hue as a denser loaded stroke, and the handle as a small rectangular impasto dab.
- **Painted button / step** — a thick square of wet pigment with softened edges; inactive steps are a thin outline wash, active steps are loaded with the lane's hue, and the currently playing step is the one dab in the sequencer that visibly glistens.

The reusable primitive is parameterised by type (rotary / vertical / horizontal / toggle), value range and mapping, hue, and label. Every control in Components 2 through 7 is an instance of it — there is exactly one implementation of drag, keyboard, pointer-capture, and value-clamping behaviour in the instrument, which is what keeps a surface with several hundred controls maintainable.

Layout is desktop-first and mirrors the Thor reference: a global strip across the top, three region rows for voice / tone / modulation / effects, the 808 kit, then the full-width sequencer and arpeggiator, then the on-screen keyboard. Below roughly 900 px the regions stack vertically in the same order. Legends are set in a serif display face to carry the painterly-signature quality; numeric readouts use a system sans. Charcoal ink is reserved for legends and readouts and is chosen to clear WCAG AA contrast against the parchment ground.

The regional layout below is a structural sketch, not a wireframe — the boxes are functional regions in the Thor arrangement, and the links simply force them into a row.

```mermaid
flowchart TB
    G["GLOBAL STRIP — power · master volume · latch · arpeggiator · tempo · run/stop"]
    subgraph R1["VOICE"]
        direction LR
        O1["Osc 1"] --- O2["Osc 2"] --- O3["Osc 3"] --- W["Wavesampler"]
    end
    subgraph R2["TONE"]
        direction LR
        MX["Voice mixer"] --- FLT["Filter 1 + Filter 2"] --- ENV["Amp + Filter envelopes"]
    end
    subgraph R3["MODULATION"]
        direction LR
        L1["LFO 1"] --- L2["LFO 2"] --- L3["LFO 3"] --- MM["Modulation matrix 8 x 8"]
    end
    subgraph R4["EFFECTS"]
        direction LR
        EQ["3-band EQ"] --- DL["Delay"] --- RV["Reverb"]
    end
    subgraph R5["808 KIT — tune · decay · level · pan per voice"]
        direction LR
        K1["BD · SD · LT · MT · HT"] --- K2["RS · CP · CB"] --- K3["CH · OH · CY"]
    end
    SEQ["16-STEP SEQUENCER — 11 drum lanes + melodic lane · 4 patterns · chain · swing"]
    KEY["ON-SCREEN KEYBOARD"]
    G --> R1 --> R2 --> R3 --> R4 --> R5 --> SEQ --> KEY
```

### Component 2 — Voice Engine: Oscillator Cores, Wavesampler, FM, Ring Mod, Unison

**Objective**: Generate the raw sound of every note — the oscillator bank, its 10 waveforms, and the three cross-oscillator mechanisms — and manage a bounded pool of concurrent voices.

The voice is a self-contained unit: three oscillator cores feeding a voice mixer, and a voice allocator handing out up to **16** concurrent voices, stealing the oldest released voice first and then the oldest sounding voice if all are busy. Each note event carries pitch, velocity, a note identifier, and a fresh random value for per-note modulation.

Each oscillator core has: waveform selection across **10 waveforms**; octave range of -2 to +2; semitone offset of -12 to +12; fine tune in cents; level; FM amount and FM source selection; unison voice count of 1 to 7 with a detune-spread control; and ring-modulator assignment. The 10 waveforms are:

1. Sine
2. Triangle
3. Sawtooth
4. Square (50% duty)
5. Pulse 25% duty
6. Pulse 12.5% duty
7. Reverse saw (rising ramp)
8. Saw (falling ramp)
9. White noise
10. Additive "reed" — a `PeriodicWave` summing harmonics 1, 2, 3, 4, 6 and 8 at decreasing amplitude

Pulse widths other than the three listed are deliberately excluded; they are not in the requested set of 10 and each additional width is another control the user did not ask for. Unison and FM are per-oscillator; ring modulation is a pairwise assignment between cores, so core 1 can ring-modulate core 2 while core 2 also feeds the mixer.

The **wavesampler** is a fourth, independently level-controlled voice using `PeriodicWave`. It ships four factory wavetables generated from Fourier series at load time ("Warm Saw", "Soft Square", "Reed", "Glass") plus a scan-position control so the wave can be read at a chosen point in its cycle. A single file-load control accepts any mono `.wav` (via the File API and `decodeAudioData`), resamples it to a fixed 2048-point single-cycle table, and caps its harmonic content at Nyquist for the current playback frequency. No `.wav` file ships with the site; the loader is entirely user-supplied content.

All oscillator pitch changes — from the keyboard, from octave and semitone offsets, from FM, and from modulation-matrix routes — resolve to a single per-voice frequency computation and are applied through scheduled parameter automation, never by writing a frequency value directly during a gesture.

### Component 3 — Filter Bank, Mixer and Envelopes

**Objective**: Turn the raw oscillator sum into a tone that can be swept, coloured and shaped in amplitude.

Two cascaded `BiquadFilterNode` stages per voice. Each stage has mode selection across **LP24** (two cascaded 12 dB sections for a steeper slope), **LP12**, **HP12**, **BP12** and **Notch12**; cutoff from **20 Hz to 20 kHz** on a logarithmic scale; resonance as a Q value from **0.5 to 30**; drive; key tracking from 0 to 100%; and a bypass toggle so a stage can be removed from the chain. Filter 1 feeds Filter 2; filter 2 feeds the amplifier.

Resonance is intentionally allowed to reach a self-oscillating region, which is the musical point of the control. A `WaveShaperNode` driven by a soft-clipping curve sits ahead of each filter and is what the drive control operates, providing the saturation that makes high resonance audible rather than merely loud.

The voice mixer sums the three oscillator cores, the wavesampler and any ring-modulator pairs into filter 1. The amplifier is a gain stage under an amp ADSR: attack and decay on logarithmic scales from 1 ms to 5 s, sustain 0 to 100%, release 1 ms to 8 s. A second ADSR, the filter envelope, shares those time ranges and acts as a modulation-matrix source whose depth is set by the user in the "filter envelope → filter 1 cutoff" and "filter envelope → filter 2 cutoff" cells (Component 4). There is therefore no dedicated filter-envelope amount knob, and no knob that duplicates a matrix cell.

### Component 4 — LFOs and the 8x8 Modulation Matrix

**Objective**: Supply continuous and per-note movement, and give those movements somewhere to go.

Three LFOs, each with a rate that is either free-running from **0.02 Hz to 30 Hz** or tempo-synced across 1/4, 1/8, 1/8T, 1/16, 1/16T and 1/32; a shape across **sine, triangle, saw up, saw down, square and sample-and-hold**; and a fade-in so that enabling an LFO on a held chord does not click. Sample-and-hold is implemented with a buffer source stepping at the LFO rate, not with an `AudioWorklet`.

The modulation matrix is **8 sources by 8 destinations**, 64 routes, each with a bipolar depth of -100 to +100:

- **Sources** — LFO 1, LFO 2, LFO 3, amp envelope, filter envelope, velocity, key tracking, per-note random.
- **Destinations** — oscillator pitch, FM amount, unison detune spread, filter 1 cutoff, filter 2 cutoff, amp level, delay time, reverb send.

Each cell is a single painted control: click to activate, drag vertically for depth. There is no routing menu, no source-mix stage, no per-route curve editor, and no assign-on workflow. Velocity, key tracking and per-note random are produced by the voice layer and enter the same matrix as the LFOs, so "velocity to filter cutoff" is just one cell.

The architectural constraint that matters here: modulation is **summed once per voice per block into a single vector, then applied at a small number of defined points**. No matrix route writes parameters directly. This is what stops 64 live routes from turning into an untraceable pile of concurrent automation events.

### Component 5 — Master Effects Chain: EQ, Delay, Reverb

**Objective**: Finish the signal with the three processing stages the work order named explicitly, in that order.

The master bus runs: **3-band EQ**, then **delay**, then **reverb**, then a safety **limiter**, then an `AnalyserNode`, then the destination.

The EQ is three `BiquadFilterNode` stages — a low shelf at 200 Hz, a peaking band at 800 Hz with Q 0.7, and a high shelf at 3 kHz — each with -18 to +18 dB of gain. One band per lane is the scope agreed in clarification #4; there is no 6-band or parametric version.

The delay offers a time from 1 ms to 2 s or a tempo-synced fraction of the current beat, feedback from 0 to 95% with a hard ceiling below unity so the loop cannot run away, a tone control (lowpass in the feedback path, 400 Hz to 20 kHz) that darkens repeats the way a real analog delay does, and a dry/wet mix. The delay sits before the reverb so that delay taps feeding into reverb get the wash, which matches the Thor signal order.

The reverb is a `ConvolverNode` whose impulse response is generated at startup: a decaying noise burst with an exponential envelope, built once and re-generated only when the decay control changes, with the decay control ranging from 0.3 s to a **12 s ceiling** and a damping lowpass plus a pre-delay in the wet path. The 12 s cap is a deliberate CPU guard — a longer generated convolution will audibly tax lower-end machines. A wet/dry mix bypasses the stage entirely.

The limiter is a compressor with a fast attack and a high ratio, present to protect the output when 16 voices, unison spreads and resonant filters all peak together. Master volume sits before it.

### Component 6 — 808 Drum Engine, 16-Step Sequencer and Arpeggiator

**Objective**: Provide the rhythmic half of the instrument and the device that turns held notes into sequenced ones, all driven by one clock.

The 808 kit is **11 synthesized voices**, each with tune (-12 to +12 semitones), decay (0.05 s to 2.0 s), level and pan. The synthesis recipes are deliberately 808-shaped rather than sample-accurate: bass drum is a sine with a fast pitch-drop envelope and a click transient; snare is a tuned body tone plus a filtered noise burst; the three toms are pitched sines with descending envelopes; rimshot is a very short high-Q noise-and-tone transient; clap is four staggered filtered noise bursts; closed and open hats are highpassed noise with very different decay envelopes, the open hat playable as both a step voice and a held pedal; crash is a long noise burst layered with detuned square clusters; cowbell is two detuned squares at a inharmonic interval through a bandpass. No audio files are involved — confirmed in clarification #1.

The **step sequencer** has **16 steps**. Each of the 11 drum lanes plus **one melodic synth lane** carries a per-step on/off and a per-step velocity used as accent, 0 to 100%. The melodic lane adds a chromatic note and a gate length of 10 to 100% per step. Global transport covers a tempo of **40 to 220 BPM**, swing from 50% to 75% applied to odd sixteenths, run and stop, and a playhead indicator that follows the firing step.

The sequencer holds **4 patterns (A–D)** and a **chain mode** over an ordered list of the four, so `A-B-A-D` loops indefinitely. Chain order is edited by clicking pattern slots in sequence. Presets save and restore the currently playing pattern set, chain order and swing.

All timing comes from a single **lookahead scheduler**: a 25 ms interval that schedules events 100 ms ahead against the `AudioContext` clock. The sequencer, the arpeggiator and the LFOs' tempo-sync all read from this one clock. There is no second timer anywhere in the instrument — this is the single most important structural decision in the component, because independent timers are what make sequencers drift and why multi-pattern chaining plus arpeggiation plus tempo sync is usually where these builds break.

The **arpeggiator** has an on/off, a mode across **Up, Down, Up-Down, Random and As-Play**, a tempo-synced rate from 1/4 down to 1/32 (including triplet variants), an octave range of 1 to 4, and a gate length of 10 to 100%. Held keyboard notes feed it; when the melodic sequencer lane is firing, the arpeggiator can be set to process the lane's notes or bypassed so the lane plays as written.

### Component 7 — Input, Presets, Instrumentation and the Runtime Inspection Handle

**Objective**: Make the instrument playable and provably working.

**Input.** An on-screen piano keyboard spanning at least three octaves, playable by mouse with velocity derived from where on the key the click lands, plus computer-keyboard mapping in the standard tracker layout. A latch/hold mode sustains notes so a chord can be held while both hands — or a single hand on a small screen — reach the controls. Every knob and fader is focusable and operable with arrow keys, and a dedicated latch button replaces the space bar so page scrolling is not stolen. A single explicit **power-on control** gates the whole instrument: browsers block audio until a user gesture, so the interface is presented powered-off and the first gesture resumes the `AudioContext`.

**Presets.** Twelve named slots in `localStorage` under a versioned schema key, each storing every parameter, all four patterns, the chain order, the swing value, the tempo, and any user-loaded wavetables. A baked init patch loads when no slot is present or when stored data fails to parse. Export produces a JSON file containing all of it; import reads one back. Confirmed in clarification #5.

**Instrumentation.** A single output level meter driven by the `AnalyserNode`, rendered as a paint stroke whose saturation and spread track the measured RMS.

**Runtime inspection handle.** A small read-only object on `window` exposing the live audio context state and time, the constructed effect and voice node inventory, current parameter values, the firing sequencer step and pattern, the current analyser RMS plus a short-window peak hold, a monotonically increasing trigger counter per drum voice, any captured runtime errors, and the contents of `localStorage`. It exists solely so that the *Self Validation* steps below can assert on real runtime state through `playwright-cli` rather than on screenshots alone, and so that percussive voices whose envelopes are shorter than an evaluation round-trip can be verified by counter increment rather than by sampling level. It performs no audio function of its own.

## Risk Considerations and Mitigation Strategies

<details>
<summary>Technical Risks</summary>

- **Autoplay policy blocks the AudioContext and the instrument appears dead**: Browsers refuse to start audio without a user gesture, and a context created before one begins in a suspended state that no amount of parameter setting fixes.
    - **Mitigation**: The interface is presented powered-off behind a single explicit power-on control. That control is the only thing that constructs and resumes the context. A visually distinct prompt state makes the requirement obvious rather than mysterious.

- **Resonance at high Q self-oscillates and spikes the output**: Q of 30 on a biquad at a hot signal level produces very loud, very narrow peaks, and 16 voices of it will clip.
    - **Mitigation**: Q is capped at 30 by design, drive uses a soft-clipping `WaveShaperNode` rather than raw gain, and a fast compressor/limiter sits immediately before the destination. Master volume defaults low enough that the limiter is not doing routine work.

- **Matrix and envelope modulation of filter cutoff can produce unstable or inaudible results**: Pushing a biquad cutoff to zero or past Nyquist produces NaN output and can silence the whole voice permanently.
    - **Mitigation**: Every cutoff-modulating route is clamped to 20 Hz–20 kHz and to a fraction of the actual sample rate before it is applied. Modulation sums into one vector precisely so there is a single place where this clamp happens.

- **Control drags produce zipper noise**: Assigning `AudioParam.value` directly during a pointer gesture steps the parameter per frame and clicks audibly.
    - **Mitigation**: All continuous parameter changes are applied through scheduled automation with a short ramp. Direct assignment is reserved for switch-like state changes that happen while the voice is silent.

- **Convolution reverb is the most expensive node in the graph**: A long generated impulse response costs real CPU, and it is running continuously once started.
    - **Mitigation**: Decay is capped at 12 s, the impulse response is generated once and only regenerated when the decay control actually changes, and the stage has a dry/wet control that removes it from the graph's cost when unused.

- **Noise-as-waveform and sample-and-hold alias audibly at high pitches**: Buffer sources are not band-limited, so a noise "oscillator" played three octaves up hisses.
    - **Mitigation**: Accepted deliberately (clarification #7). Noise routed through the oscillator bank is low-passed by the voice's own filter chain, which masks most of it. Introducing an `AudioWorklet` to band-limit properly is explicitly not in scope.

- **Frequency-modulation and ring-modulator changes can leave a voice connected to a node it should no longer be routed to**: Oscillator routing is a graph-topology problem, not a parameter problem, and a leak means a voice never stops sounding.
    - **Mitigation**: Voice teardown disconnects the voice's entire subtree from its single entry point rather than unwiring individual nodes, so a mis-routed oscillator cannot outlive its voice.
</details>

<details>
<summary>Implementation Risks</summary>

- **The surface is large and the scope grew during clarification**: Several hundred controls across twelve oscillator parameters, twelve per-voice filter and envelope parameters, 64 matrix cells, 12 sequencer lanes, and the effects chain.
    - **Mitigation**: One parameter store is the sole authority for all state; the UI reflects the store and never holds independent truth. One painted-control primitive serves every control type. No control invents its own storage convention.

- **Duplicated knob, fader and toggle logic across a large page**: Hand-rolling this repeatedly is the fastest route to inconsistent behaviour and to accessibility regressions.
    - **Mitigation**: Exactly one implementation of pointer capture, drag mapping, clamping, keyboard stepping, focus ring and ARIA state. New controls are configurations of it, not new code.

- **Timing subsystems drift against one another**: Sequencer, arpeggiator and tempo-synced LFOs each wanting their own timer produce a sequencer that falls behind the beat within a minute.
    - **Mitigation**: A single lookahead scheduler owns all musical timing; every other timing consumer is a subscriber. This is stated as a structural constraint rather than a suggestion.

- **Unwired matrix routes write parameters from many places at once**: 64 independent writers makes behaviour impossible to predict or debug.
    - **Mitigation**: Routes are summed into a single per-voice modulation vector applied at a small number of defined points. No route touches a parameter directly.

- **Presets silently fail to restore**: A schema mismatch or a malformed stored document leaves the instrument in a broken state with no obvious cause.
    - **Mitigation**: Versioned storage key, parse failure falls back to the baked init patch and logs the reason, and import validates before replacing anything.

- **Layout cannot be verified without a running page, and the docroot starts empty**: There is no server-side or build-time signal that a control is misplaced.
    - **Mitigation**: The runtime inspection handle plus `playwright-cli` gives assertions on real state, and screenshots at desktop and narrow widths catch layout failures.
</details>

<details>
<summary>Quality Risks</summary>

- **The reactive paint layer degrades frame rate**: A canvas dab layer reacting to audio level can allocate and repaint without bound, and a dropped frame rate makes the instrument feel broken.
    - **Mitigation**: The dab layer is a fixed-capacity ring buffer of a few hundred dabs, driven by `requestAnimationFrame` with no per-frame allocation, and it can be disabled without affecting any audio behaviour.

- **Charcoal legends on a cream ground fail contrast**: A painterly palette makes it easy to lose legibility on exactly the text that explains the controls.
    - **Mitigation**: Legend and readout ink is chosen against the parchment ground to clear WCAG AA, and legend text is never carried by colour alone.

- **A screen reader or keyboard user cannot operate a knob-heavy interface**: Rotary controls are the classic failure case.
    - **Mitigation**: Every painted control is a real focusable form element with a label, an accessible value, arrow-key stepping, and explicit pressed state on toggles and steps. The painted appearance is presentation over semantic markup, not a replacement for it.
</details>

## Success Criteria

### Primary Success Criteria

1. `https://soc.ddev.site/` returns **HTTP 200** (not 403), and the full control surface renders with no dark brushed-metal styling anywhere — the ground is impressionist and every control reads as painted.
2. Before any user gesture the instrument is visibly powered off; one power-on gesture resumes the `AudioContext` and its reported state becomes `running`.
3. Playing a note produces sound: with the init patch loaded and reverb and delay at zero, the measured output RMS rises above a defined noise floor during a held note and returns to floor after release.
4. All **3** oscillator cores are independently audible and controllable, each offering all **10** waveforms, octave, semitone, fine tune and level; each supports FM, unison spread, and ring modulation against another core.
5. The wavesampler sounds with its four factory wavetables and accepts a user-supplied single-cycle `.wav` that becomes selectable without a page reload.
6. Both filters are audible in series, with cutoff spanning **20 Hz to 20 kHz**, resonance audibly colouring the tone up to **Q 30**, and each independently bypassable.
7. The **8x8** modulation matrix routes all 64 cells; at least eight representative routes (an LFO to pitch, velocity to filter cutoff, per-note random to unison spread, amp envelope to delay time) are individually demonstrable.
8. All **11** 808 drum voices are individually audible from the sequencer, each with working tune, decay, level and pan, and **no audio file is fetched by the page**.
9. The sequencer runs at any tempo from **40 to 220 BPM**, the playhead tracks the firing step, swing audibly offsets odd sixteenths, and all **4** patterns plus a chain order loop correctly.
10. The arpeggiator produces each of its **5** modes at each of its tempo-synced rates, with octave range and gate length taking effect.
11. EQ, delay and reverb are each independently audible, each has a dry/wet or gain control, and reverb decay reaches its 12 s ceiling without audible CPU collapse.
12. A patch saved to a preset slot survives a full page reload with all parameters, patterns, chain order and tempo intact, and a JSON export/import round-trip restores the same patch.
13. The site ships no build step, no package manager, no framework and no third-party or CDN request; the page loads and functions with the network offline after first load.

## Self Validation

Perform these steps in order after all tasks are complete. They inspect the running system; none of them is a pre-existing test.

1. **Confirm the 403 is gone.** Run `curl -sS -o /dev/null -w '%{http_code}\n' https://soc.ddev.site/`. Expect `200`.
2. **Confirm the surface renders.** Run `playwright-cli open https://soc.ddev.site/`, then `playwright-cli screenshot`. Verify the impressionist ground, the brushwork overlay, and the painted controls are visible, and that no region reads as dark brushed metal.
3. **Confirm nothing threw during load.** Use `playwright-cli eval` to read the captured-error array on the runtime inspection handle. Expect an empty array.
4. **Confirm the required control inventory exists.** Use `playwright-cli eval` to count focusable form controls, and separately assert that at least 10 distinct waveform options, 3 oscillator sections, 2 filter sections, 12 sequencer lanes and 64 modulation cells are present. Any shortfall is a missing feature, not a rendering issue.
5. **Confirm the instrument starts audio.** Use `playwright-cli snapshot` to find the power-on control and `playwright-cli click` it. Then `playwright-cli eval` the `AudioContext` state on the inspection handle. Expect `running`, with a current time that advances between two successive evals.
6. **Confirm sound is actually produced.** Trigger a note (press a computer keyboard key or click an on-screen key), then `playwright-cli eval` the analyser's RMS. Expect a value clearly above the idle floor. Release the note, wait, and re-read; expect it to fall back to the floor.
7. **Confirm the sequencer clock is the only clock and it advances.** Read the firing step index from the inspection handle, start the sequencer, wait roughly one beat, read it again, and confirm it advanced and that the pattern indicator matches. Screenshot mid-run to confirm the playhead dab is visibly lit.
8. **Confirm all 11 drum voices fire individually.** For each drum lane, read the per-voice trigger counters on the inspection handle, enable a single step on that lane, start the sequencer, and confirm that lane's counter incremented while the other 10 did not. Do **not** verify drum voices by sampling the analyser RMS: a closed hat, cowbell or rimshot is shorter than an evaluation round-trip and would produce a false failure.
9. **Confirm the effects are real.** Set delay feedback and mix above zero and set reverb mix above zero via their controls, fire a note, and confirm both the tail and the repeats are present in the RMS envelope trace. Then confirm the reverb stage can be fully bypassed with its mix at zero.
10. **Confirm modulation routes are live.** Set an LFO-to-oscillator-pitch cell to a non-zero depth, hold a note, and read the voice's live pitch readout twice about a quarter of a second apart; the value must differ. Repeat for velocity-to-filter-cutoff by playing the same key at two different click heights on the key.
11. **Confirm each arpeggiator mode.** Hold a three-note chord with the arpeggiator enabled and read the firing-note readout repeatedly for each of the 5 modes; confirm the note ordering changes per mode and that the octave range produces the expected span.
12. **Confirm presets survive a reload.** Move one knob to a distinctive value, save to a preset slot, run `playwright-cli goto https://soc.ddev.site/` to reload, then `playwright-cli eval` the localStorage contents and the restored knob value. Expect an exact match.
13. **Confirm JSON export/import round-trips.** Export the preset, read the emitted JSON, change several parameters, import the JSON, and confirm the original values return.
14. **Confirm keyboard and accessibility operation.** Use `playwright-cli press` with arrow keys while a knob is focused and confirm its value changes; use `playwright-cli eval` to confirm every painted control has an accessible name and that toggle and step controls expose a pressed state.
15. **Confirm narrow-viewport layout.** Resize the browser to a phone viewport and screenshot; confirm the regions stack in the agreed order with no clipped controls and no horizontal scroll.
16. **Confirm offline self-containment.** Use `playwright-cli eval` to list every network request the page made. Expect only first-party requests to the site itself — no CDN, no third-party origin.
17. **Final screenshot sweep** at desktop and narrow widths for the visual record, and a final read of the captured-error array to confirm the whole session was clean.

## Documentation

`README.md` is currently zero bytes and the site is self-explanatory only to its author, so it is filled in as part of this work: what the site is, how to start it (`ddev start`, then `https://soc.ddev.site/`), the control map by section, the fact that the instrument needs one click to power on because browsers block audio before a gesture, that wavetables are user-supplied while the 808 kit and factory wavetables are generated in the browser, and how presets persist.

`AGENTS.md` does **not** need updating. It is the auto-generated kenkeep index rather than a project-conventions document, and its "no branches" state is accurate for a repository with no curated knowledge yet. Nothing in this plan establishes a convention that belongs there.

## Resource Requirements

### Development Skills

- Web Audio API in depth: `OscillatorNode` types, `PeriodicWave` and Fourier-series table construction, `AudioBufferSourceNode` looping for noise, `BiquadFilterNode` across all modes, `WaveShaperNode` curves, `DelayNode` with feedback, `ConvolverNode` with a generated impulse response, `DynamicsCompressorNode`, `AnalyserNode`, and `AudioParam` scheduled automation.
- Web Audio scheduling: lookahead pattern, audio-clock-versus-wall-clock separation, and why one scheduler must own all musical timing.
- Native ES modules and a single-page module graph with no bundler.
- CSS custom properties for palette and layout, and pointer-capture drag interaction.
- Canvas 2D with a bounded ring buffer, for the reactive paint layer.
- Web Audio autoplay policy and the user-gesture requirement.
- `localStorage` schema versioning, and JSON file import/export via the File API and `decodeAudioData`.

### Technical Infrastructure

- DDEV, already configured: PHP 8.4, `nginx-fpm`, `docroot: web`. No `.ddev` change and no database use.
- Node 24, already present in the image, used only for running verification tooling.
- `playwright-cli` via the repo's existing skill, for the *Self Validation* steps.
- **No package manager, no build step, no framework, no CDN, no third-party runtime dependency.** Everything is served from the docroot as first-party files. This is a deliberate constraint: it removes install steps, removes a build/serve mismatch class of bugs, and keeps the site functional with the network offline.

## Integration Strategy

None required. The site is self-contained within the `web/` docroot and shares nothing with any other project in the repository. The only integration point is DDEV's existing web server configuration, which already serves `https://soc.ddev.site/` from `web/` and requires no modification — the 403 resolves the moment files exist.

## Notes

### Decision Log

- 2026-10-02: Scope expansion from clarification #3 confirmed as binding — all 7 components stay at full breadth, including the modulation matrix, the wavesampler with its `.wav` loader, the preset system, pattern chaining and the 5-mode arpeggiator. Nothing is trimmed; the work order's "build really fast" directive is met by the plain-vanilla technical approach, not by removing features.
- 2026-10-02: The work order's stated facts were re-verified rather than assumed — `example images/Thor.46.2.1.png` is present, and `web/` is still empty and returning 403. The Thor layout guides Component 1's structure; the Monet impressionist treatment overrides its material.
- 2026-10-02: The *Notes* exclusion list was tightened into an explicit nine-item contract, and a redundant "included by design" list was removed because it described absences under an inclusions heading. The prior Notes were already consistent with Components 2, 4 and 7, so this was a precision edit rather than a contradiction fix.
- 2026-10-02 (refinement pass): The clarifications table gained a `Source` column. Rows 1–7 are marked `user`; rows 8–10 are marked `auto-resolved` and reworded so they no longer read as user decisions. Two unsupported attributions were removed — a quoted "most fun" directive and a reference to an option label `(A)` that was never offered — and all Decision Log dates were corrected from 2025 to 2026. Also fixed: the non-sequitur closing sentence of the Executive Summary, a vague filter-envelope sentence in Component 3, and a flaky RMS-polling step in *Self Validation* that would have reported false failures for the shortest drum voices.

- **What is excluded (deliberate boundaries)**, to keep scope honest: `AudioWorklet` (explicitly out of scope per clarification #7); audio-file loading for the 808 drum kit (only the wavesampler accepts a user `.wav`); modulation-matrix curve editor or per-route source mixing; MIDI input; audio recording or export of rendered sound; pattern length other than 16 steps; per-oscillator pulse-width sweep beyond the three fixed duty cycles (50%, 25%, 12.5%); and a dedicated filter-envelope amount knob separate from the matrix route (the filter envelope feeds the matrix as a source, per Component 4). Everything else — the full 3-oscillator voice with FM, ring mod, unison, the 4-factory + user `.wav` wavesampler, the 8×8 modulation matrix, 12 preset slots with JSON export/import, 4-pattern chain mode, 5-mode arpeggiator, 3 LFOs, full effects chain, and the 11-voice synthesized 808 kit — is in scope.
- **Accepted rough edges**, per the work order's "I don't care if it's a little bit buggy":
  - Noise-based oscillators and percussion are not band-limited and will hiss at high pitches; the voice filters mask most of it.
  - The 808 voices are 808-*shaped* rather than sample-identical. Drum-machine purists will hear the difference; nothing else in the instrument depends on it.
  - Modulation from the matrix is applied per scheduling block rather than per sample, which is very slightly coarse at high LFO rates.
  - The reactive paint layer's dab count and lifetime are approximate and tuned for smoothness, not for visual accuracy.
- **Audio correctness beats visual polish.** Every feature in this plan is expected to be audible and adjustable before any of it is beautiful. If effort runs short, the correct response is to ship all the sound and leave some of the paint rough — not to drop a feature.
- **The single-clock rule is the highest-risk-to-violate constraint in the plan.** Sequencer, arpeggiator and tempo-synced LFOs must all subscribe to one lookahead scheduler. Independent timers are the usual cause of a sequencer that drifts or an arpeggiator that fights the beat.
- The **12 s reverb ceiling** and the **Q 30 ceiling** are hard limits, not defaults. They are the two places where the design protects the user's ears and their CPU at the cost of some headroom, and both were chosen on purpose.
## Execution Blueprint

**Validation Gates:**
- Reference: `/config/hooks/POST_PHASE.md`

### Dependency Diagram

```mermaid
graph TD
    001[Task 001: Instrument foundation and painted control primitive]
    002[Task 002: Impressionist visual layer and responsive layout]
    003[Task 003: Voice engine core - allocator, oscillator cores, mixer]
    004[Task 004: FM, ring modulation and unison spread]
    005[Task 005: Wavesampler - factory tables and user .wav loading]
    006[Task 006: Filter bank, drive and amp/filter envelopes]
    007[Task 007: LFOs and the 8x8 modulation matrix]
    008[Task 008: Master effects chain - EQ, delay, reverb, limiter]
    009[Task 009: Lookahead clock and 808 drum engine]
    010[Task 010: 16-step sequencer, pattern chain and arpeggiator]
    011[Task 011: Input - power-on gate, keyboard, computer keys, latch]
    012[Task 012: Preset system - 12 slots and JSON round-trip]
    013[Task 013: Level meter and runtime inspection handle]
    014[Task 014: README documentation]

    001 --> 002
    001 --> 003
    003 --> 004
    003 --> 005
    003 --> 006
    003 --> 008
    003 --> 009
    003 --> 011
    006 --> 007
    009 --> 010
    008 --> 013
    009 --> 013
    010 --> 013
    010 --> 012
    012 --> 014
    013 --> 014
```

The graph is acyclic. Task 003 is the audio trunk: it creates the `AudioContext`, the shared noise buffer, the master bus, the voice mixer summing inputs and the note-event path that tasks 004, 005, 006, 008, 009, 010 and 011 all connect into. Task 003 additionally creates the ring-modulator bus and wavesampler placeholder summing gains so tasks 004, 005 and 006 can fill them without rewiring the mixer.

### Execution Phases

### ✅ Phase 1: Foundation
**Parallel Tasks:**
- ✔️ Task 001: Instrument foundation and painted control primitive

**Phase notes:** This phase clears the 403 by landing the first files in `web/`, and creates the parameter store and the single painted-control primitive that every later task consumes. Nothing can run before it.

### ✅ Phase 2: Visual System and Voice Core
**Parallel Tasks:**
- ✔️ Task 002: Impressionist visual layer and responsive layout (depends on: 001)
- ✔️ Task 003: Voice engine core - allocator, oscillator cores, mixer (depends on: 001)

**Phase notes:** Task 002 is presentation-only and Task 003 is the audio trunk. They touch disjoint files and can run together. After this phase the site is audible and painted, though not yet filtered or sequenced.

### ✅ Phase 3: Oscillator Mechanisms, Wavesampler and Master Chain
**Parallel Tasks:**
- ✔️ Task 004: FM, ring modulation and unison spread (depends on: 003)
- ✔️ Task 005: Wavesampler - factory tables and user .wav loading (depends on: 003)
- ✔️ Task 008: Master effects chain - EQ, delay, reverb, limiter (depends on: 003)

**Phase notes:** Three independent audio branches off the voice engine. Task 004 and Task 005 fill the summing inputs Task 003 reserved for them; Task 008 takes the master bus and the delay-time/reverb-send destinations.

### ✅ Phase 4: Tone Shaping and Rhythm Engine
**Parallel Tasks:**
- ✔️ Task 006: Filter bank, drive and amp/filter envelopes (depends on: 003)
- ✔️ Task 009: Lookahead clock and 808 drum engine (depends on: 003)

**Phase notes:** Task 009 establishes the single source of musical time, which Tasks 007, 008's tempo sync and 010 all subscribe to. Task 006 completes the per-voice chain and provides the cutoff clamp helper that Task 007 depends on.

### ✅ Phase 5: Modulation, Sequencing and Input
**Parallel Tasks:**
- ✔️ Task 007: LFOs and the 8x8 modulation matrix (depends on: 006)
- ✔️ Task 010: 16-step sequencer, pattern chain and arpeggiator (depends on: 009)
- ✔️ Task 011: Input - power-on gate, keyboard, computer keys, latch (depends on: 003)

**Phase notes:** The largest phase. Task 007 needs Task 006's destinations and its clamp helper. Task 010 needs Task 009's clock and produces melodic note events into Task 003's note path. Task 011 supplies the held-note registry that Task 010's arpeggiator reads; until it lands, the arpeggiator is verifiable against the melodic lane.

### ✅ Phase 6: Persistence and Observability
**Parallel Tasks:**
- ✔️ Task 012: Preset system - 12 slots and JSON round-trip (depends on: 010)
- ✔️ Task 013: Level meter and runtime inspection handle (depends on: 008, 009, 010)

**Phase notes:** Task 012 needs Task 010's patterns, chain order, swing and tempo because presets own them. Task 013 needs the analyser's `fftSize` fixed by Task 008, the eleven drum trigger counters from Task 009 and the firing step and pattern from Task 010. Both must complete before the plan's Self Validation steps can run.

### ✅ Phase 7: Documentation
**Parallel Tasks:**
- ✔️ Task 014: README documentation (depends on: 012, 013)

**Phase notes:** Runs last so the control map is written from the finished store's parameter list rather than from the plan.

### Post-phase Actions
- After every phase: run `POST_PHASE.md`, update task statuses in each task file's frontmatter to `completed`, and prefix the phase title and its task entries in this blueprint with the completion emoji.
- Do not advance a phase until its own tasks are verified by the evidence gate in `/config/shared/verification-gate.md`. A subagent's report of success is a claim, not evidence.
- Do not change the site while the `playwright-cli` verification of a phase is being read.

### Execution Summary
- Total Phases: 7
- Total Tasks: 14

## Execution Summary

**Status**: ✅ Completed Successfully
**Completed Date**: 2026-10-03

### Results

All 14 tasks across 7 phases executed, each verified against the running site rather
than against a sub-agent's report. The site returns **200** (was 403) and plays.

Delivered, against the plan's seven components:

- **Voice**: 16-voice allocator stealing oldest-released-first; three oscillator cores
  each with all **10** waveforms; per-core FM with a selectable source, unison 1–7 with
  symmetric detune spread, pairwise ring modulation that is additive rather than
  exclusive; a wavesampler with four factory `PeriodicWave` tables and a user `.wav`
  loader that resamples to a fixed 2048-point table.
- **Tone**: two cascaded resonant stages per voice (LP24 / LP12 / HP12 / BP12 / Notch12),
  20 Hz–20 kHz cutoff, Q to 30, soft-clip drive, amp ADSR that releases from wherever
  it actually is, and a filter ADSR exposed as a matrix source with deliberately no
  amount knob.
- **Modulation**: three LFOs (six shapes, free-running or tempo-synced) and the full
  **8×8** matrix, 64 bipolar routes summed once per voice per block into a single
  vector and applied at eight defined points — one write site each.
- **Effects**: 3-band EQ → delay → reverb → limiter → analyser, in that order, with the
  delay upstream of the reverb.
- **Rhythm**: the single 25 ms lookahead clock, 11 synthesized 808 voices, a 16-step
  sequencer over 12 lanes with 4 patterns and chain mode, and the 5-mode arpeggiator.
- **Input and state**: power-on gate, 49-key keybed, tracker layout, latch, 12
  `localStorage` slots with JSON round-trip, a level meter, and a 51-field read-only
  inspection handle.

All 17 Self Validation steps pass. Final state: **571 tests, 0 failures**, 0 console
errors, 43 network requests from a single origin, no binary media, no third party.

### Noteworthy Events

**The code review gate did not run.** Its verbatim result:

```json
{"kind":"skipped","reason":"validator-absent","detail":"No `xmllint` on PATH, so emitted findings could not be validated against the vendored schema and the review gate was skipped. Install libxml2-utils (Debian/Ubuntu), libxml2 (Homebrew), or your platform equivalent to enable the gate.","action":"continue","codeReview":"Failed; No reviewer performed a certified review. No `xmllint` on PATH, so emitted findings could not be validated against the vendored schema and the review gate was skipped. Install libxml2-utils (Debian/Ubuntu), libxml2 (Homebrew), or your platform equivalent to enable the gate."}
```

The gate shells out to `xmllint` to validate `review.xml` against the vendored schema,
and this container has no root to install `libxml2-utils`. **No findings were acted on
or ignored, because none were produced** — this run is uncertified, not clean. The
implementer wrote and verified every line of this diff, so substituting that judgement
for an independent harness is exactly the separation the gate exists to enforce.

**Four defects were found by verification rather than by reading code**, and each is
now covered by a regression test that was confirmed to fail before the fix:

1. **The modulation rig deleted scheduled notes.** `block()` wrote AudioParams for
   voices whose note-on the clock had scheduled ahead but which had not begun, and
   `cancelAndHoldAtTime` removes every event stamped at or after its time — so every
   melodic-lane and arpeggiator note was cancelled before it sounded. Invisible on a
   warm page; total silence on a cold one. The fix guards both the pending note-on
   *and* the pending note-off, which the original diagnosis missed.
2. **The 808 kit and the clock were not in the shipped page.** All ten of Task 009's own
   acceptance criteria passed while the RUN button did nothing, because the probe
   imported `drums.js` by hand rather than through the entry point.
3. **Black keys sat up to 173 px off their seam** at narrow widths — `1fr` grid tracks
   are `minmax(auto, 1fr)`, floored at each key's min-content, and `C#2`'s label is
   wider than `D#2`'s.
4. **The keybed dragged the whole page sideways on a phone**: 218 px of horizontal
   scroll at 390 px, because nothing bounded its intrinsic width.

**Two gaps came from the task decomposition rather than the code.** Tasks 004 and 005
both needed `voice.js`; the partition was fixed by giving the wavesampler `engine.js`
as its seam, and that seam is now load-bearing. Separately, both Phase 6 tasks needed a
`<script>` line in `web/index.html`, which no task in that phase owned — so the presets
shipped wired to nothing until it was caught.

**The orchestrator's own verification was wrong four times**, each producing a false
reading rather than a false pass: `delay.feedback: 0.6` where the schema wanted 60
(percent); `filter1.reso` where the key is `filter1.resonance`; a sampling loop with
no `await`, giving 40 identical readings and a variance of 0; and an analyser connected
but not connected onward to the destination, reading zero. All four were turned into
`scripts/verify.mjs`, which now refuses each one by construction.

### Necessary follow-ups

- **Install `libxml2-utils` and re-run the review gate.** `code-review.cjs 1 opencode`
  produces a certified verdict in seconds once `xmllint` is on PATH. Nothing was
  certified in this run.
- **`choice` and preset controls still render as native form elements.** The waveform,
  FM-source, ring and table `<select>`s, the file input, and the twelve slot buttons
  read as browser defaults against an otherwise painted surface. Cosmetic, consistent
  with the work order's "a little bit buggy", but it is the one place the impressionist
  treatment does not reach.
- **The meter canvas is `aria-hidden` with no text alternative.** The value is available
  on `window.__instrument`, and an `aria-live` region updated at the meter's rate would
  flood a screen reader, so this was a deliberate choice rather than an oversight.
- **Modulation is applied per clock step, not per sample.** An LFO above roughly 4 Hz
  aliases against that block rate. The plan accepted per-block coarseness; the block
  being the *clock's step* makes it coarser than "very slightly coarse" implies, and
  closing it needs either a second timer or an `AudioWorklet` — both ruled out.
- **`waveSampler.serialize()` fills a document's own `slot` from the currently selected
  slot.** Task 012 worked around it by taking the slot from `tables()`; the
  one-liner in `web/audio/wavesampler.js` is still wrong.
