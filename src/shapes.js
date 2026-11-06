// Shape layer contents → SVG: groups, paths, paints, Merge Paths, Trim Paths,
// Repeaters.
//
// AE semantics this follows:
// - A group's items draw bottom-up. Each paint draws the paths above it in
//   the same group, including paths in groups above it.
// - A paint draws all of those paths as one compound shape: with a fill's
//   rule an inner path cuts a hole (outlined Illustrator artwork), and
//   overlaps of a translucent fill or stroke are not painted twice.
// - A modifier (Trim Paths) changes every path above it, including paths in
//   groups above it, no matter where the paints are.
// - Merge Paths combines the paths above it into one; paints below it draw
//   the merged result.
// - A Repeater copies everything above it (paths and paints); paints below it
//   draw every copy.

import { KIND, combineTracks, mapTrack, trackIsStatic, trackValueAt } from './timeline.js';
import { outlineShape } from './taper.js';
import { arrayToD, ellipseShape, polystarShape, rectShape, reverseBlocks, shapeToArray } from './path.js';
import { orientClockwise, shapeLength, transformMatrix, transformShape } from './geometry.js';
import { animate, displayToggle, element, finalize, newId, sampling, trackOf } from './anim.js';
import { num } from './format.js';
import { paint, PAINTS } from './paint.js';
import { cssBlend } from './blend.js';
import { matrixTrack, part, wrapParts, wrapTransform } from './transform.js';

const GEOMETRY = new Set(['path', 'rect', 'ellipse', 'polystar']);
const MODIFIERS = new Set(['trim', 'merge-paths', 'repeater']);

export function renderContents(items, ctx, where) {
  assignTrims(items, [], ctx, where);
  return renderStack(items, ctx, where);
}

// Renders items [0, end). A Repeater repeats everything above it, so the
// lowest one splits the stack: items below it draw first, then the copies.
function renderStack(items, ctx, where, end = items.length) {
  let r = -1;
  for (let i = end - 1; i >= 0 && r < 0; i--) if (items[i].type === 'repeater' && items[i].enabled !== false) r = i;
  let out = '';
  for (let i = end - 1; i > r; i--) {
    const it = items[i];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    const blend = shapeBlend(it, ctx, w);
    if (PAINTS.has(it.type)) {
      const style = paint(it, ctx, w);
      if (blend) blendStyle(style, blend);
      const entries = collectGeometry(items, i, ctx, where);
      out += compoundPaint(entries, style, ctx).join('');
    } else if (it.type === 'group') {
      const inner = renderStack(it.contents || [], ctx, w);
      if (inner) {
        const grouped = wrapTransform(it.transform, inner, ctx, w, { opacity: true });
        out += blend ? element('g', { style: `mix-blend-mode:${blend}` }, grouped) : grouped;
      }
    } else if (!GEOMETRY.has(it.type) && !MODIFIERS.has(it.type)) {
      ctx.warn(w, `shape item "${it.type}" is not supported (ignored)`);
    }
  }
  if (r >= 0) {
    const above = renderStack(items, ctx, where, r);
    if (above) out += repeat(items[r], above, ctx, `${where} › ${items[r].name || 'Repeater'}`);
  }
  return out;
}

// Blend mode of a group, fill or stroke as CSS (null when normal). The IR
// carries AE's mode name; older extractors wrote the raw number.
function shapeBlend(it, ctx, where) {
  if (it.blendMode === undefined) return null;
  if (typeof it.blendMode === 'number') {
    ctx.warn(where, 'shape blend modes need a newer extractor; re-export from After Effects');
    return null;
  }
  const css = cssBlend(it.blendMode, ctx, where);
  if (css) { ctx.shapeBlends = true; ctx.blends = true; }
  return css;
}

function blendStyle(style, css) {
  const add = attrs => { if (attrs) attrs.style = `mix-blend-mode:${css}`; };
  add(style.attrs);
  if (style.outline) add(style.outline.attrs);
}

