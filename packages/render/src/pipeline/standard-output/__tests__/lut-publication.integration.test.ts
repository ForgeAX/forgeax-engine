import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { Camera } from '../../../components/camera';
import { GpuResidencyCache } from '../../../device/gpu-residency';
import { createRenderPublisher } from '../../../publication/publisher';
import { RenderPublicationReceiver } from '../../../publication/receiver';
import { worldRenderResources } from '../../../publication/resource-scope';
import { prepareStandardLutGpu } from '../lut-gpu';

it('resolves a transferred LUT through the accepted publication GUID and Catalog source', async () => {
  const guid = 'ad06225f-cd21-4c64-b790-a1ae7a6f193b';
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const asset: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'rgba16float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64),
  };
  publishRuntimeAssets(assets, [{ guid, asset, sourceKey: 'fixture/color-lut' }]);
  const world = new World({ assets });
  const handle = (await assets.load(guid, 'texture')).unwrap();
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
  gpuStore.configureGpuDevice(device, undefined, device.caps);
  try {
    const catalogSnapshots = vi.spyOn(assets, 'listCatalog');
    const sourceKeys = vi.spyOn(assets, 'sourceKeyOf');
    const direct = prepareStandardLutGpu({
      world: worldRenderResources(world),
      handle,
      strength: 1,
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
    expect(assets.guidOf(handle)).toBe(guid);
    expect(received.resources.handleForGuid(guid)).toBe(handle);
    expect(received.resources.sourceForAsset(handle)).toEqual({
      guid,
      sourceKey: 'fixture/color-lut',
    });
    const prepared = prepareStandardLutGpu({
      world: received.resources,
      handle,
      strength: 1,
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
    const assetRow = packet.assets.find((row) => row.handle === handle);
    assert(assetRow);
    const invalid = {
      ...structuredClone(next.packet),
      assets: [
        {
          handle,
          revision: assetRow.revision + 1,
          value: transferred,
          guid,
          sourceKey: '',
        },
      ],
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

it.each([
  'world',
  'publication',
] as const)('adopts a runtime-created LUT edit and keeps an in-flight version alive through %s', async (mode) => {
  const assets = new AssetRegistry();
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      format: 'rgba16float',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(64),
    })
    .unwrap();
  const world = new World({ assets });
  world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { colorLut: handle, colorLutStrength: 1 } },
    )
    .unwrap();
  world.update(0).unwrap();
  const identity = { source: 'runtime-lut', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const observer = assets.observe().unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.defineProperty(device, 'limits', { value: { maxTextureDimension3D: 2 } });
  const gpuStore = new GpuResidencyCache();
  gpuStore.configureGpuDevice(device, undefined, device.caps);
  let lease: ReturnType<typeof gpuStore.retainTextureResidency>;
  const receive = () => {
    const candidate = publisher.prepare(0).unwrap();
    const accepted = receiver.accept(structuredClone(candidate.packet)).unwrap();
    candidate.accept();
    return accepted;
  };
  const initial = receive();
  const scope = mode === 'world' ? worldRenderResources(world) : initial.resources;
  const prepare = () =>
    prepareStandardLutGpu({
      world: scope,
      handle,
      strength: 1,
      gpuStore,
      device,
    }).unwrap();
  try {
    expect(assets.guidOf(handle)).toBeUndefined();
    const before = prepare();
    expect(prepare().bindGroup).toBe(before.bindGroup);
    lease = gpuStore.retainTextureResidency(handle, scope);
    expect(lease).toBeDefined();
    const writes = vi.spyOn(device.queue, 'writeTexture');
    const data = new Uint8Array(new Uint16Array(32).fill(0x3c00).buffer);
    assets.update(handle, { data }).unwrap();
    const changes = observer.read().unwrap();
    const next = receive();
    const acceptedChanges = mode === 'world' ? changes.changes : next.assetChanges;
    for (const change of acceptedChanges) {
      const content = scope.resolveAsset<TextureAsset>(change.handle).unwrap();
      gpuStore.adoptTextureChange(change, content, scope).unwrap();
    }
    changes.accept();
    const after = prepare();
    expect(after.sourceKey).toBe(before.sourceKey);
    expect(after.texture).not.toBe(before.texture);
    expect(after.bindGroup).not.toBe(before.bindGroup);
    expect(prepare().bindGroup).toBe(after.bindGroup);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toEqual(data);
    expect(scope.assetRevision(handle)).toBeGreaterThan(1);
    writes.mockRestore();
  } finally {
    await lease?.release(false);
    observer.dispose();
    publisher.dispose();
    receiver.dispose();
    gpuStore.destroyAll();
    assets.dispose();
  }
});
