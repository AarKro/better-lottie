// AE shapes → SVG path data.
//
// An AE shape is { vertices, inTangents, outTangents, closed } with tangents
// relative to their vertex. Shapes travel through the timeline as flat number
// arrays of one or more subpath blocks:
//   [n, closed, (vx, vy, ix, iy, ox, oy) × n,  n, closed, …]
// so they can be interpolated and simplified like any other value, and merged
// paths are just concatenated blocks.
//
// Path data is always `M` followed only by `C` commands (straight segments get
// zero tangents). Every keyframe of a morph then has the same command
// structure, which SMIL `d` interpolation requires.

import { num } from './format.js';

const K = 0.5522847498; // cubic bezier circle constant

export function shapeToArray(shape) {
  const ins = shape.inTangents || [];
  const outs = shape.outTangents || [];
  const out = [shape.vertices.length, shape.closed ? 1 : 0];
  shape.vertices.forEach((v, i) => {
    const a = ins[i] || [0, 0];
    const b = outs[i] || [0, 0];
    out.push(v[0], v[1], a[0], a[1], b[0], b[1]);
  });
  return out;
}

// Calls fn(start, n, closed) for each subpath block.
export function forEachBlock(arr, fn) {
  for (let i = 0; i < arr.length; i += 2 + 6 * arr[i]) fn(i, arr[i], arr[i + 1]);
}

// AE "Reverse Path Direction": each closed subpath starts at the same vertex
// and runs the other way (v0, vn-1, …, v1, tangents swapped). Open subpaths
// draw unchanged. Both verified against AE renders with Trim Paths.
export function reverseBlocks(arr) {
  const out = arr.slice();
  forEachBlock(arr, (start, n, closed) => {
    if (!closed) return;
    for (let k = 0; k < n; k++) {
      const src = start + 2 + ((n - k) % n) * 6, dst = start + 2 + k * 6;
      out[dst] = arr[src]; out[dst + 1] = arr[src + 1];
      out[dst + 2] = arr[src + 4]; out[dst + 3] = arr[src + 5];
      out[dst + 4] = arr[src + 2]; out[dst + 5] = arr[src + 3];
    }
  });
  return out;
}

// Shapes can morph into each other only with the same subpaths: equal point
// counts and open/closed state, block by block.
export function compatibleShapes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 2 + 6 * a[i]) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) return false;
  }
  return true;
}

export function arrayToD(arr) {
  let d = '';
  const p = (x, y) => `${num(x)} ${num(y)}`;
  forEachBlock(arr, (start, n, closed) => {
    if (n < 1) return;
    const at = (i, o) => [arr[start + 2 + i * 6 + o], arr[start + 3 + i * 6 + o]];
    const seg = (i, j) => {
      const [vx, vy] = at(i, 0), [ox, oy] = at(i, 4);
      const [wx, wy] = at(j, 0), [ix, iy] = at(j, 2);
      return `C${p(vx + ox, vy + oy)} ${p(wx + ix, wy + iy)} ${p(wx, wy)}`;
    };
    d += `M${p(...at(0, 0))}`;
    for (let i = 0; i < n - 1; i++) d += seg(i, i + 1);
    if (closed && n > 1) d += `${seg(n - 1, 0)}Z`;
  });
  return d;
}

export const shapeToD = shape => arrayToD(shapeToArray(shape));

// AE rectangle: position is the center. Roundness is clamped to half the
// shorter side. `rounded` forces the 8-point form so the point count stays
// stable while roundness animates. Sharp rects use 4 points, because
// zero-length corner segments can break stroke joins.
export function rectShape([w, h], [cx, cy], [roundness] = [0], rounded = roundness > 0) {
  const hw = Math.abs(w) / 2, hh = Math.abs(h) / 2;
  if (!rounded) {
    const z = [0, 0];
    return {
      vertices: [[cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh], [cx - hw, cy - hh]],
      inTangents: [z, z, z, z], outTangents: [z, z, z, z], closed: true,
    };
  }
  const r = Math.max(0, Math.min(roundness, hw, hh));
  const k = r * K;
  return {
    vertices: [
      [cx + hw, cy - hh + r], [cx + hw, cy + hh - r],
      [cx + hw - r, cy + hh], [cx - hw + r, cy + hh],
      [cx - hw, cy + hh - r], [cx - hw, cy - hh + r],
      [cx - hw + r, cy - hh], [cx + hw - r, cy - hh],
    ],
    inTangents: [[0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0]],
    outTangents: [[0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k], [0, 0], [k, 0]],
    closed: true,
  };
}

