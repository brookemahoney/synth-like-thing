/**
 * effects.test.mjs — the master chain's structure and its safety limits, driven
 * through the fake AudioContext in tests/effects-fake-audio.mjs.
 *
 * These are the parts of this task that are genuinely algorithmic rather than
 * plumbing: the feedback-loop stability ceiling, the impulse-response rebuild
 * policy, the equal-power mix crossfade and its bypass, the tempo-synced delay
 * time, and where master volume sits relative to the limiter. Each is asserted
 * from the graph and the scheduled automation, not from a description.
 *
 * Every effect control is also asserted to reach its AudioParam as a SCHEDULED
 * RAMP: a bare assignment at gesture time is audible as zipper noise, and the
 * fake AudioParam records every scheduled event so a regression is visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeEffectsContext } from './effects-fake-audio.mjs';
import { createStore, SCHEMA } from '../web/ui/params.js';
import { createRampBridge } from '../web/audio/ramp.js';
import {
  ANALYSER_FFT_SIZE,
  SAFETY_CLIP_CEILING,
  SAFETY_CLIP_KNEE,
  buildSafetyClipCurve,
  DELAY_FEEDBACK_MAX,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  DELAY_TONE_MAX,
  DELAY_TONE_MIN,
  EQ_BANDS,
  EQ_GAIN_DB,
  LIMITER,
  REVERB_DAMPING_MAX,
  REVERB_PREDELAY_MAX,
  createMasterChain,
} from '../web/audio/chain.js';

/** A deferred callback queue the test runs by hand, so nothing depends on timers. */
function manualScheduler() {
  const queued = new Map();
  let nextId = 1;
  return {
    defer(fn, ms) {
      const id = nextId;
      nextId += 1;
      queued.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      queued.delete(id);
    },
    run() {
      const pending = [...queued.values()];
      queued.clear();
      for (const entry of pending) entry.fn();
      return pending.length;
    },
    get size() {
      return queued.size;
    },
  };
}

function build(options = {}) {
  const scheduler = manualScheduler();
  const parameterStore = options.store ?? createStore(SCHEMA);
  const bridge = options.bridge ?? createRampBridge(parameterStore, {});
  const context = options.context ?? createFakeEffectsContext({ sampleRate: 48000 });
  const chain = createMasterChain(context, {
    store: parameterStore,
    bridge,
    scheduler,
    ...options.chainOptions,
  });
  return { chain, store: parameterStore, bridge, context, scheduler };
}

/** The whole chain, as label -> the labels it connects to. Nothing else, or less. */
function adjacency(chain) {
  const nodes = new Map();
  const collect = (node) => {
    if (!node || nodes.has(node.effectsLabel)) return;
    nodes.set(node.effectsLabel, node);
    for (const next of node.connections) collect(next);
  };
  collect(chain.input);
  const out = {};
  for (const [label, node] of nodes) out[label] = node.connections.map((next) => next.effectsLabel).sort();
  return out;
}

/** The value-carrying automation scheduled on a param since a mark. */
function scheduledSince(param, mark) {
  return param.events
    .slice(mark)
    .filter((event) => Number.isFinite(event.value))
    .map((event) => ({ type: event.type, value: event.value }));
}

/* --------------------------------------------------------------- the order --- */

test('the chain is EQ, delay, reverb, master volume, limiter, analyser, out', () => {
  const { chain, store } = build();
  // Both mixes up, so the wet branches are in the graph and can be compared.
  store.set('delay.mix', 0.4);
  store.set('reverb.mix', 0.4);

  // The complete graph, asserted edge for edge: the spec's order, plus the two
  // side branches (the dry crossfades and the feedback loop) and nothing else.
  assert.deepEqual(adjacency(chain), {
    input: ['eq.low'],
    'eq.low': ['eq.mid'],
    'eq.mid': ['eq.high'],
    'eq.high': ['delay.dry', 'delay.line'],
    'delay.dry': ['delay.out'],
    'delay.line': ['delay.tone', 'delay.wet'],
    'delay.tone': ['delay.feedback'],
    'delay.feedback': ['delay.line'],
    'delay.wet': ['delay.out'],
    'delay.out': ['reverb.dry', 'reverb.send'],
    'reverb.dry': ['reverb.out'],
    'reverb.send': ['reverb.preDelay'],
    'reverb.preDelay': ['reverb.damping'],
    'reverb.damping': ['convolver'],
    convolver: ['reverb.wet'],
    'reverb.wet': ['reverb.out'],
    'reverb.out': ['masterVolume'],
    masterVolume: ['limiter'],
    limiter: ['safetyClip'],
    safetyClip: ['analyser'],
    analyser: [],
  });
});

