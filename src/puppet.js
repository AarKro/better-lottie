// Puppet effect (ADBE FreePin3): deforms a shape layer's paths with AE's own
// triangle mesh and its position pins, baked once per frame.
//
// AE doesn't publish its solver. The Advanced engine behaves like linear
// blend skinning with bounded biharmonic weights and automatic pin rotations
// (Jacobson et al. 2011, "Bounded Biharmonic Weights"; 2012, "Fast Automatic
// Skinning Transformations"): each pin gets an affine transform, its
// translation fixed by the pin and the rest found by local/global ARAP
// iterations, as many as "Mesh Rotation Refinement". Plain ARAP on the mesh
// and Igarashi's two-step method were tried and fit AE's renders worse (IoU
// 0.90 and 0.92 vs 0.97 on a bent bar). The mesh itself (rest positions and
// triangles) comes from the saved project, so pins sit exactly where AE has
// them; only the solve is approximate.
//
// Spaces: shape layers are always continuously rasterized, so AE applies
// the Puppet *after* the layer's transform: mesh and pins live in comp space,
// normalized by the comp's larger side (verified: moving or scaling the layer
// slides its content under a mesh that stays put; content outside the mesh is
// not deformed). Each frame, paths go through their groups and the layer's
// transform chain (parents included) into comp space, get deformed, and come
// back, so the SVG's transform groups put them in place again.

import { KIND, bakeFunction, mapTrack, propValueAt, trackValueAt } from './timeline.js';
import { multiply, transformMatrix, transformShape } from './geometry.js';
import { matrixTrack } from './transform.js';
import { geometryTrack } from './shapes.js';

const MESH_MAGIC = 0xad0beb0a;

// The saved mesh ('fpms' chunk, big-endian):
//   u16 version, f32 × 4 bounds, u32 nOutline, nOutline × (f32, f32),
//   u32 magic 0xad0beb0a, u32 1, u8 flags,
//   u32 nv, nv × (f64 x, f64 y) normalized,
//   u32 nt, nt × (u32 a, u32 b, u32 c), padding.
export function decodeMesh(hex) {
  if (typeof hex !== 'string' || hex.length < 44 || hex.length % 2) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  const has = n => o + n <= bytes.length;
  let o = 18;
  if (!has(4)) return null;
  const nOutline = view.getUint32(o); o += 4 + nOutline * 8;
  if (!has(13) || view.getUint32(o) !== MESH_MAGIC) return null;
  o += 9;
  const nv = view.getUint32(o); o += 4;
  if (!has(nv * 16 + 4)) return null;
  const vertices = [];
  for (let i = 0; i < nv; i++, o += 16) vertices.push([view.getFloat64(o), view.getFloat64(o + 8)]);
  const nt = view.getUint32(o); o += 4;
  if (!has(nt * 12)) return null;
  const triangles = [];
  for (let i = 0; i < nt; i++, o += 12) {
    const t = [view.getUint32(o), view.getUint32(o + 4), view.getUint32(o + 8)];
    if (t.some(v => v >= nv)) return null;
    triangles.push(t);
  }
  return { vertices, triangles };
}

// --- dense symmetric positive definite solves ---

function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= L[j * n + k] * L[j * n + k];
    if (!(d > 1e-12)) return null;
    const ljj = Math.sqrt(d);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = s / ljj;
    }
  }
  return L;
}

function choleskySolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * y[k];
    y[i] = s / L[i * n + i];
  }
  return y;
}

// Solves A x = b for the free unknowns, with the others fixed to `fixed`.
// Returns a solver: (fixedValues, rhs?) → full solution.
function constrainedSystem(A, n, isFixed) {
  const free = [], fixed = [];
  for (let i = 0; i < n; i++) (isFixed[i] ? fixed : free).push(i);
  const m = free.length;
  const Aff = new Float64Array(m * m);
  for (let a = 0; a < m; a++) for (let c = 0; c < m; c++) Aff[a * m + c] = A[free[a] * n + free[c]];
  const L = cholesky(Aff, m);
  if (!L) return null;
  return (values, rhs) => {
    const b = new Float64Array(m);
    for (let a = 0; a < m; a++) {
      let s = rhs ? rhs[free[a]] : 0;
      for (const f of fixed) s -= A[free[a] * n + f] * values[f];
      b[a] = s;
    }
    const x = choleskySolve(L, m, b);
    const out = Float64Array.from(values);
    for (let a = 0; a < m; a++) out[free[a]] = x[a];
    return out;
  };
}

