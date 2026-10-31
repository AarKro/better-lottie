// IR → self-animating SVG (SMIL).

import { validate } from './ir.js';
import { num, hex, escAttr, escComment } from './format.js';
import { arrayToD, rectShape, ellipseShape, shapeToArray } from './path.js';
import {
  KIND, asProp, isAnimated, staticValue, propToTrack, propValueAt, mapTrack, bakeFunction, finalizeTrack,
} from './timeline.js';

export const VERSION = '0.1.0';

const GEOMETRY = new Set(['path', 'rect', 'ellipse']);

/**
 * @param {import('./ir.js').IR} ir
 * @param {{ loop?: boolean }} [options]
 * @returns {{ svg: string, warnings: string[] }}
 */
export function convert(ir, options = {}) {
  validate(ir);
  const comp = ir.comp;
  const warnings = [];
  const seen = new Set();
  const ctx = {
    D: comp.duration,
    fps: comp.frameRate,
    loop: options.loop !== false,
    byId: new Map(ir.layers.map(l => [l.id, l])),
    geometry: new Map(),
    warn(where, msg) {
      const s = `${where}: ${msg}`;
      if (!seen.has(s)) { seen.add(s); warnings.push(s); }
    },
  };

  const parts = [`<!-- ${escComment(`better-lottie ${VERSION} · comp "${comp.name || ''}"`)} -->`];
  if (comp.background) {
    parts.push(`<rect width="${num(comp.width)}" height="${num(comp.height)}" fill="${hex(comp.background)}"/>`);
  }
  // AE lists the top layer first; SVG paints in document order.
  for (const layer of [...ir.layers].reverse()) {
    const out = renderLayer(layer, ctx);
    if (out) parts.push(out);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(comp.width)} ${num(comp.height)}" `
    + `width="${num(comp.width)}" height="${num(comp.height)}">\n${parts.join('\n')}\n</svg>\n`;
  return { svg, warnings };
}

// --- animation helpers ---

function timing(ctx) {
  return `dur="${num(ctx.D, 4)}s" begin="0s" ${ctx.loop ? 'repeatCount="indefinite"' : 'fill="freeze"'}`;
}

function smilAttrs(smil, fmt) {
  let s = `values="${smil.values.map(fmt).join(';')}" keyTimes="${smil.keyTimes.map(k => num(k, 6)).join(';')}"`;
  if (smil.calcMode !== 'linear') s += ` calcMode="${smil.calcMode}"`;
  if (smil.keySplines) s += ` keySplines="${smil.keySplines.map(sp => sp.map(x => num(x, 4)).join(' ')).join(';')}"`;
  return s;
}

function animate(attr, r, fmt, ctx) {
  return r.smil ? `<animate attributeName="${attr}" ${smilAttrs(r.smil, fmt)} ${timing(ctx)}/>` : '';
}

function resolve(prop, kind, ctx, where) {
  const track = propToTrack(prop, kind, { fps: ctx.fps, warn: m => ctx.warn(where, m) });
  return finalizeTrack(track, ctx.D, ctx.fps, kind.tol);
}

const fmtOpacity = v => num(v[0] / 100, 4);

// --- transforms ---

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
  add('rotate', resolve(tr.rotation ?? 0, KIND.scalar, ctx, `${where} › Rotation`), v => num(v[0]), '0');
  add('scale', resolve(tr.scale ?? [100, 100], KIND.vec2, ctx, `${where} › Scale`),
    v => `${num(v[0] / 100, 4)} ${num(v[1] / 100, 4)}`, '1 1');
  if (tr.skew !== undefined && (isAnimated(tr.skew) || staticValue(tr.skew) !== 0)) {
    ctx.warn(where, 'skew is not supported (ignored)');
  }
  add('translate', resolve(tr.anchor ?? [0, 0], KIND.point, ctx, `${where} › Anchor Point`),
    v => `${num(-v[0])} ${num(-v[1])}`, '0 0');
  return parts;
}