test('the signal path reaches the analyser in the order the plan states', () => {
  const { chain, store } = build();
  store.set('delay.mix', 0.4);
  store.set('reverb.mix', 0.4);
  // Walk the path a single note takes, from the summing input to the last node:
  // EQ, delay (wet tap), reverb (wet branch), master volume, limiter, analyser.
  const path = [
    chain.input,
    chain.eq.low,
    chain.eq.mid,
    chain.eq.high,
    chain.delay.line,
    chain.delay.wet,
    chain.delay.out,
    chain.reverb.send,
    chain.reverb.preDelay,
    chain.reverb.damping,
    chain.reverb.convolver,
    chain.reverb.wet,
    chain.reverb.out,
    chain.masterVolume,
    chain.limiter,
    chain.safetyClip,
    chain.analyser,
  ];
  for (let i = 1; i < path.length; i += 1) {
    assert.ok(
      path[i - 1].connections.includes(path[i]),
      `${path[i - 1].effectsLabel} should feed ${path[i].effectsLabel}`,
    );
  }
});

test('the delay is upstream of the reverb, so delay taps receive the wash', () => {
  const { chain, store } = build();
  store.set('reverb.mix', 0.4);
  assert.ok(
    chain.delay.out.connections.includes(chain.reverb.send),
    'the delay output must feed the reverb send',
  );
  assert.ok(!chain.reverb.send.connections.includes(chain.output), 'the reverb must not feed the EQ');
  // The chain output is the analyser: the last node before the context destination.
  assert.equal(chain.output, chain.analyser);
});

test('master volume sits immediately before the limiter, and the analyser after it', () => {
  const { chain } = build();
  assert.ok(chain.masterVolume.connections.includes(chain.limiter));
  assert.ok(chain.safetyClip.connections.includes(chain.analyser));
  assert.ok(!chain.limiter.connections.includes(chain.masterVolume));
});

test('the feedback loop is closed back onto the delay line itself', () => {
  const { chain } = build();
  assert.ok(chain.delay.line.connections.includes(chain.delay.tone));
  assert.ok(chain.delay.tone.connections.includes(chain.delay.feedback));
  assert.ok(chain.delay.feedback.connections.includes(chain.delay.line));
  // Tone is a lowpass in the feedback path, and nothing else is in the loop.
  assert.equal(chain.delay.tone.type, 'lowpass');
  assert.ok(chain.delay.feedback.connections.length === 1, 'no other gain belongs inside the loop');
});

/* ------------------------------------------------------------------- the EQ --- */

test('the EQ is exactly three bands, at the frequencies the plan names', () => {
  const { chain } = build();
  assert.equal(EQ_BANDS.length, 3);
  assert.deepEqual(
    EQ_BANDS.map((band) => [band.key, band.type, band.frequency]),
    [
      ['eq.low', 'lowshelf', 200],
      ['eq.mid', 'peaking', 800],
      ['eq.high', 'highshelf', 3000],
    ],
  );
  for (const band of EQ_BANDS) {
    const node = chain.eq[band.name];
    assert.equal(node.type, band.type);
    assert.equal(node.frequency.value, band.frequency);
  }
  assert.equal(chain.eq.mid.Q.value, 0.7, 'the mid band is Q 0.7');
  assert.equal(EQ_GAIN_DB, 18);
});

test('each EQ band takes its own store key, -18 dB to +18 dB, as a ramp', () => {
  const { chain, store } = build();
  for (const band of EQ_BANDS) {
    const node = chain.eq[band.name];
    for (const dB of [-18, 0, 18]) {
      const mark = node.gain.events.length;
      const stored = store.set(band.key, dB);
      assert.equal(stored, dB);
      const events = scheduledSince(node.gain, mark);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'linearRampToValueAtTime', 'a knob drag must ramp, not step');
      assert.equal(events[0].value, dB);
    }
  }
});

