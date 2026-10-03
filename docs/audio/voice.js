/**
 * voice.js — one voice of the instrument: three oscillator cores summed into one
 * chain behind one entry point.
 *
 * THE SHAPE (all of it created on the voice's first note, none of it rewritten
 * by a later task):
 *
 *   core1 ─┐  oscillator  ─> core1 gain ─┐
 *   core2 ─┤  oscillator  ─> core2 gain ─┼─> voice mix ─┐
 *   core3 ─┤  oscillator  ─> core3 gain ─┘              │
 *   ring ──┤  (task 4: ring products)                    │
 *   wave ──┘  (task 5: wavesampler slot)                │
 *                                                        ▼
 *              filter 1 ─> filter 2 ─> VCA (amp ADSR) ─> ENTRY ─> parent
 *
 *   The filter bank (task 6) sits between the mixer and the amplifier, and the
 *   amplifier is under the amp ADSR. `entry` does not move: it is still the one
 *   node whose disconnection ends the voice.
 *
 *   Every core also owns a `ConstantSourceNode` whose `offset` is that core's
 *   ABSOLUTE FREQUENCY IN HZ, connected into each of its oscillators'
 *   `frequency` param. That is the whole pitch story: the panel controls, the
 *   keyboard note, the modulation matrix and (task 4) the frequency modulator
 *   all move one AudioParam, and every oscillator following it needs no per-node
 *   bookkeeping. It is also the single modulation point task 7 sums into, and
 *   the value tasks 10 and 13 read back as a voice's live pitch.
 *
 *   The oscillators themselves are built with `frequency = 0`, so they make no
 *   sound of their own; their pitch is whatever the core's pitch source says.
 *
 * WHY `frequency = 0` AND NOT THE NOTE
 *   A store write to `osc1.detune` has to reach every voice currently playing
 *   osc 1. Writing it into each oscillator's `frequency` would mean sixteen
 *   bindings per key and a second source of truth for pitch. Summing into one
 *   audio-rate signal means one param per voice per core, which is what the plan
 *   calls "modulation summed once per voice, then applied at a small number of
 *   defined points".
 *
 * THE TWO TAPS OF A CORE (task 4)
 *   Each core has a LEVEL tap and a RAW tap:
 *
 *     sources ─> core gain (the level, `osc{n}.level`) ─> mix
 *            └─> core raw  (unity sum, no fader)        ─> FM modulators
 *                                                         and ring products
 *
 *   The raw tap is the one that makes ring modulation ADDITIVE and an FM depth
 *   predictable: a level fader then means exactly one thing, which is this core's
 *   direct contribution to the mixer. Turning a modulator's level to zero removes
 *   its dry path and leaves the ring product running.
 *
 * UNISON (task 4)
 *   A core with unison N owns N-1 extra oscillators — COPIES — playing the same
 *   pitch signal, each displaced by its own `detune`, all summing into one 1/N
 *   gain so the count is not a volume control. The core's own oscillator moves
 *   onto that same sum as soon as N is above one, which is what makes the total
 *   exactly one voice of level at every count. Copies are built on the first
 *   non-zero level of their core and never for a core that is silent: sixteen
 *   voices x three cores x seven is 288 oscillators, and a patch that only uses
 *   one core should not pay for the other two. They are stopped with the core's
 *   own source at note-off, so they cannot outlive the note.
 *
 * THE FILTER BANK AND THE ENVELOPES (task 6)
 *   `voice.filters` is a pair of stages, each a drive shaper and two biquad
 *   sections, and `routeChain()` is the one place their order and their bypasses
 *   are decided. A bypass rewires AROUND the stage rather than muting it, so a
 *   bypassed stage contributes neither slope nor resonance and stops costing
 *   anything downstream. The cutoff a stage runs at is resolved in one direction
 *   and one direction only — panel value, then key tracking, then the matrix
 *   route, then `clampCutoff` — so there is exactly one place a cutoff can be
 *   made illegal, and it clamps.
 *
 *   `voice.ampEnv` owns the amplifier. `voice.filterEnv` owns nothing: it is a
 *   modulation-matrix SOURCE with a shape and no amount, because the plan puts
 *   its depth in the matrix cells for filter 1 and filter 2 cutoff.
 *
 * TEARDOWN — THE PLAN'S NAMED RISK
 *   `entry` is the only node that leaves the voice. `kill()` disconnects that one
 *   node from its parent and stops the per-note sources. Nothing walks the graph
 *   unwiring children, so an oscillator mis-routed by a later task cannot
 *   outlive its voice: the path out of the voice is severed at a single point.
 *   tests/voice.test.mjs asserts that no child is disconnected during teardown,
 *   tests/filter-stage.test.mjs re-asserts it with the filter bank in the way, and
 *   tests/{fm,ring,unison}.test.mjs re-assert it after a hundred re-routes.
 *
 *   Oscillators are never recycled. An OscillatorNode cannot be restarted, so
 *   note-on builds fresh ones and `onended` retires them; a note-off schedules
 *   `stop()` after a short fade rather than cutting mid-cycle.
 *
 *   API
 *     createVoice({ context, parent, read, index }) -> voice
 *     voice.start(note, { at })      note: { id, note, velocity, random }
 *     voice.release(at)              fade, stop, keep for reuse
 *     voice.kill(at)                 THE teardown
 *     voice.core(i)                  { gain, raw, pitchSource, source, copies, read }
 *     voice.coreReads()              the FM / unison / ring values
 *     voice.applyCore(i, opts)       re-resolve pitch through pitch.js
 *     voice.setCoreLevel(i, v, opts) / voice.setMixLevel(v, opts)
 *     voice.setCoreModulation(i, cents, opts)   the matrix pitch route
 *     voice.applyCoreModulation(i, key, value, opts)  the FM/unison/ring door
 *     voice.fmState(i) / voice.unisonState(i) / voice.ringState(i)
 *     voice.setFmAmount / setFmModulation / setUnisonSpread / setUnisonSpreadModulation
 *     voice.modulationPoints()       task 7's destinations
 *     voice.modulationSources()      the per-voice matrix sources, incl. filterEnv
 *
 *     voice.filters / voice.filter(i) / voice.filterState(i) / voice.filterReads()
 *     voice.applyFilter(i, key, value, opts)   the six `filter{n}.*` keys' door
 *     voice.setFilterBypass(i, on, opts)       a graph change, not a mute
 *     voice.setCutoffModulation(i, cents, opts) / voice.cutoffModulation(i)
 *     voice.filterCutoff(i)         the hertz the stage is actually running at
 *     voice.applyEnvelope(prefix, name, value, opts)  the `env*.{shape}` door
 *     voice.envelopeStage(which) / voice.envelopeValue(which)
 *     voice.ampEnvValue() / voice.filterEnvValue()
 *     voice.setAmpLevelBias(delta, opts) / voice.ampLevelBias()
 *
 *     voice.livePitch(i) / livePitchSpan(i) / liveState()
 */

