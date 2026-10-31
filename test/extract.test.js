import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { convert } from '../src/index.js';
import {
  loadHost, CompItem, AVLayer, CameraLayer, TextLayer, Shape, EASY,
  shapeLayer, plainLayer, layerTransform, group, rect, ellipse, path, fill, stroke, trim, BlendingMode,
} from './helpers/ae-mock.js';

const HOST = fileURLToPath(new URL('../extension/host/extract.jsx', import.meta.url));
const source = readFileSync(HOST, 'utf8');

test('extract.jsx is valid ES3', () => {
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 3 }));
});

test('extract.jsx avoids APIs ExtendScript lacks', () => {
  const code = source.replace(/\/\/.*$/gm, '');
  const banned = /\.(map|forEach|filter|reduce|some|every|indexOf|lastIndexOf|trim|bind)\(|\bJSON\.|Object\.(keys|create|assign|defineProperty)|Array\.isArray/g;
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
  for (const expected of ['text layers are not supported', '"trim" is not supported', 'blend mode "multiply"', 'expression baked']) {
    assert.ok(warnings.some(w => w.includes(expected)), expected);
  }
});

test('asks for a comp when none is active', () => {
  assert.deepEqual(JSON.parse(loadHost(HOST, null).extractActiveComp()), { error: 'Open or select a composition first.' });
});
