/**
 * drum-kit.js — the eleven synthesized Roland 808 voices: their recipes, their
 * per-trigger graphs, and the kit that owns their counters and their pedal.
 *
 * WHY THIS FILE IS A FACTORY AND NOT A SINGLETON
 *   It imports nothing from the audio graph — no context, no master bus, no store.
 *   Everything arrives as an argument, which is what lets tests/808.test.mjs drive
 *   all eleven recipes on a fake AudioContext with no browser and no audio device,
 *   and check the scheduled AUTOMATION rather than guessing from a level reading.
 *   `web/audio/drums.js` is what binds this to the real instrument.
 *
 * 808-SHAPED, NOT SAMPLE-IDENTICAL
 *   The plan accepted this trade-off explicitly. The recipes below follow each
 *   voice's construction — a pitch-dropping sine, four staggered bursts, an
 *   inharmonic square pair — and stop there. No attempt is made to match a sampled
 *   transient sample-for-sample, because nothing else in the instrument depends on
 *   it and the effort is better spent on the clock.
 *
 * EVERY VOICE HAS THE SAME SHAPE
 *
 *   source(s) ─> [filters] ─> envelope ─> entry ─> panner ─> the mix bus
 *
 *   The ENTRY gain carries the whole voice's decay, so the kit's `stop` and
 *   `allNotesOff` have exactly one node to fade and one number to reason about no
 *   matter how many sub-bursts a recipe has. The PAN is a `StereoPannerNode` and is
 *   the only positioning control in the kit — the plan has no width control, so a
 *   drum voice can be placed but not widened.
 *
 *   Node counts are honest because nodes.js is used for every node, including the
 *   biquads and the panner, which have no factory there. A label is
 *   `drum-<voice>-<role>`, so `nodeReport()` can attribute every allocated node to
 *   the voice that made it — which is how "five hundred hits left no nodes behind"
 *   is checked rather than asserted.
 *
 * NOISE IS ALWAYS THE SHARED BUFFER
 *   Every noise layer goes through `createNoiseSource()` from audio/noise.js. Task 3
 *   built that single buffer precisely so this kit could reuse it; a per-trigger
 *   noise buffer would be ~380 KB per hit. tests/808.test.mjs fires 500 hits and
 *   asserts `noiseBufferCount(ctx)` is still 1.
 *
 * TEARDOWN HANGS OFF THE NODE'S OWN END
 *   Each source gets an `onended` that retires and disconnects the whole trigger.
 *   Nothing waits on a timer: a crash cymbal legitimately owns its nodes for over a
 *   second, and a timer-based teardown either clips it early or leaks it. Every
 *   source in a trigger is handed the same stop time, so the last `onended` is the
 *   one that finds a complete, still-connected graph.
 *
 * THE OPEN HAT'S PEDAL
 *   `oh` is playable as a step voice AND as a held pedal. While the pedal is down, a
 *   note-off is COUNTED, not obeyed — `releasePendingCount('oh')` says how many
 *   releases are waiting — and the voice is only faded when `pedalUp` lets them
 *   through. The counter is per voice so a stray note-off cannot be lost, and a
 *   panic clears it.
 *
 * THE PARAMETERS, AND WHY THEY ARE READ AT TRIGGER TIME
 *   tune (-12..+12 semitones), decay (0.05..2.0 s), level (0..1) and pan (-1..1) are
 *   read from the store when a voice is triggered and baked into that trigger's
 *   nodes. That is not laziness: a percussive voice has no meaningful "held" state
 *   to modify, and the values a trigger has already scheduled cannot be unscheduled
 *   by a later drag. So a control drag writes to the store, and the next hit uses
 *   it — with no AudioParam written during a gesture, which is the rule the rest of
 *   the instrument follows.
 *
 *   The one exception is a HELD open hat, which is a real sustained voice: the kit
 *   exposes its live level and pan gains so the app layer can ramp them while the
 *   pedal is down. See `applyLiveLevel` / `applyLivePan`.
 */

import { createGain, createOscillator, nodeStats, retireNode, trackNode } from './nodes.js';
import { createNoiseSource } from './noise.js';
import { SEMITONE_CENTS, centsToRatio, clampFrequency } from './pitch.js';
import { rampTo, setNow } from './automation.js';
import { KIT_VOICES } from '../ui/params.js';

/** The declared ranges, mirrored from the store so the kit can defend itself. */
export const TUNE_RANGE = { min: -12, max: 12 };
export const DECAY_RANGE = { min: 0.05, max: 2 };
export const LEVEL_RANGE = { min: 0, max: 1 };
export const PAN_RANGE = { min: -1, max: 1 };

