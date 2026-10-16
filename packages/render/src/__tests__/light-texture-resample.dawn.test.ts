import { parseKtx2, transcodeKtx2 } from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  type V7Tape as Tape,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { resampleLightTextureSlice } from '../prepare/extended-lighting/light-texture-resample';
import {
  COOKIE_MIP_LEVEL_COUNT,
  COOKIE_SLICE_CAPACITY,
  COOKIE_SLICE_SIZE,
} from '../prepare/extended-lighting/resources';
import { prepareCookieProjection } from '../prepare/extended-lighting/spot-modifiers';

const BC7 = 'bc7-rgba-unorm-srgb';

/** A stained-glass style panel: hue bands, a sharp diagonal edge, and a fine checker. */
function panelPixels(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const offset = (y * width + x) * 4;
      const band = Math.floor(u * 6) % 3;
      const edge = u + v > 1 ? 1 : 0;
      const checker = ((x >> 3) + (y >> 3)) % 2;
      data[offset] = band === 0 ? 230 : 40 + 150 * edge;
      data[offset + 1] = band === 1 ? 210 : 30 + 60 * checker;
      data[offset + 2] = band === 2 ? 220 : Math.round(255 * v);
      data[offset + 3] = 255;
    }
  }
  return data;
}

function rgba8(width: number, height: number): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data: panelPixels(width, height),
  };
}

/**
 * The production KTX2 path: UASTC encode with offline mips, then transcode to
 * BC7. The same KTX2 transcoded to RGBA8 is the decoded reference, so the
 * comparison isolates the GPU projection from UASTC encoding loss.
 */
async function bc7(
  width: number,
  height: number,
): Promise<{ readonly asset: TextureAsset; readonly decoded: TextureAsset }> {
  const encoded = await basisEncode(panelPixels(width, height), {
    mode: 'uastc-ldr',
    width,
    height,
    srgb: true,
    perceptual: true,
    uastcSupercompression: false,
    mipGen: true,
  });
  if (!encoded.ok) throw new Error(`basis encode failed: ${encoded.error.code}`);
  const parsed = await parseKtx2(encoded.value);
  if (!parsed.ok) throw new Error(`ktx2 parse failed: ${parsed.error.code}`);
  const transcode = async (format: typeof BC7 | 'rgba8unorm-srgb'): Promise<TextureAsset> => {
    const transcoded = await transcodeKtx2(parsed.value, format);
    if (!transcoded.ok) throw new Error(`ktx2 transcode failed: ${transcoded.error.code}`);
    const mips = format === BC7 ? transcoded.value.mips : transcoded.value.mips.slice(0, 1);
    const data = new Uint8Array(mips.reduce((size, mip) => size + mip.data.length, 0));
    let offset = 0;
    for (const mip of mips) {
      data.set(mip.data, offset);
      offset += mip.data.length;
    }
    return {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height } },
      format,
      colorSpace: 'srgb',
      mips: format === BC7 ? { kind: 'packed', levelCount: mips.length } : { kind: 'none' },
      data,
    };
  };
  return { asset: await transcode(BC7), decoded: await transcode('rgba8unorm-srgb') };
}

function cpuChain(asset: TextureAsset): Uint8Array {
  const source = prepareCookieProjection(asset)?.source;
  if (source?.kind !== 'mip-chain') throw new Error('expected a CPU mip chain');
  return source.data;
}

function chainLevel(chain: Uint8Array, level: number): Uint8Array {
  let offset = 0;
  for (let mip = 0; mip < level; mip += 1) offset += (COOKIE_SLICE_SIZE >> mip) ** 2 * 4;
  return chain.subarray(offset, offset + (COOKIE_SLICE_SIZE >> level) ** 2 * 4);
}

