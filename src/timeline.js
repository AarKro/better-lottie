// Keyframed IR properties → tracks → SMIL timing attributes.
//
// A track is the timeline of one value:
//   stops: [{ t, v }]                    v is a flat number array
//   segs:  [{ spline } | { hold: true }] segs[i] runs stops[i] → stops[i+1]
// Segments that SMIL can express exactly keep their keyframes and get a
// keySpline. Everything else is baked: sampled once per frame, then simplified.

import {
  LINEAR, aeHandles, easeValue, isHold, isLinearSpline, normalizeHandles, splineAt, cubic,
} from './easing.js';
import { compatibleShapes, shapeToArray } from './path.js';

const EPS = 1e-9;
const HOLD = { hold: true };

// How each kind of property is interpolated:
//   spatial:  AE moves along a motion path; speed is px/s along that path
//   progress: interpolated as one 0..1 progress (colors, paths)
//   tol:      max error allowed when simplifying baked samples (in IR units)
export const KIND = {
  scalar: { toArray: v => [Array.isArray(v) ? v[0] : v], tol: 0.01 },
  vec2: { toArray: v => [v[0], v[1]], tol: 0.01 },
  point: { toArray: v => [v[0], v[1]], tol: 0.01, spatial: true },
  color: { toArray: v => [v[0], v[1], v[2]], tol: 0.001, progress: true },
  shape: { toArray: shapeToArray, tol: 0.01, progress: true, shape: true },
};

// Props may be given as { value }, { keyframes }, or a bare value.
export function asProp(p) {
  if (p && typeof p === 'object' && !Array.isArray(p) && ('keyframes' in p || 'value' in p)) return p;
  return { value: p };
}

export const isAnimated = p => {
  const k = asProp(p).keyframes;
  return Array.isArray(k) && k.length > 1;
};

export function staticValue(p) {
  p = asProp(p);
  return p.keyframes && p.keyframes.length ? p.keyframes[0].v : p.value;
}

// --- spatial (motion path) helpers ---

function spatialCtrl(A, B) {
  const a = [A.v[0], A.v[1]], b = [B.v[0], B.v[1]];
  const so = A.spatialOut || [0, 0], si = B.spatialIn || [0, 0];
  return [a, [a[0] + so[0], a[1] + so[1]], [b[0] + si[0], b[1] + si[1]], b];
}

// A motion path is straight when both handles lie on the segment itself.
function isStraight([a, c1, c2, b]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  if (L2 < EPS) return Math.hypot(c1[0] - a[0], c1[1] - a[1]) < 1e-6 && Math.hypot(c2[0] - b[0], c2[1] - b[1]) < 1e-6;
  const onSeg = ([x, y]) => {
    const cx = x - a[0], cy = y - a[1];
    const dot = cx * dx + cy * dy;
    return Math.abs(cx * dy - cy * dx) <= 1e-4 * L2 && dot >= -1e-6 && dot <= L2 * (1 + 1e-6);
  };
  return onSeg(c1) && onSeg(c2);
}

function arcTable(ctrl, n = 64) {
  const pts = [], len = [0];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push([0, 1].map(c => cubic(ctrl[0][c], ctrl[1][c], ctrl[2][c], ctrl[3][c], s)));
    if (i) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, len, L: len[n] };
}

function pointAtDist({ pts, len, L }, dist) {
  if (dist <= 0) return pts[0].slice();
  if (dist >= L) return pts[pts.length - 1].slice();
  let i = 1;
  while (len[i] < dist) i++;
  const f = (dist - len[i - 1]) / (len[i] - len[i - 1] || 1);
  return [0, 1].map(c => pts[i - 1][c] + (pts[i][c] - pts[i - 1][c]) * f);
}

// --- evaluating AE keyframes ---

