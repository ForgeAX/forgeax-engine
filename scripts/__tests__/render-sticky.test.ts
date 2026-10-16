// render-sticky.test.ts (M5 w22) - sticky comment renderer snapshot tests.
//
// Drives the implementation of scripts/metrics/render-sticky.mjs (M5 w22 same
// commit) via TDD. Three fixture report trees exercise the renderer state
// machine:
//
//   (i)   render-sticky-all-ok    => summary table shows only the "total: N/M"
//                                    overview row; <details> body lists every
//                                    metric entry.
//   (ii)  render-sticky-partial   => summary table lists status !== 'ok' rows
//                                    plus the overview row; <details> body
//                                    still lists every entry.
//   (iii) render-sticky-all-bad   => summary table lists every entry (all are
//                                    not ok) plus the overview row.
//
// Output contract (plan-strategy K-10 + AC-15):
//   - Title:   '### forgeax-engine metrics report'
//   - Summary table <= 30 rows (the renderer caps the table at 30 lines)
//   - <details><summary>...</summary> wraps the full matrix
//   - Full matrix retains every producer-owned metric, without a fixed roster cap.
//
// Reference:
//   - requirements §AC-07 / §AC-15
//   - plan-strategy §K-10 / §4.4 / §7.4 / §7.5
//   - plan-tasks.json#w22 acceptanceCheck

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const renderer = resolve(repoRoot, 'scripts/metrics/render-sticky.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');

interface RenderResult {
  status: number;
  stdout: string;
  stderr: string;
}

let tmpOut: string;

beforeEach(() => {
  tmpOut = mkdtempSync(`${tmpdir()}/forgeax-render-sticky-`);
});

afterEach(() => {
  rmSync(tmpOut, { recursive: true, force: true });
});

