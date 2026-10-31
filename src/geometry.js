// Operations on shape arrays (see path.js): transforms, orientation, length.

import { cubic } from './easing.js';
import { forEachBlock } from './path.js';

// Affine matrix [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f)
// of AE's translate(position) · rotate · scale · translate(−anchor).
export function transformMatrix(position, rotation, scale, anchor) {
  const r = (rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const sx = scale[0] / 100, sy = scale[1] / 100;
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  return [a, b, c, d, position[0] - (a * anchor[0] + c * anchor[1]), position[1] - (b * anchor[0] + d * anchor[1])];
}

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// Vertices get the full transform, tangents (relative) only the linear part.
export function transformShape(arr, m) {
  const out = arr.slice();
  forEachBlock(arr, (start, n) => {
    for (let i = 0; i < n; i++) {
      const o = start + 2 + i * 6;
      out[o] = m[0] * arr[o] + m[2] * arr[o + 1] + m[4];
      out[o + 1] = m[1] * arr[o] + m[3] * arr[o + 1] + m[5];
      for (const t of [o + 2, o + 4]) {
        out[t] = m[0] * arr[t] + m[2] * arr[t + 1];
        out[t + 1] = m[1] * arr[t] + m[3] * arr[t + 1];
      }
    }
  });
  return out;
}

// Points along each cubic segment of one block, for area and length.
function samplePoints(arr, start, n, closed, steps = 16) {
  const pts = [];
  const at = (i, o) => [arr[start + 2 + i * 6 + o], arr[start + 3 + i * 6 + o]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const p0 = at(i, 0), p3 = at(j, 0);
    const p1 = [p0[0] + at(i, 4)[0], p0[1] + at(i, 4)[1]];
    const p2 = [p3[0] + at(j, 2)[0], p3[1] + at(j, 2)[1]];
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      pts.push([cubic(p0[0], p1[0], p2[0], p3[0], u), cubic(p0[1], p1[1], p2[1], p3[1], u)]);
    }
  }
  if (!closed && n) pts.push(at(n - 1, 0));
  return pts;
}

// Signed area of one block (y-down: positive = clockwise on screen).
export function blockArea(arr, start) {
  const pts = samplePoints(arr, start, arr[start], true);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

// Same subpaths, every block wound clockwise. With fill-rule nonzero the
// result fills the union of the blocks.
export function orientClockwise(arr) {
  const out = [];
  forEachBlock(arr, (start, n) => {
    const block = arr.slice(start, start + 2 + 6 * n);
    out.push(...(blockArea(arr, start) < 0 ? reverseBlock(block) : block));
  });
  return out;
}

function reverseBlock(block) {
  const n = block[0], out = [n, block[1]];
  for (let i = n - 1; i >= 0; i--) {
    const o = 2 + i * 6;
    out.push(block[o], block[o + 1], block[o + 4], block[o + 5], block[o + 2], block[o + 3]);
  }
  return out;
}

export function shapeLength(arr) {
  let len = 0;
  forEachBlock(arr, (start, n, closed) => {
    const pts = samplePoints(arr, start, n, closed);
    if (closed && pts.length) pts.push(pts[0]);
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  });
  return len;
}
