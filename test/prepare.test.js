import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { convert } from '../src/index.js';
import {
  loadHost, CompItem, AVLayer, TextLayer, FootageItem, BlendingMode, TrackMatteType,
  shapeLayer, plainLayer, layerTransform, group, rect, fill, gradientFill, Property, PropertyGroup,
} from './helpers/ae-mock.js';

const EXTRACT = fileURLToPath(new URL('../extension/host/extract.jsx', import.meta.url));
const PREPARE = fileURLToPath(new URL('../extension/host/prepare.jsx', import.meta.url));
const source = readFileSync(PREPARE, 'utf8');

test('prepare.jsx is valid ES3 and avoids APIs ExtendScript lacks', () => {
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 3 }));
  const code = source.replace(/\/\/.*$/gm, '');
  const banned = /\.(map|forEach|filter|reduce|some|every|lastIndexOf|trim|bind)\(|\bJSON\.|Object\.(keys|create|assign|defineProperty)|Array\.isArray/g;
  assert.deepEqual(code.match(banned), null);
});

const artwork = (shapes, props = {}) => new FootageItem({ name: 'Logo/Assets.ai', file: { name: 'Assets.ai' }, shapes, ...props });

function footageLayer(name, source, props = {}) {
  return new AVLayer({
    name, source, outPoint: 2,
    groups: {
      'ADBE Transform Group': layerTransform({ position: [50, 40, 0], anchor: [20, 20, 0] }),
      'ADBE Effect Parade': new PropertyGroup('ADBE Effect Parade', 'Effects', []),
      'ADBE Mask Parade': new PropertyGroup('ADBE Mask Parade', 'Masks', []),
    },
    ...props,
  });
}

function textLayer(name, animated) {
  const animators = new PropertyGroup('ADBE Text Animators', 'Animators', animated ? [new PropertyGroup('ADBE Text Animator', 'Animator 1')] : []);
  const text = new PropertyGroup('ADBE Text Properties', 'Text', [new Property('ADBE Text Document', 'Source Text', 'Hi'), animators]);
  return new TextLayer({ name, outPoint: 2, groups: { 'ADBE Transform Group': layerTransform(), 'ADBE Text Properties': text } });
}

// Ctrl (null) ← Bucket (Illustrator, multiply, motion blur, locked) ← Lid (shape);
// Fill (shape) uses Bucket as its alpha matte; Title is text.
function buildComp({ missing = false } = {}) {
  const comp = new CompItem({ id: 7, name: 'Dough', width: 200, height: 200, duration: 2, frameRate: 24 });
  const ctrl = plainLayer(AVLayer, { name: 'Ctrl', nullLayer: true, outPoint: 2 });
  const bucket = footageLayer('Bucket', artwork([group('Body', [rect('R', [40, 40]), fill('F', [1, 0, 0, 1])])], { footageMissing: missing }), {
    parent: ctrl, blendingMode: BlendingMode.MULTIPLY, motionBlur: true, locked: true, label: 5,
  });
  const lid = shapeLayer({ name: 'Lid', parent: bucket, outPoint: 2 }, [rect('R', [10, 10]), fill('F', [0, 0, 1, 1])]);
  const blue = shapeLayer({ name: 'Blue', outPoint: 2 }, [rect('R', [200, 200]), fill('F', [0, 0, 1, 1])]);
  comp.layers = [textLayer('Title', true), lid, bucket, blue, ctrl];
  comp.reindex();
  blue.setTrackMatte(bucket, TrackMatteType.ALPHA);
  bucket.enabled = true; // keep it visible as well, to check the eye switch is copied
  return comp;
}

const run = comp => {
  const host = loadHost([EXTRACT, PREPARE], comp);
  return { host, result: JSON.parse(host.prepareActiveComp()) };
};

