import { fileURLToPath } from 'node:url';
import { derive, type MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

const root = fileURLToPath(
  new URL('../../../../runtime/src/__tests__/fixtures/external-texture/', import.meta.url),
);

const material: MaterialAsset = {
  kind: 'material',
  colorSpace: 'linear',
  parameters: [{ name: 'videoTexture', type: 'texture_external' }],
  passes: [
    {
      name: 'Forward',
      program: {
        module: 'regression::external_unlit',
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
      },
      renderState: { tags: { LightMode: 'Forward' }, cullMode: 'none' },
    },
  ],
};

it('cooks a texture_external parameter into one externalTexture BGL entry and a texture_external WGSL binding', async () => {
  const cooked = await createMaterialPackCooker([root]).cook({
    guid: 'external-unlit',
    source: material,
  });
  const text = Object.values(cooked.artifacts)
    .map((artifact) => new TextDecoder().decode(artifact.bytes))
    .join('\n');
  expect(text).toContain('texture_external');
  expect(text).toContain('textureSampleBaseClampToEdge');
}, 120_000);

it('derives the externalTexture BGL entry after its auto-paired sampler', () => {
  const out = derive([{ name: 'videoTexture', type: 'texture_external' }]);
  const sampler = out.bglEntries.find((entry) => entry.sampler !== undefined);
  const external = out.bglEntries.find((entry) => entry.externalTexture !== undefined);
  expect(sampler).toBeDefined();
  expect(external).toEqual({
    binding: (sampler?.binding ?? -1) + 1,
    visibility: 2,
    externalTexture: {},
  });
  expect(out.bglEntries.some((entry) => entry.texture !== undefined)).toBe(false);
});
