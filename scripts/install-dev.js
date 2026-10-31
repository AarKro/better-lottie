// Dev install: lets AE load the unsigned extension straight from this repo.
//   npm run dev:install     build, enable unsigned extensions, link extension/
//   npm run dev:uninstall   remove the link (PlayerDebugMode is left on)
// Restart After Effects afterwards; the panel is under Window › Extensions.

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const isWin = platform() === 'win32';
const extensionsDir = isWin
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions')
  : join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
const target = join(extensionsDir, 'better-lottie');
const CSXS_VERSIONS = [9, 10, 11, 12];

function linkState() {
  try {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) return 'other';
    return resolve(dirname(target), readlinkSync(target)) === source ? 'ours' : 'other';
  } catch {
    return 'missing';
  }
}

if (process.argv.includes('--uninstall')) {
  if (linkState() === 'ours') { unlinkSync(target); console.log(`Removed ${target}`); }
  else console.log('Nothing to remove.');
  process.exit(0);
}

if (!existsSync(join(source, 'lib', 'better-lottie.js'))) {
  console.error('extension/lib/better-lottie.js is missing. Run `npm run build` first.');
  process.exit(1);
}

// Unsigned extensions only load with PlayerDebugMode on, per CEP major version.
for (const v of CSXS_VERSIONS) {
  execSync(isWin
    ? `reg add HKCU\\Software\\Adobe\\CSXS.${v} /v PlayerDebugMode /t REG_SZ /d 1 /f`
    : `defaults write com.adobe.CSXS.${v} PlayerDebugMode 1`, { stdio: 'ignore' });
}
console.log(`PlayerDebugMode enabled for CSXS ${CSXS_VERSIONS.join(', ')}`);

const state = linkState();
if (state === 'other') {
  console.error(`${target} already exists and is not a link to this repo. Remove it and retry.`);
  process.exit(1);
}
if (state === 'missing') {
  mkdirSync(extensionsDir, { recursive: true });
  symlinkSync(source, target, isWin ? 'junction' : 'dir');
}
console.log(`Linked ${target} → ${source}`);
console.log('Restart After Effects, then open Window › Extensions › better-lottie.');