function segmentValueAt(A, B, kind, t) {
  const a = kind.toArray(A.v), b = kind.toArray(B.v);
  if (isHold(A, B) || (kind.shape && !compatibleShapes(a, b))) return a;
  const d = B.t - A.t, u = (t - A.t) / d;
  if (kind.spatial) {
    const tab = arcTable(spatialCtrl(A, B));
    return pointAtDist(tab, easeValue(0, tab.L, aeHandles(A, B, 0, tab.L / d, d), u));
  }
  if (kind.progress) {
    const p = easeValue(0, 1, aeHandles(A, B, 0, 1 / d, d), u);
    return a.map((x, i) => x + (b[i] - x) * p);
  }
  return a.map((x, i) => easeValue(x, b[i], aeHandles(A, B, i, (b[i] - x) / d, d), u));
}

// Value of an IR prop at time t, exactly as AE would compute it.
export function propValueAt(prop, kind, t) {
  prop = asProp(prop);
  const k = prop.keyframes;
  if (!k || !k.length) return kind.toArray(prop.value);
  if (t <= k[0].t) return kind.toArray(k[0].v);
  for (let i = 0; i < k.length - 1; i++) {
    if (t < k[i + 1].t) return segmentValueAt(k[i], k[i + 1], kind, t);
  }
  return kind.toArray(k[k.length - 1].v);
}

// SMIL keySpline reproducing segment A→B exactly, or null if there is none.
// A single spline drives all dimensions, so per-dimension curves must agree.
function exactSpline(A, B, kind) {
  const d = B.t - A.t;
  if (kind.spatial) {
    const ctrl = spatialCtrl(A, B);
    if (!isStraight(ctrl)) return null;
    const L = Math.hypot(ctrl[3][0] - ctrl[0][0], ctrl[3][1] - ctrl[0][1]);
    if (L < EPS) return LINEAR;
    return normalizeHandles(aeHandles(A, B, 0, L / d, d), L);
  }
  if (kind.progress) return normalizeHandles(aeHandles(A, B, 0, 1 / d, d), 1);
  const a = kind.toArray(A.v), b = kind.toArray(B.v);
  let spline = null;
  for (let i = 0; i < a.length; i++) {
    const delta = b[i] - a[i];
    const h = aeHandles(A, B, i, delta / d, d);
    if (Math.abs(delta) < EPS) {
      // Equal values but nonzero speed: AE bumps away and back.
      if (Math.abs(h.dv1) > 1e-7 || Math.abs(h.dv2) > 1e-7) return null;
      continue;
    }
    const s = normalizeHandles(h, delta);
    if (!s) return null;
    if (!spline) spline = s;
    else if (s.some((x, j) => Math.abs(x - spline[j]) > 1e-3)) return null;
  }
  return spline || LINEAR;
}

// --- tracks ---

// Douglas–Peucker over time: keep the samples that linear interpolation
// between their neighbours can't reproduce within `tol`.
export function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = pts.map((_, i) => i === 0 || i === pts.length - 1);
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxErr = 0, idx = -1;
    for (let m = i + 1; m < j; m++) {
      const f = (pts[m].t - pts[i].t) / (pts[j].t - pts[i].t);
      let err = 0;
      for (let c = 0; c < pts[m].v.length; c++) {
        const lerp = pts[i].v[c] + (pts[j].v[c] - pts[i].v[c]) * f;
        err = Math.max(err, Math.abs(lerp - pts[m].v[c]));
      }
      if (err > maxErr) { maxErr = err; idx = m; }
    }
    if (maxErr > tol) {
      keep[idx] = true;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Track of any function of time, sampled once per frame over [t0, t1].
export function bakeFunction(fn, t0, t1, fps, tol) {
  const step = 1 / fps, pts = [];
  for (let j = 0; t0 + j * step < t1 - step * 1e-3; j++) pts.push({ t: t0 + j * step, v: fn(t0 + j * step) });
  pts.push({ t: t1, v: fn(t1) });
  const stops = simplify(pts, tol);
  return { stops, segs: stops.slice(1).map(() => ({ spline: LINEAR })) };
}

// ctx: { fps, warn(message) }
export function propToTrack(prop, kind, ctx) {
  prop = asProp(prop);
  const k = prop.keyframes;
  if (!k || k.length < 2) {
    return { stops: [{ t: 0, v: kind.toArray(k && k.length ? k[0].v : prop.value) }], segs: [] };
  }
  const stops = [{ t: k[0].t, v: kind.toArray(k[0].v) }];
  const segs = [];
  const step = 1 / ctx.fps;
  for (let i = 0; i < k.length - 1; i++) {
    const A = k[i], B = k[i + 1];
    const vA = stops[stops.length - 1].v, vB = kind.toArray(B.v);
    if (!(B.t > A.t)) { ctx.warn('keyframes are not in time order (skipped one)'); continue; }
    if (kind.shape && !compatibleShapes(vA, vB)) {
      ctx.warn('path keyframes differ in point count or open/closed state; they switch instead of morphing');
      segs.push(HOLD); stops.push({ t: B.t, v: vB });
      continue;
    }
    if (isHold(A, B)) { segs.push(HOLD); stops.push({ t: B.t, v: vB }); continue; }
    const spline = exactSpline(A, B, kind);
    if (spline) { segs.push({ spline }); stops.push({ t: B.t, v: vB }); continue; }
    const run = [stops[stops.length - 1]];
    for (let j = 1; A.t + j * step < B.t - step * 1e-3; j++) {
      const t = A.t + j * step;
      run.push({ t, v: segmentValueAt(A, B, kind, t) });
    }
    run.push({ t: B.t, v: vB });
    for (const s of simplify(run, kind.tol).slice(1)) { segs.push({ spline: LINEAR }); stops.push(s); }
  }
  return { stops, segs };
}

export function mapTrack(track, fn) {
  return { stops: track.stops.map(s => ({ t: s.t, v: fn(s.v) })), segs: track.segs };
}

const sameArr = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < EPS);

