import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DAWN_TEST_PARTITIONS,
  LIGHTWEIGHT_DAWN_TEST_PARTITIONS,
  runDawnPartitions,
  selectDawnTestPartitions,
  selectTransmissionSmokeOwner,
  validateDawnPartitionReport,
} from '../run-dawn-partitions.mjs';

function reportFor(partitions, selected) {
  return {
    success: true,
    testResults: [
      {
        assertionResults: partitions.flatMap((partition) =>
          Array.from({ length: partition.count }, (_, index) => ({
            fullName: `${partition.pattern} case ${index}`,
            status: partition === selected ? 'passed' : 'skipped',
          })),
        ),
      },
    ],
  };
}

for (const kind of ['feature-depth', 'vfx-depth']) {
  const partitions = DAWN_TEST_PARTITIONS[kind];
  test(`${kind} partitions execute the complete assertion roster exactly once`, () => {
    const covered = new Set();
    let total = 0;
    for (const partition of partitions)
      total = validateDawnPartitionReport(
        reportFor(partitions, partition),
        partitions,
        partition,
        covered,
      );
    assert.equal(covered.size, total);
    assert.equal(total, kind === 'feature-depth' ? 19 : 26);
  });
}

for (const [kind, count] of [
  ['feature-depth', 7],
  ['vfx-depth', 11],
]) {
  test(`${kind} lightweight partitions retain the declared PR assertion roster`, () => {
    const partitions = selectDawnTestPartitions(kind, { FORGEAX_DAWN_LIGHTWEIGHT: '1' });
    assert.equal(partitions, LIGHTWEIGHT_DAWN_TEST_PARTITIONS[kind]);
    assert.equal(
      partitions.reduce((total, partition) => total + partition.count, 0),
      count,
    );
    assert.equal(selectDawnTestPartitions(kind, {}), DAWN_TEST_PARTITIONS[kind]);
  });
}

for (const [kind, file, count] of [
  ['shadow-fields', 'packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts', 12],
  [
    'transmission',
    'packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts',
    8,
  ],
])
  test(`${kind} real test titles are selected and passed exactly once`, () => {
    const source = readFileSync(file, 'utf8');
    const names = [...source.matchAll(/\bit\(\s*'([^']+)'/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'emits the canonical 60-frame Dawn roster receipt');
    assert.equal(names.length, count);
    const partitions = DAWN_TEST_PARTITIONS[kind];
    const covered = new Set();
    for (const partition of partitions) {
      const pattern = new RegExp(partition.pattern);
      const report = {
        success: true,
        testResults: [
          {
            assertionResults: names.map((fullName) => ({
              fullName,
              status: pattern.test(fullName) ? 'passed' : 'skipped',
            })),
          },
        ],
      };
      validateDawnPartitionReport(report, partitions, partition, covered);
    }
    assert.deepEqual([...covered].sort(), names.sort());
  });

test('standalone VFX depth tests belong to exactly one full and lightweight partition', () => {
  const source = readFileSync(
    'packages/runtime/src/__tests__/vfx-depth-material.dawn.test.ts',
    'utf8',
  );
  const names = [...source.matchAll(/\bit\(\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(names.length > 0, 'the real Player MeshFilter regression must be discovered');
  for (const partitions of [
    DAWN_TEST_PARTITIONS['vfx-depth'],
    LIGHTWEIGHT_DAWN_TEST_PARTITIONS['vfx-depth'],
  ])
    for (const name of names)
      assert.equal(
        partitions.filter((partition) => new RegExp(partition.pattern).test(name)).length,
        1,
        `standalone VFX depth test has no unique partition: ${name}`,
      );
});

test('an all-skipped filtered file cannot be a green partition', () => {
  const partitions = DAWN_TEST_PARTITIONS['feature-depth'];
  const report = reportFor(partitions, undefined);
  assert.throws(
    () => validateDawnPartitionReport(report, partitions, partitions[0], new Set()),
    /unexpected result/,
  );
});

test('unknown or misplaced Smoke owner rejects before native process startup', async () => {
  await assert.rejects(
    runDawnPartitions('transmission', {
      env: { FORGEAX_DAWN_ROSTER_SMOKE: '1' },
      smokeOwner: 'typo',
    }),
    /unknown transmission Smoke owner/,
  );
  await assert.rejects(
    runDawnPartitions('transmission', {
      env: {},
      smokeOwner: 'frames',
    }),
    /complete transmission declaration/,
  );
});

test('transmission Smoke owners conserve all nine real assertions and the direct five-process route', () => {
  const features = DAWN_TEST_PARTITIONS.transmission;
  const canonical = { pattern: 'emits the canonical 60-frame Dawn roster receipt', count: 1 };
  const roster = [...features, canonical];
  const source = readFileSync(
    'packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts',
    'utf8',
  );
  const names = [...source.matchAll(/\bit\(\s*'([^']+)'/g)].map((match) => match[1]);
  assert.equal(names.length, 9);
  assert.deepEqual(selectTransmissionSmokeOwner(features), roster);
  assert.equal(roster.length, 5);
  assert.deepEqual(selectTransmissionSmokeOwner(features, 'frames'), [canonical]);
  assert.equal(selectDawnTestPartitions('transmission', {}).length, 4);
  assert.throws(() => selectTransmissionSmokeOwner(features, 'typo'), /unknown/);
  const allCovered = new Set();
  for (const [owner, expected] of [
    ['features-a', 4],
    ['features-b', 4],
    ['frames', 1],
  ]) {
    const covered = new Set();
    for (const partition of selectTransmissionSmokeOwner(features, owner)) {
      const report = {
        success: true,
        testResults: [
          {
            assertionResults: names.map((fullName) => ({
              fullName,
              status: new RegExp(partition.pattern).test(fullName) ? 'passed' : 'skipped',
            })),
          },
        ],
      };
      validateDawnPartitionReport(report, roster, partition, covered);
      for (const mutate of [
        (rows) => rows.pop(),
        (rows) => rows.push(rows[0]),
        (rows) => {
          rows.find((row) => row.status === 'passed').status = 'failed';
        },
        (rows) => {
          rows.find((row) => row.status === 'skipped').status = 'passed';
        },
      ]) {
        const corrupted = structuredClone(report);
        mutate(corrupted.testResults[0].assertionResults);
        assert.throws(() => validateDawnPartitionReport(corrupted, roster, partition, new Set()));
      }
    }
    assert.equal(covered.size, expected);
    for (const name of covered) {
      assert.equal(allCovered.has(name), false, `duplicate owner: ${name}`);
      allCovered.add(name);
    }
  }
  assert.deepEqual([...allCovered].sort(), names.sort());
});

test('missing, duplicate, failed, or overlapping assertions fail closed', () => {
  const partitions = DAWN_TEST_PARTITIONS['feature-depth'];
  const partition = partitions[0];
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(rows[0]),
    (rows) => {
      rows[0].status = 'failed';
    },
    (rows) => {
      rows[0].fullName = 'unplanned test';
    },
  ]) {
    const report = reportFor(partitions, partition);
    mutate(report.testResults[0].assertionResults);
    assert.throws(() => validateDawnPartitionReport(report, partitions, partition, new Set()));
  }
  const covered = new Set();
  const report = reportFor(partitions, partition);
  validateDawnPartitionReport(report, partitions, partition, covered);
  assert.throws(
    () => validateDawnPartitionReport(report, partitions, partition, covered),
    /duplicate execution/,
  );
});
