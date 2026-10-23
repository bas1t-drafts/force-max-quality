/*
 * Builds the distributable zip (runtime files only, no dev/ or tests).
 * Run with: node dev/package.mjs
 *
 * Output: dist/force-max-quality.zip
 * The archive contains a single top-level folder with a *fixed* name, so
 * extraction produces a stable directory that can be picked directly with
 * "Load unpacked" — and re-extracting over it is how updates are applied.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const folder = 'force-max-quality';
const stage = path.join(DIST, folder);

const RUNTIME = ['manifest.json', 'src', 'icons', 'LICENSE', 'README.md'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const entry of RUNTIME) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) throw new Error(`missing ${entry}`);
  fs.cpSync(from, path.join(stage, entry), { recursive: true });
}

const out = path.join(DIST, 'force-max-quality.zip');
const result = spawnSync(
  'zip',
  ['-rq', out, folder, '-x', '*.DS_Store', '-x', '*/node_modules/*'],
  { cwd: DIST, encoding: 'utf8' }
);

if (result.error || result.status !== 0) {
  throw new Error(`zip failed: ${result.error ? result.error.message : result.stderr}`);
}

fs.rmSync(stage, { recursive: true, force: true });

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`wrote ${path.relative(ROOT, out)} (${kb} KB, v${version})`);
