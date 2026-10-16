import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { resolveMaterialSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

function guid(text: string) {
  const parsed = AssetGuid.parse(text);
  if (!parsed.ok) throw new Error(`invalid fixture GUID: ${text}`);
  return parsed.value;
}

describe('material resource references across submeshes', () => {
  it.each([
    'bytes',
    'string',
    'handle',
    'missing',
  ] as const)('preserves %s texture and sampler references in every material slot', (representation) => {
    const world = new World();
    const assets = new AssetRegistry(
      new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('extraction must not compile shaders');
          },
        },
        manifestUrl: undefined,
      }),
    );
    const texture: TextureAsset = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'packed', levelCount: 1 },
      data: new Uint8Array([255, 0, 0, 255]),
    };
    const layers: TextureAsset = {
      ...texture,
      shape: { viewDimension: '2d-array', extent: { width: 1, height: 1, layers: 2 } },
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    };
    const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
    const textureGuid = guid('019d0000-0000-7000-8000-000000000011');
    const layersGuid = guid('019d0000-0000-7000-8000-000000000012');
    const samplerGuid = guid('019d0000-0000-7000-8000-000000000013');
    if (representation !== 'missing') {
      assets.catalog(textureGuid, texture).unwrap();
      assets.catalog(layersGuid, layers).unwrap();
      assets.catalog(samplerGuid, sampler).unwrap();
    }
    const textureRef =
      representation === 'handle'
        ? world.allocSharedRef('TextureAsset', texture)
        : representation === 'string'
          ? AssetGuid.format(textureGuid)
          : textureGuid;
    const layersRef =
      representation === 'handle'
        ? world.allocSharedRef('TextureAsset', layers)
        : representation === 'string'
          ? AssetGuid.format(layersGuid)
          : layersGuid;
    const samplerRef =
      representation === 'handle'
        ? world.allocSharedRef('SamplerAsset', sampler)
        : representation === 'string'
          ? AssetGuid.format(samplerGuid)
          : samplerGuid;
    const material = (): MaterialAsset => ({
      kind: 'material',
      parameters: [
        { name: 'baseColorTexture', type: 'texture' },
        { name: 'layers', type: 'texture_2d_array' },
      ],
      passes: [{ name: 'Forward', program: { module: 'game::material-guid-fixture' } }],
      values: {
        baseColorTexture: { texture: textureRef, sampler: samplerRef },
        layers: { texture: layersRef, sampler: samplerRef },
      },
    });
    const firstMaterial = world.allocSharedRef('MaterialAsset', material());
    const secondMaterial = world.allocSharedRef('MaterialAsset', material());
    const handles = [firstMaterial, secondMaterial];
    const box = createBoxGeometry(1, 1, 1).unwrap();
    const submesh = box.submeshes[0];
    if (submesh === undefined) throw new Error('box has no submesh');
    const mesh = world.allocSharedRef('MeshAsset', {
      ...box,
      materialSlots: [{ slotName: 'first' }, { slotName: 'second' }],
      submeshes: [
        { ...submesh, materialSlot: 0 },
        { ...submesh, materialSlot: 1 },
      ],
    });
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: handles } },
      )
      .unwrap();

    const extracted = extractFrames([world], 0, assets).renderables[0];
    expect(extracted?.materials).toHaveLength(2);
    const primary = extracted?.materials[0];
    const secondary = extracted?.materials[1];
    for (const snapshot of [
      primary,
      secondary,
      resolveMaterialSnapshot(secondMaterial, world, assets),
    ]) {
      expect(snapshot?.textureHandles).toEqual(primary?.textureHandles);
      expect(snapshot?.samplerHandles).toEqual(primary?.samplerHandles);
      if (representation === 'missing') {
        expect(snapshot?.textureHandles).toBeUndefined();
        expect(snapshot?.samplerHandles).toBeUndefined();
        continue;
      }
      expect(snapshot?.textureHandles?.size).toBe(2);
      expect(snapshot?.samplerHandles?.size).toBe(2);
      for (const field of ['baseColorTexture', 'layers']) {
        const textureHandle = snapshot?.textureHandles?.get(field);
        const samplerHandle = snapshot?.samplerHandles?.get(field);
        if (textureHandle === undefined || samplerHandle === undefined) {
          throw new Error(`missing ${field} texture or sampler`);
        }
        expect(world.sharedRefs.resolve(textureHandle).unwrap()).toEqual(
          field === 'layers' ? layers : texture,
        );
        expect(world.sharedRefs.resolve(samplerHandle).unwrap()).toEqual(sampler);
      }
    }
    const next = extractFrames([world], 0, assets).renderables[0];
    expect(next?.materials[1]?.textureHandles).toEqual(secondary?.textureHandles);
    expect(next?.materials[1]?.samplerHandles).toEqual(secondary?.samplerHandles);
  });
});