/** How long the envelope takes to reach its peak. Percussive: microseconds. */
const ATTACK_CEILING = 0.002;

/** The floor an exponential decay ramps to before the hard cut to zero. */
const DECAY_FLOOR = 1e-4;

/**
 * Silence past the end of the envelope. A source cannot be stopped at the instant
 * its gain is already zero without a click, and it gives every voice the same
 * release shape.
 */
const RELEASE_TAIL = 0.01;

/** How long a release takes when something is released by hand or by panic. */
const RELEASE_FADE = 0.02;

/* --------------------------------------------------------------- the recipes --- */

/**
 * THE ELEVEN RECIPES. Every number here is a construction decision with a reason,
 * not a fitted one.
 *
 * Shared field meanings:
 *   wave           the oscillator type of the pitched layer
 *   hz             the fundamental, before `tune`
 *   bodyHz         a tuned body: two oscillators at these frequencies
 *   bodyQ          resonance of each body oscillator, for the voices that need one
 *   defaultDecay   the `kit.<voice>.decay` default the recipe was shaped around
 *   attackSeconds  time to peak
 *   noise          the noise layer: { filter, hz, q, gain, decayShare }
 *   decayShare     this layer's length as a fraction of the voice's total decay,
 *                  for a recipe whose layers do NOT all last the whole note
 *   pedal          true for the one voice that is a held pedal
 *   levelTrim      the recipe's own balance, before the store's `level`
 */
