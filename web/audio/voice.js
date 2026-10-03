/**
 * voice.js — one voice of the instrument: three oscillator cores summed into one
 * chain behind one entry point.
 *
 * THE SHAPE (all of it created on the voice's first note, none of it rewritten
 * by a later task):
 *
 *   core1 ─┐  oscillator  ─> core1 gain ─┐
 *   core2 ─┤  oscillator  ─> core2 gain ─┼─> voice mix ─> VCA ─> ENTRY ─> parent
 *   core3 ─┤  oscillator  ─> core3 gain ─┘                                  (master)
 *   ring ──┤  (task 4: ring products)             ^
 *   wave ──┘  (task 5: wavesampler slot)  tasks 6 insert filters between
 *                                            mix and VCA
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
 * TEARDOWN — THE PLAN'S NAMED RISK
 *   `entry` is the only node that leaves the voice. `kill()` disconnects that one
 *   node from its parent and stops the per-note sources. Nothing walks the graph
 *   unwiring children, so an oscillator mis-routed by a later task cannot
 *   outlive its voice: the path out of the voice is severed at a single point.
 *   tests/voice.test.mjs asserts that no child is disconnected during teardown,
 *   and tests/{fm,ring,unison}.test.mjs re-assert it after a hundred re-routes.
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
 *     voice.livePitch(i) / livePitchSpan(i) / liveState()
 */

import { VOICE_STATE } from './allocator.js';
import { buildPeriodicWave, nativeWaveform } from './waveforms.js';
import { computeCoreFrequency, midiToHz } from './pitch.js';
import { createNoiseSource } from './noise.js';
import { createConstantSource, createGain, createOscillator, retireNode } from './nodes.js';
import { rampTo, setNow } from './automation.js';
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

/** How long a released voice fades before its sources are stopped. Without the
 *  amp envelope (task 6) this is a short click-free fade rather than a cut. */
export const RELEASE_FADE_SECONDS = 0.03;

/** A note-on fade-in, so a reused voice does not start with a step. */
const ATTACK_FADE_SECONDS = 0.005;

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
  };

  let modCents = [0, 0, 0];
  let sources = [];
  let attached = false;
  let ringBusTarget = 0;

  /* ------------------------------------------------------------ the build --- */

  function build() {
    // The entry point is the outermost node: the one disconnection that ends
    // this voice. Task 6 inserts the filters between mix and vca; entry does not
    // move, so the teardown path does not change.
    voice.entry = createGain(context, 'voice-entry');
    voice.vca = createGain(context, 'voice-vca');
    voice.mix = createGain(context, 'voice-mix');
    voice.vca.gain.value = 0; // silent until a note starts
    voice.mix.connect(voice.vca);
    voice.vca.connect(voice.entry);

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

    // The voice comes up over a few milliseconds rather than appearing at full
    // level. One call, not two: rampTo holds the current value first, so a
    // setValueAtTime written just before it would be cancelled by that hold.
    rampTo(voice.vca.gain, 1, context, { at: when, seconds: ATTACK_FADE_SECONDS });
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
    // Fade the amplifier, then stop the sources: a hard cut clicks.
    rampTo(voice.vca.gain, 0, context, { at: when, seconds: RELEASE_FADE_SECONDS });
    stopSources(when);
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
    /* `stage` is the voice's own lifecycle, not the amp envelope's stage. Task 6
     * replaces it with the real ADSR stage once it owns the amplifier. */
    stage: voice.state,
  });

  /* The store fan-out reaches this voice through `applyCoreModulation`. The
   * registration is bounded by the pool and undone by nothing, because a voice
   * is never disposed of — the allocator keeps and re-uses them. */
  registerVoice(voice);

  return voice;
}
