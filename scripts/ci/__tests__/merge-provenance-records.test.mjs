import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'merge-provenance-records.mjs');
const contract = join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json');
function record(producer, classes, attempt = 1) {
  return {
    schemaVersion: 1,
    producer,
    runId: 'run-1',
    producerRunAttempt: attempt,
    artifacts: classes.map((className, index) => ({
      class: className,
      artifactName: `${className}-${producer}-a${attempt}`,
      artifactId: `${producer}-${attempt}-${index}`,
      producerRunAttempt: attempt,
      inputFingerprint: `sha256:${producer}-${className}-${attempt}`,
      upload: {
        startedAt: '2026-07-16T19:54:58Z',
        completedAt: '2026-07-16T19:55:00Z',
        elapsedSeconds: 2,
        transferAttempt: 1,
      },
    })),
    ...(producer === 'shared-app-inputs'
      ? {
          sharedInputs: {
            schemaVersion: 1,
            inputFingerprint: 'current',
            sourceFingerprint: 'current',
            inventory: [
              'shared-app-inputs/assets/catalog.json',
              'shared-app-inputs/shaders/manifest.json',
            ],
          },
          sharedProduction: {
            producer: 'shared-app-inputs',
            inputFingerprint: 'current',
            cacheState: 'cold',
            sourceScanCount: 1,
            payloadEmitCount: 2,
            engineCompileCount: 1,
            buildDurationSeconds: 1,
          },
        }
      : {}),
  };
}
function records() {
  return [
    record('core-build', ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec']),
    record('shared-app-inputs', ['shared-asset-pack', 'shared-engine-shaders']),
    record('app-shard-0', ['app-dist-0']),
    record('app-shard-1', ['app-dist-1']),
    record('app-shard-2', ['app-dist-2']),
  ];
}
function fixture(values) {
  const root = mkdtempSync(join(tmpdir(), 'provenance-'));
  for (const [index, value] of values.entries())
    writeFileSync(
      join(root, `provenance-${value.producer}-${index}-a${value.producerRunAttempt}.json`),
      JSON.stringify(value),
    );
  return root;
}
function rawFixture(entries) {
  const root = mkdtempSync(join(tmpdir(), 'provenance-raw-'));
  for (const [name, value] of entries)
    writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  return root;
}
function run(dir, contractPath = contract, aggregateAttempt = 2) {
  const out = join(dir, 'merged.json');
  const githubOutput = join(dir, 'github-output');
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        script,
        '--records-dir',
        dir,
        '--aggregate-attempt',
        String(aggregateAttempt),
        '--out',
        out,
        '--github-output',
        githubOutput,
        '--contract',
        contractPath,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { exitCode: 0, stdout: stdout.trim(), out, githubOutput };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout?.toString().trim() ?? '', out };
  }
}

