/**
 * 808.test.mjs — the eleven synthesized drum voices: their recipes, their four
 * parameters, their trigger counters, the open hat's pedal, and their node lifecycle.
 *
 * WHY THE COUNTERS EXIST AND WHY RMS IS NEVER USED HERE
 *   A closed hat is 55 ms, a rimshot 60 ms, a cowbell 300 ms. An evaluation
 *   round-trip — read, return, parse, issue the next call — is comparable to or
 *   longer than that. Sampling analyser RMS for a voice that has already finished
 *   reports a false failure, which is precisely the trap the plan names. So these
 *   tests assert on the trigger counters, which increment on the audio scheduling
 *   path, and on the AUTOMATION the recipe scheduled — which is checkable to the
 *   nanosecond and is what "the parameter took effect" actually means.
 *
 * WHAT IS CHECKED, AND HOW
 *   - the recipe table: 11 voices, the described frequencies and filters
 *   - tune: -12..+12 semitones moves the scheduled frequency by the right ratio
 *   - decay: 0.05..2.0 s moves the scheduled ramp end time by the right amount
 *   - level and pan: reach the entry gain and the StereoPannerNode
 *   - counters: monotonic, incremented on trigger, per voice, independent
 *   - the open hat's pedal: note-off is deferred until the pedal releases
 *   - lifecycle: nodes are allocated per trigger and retired on `onended`
 *   - the shared noise buffer: 500 hits, one buffer, flat node counts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDrumFakeAudioContext } from './drum-fake-audio.mjs';
import { noiseBufferCount } from '../web/audio/noise.js';
import { nodeLabel, nodeStats, resetNodeStats } from '../web/audio/nodes.js';
import { KIT_VOICES } from '../web/ui/params.js';
import { createDrumKit, DRUM_RECIPES, TUNE_RANGE, DECAY_RANGE } from '../web/audio/drum-kit.js';

/**
 * A stand-in for the mix bus. Nothing is connected to it in these tests; it exists so a
 * trigger has a parent to reach. Its `connect` refuses a non-node for the same reason
 * the harness's nodes do — see `enforceConnect` in tests/drum-fake-audio.mjs.
 */
function makeParent() {
  return {
    kind: 'parent',
    connections: [],
    connect(node) {
      if (!node || typeof node !== 'object' || !Array.isArray(node.connections)) {
        throw new TypeError(`fake parent: connect() called with ${String(node)}, which is not an AudioNode`);
      }
      this.connections.push(node);
      return node;
    },
    disconnect() {},
  };
}

/** A kit over a fake context, with the kit's four parameters per voice writable. */
function makeKit({ table = {} } = {}) {
  const context = createDrumFakeAudioContext({ now: 0 });
  const parent = makeParent();
  const voices = new Map();
  for (const name of KIT_VOICES) {
    voices.set(name, {
      'tune': 0,
      'decay': DRUM_RECIPES[name].defaultDecay,
      'level': 1,
      'pan': 0,
      ...table[name],
    });
  }
  const kit = createDrumKit({
    context,
    parent,
    read: (key) => {
      if (key === 'global.tempo') return 120;
      if (key === 'global.swing') return 50;
      const [, voice, field] = key.split('.');
      return voices.get(voice)?.[field];
    },
  });
  return { context, parent, kit, voices };
}

/** Every AudioParam event scheduled on a node, flattened, for assertions. */
function automationOf(node, param = 'gain') {
  return node[param]?.events ?? [];
}

/** The last value any event scheduled on `param` wrote. */
function finalValue(node, param = 'gain') {
  const events = automationOf(node, param);
  return events.length ? events[events.length - 1].value : node[param]?.value;
}

/** The last TIME any event on `param` was scheduled for. */
function finalTime(node, param = 'gain') {
  const events = automationOf(node, param);
  return events.length ? events[events.length - 1].time : 0;
}

/* ------------------------------------------------------------ the recipe table --- */

