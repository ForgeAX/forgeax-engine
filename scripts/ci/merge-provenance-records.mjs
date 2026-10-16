#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function fail(code, detail = {}) {
  process.stdout.write(
    `${JSON.stringify({
      code,
      expected: detail.expected ?? 'compatible declared provenance',
      detail: detail.detail ?? detail,
      hint: detail.hint ?? 'Rebuild the producer artifact, then rerun provenance merge.',
      ...detail,
    })}\n`,
  );
  process.exit(1);
}

const recordsDir = resolve(argument('--records-dir') ?? 'provenance-records');
const output = resolve(argument('--out') ?? 'ci-provenance-merged.json');
const githubOutput = argument('--github-output');
const aggregateAttempt = Number(argument('--aggregate-attempt'));
const contractPath = resolve(
  argument('--contract') ?? join('scripts', 'ci', 'build-artifact-contract.json'),
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const producers = contract.provenance.producerRoster;
const sharedInputs =
  contract.sharedInputs ??
  (contract.provenance.payloadClasses.includes('shared-asset-pack')
    ? {
        producer: 'shared-app-inputs',
        payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
      }
    : null);

if (!Number.isInteger(aggregateAttempt) || aggregateAttempt < 1)
  fail('ci-provenance-aggregate-attempt-mismatch', {
    expected: 'a positive aggregate attempt',
    detail: { observedAggregateAttempt: aggregateAttempt },
  });

if (!existsSync(recordsDir)) fail('ci-provenance-records-dir-missing', { recordsDir });
const candidates = [];
for (const name of readdirSync(recordsDir)) {
  if (!/^provenance-[^-]+(?:-[^-]+)*-a\d+\.json$/.test(name)) continue;
  const path = join(recordsDir, name);
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('ci-provenance-record-invalid', { path });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record))
    fail('ci-provenance-record-invalid', { path });
  if (!producers.includes(record.producer))
    fail('ci-provenance-producer-unknown', {
      path,
      producer: record.producer ?? null,
      expected: producers,
    });
  candidates.push({ path, record });
}

const selected = new Map();
let runId = null;
let schemaVersion = null;
for (const { path, record } of candidates) {
  if (
    !Number.isInteger(record.producerRunAttempt) ||
    record.producerRunAttempt < 1 ||
    typeof record.runId !== 'string' ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.some(
      (artifact) =>
        typeof artifact?.class !== 'string' ||
        typeof artifact?.artifactName !== 'string' ||
        typeof artifact?.artifactId !== 'string' ||
        typeof artifact?.producerRunAttempt !== 'number' ||
        (artifact.artifactId === ''
          ? artifact.upload !== null
          : typeof artifact?.upload?.startedAt !== 'string' ||
            typeof artifact?.upload?.completedAt !== 'string' ||
            !Number.isFinite(artifact?.upload?.elapsedSeconds) ||
            artifact.upload.elapsedSeconds < 0 ||
            !Number.isInteger(artifact?.upload?.transferAttempt) ||
            artifact.upload.transferAttempt < 1 ||
            artifact.upload.transferAttempt > 3),
    )
  )
    fail('ci-provenance-record-invalid', { path, producer: record?.producer });
  if (runId === null) {
    runId = record.runId;
    schemaVersion = record.schemaVersion;
  }
  if (record.runId !== runId)
    fail('ci-provenance-cross-run', {
      expected: { runId },
      detail: { observedRunId: record.runId, producer: record.producer },
    });
  if (record.schemaVersion !== schemaVersion)
    fail('ci-provenance-schema-mismatch', { path, producer: record.producer });
  if (record.producerRunAttempt > aggregateAttempt)
    fail('ci-provenance-aggregate-attempt-mismatch', {
      expected: { aggregateAttempt, producerRunAttemptAtMost: aggregateAttempt },
      detail: {
        producer: record.producer,
        observedProducerAttempt: record.producerRunAttempt,
      },
    });
  for (const artifact of record.artifacts) {
    if (artifact.producerRunAttempt !== record.producerRunAttempt)
      fail('ci-provenance-foreign-producer-attempt', {
        expected: { producer: record.producer, producerRunAttempt: record.producerRunAttempt },
        detail: { class: artifact.class, observedProducerAttempt: artifact.producerRunAttempt },
      });
    if (typeof artifact.inputFingerprint !== 'string' || artifact.inputFingerprint.length === 0)
      fail('ci-provenance-fingerprint-missing', {
        expected: 'a producer-owned per-family input fingerprint',
        detail: { producer: record.producer, class: artifact.class },
      });
  }
  const prior = selected.get(record.producer);
  if (prior && prior.record.producerRunAttempt === record.producerRunAttempt)
    fail('ci-provenance-record-duplicate', {
      producer: record.producer,
      attempt: record.producerRunAttempt,
    });
  if (!prior || record.producerRunAttempt > prior.record.producerRunAttempt)
    selected.set(record.producer, { path, record });
}

for (const producer of producers)
  if (!selected.has(producer)) fail('ci-provenance-record-missing', { producer });

