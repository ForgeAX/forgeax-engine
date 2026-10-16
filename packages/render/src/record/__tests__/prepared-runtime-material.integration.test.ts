import { AssetRegistry, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { BindGroupLayout } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry, STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import { createSkylightFallback } from '../../ibl/skylight-bind-group';
import { renderPublicationTransfers } from '../../publication/contract';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { preparedMaterialBindings } from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';

it('uploads accepted values on World and published-reader paths without mutating the base', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abc';
  const base: MaterialAsset = { kind: 'material', values: { roughness: 0.8 } };
  assets.catalog(guid, base);
  const handle = world.internSharedRef('MaterialAsset', base);
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'roughness', kind: 0, value: [0.25] },
    })
    .unwrap();
  const uploads: number[] = [];
  let destroys = 0;
  const runtime = {
    assets,
    getParamSchema: () => [{ name: 'roughness', type: 'f32' }],
    getPipelineState: () => ({
      defaultSampler: {},
      skylightFallback: {
        irradianceView: {},
        prefilterView: {},
        brdfLutView: {},
        sampler: {},
        intensityBuffer: {},
      },
    }),
    device: {
      caps: { storageBuffer: false },
      limits: { maxSampledTexturesPerShaderStage: 16 },
      createBuffer: () => ok({}),
      destroyBuffer: () => {
        destroys++;
        return ok(undefined);
      },
      createBindGroup: () => ok({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, bytes: Uint8Array) => {
          uploads.push(new Float32Array(bytes.buffer, bytes.byteOffset, 1)[0] ?? NaN);
          return ok(undefined);
        },
      },
    },
  } as unknown as RenderSystemInternals;
  const identity = { source: 'material-values', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [
    {
      identity: 'material-consumer',
      extract: () => ok({}),
      assetDependencies: () => [guid],
      plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    },
  ]);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const resources = receiver.accept(packet).unwrap().resources;
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return resources;
  };
  const reader = publish();
  for (const source of [world, reader]) {
    const bindings = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    if ('release' in bindings) bindings.release?.();
  }
  expect(uploads).toEqual([0.25, 0.25]);
  expect(base.values?.roughness).toBe(0.8);
  const other = new World();
  const otherHandle = other.internSharedRef('MaterialAsset', base);
  const otherContent = other
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: otherHandle,
        parameter: 'roughness',
        kind: 0,
        value: [0.6],
      },
    })
    .unwrap();
  for (const [owner, expected] of [
    [1, 0.6],
    [0, 0.25],
  ] as const) {
    const bindings = preparedMaterialBindings(
      runtime,
      [world, other],
      'shader',
      owner,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(expected);
    if ('release' in bindings) bindings.release?.();
  }
  other.despawn(otherContent).unwrap();
  world.despawn(content).unwrap();
  for (const source of [world, publish()]) {
    const restored = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(0.8);
    if ('release' in restored) restored.release?.();
  }
  expect(destroys).toBe(6);
  publisher.dispose();
});

it('binds the shared direct DFG texture for prepared feature materials and renews it after recovery', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abe';
  const material: MaterialAsset = { kind: 'material', values: { directMultiscatteringLut: 1 } };
  assets.catalog(guid, material);
  const fallback = createSkylightFallback(device, device.queue);
  const storage = device.createBuffer({ size: 256, usage: 128 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  let scope = DeviceScope.create(1, 'prepared-dfg');
  let lut = false;
  const runtime = {
    assets,
    device,
    get deviceScope() {
      return scope;
    },
    getParamSchema: () =>
      lut ? [{ name: 'directMultiscatteringLut', type: 'u32', default: 1 }] : [],
    getPipelineState: () => ({
      defaultSampler: fallback.sampler,
      skylightFallback: fallback,
      meshStorageBuffer: { buffer: storage },
    }),
  } as unknown as RenderSystemInternals;
  const groups = vi.spyOn(device, 'createBindGroup');
  const upload = vi.spyOn(device.queue, 'writeTexture');
  const prepare = () => {
    const result = preparedMaterialBindings(
      runtime,
      [world],
      'game::prepared-dfg',
      0,
      guid,
      layout,
    ).unwrap();
    const entry = Array.from(groups.mock.calls.at(-1)?.[0].entries ?? []).find(
      (binding) => binding.binding === STANDARD_DIRECT_DFG_LUT_BINDING,
    );
    if ('release' in result) result.release?.();
    return entry?.resource;
  };
  expect(prepare()).toBeUndefined();
  expect(upload).not.toHaveBeenCalled();
  lut = true;
  const first = prepare();
  expect(first).toMatchObject({ kind: 'textureView' });
  expect(prepare()).toEqual(first);
  expect(upload).toHaveBeenCalledTimes(1);
  scope.dispose();
  scope = DeviceScope.create(2, 'prepared-dfg');
  expect(prepare()).not.toEqual(first);
  expect(upload).toHaveBeenCalledTimes(2);
  scope.dispose();
  for (const texture of [
    fallback.irradianceTexture,
    fallback.prefilterTexture,
    fallback.brdfLutTexture,
  ])
    device.destroyTexture(texture).unwrap();
  device.destroyBuffer(fallback.intensityBuffer).unwrap();
  device.destroyBuffer(storage).unwrap();
});