test('there are exactly eleven voices, and KIT_VOICES is the list the recipes cover', () => {
  assert.equal(KIT_VOICES.length, 11);
  assert.deepEqual(Object.keys(DRUM_RECIPES).sort(), [...KIT_VOICES].sort());
});

test('tune is -12..+12 semitones and decay is 0.05..2.0 s, as the plan states', () => {
  assert.deepEqual(TUNE_RANGE, { min: -12, max: 12 });
  assert.deepEqual(DECAY_RANGE, { min: 0.05, max: 2 });
  for (const [name, recipe] of Object.entries(DRUM_RECIPES)) {
    assert.ok(recipe.defaultDecay >= DECAY_RANGE.min && recipe.defaultDecay <= DECAY_RANGE.max, name);
  }
});

test('the bass drum is a sine with a pitch drop and a click, not a plain sine', () => {
  const bd = DRUM_RECIPES.bd;
  assert.equal(bd.wave, 'sine');
  assert.equal(bd.pitchDropSeconds, 0.05, 'the 808 bass drum drops pitch over roughly 50 ms');
  assert.ok(bd.pitchDropRatio > 1, 'it starts ABOVE the fundamental and falls to it');
  assert.ok(bd.click, 'the click transient is part of the recipe');
});

test('the snare is a ~180 Hz body tone plus a filtered noise burst', () => {
  const sd = DRUM_RECIPES.sd;
  assert.ok(sd.bodyHz.some((hz) => Math.abs(hz - 180) < 5), `expected a ~180 Hz body, got ${sd.bodyHz}`);
  assert.ok(sd.noise, 'the snare has a noise burst as well as a body');
  assert.ok(sd.noise.filter === 'bandpass' || sd.noise.filter === 'highpass');
});

test('the three toms descend in pitch and in envelope', () => {
  const { lt, mt, ht } = DRUM_RECIPES;
  assert.ok(lt.hz < mt.hz && mt.hz < ht.hz, 'low tom is lowest, hi tom is highest');
  assert.ok(lt.defaultDecay > mt.defaultDecay && mt.defaultDecay > ht.defaultDecay, 'and their envelopes descend too');
  for (const tom of [lt, mt, ht]) assert.equal(tom.wave, 'sine', 'a tom is a pitched sine');
});

test('the rimshot is a very short high-Q noise-and-tone transient', () => {
  const rs = DRUM_RECIPES.rs;
  assert.ok(rs.defaultDecay <= 0.1, 'a rimshot is over in well under 100 ms');
  assert.ok(rs.bodyHz.length >= 1 && rs.noise, 'it is a tone AND a noise tick');
  assert.ok(rs.bodyQ >= 8, 'and the tone is resonant — that is what makes it a rimshot');
});

test('the clap is four staggered noise bursts about 10 ms apart', () => {
  const cp = DRUM_RECIPES.cp;
  assert.equal(cp.bursts, 4);
  assert.equal(cp.burstGapSeconds, 0.01);
});

test('the hats are both highpassed noise, with very different decays', () => {
  const { ch, oh } = DRUM_RECIPES;
  assert.equal(ch.noise.filter, 'highpass');
  assert.equal(oh.noise.filter, 'highpass');
  assert.ok(oh.defaultDecay > ch.defaultDecay * 4, `open hat (${oh.defaultDecay}s) must be far longer than closed (${ch.defaultDecay}s)`);
  assert.equal(oh.pedal, true, 'the open hat is the one that is a held pedal');
  assert.equal(ch.pedal, false);
});

test('the cymbal is a long noise burst plus detuned square clusters', () => {
  const cy = DRUM_RECIPES.cy;
  assert.ok(cy.noise, 'a noise layer');
  assert.ok(cy.clusters >= 2, 'and more than one detuned square');
  assert.ok(cy.defaultDecay >= 1, 'the cymbal is the long voice of the kit');
});