// --- the solver ---

// rest: [[x, y]] in source pixels; pins: vertex indices.
// Returns solve(pinPositions) → deformed vertices, or null when the mesh
// can't be solved (degenerate or disconnected from the pins).
export function createSolver(rest, triangles, pins, iterations = 20) {
  const pinned = [...new Set(pins)];
  if (!pinned.length) return () => rest.map(p => p.slice());
  if (pinned.length === 1) {
    // One pin: AE just moves the whole mesh.
    const i = pinned[0];
    return positions => {
      const [x, y] = positions[pins.lastIndexOf(i)];
      return rest.map(p => [p[0] + x - rest[i][0], p[1] + y - rest[i][1]]);
    };
  }
  return skinningSolver(rest, triangles, pins, iterations);
}

// Cotangent weights per edge (clamped positive) and lumped vertex areas.
function cotangentLaplacian(rest, triangles) {
  const n = rest.length;
  const W = new Map(), area = new Float64Array(n);
  const key = (i, j) => (i < j ? i * n + j : j * n + i);
  for (const [a, b, c] of triangles) {
    const A = Math.abs((rest[b][0] - rest[a][0]) * (rest[c][1] - rest[a][1]) - (rest[c][0] - rest[a][0]) * (rest[b][1] - rest[a][1])) / 2;
    for (const v of [a, b, c]) area[v] += A / 3;
    for (const [i, j, k] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const ux = rest[i][0] - rest[k][0], uy = rest[i][1] - rest[k][1], vx = rest[j][0] - rest[k][0], vy = rest[j][1] - rest[k][1];
      const cr = Math.abs(ux * vy - uy * vx);
      W.set(key(i, j), (W.get(key(i, j)) || 0) + (cr < 1e-12 ? 0 : 0.5 * (ux * vx + uy * vy) / cr));
    }
  }
  let mean = 0;
  for (const w of W.values()) mean += Math.abs(w);
  mean = mean / Math.max(1, W.size) || 1;
  const nbrs = rest.map(() => []);
  for (const [k, w] of W) {
    const i = Math.floor(k / n), j = k % n, ww = Math.max(w, 1e-3 * mean);
    nbrs[i].push([j, ww]); nbrs[j].push([i, ww]);
  }
  return { nbrs, area };
}

