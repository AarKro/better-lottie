import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aeHandles, normalizeHandles, splineAt, LINEAR } from '../src/easing.js';

const EASY = [{ speed: 0, influence: 33.333 }];
const close = (a, b, eps = 1e-3) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${a} ≈ ${b}`));

test('easy ease → 0.333 0 0.667 1', () => {
  const A = { t: 0, v: 0, easeOut: EASY }, B = { t: 1, v: 100, easeIn: EASY };
  close(normalizeHandles(aeHandles(A, B, 0, 100, 1), 100), [0.333, 0, 0.667, 1]);
});

test('linear keyframes → LINEAR', () => {
  const A = { t: 0, v: 0 }, B = { t: 2, v: 50 };
  assert.equal(normalizeHandles(aeHandles(A, B, 0, 25, 2), 50), LINEAR);
});

test('speed is honoured: a fast start lifts y1', () => {
  // avg 100/s, out speed 200/s with 50% influence → y1 = 0.5·200/100 = 1
  const A = { t: 0, v: 0, easeOut: [{ speed: 200, influence: 50 }] }, B = { t: 1, v: 100 };
  close(normalizeHandles(aeHandles(A, B, 0, 100, 1), 100), [0.5, 1, 5 / 6, 5 / 6]);
});

test('overshoot cannot be a keySpline', () => {
  const A = { t: 0, v: 0 }, B = { t: 1, v: 100, easeIn: [{ speed: -300, influence: 50 }] };
  assert.equal(normalizeHandles(aeHandles(A, B, 0, 100, 1), 100), null);
});

test('splineAt hits the endpoints and the symmetric midpoint', () => {
  const s = [0.333, 0, 0.667, 1];
  assert.equal(splineAt(s, 0), 0);
  assert.equal(splineAt(s, 1), 1);
  assert.ok(Math.abs(splineAt(s, 0.5) - 0.5) < 1e-6);
  assert.ok(splineAt(s, 0.25) < 0.25); // eased in
});