test('the cowbell is two detuned squares at an INHARMONIC interval through a bandpass', () => {
  const cb = DRUM_RECIPES.cb;
  assert.equal(cb.wave, 'square');
  assert.equal(cb.squares.length, 2);
  // Not an octave: 800/540 is the famously wrong-sounding-but-right 808 ratio.
  const ratio = cb.squares[1] / cb.squares[0];
  assert.ok(ratio > 1.3 && ratio < 1.7, `expected an inharmonic pair, got a ratio of ${ratio.toFixed(3)}`);
  assert.equal(cb.filter, 'bandpass');
  assert.ok(cb.filterQ > 0.5);
});

/* --------------------------------------------------------- every voice builds --- */

test('every one of the eleven voices builds a graph, connects it to the parent, and retires it', () => {
  for (const name of KIT_VOICES) {
    const { context, parent, kit } = makeKit();
    kit.trigger(name, { at: 0 });
    const nodes = context.created.slice();
    const sources = nodes.filter((node) => ['oscillator', 'bufferSource'].includes(node.kind));
    const panners = nodes.filter((node) => node.kind === 'stereoPanner');
    const filters = nodes.filter((node) => node.kind === 'biquad');

    assert.ok(sources.length >= 1, `${name} needs at least one source`);
    assert.equal(panners.length, 1, `${name} needs exactly one StereoPannerNode — pan is the only position control`);
    assert.equal(panners[0].connections.length, 1, `${name}'s panner must reach the mix bus and nothing else`);
    // A pitched sine needs no filter of its own, but every voice built on NOISE does:
    // unshaped noise is a hiss and not an 808 anything.
    if (DRUM_RECIPES[name].noise) {
      assert.ok(filters.length >= 1, `${name} uses noise and must filter it`);
    }
    // Every source starts at the requested time, and they all stop together so the
    // last `onended` finds a complete graph.
    for (const source of sources) assert.equal(source.startedAt, 0, `${name} source not started at the scheduled time`);
    const stops = new Set(sources.map((source) => source.stoppedAt));
    assert.equal(stops.size, 1, `${name} sources must share one stop time, saw ${[...stops]}`);
    const lastStop = sources[0].stoppedAt;
    assert.ok(lastStop > 0, `${name} never stops`);

    // Teardown hangs off the node's own end — nothing here waits on a timer.
    context.advance(lastStop + 0.001);
    const stillConnected = nodes.filter((node) => node.connections.length > 0);
    assert.deepEqual(stillConnected, [], `${name} left nodes connected after its sources ended`);
  }
});

test('no gain inside a trigger stays closed: every layer can actually reach the entry', () => {
  // This is the assertion that catches a summing bus left at zero. Two recipes once had
  // one — the clap's burst bus and the cowbell's square bus — and BOTH voices rendered
  // absolute silence while every structural test passed: the nodes existed, the filters
  // existed, the counter moved, the envelope on the ENTRY gain was a perfect decay. The
  // only thing wrong was a gate between the source and the entry that never opened.
  //
  // So: every GainNode in a trigger must reach a positive value at its default
  // parameters. A closed gate anywhere in a recipe is a silent voice.
  for (const name of KIT_VOICES) {
    const { context, kit } = makeKit();
    kit.trigger(name, { at: 0 });
    // Only real GainNodes: a biquad's `gain` is a filter gain in dB and legitimately
    // sits at 0, and the harness's panner is a re-labelled gain node carrying an unused
    // gain param from the template.
    const closed = context.created
      .filter((node) => node.kind === 'gain' && Array.isArray(node.gain?.events))
      .filter((node) => Math.max(...node.gain.events.map((event) => event.value)) <= 0)
      .map((node) => node.connections.length);
    assert.deepEqual(closed, [], `${name} has a gain that never opens, so part of it is silent`);
  }
});