export const DRUM_RECIPES = {
  /**
   * BASS DRUM — a sine whose pitch falls from well above the fundamental to it in
   * 50 ms, with a click transient over the top. The pitch drop is the whole
   * character: a bass drum that started at its own frequency would read as a
   * bloop, and the drop is why an 808 kick punches rather than plods. The click is
   * the beater, and it is what makes the attack audible on small speakers.
   */
  bd: {
    label: 'Bass Drum',
    wave: 'sine',
    hz: 52,
    pitchDropRatio: 4,
    pitchDropSeconds: 0.05,
    click: { filter: 'highpass', hz: 1800, seconds: 0.004, gain: 0.5 },
    defaultDecay: 0.45,
    attackSeconds: ATTACK_CEILING,
    levelTrim: 1,
  },

  /**
   * SNARE — two tuned body tones around 180 Hz and 331 Hz, plus a bandpassed noise
   * burst. The body is what carries pitch, so the noise is the bright part and the
   * body the loud part; a snare made of noise alone has no note to tune to, which
   * is why the 808's two body oscillators are the reason its snare sits in a kit.
   */
  sd: {
    label: 'Snare',
    bodyHz: [180, 331],
    bodyGain: 0.42,
    noise: { filter: 'bandpass', hz: 1800, q: 0.8, gain: 0.75, decayShare: 0.8 },
    defaultDecay: 0.22,
    attackSeconds: 0.001,
    levelTrim: 0.95,
  },

  /** LOW TOM — a pitched sine at 100 Hz. The longest of the three. */
  lt: { label: 'Low Tom', wave: 'sine', hz: 100, defaultDecay: 0.35, attackSeconds: ATTACK_CEILING, levelTrim: 0.9 },

  /** MID TOM — 150 Hz, shorter than the low tom. */
  mt: { label: 'Mid Tom', wave: 'sine', hz: 150, defaultDecay: 0.32, attackSeconds: ATTACK_CEILING, levelTrim: 0.9 },

  /** HI TOM — 220 Hz, the shortest. The three descend in pitch and in envelope. */
  ht: { label: 'Hi Tom', wave: 'sine', hz: 220, defaultDecay: 0.28, attackSeconds: ATTACK_CEILING, levelTrim: 0.9 },

  /**
   * RIM SHOT — two high-Q tuned tones (1.7 kHz and 480 Hz) and a noise tick, over
   * 35% of the voice's decay. The high Q is the whole point: a rimshot is two
   * resonant modes ringing for a moment, which is why it sounds like a stick on a
   * shell rather than a click.
   */
  rs: {
    label: 'Rim Shot',
    bodyHz: [1700, 480],
    bodyQ: 12,
    bodyGain: 0.6,
    decayShare: 0.35,
    noise: { filter: 'bandpass', hz: 2600, q: 6, gain: 0.6, decayShare: 1 },
    defaultDecay: 0.06,
    attackSeconds: 0.0008,
    levelTrim: 0.9,
  },

  /**
   * CLAP — four bandpassed noise bursts 10 ms apart. Not four copies of one hit: the
   * gap is what the ear reads as "several hands", and collapsing them into one
   * burst is the single most common way a synthesized clap sounds wrong.
   */
  cp: {
    label: 'Clap',
    bursts: 4,
    burstGapSeconds: 0.01,
    // The three hands are 4 ms ticks inside 10 ms gaps. The number is not arbitrary: the
    // gap has to be long enough for the ear to hear, and this clap's noise passes a
    // roughly 750 Hz band, so a gap shorter than about two cycles — under 3 ms — is not a
    // gap at all, it is a phase wobble. At 8 ms bursts in 10 ms gaps the four hands
    // smeared into one decaying hit, which is the single most common way a synthesized
    // clap sounds wrong.
    burstDecaySeconds: 0.004,
    // The LAST burst is the body: it rings for the voice's whole decay, so the decay
    // control changes what the clap leaves behind instead of only its peak.
    burstBodyShare: 1,
    noise: { filter: 'bandpass', hz: 1050, q: 1.4, gain: 1 },
    defaultDecay: 0.18,
    attackSeconds: 0.0008,
    levelTrim: 0.95,
  },

  /**
   * COWBELL — two square waves at 540 Hz and 800 Hz through a bandpass. The ratio
   * 800/540 = 1.481 is the famously wrong-sounding-but-right interval: it is not a
   * harmonic and not an octave, which is exactly why it reads as a struck metal
   * bar. The two-stage ring — a short one and a long one — is the 808's signature.
   */
  cb: {
    label: 'Cowbell',
    wave: 'square',
    squares: [540, 800],
    filter: 'bandpass',
    // Wide enough at Q 0.9 that BOTH squares survive it: the whole character of this
    // voice is the interval between them, and a filter steep enough to remove the
    // lower one removes the evidence that there are two.
    filterHz: 2200,
    filterQ: 0.9,
    decayRings: [0.33, 1],
    defaultDecay: 0.3,
    attackSeconds: 0.001,
    levelTrim: 0.85,
  },

  /** CLOSED HAT — highpassed noise, 55 ms. */
  ch: {
    label: 'Closed Hat',
    noise: { filter: 'highpass', hz: 7000, q: 0.9, gain: 1 },
    defaultDecay: 0.055,
    attackSeconds: 0.0006,
    levelTrim: 0.85,
    pedal: false,
  },

  /**
   * OPEN HAT — the same filter as the closed hat and a far longer decay, and the one
   * voice that is also a held pedal. Same filter, different envelope: that is the
   * entire difference between the two hats on a real machine, and matching it is
   * what makes them interchangeable at the panel.
   */
  oh: {
    label: 'Open Hat',
    noise: { filter: 'highpass', hz: 7000, q: 0.9, gain: 1 },
    defaultDecay: 0.4,
    attackSeconds: 0.0008,
    levelTrim: 0.85,
    pedal: true,
  },

  /**
   * CYMBAL — a long highpassed noise burst layered with a CLUSTER of detuned squares
   * at inharmonic pitches through a bandpass. The noise alone is a hiss; the cluster
   * is what gives it the shimmering metallic partials, and the detune is what keeps
   * the cluster from sounding like one buzzer.
   */
  cy: {
    label: 'Cymbal',
    noise: { filter: 'highpass', hz: 3500, q: 0.7, gain: 1, decayShare: 1 },
    clusters: 6,
    clusterHz: [196, 233, 294, 349, 415, 494],
    clusterDetune: [0, 28, -35, 44, -22, 57],
    clusterFilter: { type: 'bandpass', hz: 1200, q: 0.7 },
    clusterDecayShare: 0.45,
    defaultDecay: 1.2,
    attackSeconds: 0.002,
    levelTrim: 0.7,
  },
};

/* ------------------------------------------------------------------- helpers --- */

const finite = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
const clamp = (n, low, high) => (n < low ? low : n > high ? high : n);
const positive = (n, fallback) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : fallback);

/** A trigger's parameters, read from the store and clamped to the declared ranges. */
export function drumParams(read, name) {
  return {
    tune: Math.round(clamp(finite(read(`kit.${name}.tune`), 0), TUNE_RANGE.min, TUNE_RANGE.max)),
    decay: clamp(finite(read(`kit.${name}.decay`), DRUM_RECIPES[name].defaultDecay), DECAY_RANGE.min, DECAY_RANGE.max),
    level: clamp(finite(read(`kit.${name}.level`), 1), LEVEL_RANGE.min, LEVEL_RANGE.max),
    pan: clamp(finite(read(`kit.${name}.pan`), 0), PAN_RANGE.min, PAN_RANGE.max),
  };
}

