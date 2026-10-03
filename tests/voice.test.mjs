/**
 * The voice: three oscillator cores, one summing chain, one entry point, and a
 * teardown that cuts exactly one node.
 *
 * Two of the plan's named risks live here and neither is visible by eye:
 *   - an oscillator left connected somewhere keeps sounding forever, so teardown
 *     must disconnect ONE entry-point node and walk nothing;
 *   - an OscillatorNode cannot be restarted, so nodes are per note and retired on
 *     `onended` — which is why node counts must come back down.
 *
 * Framework-free: `node --test tests/voice.test.mjs`, against the recording
 * stand-in in voice-fake-audio.mjs. No audio device, no browser.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WAVEFORMS } from '../web/ui/params.js';
import { VOICE_STATE } from '../web/audio/allocator.js';
import { CORE_COUNT, createVoice } from '../web/audio/voice.js';
import { nativeWaveform } from '../web/audio/waveforms.js';
import { midiToHz } from '../web/audio/pitch.js';
import { nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { NOISE_SECONDS, noiseBuffer } from '../web/audio/noise.js';
import { createFakeAudioContext, createFakeRead } from './voice-fake-audio.mjs';

/** The store keys a voice reads, at the schema's init-patch values. */
function defaultRead(overrides = {}) {
  return createFakeRead({
    'osc1.waveform': 'sawtooth',
    'osc1.octave': 0,
    'osc1.semitone': 0,
    'osc1.detune': 0,
    'osc1.level': 0.8,
    'osc2.waveform': 'square',
    'osc2.octave': 0,
    'osc2.semitone': 0,
    'osc2.detune': 0,
    'osc2.level': 0.5,
    'osc3.waveform': 'sine',
    'osc3.octave': 0,
    'osc3.semitone': 0,
    'osc3.detune': 0,
    'osc3.level': 0.35,
    'mixer.level': 0.8,
    ...overrides,
  });
}

function harness(read = defaultRead()) {
  const context = createFakeAudioContext();
  const parent = context.createGain();
  const voice = createVoice({ context, parent, read, index: 0 });
  return { context, parent, read, voice };
}

const A4 = { id: 'n1', note: 69, velocity: 0.8, random: 0.5 };

beforeEach(() => {
  resetNodeStats();
});

test('a voice is three cores, one summing chain, one entry point', () => {
  const { voice, parent } = harness();

  assert.equal(voice.state, VOICE_STATE.IDLE);
  assert.equal(voice.entry, null, 'nothing is built before the first note');
  assert.equal(CORE_COUNT, 3);

  voice.start(A4, { at: 0 });
  assert.equal(voice.entry.kind, 'gain', 'the entry point is a gain node');
  assert.ok(voice.entry.connections.includes(parent), 'the entry point is what reaches the parent');
  assert.equal(voice.entry.disconnects, 0);

  // Every core sums into the voice mix, and the mix is the only thing before the
  // entry point — so one disconnection severs the whole subtree.
  for (let i = 0; i < CORE_COUNT; i += 1) {
    assert.ok(voice.core(i).gain.connections.includes(voice.mix), `core ${i} sums into the voice mix`);
    assert.ok(voice.mix.connections.includes(voice.vca));
  }
  assert.ok(voice.vca.connections.includes(voice.entry));
  assert.ok(voice.ringBus.connections.includes(voice.mix), 'the ring bus is a summing input, ready for task 4');
  assert.ok(voice.waveSlot.connections.includes(voice.mix), 'the wavesampler slot is a summing input, ready for task 5');
});

test('the ring-modulator bus and the wavesampler slot exist, silent, before tasks 4 and 5', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });
  assert.equal(voice.ringBus.gain.value, 0);
  assert.equal(voice.waveSlot.gain.value, 0);
  assert.deepEqual(voice.summingInputs(), ['core1', 'core2', 'core3', 'ringMod', 'waveSampler']);
});

test('the oscillator base frequency is zero and the core pitch source drives it', () => {
  const { voice, context } = harness();
  voice.start(A4, { at: 0 });

  const osc = voice.core(0).source;
  assert.equal(osc.frequency.value, 0, 'the oscillator itself plays nothing; the core pitch source supplies Hz');
  assert.ok(
    voice.core(0).pitchSource.connections.includes(osc.frequency),
    'the core pitch source is connected into the oscillator frequency',
  );
  assert.equal(osc.startedAt, 0);
  assert.ok(osc.connections.includes(voice.core(0).gain));
  assert.equal(context.currentTime, 0);
});