test('every voice has a path from a source to the entry gain', () => {
  // Belt and braces on the same failure: walk UPSTREAM from the entry and require a
  // source in reach. A recipe that built nodes but wired none of them up is
  // indistinguishable from a working one by counting alone.
  //
  // The fake's `connections` list is OUTGOING — `a.connect(b)` records `b` on `a` — so
  // upstream means reversing the graph first. Doing it the other way round walks
  // downstream and "finds" a source by way of the mix bus.
  for (const name of KIT_VOICES) {
    const { context, kit } = makeKit();
    kit.trigger(name, { at: 0 });
    const nodes = context.created;
    const feeds = new Map();
    for (const node of nodes) {
      for (const destination of node.connections) {
        if (!feeds.has(destination)) feeds.set(destination, []);
        feeds.get(destination).push(node);
      }
    }
    // The entry is the gain the panner feeds from — the one stage every layer reaches.
    const entry = nodes.find((node) => feeds.has(node) && node.connections.some((next) => next.kind === 'stereoPanner'));
    assert.ok(entry, `${name}: no entry gain feeding the panner`);

    const seen = new Set();
    const queue = [...(feeds.get(entry) ?? [])];
    let reachedSource = false;
    while (queue.length) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (['oscillator', 'bufferSource'].includes(node.kind)) {
        reachedSource = true;
        continue;
      }
      queue.push(...(feeds.get(node) ?? []));
    }
    assert.ok(reachedSource, `${name}: nothing upstream of the entry can make a sound`);
  }
});

test('a hit scheduled in the future is silent until its start time', () => {
  // A GainNode's `gain` is 1 until something writes to it, and a SCHEDULED write only
  // lands AT its own time. The lookahead clock schedules every drum hit up to 100 ms
  // ahead, so a layer that is only silenced by a scheduled event is wide open through
  // the whole of that window. This shipped once and it was audible: the clap's staggered
  // bursts summed at full level through the gaps between them, because bursts two, three
  // and four were all still at gain 1 until their own start time arrived.
  //
  // Triggering at five seconds ahead is deliberately far beyond any horizon: what matters
  // is that nothing is open at all before the trigger's own time. A panner needs no
  // equivalent assertion because its `pan` is 0 by default and therefore centred — and
  // silent — already.
  for (const name of KIT_VOICES) {
    const { context, kit } = makeKit();
    kit.trigger(name, { at: 5 });
    for (const node of context.created) {
      // `firstWrite` is the first value a param was ever assigned, whether by a direct
      // assignment or by scheduling. A gain whose FIRST write is not silence was open
      // between its creation and that write.
      if (node.gain?.firstWrite !== undefined) {
        assert.equal(node.gain.firstWrite, 0, `${name}: a gain node is open before its trigger time`);
      }
    }
  }
});

