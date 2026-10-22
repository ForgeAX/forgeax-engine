import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_PATH,
  collectFindings,
  compareWithBaseline,
  listLockfiles,
} from '../check-dependency-vulnerabilities.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gatePath = resolve(repoRoot, 'scripts', 'ci', 'check-dependency-vulnerabilities.mjs');

function osvReport(root, packages) {
  return {
    results: [
      {
        source: { path: `${root}/pnpm-lock.yaml`, type: 'lockfile' },
        packages: packages.map(({ name, version, groups }) => ({
          package: { name, version, ecosystem: 'npm' },
          groups: groups.map((ids) => ({ ids })),
          vulnerabilities: groups.flat().map((id) => ({ id })),
        })),
      },
    ],
  };
}

function withRepo(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-dependency-vulnerabilities-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    for (const [path, contents] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGate(root, report, ...args) {
  const reportPath = join(root, 'osv.json');
  writeFileSync(reportPath, JSON.stringify(report));
  return spawnSync(process.execPath, [gatePath, '--root', root, '--report', reportPath, ...args], {
    encoding: 'utf8',
  });
}

describe('listLockfiles', () => {
  it('selects first-party lockfiles and skips pinned upstream sources and fixtures', () => {
    withRepo(
      [
        ['pnpm-lock.yaml', ''],
        ['bun.lock', ''],
        ['packages/a/Cargo.lock', ''],
        ['packages/a/scripts/native-tests.Cargo.lock', ''],
        ['third_party/wgpu/Cargo.lock', ''],
        ['packages/b/vendor/x/Cargo.lock', ''],
        ['scripts/__tests__/fixtures/pnpm-lock.yaml', ''],
      ],
      (root) => {
        assert.deepEqual(listLockfiles(root), [
          'bun.lock',
          'packages/a/Cargo.lock',
          'packages/a/scripts/native-tests.Cargo.lock',
          'pnpm-lock.yaml',
        ]);
      },
    );
  });
});

describe('collectFindings', () => {
  it('collapses alias groups and merges versions per package', () => {
    const root = '/repo';
    const report = osvReport(root, [
      { name: 'vite', version: '7.3.6', groups: [['GHSA-b', 'CVE-1']] },
      { name: 'vite', version: '8.0.10', groups: [['GHSA-b', 'CVE-1'], ['GHSA-c']] },
    ]);
    const findings = collectFindings(report, root);
    assert.deepEqual(
      findings.map((f) => [f.key, [...f.versions], [...f.lockfiles]]),
      [
        ['npm/vite/CVE-1', ['7.3.6', '8.0.10'], ['pnpm-lock.yaml']],
        ['npm/vite/GHSA-c', ['8.0.10'], ['pnpm-lock.yaml']],
      ],
    );
  });
});

describe('compareWithBaseline', () => {
  it('reports new, expired and stale entries', () => {
    const findings = [{ key: 'npm/a/X' }, { key: 'npm/b/Y' }];
    const baseline = new Map([
      ['npm/b/Y', { reason: 'r', until: '2026-01-01' }],
      ['npm/c/Z', { reason: 'r', until: '2027-01-01' }],
    ]);
    const result = compareWithBaseline(findings, baseline, '2026-06-01');
    assert.deepEqual(
      result.added.map((f) => f.key),
      ['npm/a/X'],
    );
    assert.deepEqual(
      result.expired.map((f) => f.key),
      ['npm/b/Y'],
    );
    assert.deepEqual(result.stale, ['npm/c/Z']);
  });
});

describe('check-dependency-vulnerabilities CLI', () => {
  it('fails a new advisory, passes once accepted, and keeps the reviewed reason', () => {
    withRepo([[BASELINE_PATH, '{"accepted":{}}\n']], (root) => {
      const report = osvReport(root, [{ name: 'ws', version: '8.20.0', groups: [['GHSA-x']] }]);
      const failed = runGate(root, report);
      assert.equal(failed.status, 1);
      assert.match(
        failed.stderr,
        /FAIL new key=npm\/ws\/GHSA-x versions=8\.20\.0 lockfiles=pnpm-lock\.yaml/,
      );

      assert.equal(
        runGate(root, report, '--accept', 'not reachable', '--until', '2999-01-01').status,
        0,
      );
      assert.equal(runGate(root, report).status, 0);
      runGate(root, report, '--accept', 'other reason', '--until', '2999-02-01');
      const baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
      assert.deepEqual(baseline.accepted['npm/ws/GHSA-x'], {
        reason: 'not reachable',
        until: '2999-01-01',
      });
    });
  });

  it('fails when an accepted advisory expires or disappears', () => {
    const accepted = { 'npm/ws/GHSA-x': { reason: 'r', until: '2000-01-01' } };
    withRepo([[BASELINE_PATH, JSON.stringify({ accepted })]], (root) => {
      const report = osvReport(root, [{ name: 'ws', version: '8.20.0', groups: [['GHSA-x']] }]);
      assert.match(runGate(root, report).stderr, /FAIL expired key=npm\/ws\/GHSA-x/);
      assert.match(runGate(root, osvReport(root, [])).stderr, /FAIL stale key=npm\/ws\/GHSA-x/);
    });
  });

  it('treats a scanner failure as a setup error, never as a pass', () => {
    withRepo([[BASELINE_PATH, '{"accepted":{}}\n']], (root) => {
      const result = spawnSync(
        process.execPath,
        [gatePath, '--root', root, '--scanner', join(root, 'missing-osv-scanner')],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /setup error: dependency-vulnerabilities: cannot run/);
    });
  });
});
