// Shape layer contents → SVG: groups, paths, paints, Merge Paths, Trim Paths.
//
// AE semantics this follows:
// - A group's items draw bottom-up. Each paint draws the paths above it in
//   the same group, including paths in groups above it.
// - A modifier (Trim Paths) changes every path above it, including paths in
//   groups above it, no matter where the paints are.
// - Merge Paths combines the paths above it into one; paints below it draw
//   the merged result.

import { KIND, combineTracks, mapTrack, trackIsStatic, trackValueAt } from './timeline.js';
import { arrayToD, ellipseShape, rectShape, shapeToArray } from './path.js';
import { orientClockwise, shapeLength, transformMatrix, transformShape } from './geometry.js';
import { animate, displayToggle, element, finalize, newId, sampling, trackOf } from './anim.js';
import { num } from './format.js';
import { paint, PAINTS } from './paint.js';
import { matrixTrack, wrapTransform } from './transform.js';

const GEOMETRY = new Set(['path', 'rect', 'ellipse']);
const MODIFIERS = new Set(['trim', 'merge-paths']);

export function renderContents(items, ctx, where) {
  assignTrims(items, [], ctx, where);
  return renderStack(items, ctx, where);
}

function renderStack(items, ctx, where) {
  let out = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    if (PAINTS.has(it.type)) {
      const style = paint(it, ctx, w);
      out += collectGeometry(items, i, ctx, where).map(e => e.render(style)).join('');
    } else if (it.type === 'group') {
      const inner = renderStack(it.contents || [], ctx, w);
      if (inner) out += wrapTransform(it.transform, inner, ctx, w, { opacity: true });
    } else if (!GEOMETRY.has(it.type) && !MODIFIERS.has(it.type)) {
      ctx.warn(w, `shape item "${it.type}" is not supported (ignored)`);
    }
  }
  return out;
}

// Drawable entries for everything above index `end`:
//   { track(): shape track in this group's space (null if not expressible),
//     trimmed, render(style) → SVG string }
function collectGeometry(items, end, ctx, where) {
  let entries = [];
  for (let j = 0; j < end; j++) {
    const it = items[j];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    if (GEOMETRY.has(it.type)) {
      entries.push({
        track: () => geometry(it, ctx, w).track,
        trimmed: ctx.trimOf.has(it),
        render: style => pathElement(it, style, ctx, w),
      });
    } else if (it.type === 'group') {
      for (const e of collectGeometry(it.contents || [], (it.contents || []).length, ctx, w)) {
        entries.push(nestEntry(e, it.transform, ctx, w));
      }
    } else if (it.type === 'merge-paths' && entries.length) {
      entries = [mergeEntry(entries, it, ctx, w)];
    }
  }
  return entries;
}

// An entry from a sub-group: drawn inside the group's transform, or
// flattened into this group's space when merged.
function nestEntry(e, tr, ctx, where) {
  return {
    track() {
      const inner = e.track();
      if (!inner) return null;
      const m = matrixTrack(tr, ctx, where);
      return combineTracks([inner, ...m.parts],
        (shape, pos, rot, scale, anchor) => transformShape(shape, transformMatrix(pos, rot[0], scale, anchor)),
        sampling(ctx, KIND.shape.tol, !m.moving));
    },
    trimmed: e.trimmed,
    render: style => wrapTransform(tr, e.render(style), ctx, where, { opacity: false }),
  };
}

// --- geometry ---

function geometry(it, ctx, where) {
  if (ctx.geometry.has(it)) return ctx.geometry.get(it);
  const track = it.type === 'path' ? trackOf(it.path, KIND.shape, ctx, where) : primitiveTrack(it, ctx, where);
  const r = finalize(track, ctx, KIND.shape.tol);
  const g = { track, value: r.value, d: arrayToD(r.value), anim: animate('d', r, arrayToD, ctx) };
  ctx.geometry.set(it, g);
  return g;
}

// Rects and ellipses become paths. The path is linear in each parameter, so
// a single animated parameter keeps its keyframes and easing; several
// animated parameters are baked.
function primitiveTrack(it, ctx, where) {
  const isRect = it.type === 'rect';
  const tracks = [
    trackOf(it.size ?? [100, 100], KIND.vec2, ctx, `${where} › Size`),
    trackOf(it.position ?? [0, 0], KIND.point, ctx, `${where} › Position`),
  ];
  if (isRect) tracks.push(trackOf(it.roundness ?? 0, KIND.scalar, ctx, `${where} › Roundness`));
  const rounded = isRect && (!trackIsStatic(tracks[2]) || tracks[2].stops[0].v[0] > 0);
  return combineTracks(tracks,
    (size, pos, round) => shapeToArray(isRect ? rectShape(size, pos, round, rounded) : ellipseShape(size, pos)),
    sampling(ctx, KIND.shape.tol));
}

function withDash(attrs, style) {
  if (!style.dash) return '';
  Object.assign(attrs, style.dash.attrs);
  return style.dash.anims;
}

