import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { createSolver, decodeMesh, layerMatrix, puppetLayer, subdivide } from '../src/puppet.js';
import { trackValueAt } from '../src/timeline.js';
import { flatten, rasterize, readPng } from './helpers/raster.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
// Comp "puppet" in the scratch project: a 360×60 bar, pins at both ends and
// the middle (placed by hand in AE), the right pin keyed 80 px up at 1 s.
const IR = JSON.parse(readFileSync(fixture('ae-puppet.ir.json'), 'utf8'));
const PUPPET = IR.layers[0].puppets[0];
const ctxOf = ir => ({ D: ir.comp.duration, fps: ir.comp.frameRate, warnings: [], warn(w, m) { this.warnings.push(`${w}: ${m}`); } });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('decodes the saved mesh; pins sit on their mesh vertices', () => {
  const mesh = decodeMesh(PUPPET.meshes[0].data);
  assert.equal(mesh.vertices.length, 126);
  assert.equal(mesh.triangles.length, 212);
  // Normalized by the source width (500): exactly where AE reports the pins.
  for (const pin of PUPPET.meshes[0].pins) {
    const [x, y] = mesh.vertices[pin.vertex];
    const p = pin.position.keyframes ? pin.position.keyframes[0].v : pin.position.value;
    close(x * 500, p[0], 1e-4, `${pin.name} x`);
    close(y * 500, p[1], 1e-4, `${pin.name} y`);
  }
  assert.equal(decodeMesh('00'), null);
  assert.equal(decodeMesh(PUPPET.meshes[0].data.slice(0, 400)), null, 'truncated');
});

test('the solver holds pins, keeps the rest pose, and moves rigidly with one pin', () => {
  const mesh = decodeMesh(PUPPET.meshes[0].data);
  const rest = mesh.vertices.map(([x, y]) => [x * 500, y * 500]);
  const pins = [4, 5, 6];
  const solve = createSolver(rest, mesh.triangles, pins);
  const atRest = solve(pins.map(i => rest[i]));
  atRest.forEach((p, i) => { close(p[0], rest[i][0], 1e-6, `rest x${i}`); close(p[1], rest[i][1], 1e-6, `rest y${i}`); });
  const moved = [[421.77, 69.66], rest[5], rest[6]];
  const out = solve(moved);
  pins.forEach((v, k) => { close(out[v][0], moved[k][0], 1e-6, 'pin x'); close(out[v][1], moved[k][1], 1e-6, 'pin y'); });

  const one = createSolver(rest, mesh.triangles, [5])([[rest[5][0] + 10, rest[5][1] - 5]]);
  one.forEach((p, i) => { close(p[0], rest[i][0] + 10, 1e-9, 'dx'); close(p[1], rest[i][1] - 5, 1e-9, 'dy'); });
});

test('subdivision keeps the curve and the open/closed structure', () => {
  // A closed curved square and an open line.
  const arr = [4, 1, 0, 0, 0, -5, 5, 0, 10, 0, -5, 0, 0, 5, 10, 10, 0, 5, 0, 0, 0, 10, 0, 0, 0, 0,
    2, 0, 0, 0, 0, 0, 0, 0, 30, 0, 0, 0, 0, 0];
  const split = subdivide(arr, [[3, 1, 2, 4], [3, 7]]);
  assert.deepEqual([split[0], split[1]], [10, 1]);
  const second = 2 + 6 * 10;
  assert.deepEqual([split[second], split[second + 1]], [4, 0], 'open: the last vertex has no outgoing segment');
  const poly = a => flatten(a, undefined, 240);
  const ref = rasterize(poly(arr.slice(0, 26)), 12, 12), got = rasterize(poly(split.slice(0, second)), 12, 12);
  ref.forEach((c, i) => close(got[i], c, 0.02, `coverage at ${i}`));
  // A straight line splits evenly.
  [0, 10, 20, 30].forEach((x, k) => close(split[second + 2 + k * 6], x, 1e-9, `line point ${k}`));
});

test('matches the AE render of the bent bar', () => {
  const layer = puppetLayer(IR.layers[0], ctxOf(IR), 'layer "bar"');
  const png = readPng(fixture('ae-puppet-1.png'));
  const arr = trackValueAt(layer.contents[0].contents[0].track, 1);
  const cov = rasterize(flatten(arr, [1, 0, 0, 1, 250, 150]), png.width, png.height);
  let inter = 0, union = 0;
  for (let i = 0; i < cov.length; i++) {
    // fill #f2731a over white: coverage from the blue channel
    const ae = Math.min(1, Math.max(0, (255 - png.data[i * png.channels + 2]) / 229));
    inter += Math.min(ae, cov[i]); union += Math.max(ae, cov[i]);
  }
  assert.ok(inter / union > 0.965, `IoU ${inter / union}`);
});

