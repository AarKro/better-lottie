// Layer masks and track mattes → SVG <mask>s.
//
// Layer masks (layer space, applied inside the layer's transform). AE
// combines masks in order: add = union, subtract = remove, intersect =
// keep the overlap; inverted masks use their complement; opacity scales a
// mask's strength. In SVG:
//   - consecutive add/subtract masks go into one <mask> as white/black shapes
//     (painting black over white removes),
//   - each intersect (and inverted subtract) is a separate <mask> wrapped
//     around the content, since nested masks multiply.
//   Masks never reference other masks: Chromium doesn't repaint a mask whose
//   content is itself masked when that inner content animates.
//   Feather is a Gaussian blur (σ ≈ feather / 2.4, fitted against AE);
//   expansion is a stroke (grow) or an erode filter (shrink).
//   Lighten, darken and difference are approximated by add, intersect, add.
//
// Track mattes (comp space, around the whole layer): the matte layer is
// rendered into a luminance <mask>, with filters turning alpha into
// luminance and inverting where needed. AE uses sRGB luminance.

import { KIND } from './timeline.js';
import { animate, element, finalize, newId, resolve, trackOf } from './anim.js';
import { arrayToD, forEachBlock } from './path.js';
import { num } from './format.js';

const FEATHER_TO_SIGMA = 1 / 2.4;
const BIG = { x: -1e5, y: -1e5, width: 2e5, height: 2e5 };
const APPROXIMATE = { lighten: 'add', darken: 'intersect', difference: 'add' };

export function applyMasks(layer, content, ctx, where) {
  const masks = (layer.masks || []).filter(m => m && m.mode);
  if (!masks.length) return content;
  const segments = [];
  let open = null; // the add/subtract segment being filled, if any
  masks.forEach((m, i) => {
    const w = `${where} › ${m.name || `Mask ${i + 1}`}`;
    let mode = APPROXIMATE[m.mode] || m.mode;
    if (mode !== m.mode) ctx.warn(w, `mask mode "${m.mode}" is approximated as "${mode}"`);
    if (i === 0 && mode === 'intersect') mode = 'add'; // intersecting nothing = the mask itself
    if (mode === 'subtract' && m.inverted) mode = 'intersect-plain'; // remove the outside = keep the inside

    if (mode === 'intersect' || mode === 'intersect-plain') {
      const inverted = mode === 'intersect' && m.inverted;
      segments.push(inverted ? invertedShape(m, ctx, w, '#fff') : maskShape(m, ctx, w, '#fff'));
      open = null;
      return;
    }
    if (!open) {
      if (segments.length) ctx.warn(w, 'adding or subtracting after an intersect is approximated');
      open = [];
      segments.push(open);
      if (mode === 'subtract') open.push(element('rect', { ...BIG, fill: '#fff' }));
    }
    if (mode === 'add') {
      if (m.inverted && open.length) ctx.warn(w, 'an inverted add after other masks is approximated');
      open.push(m.inverted ? invertedShape(m, ctx, w, '#fff') : maskShape(m, ctx, w, '#fff'));
    } else {
      open.push(maskShape(m, ctx, w, '#000'));
    }
  });
  return segments.reduce((inner, seg) => {
    const id = newId(ctx, 'mask');
    const body = Array.isArray(seg) ? seg.join('') : seg;
    ctx.defs.push(element('mask', { id, maskUnits: 'userSpaceOnUse', ...BIG }, body));
    return element('g', { mask: `url(#${id})` }, inner);
  }, content);
}

// The mask's complement: white everywhere except the shape, all scaled by
// the mask's opacity.
function invertedShape(m, ctx, where, ink) {
  return maskShape(m, ctx, where, '#000', element('rect', { ...BIG, fill: ink }));
}

