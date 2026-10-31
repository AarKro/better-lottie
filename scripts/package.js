// Release package: a signed .zxp people install with a ZXP installer, no Node.js needed.
//   npm run package     build, sign, write dist/better-lottie-<version>.zxp
// The first run creates a self-signed certificate in certs/ (git-ignored). Keep it and
// reuse it for every release so updates are signed by the same certificate.
// Password: ZXP_CERT_PASSWORD, or the default below.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const dist = join(root, 'dist');
const stage = join(dist, 'stage', 'better-lottie');
const certFile = join(root, 'certs', 'better-lottie.p12');
const password = process.env.ZXP_CERT_PASSWORD || 'better-lottie';
// Shown as the signer in ZXP installers. Only used when the certificate is first created.
const CERT = { country: 'CH', state: 'ZH', org: 'better-lottie', name: 'better-lottie' };
const TIMESTAMP_URL = 'http://timestamp.digicert.com';
// Dev-only files that don't belong in a release.
const EXCLUDE = new Set(['.debug', '.DS_Store', '__MACOSX']);

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = readFileSync(join(source, 'CSXS', 'manifest.xml'), 'utf8');
const manifestVersion = manifest.match(/ExtensionBundleVersion="([^"]+)"/)?.[1];
const converterVersion = readFileSync(join(root, 'src', 'svg.js'), 'utf8').match(/export const VERSION = '([^']+)'/)?.[1];
if (manifestVersion !== version || converterVersion !== version) {
  console.error(`Version mismatch: package.json is ${version}, extension/CSXS/manifest.xml is ${manifestVersion}, src/svg.js is ${converterVersion}.`);
  process.exit(1);
}
const output = join(dist, `better-lottie-${version}.zxp`);

// ZXPSignCmd 4.1.3 from Adobe's CEP-Resources, pinned to a commit and checked by hash.
// 4.1.1 (the last one on npm) segfaults on macOS when signing with -tsa; 4.1.3 fixes it.
// The macOS build is x86_64, so Apple Silicon needs Rosetta.
const SIGNER_BASE = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/fcee8de5537d2dd2ed3d91d5a495b7041155b280/ZXPSignCMD/4.1.3/';
const SIGNERS = {
  darwin: { path: 'macOS/ZXPSignCmd', sha256: 'bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095' },
  win32: arch() === 'x64'
    ? { path: 'x64/ZXPSignCmd.exe', sha256: 'ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98' }
    : { path: 'Win32/ZXPSignCmd.exe', sha256: 'bd1cec5d7b5b1079d1f7dda365026c4c0892aecc99cf7045dab1b5d71fc1f10f' },
};

async function signer() {
  const entry = SIGNERS[platform()];
  if (!entry) {
    console.error(`Adobe's ZXPSignCmd only runs on macOS and Windows, not ${platform()}.`);
    process.exit(1);
  }
  const file = join(root, 'node_modules', '.cache', 'zxpsigncmd', '4.1.3', entry.path);
  if (!existsSync(file)) {
    const response = await fetch(SIGNER_BASE + entry.path);
    if (!response.ok) throw new Error(`Downloading ZXPSignCmd failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash !== entry.sha256) throw new Error(`ZXPSignCmd checksum mismatch (got ${hash}).`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data, { mode: 0o755 });
  }
  return file;
}

const signCmd = await signer();
function run(args) {
  execFileSync(signCmd, args, { stdio: 'inherit' });
}

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: platform() === 'win32' });

rmSync(join(dist, 'stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// dereference: installers unpack symlinks as text files, which breaks the signature.
cpSync(source, stage, { recursive: true, dereference: true, filter: src => !EXCLUDE.has(basename(src)) });

if (!existsSync(certFile)) {
  mkdirSync(dirname(certFile), { recursive: true });
  run(['-selfSignedCert', CERT.country, CERT.state, CERT.org, CERT.name, password, certFile]);
  console.log(`Created certificate ${certFile}. Keep it for future releases.`);
}

// ZXPSignCmd refuses to overwrite an existing package.
rmSync(output, { force: true });
// The timestamp keeps the signature valid after the certificate expires.
run(['-sign', stage, output, certFile, password, '-tsa', TIMESTAMP_URL]);
run(['-verify', output]);
rmSync(join(dist, 'stage'), { recursive: true, force: true });
console.log(`\nPackaged ${output}`);
