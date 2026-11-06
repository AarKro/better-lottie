import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { convert } from '../src/index.js';
import {
  loadHost, CompItem, AVLayer, CameraLayer, TextLayer, Shape, EASY, AutoOrientType, buildAep, gradientXml,
  shapeLayer, plainLayer, layerTransform, group, rect, ellipse, path, fill, stroke, trim, merge, gradientFill, BlendingMode,
  MaskMode, TrackMatteType, mask, repeater, polystar,
} from './helpers/ae-mock.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = fileURLToPath(new URL('../extension/host/extract.jsx', import.meta.url));
const source = readFileSync(HOST, 'utf8');

test('extract.jsx is valid ES3', () => {
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 3 }));
});

test('extract.jsx avoids APIs ExtendScript lacks', () => {
  const code = source.replace(/\/\/.*$/gm, '');
  const banned = /\.(map|forEach|filter|reduce|some|every|lastIndexOf|trim|bind)\(|\bJSON\.|Object\.(keys|create|assign|defineProperty)|Array\.isArray/g;
  assert.deepEqual(code.match(banned), null);
});

// A comp exercising most of the extractor: parenting through a hidden null,
// spatial ease, expressions, separated position, unsupported items and layers.
function buildComp() {
  const comp = new CompItem({ name: 'Logo "intro" ✨\u2028v2', width: 400, height: 300, duration: 2, frameRate: 25, bgColor: [0.1, 0.1, 0.1] });
  const nul = plainLayer(AVLayer, {
    index: 4, name: 'Ctrl', enabled: false, nullLayer: true, outPoint: 2,
    transform: layerTransform({
      position: [200, 150, 0],
      scale: { keys: [{ t: 0, v: [100, 100, 100], outType: 'HOLD' }, { t: 1, v: [50, 50, 100], inType: 'HOLD' }] },
    }),
  });

  const badge = shapeLayer({
    index: 2, name: 'Badge', parent: nul, outPoint: 2,
    transform: layerTransform({
      position: { keys: [
        { t: 0, v: [-100, 0, 0], outType: 'BEZIER', easeOut: EASY() },
        { t: 1.5, v: [100, 0, 0], inType: 'BEZIER', easeIn: EASY() },
      ] },
    }),
  }, [
    group('Circle', [
      ellipse('Ellipse Path 1', [60, 60]),
      stroke('Stroke 1', [1, 1, 1, 1], 4, { cap: 2, join: 2 }),
      fill('Fill 1', [0.9, 0.3, 0.2, 1]),
    ]),
    trim('Trim Paths 1'),
  ]);

  const spinner = shapeLayer({
    index: 3, name: 'Spinner', outPoint: 2, blendingMode: BlendingMode.MULTIPLY,
    transform: layerTransform({
      x: { keys: [{ t: 0, v: 50 }, { t: 2, v: 350 }] },
      y: 250,
      rotation: { expr: t => t * 180 },
    }),
  }, [
    rect('Rectangle Path 1', [40, 40], 8),
    path('Tick', new Shape({ vertices: [[-10, 0], [0, 10], [10, -10]], closed: false })),
    fill('Fill 1', [0.2, 0.6, 1, 1]),
  ], { effects: 1 });

  comp.layers = [
    plainLayer(TextLayer, { index: 1, name: 'Title', outPoint: 2 }),
    badge,
    spinner,
    nul,
    plainLayer(CameraLayer, { index: 5, name: 'Camera 1', outPoint: 2 }),
  ];
  return comp;
}

function extract(comp) {
  return JSON.parse(loadHost(HOST, comp).extractActiveComp());
}

test('extracts layers, types and parenting', () => {
  const ir = extract(buildComp());
  assert.equal(ir.version, 1);
  assert.equal(ir.comp.name, 'Logo "intro" ✨\u2028v2'); // survives the hand-rolled JSON
  assert.deepEqual(ir.layers.map(l => l.type), ['text', 'shape', 'shape', 'null', 'camera']);
  assert.equal(ir.layers[1].parent, 4);
  const ctrl = ir.layers[3];
  assert.equal(ctrl.enabled, false);
  assert.ok(ctrl.transform.scale.keyframes, 'hidden parents keep their transform');
});

test('extracts shape contents and stroke settings', () => {
  const [, badge, spinner] = extract(buildComp()).layers;
  assert.deepEqual(badge.contents.map(i => i.type), ['group', 'trim']);
  const [, strokeItem, fillItem] = badge.contents[0].contents;
  assert.deepEqual([strokeItem.lineCap, strokeItem.lineJoin, strokeItem.dashes], ['round', 'round', undefined]);
  assert.equal(fillItem.fillRule, 'nonzero');
  assert.equal(badge.contents[0].transform.skew.value, 0);
  assert.deepEqual(spinner.contents[1].path.value.vertices[1], [0, 10]);
  assert.equal(spinner.contents[1].path.value.closed, false);
});

test('extracts keyframes with interpolation, ease and spatial tangents', () => {
  const kf = extract(buildComp()).layers[1].transform.position.keyframes;
  assert.equal(kf.length, 2);
  assert.deepEqual([kf[0].outType, kf[1].inType], ['bezier', 'bezier']);
  assert.deepEqual(kf[0].easeOut, [{ speed: 0, influence: 33.333 }]);
  assert.deepEqual(kf[0].spatialOut, [0, 0, 0]);
});

test('bakes expressions and reports what it skips', () => {
  const ir = extract(buildComp());
  const spinner = ir.layers[2];
  assert.equal(spinner.transform.rotation.keyframes.length, 2 * 25 + 1);
  assert.equal(spinner.transform.position.separated, true);
  assert.equal(spinner.blendMode, 'multiply');
  assert.ok(ir.warnings.some(w => w.includes('Rotation: expression baked')));
  assert.ok(ir.warnings.some(w => w.includes('"Spinner": effects are not supported')));
});

test('extracted IR converts end to end', () => {
  const { svg, warnings } = convert(extract(buildComp()));
  // Baked linear expression collapses back to two values.
  assert.match(svg, /type="rotate" values="0;360"/);
  // Hold keyframes on the hidden null still drive the child.
  assert.match(svg, /type="scale" values="1 1;0.5 0.5;0.5 0.5" keyTimes="0;0.5;1" calcMode="discrete"/);
  assert.match(svg, /stroke-linecap="round" stroke-linejoin="round"/);
  assert.match(svg, /<g style="mix-blend-mode:multiply">/);
  assert.match(svg, /<svg [^>]*style="isolation:isolate"/);
  for (const expected of ['text layers are not supported', 'expression baked']) {
    assert.ok(warnings.some(w => w.includes(expected)), expected);
  }
});

test('asks for a comp when none is active', () => {
  assert.deepEqual(JSON.parse(loadHost(HOST, null).extractActiveComp()), { error: 'Open or select a composition first.' });
});

// --- dashes, trim, merge, auto-orient, gradients ---

function featureComp() {
  const comp = new CompItem({ id: 42, name: 'Features', width: 200, height: 200, duration: 1, frameRate: 25, bgColor: [0, 0, 0] });
  const flyer = shapeLayer({
    index: 1, name: 'Flyer', outPoint: 1, autoOrient: AutoOrientType.ALONG_PATH,
    transform: layerTransform({ position: { keys: [
      { t: 0, v: [0, 0, 0], spatialOut: [50, -50, 0] }, { t: 1, v: [200, 0, 0], spatialIn: [-50, -50, 0] },
    ] } }),
  }, [
    group('Lines', [
      path('A', new Shape({ vertices: [[0, 0], [100, 0]], closed: false })),
      stroke('Dashed', [1, 1, 1, 1], 2, { dashes: [20, 10], dashOffset: 5 }),
      stroke('Plain', [1, 1, 1, 1], 2),
    ]),
    trim('Trim Paths 1', { end: { keys: [{ t: 0, v: 0 }, { t: 1, v: 100 }] }, type: 2 }),
  ]);
  const liquid = shapeLayer({ index: 2, name: 'Liquid', outPoint: 1 }, [
    group('Group 1', [
      rect('Level', [100, 50]),
      group('Glass', [ellipse('Glass Path', [80, 80])]),
      merge('Merge Paths 1', 4),
      gradientFill('Gradient Fill 1'),
    ]),
  ]);
  comp.layers = [flyer, liquid];
  return comp;
}

const GOLD = [[0, 0.5, 0.96, 0.78, 0.35], [1, 0.5, 0.95, 0.4, 0.09]];

function projectFile(comps) {
  const file = join(mkdtempSync(join(tmpdir(), 'bl-')), 'project.aep');
  writeFileSync(file, buildAep(comps));
  return file;
}

test('reads only the dashes in use, plus trim, merge mode and auto-orient', () => {
  const ir = JSON.parse(loadHost(HOST, featureComp()).extractActiveComp());
  const [flyer, liquid] = ir.layers;
  assert.equal(flyer.transform.autoOrient, true);
  const [lines, trimItem] = flyer.contents;
  const [, dashed, plain] = lines.contents;
  assert.deepEqual(dashed.dashes.map(d => [d.type, d.value.value]), [['dash', 20], ['gap', 10]]);
  assert.equal(dashed.dashOffset.value, 5);
  assert.equal(plain.dashes, undefined, 'hidden default dash streams are not dashes');
  assert.equal(trimItem.mode, 'individually');
  assert.equal(trimItem.end.keyframes.length, 2);
  assert.equal(liquid.contents[0].contents[2].mode, 'intersect');
});

test('reads gradient colors from the project file, matched by comp id and layer', () => {
  const file = projectFile([
    { id: 7, layers: [[], [gradientXml([[0, 0.5, 1, 0, 0], [1, 0.5, 0, 1, 0]])]] }, // a decoy comp
    { id: 42, layers: [[], [gradientXml(GOLD)]] },
  ]);
  const ir = JSON.parse(loadHost(HOST, featureComp(), { projectFile: file }).extractActiveComp());
  const g = ir.layers[1].contents[0].contents[3];
  assert.equal(g.type, 'gradient-fill');
  assert.equal(g.gradientType, 'linear');
  assert.deepEqual(g.stops.value.colors, GOLD);
  assert.deepEqual(g.stops.value.alphas, [[0, 0.5, 1], [1, 0.5, 1]]);
  assert.deepEqual(ir.warnings, []);
});

test('gradient colors: unsaved projects and mismatches warn instead of guessing', () => {
  const unsaved = JSON.parse(loadHost(HOST, featureComp()).extractActiveComp());
  assert.equal(unsaved.layers[1].contents[0].contents[3].stops, null);
  assert.ok(unsaved.warnings.some(w => w.includes('save the project')));

  const file = projectFile([{ id: 42, layers: [[], [gradientXml(GOLD), gradientXml(GOLD)]] }]);
  const mismatch = JSON.parse(loadHost(HOST, featureComp(), { projectFile: file }).extractActiveComp());
  assert.equal(mismatch.layers[1].contents[0].contents[3].stops, null);
  assert.ok(mismatch.warnings.some(w => w.includes('could not be matched')));
});

test('feature comp converts end to end', () => {
  const file = projectFile([{ id: 42, layers: [[], [gradientXml(GOLD)]] }]);
  const { svg, warnings } = convert(JSON.parse(loadHost(HOST, featureComp(), { projectFile: file }).extractActiveComp()));
  assert.match(svg, /<linearGradient [^>]*><stop offset="0" stop-color="#f5c759"\/><stop offset="1" stop-color="#f26617"\/>/);
  assert.match(svg, /<clipPath id="[^"]+"><path d="M0 -40C/);
  assert.match(svg, /pathLength="1" stroke-dasharray="0 1.001"/);
  assert.match(svg, /type="rotate" values="-45/, 'auto-orient starts along the path tangent');
  assert.ok(warnings.some(w => w.includes('dashes are replaced by Trim Paths')));
});

// --- masks, mattes, repeaters, taper, gradient keyframes ---

function layeredComp() {
  const comp = new CompItem({ id: 9, name: 'Layered', width: 200, height: 200, duration: 2, frameRate: 25, bgColor: [0, 0, 0] });
  const matte = shapeLayer({ index: 1, name: 'Matte', enabled: false, isTrackMatte: true, outPoint: 2 },
    [ellipse('Dot', [80, 80]), fill('Fill 1', [1, 1, 1, 1])]);
  const target = shapeLayer({
    index: 2, name: 'Target', outPoint: 2, trackMatteType: TrackMatteType.LUMA_INVERTED, trackMatteLayer: matte,
  }, [
    group('Tiles', [rect('Tile', [20, 20]), fill('Fill 1', [1, 0, 0, 1])]),
    repeater('Repeater 1', { copies: 4, order: 2, startOpacity: 100, endOpacity: 20 }),
    path('Line', new Shape({ vertices: [[0, 0], [100, 0]], closed: false })),
    stroke('Tapered', [1, 1, 1, 1], 10, { taper: { startLength: 50, startEase: 25, endWidth: 30 } }),
    gradientFill('Animated', { colorKeys: [0, 1] }),
    gradientFill('Untouched'),
  ], {
    masks: [
      mask('Mask 1', [[0, 0], [50, 0], [50, 50]], { feather: [8, 8] }),
      mask('Mask 2', [[10, 10], [20, 10], [20, 20]], { mode: MaskMode.SUBTRACT, inverted: true, opacity: 50 }),
      mask('Mask 3', [[0, 0], [1, 1], [0, 1]], { mode: MaskMode.NONE }),
    ],
  });
  comp.layers = [matte, target];
  return comp;
}

test('reads masks, track mattes (incl. hidden matte layers) and repeaters', () => {
  const [matteLayer, target] = JSON.parse(loadHost(HOST, layeredComp()).extractActiveComp()).layers;
  assert.equal(matteLayer.isMatte, true);
  assert.equal(matteLayer.contents.length, 2, 'hidden matte layers keep their contents');
  assert.deepEqual(target.matte, { type: 'luma-inverted', layer: 1 });
  assert.deepEqual(target.masks.map(m => [m.mode, m.inverted]), [['add', false], ['subtract', true]], 'mode None is skipped');
  assert.deepEqual(target.masks[0].feather.value, [8, 8]);
  const rep = target.contents[1];
  assert.equal(rep.type, 'repeater');
  assert.equal(rep.composite, 'above');
  assert.equal(rep.copies.value, 4);
  assert.deepEqual(rep.transform.position.value, [50, 0]);
  assert.equal(rep.endOpacity.value, 20);
});

test('reads taper settings in the right units', () => {
  const target = JSON.parse(loadHost(HOST, layeredComp()).extractActiveComp()).layers[1];
  const taper = target.contents[3].taper;
  assert.equal(taper.units, 'percent');
  assert.equal(taper.startLength.value, 50);
  assert.equal(taper.startEase.value, 25);
  assert.equal(taper.endWidth.value, 30);
  assert.equal(target.contents[3].wave, undefined, 'unmodified wave is not exported');
});

test('reads gradient color keyframes, and AE defaults for untouched gradients', () => {
  const RED = [[0, 0.5, 1, 0, 0], [1, 0.5, 0.5, 0, 0]], BLUE = [[0, 0.5, 0, 0, 1], [1, 0.5, 0, 0, 0.5]];
  const file = projectFile([{ id: 9, layers: [[], [[gradientXml(RED), gradientXml(BLUE)], null]] }]);
  const ir = JSON.parse(loadHost(HOST, layeredComp(), { projectFile: file }).extractActiveComp());
  const [animated, untouched] = ir.layers[1].contents.slice(4);
  assert.deepEqual(animated.stops.keyframes.map(k => [k.t, k.v.colors]), [[0, RED], [1, BLUE]]);
  assert.deepEqual(untouched.stops.value.colors, [[0, 0.5, 1, 1, 1], [1, 0.5, 0, 0, 0]], 'white to black');
  assert.deepEqual(ir.warnings, []);
});

test('maps shape-level blend mode numbers (AE menu positions) to names', () => {
  const comp = new CompItem({ id: 3, name: 'Blends', width: 100, height: 100, duration: 1, frameRate: 25, bgColor: [0, 0, 0] });
  comp.layers = [shapeLayer({ index: 1, name: 'L', outPoint: 1 }, [
    rect('R', [10, 10]), fill('A', [1, 0, 0, 1], 100, 4), fill('B', [1, 0, 0, 1], 100, 12),
    fill('C', [1, 0, 0, 1], 100, 29), fill('D', [1, 0, 0, 1], 100, 8), fill('E', [1, 0, 0, 1], 100, 1),
  ])];
  const items = JSON.parse(loadHost(HOST, comp).extractActiveComp()).layers[0].contents;
  assert.deepEqual(items.slice(1).map(i => i.blendMode), ['multiply', 'add', 'luminosity', undefined, undefined]);
});

test('reads Reverse Path Direction (3) on paths, rects and ellipses', () => {
  const comp = new CompItem({ id: 11, name: 'Directions', width: 100, height: 100, duration: 1, frameRate: 30 });
  comp.layers = [shapeLayer({ index: 1, name: 'Ring', outPoint: 1 }, [
    ellipse('Inner', [40, 40], 3),
    rect('Clockwise', [80, 80], 0, 2),
    path('Drawn', new Shape({ vertices: [[0, 0], [10, 0], [10, 10]], closed: true }), 3),
    fill('Fill 1', [1, 0, 0, 1]),
  ])];
  const [layer] = JSON.parse(loadHost(HOST, comp).extractActiveComp()).layers;
  assert.deepEqual(layer.contents.map(it => it.direction), ['reversed', undefined, 'reversed', undefined]);
});

test('reads Polygon/Star settings (stars only get inner radius and roundness)', () => {
  const comp = new CompItem({ id: 12, name: 'Stars', width: 100, height: 100, duration: 1, frameRate: 30 });
  comp.layers = [shapeLayer({ index: 1, name: 'Stars', outPoint: 1 }, [
    polystar('Star', { points: { keys: [{ t: 0, v: 3 }, { t: 1, v: 8 }] }, innerRadius: 40, innerRoundness: 20, outerRoundness: -10, direction: 3 }),
    polystar('Polygon', { type: 2, points: 6, position: [5, 6], rotation: 15, outerRadius: 80 }),
    fill('Fill 1', [1, 0, 0, 1]),
  ])];
  const [star, poly] = JSON.parse(loadHost(HOST, comp).extractActiveComp()).layers[0].contents;
  assert.equal(star.type, 'polystar');
  assert.equal(star.starType, 'star');
  assert.equal(star.direction, 'reversed');
  assert.deepEqual(star.points.keyframes.map(k => k.v), [3, 8]);
  assert.deepEqual([star.innerRadius, star.innerRoundness, star.outerRoundness], [{ value: 40 }, { value: 20 }, { value: -10 }]);
  assert.equal(poly.starType, 'polygon');
  assert.deepEqual([poly.points, poly.position, poly.rotation, poly.outerRadius], [{ value: 6 }, { value: [5, 6] }, { value: 15 }, { value: 80 }]);
  assert.equal(poly.innerRadius, undefined);
});
