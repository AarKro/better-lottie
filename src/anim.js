// Shared helpers for writing SMIL animations and SVG elements.

import { num } from './format.js';
import { propToTrack, finalizeTrack, trackValueAt } from './timeline.js';

export function timing(ctx) {
  return `dur="${num(ctx.D, 4)}s" begin="0s" ${ctx.loop ? 'repeatCount="indefinite"' : 'fill="freeze"'}`;
}

export function smilAttrs(smil, fmt) {
  let s = `values="${smil.values.map(fmt).join(';')}" keyTimes="${smil.keyTimes.map(k => num(k, 6)).join(';')}"`;
  if (smil.calcMode !== 'linear') s += ` calcMode="${smil.calcMode}"`;
  if (smil.keySplines) s += ` keySplines="${smil.keySplines.map(sp => sp.map(x => num(x, 4)).join(' ')).join(';')}"`;
  return s;
}

// r: { value, smil } from finalize()/resolve(). Empty string when static.
export function animate(attr, r, fmt, ctx) {
  return r.smil ? `<animate attributeName="${attr}" ${smilAttrs(r.smil, fmt)} ${timing(ctx)}/>` : '';
}

export function trackOf(prop, kind, ctx, where) {
  return propToTrack(prop, kind, { fps: ctx.fps, warn: m => ctx.warn(where, m) });
}

export function finalize(track, ctx, tol) {
  return finalizeTrack(track, ctx.D, ctx.fps, tol);
}

export function resolve(prop, kind, ctx, where) {
  return finalize(trackOf(prop, kind, ctx, where), ctx, kind.tol);
}

// Options for combineTracks() bound to this export's frame rate.
export const sampling = (ctx, tol, linear = true) => ({ fps: ctx.fps, tol, linear });

export const fmtOpacity = v => num(v[0] / 100, 4);

export function element(tag, attrs, children = '') {
  const a = Object.keys(attrs).filter(k => attrs[k] != null).map(k => ` ${k}="${attrs[k]}"`).join('');
  return children ? `<${tag}${a}>${children}</${tag}>` : `<${tag}${a}/>`;
}

export function newId(ctx, kind) {
  ctx.idCount += 1;
  return `${ctx.idPrefix}-${kind}${ctx.idCount}`;
}

// Discrete show/hide of an element from a per-frame predicate. Uses
// `display` rather than `visibility`: a child set to visibility="visible"
// would override a hidden layer, while display can only hide.
export function displayToggle(isHidden, ctx) {
  const values = [], times = [];
  const frames = Math.round(ctx.D * ctx.fps);
  for (let f = 0; f <= frames; f++) {
    const t = Math.min(f / ctx.fps, ctx.D);
    const v = isHidden(t) ? 'none' : 'inline';
    if (values[values.length - 1] !== v) { values.push(v); times.push(t / ctx.D); }
  }
  if (values.length === 1) return values[0] === 'none' ? { attrs: { display: 'none' }, anims: '' } : { attrs: {}, anims: '' };
  return {
    attrs: { display: values[0] },
    anims: `<animate attributeName="display" calcMode="discrete" values="${values.join(';')}" `
      + `keyTimes="${times.map(t => num(t, 6)).join(';')}" ${timing(ctx)}/>`,
  };
}

export { trackValueAt };
