/**
 * wave-sampler.test.mjs — the wavesampler's arithmetic and its file path, in plain
 * node with no browser and no audio device.
 *
 * What is tested here is the part of the feature that is arithmetic rather than
 * wiring, because that is the part that cannot be checked by ear:
 *
 *   - the four factory coefficient sets, including that the literals in the module
 *     still equal the formula its comment documents (a comment that has drifted from
 *     the code is a lie the reader cannot detect);
 *   - the 2048-point contract, including for a user file shorter than the table;
 *   - that the resample really interpolates rather than stepping;
 *   - the Nyquist cap, at and above the threshold;
 *   - the scan phase rotation, including a whole turn being the identity;
 *   - both shapes of decodeAudioData failure, and the promise form succeeding.
 *
 * The audio graph side (a per-note oscillator into `voice.waveSlot`, the level
 * fan-out) needs a context, so it is asserted with the fake-AudioContext harness
 * in wave-sampler-voice.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAVE_TABLE_LENGTH,
  TABLE_HARMONICS,
  WAVE_TABLE_NAMES,
  FACTORY_TABLES,
  KERNEL_HALF_WIDTH,
  HARMONIC_QUANTUM,
  tableLabel,
  synthesiseCycle,
  resampleCycle,
  besselI0,
  kaiserWindow,
  KAISER_BETA,
  samplesToCoefficients,
  capHarmonics,
  rotateCoefficients,
  harmonicBudget,
  PITCH_HEADROOM_RATIO,
  buildTable,
  createWaveTable,
  decodeAudioBuffer,
  wavetableFromBuffer,
  loadWaveFile,
  waveSampler,
  WaveLoadError,
} from '../web/audio/wavesampler.js';
import { store } from '../web/ui/params.js';

const TAU = Math.PI * 2;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps ${eps})`);

/* --------------------------------------------------------- the 2048 contract --- */

test('every table is exactly 2048 points long, factory or user', () => {
  assert.equal(WAVE_TABLE_LENGTH, 2048);
  assert.equal(TABLE_HARMONICS, 1024);
  for (const name of WAVE_TABLE_NAMES) {
    const table = buildTable({ name });
    assert.equal(table.samples.length, WAVE_TABLE_LENGTH, `${name} samples`);
    assert.equal(table.coefficients.real.length, TABLE_HARMONICS + 1, `${name} real`);
    assert.equal(table.coefficients.imag.length, TABLE_HARMONICS + 1, `${name} imag`);
    assert.equal(table.length, WAVE_TABLE_LENGTH, `${name} length`);
  }
});

test('a short user cycle still lands on 2048 points', () => {
  // Four samples is not a table; it has to be stretched to the contract length.
  const short = new Float32Array([0, 0.5, 1, 0.5]);
  const out = resampleCycle(short);
  assert.equal(out.length, WAVE_TABLE_LENGTH);
  const table = createWaveTable({ name: 'user:short.wav', samples: short });
  assert.equal(table.samples.length, WAVE_TABLE_LENGTH);
  assert.equal(table.length, WAVE_TABLE_LENGTH);
});

/* ------------------------------------------------------ the factory spectra --- */