function createArray(device: RhiDevice): Texture {
  return device
    .createTexture({
      label: 'light-texture-resample-target',
      size: {
        width: COOKIE_SLICE_SIZE,
        height: COOKIE_SLICE_SIZE,
        depthOrArrayLayers: COOKIE_SLICE_CAPACITY,
      },
      mipLevelCount: COOKIE_MIP_LEVEL_COUNT,
      format: 'rgba8unorm',
      usage:
        GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
}

async function readSlice(
  device: RhiDevice,
  texture: Texture,
  slice: number,
  level: number,
): Promise<Uint8Array> {
  const size = COOKIE_SLICE_SIZE >> level;
  const bytesPerRow = Math.max(256, size * 4);
  const readback = device
    .createBuffer({
      size: bytesPerRow * size,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  encoder.copyTextureToBuffer(
    { texture: texture as never, mipLevel: level, origin: { x: 0, y: 0, z: slice } },
    { buffer: readback as never, bytesPerRow, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readback.mapAsync(1)).unwrap();
  const padded = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  device.destroyBuffer(readback).unwrap();
  const tight = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    tight.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + size * 4), row * size * 4);
  }
  return tight;
}

function difference(actual: Uint8Array, expected: Uint8Array): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (index % 4 === 3) continue;
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    max = Math.max(max, delta);
    sum += delta;
    count += 1;
  }
  return { max, mean: sum / count };
}

async function openFreshReplay(tape: Tape) {
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  return replay;
}

