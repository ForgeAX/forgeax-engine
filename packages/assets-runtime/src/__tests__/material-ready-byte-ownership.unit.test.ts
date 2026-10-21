import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssetReference } from '../internal';
import { createMaterialLoader } from '../material/loader';
import { materialPublicationFixture, materialRecordFixture } from './fixtures/material-publication';
import { loadMaterialFixture } from './fixtures/runtime-material';

const passes = [{ name: 'Forward', program: { module: `game::ready${'x'.repeat(512)}` } }];
async function ready(index: number) {
  const record = materialRecordFixture({
    guid: `019f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    passes,
  });
  const loaded = await createMaterialLoader({
    loadPublication: async () => materialPublicationFixture(record),
  }).load({ guid: record.guid, specializationKey: record.specializationKey });
  if (loaded.status !== 'Ready') throw Error(loaded.error.code);
  return loaded;
}

describe('actual material-ready caller byte ownership work', () => {
  it('keeps duplicate registrations on distinct buffers through preflight and publication', async () => {
    const shaders = new ShaderRegistry({ manifestUrl: undefined }),
      owner = new AssetRegistry({ shaderRegistry: shaders });
    const original = MaterialArtifactRegistry.prototype.register;
    const stats = {
      registrations: 0,
      equalComparisons: 0,
      sameView: 0,
      sameRegion: 0,
      comparedBytes: 0,
    };
    const spy = vi
      .spyOn(MaterialArtifactRegistry.prototype, 'register')
      .mockImplementation(function (this: MaterialArtifactRegistry, artifact) {
        stats.registrations++;
        const previous = this.get(artifact.key);
        if (previous !== undefined) {
          stats.equalComparisons++;
          stats.comparedBytes += previous.bytes.length;
          if (previous.bytes === artifact.bytes) stats.sameView++;
          if (
            previous.bytes.buffer === artifact.bytes.buffer &&
            previous.bytes.byteOffset === artifact.bytes.byteOffset &&
            previous.bytes.byteLength === artifact.bytes.byteLength
          )
            stats.sameRegion++;
        }
        return original.call(this, artifact);
      });
    try {
      for (let index = 1; index <= 6; index++) {
        const loaded = await ready(index);
        const adopted = (await loadMaterialFixture(owner, loaded.record)).unwrap();
        expect(adopted.projection).toBeDefined();
      }
      expect(stats).toMatchObject({
        registrations: 17,
        equalComparisons: 10,
        sameView: 0,
        sameRegion: 0,
      });
      expect(stats.comparedBytes).toBeGreaterThan(5120);
    } finally {
      spy.mockRestore();
    }
  });

  it('revalidates caller-mutated retained bytes after the shader preflight callback', async () => {
    const shaders = new ShaderRegistry({ manifestUrl: undefined }),
      owner = new AssetRegistry({ shaderRegistry: shaders });
    const first = await ready(1);
    (await loadMaterialFixture(owner, first.record)).unwrap();
    const key = first.record.programs[0]?.specializationKey;
    if (key === undefined) throw Error('Missing program');
    const existing = owner.getMaterialArtifact(key);
    if (existing === undefined) throw Error('Missing retained artifact');
    const second = await ready(2);
    const original = shaders.findMaterialArtifact.bind(shaders);
    const spy = vi.spyOn(shaders, 'findMaterialArtifact').mockImplementation((identifier) => {
      existing.bytes[120] = (existing.bytes[120] ?? 0) ^ 128;
      return original(identifier);
    });
    try {
      let thrown: unknown;
      try {
        (await loadMaterialFixture(owner, second.record)).unwrap();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: 'material-artifact-conflict',
        detail: { dimension: 'bytes' },
      });
      expect(runtimeAssetReference(owner, second.record.guid)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
