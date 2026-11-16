import type { MipmapShaderModuleFactory } from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  gpuTextureContribution,
  textureGeneratorContribution,
  validateAssetPublication,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId, gpuTextureOutputs } from '@forgeax/engine-pack/source';
import { type RhiDevice, RhiError, type Texture } from '@forgeax/engine-rhi';
import type { TextureGeneratorPrograms } from '@forgeax/engine-types';
import { err, srgbChannelToLinear } from '@forgeax/engine-types';
import { assert, expect, vi } from 'vitest';
import { prepareRuntimePackContent, RuntimePackProducer } from '../../../import/src/runtime-pack';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

/** Decode the actual quantized sRGB mip before the consumer's UNORM write. */
export function sampledSrgbPixel(pixel: readonly number[] | Uint8Array): number[] {
  return Array.from(pixel, (channel, index) =>
    index === 3 ? channel : Math.round(srgbChannelToLinear(channel / 255) * 255),
  );
}

const packageIdText = '01900000-0000-7000-8000-000000000010';
const packageId = definePackageId(packageIdText);
const shape = { viewDimension: '2d', extent: { width: 16, height: 16 } } as const;
const linear = {
  shape,
  format: 'rgba8unorm',
  colorSpace: 'linear',
  mips: { kind: 'generate' },
} as const;
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const decoders = [gpuTextureContribution, textureGeneratorContribution];

export interface TextureGeneratorFixtureOptions {
  readonly observe?: (
    phase: 'generation' | 'resident',
    submit: () => Promise<void>,
  ) => Promise<void>;
  readonly recreateDevice?: () => Promise<{
    device: RhiDevice;
    factory: MipmapShaderModuleFactory;
  }>;
}

