import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const mergerPath = join(repoRoot, 'scripts', 'ci', 'merge-app-shard-results.mjs');

function paths(apps) {
  return apps.map((app) => `apps/${app}/dist/shaders/manifest.json`);
}

function fixture({ reports, inventories }) {
  const root = mkdtempSync(join(tmpdir(), 'merge-app-shards-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const allApps = ['alpha', 'beta', 'gamma'];
  for (const app of allApps) {
    const appDir = join(root, 'apps', app);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: app, scripts: { build: 'true' } }),
    );
  }
  const reportsDir = join(root, 'reports');
  mkdirSync(reportsDir);
  for (const [index, report] of reports.entries()) {
    writeFileSync(join(reportsDir, `coverage-${index}.json`), JSON.stringify(report));
    if (inventories[index] !== undefined) {
      writeFileSync(
        join(reportsDir, `artifact-inventory-${index}.json`),
        JSON.stringify(inventories[index]),
      );
    }
  }
  return { root, reportsDir };
}

function validReports() {
  return [
    { shardIndex: 0, result: 'success', apps: ['alpha'], artifactInventory: paths(['alpha']) },
    { shardIndex: 1, result: 'success', apps: ['beta'], artifactInventory: paths(['beta']) },
    { shardIndex: 2, result: 'success', apps: ['gamma'], artifactInventory: paths(['gamma']) },
  ];
}

function run(root, reportsDir, selectionPath = null) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        mergerPath,
        '--root',
        root,
        '--reports-dir',
        reportsDir,
        ...(selectionPath ? ['--selection', selectionPath] : []),
      ],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
    };
  }
}

