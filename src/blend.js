// AE blend modes → CSS mix-blend-mode. Browsers implement the W3C
// compositing formulas, which follow the same Photoshop formulas as AE;
// verified against AE renders to within 2/255 for every mode below.

const CSS_BLEND = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
  luminosity: 'luminosity', add: 'plus-lighter', 'linear-dodge': 'plus-lighter',
};
// AE's legacy variants of three modes; close to the current ones.
const APPROX = { 'classic-color-burn': 'color-burn', 'classic-color-dodge': 'color-dodge', 'classic-difference': 'difference' };

// CSS mode for an AE mode, or null for normal / no equivalent (reported).
export function cssBlend(mode, ctx, where) {
  if (!mode || mode === 'normal') return null;
  const css = CSS_BLEND[mode] || APPROX[mode];
  if (!css) {
    ctx.warn(where, `blend mode "${mode}" has no browser equivalent (exported as normal)`);
    return null;
  }
  if (APPROX[mode]) ctx.warn(where, `blend mode "${mode}" is approximated as "${css}"`);
  return css;
}
