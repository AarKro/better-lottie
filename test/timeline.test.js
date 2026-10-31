import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, propToTrack, propValueAt, trackValueAt, trackToSmil } from '../src/timeline.js';

const EASY = [{ speed: 0, influence: 33.333 }];
const ctx = { fps: 30, warn: () => {} };
const near = (a, b, eps) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= eps, `${a} vs ${b} (±${eps})`));

// The SMIL track must reproduce AE's curve, not just its keyframes.
function assertTrackMatchesAE(prop, kind, eps, frames = 60) {
  const track = propToTrack(prop, kind, ctx);
  const k = prop.keyframes;
  const t0 = k[0].t, t1 = k[k.length - 1].t;
  for (let i = 0; i <= frames; i++) {
    const t = t0 + ((t1 - t0) * i) / frames;
    near(trackValueAt(track, t), propValueAt(prop, kind, t), eps);
  }
  return track;
}

test('eased 1D segment is exact, with no extra stops', () => {
  const prop = { keyframes: [{ t: 0, v: 0, easeOut: EASY }, { t: 1, v: 90, easeIn: EASY }] };
  const track = assertTrackMatchesAE(prop, KIND.scalar, 1e-6);
  assert.equal(track.stops.length, 2);
});

test('straight eased motion is exact', () => {
  const prop = { keyframes: [{ t: 0, v: [0, 0], easeOut: EASY }, { t: 2, v: [100, 50], easeIn: EASY }] };
  assert.equal(assertTrackMatchesAE(prop, KIND.point, 1e-6).stops.length, 2);
});

test('curved motion path is baked within tolerance', () => {
  const prop = { keyframes: [
    { t: 0, v: [0, 0], spatialOut: [50, -100], easeOut: EASY },
    { t: 1, v: [200, 0], spatialIn: [-50, -100], easeIn: EASY },
  ] };
  const track = propToTrack(prop, KIND.point, ctx);
  assert.ok(track.stops.length > 2);
  for (let f = 0; f <= 30; f++) near(trackValueAt(track, f / 30), propValueAt(prop, KIND.point, f / 30), 0.02);
});

test('overshoot is baked and still overshoots', () => {
  const prop = { keyframes: [{ t: 0, v: 0 }, { t: 1, v: 100, easeIn: [{ speed: -300, influence: 50 }] }] };
  const track = propToTrack(prop, KIND.scalar, ctx);
  for (let f = 0; f <= 30; f++) near(trackValueAt(track, f / 30), propValueAt(prop, KIND.scalar, f / 30), 0.02);
  assert.ok(Math.max(...track.stops.map(s => s.v[0])) > 100);
});

test('per-dimension eases that differ are baked', () => {
  const prop = { keyframes: [
    { t: 0, v: [0, 0], easeOut: [{ speed: 0, influence: 33.333 }, { speed: 0, influence: 90 }] },
    { t: 1, v: [100, 100] },
  ] };
  assert.ok(assertTrackMatchesAE(prop, KIND.vec2, 0.02, 30).stops.length > 2);
});

test('mismatched path point counts hold and warn', () => {
  const sq = n => ({ closed: true, vertices: Array.from({ length: n }, (_, i) => [i, 0]) });
  const warnings = [];
  const track = propToTrack({ keyframes: [{ t: 0, v: sq(3) }, { t: 1, v: sq(4) }] }, KIND.shape,
    { fps: 30, warn: m => warnings.push(m) });
  assert.ok(track.segs[0].hold);
  assert.equal(warnings.length, 1);
});

test('smil covers [0, D] and expands holds into jumps', () => {
  const track = propToTrack({ keyframes: [
    { t: 0.5, v: 0, outType: 'hold' }, { t: 1, v: 10, easeOut: EASY }, { t: 1.5, v: 20, easeIn: EASY },
  ] }, KIND.scalar, ctx);
  const smil = trackToSmil(track, 2, 30);
  assert.equal(smil.calcMode, 'spline');
  assert.equal(smil.keyTimes[0], 0);
  assert.equal(smil.keyTimes.at(-1), 1);
  assert.equal(smil.keySplines.length, smil.values.length - 1);
  assert.deepEqual(smil.values.map(v => v[0]), [0, 0, 0, 10, 20, 20]);
  for (let i = 1; i < smil.keyTimes.length; i++) assert.ok(smil.keyTimes[i] > smil.keyTimes[i - 1]);
});

test('all-hold tracks become discrete', () => {
  const track = propToTrack({ keyframes: [{ t: 0, v: 1, outType: 'hold' }, { t: 1, v: 2 }] }, KIND.scalar, ctx);
  assert.equal(trackToSmil(track, 2, 30).calcMode, 'discrete');
});

test('keyframes outside the comp are clipped to [0, D]', () => {
  const track = propToTrack({ keyframes: [{ t: -1, v: 0 }, { t: 1, v: 100 }] }, KIND.scalar, ctx);
  const smil = trackToSmil(track, 2, 30);
  near(smil.values[0], [50], 1e-6);
  assert.equal(smil.keyTimes.at(-1), 1);
});
