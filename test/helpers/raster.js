// Tiny PNG decoder and polygon rasterizer for comparing converter geometry
// against AE renders (test/ae/frames) without a browser.

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

// 8-bit RGB/RGBA, non-interlaced → { width, height, channels, data }
export function readPng(file) {
  const b = readFileSync(file);
  let o = 8, width, height, depth, type;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), id = b.toString('latin1', o + 4, o + 8), body = b.subarray(o + 8, o + 8 + len);
    if (id === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; }
    if (id === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const ch = type === 6 ? 4 : 3, stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * ch);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? data[dst + x - ch] : 0, up = y ? data[dst - stride + x] : 0, ul = y && x >= ch ? data[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
      data[dst + x] = v & 255;
    }
  }
  return { width, height, channels: ch, data };
}

// Shape array (path.js layout) → closed polylines.
export function flatten(arr, m = [1, 0, 0, 1, 0, 0], steps = 24) {
  const ap = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const polys = [];
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) {
    const n = arr[s], pts = [];
    for (let i = 0; i < n; i++) {
      const o = s + 2 + i * 6, w = s + 2 + ((i + 1) % n) * 6;
      if (!arr[s + 1] && i === n - 1) { pts.push(ap(arr[o], arr[o + 1])); break; }
      const p0 = [arr[o], arr[o + 1]], p1 = [arr[o] + arr[o + 4], arr[o + 1] + arr[o + 5]];
      const p2 = [arr[w] + arr[w + 2], arr[w + 1] + arr[w + 3]], p3 = [arr[w], arr[w + 1]];
      for (let k = 0; k < steps; k++) {
        const u = k / steps, v = 1 - u;
        const c = [v * v * v, 3 * v * v * u, 3 * v * u * u, u * u * u];
        pts.push(ap(c[0] * p0[0] + c[1] * p1[0] + c[2] * p2[0] + c[3] * p3[0], c[0] * p0[1] + c[1] * p1[1] + c[2] * p2[1] + c[3] * p3[1]));
      }
    }
    polys.push(pts);
  }
  return polys;
}

// Nonzero coverage per pixel (0..1), 16 × 16 subsamples.
export function rasterize(polys, width, height, ss = 16) {
  const cov = new Float32Array(width * height);
  const edges = [];
  for (const p of polys) for (let i = 0; i < p.length; i++) edges.push([p[i], p[(i + 1) % p.length]]);
  for (let sy = 0; sy < height * ss; sy++) {
    const y = (sy + 0.5) / ss, xs = [];
    for (const [a, b] of edges) {
      if ((a[1] <= y) === (b[1] <= y)) continue;
      xs.push([a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    const row = Math.floor(sy / ss) * width;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k][1];
      if (!wind) continue;
      const x0 = Math.max(0, xs[k][0]), x1 = Math.min(width, xs[k + 1][0]);
      for (let px = Math.floor(x0); px < x1; px++) {
        const l = Math.max(x0, px), r = Math.min(x1, px + 1);
        if (r > l) cov[row + px] += (r - l) / ss;
      }
    }
  }
  return cov;
}
