import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILTIN_HANDLE_CUBE } from '@forgeax/engine-pack/builtin';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const plannerPath = join(repoRoot, 'scripts', 'ci', 'build-app-shard.mjs');
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');

function fixture(appNames) {
  const root = mkdtempSync(join(tmpdir(), 'app-shard-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  mkdirSync(join(root, 'apps'), { recursive: true });
  for (const name of appNames) {
    const appDir = join(root, 'apps', name);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${name}`, scripts: { build: 'true' } }),
    );
    const shaders = join(appDir, 'dist', 'shaders');
    mkdirSync(shaders, { recursive: true });
    writeFileSync(join(shaders, 'manifest.json'), name);
    mkdirSync(join(appDir, 'report'), { recursive: true });
    writeFileSync(join(appDir, 'report', 'result.txt'), name);
  }
  return root;
}

function runPlanner(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [plannerPath, '--root', root, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
    };
  }
}

function writePackRoster(root, app, guid) {
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'ci', 'dawn-smoke-roster.json'),
    JSON.stringify({
      schemaVersion: 3,
      roots: ['apps'],
      entries: [
        {
          package: `@fixture/${app}`,
          path: `apps/${app}/package.json`,
          classification: 'run',
          gates: [
            {
              gateId: `${app}/smoke`,
              commandId: 'smoke',
              executionClass: 'sharded',

              artifactRequirements: { packGuids: [guid] },

              oracle: 'frameReceipt',
            },
          ],
        },
      ],
    }),
  );
}

function writePackFixture(root, { packageUrl = null, bodyPath = null, sidecars = [] } = {}) {
  const app = 'pbr';
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const resolvedBodyPath = bodyPath ?? `${guid}-body.bin`;
  const appDir = join(root, 'apps', app);
  const dist = join(appDir, 'dist');
  mkdirSync(join(dist, 'shaders'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: `@fixture/${app}`,
      scripts: { build: 'true' },
      forgeax: { smokeInvocation: `pnpm --filter @fixture/${app} smoke` },
    }),
  );
  writeFileSync(join(dist, 'shaders', 'manifest.json'), 'shader');
  const packName = `${guid}.pack-fixture.json`;
  const resolvedPackageUrl = packageUrl ?? `/assets/${packName}`;
  writeFileSync(
    join(dist, 'pack-index.json'),
    JSON.stringify([{ guid, packageUrl: resolvedPackageUrl }]),
  );
  writeFileSync(
    join(dist, 'assets', packName),
    JSON.stringify({
      schemaVersion: '2.0.0',
      assets: [
        {
          guid,
          artifacts: {
            body: { path: resolvedBodyPath },
            ...Object.fromEntries(sidecars.map((path) => [path, { path }])),
          },
        },
      ],
    }),
  );
  writeFileSync(join(dist, 'assets', resolvedBodyPath), 'body');
  for (const path of sidecars) writeFileSync(join(dist, 'assets', path), 'sidecar');
  writePackRoster(root, app, guid);
}

function shardReport(root, index, count = 3) {
  const result = runPlanner(root, [
    '--shard-count',
    String(count),
    '--shard-index',
    String(index),
    '--dry-run',
  ]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('t12: derives a stable exact-once roster across three shards', () => {
  const root = fixture(['zeta', 'alpha', 'gamma', 'beta', 'delta', 'epsilon']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    const covered = reports.flatMap((report) => report.apps).sort();
    assert.deepEqual(covered, ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta']);
    assert.equal(new Set(covered).size, covered.length);
    assert.deepEqual(shardReport(root, 0), shardReport(root, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: preserves exact-once coverage when the roster is not divisible by three', () => {
  const root = fixture(['five', 'one', 'four', 'two', 'three']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    assert.deepEqual(reports.flatMap((report) => report.apps).sort(), [
      'five',
      'four',
      'one',
      'three',
      'two',
    ]);
    assert.deepEqual(
      reports.map((report) => report.appCount),
      [2, 2, 1],
    );
    assert.equal(reports[0].loadImbalance, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: rejects an out-of-range shard index with a structured error', () => {
  const root = fixture(['one']);
  try {
    const result = runPlanner(root, ['--shard-count', '3', '--shard-index', '3', '--dry-run']);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-index-out-of-range');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared mode rejects a missing declared manifest instead of reading an implicit runner path', () => {
  const root = fixture(['one']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '3',
      '--shard-index',
      '0',
      '--shared-input-manifest',
      'missing/manifest.json',
      '--dry-run',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-shared-input-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: dry-run prints the assigned apps without invoking builds', () => {
  const root = fixture(['alpha', 'beta']);
  try {
    const result = runPlanner(root, ['--shard-count', '3', '--shard-index', '0', '--dry-run']);
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.apps, ['alpha']);
    assert.equal(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').includes('apps/*'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: skipped consumer-built apps are omitted from the shard payload', () => {
  const root = fixture(['alpha', 'beta']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--omit-transfer-app',
      'alpha',
      '--skip-build-app',
      'alpha',
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.apps, ['alpha', 'beta']);
    assert.deepEqual(report.buildApps, ['beta']);
    assert.deepEqual(report.skippedBuildApps, ['alpha']);
    assert.deepEqual(report.transferApps, ['beta']);
    assert.deepEqual(report.artifactInventory, ['apps/beta/dist/shaders/manifest.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: skipping a build without omitting transfer fails closed', () => {
  const root = fixture(['alpha']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--skip-build-app',
      'alpha',
      '--dry-run',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-skip-build-transfer-required');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-built exclusions follow app assignment when the roster grows', () => {
  for (const names of [
    ['beta', 'gamma'],
    ['alpha', 'beta', 'gamma'],
  ]) {
    const root = fixture(names);
    try {
      const reports = [0, 1, 2].map((index) => {
        const result = runPlanner(root, [
          '--shard-count',
          '3',
          '--shard-index',
          String(index),
          '--omit-transfer-app',
          'beta',
          '--skip-build-app',
          'beta',
          '--dry-run',
        ]);
        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      });
      assert.deepEqual(
        reports.flatMap((report) => report.skippedBuildApps),
        ['beta'],
      );
      assert.deepEqual(
        reports.flatMap((report) => report.omittedTransferApps),
        ['beta'],
      );
      assert.deepEqual(
        reports.flatMap((report) => report.buildApps).sort(),
        names.filter((name) => name !== 'beta'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('global consumer-built exclusions reject unknown apps', () => {
  const root = fixture(['alpha']);
  try {
    for (const flag of ['--omit-transfer-app', '--skip-build-app']) {
      const result = runPlanner(root, [flag, 'missing', '--dry-run']);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).app, 'missing');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12b: derives deterministic repo-relative manifest inventories from every shard roster', () => {
  const root = fixture(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    const expected = reports.flatMap((report) =>
      report.apps.map((app) => `apps/${app}/dist/shaders/manifest.json`),
    );
    const inventory = reports.flatMap((report) => report.artifactInventory).sort();
    assert.deepEqual(inventory, expected.sort());
    assert.equal(new Set(inventory).size, inventory.length);
    for (const path of inventory) {
      assert.match(path, /^apps\/[^/]+\/dist\/shaders\/manifest\.json$/);
    }
    assert.deepEqual(
      shardReport(root, 0).artifactInventory,
      shardReport(root, 0).artifactInventory,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12b: emits an empty inventory for an empty shard roster', () => {
  const root = fixture(['alpha']);
  try {
    assert.deepEqual(shardReport(root, 2).artifactInventory, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: projects only roster-declared Pack JSON and body closure from a fresh app dist', () => {
  const root = fixture([]);
  writePackFixture(root);
  const output = join(root, 'shard-output');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.artifactInventory.sort(), [
      'apps/pbr/dist/assets/019e4a26-3c29-7420-af5d-20f2724a16b0-body.bin',
      'apps/pbr/dist/assets/019e4a26-3c29-7420-af5d-20f2724a16b0.pack-fixture.json',
      'apps/pbr/dist/pack-index.json',
      'apps/pbr/dist/shaders/manifest.json',
    ]);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'pbr', 'dist', 'assets')), true);
    assert.equal(
      existsSync(join(output, 'artifacts', 'apps', 'pbr', 'dist', 'assets', 'unused.bin')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary builtin descriptor references require their Pack closure', () => {
  const root = fixture([]);
  writePackFixture(root);
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const cube = BUILTIN_HANDLE_CUBE;
  const packagePath = join(root, 'apps/pbr/dist/assets', `${guid}.pack-fixture.json`);
  const document = JSON.parse(readFileSync(packagePath, 'utf8'));
  document.assets[0].refs = [cube];
  writeFileSync(packagePath, JSON.stringify(document));
  try {
    const result = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
    assert.notEqual(result.exitCode, 0);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.code, 'ci-app-shard-pack-guid-missing');
    assert.equal(failure.guid, cube);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: inventories a scoped static catalog and rejects degraded authority', () => {
  for (const authority of ['authoritative', 'degraded']) {
    const root = fixture([]);
    writePackFixture(root);
    const path = join(root, 'apps', 'pbr', 'dist', 'pack-index.json');
    const entries = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'pbr',
        generation: 1,
        authority,
        entries,
        diagnostics: [],
      }),
    );
    try {
      const result = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
      if (authority === 'authoritative') {
        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        assert(
          JSON.parse(result.stdout).artifactInventory.includes('apps/pbr/dist/pack-index.json'),
        );
      } else {
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stdout + result.stderr, /ci-app-shard-pack-index-invalid/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repair: fails closed when a roster-declared Pack path is unsafe or absent', () => {
  for (const options of [{ packageUrl: '../escape.json' }, { bodyPath: 'missing.bin' }]) {
    const root = fixture([]);
    writePackFixture(root, options);
    if (options.bodyPath === 'missing.bin')
      rmSync(join(root, 'apps', 'pbr', 'dist', 'assets', 'missing.bin'));
    try {
      const result = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
      assert.notEqual(result.exitCode, 0);
      assert.match(
        JSON.parse(result.stdout).code,
        /^(?:ci-app-shard-pack-unsafe-path|ci-app-shard-pack-body-missing)$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('retains the declared field and program artifacts without inferring type from a suffix', () => {
  const root = fixture([]);
  writePackFixture(root, {
    bodyPath: 'body.payload',
    sidecars: ['distance-field.payload', 'program.json'],
  });
  try {
    const report = shardReport(root, 0, 1);
    assert.equal(report.artifactInventory.includes('apps/pbr/dist/assets/body.payload'), true);
    assert.equal(
      report.artifactInventory.includes('apps/pbr/dist/assets/distance-field.payload'),
      true,
    );
    assert.equal(report.artifactInventory.includes('apps/pbr/dist/assets/program.json'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Boss and SDF smokes receive their complete Pack closures through the actual roster', () => {
  const app = 'hello/boss-lightning';
  const root = fixture([app]);
  const appDir = join(root, 'apps', app);
  const dist = join(appDir, 'dist');
  const roster = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'ci', 'dawn-smoke-roster.json'), 'utf8'),
  );
  const entry = roster.entries.find((entry) => entry.package === '@forgeax/hello-boss-lightning');
  const guids = [
    '0d9c8387-2647-5124-aba5-ca234bbe228f',
    '8ab23da3-6776-5126-ac38-07760b291f5f',
    '376f65c2-5471-5873-aebb-543604f31a85',
    '8e981af2-17c6-56a7-a576-3d8e3677973d',
    '200eacce-a363-5e18-b55d-e6108efed60f',
    'bbb7fc40-a40d-58e2-a6e6-209dc256e911',
  ];
  const particleMaterial = 'd58f993a-290f-59f7-9297-950c29ea5d08';
  const bossEffect = '019e9c00-0000-7000-8000-000000000000';
  const bossMaterial = '019e9c00-0000-7000-8000-000000000002';
  const bossShader = '7e43f472-4c4d-4ee3-9aa1-bc89e7402811';
  const fieldEffect = '8cf2368a-0ae3-579a-a479-b0df2b5f392a';
  const fieldTexture = '9207c1b4-c292-5c11-8cc0-abea04a8ed63';
  const fieldMaterial = 'd7e37f40-18a2-5541-98d2-ed9efc339891';
  const smokeGate = entry.gates.find((gate) => gate.gateId === 'hello-boss-lightning/smoke');
  assert.ok(smokeGate?.artifactRequirements.packGuids.includes(fieldEffect));
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'ci', 'dawn-smoke-roster.json'),
    JSON.stringify({ ...roster, roots: ['apps/hello'], entries: [entry] }),
  );
  writeFileSync(join(appDir, 'package.json'), readFileSync(join(repoRoot, entry.path)));
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(
    join(dist, 'pack-index.json'),
    JSON.stringify({
      schemaVersion: 'runtime-catalog-snapshot-v1',
      scopeId: 'boss-lightning',
      generation: 1,
      authority: 'authoritative',
      diagnostics: [],
      entries: [
        ...[...guids, particleMaterial].map((guid) => ({
          guid,
          packageUrl: '/assets/sdf.pack.json',
        })),
        { guid: BUILTIN_HANDLE_CUBE, packageUrl: '/assets/builtin-cube.pack.json' },
        { guid: bossEffect, packageUrl: '/assets/boss-effect.pack.json' },
        { guid: bossMaterial, packageUrl: '/assets/boss-material.pack.json' },
        { guid: bossShader, packageUrl: '/assets/boss-shader.pack.json' },
        { guid: fieldEffect, packageUrl: '/assets/field-effects.pack.json' },
        { guid: fieldTexture, packageUrl: '/assets/fields.pack.json' },
        { guid: fieldMaterial, packageUrl: '/assets/fields.pack.json' },
      ],
    }),
  );
  const assets = guids.map((guid, index) => ({
    guid,
    refs: index >= 4 ? [particleMaterial] : [],
    artifacts:
      index < 2
        ? {
            body: { path: `${guid}/body.bin` },
            field: { path: `${guid}/distance-field.bin` },
          }
        : {},
  }));
  assets.push({ guid: particleMaterial, artifacts: { body: { path: 'particle-material.json' } } });
  writeFileSync(
    join(dist, 'assets', 'sdf.pack.json'),
    JSON.stringify({ schemaVersion: '2.0.0', assets }),
  );
  const bossAssets = [
    {
      guid: bossEffect,
      refs: [bossMaterial, bossShader, BUILTIN_HANDLE_CUBE],
      artifacts: { program: { path: 'boss/program.json' } },
    },
    { guid: bossMaterial, refs: [], artifacts: {} },
    {
      guid: bossShader,
      refs: [bossMaterial],
      artifacts: { shader: { path: 'boss/material.wgsl' } },
    },
  ];
  writeFileSync(
    join(dist, 'assets', 'builtin-cube.pack.json'),
    JSON.stringify({
      schemaVersion: '2.0.0',
      assets: [
        {
          guid: BUILTIN_HANDLE_CUBE,
          kind: 'mesh',
          payload: { kind: 'mesh', geometry: 'procedural-cube' },
          refs: [],
          artifacts: {},
        },
      ],
    }),
  );
  const fieldAssets = [
    {
      guid: fieldEffect,
      refs: [fieldTexture, fieldMaterial],
      artifacts: { program: { path: 'field-effects/program.json' } },
    },
    { guid: fieldTexture, refs: [], artifacts: { body: { path: 'fields/constant-8.bin' } } },
    {
      guid: fieldMaterial,
      refs: [],
      artifacts: { body: { path: 'fields/particle-material.json' } },
    },
  ];
  for (const [index, name] of ['boss-effect', 'boss-material', 'boss-shader'].entries()) {
    writeFileSync(
      join(dist, 'assets', `${name}.pack.json`),
      JSON.stringify({ schemaVersion: '2.0.0', assets: [bossAssets[index]] }),
    );
  }
  for (const [name, rows] of [
    ['field-effects', [fieldAssets[0]]],
    ['fields', fieldAssets.slice(1)],
  ]) {
    writeFileSync(
      join(dist, 'assets', `${name}.pack.json`),
      JSON.stringify({ schemaVersion: '2.0.0', assets: rows }),
    );
  }
  for (const asset of [...assets, ...bossAssets, ...fieldAssets]) {
    for (const descriptor of Object.values(asset.artifacts)) {
      const path = join(dist, 'assets', descriptor.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, descriptor.path);
    }
  }
  writeFileSync(join(dist, 'assets', 'unrelated.bin'), 'excluded');
  const output = join(root, 'shard-output');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--dry-run',
      '--retain-artifact-only',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const retained = join(output, 'artifacts', 'apps', app, 'dist');
    assert.equal(existsSync(join(retained, 'pack-index.json')), true);
    assert.equal(existsSync(join(retained, 'assets', 'builtin-cube.pack.json')), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(retained, 'assets', 'sdf.pack.json'), 'utf8')).assets,
      assets,
    );
    for (const asset of [...assets, ...bossAssets, ...fieldAssets]) {
      for (const descriptor of Object.values(asset.artifacts)) {
        assert.equal(
          readFileSync(join(retained, 'assets', descriptor.path), 'utf8'),
          descriptor.path,
        );
      }
    }
    for (const name of ['boss-effect', 'boss-material', 'boss-shader']) {
      assert.equal(existsSync(join(retained, 'assets', `${name}.pack.json`)), true);
    }
    assert.equal(existsSync(join(retained, 'assets', 'field-effects.pack.json')), true);
    assert.equal(existsSync(join(retained, 'assets', 'fields.pack.json')), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(retained, 'assets', 'field-effects.pack.json'), 'utf8')).assets,
      [fieldAssets[0]],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(retained, 'assets', 'fields.pack.json'), 'utf8')).assets,
      fieldAssets.slice(1),
    );
    assert.equal(existsSync(join(retained, 'assets', 'unrelated.bin')), false);
    const effectPath = join(dist, 'assets', 'boss-effect.pack.json');
    const unknownGuid = 'ffffffff-ffff-5fff-8fff-ffffffffffff';
    const unknown = structuredClone(bossAssets[0]);
    unknown.refs.push(unknownGuid);
    writeFileSync(effectPath, JSON.stringify({ schemaVersion: '2.0.0', assets: [unknown] }));
    const missingRef = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
    assert.notEqual(missingRef.exitCode, 0);
    assert.equal(JSON.parse(missingRef.stdout).guid, unknownGuid);
    writeFileSync(effectPath, JSON.stringify({ schemaVersion: '2.0.0', assets: [bossAssets[0]] }));
    rmSync(join(dist, 'assets', `${guids[0]}/distance-field.bin`));
    const missingField = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--dry-run',
    ]);
    assert.notEqual(missingField.exitCode, 0);
    const failure = JSON.parse(missingField.stdout);
    assert.equal(failure.code, 'ci-app-shard-pack-unsafe-path');
    assert.equal(failure.path, `${guids[0]}/distance-field.bin`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t15: writes only the assigned shard artifact paths to its report output', () => {
  const root = fixture(['alpha', 'beta', 'gamma']);
  const output = join(root, 'shard-output');
  try {
    const alphaManifest = join(root, 'apps', 'alpha', 'dist', 'shaders');
    mkdirSync(alphaManifest, { recursive: true });
    writeFileSync(join(alphaManifest, 'manifest.json'), 'alpha');
    const result = runPlanner(root, [
      '--shard-count',
      '3',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(
      readFileSync(
        join(output, 'artifacts', 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
        'utf8',
      ),
      'alpha',
    );
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'alpha', 'report')), false);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'beta')), false);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'gamma')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const producer of ['repo-build-inputs', 'shared-app-inputs']) {
  test(`t15: compacts ${producer} engine rows before uploading shard artifacts`, () => {
    const root = fixture(['alpha']);
    const shared = join(root, 'shared-app-inputs');
    const sharedManifest = join(shared, 'shaders', 'manifest.json');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: producer === 'repo-build-inputs' ? 2 : 1,
        producer,
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    writeFileSync(
      sharedManifest,
      JSON.stringify({
        entries: [{ hash: 'engine', wgsl: 'engine', bindings: '{}', glsl: '' }],
        materialShaders: [],
      }),
    );
    writeFileSync(
      join(root, 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
      JSON.stringify({
        entries: [
          { hash: 'engine', wgsl: 'engine', bindings: '{}', glsl: '' },
          { hash: 'custom', wgsl: 'custom', bindings: '{}', glsl: '' },
        ],
        materialShaders: [],
      }),
    );
    const output = join(root, 'shard-output');
    try {
      const result = runPlanner(root, [
        '--shard-count',
        '1',
        '--shard-index',
        '0',
        '--shared-input-manifest',
        'shared-app-inputs/manifest.json',
        '--output-dir',
        output,
        '--dry-run',
      ]);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      const compact = JSON.parse(
        readFileSync(
          join(output, 'artifacts', 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
          'utf8',
        ),
      );
      assert.equal(compact.forgeaxTransport, 'forgeax-app-shader-manifest-delta-v1');
      assert.deepEqual(
        compact.entries.map((entry) => entry.hash),
        ['custom'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('m2: DDC snapshot merge copies complete entries and excludes staging and leases', () => {
  const root = fixture(['alpha']);
  const snapshots = join(root, 'ddc-snapshots');
  const output = join(root, 'ddc-merged');
  mkdirSync(join(snapshots, '0', 'entries', 'aaaa'), { recursive: true });
  mkdirSync(join(snapshots, '0', 'staging', 'attempt'), { recursive: true });
  mkdirSync(join(snapshots, '0', 'lease'), { recursive: true });
  writeFileSync(join(snapshots, '0', 'entries', 'aaaa', 'integrity.json'), 'complete');
  writeFileSync(join(snapshots, '0', 'entries', 'aaaa', 'receipt.json'), 'receipt');
  writeFileSync(join(snapshots, '0', 'staging', 'attempt', 'payload.bin'), 'partial');
  writeFileSync(join(snapshots, '0', 'lease', 'lock'), 'lease');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(output, 'entries', 'aaaa', 'integrity.json')), true);
    assert.equal(existsSync(join(output, 'staging')), false);
    assert.equal(existsSync(join(output, 'lease')), false);
    const second = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.equal(second.exitCode, 0, second.stderr || second.stdout);
    assert.deepEqual(JSON.parse(second.stdout), JSON.parse(result.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('m2: DDC snapshot merge rejects an entry without receipt and integrity', () => {
  const root = fixture(['alpha']);
  const snapshots = join(root, 'ddc-snapshots');
  const output = join(root, 'ddc-merged');
  mkdirSync(join(snapshots, '0', 'entries', 'bbbb'), { recursive: true });
  writeFileSync(join(snapshots, '0', 'entries', 'bbbb', 'payload.json'), '{}');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ddc-snapshot-entry-incomplete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: stages core classes at their consumer extraction roots', () => {
  const root = fixture([]);
  try {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.equal(workflow.includes('path: ci-artifacts/core'), true);
    assert.equal(workflow.includes('name: engine-dist\n          path: packages/*/dist'), false);
    assert.equal(
      workflow.includes('name: wasm-runtime\n          path: packages/wgpu-wasm/pkg'),
      false,
    );
    assert.equal(workflow.includes('name: wasm-fbx\n          path: packages/fbx/pkg'), false);
    assert.equal(workflow.includes('name: wasm-codec\n          path: packages/codec/pkg'), false);

    const sources = {
      'packages/runtime/dist/index.mjs': 'runtime',
      'packages/wgpu-wasm/pkg/wgpu_wasm.js': 'wgpu',
      'packages/fbx/pkg/fbx-wasm.mjs': 'fbx',
      'packages/codec/pkg/basis.mjs': 'codec',
    };
    for (const [relative, contents] of Object.entries(sources)) {
      const source = join(root, relative);
      mkdirSync(join(source, '..'), { recursive: true });
      writeFileSync(source, contents);
    }

    const classes = [
      ['engine-dist', 'packages'],
      ['wasm-runtime', 'packages/wgpu-wasm/pkg'],
      ['wasm-fbx', 'packages/fbx/pkg'],
      ['wasm-codec', 'packages/codec/pkg'],
    ];
    const extraction = join(root, 'download');
    for (const [, source] of classes) {
      const stage = join(root, 'ci-artifacts', 'core', source);
      mkdirSync(join(stage, '..'), { recursive: true });
      cpSync(join(root, source), stage, { recursive: true });
    }
    const archive = join(root, 'core.tar');
    execFileSync('tar', ['-C', join(root, 'ci-artifacts', 'core'), '-cf', archive, '.']);
    mkdirSync(extraction, { recursive: true });
    execFileSync('tar', ['-C', extraction, '-xf', archive]);

    for (const relative of Object.keys(sources)) {
      assert.equal(existsSync(join(extraction, relative)), true, relative);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: packages each shard at the extraction root with pairwise-disjoint app payloads', () => {
  const root = fixture(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
  try {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.equal(workflow.includes('path: shard-transfer'), true);
    assert.equal(
      workflow.match(
        /Stage shard transfer artifact[\s\S]*?rm -rf shard-transfer[\s\S]*?cp -a shard-output\/artifacts/g,
      )?.length,
      3,
      'each shard must clear its reused transfer directory before staging a new payload',
    );
    assert.equal(
      workflow.match(/path: shard-report-transfer/g)?.length,
      3,
      'shard reports must have a dedicated lightweight transfer artifact',
    );
    assert.equal(
      workflow.includes('shard-output/artifacts/apps/*/dist/shaders/manifest.json'),
      false,
    );
    assert.equal(workflow.includes('shard-output/artifacts/apps/*/report'), false);
    for (const app of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      const manifest = join(root, 'apps', app, 'dist', 'shaders');
      mkdirSync(manifest, { recursive: true });
      writeFileSync(join(manifest, 'manifest.json'), app);
      mkdirSync(join(root, 'apps', app, 'report'), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'report', 'result.txt'), app);
    }

    const extractedInventories = [];
    for (const shardIndex of [0, 1, 2]) {
      const output = join(root, `shard-output-${shardIndex}`);
      const result = runPlanner(root, [
        '--shard-count',
        '3',
        '--shard-index',
        String(shardIndex),
        '--output-dir',
        output,
        '--dry-run',
      ]);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);

      const archive = join(root, `app-shard-${shardIndex}.tar`);
      const extraction = join(root, `download-${shardIndex}`);
      // Mirrors upload-artifact's archive root: the staged artifacts directory
      // itself is the payload, so consumers receive apps/ at their repo root.
      execFileSync('tar', ['-C', join(output, 'artifacts'), '-cf', archive, '.']);
      mkdirSync(extraction, { recursive: true });
      execFileSync('tar', ['-C', extraction, '-xf', archive]);

      const report = JSON.parse(result.stdout);
      for (const relative of report.artifactInventory) {
        assert.equal(existsSync(join(extraction, relative)), true, relative);
        assert.equal(existsSync(join(extraction, 'shard-output', 'artifacts', relative)), false);
      }
      extractedInventories.push(report.artifactInventory);
    }

    const allPaths = extractedInventories.flat();
    assert.equal(
      new Set(allPaths).size,
      allPaths.length,
      'shard payloads must be pairwise disjoint',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t14: merges snapshots, reports cold-path state, and skips an exact cache hit', () => {
  const root = fixture([]);
  const snapshots = join(root, 'snapshots');
  const output = join(root, 'ddc');
  try {
    for (const [index, value] of ['zero', 'one', 'two'].entries()) {
      const directory = join(snapshots, String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${value}.cache`), value);
    }
    const saved = runPlanner(root, [
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
      '--shard-count',
      '3',
    ]);
    assert.equal(saved.exitCode, 0, saved.stderr || saved.stdout);
    assert.deepEqual(JSON.parse(saved.stdout), {
      outcome: 'saved',
      availableSnapshots: 3,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(readFileSync(join(output, 'zero.cache'), 'utf8'), 'zero');
    assert.equal(readFileSync(join(output, 'one.cache'), 'utf8'), 'one');
    assert.equal(readFileSync(join(output, 'two.cache'), 'utf8'), 'two');

    const partialSnapshots = join(root, 'partial-snapshots');
    mkdirSync(join(partialSnapshots, '0'), { recursive: true });
    writeFileSync(join(partialSnapshots, '0', 'partial.cache'), 'partial');
    const partial = runPlanner(root, [
      '--merge-ddc',
      '--snapshots-dir',
      partialSnapshots,
      '--ddc-output-dir',
      output,
      '--shard-count',
      '3',
    ]);
    assert.equal(partial.exitCode, 0, partial.stderr || partial.stdout);
    assert.deepEqual(JSON.parse(partial.stdout), {
      outcome: 'partial',
      availableSnapshots: 1,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(readFileSync(join(output, 'partial.cache'), 'utf8'), 'partial');

    const hit = runPlanner(root, ['--merge-ddc', '--cache-hit', '--ddc-output-dir', output]);
    assert.equal(hit.exitCode, 0, hit.stderr || hit.stdout);
    assert.deepEqual(JSON.parse(hit.stdout), {
      outcome: 'skipped',
      availableSnapshots: 0,
      shardCount: 3,
      nextRunWouldHit: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('App and Bevy build owners form a disjoint complete source roster', async () => {
  const { appPackages } = await import('../../build-task-cache.mjs');
  const { bevySmokeApps } = await import('../../bevy-demo.mjs');
  const { appShardRoster } = await import('../app-build-roster.mjs');
  const { relative, resolve } = await import('node:path');
  const appRoot = resolve(repoRoot, 'apps');
  const expected = appPackages(repoRoot)
    .map((app) => relative(appRoot, app.directory).replaceAll('\\', '/'))
    .sort();
  const shards = appShardRoster(repoRoot);
  const bevy = bevySmokeApps(repoRoot).map((app) =>
    relative(appRoot, app.dir).replaceAll('\\', '/'),
  );
  assert.ok(bevy.length > 0);
  assert.deepEqual(
    shards.filter((app) => bevy.includes(app)),
    [],
  );
  assert.deepEqual([...shards, ...bevy].sort(), expected);
  for (const app of appPackages(repoRoot).filter(
    (app) => app.manifest.forgeax?.bevyExample?.status === 'partial',
  )) {
    assert.ok(shards.includes(relative(appRoot, app.directory).replaceAll('\\', '/')));
  }
});

test('shared material transport retains the declared artifact closure and rejects malformed or escaping bodies', () => {
  for (const scenario of ['valid', 'invalid-reference', 'escaping-body', 'missing-guid']) {
    const root = fixture([]);
    writePackFixture(root);
    const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
    const path = join(root, 'apps/pbr/dist/assets', `${guid}.pack-fixture.json`);
    const pack = JSON.parse(readFileSync(path, 'utf8'));
    pack.assets[0].kind = 'material';
    pack.assets[0].payload = { schemaVersion: 'material-cook/4', programs: [0, 0] };
    if (scenario === 'invalid-reference') pack.assets[0].payload.programs[0] = 1;
    if (scenario === 'escaping-body') pack.assets[0].artifacts.body.path = '../escape.bin';
    if (scenario === 'missing-guid') pack.assets[0].guid = 'not-the-roster-guid';
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 'pack-material-programs/1', pack, programs: [{}] }),
    );
    try {
      const result = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
      if (scenario === 'valid') {
        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        assert(
          JSON.parse(result.stdout).artifactInventory.includes(
            `apps/pbr/dist/assets/${guid}-body.bin`,
          ),
        );
      } else {
        assert.notEqual(result.exitCode, 0);
        assert.equal(
          JSON.parse(result.stdout).code,
          {
            'invalid-reference': 'ci-app-shard-pack-package-invalid',
            'escaping-body': 'ci-app-shard-pack-unsafe-path',
            'missing-guid': 'ci-app-shard-pack-guid-missing',
          }[scenario],
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