// Drawable entries for everything above index `end`:
//   { track(): shape track in this group's space (null if not expressible),
//     trimmed: the path's Trim Paths info (or false),
//     compound: a plain path a paint can join into one compound path without
//       baking (no animated group transform, no modifier in between),
//     render(style) → SVG string }
function collectGeometry(items, end, ctx, where) {
  let entries = [];
  for (let j = 0; j < end; j++) {
    const it = items[j];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    if (GEOMETRY.has(it.type)) {
      entries.push({
        track: () => geometry(it, ctx, w).track,
        trimmed: ctx.trimOf.get(it) || false,
        compound: true,
        render: style => pathElement(it, style, ctx, w),
      });
    } else if (it.type === 'group') {
      for (const e of collectGeometry(it.contents || [], (it.contents || []).length, ctx, w)) {
        entries.push(nestEntry(e, it.transform, ctx, w));
      }
    } else if (it.type === 'merge-paths' && entries.length) {
      entries = [mergeEntry(entries, it, ctx, w)];
    } else if (it.type === 'repeater' && entries.length) {
      entries = entries.map(e => ({
        track: () => null,
        trimmed: e.trimmed,
        render: style => repeat(it, e.render(style), ctx, w),
      }));
    }
  }
  return entries;
}

// An entry from a sub-group: drawn inside the group's transform, or
// flattened into this group's space when merged.
function nestEntry(e, tr, ctx, where) {
  const m = matrixTrack(tr, ctx, where);
  return {
    track() {
      const inner = e.track();
      if (!inner) return null;
      return combineTracks([inner, ...m.parts],
        (shape, pos, rot, scale, anchor) => transformShape(shape, transformMatrix(pos, rot[0], scale, anchor)),
        sampling(ctx, KIND.shape.tol, !m.moving));
    },
    trimmed: e.trimmed,
    compound: e.compound && !m.moving,
    render: style => wrapTransform(tr, e.render(style), ctx, where, { opacity: false }),
  };
}

// A paint's paths as one <path>, like AE draws them (verified in AE 2026):
// the fill rule sees all subpaths together, so inner paths cut holes, and a
// translucent fill or stroke doesn't double up where paths overlap. Entries
// that can't join (behind an animated group transform, repeated, boolean
// merges) are drawn on their own, and so are strokes with dashes, taper or
// Trim Paths, which work per path.
function compoundPaint(entries, style, ctx) {
  const isFill = style.kind === 'fill';
  if (!isFill && (style.dash || style.outline)) return entries.map(e => e.render(style));
  const members = entries.filter(e => e.compound && (isFill || !e.trimmed));
  if (members.length < 2) return entries.map(e => e.render(style));
  for (const e of members) {
    if (e.trimmed) ctx.warn(e.trimmed.state.where, 'Trim Paths only trims strokes in the export; fills stay whole');
  }
  const r = finalize(concatShapes(members.map(e => e.track()), ctx), ctx, KIND.shape.tol);
  const compound = element('path', { d: arrayToD(r.value), ...style.attrs }, animate('d', r, arrayToD, ctx) + style.anims);
  return entries.map(e => (e === members[0] ? compound : members.includes(e) ? '' : e.render(style)));
}

// Shape tracks → one track of their concatenated subpaths. Concatenation is
// linear, so when every moving shape has the same keyframe times and easing
// (e.g. a compound path keyed as a whole) the keyframes carry over exactly;
// otherwise combineTracks bakes it.
function concatShapes(tracks, ctx) {
  const concat = (...arrs) => [].concat(...arrs);
  const moving = tracks.filter(t => !trackIsStatic(t));
  const ref = moving[0];
  if (moving.length > 1 && moving.every(t => sameTiming(t, ref))) {
    return {
      stops: ref.stops.map((s, k) => ({ t: s.t, v: concat(...tracks.map(t => (trackIsStatic(t) ? t.stops[0] : t.stops[k]).v)) })),
      segs: ref.segs,
    };
  }
  return combineTracks(tracks, concat, sampling(ctx, KIND.shape.tol));
}

function sameTiming(a, b) {
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  return a.stops.length === b.stops.length
    && a.stops.every((s, k) => near(s.t, b.stops[k].t))
    && a.segs.every((s, k) => {
      const o = b.segs[k];
      if (s.hold || o.hold) return !!s.hold === !!o.hold;
      return s.spline.every((x, c) => near(x, o.spline[c]));
    });
}

// --- geometry ---

