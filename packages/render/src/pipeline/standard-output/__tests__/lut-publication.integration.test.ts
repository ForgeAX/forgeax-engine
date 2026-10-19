import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { Camera } from '../../../components/camera';
import { GpuResidencyCache } from '../../../device/gpu-residency';
import { createRenderPublisher } from '../../../publication/publisher';
import { RenderPublicationReceiver } from '../../../publication/receiver';
import { prepareStandardLutGpu } from '../lut-gpu';

it('resolves a transferred LUT through the accepted publication GUID and Catalog source', async () => {
  const guid = 'ad06225f-cd21-4c64-b790-a1ae7a6f193b';
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.configurePackIndex('/fixture-index.json');
  assets.setCatalogSource(
    createCatalogSource({
      url: '/fixture-index.json',
      entries: [
        {
          guid,
          kind: 'texture',
          packageUrl: '/fixture.fpack',
          sourcePath: 'fixtures/lut.pack.ts',
          sourceKey: 'fixture/color-lut',
        },
      ],
    }),
  );
  (await assets.enumerateCatalog()).unwrap();
  const asset = assets
    .catalog<TextureAsset>(guid, {
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      format: 'rgba16float',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(64),
    })
    .unwrap();
  const world = new World(),
    handle = world.allocSharedRef('TextureAsset', asset);
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: { colorLut: handle },
      },
    )
    .unwrap();
  world.update(0).unwrap();
  const identity = { source: 'lut-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  // Null has no physical limits; this structural fixture admits exactly its 2-cube.
  Object.defineProperty(device, 'limits', { value: { maxTextureDimension3D: 2 } });
  const gpuStore = new GpuResidencyCache();
  gpuStore.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('LUT preparation does not create environment cubes');
    },
    device.caps,
  );
  try {
    const catalogSnapshots = vi.spyOn(assets, 'listCatalog');
    const sourceKeys = vi.spyOn(assets, 'sourceKeyOf');
    const direct = prepareStandardLutGpu({
      world,
      handle,
      strength: 1,
      assets,
      gpuStore,
      device,
    });
    expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true });
    const candidate = publisher.prepare(0).unwrap();
    expect(catalogSnapshots).not.toHaveBeenCalled();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const received = receiver.accept(packet).unwrap();
    const transferred = received.resources.resolveAsset<TextureAsset>(handle).unwrap();
    expect(transferred).not.toBe(asset);
    expect(assets.guidOf(transferred)).toBeUndefined();
    expect(received.resources.handleForGuid(guid)).toBe(handle);
    expect(received.resources.sourceForAsset(handle)).toEqual({
      guid,
      sourceKey: 'fixture/color-lut',
    });
    const prepared = prepareStandardLutGpu({
      world: received.resources,
      handle,
      strength: 1,
      assets: new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
      gpuStore,
      device,
    });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({
      ok: true,
      value: { sourceKey: 'fixture/color-lut', size: 2, strength: 1 },
    });
    sourceKeys.mockClear();
    const next = publisher.prepare(0).unwrap();
    expect(next.packet.assets).toEqual([]);
    expect(catalogSnapshots).not.toHaveBeenCalled();
    expect(sourceKeys).not.toHaveBeenCalled();
    const invalid = {
      ...structuredClone(next.packet),
      assets: [{ handle, value: transferred, guid, sourceKey: '' }],
    };
    expect(receiver.accept(invalid)).toMatchObject({
      ok: false,
      error: { detail: { subject: 'asset source' } },
    });
    expect(received.resources.sourceForAsset(handle)).toEqual({
      guid,
      sourceKey: 'fixture/color-lut',
    });
    next.discard();
  } finally {
    publisher.dispose();
    receiver.dispose();
    gpuStore.destroyAll();
  }
});
