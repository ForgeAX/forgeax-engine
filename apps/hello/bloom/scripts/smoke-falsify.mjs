#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const command = ['scripts/smoke-dawn.mjs'];
const result = spawnSync(process.execPath, command, {
  cwd: appRoot,
  env: { ...process.env, FORGEAX_BLOOM_FALSIFY: '1', SMOKE_MIN_FRAMES: process.env.SMOKE_MIN_FRAMES ?? '60' },
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const expectedFailure =
  output.includes('Bloom contribution oracle: enabled output is all black') ||
  output.includes('Bloom contribution oracle: on/off numeric RGB readback is identical');
const evidencePath = resolve(appRoot, 'evidence', 'falsify-result.json');
mkdirSync(resolve(appRoot, 'evidence'), { recursive: true });
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 'hello-bloom-falsifier/1',
      sourceRevision,
      command: 'pnpm --filter @forgeax/hello-bloom smoke:falsify',
      injectedFactor:
        'all scene radiance sources removed while camera, graph, and frame schedule remain unchanged',
      childEvidencePath: 'apps/hello/bloom/evidence/falsify-dawn-result.json',
      childExitCode: result.status ?? 1,
      expectedFailure,
      verdict: expectedFailure && result.status !== 0 ? 'pass' : 'fail',
      rawOutputSha256: createHash('sha256').update(output).digest('hex'),
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(output);
console.log(`[hello-bloom-falsify] evidence=${evidencePath} status=${expectedFailure && result.status !== 0 ? 'pass' : 'fail'}`);
if (!(expectedFailure && result.status !== 0)) process.exit(1);