test('the documented factory coefficient formulas still produce the literals in the module', () => {
  // Warm Saw: a saw sine series 2/(n.pi) with a raised-cosine taper from n=9 to n=32.
  const warmTaper = (n) => (n <= 8 ? 1 : n >= 32 ? 0 : 0.5 * (1 + Math.cos((Math.PI * (n - 8)) / 24)));
  for (let n = 1; n <= 32; n += 1) close(FACTORY_TABLES.warmSaw.imag[n], (2 / (n * Math.PI)) * warmTaper(n), 5e-7);
  assert.equal(FACTORY_TABLES.warmSaw.imag.length, 33);
  assert.equal(FACTORY_TABLES.warmSaw.imag[32], 0, 'the taper reaches zero exactly at harmonic 32');

  // Soft Square: odd harmonics at 4/(n.pi), tapered from n=17 to zero at n=31.
  const squareTaper = (n) => (n <= 15 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (n - 15)) / 16)));
  for (let n = 1; n <= 31; n += 1) {
    const expected = n % 2 === 1 ? (4 / (n * Math.PI)) * squareTaper(n) : 0;
    close(FACTORY_TABLES.softSquare.imag[n], expected, 5e-7);
  }
  assert.equal(FACTORY_TABLES.softSquare.imag[2], 0, 'no even harmonics at all');

  // Glass: the struck-bell partial list, cosine only.
  const expectedGlass = {
    1: 0.5, 2: 0.22, 3: 0.3, 4: 0.5, 5: 0.34, 7: 0.26, 9: 0.2, 11: 0.17,
    13: 0.14, 17: 0.12, 19: 0.1, 23: 0.085, 29: 0.06, 31: 0.055, 37: 0.045,
  };
  for (const [n, a] of Object.entries(expectedGlass)) close(FACTORY_TABLES.glass.real[Number(n)], a, 5e-7);
  assert.equal(FACTORY_TABLES.glass.real.length, 38);
  assert.ok(FACTORY_TABLES.glass.real.some((v, n) => n > 20 && v > 0), 'a bright top cluster past harmonic 20');

  // Reed: the one small harmonic stack, shared with waveforms.js.
  for (const [n, a] of [[1, 1], [2, 0.55], [3, 0.34], [4, 0.2], [6, 0.11], [8, 0.06]]) {
    close(FACTORY_TABLES.reed.real[n], a, 5e-7);
  }
  assert.equal(FACTORY_TABLES.reed.real[5], 0, 'the odd fifth is absent, which is what makes it hollow');

  for (const name of WAVE_TABLE_NAMES) {
    assert.deepEqual(FACTORY_TABLES[name].real, FACTORY_TABLES[name].real.slice(), `${name} real is a copy`);
    assert.equal(FACTORY_TABLES[name].real[0], 0, `${name} has no DC term`);
  }
});

test('the four factory tables are different spectra, not four names for one wave', () => {
  const fingerprints = WAVE_TABLE_NAMES.map((name) => buildTable({ name }).samples.join(','));
  assert.equal(new Set(fingerprints).size, 4);
  const squared = WAVE_TABLE_NAMES.map((name) => {
    const { real, imag } = buildTable({ name }).coefficients;
    let total = 0;
    for (let n = 1; n < real.length; n += 1) total += real[n] ** 2 + imag[n] ** 2;
    return total;
  });
  assert.ok(new Set(squared.map((v) => v.toFixed(4))).size === 4, `four distinct energies: ${squared}`);
});

test('the four names are the four the schema declares, with painted labels', () => {
  assert.deepEqual(WAVE_TABLE_NAMES, ['warmSaw', 'softSquare', 'reed', 'glass']);
  assert.deepEqual(store.schema('wave.table').options, [...WAVE_TABLE_NAMES]);
  assert.equal(tableLabel('warmSaw'), 'Warm Saw');
  assert.equal(tableLabel('softSquare'), 'Soft Square');
  assert.equal(tableLabel('reed'), 'Reed');
  assert.equal(tableLabel('glass'), 'Glass');
  assert.equal(tableLabel('user:my tone.wav'), 'My Tone');
});

test('the synthesised 2048-point cycle of a pure sine has the amplitude it was given', () => {
  const cycle = synthesiseCycle({ real: new Float64Array(TABLE_HARMONICS + 1), imag: [0, 0.25] });
  assert.equal(cycle.length, WAVE_TABLE_LENGTH);
  let peak = 0;
  for (const v of cycle) peak = Math.max(peak, Math.abs(v));
  close(peak, 0.25, 1e-9);
  close(cycle[0], 0, 1e-9);
  close(cycle[WAVE_TABLE_LENGTH / 4], 0.25, 1e-9); // a quarter of a cycle is the peak
});

/* ------------------------------------------------------------- the resample --- */

test('the resample interpolates: a two-sample ramp comes back as intermediate values', () => {
  // A nearest-neighbour or sample-and-hold resample can only ever return 0 or 1
  // from this input, so any strictly-between value proves real interpolation.
  const out = resampleCycle(new Float32Array([0, 1]));
  assert.equal(out.length, WAVE_TABLE_LENGTH);
  const interior = out.slice(8, -8);
  assert.ok(interior.some((v) => v > 0.01 && v < 0.99), 'interpolated values exist');
  assert.ok(interior.every((v) => v >= -1e-9 && v <= 1 + 1e-9), 'no overshoot beyond the input range');
  // and it is smooth: no step larger than a hundredth of the range between neighbours
  let biggest = 0;
  for (let i = 1; i < out.length; i += 1) biggest = Math.max(biggest, Math.abs(out[i] - out[i - 1]));
  assert.ok(biggest < 0.01, `largest step ${biggest}`);
});