import { VOICE_STATE } from './allocator.js';
import { buildPeriodicWave, nativeWaveform } from './waveforms.js';
import { computeCoreFrequency, midiToHz } from './pitch.js';
import { createNoiseSource } from './noise.js';
import { createConstantSource, createGain, createOscillator, retireNode } from './nodes.js';
import { rampTo, setNow } from './automation.js';
import {
  FILTER_KEYS,
  FILTER_MODES,
  KEY_TRACK_REFERENCE_NOTE,
  CUTOFF_MOD_CENTS,
  clampCutoff,
  clampCutoffModulation,
  createFilterStage,
  cutoffWithKeyTrack,
  cutoffWithModulation,
  registerFilterVoice,
} from './filter.js';
import { clampTimes, createEnvelope, registerEnvelopeVoice } from './env.js';
import {
  CORE_COUNT,
  RING_BUS_LEVEL,
  SPREAD_MAX_CENTS,
  clampFmAmount,
  clampUnisonCount,
  clampUnisonSpread,
  fmSourceIndex,
  fmRouter,
  registerVoice,
  ringPartnerIndex,
  ringRouter,
  unisonCentreCents,
  unisonCopyCents,
  unisonDetuneCents,
  unisonSumGain,
} from './osc-mod.js';

export { CORE_COUNT };

/** The two filter stages per voice, and the amp envelope's peak. */
const FILTER_COUNT = 2;

/** A released voice fades before its sources are stopped, so the sources outlive
 *  the envelope's release by this much rather than being cut at its end. */
export const RELEASE_FADE_SECONDS = 0.03;

/** The matrix may not take a pitch route further than four octaves from centre. */
const MATRIX_PITCH_LIMIT_CENTS = 4 * 1200;

const clampPitchRoute = (cents) => {
  const n = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  return Math.min(Math.max(n, -MATRIX_PITCH_LIMIT_CENTS), MATRIX_PITCH_LIMIT_CENTS);
};

/** Disconnect one destination, and treat "not connected" as a no-op. */
const dropConnection = (node, destination) => {
  try {
    node.disconnect(destination);
  } catch {
    /* already disconnected, or a destination this node never had */
  }
};

