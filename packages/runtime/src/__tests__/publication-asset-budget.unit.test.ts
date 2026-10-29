import { describe, expect, it } from 'vitest';
import { createPublicationAssets } from '../renderer-host';

const mesh = (count: number) => ({
  kind: 'mesh' as const,
  vertices: new Float32Array(count * 3),
  attributes: { position: new Float32Array(count * 3) },
  submeshes: [
    {
      indexOffset: 0,
      indexCount: 0,
      vertexCount: count,
      topology: 'point-list' as const,
      materialSlot: 0,
    },
  ],
  materialSlots: [{ slotName: 'Default' }],
});

describe('split-source publication assets budget', () => {
  it('applies the App asset budget to the source-realm AssetRegistry', async () => {
    const bounded = await createPublicationAssets(
      { shaderManifestUrl: undefined },
      { assetBudgetBytes: 4096 },
    );
    expect(bounded.create(mesh(10_000))).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    bounded.dispose();
    const defaulted = await createPublicationAssets({ shaderManifestUrl: undefined });
    expect(defaulted.create(mesh(10_000)).ok).toBe(true);
    defaulted.dispose();
  });

  it('rejects an invalid budget before creating a registry', async () => {
    await expect(
      createPublicationAssets({ shaderManifestUrl: undefined }, { assetBudgetBytes: 0 }),
    ).rejects.toThrow('assetBudgetBytes must be a positive safe integer');
  });
});