it('fills light-texture slices on the GPU with the CPU filter, including BC7 KTX2 sources', {
  timeout: 180_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const bcSupported = adapter.features.has('texture-compression-bc');
  const device = (
    await adapter.requestDevice({
      requiredFeatures: bcSupported ? ['texture-compression-bc'] : [],
    })
  ).unwrap();
  const immediate = (
    recorder.backend.rhi as {
      createShaderModuleImmediate?: typeof webgpu.createShaderModuleImmediate;
    }
  ).createShaderModuleImmediate;
  if (immediate === undefined) throw new Error('recorder backend lacks immediate shader modules');
  const factory = {
    createShaderModule: (descriptor: { readonly code: string; readonly label?: string }) =>
      immediate(device, descriptor),
  };
  const target = createArray(device);
  const timings: Record<string, number> = {};
  const resample = async (label: string, slice: number, asset: TextureAsset) => {
    const start = performance.now();
    const result = resampleLightTextureSlice({ device, factory, target, slice, asset });
    await device.queue.onSubmittedWorkDone();
    timings[label] = performance.now() - start;
    expect(
      result.ok,
      result.ok ? '' : JSON.stringify(result.error.detail ?? result.error.expected),
    ).toBe(true);
  };
  try {
    // Parity: non-square rgba8 sources through both paths. 400x160 box-filters
    // x and bilinearly upsamples y; 1024x512 exercises two-axis integration.
    const parity = [rgba8(400, 160), rgba8(1024, 512), rgba8(256, 256)];
    for (const [slice, asset] of parity.entries()) {
      await resample(
        `rgba8-${asset.shape.extent.width}x${asset.shape.extent.height}`,
        slice,
        asset,
      );
      const cpuStart = performance.now();
      const chain = cpuChain(asset);
      timings[`cpu-${asset.shape.extent.width}x${asset.shape.extent.height}`] =
        performance.now() - cpuStart;
      for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
        const gpu = await readSlice(device, target, slice, level);
        const delta = difference(gpu, chainLevel(chain, level));
        expect(delta.max, `slice ${slice} mip ${level}`).toBeLessThanOrEqual(1);
      }
    }
    // A 256x256 source copies texel for texel at unit scale.
    const identity = await readSlice(device, target, 2, 0);
    const exact = chainLevel(cpuChain(parity[2] as TextureAsset), 0);
    expect(difference(identity, exact).max).toBeLessThanOrEqual(1);

    if (!bcSupported) {
      // biome-ignore lint/suspicious/noConsole: adapter capability is test evidence
      console.log(JSON.stringify({ bc7: 'texture-compression-bc unavailable', timings }));
      return;
    }

    // BC7 KTX2 sources with offline mips, captured by the RHI Debug recorder.
    // Only level 0 is read, so the slice matches the CPU chain of the decoded
    // UASTC pixels up to the UASTC -> BC7 transcode loss.
    const large = await bc7(1024, 512);
    const small = await bc7(400, 160);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await resample('bc7-1024x512', 5, large.asset);
    await resample('bc7-400x160', 6, small.asset);
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await capture).unwrap().bytes).unwrap();

    const live: Uint8Array[][] = [];
    for (const [slice, asset] of [
      [5, large.decoded],
      [6, small.decoded],
    ] as const) {
      const chain = cpuChain(asset);
      const levels: Uint8Array[] = [];
      for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
        const gpu = await readSlice(device, target, slice, level);
        levels.push(gpu);
        const delta = difference(gpu, chainLevel(chain, level));
        // biome-ignore lint/suspicious/noConsole: BC7 residual is effect evidence
        if (level === 0) console.log(JSON.stringify({ slice, bc7Residual: delta }));
        expect(delta.mean, `bc7 slice ${slice} mip ${level} mean`).toBeLessThan(1);
        expect(delta.max, `bc7 slice ${slice} mip ${level} max`).toBeLessThanOrEqual(8);
      }
      live.push(levels);
    }

    const model = buildFrameModel(tape);
    const kernels = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('fn light_texture_resample')),
    );
    // One resample and eight 2x2 reductions per source.
    expect(kernels.length).toBe(2 * COOKIE_MIP_LEVEL_COUNT);
    const sourceFormats = model.resources.flatMap((resource) => {
      const descriptor = resource.descriptor as { desc?: { format?: string } } | undefined;
      return descriptor?.desc?.format === BC7 ? [resource.resourceId] : [];
    });
    expect(sourceFormats.length).toBe(2);
    const copies = model.commands.filter((command) => command.kind === 'copyBufferToTexture');
    const copiedMips = copies.map(
      (command) => (command.params as { destination: { mipLevel: number } }).destination.mipLevel,
    );
    expect(copiedMips.sort((a, b) => a - b)).toEqual(
      Array.from({ length: COOKIE_MIP_LEVEL_COUNT }, (_, mip) => [mip, mip]).flat(),
    );
    // The only 32-layer texture on the tape is the light-texture array.
    const targetId = model.resources.find((resource) => {
      const descriptor = resource.descriptor as
        | { desc?: { size?: { depthOrArrayLayers?: number } } }
        | undefined;
      return descriptor?.desc?.size?.depthOrArrayLayers === COOKIE_SLICE_CAPACITY;
    })?.resourceId;
    expect(targetId).toBeDefined();

    // Replay the capture on a fresh device through each source's last (1x1)
    // reduction: the packed staging buffer equals the live slice mips byte
    // for byte.
    const reduceWorks = kernels.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'light_texture_reduce'),
    );
    expect(reduceWorks.length).toBe(2 * (COOKIE_MIP_LEVEL_COUNT - 1));
    const packWorks = [
      reduceWorks[COOKIE_MIP_LEVEL_COUNT - 2],
      reduceWorks[2 * (COOKIE_MIP_LEVEL_COUNT - 1) - 1],
    ].filter((work) => work !== undefined);
    expect(packWorks.length).toBe(2);
    const replay = await openFreshReplay(tape);
    try {
      for (const [index, work] of packWorks.entries()) {
        const packedId = work.bindings.find((binding) => binding.binding === 3)?.resourceId;
        expect(packedId).toBeTruthy();
        const replayed = (
          await replay.readResourceAtWork(packedId as string, work.workIndex)
        ).unwrap();
        let offset = 0;
        for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
          const size = COOKIE_SLICE_SIZE >> level;
          const rowBytes = Math.max(256, size * 4);
          const tight = new Uint8Array(size * size * 4);
          for (let row = 0; row < size; row += 1) {
            const start = offset + row * rowBytes;
            tight.set(replayed.bytes.subarray(start, start + size * 4), row * size * 4);
          }
          offset += rowBytes * size;
          const expected = live[index]?.[level] as Uint8Array;
          expect(
            difference(tight, expected).max,
            `replay work ${work.workIndex} mip ${level}`,
          ).toBe(0);
        }
      }
    } finally {
      (await replay.dispose()).unwrap();
    }
    // biome-ignore lint/suspicious/noConsole: one-shot resample cost is perf evidence
    console.log(JSON.stringify({ timings }));
  } finally {
    device.destroyTexture(target).unwrap();
    (await recorder.dispose()).unwrap();
  }
});
