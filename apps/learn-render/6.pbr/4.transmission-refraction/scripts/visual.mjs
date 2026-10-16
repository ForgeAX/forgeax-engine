import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = resolve(root, 'scripts', 'smoke-browser.mjs');
const child = spawn(process.execPath, [smoke], { cwd: resolve(root, '../../../..'), stdio: 'inherit' });
const exitCode = await new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code ?? 1)));
if (exitCode !== 0) process.exit(exitCode);

const debugRoot = resolve(root, '.forgeax-debug');
const runs = (await readdir(debugRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('verify-'))
  .map((entry) => entry.name)
  .sort();
const run = runs.at(-1);
if (run === undefined) throw new Error('Browser smoke produced no visual artifact directory');
console.log(JSON.stringify({
  executionPath: 'headed-browser:carrier',
  artifactRef: resolve(debugRoot, run, 'compare.png'),
  expectations: [
    'smooth-glass-refraction',
    'rough-glass-blur',
    'thick-colored-attenuation',
    'mask-hole-composition',
    'transparent-ordering',
    'edge-fallback',
    'gltf-parity',
    'lane-parity',
  ],
  observed: 'requires Read(image) by the visual evidence executor',
  verdict: 'pending-human-read',
  confidence: 'not-available-before-read',
}, null, 2));
