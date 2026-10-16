// ac-08-grep-gate-13.test.mjs (M5 w16) - gate 13 fixture-driven TDD red phase.
//
// Drives the implementation of gate 13 in
// apps/hello/triangle/scripts/ac-08-grep-gate.mjs (M5 w17) via red-green:
//
//   (a) finalize.json contains literal '--auto'
//       -> gate 13 exits non-zero with three-segment stderr (reason / rerun / hint)
//   (b) finalize.json does NOT contain '--auto'
//       -> gate 13 line is PASS (gate 13 isolated PASS); the full gate runner
//          aggregates over all 13 gates - we only assert gate 13 line literal
//   (c) finalize.json missing
//       -> gate 13 fails fast (post this loop every feat-dir owns finalize.json;
//          absence is structural anomaly)
//
// Test contract (drives gate 13 CLI shape, plan-tasks.json#w17 description):
//   node apps/hello/triangle/scripts/ac-08-grep-gate.mjs --finalize-path <path>
//   --finalize-path  optional override path to finalize.json (test injection
//                    point); when omitted gate 13 reads featureId from
//                    loop-state.json same shape as gate 12 (l) delegation.
//
// stderr structured 3-section (literal grep targets, plan-strategy section 7.3):
//   [reason] LLM convention drift detected: '--auto' literal in <path>
//   [rerun]  node apps/hello/triangle/scripts/ac-08-grep-gate.mjs ...
//   [hint]   review .claude/skills/forgeax-step-finalize/agents/finalizer.md Step 5;
//            cat <path>; '--auto' lets gh merge bypass required checks
//            (feat-20260510-ci-merge-gate-hardening K-5 / AC-05 (c))
//
// Reference:
//   - requirements AC-05 (c) (verify phase grep '--auto' finalize.json hits 0)
//   - research Finding 5 fix (d) (verify phase grep gate process drift -> file drift)
//   - plan-strategy section 2 K-5 (gate 13 anchor = ac-08-grep-gate.mjs additive)
//   - plan-strategy section 4.1 TDD stance (c) + section 4.3 L3-C gate 13 three cases
//   - plan-strategy section 7.3 error message strategy (gate 13 three-segment template)

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const gateScript = resolve(repoRoot, 'apps/hello/triangle/scripts/ac-08-grep-gate.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');
const fixtureWithAuto = resolve(fixturesDir, 'finalize-with-auto.json');
const fixtureClean = resolve(fixturesDir, 'finalize-clean.json');
const fixtureMissing = resolve(fixturesDir, 'finalize-does-not-exist.json');

function runGate(args) {
  const r = spawnSync('node', [gateScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    combined: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

describe('ac-08-grep-gate gate 13 (--auto in finalize.json) - M5 w16/w17', () => {
  it('(a) finalize.json with `--auto` -> gate 13 FAIL with three-segment stderr', () => {
    const r = runGate(['--finalize-path', fixtureWithAuto]);
    // gate runner exits non-zero on any failed gate
    expect(r.status).not.toBe(0);
    // gate 13 line must be FAIL
    expect(r.combined).toMatch(/\(\s*13\s*\)\s*FAIL/);
    // three-segment structured stderr (plan-strategy section 7.3 templates)
    expect(r.combined).toMatch(/\[reason\]/);
    expect(r.combined).toMatch(/\[rerun\]/);
    expect(r.combined).toMatch(/\[hint\]/);
    // mentions the literal `--auto` so the AI user can grep the cause
    expect(r.combined).toMatch(/--auto/);
  });

  it('(b) finalize.json without `--auto` -> gate 13 PASS', () => {
    const r = runGate(['--finalize-path', fixtureClean]);
    // gate 13 line must explicitly read PASS
    expect(r.combined).toMatch(/\(\s*13\s*\)\s*PASS/);
  });

  it('(c) finalize.json missing -> gate 13 FAIL (fail-fast)', () => {
    const r = runGate(['--finalize-path', fixtureMissing]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toMatch(/\(\s*13\s*\)\s*FAIL/);
    // points at the missing path so AI user can read the failure
    expect(r.combined).toContain(fixtureMissing);
  });
});
