import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { BindGroupLayout } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { ShaderRegistry, STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { samplerContribution } from '../../assets/asset-decoders';
import { DeviceScope } from '../../device/device-scope';
import { createSkylightFallback } from '../../ibl/skylight-bind-group';
import { renderPublicationTransfers } from '../../publication/contract';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { worldRenderResources } from '../../publication/resource-scope';
import { preparedMaterialBindings } from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';

it.each([
  'descriptor',
  'shorthand',
] as const)('binds owned %s texture references on local and published paths', async (form) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      mips: { kind: 'none' },
      colorSpace: 'linear',
      data: new Uint8Array([1, 2, 3, 255]),
    })
    .unwrap();
  const sampler = assets.create({ kind: 'sampler', magFilter: 'nearest' }).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
      parameters: [{ name: 'map', type: 'texture' }],
      values: { map: form === 'descriptor' ? { texture, sampler } : texture },
    })
    .unwrap();
  const fallback = createSkylightFallback(device, device.queue);
  const nativeSampler = device.createSampler({ magFilter: 'nearest' }).unwrap();
  const nativeTexture = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 4 })
    .unwrap();
  const view = device.createTextureView(nativeTexture, {}).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const storage = device.createBuffer({ size: 256, usage: 128 }).unwrap();
  const ensureSamplerResident = vi.fn((_handle: number) => ok(nativeSampler));
  const ensureResident = vi.fn((_handle: number) => ok(undefined));
  const runtime = {
    assets,
    device,
    gpuStore: { ensureSamplerResident, ensureResident, getTextureGpuView: () => view },
    getParamSchema: () => [{ name: 'map', type: 'texture2d' }],
    getPipelineState: () => ({
      defaultSampler: fallback.sampler,
      defaultWhiteTextureView: fallback.brdfLutView,
      skylightFallback: fallback,
      meshStorageBuffer: { buffer: storage },
    }),
  } as unknown as RenderSystemInternals;
  const identity = { source: 'managed-texture-binding', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [
    {
      identity: 'texture-consumer',
      extract: () => ok({}),
      assetDependencies: () => [material],
      plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    },
  ]);
  const receiver = new RenderPublicationReceiver(identity);
  const groups = vi.spyOn(device, 'createBindGroup');
  try {
    const candidate = publisher.prepare(0).unwrap();
    const remote = receiver.accept(structuredClone(candidate.packet)).unwrap().resources;
    candidate.accept();
    for (const source of [worldRenderResources(world), remote]) {
      const binding = preparedMaterialBindings(
        runtime,
        [source],
        'field::texture',
        0,
        material,
        layout,
      ).unwrap();
      const entries = Array.from(groups.mock.calls.at(-1)?.[0].entries ?? []);
      expect(
        entries.some(
          (entry) => entry.resource.kind === 'textureView' && entry.resource.value === view,
        ),
      ).toBe(true);
      expect(ensureResident.mock.calls.at(-1)?.[0]).toBe(texture);
      if (form === 'descriptor') {
        expect(ensureSamplerResident.mock.calls.at(-1)?.[0]).toBe(sampler);
        expect(
          entries.some(
            (entry) => entry.resource.kind === 'sampler' && entry.resource.value === nativeSampler,
          ),
        ).toBe(true);
      }
      if ('release' in binding) binding.release?.();
    }
    expect(assets.read(material).unwrap().values?.map).toEqual(
      form === 'descriptor' ? { texture, sampler } : texture,
    );
  } finally {
    publisher.dispose();
    assets.dispose();
    device.destroyTexture(nativeTexture);
    device.destroyBuffer(storage);
    for (const texture of [
      fallback.irradianceTexture,
      fallback.prefilterTexture,
      fallback.brdfLutTexture,
    ])
      device.destroyTexture(texture);
    device.destroyBuffer(fallback.intensityBuffer);
  }
});

it('uploads accepted values on World and published-reader paths without mutating the input', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const base: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: { roughness: 0.8 },
  };
  const handle = assets.create(base).unwrap();
  assets.update(handle, { values: { roughness: 0.25 } }).unwrap();
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
      assetDependencies: () => [handle],
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
  for (const source of [worldRenderResources(world), reader]) {
    const bindings = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      handle,
      {} as BindGroupLayout,
    ).unwrap();
    if ('release' in bindings) bindings.release?.();
  }
  expect(uploads).toEqual([0.25, 0.25]);
  expect(base.values?.roughness).toBe(0.8);
  const otherAssets = new AssetRegistry();
  otherAssets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const other = new World({ assets: otherAssets });
  const otherHandle = otherAssets.create(base).unwrap();
  otherAssets.update(otherHandle, { values: { roughness: 0.6 } }).unwrap();
  for (const [owner, expected] of [
    [1, 0.6],
    [0, 0.25],
  ] as const) {
    const bindings = preparedMaterialBindings(
      runtime,
      [world, other].map(worldRenderResources),
      'shader',
      owner,
      owner === 1 ? otherHandle : handle,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(expected);
    if ('release' in bindings) bindings.release?.();
  }
  otherAssets.dispose();
  assets.update(handle, { values: { roughness: 0.8 } }).unwrap();
  for (const source of [worldRenderResources(world), publish()]) {
    const restored = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      handle,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(0.8);
    if ('release' in restored) restored.release?.();
  }
  expect(destroys).toBe(6);
  publisher.dispose();
  assets.dispose();
});

it('binds the shared direct DFG texture for prepared feature materials and renews it after recovery', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: { directMultiscatteringLut: 1 },
  };
  const handle = assets.create(material).unwrap();
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
      [world].map(worldRenderResources),
      'game::prepared-dfg',
      0,
      handle,
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
