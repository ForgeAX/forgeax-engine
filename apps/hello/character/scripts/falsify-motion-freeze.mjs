#!/usr/bin/env node
// F-5 falsification: prove that position-tracking detects motion freeze.
//
// Temporarily zeroes the smoke script's horizontal drive velocity (0.05 → 0)
// and runs the smoke. The position-tracking MUST fail because x does not advance.
// This is the same measurement as the existing hello-character smoke.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const SMOKE_PATH = resolve(APP_ROOT, 'scripts', 'smoke.mjs');
const SOURCE = readFileSync(SMOKE_PATH, 'utf8');

// Zero the horizontal drive velocity in the smoke's drive loop
const FROZEN = SOURCE.replace(
  'pwReady.moveAndSlide(character, Float32Array.of(0.05, 0, 0));',
  'pwReady.moveAndSlide(character, Float32Array.of(0, 0, 0));',
);
if (FROZEN === SOURCE) {
  process.stderr.write('falsification fixture: did not find the smoke drive velocity\n');
  process.exit(1);
}

const backupPath = `${SMOKE_PATH}.falsification-backup`;
writeFileSync(backupPath, SOURCE);
writeFileSync(SMOKE_PATH, FROZEN);

try {
  const result = spawnSync('node', ['scripts/smoke.mjs'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.status === 0) {
    process.stderr.write('falsification failed: smoke with frozen drive passed (character advanced)\n');
    process.exit(1);
  }

  const output = result.stdout + result.stderr;
  if (!output.includes('FAIL') && !output.includes('did not advance')) {
    process.stderr.write('falsification did not produce the expected position-tracking failure\n');
    process.exit(1);
  }

  console.log('[falsify-motion-freeze] PASS - frozen drive prevented character x motion');
} finally {
  writeFileSync(SMOKE_PATH, SOURCE);
  rmSync(backupPath, { force: true });
}