/** The recipe's fundamental after `tune`, clamped inside what the context can render. */
export function tunedHz(hz, tune, sampleRate) {
  return clampFrequency(positive(hz, 220) * centsToRatio(tune * SEMITONE_CENTS), sampleRate, { floor: 8 });
}

/* ------------------------------------------------------------- the accumulator --- */

/**
 * One trigger in progress. Holds every node it made so teardown can retire and
 * disconnect all of them, and remembers which one is the voice's PRIMARY source —
 * the node whose frequency a tune change is legible on.
 */
function makeTrigger(context, parent, name, at) {
  return { context, parent, name, at, nodes: [], primary: null, sources: [] };
}

const label = (voice, role) => `drum-${voice}-${role}`;

/**
 * A GainNode's `gain` is 1 until something writes to it, and a SCHEDULED write only
 * takes effect AT its own time. The lookahead clock schedules every drum hit up to
 * 100 ms in the future, so a layer whose envelope merely starts with
 * `setValueAtTime(0, at)` is wide open for the whole of that 100 ms — a hat scheduled
 * for the next step leaks at full level before it begins.
 *
 * So every gain a voice creates is silenced AT CONSTRUCTION, before anything is
 * scheduled. This is the one place in the instrument where assigning an AudioParam
 * directly is correct, and it is correct for exactly the reason the ramp rule requires:
 * the node has never been connected to anything and has produced no output, so there is
 * no signal to zipper. It is the "switch-like state change while the voice is silent"
 * that rule explicitly carves out.
 */
function addGain(voice, role, value, at) {
  const node = createGain(voice.context, label(voice.name, role));
  node.gain.value = 0;
  setNow(node.gain, value, voice.context, { at });
  voice.nodes.push(node);
  return node;
}

function addFilter(voice, role, { type = 'lowpass', hz = 1000, q = 1, gain = 0 }, at) {
  const node = trackNode(voice.context.createBiquadFilter(), label(voice.name, role));
  node.type = type;
  setNow(node.frequency, hz, voice.context, { at });
  setNow(node.Q, q, voice.context, { at });
  setNow(node.gain, gain, voice.context, { at });
  voice.nodes.push(node);
  return node;
}

function addOscillator(voice, role, { type = 'sine', hz = 220 }, at) {
  const node = createOscillator(voice.context, label(voice.name, role));
  node.type = type;
  setNow(node.frequency, hz, voice.context, { at });
  voice.nodes.push(node);
  voice.sources.push(node);
  if (!voice.primary) voice.primary = node;
  return node;
}

function addNoise(voice) {
  // The shared buffer, always. Task 3 built it for exactly this.
  //
  // NOT re-tracked. `createNoiseSource` goes through `createBufferSource`, which
  // already calls `trackNode`, and `retireNode` only ever decrements once — so a
  // second `trackNode` here would count the same node twice and leave the instrument's
  // live-node tally permanently one too high per noise source. The cost is that noise
  // sources are tallied under the harness's own `bufferSource` label rather than under
  // `drum-<voice>-noise`; every other node in a trigger is attributed per voice, which
  // is what the leak checks read.
  const node = createNoiseSource(voice.context);
  voice.nodes.push(node);
  voice.sources.push(node);
  if (!voice.primary) voice.primary = node;
  return node;
}

function addPanner(voice, role, pan, at) {
  const node = trackNode(voice.context.createStereoPanner(), label(voice.name, role));
  // No initial write is needed here, unlike addGain: a StereoPannerNode's `pan` is
  // already 0, so it is centred — and silent — before its scheduled time without help.
  setNow(node.pan, pan, voice.context, { at });
  voice.nodes.push(node);
  return node;
}

/**
 * The entry envelope: instant silence, a short ramp to peak, then a decay, then a hard
 * cut to zero.
 *
 * `shape: 'exp'` is the default and the right one for a voice that RINGS: an exponential
 * decay is what a struck object actually does, and a linear decay sounds like a slide.
 *
 * `shape: 'lin'` exists for a layer that is over in a few milliseconds. An exponential
 * ramp spans the whole 60 dB of the envelope, so across an 8 ms clap burst it is already
 * 21 dB down halfway through and never has a perceptible peak — four such bursts stack
 * into one decaying smear instead of reading as four, which is the whole character of
 * the clap. A short tick needs a short linear fall and nothing more.
 *
 * A peak of zero schedules silence and nothing else — an exponential ramp cannot reach
 * zero, so the degenerate case has to be handled rather than clamped.
 */
