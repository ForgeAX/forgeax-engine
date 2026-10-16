import {
  createAcceptedPublicationStore,
  scriptablePackOutputSetDigest,
  scriptablePackPublicationGeneration,
} from '@forgeax/engine-ddc';
import type { AssetPublicationEnvelope } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  preserveAcceptedPublicationGeneration,
  selectAuthoredPublicationGeneration,
} from '../dev/authored-pack-publication.js';

function publication(generation: number): AssetPublicationEnvelope {
  const outputs = [
    {
      guid: '01890000-0000-7000-8000-111111111111',
      sourceKey: 'scene/main',
      kind: 'scene',
      digest: `sha256:scene-${generation}`,
      refs: [] as const,
    },
    {
      guid: '01890000-0000-7000-8000-222222222222',
      sourceKey: 'mesh/main',
      kind: 'mesh',
      digest: `sha256:mesh-${generation}`,
      refs: [] as const,
    },
  ];
  const outputSetDigest = scriptablePackOutputSetDigest(outputs);
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: 'assets/showcase.pack.ts',
    sourceRevision: `source-${generation}`,
    generation,
    digest: `sha256:publication-${generation}`,
    outputSetDigest,
    outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: 'assets/showcase.pack.ts',
      sourceRevision: `source-${generation}`,
      inputFingerprint: `sha256:receipt-${generation}`,
      outputDigest: `sha256:publication-${generation}`,
      outputSetDigest,
      externalEvidence: [],
    },
    externalEvidence: [],
  };
}

describe('ScriptablePack publication integration', () => {
  it('derives the same publication generation from the accepted tuple', () => {
    const input = {
      sourceRevision: 'sha256:source',
      digest: 'sha256:package',
      outputSetDigest: 'sha256:outputs',
    };
    expect(scriptablePackPublicationGeneration(input)).toBe(
      scriptablePackPublicationGeneration({ ...input }),
    );
    expect(scriptablePackPublicationGeneration(input)).toBeGreaterThan(0);
  });

  it('reuses the accepted generation for an unchanged authored tuple', () => {
    const accepted = publication(1);
    const candidate: AssetPublicationEnvelope = {
      ...accepted,
      generation: 2,
      current: {
        generation: 2,
        digest: accepted.digest,
        outputSetDigest: accepted.outputSetDigest,
        packageUrl: '/__forgeax-ddc/scene.pack.json',
        receiptKey: accepted.receipt.inputFingerprint,
      },
    };

    const preserved = preserveAcceptedPublicationGeneration(candidate, { current: accepted });

    expect(preserved).toMatchObject({
      generation: 1,
      current: { generation: 1 },
    });
    expect(preserved.digest).toBe(candidate.digest);
    expect(preserved.outputSetDigest).toBe(candidate.outputSetDigest);
  });

  it('does not advance an unchanged bystander during a generation-neutral probe', () => {
    const accepted = publication(7);
    const probe: AssetPublicationEnvelope = {
      ...accepted,
      generation: 7,
    };

    expect(selectAuthoredPublicationGeneration(accepted, probe)).toBe(7);
    expect(
      selectAuthoredPublicationGeneration(accepted, { ...probe, sourceRevision: 'source-changed' }),
    ).toBe(8);
    expect(
      selectAuthoredPublicationGeneration(publication(1), {
        ...publication(1),
        generation: 1,
        digest: 'sha256:probe',
        receipt: { ...publication(1).receipt, outputDigest: 'sha256:probe' },
      }),
    ).toBe(2);
  });

  it('installs only one complete publication tuple and keeps the previous LKG on route failure', async () => {
    const store = createAcceptedPublicationStore();
    const first = publication(1);
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    expect((await store.commit(first.sourcePath, { envelope: first }, () => undefined)).ok).toBe(
      true,
    );
    const failedEnvelope = publication(2);
    expect(store.stage(failedEnvelope.sourcePath, { envelope: failedEnvelope }).ok).toBe(true);
    const failed = await store.commit(
      failedEnvelope.sourcePath,
      { envelope: failedEnvelope },
      () => {
        throw new Error('route unavailable');
      },
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'asset-publication-route-failed', recovery: { useLastKnownGood: true } },
    });
    expect(store.observe(first.sourcePath)).toMatchObject({ current: { generation: 1 } });
  });
});
