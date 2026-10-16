// check-metrics-declared.test.ts (M3 w8) - drift detector fixture-driven tests.
//
// Drives the implementation of scripts/check-metrics-declared.mjs (M3 w9) via
// red-green-refactor (plan-strategy §4.1 strict TDD). Five fixture roots cover
// the 3 detector-fired error codes plus the happy path:
//
//   (a) happy        => exit 0; all 5 MetricKind members declared per workspace
//   (b) missing      => exit 1 + 'metric-not-declared'      (workspace lacks forgeax.metrics)
//   (c) typo         => exit 1 + 'metric-kind-unknown'      (key not in closed union)
//   (d) malformed    => exit 1 + 'metric-schema-malformed'  (schema JSON syntax error)
//   (e) status       => 'metric-status-not-ok' is M5 generic-runner-only; the
//                       drift detector itself does NOT consume it. Stub here.
//
// stderr structured 3-section (literal grep targets, plan-strategy §7.3):
//   [reason] ...   (machine-readable line-1: error code + offending workspace)
//   [rerun]  ...   (literal command to reproduce locally)
//   [hint]   ...   (.hint template from AGENTS.md §Metric registry)
//
// Detector contract (plan-tasks.json#w9 description):
//   node scripts/check-metrics-declared.mjs [--root <dir>] [--schema <path>]
//   --root   default = process.cwd()
//   --schema default = <root>/schemas/forgeax-metrics.schema.json
//
// Reference:
//   - requirements §AC-03 / §AC-12 / §AC-15
//   - plan-strategy §4.3 / §4.4 / §7.3
//   - plan-tasks.json#w8 acceptanceCheck

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const detector = resolve(repoRoot, 'scripts/check-metrics-declared.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');
const realSchema = resolve(repoRoot, 'schemas/forgeax-metrics.schema.json');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runDetector(args: string[]): RunResult {
  const r = spawnSync('node', [detector, ...args], {
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

describe('check-metrics-declared.mjs drift detector (w8)', () => {
  it('(a) happy fixture: all 5 MetricKind members declared per workspace -> exit 0', () => {
    const root = resolve(fixturesDir, 'metrics-decl-happy');
    const r = runDetector(['--root', root, '--schema', realSchema]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
  });

  it('(b1) missing fixture: workspace lacks forgeax.metrics -> exit 1 + metric-not-declared', () => {
    const root = resolve(fixturesDir, 'metrics-decl-missing');
    const r = runDetector(['--root', root, '--schema', realSchema]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('metric-not-declared');
    // stderr 3-section literal grep targets
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(b2) missing fixture: hint surfaces canonical example reference', () => {
    const root = resolve(fixturesDir, 'metrics-decl-missing');
    const r = runDetector(['--root', root, '--schema', realSchema]);
    expect(r.status).toBe(1);
    // .hint template per AGENTS.md (canonical example pointer)
    expect(r.stderr).toMatch(/forgeax\.metrics/);
  });

  it('(c1) typo fixture: unknown MetricKind key -> exit 1 + metric-kind-unknown', () => {
    const root = resolve(fixturesDir, 'metrics-decl-typo');
    const r = runDetector(['--root', root, '--schema', realSchema]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('metric-kind-unknown');
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(c2) typo fixture: stderr names the offending key (bundle-sizes vs bundle-size)', () => {
    const root = resolve(fixturesDir, 'metrics-decl-typo');
    const r = runDetector(['--root', root, '--schema', realSchema]);
    expect(r.status).toBe(1);
    // The stderr must surface enough info for the reader to spot the typo.
    expect(r.stderr).toMatch(/bundle-size/);
  });

  it('(d1) malformed fixture: schema JSON syntax error -> exit 1 + metric-schema-malformed', () => {
    const root = resolve(fixturesDir, 'metrics-decl-schema-malformed');
    // For this fixture the schema lives inside the fixture root and is broken.
    const r = runDetector(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('metric-schema-malformed');
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(d2) malformed fixture: hint surfaces actionable rerun command', () => {
    const root = resolve(fixturesDir, 'metrics-decl-schema-malformed');
    const r = runDetector(['--root', root]);
    expect(r.status).toBe(1);
    // Per AGENTS.md hint template the user is pointed at python -m json.tool
    expect(r.stderr).toMatch(/json\.tool|JSON|parse/i);
  });

  it('(e) metric-status-not-ok is reserved for the M5 generic runner (drift detector stub)', () => {
    // The drift detector itself never fires this code; stubbed here to record
    // the closed-union contract (4 MetricErrorCode members -> detector emits
    // 3 of them, runner emits the remaining 'metric-status-not-ok').
    const reservedForRunner = 'metric-status-not-ok' as const;
    expect(reservedForRunner).toBe('metric-status-not-ok');
  });
});
