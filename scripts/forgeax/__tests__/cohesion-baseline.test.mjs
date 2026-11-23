import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  collectM0CohesionSnapshot,
  compareM0CohesionSnapshots,
} from '../check-format-tier1-scope.mjs';

const root = resolve(import.meta.dirname, '../../..');
const runner = resolve(root, 'scripts/forgeax/check-format-tier1-scope.mjs');

const before = {
  schemaVersion: 1,
  metrics: {
    devkitRootExports: 38,
    packInventoryExportModules: 2,
    sceneInstanceLines: 1564,
    typesIndexLines: 4856,
  },
};

test('M0 cohesion snapshot measures the current owners', () => {
  const after = collectM0CohesionSnapshot(root);
  const comparison = compareM0CohesionSnapshots(before, after);
  for (const [key, change] of Object.entries(comparison.changes)) {
    assert.equal(change.delta, after.metrics[key] - before.metrics[key]);
  }
  assert.equal(
    comparison.status,
    Object.values(comparison.changes).every(({ delta }) => delta < 0) ? 'pass' : 'blocked',
  );
});

test('M0 runner emits reproducible before and after JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-m0-cohesion-'));
  try {
    for (const path of Object.values(collectM0CohesionSnapshot(root).files)) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '');
    }
    const beforePath = join(directory, 'before.json');
    writeFileSync(beforePath, `${JSON.stringify(before)}\n`);
    const output = execFileSync(process.execPath, [runner, '--cohesion', '--before', beforePath], {
      cwd: directory,
      encoding: 'utf8',
    });
    const report = JSON.parse(output);
    assert.deepEqual(report.before, before);
    assert.equal(report.after.schemaVersion, 1);
    assert.equal(report.comparison.status, 'pass');
    assert.deepEqual(report.gates, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('M0 owner barrels preserve the touched public symbols', () => {
  const sources = [
    ['packages/types/src/core-contracts.ts', ['AssetRef', 'AssetEnvelope']],
    ['packages/devkit/src/index.ts', ['readProjectFacts', 'createInitPlan']],
    ['packages/pack/src/index.ts', ['validateProducerContract', 'validateProducerOutputs']],
    ['packages/pack/src/scanner.ts', ['scanInventory']],
    ['packages/scene/src/instances/scene-instances.ts', ['SceneInstanceState']],
  ];
  for (const [path, symbols] of sources) {
    const source = readFileSync(resolve(root, path), 'utf8');
    for (const symbol of symbols) assert.ok(source.includes(symbol), `${path} lost ${symbol}`);
  }
  const packManifest = JSON.parse(
    readFileSync(resolve(root, 'packages/pack/package.json'), 'utf8'),
  );
  assert.ok(
    packManifest.exports['./scanner'],
    'Pack scanner must remain available as a focused subpath',
  );
});

test('M0 runner wires the required structural gates', () => {
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /--run-gates/);
  assert.match(source, /test:layout/);
  assert.match(source, /lint:internal/);
});