test('the resample is cyclic: a wrapped sine comes back as the same wave on a longer grid', () => {
  const input = new Float32Array(64);
  for (let k = 0; k < 64; k += 1) input[k] = Math.sin((TAU * k) / 64);
  const out = resampleCycle(input);
  assert.equal(out.length, WAVE_TABLE_LENGTH);
  // The output grid does not land on the input grid — it has to be the CONTINUOUS
  // signal that the 64 samples describe, which is the whole point of resampling.
  let worst = 0;
  for (let j = 0; j < WAVE_TABLE_LENGTH; j += 1) worst = Math.max(worst, Math.abs(out[j] - Math.sin((TAU * j) / WAVE_TABLE_LENGTH)));
  assert.ok(worst < 1e-3, `worst deviation from the continuous sine ${worst}`);
  // ... and it wraps, so the seam is no worse than anywhere else.
  close(out[0], 0, 1e-3);
  close(out[WAVE_TABLE_LENGTH - 1], Math.sin((TAU * (WAVE_TABLE_LENGTH - 1)) / WAVE_TABLE_LENGTH), 1e-3);
});

test('the resample band-limits: decimating a long cycle leaves no folded partials', () => {
  // 8192 samples of one cycle carrying the fundamental plus harmonic 2050. Decimated
  // to 2048 (a factor of 4), harmonic 2050 is above the output's Nyquist, so a
  // resampler that does not band-limit folds it down to harmonic 2050 - 2048 = 2,
  // where it is plainly audible. The linear decimation below is that reference.
  const source = new Float32Array(8192);
  for (let k = 0; k < 8192; k += 1) source[k] = 0.5 * Math.sin((TAU * k) / 8192) + 0.3 * Math.sin((TAU * 2050 * k) / 8192);

  const linearDecimation = new Float32Array(WAVE_TABLE_LENGTH);
  for (let j = 0; j < WAVE_TABLE_LENGTH; j += 1) linearDecimation[j] = source[j * 4];
  const naive = samplesToCoefficients(linearDecimation, { harmonics: 8 });
  assert.ok(Math.abs(naive.imag[2]) > 0.1, `the reference decimator really does fold it (harmonic 2 at ${naive.imag[2]})`);

  const good = samplesToCoefficients(resampleCycle(source), { harmonics: 8 });
  close(Math.abs(good.imag[1]), 0.5, 5e-3);
  assert.ok(Math.abs(good.imag[2]) < 5e-3, `no folded partial at harmonic 2 (got ${good.imag[2]})`);
});

test('the Kaiser window is built on a correct I0, because it divides the resample', () => {
  // Values from the series itself, to six figures.
  close(besselI0(0), 1, 1e-12);
  close(besselI0(1), 1.2660658, 1e-7);
  close(besselI0(2), 2.2795853, 1e-7);
  close(besselI0(5), 27.239872, 1e-6);
  close(besselI0(10), 2815.7166, 1e-4);
  close(besselI0(-4), besselI0(4), 1e-12);
  assert.ok(besselI0(9) > besselI0(8), 'I0 rises for positive x');

  close(kaiserWindow(0, KERNEL_HALF_WIDTH, KAISER_BETA), 1, 1e-12);
  close(kaiserWindow(KERNEL_HALF_WIDTH, KERNEL_HALF_WIDTH, KAISER_BETA), 0, 1e-12);
  close(kaiserWindow(KERNEL_HALF_WIDTH * 2, KERNEL_HALF_WIDTH, KAISER_BETA), 0, 1e-12);
  // Monotone from the centre outwards, and effectively zero before the edge.
  let previous = 1;
  for (let offset = 0; offset <= KERNEL_HALF_WIDTH; offset += 0.25) {
    const w = kaiserWindow(offset, KERNEL_HALF_WIDTH, KAISER_BETA);
    assert.ok(w <= previous + 1e-12, `window rose at offset ${offset}`);
    previous = w;
  }
  assert.ok(kaiserWindow(KERNEL_HALF_WIDTH * 0.95, KERNEL_HALF_WIDTH, KAISER_BETA) < 0.02, 'near zero at the edge');
});