export const trackIsStatic = track => track.stops.every(s => sameArr(s.v, track.stops[0].v));

export function trackValueAt({ stops, segs }, t) {
  if (t <= stops[0].t) return stops[0].v;
  for (let i = 0; i < segs.length; i++) {
    const A = stops[i], B = stops[i + 1];
    if (t < B.t) {
      if (segs[i].hold) return A.v;
      const p = splineAt(segs[i].spline, (t - A.t) / (B.t - A.t));
      return A.v.map((x, c) => x + (B.v[c] - x) * p);
    }
  }
  return stops[stops.length - 1].v;
}

// Track → { calcMode, values, keyTimes, keySplines } spanning exactly [0, D].
export function trackToSmil(track, D, fps, tol = 0.01) {
  let { stops, segs } = track;
  if (stops[0].t < 0 || stops[stops.length - 1].t > D) {
    // Keyframes outside the comp: resample the visible part.
    ({ stops, segs } = bakeFunction(t => trackValueAt(track, t), 0, D, fps, tol));
  }
  stops = stops.slice();
  segs = segs.slice();
  if (stops[0].t > 0) { stops.unshift({ t: 0, v: stops[0].v }); segs.unshift(HOLD); }
  if (stops[stops.length - 1].t < D) { stops.push({ t: D, v: stops[stops.length - 1].v }); segs.push(HOLD); }

  if (segs.every(s => s.hold)) {
    return { calcMode: 'discrete', values: stops.map(s => s.v), keyTimes: stops.map(s => s.t / D), keySplines: null };
  }

  // Mixed: a hold becomes "stay at A until just before B, then jump".
  const eps = D * 1e-4;
  const values = [stops[0].v], times = [0], splines = [];
  segs.forEach((seg, i) => {
    const A = stops[i], B = stops[i + 1];
    if (seg.hold) {
      if (!sameArr(A.v, B.v) && B.t - eps > A.t) {
        values.push(A.v); times.push(B.t - eps); splines.push(LINEAR);
      }
      splines.push(LINEAR);
    } else {
      splines.push(seg.spline);
    }
    values.push(B.v); times.push(B.t);
  });
  const linear = splines.every(isLinearSpline);
  return {
    calcMode: linear ? 'linear' : 'spline',
    values,
    keyTimes: times.map(t => t / D),
    keySplines: linear ? null : splines,
  };
}

// Track → { value, smil }. `value` is the value at t = 0 (the static fallback).
export function finalizeTrack(track, D, fps, tol) {
  if (trackIsStatic(track)) return { value: track.stops[0].v, smil: null };
  const smil = trackToSmil(track, D, fps, tol);
  return { value: smil.values[0], smil };
}