function runRenderer(
  reportRoot: string,
  environment: Record<string, string> = {},
  additionalArguments: string[] = [],
): RenderResult {
  const out = `${tmpOut}/sticky-comment.md`;
  const r = spawnSync(
    'node',
    [renderer, '--report-dir', reportRoot, '--out', out, '--stdout', ...additionalArguments],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        EXPECTED_PRODUCT_SHA: '',
        GITHUB_SHA: '',
        GITHUB_RUN_ID: '',
        FORGEAX_CI_NEEDS: '',
        ...environment,
      },
    },
  );
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('scripts/metrics/render-sticky.mjs sticky comment composer (w22)', () => {
  it('publishes failed gate context and exact identity when metric production is skipped', () => {
    const root = resolve(tmpOut, 'report');
    mkdirSync(root);
    const r = runRenderer(
      root,
      {
        EXPECTED_PRODUCT_SHA: 'tested-head',
        GITHUB_SHA: 'merge-event',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_REPOSITORY: 'ForgeaX-Games/forgeax-engine',
        FORGEAX_CI_NEEDS: JSON.stringify({
          'primary-pnpm': { result: 'failure', outputs: {} },
          'metrics-validate': { result: 'skipped', outputs: {} },
        }),
      },
      ['--ci-context'],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Head: `tested-head`');
    expect(r.stdout).toContain('Workflow event SHA: `merge-event`');
    expect(r.stdout).toContain('attempt 2');
    expect(r.stdout).toContain('| primary-pnpm | failure |');
    expect(r.stdout).toContain('| metrics-validate | skipped |');
    expect(r.stdout).toContain('Metric report unavailable');
    expect(r.stdout).toContain('full job/shard roster');
  });

  it('preserves the complete producer report when adding CI gate context', () => {
    const metric = runRenderer(resolve(fixturesDir, 'render-sticky-all-ok'));
    const root = resolve(tmpOut, 'report');
    mkdirSync(root);
    writeFileSync(resolve(root, 'sticky-comment.md'), metric.stdout);
    const r = runRenderer(
      root,
      {
        FORGEAX_CI_NEEDS: JSON.stringify({
          'primary-pnpm': { result: 'success', outputs: {} },
          'metrics-validate': { result: 'success', outputs: { metrics_artifact_id: '123' } },
        }),
      },
      ['--ci-context'],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| metrics-validate | success |');
    expect(r.stdout).toContain('metrics_artifact_id');
    expect(r.stdout).toContain('123');
    expect(r.stdout).toContain(metric.stdout.trim());
  });

  it('fails closed while retaining context when a successful producer has no report body', () => {
    const root = resolve(tmpOut, 'report');
    mkdirSync(root);
    const r = runRenderer(
      root,
      {
        FORGEAX_CI_NEEDS: JSON.stringify({
          'metrics-validate': { result: 'success', outputs: {} },
        }),
      },
      ['--ci-context'],
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('| metrics-validate | success |');
    expect(r.stdout).toContain('Metric report unavailable');
    expect(r.stderr).toContain('successful metrics producer has no report body');
  });

  it('publishes exact Actions identity while separating metric status from CI acceptance', () => {
    const r = runRenderer(resolve(fixturesDir, 'render-sticky-all-ok'), {
      EXPECTED_PRODUCT_SHA: 'tested-head',
      GITHUB_SHA: 'merge-event',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_REPOSITORY: 'ForgeaX-Games/forgeax-engine',
      GITHUB_SERVER_URL: 'https://github.com',
    });
    expect(r.stdout).toContain('Head: `tested-head`');
    expect(r.stdout).toContain('Workflow event SHA: `merge-event`');
    expect(r.stdout).toContain('actions/runs/42');
    expect(r.stdout).toContain('attempt 2');
    expect(r.stdout).toContain('Metric status is separate from overall CI acceptance');
    expect(r.stdout).toContain('no threshold was declared');
  });

  it('counts only producer-owned metric files and preserves invalid metric evidence', () => {
    const root = resolve(tmpOut, 'report');
    const pkg = resolve(root, 'fixture');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      resolve(pkg, 'bundle-size.json'),
      JSON.stringify({
        package: 'fixture',
        kind: 'bundle-size',
        status: 'ok',
        value: 64,
        threshold: null,
        details: { compression: 'gzip' },
      }),
    );
    writeFileSync(resolve(pkg, 'validation.json'), JSON.stringify({ status: 'pass' }));
    writeFileSync(resolve(pkg, 'receipt.json'), JSON.stringify({ status: 'complete' }));
    writeFileSync(resolve(pkg, 'gate.json'), '{broken');
    writeFileSync(resolve(pkg, 'fps.json'), JSON.stringify({ kind: 'gate', status: 'ok' }));
    const r = runRenderer(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('total: 1/3');
    expect(r.stdout).toContain('| fixture | gate | n/a | n/a | unavailable |');
    expect(r.stdout).not.toContain('undefined');
    expect(r.stdout).toContain('invalid metric report');
    expect(r.stdout).toContain('invalid metric identity or status');
  });

  it('includes every metric beyond the former 60-line limit, with its evidence', () => {
    const root = resolve(tmpOut, 'report');
    for (let index = 0; index < 80; index += 1) {
      const pkg = `fixture-${String(index).padStart(3, '0')}`;
      const dir = resolve(root, pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'gate.json'),
        JSON.stringify({
          package: pkg,
          kind: 'gate',
          status: 'ok',
          value: 1,
          threshold: null,
          details: { command: `check-${index}`, exit: 0 },
        }),
      );
    }
    const r = runRenderer(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('complete metrics details (80 entries)');
    expect(r.stdout).toContain('| fixture-079 | gate | 1 | n/a | ok |');
    expect(r.stdout).toContain('check-79');
    expect(r.stdout).not.toContain('more, see <details>');
  });

  it('reports GPU improvement floors and VFX p95 budgets with their actual units', () => {
    const root = resolve(tmpOut, 'report');
    for (const entry of [
      {
        package: 'gpu',
        kind: 'bench',
        status: 'ok',
        value: 0.25,
        threshold: 0.15,
        details: { reportSchema: 'gpu-frame-samples', identityBuild: 'tested-head' },
      },
      {
        package: 'vfx',
        kind: 'bench',
        status: 'ok',
        value: 12.5,
        threshold: 33.34,
        details: { reportSchema: 'vfx-batch-b', adapterClass: 'hardware' },
      },
    ]) {
      const dir = resolve(root, entry.package);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'bench.json'), JSON.stringify(entry));
    }
    const r = runRenderer(root);
    expect(r.stdout).toContain('25.00% GPU median improvement');
    expect(r.stdout).toContain('>= 15.00% GPU median improvement');
    expect(r.stdout).toContain('12.50 ms p95');
    expect(r.stdout).toContain('<= 33.34 ms p95');
    expect(r.stdout).toContain('tested-head');
    expect(r.stdout).toContain('hardware');
  });

  it('(i) all-ok fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(i.a) all-ok fixture: title literal present', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toContain('### forgeax-engine metrics report');
  });

  it('(i.b) all-ok fixture: <details> + <summary> wraps the matrix', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toContain('<details>');
    expect(r.stdout).toContain('<summary>');
  });

  it('(ii) partial fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(ii.a) partial fixture: summary table lists the over entry', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toMatch(/engine[\s\S]*bundle-size[\s\S]*over/);
  });

  it('(iii) all-bad fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-bad');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(iv) small fixture keeps a compact overview and a complete matrix', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-bad');
    const r = runRenderer(reportRoot);
    const summaryEnd = r.stdout.indexOf('<details>');
    expect(summaryEnd).toBeGreaterThan(0);
    const summaryLines = r.stdout.slice(0, summaryEnd).split('\n');
    expect(summaryLines.length).toBeLessThanOrEqual(30);
    const detailsEnd = r.stdout.indexOf('</details>');
    const detailsBlock = r.stdout.slice(summaryEnd, detailsEnd);
    const detailsLines = detailsBlock.split('\n');
    expect(detailsLines.length).toBeLessThanOrEqual(60);
  });

  it('(v) determinism: 3 reruns produce identical stdout', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const a = runRenderer(reportRoot).stdout;
    const b = runRenderer(reportRoot).stdout;
    const c = runRenderer(reportRoot).stdout;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
