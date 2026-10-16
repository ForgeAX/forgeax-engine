import {
  createRuntimeAssetEvidenceAdapter,
  type RuntimeEvidenceSource,
} from '@forgeax/engine/assets-runtime';
import { defineFeature } from '../../lab/feature';

const GUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01';
const OTHER = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02';
const DIGEST = 'sha256:aa';
const receipt = {
  guid: GUID,
  origin: 'sourceMeta',
  status: 'succeeded',
  inputFingerprint: 'fp-1',
  outputDigest: DIGEST,
} as const;
const artifact = { path: 'lab/body.bin', mediaType: 'application/octet-stream', byteLength: 4 };

type Inputs = Exclude<Awaited<ReturnType<RuntimeEvidenceSource['evidence']>>, { ok: boolean }>;

async function inspect(inputs: Inputs) {
  return createRuntimeAssetEvidenceAdapter({ evidence: async () => inputs }).inspect(GUID);
}

export default defineFeature({
  title: 'AssetEvidence',
  catalog: 'AssetEvidence',
  kind: 'headless',
  summary:
    'Runtime evidence adapter joins source, receipt, package, artifact, and runtime facts; unknown is never passed.',
  expect:
    'Missing facts stay unknown/notChecked, stale receipts are stale, conflicts return structured asset-evidence-* codes.',
  async run(checks) {
    const missing = await createRuntimeAssetEvidenceAdapter().inspect(GUID);
    checks.equal(
      'no source returns capability-missing',
      missing.ok ? 'ok' : missing.error.code,
      'asset-evidence-capability-missing',
    );

    const bare = await inspect({ guid: GUID });
    checks.equal(
      'guid alone stays unknown, not passed',
      bare.ok
        ? [bare.value.cook.status, bare.value.cook.freshness, bare.value.runtime.status]
        : bare.error.code,
      ['unknown', 'unknown', 'unknown'],
    );

    const current = await inspect({
      guid: GUID,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
      receipt,
      package: {
        guid: GUID,
        digest: DIGEST,
        artifacts: { body: { descriptor: artifact, verification: 'passed' } },
      },
      runtime: { status: 'ready' },
    });
    checks.equal(
      'full facts join into ready/current/passed',
      current.ok
        ? [
            current.value.cook.status,
            current.value.cook.freshness,
            current.value.package?.status,
            current.value.artifacts.body?.verification,
            current.value.runtime.status,
          ]
        : current.error.code,
      ['ready', 'current', 'passed', 'passed', 'ready'],
    );

    const stale = await inspect({
      guid: GUID,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-2' },
      receipt,
    });
    checks.equal(
      'changed input fingerprint is stale',
      stale.ok ? stale.value.cook.freshness : stale.error.code,
      'stale',
    );

    const unchecked = await inspect({ guid: GUID, artifacts: { body: artifact } });
    checks.equal(
      'artifact without verifier stays notChecked',
      unchecked.ok ? unchecked.value.artifacts.body?.verification : unchecked.error.code,
      'notChecked',
    );

    const authored = await inspect({ guid: GUID, source: { origin: 'authoredPack' } });
    checks.equal(
      'authored Pack needs no cook',
      authored.ok
        ? [authored.value.cook.status, authored.value.cook.freshness]
        : authored.error.code,
      ['notRequired', 'notApplicable'],
    );

    const mismatch = await inspect({
      guid: GUID,
      receipt,
      packageVerification: { status: 'passed', digest: 'sha256:bb' },
    });
    checks.equal(
      'receipt vs package digest mismatch',
      mismatch.ok ? 'ok' : mismatch.error.code,
      'asset-evidence-digest-mismatch',
    );

    const foreign = await inspect({ guid: GUID, receipt: { ...receipt, guid: OTHER } });
    checks.equal(
      'receipt for another GUID conflicts',
      foreign.ok ? 'ok' : foreign.error.code,
      'asset-evidence-receipt-conflict',
    );

    const locators = await inspect({
      guid: GUID,
      locators: [{ packageUrl: '/a.pack.json' }, { packageUrl: '/b.pack.json' }],
    });
    checks.equal(
      'two package URLs conflict',
      locators.ok ? 'ok' : locators.error.code,
      'asset-evidence-locator-conflict',
    );
  },
});
