import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroupLayout, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import {
  createShaderModule as createWebGpuShader,
  requestAdapter as webgpuAdapter,
} from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import {
  createShaderModule,
  ensureReady,
  requestAdapter as webglAdapter,
} from '../../../rhi-wgpu/src/index';
import common from '../../../shader/src/common.wgsl?raw';
import fxaa from '../../../shader/src/fxaa.wgsl?raw';
import outputEncoding from '../../../shader/src/output-encoding.wgsl?raw';
import tonemap from '../../../shader/src/tonemap.wgsl?raw';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';
import { addTypedOutputTransformPass } from '../typed-render-graph-primitives';

async function open(kind: 'webgl' | 'webgpu') {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  await ensureReady();
  const adapter = await (kind === 'webgl' ? webglAdapter(undefined, canvas) : webgpuAdapter());
  const device = (await adapter.unwrap().requestDevice()).unwrap();
  return {
    device,
    close: () => {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
async function shader(device: RhiDevice, source: string): Promise<ShaderModule> {
  const code = await composeShader(
    source,
    { 'forgeax_view::common': common, 'forgeax_view::output_encoding': outputEncoding },
    {
      STORAGE_BUFFER_AVAILABLE: false,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PER_INSTANCE_REGION: false,
    },
  );
  return device.caps.backendKind === 'wgpu-webgl2'
    ? (await createShaderModule(device, { code })).unwrap()
    : (await createWebGpuShader(device, { code })).unwrap();
}
function fixture(w: number, h: number, transpose = false): Uint8Array {
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = transpose ? y : x,
        v = transpose ? x : y;
      // A sloped high-contrast edge plus smooth subpixel coverage and a second
      // detached edge. Transposition changes only the axis, never the image.
      const distance = v - 0.31 * u - 27.17;
      const coverage = Math.max(0, Math.min(1, distance + 0.5));
      const value = v > 0.17 * u + 88.4 ? 25 : Math.round(25 + 211 * coverage);
      bytes.set([value, value, value, 255], (y * w + x) * 4);
    }
  return bytes;
}
async function read(
  device: RhiDevice,
  texture: import('@forgeax/engine-rhi').Texture,
  w: number,
  h: number,
  mipLevel = 0,
  bytesPerPixel = 4,
) {
  const stride = Math.ceil((w * bytesPerPixel) / 256) * 256;
  const buffer = device.createBuffer({ size: stride * h, usage: 0x09 }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  encoder.copyTextureToBuffer({ texture, mipLevel }, { buffer, bytesPerRow: stride }, [w, h, 1]);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const mapped = (await buffer.mapAsync(1)).unwrap();
  const raw = new Uint8Array(mapped.getMappedRange().unwrap());
  const result = new Uint8Array(w * h * bytesPerPixel);
  for (let y = 0; y < h; y++)
    result.set(raw.subarray(y * stride, y * stride + w * bytesPerPixel), y * w * bytesPerPixel);
  mapped.unmap();
  device.destroyBuffer(buffer).unwrap();
  return result;
}
async function runFxaa(
  device: RhiDevice,
  module: ShaderModule,
  w: number,
  h: number,
  data: Uint8Array,
) {
  const input = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 0x06 }).unwrap();
  const output = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 0x11 }).unwrap();
  const params = device.createBuffer({ size: 16, usage: 0x48 }).unwrap();
  try {
    device.queue.writeTexture({ texture: input }, data, { bytesPerRow: w * 4 }, [w, h, 1]).unwrap();
    device.queue.writeBuffer(params, 0, new Uint8Array(16)).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
          { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs_main', buffers: [] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(input, {}).unwrap(),
            },
          },
          {
            binding: 1,
            resource: {
              kind: 'sampler',
              value: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
            },
          },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: params } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(output, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    return await read(device, output, w, h);
  } finally {
    device.destroyTexture(input).unwrap();
    device.destroyTexture(output).unwrap();
    device.destroyBuffer(params).unwrap();
  }
}

function maxByteError(first: Uint8Array, second: Uint8Array): number {
  expect(first.length).toBe(second.length);
  return first.reduce(
    (maximum, byte, index) => Math.max(maximum, Math.abs(byte - (second[index] ?? Number.NaN))),
    0,
  );
}