test('pitch resolves through the single computation: octave, semitone, cents', () => {
  const read = defaultRead();
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(voice.core(0).pitchSource.offset.value, 440);
  assert.equal(voice.livePitch(0), 440);
  assert.equal(voice.livePitch(2), 440, 'all three cores start on the keyboard note');

  // Each offset is checked on its own, from the unshifted note.
  read.set('osc1.octave', 2);
  voice.applyCore(0, { at: 0 });
  assert.equal(voice.livePitch(0), 1760);
  read.set('osc1.octave', -2);
  voice.applyCore(0, { at: 0 });
  assert.equal(voice.livePitch(0), 110);

  read.set('osc1.octave', 0);
  read.set('osc1.semitone', 12);
  voice.applyCore(0, { at: 0 });
  assert.equal(voice.livePitch(0), 880);
  read.set('osc1.semitone', -12);
  voice.applyCore(0, { at: 0 });
  assert.equal(voice.livePitch(0), 220);

  read.set('osc1.semitone', 0);
  read.set('osc1.detune', 50);
  voice.applyCore(0, { at: 0 });
  assert.ok(Math.abs(voice.livePitch(0) - 440 * 2 ** (50 / 1200)) < 1e-9);

  assert.equal(voice.livePitch(1), 440, 'the other cores are untouched');
});

test('the modulation-matrix contribution goes through the same computation', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  voice.setCoreModulation(0, 1200, { at: 0 });
  assert.equal(voice.livePitch(0), 880, 'a matrix route of +1 octave doubles the core');
  voice.setCoreModulation(0, -1200, { at: 0 });
  assert.equal(voice.livePitch(0), 220);
  voice.setCoreModulation(0, 0, { at: 0 });
  assert.equal(voice.livePitch(0), 440);
});

test('pitch is applied by scheduled automation, never by writing the value', () => {
  const { voice } = harness();
  voice.start(A4, { at: 5 });

  const offset = voice.core(0).pitchSource.offset;
  offset.events.length = 0;
  voice.applyCore(0, { at: 5, ramp: true });

  assert.ok(offset.events.length > 0, 'something was scheduled');
  for (const event of offset.events) {
    assert.ok(['linearRampToValueAtTime', 'setTargetAtTime', 'setValueAtTime', 'cancelAndHoldAtTime'].includes(event.type));
  }
  assert.ok(offset.events.some((event) => event.value === 440), 'the target frequency was scheduled');
  assert.ok(offset.events.some((event) => event.time >= 5), 'against the audio clock, not a wall clock');
});

test('each core level is its own AudioParam and reaches its own extremes', () => {
  const read = defaultRead();
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(voice.core(0).gain.gain.value, 0.8);
  assert.equal(voice.core(1).gain.gain.value, 0.5);
  assert.equal(voice.core(2).gain.gain.value, 0.35);

  read.set('osc1.level', 0);
  voice.setCoreLevel(0, 0, { at: 0 });
  assert.equal(voice.core(0).gain.gain.value, 0);
  read.set('osc1.level', 1);
  voice.setCoreLevel(0, 1, { at: 0 });
  assert.equal(voice.core(0).gain.gain.value, 1);

  assert.equal(voice.core(1).gain.gain.value, 0.5, 'one core at full level does not touch another');
});

test('the voice mix level is its own node, separate from the core levels', () => {
  const read = defaultRead();
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  assert.equal(voice.mix.gain.value, 0.8);
  voice.setMixLevel(0.25, { at: 0 });
  assert.equal(voice.mix.gain.value, 0.25);
  assert.equal(voice.core(0).gain.gain.value, 0.8);
});