test('the resample has a finite kernel wide enough to interpolate from few samples', () => {
  assert.ok(KERNEL_HALF_WIDTH >= 4, 'a two-tap kernel would be linear, not band-limited');
  const out = resampleCycle(new Float32Array(3).fill(0.5));
  assert.equal(out.length, WAVE_TABLE_LENGTH);
  for (const v of out) close(v, 0.5, 1e-6);
});

/* ------------------------------------------------ samples -> Fourier series --- */

test('samples become the Fourier coefficients of the wave they sample', () => {
  const samples = new Float32Array(WAVE_TABLE_LENGTH);
  for (let k = 0; k < samples.length; k += 1) {
    samples[k] = 0.4 * Math.sin((TAU * 3 * k) / samples.length) - 0.2 * Math.cos((TAU * 5 * k) / samples.length);
  }
  const { real, imag } = samplesToCoefficients(samples);
  assert.equal(real.length, TABLE_HARMONICS + 1);
  close(real[0], 0, 1e-9);
  close(imag[3], 0.4, 1e-9);
  close(real[5], -0.2, 1e-9);
  close(imag[5], 0, 1e-9);
  for (let n = 1; n <= 12; n += 1) {
    if (n === 3 || n === 5) continue;
    close(real[n], 0, 1e-9);
    close(imag[n], 0, 1e-9);
  }
});

test('the coefficients and the samples round-trip', () => {
  const table = buildTable({ name: 'glass' });
  const back = synthesiseCycle(table.coefficients);
  let worst = 0;
  for (let k = 0; k < WAVE_TABLE_LENGTH; k += 1) worst = Math.max(worst, Math.abs(back[k] - table.samples[k]));
  assert.ok(worst < 1e-9, `worst sample difference ${worst}`);
});

/* ------------------------------------------------------------ the Nyquist cap --- */

test('a coefficient is zeroed exactly when its harmonic index is past Nyquist', () => {
  const real = new Float64Array(TABLE_HARMONICS + 1).fill(0);
  const imag = new Float64Array(TABLE_HARMONICS + 1).fill(0);
  for (let n = 1; n <= 200; n += 1) imag[n] = 1 / n;
  const sampleRate = 48000;
  const frequency = 1000;
  const highest = Math.floor((0.5 * sampleRate) / frequency); // 24
  const capped = capHarmonics({ real, imag }, { frequency, sampleRate });
  assert.equal(capped.cappedAt, highest);
  for (let n = 1; n <= highest; n += 1) close(capped.imag[n], 1 / n, 1e-12);
  for (let n = highest + 1; n <= 200; n += 1) {
    assert.equal(capped.imag[n], 0, `harmonic ${n} must be zero`);
    assert.equal(capped.real[n], 0, `harmonic ${n} must be zero`);
  }
  assert.equal(capped.zeroed, TABLE_HARMONICS - highest, 'every coefficient above the cap is dropped');
  // the input is untouched: the cap produces a new series rather than editing one
  close(imag[200], 1 / 200, 1e-12);
});

test('the cap keeps the partial that lands exactly on Nyquist', () => {
  const imag = new Float64Array(101).fill(0);
  imag[24] = 0.5;
  imag[25] = 0.5;
  const capped = capHarmonics({ real: new Float64Array(101), imag }, { frequency: 1000, sampleRate: 48000 });
  close(capped.imag[24], 0.5, 1e-12);
  assert.equal(capped.imag[25], 0);
});

test('a frequency above Nyquist for the sample rate yields no harmonics at all, not a crash', () => {
  const imag = new Float64Array(65).fill(0);
  imag[1] = 1;
  const capped = capHarmonics({ real: new Float64Array(65), imag }, { frequency: 40000, sampleRate: 48000 });
  assert.equal(capped.cappedAt, 0);
  assert.equal(capped.imag[1], 0);
});