test('Prepare comp converts Illustrator and text layers in a copy and keeps the original', () => {
  const comp = buildComp();
  const { host, result } = run(comp);
  assert.equal(result.comp, 'Dough [better-lottie]');
  assert.deepEqual(result.converted, ['Title', 'Bucket']);
  assert.deepEqual(result.warnings, ['layer "Title": text animation is not carried over; the shapes show the text at the current time']);
  assert.equal(result.needsSave, false);
  assert.deepEqual(host.app.undoGroups, ['Prepare comp for better-lottie', 'end']);

  assert.deepEqual(comp.layers.map(l => l.name), ['Title', 'Lid', 'Bucket', 'Blue', 'Ctrl'], 'original untouched');
  assert.ok(comp.layer(3) instanceof AVLayer && comp.layer(3).source);

  const copy = host.app.project.activeItem;
  assert.equal(copy.id, result.id);
  assert.deepEqual(copy.layers.map(l => [l.name, l.constructor.name]),
    [['Title', 'ShapeLayer'], ['Lid', 'ShapeLayer'], ['Bucket', 'ShapeLayer'], ['Blue', 'ShapeLayer'], ['Ctrl', 'AVLayer']]);
  const [, lid, bucket, blue, ctrl] = copy.layers;
  assert.equal(bucket.parent, ctrl);
  assert.equal(lid.parent, bucket, 'children follow the new layer');
  assert.equal(blue.trackMatteLayer, bucket, 'matted layers follow the new layer');
  assert.deepEqual([bucket.blendingMode, bucket.motionBlur, bucket.locked, bucket.label, bucket.enabled],
    [BlendingMode.MULTIPLY, true, true, 5, true]);
});

test('Prepare comp keeps a converted layer\'s own track matte', () => {
  const comp = buildComp();
  const bucket = comp.layer(3);
  comp.layer(2).setTrackMatte(comp.layer(1), TrackMatteType.LUMA); // unrelated
  bucket.setTrackMatte(comp.layer(2), TrackMatteType.LUMA);
  const { host } = run(comp);
  const copy = host.app.project.activeItem;
  const shape = copy.layers.find(l => l.name === 'Bucket');
  assert.equal(shape.trackMatteType, TrackMatteType.LUMA);
  assert.equal(shape.trackMatteLayer.name, 'Lid');
});

test('Prepare comp reports missing Illustrator files and asks for a save with gradients', () => {
  const missing = run(buildComp({ missing: true })).result;
  assert.deepEqual(missing.converted, ['Title']);
  assert.ok(missing.warnings.some(w => w.startsWith('layer "Bucket": its Illustrator file is missing')));

  const comp = buildComp();
  comp.layer(3).source.shapes = [group('G', [rect('R', [40, 40]), gradientFill('Gradient Fill 1')])];
  assert.equal(run(comp).result.needsSave, true);
});

test('Prepare comp makes no copy when there is nothing to convert', () => {
  const comp = new CompItem({ id: 8, name: 'Plain', width: 10, height: 10, duration: 1, frameRate: 24 });
  comp.layers = [shapeLayer({ name: 'S', outPoint: 1 }, [rect('R', [4, 4]), fill('F', [1, 0, 0, 1])])];
  const { host, result } = run(comp);
  assert.deepEqual(result, { comp: 'Plain', converted: [], warnings: [] });
  assert.equal(host.app.project.items.length, 1);
  assert.deepEqual(host.app.undoGroups, []);

  const all = buildComp({ missing: true });
  all.layers.shift(); // no text layer: nothing converts, so the copy is removed again
  const { host: h2, result: r2 } = run(all);
  assert.equal(r2.id, undefined);
  assert.equal(h2.app.project.removed.length, 1);
  assert.equal(h2.app.project.activeItem, all);
});

test('the extractor flags Illustrator footage and the converter points to Prepare comp', () => {
  const comp = buildComp();
  comp.layer(3).groups['ADBE Effect Parade'].children.push(new PropertyGroup('ADBE FreePin3', 'Puppet'));
  const ir = JSON.parse(loadHost(EXTRACT, comp).extractActiveComp());
  const bucket = ir.layers.find(l => l.name === 'Bucket');
  assert.deepEqual([bucket.type, bucket.vector], ['footage', true]);
  assert.ok(ir.warnings.includes('layer "Bucket": effects are not supported (ignored): Puppet'));
  const { warnings } = convert(ir);
  assert.ok(warnings.some(w => w.startsWith('layer "Bucket": Illustrator layers are not supported (skipped); convert them with "Prepare comp"')));
  assert.ok(warnings.some(w => w.startsWith('layer "Title": text layers are not supported (skipped); convert them with "Prepare comp"')));
});