it('FXAA uses the same pixel grid on WebGL/WebGPU and pairs edge gradients with their signed step', async () => {
  const w = 257,
    h = 193;
  const results: Uint8Array[] = [];
  for (const kind of ['webgl', 'webgpu'] as const) {
    const host = await open(kind);
    try {
      const module = await shader(host.device, fxaa);
      const result = await runFxaa(host.device, module, w, h, fixture(w, h));
      const transposed = await runFxaa(host.device, module, h, w, fixture(h, w, true));
      let maxAxisError = 0,
        changed = 0;
      const input = fixture(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          maxAxisError = Math.max(
            maxAxisError,
            Math.abs(
              (result[(y * w + x) * 4] ?? Number.NaN) - (transposed[(x * h + y) * 4] ?? Number.NaN),
            ),
          );
          changed += (result[(y * w + x) * 4] ?? Number.NaN) !== input[(y * w + x) * 4] ? 1 : 0;
        }
      expect(maxAxisError, `${kind} transposed-edge error in UNORM bytes`).toBeLessThanOrEqual(1);
      expect(changed, 'FXAA actually filters edges').toBeGreaterThan(100);
      // Falsify the same comparison with a one-texel grid error through the
      // real GPU path. A filtering tolerance must still reject misalignment.
      const shiftedInput = input.slice();
      for (let y = 0; y < h; y++) {
        shiftedInput.set(input.subarray((y * w + 1) * 4, (y + 1) * w * 4), y * w * 4);
      }
      const shifted = await runFxaa(host.device, module, w, h, shiftedInput);
      expect(maxByteError(result, shifted), `${kind} one-texel grid falsifier`).toBeGreaterThan(1);
      results.push(result);
    } finally {
      host.close();
    }
  }
  // The final color uses hardware filtering and may differ by one UNORM
  // quantization step. Exact source texels and equal-grid Output Transform
  // loads retain their strict contract; luma-search branch errors exceed this.
  const [webgl, webgpu] = results;
  if (webgl === undefined || webgpu === undefined) throw new Error('missing backend readback');
  expect(maxByteError(webgl, webgpu), 'same-input backend UNORM error').toBeLessThanOrEqual(1);
}, 60_000);

