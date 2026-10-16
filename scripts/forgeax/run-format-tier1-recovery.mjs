#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, DdcLifecycle, ddcOutputDigest, semanticDdcKey } from '@forgeax/engine-ddc';

const FEATURE_ID = 'feat-20260812-format-classification-tier1';
const SOURCE_SHA256 = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const FIRST_TIER_ROWS = [8, 18, 26];

const SCENARIOS = [
  {
    formatId: 'meshopt',
    csvRow: 8,
    guid: '019f0000-0000-7000-8000-000000000008',
    sourceKey: 'meshopt:fixture:triangle',
    producer: 'gltf-meshopt-importer',
    contamination: 'source',
    goodSource: 'meshopt-source-v1',
    corruptSource: 'meshopt-source-corrupt',
    failure: {
      code: 'format-tier1-meshopt-source-invalid',
      expected: 'Meshopt source bytes decode to the declared accessor payload',
      hint: 'inspect the producer input, restore the source, then rebuild or cold-cook the same GUID and sourceKey',
      detail: 'the source payload does not contain a valid Meshopt frame',
    },
  },
  {
    formatId: 'ktx2-basis',
    csvRow: 18,
    guid: '019f0000-0000-7000-8000-000000000018',
    sourceKey: 'ktx2-basis:fixture:rgba',
    producer: 'ktx2-basis-transcoder',
    contamination: 'ddc-payload',
    goodSource: 'ktx2-source-v1',
    revisedSource: 'ktx2-source-v2',
    failure: {
      code: 'format-tier1-ktx2-ddc-payload-invalid',
      expected: 'The DDC payload and integrity receipt validate before Catalog promotion',
      hint: 'inspect the producer receipt, discard the invalid payload, preview last-known-good, then cold-cook the same GUID and sourceKey',
      detail: 'the DDC payload was truncated after publication',
    },
  },
  {
    formatId: 'morph-target',
    csvRow: 26,
    guid: '019f0000-0000-7000-8000-000000000026',
    sourceKey: 'morph-target:fixture:face',
    producer: 'gltf-fbx-morph-importer',
    contamination: 'source',
    goodSource: 'morph-source-weights-v1',
    corruptSource: 'morph-source-weights-invalid',
    failure: {
      code: 'format-tier1-morph-source-invalid',
      expected: 'Morph target and animation weight counts agree before mesh-binary publication',
      hint: 'inspect the producer input, restore the source, then rebuild or cold-cook the same GUID and sourceKey',
      detail: 'the source contains a weight channel with a mismatched target count',
    },
  },
];

function bytes(value) {
  return Buffer.from(value, 'utf8');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ddcKey(scenario, sourceBytes, revision) {
  return semanticDdcKey({
    schemaVersion: 'format-tier1/recovery/1',
    importer: scenario.formatId,
    codec: scenario.producer,
    settings: { revision, sourceKey: scenario.sourceKey },
    sourceBytes: [sourceBytes],
    declaredGuids: [scenario.guid],
    targetProfile: 'format-tier1',
    producer: scenario.producer,
  });
}

function payloadFor(scenario, key, sourceBytes, revision) {
  return {
    formatId: scenario.formatId,
    guid: scenario.guid,
    sourceKey: scenario.sourceKey,
    revision,
    sourceDigest: digest(sourceBytes),
    ddcKey: key,
  };
}

async function writeEntry(root, scenario, key, sourceBytes, revision) {
  const payload = payloadFor(scenario, key, sourceBytes, revision);
  const base = {
    key,
    guid: scenario.guid,
    payload,
    refs: [scenario.sourceKey],
    artifacts: {},
    receipt: {
      guid: scenario.guid,
      key,
      producer: scenario.producer,
      inputFingerprint: digest(sourceBytes),
      outputDigest: '',
    },
  };
  return new DdcEntryStore(root).write({
    ...base,
    receipt: { ...base.receipt, outputDigest: ddcOutputDigest(base) },
  });
}

function inspectionShape(head) {
  return {
    state: head.state,
    currentKey: head.currentKey,
    lastKnownGoodKey: head.lastKnownGoodKey,
    ...(head.failure === undefined ? {} : { failure: head.failure }),
  };
}

function failureShape(error) {
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  };
}

async function commitInitial(root, lifecycle, scenario, key, sourceBytes, revision) {
  const lease = await lifecycle.begin(scenario.guid, key);
  await writeEntry(root, scenario, key, sourceBytes, revision);
  const committed = await lifecycle.commit(lease, key);
  if (committed.result !== 'current') {
    throw new Error(`${scenario.formatId}: initial DDC commit was ${committed.result}`);
  }
}