function wrapTransform(tr, inner, ctx, where, { opacity }) {
  tr = tr || {};
  const groups = [];
  let statics = [];
  for (const p of transformParts(tr, ctx, where)) {
    if (!p.r.smil) { statics.push(`${p.type}(${p.fmt(p.r.value)})`); continue; }
    const additive = statics.length ? ' additive="sum"' : '';
    const base = statics.length ? statics.join(' ') : `${p.type}(${p.fmt(p.r.value)})`;
    groups.push({
      attrs: ` transform="${base}"`,
      anims: `<animateTransform attributeName="transform" type="${p.type}" ${smilAttrs(p.r.smil, p.fmt)}${additive} ${timing(ctx)}/>`,
    });
    statics = [];
  }
  if (statics.length) groups.push({ attrs: ` transform="${statics.join(' ')}"`, anims: '' });

  if (opacity) {
    const o = resolve(tr.opacity ?? 100, KIND.scalar, ctx, `${where} › Opacity`);
    if (o.smil || o.value[0] !== 100) {
      if (!groups.length) groups.push({ attrs: '', anims: '' });
      const g = groups[groups.length - 1];
      g.attrs += ` opacity="${fmtOpacity(o.value)}"`;
      g.anims += animate('opacity', o, fmtOpacity, ctx);
    }
  }

  return groups.reduceRight((acc, g) => `<g${g.attrs}>${g.anims}${acc}</g>`, inner);
}

// --- layers ---

function renderLayer(layer, ctx) {
  const where = `layer "${layer.name}"`;
  if (layer.enabled === false || layer.type === 'null') return '';
  if (layer.type !== 'shape') {
    ctx.warn(where, `${layer.type} layers are not supported (skipped)`);
    return '';
  }
  if (layer.threeD) ctx.warn(where, '3D layer exported as 2D');
  if (layer.blendMode && layer.blendMode !== 'normal') ctx.warn(where, `blend mode "${layer.blendMode}" is not supported (exported as normal)`);
  if (layer.trackMatte) ctx.warn(where, 'track mattes are not supported (ignored)');

  const content = renderStack(layer.contents || [], ctx, where);
  if (!content) return '';
  let out = wrapTransform(layer.transform, content, ctx, where, { opacity: true });

  // AE parenting passes down transforms but not opacity.
  const chain = new Set([layer.id]);
  for (let pid = layer.parent; pid != null;) {
    const p = ctx.byId.get(pid);
    if (!p || chain.has(pid)) { ctx.warn(where, 'broken parent chain (rest of chain ignored)'); break; }
    chain.add(pid);
    out = wrapTransform(p.transform, out, ctx, `layer "${p.name}"`, { opacity: false });
    pid = p.parent;
  }
  return withVisibility(layer, out, ctx);
}

// Layer in/out points → a discrete visibility animation.
function withVisibility(layer, out, ctx) {
  const D = ctx.D;
  const tIn = layer.inPoint ?? 0, tOut = layer.outPoint ?? D;
  if (tIn <= 0 && tOut >= D) return out;
  if (tOut <= 0 || tIn >= D || tOut <= tIn) return '';
  const values = [], times = [];
  if (tIn > 0) { values.push('hidden'); times.push(0); }
  values.push('visible'); times.push(tIn > 0 ? tIn / D : 0);
  if (tOut < D) { values.push('hidden'); times.push(tOut / D); }
  return `<g visibility="${values[0]}"><animate attributeName="visibility" calcMode="discrete" `
    + `values="${values.join(';')}" keyTimes="${times.map(t => num(t, 6)).join(';')}" ${timing(ctx)}/>${out}</g>`;
}

// --- shape contents ---

// AE draws a group's items bottom-up. Each fill/stroke paints the paths
// above it; each sub-group draws as a unit.
function renderStack(items, ctx, where) {
  let out = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    if (it.type === 'fill' || it.type === 'stroke') {
      const style = paint(it, ctx, w);
      out += collectGeometry(items, i, ctx, where).map(f => f(style)).join('');
    } else if (it.type === 'group') {
      const inner = renderStack(it.contents || [], ctx, w);
      if (inner) out += wrapTransform(it.transform, inner, ctx, w, { opacity: true });
    } else if (!GEOMETRY.has(it.type)) {
      ctx.warn(w, `shape item "${it.type}" is not supported (ignored)`);
    }
  }
  return out;
}

// Render functions for every path above index `end`, nested groups included.
function collectGeometry(items, end, ctx, where) {
  const fns = [];
  for (let j = 0; j < end; j++) {
    const it = items[j];
    if (it.enabled === false) continue;
    const w = `${where} › ${it.name || it.type}`;
    if (GEOMETRY.has(it.type)) {
      const g = geometry(it, ctx, w);
      fns.push(style => {
        const kids = g.anim + style.anims;
        return `<path d="${g.d}"${style.attrs}${kids ? `>${kids}</path>` : '/>'}`;
      });
    } else if (it.type === 'group') {
      const inner = collectGeometry(it.contents || [], (it.contents || []).length, ctx, w);
      if (inner.length) {
        fns.push(style => wrapTransform(it.transform, inner.map(f => f(style)).join(''), ctx, w, { opacity: false }));
      }
    }
  }
  return fns;
}