test('retry provenance: falls back to the only downloaded shard attempt when aggregate attempt is newer', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: reports.map((report) => paths(report.apps)),
  });
  const selectionPath = join(root, 'selection.json');
  writeFileSync(
    selectionPath,
    JSON.stringify({ producerAttempts: { 'app-shard-0': 2, 'app-shard-1': 2, 'app-shard-2': 2 } }),
  );
  for (const [index, report] of reports.entries()) {
    writeFileSync(join(reportsDir, `coverage-${index}-a1.json`), JSON.stringify(report));
    writeFileSync(
      join(reportsDir, `artifact-inventory-${index}-a1.json`),
      JSON.stringify(paths(report.apps)),
    );
  }
  try {
    const result = run(root, reportsDir, selectionPath);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t13: merges three successful exact-once coverage reports', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: reports.map((report) => paths(report.apps)),
  });
  try {
    const result = run(root, reportsDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t13: rejects failed, cancelled, skipped, duplicate, and missing app coverage', () => {
  const scenarios = [
    {
      reports: [{ shardIndex: 0, result: 'failure', apps: ['alpha'] }, ...validReports().slice(1)],
    },
    {
      reports: [
        { shardIndex: 0, result: 'cancelled', apps: ['alpha'] },
        ...validReports().slice(1),
      ],
    },
    {
      reports: [{ shardIndex: 0, result: 'skipped', apps: ['alpha'] }, ...validReports().slice(1)],
    },
    {
      reports: [
        { shardIndex: 0, result: 'success', apps: ['alpha', 'beta'] },
        ...validReports().slice(1),
      ],
    },
    {
      reports: [
        { shardIndex: 0, result: 'success', apps: ['alpha'] },
        { shardIndex: 1, result: 'success', apps: [] },
        validReports()[2],
      ],
    },
  ];
  for (const scenario of scenarios) {
    const { root, reportsDir } = fixture({
      reports: scenario.reports,
      inventories: scenario.reports.map((report) => paths(report.apps)),
    });
    try {
      const result = run(root, reportsDir);
      assert.notEqual(result.exitCode, 0);
      assert.match(JSON.parse(result.stdout).code, /^(?:ci-app-shard-|ci-shard-inventory-)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('t12c: validates complete disjoint repo-relative manifest inventories before coverage', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: reports.map((report) => paths(report.apps)),
  });
  try {
    const pass = run(root, reportsDir);
    assert.equal(pass.exitCode, 0, pass.stderr || pass.stdout);

    writeFileSync(join(reportsDir, 'artifact-inventory-1.json'), JSON.stringify(['../escape']));
    const invalidPath = run(root, reportsDir);
    assert.notEqual(invalidPath.exitCode, 0);
    assert.equal(JSON.parse(invalidPath.stdout).code, 'ci-shard-inventory-invalid-path');

    writeFileSync(join(reportsDir, 'artifact-inventory-1.json'), JSON.stringify(paths(['alpha'])));
    const intersection = run(root, reportsDir);
    assert.notEqual(intersection.exitCode, 0);
    assert.equal(JSON.parse(intersection.stdout).code, 'ci-shard-inventory-path-intersection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: permits build apps without Vite artifact output', () => {
  const reports = validReports();
  reports[2].artifactInventory = [];
  const { root, reportsDir } = fixture({
    reports,
    inventories: [paths(['alpha']), paths(['beta']), []],
  });
  try {
    const result = run(root, reportsDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12c: rejects a missing or invalid inventory', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: [paths(['alpha']), paths(['beta'])],
  });
  try {
    const missing = run(root, reportsDir);
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).code, 'ci-shard-inventory-missing');
    writeFileSync(join(reportsDir, 'artifact-inventory-2.json'), '{');
    const invalid = run(root, reportsDir);
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(JSON.parse(invalid.stdout).code, 'ci-shard-inventory-invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w17: rejects shared, cross-app, unknown, and incomplete shard inventories structurally', () => {
  const reports = validReports();
  const scenarios = [
    {
      inventory: ['shared-app-inputs/assets/catalog.json'],
      code: 'ci-shard-inventory-shared-payload',
    },
    {
      inventory: paths(['beta']),
      inventories: [paths(['beta']), [], paths(['gamma'])],
      code: 'ci-shard-inventory-cross-app-path',
    },
    {
      inventory: ['apps/missing/dist/shaders/manifest.json'],
      code: 'ci-shard-inventory-unknown-app',
    },
    { inventory: [], required: true, code: 'ci-shard-inventory-required-file-missing' },
  ];
  for (const { inventory, inventories, required, code } of scenarios) {
    const scenarioReports = structuredClone(reports);
    if (required) scenarioReports[0].artifactInventory = paths(['alpha']);
    const { root, reportsDir } = fixture({
      reports: scenarioReports,
      inventories: inventories ?? [inventory, paths(['beta']), paths(['gamma'])],
    });
    try {
      const result = run(root, reportsDir);
      assert.notEqual(result.exitCode, 0);
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.code, code);
      assert.ok('expected' in failure);
      assert.ok('detail' in failure);
      assert.ok('hint' in failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repair: accepts a complete Pack closure and rejects a partial closure', () => {
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const complete = [
    'apps/alpha/dist/shaders/manifest.json',
    'apps/alpha/dist/pack-index.json',
    `apps/alpha/dist/assets/${guid}.pack-fixture.json`,
    `apps/alpha/dist/assets/${guid}-body.bin`,
  ];
  const reports = validReports();
  reports[0].artifactInventory = complete;
  const { root, reportsDir } = fixture({
    reports,
    inventories: [complete, paths(['beta']), paths(['gamma'])],
  });
  try {
    const pass = run(root, reportsDir);
    assert.equal(pass.exitCode, 0, pass.stderr || pass.stdout);
    writeFileSync(
      join(reportsDir, 'artifact-inventory-0.json'),
      JSON.stringify(complete.slice(0, -1)),
    );
    const partial = run(root, reportsDir);
    assert.notEqual(partial.exitCode, 0);
    assert.equal(JSON.parse(partial.stdout).code, 'ci-shard-inventory-required-file-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: accepts the canonical .pack.json sidecar closure', () => {
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const complete = [
    'apps/alpha/dist/shaders/manifest.json',
    'apps/alpha/dist/pack-index.json',
    `apps/alpha/dist/assets/${guid}.pack.json`,
    `apps/alpha/dist/assets/${guid}-body.bin`,
  ];
  const reports = validReports();
  reports[0].artifactInventory = complete;
  const { root, reportsDir } = fixture({
    reports,
    inventories: [complete, paths(['beta']), paths(['gamma'])],
  });
  try {
    const result = run(root, reportsDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the producer-declared field/program closure without inferring artifact names', () => {
  const complete = [
    ...paths(['alpha']),
    'apps/alpha/dist/pack-index.json',
    'apps/alpha/dist/assets/019fcaf0-0015-7000-8000-000000000001.pack.json',
    'apps/alpha/dist/assets/0d9c8387-2647-5124-aba5-ca234bbe228f/body.bin',
    'apps/alpha/dist/assets/0d9c8387-2647-5124-aba5-ca234bbe228f/distance-field.payload',
    'apps/alpha/dist/assets/019e9c00-0000-7000-8000-000000000000/particle-effect/program.json.bin',
    'apps/alpha/dist/assets/materials/programs/material.wgsl.bin',
  ];
  const reports = validReports();
  reports[0].artifactInventory = complete;
  const { root, reportsDir } = fixture({
    reports,
    inventories: [complete, paths(['beta']), paths(['gamma'])],
  });
  try {
    const pass = run(root, reportsDir);
    assert.equal(pass.exitCode, 0, pass.stderr || pass.stdout);
    for (const missing of complete.slice(2)) {
      writeFileSync(
        join(reportsDir, 'artifact-inventory-0.json'),
        JSON.stringify(complete.filter((path) => path !== missing)),
      );
      const result = run(root, reportsDir);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).code, 'ci-shard-inventory-required-file-missing');
    }
    writeFileSync(
      join(reportsDir, 'artifact-inventory-0.json'),
      JSON.stringify([...complete, 'apps/alpha/dist/assets/undeclared.payload']),
    );
    const extra = run(root, reportsDir);
    assert.notEqual(extra.exitCode, 0);
    assert.equal(JSON.parse(extra.stdout).code, 'ci-shard-inventory-undeclared-file');
    for (const unsafe of [
      '../escape',
      'nested//file',
      'nested/./file',
      'nested/../file',
      'nested\\file',
      'file\u0000.bin',
    ]) {
      const path = `apps/alpha/dist/assets/${unsafe}`;
      writeFileSync(
        join(reportsDir, 'artifact-inventory-0.json'),
        JSON.stringify([...complete, path]),
      );
      const invalid = run(root, reportsDir);
      assert.notEqual(invalid.exitCode, 0);
      assert.equal(JSON.parse(invalid.stdout).code, 'ci-shard-inventory-invalid-path');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