test('the harmonic budget is quantised downwards, so a block can never exceed the true cap', () => {
  assert.ok(HARMONIC_QUANTUM >= 4);
  for (const frequency of [55, 110, 220, 440, 880, 1318.5, 4400, 10465]) {
    for (const sampleRate of [44100, 48000]) {
      for (const ratio of [1, 2, 4]) {
        const budget = harmonicBudget(frequency, sampleRate, { ratio });
        const trueCeiling = Math.floor((0.5 * sampleRate) / (frequency * ratio));
        // One harmonic is always kept, even where the true ceiling is zero: a note past
        // Nyquist should be a sine, not an exception and not silence.
        assert.ok(budget <= Math.max(1, trueCeiling), `${budget} > ${trueCeiling} at ${frequency} Hz x${ratio}`);
        assert.ok(budget % HARMONIC_QUANTUM === 0 || budget === 1, `${budget} is not a whole number of blocks`);
      }
      // The default headroom is what a live pitch change relies on.
      const budget = harmonicBudget(frequency, sampleRate);
      assert.ok(budget * frequency * PITCH_HEADROOM_RATIO <= 0.5 * sampleRate, `${budget} harmonics at ${frequency} Hz x2`);
    }
  }
  assert.ok(harmonicBudget(8.1757989, 48000) <= TABLE_HARMONICS, 'the lowest note cannot ask for more than the table holds');
  assert.equal(harmonicBudget(20000, 48000), 1, 'a note past Nyquist still gets a fundamental rather than a crash');
});

/* --------------------------------------------------------------- the scan --- */

test('a whole turn of scan is the identity, and a half turn moves the phase', () => {
  const base = { real: [0, 0, 0.5], imag: [0, 0.25, 0] };
  const full = rotateCoefficients(base, 1);
  close(full.real[2], 0.5, 1e-12);
  close(full.imag[2], 0, 1e-12);

  // A phase of half a cycle rotates harmonic n by n * pi: the fundamental inverts,
  // the second harmonic comes back to where it started.
  const half = rotateCoefficients(base, 0.5);
  close(half.real[1], 0, 1e-12);
  close(half.imag[1], -0.25, 1e-12);
  close(half.real[2], 0.5, 1e-12);
  close(half.imag[2], 0, 1e-12);
});

test('scan rotates each harmonic by its own multiple of the phase', () => {
  const base = { real: new Float64Array(8), imag: new Float64Array(8) };
  base.real[3] = 0.6;
  base.imag[3] = 0.8;
  const turns = 0.25;
  const out = rotateCoefficients(base, turns);
  const angle = TAU * 3 * turns;
  close(out.real[3], 0.6 * Math.cos(angle) - 0.8 * Math.sin(angle), 1e-12);
  close(out.imag[3], 0.6 * Math.sin(angle) + 0.8 * Math.cos(angle), 1e-12);
  assert.ok(out !== base, 'a new series, so the table is never edited in place');
});

/* --------------------------------------------------------------- the files --- */