it('Output Transform preserves the backend pixel grid and scaled/mip attachment sampling', async () => {
  const halfResults: Uint8Array[] = [];
  for (const kind of ['webgl', 'webgpu'] as const) {
    const host = await open(kind),
      device = host.device;
    try {
      const module = await shader(device, tonemap);
      for (const [w, h, mip, format] of [
        [257, 193, 0, 'rgba8unorm'],
        [131, 97, 0, 'rgba8unorm'],
        [131, 97, 2, 'rgba8unorm'],
        [2532, 1170, 0, 'rgba16float'],
      ] as const) {
        const half = format === 'rgba16float';
        const iw = half ? w : 257,
          ih = half ? h : 193,
          bytesPerPixel = half ? 8 : 4;
        const data = new Uint8Array(iw * ih * bytesPerPixel);
        const halfValues = new DataView(data.buffer);
        for (let y = 0; y < ih; y++)
          for (let x = 0; x < iw; x++) {
            if (half) {
              const offset = (y * iw + x) * 8;
              // Exact binary16 checker values reveal interpolation below an
              // UNORM byte. Same-input backend comparison retains every binary16 bit.
              halfValues.setUint16(offset, (x + y) % 2 === 0 ? 0x3c00 : 0, true);
              halfValues.setUint16(offset + 2, x % 3 === 0 ? 0x3800 : 0, true);
              halfValues.setUint16(offset + 4, 0x3400, true);
              halfValues.setUint16(offset + 6, 0x3c00, true);
            } else data.set([x % 256, y, 73, 255], (y * iw + x) * 4);
          }
        const input = device.createTexture({ size: [iw, ih], format, usage: 0x06 }).unwrap();
        const params = device.createBuffer({ size: 32, usage: 0x48 }).unwrap();
        const bytes = new Uint8Array(32);
        new DataView(bytes.buffer).setFloat32(0, 1, true);
        device.queue
          .writeTexture({ texture: input }, data, { bytesPerRow: iw * bytesPerPixel }, [iw, ih, 1])
          .unwrap();
        const graph = new RenderGraphBuilder<RenderPipelineFrame>();
        const inputHandle = graph
          .importTexture(
            'source',
            { size: { width: iw, height: ih }, format, usage: 0x06 },
            () => input,
          )
          .unwrap();
        const inputTarget = {
          texture: inputHandle,
          view: graph.view(inputHandle).unwrap(),
          format,
          sampleCount: 1 as const,
        };
        const output = createRenderPipelineTarget(
          graph,
          'destination',
          {
            size: { width: w * 2 ** mip, height: h * 2 ** mip },
            format,
            mipLevelCount: mip + 1,
          },
          { baseMipLevel: mip, mipLevelCount: 1 },
        ).unwrap();
        addTypedOutputTransformPass(graph, inputTarget, output, {
          fragmentEntryPoint: 'fs_present',
        }).unwrap();
        // Declare readback through the same graph, so COPY_SRC is derived.
        let outputTexture: import('@forgeax/engine-rhi').Texture | undefined;
        graph
          .addCopyPass('readback-access', {
            accesses: [{ resource: output.view, usage: 'copy-src' }],
            encode: ({ resources }) => {
              outputTexture = resources.texture(output.texture).unwrap();
            },
          })
          .unwrap();
        const compiled = graph
          .compile({ device, surfaceSize: { width: 911, height: 503 } })
          .unwrap();
        const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
        const emptyGroup = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        const frame = {
          encoder,
          targetW: 911,
          targetH: 503,
          postProcessParams: new Map([['forgeax::standard::output-transform', bytes]]),
          runtime: {
            device,
            errorRegistry: {
              fire: (error: unknown) => {
                throw error;
              },
            },
            lookupPostProcess: () => ({
              source: 'test',
              params: { byteSize: 32, defaultValue: bytes },
            }),
            getPostProcessParamsBuffer: () => params,
            getPostProcessPipeline: (_id: string, layout: BindGroupLayout) =>
              device
                .createRenderPipeline({
                  layout: device
                    .createPipelineLayout({ bindGroupLayouts: [empty, layout] })
                    .unwrap(),
                  vertex: { module, entryPoint: 'vs_main', buffers: [] },
                  fragment: { module, entryPoint: 'fs_present', targets: [{ format }] },
                  primitive: { topology: 'triangle-list' },
                })
                .unwrap(),
          },
        } as unknown as RenderPipelineFrame;
        // Empty group zero is still required by the explicit WebGPU pipeline layout.
        const original = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (descriptor) => {
          const pass = original(descriptor);
          pass.setBindGroup(0, emptyGroup);
          return pass;
        };
        try {
          compiled.execute(frame).unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          if (outputTexture === undefined) throw new Error('declared output was not resolved');
          const result = await read(device, outputTexture, w, h, mip, bytesPerPixel);
          if (half) {
            // Equal grids retain exact source texels, including every binary16 bit.
            expect(
              result.reduce((count, byte, index) => count + (byte === data[index] ? 0 : 1), 0),
              `${kind} equal-grid binary16 source byte differences`,
            ).toBe(0);
            halfResults.push(result);
            continue;
          }
          let error = 0;
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const sx = Math.max(0, Math.min(iw - 1, ((x + 0.5) * iw) / w - 0.5));
              const sy = Math.max(0, Math.min(ih - 1, ((y + 0.5) * ih) / h - 0.5));
              const left = Math.floor(sx),
                right = Math.min(iw - 1, left + 1);
              const expected = (left % 256) * (1 - sx + left) + (right % 256) * (sx - left);
              error = Math.max(
                error,
                Math.abs((result[(y * w + x) * 4] ?? Number.NaN) - expected),
                Math.abs((result[(y * w + x) * 4 + 1] ?? Number.NaN) - sy),
                Math.abs((result[(y * w + x) * 4 + 2] ?? Number.NaN) - 73),
              );
            }
          expect(error, `${kind} ${w}x${h} mip ${mip}: bilinear UNORM error`).toBeLessThanOrEqual(
            1,
          );
          expect([...bytes.slice(24)], 'camera params remain unchanged').toEqual(Array(8).fill(0));
        } finally {
          await compiled.retire();
          device.destroyTexture(input).unwrap();
          device.destroyBuffer(params).unwrap();
        }
      }
    } finally {
      host.close();
    }
  }
  expect(
    halfResults[0]?.reduce((n, byte, i) => n + (byte === halfResults[1]?.[i] ? 0 : 1), 0),
    'same-input binary16 backend byte differences',
  ).toBe(0);
}, 60_000);