test('all ten waveforms are selectable per core, and each builds the right source', () => {
  const read = defaultRead();
  const { voice } = harness(read);

  for (const name of WAVEFORMS) {
    read.set('osc1.waveform', name);
    voice.start({ ...A4, id: `note-${name}` }, { at: 0 });
    const source = voice.core(0).source;

    if (name === 'noise') {
      assert.equal(source.kind, 'bufferSource', `${name} is a looping buffer, not an oscillator`);
      assert.equal(source.loop, true);
      assert.ok(source.buffer, `${name} shares the one noise buffer`);
    } else if (nativeWaveform(name)) {
      assert.equal(source.kind, 'oscillator');
      assert.equal(source.type, nativeWaveform(name), `${name} uses the native type`);
      assert.equal(source.periodicWave, null);
    } else {
      assert.equal(source.kind, 'oscillator');
      assert.ok(source.periodicWave, `${name} is built as a PeriodicWave`);
      assert.ok(source.periodicWave.imag.length > 1 || source.periodicWave.real.some((v, i) => i > 0 && v !== 0));
    }
    voice.kill(0);
  }
});

test('a waveform change applies to the next note, not to a sounding one', () => {
  const read = defaultRead();
  const { voice } = harness(read);
  read.set('osc1.waveform', 'sine');
  voice.start(A4, { at: 0 });
  const first = voice.core(0).source;

  read.set('osc1.waveform', 'triangle');
  assert.equal(voice.core(0).source, first, 'the sounding oscillator is not disturbed');
  voice.kill(0);
  voice.start({ ...A4, id: 'n2' }, { at: 1 });
  assert.equal(voice.core(0).source.type, 'triangle');
});

test('per-core read values exist for FM, unison and ring modulation', () => {
  const read = defaultRead({ 'osc1.fmAmount': 0.4, 'osc1.fmSource': 'osc2', 'osc1.unison': 3, 'osc1.unisonSpread': 12, 'osc1.ringMod': 'osc2' });
  const { voice } = harness(read);
  voice.start(A4, { at: 0 });

  const core = voice.core(0).read;
  assert.equal(core.fmAmount, 0.4);
  assert.equal(core.fmSource, 'osc2');
  assert.equal(core.unison, 3);
  assert.equal(core.unisonSpread, 12);
  assert.equal(core.ringMod, 'osc2');
  assert.deepEqual(voice.coreReads(), [core, voice.core(1).read, voice.core(2).read]);
});

test('TEARDOWN disconnects exactly one node: the entry point', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });

  const sources = voice.cores.map((core) => core.source);
  const children = [
    voice.mix,
    voice.vca,
    voice.ringBus,
    voice.waveSlot,
    ...voice.cores.map((core) => core.gain),
    ...voice.cores.map((core) => core.pitchSource),
    ...sources,
  ];
  const entry = voice.entry;

  voice.kill(10);

  assert.equal(entry.disconnects, 1, 'the entry point is the one node cut');
  assert.equal(entry.disconnectAll, 1, 'and it is cut from its parent, which is the whole teardown');
  for (const node of children) {
    assert.equal(node.disconnects, 0, `${node.kind} must not be unwired individually`);
  }
  for (const source of sources) {
    assert.ok(source.stoppedAt !== null, 'sources are stopped so nothing can outlive the voice');
  }
  assert.equal(voice.state, VOICE_STATE.IDLE);
});

test('release fades the amplifier and stops the sources; the voice is reusable', () => {
  const { voice } = harness();
  voice.start(A4, { at: 0 });
  const first = voice.core(0).source;

  voice.release(1);

  assert.equal(voice.state, VOICE_STATE.RELEASED);
  assert.equal(voice.releasedAt, 1);
  assert.ok(voice.vca.gain.value < 1, 'the amplifier is faded, not cut to silence');
  assert.ok(first.stoppedAt > 1, 'the sources are stopped after the fade');

  voice.kill(2);
  voice.start({ ...A4, id: 'n2' }, { at: 3 });
  assert.equal(voice.state, VOICE_STATE.SOUNDING);
  assert.notEqual(voice.core(0).source, first, 'a new oscillator, never a recycled one');
});

test('a killed voice keeps its summing chain and re-attaches its entry point', () => {
  const { voice, parent } = harness();
  voice.start(A4, { at: 0 });
  const entry = voice.entry;

  voice.kill(1);
  assert.ok(!entry.connections.includes(parent));
  assert.equal(entry.disconnects, 1);

  voice.start({ ...A4, id: 'n2' }, { at: 2 });
  assert.equal(entry, voice.entry, 'the entry point is a stable node for the life of the voice');
  assert.ok(entry.connections.includes(parent), 'and is re-attached on the next note');
  assert.equal(entry.disconnects, 1, 're-attaching is not a second teardown');
});

