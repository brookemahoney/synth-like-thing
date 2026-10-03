/**
 * The voice allocator's stealing policy is the contract: at most 16 live
 * voices, the OLDEST RELEASED voice stolen first, and only when every voice is
 * still sounding, the OLDEST SOUNDING one. Getting that order wrong makes a
 * held chord cut itself off, so it is tested here rather than listened for.
 *
 * Framework-free: `node --test tests/alloc.test.mjs`. The allocator never touches
 * an AudioContext — it only decides which existing voice to give away, so a
 * recording of voice start times, release times and note ids is enough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VOICE_CAPACITY, VOICE_STATE, createAllocator, pickVoice } from '../web/audio/allocator.js';

/** A voice that records what the allocator did to it, and nothing else. */
function makeFakeVoice(index) {
  return {
    index,
    state: VOICE_STATE.IDLE,
    noteId: null,
    startedAt: null,
    releasedAt: null,
    log: [],
    start(note, { at }) {
      this.state = VOICE_STATE.SOUNDING;
      this.noteId = note.id;
      this.startedAt = at;
      this.releasedAt = null;
      this.log.push(`start:${note.id}`);
    },
    release(at) {
      this.state = VOICE_STATE.RELEASED;
      this.releasedAt = at;
      this.log.push(`release:${this.noteId}`);
    },
    kill(at) {
      this.state = VOICE_STATE.IDLE;
      this.noteId = null;
      this.startedAt = null;
      this.releasedAt = null;
      this.log.push(`kill@${at}`);
    },
  };
}

function makeAllocator(capacity = VOICE_CAPACITY) {
  let created = 0;
  return createAllocator({
    capacity,
    createVoice: (index) => {
      created += 1;
      return makeFakeVoice(index);
    },
  });
}

test('the pool is sixteen voices and no voice is built before it is asked for', () => {
  const allocator = makeAllocator();
  assert.equal(allocator.capacity, 16);
  assert.equal(allocator.voices.length, 0, 'lazy: no nodes exist before the first note');
  allocator.acquire({ id: 'a' }, 1);
  assert.equal(allocator.voices.length, 1);
});

test('a released voice is used in preference to an idle one, and is not killed', () => {
  const allocator = makeAllocator(1);
  const first = allocator.acquire({ id: 'a' }, 1);
  first.release(2);

  const second = allocator.acquire({ id: 'b' }, 3);

  assert.equal(second, first, 'the pool is full, so the released voice is reused');
  assert.deepEqual(first.log, ['start:a', 'release:a', 'kill@3', 'start:b'], 'reused, but only through the one teardown path');
  assert.equal(allocator.stats().steals, 0);
  assert.equal(allocator.stats().reuses, 1);
});

test('an idle voice is preferred while the pool still has room', () => {
  const allocator = makeAllocator(2);
  const first = allocator.acquire({ id: 'a' }, 1);
  first.release(2);
  const second = allocator.acquire({ id: 'b' }, 3);

  assert.equal(second.index, 1, 'growing into a free slot steals nothing');
  assert.deepEqual(allocator.stats(), { capacity: 2, pool: 2, live: 2, sounding: 1, released: 1, idle: 0, steals: 0, reuses: 0 });
});

test('with no idle voice the OLDEST RELEASED voice is stolen, not the newest', () => {
  const allocator = makeAllocator(3);
  const a = allocator.acquire({ id: 'a' }, 1);
  const b = allocator.acquire({ id: 'b' }, 2);
  const c = allocator.acquire({ id: 'c' }, 3);

  c.release(30); // released first
  b.release(31); // released second, but still older than `a`, which never releases
  a.release(32);

  const stolen = allocator.acquire({ id: 'd' }, 40);
  assert.equal(stolen.index, c.index, 'voice 3 released at t=30, so it is stolen first');
  assert.equal(a.state, VOICE_STATE.RELEASED, 'a was released last, so it is still waiting');
  assert.equal(b.state, VOICE_STATE.RELEASED, 'b was released second, so it is still waiting');
  assert.deepEqual(c.log, ['start:c', 'release:c', 'kill@40', 'start:d']);
});

test('release order, not note order, decides which released voice goes first', () => {
  const allocator = makeAllocator(3);
  allocator.acquire({ id: 'a' }, 1);
  const b = allocator.acquire({ id: 'b' }, 2);
  const c = allocator.acquire({ id: 'c' }, 3);

  b.release(20); // note b (voice 2) is the FIRST released
  c.release(21); // note c (voice 3) is the second

  const stolen = allocator.acquire({ id: 'd' }, 30);
  assert.equal(stolen.index, b.index);
});

test('when every voice is still sounding the OLDEST SOUNDING voice is stolen', () => {
  const allocator = makeAllocator(3);
  const a = allocator.acquire({ id: 'a' }, 10);
  allocator.acquire({ id: 'b' }, 20);
  const c = allocator.acquire({ id: 'c' }, 30);

  const stolen = allocator.acquire({ id: 'd' }, 40);
  assert.equal(stolen.index, a.index, 'voice 1 started at t=10, so it is the oldest sounding voice');
  assert.equal(stolen.index, 0);
  assert.deepEqual(c.log, ['start:c'], 'the most recently started voice keeps playing');
  assert.equal(allocator.stats().steals, 1);
});