test('the clap schedules FOUR bursts 10 ms apart, the last one ringing for the whole decay', () => {
  // "Four staggered filtered noise bursts roughly 10 ms apart" is a claim about what is
  // SCHEDULED, and this is where that claim can be exact. An amplitude-envelope
  // measurement cannot settle it: the clap's noise passes a ~750 Hz band, so a window
  // short enough to resolve a 4 ms tick is shorter than one cycle of the passband and
  // its RMS swings 20 dB window to window. The render confirms all four burst periods
  // carry energy; this test confirms what those four bursts ARE.
  const { context, kit } = makeKit();
  const handle = kit.trigger('cp', { at: 0 });
  assert.equal(DRUM_RECIPES.cp.bursts, 4);
  assert.equal(DRUM_RECIPES.cp.burstGapSeconds, 0.01);

  // One noise source per burst, and every one of them started at the trigger time.
  const noise = handle.nodes.filter((node) => node.kind === 'bufferSource');
  assert.equal(noise.length, 4, 'one noise source per burst');

  // Four burst envelopes, opening at 0 / 10 / 20 / 30 ms.
  const burstNode = (i) => handle.nodes.find((node) => nodeLabel(node) === `drum-cp-burst${i}`);
  const bursts = [0, 1, 2, 3].map((i) => {
    const events = burstNode(i).gain.events;
    return {
      silence: events.find((event) => event.type === 'setValueAtTime' && event.value === 0),
      peak: events.find((event) => event.type === 'linearRampToValueAtTime' && event.value > 0.5),
      last: events.at(-1),
    };
  });

  assert.deepEqual(bursts.map((b) => b.silence.time), [0, 0.01, 0.02, 0.03], 'bursts 10 ms apart');

  // The three hands: a sub-2 ms attack, then gated closed again so the gap is audible.
  for (const [i, burst] of bursts.slice(0, 3).entries()) {
    assert.ok(burst.peak.time > burst.silence.time && burst.peak.time - burst.silence.time < 0.002,
      `hand ${i} should open with a sub-2 ms attack`);
    assert.equal(burst.last.value, 0, `hand ${i} must be closed again, or there is no gap to hear`);
    assert.ok(burst.last.time - burst.silence.time <= DRUM_RECIPES.cp.burstDecaySeconds + 1e-9,
      `hand ${i} must close inside its own burst window`);
  }

  // The fourth is the body: it opens on the same 10 ms grid and rings for the decay.
  assert.equal(bursts[3].silence.time, 0.03);
  assert.ok(finalTime(burstNode(3), 'gain') > 0.15,
    `the clap body must ring for its decay, ended at ${finalTime(burstNode(3), 'gain')}`);
});

test('a voice is torn down by its own onended, with no timer involved', () => {
  resetNodeStats();
  const { context, kit } = makeKit();
  kit.trigger('cy', { at: 0 }); // the cymbal is the voice that legitimately lives for seconds
  const before = nodeStats().live;
  assert.ok(before > 0, 'the trigger allocated nodes');
  // Nothing has ended yet, so everything is still live: a long decay is not a leak.
  const sources = context.created.filter((node) => ['oscillator', 'bufferSource'].includes(node.kind));
  const end = Math.max(...sources.map((node) => node.stoppedAt));
  context.advance(end - 0.001);
  assert.equal(nodeStats().live, before, 'a cymbal still decaying must still own its nodes');
  context.advance(0.002);
  assert.equal(nodeStats().live, 0, 'and must have released every one of them when it ended');
});

/* --------------------------------------------------------------- the counters --- */

test('a trigger increments its own counter and nobody else\'s', () => {
  const { kit } = makeKit();
  for (const voice of KIT_VOICES) assert.equal(kit.triggerCount(voice), 0, `${voice} should start at zero`);

  kit.trigger('cb', { at: 0 });
  assert.equal(kit.triggerCount('cb'), 1);
  for (const voice of KIT_VOICES) {
    if (voice === 'cb') continue;
    assert.equal(kit.triggerCount(voice), 0, `${voice} must not have been triggered`);
  }
});

test('every voice increments its own counter when it is the one triggered', () => {
  for (const voice of KIT_VOICES) {
    const { kit } = makeKit();
    kit.trigger(voice, { at: 0 });
    for (const other of KIT_VOICES) {
      assert.equal(kit.triggerCount(other), other === voice ? 1 : 0, `${voice} -> ${other}`);
    }
  }
});

test('the counters are monotonic across many triggers and never reset', () => {
  const { context, kit } = makeKit();
  let last = kit.counters().cb;
  for (let i = 0; i < 50; i += 1) {
    kit.trigger('cb', { at: context.currentTime });
    const now = kit.counters().cb;
    assert.ok(now > last, `counter went backwards: ${now} <= ${last}`);
    last = now;
  }
  assert.equal(last, 50);
  // Every other voice is still silent after fifty cowbell hits.
  for (const voice of KIT_VOICES) {
    if (voice !== 'cb') assert.equal(kit.triggerCount(voice), 0, voice);
  }
});

