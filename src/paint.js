// Fills, strokes, dashes and gradients → a style for path elements.
//
// A style is { kind: 'fill'|'stroke', attrs, anims, dash, lineCap, outline? }:
//   attrs/anims go on every path the paint draws; `dash` is the stroke's own
//   dash pattern, which trim paths replace. `outline` is set for strokes with
//   Taper or Wave, which are drawn as filled outlines (see taper.js).

import { num, hex } from './format.js';
import { KIND, asProp, combineTracks, isAnimated, staticValue } from './timeline.js';
import { animate, element, finalize, fmtOpacity, newId, resolve, sampling, smilAttrs, timing, trackOf } from './anim.js';

const GRADIENT_TYPES = new Set(['gradient-fill', 'gradient-stroke']);
export const PAINTS = new Set(['fill', 'stroke', 'gradient-fill', 'gradient-stroke']);

export function paint(it, ctx, where) {
  const isStroke = it.type === 'stroke' || it.type === 'gradient-stroke';

  // The paint itself, written out for whichever attribute ends up using it.
  let source;
  if (GRADIENT_TYPES.has(it.type)) {
    const url = `url(#${gradient(it, ctx, where)})`;
    source = () => ({ value: url, anims: '' });
  } else {
    const color = resolve(it.color ?? [1, 1, 1], KIND.color, ctx, `${where} › Color`);
    source = attr => ({ value: hex(color.value), anims: animate(attr, color, hex, ctx) });
  }
  const opacity = resolve(it.opacity ?? 100, KIND.scalar, ctx, `${where} › Opacity`);
  const paintAttrs = target => {
    const s = source(target);
    const attrs = { [target]: s.value };
    let anims = s.anims;
    if (opacity.smil || opacity.value[0] !== 100) {
      attrs[`${target}-opacity`] = fmtOpacity(opacity.value);
      anims += animate(`${target}-opacity`, opacity, fmtOpacity, ctx);
    }
    return { attrs, anims };
  };

  if (!isStroke) {
    const { attrs, anims } = paintAttrs('fill');
    if (it.fillRule === 'evenodd') attrs['fill-rule'] = 'evenodd';
    return { kind: 'fill', attrs, anims, dash: null, lineCap: 'butt' };
  }

  const p = paintAttrs('stroke');
  const width = resolve(it.width ?? 2, KIND.scalar, ctx, `${where} › Stroke Width`);
  const fmtW = v => num(v[0]);
  const attrs = { fill: 'none', stroke: p.attrs.stroke, 'stroke-width': fmtW(width.value) };
  if (p.attrs['stroke-opacity'] != null) attrs['stroke-opacity'] = p.attrs['stroke-opacity'];
  const anims = p.anims + animate('stroke-width', width, fmtW, ctx);
  if (it.lineCap && it.lineCap !== 'butt') attrs['stroke-linecap'] = it.lineCap;
  if (it.lineJoin && it.lineJoin !== 'miter') attrs['stroke-linejoin'] = it.lineJoin;
  if (it.miterLimit != null && it.miterLimit !== 4) attrs['stroke-miterlimit'] = num(it.miterLimit);
  const style = { kind: 'stroke', attrs, anims, dash: dashes(it, ctx, where), lineCap: it.lineCap || 'butt' };

  if (it.taper === true) {
    ctx.warn(where, 'stroke taper needs a newer extractor; re-export from After Effects');
  } else if (it.taper || it.wave) {
    if (style.dash) ctx.warn(where, 'dashes on a tapered stroke are not supported (ignored)');
    style.outline = { ...paintAttrs('fill'), ...outlineTracks(it, ctx, where), lineCap: style.lineCap };
  }
  return style;
}

// Width-related tracks for an outlined (tapered/waved) stroke, in the order
// taper.js expects.
function outlineTracks(it, ctx, where) {
  const t = it.taper || {}, w = it.wave || {};
  const track = (p, fallback, label) => trackOf(p ?? fallback, KIND.scalar, ctx, `${where} › ${label}`);
  return {
    taperUnits: t.units || 'percent',
    waveUnits: w.units || 'pixels',
    tracks: [
      track(it.width, 2, 'Stroke Width'),
      track(t.startLength, 0, 'Taper Start Length'), track(t.endLength, 0, 'Taper End Length'),
      track(t.startWidth, 0, 'Taper Start Width'), track(t.endWidth, 0, 'Taper End Width'),
      track(t.startEase, 0, 'Taper Start Ease'), track(t.endEase, 0, 'Taper End Ease'),
      track(w.amount, 0, 'Wave Amount'), track(w.wavelength, 100, 'Wave Wavelength'),
      track(w.cycles, 10, 'Wave Cycles'), track(w.phase, 0, 'Wave Phase'),
    ],
  };
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
  anims += gradientTransform(it, ctx, where, attrs);
  ctx.defs.push(element(tag, attrs, anims + stopElements(it.stops, ctx, where)));
  return id;
}

