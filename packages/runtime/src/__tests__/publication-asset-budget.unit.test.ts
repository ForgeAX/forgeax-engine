import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it, vi } from 'vitest';
import { defaultAssetDecoderContributions } from '../asset-contributions';
import { createPublicationAssets, stagePublicationAssets } from '../renderer-host';

const constructionModuleLoaded = vi.hoisted(() => vi.fn());
vi.mock('@forgeax/engine-render/internal/construct-renderer', async (load) => {
  constructionModuleLoaded();
  return load();
});

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
  it('leaves staged decoders to the App and equips standalone publication assets', async () => {
    const install = vi.spyOn(AssetRegistry.prototype, 'installDecoder');
    const options = { shaderManifestUrl: undefined };
    const staged = stagePublicationAssets(options);
    try {
      await staged.ready;
      expect(install).not.toHaveBeenCalled();
      const standalone = await createPublicationAssets(options);
      try {
        expect(install).toHaveBeenCalledTimes(defaultAssetDecoderContributions.length);
      } finally {
        standalone.dispose();
      }
    } finally {
      staged.assets.dispose();
      install.mockRestore();
    }
  });

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
    expect(constructionModuleLoaded).not.toHaveBeenCalled();
  });

  it('rejects an invalid budget before creating a registry', async () => {
    await expect(
      createPublicationAssets({ shaderManifestUrl: undefined }, { assetBudgetBytes: 0 }),
    ).rejects.toThrow('assetBudgetBytes must be a positive safe integer');
  });
});