test('an unknown voice name is refused rather than silently swallowed', () => {
  const { kit } = makeKit();
  assert.equal(kit.trigger('kick', { at: 0 }), null);
  assert.equal(kit.triggerCount('kick'), undefined);
});

/* ------------------------------------------------------------------- the four --- */

test('tune moves the scheduled frequency by the right ratio, both directions', () => {
  const flat = makeKit().kit;
  const at = flat.trigger('bd', { at: 0 });
  const baseHz = finalValue(at.primary, 'frequency');

  for (const semitones of [-12, -5, 1, 7, 12]) {
    const { kit } = makeKit({ table: { bd: { tune: semitones } } });
    const handle = kit.trigger('bd', { at: 0 });
    const hz = finalValue(handle.primary, 'frequency');
    const expected = baseHz * 2 ** (semitones / 12);
    assert.ok(Math.abs(hz / expected - 1) < 1e-6, `${semitones} st: ${hz} != ${expected}`);
  }
});

test('tune is clamped to the store range rather than trusted', () => {
  const { kit } = makeKit({ table: { bd: { tune: 99 } } });
  const handle = kit.trigger('bd', { at: 0 });
  const twelve = makeKit({ table: { bd: { tune: 12 } } }).kit.trigger('bd', { at: 0 });
  assert.equal(finalValue(handle.primary, 'frequency'), finalValue(twelve.primary, 'frequency'));
});

test('decay moves the scheduled envelope end time, for every voice', () => {
  for (const voice of KIT_VOICES) {
    const short = makeKit({ table: { [voice]: { decay: 0.05 } } }).kit;
    const long = makeKit({ table: { [voice]: { decay: 2 } } }).kit;
    const a = short.trigger(voice, { at: 0 });
    const b = long.trigger(voice, { at: 0 });
    // The ENTRY gain is the last thing to finish, so it is where the voice's total
    // length is legible regardless of how many sub-bursts the recipe has.
    const shortEnd = finalTime(a.entry, 'gain');
    const longEnd = finalTime(b.entry, 'gain');
    assert.ok(longEnd > shortEnd + 1.5, `${voice}: ${shortEnd} -> ${longEnd} is not a decay change`);
    assert.ok(Math.abs(shortEnd - 0.05) < 0.02, `${voice} at its 0.05 s minimum ran to ${shortEnd}`);
  }
});

test('level reaches the entry gain, and zero level silences the voice', () => {
  const loud = makeKit({ table: { bd: { level: 1 } } }).kit.trigger('bd', { at: 0 });
  const quiet = makeKit({ table: { bd: { level: 0 } } }).kit.trigger('bd', { at: 0 });
  const loudPeak = Math.max(...automationOf(loud.entry).map((event) => event.value));
  const quietPeak = Math.max(...automationOf(quiet.entry).map((event) => event.value));
  assert.ok(loudPeak > 0, 'a level of 1 must be audible');
  assert.equal(quietPeak, 0, 'a level of 0 must schedule no gain at all');
});

test('pan reaches the StereoPannerNode, hard left to hard right, and is clamped', () => {
  const left = makeKit({ table: { sd: { pan: -1 } } }).kit.trigger('sd', { at: 0 });
  assert.equal(finalValue(left.panner, 'pan'), -1);
  const right = makeKit({ table: { sd: { pan: 1 } } }).kit.trigger('sd', { at: 0 });
  assert.equal(finalValue(right.panner, 'pan'), 1);
  const wild = makeKit({ table: { sd: { pan: 42 } } }).kit.trigger('sd', { at: 0 });
  assert.equal(finalValue(wild.panner, 'pan'), 1, 'a pan outside the store range is clamped, not obeyed');
});

/* --------------------------------------------------------------- the envelopes --- */

