import type { BindGroup, BindGroupLayout, Buffer, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { MaterialSnapshot } from '../../render-system-extract';
import type { RenderTargetTextureSource } from '../../targets/contracts';
import type { MaterialBgAssemblyCacheEntry } from '../frame-snapshot';
import { isMaterialBgAssemblyCacheHit } from '../main-pass-material';

describe('material bind-group assembly cache', () => {
  it('reuses cloned bindings and uniform edits but invalidates every binding source change', () => {
    const material = {
      textureHandles: new Map([['baseColorTexture', 1]]),
      samplerHandles: new Map([['baseColorTexture', 2]]),
      emissiveTexture: 3,
      occlusionTexture: 4,
      standardTextureMask: 0,
      paramSnapshot: { roughness: 0.5 },
    } as unknown as MaterialSnapshot;
    const cached = {
      material,
      materialBgl: {},
      materialBuffer: {},
      materialResourceEpoch: 7,
      skylightResources: {},
      bindGroup: {},
    } as MaterialBgAssemblyCacheEntry;
    const hit = (next: MaterialSnapshot) =>
      isMaterialBgAssemblyCacheHit(
        cached,
        next,
        cached.materialBgl,
        cached.materialBuffer,
        cached.skylightResources,
        7,
      );
    expect(hit(structuredClone(material))).toBe(true);
    expect(hit({ ...structuredClone(material), paramSnapshot: { roughness: 0.9 } })).toBe(true);
    for (const changed of [
      { textureHandles: new Map([['baseColorTexture', 5]]) },
      { samplerHandles: new Map([['baseColorTexture', 5]]) },
      { textureHandles: new Map() },
      { samplerHandles: new Map() },
      { emissiveTexture: 5 },
      { occlusionTexture: 5 },
      { standardTextureMask: 8 },
      { paramSnapshot: { transmission: 0 } },
      { videoTextureFields: new Map([['baseColorTexture', 5]]) },
    ]) {
      expect(hit({ ...material, ...changed } as MaterialSnapshot)).toBe(false);
    }
  });

  it('invalidates when material buffer capacity growth replaces the buffer', () => {
    const material = {} as MaterialSnapshot;
    const materialBgl = {} as BindGroupLayout;
    const oldBuffer = {} as Buffer;
    const newBuffer = {} as Buffer;
    const skylightResources = {
      irradianceView: {},
      irradianceSampler: {},
      prefilterView: {},
      prefilterSampler: {},
      brdfLutView: {},
      intensityBuffer: {},
    } as MaterialBgAssemblyCacheEntry['skylightResources'];
    const cached: MaterialBgAssemblyCacheEntry = {
      material,
      materialResourceEpoch: 7,
      materialBgl,
      materialBuffer: oldBuffer,
      skylightResources,
      bindGroup: {} as BindGroup,
    };

    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, oldBuffer, skylightResources, 7),
    ).toBe(true);
    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, newBuffer, skylightResources, 7),
    ).toBe(false);
    expect(
      isMaterialBgAssemblyCacheHit(
        cached,
        material,
        materialBgl,
        oldBuffer,
        { ...skylightResources, skylightPrefilterView: {} as TextureView },
        7,
      ),
    ).toBe(false);
    const targetMaterial = {
      ...material,
      textureSources: new Map([['baseColorTexture', {} as RenderTargetTextureSource]]),
    };
    expect(
      isMaterialBgAssemblyCacheHit(
        { ...cached, material: targetMaterial },
        targetMaterial,
        materialBgl,
        oldBuffer,
        skylightResources,
        7,
      ),
    ).toBe(false);
    const sceneCached = { ...cached, sceneMaterialBuffer: oldBuffer };
    expect(
      isMaterialBgAssemblyCacheHit(
        sceneCached,
        material,
        materialBgl,
        oldBuffer,
        skylightResources,
        7,
        undefined,
        oldBuffer,
      ),
    ).toBe(true);
    expect(
      isMaterialBgAssemblyCacheHit(
        sceneCached,
        material,
        materialBgl,
        oldBuffer,
        skylightResources,
        7,
        undefined,
        newBuffer,
      ),
    ).toBe(false);
    expect(
      isMaterialBgAssemblyCacheHit(
        sceneCached,
        material,
        materialBgl,
        oldBuffer,
        skylightResources,
        7,
      ),
    ).toBe(false);
    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, oldBuffer, skylightResources, 8),
    ).toBe(false);
    expect(
      isMaterialBgAssemblyCacheHit(
        cached,
        material,
        materialBgl,
        oldBuffer,
        skylightResources,
        7,
        {} as TextureView,
      ),
    ).toBe(false);
  });
});
