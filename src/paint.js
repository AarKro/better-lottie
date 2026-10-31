// Fills, strokes, dashes and gradients → a style for path elements.
//
// A style is { kind: 'fill'|'stroke', attrs, anims, dash, lineCap }:
//   attrs/anims go on every path the paint draws; `dash` is the stroke's own
//   dash pattern, which trim paths replace.

import { num, hex } from './format.js';
import { KIND, combineTracks } from './timeline.js';
import { animate, element, finalize, fmtOpacity, newId, resolve, sampling, trackOf } from './anim.js';

const GRADIENT_TYPES = new Set(['gradient-fill', 'gradient-stroke']);
export const PAINTS = new Set(['fill', 'stroke', 'gradient-fill', 'gradient-stroke']);

export function paint(it, ctx, where) {
  const isStroke = it.type === 'stroke' || it.type === 'gradient-stroke';
  const target = isStroke ? 'stroke' : 'fill';
  const attrs = isStroke ? { fill: 'none' } : {};
  let anims = '';

  if (GRADIENT_TYPES.has(it.type)) {
    attrs[target] = `url(#${gradient(it, ctx, where)})`;
  } else {
    const color = resolve(it.color ?? [1, 1, 1], KIND.color, ctx, `${where} › Color`);
    attrs[target] = hex(color.value);
    anims += animate(target, color, hex, ctx);
  }

  if (isStroke) {
    const width = resolve(it.width ?? 2, KIND.scalar, ctx, `${where} › Stroke Width`);
    const fmtW = v => num(v[0]);
    attrs['stroke-width'] = fmtW(width.value);
    anims += animate('stroke-width', width, fmtW, ctx);
  }

  const opacity = resolve(it.opacity ?? 100, KIND.scalar, ctx, `${where} › Opacity`);
  if (opacity.smil || opacity.value[0] !== 100) {
    attrs[`${target}-opacity`] = fmtOpacity(opacity.value);
    anims += animate(`${target}-opacity`, opacity, fmtOpacity, ctx);
  }

  if (!isStroke) {
    if (it.fillRule === 'evenodd') attrs['fill-rule'] = 'evenodd';
    return { kind: 'fill', attrs, anims, dash: null, lineCap: 'butt' };
  }

  if (it.lineCap && it.lineCap !== 'butt') attrs['stroke-linecap'] = it.lineCap;
  if (it.lineJoin && it.lineJoin !== 'miter') attrs['stroke-linejoin'] = it.lineJoin;
  if (it.miterLimit != null && it.miterLimit !== 4) attrs['stroke-miterlimit'] = num(it.miterLimit);
  if (it.taper) ctx.warn(where, 'stroke taper and wave are not supported (ignored)');
  return { kind: 'stroke', attrs, anims, dash: dashes(it, ctx, where), lineCap: it.lineCap || 'butt' };
}

// AE dash pattern [dash, gap, dash, …] + offset → stroke-dasharray/-dashoffset.
// An odd-length list repeats in SVG, which matches AE's "gap = dash" default.
function dashes(it, ctx, where) {
  if (it.dashes === true) {
    ctx.warn(where, 'dashes need a newer extractor; re-export from After Effects');
    return null;
  }
  if (!Array.isArray(it.dashes) || !it.dashes.length) return null;
  const tracks = it.dashes.map(d => trackOf(d.value, KIND.scalar, ctx, `${where} › ${d.type}`));
  const pattern = finalize(combineTracks(tracks, (...vs) => vs.map(v => Math.max(0, v[0])), sampling(ctx, 0.01)), ctx, 0.01);
  const offset = resolve(it.dashOffset ?? 0, KIND.scalar, ctx, `${where} › Offset`);
  const fmtP = v => v.map(x => num(x)).join(' ');
  const fmtO = v => num(v[0]);
  const attrs = { 'stroke-dasharray': fmtP(pattern.value) };
  if (offset.smil || offset.value[0] !== 0) attrs['stroke-dashoffset'] = fmtO(offset.value);
  return { attrs, anims: animate('stroke-dasharray', pattern, fmtP, ctx) + animate('stroke-dashoffset', offset, fmtO, ctx) };
}

// --- gradients ---