// One mask's shape painted in `ink` (with feather, expansion and opacity).
// `under` is drawn first inside the same opacity group (for inversion).
function maskShape(m, ctx, where, ink, under = '') {
  const path = trackOf(m.path, KIND.shape, ctx, `${where} › Mask Path`);
  const shape = finalize(path, ctx, KIND.shape.tol);
  const opacity = resolve(m.opacity ?? 100, KIND.scalar, ctx, `${where} › Mask Opacity`);
  const feather = resolve(m.feather ?? [0, 0], KIND.vec2, ctx, `${where} › Mask Feather`);
  const expansion = resolve(m.expansion ?? 0, KIND.scalar, ctx, `${where} › Mask Expansion`);

  const attrs = { d: arrayToD(shape.value), fill: ink };
  let anims = animate('d', shape, arrayToD, ctx);

  // Expansion: grow with a stroke of twice the amount; shrink with erosion.
  const values = r => (r.smil ? r.smil.values : [r.value]);
  const grows = values(expansion).some(v => v[0] > 0);
  const shrinks = values(expansion).some(v => v[0] < 0);
  if (grows) {
    const fmt = v => num(Math.max(0, v[0]) * 2);
    Object.assign(attrs, { stroke: ink, 'stroke-width': fmt(expansion.value), 'stroke-linejoin': 'round' });
    anims += animate('stroke-width', expansion, fmt, ctx);
  }
  const blurs = values(feather).some(v => v[0] > 0 || v[1] > 0);
  if (blurs || shrinks) {
    const filterId = newId(ctx, 'feather');
    const sigma = v => `${num(Math.max(0, v[0]) * FEATHER_TO_SIGMA)} ${num(Math.max(0, v[1]) * FEATHER_TO_SIGMA)}`;
    const radius = v => num(Math.max(0, -v[0]));
    let steps = '';
    if (shrinks) steps += element('feMorphology', { operator: 'erode', radius: radius(expansion.value) }, animate('radius', expansion, radius, ctx));
    if (blurs) steps += element('feGaussianBlur', { stdDeviation: sigma(feather.value) }, animate('stdDeviation', feather, sigma, ctx));
    ctx.defs.push(element('filter', { id: filterId, filterUnits: 'userSpaceOnUse', ...filterRegion(path, feather, expansion) }, steps));
    attrs.filter = `url(#${filterId})`;
  }

  const body = under + element('path', attrs, anims);
  if (!opacity.smil && opacity.value[0] === 100) return under ? element('g', {}, body) : body;
  return element('g', { opacity: num(opacity.value[0] / 100, 4) }, animate('opacity', opacity, v => num(v[0] / 100, 4), ctx) + body);
}

// Blur and erosion need room around the shape: its bounds over all
// keyframes, plus three sigmas and the expansion.
function filterRegion(path, feather, expansion) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { v } of path.stops) {
    forEachBlock(v, (start, n) => {
      for (let i = 0; i < n; i++) {
        const o = start + 2 + i * 6;
        for (const [dx, dy] of [[0, 0], [v[o + 2], v[o + 3]], [v[o + 4], v[o + 5]]]) {
          x0 = Math.min(x0, v[o] + dx); x1 = Math.max(x1, v[o] + dx);
          y0 = Math.min(y0, v[o + 1] + dy); y1 = Math.max(y1, v[o + 1] + dy);
        }
      }
    });
  }
  const values = r => (r.smil ? r.smil.values : [r.value]);
  const f = Math.max(0, ...values(feather).map(v => Math.max(v[0], v[1])));
  const e = Math.max(0, ...values(expansion).map(v => Math.abs(v[0])));
  const pad = f * FEATHER_TO_SIGMA * 3 + e + 2;
  return { x: num(x0 - pad), y: num(y0 - pad), width: num(x1 - x0 + 2 * pad), height: num(y1 - y0 + 2 * pad) };
}

// --- track mattes ---

const MATTE_FILTERS = {
  // alpha → white with that alpha, so luminance × alpha = alpha
  alpha: '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0',
  // black with that alpha over white → 1 − alpha
  'alpha-inverted': '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
  // inverted colors over white → 1 − luminance × alpha
  'luma-inverted': '-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0',
};

// matteContent: the matte layer, rendered (comp space).
export function applyMatte(type, matteContent, out, ctx) {
  let body = matteContent;
  if (MATTE_FILTERS[type]) {
    const filterId = newId(ctx, 'mattefx');
    ctx.defs.push(element('filter', { id: filterId, 'color-interpolation-filters': 'sRGB' },
      element('feColorMatrix', { type: 'matrix', values: MATTE_FILTERS[type] })));
    body = element('g', { filter: `url(#${filterId})` }, body);
  }
  if (type === 'alpha-inverted' || type === 'luma-inverted') body = element('rect', { ...BIG, fill: '#fff' }) + body;
  const id = newId(ctx, 'matte');
  ctx.defs.push(element('mask', { id, maskUnits: 'userSpaceOnUse', ...BIG, 'color-interpolation': 'sRGB' }, body));
  return element('g', { mask: `url(#${id})` }, out);
}
