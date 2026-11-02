import type { Buffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import * as webgpu from '../../../rhi-webgpu/src/index.js';
import * as webgl from '../../../rhi-wgpu/src/index.js';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { prepareLightTextureSliceResample } from '../prepare/extended-lighting/light-texture-resample';
import { COOKIE_MIP_LEVEL_COUNT, COOKIE_SLICE_SIZE } from '../prepare/extended-lighting/resources';
import {
  type AdmittedLightTextureResamplePrograms,
  loadEmittedLightTextureResamplePrograms,
} from './light-texture-resample-admitted.fixture';
import {
  expectedLightTextureF32Levels,
  packLightTextureLevel,
} from './light-texture-resample-reference';

const ALIGNMENT = 256;
const F32_MAX_ERROR = 2e-5;
const F32_RMS_ERROR = 2e-6;

function source(width: number, height: number): TextureAsset {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = (x * 37 + y * 11) & 255;
      data[at + 1] = (x * 5 + y * 17) & 255;
      data[at + 2] = ((x ^ y) * 13) & 255;
      data[at + 3] = 64 + (((x + y) * 7) % 192);
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

function readbackSize(): number {
  let bytes = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    bytes += Math.ceil((size * 16) / ALIGNMENT) * ALIGNMENT * size;
  }
  return bytes;
}

async function readFloatLevels(
  buffer: Buffer,
  execution: 'compute' | 'fragment',
): Promise<Float32Array[]> {
  const mapped = (await buffer.mapAsync(1)).unwrap();
  const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levels: Float32Array[] = [];
  let offset = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    const rowBytes =
      execution === 'compute' ? size * 16 : Math.ceil((size * 16) / ALIGNMENT) * ALIGNMENT;
    const values = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size * 4; x += 1) {
        values[y * size * 4 + x] = view.getFloat32(offset + y * rowBytes + x * 4, true);
      }
    }
    levels.push(values);
    offset += rowBytes * size;
  }
  return levels;
}

function expectF32(actual: Float32Array, expected: Float32Array, label: string): void {
  let maximum = 0;
  let squared = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    maximum = Math.max(maximum, delta);
    squared += delta * delta;
  }
  const rms = Math.sqrt(squared / expected.length);
  expect(maximum, `${label} maximum absolute f32 error`).toBeLessThanOrEqual(F32_MAX_ERROR);
  expect(rms, `${label} RMS f32 error`).toBeLessThanOrEqual(F32_RMS_ERROR);
}

function createTarget(device: RhiDevice): Texture {
  return device
    .createTexture({
      label: 'light-texture-resample-browser-target',
      size: { width: COOKIE_SLICE_SIZE, height: COOKIE_SLICE_SIZE, depthOrArrayLayers: 2 },
      mipLevelCount: COOKIE_MIP_LEVEL_COUNT,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba8unorm',
      usage:
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    })
    .unwrap();
}

async function readMip(
  device: RhiDevice,
  target: Texture,
  slice: number,
  mip: number,
): Promise<Uint8Array> {
  const size = COOKIE_SLICE_SIZE >> mip;
  const bytesPerRow = Math.max(ALIGNMENT, size * 4);
  const buffer = device
    .createBuffer({
      size: bytesPerRow * size,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  const encoder = device
    .createCommandEncoder({ label: 'light-texture-resample-browser-readback' })
    .unwrap();
  encoder.copyTextureToBuffer(
    { texture: target, mipLevel: mip, origin: { x: 0, y: 0, z: slice } },
    { buffer, bytesPerRow, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await buffer.mapAsync(1)).unwrap();
  const padded = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  device.destroyBuffer(buffer).unwrap();
  const tight = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1)
    tight.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + size * 4), row * size * 4);
  return tight;
}