test('the EQ gain range is owned by the store, which is the only thing that clamps it', () => {
  const { chain, store } = build();
  assert.equal(store.schema('eq.low').min, -EQ_GAIN_DB);
  assert.equal(store.schema('eq.low').max, EQ_GAIN_DB);
  store.set('eq.low', 99);
  assert.equal(chain.eq.low.gain.value, 18, 'a knob cannot ask for more than the schema allows');
  store.set('eq.mid', -99);
  assert.equal(chain.eq.mid.gain.value, -18);
});

/* -------------------------------------------------------- the feedback cap --- */

test('the delay feedback ceiling is 95%, and the parameter is capped there', () => {
  assert.equal(DELAY_FEEDBACK_MAX, 0.95);
  assert.ok(DELAY_FEEDBACK_MAX < 1, 'unity feedback in a wet/dry loop runs away');
});

test('feedback above the ceiling is clamped even when the schema allows it', () => {
  const loose = createStore({
    'delay.feedback': { kind: 'number', min: 0, max: 1000, def: 0, curve: 'linear', unit: '%' },
  });
  const bridge = createRampBridge(loose, {});
  const { chain } = build({ store: loose, bridge });

  loose.set('delay.feedback', 1000);
  assert.equal(chain.delay.feedback.gain.value, DELAY_FEEDBACK_MAX);

  loose.set('delay.feedback', -40);
  assert.equal(chain.delay.feedback.gain.value, 0);

  loose.set('delay.feedback', 42);
  assert.ok(Math.abs(chain.delay.feedback.gain.value - 0.42) < 1e-9, 'the percentage is read as a fraction');
});

test('the feedback gain is clamped however it is asked for', () => {
  const { chain } = build();
  assert.equal(chain.setDelayFeedback(1), DELAY_FEEDBACK_MAX);
  assert.equal(chain.setDelayFeedback(2.5), DELAY_FEEDBACK_MAX);
  assert.equal(chain.setDelayFeedback(-1), 0);
  assert.equal(chain.setDelayFeedback(0.5), 0.5);
  assert.equal(chain.delay.feedback.gain.value, 0.5);
});

/* ------------------------------------------------------------ the delay stage --- */

test('the delay line is built for the full 2 s the control allows', () => {
  const { chain } = build();
  assert.equal(chain.delay.line.maxDelayTime, DELAY_TIME_MAX);
  assert.equal(DELAY_TIME_MIN, 0.001);
});

test('delay time is written through one scheduled site, never by assignment', () => {
  const { chain, store } = build();
  const param = chain.delay.line.delayTime;
  const mark = param.events.length;
  store.set('delay.time', 0.75);
  const events = scheduledSince(param, mark);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'linearRampToValueAtTime');
  assert.equal(events[0].value, 0.75);
});

test('the tone control is a 400 Hz to 20 kHz lowpass with no resonant peak', () => {
  const { chain, store } = build();
  assert.equal(DELAY_TONE_MIN, 400);
  assert.equal(DELAY_TONE_MAX, 20000);
  store.set('delay.tone', DELAY_TONE_MIN);
  assert.equal(chain.delay.tone.frequency.value, 400);
  store.set('delay.tone', DELAY_TONE_MAX);
  assert.equal(chain.delay.tone.frequency.value, 20000);
  // A resonant peak above unity in the loop would undo the 95% cap.
  assert.ok(chain.delay.tone.Q.value <= 1, 'the feedback filter must be overdamped');
});

test('a tempo-synced fraction follows the beat, and switching is instant to hear', () => {
  const { chain, store } = build();
  store.set('delay.sync', true);
  store.set('delay.timeSync', '1/4');
  chain.syncDelayToTempo(120);
  // A quarter note at 120 BPM is half a second.
  assert.equal(chain.delay.line.delayTime.value, 0.5);

  chain.syncDelayToTempo(60);
  assert.equal(chain.delay.line.delayTime.value, 1);

  store.set('delay.timeSync', '1/8');
  assert.equal(chain.delay.line.delayTime.value, 0.5);

  store.set('delay.timeSync', '1/8T');
  assert.ok(Math.abs(chain.delay.line.delayTime.value - 1 / 3) < 1e-9, 'a triplet is a third of a beat');

  // Synced off: the free time control takes over again.
  store.set('delay.sync', false);
  store.set('delay.time', 0.25);
  assert.equal(chain.delay.line.delayTime.value, 0.25);
});

