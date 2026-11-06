import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arrayToD, shapeToArray, shapeToD, rectShape, ellipseShape, polystarShape } from '../src/path.js';

const commands = d => d.replace(/[^MCZ]/g, '');

test('open path: M then one C per segment, no Z', () => {
  const d = shapeToD({ closed: false, vertices: [[0, 0], [10, 0], [10, 10]], inTangents: [], outTangents: [] });
  assert.equal(d, 'M0 0C0 0 10 0 10 0C10 0 10 10 10 10');
});

test('closed path gets a closing C and Z', () => {
  assert.equal(commands(shapeToD(ellipseShape([20, 20], [0, 0]))), 'MCCCCZ');
});

test('ellipse points sit on the axes', () => {
  const arr = shapeToArray(ellipseShape([40, 20], [5, 5]));
  assert.deepEqual(arr.slice(0, 2), [4, 1]);     // block header: 4 points, closed
  assert.deepEqual([arr[2], arr[3]], [5, -5]);   // top
  assert.deepEqual([arr[8], arr[9]], [25, 5]);   // right
});

test('concatenated blocks become one compound path', () => {
  const a = shapeToArray(rectShape([10, 10], [0, 0])), b = shapeToArray(ellipseShape([4, 4], [0, 0]));
  assert.equal(commands(arrayToD([...a, ...b])), 'MCCCCZMCCCCZ');
});

test('rect: 4 points when sharp, 8 when rounded or forced', () => {
  assert.equal(rectShape([10, 10], [0, 0]).vertices.length, 4);
  assert.equal(rectShape([10, 10], [0, 0], [2]).vertices.length, 8);
  assert.equal(rectShape([10, 10], [0, 0], [0], true).vertices.length, 8);
});

test('rect roundness is clamped to half the short side', () => {
  const { vertices } = rectShape([20, 10], [0, 0], [50]);
  assert.deepEqual(vertices[0], [10, 0]); // r = 5 → right edge collapses to its midpoint
});

test('empty shape → empty path', () => {
  assert.equal(arrayToD([0, 1]), '');
});

// Shapes AE 2026 made with "Convert To Bezier Path" (4 decimals), incl.
// fractional points and negative roundness.
const AE_POLYSTARS = JSON.parse(readFileSync(new URL('./fixtures/ae-polystar-shapes.json', import.meta.url), 'utf8'));

test('polystar matches AE\'s own bezier conversion', () => {
  for (const { params, v, i, o } of AE_POLYSTARS) {
    const s = polystarShape(params);
    assert.equal(s.vertices.length, v.length, JSON.stringify(params));
    for (const [mine, ae] of [[s.vertices, v], [s.inTangents, i], [s.outTangents, o]]) {
      mine.forEach((p, k) => {
        assert.ok(Math.abs(p[0] - ae[k][0]) < 1e-3 && Math.abs(p[1] - ae[k][1]) < 1e-3, `${JSON.stringify(params)} #${k}`);
      });
    }
  }
});

test('padded polystar keeps its point count and is continuous across whole points', () => {
  for (const type of ['star', 'polygon']) {
    const at = points => shapeToArray(polystarShape({
      type, points, position: [0, 0], rotation: 0, innerRadius: 40, outerRadius: 100, innerRoundness: 30, outerRoundness: 50,
    }, 8));
    const sizes = new Set([3, 4.5, 5, 7.99, 8].map(n => at(n).length));
    assert.equal(sizes.size, 1, type);
    for (const n of [4, 5, 6]) {
      const below = at(n - 1e-6), above = at(n);
      assert.ok(below.every((x, k) => Math.abs(x - above[k]) < 1e-3), `${type} at ${n}`);
    }
  }
});