// Linear blend skinning with biharmonic weights, one affine transform per
// pin; the transforms' rotations come from local/global ARAP iterations
// (Jacobson et al. 2011/2012: bounded biharmonic weights, automatic
// skinning transformations).
function skinningSolver(rest, triangles, pins, iterations) {
  const n = rest.length;
  const handles = [...new Set(pins)], m = handles.length;
  const { nbrs, area } = cotangentLaplacian(rest, triangles);
  // Q = L M⁻¹ L
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (const [j, w] of nbrs[i]) { L[i * n + i] += w; L[i * n + j] -= w; }
  const Q = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const lik = L[i * n + k];
      if (!lik) continue;
      const inv = lik / Math.max(area[k], 1e-9);
      for (let j = 0; j < n; j++) if (L[k * n + j]) Q[i * n + j] += inv * L[k * n + j];
    }
  }
  const weights = handles.map((_, j) => boundedWeights(Q, n, handles, j));
  // Partition of unity after the bounds.
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const w of weights) sum += w[i];
    if (sum > 1e-12) for (const w of weights) w[i] /= sum;
  }
  // φ_i: 3m row so that x'_i = φ_i · [a_j, b_j, c_j]_j (same for y with d, e, f)
  const phi = rest.map((p, i) => {
    const r = new Float64Array(3 * m);
    for (let j = 0; j < m; j++) { const w = weights[j][i]; r[3 * j] = w * p[0]; r[3 * j + 1] = w * p[1]; r[3 * j + 2] = w; }
    return r;
  });
  const N = 3 * m;
  const K = new Float64Array(N * N);
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (const [k, w] of nbrs[i]) {
      const g = new Float64Array(N);
      for (let c = 0; c < N; c++) g[c] = phi[i][c] - phi[k][c];
      for (let a = 0; a < N; a++) if (g[a]) for (let b = 0; b < N; b++) K[a * N + b] += w * g[a] * g[b];
      edges.push([i, k, w, g]);
    }
  }
  // KKT: [K Cᵀ; C 0] with C_j · x = target (T_j applied to the pin's rest position)
  const S = N + m;
  const KKT = new Float64Array(S * S);
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) KKT[a * S + b] = K[a * N + b];
  handles.forEach((h, j) => {
    const row = [rest[h][0], rest[h][1], 1];
    for (let c = 0; c < 3; c++) { KKT[(N + j) * S + 3 * j + c] = row[c]; KKT[(3 * j + c) * S + N + j] = row[c]; }
  });
  const lu = luFactor(KKT, S);
  if (!lu) return null;
  return positions => {
    const target = new Map();
    pins.forEach((v, k) => target.set(v, positions[k]));
    let R = rest.map(() => [1, 0]);
    let cur = null;
    for (let it = 0; it <= iterations; it++) {
      const sol = [0, 1].map(axis => {
        const b = new Float64Array(S);
        for (const [i, k, w, g] of edges) {
          const ex = rest[i][0] - rest[k][0], ey = rest[i][1] - rest[k][1];
          const [c, s] = R[i];
          const r = axis === 0 ? c * ex - s * ey : s * ex + c * ey;
          for (let a = 0; a < N; a++) b[a] += w * g[a] * r;
        }
        handles.forEach((h, j) => { b[N + j] = target.get(h)[axis]; });
        return luSolve(lu, S, b);
      });
      cur = phi.map(f => {
        let x = 0, y = 0;
        for (let a = 0; a < N; a++) { x += f[a] * sol[0][a]; y += f[a] * sol[1][a]; }
        return [x, y];
      });
      R = cur.map((p, i) => {
        let dot = 0, cross = 0;
        for (const [k, w] of nbrs[i]) {
          const ex = rest[i][0] - rest[k][0], ey = rest[i][1] - rest[k][1];
          const fx = p[0] - cur[k][0], fy = p[1] - cur[k][1];
          dot += w * (ex * fx + ey * fy); cross += w * (ex * fy - ey * fx);
        }
        const h = Math.hypot(dot, cross);
        return h < 1e-12 ? [1, 0] : [dot / h, cross / h];
      });
    }
    return cur;
  };
}

// Biharmonic weight of handle j (1 there, 0 at the other handles), kept in
// [0, 1] by an active set: values outside are fixed to the bound and the
// rest solved again.
function boundedWeights(Q, n, handles, j) {
  const fixedAt = new Map(handles.map((h, k) => [h, k === j ? 1 : 0]));
  let w = null;
  for (let round = 0; round < 50; round++) {
    const isFixed = new Array(n).fill(false), values = new Float64Array(n);
    for (const [i, v] of fixedAt) { isFixed[i] = true; values[i] = v; }
    const solve = constrainedSystem(Q, n, isFixed);
    if (!solve) return values;
    w = solve(values);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixedAt.has(i)) continue;
      if (w[i] < 0) { fixedAt.set(i, 0); changed = true; } else if (w[i] > 1) { fixedAt.set(i, 1); changed = true; }
    }
    if (!changed) break;
  }
  return w;
}

function luFactor(A, n) {
  const M = Float64Array.from(A), piv = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i * n + k]) > best) { best = Math.abs(M[i * n + k]); p = i; }
    if (best < 1e-14) return null;
    piv[k] = p;
    if (p !== k) for (let c = 0; c < n; c++) { const t = M[k * n + c]; M[k * n + c] = M[p * n + c]; M[p * n + c] = t; }
    for (let i = k + 1; i < n; i++) {
      const f = (M[i * n + k] /= M[k * n + k]);
      if (f) for (let c = k + 1; c < n; c++) M[i * n + c] -= f * M[k * n + c];
    }
  }
  return { M, piv };
}

function luSolve({ M, piv }, n, b) {
  const x = Float64Array.from(b);
  for (let k = 0; k < n; k++) { const p = piv[k]; if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; } }
  for (let i = 0; i < n; i++) for (let k = 0; k < i; k++) x[i] -= M[i * n + k] * x[k];
  for (let i = n - 1; i >= 0; i--) {
    for (let k = i + 1; k < n; k++) x[i] -= M[i * n + k] * x[k];
    x[i] /= M[i * n + i];
  }
  return x;
}

