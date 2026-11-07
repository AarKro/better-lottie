// IR → self-animating SVG (SMIL): document, layers, parenting, visibility.
// Shape contents live in shapes.js, paints in paint.js.

import { validate } from './ir.js';
import { num, hex, escComment } from './format.js';
import { element, switchTime, timing } from './anim.js';
import { renderContents } from './shapes.js';
import { wrapTransform } from './transform.js';
import { applyMasks, applyMatte } from './masks.js';
import { cssBlend } from './blend.js';
import { puppetLayer } from './puppet.js';
import { cropToWorkArea } from './workarea.js';

export const VERSION = '0.5.0';

/**
 * @param {import('./ir.js').IR} ir
 * @param {{ loop?: boolean, background?: boolean, idPrefix?: string }} [options]
 *   loop: repeat forever (default) or play once and hold the last frame
 *   background: draw comp.background if the IR has one (default true)
 *   idPrefix: prefix for gradient/clip/mask ids; defaults to one derived from
 *     the comp name, so several exports can be inlined on one page
 *   workArea: export only the comp's work area (IR comp.workArea), starting at 0
 * @returns {{ svg: string, warnings: string[] }}
 */
export function convert(ir, options = {}) {
  validate(ir);
  if (options.workArea) ir = cropToWorkArea(ir);
  const comp = ir.comp;
  const warnings = (ir.warnings || []).slice();
  const seen = new Set(warnings);
  const ctx = {
    D: comp.duration,
    fps: comp.frameRate,
    loop: options.loop !== false,
    byId: new Map(ir.layers.map(l => [l.id, l])),
    idPrefix: options.idPrefix || `bl${hash(comp.name || '')}`,
    idCount: 0,
    defs: [],
    geometry: new Map(),
    trimOf: new Map(),
    trimCache: new Map(),
    merges: new Map(),
    mattes: new Set(),
    puppets: new Map(),
    warn(where, msg) {
      const s = `${where}: ${msg}`;
      if (!seen.has(s)) { seen.add(s); warnings.push(s); }
    },
  };

  const body = [];
  if (comp.background && options.background !== false) {
    body.push(element('rect', { width: num(comp.width), height: num(comp.height), fill: hex(comp.background) }));
  }
  // AE lists the top layer first; SVG paints in document order.
  for (const layer of [...ir.layers].reverse()) {
    const out = renderLayer(layer, ctx);
    if (out) body.push(out);
  }

  // AE never blends with the comp background color (it isn't a layer), so
  // blended layers composite among themselves first, then over the background.
  if (ctx.blends && body.length && body[0].startsWith('<rect')) {
    body.splice(1, body.length - 1, element('g', { style: 'isolation:isolate' }, body.slice(1).join('\n')));
  }
  const head = [`<!-- ${escComment(`better-lottie ${VERSION} · comp "${comp.name || ''}"`)} -->`];
  if (ctx.defs.length) head.push(`<defs>${ctx.defs.join('')}</defs>`);
  // Blending stays inside the SVG, like in AE, even when it's inlined in a page.
  const isolate = ctx.blends ? ' style="isolation:isolate"' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(comp.width)} ${num(comp.height)}" `
    + `width="${num(comp.width)}" height="${num(comp.height)}"${isolate}>\n${head.concat(body).join('\n')}\n</svg>\n`;
  return { svg, warnings };
}

// Short, stable id prefix (FNV-1a).
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36).slice(0, 5);
}

// Illustrator and text layers have a fix: AE can turn them into shape layers.
function unsupportedLayer(layer) {
  if (layer.type === 'footage' && layer.vector) {
    return 'Illustrator layers are not supported (skipped); convert them with "Prepare comp" in the panel'
      + ' or Layer › Create › Create Shapes from Vector Layer';
  }
  if (layer.type === 'text') {
    return 'text layers are not supported (skipped); convert them with "Prepare comp" in the panel'
      + ' or Layer › Create › Create Shapes from Text';
  }
  return `${layer.type} layers are not supported (skipped)`;
}

// force: render even when hidden (track matte layers are hidden in AE).
function renderLayer(layer, ctx, { force = false } = {}) {
  const where = `layer "${layer.name}"`;
  if ((layer.enabled === false && !force) || layer.type === 'null') return '';
  if (layer.type !== 'shape') {
    ctx.warn(where, unsupportedLayer(layer));
    return '';
  }
  if (layer.threeD) ctx.warn(where, '3D layer exported as 2D');
  if (layer.trackMatte) ctx.warn(where, 'track mattes need a newer extractor; re-export from After Effects');
  if (layer.puppets) {
    if (!ctx.puppets.has(layer)) ctx.puppets.set(layer, puppetLayer(layer, ctx, where));
    layer = ctx.puppets.get(layer);
  }

  ctx.shapeBlends = false;
  let content = renderContents(layer.contents || [], ctx, where);
  if (!content) return '';
  // Shape-level blend modes blend within the layer only.
  if (ctx.shapeBlends) content = element('g', { style: 'isolation:isolate' }, content);
  content = applyMasks(layer, content, ctx, where);
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
  out = withMatte(layer, withVisibility(layer, out, ctx), ctx, where);
  // A matte layer's own blend mode doesn't matter inside the matte.
  return force ? out : withBlend(layer, out, ctx, where);
}

function withBlend(layer, out, ctx, where) {
  const css = out ? cssBlend(layer.blendMode, ctx, where) : null;
  if (!css) return out;
  ctx.blends = true;
  return element('g', { style: `mix-blend-mode:${css}` }, out);
}

function withMatte(layer, out, ctx, where) {
  const m = layer.matte;
  if (!m || !out) return out;
  const matteLayer = ctx.byId.get(m.layer);
  if (!matteLayer || ctx.mattes.has(m.layer)) {
    ctx.warn(where, 'track matte layer not found (matte ignored)');
    return out;
  }
  ctx.mattes.add(m.layer);
  const matte = renderLayer(matteLayer, ctx, { force: true });
  ctx.mattes.delete(m.layer);
  // An empty matte hides everything (or nothing, when inverted).
  return applyMatte(m.type || 'alpha', matte, out, ctx);
}

// Layer in/out points → a discrete visibility animation.
function withVisibility(layer, out, ctx) {
  const D = ctx.D;
  const tIn = layer.inPoint ?? 0, tOut = layer.outPoint ?? D;
  if (tIn <= 0 && tOut >= D) return out;
  if (tOut <= 0 || tIn >= D || tOut <= tIn) return '';
  const values = [], times = [];
  if (tIn > 0) { values.push('hidden'); times.push(0); }
  values.push('visible'); times.push(tIn > 0 ? switchTime(tIn, ctx) / D : 0);
  if (tOut < D) { values.push('hidden'); times.push(switchTime(tOut, ctx) / D); }
  return `<g visibility="${values[0]}"><animate attributeName="visibility" calcMode="discrete" `
    + `values="${values.join(';')}" keyTimes="${times.map(t => num(t, 6)).join(';')}" ${timing(ctx)}/>${out}</g>`;
}
