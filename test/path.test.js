import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrayToD, shapeToArray, shapeToD, rectShape, ellipseShape } from '../src/path.js';

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
  assert.deepEqual([arr[1], arr[2]], [5, -5]);   // top
  assert.deepEqual([arr[7], arr[8]], [25, 5]);   // right
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
  assert.equal(arrayToD([1]), '');
});