test('NOISE BUFFER: one buffer, reused by every noise voice and every note', () => {
  const context = createFakeAudioContext();
  const read = defaultRead({ 'osc1.waveform': 'noise' });
  const buffers = new Set();

  for (let i = 0; i < 25; i += 1) {
    const voice = createVoice({ context, parent: context.createGain(), read, index: i });
    voice.start({ ...A4, id: `n${i}` }, { at: i });
    buffers.add(voice.core(0).source.buffer);
    voice.kill(i);
  }

  assert.equal(buffers.size, 1, 'twenty-five noise notes, one buffer');
  assert.equal(noiseBuffer(context).length, Math.floor(NOISE_SECONDS * context.sampleRate));
  assert.equal(context.createBufferCalls, 1, 'the buffer was built once, not once per note');
});

test('NODE COUNTS STAY FLAT: two hundred notes do not grow the graph', () => {
  const context = createFakeAudioContext();
  const read = defaultRead();
  const voices = Array.from({ length: 4 }, (_unused, index) =>
    createVoice({ context, parent: context.createGain(), read, index }),
  );

  for (let n = 0; n < 200; n += 1) {
    const at = context.currentTime;
    const voice = voices[n % voices.length];
    voice.kill(at);
    voice.start({ ...A4, id: `n${n}` }, { at });
    if (n > 8) voice.release(at); // a released voice must retire its sources too
    context.advance(0.2); // longer than the release fade, so every note can end
  }
  for (const voice of voices) voice.kill(context.currentTime);
  context.advance(1);

  const stats = nodeStats();
  assert.equal(stats.byLabel.oscillator.live, 0, 'every per-note oscillator was retired');
  assert.equal(stats.byLabel.bufferSource?.live ?? 0, 0);
  assert.equal(stats.byLabel.oscillator.created, 600, 'three fresh oscillators per note, never recycled');
  assert.equal(stats.byLabel.oscillator.retired, 600);
  assert.ok(
    (stats.byLabel['voice-entry']?.live ?? 0) <= 4,
    'the persistent nodes stay bounded: one entry point per voice, whatever the note count',
  );
  assert.ok((stats.byLabel['core-pitch']?.live ?? 0) <= 12);
});

test('the live node count plateaus instead of growing across a long run', () => {
  const context = createFakeAudioContext();
  const read = defaultRead();
  const voices = Array.from({ length: 16 }, (_unused, index) =>
    createVoice({ context, parent: context.createGain(), read, index }),
  );

  const samples = [];
  for (let n = 0; n < 200; n += 1) {
    const at = context.currentTime;
    const voice = voices[n % voices.length];
    voice.kill(at);
    voice.start({ ...A4, id: `n${n}` }, { at });
    context.advance(0.2);
    samples.push(nodeStats().byLabel.oscillator.live);
  }

  // Sixteen voices x three cores is the whole point: one live oscillator per core
  // per HELD note. Anything above that is accumulation.
  assert.equal(Math.max(...samples), 48, 'no more live oscillators than voices x cores');
  assert.ok(
    samples.slice(32).every((live) => live === 48),
    'and the count sits at that plateau for the rest of the run',
  );

  for (const voice of voices) voice.kill(context.currentTime);
  context.advance(1);
  assert.equal(nodeStats().byLabel.oscillator.live, 0, 'releasing everything returns it to zero');
});

test('the voice exposes its live state for the sequencer and the meter', () => {
  const { voice } = harness();
  voice.start({ ...A4, note: 57, velocity: 0.9 }, { at: 0 });

  const state = voice.liveState();
  assert.equal(state.note, 57);
  assert.equal(state.noteId, 'n1');
  assert.equal(state.velocity, 0.9);
  assert.equal(state.noteHz, midiToHz(57));
  assert.deepEqual(state.pitch, [220, 220, 220]);
  assert.deepEqual(state.levels, [0.8, 0.5, 0.35]);
  assert.equal(state.amplitude, 1, 'the voice is at full envelope until task 6 owns the amp stage');
  assert.equal(state.stage, 'sounding');
});