async function verifyFragmentResampling(
  device: RhiDevice,
  makeModule: typeof webgpu.createShaderModuleImmediate,
  admitted: AdmittedLightTextureResamplePrograms,
): Promise<{ readonly backend: string; readonly consumedShaderHash: string }> {
  expect(device.caps.compute).toBe(device.caps.backendKind === 'webgpu');
  const consumedShaderSources = new Set<string>();
  const factory = {
    createShaderModule: (descriptor: { readonly code: string; readonly label?: string }) => {
      consumedShaderSources.add(descriptor.code);
      return makeModule(device, descriptor);
    },
  };
  const target = createTarget(device);
  let ordinaryConsumerTarget: Texture | undefined;
  try {
    const cases = [source(7, 5), source(513, 257)];
    for (let slice = 0; slice < cases.length; slice += 1) {
      const asset = cases[slice] as TextureAsset;
      const readback = device
        .createBuffer({
          size: readbackSize(),
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        })
        .unwrap();
      try {
        const result = prepareLightTextureSliceResample({
          device,
          factory,
          programs: admitted,
          target,
          slice,
          asset,
          execution: 'fragment',
          intermediateReadback: readback,
        });
        expect(
          result.ok,
          result.ok
            ? ''
            : JSON.stringify({
                code: result.error.code,
                expected: result.error.expected,
                hint: result.error.hint,
                detail: result.error.detail,
              }),
        ).toBe(true);
        if (!result.ok) throw result.error;

        const encoder = device
          .createCommandEncoder({ label: 'light-texture-resample-browser-frame' })
          .unwrap();
        const encoded = result.value.execute(encoder);
        expect(
          encoded.ok,
          encoded.ok
            ? ''
            : JSON.stringify({ expected: encoded.error.expected, hint: encoded.error.hint }),
        ).toBe(true);
        if (!encoded.ok) throw encoded.error;

        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completion = device.queue.onSubmittedWorkDone();
        result.value.submitted(completion);
        await completion;
        const expected = expectedLightTextureF32Levels(asset);
        const actualFloat = await readFloatLevels(readback, 'fragment');
        for (let mip = 0; mip < COOKIE_MIP_LEVEL_COUNT; mip += 1) {
          const actual = await readMip(device, target, slice, mip);
          const reference = expected[mip] as Float32Array;
          const packedReference = packLightTextureLevel(reference);
          let maximum = 0;
          for (let i = 0; i < actual.length; i += 1)
            maximum = Math.max(maximum, Math.abs((actual[i] ?? 0) - (packedReference[i] ?? 0)));
          expect(
            maximum,
            `${device.caps.backendKind}, ${asset.shape.extent.width}x${asset.shape.extent.height}, mip ${mip}`,
          ).toBeLessThanOrEqual(1);
          expectF32(
            actualFloat[mip] as Float32Array,
            reference,
            `${device.caps.backendKind}, ${asset.shape.extent.width}x${asset.shape.extent.height}, mip ${mip}`,
          );
        }
      } finally {
        device.destroyBuffer(readback).unwrap();
      }
    }

    expect(consumedShaderSources.has(admitted.fragment.wgsl)).toBe(true);

    const sourceView = device
      .createTextureView(target, {
        label: 'light-texture-resample-ordinary-consumer-view',
        dimension: '2d-array',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 2,
      })
      .unwrap();
    const consumerLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 2,
            texture: { sampleType: 'float', viewDimension: '2d-array' },
          },
        ],
      })
      .unwrap();
    const consumerGroup = device
      .createBindGroup({
        layout: consumerLayout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: sourceView } }],
      })
      .unwrap();
    const consumerModule = makeModule(device, {
      code: `
@group(0) @binding(0) var cookies: texture_2d_array<f32>;
struct Out { @builtin(position) position: vec4<f32>, }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: Out; out.position = vec4<f32>(p[i], 0.0, 1.0); return out;
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(cookies, vec2<i32>(p.xy), 0, 0);
}
`,
      label: 'light-texture-resample-ordinary-consumer',
    }).unwrap();
    const consumerPipeline = device
      .createRenderPipeline({
        label: 'light-texture-resample-ordinary-consumer',
        layout: device.createPipelineLayout({ bindGroupLayouts: [consumerLayout] }).unwrap(),
        primitive: { topology: 'triangle-list' },
        vertex: { module: consumerModule, entryPoint: 'vs', buffers: [] },
        fragment: {
          module: consumerModule,
          entryPoint: 'fs',
          targets: [{ format: 'rgba8unorm' }],
        },
      })
      .unwrap();
    ordinaryConsumerTarget = device
      .createTexture({
        label: 'light-texture-resample-ordinary-consumer-target',
        size: { width: COOKIE_SLICE_SIZE, height: COOKIE_SLICE_SIZE, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const consumerView = device.createTextureView(ordinaryConsumerTarget, {}).unwrap();
    const consumerEncoder = device
      .createCommandEncoder({ label: 'light-texture-resample-ordinary-consumer' })
      .unwrap();
    const consumerPass = consumerEncoder.beginRenderPass({
      label: 'light-texture-resample-ordinary-consumer',
      colorAttachments: [
        {
          view: consumerView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    consumerPass.setPipeline(consumerPipeline);
    consumerPass.setBindGroup(0, consumerGroup);
    consumerPass.draw(3);
    consumerPass.end();
    device.queue.submit([consumerEncoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const consumed = await readMip(device, ordinaryConsumerTarget, 0, 0);
    const published = await readMip(device, target, 0, 0);
    expect(consumed).toEqual(published);
    return { backend: device.caps.backendKind, consumedShaderHash: admitted.fragment.hash };
  } finally {
    await device.queue.onSubmittedWorkDone();
    if (ordinaryConsumerTarget !== undefined)
      device.destroyTexture(ordinaryConsumerTarget).unwrap();
    device.destroyTexture(target).unwrap();
  }
}

async function verifyComputeResampling(
  device: RhiDevice,
  makeModule: typeof webgpu.createShaderModuleImmediate,
  admitted: AdmittedLightTextureResamplePrograms,
): Promise<{ readonly backend: string; readonly consumedShaderHash: string }> {
  expect(device.caps.backendKind).toBe('webgpu');
  expect(device.caps.compute).toBe(true);
  const target = createTarget(device);
  const consumedShaderSources = new Set<string>();
  const factory = {
    createShaderModule: (descriptor: { readonly code: string; readonly label?: string }) => {
      consumedShaderSources.add(descriptor.code);
      return makeModule(device, descriptor);
    },
  };
  try {
    const cases = [source(7, 5), source(513, 257)];
    for (const [slice, asset] of cases.entries()) {
      const readback = device
        .createBuffer({
          size: readbackSize(),
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        })
        .unwrap();
      try {
        const prepared = prepareLightTextureSliceResample({
          device,
          factory,
          programs: admitted,
          target,
          slice,
          asset,
          execution: 'compute',
          intermediateReadback: readback,
        });
        expect(prepared.ok, prepared.ok ? '' : prepared.error.expected).toBe(true);
        if (!prepared.ok) throw prepared.error;
        const encoder = device
          .createCommandEncoder({ label: 'admitted-light-texture-resample-compute' })
          .unwrap();
        const encoded = prepared.value.execute(encoder);
        expect(encoded.ok, encoded.ok ? '' : encoded.error.expected).toBe(true);
        if (!encoded.ok) {
          prepared.value.discard();
          throw encoded.error;
        }
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completion = device.queue.onSubmittedWorkDone();
        prepared.value.submitted(completion);
        await completion;

        const actualFloat = await readFloatLevels(readback, 'compute');
        const expectedFloat = expectedLightTextureF32Levels(asset);
        for (let mip = 0; mip < COOKIE_MIP_LEVEL_COUNT; mip += 1) {
          const expectedLevel = expectedFloat[mip] as Float32Array;
          expectF32(
            actualFloat[mip] as Float32Array,
            expectedLevel,
            `admitted WebGPU compute ${asset.shape.extent.width}x${asset.shape.extent.height} mip ${mip}`,
          );
          const actualPacked = await readMip(device, target, slice, mip);
          const expectedPacked = packLightTextureLevel(expectedLevel);
          let maximum = 0;
          for (let index = 0; index < actualPacked.length; index += 1) {
            maximum = Math.max(
              maximum,
              Math.abs((actualPacked[index] ?? 0) - (expectedPacked[index] ?? 0)),
            );
          }
          expect(maximum, `admitted WebGPU compute packed mip ${mip}`).toBeLessThanOrEqual(1);
        }
      } finally {
        device.destroyBuffer(readback).unwrap();
      }
    }
    expect(consumedShaderSources.has(admitted.compute.wgsl)).toBe(true);
    return { backend: device.caps.backendKind, consumedShaderHash: admitted.compute.hash };
  } finally {
    await device.queue.onSubmittedWorkDone();
    device.destroyTexture(target).unwrap();
  }
}

it('executes admitted production resampling on WebGPU compute/fragment and wgpu-WebGL2 fragment', async () => {
  const admitted = await loadEmittedLightTextureResamplePrograms();
  const webgpuAdapter = (await webgpu.requestAdapter()).unwrap();
  const webgpuDevice = (await webgpuAdapter.requestDevice()).unwrap();
  const compute = await verifyComputeResampling(
    webgpuDevice,
    webgpu.createShaderModuleImmediate,
    admitted,
  );
  const webgpuFragment = await verifyFragmentResampling(
    webgpuDevice,
    webgpu.createShaderModuleImmediate,
    admitted,
  );

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  document.body.append(canvas);
  await webgl.ensureReady();
  const webglAdapter = (await webgl.requestAdapter(undefined, canvas)).unwrap();
  const webglDevice = (await webglAdapter.requestDevice()).unwrap();
  expect(webglDevice.caps.backendKind).toBe('wgpu-webgl2');
  let webglFragment: { readonly backend: string; readonly consumedShaderHash: string };
  try {
    webglFragment = await verifyFragmentResampling(
      webglDevice,
      webgl.createShaderModuleImmediate,
      admitted,
    );
  } finally {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
  // biome-ignore lint/suspicious/noConsole: emitted manifest and consumed artifact identity evidence
  console.log(
    JSON.stringify({
      admittedManifest: admitted.publication,
      gpuConsumers: [compute, webgpuFragment, webglFragment],
    }),
  );
}, 120_000);