function applyEntryEnvelope(entry, { at, peak, attack, end, shape = 'exp' }) {
  const context = entry.context;
  if (!(peak > 0)) {
    setNow(entry.gain, 0, context, { at });
    return;
  }
  setNow(entry.gain, 0, context, { at });
  entry.gain.linearRampToValueAtTime(peak, at + attack);
  if (shape === 'lin') {
    entry.gain.linearRampToValueAtTime(0, Math.max(at + attack + 1e-4, end));
    return;
  }
  entry.gain.exponentialRampToValueAtTime(Math.max(DECAY_FLOOR, peak * 1e-3), Math.max(at + attack + 1e-4, end - 0.002));
  setNow(entry.gain, 0, context, { at: end });
}

/** Fade the entry gain and stop every source. Idempotent. */
function fadeAndStop(record, { at, seconds }) {
  if (record.stopped) return false;
  record.stopped = true;
  const stopAt = at + seconds;
  for (const source of record.sources) {
    // A released voice is no longer on its own envelope, so the entry gain is faded
    // explicitly rather than left to run to a scheduled zero that is now behind us.
    try {
      if (typeof record.entry.gain.cancelAndHoldAtTime === 'function') record.entry.gain.cancelAndHoldAtTime(at);
      else record.entry.gain.cancelScheduledValues(at);
      record.entry.gain.linearRampToValueAtTime(0, stopAt);
    } catch {
      /* the envelope already finished */
    }
    try {
      source.stop(stopAt);
    } catch {
      /* already stopped, or never started */
    }
  }
  return true;
}

/* ---------------------------------------------------------------- the recipes --- */

/**
 * Build one voice's graph at `at`. The recipe decides the sources and the filters;
 * this function owns the shared shape — entry, panner, stop time, teardown — so no
 * recipe can forget the part that keeps the kit leak-free.
 */
