/**
 * A recording stand-in for the Web Audio API: just enough of AudioContext,
 * AudioNode and AudioParam for the voice engine's structure and automation to be
 * asserted in `node --test`, with no audio device and no browser.
 *
 * It is a FAKE, not a mock framework: every node records the connections and
 * disconnections it was given, every AudioParam records the automation it was
 * asked to schedule, and the clock advances explicitly so a test can prove that
 * node counts come back down after teardown.
 *
 * The one deliberate simplification: a scheduled `linearRampToValueAtTime`
 * updates the param's `value` immediately. A real param interpolates over time,
 * but tests care that the write WAS scheduled and what it targeted, and having
 * to sleep in a unit test is not an option.
 */

export function createFakeAudioContext({ sampleRate = 48000, now = 0 } = {}) {
  const tally = new Map();
  const ended = [];

  const context = {
    kind: 'AudioContext',
    sampleRate,
    currentTime: now,
    /** Every node created, in order, for leak assertions. */
    created: [],
    tally,

    createGain: () => {
      const node = makeNode(context, 'gain');
      node.gain = makeParam(1);
      return node;
    },
    createConstantSource: () => {
      const node = makeNode(context, 'constantSource');
      node.offset = makeParam(0);
      return node;
    },
    createOscillator: () => {
      const node = makeNode(context, 'oscillator');
      node.type = 'sine';
      node.frequency = makeParam(440);
      node.detune = makeParam(0);
      node.periodicWave = null;
      node.setPeriodicWave = (wave) => {
        node.periodicWave = wave;
      };
      return node;
    },
    createBufferSource: () => {
      const node = makeNode(context, 'bufferSource');
      node.buffer = null;
      node.loop = false;
      node.playbackRate = makeParam(1);
      return node;
    },
    createPeriodicWave: (real, imag, constraints) => ({ real: [...real], imag: [...imag], constraints }),
    createBiquadFilter: () => {
      const node = makeNode(context, 'biquad');
      node.type = 'lowpass';
      node.frequency = makeParam(350);
      node.detune = makeParam(0);
      node.Q = makeParam(1);
      node.gain = makeParam(0);
      return node;
    },
    createWaveShaper: () => {
      const node = makeNode(context, 'waveShaper');
      node.curve = null;
      node.oversample = 'none';
      return node;
    },
    createBufferCalls: 0,
    createBuffer(channels, length, rate) {
      context.createBufferCalls += 1;
      return {
        channels,
        length,
        sampleRate: rate,
        getChannelData: (channel) => new Float32Array(length),
      };
    },

    /** Move the audio clock forward, firing `onended` for anything already stopped. */
    advance(seconds) {
      context.currentTime += seconds;
      for (let i = ended.length - 1; i >= 0; i -= 1) {
        const entry = ended[i];
        if (entry.stopTime <= context.currentTime) {
          ended.splice(i, 1);
          entry.node.onended?.({ target: entry.node, type: 'ended' });
        }
      }
      return context.currentTime;
    },

    /** Everything stopped but not yet ended, i.e. still holding a reference. */
    pending: () => ended.map((entry) => entry.node),
    tallyOf: (label) => ({ ...(tally.get(label) ?? { live: 0, created: 0, retired: 0 }) }),
  };

  context.destination = makeNode(context, 'destination');

  function makeNode(ctx, kind) {
    const node = {
      kind,
      connections: [],
      disconnects: 0,
      disconnectAll: 0,
      startedAt: null,
      stoppedAt: null,
      connect(destination) {
        node.connections.push(destination);
        return destination;
      },
      disconnect(destination) {
        node.disconnects += 1;
        if (destination === undefined) {
          node.disconnectAll += 1;
          node.connections.length = 0;
          return;
        }
        const at = node.connections.indexOf(destination);
        if (at >= 0) node.connections.splice(at, 1);
      },
      start(when) {
        if (node.startedAt !== null) throw new Error('InvalidStateError: node already started');
        node.startedAt = when ?? ctx.currentTime;
      },
      stop(when) {
        // Faithful to the spec: a node cannot be stopped twice, and stopping a
        // node that never started is an error. A voice that gets this wrong
        // should see the exception here rather than in a browser.
        if (node.startedAt === null) throw new Error('InvalidStateError: node not started');
        if (node.stoppedAt !== null) throw new Error('InvalidStateError: node already stopped');
        node.stoppedAt = when ?? ctx.currentTime;
        ended.push({ node, stopTime: node.stoppedAt });
      },
    };
    ctx.created.push(node);
    return node;
  }

  function makeParam(initial) {
    return {
      value: initial,
      events: [],
      setValueAtTime(value, time) {
        this.value = value;
        this.events.push({ type: 'setValueAtTime', value, time });
        return this;
      },
      linearRampToValueAtTime(value, time) {
        this.value = value;
        this.events.push({ type: 'linearRampToValueAtTime', value, time });
        return this;
      },
      setTargetAtTime(value, time, constant) {
        this.value = value;
        this.events.push({ type: 'setTargetAtTime', value, time, constant });
        return this;
      },
      cancelScheduledValues(time) {
        this.events.push({ type: 'cancelScheduledValues', time });
        return this;
      },
      cancelAndHoldAtTime(time) {
        this.events.push({ type: 'cancelAndHoldAtTime', time });
        return this;
      },
      /** How many times something wrote to this param without scheduling anything. */
      unscheduledWrites() {
        return this.events.filter((event) => !Number.isFinite(event.value)).length;
      },
    };
  }

  return context;
}

/** A parameter store stand-in: a flat table of numbers and strings. */
export function createFakeRead(initial = {}) {
  const table = { ...initial };
  const reads = [];
  const read = (key) => {
    reads.push(key);
    return table[key];
  };
  read.set = (key, value) => {
    table[key] = value;
    return value;
  };
  read.reads = reads;
  read.table = table;
  return read;
}