function pathElement(it, style, ctx, where) {
  const g = geometry(it, ctx, where);
  const attrs = { d: g.d, ...style.attrs };
  let kids = g.anim + style.anims;
  const info = ctx.trimOf.get(it);
  const trim = info ? trimFor(it, info, ctx) : null;
  if (trim && style.kind === 'fill') {
    ctx.warn(info.state.where, 'Trim Paths only trims strokes in the export; fills stay whole');
  }
  if (trim && style.kind === 'stroke') {
    if (style.dash) ctx.warn(where, 'the stroke\'s dashes are replaced by Trim Paths');
    Object.assign(attrs, trim.attrs);
    kids += trim.anims;
    // A zero-length dash still draws round or square caps; AE draws nothing.
    if (style.lineCap !== 'butt') {
      const toggle = trim.display();
      Object.assign(attrs, toggle.attrs);
      kids += toggle.anims;
    }
  } else {
    kids += withDash(attrs, style);
  }
  return element('path', attrs, kids);
}

// --- Trim Paths ---

// Pre-pass: link every path to the nearest Trim Paths below it (same group or
// an ancestor group). Members are listed top-first, which "simultaneously"
// mode needs to lay the paths end to end.
function assignTrims(items, inherited, ctx, where) {
  const below = new Array(items.length);
  let acc = [];
  for (let k = items.length - 1; k >= 0; k--) {
    below[k] = acc;
    const it = items[k];
    if (it.type === 'trim' && it.enabled !== false) {
      acc = [{ item: it, where: `${where} › ${it.name || 'Trim Paths'}`, members: [] }, ...acc];
    }
  }
  items.forEach((it, j) => {
    if (it.enabled === false) return;
    const w = `${where} › ${it.name || it.type}`;
    const applicable = below[j].concat(inherited);
    if (GEOMETRY.has(it.type) && applicable.length) {
      if (applicable.length > 1) ctx.warn(w, 'several Trim Paths apply to this path; only the nearest one is exported');
      const state = applicable[0];
      ctx.trimOf.set(it, { state, index: state.members.length });
      state.members.push(it);
    } else if (it.type === 'group') {
      assignTrims(it.contents || [], applicable, ctx, w);
    }
  });
}

// Trim → dash on a path normalized with pathLength="1": a dash of the visible
// length, a gap of the rest, shifted to the visible start. The period of
// exactly 1 makes segments that cross the path's end wrap around, like AE.
// Tracks hold [visible length, start], both as fractions of the path.
function trimFor(it, { state, index }, ctx) {
  if (ctx.trimCache.has(it)) return ctx.trimCache.get(it);
  const T = state.item, w = state.where;
  const s = trackOf(T.start ?? 0, KIND.scalar, ctx, `${w} › Start`);
  const e = trackOf(T.end ?? 100, KIND.scalar, ctx, `${w} › End`);
  const o = trackOf(T.offset ?? 0, KIND.scalar, ctx, `${w} › Offset`);
  let fn, linear = false;
  if (T.mode === 'individually' || state.members.length === 1) {
    fn = ([sv], [ev], [ov]) => {
      const a = Math.min(sv, ev) / 100, b = Math.max(sv, ev) / 100;
      return [Math.min(1, b - a), a + ov / 360];
    };
    linear = sameSide(s, e);
  } else {
    const lengths = state.members.map(m => shapeLength(geometry(m, ctx, w).value));
    const total = lengths.reduce((x, y) => x + y, 0) || 1;
    const a = lengths.slice(0, index).reduce((x, y) => x + y, 0) / total;
    const b = a + lengths[index] / total;
    fn = ([sv], [ev], [ov]) => localTrim(a, b, Math.min(sv, ev) / 100, Math.max(sv, ev) / 100, ov / 360);
  }
  const track = combineTracks([s, e, o], fn, sampling(ctx, 1e-4, linear));
  let result = null;
  if (!(trackIsStatic(track) && track.stops[0].v[0] >= 1 - 1e-9)) {
    // Split so a constant length or start doesn't get an animation.
    const length = finalize(mapTrack(track, v => [v[0]]), ctx, 1e-4);
    const start = finalize(mapTrack(track, v => [v[1]]), ctx, 1e-4);
    const fmtDash = v => `${num(v[0], 4)} ${num(Math.max(0, 1 - v[0]), 4)}`;
    const fmtOffset = v => num(-v[0], 4);
    result = {
      attrs: { pathLength: '1', 'stroke-dasharray': fmtDash(length.value), 'stroke-dashoffset': fmtOffset(start.value) },
      anims: animate('stroke-dasharray', length, fmtDash, ctx) + animate('stroke-dashoffset', start, fmtOffset, ctx),
      display: () => displayToggle(t => trackValueAt(track, t)[0] < 1e-6, ctx),
    };
  }
  ctx.trimCache.set(it, result);
  return result;
}

