// AE transforms → nested SVG groups, or → matrix tracks for flattening paths.

import { num } from './format.js';
import { KIND, isAnimated, staticValue, combineTracks, orientationTrack, trackIsStatic } from './timeline.js';
import { animate, element, finalize, fmtOpacity, resolve, sampling, smilAttrs, timing, trackOf } from './anim.js';

// AE applies translate(position) · rotate · scale · translate(−anchor).
// Static parts are merged into one transform attribute. Each animated part
// gets a group of its own, composed onto the static parts before it with
// additive="sum".
function transformParts(tr, ctx, where) {
  const parts = [];
  const add = (type, r, fmt, identity) => {
    if (r.smil || fmt(r.value) !== identity) parts.push({ type, r, fmt });
  };
  const pos = tr.position;
  if (pos && pos.separated) {
    add('translate', resolve(pos.x ?? 0, KIND.scalar, ctx, `${where} › X Position`), v => `${num(v[0])} 0`, '0 0');
    add('translate', resolve(pos.y ?? 0, KIND.scalar, ctx, `${where} › Y Position`), v => `0 ${num(v[0])}`, '0 0');
  } else {
    add('translate', resolve(pos ?? [0, 0], KIND.point, ctx, `${where} › Position`), v => `${num(v[0])} ${num(v[1])}`, '0 0');
  }
  add('rotate', rotation(tr, ctx, where), v => num(v[0]), '0');
  add('scale', resolve(tr.scale ?? [100, 100], KIND.vec2, ctx, `${where} › Scale`),
    v => `${num(v[0] / 100, 4)} ${num(v[1] / 100, 4)}`, '1 1');
  if (tr.skew !== undefined && (isAnimated(tr.skew) || staticValue(tr.skew) !== 0)) {
    ctx.warn(where, 'skew is not supported (ignored)');
  }
  add('translate', resolve(tr.anchor ?? [0, 0], KIND.point, ctx, `${where} › Anchor Point`),
    v => `${num(-v[0])} ${num(-v[1])}`, '0 0');
  return parts;
}

// Rotation, plus the motion path's direction when the layer auto-orients.
function rotation(tr, ctx, where) {
  const w = `${where} › Rotation`;
  const rot = trackOf(tr.rotation ?? 0, KIND.scalar, ctx, w);
  if (!tr.autoOrient) return finalize(rot, ctx, KIND.scalar.tol);
  if (tr.position && tr.position.separated) {
    ctx.warn(where, 'Auto-Orient with separated position dimensions is not supported (ignored)');
    return finalize(rot, ctx, KIND.scalar.tol);
  }
  const orient = orientationTrack(tr.position ?? [0, 0], ctx.fps);
  if (!orient) return finalize(rot, ctx, KIND.scalar.tol);
  return finalize(combineTracks([rot, orient], (r, o) => [r[0] + o[0]], sampling(ctx, KIND.scalar.tol)), ctx, KIND.scalar.tol);
}

export function wrapTransform(tr, inner, ctx, where, { opacity }) {
  tr = tr || {};
  const extra = {};
  let anims = '';
  if (opacity) {
    const o = resolve(tr.opacity ?? 100, KIND.scalar, ctx, `${where} › Opacity`);
    if (o.smil || o.value[0] !== 100) {
      extra.opacity = fmtOpacity(o.value);
      anims = animate('opacity', o, fmtOpacity, ctx);
    }
  }
  return wrapParts(transformParts(tr, ctx, where), inner, ctx, { attrs: extra, anims });
}

// Parts [{ type, r: { value, smil }, fmt }] (outer first) → nested groups.
// `innermost` adds attributes/animations (e.g. opacity) to the innermost group.
export function wrapParts(parts, inner, ctx, innermost = { attrs: {}, anims: '' }) {
  const groups = [];
  let statics = [];
  for (const p of parts) {
    if (!p.r.smil) { statics.push(`${p.type}(${p.fmt(p.r.value)})`); continue; }
    const additive = statics.length ? ' additive="sum"' : '';
    const base = statics.length ? statics.join(' ') : `${p.type}(${p.fmt(p.r.value)})`;
    groups.push({
      attrs: { transform: base },
      anims: `<animateTransform attributeName="transform" type="${p.type}" ${smilAttrs(p.r.smil, p.fmt)}${additive} ${timing(ctx)}/>`,
    });
    statics = [];
  }
  if (statics.length) groups.push({ attrs: { transform: statics.join(' ') }, anims: '' });
  if (Object.keys(innermost.attrs).length || innermost.anims) {
    if (!groups.length) groups.push({ attrs: {}, anims: '' });
    const g = groups[groups.length - 1];
    Object.assign(g.attrs, innermost.attrs);
    g.anims += innermost.anims;
  }
  return groups.reduceRight((acc, g) => element('g', g.attrs, g.anims + acc), inner);
}

// A transform part for wrapParts(); dropped when static and identity.
export function part(type, r, fmt, identity) {
  return r.smil || fmt(r.value) !== identity ? [{ type, r, fmt }] : [];
}

// The transform as a track of affine matrices (for flattening paths into a
// parent's space). `linear` is false when the matrix changes over time,
// since rotation and scale don't map linearly onto path coordinates.
export function matrixTrack(tr, ctx, where) {
  tr = tr || {};
  const pos = tr.position;
  const position = pos && pos.separated
    ? combineTracks([trackOf(pos.x ?? 0, KIND.scalar, ctx, where), trackOf(pos.y ?? 0, KIND.scalar, ctx, where)],
      (x, y) => [x[0], y[0]], sampling(ctx, 0.01))
    : trackOf(pos ?? [0, 0], KIND.point, ctx, where);
  const parts = [
    position,
    trackOf(tr.rotation ?? 0, KIND.scalar, ctx, where),
    trackOf(tr.scale ?? [100, 100], KIND.vec2, ctx, where),
    trackOf(tr.anchor ?? [0, 0], KIND.point, ctx, where),
  ];
  return { parts, moving: parts.some(t => !trackIsStatic(t)) };
}