test('the matrix can modulate delay time in cents, clamped to the delay ceiling', () => {
  const { chain, store } = build();
  store.set('delay.sync', false);
  store.set('delay.time', 0.5);
  assert.equal(chain.modulateDelayTime(1200), 1, 'an octave up doubles the time');
  assert.equal(chain.delay.line.delayTime.value, 1);
  assert.equal(chain.modulateDelayTime(-1200), 0.25);
  assert.equal(chain.delay.line.delayTime.value, 0.25);
  chain.modulateDelayTime(4800);
  assert.equal(chain.delay.line.delayTime.value, DELAY_TIME_MAX, 'clamped to the DelayNode ceiling');
  chain.resetDelayTimeModulation();
  assert.equal(chain.delay.line.delayTime.value, 0.5, 'reset returns to the base time, not to a remembered one');
});

test('modulating delay time never writes the AudioParam twice for one change', () => {
  const { chain } = build();
  const param = chain.delay.line.delayTime;
  const mark = param.events.length;
  chain.modulateDelayTime(600);
  const events = scheduledSince(param, mark);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'linearRampToValueAtTime');
});

/* ---------------------------------------------------------- the reverb stage --- */

test('the reverb impulse response is generated once at startup', () => {
  const { chain, context } = build();
  assert.equal(context.createBufferCalls, 1, 'exactly one impulse response at startup');
  assert.ok(chain.reverb.convolver.buffer, 'the convolver has a response');
  const stats = chain.reverbIrStats();
  assert.equal(stats.builds, 1);
  assert.equal(stats.active, false, 'with the mix at zero the branch is out of the graph entirely');
});

test('the reverb decay is clamped to the 12 s ceiling before a buffer is built', () => {
  const loose = createStore({
    'reverb.decay': { kind: 'number', min: 0, max: 999, def: 1.8, curve: 'linear', unit: 's' },
  });
  const bridge = createRampBridge(loose, {});
  const { chain, scheduler } = build({ store: loose, bridge });
  loose.set('reverb.decay', 999);
  scheduler.run();
  const stats = chain.reverbIrStats();
  assert.equal(stats.loadedSeconds, 12);
  assert.equal(stats.lastSeconds, 12);
  assert.equal(chain.reverb.convolver.buffer.length, 12 * 48000);
  assert.equal(stats.maxSeconds, 12);
});

test('the response is rebuilt only when the decay actually changes', () => {
  const { chain, store, scheduler } = build();
  assert.equal(chain.reverbIrStats().builds, 1);

  store.set('reverb.decay', 1.8); // the value it already has
  assert.equal(scheduler.size, 0, 'an unchanged value must not even queue a build');
  assert.equal(chain.reverbIrStats().builds, 1);

  store.set('reverb.decay', 2.5);
  scheduler.run();
  assert.equal(chain.reverbIrStats().builds, 2);
  assert.equal(chain.reverbIrStats().loadedSeconds, 2.5);

  store.set('reverb.decay', 2.5); // the value it now has
  scheduler.run();
  assert.equal(chain.reverbIrStats().builds, 2, 'no rebuild for a value that is already loaded');
});

test('a sweep of the decay knob coalesces into one build, not one per tick', () => {
  const { chain, store, scheduler } = build();
  for (const seconds of [1.9, 2.0, 2.1, 2.2, 2.3]) store.set('reverb.decay', seconds);
  assert.ok(scheduler.size <= 1, `expected one queued build, got ${scheduler.size}`);
  scheduler.run();
  const stats = chain.reverbIrStats();
  assert.equal(stats.builds, 2, 'one startup build plus one for the sweep');
  assert.equal(stats.loadedSeconds, 2.3, 'the build lands on the last value asked for');
});

test('the build cost and length are reported for verification', () => {
  const { chain, store, scheduler } = build();
  store.set('reverb.decay', 12);
  scheduler.run();
  const stats = chain.reverbIrStats();
  assert.ok(Number.isFinite(stats.lastBuildMs), 'buildMs must be a measurement');
  assert.equal(stats.lastFrames, 12 * 48000);
  assert.equal(stats.channels, 2);
  assert.equal(stats.pending, false);
});

