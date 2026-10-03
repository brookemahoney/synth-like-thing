// A probe is a single arrow-function expression receiving h. Run it with:
//   node scripts/verify.mjs rms mysession probes/example.mjs
//
// h gives you: h.params (schema-checked, real units), h.get, h.sample (awaited),
// h.hold, h.release, h.transport, h.live, h.silence, and the raw h.rms/h.peak/h.band
// readers. h.params throws on a key the schema does not declare rather than
// silently leaving the feature untouched.

async (h) => {
  const applied = h.params({
    'osc1.level': 0.8,
    'osc2.level': 0,
    'osc3.level': 0,
    'filter1.resonance': 30, // real units: 0.5..30, not 0..1
  });

  await h.hold(57, { ms: 500, id: 'p1' });
  const held = await h.sample(30, 60);
  await h.release('p1');

  const quiet = await h.sample(10, 60);
  await h.silence(300);

  return {
    applied,
    held: { mean: held.mean, peak: held.peak, distinct: held.distinct, variance: held.variance },
    afterRelease: { mean: quiet.mean },
  };
}