// AE gradients live in the element's own coordinate space, like
// gradientUnits="userSpaceOnUse". Returns the id of the <defs> entry.
function gradient(it, ctx, where) {
  const id = newId(ctx, 'grad');
  const start = trackOf(it.startPoint ?? [0, 0], KIND.point, ctx, `${where} › Start Point`);
  const end = trackOf(it.endPoint ?? [100, 0], KIND.point, ctx, `${where} › End Point`);
  const x = v => num(v[0]), y = v => num(v[1]);
  const attrs = { id, gradientUnits: 'userSpaceOnUse' };
  let anims = '';
  const put = (name, r, fmt) => { attrs[name] = fmt(r.value); anims += animate(name, r, fmt, ctx); };
  const s = finalize(start, ctx, KIND.point.tol);
  const tag = it.gradientType === 'radial' ? 'radialGradient' : 'linearGradient';

  if (tag === 'linearGradient') {
    const e = finalize(end, ctx, KIND.point.tol);
    put('x1', s, x); put('y1', s, y); put('x2', e, x); put('y2', e, y);
  } else {
    // AE: radius = |end − start|; the highlight moves the focal point along
    // the start→end direction rotated by the highlight angle (as lottie-web).
    const hl = trackOf(it.highlightLength ?? 0, KIND.scalar, ctx, `${where} › Highlight Length`);
    const ha = trackOf(it.highlightAngle ?? 0, KIND.scalar, ctx, `${where} › Highlight Angle`);
    const radius = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = finalize(combineTracks([start, end], (a, b) => [radius(a, b)], sampling(ctx, 0.01, false)), ctx, 0.01);
    const focal = finalize(combineTracks([start, end, hl, ha], (a, b, [len], [angle]) => {
      const dist = radius(a, b) * Math.max(-0.99, Math.min(0.99, len / 100));
      const dir = Math.atan2(b[1] - a[1], b[0] - a[0]) + (angle * Math.PI) / 180;
      return [a[0] + Math.cos(dir) * dist, a[1] + Math.sin(dir) * dist];
    }, sampling(ctx, 0.01, false)), ctx, 0.01);
    put('cx', s, x); put('cy', s, y); put('r', r, v => num(v[0]));
    if (focal.smil || focal.value[0] !== s.value[0] || focal.value[1] !== s.value[1]) { put('fx', focal, x); put('fy', focal, y); }
  }
  if (it.gradientTransform) ctx.warn(where, 'gradient Scale and Rotation are not supported (ignored)');

  const stops = gradientStops(it.stops, ctx, where)
    .map(([offset, r, g, b, a]) => element('stop', {
      offset: num(offset, 4), 'stop-color': hex([r, g, b]), 'stop-opacity': a < 1 ? num(a, 4) : null,
    })).join('');
  ctx.defs.push(element(tag, attrs, anims + stops));
  return id;
}

// AE keeps color stops [offset, midpoint, r, g, b] and opacity stops
// [offset, midpoint, a] separately. SVG stops carry both, so take the union
// of offsets. A midpoint away from 0.5 becomes an extra stop there.
function gradientStops(stops, ctx, where) {
  if (!stops || !stops.colors || !stops.colors.length) {
    ctx.warn(where, 'gradient colors are unavailable (save the project and export again); using black to white');
    stops = { colors: [[0, 0.5, 0, 0, 0], [1, 0.5, 1, 1, 1]], alphas: [] };
  }
  const colors = withMidpoints(stops.colors);
  const alphas = withMidpoints(stops.alphas && stops.alphas.length ? stops.alphas : [[0, 0.5, 1]]);
  const offsets = [...new Set([...colors, ...alphas].map(s => s[0]))].sort((a, b) => a - b);
  return offsets.map(o => [o, ...valueAt(colors, o), valueAt(alphas, o)[0]]);
}

// [[offset, midpoint, ...values]] → sorted [[offset, ...values]] with midpoint stops added.
function withMidpoints(list) {
  const sorted = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  sorted.forEach((s, i) => {
    out.push([s[0], ...s.slice(2)]);
    const next = sorted[i + 1];
    if (next && Math.abs(s[1] - 0.5) > 0.01) {
      out.push([s[0] + (next[0] - s[0]) * s[1], ...s.slice(2).map((v, j) => (v + next[2 + j]) / 2)]);
    }
  });
  return out;
}

function valueAt(list, o) {
  if (o <= list[0][0]) return list[0].slice(1);
  for (let i = 1; i < list.length; i++) {
    if (o <= list[i][0]) {
      const a = list[i - 1], b = list[i], f = (o - a[0]) / (b[0] - a[0] || 1);
      return a.slice(1).map((v, j) => v + (b[1 + j] - v) * f);
    }
  }
  return list[list.length - 1].slice(1);
}