function sharedContract(dir) {
  const value = JSON.parse(readFileSync(contract, 'utf8'));
  value.version = 2;
  value.artifactClasses['shared-asset-pack'] = {
    description: 'Shared LearnOpenGL input payload',
    fileClasses: ['shared-app-inputs/assets'],
  };
  value.artifactClasses['shared-engine-shaders'] = {
    description: 'Shared engine shader input payload',
    fileClasses: ['shared-app-inputs/shaders'],
  };
  value.provenance.producerRoster = [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ];
  value.provenance.payloadClasses.push('shared-asset-pack', 'shared-engine-shaders');
  const path = join(dir, 'shared-contract.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function sharedRecords() {
  return [
    record('core-build', ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec']),
    record('shared-app-inputs', ['shared-asset-pack', 'shared-engine-shaders']),
    record('app-shard-0', ['app-dist-0']),
    record('app-shard-1', ['app-dist-1']),
    record('app-shard-2', ['app-dist-2']),
  ];
}

test('t15b: merges immutable producer records with selected artifact IDs', () => {
  const values = records();
  for (const artifact of values[0].artifacts) artifact.artifactId = 'core-transfer';
  const dir = fixture(values);
  try {
    const result = run(dir);
    assert.equal(result.exitCode, 0, result.stdout);
    const merged = JSON.parse(readFileSync(result.out, 'utf8'));
    assert.equal(merged.aggregateAttempt, 2);
    assert.deepEqual(merged.producerAttempts, {
      'core-build': 1,
      'shared-app-inputs': 1,
      'app-shard-0': 1,
      'app-shard-1': 1,
      'app-shard-2': 1,
    });
    assert.equal(merged.artifacts.length, 9);
    const githubOutput = readFileSync(result.githubOutput, 'utf8');
    assert.match(githubOutput, /^artifact_ids=/m);
    assert.doesNotMatch(githubOutput, /^artifact_ids=.*shared-app-inputs-1-[01]/m);
    const artifactIds = githubOutput.match(/^artifact_ids=(.*)$/m)?.[1]?.split(',') ?? [];
    assert.equal(artifactIds.filter((artifactId) => artifactId === 'core-transfer').length, 1);
    const consumerIds = (name) =>
      githubOutput.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.split(',') ?? [];
    assert.ok(consumerIds('artifact_ids_primary_pnpm').includes('core-transfer'));
    assert.equal(consumerIds('artifact_ids_primary_pnpm').length, 1);
    assert.ok(!consumerIds('artifact_ids_smoke_fleet').includes('shared-app-inputs-1-1'));
    assert.ok(consumerIds('artifact_ids_smoke_fleet').includes('app-shard-2-1-0'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unknown producer identities and non-object JSON records before roster selection', () => {
  const scenarios = [
    {
      dir: () => fixture([...records(), record('unexpected-producer', [])]),
      code: 'ci-provenance-producer-unknown',
    },
    {
      dir: () => rawFixture([['provenance-invalid-a1.json', 'null']]),
      code: 'ci-provenance-record-invalid',
    },
  ];
  for (const { dir: makeDir, code } of scenarios) {
    const dir = makeDir();
    try {
      const result = run(dir);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).code, code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('repair: a failed-job retry selects only the retried producer newest immutable record', () => {
  const values = records();
  values.push(record('app-shard-1', ['app-dist-1'], 2));
  const dir = fixture(values);
  try {
    const result = run(dir);
    assert.equal(result.exitCode, 0, result.stdout);
    const merged = JSON.parse(readFileSync(result.out, 'utf8'));
    assert.equal(merged.producerAttempts['app-shard-1'], 2);
    assert.equal(merged.producerAttempts['core-build'], 1);
    const selected = merged.artifacts.find((artifact) => artifact.class === 'app-dist-1');
    assert.equal(selected.producerRunAttempt, 2);
    assert.equal(selected.artifactId, 'app-shard-1-2-0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2-T1: rejects cross-run, aggregate mismatch, foreign attempt, and missing fingerprint', () => {
  const scenarios = [
    {
      mutate(values) {
        values.find((value) => value.producer === 'app-shard-2').runId = 'run-2';
      },
      aggregateAttempt: 2,
      code: 'ci-provenance-cross-run',
    },
    {
      mutate(values) {
        values.push(record('app-shard-1', ['app-dist-1'], 2));
      },
      aggregateAttempt: 1,
      code: 'ci-provenance-aggregate-attempt-mismatch',
    },
    {
      mutate(values) {
        values.find((value) => value.producer === 'app-shard-1').artifacts[0].producerRunAttempt =
          9;
      },
      aggregateAttempt: 2,
      code: 'ci-provenance-foreign-producer-attempt',
    },
    {
      mutate(values) {
        delete values.find((value) => value.producer === 'core-build').artifacts[0]
          .inputFingerprint;
      },
      aggregateAttempt: 2,
      code: 'ci-provenance-fingerprint-missing',
    },
  ];

  for (const { mutate, aggregateAttempt, code } of scenarios) {
    const values = records();
    mutate(values);
    const dir = fixture(values);
    try {
      const result = run(dir, contract, aggregateAttempt);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).code, code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('t15b: fails for missing record, class conflict, and schema mismatch', () => {
  for (const mutate of [
    (values) =>
      values.splice(
        values.findIndex((value) => value.producer === 'app-shard-2'),
        1,
      ),
    (values) => {
      values.find((value) => value.producer === 'app-shard-1').artifacts = [
        {
          class: 'app-dist-0',
          artifactName: 'bad',
          artifactId: 'bad',
          uploadedAt: '2026-07-16T19:55:00Z',
        },
      ];
    },
    (values) => {
      values.find((value) => value.producer === 'app-shard-2').schemaVersion = 2;
    },
    (values) => {
      values.push(record('app-shard-0', ['app-dist-0'], 1));
    },
  ]) {
    const values = records();
    mutate(values);
    const dir = fixture(values);
    try {
      const result = run(dir);
      assert.notEqual(result.exitCode, 0);
      assert.match(JSON.parse(result.stdout).code, /^ci-provenance-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('w7: merged provenance selects the one shared producer and all shard payloads', () => {
  const dir = fixture(sharedRecords());
  try {
    const result = run(dir, sharedContract(dir));
    assert.equal(result.exitCode, 0, result.stdout);
    const merged = JSON.parse(readFileSync(result.out, 'utf8'));
    assert.equal(
      merged.artifacts.filter((artifact) => artifact.producer === 'shared-app-inputs').length,
      2,
    );
    assert.deepEqual(
      merged.artifacts
        .filter((artifact) => artifact.producer === 'shared-app-inputs')
        .map((artifact) => artifact.class)
        .sort(),
      ['shared-asset-pack', 'shared-engine-shaders'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('w7: shared producer rejects duplicate, missing, and uncovered payload records', () => {
  for (const mutate of [
    (values) =>
      values.push(record('shared-app-inputs', ['shared-asset-pack', 'shared-engine-shaders'])),
    (values) =>
      values.splice(
        values.findIndex((value) => value.producer === 'shared-app-inputs'),
        1,
      ),
    (values) => {
      values.find((value) => value.producer === 'shared-app-inputs').artifacts.pop();
    },
  ]) {
    const values = sharedRecords();
    mutate(values);
    const dir = fixture(values);
    try {
      const result = run(dir, sharedContract(dir));
      assert.notEqual(result.exitCode, 0);
      assert.match(JSON.parse(result.stdout).code, /^ci-provenance-(?:record|class)-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('w18: rejects missing, stale, incompatible, and duplicate shared provenance structurally', () => {
  const scenarios = [
    {
      mutate(values) {
        values.splice(
          values.findIndex((value) => value.producer === 'shared-app-inputs'),
          1,
        );
      },
      code: 'ci-provenance-record-missing',
    },
    {
      mutate(values) {
        values.find((value) => value.producer === 'shared-app-inputs').sharedInputs = {
          schemaVersion: 999,
          inputFingerprint: 'current',
          sourceFingerprint: 'current',
          inventory: [
            'shared-app-inputs/assets/catalog.json',
            'shared-app-inputs/shaders/manifest.json',
          ],
        };
      },
      code: 'ci-provenance-shared-schema-incompatible',
    },
    {
      mutate(values) {
        values.find((value) => value.producer === 'shared-app-inputs').sharedInputs = {
          schemaVersion: 1,
          inputFingerprint: 'stale',
          sourceFingerprint: 'current',
          inventory: [
            'shared-app-inputs/assets/catalog.json',
            'shared-app-inputs/shaders/manifest.json',
          ],
        };
      },
      code: 'ci-provenance-shared-input-fingerprint-stale',
    },
    {
      mutate(values) {
        values.find((value) => value.producer === 'shared-app-inputs').sharedInputs = {
          schemaVersion: 1,
          inputFingerprint: 'current',
          sourceFingerprint: 'current',
          inventory: ['shared-app-inputs/assets/catalog.json'],
        };
      },
      code: 'ci-provenance-shared-inventory-incompatible',
    },
    {
      mutate(values) {
        values.push(record('shared-app-inputs', ['shared-asset-pack', 'shared-engine-shaders']));
      },
      code: 'ci-provenance-record-duplicate',
    },
  ];
  for (const scenario of scenarios) {
    const values = sharedRecords();
    scenario.mutate(values);
    const dir = fixture(values);
    try {
      const result = run(dir, sharedContract(dir));
      assert.notEqual(result.exitCode, 0);
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.code, scenario.code);
      assert.ok('expected' in failure);
      assert.ok('detail' in failure);
      assert.ok('hint' in failure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

for (const missing of ['core-build', 'shared-app-inputs', 'app-shard-1']) {
  test(`unavailable ${missing} transfer preserves source proof without inventing upload evidence`, () => {
    const values = records();
    for (const artifact of values.find((value) => value.producer === missing).artifacts) {
      artifact.artifactId = '';
      artifact.upload = null;
    }
    const dir = fixture(values);
    try {
      const result = run(dir);
      assert.equal(result.exitCode, 0, result.stdout);
      const merged = JSON.parse(readFileSync(result.out, 'utf8'));
      assert.ok(
        merged.artifacts
          .filter((artifact) => artifact.producer === missing)
          .every((artifact) => artifact.artifactId === '' && artifact.upload === null),
      );
      if (missing === 'core-build')
        assert.match(readFileSync(result.githubOutput, 'utf8'), /^artifact_ids_primary_pnpm=$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