// --- mapping points through the deformed mesh ---

// Barycentric binding of points to the rest mesh; points outside it use the
// nearest triangle's affine map.
export function createMapper(rest, triangles) {
  const tris = triangles.map(([a, b, c]) => {
    const p = rest[a], q = rest[b], r = rest[c];
    const det = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
    return { a, b, c, p, q, r, det };
  }).filter(t => Math.abs(t.det) > 1e-12);
  const bary = (t, [x, y]) => {
    const l1 = ((x - t.p[0]) * (t.r[1] - t.p[1]) - (t.r[0] - t.p[0]) * (y - t.p[1])) / t.det;
    const l2 = ((t.q[0] - t.p[0]) * (y - t.p[1]) - (x - t.p[0]) * (t.q[1] - t.p[1])) / t.det;
    return [1 - l1 - l2, l1, l2];
  };
  const segDist = ([x, y], a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    return Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy);
  };
  // { t, l: barycentrics, dist: 0 inside, else distance to the nearest triangle }
  const locate = pt => {
    let best = null;
    for (const t of tris) {
      const l = bary(t, pt);
      if (l[0] >= -1e-9 && l[1] >= -1e-9 && l[2] >= -1e-9) return { t, l, dist: 0 };
      const dist = Math.min(segDist(pt, t.p, t.q), segDist(pt, t.q, t.r), segDist(pt, t.r, t.p));
      if (!best || dist < best.dist) best = { t, l, dist };
    }
    return best;
  };
  let edge = 0;
  for (const t of tris) edge += (Math.hypot(t.q[0] - t.p[0], t.q[1] - t.p[1]) + Math.hypot(t.r[0] - t.q[0], t.r[1] - t.q[1]) + Math.hypot(t.p[0] - t.r[0], t.p[1] - t.r[1])) / 3;
  return {
    locate,
    empty: !tris.length,
    // Points this close outside the mesh follow its nearest triangle: AE's
    // mesh comes from the rasterized layer, so vector outlines can poke out a
    // little. Content farther away isn't deformed (AE leaves it in place).
    margin: tris.length ? edge / tris.length : 0,
    // deformed point and the triangle's Jacobian at a located point
    apply({ t, l }, def) {
      const P = def[t.a], Q = def[t.b], R = def[t.c];
      const x = l[0] * P[0] + l[1] * Q[0] + l[2] * R[0];
      const y = l[0] * P[1] + l[1] * Q[1] + l[2] * R[1];
      // J = [Q−P, R−P] · [q−p, r−p]⁻¹
      const ax = t.q[0] - t.p[0], ay = t.q[1] - t.p[1], bx = t.r[0] - t.p[0], by = t.r[1] - t.p[1];
      const Ax = Q[0] - P[0], Ay = Q[1] - P[1], Bx = R[0] - P[0], By = R[1] - P[1];
      const inv = 1 / t.det; // det = ax·by − bx·ay
      const J = [
        (Ax * by - Bx * ay) * inv, (Ay * by - By * ay) * inv,
        (Bx * ax - Ax * bx) * inv, (By * ax - Ay * bx) * inv,
      ]; // column-major [j00, j10, j01, j11]
      return { x, y, J };
    },
  };
}

// --- shape arrays: subdivision and deformation ---

