// run-all-runner.test.ts (M5 w18) - generic runner fixture-driven tests.
//
// Drives the implementation of scripts/metrics/run-all.mjs (M5 w19) via TDD.
// Three fixture roots exercise the runner status state machine:
//
//   (a) runner-all-ok  => exit 0; report/<package>/<kind>.json files written for
//                         every (workspace, kind) where enabled=true; status=ok
//   (b) runner-over    => exit 1 + 'metric-status-not-ok' on stderr; bundle-size
//                         exceeds baseline.threshold => status='over'
//   (c) runner-disabled => exit 0; enabled=false skips the kind without writing
//                          a report file (no false-green stub artefacts)
//
// stderr structured 3-section (literal grep targets, plan-strategy §7.3):
//   [reason] ...   (machine-readable line-1: error code + offending entry)
//   [rerun]  ...   (literal command to reproduce locally)
//   [hint]   ...   (.hint template from AGENTS.md §Metric registry)
//
// Runner contract (plan-tasks.json#w19 description):
//   node scripts/metrics/run-all.mjs [--root <dir>] [--schema <path>] [--report-dir <dir>]
//   --root       default = process.cwd()
//   --schema     default = <root>/schemas/forgeax-metrics.schema.json
//   --report-dir default = <root>/report
//
// Output schema for report/<package>/<kind>.json (validated via the same
// schemas/forgeax-metrics.schema.json $defs/runnerEntry):
//   { package: string, kind: MetricKind, enabled: true, status: 'ok'|'over'|...,
//     value: number|null, threshold: number|null, details: object }
//
// Reference:
//   - requirements §AC-05 / §AC-06 / §AC-15
//   - plan-strategy §K-5 / §K-8 / §K-11 / §4.3 / §4.4 / §7.3
//   - plan-tasks.json#w18 acceptanceCheck

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const runner = resolve(repoRoot, 'scripts/metrics/run-all.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');
const realSchema = resolve(repoRoot, 'schemas/forgeax-metrics.schema.json');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runRunner(args: string[]): RunResult {
  const start = Date.now();
  const r = spawnSync('node', [runner, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    durationMs: Date.now() - start,
  };
}

let tmpReport: string;

beforeEach(() => {
  tmpReport = mkdtempSync(`${tmpdir()}/forgeax-runner-test-`);
});

afterEach(() => {
  if (tmpReport && existsSync(tmpReport)) {
    rmSync(tmpReport, { recursive: true, force: true });
  }
});

describe('scripts/metrics/run-all.mjs generic runner (w18)', () => {
  it('(a1) runner-all-ok fixture: exit 0 with all status=ok', () => {
    const root = resolve(fixturesDir, 'runner-all-ok');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
  });

  it('(a2) runner-all-ok fixture: generic report/<package>/<kind>.json uses dispatched kinds', () => {
    const root = resolve(fixturesDir, 'runner-all-ok');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    const alphaBundlePath = resolve(tmpReport, 'alpha/bundle-size.json');
    expect(existsSync(alphaBundlePath)).toBe(true);
    const alphaGatePath = resolve(tmpReport, 'alpha/gate.json');
    expect(existsSync(alphaGatePath)).toBe(false);
    const bundleEntry = JSON.parse(readFileSync(alphaBundlePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(bundleEntry.package).toBe('alpha');
    expect(bundleEntry.kind).toBe('bundle-size');
    expect(bundleEntry.enabled).toBe(true);
    expect(bundleEntry.status).toBe('ok');
    expect(typeof bundleEntry.value).toBe('number');
    expect(bundleEntry.threshold).toBe(102400);
  });

  it('(a3) runner-all-ok fixture: disabled and dedicated gate kinds produce no generic reports', () => {
    const root = resolve(fixturesDir, 'runner-all-ok');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(existsSync(resolve(tmpReport, 'beta'))).toBe(false);
    const alphaDir = resolve(tmpReport, 'alpha');
    expect(existsSync(alphaDir)).toBe(true);
    const alphaFiles = readdirSync(alphaDir).sort();
    expect(alphaFiles).toEqual(['bundle-size.json']);
    const charlieDir = resolve(tmpReport, 'charlie');
    expect(existsSync(charlieDir)).toBe(true);
    const charlieFiles = readdirSync(charlieDir).sort();
    expect(charlieFiles).toEqual(['bundle-size.json']);
  });

  it('(b1) runner-over fixture: status=over fires metric-status-not-ok exit 1', () => {
    const root = resolve(fixturesDir, 'runner-over');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('metric-status-not-ok');
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(b2) runner-over fixture: report still written with status=over', () => {
    const root = resolve(fixturesDir, 'runner-over');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status).toBe(1);
    const path = resolve(tmpReport, 'alpha/bundle-size.json');
    expect(existsSync(path)).toBe(true);
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(entry.status).toBe('over');
    expect(entry.threshold).toBe(8);
    expect(typeof entry.value).toBe('number');
    expect((entry.value as number) > 8).toBe(true);
  });

  it('(c1) runner-disabled fixture: all enabled=false skipped exit 0', () => {
    const root = resolve(fixturesDir, 'runner-disabled');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain('metric-status-not-ok');
  });

  it('(c2) runner-disabled fixture: no report files written', () => {
    const root = resolve(fixturesDir, 'runner-disabled');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(existsSync(resolve(tmpReport, 'alpha'))).toBe(false);
  });

  it('(d) timing budget: every fixture run completes under 30s (K-11)', () => {
    const root = resolve(fixturesDir, 'runner-all-ok');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.durationMs).toBeLessThan(30_000);
  });

  it('(e) brotli compression path: charlie workspace uses compression=brotli', () => {
    const root = resolve(fixturesDir, 'runner-all-ok');
    const r = runRunner(['--root', root, '--schema', realSchema, '--report-dir', tmpReport]);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    const charlieBundlePath = resolve(tmpReport, 'charlie/bundle-size.json');
    expect(existsSync(charlieBundlePath)).toBe(true);
    const entry = JSON.parse(readFileSync(charlieBundlePath, 'utf8')) as Record<string, unknown>;
    expect(entry.status).toBe('ok');
    expect(typeof entry.value).toBe('number');
    const details = entry.details as { compression?: unknown } | null;
    expect(details?.compression).toBe('brotli');
  });
});