function geometry(it, ctx, where) {
  if (ctx.geometry.has(it)) return ctx.geometry.get(it);
  const r = it.type === 'path' ? resolve(it.path, KIND.shape, ctx, where) : primitive(it, ctx);
  const g = { d: arrayToD(r.value), anim: animate('d', r, arrayToD, ctx) };
  ctx.geometry.set(it, g);
  return g;
}

// Rects and ellipses become paths. The path is linear in each parameter, so
// a single animated parameter keeps its keyframes and easing. Several
// animated parameters are baked.
function primitive(it, ctx) {
  const isRect = it.type === 'rect';
  const props = [
    [it.size ?? [100, 100], KIND.vec2],
    [it.position ?? [0, 0], KIND.point],
    ...(isRect ? [[it.roundness ?? 0, KIND.scalar]] : []),
  ];
  const rounded = isRect && (isAnimated(props[2][0]) || staticValue(props[2][0]) > 0);
  const build = args => shapeToArray(isRect ? rectShape(args[0], args[1], args[2], rounded) : ellipseShape(args[0], args[1]));
  const statics = props.map(([p, k]) => k.toArray(staticValue(asProp(p))));
  const animated = props.map(([p], i) => (isAnimated(p) ? i : -1)).filter(i => i >= 0);
  const noWarn = { fps: ctx.fps, warn: () => {} };

  if (!animated.length) return { value: build(statics), smil: null };
  if (animated.length === 1) {
    const i = animated[0];
    const track = propToTrack(props[i][0], props[i][1], noWarn);
    const mapped = mapTrack(track, v => build(statics.map((s, j) => (j === i ? v : s))));
    return finalizeTrack(mapped, ctx.D, ctx.fps, KIND.shape.tol);
  }
  const times = animated.flatMap(i => asProp(props[i][0]).keyframes.map(k => k.t));
  const track = bakeFunction(
    t => build(props.map(([p, k]) => propValueAt(p, k, t))),
    Math.min(...times), Math.max(...times), ctx.fps, KIND.shape.tol,
  );
  return finalizeTrack(track, ctx.D, ctx.fps, KIND.shape.tol);
}

function paint(it, ctx, where) {
  const color = resolve(it.color ?? [1, 1, 1], KIND.color, ctx, `${where} › Color`);
  const opacity = resolve(it.opacity ?? 100, KIND.scalar, ctx, `${where} › Opacity`);
  let attrs, anims;
  if (it.type === 'fill') {
    attrs = ` fill="${hex(color.value)}"`;
    anims = animate('fill', color, hex, ctx);
    if (opacity.smil || opacity.value[0] !== 100) {
      attrs += ` fill-opacity="${fmtOpacity(opacity.value)}"`;
      anims += animate('fill-opacity', opacity, fmtOpacity, ctx);
    }
    if (it.fillRule === 'evenodd') attrs += ' fill-rule="evenodd"';
  } else {
    const width = resolve(it.width ?? 2, KIND.scalar, ctx, `${where} › Stroke Width`);
    const fmtW = v => num(v[0]);
    attrs = ` fill="none" stroke="${hex(color.value)}" stroke-width="${fmtW(width.value)}"`;
    anims = animate('stroke', color, hex, ctx) + animate('stroke-width', width, fmtW, ctx);
    if (opacity.smil || opacity.value[0] !== 100) {
      attrs += ` stroke-opacity="${fmtOpacity(opacity.value)}"`;
      anims += animate('stroke-opacity', opacity, fmtOpacity, ctx);
    }
    if (it.lineCap && it.lineCap !== 'butt') attrs += ` stroke-linecap="${escAttr(it.lineCap)}"`;
    if (it.lineJoin && it.lineJoin !== 'miter') attrs += ` stroke-linejoin="${escAttr(it.lineJoin)}"`;
    if (it.miterLimit != null && it.miterLimit !== 4) attrs += ` stroke-miterlimit="${num(it.miterLimit)}"`;
    if (it.dashes) ctx.warn(where, 'dashes are not supported yet (ignored)');
  }
  return { attrs, anims };
}