test('the damping lowpass and the pre-delay sit in the wet path', () => {
  const { chain, store } = build();
  store.set('reverb.mix', 0.5); // otherwise the whole branch is bypassed
  assert.equal(chain.reverb.damping.type, 'lowpass');
  assert.ok(chain.reverb.send.connections.includes(chain.reverb.preDelay));
  assert.ok(chain.reverb.preDelay.connections.includes(chain.reverb.damping));
  assert.ok(chain.reverb.damping.connections.includes(chain.reverb.convolver));
  assert.ok(chain.reverb.convolver.connections.includes(chain.reverb.wet));
  assert.ok(!chain.reverb.damping.connections.includes(chain.reverb.dry), 'damping must not touch the dry path');

  store.set('reverb.damping', REVERB_DAMPING_MAX);
  assert.equal(chain.reverb.damping.frequency.value, REVERB_DAMPING_MAX);
  store.set('reverb.preDelay', REVERB_PREDELAY_MAX);
  assert.equal(chain.reverb.preDelay.delayTime.value, REVERB_PREDELAY_MAX);
  assert.equal(chain.reverb.preDelay.maxDelayTime, REVERB_PREDELAY_MAX);
});

test('the mix is an equal-power crossfade and reaches exact silence at zero', () => {
  const { chain, store } = build();
  store.set('reverb.mix', 0);
  assert.equal(chain.reverb.wet.gain.value, 0);
  assert.equal(chain.reverb.dry.gain.value, 1);

  store.set('reverb.mix', 0.5);
  const power = chain.reverb.wet.gain.value ** 2 + chain.reverb.dry.gain.value ** 2;
  assert.ok(Math.abs(power - 1) < 1e-9, `equal power expected, got ${power}`);

  store.set('reverb.mix', 1);
  assert.equal(chain.reverb.wet.gain.value, 1);
  assert.ok(chain.reverb.dry.gain.value < 1e-9, 'a fully wet stage leaves nothing dry');
});

test('the delay mix is an equal-power crossfade too', () => {
  const { chain, store } = build();
  store.set('delay.mix', 0);
  assert.equal(chain.delay.wet.gain.value, 0);
  assert.equal(chain.delay.dry.gain.value, 1);
  store.set('delay.mix', 0.5);
  const power = chain.delay.wet.gain.value ** 2 + chain.delay.dry.gain.value ** 2;
  assert.ok(Math.abs(power - 1) < 1e-9, `equal power expected, got ${power}`);
});

test('mix zero removes the convolution from the graph rather than muting it', () => {
  const { chain, store, scheduler } = build();
  store.set('reverb.mix', 0.4);
  assert.ok(chain.delay.out.connections.includes(chain.reverb.send));
  assert.ok(chain.reverb.wet.connections.includes(chain.reverb.out));

  store.set('reverb.mix', 0);
  assert.equal(chain.reverb.wet.gain.value, 0, 'the wet gain is already at zero');
  assert.equal(chain.reverb.active, true, 'the cut waits for the ramp to land');
  scheduler.run();
  assert.equal(chain.reverb.active, false, 'past the ramp the stage is out of the graph');
  assert.ok(!chain.delay.out.connections.includes(chain.reverb.send));
  assert.ok(!chain.reverb.wet.connections.includes(chain.reverb.out));
  assert.ok(chain.delay.out.connections.includes(chain.reverb.dry), 'the dry path is untouched');
});

test('coming back from zero re-arms the stage and fades it in', () => {
  const { chain, store, scheduler } = build();
  store.set('reverb.mix', 0);
  scheduler.run();
  assert.equal(chain.reverb.active, false);

  store.set('reverb.mix', 0.3);
  assert.equal(chain.reverb.active, true);
  assert.ok(chain.delay.out.connections.includes(chain.reverb.send));
  assert.ok(chain.reverb.wet.connections.includes(chain.reverb.out));
  assert.ok(chain.reverb.wet.gain.value > 0);
});