function geometry(it, ctx, where) {
  if (ctx.geometry.has(it)) return ctx.geometry.get(it);
  let track = it.type === 'path' ? trackOf(it.path, KIND.shape, ctx, where)
    : it.type === 'polystar' ? polystarTrack(it, ctx, where) : primitiveTrack(it, ctx, where);
  if (it.direction === 'reversed') track = mapTrack(track, reverseBlocks);
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

// Polygon/Star: linear in position, radii and roundness (one moving keeps its
// keyframes), except a fractional polygon's partial vertex, whose handle is
// quadratic in roundness. Animated points or rotation bake; animated points
// pad every frame to the same vertex count so the path can morph.
function polystarTrack(it, ctx, where) {
  const polygon = it.starType === 'polygon';
  const scalar = (prop, name, def) => trackOf(prop ?? def, KIND.scalar, ctx, `${where} › ${name}`);
  const tracks = [
    scalar(it.points, 'Points', 5),
    trackOf(it.position ?? [0, 0], KIND.point, ctx, `${where} › Position`),
    scalar(it.rotation, 'Rotation', 0),
    scalar(polygon ? 0 : it.innerRadius, 'Inner Radius', 50),
    scalar(it.outerRadius, 'Outer Radius', 100),
    scalar(polygon ? 0 : it.innerRoundness, 'Inner Roundness', 0),
    scalar(it.outerRoundness, 'Outer Roundness', 0),
  ];
  const [points, , rotation, , , , outerRound] = tracks;
  const pointsMove = !trackIsStatic(points);
  const pad = pointsMove ? Math.max(...points.stops.map(s => s.v[0])) : null;
  const n = points.stops[0].v[0];
  const linear = trackIsStatic(rotation) && !pointsMove
    && !(polygon && n !== Math.floor(n) && !trackIsStatic(outerRound));
  return combineTracks(tracks,
    ([pts], position, [rot], [ir], [or], [is], [os]) => shapeToArray(polystarShape({
      type: polygon ? 'polygon' : 'star', points: pts, position, rotation: rot,
      innerRadius: ir, outerRadius: or, innerRoundness: is, outerRoundness: os,
    }, pad)),
    sampling(ctx, KIND.shape.tol, linear));
}

function withDash(attrs, style) {
  if (!style.dash) return '';
  Object.assign(attrs, style.dash.attrs);
  return style.dash.anims;
}

function pathElement(it, style, ctx, where) {
  const g = geometry(it, ctx, where);
  if (style.outline) return outlineElement(it, g, style.outline, ctx, where);
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

// A tapered/waved stroke as a filled outline. Trim Paths cut the centerline
// first, so the taper follows the visible part like in AE.
function outlineElement(it, g, outline, ctx, where) {
  const info = ctx.trimOf.get(it);
  const trim = info ? trimFor(it, info, ctx) : null;
  const inputs = [g.track, ...outline.tracks];
  if (trim) inputs.push(trim.track);
  const track = combineTracks(inputs,
    (shape, ...rest) => outlineShape(shape, trim ? rest.slice(0, -1) : rest, outline, trim ? rest[rest.length - 1] : null),
    sampling(ctx, 0.05, false));
  const r = finalize(track, ctx, 0.05);
  return element('path', { d: arrayToD(r.value), ...outline.attrs }, animate('d', r, arrayToD, ctx) + outline.anims);
}

// --- Repeater ---

// Copy k (k = index + offset) is drawn with
//   translate(position·k) · translate(anchor) · rotate(rotation·k) · scale(scale^k) · translate(−anchor)
// — the position steps are not rotated or scaled by earlier copies. Copy i
// has opacity start + (end − start) · i / ⌈copies⌉ (so End Opacity itself is
// never reached), and a fractional copy count fades the last copy by the
// fraction. Both measured against AE renders. The repeated content
// is written once and the other copies <use> it.
function repeat(rep, content, ctx, where) {
  const tr = rep.transform || {};
  const t = (p, fallback, kind, label) => trackOf(p ?? fallback, kind, ctx, `${where} › ${label}`);
  const copies = t(rep.copies, 3, KIND.scalar, 'Copies');
  const offset = t(rep.offset, 0, KIND.scalar, 'Offset');
  const pos = t(tr.position, [0, 0], KIND.point, 'Position');
  const anchor = t(tr.anchor, [0, 0], KIND.point, 'Anchor Point');
  const rot = t(tr.rotation, 0, KIND.scalar, 'Rotation');
  const scale = t(tr.scale, [100, 100], KIND.vec2, 'Scale');
  const startOp = t(rep.startOpacity, 100, KIND.scalar, 'Start Opacity');
  const endOp = t(rep.endOpacity, 100, KIND.scalar, 'End Opacity');
  const maxCopies = Math.max(0, Math.ceil(Math.max(...copies.stops.map(s => s.v[0])) - 1e-9));
  if (!maxCopies) return '';

  const id = newId(ctx, 'rep');
  const fixedOffset = trackIsStatic(offset);
  const copyEls = [];
  for (let i = 0; i < maxCopies; i++) {
    const k = ([o]) => i + o[0];
    const lin = sampling(ctx, 0.01, fixedOffset);
    const parts = [
      ...part('translate', finalize(combineTracks([pos, offset], (p, o) => [p[0] * k([o]), p[1] * k([o])], lin), ctx, 0.01),
        v => `${num(v[0])} ${num(v[1])}`, '0 0'),
      ...part('translate', finalize(anchor, ctx, 0.01), v => `${num(v[0])} ${num(v[1])}`, '0 0'),
      ...part('rotate', finalize(combineTracks([rot, offset], (r, o) => [r[0] * k([o])], lin), ctx, 0.01), v => num(v[0]), '0'),
      ...part('scale', finalize(combineTracks([scale, offset],
        (s, o) => [Math.pow(s[0] / 100, k([o])), Math.pow(s[1] / 100, k([o]))], sampling(ctx, 0.0001, false)), ctx, 0.0001),
      v => `${num(v[0], 4)} ${num(v[1], 4)}`, '1 1'),
      ...part('translate', finalize(anchor, ctx, 0.01), v => `${num(-v[0])} ${num(-v[1])}`, '0 0'),
    ];
    const opacity = finalize(combineTracks([copies, startOp, endOp], ([c], [a], [b]) => {
      const n = Math.ceil(c - 1e-9);
      if (i >= n) return [0];
      const ramp = a + (b - a) * (i / n);
      const partial = i === n - 1 && c % 1 > 1e-9 ? c % 1 : 1;
      return [Math.max(0, ramp * partial)];
    }, sampling(ctx, 0.01, trackIsStatic(copies))), ctx, 0.01);
    const innermost = { attrs: {}, anims: '' };
    if (opacity.smil || opacity.value[0] !== 100) {
      innermost.attrs.opacity = num(opacity.value[0] / 100, 4);
      innermost.anims = animate('opacity', opacity, v => num(v[0] / 100, 4), ctx);
    }
    const body = i === 0 ? element('g', { id }, content) : element('use', { href: `#${id}` });
    copyEls.push(wrapParts(parts, body, ctx, innermost));
  }
  // "Below": each copy goes under the previous one, so copy 0 is drawn last.
  if (rep.composite !== 'above') copyEls.reverse();
  return copyEls.join('');
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
// length, shifted to the visible start. Tracks hold [visible length, start],
// both as fractions of the path.
// The gap must keep the next dash off the path: a dash starting exactly at
// the path's end is drawn or not depending on rounding, and with round caps
// that shows as a flickering dot. So the gap is 1.001 (next dash past the end)
// unless the visible part wraps around the end (offsets on closed paths);
// then the period is 1 plus a hair, which still wraps like AE.
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
    const wraps = track.stops.some(({ v: [len, from] }) => from < -1e-6 || from + len > 1 + 1e-6);
    const gap = len => (wraps ? Math.max(0, 1 - len) : 1) + 0.001;
    const fmtDash = v => `${num(v[0], 4)} ${num(gap(v[0]), 4)}`;
    const fmtOffset = v => num(-v[0], 4);
    result = {
      track,
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

// Verified against AE renders (comp merge-modes in the scratch project):
// merge: subpaths as drawn, so the fill's rule and the windings decide holes
//   (AE builds Illustrator compound paths this way).
// add: union whatever the windings or fill rule, via clockwise subpaths +
//   nonzero. exclude: evenodd (XOR).
function combinedEntry(tracks, mode, ctx, where) {
  const prepared = mode === 'add' ? tracks.map(t => mapTrack(t, orientClockwise)) : tracks;
  const combined = concatShapes(prepared, ctx);
  const r = finalize(combined, ctx, KIND.shape.tol);
  const d = arrayToD(r.value);
  const anim = animate('d', r, arrayToD, ctx);
  return {
    track: () => combined,
    trimmed: false,
    render(style) {
      const attrs = { d, ...style.attrs };
      if (mode === 'exclude') attrs['fill-rule'] = 'evenodd';
      if (mode === 'add') {
        delete attrs['fill-rule'];
        if (style.kind === 'stroke' && tracks.length > 1) ctx.warn(where, 'strokes on an "add" Merge Paths also outline overlapping parts');
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
