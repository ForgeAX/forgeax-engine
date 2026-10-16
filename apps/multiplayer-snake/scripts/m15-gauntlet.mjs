#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const artifactDir = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? mkdtempSync(resolve(tmpdir(), 'forgeax-m16-network-')),
);
mkdirSync(artifactDir, { recursive: true });

const child = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'src/__tests__/process-e2e.test.ts',
    '--reporter=verbose',
    '--disableConsoleIntercept',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    encoding: 'utf8',
  },
);
const stdout = child.stdout ?? '';
const stderr = child.stderr ?? '';
const marker = '[m16-net] evidence: ';
const evidenceLine = stdout.split(/\r?\n/).find((line) => line.includes(marker));
if (evidenceLine !== undefined) {
  try {
    const evidence = JSON.parse(evidenceLine.slice(evidenceLine.indexOf(marker) + marker.length));
    writeFileSync(resolve(artifactDir, 'm16-network-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    writeFileSync(
      resolve(artifactDir, 'm16-network-evidence-error.json'),
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
  }
}
writeFileSync(resolve(artifactDir, 'm16-network-stdout.log'), stdout);
writeFileSync(resolve(artifactDir, 'm16-network-stderr.log'), stderr);
if (child.error !== undefined) {
  process.stderr.write(`${child.error.message}\n`);
  process.exit(1);
}
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(child.status ?? 1);