// Splits segment i of every block into `pieces[b][i]` equal-parameter parts,
// so the deformation can bend long segments. Shape array layout: see path.js.
export function subdivide(arr, pieces) {
  const out = [];
  let b = 0;
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s], b++) {
    const n = arr[s], closed = arr[s + 1];
    const V = [];
    for (let i = 0; i < n; i++) V.push(arr.slice(s + 2 + i * 6, s + 8 + i * 6));
    // segs[i]: the parts of the segment from vertex i to i + 1
    const segs = V.map((v, i) => {
      if (!closed && i === n - 1) return null;
      const w = V[(i + 1) % n];
      let cur = [[v[0], v[1]], [v[0] + v[4], v[1] + v[5]], [w[0] + w[2], w[1] + w[3]], [w[0], w[1]]];
      // A straight segment (no handles) splits evenly with handles at thirds.
      if (!v[4] && !v[5] && !w[2] && !w[3]) {
        const dx = (w[0] - v[0]) / 3, dy = (w[1] - v[1]) / 3;
        cur = [cur[0], [v[0] + dx, v[1] + dy], [w[0] - dx, w[1] - dy], cur[3]];
      }
      const k = Math.max(1, (pieces[b] && pieces[b][i]) || 1), parts = [];
      for (let j = 0; j < k - 1; j++) {
        const [left, right] = split(cur, 1 / (k - j));
        parts.push(left);
        cur = right;
      }
      parts.push(cur);
      return parts;
    });
    const res = [];
    V.forEach((v, i) => {
      const prev = segs[(i - 1 + n) % n];
      const into = prev && (closed || i > 0) ? prev[prev.length - 1][2] : null;
      const from = segs[i] ? segs[i][0][1] : null;
      res.push([v[0], v[1],
        into ? into[0] - v[0] : v[2], into ? into[1] - v[1] : v[3],
        from ? from[0] - v[0] : v[4], from ? from[1] - v[1] : v[5]]);
      const parts = segs[i] || [];
      for (let j = 1; j < parts.length; j++) {
        const q = parts[j][0];
        res.push([q[0], q[1], parts[j - 1][2][0] - q[0], parts[j - 1][2][1] - q[1],
          parts[j][1][0] - q[0], parts[j][1][1] - q[1]]);
      }
    });
    out.push(res.length, closed);
    for (const v of res) out.push(...v);
  }
  return out;
}

function split([p0, p1, p2, p3], u) {
  const lerp = (a, c) => [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u];
  const a = lerp(p0, p1), b = lerp(p1, p2), c = lerp(p2, p3);
  const d = lerp(a, b), e = lerp(b, c), f = lerp(d, e);
  return [[p0, a, d, f], [f, e, c, p3]];
}

// Upper bound of each segment's length: chord through both handles.
export function segmentLengths(arr) {
  const out = [];
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) {
    const n = arr[s], lens = [];
    for (let i = 0; i < n; i++) {
      const o = s + 2 + i * 6, w = s + 2 + ((i + 1) % n) * 6;
      const hx = arr[o + 4], hy = arr[o + 5], ix = arr[w + 2], iy = arr[w + 3];
      lens.push(Math.hypot(hx, hy) + Math.hypot(arr[w] + ix - arr[o] - hx, arr[w + 1] + iy - arr[o + 1] - hy) + Math.hypot(ix, iy));
    }
    out.push(lens);
  }
  return out;
}

// Deforms a shape array: vertices through the mesh, each handle through the
// Jacobian of its vertex's triangle. `toSource`/`fromSource` are affine
// matrices [a, b, c, d, e, f] between the array's space and source space.
export function deformArray(arr, mapper, def, toSource, fromSource) {
  const out = arr.slice();
  const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const lin = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) {
    for (let i = 0; i < arr[s]; i++) {
      const o = s + 2 + i * 6;
      const P = ap(toSource, arr[o], arr[o + 1]);
      const hit = mapper.locate(P);
      if (!hit || hit.dist > mapper.margin) continue;
      const { x, y, J } = mapper.apply(hit, def);
      const V = ap(fromSource, x, y);
      out[o] = V[0]; out[o + 1] = V[1];
      for (const t of [o + 2, o + 4]) {
        const h = lin(toSource, arr[t], arr[t + 1]);
        const H = lin(fromSource, J[0] * h[0] + J[2] * h[1], J[1] * h[0] + J[3] * h[1]);
        out[t] = H[0]; out[t + 1] = H[1];
      }
    }
  }
  return out;
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// --- the layer pre-pass ---

const MAX_PIECES = 16;

