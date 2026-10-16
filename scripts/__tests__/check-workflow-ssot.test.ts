// check-workflow-ssot.test.ts (M3 w12) - SSOT lint fixture-driven tests.
//
// Drives the implementation of scripts/check-workflow-ssot.mjs (M3 w13) via
// red-green-refactor (plan-strategy §4.1). Three fixture .github/ trees cover
// the SSOT lint matrix per the user's narrowed scope (todo-059 split):
//
//   (a) aligned: ci.yml + nightly.yml both `uses:
//       ./.github/actions/install-playwright-chrome-beta` (>= 2 hits) and
//       no inline `playwright install --with-deps chrome-beta` -> exit 0.
//   (b) drift:   one yml replaced the composite `uses:` with an inline
//       `pnpm exec playwright install --with-deps chrome-beta` -> exit 1
//       + stderr names the offending file + line.
//   (c) undercount: only 1 yml uses the composite action -> exit 1 + stderr
//       names the >= 2 expectation.
//
// stderr structured 3-section grep targets (plan-strategy §7.3):
//   [reason] / [rerun] / [hint]
//
// Reference:
//   - requirements §AC-10 SSOT lint
//   - plan-strategy §K-6 / §4.3 / §7.3
//   - plan-tasks.json#w12 acceptanceCheck

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const lint = resolve(repoRoot, 'scripts/check-workflow-ssot.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runLint(args: string[]): RunResult {
  const r = spawnSync('node', [lint, ...args], {
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

describe('check-workflow-ssot.mjs SSOT lint (w12)', () => {
  it('(a) aligned fixture: >= 2 composite uses, no inline chrome-beta -> exit 0', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-aligned');
    const r = runLint(['--root', root]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
  });

  it('(b1) drift fixture: inline chrome-beta install -> exit 1', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-drift');
    const r = runLint(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(b2) drift fixture: stderr names the offending file', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-drift');
    const r = runLint(['--root', root]);
    expect(r.status).toBe(1);
    // The drift inserted in nightly.yml -> file name must surface for the
    // human reader to navigate to it.
    expect(r.stderr).toMatch(/nightly\.yml/);
  });

  it('(b3) drift fixture: stderr surfaces the offending literal (chrome-beta inline)', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-drift');
    const r = runLint(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/chrome-beta/);
  });

  it('(c1) undercount fixture: only 1 composite use -> exit 1', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-undercount');
    const r = runLint(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(c2) undercount fixture: stderr surfaces composite action expectation', () => {
    const root = resolve(fixturesDir, 'workflow-ssot-undercount');
    const r = runLint(['--root', root]);
    expect(r.status).toBe(1);
    // stderr should make the composite-action reuse intent visible.
    expect(r.stderr).toContain('install-playwright-chrome-beta');
  });
});
