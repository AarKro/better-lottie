import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const snapshots = join(here, 'snapshots');
const load = name => JSON.parse(readFileSync(join(fixtures, `${name}.ir.json`), 'utf8'));

// Snapshots: written on first run, rewritten with UPDATE_SNAPSHOTS=1.
for (const file of readdirSync(fixtures).filter(f => f.endsWith('.ir.json'))) {
  const name = file.replace('.ir.json', '');
  test(`snapshot: ${name}`, () => {
    const { svg } = convert(load(name));
    const snap = join(snapshots, `${name}.svg`);
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) {
      mkdirSync(snapshots, { recursive: true });
      writeFileSync(snap, svg);
    }
    assert.equal(svg, readFileSync(snap, 'utf8'));
  });
}

test('every keySplines list matches its keyTimes', () => {
  for (const file of readdirSync(fixtures).filter(f => f.endsWith('.ir.json'))) {
    const { svg } = convert(JSON.parse(readFileSync(join(fixtures, file), 'utf8')));
    for (const m of svg.matchAll(/<animate(?:Transform)? [^>]*>/g)) {
      const tag = m[0];
      const n = tag.match(/keyTimes="([^"]*)"/)[1].split(';').length;
      assert.equal(tag.match(/values="([^"]*)"/)[1].split(';').length, n, `${file}: ${tag.slice(0, 80)}`);
      const ks = tag.match(/keySplines="([^"]*)"/);
      if (ks) assert.equal(ks[1].split(';').length, n - 1, `${file}: ${tag.slice(0, 80)}`);
    }
  }
});

test('parenting inherits transforms but not opacity', () => {
  const { svg } = convert(load('parenting'));
  // The null "Orbit" has opacity 0; it must not hide the moon.
  assert.ok(!svg.includes('opacity="0"'));
  // The moon sits inside the orbit's rotation.
  assert.match(svg, /type="rotate" values="0;360"[^>]*additive="sum"[^>]*\/><g transform="translate\(130 0\)">/);
});

test('in/out points become a discrete visibility animation', () => {
  const { svg } = convert(load('parenting'));
  assert.match(svg, /values="hidden;visible;hidden" keyTimes="0;0.5;0.75"/);
});

test('unsupported features are reported, not dropped silently', () => {
  const { warnings } = convert(load('baked-motion'));
  assert.ok(warnings.some(w => w.includes("\"repeater\" is not supported")));
  assert.ok(warnings.some(w => w.includes('text layers are not supported')));
});

test('play-once uses fill="freeze"', () => {
  const { svg } = convert(load('transform-basics'), { loop: false });
  assert.ok(svg.includes('fill="freeze"'));
  assert.ok(!svg.includes('repeatCount'));
});

test('invalid IR fails loudly', () => {
  assert.throws(() => convert({ comp: { width: 10 }, layers: [] }), /Invalid IR/);
});