test('the bass drum pitch drops from high to low over about 50 ms', () => {
  const { kit } = makeKit();
  const handle = kit.trigger('bd', { at: 0 });
  const oscillator = handle.primary;
  const events = automationOf(oscillator, 'frequency');
  const drop = events.find((event) => event.type === 'exponentialRampToValueAtTime');
  assert.ok(drop, 'the pitch drop must be a scheduled ramp, not a set value');
  assert.ok(Math.abs(drop.time - 0.05) < 1e-6, `drop ended at ${drop.time}, expected 0.05`);
  // It FALLS: the scheduled end frequency is below the start.
  const start = events[0].value;
  assert.ok(drop.value < start, `pitch rose instead of dropping: ${start} -> ${drop.value}`);
  assert.ok(finalValue(oscillator, 'frequency') <= drop.value * 1.001, 'and it lands on the fundamental');
});

test('a closed hat is a short highpassed burst and an open hat is the same filter, much longer', () => {
  const short = makeKit({ table: { ch: { decay: 0.05 } } }).kit.trigger('ch', { at: 0 });
  const long = makeKit({ table: { oh: { decay: 1.5 } } }).kit.trigger('oh', { at: 0 });
  const cutoffs = (handle) => finalValue(handle.nodes.find((node) => node.kind === 'biquad'), 'frequency');
  assert.ok(cutoffs(short) >= 4000, `a hat is highpassed: got ${cutoffs(short)} Hz`);
  assert.ok(Math.abs(cutoffs(short) - cutoffs(long)) < 1, 'and both hats use the same filter');
  assert.ok(finalTime(long.entry, 'gain') - finalTime(short.entry, 'gain') > 1.4);
});

/* ----------------------------------------------------------------- the pedal --- */

test('the open hat holds while the pedal is engaged and is released only when it lets go', () => {
  const { context, kit } = makeKit();
  kit.trigger('oh', { at: 0 });
  assert.equal(kit.pedalEngaged(), false);

  kit.pedalDown('oh');
  assert.equal(kit.pedalEngaged(), true);

  // While the pedal is down, a note-off must not silence the voice: the request is
  // remembered, not obeyed.
  kit.release('oh', { at: 0 });
  assert.equal(kit.pedalPending(), true, 'the release is deferred, not lost');
  assert.equal(kit.releasePendingCount('oh'), 1);
  assert.equal(kit.liveCount('oh'), 1, 'and the voice is still sounding');

  kit.pedalUp('oh');
  assert.equal(kit.pedalEngaged(), false);
  assert.equal(kit.releasePendingCount('oh'), 0, 'releasing the pedal is what lets the deferred note-off through');
});

test('with no pedal engaged, a release takes effect immediately', () => {
  const { kit } = makeKit();
  kit.trigger('oh', { at: 0 });
  kit.release('oh', { at: 0 });
  assert.equal(kit.releasePendingCount('oh'), 0, 'nothing is deferred when no pedal is down');
});

test('no other voice has a pedal', () => {
  for (const voice of KIT_VOICES) {
    if (voice === 'oh') continue;
    assert.notEqual(DRUM_RECIPES[voice].pedal, true, `${voice} must not claim a pedal`);
  }
});

/* ------------------------------------------------------------ the shared noise --- */

test('every noise-using voice reuses ONE shared noise buffer, and none allocates its own', () => {
  const { context, kit } = makeKit();
  assert.equal(noiseBufferCount(context), 0, 'no buffer exists until something asks for one');
  kit.trigger('ch', { at: 0 });
  assert.equal(noiseBufferCount(context), 1);
  const sources = context.created.filter((node) => node.kind === 'bufferSource');
  assert.ok(sources.length >= 1);
  const buffers = new Set(sources.map((node) => node.buffer));
  assert.equal(buffers.size, 1, 'every noise source must be looping the SAME buffer');
  for (const node of sources) {
    assert.equal(node.loop, true, 'a shared noise buffer must loop, or it repeats audibly');
  }
});

