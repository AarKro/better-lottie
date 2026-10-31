#!/usr/bin/env node
// Usage: better-lottie <input.ir.json> [-o out.svg] [--once]

import { readFileSync, writeFileSync } from 'node:fs';
import { convert } from '../src/index.js';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '-o');
const outIdx = args.indexOf('-o');
const output = outIdx >= 0 ? args[outIdx + 1] : null;

if (!input) {
  console.error('Usage: better-lottie <input.ir.json> [-o out.svg] [--once]');
  process.exit(1);
}

const { svg, warnings } = convert(JSON.parse(readFileSync(input, 'utf8')), { loop: !args.includes('--once') });
for (const w of warnings) console.error(`warning: ${w}`);
if (output) writeFileSync(output, svg);
else process.stdout.write(svg);