test('paths in transformed groups and masks deform in layer space', () => {
  const bar = IR.layers[0];
  // translate(10, 20) · rotate(90) · scale(50%, 200%) maps this rect onto the
  // bar's layer-space rect [−180, 180] × [−30, 30].
  const inGroup = {
    ...bar,
    contents: [{
      type: 'group', name: 'Moved', transform: { position: [10, 20], rotation: 90, scale: [50, 200], anchor: [0, 0] },
      contents: [{ type: 'rect', size: [120, 180], position: [-40, 5] }, { type: 'fill', color: [1, 0, 0], opacity: 100 }],
    }],
    masks: [{ name: 'M', mode: 'add', inverted: false, path: { vertices: [[-180, -30], [180, -30], [180, 30], [-180, 30]], closed: true } }],
  };
  const plain = puppetLayer(bar, ctxOf(IR), 'plain');
  const moved = puppetLayer(inGroup, ctxOf(IR), 'moved');
  const toComp = m => [m[0], m[1], m[2], m[3], m[4] + 250, m[5] + 150];
  const raster = (track, m) => rasterize(flatten(trackValueAt(track, 1), toComp(m)), 500, 300, 4);
  const ref = raster(plain.contents[0].contents[0].track, [1, 0, 0, 1, 0, 0]);
  for (const [name, cov] of [
    ['group', raster(moved.contents[0].contents[0].track, [0, 0.5, -2, 0, 10, 20])],
    ['mask', raster(moved.masks[0].track, [1, 0, 0, 1, 0, 0])],
  ]) {
    let diff = 0, area = 0;
    cov.forEach((c, i) => { diff += Math.abs(c - ref[i]); area += ref[i]; });
    assert.ok(diff / area < 0.01, `${name}: ${diff / area}`);
  }
});

test('puppet layers convert with warnings for what is not handled', () => {
  const ir = structuredClone(IR);
  const fx = ir.layers[0].puppets[0];
  fx.overlapPins = 1;
  fx.meshes.push({ data: null, pins: [] });
  fx.meshes[0].pins.push({ name: 'Bend', type: 'type 3', vertex: 7, position: { value: [0, 0] } });
  const { svg, warnings } = convert(ir);
  assert.match(svg, /<animate attributeName="d"/);
  for (const w of ['Overlap pins are not supported', 'puppet mesh not found in the saved project', 'type 3 pins are not supported']) {
    assert.ok(warnings.some(x => x.includes(w)), w);
  }
  fx.enabled = false;
  assert.doesNotMatch(convert(ir).svg, /<animate attributeName="d"/, 'a switched-off puppet does nothing');
});

test('tall layer: mesh scaled by the larger side; filled open paths close along the bend', () => {
  // Comp "puppet-tall" (300×500): a bar plus an open curve with fill and
  // stroke, three pins down the middle (clicked in AE), the bottom one keyed
  // 80 px right at 1 s.
  const ir = JSON.parse(readFileSync(fixture('ae-puppet-tall.ir.json'), 'utf8'));
  const fx = ir.layers[0].puppets[0];
  const mesh = decodeMesh(fx.meshes[0].data);
  for (const pin of fx.meshes[0].pins) {
    const p = pin.position.keyframes ? pin.position.keyframes[0].v : pin.position.value;
    close(mesh.vertices[pin.vertex][1] * 500, p[1], 1e-4, `${pin.name} y`);
  }
  const layer = puppetLayer(ir.layers[0], ctxOf(ir), 'layer "stem"');
  const items = layer.contents[0].contents.filter(i => i.track);
  assert.equal(items.filter(i => i.fillTrack).length, 1, 'the open curve gets a closed copy for fills');
  const png = readPng(fixture('ae-puppet-tall-1.png'));
  const polys = items.flatMap(i => flatten(trackValueAt(i.fillTrack || i.track, 1), [1, 0, 0, 1, 150, 250]));
  const cov = rasterize(polys, png.width, png.height);
  let inter = 0, union = 0;
  for (let i = 0; i < cov.length; i++) {
    // fill and the 8 px stroke over white (the stroke isn't rasterized here,
    // which alone limits IoU to 0.92 at rest)
    const ae = Math.min(1, Math.max(0, (255 - png.data[i * png.channels]) / 204));
    inter += Math.min(ae, cov[i]); union += Math.max(ae, cov[i]);
  }
  assert.ok(inter / union > 0.895, `IoU ${inter / union}`);
  const { svg } = convert(ir);
  // Fill and stroke each draw both paths as one compound path; only the
  // fill's closes the curve.
  const dOf = re => svg.match(new RegExp(`<path d="([^"]*)" ${re}`))[1];
  const fillD = dOf('fill="#'), strokeD = dOf('fill="none"');
  assert.deepEqual([fillD.match(/Z/g).length, strokeD.match(/Z/g).length], [2, 1]);
});

test('the deformation happens in comp space, through parents', () => {
  // AE applies the Puppet after the layer's transform (shape layers are always
  // continuously rasterized): the same bar reached through a parent null must
  // deform exactly like the bar placed directly.
  const bar = IR.layers[0];
  const parented = { ...bar, parent: 9, transform: { ...bar.transform, position: { value: [200, 100] } } };
  const nul = { id: 9, name: 'Null', type: 'null', transform: { position: { value: [50, 50] } } };
  const ctx = { ...ctxOf(IR), byId: new Map([[1, parented], [9, nul]]) };
  const a = puppetLayer(bar, ctxOf(IR), 'direct'), b = puppetLayer(parented, ctx, 'parented');
  const m = layerMatrix(parented, ctx, 'x')(1);
  assert.deepEqual(m, [1, 0, 0, 1, 250, 150]);
  const va = trackValueAt(a.contents[0].contents[0].track, 1), vb = trackValueAt(b.contents[0].contents[0].track, 1);
  va.forEach((v, i) => close(vb[i], v, 1e-9, `value ${i}`));
});

test('content far outside the mesh is not deformed', () => {
  const bar = IR.layers[0];
  // A second rect 100 px below the bar, far from its mesh.
  const extra = structuredClone(bar);
  extra.contents[0].contents.unshift({ type: 'rect', size: [40, 20], position: [0, 100] });
  const out = puppetLayer(extra, ctxOf(IR), 'x');
  const far = trackValueAt(out.contents[0].contents[0].track, 1);
  const rest = trackValueAt(out.contents[0].contents[0].track, 0);
  far.forEach((v, i) => close(v, rest[i], 1e-9, `far point ${i}`));
});