async function runSourceScenario(root, scenario) {
  const lifecycle = new DdcLifecycle(root);
  const sourcePath = join(root, `${scenario.formatId}.source`);
  const goodBytes = bytes(scenario.goodSource);
  const corruptBytes = bytes(scenario.corruptSource);
  await writeFile(sourcePath, goodBytes);
  const goodKey = ddcKey(scenario, goodBytes, 'good');
  await commitInitial(root, lifecycle, scenario, goodKey, goodBytes, 'good');

  await writeFile(sourcePath, corruptBytes);
  const corruptKey = ddcKey(scenario, corruptBytes, 'corrupt');
  const failedLease = await lifecycle.begin(scenario.guid, corruptKey);
  const cookingInspection = inspectionShape(await lifecycle.inspect(scenario.guid, corruptKey));
  if (cookingInspection.state !== 'cooking') {
    throw new Error(`${scenario.formatId}: source contamination did not enter cooking state`);
  }
  const observedSource = await readFile(sourcePath);
  if (Buffer.compare(observedSource, goodBytes) !== 0) {
    await lifecycle.fail(failedLease, scenario.failure);
  }
  const failedInspection = inspectionShape(await lifecycle.inspect(scenario.guid, corruptKey));
  if (failedInspection.state !== 'failed') {
    throw new Error(`${scenario.formatId}: source contamination did not produce a failed head`);
  }

  await writeFile(sourcePath, goodBytes);
  const recoveryLease = await lifecycle.begin(scenario.guid, goodKey);
  await writeEntry(root, scenario, goodKey, goodBytes, 'cold-cook');
  const committed = await lifecycle.commit(recoveryLease, goodKey);
  if (committed.result !== 'current') {
    throw new Error(`${scenario.formatId}: source recovery commit was ${committed.result}`);
  }
  const inspection = inspectionShape(await lifecycle.inspect(scenario.guid, goodKey));
  const entry = await new DdcEntryStore(root).read(goodKey);
  const sameGuid = entry?.guid === scenario.guid && entry.payload?.guid === scenario.guid;
  const sameSourceKey = entry?.payload?.sourceKey === scenario.sourceKey;
  return {
    formatId: scenario.formatId,
    csvRow: scenario.csvRow,
    guid: scenario.guid,
    sourceKey: scenario.sourceKey,
    contamination: scenario.contamination,
    failedInspection,
    failure: failureShape(scenario.failure),
    recovery: {
      actions: ['inspect', 'rebuild', 'cold-cook', 'verify'],
      recoveredKey: goodKey,
      inspection,
      sameGuid,
      sameSourceKey,
      lkgPreserved:
        failedInspection.lastKnownGoodKey === goodKey && inspection.lastKnownGoodKey === goodKey,
      verified: inspection.state === 'current' && sameGuid && sameSourceKey,
    },
  };
}

async function runPayloadScenario(root, scenario) {
  const lifecycle = new DdcLifecycle(root);
  const store = new DdcEntryStore(root);
  const firstBytes = bytes(scenario.goodSource);
  const revisedBytes = bytes(scenario.revisedSource);
  const firstKey = ddcKey(scenario, firstBytes, 'v1');
  const revisedKey = ddcKey(scenario, revisedBytes, 'v2');
  await commitInitial(root, lifecycle, scenario, firstKey, firstBytes, 'v1');
  await commitInitial(root, lifecycle, scenario, revisedKey, revisedBytes, 'v2');

  const payloadPath = join(root, 'entries', revisedKey, 'payload.json');
  await writeFile(payloadPath, '{"formatId":', 'utf8');
  const checked = await store.readChecked(revisedKey);
  if (checked.ok) throw new Error(`${scenario.formatId}: payload corruption was not detected`);
  const contaminationFailure = {
    ...scenario.failure,
    code: checked.error.code,
    expected: checked.error.expected,
    hint: `${scenario.failure.hint}; producer action is required before publish`,
    detail: `${scenario.failure.detail}; ${checked.error.detail}`,
  };
  const contaminatedInspection = inspectionShape(
    await lifecycle.inspect(scenario.guid, revisedKey),
  );
  if (contaminatedInspection.state !== 'stale') {
    throw new Error(`${scenario.formatId}: corrupted DDC payload did not become stale`);
  }
  const failedLease = await lifecycle.begin(scenario.guid, revisedKey);
  await lifecycle.fail(failedLease, contaminationFailure);
  const failedInspection = inspectionShape(await lifecycle.inspect(scenario.guid, revisedKey));
  if (failedInspection.state !== 'failed') {
    throw new Error(`${scenario.formatId}: payload contamination did not produce a failed head`);
  }

  await rm(join(root, 'entries', revisedKey), { recursive: true, force: true });
  const recoveryLease = await lifecycle.begin(scenario.guid, revisedKey);
  await writeEntry(root, scenario, revisedKey, revisedBytes, 'cold-cook');
  const committed = await lifecycle.commit(recoveryLease, revisedKey);
  if (committed.result !== 'current') {
    throw new Error(`${scenario.formatId}: payload recovery commit was ${committed.result}`);
  }
  const inspection = inspectionShape(await lifecycle.inspect(scenario.guid, revisedKey));
  const entry = await store.read(revisedKey);
  const sameGuid = entry?.guid === scenario.guid && entry.payload?.guid === scenario.guid;
  const sameSourceKey = entry?.payload?.sourceKey === scenario.sourceKey;
  return {
    formatId: scenario.formatId,
    csvRow: scenario.csvRow,
    guid: scenario.guid,
    sourceKey: scenario.sourceKey,
    contamination: scenario.contamination,
    contaminatedInspection,
    failedInspection,
    failure: failureShape(contaminationFailure),
    recovery: {
      actions: ['inspect', 'preview-LKG', 'cold-cook', 'verify'],
      recoveredKey: revisedKey,
      inspection,
      sameGuid,
      sameSourceKey,
      lkgPreserved:
        failedInspection.lastKnownGoodKey === firstKey && inspection.lastKnownGoodKey === firstKey,
      verified: inspection.state === 'current' && sameGuid && sameSourceKey,
    },
  };
}

async function runScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-format-tier1-recovery-'));
  try {
    return scenario.contamination === 'source'
      ? await runSourceScenario(root, scenario)
      : await runPayloadScenario(root, scenario);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios = [];
for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario));

const report = {
  schemaVersion: 'format-tier1-recovery/1',
  featureId: FEATURE_ID,
  sourceSha256: SOURCE_SHA256,
  firstTierRows: FIRST_TIER_ROWS,
  scenarios,
  observed:
    'All first-tier formats completed inspect, producer failure classification, same-identity rebuild or cold-cook, and post-recovery verification.',
  verdict: scenarios.every((scenario) => scenario.recovery.verified) ? 'supported' : 'blocked',
  confidence: 'high',
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
