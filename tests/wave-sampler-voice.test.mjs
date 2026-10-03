/**
 * wave-sampler-voice.test.mjs — the wavesampler's half of a note, against the
 * recording stand-in in voice-fake-audio.mjs. No browser, no audio device.
 *
 * What is asserted is the wiring and the arithmetic that reaches the wire:
 *
 *   - one per-note oscillator, into the voice's wavesampler slot, nothing else;
 *   - its frequency comes from the voice's core-1 pitch source rather than a second
 *     frequency computation;
 *   - the wave handed to the oscillator is capped at that note's frequency and is
 *     rebuilt, not reused, when the scan position moves;
 *   - stopping it retires the node, so a long run does not accumulate sources;
 *   - the wavesampler's level is its own gain: silencing the three cores cannot touch
 *     it and silencing it cannot touch the cores.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createVoice } from '../web/audio/voice.js';
import { midiToHz, computeCoreFrequency } from '../web/audio/pitch.js';
import { nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { store } from '../web/ui/params.js';
import {
  startWaveVoice,
  stopWaveVoice,
  stopAllWaveVoices,
  waveVoices,
  buildWave,
  waveSampler,
  harmonicBudget,
  TABLE_HARMONICS,
  WAVE_TABLE_NAMES,
} from '../web/audio/wavesampler.js';
import { createFakeAudioContext, createFakeRead } from './voice-fake-audio.mjs';

const A4 = { id: 'n1', note: 69, velocity: 0.8, random: 0.5 };

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
  voice.start(A4, { at: 0 });
  return { context, parent, voice, read };
}

beforeEach(() => {
  resetNodeStats();
  stopAllWaveVoices({ at: 0 });
  store.set('wave.table', 'warmSaw', { source: 'test', apply: 'direct' });
  store.set('wave.scan', 0, { source: 'test', apply: 'direct' });
  store.set('wave.level', 0, { source: 'test', apply: 'direct' });
});

test('a note gets exactly one wavesampler oscillator, into the wavesampler slot', () => {
  const { context, voice } = harness();
  const before = nodeStats().byLabel['wavesampler-oscillator'] ?? { created: 0 };

  const handle = startWaveVoice({ voice, context, at: 0, frequency: midiToHz(A4.note), level: 0.7 });
  assert.ok(handle, 'the voice got a wavesampler source');

  const after = nodeStats().byLabel['wavesampler-oscillator'];
  assert.equal(after.created - before.created, 1, 'exactly one source per note');
  assert.equal(handle.node.startedAt, 0);
  assert.equal(handle.node.disconnects, 0);
  assert.ok(handle.node.connections.includes(voice.waveSlot), 'it sums into the wavesampler slot');
  assert.ok(!handle.node.connections.includes(voice.mix), 'and not into the mix directly');
  assert.ok(voice.waveSlot.connections.includes(voice.mix), 'the slot is what reaches the mix');

  // A voice has one wavesampler source at a time; a second note replaces the first.
  startWaveVoice({ voice, context, at: 1, frequency: 440, level: 0.7 });
  assert.equal(waveVoices().length, 1);
  assert.equal(nodeStats().byLabel['wavesampler-oscillator'].created - before.created, 2);
});

test('the wavesampler takes its pitch from core 1, not from a second computation', () => {
  const { context, voice } = harness();
  const handle = startWaveVoice({ voice, context, at: 0, frequency: voice.core(0).hz, level: 0.5 });

  // The oscillator starts silent on its own and is driven by the same pitch signal
  // that drives core 1's oscillator — one computation, one path.
  const startEvent = handle.node.frequency.events.find((e) => e.type === 'setValueAtTime');
  assert.equal(startEvent.value, 0, 'no frequency of its own at note-on');
  assert.ok(
    voice.core(0).pitchSource.connections.includes(handle.node.frequency),
    'core 1\'s pitch source drives the wavesampler',
  );
  // Its own frequency never leaves the voice's computation: no value was written to
  // the oscillator's frequency param other than the zero above.
  assert.equal(handle.node.frequency.events.length, 1);
});

test('the frequency it is capped for is the one pitch.js computed for this note', () => {
  // A note with its own octave, semitone and detune offsets, so "the same
  // computation" means computeCoreFrequency() and not midiToHz().
  const read = defaultRead({ 'osc1.octave': -1, 'osc1.semitone': 3, 'osc1.detune': 12 });
  const { context, voice } = harness(read);
  const throughPitchJs = computeCoreFrequency(
    { noteHz: midiToHz(A4.note), octave: -1, semitone: 3, cents: 12 },
    { sampleRate: context.sampleRate },
  );
  assert.equal(voice.core(0).hz, throughPitchJs, 'the voice resolved its own pitch first');

  const handle = startWaveVoice({ voice, context, at: 0, frequency: voice.core(0).hz, level: 0.5 });
  assert.equal(handle.hz, throughPitchJs, 'the wavesampler is capped for exactly that frequency');
  assert.equal(handle.node.frequency.value, 0, 'and its own frequency param was never written a value');
  // The table it got is the one built for that frequency, not for the raw note.
  const atNote = buildWave(context, voice ? waveSampler.table() : null, { frequency: midiToHz(A4.note) });
  assert.notEqual(handle.node.periodicWave, undefined);
  assert.equal(buildWave(context, waveSampler.table(), { frequency: throughPitchJs }).real.length, harmonicBudget(throughPitchJs, context.sampleRate) + 1);
  assert.ok(throughPitchJs < midiToHz(A4.note), 'the note really was detuned down, so the two would differ');
  assert.notEqual(atNote, undefined);
});

test('the wave it plays is capped for the frequency in use', () => {
  const { context, voice } = harness();
  const frequency = midiToHz(A4.note); // 440 Hz
  const handle = startWaveVoice({ voice, context, at: 0, frequency, level: 0.5 });
  const wave = handle.node.periodicWave;
  const sampleRate = context.sampleRate;

  assert.ok(wave, 'a PeriodicWave was set');
  assert.equal(wave.real.length, wave.imag.length);
  const budget = harmonicBudget(frequency, sampleRate);
  assert.equal(wave.real.length, budget + 1, `allocated to the harmonic budget (${budget})`);
  // Nothing above the true Nyquist for this frequency survives, and nothing above the
  // budget either, since the budget is the conservative block count.
  const ceiling = Math.floor((0.5 * sampleRate) / frequency);
  for (let n = budget + 1; n < wave.real.length; n += 1) assert.equal(wave.real[n], 0);
  assert.ok(budget <= ceiling, `${budget} never exceeds ${ceiling}`);
  // And the partials that DO survive are the ones the cap is about: harmonic 1 present,
  // harmonic ceiling+1 absent if it was allocated at all.
  assert.ok(Math.abs(wave.imag[1]) > 0, 'the fundamental is there');
  if (ceiling + 1 <= budget) assert.equal(wave.imag[ceiling + 1], 0);
  assert.ok(wave.real.length <= TABLE_HARMONICS + 1);
});

test('a high note is capped much harder than a low one, and never below the fundamental', () => {
  const context = createFakeAudioContext();
  const table = waveSampler.table();
  const low = buildWave(context, table, { frequency: midiToHz(21) });
  const high = buildWave(context, table, { frequency: midiToHz(96) });
  assert.ok(low.real.length > high.real.length, `low ${low.real.length} vs high ${high.real.length}`);
  assert.equal(high.real.length, harmonicBudget(midiToHz(96), 48000) + 1);
  assert.ok(high.real.length >= 2, 'a note near the top of the keyboard is still a wave, not silence');
});

test('the scan position builds a different wave, and the same scan builds it once', () => {
  const context = createFakeAudioContext();
  const table = waveSampler.table();
  const before = context.created.length;
  const atZero = buildWave(context, table, { frequency: 440, scan: 0 });
  const again = buildWave(context, table, { frequency: 440, scan: 0 });
  assert.equal(atZero, again, 'the second note with the same scan reuses the wave');

  const atOne = buildWave(context, table, { frequency: 440, scan: 1 });
  assert.notEqual(atZero, atOne, 'the far end of the scan is a different wave');
  let worst = 0;
  for (let n = 0; n < atZero.imag.length; n += 1) worst = Math.max(worst, Math.abs(atZero.imag[n] - atOne.imag[n]));
  assert.ok(worst > 0.05, `the two extremes really differ (largest coefficient change ${worst})`);
  assert.equal(context.created.length, before, 'building a wave creates no nodes');

  // The travel is a HALF cycle, so the far end is a half turn on, not a whole one.
  const clamped = buildWave(context, table, { frequency: 440, scan: 4 });
  assert.equal(clamped, atOne, 'past the end of the fader is the end of the fader');
});

test('stopping the source schedules one stop, and retiring it gives the node back', () => {
  const { context, voice } = harness();
  startWaveVoice({ voice, context, at: 0, frequency: 440, level: 0.5 });
  const live = nodeStats().byLabel['wavesampler-oscillator'];

  assert.equal(stopWaveVoice(0, { at: 0 }), true);
  assert.deepEqual(waveVoices().map((r) => r.stopping), [true], 'stopped, but still referenced until it ends');
  // A second stop must not throw: an OscillatorNode cannot be stopped twice.
  assert.equal(stopWaveVoice(0, { at: 0 }), true);
  context.advance(1);
  assert.equal(waveVoices().length, 0, 'the handle is released when the source ends');
  const retired = nodeStats().byLabel['wavesampler-oscillator'];
  assert.equal(retired.live, live.live - 1, 'the node came back');
  assert.equal(retired.retired, live.retired + 1);
});

test('the wavesampler level is its own gain, independent of the three cores', () => {
  const { context, voice, read } = harness();
  startWaveVoice({ voice, context, at: 0, frequency: 440, level: 0.9 });
  assert.equal(voice.waveSlot.gain.value, 0.9);

  // Silence every core: the wavesampler gain is untouched.
  read.set('osc1.level', 0);
  read.set('osc2.level', 0);
  read.set('osc3.level', 0);
  voice.setCoreLevel(0, 0, { ramp: false });
  voice.setCoreLevel(1, 0, { ramp: false });
  voice.setCoreLevel(2, 0, { ramp: false });
  assert.deepEqual(
    voice.coreReads().map((c) => c.level),
    [0, 0, 0],
    'the three cores are silent',
  );
  assert.deepEqual(
    voice.coreReads().map((_c, i) => voice.core(i).gain.gain.value),
    [0, 0, 0],
  );
  assert.equal(voice.waveSlot.gain.value, 0.9, 'and the wavesampler is still at full level');

  // Silence the wavesampler: the cores keep their levels.
  voice.waveSlot.gain.value = 0;
  read.set('osc1.level', 0.8);
  read.set('osc2.level', 0.5);
  read.set('osc3.level', 0.35);
  assert.deepEqual(voice.coreReads().map((c) => c.level), [0.8, 0.5, 0.35]);
  assert.equal(voice.waveSlot.gain.value, 0);
});

test('a note starts at the level the store says, so a fresh voice is not silent', () => {
  const { context, voice } = harness();
  startWaveVoice({ voice, context, at: 0, frequency: 440, level: 0.35 });
  const scheduled = voice.waveSlot.gain.events.filter((e) => e.type === 'setValueAtTime');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].value, 0.35);
});

test('a voice with no wavesampler slot is refused rather than half-wired', () => {
  const context = createFakeAudioContext();
  const bare = { index: 9 };
  assert.equal(startWaveVoice({ voice: bare, context, at: 0, frequency: 440, level: 1 }), null);
  assert.equal(startWaveVoice({ voice: { waveSlot: context.createGain() }, context: null, at: 0 }), null);
  assert.equal(waveVoices().filter((row) => row.voice === 9).length, 0);
});

test('every slot builds a wave, and the table reports which content each holds', () => {
  const context = createFakeAudioContext();
  for (const slot of WAVE_TABLE_NAMES) {
    const table = waveSampler.tables().find((row) => row.slot === slot);
    assert.equal(table.name, slot);
    assert.equal(table.kind, 'factory');
    const wave = buildWave(context, waveSampler.table(), { frequency: 220 });
    assert.ok(wave && wave.real.length > 1, `${slot} builds`);
  }
  stopAllWaveVoices({ at: 0 });
});