test('pickVoice reports why it chose a voice, and nothing from an empty pool', () => {
  assert.equal(pickVoice([]).voice, null);
  const voices = [
    { index: 0, state: VOICE_STATE.SOUNDING, startedAt: 1, releasedAt: null },
    { index: 1, state: VOICE_STATE.RELEASED, startedAt: 2, releasedAt: 9 },
    { index: 2, state: VOICE_STATE.IDLE, startedAt: null, releasedAt: null },
  ];
  const idle = pickVoice(voices);
  assert.equal(idle.reason, 'idle');
  assert.equal(idle.voice.index, 2);

  voices.pop();
  assert.equal(pickVoice(voices).reason, 'released');
  voices.push({ index: 2, state: VOICE_STATE.SOUNDING, startedAt: 9, releasedAt: null });
  assert.equal(pickVoice(voices).reason, 'released', 'a released voice outranks a sounding one');
  voices.splice(1, 1);
  assert.equal(pickVoice(voices).reason, 'sounding');
});

test('equal timestamps fall back to pool order, so stealing is deterministic', () => {
  const voices = [
    { index: 0, state: VOICE_STATE.SOUNDING, startedAt: 5, releasedAt: null },
    { index: 1, state: VOICE_STATE.SOUNDING, startedAt: 5, releasedAt: null },
    { index: 2, state: VOICE_STATE.SOUNDING, startedAt: 5, releasedAt: null },
  ];
  assert.equal(pickVoice(voices).voice.index, 0);
});

test('twenty overlapping notes never put more than sixteen live voices on the bus', () => {
  const allocator = makeAllocator();
  for (let i = 0; i < 20; i += 1) {
    allocator.acquire({ id: `n${i}` }, i);
    const stats = allocator.stats();
    assert.ok(stats.live <= 16, `live ${stats.live} exceeded the pool at note ${i}`);
    assert.ok(stats.sounding <= 16);
  }
  const stats = allocator.stats();
  assert.equal(allocator.voices.length, 16, 'the pool stops growing at sixteen');
  assert.equal(stats.steals, 4, 'four of the twenty notes had to cut a sounding voice');
  assert.equal(stats.sounding, 16);
  assert.equal(new Set(allocator.voices).size, 16);
});

test('a full pool of released voices is reused oldest-release-first, in order', () => {
  const allocator = makeAllocator();
  for (let i = 0; i < 16; i += 1) allocator.acquire({ id: `n${i}` }, i);

  // Release voices 5, then 2, then 11 — the steal order must be that exact order.
  for (const [id, at] of [['n5', 100], ['n2', 101], ['n11', 102]]) allocator.noteOff(id, at);

  const stolen = [];
  for (let i = 0; i < 3; i += 1) stolen.push(allocator.acquire({ id: `x${i}` }, 200 + i).index);

  assert.deepEqual(stolen, [5, 2, 11]);
});

test('once released voices are gone the oldest sounding voice is next in line', () => {
  const allocator = makeAllocator();
  const first = allocator.acquire({ id: 'n0' }, 0);
  for (let i = 1; i < 16; i += 1) allocator.acquire({ id: `n${i}` }, i);
  allocator.noteOff('n5', 100);

  const stolen = [];
  for (let i = 0; i < 2; i += 1) stolen.push(allocator.acquire({ id: `x${i}` }, 200 + i).index);

  assert.deepEqual(stolen, [5, 0], 'the released voice first, then the oldest sounding one');
  assert.equal(first.index, 0);
});

test('noteOff finds a sounding voice by note id and is harmless otherwise', () => {
  const allocator = makeAllocator();
  const a = allocator.acquire({ id: 'a' }, 1);
  const b = allocator.acquire({ id: 'b' }, 2);

  assert.equal(allocator.noteOff('b', 5), b);
  assert.equal(b.state, VOICE_STATE.RELEASED);
  assert.equal(b.releasedAt, 5);
  assert.equal(allocator.noteOff('b', 6), null, 'a voice already released is not released twice');
  assert.equal(allocator.noteOff('nope', 7), null);
  assert.equal(a.state, VOICE_STATE.SOUNDING);
});

test('the same note id cannot be released twice and cannot hide another voice', () => {
  const allocator = makeAllocator();
  allocator.acquire({ id: 'a' }, 1);
  allocator.acquire({ id: 'a' }, 2); // a stolen voice takes the same id
  const released = allocator.noteOff('a', 3);
  assert.ok(released);
  assert.equal(released.startedAt, 2, 'the most recent claim of the id is the live one');
});

test('allNotesOff releases every sounding voice and the released order is oldest first', () => {
  const allocator = makeAllocator(4);
  for (let i = 0; i < 4; i += 1) allocator.acquire({ id: `n${i}` }, i);
  allocator.allNotesOff(50);
  assert.equal(allocator.stats().sounding, 0);
  assert.equal(allocator.stats().released, 4);

  const stolen = allocator.acquire({ id: 'x' }, 60).index;
  assert.equal(stolen, 0, 'the oldest release came from the oldest voice');
});

test('releasing every voice hands the next note a still-idle voice, not a steal', () => {
  const allocator = makeAllocator(2);
  allocator.acquire({ id: 'a' }, 1);
  allocator.acquire({ id: 'b' }, 2);
  allocator.allNotesOff(3);
  const voice = allocator.acquire({ id: 'c' }, 4);
  assert.equal(voice.index, 0);
  assert.deepEqual(allocator.stats().steals, 0);
  assert.deepEqual(allocator.stats().reuses, 1, 'the released voice was reused, not stolen');
});