import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockArea, orientClockwise, shapeLength, transformMatrix, transformShape } from '../src/geometry.js';
import { ellipseShape, rectShape, shapeToArray } from '../src/path.js';
import { localTrim } from '../src/shapes.js';

const near = (a, b, eps = 1e-6) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= eps, `${a} ≈ ${b}`));
const square = shapeToArray(rectShape([10, 10], [0, 0]));

test('transformShape applies position, rotation, scale and anchor like AE', () => {
  const m = transformMatrix([100, 50], 90, [200, 100], [5, 0]);
  const out = transformShape(square, m);
  // first vertex (5, -5): minus anchor → (0, -5), scale ×2 → (0, -5), rotate 90° → (5, 0), + position
  near(out.slice(2, 4), [105, 50]);
});

test('orientClockwise flips counter-clockwise blocks only', () => {
  const cw = shapeToArray(ellipseShape([10, 10], [0, 0]));
  const ccw = shapeToArray({ ...ellipseShape([10, 10], [0, 0]), vertices: ellipseShape([10, 10], [0, 0]).vertices.slice().reverse() });
  assert.ok(blockArea(cw, 0) > 0);
  assert.deepEqual(orientClockwise(cw), cw);
  assert.ok(blockArea(orientClockwise([...cw, ...ccw]), cw.length) > 0);
});

test('shapeLength of a 10×10 square is 40', () => {
  assert.ok(Math.abs(shapeLength(square) - 40) < 1e-6);
});

test('localTrim lays paths end to end and wraps', () => {
  // two equal paths: [0, .5] and [.5, 1]
  near(localTrim(0, 0.5, 0, 0.25, 0), [0.5, 0]);      // first half of path 1
  near(localTrim(0.5, 1, 0, 0.25, 0), [0, 0]);        // nothing of path 2
  near(localTrim(0.5, 1, 0.25, 0.75, 0), [0.5, 0]);   // first half of path 2
  near(localTrim(0, 1, 0.8, 1, 0.5), [0.2, 0.3]);     // offset by half a turn
  near(localTrim(0, 1, 0.5, 1, 0.75), [0.5, 0.25]);   // single path: offset wraps
  near(localTrim(0, 0.5, 0, 1, 0.3), [1, 0]);         // everything visible
});