export function createVoice({ context, parent, read, index = 0 } = {}) {
  if (!context) throw new Error('createVoice needs a context');
  if (!parent) throw new Error('createVoice needs the parent node it feeds');
  if (typeof read !== 'function') throw new Error('createVoice needs a read(key) accessor for the store');

  const voice = {
    index,
    context,
    parent,
    read,
    state: VOICE_STATE.IDLE,
    noteId: null,
    note: null,
    velocity: 0,
    random: 0,
    startedAt: null,
    releasedAt: null,

    /** Populated on the first note. */
    cores: null,
    mix: null,
    vca: null,
    ringBus: null,
    waveSlot: null,
    entry: null,
    /** Task 6: the two filter stages and the two envelopes. */
    filters: null,
    filterControls: null,
    ampEnv: null,
    filterEnv: null,
  };

  let modCents = [0, 0, 0];
  let sources = [];
  let attached = false;
  let ringBusTarget = 0;
  /** The chain edges currently made, so bypass can take exactly them back. */
  let chainLinks = [];
  /** Task 7's additive bias into the amp envelope's peak. Zero until it writes. */
  let ampLevelBiasValue = 0;

  /* ------------------------------------------------------------ the build --- */

  function build() {
    // The entry point is the outermost node: the one disconnection that ends
    // this voice. Task 6 inserted the filter bank between mix and vca; entry does
    // not move, so the teardown path does not change.
    voice.entry = createGain(context, 'voice-entry');
    voice.vca = createGain(context, 'voice-vca');
    voice.mix = createGain(context, 'voice-mix');
    voice.vca.gain.value = 0; // silent until a note starts
    // The amplifier -> entry edge is permanent. Only the chain BEFORE the
    // amplifier is rewirable, so bypass never touches the way out of the voice.
    voice.vca.connect(voice.entry);

    // Task 6's bank. `routeChain()` makes the connections, because bypass has to
    // be able to take them back — so mix does NOT connect to the vca here.
    voice.filters = [];
    voice.filterControls = [];
    for (let i = 0; i < FILTER_COUNT; i += 1) {
      voice.filters.push(createFilterStage({ context, index: i }));
      voice.filterControls.push(emptyFilterControl(i));
    }
    routeChain();

    // The amp envelope drives the amplifier; the filter envelope drives nothing —
    // it is a matrix SOURCE, and its depth lives in the matrix cells.
    voice.ampEnv = createEnvelope({ context, param: voice.vca.gain, peak: 1 });
    voice.filterEnv = createEnvelope({ context, param: null, peak: 1 });

    // Placeholder summing inputs. They exist NOW, silent, so tasks 4, 5 and 6
    // fill them without unwiring or rewiring the mixer.
    voice.ringBus = createGain(context, 'ring-bus');
    voice.ringBus.gain.value = 0;
    voice.ringBus.connect(voice.mix);
    voice.waveSlot = createGain(context, 'wave-slot');
    voice.waveSlot.gain.value = 0;
    voice.waveSlot.connect(voice.mix);

    voice.cores = [];
    for (let i = 0; i < CORE_COUNT; i += 1) {
      const gain = createGain(context, 'core-gain');
      gain.connect(voice.mix);
      // The raw tap: the sum of this core's oscillators before its level fader,
      // which is where task 4's modulators are taken from.
      const raw = createGain(context, 'core-raw');
      const pitchSource = createConstantSource(context, 'core-pitch');
      pitchSource.start(context.currentTime);
      voice.cores.push({
        index: i,
        gain,
        raw,
        pitchSource,
        source: null,
        copies: [],
        ownDest: null,
        unisonSum: null,
        unisonSumTarget: 1,
        fm: fmRouter(context, pitchSource),
        ring: ringRouter(context, voice.ringBus, i),
        read: coreRead(i),
        modCents: 0,
        hz: 0,
        // The manual values are the store's until a matrix route is added, and
        // are re-read from the store at every note-on, so the store stays the
        // only authority for what the panel says.
        fmManual: 0,
        fmRoute: 0,
        fmSourceName: null,
        unisonManual: 1,
        ringModName: null,
        spreadManual: 0,
        spreadRoute: 0,
        spreadWritten: NaN,
      });
    }
  }

  /** The FM / unison / ring values for one core, refreshed from the store. The
   *  store is the only authority, so these are re-read rather than cached: a
   *  control moved while the voice is sounding must change what the voice reads. */
  function coreRead(i) {
    return {
      index: i,
      waveform: read(`osc${i + 1}.waveform`),
      octave: read(`osc${i + 1}.octave`),
      semitone: read(`osc${i + 1}.semitone`),
      detune: read(`osc${i + 1}.detune`),
      level: read(`osc${i + 1}.level`),
      fmAmount: read(`osc${i + 1}.fmAmount`),
      fmSource: read(`osc${i + 1}.fmSource`),
      unison: read(`osc${i + 1}.unison`),
      unisonSpread: read(`osc${i + 1}.unisonSpread`),
      ringMod: read(`osc${i + 1}.ringMod`),
    };
  }

  /** Re-read one core's values in place, so `core.read` is never a stale copy. */
  function refreshCoreRead(i) {
    const core = voice.cores[i];
    if (!core) return null;
    Object.assign(core.read, coreRead(i));
    return core.read;
  }

  /* -------------------------------------------------- the filter bank (task 6) --- */

  /** A stage's control values, before the store has been read. */
  function emptyFilterControl(i) {
    return {
      index: i,
      type: 'lp24',
      cutoff: 350,
      resonance: 1,
      drive: 0,
      keyTrack: 0,
      bypass: false,
      /** Task 7's additive contribution, in cents. Zero until something routes. */
      cutoffRoute: 0,
      /** The hertz actually written to the sections, after tracking and the clamp. */
      appliedHz: 350,
    };
  }

  /**
   * THE CHAIN: mix -> filter 1 -> filter 2 -> amplifier, with every bypassed
   * stage rewired AROUND rather than muted. Rebuilt as a list of edges every time
   * a bypass changes, and only the edges that actually changed are connected or
   * disconnected — so a bypass toggle costs two connections, not a graph walk.
   *
   * `chainLinks` is the memory of what is currently wired. Without it a bypass
   * could not be undone, and the "nothing is individually disconnected at
   * teardown" rule would have an exception in it.
   */
  function routeChain() {
    const wanted = [];
    let source = voice.mix;
    for (const stage of voice.filters) {
      if (stage.bypass) continue;
      wanted.push([source, stage.input]);
      source = stage.output;
    }
    wanted.push([source, voice.vca]);

    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    for (const link of chainLinks) if (!wanted.some((next) => same(link, next))) dropConnection(link[0], link[1]);
    for (const link of wanted) if (!chainLinks.some((now) => same(now, link))) link[0].connect(link[1]);
    chainLinks = wanted;
    return wanted;
  }

  /** The panel's value for one filter key, read fresh — the store is the only
   *  authority, so a control moved while the note sounds takes effect at once. */
  function filterControlRead(i) {
    const n = i + 1;
    return {
      type: read(`filter${n}.type`),
      cutoff: read(`filter${n}.cutoff`),
      resonance: read(`filter${n}.resonance`),
      drive: read(`filter${n}.drive`),
      keyTrack: read(`filter${n}.keyTrack`),
      bypass: read(`filter${n}.bypass`),
    };
  }

  /**
   * Resolve one stage and write it. The resolution is the whole of the cutoff
   * story, in one place, in this order:
   *
   *   panel value  ->  key tracking (a ratio against middle C)
   *                ->  matrix route (cents, added)
   *                ->  THE CLAMP (20 Hz..20 kHz, and a fraction of the sample rate)
   *
   * Nothing below this line can move a cutoff, which is why task 7 has nothing
   * to clamp for itself.
   */
  function applyFilterStage(i, { at, ramp = true, seconds } = {}) {
    const stage = voice.filters?.[i];
    const control = voice.filterControls?.[i];
    if (!stage || !control) return false;
    stage.setMode(control.type, { at });
    const note = Number.isFinite(voice.note) ? voice.note : KEY_TRACK_REFERENCE_NOTE;
    const tracked = cutoffWithKeyTrack(control.cutoff, note, control.keyTrack);
    const hz = clampCutoff(cutoffWithModulation(tracked, control.cutoffRoute), context.sampleRate);
    control.appliedHz = hz;
    stage.setFrequency(hz, { at, ramp, seconds });
    stage.setResonance(control.resonance, { at, ramp, seconds });
    stage.setDrive(control.drive, { at, ramp, seconds });
    if (stage.bypass !== Boolean(control.bypass)) {
      stage.bypass = Boolean(control.bypass);
      routeChain();
    }
    return hz;
  }

  /** Bring both stages in line with the store, from scratch. Note-on does this in
   *  silence-friendly writes, because nothing is sounding yet. */
  function applyAllFilters(at, ramp = false) {
    for (let i = 0; i < FILTER_COUNT; i += 1) {
      Object.assign(voice.filterControls[i], filterControlRead(i));
      applyFilterStage(i, { at, ramp });
    }
  }

  /** Bring both envelopes in line with the store. */
  function applyAllEnvelopes() {
    voice.ampEnv.setTimes(clampTimes(readEnvTimes('envAmp')));
    voice.filterEnv.setTimes(clampTimes(readEnvTimes('envFilter')));
  }

  function readEnvTimes(prefix) {
    return {
      attack: read(`${prefix}.attack`),
      decay: read(`${prefix}.decay`),
      sustain: read(`${prefix}.sustain`),
      release: read(`${prefix}.release`),
    };
  }

  /* -------------------------------------------------------------- a note --- */

  /**
   * Build one oscillator (or noise source) for a core: silent on its own, with
   * the core's pitch source supplying the frequency. `copy` distinguishes a
   * unison copy from the core's own voice, which is the only difference between
   * them apart from the detune and the summing gain they go through.
   *
   * Nothing is connected to the raw tap or the unison sum here: `applyUnison`
   * owns both, so a copy's two destinations always move together.
   */
  function makeCoreSource(i, at, { copy = false } = {}) {
    const core = voice.cores[i];
    const waveform = read(`osc${i + 1}.waveform`);

    let source;
    if (waveform === 'noise') {
      source = createNoiseSource(context);
    } else {
      source = createOscillator(context, copy ? 'unison-copy' : 'oscillator');
      const native = nativeWaveform(waveform);
      if (native) source.type = native;
      else source.setPeriodicWave(buildPeriodicWave(waveform, context));
      // Silent on its own: the core's pitch source supplies the frequency.
      setNow(source.frequency, 0, context, { at });
      core.pitchSource.connect(source.frequency);
    }

    source.start(at);
    source.onended = () => {
      // The per-note node's only exit. Retiring here is what keeps the node
      // count flat over a long run.
      retireNode(source);
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        core.pitchSource.disconnect(source.frequency);
      } catch {
        /* already disconnected */
      }
      core.copies = core.copies.filter((entry) => entry.source !== source);
      sources = sources.filter((entry) => entry.node !== source);
    };

    sources.push({ node: source, core: i, copy, stopping: false });
    return source;
  }

  function startCore(i, at) {
    const core = voice.cores[i];
    core.source = makeCoreSource(i, at);
    // The core voice is always in the raw tap; only copies come and go with the
    // group, because only copies can be "not playing".
    core.source.connect(core.raw);
    core.ownDest = null;
    voice.applyCore(i, { at, ramp: false });
    setNow(core.gain.gain, read(`osc${i + 1}.level`), context, { at });
    // Places the core voice on its unison sum (or straight on its level) and
    // builds the copies this core's level has earned.
    applyUnison(i, { at, ramp: false, create: true });
  }

  /** The one summing gain a core's copies share, created on first use. */
  function ensureUnisonSum(i) {
    const core = voice.cores[i];
    if (!core.unisonSum) {
      core.unisonSum = createGain(context, 'core-unison-sum');
      core.unisonSum.gain.value = 1;
      core.unisonSumTarget = 1;
      core.unisonSum.connect(core.gain);
    }
    return core.unisonSum;
  }

  /**
   * Per-note nodes may only be built while a note is sounding. A unison change that
   * arrives after the note has gone would otherwise start oscillators that nothing
   * is left to stop — the plan's named risk in its purest form: nodes that outlive
   * their note and are never silenced.
   */
  function mayCreatePerNote() {
    return voice.state === VOICE_STATE.SOUNDING;
  }

  function createUnisonCopies(i, howMany, at) {
    const core = voice.cores[i];
    if (!mayCreatePerNote()) return 0;
    let made = 0;
    for (let n = 0; n < howMany; n += 1) {
      const source = makeCoreSource(i, at, { copy: true });
      core.copies.push({ source, dest: null });
      made += 1;
    }
    return made;
  }

  /**
   * The unison count this core should actually have, given that a noise core
   * cannot be retuned as a waveform and a silent core should cost nothing. The
   * count and the spread come from the voice's own copy of the panel value, which
   * the store fan-out writes — the store is where they come from, this is where
   * they are read from while the note sounds.
   */
  function unisonPlan(i) {
    const core = voice.cores[i];
    const periodic = refreshCoreRead(i).waveform !== 'noise';
    const count = periodic ? clampUnisonCount(core.unisonManual) : 1;
    const audible = periodic && read(`osc${i + 1}.level`) > 0;
    return { count, copies: audible ? count - 1 : 0, spread: clampUnisonSpread(core.spreadManual + core.spreadRoute) };
  }

  /** 1/N on the sum while the count is above one, unity once it is back to one. */
  function applyUnisonGain(i, count, { at, ramp, seconds }) {
    const core = voice.cores[i];
    if (!core.unisonSum) return;
    const target = unisonSumGain(count);
    if (core.unisonSumTarget === target) return; // a level drag must not rewrite it
    core.unisonSumTarget = target;
    if (ramp) rampTo(core.unisonSum.gain, target, context, { at, seconds });
    else setNow(core.unisonSum.gain, target, context, { at });
  }

  /** Ramp every copy's `detune` to its slot in the documented distribution. */
  function applyUnisonSpread(i, count, spread, { at, ramp, seconds }) {
    const core = voice.cores[i];
    if (!core) return 0;
    if (core.spreadWritten === spread) return spread;
    core.spreadWritten = spread;
    for (let k = 0; k < core.copies.length; k += 1) {
      const target = unisonCopyCents(count, spread, k);
      const param = core.copies[k].source.detune;
      if (ramp) rampTo(param, target, context, { at, seconds });
      else setNow(param, target, context, { at });
    }
    return spread;
  }

  /**
   * Bring one core's unison group into line with the store: create the copies a
   * non-zero level has earned, connect exactly the ones the count calls for, and
   * move the core's own oscillator onto the sum when there is a group to join.
   *
   * Pure re-routing beyond the creation step: slots are kept for the life of the
   * note, so climbing and falling between one and seven costs six copy nodes
   * once and no nodes at all thereafter.
   */
  function applyUnison(i, { at, ramp = true, seconds, create = false } = {}) {
    const core = voice.cores[i];
    if (!core) return 1;
    const plan = unisonPlan(i);

    if (create && mayCreatePerNote() && plan.copies > core.copies.length) {
      createUnisonCopies(i, plan.copies - core.copies.length, at);
    }

    const sum = plan.copies > 0 ? ensureUnisonSum(i) : null;
    const dest = sum ?? core.gain;
    if (core.source && core.ownDest !== dest) {
      if (core.ownDest) dropConnection(core.source, core.ownDest);
      core.source.connect(dest);
      core.ownDest = dest;
    }

    for (let k = 0; k < core.copies.length; k += 1) {
      const copy = core.copies[k];
      const wanted = sum && k < plan.copies ? sum : null;
      if (copy.dest !== wanted) {
        if (copy.dest) dropConnection(copy.source, copy.dest);
        // The raw tap moves with the group: a copy that is not playing must not
        // drive the FM or ring modulator either, or the modulator signal would
        // be N times louder at unison N than it is at unison 1.
        if (wanted) copy.source.connect(core.raw);
        else dropConnection(copy.source, core.raw);
        if (wanted) copy.source.connect(wanted);
        copy.dest = wanted;
      }
    }

    applyUnisonGain(i, sum ? plan.count : 1, { at, ramp, seconds });
    applyUnisonSpread(i, plan.count, plan.spread, { at, ramp, seconds });
    return plan.count;
  }

  /**
   * Route one core's frequency modulator and set its depth. The modulator is the
   * modulator core's RAW tap; the depth is summed into this core's pitch source.
   */
  function applyFm(i, { at, ramp = true, seconds } = {}) {
    const core = voice.cores[i];
    if (!core) return 0;
    const wants = refreshCoreRead(i);
    const name = core.fmSourceName === null ? wants.fmSource : core.fmSourceName;
    const sourceIndex = fmSourceIndex(name);
    const modulator = sourceIndex >= 0 ? voice.cores[sourceIndex]?.raw ?? null : null;
    const modulatorHz = sourceIndex >= 0 ? voice.cores[sourceIndex]?.hz ?? 0 : 0;
    return core.fm.apply({
      modulator,
      index: sourceIndex,
      amount: clampFmAmount(core.fmManual + core.fmRoute),
      modulatorHz,
      at,
      ramp,
      seconds,
    });
  }

  /** The ring bus is the one summing point for every product, so it is opened
   *  by the voice as a whole: any live pair, or nothing. */
  function refreshRingBus({ at, ramp = true, seconds } = {}) {
    const active = voice.cores.some((core) => core.ring.state().active);
    const target = active ? RING_BUS_LEVEL : 0;
    if (ringBusTarget === target) return target;
    ringBusTarget = target;
    if (ramp) rampTo(voice.ringBus.gain, target, context, { at, seconds });
    else setNow(voice.ringBus.gain, target, context, { at });
    return target;
  }

  /**
   * Ring modulation is a GRAPH change, not a parameter change. An assignment
   * builds (once) this core's product node and routes two connections into it;
   * turning it off disconnects both. Both signals come from the raw taps, so
   * the partner still feeds the mixer directly and its level fader still means
   * "this core's dry contribution".
   */
  function applyRing(i, { at, ramp = true, seconds } = {}) {
    const core = voice.cores[i];
    if (!core) return false;
    const name = core.ringModName === null ? refreshCoreRead(i).ringMod : core.ringModName;
    const partner = ringPartnerIndex(i, name, CORE_COUNT);
    const live = core.ring.apply({
      carrier: core.raw,
      modulator: partner >= 0 ? voice.cores[partner]?.raw ?? null : null,
      partner,
      on: partner >= 0,
    });
    refreshRingBus({ at, ramp, seconds });
    return live;
  }

  /** Re-resolve the depth of every core that this core modulates. A pitch change
   *  on a modulator has to move its carrier's excursion, so `applyCore` closes
   *  that loop rather than waiting for the next control move. */
  function refreshModulatedBy(i, options) {
    for (let j = 0; j < CORE_COUNT; j += 1) {
      if (fmSourceIndex(read(`osc${j + 1}.fmSource`)) === i) applyFm(j, options);
    }
  }

  /** Settle every mechanism at note-on, from the store, in silence-friendly writes. */
  function applyAllModulation(at) {
    for (let i = 0; i < CORE_COUNT; i += 1) {
      applyUnison(i, { at, ramp: false, create: true });
      applyFm(i, { at, ramp: false });
      applyRing(i, { at, ramp: false });
    }
  }

  /**
   * Schedule `stop()` on every source that is still running. A source already
   * given a stop time is left alone: calling stop() twice throws in the browser,
   * and a source that is fading out does not need stopping again. Unison copies
   * are in the same list, so they stop with the core's own voice.
   */
  function stopSources(at) {
    const fade = at ?? context.currentTime;
    for (const entry of sources) {
      if (entry.stopping) continue;
      entry.stopping = true;
      try {
        entry.node.stop(fade + RELEASE_FADE_SECONDS);
      } catch {
        /* already stopped */
      }
    }
  }

  /* ----------------------------------------------------------- the public --- */

  voice.core = (i) => {
    if (!voice.cores) throw new Error('voice.core: the voice has no cores yet; start a note first');
    const core = voice.cores[i];
    if (!core) throw new Error(`voice.core: no core ${i}`);
    return core;
  };

  voice.coreReads = () => (voice.cores ?? []).map((_core, i) => refreshCoreRead(i));

  voice.summingInputs = () => ['core1', 'core2', 'core3', 'ringMod', 'waveSampler'];

  voice.start = (note, { at } = {}) => {
    const when = Number.isFinite(at) ? at : context.currentTime;
    if (!voice.cores) build();
    if (!attached) {
      voice.entry.connect(parent);
      attached = true;
    }
    // A start on top of a note that is still running would orphan the old
    // sources, so it stops them first. The allocator always kills before it
    // re-uses; this is the belt to that braces.
    if (sources.some((entry) => !entry.stopping)) stopSources(when);

    voice.state = VOICE_STATE.SOUNDING;
    voice.noteId = note.id ?? null;
    voice.note = note.note;
    voice.velocity = note.velocity ?? 1;
    voice.random = Number.isFinite(note.random) ? note.random : 0;
    voice.startedAt = when;
    voice.releasedAt = null;
    voice.noteHz = midiToHz(voice.note);

    modCents = [0, 0, 0];
    for (const core of voice.cores) {
      core.modCents = 0;
      core.source = null;
      core.copies = [];
      core.ownDest = null;
      // Each note re-reads the panel; a matrix route is per block, not per note.
      core.fmManual = clampFmAmount(read(`osc${core.index + 1}.fmAmount`));
      core.fmRoute = 0;
      core.fmSourceName = read(`osc${core.index + 1}.fmSource`);
      core.unisonManual = clampUnisonCount(read(`osc${core.index + 1}.unison`));
      core.ringModName = read(`osc${core.index + 1}.ringMod`);
      core.spreadManual = clampUnisonSpread(read(`osc${core.index + 1}.unisonSpread`));
      core.spreadRoute = 0;
      core.spreadWritten = NaN; // forces the first spread write
    }

        // The voice comes up over its amp envelope's attack, not over a fixed fade:
    // the envelope owns the amplifier now, and it holds the value itself if a
    // reused voice is still finishing the previous note's release.
    applyAllFilters(when, false);
    applyAllEnvelopes();
    voice.ampEnv.start(when);
    voice.filterEnv.start(when);
    setNow(voice.mix.gain, read('mixer.level'), context, { at: when });

    for (let i = 0; i < CORE_COUNT; i += 1) startCore(i, when);
    applyAllModulation(when);
    return voice;
  };

  voice.release = (at) => {
    if (voice.state !== VOICE_STATE.SOUNDING) return voice;
    const when = Number.isFinite(at) ? at : context.currentTime;
    voice.state = VOICE_STATE.RELEASED;
    voice.releasedAt = when;
    // Both envelopes release from wherever they are — cancel-and-hold, so a note
    // off during the attack does not jump up to the sustain level first. The amp
    // envelope's length is returned because the sources have to outlive it: an
    // 8 s release would otherwise be 8 s of silence.
    const releaseSeconds = voice.ampEnv.release(when);
    voice.filterEnv.release(when);
    stopSources(when + releaseSeconds);
    return voice;
  };

  voice.kill = (at) => {
    const when = Number.isFinite(at) ? at : context.currentTime;
    if (voice.cores) stopSources(when);

    // THE TEARDOWN. One node, one disconnection. Nothing below this line walks
    // the graph: an oscillator that a later task mis-routed is silenced by this
    // single cut rather than by being hunted down.
    if (attached) {
      voice.entry.disconnect();
      attached = false;
    }
        // Ramp, not assign: a ramp to 1 may still be in flight from this voice's own
    // attack, and a bare setValueAtTime would be overridden by its end point.
    if (voice.vca) rampTo(voice.vca.gain, 0, context, { at: when });
    // The envelopes stop here rather than running on through an idle voice.
    if (voice.ampEnv) voice.ampEnv.reset();
    if (voice.filterEnv) voice.filterEnv.reset();

    voice.state = VOICE_STATE.IDLE;
    voice.noteId = null;
    voice.startedAt = null;
    voice.releasedAt = null;
    if (voice.cores) {
      for (const core of voice.cores) {
        core.source = null;
        core.copies = [];
        core.ownDest = null;
      }
    }
    return voice;
  };

  /* ------------------------------------------------------- the parameters --- */

  /** Re-resolve one core's frequency. Always through the single computation. */
  voice.applyCore = (i, { at, ramp = true, seconds } = {}) => {
    if (!voice.cores) return 0;
    const core = voice.cores[i];
    if (!core) return 0;
    const params = refreshCoreRead(i);
    const hz = computeCoreFrequency(
      {
        noteHz: voice.noteHz ?? 0,
        octave: params.octave,
        semitone: params.semitone,
        cents: params.detune,
        modCents: modCents[i],
      },
      { sampleRate: context.sampleRate },
    );
    core.hz = hz;
    if (ramp) rampTo(core.pitchSource.offset, hz, context, { at, seconds });
    else setNow(core.pitchSource.offset, hz, context, { at });
    // A modulator's pitch is half of what its carrier's depth depends on.
    refreshModulatedBy(i, { at, ramp, seconds });
    return hz;
  };

  voice.setCoreLevel = (i, value, { at, ramp = true, seconds } = {}) => {
    if (!voice.cores) return false;
    const core = voice.cores[i];
    if (!core) return false;
    const v = Math.max(0, Number(value) || 0);
    if (ramp) rampTo(core.gain.gain, v, context, { at, seconds });
    else setNow(core.gain.gain, v, context, { at });
    // A level coming up from zero is the moment a silent core's copies are worth
    // building, which is the whole of the lazy-creation rule.
    applyUnison(i, { at, ramp, seconds, create: mayCreatePerNote() });
    return true;
  };

  voice.setMixLevel = (value, { at, ramp = true, seconds } = {}) => {
    if (!voice.mix) return false;
    const v = Math.max(0, Number(value) || 0);
    if (ramp) rampTo(voice.mix.gain, v, context, { at, seconds });
    else setNow(voice.mix.gain, v, context, { at });
    return true;
  };

  /**
   * The modulation-matrix contribution for one core, in cents. Task 7 writes it
   * once per block; it exists here as a parameter so the matrix travels the same
   * road as the panel controls instead of becoming a second pitch path.
   */
  voice.setCoreModulation = (i, cents, { at, ramp = true, seconds } = {}) => {
    if (!voice.cores) return 0;
    modCents[i] = Number.isFinite(cents) ? cents : 0;
    voice.cores[i].modCents = modCents[i];
    return voice.applyCore(i, { at, ramp, seconds });
  };

  /**
   * THE DOOR for the five keys task 4 owns. The store fan-out in osc-mod.js and
   * anything that wants to change a mechanism by hand both come through here, so
   * there is one place that can re-route a voice. A key this task does not own is
   * refused rather than quietly ignored.
   */
  voice.applyCoreModulation = (i, key, value, options = {}) => {
    if (!voice.cores || !voice.cores[i]) return false;
    const at = options.at;
    const ramp = options.ramp !== false;
    const seconds = options.seconds;
    switch (String(key).split('.').pop()) {
      case 'fmSource':
        voice.cores[i].fmSourceName = value;
        applyFm(i, { at, ramp, seconds });
        return true;
      case 'fmAmount':
        voice.cores[i].fmManual = clampFmAmount(value);
        applyFm(i, { at, ramp, seconds });
        return true;
      case 'unison':
        voice.cores[i].unisonManual = clampUnisonCount(value);
        applyUnison(i, { at, ramp, seconds, create: mayCreatePerNote() });
        return true;
      case 'unisonSpread':
        voice.cores[i].spreadManual = clampUnisonSpread(value);
        applyUnison(i, { at, ramp, seconds });
        return true;
      case 'ringMod':
        voice.cores[i].ringModName = value;
        applyRing(i, { at, ramp, seconds });
        return true;
      default:
        return false;
    }
  };

  /* ------------------------------------------------- the manual / matrix split --- */

  /**
   * The FM source for one core: 'none', or another core. A switch rather than a
   * continuous value, so it is re-routed immediately rather than ramped — but it
   * still goes through `applyCoreModulation`, so there is one door.
   */
  voice.setFmSource = (i, name, options = {}) => voice.applyCoreModulation(i, `osc${i + 1}.fmSource`, name, options) === true;

  /**
   * The manual FM amount for one core, 0..1. This is the panel's value, so it is
   * what a matrix route is ADDED to rather than what it replaces.
   */
  voice.setFmAmount = (i, value, options = {}) => {
    if (!voice.cores || !voice.cores[i]) return false;
    voice.cores[i].fmManual = clampFmAmount(value);
    applyFm(i, options);
    return true;
  };

  /**
   * Task 7's route into the FM amount, in the same 0..1 units as the control.
   * A route may be negative — that is how a matrix subtracts — but it is clipped
   * so the TOTAL stays inside the control's own range, and the contribution that
   * was actually applied is returned.
   */
  voice.setFmModulation = (i, route, options = {}) => {
    const core = voice.cores?.[i];
    if (!core) return 0;
    const wanted = Number.isFinite(Number(route)) ? Number(route) : 0;
    const applied = Math.min(Math.max(wanted, -core.fmManual), 1 - core.fmManual);
    core.fmRoute = applied;
    applyFm(i, options);
    return applied;
  };

  /**
   * The ring-modulator assignment for one core: 'none', or the core to pair with.
   * A routing decision rather than a value, so it takes effect at once — but it
   * still goes through `applyCoreModulation`, so there is one door.
   */
  voice.setRingMod = (i, name, options = {}) => voice.applyCoreModulation(i, `osc${i + 1}.ringMod`, name, options) === true;

  /** The manual unison spread for one core, in cents, clamped to 0..50. */
  voice.setUnisonSpread = (i, cents, options = {}) => {
    if (!voice.cores || !voice.cores[i]) return false;
    voice.cores[i].spreadManual = clampUnisonSpread(cents);
    applyUnison(i, { ...options, create: true });
    return true;
  };

  /** Task 7's route into the spread, in cents, clamped into the control's range. */
  voice.setUnisonSpreadModulation = (i, cents, options = {}) => {
    const core = voice.cores?.[i];
    if (!core) return 0;
    const wanted = Number.isFinite(Number(cents)) ? Number(cents) : 0;
    const applied = Math.min(Math.max(wanted, -core.spreadManual), SPREAD_MAX_CENTS - core.spreadManual);
    core.spreadRoute = applied;
    applyUnison(i, { ...options, create: mayCreatePerNote() });
    return applied;
  };

  /* ------------------------------------------ the filter bank and the envelopes --- */

  /** The two stages, or one of them. */
  voice.filter = (i) => {
    if (!voice.filters) throw new Error('voice.filter: the voice has no filters yet; start a note first');
    const stage = voice.filters[i];
    if (!stage) throw new Error(`voice.filter: no filter stage ${i}`);
    return stage;
  };

  /** The panel's values for both stages, read fresh from the store. */
  voice.filterReads = () => {
    if (!voice.filterControls) return [];
    voice.filterControls.forEach((_control, i) => Object.assign(voice.filterControls[i], filterControlRead(i)));
    return voice.filterControls.map((control, i) => ({ ...control, filter: i }));
  };

  /**
   * THE DOOR for the six `filter{n}.*` keys, exactly as `applyCoreModulation` is
   * the door for task 4's five. The store fan-out in filter.js calls this for
   * every built voice, so a control move reaches the whole pool through one
   * function, and a key this task does not own is refused rather than ignored.
   */
  voice.applyFilter = (i, key, value, options = {}) => {
    const control = voice.filterControls?.[i];
    if (!control) return false;
    const name = String(key).split('.').pop();
    if (!FILTER_KEYS.includes(name)) return false;
    if (name === 'bypass') control.bypass = Boolean(value);
    else if (name === 'type') control.type = FILTER_MODES.includes(value) ? value : control.type;
    else control[name] = value;
    applyFilterStage(i, {
      at: options.at,
      ramp: options.ramp !== false,
      seconds: options.seconds,
    });
    return true;
  };

  /** Bypass one stage: it leaves the chain entirely, it is not muted. */
  voice.setFilterBypass = (i, on, options = {}) => voice.applyFilter(i, `filter${i + 1}.bypass`, Boolean(on), options) === true;

  /**
   * Task 7's route into a cutoff, in CENTS — the same units as the pitch
   * destination, so the matrix has one unit for "how far to move a frequency"
   * and one clamp to call. It is ADDITIVE with the panel value and with key
   * tracking, and the total is clamped before it reaches a biquad.
   */
  voice.setCutoffModulation = (i, cents, options = {}) => {
    const control = voice.filterControls?.[i];
    if (!control) return 0;
    control.cutoffRoute = clampCutoffModulation(cents);
    applyFilterStage(i, { at: options.at, ramp: options.ramp !== false, seconds: options.seconds });
    return control.cutoffRoute;
  };

  /** What the matrix is currently contributing to one stage's cutoff. */
  voice.cutoffModulation = (i) => voice.filterControls?.[i]?.cutoffRoute ?? 0;

  /** The frequency one stage is actually running at, in hertz. */
  voice.filterCutoff = (i) => voice.filterControls?.[i]?.appliedHz ?? 0;

  /** Everything an inspection panel needs about one stage. */
  voice.filterState = (i) => {
    const stage = voice.filters?.[i];
    const control = voice.filterControls?.[i];
    if (!stage || !control) return null;
    return {
      ...stage.state(),
      keyTrack: control.keyTrack,
      panelHz: control.cutoff,
      routeCents: control.cutoffRoute,
      appliedHz: control.appliedHz,
    };
  };

  /* ---------------------------------------------------------- the envelopes --- */

  /** One `envAmp.*` or `envFilter.*` key. The second door, for the envelope store
   *  fan-out in env.js. A key this task does not own is refused. */
  voice.applyEnvelope = (prefix, name, value, options = {}) => {
    const envelope = prefix === 'envFilter' ? voice.filterEnv : prefix === 'envAmp' ? voice.ampEnv : null;
    if (!envelope) return false;
    if (name === 'peak') {
      envelope.setPeak(value, options);
      return true;
    }
    if (!['attack', 'decay', 'sustain', 'release'].includes(name)) return false;
    envelope.setTimes({ [name]: value }, options);
    return true;
  };

  /** Where an envelope is: 'idle' | 'attack' | 'decay' | 'sustain' | 'release'. */
  voice.envelopeStage = (which = 'amp') => (which === 'filter' ? voice.filterEnv : voice.ampEnv)?.stage() ?? 'idle';

  /** The live level of an envelope, 0..1. The filter envelope's is a matrix SOURCE. */
  voice.envelopeValue = (which = 'amp') => (which === 'filter' ? voice.filterEnv : voice.ampEnv)?.value() ?? 0;

  /** Shorthand the matrix and an inspection panel both want. */
  voice.ampEnvValue = () => voice.envelopeValue('amp');
  voice.filterEnvValue = () => voice.envelopeValue('filter');

  /**
   * Task 7's `ampLevel` destination: a bipolar bias ADDED to the amp envelope's
   * peak, so zero means "the panel value" and -1 means silence. It is a bias and
   * not a replacement for the same reason the wavesampler level is one: a matrix
   * route has to be able to add and subtract.
   */
  voice.setAmpLevelBias = (delta, options = {}) => {
    if (!voice.ampEnv) return 0;
    const wanted = Number.isFinite(Number(delta)) ? Number(delta) : 0;
    const bias = Math.min(Math.max(wanted, -1), 1);
    ampLevelBiasValue = bias;
    voice.ampEnv.setPeak(1 + bias, options);
    return bias;
  };

  voice.ampLevelBias = () => (voice.ampEnv ? ampLevelBiasValue : 0);

  /**
   * Task 7's destinations. Each point is a READ value the matrix can inspect, a
   * write whose contribution is clamped to the manual control's own range, and a
   * unit — so the matrix never has to know how a control is turned into audio.
   */
  voice.modulationPoints = () => [
    {
      destination: 'pitch',
      unit: 'cents',
      range: [-MATRIX_PITCH_LIMIT_CENTS, MATRIX_PITCH_LIMIT_CENTS],
      read: (i) => modCents[i] ?? 0,
      route: (i) => modCents[i] ?? 0,
      apply: (i, cents, options) => voice.setCoreModulation(i, clampPitchRoute(cents), options),
    },
    {
      destination: 'fmAmount',
      unit: 'ratio',
      range: [0, 1],
      read: (i) => fmStateOf(voice.cores?.[i]).amount,
      route: (i) => voice.cores?.[i]?.fmRoute ?? 0,
      apply: (i, route, options) => voice.setFmModulation(i, route, options),
    },
    {
      destination: 'unisonSpread',
      unit: 'cents',
      range: [0, SPREAD_MAX_CENTS],
      read: (i) => voice.unisonState(i).spreadCents,
      route: (i) => voice.cores?.[i]?.spreadRoute ?? 0,
      apply: (i, cents, options) => voice.setUnisonSpreadModulation(i, cents, options),
    },
    {
      destination: 'cutoff1',
      unit: 'cents',
      range: [-CUTOFF_MOD_CENTS, CUTOFF_MOD_CENTS],
      read: () => voice.filterCutoff(0),
      route: () => voice.cutoffModulation(0),
      apply: (_i, cents, options) => voice.setCutoffModulation(0, cents, options),
    },
    {
      destination: 'cutoff2',
      unit: 'cents',
      range: [-CUTOFF_MOD_CENTS, CUTOFF_MOD_CENTS],
      read: () => voice.filterCutoff(1),
      route: () => voice.cutoffModulation(1),
      apply: (_i, cents, options) => voice.setCutoffModulation(1, cents, options),
    },
    {
      destination: 'ampLevel',
      unit: 'bias',
      range: [-1, 1],
      read: () => (voice.vca ? voice.vca.gain.value : 0),
      route: () => voice.ampLevelBias(),
      apply: (_i, bias, options) => voice.setAmpLevelBias(bias, options),
    },
  ];

  /**
   * Task 7's SOURCES that this voice produces. The LFOs are task 7's own; these
   * are the per-voice ones the plan says enter the same matrix — the amp and
   * filter envelopes, velocity, key tracking and the per-note random.
   *
   * The filter envelope is here and only here: it has a shape, no amount, and no
   * destination of its own. Its depth is the matrix cell for filter 1 or
   * filter 2 cutoff.
   */
  voice.modulationSources = () => [
    { source: 'ampEnv', unit: 'level', range: [0, 1], read: () => voice.ampEnvValue() },
    { source: 'filterEnv', unit: 'level', range: [0, 1], read: () => voice.filterEnvValue() },
    { source: 'velocity', unit: 'level', range: [0, 1], read: () => voice.velocity },
    { source: 'random', unit: 'level', range: [0, 1], read: () => voice.random },
    {
      source: 'keyTrack',
      unit: 'ratio',
      range: [0, 2],
      read: () => (voice.filters?.[0] ? voice.filterCutoff(0) / (voice.filterState(0)?.panelHz || 1) : 1),
    },
  ];

  /* ------------------------------------------------------------- readouts --- */

  const fmStateOf = (core) => {
    if (!core) return { connected: false, sourceIndex: -1, modulatorNode: null, amount: 0, index: 0, deviationHz: 0, manual: 0, modulation: 0 };
    const state = core.fm.state();
    return {
      ...state,
      modulatorNode: state.modulator,
      manual: core.fmManual,
      modulation: core.fmRoute,
      amount: state.amount,
    };
  };

  const unisonStateOf = (core) => {
    const plan = core ? unisonPlan(core.index) : { count: 1, spread: 0 };
    const count = plan.count;
    const spread = plan.spread;
    return {
      index: core?.index ?? 0,
      count,
      copies: core ? core.copies.length : 0,
      connectedCopies: core ? core.copies.filter((copy) => copy.dest !== null).length : 0,
      spreadCents: spread,
      detuneCents: unisonDetuneCents(count, spread),
      centreCents: unisonCentreCents(count, spread),
      manual: core?.spreadManual ?? 0,
      modulation: core?.spreadRoute ?? 0,
      sumGain: core?.unisonSum ? core.unisonSum.gain.value : 1,
    };
  };

  const ringStateOf = (i) => {
    const core = voice.cores?.[i];
    const state = core ? core.ring.state() : { active: false, partner: -1 };
    return {
      index: i,
      active: state.active,
      partner: state.partner,
      busLevel: voice.ringBus ? voice.ringBus.gain.value : 0,
      /** Every live pair in the voice, for the runtime handle and task 13. */
      pairs: () =>
        (voice.cores ?? [])
          .map((entry, index) => ({ core: index, partner: entry.ring.state().partner }))
          .filter((pair) => pair.partner >= 0),
    };
  };

  voice.fmState = (i) => fmStateOf(voice.cores?.[i]);

  voice.unisonState = (i) => unisonStateOf(voice.cores?.[i]);

  voice.ringState = (i) => ringStateOf(i);

  /** The depth gain for one core, or null if FM has never been asked for. */
  voice.fmDepth = (i) => voice.cores?.[i]?.fm.node ?? null;

  voice.livePitch = (i = 0) => voice.cores?.[i]?.hz ?? 0;

  /**
   * The carrier's live pitch AND its frequency-modulation excursion. The base
   * Hz is a scheduled value and cannot move because a modulator moved — FM is
   * audio-rate — so the excursion is reported alongside it, and that is what
   * makes an FM source change measurable rather than merely audible.
   */
  voice.livePitchSpan = (i = 0) => {
    const core = voice.cores?.[i];
    const hz = core?.hz ?? 0;
    const fm = fmStateOf(core);
    return {
      index: i,
      hz,
      sourceIndex: fm.sourceIndex,
      modulatorHz: fm.sourceIndex >= 0 ? voice.cores?.[fm.sourceIndex]?.hz ?? 0 : 0,
      deviationHz: fm.deviationHz,
      minHz: hz - fm.deviationHz,
      maxHz: hz + fm.deviationHz,
      /** The deviation ratio, i.e. what the amount control is actually mapped to. */
      ratio: fm.index,
    };
  };

  voice.liveState = () => ({
    index: voice.index,
    state: voice.state,
    noteId: voice.noteId,
    note: voice.note,
    noteHz: voice.noteHz ?? 0,
    velocity: voice.velocity,
    random: voice.random,
    startedAt: voice.startedAt,
    releasedAt: voice.releasedAt,
    amplitude: voice.vca ? voice.vca.gain.value : 0,
    pitch: voice.cores ? voice.cores.map((core) => core.hz ?? 0) : [],
    levels: voice.cores ? voice.cores.map((core) => core.gain.gain.value) : [],
    soundingSources: sources.filter((entry) => !entry.stopping).length,
    /* Task 4's three mechanisms, live. */
    fm: voice.cores ? voice.cores.map((_core, i) => fmStateOf(voice.cores[i])) : [],
    pitchSpans: voice.cores ? voice.cores.map((_core, i) => voice.livePitchSpan(i)) : [],
        unison: voice.cores ? voice.cores.map((_core, i) => unisonStateOf(voice.cores[i])) : [],
    ring: voice.ringBus ? voice.ringBus.gain.value : 0,
    ringPairs: voice.cores ? voice.ringState(0).pairs() : [],
    /* Task 6: the filter bank and the two envelopes. `stage` is the AMP
     * ENVELOPE's stage now, not the voice's own lifecycle — `state` above is
     * still the lifecycle. */
    filters: voice.filters ? voice.filters.map((_stage, i) => voice.filterState(i)) : [],
    ampEnv: voice.ampEnv ? voice.ampEnv.state() : null,
    filterEnv: voice.filterEnv ? voice.filterEnv.state() : null,
    stage: voice.ampEnv ? voice.ampEnv.stage() : voice.state,
    filterStage: voice.filterEnv ? voice.filterEnv.stage() : 'idle',
  });

  /* The store fan-outs reach this voice through `applyFilter` / `applyEnvelope`.
   * The registrations are bounded by the pool and undone by nothing, because a
   * voice is never disposed of — the allocator keeps and re-uses them. */
  registerVoice(voice);
  registerFilterVoice(voice);
  registerEnvelopeVoice(voice);

  return voice;
}
