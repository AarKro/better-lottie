// IR → self-animating SVG (SMIL): document, layers, parenting, visibility.
// Shape contents live in shapes.js, paints in paint.js.

import { validate } from './ir.js';
import { num, hex, escComment } from './format.js';
import { element, timing } from './anim.js';
import { renderContents } from './shapes.js';
import { wrapTransform } from './transform.js';

export const VERSION = '0.2.0';

/**
 * @param {import('./ir.js').IR} ir
 * @param {{ loop?: boolean, background?: boolean, idPrefix?: string }} [options]
 *   loop: repeat forever (default) or play once and hold the last frame
 *   background: draw comp.background if the IR has one (default true)
 *   idPrefix: prefix for gradient/clip/mask ids; defaults to one derived from
 *     the comp name, so several exports can be inlined on one page
 * @returns {{ svg: string, warnings: string[] }}
 */
export function convert(ir, options = {}) {
  validate(ir);
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

  const head = [`<!-- ${escComment(`better-lottie ${VERSION} · comp "${comp.name || ''}"`)} -->`];
  if (ctx.defs.length) head.push(`<defs>${ctx.defs.join('')}</defs>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(comp.width)} ${num(comp.height)}" `
    + `width="${num(comp.width)}" height="${num(comp.height)}">\n${head.concat(body).join('\n')}\n</svg>\n`;
  return { svg, warnings };
}

// Short, stable id prefix (FNV-1a).
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36).slice(0, 5);
}

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

  const content = renderContents(layer.contents || [], ctx, where);
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