// AE Polygon/Star (fitted to shapes AE's "Convert To Bezier Path" produced,
// to 1e-4). With a = π / points, vertices run clockwise from -90° + rotation:
// a star alternates outer and inner radius every a, a polygon steps 2a. A
// vertex with roundness q gets handles q · r · K · sin(a) along the circle.
//
// Fractional points (n = N + f) add a partial vertex P first, centred in the
// gap left at the top. Star: P lies between inner and outer radius by f, its
// handles are scaled by f, and so are the handles of its neighbours that
// point at it. Polygon: P blends the midpoint of a rounded edge (f = 0) with
// a full vertex (f = 1); the neighbours' handles towards it scale by (1+f)/2.
// Both are continuous in n, so animated points can morph.
//
// padPoints (for animated points) always uses the fractional layout, starts
// at the first full vertex instead of P, and pads up to padPoints with
// zero-length copies of that vertex at the end (polygons first split their
// closing edge). The point count stays constant and vertices line up
// when n crosses an integer.
export function polystarShape(p, padPoints) {
  const star = p.type !== 'polygon';
  const n = Math.max(3, p.points);
  const N = Math.floor(n + 1e-9), f = Math.max(0, n - N);
  const frac = f > 1e-6 || padPoints != null;
  const a = Math.PI / n, sa = Math.sin(a);
  const base = (p.rotation - 90) * Math.PI / 180;
  const or = p.outerRadius, ir = star ? p.innerRadius : 0;
  const os = p.outerRoundness / 100, is = star ? p.innerRoundness / 100 : 0;
  const hOuter = os * or * K * sa, hInner = is * ir * K * sa;
  const pts = []; // [angle, radius, in handle, out handle]
  if (!star) {
    if (frac) {
      const mid = or * Math.cos(a) + 0.75 * hOuter * sa;
      const edge = or * sa / 2 - hOuter * Math.cos(a) / 4;
      const r = (1 - f) * mid + f * or, h = (1 - f) * edge + f * os * r * K * sa;
      pts.push([base + (N + 1) * a + Math.PI, r, h, h]);
      for (let k = 1; k <= N; k++) pts.push([base + 2 * k * a, or, hOuter, hOuter]);
      pts[1][2] *= (1 + f) / 2;
      pts[N][3] *= (1 + f) / 2;
    } else {
      for (let k = 0; k < N; k++) pts.push([base + 2 * k * a, or, hOuter, hOuter]);
    }
  } else if (frac) {
    const r = ir + (or - ir) * f, h = f * os * r * K * sa;
    pts.push([base + (2 * N + 1 + f) * a, r, h, h]);
    for (let k = 1; k <= 2 * N + 1; k++) {
      const outer = k % 2 === 0;
      pts.push([base + k * a, outer ? or : ir, outer ? hOuter : hInner, outer ? hOuter : hInner]);
    }
    pts[1][2] *= f;
    pts[2 * N + 1][3] *= f;
  } else {
    for (let k = 0; k < 2 * N; k++) {
      const outer = k % 2 === 0;
      pts.push([base + k * a, outer ? or : ir, outer ? hOuter : hInner, outer ? hOuter : hInner]);
    }
  }
  if (padPoints != null) pts.push(pts.shift());
  const [cx, cy] = p.position;
  const V = [], I = [], O = [];
  for (const [ang, r, hin, hout] of pts) {
    const c = Math.cos(ang), s = Math.sin(ang);
    V.push([cx + r * c, cy + r * s]);
    I.push([s * hin, -c * hin]);
    O.push([-s * hout, c * hout]);
  }
  const size = padPoints == null ? 0 : star ? 2 * Math.floor(padPoints) + 2 : Math.floor(padPoints) + 1;
  if (V.length < size && !star) {
    // A polygon gaining a point splits its closing edge at the new partial
    // vertex (the edge's midpoint at f = 0), and its other padding sits on v1.
    // Splitting at t = 1 - f/2 matches both ends and never changes the shape.
    const t = 1 - f / 2, m = V.length - 1, A = V[m], B = V[0];
    const c1 = [A[0] + O[m][0], A[1] + O[m][1]], c2 = [B[0] + I[0][0], B[1] + I[0][1]];
    const at = (u, w) => [u[0] + (w[0] - u[0]) * t, u[1] + (w[1] - u[1]) * t];
    const p01 = at(A, c1), p12 = at(c1, c2), p23 = at(c2, B), p012 = at(p01, p12), p123 = at(p12, p23);
    const M = at(p012, p123);
    O[m] = [p01[0] - A[0], p01[1] - A[1]];
    V.push(M); I.push([p012[0] - M[0], p012[1] - M[1]]); O.push([p123[0] - M[0], p123[1] - M[1]]);
    I[0] = [p23[0] - B[0], p23[1] - B[1]];
  }
  if (V.length < size) {
    V.push(V[0]); I.push(I[0]); O.push([0, 0]);
    while (V.length < size) { V.push(V[0]); I.push([0, 0]); O.push([0, 0]); }
    I[0] = [0, 0];
  }
  return { vertices: V, inTangents: I, outTangents: O, closed: true };
}

// AE ellipse: position is the center. 4 points, clockwise from the top.
export function ellipseShape([w, h], [cx, cy]) {
  const rx = w / 2, ry = h / 2, kx = rx * K, ky = ry * K;
  return {
    vertices: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
    inTangents: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
    outTangents: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]],
    closed: true,
  };
}