// [length, start] is linear in start/end only while their order never flips.
function sameSide(s, e) {
  const side = (moving, fixed) => {
    const f = fixed.stops[0].v[0];
    const vs = moving.stops.map(x => x.v[0]);
    return vs.every(v => v <= f) || vs.every(v => v >= f);
  };
  if (trackIsStatic(s)) return side(e, s);
  if (trackIsStatic(e)) return side(s, e);
  return false;
}

// "Simultaneously": the visible window [S, E] (shifted by O, wrapping at 1)
// runs over all member paths laid end to end; this path covers [a, b].
// Returns this path's local [length, start].
export function localTrim(a, b, S, E, O) {
  const w = b - a;
  if (w <= 0) return [0, 0];
  if (E - S >= 1 - 1e-9) return [1, 0];
  let A = S + O;
  A -= Math.floor(A);
  const B = A + (E - S);
  const p1 = [Math.max(A, a), Math.min(B, 1, b)];
  const p2 = B > 1 ? [a, Math.min(B - 1, b)] : null;
  const has1 = p1[1] > p1[0], has2 = !!p2 && p2[1] > p2[0];
  if (has1 && has2) return [(b - p1[0] + p2[1] - a) / w, (p1[0] - a) / w];
  const p = has1 ? p1 : has2 ? p2 : null;
  return p ? [(p[1] - p[0]) / w, (p[0] - a) / w] : [0, 0];
}

// --- Merge Paths ---

function mergeEntry(entries, it, ctx, where) {
  if (ctx.merges.has(it)) return ctx.merges.get(it);
  const mode = it.mode || 'add';
  if (entries.some(e => e.trimmed)) ctx.warn(where, 'Trim Paths on paths above Merge Paths are not supported (ignored)');
  const tracks = entries.map(e => e.track());
  if (tracks.some(t => !t)) ctx.warn(where, 'nested intersect/subtract merges are flattened to their first path');
  const usable = tracks.filter(Boolean);
  const entry = mode === 'intersect' || mode === 'subtract'
    ? booleanEntry(usable, mode, ctx, where)
    : combinedEntry(usable, mode, ctx, where);
  ctx.merges.set(it, entry);
  return entry;
}

// add: subpaths side by side (the fill's own rule decides holes).
// merge: union, via clockwise subpaths + nonzero. exclude: evenodd (XOR).
function combinedEntry(tracks, mode, ctx, where) {
  const prepared = mode === 'merge' ? tracks.map(t => mapTrack(t, orientClockwise)) : tracks;
  const combined = combineTracks(prepared, (...arrs) => [].concat(...arrs), sampling(ctx, KIND.shape.tol));
  const r = finalize(combined, ctx, KIND.shape.tol);
  const d = arrayToD(r.value);
  const anim = animate('d', r, arrayToD, ctx);
  return {
    track: () => combined,
    trimmed: false,
    render(style) {
      const attrs = { d, ...style.attrs };
      if (mode === 'exclude') attrs['fill-rule'] = 'evenodd';
      if (mode === 'merge') {
        delete attrs['fill-rule'];
        if (style.kind === 'stroke' && tracks.length > 1) ctx.warn(where, 'strokes on a "merge" Merge Paths also outline overlapping parts');
      }
      const dash = withDash(attrs, style);
      return element('path', attrs, anim + style.anims + dash);
    },
  };
}

// intersect: first path clipped by every other path.
// subtract: first path masked by the others (assumed: the topmost path is
// the one the rest are cut out of).
function booleanEntry(tracks, mode, ctx, where) {
  const geo = tracks.map(t => {
    const r = finalize(t, ctx, KIND.shape.tol);
    return { d: arrayToD(r.value), anim: animate('d', r, arrayToD, ctx) };
  });
  const [first, ...rest] = geo;
  const wrappers = [];
  if (rest.length && mode === 'intersect') {
    for (const g of rest) {
      const id = newId(ctx, 'clip');
      ctx.defs.push(element('clipPath', { id }, element('path', { d: g.d }, g.anim)));
      wrappers.push({ 'clip-path': `url(#${id})` });
    }
  } else if (rest.length) {
    const id = newId(ctx, 'mask');
    const box = { x: -1e5, y: -1e5, width: 2e5, height: 2e5 };
    ctx.defs.push(element('mask', { id, maskUnits: 'userSpaceOnUse', ...box },
      element('rect', { ...box, fill: '#fff' }) + rest.map(g => element('path', { d: g.d, fill: '#000' }, g.anim)).join('')));
    wrappers.push({ mask: `url(#${id})` });
  }
  return {
    track: () => null,
    trimmed: false,
    render(style) {
      if (!first) return '';
      if (style.kind === 'stroke' && rest.length) ctx.warn(where, `strokes on a "${mode}" Merge Paths outline the original path, cut to the result`);
      const attrs = { d: first.d, ...style.attrs };
      const dash = withDash(attrs, style);
      return wrappers.reduce((out, w) => element('g', w, out), element('path', attrs, first.anim + style.anims + dash));
    },
  };
}
