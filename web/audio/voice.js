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
 *   ring ──┤  (task 4 fills this)                     ^
 *   wave ──┘  (task 5 fills this)            tasks 6 insert filters between
 *                                             mix and VCA
 *
 *   Every core also owns a `ConstantSourceNode` whose `offset` is that core's
 *   ABSOLUTE FREQUENCY IN HZ, connected into each of its oscillators'
 *   `frequency` param. That is the whole pitch story: the panel controls, the
 *   keyboard note and the modulation matrix all move one AudioParam, and every
 *   oscillator following it needs no per-node bookkeeping. It is also the single
 *   modulation point task 7 sums into, and the value tasks 10 and 13 read back
 *   as a voice's live pitch.
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
 * TEARDOWN — THE PLAN'S NAMED RISK
 *   `entry` is the only node that leaves the voice. `kill()` disconnects that one
 *   node from its parent and stops the per-note sources. Nothing walks the graph
 *   unwiring children, so an oscillator mis-routed by a later task cannot
 *   outlive its voice: the path out of the voice is severed at a single point.
 *   tests/voice.test.mjs asserts that no child is disconnected during teardown.
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
 *     voice.core(i)                  { gain, pitchSource, source, read }
 *     voice.coreReads()              the FM / unison / ring values for task 4
 *     voice.applyCore(i, opts)       re-resolve pitch through pitch.js
 *     voice.setCoreLevel(i, v, opts) / voice.setMixLevel(v, opts)
 *     voice.setCoreModulation(i, cents, opts)   the matrix contribution
 *     voice.summingInputs()          what a later task fills
 *     voice.liveState() / voice.livePitch(i)    readouts for tasks 10 and 13
 */

import { VOICE_STATE } from './allocator.js';
import { buildPeriodicWave, nativeWaveform } from './waveforms.js';
import { computeCoreFrequency, midiToHz } from './pitch.js';
import { createNoiseSource } from './noise.js';
import { createConstantSource, createGain, createOscillator, retireNode } from './nodes.js';
import { rampTo, setNow } from './automation.js';

export const CORE_COUNT = 3;

/** How long a released voice fades before its sources are stopped. Without the
 *  amp envelope (task 6) this is a short click-free fade rather than a cut. */
export const RELEASE_FADE_SECONDS = 0.03;

/** A note-on fade-in, so a reused voice does not start with a step. */
const ATTACK_FADE_SECONDS = 0.005;

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
      const pitchSource = createConstantSource(context, 'core-pitch');
      pitchSource.start(context.currentTime);
      voice.cores.push({ gain, pitchSource, source: null, read: coreRead(i), modCents: 0 });
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

  function startCore(i, at) {
    const core = voice.cores[i];
    const waveform = read(`osc${i + 1}.waveform`);

    let source;
    if (waveform === 'noise') {
      source = createNoiseSource(context);
    } else {
      source = createOscillator(context);
      const native = nativeWaveform(waveform);
      if (native) source.type = native;
      else source.setPeriodicWave(buildPeriodicWave(waveform, context));
      // Silent on its own: the core's pitch source supplies the frequency.
      setNow(source.frequency, 0, context, { at });
      core.pitchSource.connect(source.frequency);
    }

    source.connect(core.gain);
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
      sources = sources.filter((entry) => entry.node !== source);
    };

    core.source = source;
    sources.push({ node: source, core: i, stopping: false });
    voice.applyCore(i, { at, ramp: false });
    setNow(core.gain.gain, read(`osc${i + 1}.level`), context, { at });
  }

  /**
   * Schedule `stop()` on every source that is still running. A source already
   * given a stop time is left alone: calling stop() twice throws in the browser,
   * and a source that is fading out does not need stopping again.
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

    voice.state = VOICE_STATE.SOUNDING;
    voice.noteId = note.id ?? null;
    voice.note = note.note;
    voice.velocity = note.velocity ?? 1;
    voice.random = Number.isFinite(note.random) ? note.random : 0;
    voice.startedAt = when;
    voice.releasedAt = null;
    voice.noteHz = midiToHz(voice.note);

    modCents = [0, 0, 0];
    for (const core of voice.cores) core.modCents = 0;

    // The voice comes up over a few milliseconds rather than appearing at full
    // level. One call, not two: rampTo holds the current value first, so a
    // setValueAtTime written just before it would be cancelled by that hold.
    rampTo(voice.vca.gain, 1, context, { at: when, seconds: ATTACK_FADE_SECONDS });
    setNow(voice.mix.gain, read('mixer.level'), context, { at: when });

    for (let i = 0; i < CORE_COUNT; i += 1) startCore(i, when);
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
    if (voice.cores) for (const core of voice.cores) core.source = null;
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
    return hz;
  };

  voice.setCoreLevel = (i, value, { at, ramp = true, seconds } = {}) => {
    if (!voice.cores) return false;
    const core = voice.cores[i];
    if (!core) return false;
    const v = Math.max(0, Number(value) || 0);
    if (ramp) rampTo(core.gain.gain, v, context, { at, seconds });
    else setNow(core.gain.gain, v, context, { at });
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

  /* ------------------------------------------------------------- readouts --- */

  voice.livePitch = (i = 0) => voice.cores?.[i]?.hz ?? 0;

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
    /* `stage` is the voice's own lifecycle, not the amp envelope's stage. Task 6
     * replaces it with the real ADSR stage once it owns the amplifier. */
    stage: voice.state,
  });

  return voice;
}