// A copy of the layer whose paths and masks are deformed by its Puppet
// effects (baked once per frame). Paths keep their groups: each frame's
// shape is moved into layer space, deformed, and moved back, so group
// transforms, gradients and paints still apply as before.
export function puppetLayer(layer, ctx, where) {
  const stages = [];
  let edge = 0, edges = 0;
  for (const fx of layer.puppets || []) {
    const w = `${where} › ${fx.name || 'Puppet'}`;
    if (fx.enabled === false) continue;
    if (fx.engine === 'legacy') ctx.warn(w, 'the Legacy puppet engine is approximated with the Advanced one');
    if (fx.overlapPins) ctx.warn(w, 'Overlap pins are not supported (ignored)');
    if (fx.stiffnessPins) ctx.warn(w, 'Stiffness pins are not supported (ignored)');
    const src = fx.source || {};
    const scale = src.scale || Math.max(src.width || 0, src.height || 0);
    const meshes = [];
    for (const m of fx.meshes || []) {
      const mesh = m.data ? decodeMesh(m.data) : null;
      if (!mesh) {
        ctx.warn(w, 'puppet mesh not found in the saved project (ignored); save the project and export again');
        continue;
      }
      const rest = mesh.vertices.map(([x, y]) => [x * scale, y * scale]);
      const pins = [];
      for (const p of m.pins || []) {
        if (p.type && p.type !== 'position') {
          ctx.warn(w, `${p.type} pins are not supported (ignored)`);
          continue;
        }
        if (!(p.vertex >= 0 && p.vertex < rest.length)) {
          ctx.warn(w, `pin "${p.name}" is not attached to the mesh (ignored)`);
          continue;
        }
        pins.push(p);
      }
      const solve = createSolver(rest, mesh.triangles, pins.map(p => p.vertex), fx.refinement ?? 20);
      if (!solve) {
        ctx.warn(w, 'puppet mesh could not be solved (ignored)');
        continue;
      }
      for (const [a, b, c] of mesh.triangles) {
        for (const [i, j] of [[a, b], [b, c], [c, a]]) {
          edge += Math.hypot(rest[i][0] - rest[j][0], rest[i][1] - rest[j][1]);
          edges++;
        }
      }
      const cache = new Map();
      meshes.push({
        mapper: createMapper(rest, mesh.triangles),
        at(t) {
          const key = Math.round(t * 1e6);
          if (!cache.has(key)) cache.set(key, solve(pins.map(p => propValueAt(p.position, KIND.point, t))));
          return cache.get(key);
        },
      });
    }
    if (meshes.length) stages.push({ meshes });
  }
  if (!stages.length) return layer;
  if (layer.contents && hasRepeater(layer.contents)) {
    ctx.warn(where, 'repeater copies on a puppet layer move with the deformation of the original');
  }
  const pieceLen = Math.max(1, edge / Math.max(1, edges)) * 2.5;
  const frames = [];
  for (let j = 0; j * (1 / ctx.fps) < ctx.D - 1e-9; j++) frames.push(j / ctx.fps);
  frames.push(ctx.D);

  // A comp-space array at time t through every Puppet in effect order.
  const deform = (arr, t) => stages.reduce((a, st) => deformAll(a, st.meshes, t), arr);
  const layerToComp = layerMatrix(layer, ctx, where);

  // toLayer(t): matrix from the item's space to layer space.
  const bake = (track, itemToLayer, w) => {
    const toLayer = t => multiply(layerToComp(t), itemToLayer(t));
    const shapeAt = t => trackValueAt(track, t);
    const first = shapeAt(0);
    const lengths = new Map();
    for (const t of frames) {
      const a = shapeAt(t);
      if (a.length !== first.length) {
        ctx.warn(w, 'path changes its point count; it is not deformed by the puppet');
        return track;
      }
      segmentLengths(transformShape(a, toLayer(t))).forEach((ls, b) => ls.forEach((l, i) => {
        const k = `${b}:${i}`;
        lengths.set(k, Math.max(lengths.get(k) || 0, l));
      }));
    }
    const pieces = segmentLengths(first).map((ls, b) => ls.map((_, i) =>
      Math.min(MAX_PIECES, Math.max(1, Math.ceil(lengths.get(`${b}:${i}`) / pieceLen)))));
    return bakeFunction(t => {
      const m = toLayer(t), inv = invert(m);
      if (!inv) return subdivide(shapeAt(t), pieces);
      return transformShape(deform(transformShape(subdivide(shapeAt(t), pieces), m), t), inv);
    }, 0, ctx.D, ctx.fps, KIND.shape.tol);
  };

  const walk = (items, toLayer, w) => items.map(it => {
    const iw = `${w} › ${it.name || it.type}`;
    if (it.type === 'group') {
      const own = matrixAt(it.transform, ctx, iw);
      const inner = t => multiply(toLayer(t), own(t));
      return { ...it, contents: walk(it.contents || [], inner, iw) };
    }
    if (it.type === 'path' || it.type === 'rect' || it.type === 'ellipse' || it.type === 'polystar') {
      const source = geometryTrack(it, ctx, iw);
      const out = { type: 'path', name: it.name, enabled: it.enabled, track: bake(source, toLayer, iw) };
      // A fill closes an open path with a straight line, which AE bends with
      // the mesh like the rest: fills get a closed copy, deformed as well.
      if (hasOpen(source.stops[0].v)) out.fillTrack = bake(mapTrack(source, closeOpen), toLayer, iw);
      return out;
    }
    return it;
  });

  const identity = () => [1, 0, 0, 1, 0, 0];
  const out = { ...layer };
  if (layer.contents) out.contents = walk(layer.contents, identity, where);
  if (layer.masks) {
    out.masks = layer.masks.map(m => ({
      ...m,
      track: bake(geometryTrack({ type: 'path', path: m.path }, ctx, `${where} › ${m.name || 'Mask'}`), identity,
        `${where} › ${m.name || 'Mask'}`),
    }));
  }
  return out;
}