const shardClasses = new Set(
  contract.shardFamilies?.flatMap((family) => family.members ?? []) ?? [],
);
const shardInputClasses = new Set(sharedInputs?.payloadClasses ?? []);
const expectedByProducer = new Map(
  producers.map((producer) => [
    producer,
    contract.provenance.payloadClasses.filter((className) => {
      if (sharedInputs?.payloadClasses.includes(className)) {
        return producer === sharedInputs.producer;
      }
      if (!shardClasses.has(className)) return producer === 'core-build';
      return contract.shardFamilies?.some(
        (family) => family.producerMapping?.[className] === producer,
      );
    }),
  ]),
);
const mapped = new Map();
for (const producer of producers) {
  const { record } = selected.get(producer);
  const expected = expectedByProducer.get(producer) ?? [];
  const actual = new Set(record.artifacts.map((artifact) => artifact.class));
  if (
    actual.size !== record.artifacts.length ||
    expected.some((className) => !actual.has(className))
  )
    fail('ci-provenance-class-uncovered', { producer, expected, actual: [...actual] });
  if (producer === sharedInputs?.producer) {
    const metadata = record.sharedInputs;
    const requiredInventory = contract.sharedInputs.inventory;
    if (!metadata || typeof metadata !== 'object')
      fail('ci-provenance-shared-record-missing', {
        producer,
        expected: 'shared provenance metadata',
        hint: 'Rebuild shared-app-inputs so its provenance record includes schema, fingerprint, and inventory.',
      });
    if (metadata.schemaVersion !== contract.sharedInputs.schemaVersion)
      fail('ci-provenance-shared-schema-incompatible', {
        producer,
        expected: contract.sharedInputs.schemaVersion,
        detail: metadata.schemaVersion,
      });
    if (
      typeof metadata.inputFingerprint !== 'string' ||
      metadata.inputFingerprint.length === 0 ||
      metadata.inputFingerprint !== metadata.sourceFingerprint
    )
      fail('ci-provenance-shared-input-fingerprint-stale', {
        producer,
        expected: 'inputFingerprint equal to sourceFingerprint',
        detail: metadata,
      });
    if (
      !Array.isArray(metadata.inventory) ||
      requiredInventory.some((path) => !metadata.inventory.includes(path))
    )
      fail('ci-provenance-shared-inventory-incompatible', {
        producer,
        expected: requiredInventory,
        detail: metadata.inventory,
      });
    const production = record.sharedProduction;
    if (
      !production ||
      production.producer !== producer ||
      production.inputFingerprint !== metadata.inputFingerprint ||
      !['cold', 'warm'].includes(production.cacheState) ||
      ['sourceScanCount', 'payloadEmitCount', 'engineCompileCount', 'buildDurationSeconds'].some(
        (field) => !Number.isFinite(production[field]) || production[field] < 0,
      )
    )
      fail('ci-provenance-shared-production-invalid', {
        producer,
        expected: 'measured shared producer facts linked to the provenance fingerprint',
        detail: production,
      });
  }
  for (const artifact of record.artifacts) {
    if (!contract.provenance.payloadClasses.includes(artifact.class))
      fail('ci-provenance-undeclared-class', { producer, class: artifact.class });
    if (mapped.has(artifact.class))
      fail('ci-provenance-class-conflict', {
        class: artifact.class,
        producers: [mapped.get(artifact.class).producer, producer],
      });
    mapped.set(artifact.class, { ...artifact, producer });
  }
}
for (const className of contract.provenance.payloadClasses)
  if (!mapped.has(className)) fail('ci-provenance-class-uncovered', { class: className });

const artifacts = [...mapped.values()].sort((a, b) => a.class.localeCompare(b.class));
const coreArtifactIds = artifacts
  .filter((artifact) => !shardClasses.has(artifact.class) && !shardInputClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const appArtifactIds = artifacts
  .filter((artifact) => shardClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const consumerArtifactIds = artifacts
  .filter((artifact) => !shardInputClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const consumerOutputLines = Object.entries(contract.consumers ?? {}).map(
  ([consumer, definition]) => {
    const classes = definition.requiredArtifactClasses ?? [];
    const ids = classes
      .filter((className) => !shardInputClasses.has(className))
      .map((className) => {
        const artifact = mapped.get(className);
        if (!artifact) fail('ci-provenance-consumer-class-unmapped', { consumer, className });
        return artifact.artifactId;
      });
    const outputName = `artifact_ids_${consumer.replaceAll('-', '_')}`;
    return `${outputName}=${ids.includes('') ? '' : [...new Set(ids)].join(',')}`;
  },
);
const merged = {
  schemaVersion,
  runId,
  aggregateAttempt,
  producerAttempts: Object.fromEntries(
    producers.map((producer) => [producer, selected.get(producer).record.producerRunAttempt]),
  ),
  mergedAt: new Date().toISOString(),
  artifacts,
  sharedInputs: selected.get(sharedInputs?.producer)?.record.sharedInputs,
  sharedProduction: selected.get(sharedInputs?.producer)?.record.sharedProduction,
};
writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
if (githubOutput) {
  writeFileSync(
    resolve(githubOutput),
    `${[
      `artifact_ids=${[...new Set(consumerArtifactIds)].join(',')}`,
      `core_artifact_ids=${[...new Set(coreArtifactIds)].join(',')}`,
      `app_artifact_ids=${[...new Set(appArtifactIds)].join(',')}`,
      ...consumerOutputLines,
    ].join('\n')}\n`,
    { flag: 'a' },
  );
}
process.stdout.write(`${JSON.stringify(merged)}\n`);
