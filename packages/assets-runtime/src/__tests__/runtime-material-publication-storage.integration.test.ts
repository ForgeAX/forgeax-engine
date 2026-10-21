import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import { materialRecordFixture } from './fixtures/material-publication';
import { loadMaterialFixture } from './fixtures/runtime-material';

it('keeps publication program data with its source instead of copying it into mutable content', async () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const owner = new AssetRegistry({ shaderRegistry: shaders });
  try {
    const record = materialRecordFixture({
      parameters: [{ name: 'roughness', type: 'f32' }],
      values: { roughness: 0.3 },
    });
    const loaded = (await loadMaterialFixture(owner, record)).unwrap();
    expect(loaded.payload).not.toHaveProperty('cooked');
    expect(loaded.projection?.specializationKey).toBe(record.specializationKey);
    for (const program of record.programs) {
      expect(shaders.findMaterialArtifact(program.specializationKey)).toMatchObject({ ok: true });
    }
    owner.update(loaded.handle, { values: { roughness: 0.5 } }).unwrap();
    expect(runtimeAssets(owner).borrow(loaded.handle).unwrap()).not.toHaveProperty('cooked');
  } finally {
    owner.dispose();
  }
});

it('admits ordinary content within budget when the complete Cook publication is larger', async () => {
  const owner = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    limits: { maxBytes: 24 * 1024 },
  });
  try {
    const record = materialRecordFixture({
      passes: [{ name: 'Forward', program: { module: `game::ready${'x'.repeat(8192)}` } }],
    });
    const result = await loadMaterialFixture(owner, record);
    expect(result.ok, result.ok ? undefined : String(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.value.projection?.specializationKey).toBe(record.specializationKey);
    expect(runtimeAssets(owner).inspect().bytes).toBeLessThan(24 * 1024);
  } finally {
    owner.dispose();
  }
});
