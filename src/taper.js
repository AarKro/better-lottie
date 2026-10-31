// AE stroke Taper and Wave → filled outline polygons.
//
// SVG strokes have one width, so a variable-width stroke becomes a filled
// polygon: the centerline sampled at fixed steps, offset by half the local
// width on both sides, plus end caps. Sample counts are fixed so the
// polygon's structure stays the same over time and SMIL can interpolate `d`.
//
// Width along the visible path (s = 0..1), all fitted against AE renders:
//   taper start (s < Ls): W · (startWidth + (1 − startWidth) · ease(s / Ls))
//   taper end (s > 1 − Le): same, mirrored
//   ease(u, e): cubic bezier with handles (0, e) and (1 − e, 1); e = 0 is linear
//   wave: W · (1 − A/2 − A/2 · cos(2π · cycles · s + phase))

import { cubic, solveT } from './easing.js';
import { forEachBlock } from './path.js';

const SAMPLES = 64;
const CAP_STEPS = 6;

// tracks (see paint.js outlineTracks) as values: [width, startLength,
// endLength, startWidth, endWidth, startEase, endEase, amount, wavelength,
// cycles, phase]; trim: [visible length, start] as path fractions, or null.
export function outlineShape(shape, values, { taperUnits, waveUnits, lineCap }, trim) {
  const [width, sl, el, sw, ew, se, ee, amount, wavelength, cycles, phase] = values.map(v => v[0]);
  const out = [];
  forEachBlock(shape, (start, n, closed) => {
    if (n < 2) return;
    const line = densePolyline(shape, start, n, closed);
    const ring = closed && !trim;
    const visible = trim ? [trim[1], trim[1] + trim[0]] : [0, 1];
    const visLen = (visible[1] - visible[0]) * line.length;
    const frac = (len, units) => (units === 'pixels' ? (visLen > 0 ? len / visLen : 0) : len / 100);
    const Ls = frac(sl, taperUnits), Le = frac(el, taperUnits);
    const waveCycles = waveUnits === 'cycles' ? cycles : (wavelength > 0 ? visLen / wavelength : 0);
    const widthAt = s => {
      let f = 1;
      if (Ls > 0 && s < Ls) f = Math.min(f, sw / 100 + (1 - sw / 100) * ease(s / Ls, se / 100));
      if (Le > 0 && s > 1 - Le) f = Math.min(f, ew / 100 + (1 - ew / 100) * ease((1 - s) / Le, ee / 100));
      const A = amount / 100;
      if (A) f *= 1 - A / 2 - (A / 2) * Math.cos(2 * Math.PI * waveCycles * s + (phase * Math.PI) / 180);
      return Math.max(0, width * f);
    };

    const count = ring ? SAMPLES : SAMPLES + 1;
    const left = [], right = [], centers = [], tangents = [], widths = [];
    for (let i = 0; i < count; i++) {
      // Denser near the ends, where tapers change fastest.
      const s = ring ? i / SAMPLES : (1 - Math.cos((Math.PI * i) / SAMPLES)) / 2;
      const at = pointAt(line, visible[0] + (visible[1] - visible[0]) * s, closed);
      const w = widthAt(s) / 2;
      const nx = -at.ty, ny = at.tx;
      left.push([at.x + nx * w, at.y + ny * w]);
      right.push([at.x - nx * w, at.y - ny * w]);
      centers.push([at.x, at.y]); tangents.push([at.tx, at.ty]); widths.push(w);
    }

    if (ring) {
      out.push(...polygon(left), ...polygon(right.slice().reverse()));
      return;
    }
    const last = count - 1;
    const endCap = cap(centers[last], tangents[last], widths[last], lineCap, 1);
    const startCap = cap(centers[0], tangents[0], widths[0], lineCap, -1);
    out.push(...polygon([...left, ...endCap, ...right.slice().reverse(), ...startCap]));
  });
  return out;
}

// Taper ease curve; e = 0 is linear.
function ease(u, e) {
  u = Math.min(1, Math.max(0, u));
  e = Math.min(1, Math.max(0, e));
  return cubic(0, e, 1, 1, solveT(0, 1 - e, u));
}

// Cap points between the left and right edge at one end. `dir` is +1 at the
// end of the path, −1 at the start. Always CAP_STEPS points so the polygon's
// structure doesn't depend on the cap style.
function cap([cx, cy], [tx, ty], w, lineCap, dir) {
  const pts = [];
  const nx = -ty, ny = tx;
  for (let i = 1; i <= CAP_STEPS; i++) {
    const a = (i / (CAP_STEPS + 1)) * Math.PI; // sweeps from the left edge around to the right edge
    const across = Math.cos(a) * dir, along = Math.sin(a) * dir;
    if (lineCap === 'round') {
      pts.push([cx + (nx * across + tx * along) * w, cy + (ny * across + ty * along) * w]);
    } else if (lineCap === 'square') {
      const k = Math.min(1 / Math.abs(Math.cos(a) || 1e-9), 1 / Math.abs(Math.sin(a) || 1e-9));
      pts.push([cx + (nx * across + tx * along) * w * k, cy + (ny * across + ty * along) * w * k]);
    } else {
      pts.push([cx + nx * across * w, cy + ny * across * w]);
    }
  }
  return pts;
}

// Points with zero tangents as one closed shape-array block.
function polygon(points) {
  const out = [points.length, 1];
  for (const [x, y] of points) out.push(x, y, 0, 0, 0, 0);
  return out;
}

// One block as a dense polyline with cumulative lengths.
function densePolyline(arr, start, n, closed) {
  const at = (i, o) => [arr[start + 2 + i * 6 + o], arr[start + 3 + i * 6 + o]];
  const pts = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const p0 = at(i, 0), p3 = at(j, 0);
    const p1 = [p0[0] + at(i, 4)[0], p0[1] + at(i, 4)[1]];
    const p2 = [p3[0] + at(j, 2)[0], p3[1] + at(j, 2)[1]];
    for (let s = 0; s < 32; s++) {
      const u = s / 32;
      pts.push([cubic(p0[0], p1[0], p2[0], p3[0], u), cubic(p0[1], p1[1], p2[1], p3[1], u)]);
    }
  }
  pts.push(closed ? pts[0] : at(n - 1, 0));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, length: cum[cum.length - 1] };
}

// Point and unit tangent at fraction f of the polyline (wrapping when closed).
function pointAt({ pts, cum, length }, f, closed) {
  if (closed) f -= Math.floor(f);
  else f = Math.min(1, Math.max(0, f));
  const d = f * length;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  let tx = b[0] - a[0], ty = b[1] - a[1];
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tx, ty };
}