test('the reverb send is the matrix modulation point, and one write site', () => {
  const { chain } = build();
  assert.equal(chain.modulateReverbSend(0.5), 0.5);
  assert.equal(chain.reverb.send.gain.value, 0.5);
  const mark = chain.reverb.send.gain.events.length;
  chain.modulateReverbSend(0.25);
  const events = scheduledSince(chain.reverb.send.gain, mark);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'linearRampToValueAtTime');
  assert.equal(chain.modulateReverbSend(5), 1, 'a send cannot exceed unity');
  assert.equal(chain.modulateReverbSend(-1), 0);
});

/* --------------------------------------------------------- the limiter, out --- */

test('the limiter is a fast, hard compressor doing safety work only', () => {
  const { chain } = build();
  const limiter = chain.limiter;
  assert.ok(limiter.threshold.value <= -3, 'it must only be catching peaks');
  assert.equal(limiter.ratio.value, 20, 'the maximum ratio the node offers');
  assert.equal(limiter.knee.value, 0, 'a knee would soften the ceiling it exists to hold');
  assert.ok(limiter.attack.value <= 0.005, 'a slow attack lets peaks through');
  assert.ok(limiter.release.value >= 0.05 && limiter.release.value <= 0.4);
  assert.deepEqual(LIMITER, { threshold: limiter.threshold.value, knee: 0, ratio: 20, attack: limiter.attack.value, release: limiter.release.value });
});

test('master volume is bound to the node before the limiter, not to the summing bus', () => {
  const { chain, store, bridge } = build();
  assert.ok(bridge.keys().includes('global.volume'));
  store.set('global.volume', 0.25);
  assert.equal(chain.masterVolume.gain.value, 0.25);
  assert.notEqual(chain.masterVolume, chain.input, 'the level stage is not the summing input');
});

test('the analyser is last, with the documented fftSize, and reports finite levels', () => {
  const { chain } = build();
  assert.equal(ANALYSER_FFT_SIZE, 2048);
  assert.equal(chain.analyser.fftSize, 2048);
  assert.equal(chain.analyser.frequencyBinCount, 1024);
  const levels = chain.readLevels();
  assert.ok(Number.isFinite(levels.rms) && levels.rms >= 0);
  assert.ok(Number.isFinite(levels.peak) && levels.peak >= 0);
});

test('the chain releases its store subscriptions when disposed', () => {
  const { chain, store, scheduler } = build();
  chain.dispose();
  const mark = chain.eq.low.gain.events.length;
  store.set('eq.low', 12);
  store.set('reverb.decay', 4);
  assert.equal(scheduler.size, 0);
  assert.equal(chain.eq.low.gain.events.length, mark, 'a disposed chain writes nothing');
});
test('the inventory task 13 reads describes every node, in signal order', () => {
  const { chain, store } = build();
  store.set('reverb.mix', 0.5);
  const rows = chain.nodeInventory();
  assert.equal(rows[0].label, 'input');
  assert.equal(rows[rows.length - 1].label, 'analyser');
  assert.deepEqual(
    rows.map((row) => row.label),
    [
      'input', 'eq.low', 'eq.mid', 'eq.high', 'delay.dry', 'delay.line', 'delay.tone',
      'delay.feedback', 'delay.wet', 'delay.out', 'reverb.dry', 'reverb.send',
      'reverb.preDelay', 'reverb.damping', 'convolver', 'reverb.wet', 'reverb.out',
      'masterVolume', 'limiter', 'safetyClip', 'analyser',
    ],
  );
  assert.ok(rows.every((row) => row.kind !== 'AudioNode'), 'every row names its node type');
  assert.deepEqual(rows.find((row) => row.label === 'limiter').feeds, ['safetyClip']);
  assert.deepEqual(rows.find((row) => row.label === 'masterVolume').feeds, ['limiter']);
  assert.ok(rows.every((row) => row.connected), 'with the mix up, every edge is made');
});

test('the inventory reports the bypass as disconnected edges', () => {
  const { chain } = build();
  const cut = chain.nodeInventory().find((row) => row.label === 'convolver');
  assert.equal(cut.connected, false);
  const dry = chain.nodeInventory().find((row) => row.label === 'reverb.dry');
  assert.equal(dry.connected, true);
});

