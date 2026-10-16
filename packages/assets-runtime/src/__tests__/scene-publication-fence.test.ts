import type { AssetPublicationEnvelope } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  compareScenePublicationFences,
  createScenePublicationFence,
  observeScenePublication,
  parseScenePublicationFence,
  type ScenePublicationFence,
  scenePublicationFenceFromCatalog,
} from '../registry/scene-publication-fence.js';

function publication(generation: number): AssetPublicationEnvelope {
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: 'assets/showcase.pack.ts',
    sourceRevision: `source-${generation}`,
    generation,
    digest: `sha256:publication-${generation}`,
    outputSetDigest: `sha256:outputs-${generation}`,
    outputs: [
      {
        guid: '01890000-0000-7000-8000-111111111111',
        sourceKey: 'scene/main',
        kind: 'scene',
        digest: `sha256:scene-${generation}`,
        refs: [],
      },
    ],
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: 'assets/showcase.pack.ts',
      sourceRevision: `source-${generation}`,
      inputFingerprint: `sha256:receipt-${generation}`,
      outputDigest: `sha256:publication-${generation}`,
      outputSetDigest: `sha256:outputs-${generation}`,
      externalEvidence: [],
    },
    externalEvidence: [],
  };
}

describe('Scene publication fence', () => {
  it('serializes one complete source publication tuple', () => {
    const created = createScenePublicationFence(publication(4));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parsed = parseScenePublicationFence(JSON.parse(JSON.stringify(created.value)));
    expect(parsed).toEqual(created);
    expect(created.value).toMatchObject<ScenePublicationFence>({
      schemaVersion: 'scene-publication-fence/1',
      sourcePath: 'assets/showcase.pack.ts',
      sourceRevision: 'source-4',
      publicationGeneration: 4,
      outputDigest: 'sha256:publication-4',
      outputSetDigest: 'sha256:outputs-4',
      receiptIdentity: 'sha256:receipt-4',
    });
  });

  it('rejects missing output and receipt or digest mismatches before observation', () => {
    expect(createScenePublicationFence({ ...publication(1), outputs: [] })).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', phase: 'publication' },
    });
    expect(
      createScenePublicationFence({
        ...publication(1),
        receipt: { ...publication(1).receipt, outputDigest: 'sha256:wrong' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', phase: 'publication' },
    });
  });

  it('fails closed for mixed generations and observation timeout while preserving LKG', async () => {
    const first = createScenePublicationFence(publication(1));
    const second = createScenePublicationFence(publication(2));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(compareScenePublicationFences(first.value, second.value)).toMatchObject({
      ok: false,
      error: {
        code: 'asset-generation-fence-mismatch',
        phase: 'observation',
        currentGeneration: 2,
      },
    });

    const observed = await observeScenePublication({
      publication: publication(2),
      waitForOutput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      timeoutMs: 1,
      lastKnownGood: first.value,
    });
    expect(observed).toMatchObject({
      ok: false,
      error: {
        code: 'asset-generation-fence-mismatch',
        phase: 'observation',
        lastKnownGood: { publicationGeneration: 1 },
        recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
      },
    });
  });

  it('requires every Catalog output row to carry the same publication tuple', () => {
    const source = publication(7);
    const entries = source.outputs.map((output) => ({
      guid: output.guid,
      kind: output.kind,
      packageUrl: '/assets/showcase.pack.json',
      sourcePath: source.sourcePath,
      publication: source,
    }));
    const outputGuid = source.outputs[0]?.guid;
    if (outputGuid === undefined) return;
    expect(scenePublicationFenceFromCatalog(entries, outputGuid)).toMatchObject({
      ok: true,
      value: { publicationGeneration: 7 },
    });
    expect(scenePublicationFenceFromCatalog(entries.slice(0, 0), outputGuid)).toMatchObject({
      ok: false,
      error: { code: 'asset-generation-fence-mismatch', phase: 'catalog' },
    });
  });
});