function buildVoice(voice, params) {
  const recipe = DRUM_RECIPES[voice.name];
  const context = voice.context;
  const sampleRate = context.sampleRate ?? 48000;
  const at = voice.at;
  const attack = Math.min(recipe.attackSeconds, params.decay / 2);
  const end = at + attack + params.decay + RELEASE_TAIL;
  const entry = addGain(voice, 'entry', 0, at);
  const panner = addPanner(voice, 'pan', params.pan, at);
  entry.connect(panner);
  panner.connect(voice.parent);

  /** A layer's own length: the whole decay, or the share the recipe gives it. */
  const layerSeconds = (share) => at + Math.max(attack + 1e-4, (end - at) * (share ?? 1) - RELEASE_TAIL);

  switch (voice.name) {
    /* ---- bass drum: pitch drop plus a beater click ---- */
    case 'bd': {
      const base = tunedHz(recipe.hz, params.tune, sampleRate);
      const start = clampFrequency(base * recipe.pitchDropRatio, sampleRate);
      const dropEnd = at + Math.min(recipe.pitchDropSeconds, params.decay);
      const osc = addOscillator(voice, 'body', { type: 'sine', hz: start }, at);
      osc.frequency.exponentialRampToValueAtTime(base, dropEnd);
      setNow(osc.frequency, base, context, { at: end });
      osc.connect(entry);

      // The click: a very short highpassed noise burst, so the attack is a transient
      // rather than a fade-in.
      const clickFilter = addFilter(voice, 'clickFilter', { type: recipe.click.filter, hz: recipe.click.hz, q: 0.7 }, at);
      const clickGain = addGain(voice, 'clickGain', 0, at);
      const clickNoise = addNoise(voice);
      clickNoise.connect(clickFilter);
      clickFilter.connect(clickGain);
      clickGain.connect(entry);
      const clickEnd = at + Math.min(recipe.click.seconds, params.decay);
      applyEntryEnvelope(clickGain, { at, peak: recipe.click.gain, attack: 0.0004, end: clickEnd });
      break;
    }

    /* ---- snare: two tuned bodies plus a noise burst ---- */
    case 'sd': {
      const share = recipe.noise.decayShare;
      for (const [index, hz] of recipe.bodyHz.entries()) {
        const body = addOscillator(voice, `body${index}`, {
          type: index === 0 ? 'triangle' : 'sine',
          hz: tunedHz(hz, params.tune, sampleRate),
        }, at);
        body.connect(entry);
      }
      const noiseFilter = addFilter(voice, 'noiseFilter', {
        type: recipe.noise.filter, hz: recipe.noise.hz, q: recipe.noise.q,
      }, at);
      const noiseGain = addGain(voice, 'noiseGain', 0, at);
      const noise = addNoise(voice);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(entry);
      applyEntryEnvelope(noiseGain, {
        at, peak: recipe.noise.gain, attack, end: Math.min(layerSeconds(share), end),
      });
      break;
    }

    /* ---- the three toms: a pitched sine each ---- */
    case 'lt':
    case 'mt':
    case 'ht': {
      const body = addOscillator(voice, 'body', { type: recipe.wave, hz: tunedHz(recipe.hz, params.tune, sampleRate) }, at);
      body.connect(entry);
      break;
    }

    /* ---- rimshot: two resonant modes plus a tick ---- */
    case 'rs': {
      // The two high-Q modes are the TRANSIENT and ring for `decayShare` of the voice;
      // the noise tick is the body and rings for all of it. That ordering is the
      // rimshot's character — a stick on a shell is bright on the attack and broadband
      // after it, not the other way round.
      const modeBus = addGain(voice, 'modeBus', 0, at);
      modeBus.connect(entry);
      for (const [index, hz] of recipe.bodyHz.entries()) {
        const mode = addOscillator(voice, `mode${index}`, { type: 'sine', hz: tunedHz(hz, params.tune, sampleRate) }, at);
        const ring = addFilter(voice, `modeFilter${index}`, { type: 'bandpass', hz, q: recipe.bodyQ, gain: 6 }, at);
        mode.connect(ring);
        ring.connect(modeBus);
      }
      applyEntryEnvelope(modeBus, {
        at,
        peak: 1,
        attack,
        end: Math.min(layerSeconds(recipe.decayShare), end),
      });
      const tickFilter = addFilter(voice, 'tickFilter', {
        type: recipe.noise.filter, hz: recipe.noise.hz, q: recipe.noise.q,
      }, at);
      const tickGain = addGain(voice, 'tickGain', 0, at);
      const tick = addNoise(voice);
      tick.connect(tickFilter);
      tickFilter.connect(tickGain);
      tickGain.connect(entry);
      applyEntryEnvelope(tickGain, {
        at,
        peak: recipe.noise.gain,
        attack,
        end: Math.min(layerSeconds(recipe.noise.decayShare), end),
      });
      break;
    }

    /* ---- clap: four staggered bursts ---- */
    case 'cp': {
      const filter = addFilter(voice, 'burstFilter', { type: recipe.noise.filter, hz: recipe.noise.hz, q: recipe.noise.q }, at);
      // A summing bus is a fixed unity stage. It is NOT an envelope: each BURST is the
      // gate, and an enveloped bus here would hold all four of them closed.
      const bus = addGain(voice, 'burstBus', 1, at);
      filter.connect(bus);
      bus.connect(entry);
      const body = recipe.bursts - 1;
      for (let index = 0; index < recipe.bursts; index += 1) {
        const burstAt = at + index * recipe.burstGapSeconds;
        const burstGain = addGain(voice, `burst${index}`, 0, burstAt);
        const burst = addNoise(voice);
        burst.connect(burstGain);
        burstGain.connect(filter);
        applyEntryEnvelope(burstGain, {
          at: burstAt,
          peak: recipe.noise.gain,
          attack: 0.0006,
          // The last burst is the body and rings for the whole decay; the other three
          // are the hands and stop inside their own gap.
          end: index === body
            ? Math.min(layerSeconds(recipe.burstBodyShare), end)
            : burstAt + recipe.burstDecaySeconds,
          // The body rings and uses the exponential shape; the three hands are short
          // ticks that need a linear fall, so the gaps between them are audible.
          shape: index === body ? 'exp' : 'lin',
        });
      }
      break;
    }

    /* ---- cowbell: two inharmonic squares through a bandpass ---- */
    case 'cb': {
      const band = addFilter(voice, 'band', { type: recipe.filter, hz: recipe.filterHz, q: recipe.filterQ }, at);
      band.connect(entry);
      // A summing bus is a fixed unity stage; the two RINGS are the envelopes.
      const bus = addGain(voice, 'bus', 1, at);
      bus.connect(band);
      // Two square waves, and TWO ring stages: the short one is the strike and the
      // long one is the body, which together are the 808 cowbell's signature.
      for (const [index, hz] of recipe.squares.entries()) {
        const square = addOscillator(voice, `square${index}`, {
          type: recipe.wave, hz: tunedHz(hz, params.tune, sampleRate),
        }, at);
        const ring = addGain(voice, `ring${index}`, 0, at);
        square.connect(ring);
        ring.connect(bus);
        const share = recipe.decayRings[index] ?? 1;
        applyEntryEnvelope(ring, { at, peak: 0.42, attack, end: Math.min(layerSeconds(share), end) });
      }
      break;
    }

    /* ---- hats: highpassed noise, short or long ---- */
    case 'ch':
    case 'oh': {
      const filter = addFilter(voice, 'hatFilter', {
        type: recipe.noise.filter, hz: recipe.noise.hz, q: recipe.noise.q,
      }, at);
      filter.connect(entry);
      const noise = addNoise(voice);
      noise.connect(filter);
      break;
    }

    /* ---- cymbal: long noise plus a detuned square cluster ---- */
    case 'cy': {
      const noiseFilter = addFilter(voice, 'noiseFilter', {
        type: recipe.noise.filter, hz: recipe.noise.hz, q: recipe.noise.q,
      }, at);
      noiseFilter.connect(entry);
      const noise = addNoise(voice);
      noise.connect(noiseFilter);

      const clusterFilter = addFilter(voice, 'clusterFilter', {
        type: recipe.clusterFilter.type, hz: recipe.clusterFilter.hz, q: recipe.clusterFilter.q,
      }, at);
      const clusterBus = addGain(voice, 'clusterBus', 0, at);
      clusterFilter.connect(clusterBus);
      clusterBus.connect(entry);
      const clusterEnd = Math.min(layerSeconds(recipe.clusterDecayShare), end);
      for (let index = 0; index < recipe.clusters; index += 1) {
        // The detune is in CENTS, applied through detune rather than by changing the
        // frequency, because it is a beating offset against the shared cluster bus and
        // not a pitch of its own.
        const square = addOscillator(voice, `cluster${index}`, {
          type: 'square',
          hz: tunedHz(recipe.clusterHz[index], params.tune, sampleRate),
        }, at);
        setNow(square.detune, recipe.clusterDetune[index] ?? 0, context, { at });
        square.connect(clusterFilter);
      }
      applyEntryEnvelope(clusterBus, { at, peak: 0.32, attack, end: clusterEnd });
      break;
    }

    default:
      throw new Error(`drum-kit: no recipe for voice "${voice.name}"`);
  }

  // The voice's own level, applied once at the entry, after every layer.
  applyEntryEnvelope(entry, { at, peak: params.level * recipe.levelTrim, attack, end });

  return { entry, panner, end, primary: voice.primary };
}