test('the inventory names the same edges the graph makes', () => {
  const { chain, store } = build();
  store.set('reverb.mix', 0.5);
  const stated = {};
  for (const row of chain.nodeInventory()) stated[row.label] = [...row.feeds].sort();
  assert.deepEqual(stated, adjacency(chain));
});

/* ------------------------------------------------------- the safety clipper --- */

/** The curve's value at the grid point nearest `x`, and that grid point's own x. */
function onCurve(curve, x) {
  const i = Math.round(((x + 1) / 2) * (curve.length - 1));
  return { x: (i / (curve.length - 1)) * 2 - 1, y: curve[i] };
}

test('the safety clipper is transparent below its knee', () => {
  const curve = buildSafetyClipCurve();
  for (const x of [0, 0.1, 0.3, 0.5, SAFETY_CLIP_KNEE]) {
    const up = onCurve(curve, x);
    const down = onCurve(curve, -x);
    assert.ok(Math.abs(up.y - up.x) < 1e-6, `the curve must pass through ${x} unchanged`);
    assert.ok(Math.abs(down.y + up.y) < 1e-6, 'and be symmetric about zero');
  }
});

test('the safety clipper cannot exceed its ceiling, whatever comes in', () => {
  const curve = buildSafetyClipCurve();
  // A WaveShaperNode clamps its input to the curve's domain before looking it up, so
  // an input of 9 comes out exactly as an input of 1 does. This is the guarantee.
  assert.ok(Math.max(...curve) < SAFETY_CLIP_CEILING, 'the ceiling is never reached, only approached');
  assert.ok(Math.max(...curve) < 1 && Math.min(...curve) > -1, 'and it is below full scale');
  assert.ok(Math.abs(onCurve(curve, 1).y + onCurve(curve, -1).y) < 1e-6, 'symmetric at full scale too');
  assert.ok(onCurve(curve, 0.9).y > onCurve(curve, 0.8).y, 'still rising between the knee and the top');
  assert.ok(onCurve(curve, 0.9).y < 1);
  // Bending, not expanding: above the knee the curve is always BELOW the input.
  for (const x of [0.75, 0.85, 0.95]) {
    const point = onCurve(curve, x);
    assert.ok(point.y < point.x, `at ${x} the clipper must reduce, not boost`);
  }
});

test('the safety clipper curve is monotone, so it adds no oscillation of its own', () => {
  const curve = buildSafetyClipCurve();
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] >= curve[i - 1], `curve must not fall at index ${i}`);
  }
});

test('the clipper sits between the limiter and the analyser, and is not oversampled', () => {
  const { chain } = build();
  assert.ok(chain.limiter.connections.includes(chain.safetyClip));
  assert.ok(chain.safetyClip.connections.includes(chain.analyser));
  assert.equal(chain.safetyClip.oversample, 'none', 'a monotone curve gains nothing from resampling');
  assert.ok(chain.safetyClip.curve, 'and it has a curve');
});

test('re-arming the bypass builds a fresh convolver rather than reusing a stale one', () => {
  const { chain, context, store, scheduler } = build();
  store.set('reverb.mix', 0.4);
  const first = chain.reverb.convolver;
  assert.ok(first.buffer, 'the first convolver carries the startup response');

  store.set('reverb.mix', 0);
  scheduler.run();
  assert.equal(chain.reverb.active, false);

  store.set('reverb.mix', 0.5);
  const second = chain.reverb.convolver;
  assert.notEqual(second, first, 'a bypassed ConvolverNode keeps its convolution history, so it is replaced');
  assert.equal(second.buffer, first.buffer, 'and the response is re-used, not rebuilt');
  assert.equal(context.createBufferCalls, 1, 're-arming must not generate another impulse response');
  assert.ok(second.connections.includes(chain.reverb.wet), 'the new node is wired into the wet path');
});

test('a rebuilt response reaches the node currently carrying it', () => {
  const { chain, store, scheduler } = build();
  store.set('reverb.decay', 5);
  scheduler.run();
  assert.equal(chain.reverb.convolver.buffer.length, 5 * 48000);
  store.set('reverb.decay', 2);
  scheduler.run();
  assert.equal(chain.reverb.convolver.buffer.length, 2 * 48000, 'the live convolver gets the new response');
});