/** A stand-in for File.arrayBuffer(): the loader never sees anything else. */
const fakeFile = (name, bytes) => ({
  name,
  size: bytes.byteLength,
  type: '',
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

/** One second of a 261.63 Hz sine at 48 kHz, mono, 16-bit PCM. */
function makeWav({ channels = 1, frames = 48000, sampleRate = 48000, bits = 16, cycle = 0 } = {}) {
  const blockAlign = (channels * bits) / 8;
  const data = new Uint8Array(44 + frames * blockAlign);
  const view = new DataView(data.buffer);
  const tag = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * blockAlign, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  tag(36, 'data');
  view.setUint32(40, frames * blockAlign, true);
  for (let f = 0; f < frames; f += 1) {
    const value = cycle
      ? Math.sin((TAU * cycle * f) / frames)
      : Math.sin((TAU * 261.63 * f) / sampleRate);
    for (let c = 0; c < channels; c += 1) view.setInt16(44 + (f * channels + c) * 2, Math.round(value * 30000), true);
  }
  return data;
}

/** A decode stand-in with a channel of Float32 samples. */
function fakeContext({ mode = 'promise', decoded = null, bytes = 1, channels = 1 } = {}) {
  const calls = [];
  const context = {
    sampleRate: 48000,
    calls,
    createPeriodicWave: (real, imag, constraints) => ({ real: [...real], imag: [...imag], constraints }),
    decodeAudioData(input, onSuccess, onError) {
      calls.push({ mode, input });
      if (mode === 'throw') throw new TypeError('not audio');
      if (mode === 'callback') {
        if (decoded) onSuccess(bufferFor(decoded));
        else onError(new TypeError('Unable to decode audio data'));
        return undefined;
      }
      if (mode === 'both-error') {
        onError(new TypeError('Unable to decode audio data'));
        return Promise.reject(new TypeError('Unable to decode audio data'));
      }
      return decoded ? Promise.resolve(bufferFor(decoded)) : Promise.reject(new TypeError('Unable to decode audio data'));
    },
    createBuffer(channelsWanted, length, rate) {
      const channelsData = [];
      for (let c = 0; c < channelsWanted; c += 1) {
        const data = new Float32Array(length);
        // A decode stand-in that returns silence would be indistinguishable from a
        // file with nothing in it, which the loader quite correctly refuses.
        for (let i = 0; i < length; i += 1) data[i] = 0.6 * Math.sin((TAU * 3 * i) / length);
        channelsData.push(data);
      }
      return {
        numberOfChannels: channelsWanted,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (c) => channelsData[c],
      };
    },
  };
  function bufferFor(spec) {
    return context.createBuffer(spec.channels ?? channels, spec.length ?? bytes, spec.sampleRate ?? 48000);
  }
  return context;
}

function bufferOf(channelData, { sampleRate = 48000 } = {}) {
  return {
    numberOfChannels: channelData.length,
    length: channelData[0].length,
    sampleRate,
    duration: channelData[0].length / sampleRate,
    getChannelData: (c) => channelData[c],
  };
}

test('a decode failure is caught whether it arrives as a rejection or as the deprecated callback', async () => {
  for (const mode of ['promise', 'callback', 'both-error', 'throw']) {
    const context = fakeContext({ mode });
    await assert.rejects(
      () => decodeAudioBuffer(context, new ArrayBuffer(8)),
      (error) => {
        assert.ok(error instanceof WaveLoadError, `${mode}: expected a WaveLoadError`);
        assert.match(error.message, /decode/i);
        return true;
      },
      `${mode} must reject`,
    );
  }
});

test('a decode that succeeds by callback resolves, and by promise resolves', async () => {
  for (const mode of ['promise', 'callback']) {
    const context = fakeContext({ mode, decoded: { channels: 1, length: 512 } });
    const buffer = await decodeAudioBuffer(context, new ArrayBuffer(8));
    assert.equal(buffer.length, 512, `${mode} decoded`);
  }
});

test('a good mono file becomes a 2048-point table with the file name as its label', async () => {
  const table = await wavetableFromBuffer(fakeFile('my-tone.wav', makeWav()), { context: fakeContext({ decoded: { channels: 1, length: 4096 } }) });
  assert.equal(table.length, WAVE_TABLE_LENGTH);
  assert.equal(table.name, 'user:my-tone');
  assert.equal(table.label, 'My Tone');
  assert.equal(table.kind, 'user');
  assert.equal(table.sourceName, 'my-tone.wav');
  assert.ok(table.samples.some((v) => Math.abs(v) > 0.1), 'there is signal in it');
});

test('stereo takes channel 0 and says so', async () => {
  const context = fakeContext();
  const left = new Float32Array(1024);
  for (let i = 0; i < left.length; i += 1) left[i] = Math.sin((TAU * i) / 128);
  const right = new Float32Array(1024).fill(1); // a channel that would be obvious if it were used
  context.decodeAudioData = () => Promise.resolve(bufferOf([left, right]));
  const table = await wavetableFromBuffer(fakeFile('wide.wav', makeWav({ channels: 2, frames: 100 })), { context });
  assert.equal(table.channels, 2);
  assert.equal(table.channelUsed, 0);
  // Channel 0 is the sine (peak 1); channel 1 is a constant 1, which would be obvious.
  let peak = 0;
  for (const v of table.samples) peak = Math.max(peak, Math.abs(v));
  close(peak, 1, 5e-3);
  assert.ok(!table.samples.every((v) => v > 0.9), 'channel 1 is ignored');
  assert.ok(table.notes.some((n) => /channel 0/.test(n)), `channel 0 is documented in the table: ${table.notes}`);
});

test('an empty or one-sample decode is refused with a reason, not with a crash', async () => {
  for (const length of [0, 1]) {
    const context = fakeContext({ decoded: { channels: 1, length } });
    await assert.rejects(
      () => wavetableFromBuffer(fakeFile('tiny.wav', new Uint8Array(64)), { context }),
      (error) => {
        assert.ok(error instanceof WaveLoadError);
        assert.match(error.message, /at least 2 samples/);
        return true;
      },
      `length ${length} must be refused`,
    );
  }
});

test('a DC-only file is refused, because a flat cycle is silence not a wave', async () => {
  const context = fakeContext();
  context.decodeAudioData = () => Promise.resolve(bufferOf([new Float32Array(2048).fill(0.42)]));
  await assert.rejects(() => wavetableFromBuffer(fakeFile('dc.wav', makeWav()), { context }), /flat cycle is not a wave/);
});

test('a failing file leaves the previously selected table selected and records the reason', async () => {
  waveSampler.clearErrors();
  const before = waveSampler.tableName();
  const good = await loadWaveFile(fakeFile('good.wav', makeWav()), { context: fakeContext({ decoded: { channels: 1, length: 2048 } }) });
  assert.equal(waveSampler.tableName(), 'user:good');

  for (const [bytes, label] of [[new Uint8Array(0), 'empty'], [new TextEncoder().encode('this is not audio at all'), 'text']]) {
    await assert.rejects(() => loadWaveFile(fakeFile(`${label}.bin`, bytes), { context: fakeContext({ decoded: null }) }));
    assert.equal(waveSampler.tableName(), 'user:good', `after a ${label} file the table is unchanged`);
    assert.equal(good.name, 'user:good');
  }
  const errors = waveSampler.errors();
  assert.ok(errors.length >= 2, 'both failures were captured');
  assert.ok(errors.every((e) => typeof e.reason === 'string' && e.reason.length > 0), 'each has a reason');
  assert.ok(errors.every((e) => e.name), 'each names the file');
  waveSampler.clearErrors();
  await loadWaveFile(fakeFile('warm.wav', makeWav()), { context: fakeContext({ decoded: { channels: 1, length: 2048 } }) });
  waveSampler.restoreFactory();
  assert.equal(waveSampler.tableName(), before, 'the factory table can be put back');
  assert.equal(waveSampler.errors().length, 0);
});

test('an unreadable file object is a load failure, not an unhandled rejection', async () => {
  await assert.rejects(
    () => loadWaveFile({ name: 'ghost.wav', size: 10, arrayBuffer: async () => { throw new Error('gone'); } }, { context: fakeContext() }),
    WaveLoadError,
  );
  assert.ok(waveSampler.errors().some((e) => /gone/.test(e.reason)));
  waveSampler.clearErrors();
});

/* ----------------------------------------------------- the preset hand-off --- */

test('a loaded table serialises to its 2048 samples and comes back from them', async () => {
  const context = fakeContext({ decoded: { channels: 1, length: 1024 } });
  await loadWaveFile(fakeFile('preset-ready.wav', makeWav()), { context });
  const json = JSON.stringify(waveSampler.serialize());
  const document_ = JSON.parse(json);
  assert.equal(document_.name, 'user:preset-ready');
  assert.equal(document_.sourceName, 'preset-ready.wav');
  assert.equal(document_.slot, store.get('wave.table'));
  assert.equal(document_.length, WAVE_TABLE_LENGTH);
  assert.equal(document_.samples.length, WAVE_TABLE_LENGTH);
  assert.ok(json.length < 60000, `serialised size ${json.length} bytes is inside a localStorage quota`);
  assert.ok(document_.samples.every((v) => typeof v === 'number' && Number.isFinite(v)));

  waveSampler.restoreFactory();
  assert.equal(waveSampler.tableName(), store.get('wave.table'));
  waveSampler.restore(document_);
  assert.equal(waveSampler.tableName(), 'user:preset-ready');
  assert.equal(waveSampler.table().kind, 'user');
  assert.equal(waveSampler.table().samples.length, WAVE_TABLE_LENGTH);
});

test('the factory tables have no factory data to serialise, only the sample table', () => {
  waveSampler.restoreFactory();
  const document_ = waveSampler.serialize('warmSaw');
  assert.equal(document_.name, 'warmSaw');
  assert.equal(document_.kind, 'factory');
  assert.equal(document_.samples.length, WAVE_TABLE_LENGTH);
  assert.equal(waveSampler.serialize('nope'), null);
});