// AE's gradient Scale and Rotation apply around the shape's origin:
// gradientTransform="rotate(r) scale(sx sy)" (fitted against AE renders).
function gradientTransform(it, ctx, where, attrs) {
  if (it.gradientTransform === true) ctx.warn(where, 'gradient Scale/Rotation need a newer extractor; re-export from After Effects');
  if (it.gradientScale == null && it.gradientRotation == null) return '';
  const rot = resolve(it.gradientRotation ?? 0, KIND.scalar, ctx, `${where} › Rotation`);
  const scale = resolve(it.gradientScale ?? [100, 100], KIND.vec2, ctx, `${where} › Scale`);
  const fmtR = v => num(v[0]), fmtS = v => `${num(v[0] / 100, 4)} ${num(v[1] / 100, 4)}`;
  attrs.gradientTransform = `rotate(${fmtR(rot.value)}) scale(${fmtS(scale.value)})`;
  if (!rot.smil && !scale.smil) return '';
  // Animating replaces the whole attribute: rotate first, then scale added on.
  const hold = r => r.smil || { calcMode: 'linear', values: [r.value, r.value], keyTimes: [0, 1], keySplines: null };
  return `<animateTransform attributeName="gradientTransform" type="rotate" ${smilAttrs(hold(rot), fmtR)} ${timing(ctx)}/>`
    + `<animateTransform attributeName="gradientTransform" type="scale" ${smilAttrs(hold(scale), fmtS)} additive="sum" ${timing(ctx)}/>`;
}

// Stops, static or animated. Animated stops animate each stop's offset,
// color and opacity; keyframes with different stop layouts are resampled at
// the union of their offsets.
function stopElements(stops, ctx, where) {
  if (stops == null) {
    ctx.warn(where, 'gradient colors are unavailable (save the project and export again); using black to white');
    stops = { value: { colors: [[0, 0.5, 0, 0, 0], [1, 0.5, 1, 1, 1]], alphas: [] } };
  }
  const prop = asProp(stops);
  const toStop = (s, anims = '') => element('stop', {
    offset: num(s[0], 4), 'stop-color': hex(s.slice(1, 4)), 'stop-opacity': s[4] < 1 ? num(s[4], 4) : null,
  }, anims);
  if (!isAnimated(prop)) return gradientStops(staticValue(prop)).map(s => toStop(s)).join('');

  const layouts = prop.keyframes.map(k => gradientStops(k.v));
  const sameLayout = layouts.every(l => l.length === layouts[0].length);
  const offsets = sameLayout ? null : [...new Set([].concat(...layouts.map(l => l.map(s => s[0]))))].sort((a, b) => a - b);
  const kind = {
    tol: 0.001,
    progress: true,
    toArray: v => [].concat(...(sameLayout ? gradientStops(v) : resample(gradientStops(v), offsets))),
  };
  const r = finalize(trackOf(prop, kind, ctx, `${where} › Colors`), ctx, kind.tol);
  const out = [];
  for (let i = 0; i < r.value.length / 5; i++) {
    const at = v => v.slice(i * 5, i * 5 + 5);
    // Only animate the parts of this stop that change.
    const anim = (attr, fmt) => (r.smil && new Set(r.smil.values.map(fmt)).size > 1 ? animate(attr, r, fmt, ctx) : '');
    out.push(toStop(at(r.value),
      anim('offset', v => num(at(v)[0], 4))
      + anim('stop-color', v => hex(at(v).slice(1, 4)))
      + anim('stop-opacity', v => num(at(v)[4], 4))));
  }
  return out.join('');
}

// AE keeps color stops [offset, midpoint, r, g, b] and opacity stops
// [offset, midpoint, a] separately. SVG stops carry both, so take the union
// of offsets. A midpoint away from 0.5 becomes an extra stop there.
// Returns [[offset, r, g, b, a], …].
function gradientStops(stops) {
  const colors = withMidpoints(stops.colors && stops.colors.length ? stops.colors : [[0, 0.5, 1, 1, 1], [1, 0.5, 0, 0, 0]]);
  const alphas = withMidpoints(stops.alphas && stops.alphas.length ? stops.alphas : [[0, 0.5, 1]]);
  const offsets = [...new Set([...colors, ...alphas].map(s => s[0]))].sort((a, b) => a - b);
  return offsets.map(o => [o, ...valueAt(colors, o), valueAt(alphas, o)[0]]);
}

function resample(stops, offsets) {
  return offsets.map(o => [o, ...valueAt(stops, o)]);
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

// Value at offset o in sorted [[offset, ...values]].
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
