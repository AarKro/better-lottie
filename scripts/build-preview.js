// Converts every test fixture and writes preview/index.html, which shows each
// result twice: as <img> (autoplay, no JS) and inline (with a scrubber).
//
//   npm run preview && open preview/index.html

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'test', 'fixtures');
const outDir = join(root, 'preview', 'out');
mkdirSync(outDir, { recursive: true });

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cards = [];

for (const file of readdirSync(fixtures).filter(f => f.endsWith('.ir.json')).sort()) {
  const name = file.replace('.ir.json', '');
  const ir = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  const { svg, warnings } = convert(ir);
  writeFileSync(join(outDir, `${name}.svg`), svg);
  const kb = (Buffer.byteLength(svg) / 1024).toFixed(1);
  cards.push(`
  <section class="card" data-duration="${ir.comp.duration}" data-fps="${ir.comp.frameRate}">
    <header><h2>${esc(ir.comp.name)}</h2><span>${name}.svg · ${kb} KB · ${ir.comp.duration}s</span></header>
    <div class="views">
      <figure><img src="out/${name}.svg" alt=""><figcaption>&lt;img&gt;: autoplay</figcaption></figure>
      <figure class="inline">${svg.replace(/^<svg /, '<svg class="live" ')}<figcaption>inline: controllable</figcaption></figure>
    </div>
    <div class="controls">
      <button type="button" class="toggle">Pause</button>
      <input type="range" class="scrub" min="0" max="${ir.comp.duration}" step="${1 / ir.comp.frameRate}" value="0" aria-label="Scrub time">
      <output class="time">0.00s</output>
    </div>
    ${warnings.length ? `<ul class="warnings">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </section>`);
}

writeFileSync(join(root, 'preview', 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>better-lottie preview</title>
<style>
  :root { --bg: #f4f4f6; --card: #fff; --ink: #18181b; --muted: #71717a; --line: #e4e4e7; --warn: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0c0e; --card: #18181b; --ink: #f4f4f5; --muted: #a1a1aa; --line: #27272a; --warn: #fbbf24; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 auto 24px; max-width: 1100px; }
  main { display: grid; gap: 20px; max-width: 1100px; margin: 0 auto; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 0; }
  header span, figcaption, .time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .views { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 0; }
  figure img, figure svg { display: block; width: 100%; height: auto; border-radius: 8px; }
  figcaption { margin-top: 4px; }
  .controls { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .scrub { flex: 1; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; min-width: 64px; }
  .warnings { margin: 12px 0 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
</style>
</head>
<body>
<h1>better-lottie preview</h1>
<main>${cards.join('')}
</main>
<script>
  for (const card of document.querySelectorAll('.card')) {
    const svg = card.querySelector('svg.live');
    const scrub = card.querySelector('.scrub');
    const time = card.querySelector('.time');
    const toggle = card.querySelector('.toggle');
    const duration = Number(card.dataset.duration);
    const show = t => { time.textContent = t.toFixed(2) + 's'; };
    scrub.addEventListener('input', () => {
      svg.pauseAnimations();
      svg.setCurrentTime(Number(scrub.value));
      toggle.textContent = 'Play';
      show(Number(scrub.value));
    });
    toggle.addEventListener('click', () => {
      if (svg.animationsPaused()) { svg.unpauseAnimations(); toggle.textContent = 'Pause'; }
      else { svg.pauseAnimations(); toggle.textContent = 'Play'; }
    });
    (function tick() {
      if (!svg.animationsPaused()) {
        const t = svg.getCurrentTime() % duration;
        scrub.value = t; show(t);
      }
      requestAnimationFrame(tick);
    })();
  }
</script>
</body>
</html>
`);

console.log(`Wrote ${cards.length} previews to preview/`);