function hasOpen(arr) {
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) if (!arr[s + 1] && arr[s] > 1) return true;
  return false;
}

// Open subpaths closed with a straight segment, as a fill draws them.
function closeOpen(arr) {
  const out = arr.slice();
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) {
    if (arr[s + 1]) continue;
    const n = arr[s];
    out[s + 1] = 1;
    out[s + 2 + 2] = 0; out[s + 2 + 3] = 0; // first vertex: no in-tangent
    out[s + 2 + (n - 1) * 6 + 4] = 0; out[s + 2 + (n - 1) * 6 + 5] = 0; // last: no out-tangent
  }
  return out;
}

function hasRepeater(items) {
  return items.some(it => it.type === 'repeater' || (it.type === 'group' && hasRepeater(it.contents || [])));
}

// Layer space → comp space at time t: the layer's transform and its parents'.
export function layerMatrix(layer, ctx, where) {
  const chain = [];
  const seen = new Set();
  for (let l = layer; l && !seen.has(l.id); l = l.parent != null && ctx.byId ? ctx.byId.get(l.parent) : null) {
    seen.add(l.id);
    if (l.transform && l.transform.autoOrient) ctx.warn(where, 'Auto-Orient is ignored for the puppet deformation');
    chain.push(matrixAt(l.transform, ctx, `layer "${l.name}"`));
  }
  return t => chain.reduceRight((m, f) => multiply(m, f(t)), [1, 0, 0, 1, 0, 0]);
}

// The group transform as a function of time → affine matrix.
function matrixAt(tr, ctx, where) {
  const { parts, moving } = matrixTrack(tr, ctx, where);
  const at = t => {
    const [pos, rot, scale, anchor] = parts.map(p => trackValueAt(p, t));
    return transformMatrix(pos, rot[0], scale, anchor);
  };
  if (moving) return at;
  const m = at(0);
  return () => m;
}

// Each vertex goes through the mesh that contains it (or the nearest one).
function deformAll(arr, meshes, t) {
  if (meshes.length === 1) return deformArray(arr, meshes[0].mapper, meshes[0].at(t), IDENT, IDENT);
  const out = arr.slice();
  for (let s = 0; s < arr.length; s += 2 + 6 * arr[s]) {
    for (let i = 0; i < arr[s]; i++) {
      const o = s + 2 + i * 6, pt = [arr[o], arr[o + 1]];
      let best = meshes[0], bestOut = Infinity;
      for (const m of meshes) {
        const hit = m.mapper.locate(pt);
        const out = hit ? hit.dist : Infinity;
        if (out < bestOut) { best = m; bestOut = out; }
      }
      const one = deformArray([1, 0, ...arr.slice(o, o + 6)], best.mapper, best.at(t), IDENT, IDENT);
      for (let c = 0; c < 6; c++) out[o + c] = one[2 + c];
    }
  }
  return out;
}

const IDENT = [1, 0, 0, 1, 0, 0];
