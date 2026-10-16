#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '../../..');
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));
const metrics = packageJson.forgeax?.metrics ?? {};
const required = ['bundle-size', 'fps', 'bench', 'gate', 'spike-report'];
for (const key of required) if (!(key in metrics)) throw new Error(`deep-agent-feedback: missing metric ${key}`);

const frameTarget = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const carrier = resolve(appRoot, 'scripts/smoke-point-shadow.mjs');
const carrierResult = spawnSync(process.execPath, [carrier], {
  cwd: repoRoot,
  env: {
    ...process.env,
    POINT_SHADOW_SKIP_BROWSER: '1',
    SMOKE_MIN_FRAMES: String(frameTarget),
  },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (carrierResult.error !== undefined) throw carrierResult.error;
if (carrierResult.status !== 0) {
  throw new Error(`deep-agent-feedback: Dawn point-shadow carrier exited ${carrierResult.status}`);
}
const evidenceLine = carrierResult.stdout
  .trim()
  .split('\n')
  .reverse()
  .find((line) => line.startsWith('{'));
if (evidenceLine === undefined) {
  throw new Error('deep-agent-feedback: Dawn point-shadow carrier emitted no JSON evidence');
}
const evidence = JSON.parse(evidenceLine);
if (evidence.browser !== 'not-run' || evidence.dawn?.status !== 'pass') {
  throw new Error('deep-agent-feedback: Dawn-only carrier did not produce a valid Dawn result');
}
if (!Number.isInteger(evidence.dawn.frames) || evidence.dawn.frames < frameTarget) {
  throw new Error(
    `deep-agent-feedback: Dawn carrier observed ${evidence.dawn.frames ?? 'no'} frames; expected ${frameTarget}`,
  );
}
emitSmokeReceipt('hello-deep-agent-feedback/smoke', evidence.dawn.frames);
console.log('[deep-agent-feedback] dawn point-shadow carrier: PASS');
console.log(
  JSON.stringify({
    backend: 'dawn',
    frames: evidence.dawn.frames,
    nonZeroPixels: evidence.dawn.nonZeroPixels,
    shadowVsNoShadowPixelDifference: evidence.dawn.shadowVsNoShadowPixelDifference,
  }),
);