async function pixel(
  device: RhiDevice,
  texture: Texture,
  mip = 0,
  layer = 0,
): Promise<readonly number[]> {
  const buffer = device.createBuffer({ size: 256, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({ label: 'explicit-test-pixel-readback' }).unwrap();
    encoder.copyTextureToBuffer(
      { texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
      { buffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapping = (await buffer.mapAsync(1)).unwrap();
    const value = Array.from(new Uint8Array(mapping.getMappedRange().unwrap()).subarray(0, 4));
    mapping.unmap();
    return value;
  } finally {
    device.destroyBuffer(buffer).unwrap();
  }
}

/** Validate the quantized source separately, then predict its exact linear consumer. */
async function sampledMipRed(
  device: RhiDevice,
  texture: Texture,
  expectedSrgb: number,
): Promise<number> {
  const source = await pixel(device, texture, 4);
  for (const channel of source.slice(0, 3))
    expect(Math.abs(channel - expectedSrgb)).toBeLessThanOrEqual(1);
  expect(source[3]).toBe(255);
  const red = sampledSrgbPixel(source)[0];
  assert(red !== undefined);
  return red;
}

/** Complete Pack -> Registry -> GPU generation -> mip -> GPU sampling, without uploaded source pixels. */
export async function verifyGpuTextureGeneration(
  device: RhiDevice,
  factory: MipmapShaderModuleFactory,
  programs: TextureGeneratorPrograms,
  derivedPrograms: TextureGeneratorPrograms,
  options: TextureGeneratorFixtureOptions = {},
) {
  const assets = new AssetRegistry();
  assets.installDecoder(gpuTextureContribution.kind, gpuTextureContribution.decoder);
  assets.installDecoder(textureGeneratorContribution.kind, textureGeneratorContribution.decoder);
  const producer: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'gpu-texture-fixture',
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: producer.catalog, fetcher: producer.fetch },
        { dependencies, decoders },
      ),
  });
  assets.setCatalogSource(producer.catalog, producer.fetch);
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const store = new GpuResidencyCache();
  let rejectPreparation = false;
  store.configureGpuDevice(
    device,
    (gpu, descriptor) =>
      rejectPreparation && descriptor.label === 'test::gpu-paint'
        ? Promise.resolve(
            err(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'injected candidate program failure',
                hint: 'repair the candidate',
              }),
            ),
          )
        : factory(gpu, descriptor),
    device.caps,
  );
  const uploads = vi.spyOn(device.queue, 'writeTexture');
  const creates = vi.spyOn(device, 'createTexture');
  let activeDevice = device;
  let target: Texture | undefined;
  try {
    const derivedContent = gpuTextureOutputs(packageId, 'derived', {
      values: {},
      inputs: { source: guid('gpu-texture/paint/albedo') },
      programs: derivedPrograms,
      outputs: {
        result: {
          ...linear,
          shape: { viewDimension: '2d-array', extent: { width: 4, height: 4, layers: 2 } },
        },
      },
      transient: {},
      passes: [
        {
          kind: 'raster',
          program: { module: 'test::gpu-derived', fragmentEntry: 'derived' },
          reads: { source: { kind: 'input', name: 'source' } },
          writes: ['result'],
        },
      ],
    });
    const content = gpuTextureOutputs(packageId, 'paint', {
      values: { seed: 42, wear: 0 },
      inputs: {},
      programs,
      outputs: {
        albedo: { ...linear, format: 'rgba8unorm-srgb', colorSpace: 'srgb' },
        orm: linear,
        normal: linear,
      },
      transient: { height: { shape, format: 'r16float' } },
      passes: [
        {
          kind: 'raster',
          program: { module: 'test::gpu-paint', fragmentEntry: 'paint' },
          reads: {},
          writes: ['albedo', 'orm', 'height'],
        },
        {
          kind: 'raster',
          program: { module: 'test::gpu-normal', fragmentEntry: 'normal' },
          reads: { height: { kind: 'local', name: 'height' } },
          writes: ['normal'],
        },
      ],
    });
    const prepared = (
      await prepareRuntimePackContent(packageIdText, { ...content, ...derivedContent })
    ).unwrap();
    (await producer.admit(prepared)).unwrap();
    const handles = await Promise.all(
      ['albedo', 'orm', 'normal'].map(async (name) =>
        (await assets.load(guid(`gpu-texture/paint/${name}`), 'gpu-texture')).unwrap(),
      ),
    );
    const [handle, ormHandle, normalHandle] = handles;
    assert(handle !== undefined && ormHandle !== undefined && normalHandle !== undefined);
    const source = () => assets.read(handle).unwrap();
    expect(source()).not.toHaveProperty('data');
    expect(store.ensureResident(handle, source(), scope)).toMatchObject({
      ok: false,
      error: { code: 'asset-not-ready' },
    });
    await store.waitTextureData(Number(handle), scope);
    const first = store.ensureResident(handle, source(), scope).unwrap();
    const orm = store.ensureResident(ormHandle, assets.read(ormHandle).unwrap(), scope).unwrap();
    const normal = store
      .ensureResident(normalHandle, assets.read(normalHandle).unwrap(), scope)
      .unwrap();
    // Rejecting a frame leaves the whole generation available to the next ordinary submit.
    const rejected = store.prepareTextureMips().unwrap();
    assert(rejected);
    rejected.complete(false);
    const generate = async () => {
      const generation = store.prepareTextureMips().unwrap();
      assert(generation?.buffer);
      device.queue.submit([generation.buffer]).unwrap();
      generation.complete(true);
      await device.queue.onSubmittedWorkDone();
    };
    if (options.observe) await options.observe('generation', generate);
    else await generate();
    // Completed height intermediates must stop occupying the residency budget.
    expect(store.inspectTextureGenerators().reservedBytes).toBe(3 * 4 * (256 + 64 + 16 + 4 + 1));
    expect(uploads).not.toHaveBeenCalled();
    const albedoMip = await pixel(device, first.texture.handle, 4);
    for (const channel of albedoMip.slice(0, 3))
      expect(Math.abs(channel - 188)).toBeLessThanOrEqual(1);
    expect(await pixel(device, orm.texture.handle, 4)).toEqual([255, 0, 51, 255]);
    const normalMip = await pixel(device, normal.texture.handle, 4);
    expect(Math.abs(Number(normalMip[0]) - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(normalMip[1]) - 128)).toBeLessThanOrEqual(1);
    expect(normalMip[2]).toBeGreaterThan(195);
    expect(normalMip[2]).toBeLessThan(210);

    // A material-like textureLoad consumer renders 60 actual GPU frames; generation stays idle.
    target = device
      .createTexture({
        label: 'texture-generator-sampling-output',
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: 0x10 | 0x01,
      })
      .unwrap();
    const view = device.createTextureView(target, {}).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, texture: { sampleType: 'float' } }],
      })
      .unwrap();
    const module = (
      await factory(device, {
        code: `
      @group(0) @binding(0) var source: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
      }
      @fragment fn fs() -> @location(0) vec4<f32> { return textureLoad(source, vec2<i32>(0), 4); }
    `,
      })
    ).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const bindings = device
      .createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: first.view } }],
      })
      .unwrap();
    const warmAllocations = creates.mock.calls.length;
    for (let frame = 0; frame < 60; frame++) {
      expect(store.ensureResident(handle, source(), scope).unwrap().texture).toBe(first.texture);
      expect(store.prepareTextureMips().unwrap()).toBeUndefined();
      const submit = async () => {
        const encoder = device
          .createCommandEncoder({ label: `gpu-texture-consumer-${frame}` })
          .unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
      };
      if (options.observe && frame === 59) await options.observe('resident', submit);
      else await submit();
    }
    expect(creates.mock.calls.length).toBe(warmAllocations);
    expect(await pixel(device, target)).toEqual(sampledSrgbPixel(albedoMip));
    expect(uploads).not.toHaveBeenCalled();

    const generator = (await assets.load(guid('generator/paint'), 'texture-generator')).unwrap();
    assets.update(generator, { values: { seed: 42, wear: 0.5 } }).unwrap();
    // The full Renderer invalidates every sibling binding after an asset edit.
    // This must retain the accepted group until its replacement is submitted.
    for (const output of handles) store.invalidateTexture(Number(output), scope);
    expect(first.texture.isDestroyed).toBe(false);
    const retained = store.ensureResident(handle, source(), scope).unwrap();
    expect(retained.texture).toBe(first.texture);
    await store.waitTextureData(Number(handle), scope);
    const updated = store.ensureResident(handle, source(), scope).unwrap();
    expect(updated.texture).not.toBe(first.texture);
    const updatedOrm = store
      .ensureResident(ormHandle, assets.read(ormHandle).unwrap(), scope)
      .unwrap();
    const work = store.prepareTextureMips().unwrap();
    assert(work?.buffer);
    device.queue.submit([work.buffer]).unwrap();
    work.complete(true);
    await device.queue.onSubmittedWorkDone();
    const updatedColor = await pixel(device, updated.texture.handle, 4);
    for (const channel of updatedColor.slice(0, 3))
      expect(Math.abs(channel - 137)).toBeLessThanOrEqual(1);
    expect(await pixel(device, updatedOrm.texture.handle, 4)).toEqual([255, 128, 51, 255]);
    expect(uploads).not.toHaveBeenCalled();
    // A failed candidate must keep the accepted physical output, then recover on the next asset version.
    rejectPreparation = true;
    assets.update(generator, { values: { seed: 42, wear: 0.75 } }).unwrap();
    expect(store.ensureResident(handle, source(), scope).unwrap().texture).toBe(updated.texture);
    await store.waitTextureData(Number(handle), scope);
    expect(store.ensureResident(handle, source(), scope).unwrap().texture).toBe(updated.texture);
    expect(
      store
        .inspectTextureGenerators()
        .groups.some((group) => group.status === 'failed' && group.hasAccepted),
    ).toBe(true);
    expect(await pixel(device, updated.texture.handle, 4)).toEqual(updatedColor);
    rejectPreparation = false;
    assets.update(generator, { values: { seed: 43, wear: 0.5 } }).unwrap();
    store.ensureResident(handle, source(), scope).unwrap();
    await store.waitTextureData(Number(handle), scope);
    store.ensureResident(handle, source(), scope).unwrap();
    const repaired = store.prepareTextureMips().unwrap();
    assert(repaired?.buffer);
    device.queue.submit([repaired.buffer]).unwrap();
    repaired.complete(true);
    await device.queue.onSubmittedWorkDone();
    // A second generator consumes the first generator's mip chain and writes two array layers.
    const derivedHandle = (
      await assets.load(guid('gpu-texture/derived/result'), 'gpu-texture')
    ).unwrap();
    const derivedSource = () => assets.read(derivedHandle).unwrap();
    const generateDerived = async () => {
      let resident = store.ensureResident(derivedHandle, derivedSource(), scope);
      for (
        let attempt = 0;
        attempt < 4 && (store.isTexturePreparing(Number(derivedHandle), scope) || !resident.ok);
        attempt++
      ) {
        await store.waitTextureData(Number(derivedHandle), scope);
        resident = store.ensureResident(derivedHandle, derivedSource(), scope);
      }
      const next = resident.unwrap();
      const pending = store.prepareTextureMips().unwrap();
      assert(pending?.buffer);
      device.queue.submit([pending.buffer]).unwrap();
      pending.complete(true);
      await device.queue.onSubmittedWorkDone();
      return next;
    };
    const derived = await generateDerived();
    const inputRed = await sampledMipRed(
      device,
      store.ensureResident(handle, source(), scope).unwrap().texture.handle,
      137,
    );
    expect(await pixel(device, derived.texture.handle, 2, 0)).toEqual([inputRed, 0, 0, 255]);
    expect(await pixel(device, derived.texture.handle, 2, 1)).toEqual([inputRed, 255, 0, 255]);
    // Effective input-version propagation invalidates the downstream output too.
    assets.update(generator, { values: { seed: 42, wear: 0 } }).unwrap();
    const changedDerived = await generateDerived();
    expect(changedDerived.texture).not.toBe(derived.texture);
    const changedInputRed = await sampledMipRed(
      device,
      store.ensureResident(handle, source(), scope).unwrap().texture.handle,
      188,
    );
    expect(await pixel(device, changedDerived.texture.handle, 2, 1)).toEqual([
      changedInputRed,
      255,
      0,
      255,
    ]);
    expect(uploads).not.toHaveBeenCalled();
    expect(store.inspectTextureGenerators().groups.every((group) => group.status === 'ready')).toBe(
      true,
    );
    // Each Renderer owns its residency cache. Releasing one cannot retire a sibling's output.
    const sibling = new GpuResidencyCache();
    sibling.configureGpuDevice(device, factory, device.caps);
    try {
      sibling.ensureResident(handle, source(), scope);
      await sibling.waitTextureData(Number(handle), scope);
      const independent = sibling.ensureResident(handle, source(), scope).unwrap();
      const pending = sibling.prepareTextureMips().unwrap();
      assert(pending?.buffer);
      device.queue.submit([pending.buffer]).unwrap();
      pending.complete(true);
      await device.queue.onSubmittedWorkDone();
      expect(independent.texture).not.toBe(
        store.ensureResident(handle, source(), scope).unwrap().texture,
      );
      store.releaseUnreferenced(new Set());
      expect(sibling.ensureResident(handle, source(), scope).unwrap().texture).toBe(
        independent.texture,
      );
      const color = await pixel(device, independent.texture.handle, 4);
      for (const channel of color.slice(0, 3))
        expect(Math.abs(channel - 188)).toBeLessThanOrEqual(1);
    } finally {
      sibling.destroyAll();
    }
    if (options.recreateDevice) {
      // Recreate the GPU owner while keeping the same live registry, recipe and logical handles.
      store.ensureResident(handle, source(), scope);
      await store.waitTextureData(Number(handle), scope);
      store.ensureResident(handle, source(), scope).unwrap();
      const replacement = await options.recreateDevice();
      activeDevice = replacement.device;
      const replacementUploads = vi.spyOn(replacement.device.queue, 'writeTexture');
      try {
        store.configureGpuDevice(replacement.device, replacement.factory, replacement.device.caps);
        expect(store.ensureResident(handle, source(), scope).ok).toBe(false);
        await store.waitTextureData(Number(handle), scope);
        const recovered = store.ensureResident(handle, source(), scope).unwrap();
        const pending = store.prepareTextureMips().unwrap();
        assert(pending?.buffer);
        replacement.device.queue.submit([pending.buffer]).unwrap();
        pending.complete(true);
        await replacement.device.queue.onSubmittedWorkDone();
        const color = await pixel(replacement.device, recovered.texture.handle, 4);
        for (const channel of color.slice(0, 3))
          expect(Math.abs(channel - 188)).toBeLessThanOrEqual(1);
        expect(replacementUploads).not.toHaveBeenCalled();
      } finally {
        replacementUploads.mockRestore();
      }
    }
    store.releaseUnreferenced(new Set());
    await activeDevice.queue.onSubmittedWorkDone();
    expect(store.inspectTextureGenerators().reservedBytes).toBe(0);
    expect(store.inspectTextureGenerators().groups).toEqual([]);
    return { frames: 60, uploads: uploads.mock.calls.length, albedoMip, normalMip, updatedColor };
  } finally {
    uploads.mockRestore();
    creates.mockRestore();
    if (target !== undefined) device.destroyTexture(target);
    store.destroyAll();
    assets.dispose();
    producer.dispose();
  }
}
