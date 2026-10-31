// AE shapes → SVG path data.
//
// An AE shape is { vertices, inTangents, outTangents, closed } with tangents
// relative to their vertex. Shapes travel through the timeline as flat number
// arrays [closed, vx, vy, ix, iy, ox, oy, …] so they can be interpolated and
// simplified like any other value.
//
// Path data is always `M` followed only by `C` commands (straight segments get
// zero tangents). Every keyframe of a morph then has the same command
// structure, which SMIL `d` interpolation requires.

import { num } from './format.js';

const K = 0.5522847498; // cubic bezier circle constant

export function shapeToArray(shape) {
  const out = [shape.closed ? 1 : 0];
  const ins = shape.inTangents || [];
  const outs = shape.outTangents || [];
  shape.vertices.forEach((v, i) => {
    const a = ins[i] || [0, 0];
    const b = outs[i] || [0, 0];
    out.push(v[0], v[1], a[0], a[1], b[0], b[1]);
  });
  return out;
}

// Two shape arrays can morph into each other only with equal point counts
// and the same open/closed state.
export const compatibleShapes = (a, b) => a.length === b.length && a[0] === b[0];

export function arrayToD(arr) {
  const n = (arr.length - 1) / 6;
  if (n < 1) return '';
  const at = (i, o) => [arr[1 + i * 6 + o], arr[2 + i * 6 + o]];
  const p = (x, y) => `${num(x)} ${num(y)}`;
  const seg = (i, j) => {
    const [vx, vy] = at(i, 0), [ox, oy] = at(i, 4);
    const [wx, wy] = at(j, 0), [ix, iy] = at(j, 2);
    return `C${p(vx + ox, vy + oy)} ${p(wx + ix, wy + iy)} ${p(wx, wy)}`;
  };
  let d = `M${p(...at(0, 0))}`;
  for (let i = 0; i < n - 1; i++) d += seg(i, i + 1);
  if (arr[0] && n > 1) d += `${seg(n - 1, 0)}Z`;
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
