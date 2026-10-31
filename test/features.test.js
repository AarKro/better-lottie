import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../src/index.js';
import { outlineShape } from '../src/taper.js';
import { shapeToArray } from '../src/path.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.ir.json`, import.meta.url), 'utf8'));
const svgOf = name => convert(fixture(name)).svg;

// Half-width of an outline polygon at x (straight horizontal line along y = 0).
function halfWidthAt(poly, x) {
  const ys = [];
  for (let i = 2; i < poly.length; i += 6) if (Math.abs(poly[i] - x) < 3) ys.push(Math.abs(poly[i + 1]));
  return Math.max(...ys);
}

test('taper: full width in the middle, start width at the tip, linear at ease 0', () => {
  const line = shapeToArray({ vertices: [[0, 0], [200, 0]], closed: false });
  //           width, startLen, endLen, startW, endW, startEase, endEase, amount, wavelength, cycles, phase
  const values = [20, 50, 0, 0, 0, 0, 0, 0, 100, 10, 0].map(v => [v]);
  const poly = outlineShape(line, values, { taperUnits: 'percent', waveUnits: 'pixels', lineCap: 'butt' }, null);
  assert.ok(Math.abs(halfWidthAt(poly, 150) - 10) < 0.1);
  assert.ok(Math.abs(halfWidthAt(poly, 50) - 5) < 0.3, 'halfway through a linear taper = half width');
  assert.ok(halfWidthAt(poly, 0) < 0.3);
});

test('wave: width swings between (1 − amount) and full', () => {
  const line = shapeToArray({ vertices: [[0, 0], [400, 0]], closed: false });
  const values = [20, 0, 0, 0, 0, 0, 0, 50, 100, 4, 0].map(v => [v]);
  const poly = outlineShape(line, values, { taperUnits: 'percent', waveUnits: 'cycles', lineCap: 'butt' }, null);
  assert.ok(Math.abs(halfWidthAt(poly, 200) - 5) < 0.3, 'cos = 1 → narrowest');
  assert.ok(Math.abs(halfWidthAt(poly, 50) - 10) < 0.3, 'cos = −1 → full width');
});

test('layer masks never nest a mask inside another mask', () => {
  const svg = svgOf('ae-masks');
  for (const m of svg.matchAll(/<mask [^>]*>(.*?)<\/mask>/g)) assert.ok(!m[1].includes('mask="url('), m[0].slice(0, 120));
  assert.match(svg, /<feGaussianBlur stdDeviation="5 5"\/>/, 'feather 12 → σ 5');
});

test('track mattes: alpha via color matrix, inverted ones over white', () => {
  const svg = svgOf('ae-mattes');
  assert.match(svg, /values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"/);
  assert.equal((svg.match(/<mask [^>]*><rect [^>]*fill="#fff"\/><g filter=/g) || []).length, 2);
  assert.ok(!/matte [a-z ]+"/.test(convert(fixture('ae-mattes')).warnings.join()), 'no warnings');
});

test('repeater: copy opacity steps by (end − start) / copies', () => {
  const svg = svgOf('ae-repeaters');
  const ops = [...svg.matchAll(/ opacity="([\d.]+)"/g)].map(m => +m[1]);
  for (const step of [0.86, 0.72, 0.58, 0.44]) assert.ok(ops.includes(step), `opacity ${step}`);
  assert.match(svg, /<use href="#[^"]+-rep\d+"\/>/);
});

test('gradient scale and rotation become a gradientTransform', () => {
  assert.match(svgOf('ae-gradient-transform'), /gradientTransform="rotate\(45\) scale\(0\.5 1\)"/);
});

test('layer blend modes: CSS mix-blend-mode, isolated root, warnings for the rest', () => {
  const { svg, warnings } = convert(fixture('blend-modes'));
  assert.match(svg, /<svg [^>]*style="isolation:isolate"/);
  for (const css of ['multiply', 'soft-light', 'luminosity', 'plus-lighter']) assert.ok(svg.includes(`mix-blend-mode:${css}`), css);
  assert.deepEqual(warnings.map(w => w.replace(/^layer "[^"]+": /, '')).sort(), [
    'blend mode "linear-burn" has no browser equivalent (exported as normal)',
    'blend mode "vivid-light" has no browser equivalent (exported as normal)',
  ]);
  assert.ok(!svgOf('transform-basics').includes('isolation'), 'no isolation without blending');
});

test('shape-level blend modes: on the fill, layer content isolated', () => {
  const { svg, warnings } = convert(fixture('shape-blend-modes'));
  assert.match(svg, /fill="#66b38c" style="mix-blend-mode:multiply"/);
  assert.match(svg, /<g style="isolation:isolate">/, 'shape blends stay inside their layer');
  assert.equal(warnings.length, 7, 'linear burn/light, vivid/pin light, hard mix, lighter/darker color');
});

test('layer blend modes extracted from AE convert without surprises', () => {
  const { svg, warnings } = convert(fixture('ae-blend-layers'));
  assert.equal((svg.match(/mix-blend-mode:/g) || []).length, 16);
  assert.equal(warnings.length, 2);
});

test('blended layers never blend with the comp background', () => {
  const svg = svgOf('blend-modes');
  // background first, then all layers inside their own isolated group
  assert.match(svg, /<rect width="600" height="300" fill="#808080"\/>\n<g style="isolation:isolate">/);
});

test('trim dashes keep the next dash off the path (no flickering cap dots)', () => {
  const svg = svgOf('modifiers');
  const arrays = [...svg.matchAll(/stroke-dasharray"? values="([^"]+)"|stroke-dasharray="([^"]+)"/g)].map(m => m[1] || m[2]);
  const trimmed = arrays.filter(a => a.split(';').every(v => v.split(' ').length === 2));
  assert.ok(trimmed.length);
  for (const list of trimmed) for (const pair of list.split(';')) {
    const [dash, gap] = pair.split(' ').map(Number);
    assert.ok(dash + gap > 1, `period ${dash} + ${gap} must exceed the path length`);
  }
});

test('visibility switches land half a frame before their frame', () => {
  // parenting fixture: 30 fps, layer in at 1 s → switch at 1 − 1/60 s
  assert.match(svgOf('parenting'), /keyTimes="0;0\.491667;0\.741667"/);
});
