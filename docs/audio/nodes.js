/**
 * nodes.js — every audio node in the instrument is born here, so every one of
 * them is counted.
 *
 * WHY
 *   The plan's worst failure mode is a voice that outlives its note, and the
 *   symptom is not a crash: it is silence that never comes back, or a
 *   background hum that grows as you play. Neither is visible in the UI, so the
 *   instrument keeps a live tally of nodes and their kinds, and the runtime
 *   handle (task 13) and the self-validation steps read it. "Fire two hundred
 *   notes and the count comes back down" is checkable; "it sounded fine" is not.
 *
 *   A tally is not proof on its own — a forgotten `retire()` would inflate it
 *   without a sound — so it is read alongside the output level: a leaked
 *   oscillator both inflates the count and holds the meter up.
 *
 *   Nodes are created through these factories rather than through
 *   `context.createGain()` so that there is no way to make one by accident:
 *
 *     createGain(context, label)            -> GainNode
 *     createConstantSource(context, label)  -> ConstantSourceNode
 *     createOscillator(context, label)      -> OscillatorNode
 *     createBufferSource(context, label)    -> AudioBufferSourceNode
 *
 *     trackNode(node, label) / retireNode(node)
 *     nodeStats()   { live, created, retired, byLabel: { label: {...} } }
 *     resetNodeStats()   diagnostics only — zeroes the tallies
 */

const labels = new WeakMap();
const tally = new Map();

function entry(label) {
  let row = tally.get(label);
  if (!row) {
    row = { live: 0, created: 0, retired: 0 };
    tally.set(label, row);
  }
  return row;
}

/** Count a node as live. Retired exactly once, when it is torn down. */
export function trackNode(node, label = node.constructor?.name ?? 'node') {
  labels.set(node, label);
  const row = entry(label);
  row.created += 1;
  row.live += 1;
  return node;
}

/** Count a node as gone. Safe to call twice; the second call is a no-op. */
export function retireNode(node) {
  const label = labels.get(node);
  if (label === undefined) return false;
  labels.delete(node);
  const row = entry(label);
  row.retired += 1;
  row.live -= 1;
  return true;
}

/** Is this node one of ours, and what is it called? */
export function nodeLabel(node) {
  return labels.get(node);
}

export function nodeStats() {
  const byLabel = {};
  let live = 0;
  let created = 0;
  let retired = 0;
  for (const [label, row] of tally) {
    byLabel[label] = { ...row };
    live += row.live;
    created += row.created;
    retired += row.retired;
  }
  return { live, created, retired, byLabel };
}

/** Zero the tallies. Diagnostics only: it does not touch the audio graph. */
export function resetNodeStats() {
  tally.clear();
}

/* --------------------------------------------------------- the factories --- */

export function createGain(context, label) {
  return trackNode(context.createGain(), label ?? 'gain');
}

export function createConstantSource(context, label) {
  return trackNode(context.createConstantSource(), label ?? 'constantSource');
}

export function createOscillator(context, label) {
  return trackNode(context.createOscillator(), label ?? 'oscillator');
}

export function createBufferSource(context, label) {
  return trackNode(context.createBufferSource(), label ?? 'bufferSource');
}