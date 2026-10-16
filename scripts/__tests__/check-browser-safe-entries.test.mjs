// T-08 -- self-test fixture for scripts/check-browser-safe-entries.mjs
//
// Two fixtures cover the AC-13 contract:
//   1. happy path: all 4 checks pass -> exit 0, stdout says PASS
//   2. negative path: fake `from 'ws'` in types dist/index.mjs -> exit 1,
//      stderr contains the file path + matched pattern
//
// The script is invoked with `--root <fixture>` (mirroring the pattern
// established by scripts/check-image-pipeline-isolation.mjs). Production
// CI invocation `node scripts/check-browser-safe-entries.mjs` keeps its
// `process.cwd()` default.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(repoRoot, 'scripts/check-browser-safe-entries.mjs');
const fixturesDir = resolve(here, 'check-browser-safe-entries.fixtures');

function run(root) {
  const r = spawnSync('node', [scriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('check-browser-safe-entries', () => {
  it('happy path: all 4 checks pass -> exit 0 + PASS marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'all-clean');
    const r = run(fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-13 browser-safe entries gate: PASS/);
  });

  it('negative path: ws leaks into types/dist/index.mjs -> exit 1 + specific location', () => {
    const fixtureRoot = resolve(fixturesDir, 'ws-leak-in-types-dist');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/from 'ws'/);
    expect(r.stderr).toMatch(/packages\/types\/dist\/index\.mjs/);
    expect(r.stderr).toMatch(/AC-13 browser-safe entries gate: 1 failure/);
  });
});
