import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { samplerContribution } from '../assets/asset-decoders';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { worldRenderResources } from '../publication/resource-scope';
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
  ] as const)('preserves %s texture and sampler references in every material slot', async (representation) => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('extraction must not compile shaders');
          },
        },
        manifestUrl: undefined,
      }),
    });
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const world = new World({ assets });
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
      publishRuntimeAssets(assets, [
        { guid: AssetGuid.format(textureGuid), asset: texture },
        { guid: AssetGuid.format(layersGuid), asset: layers },
        { guid: AssetGuid.format(samplerGuid), asset: sampler },
      ]);
      for (const [guid, kind] of [
        [textureGuid, 'texture'],
        [layersGuid, 'texture'],
        [samplerGuid, 'sampler'],
      ] as const)
        (await assets.load(AssetGuid.format(guid), kind)).unwrap();
    }
    const textureRef =
      representation === 'handle'
        ? assets.create(texture).unwrap()
        : representation === 'string'
          ? AssetGuid.format(textureGuid)
          : textureGuid;
    const layersRef =
      representation === 'handle'
        ? assets.create(layers).unwrap()
        : representation === 'string'
          ? AssetGuid.format(layersGuid)
          : layersGuid;
    const samplerRef =
      representation === 'handle'
        ? assets.create(sampler).unwrap()
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
    if (representation === 'missing') {
      expect(assets.create(material())).toMatchObject({
        ok: false,
        error: { code: 'asset-reference-invalid' },
      });
      expect(world.inspect().entityCount).toBe(0);
      return;
    }
    const firstMaterial = assets.create(material()).unwrap();
    const secondMaterial = assets.create(material()).unwrap();
    const handles = [firstMaterial, secondMaterial];
    const box = createBoxGeometry(1, 1, 1).unwrap();
    const submesh = box.submeshes[0];
    if (submesh === undefined) throw new Error('box has no submesh');
    const mesh = assets
      .create({
        ...box,
        materialSlots: [{ slotName: 'first' }, { slotName: 'second' }],
        submeshes: [
          { ...submesh, materialSlot: 0 },
          { ...submesh, materialSlot: 1 },
        ],
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: handles } },
      )
      .unwrap();

    const extracted = extractFrames([world], 0, assets).renderables.at(0);
    expect(extracted?.materials).toHaveLength(2);
    const primary = extracted?.materials[0]?.snapshot;
    const secondary = extracted?.materials[1]?.snapshot;
    for (const snapshot of [
      primary,
      secondary,
      resolveMaterialSnapshot(secondMaterial, worldRenderResources(world), assets),
    ]) {
      expect(snapshot?.textureHandles).toEqual(primary?.textureHandles);
      expect(snapshot?.samplerHandles).toEqual(primary?.samplerHandles);
      expect(snapshot?.textureHandles?.size).toBe(2);
      expect(snapshot?.samplerHandles?.size).toBe(2);
      for (const field of ['baseColorTexture', 'layers']) {
        const textureHandle = snapshot?.textureHandles?.get(field);
        const samplerHandle = snapshot?.samplerHandles?.get(field);
        if (textureHandle === undefined || samplerHandle === undefined) {
          throw new Error(`missing ${field} texture or sampler`);
        }
        expect(assets.read(textureHandle).unwrap()).toEqual(field === 'layers' ? layers : texture);
        expect(assets.read(samplerHandle).unwrap()).toEqual(sampler);
      }
    }
    const next = extractFrames([world], 0, assets).renderables.at(0);
    expect(next?.materials[1]?.snapshot.textureHandles).toEqual(secondary?.textureHandles);
    expect(next?.materials[1]?.snapshot.samplerHandles).toEqual(secondary?.samplerHandles);
  });
});