test('five hundred drum hits: flat node counts, one noise buffer, no growth', () => {
  resetNodeStats();
  const { context, kit } = makeKit();
  let at = 0;
  // A realistic busy pattern rather than one voice on repeat, so every recipe is
  // exercised by the churn.
  const pattern = ['bd', 'ch', 'sd', 'oh', 'cp', 'ch', 'rs', 'cb', 'cy', 'lt', 'mt', 'ht'];
  const HITS = 500;
  const liveAfterFirstBatch = (() => {
    for (let i = 0; i < 20; i += 1) {
      kit.trigger(pattern[i % pattern.length], { at });
      at += 0.02;
    }
    context.advance(at + 3);
    return nodeStats().live;
  })();
  const bufferCount = noiseBufferCount(context);

  for (let i = 0; i < HITS; i += 1) {
    kit.trigger(pattern[i % pattern.length], { at });
    at += 0.02;
    // Let each hit's nodes end, in the same way the real audio clock would.
    if (i % 25 === 24) context.advance(at + 0.5);
  }
  context.advance(at + 3);

  assert.equal(noiseBufferCount(context), 1, 'exactly one noise buffer must exist for the whole kit');
  assert.equal(noiseBufferCount(context), bufferCount);
  assert.equal(nodeStats().live, liveAfterFirstBatch, 'live node count must not grow with hits');
  assert.ok(nodeStats().created > HITS, 'the hits really did allocate');
  const stats = nodeStats();
  assert.equal(stats.live, stats.created - stats.retired, 'every allocated node was retired');
});

test('the kit\'s own node accounting is per voice and per role', () => {
  resetNodeStats();
  const { context, kit } = makeKit();
  kit.trigger('bd', { at: 0 });
  kit.trigger('sd', { at: 0 });
  const report = kit.nodeReport();
  assert.ok(report.bd.created > 0, 'the bass drum allocated');
  assert.ok(report.sd.created > 0, 'the snare allocated');
  assert.equal(report.ch.created, 0, 'a voice that did not fire allocated nothing');
  assert.equal(report.cy.created, 0);
  // Roles are named, so a leak can be attributed to a stage rather than just a voice.
  assert.ok(report.bd.roles['drum-bd-body'], `expected a body oscillator, saw ${Object.keys(report.bd.roles)}`);
  assert.ok(report.bd.roles['drum-bd-clickFilter'], 'and the click filter the recipe describes');
  // Both are still sounding, because nothing has reached their stop time yet.
  assert.ok(report.bd.live > 0);
  const ends = context.created.filter((n) => n.stoppedAt !== null).map((n) => n.stoppedAt);
  context.advance(Math.max(...ends) + 0.001);
  const quiet = kit.nodeReport();
  for (const voice of KIT_VOICES) {
    assert.equal(quiet[voice].live, 0, `${voice} still owns nodes after its sources ended`);
  }
});

/* ------------------------------------------------------------------- the panic --- */

test('allNotesOff silences every voice, including a held pedal, and clears the pending releases', () => {
  resetNodeStats();
  const { context, kit } = makeKit();
  let at = 0;
  for (const voice of KIT_VOICES) {
    kit.trigger(voice, { at });
    at += 0.01;
  }
  kit.pedalDown('oh');
  kit.release('oh', { at });
  assert.ok(kit.liveCountAll() > 0);

  kit.allNotesOff({ at: at + 0.01 });
  assert.equal(kit.liveCountAll(), 0, 'nothing is still sounding after a panic');
  assert.equal(kit.pedalEngaged(), false, 'and the pedal is released');
  assert.equal(kit.releasePendingCount('oh'), 0);

  context.advance(at + 4);
  assert.equal(nodeStats().live, 0, 'every node a panic silenced was retired on its own end');
});

test('the kit exposes its voice list and its parameter keys, and nothing else', () => {
  const { kit } = makeKit();
  assert.deepEqual([...kit.voices()], [...KIT_VOICES]);
  assert.deepEqual(kit.parameterKeys('bd'), ['kit.bd.tune', 'kit.bd.decay', 'kit.bd.level', 'kit.bd.pan']);
});