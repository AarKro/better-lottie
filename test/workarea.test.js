import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../src/index.js';
import { cropToWorkArea } from '../src/workarea.js';
import { KIND, propValueAt } from '../src/timeline.js';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.ir.json`, import.meta.url), 'utf8'));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test('work area: keyframes and in/out points move back by its start', () => {
  const ir = load('transform-basics');
  ir.comp.workArea = { start: 0.5, duration: 1 };
  ir.layers.push({ ...ir.layers[0], id: 2, name: 'Gone', inPoint: 0, outPoint: 0.4 });
  ir.layers.push({ ...ir.layers[0], id: 3, name: 'Late', inPoint: 1, outPoint: 2 });
  const out = cropToWorkArea(ir);
  assert.equal(out.comp.duration, 1);
  [[-0.5, 1.5], [-0.5, -0.1], [0.5, 1.5]].forEach(([i, o], k) => {
    close(out.layers[k].inPoint, i, `in ${k}`); close(out.layers[k].outPoint, o, `out ${k}`);
  });
  const tr = ir.layers[0].transform, moved = out.layers[0].transform;
  for (const [key, kind] of [['position', KIND.point], ['scale', KIND.vec2], ['rotation', KIND.scalar], ['opacity', KIND.scalar]]) {
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      propValueAt(moved[key], kind, t).forEach((v, i) => close(v, propValueAt(tr[key], kind, t + 0.5)[i], `${key} at ${t}`));
    }
  }
  assert.equal(ir.layers[0].transform.rotation.keyframes[1].t, 1.5, 'the input IR is not changed');
});

test('work area: the export runs over the work area only, and only when asked', () => {
  const ir = load('transform-basics');
  ir.comp.workArea = { start: 0.5, duration: 1 };
  ir.layers.push({ ...ir.layers[0], id: 2, name: 'Gone', inPoint: 0, outPoint: 0.4 });
  const full = convert(ir).svg, cropped = convert(ir, { workArea: true }).svg;
  assert.match(full, /dur="2s"/);
  assert.doesNotMatch(cropped, /dur="2s"/);
  assert.match(cropped, /dur="1s"/);
  // The rotation starts where the work area starts (45.x° at 0.5 s), not at 0.
  const rot = cropped.match(/type="rotate" values="([^"]*)"/)[1].split(';').map(Number);
  close(rot[0], Math.round(propValueAt(ir.layers[0].transform.rotation, KIND.scalar, 0.5)[0] * 1000) / 1000, 'first rotation');
  for (const m of cropped.matchAll(/keyTimes="([^"]*)"/g)) {
    const k = m[1].split(';').map(Number);
    assert.ok(k[0] === 0 && k[k.length - 1] === 1 && k.every(x => x >= 0 && x <= 1), m[1]);
  }
  assert.equal((cropped.match(/<path /g) || []).length, 1, 'a layer that ends before the work area is left out');
  assert.equal(convert(load('transform-basics'), { workArea: true }).svg, convert(load('transform-basics')).svg,
    'IR without a work area (older extractor): whole comp');
});