/* ------------------------------------------------------------------ the kit --- */

/**
 * The kit: eleven voices, their counters, the pedal, and the panic.
 *
 * `read` is the parameter store's `get`. Nothing is cached between triggers, so a
 * control drag is heard on the next hit without any subscription here.
 */
export function createDrumKit({ context, parent, read }) {
  if (!context) throw new Error('drum-kit: createDrumKit needs a context');
  if (!parent) throw new Error('drum-kit: createDrumKit needs a parent node to feed');

  const counters = Object.fromEntries(KIT_VOICES.map((name) => [name, 0]));
  const live = Object.fromEntries(KIT_VOICES.map((name) => [name, []]));
  const deferred = Object.fromEntries(KIT_VOICES.map((name) => [name, 0]));
  const pedals = new Map();

  const engaged = (name) => pedals.get(name) === true;

  function teardown(record) {
    if (record.ended) return false;
    record.ended = true;
    for (const node of record.nodes) {
      retireNode(node);
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    record.nodes.length = 0;
    record.sources.length = 0;
    const list = live[record.name];
    const index = list.indexOf(record);
    if (index >= 0) list.splice(index, 1);
    return true;
  }

  function stopLive(name, at, seconds) {
    let stopped = 0;
    for (const record of [...live[name]]) {
      if (fadeAndStop(record, { at, seconds })) stopped += 1;
    }
    return stopped;
  }

  function trigger(name, { at, velocity = 1 } = {}) {
    const recipe = DRUM_RECIPES[name];
    if (!recipe) return null;
    const when = Number.isFinite(at) ? at : context.currentTime;
    const params = drumParams(read, name);
    // Velocity is the step lane's accent. It scales level only: a drum voice has no
    // other continuous parameter an accent could sensibly move.
    const withVelocity = { ...params, level: params.level * Math.max(0, Math.min(1, finite(velocity, 1))) };

    // THE COUNTER. Incremented here, on the audio scheduling path, so it can only move
    // if the voice really was scheduled. This is a verification instrument: a closed
    // hat is 55 ms, which is shorter than an evaluation round-trip, so counting is the
    // only way to prove a short voice fired. It must never be incremented from a UI
    // path, or it would prove nothing.
    counters[name] += 1;

    const voice = makeTrigger(context, parent, name, when);
    const built = buildVoice(voice, withVelocity);

    // The record owns the whole trigger: every node it made (for leak assertions), the
    // entry gain (where level and decay live), the panner, and the two params the app
    // layer can ramp on a held open hat.
    const record = {
      name,
      nodes: voice.nodes,
      sources: voice.sources,
      entry: built.entry,
      panner: built.panner,
      end: built.end,
      primary: built.primary,
      level: built.entry.gain,
      panParam: built.panner.pan,
      stopped: false,
      ended: false,
    };

    // Every source gets the SAME stop time, so the LAST `onended` is the one that finds
    // a complete, still-connected graph and tears it down in one piece. Each source
    // also carries the same handler: teardown is idempotent, so whichever ends first
    // does the work and the rest are no-ops.
    for (const source of record.sources) {
      source.start(when);
      source.stop(built.end);
      source.onended = () => teardown(record);
    }

    live[name].push(record);
    return record;
  }

  function release(name, { at } = {}) {
    if (!DRUM_RECIPES[name]) return 0;
    const when = Number.isFinite(at) ? at : context.currentTime;
    // THE PEDAL. While it is engaged a note-off is counted rather than obeyed, so a
    // sequencer's note-off and a player's key-up can both arrive and the hat keeps
    // ringing until the pedal itself is released.
    if (engaged(name)) {
      deferred[name] += 1;
      return 0;
    }
    deferred[name] = 0;
    return stopLive(name, when, RELEASE_FADE);
  }

  function pedalDown(name) {
    if (!DRUM_RECIPES[name] || !DRUM_RECIPES[name].pedal) return false;
    pedals.set(name, true);
    return true;
  }

  function pedalUp(name, { at } = {}) {
    if (!pedals.has(name)) return false;
    pedals.delete(name);
    const waiting = deferred[name];
    deferred[name] = 0;
    const when = Number.isFinite(at) ? at : context.currentTime;
    if (waiting > 0) stopLive(name, when, RELEASE_FADE);
    return true;
  }

  function allNotesOff({ at } = {}) {
    const when = Number.isFinite(at) ? at : context.currentTime;
    let stopped = 0;
    for (const name of KIT_VOICES) {
      pedals.delete(name);
      deferred[name] = 0;
      stopped += stopLive(name, when, RELEASE_FADE);
    }
    return stopped;
  }

  /**
   * Ramp the level or pan of a currently-held open hat. The only live parameter write
   * in the kit, and it goes through `rampTo` like every other continuous parameter in
   * the instrument, because a level dragged across a sounding voice must not step.
   *
   * A returned false means nothing is held, which is the normal case: for the other
   * ten voices the value is baked in at trigger time, which is the right shape for a
   * percussive note.
   */
  function heldOpenHat() {
    return live.oh.find((record) => !record.stopped) ?? null;
  }

  function applyLiveLevel(value) {
    const target = heldOpenHat();
    if (!target) return false;
    return rampTo(target.level, clamp(finite(value), 0, 1), context);
  }

  function applyLivePan(value) {
    const target = heldOpenHat();
    if (!target) return false;
    return rampTo(target.panParam, clamp(finite(value), PAN_RANGE.min, PAN_RANGE.max), context);
  }

  return {
    voices: () => [...KIT_VOICES],
    parameterKeys: (name) => ['tune', 'decay', 'level', 'pan'].map((field) => `kit.${name}.${field}`),

    trigger,
    release,
    pedalDown,
    pedalUp,
    allNotesOff,
    applyLiveLevel,
    applyLivePan,

    triggerCount: (name) => counters[name],
    counters: () => ({ ...counters }),

    pedalEngaged: () => [...pedals.values()].some(Boolean),
    pedalPending: () => KIT_VOICES.some((name) => deferred[name] > 0),
    releasePendingCount: (name) => deferred[name],
    liveCount: (name) => live[name].filter((record) => !record.stopped).length,
    /**
     * How many triggers are still SOUNDING — not how many records exist. A record
     * stays in its list until its sources' `onended` fires, which for a panic is a
     * couple of milliseconds later, and "still sounding" is the question that matters.
     */
    liveCountAll: () => KIT_VOICES.reduce((sum, name) => sum + live[name].filter((record) => !record.stopped).length, 0),

    /** Per-voice node accounting, attributed by the `drum-<voice>-<role>` labels. */
    nodeReport(stats) {
      const { byLabel } = stats ?? nodeStats();
      const report = {};
      for (const name of KIT_VOICES) report[name] = { created: 0, retired: 0, live: 0, roles: {} };
      for (const [key, row] of Object.entries(byLabel)) {
        const name = /^drum-(.+?)-/.exec(key)?.[1];
        if (!name || !report[name]) continue;
        report[name].created += row.created;
        report[name].retired += row.retired;
        report[name].live += row.live;
        report[name].roles[key] = { ...row };
      }
      return report;
    },
  };
}
