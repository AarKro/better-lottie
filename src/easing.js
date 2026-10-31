// AE temporal easing ↔ cubic bezier math.
//
// AE stores easing per keyframe side as { speed, influence }:
//   influence: how far (0..100 %) the handle reaches into the segment, in time
//   speed:     the value velocity (units/s) at the keyframe
// A segment A→B is a cubic bezier in (time, value) space with handles
//   P1 = (tA + x1·d, vA + speedOut·x1·d)
//   P2 = (tB − (1−x2)·d, vB − speedIn·(1−x2)·d)
// Normalizing by d and Δv gives the [x1, y1, x2, y2] that SMIL keySplines use.

export const LINEAR = [0, 0, 1, 1];

// Linear sides use a handle on the diagonal at 1/6, like bodymovin does.
const LINEAR_X1 = 1 / 6;
const LINEAR_X2 = 5 / 6;

export const cubic = (p0, p1, p2, p3, s) => {
  const m = 1 - s;
  return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3;
};

// Bezier parameter at which the time curve (0, x1, x2, 1) reaches u.
// x1, x2 ∈ [0, 1] keep that curve monotonic, so bisection is safe.
export function solveT(x1, x2, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0, hi = 1, s = u;
  for (let i = 0; i < 60; i++) {
    const x = cubic(0, x1, x2, 1, s);
    if (Math.abs(x - u) < 1e-10) break;
    if (x < u) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return s;
}

// Progress (0..1, may overshoot) of a normalized spline at time fraction u.
export function splineAt([x1, y1, x2, y2], u) {
  return cubic(0, y1, y2, 1, solveT(x1, x2, u));
}

export const outType = k => k.outType || (k.easeOut ? 'bezier' : 'linear');
export const inType = k => k.inType || (k.easeIn ? 'bezier' : 'linear');
export const isHold = (A, B) => outType(A) === 'hold' || inType(B) === 'hold';

const clamp01 = x => Math.min(1, Math.max(0, x));
const pick = (list, dim) => list[Math.min(dim, list.length - 1)];

// Handles of one dimension of segment A→B. `avg` is that dimension's average
// velocity over the segment (Δv / d); linear sides follow it exactly.
// Returns time handles x1/x2 (fractions of d) and value offsets dv1/dv2.
export function aeHandles(A, B, dim, avg, d) {
  const out = outType(A) === 'bezier' && A.easeOut ? pick(A.easeOut, dim) : null;
  const inn = inType(B) === 'bezier' && B.easeIn ? pick(B.easeIn, dim) : null;
  const x1 = out ? clamp01(out.influence / 100) : LINEAR_X1;
  const x2 = inn ? 1 - clamp01(inn.influence / 100) : LINEAR_X2;
  const s1 = out ? out.speed : avg;
  const s2 = inn ? inn.speed : avg;
  return { x1, x2, dv1: s1 * x1 * d, dv2: s2 * (1 - x2) * d };
}

// Value of one dimension at time fraction u, straight from the AE handles.
// Works for every case, including overshoot and "bumps" between equal values.
export function easeValue(a, b, h, u) {
  return cubic(a, a + h.dv1, b - h.dv2, b, solveT(h.x1, h.x2, u));
}

// Handles → SMIL keySpline, or null when SMIL can't express it
// (keySplines values must all lie in [0, 1], so overshoot is out).
export function normalizeHandles(h, delta) {
  const y1 = h.dv1 / delta;
  const y2 = 1 - h.dv2 / delta;
  const tol = 1e-6;
  if (y1 < -tol || y1 > 1 + tol || y2 < -tol || y2 > 1 + tol) return null;
  if (Math.abs(h.x1 - y1) < 1e-4 && Math.abs(h.x2 - y2) < 1e-4) return LINEAR;
  return [h.x1, clamp01(y1), h.x2, clamp01(y2)];
}

export const isLinearSpline = s =>
  s === LINEAR || (Math.abs(s[0] - s[1]) < 1e-4 && Math.abs(s[2] - s[3]) < 1e-4);
