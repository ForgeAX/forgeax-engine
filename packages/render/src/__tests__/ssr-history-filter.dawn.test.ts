import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { gbufferSource } from './standard-gbuffer.fixture';

it.each([
  'plane',
  'depth-edge',
  'normal-edge',
  'missing',
  'partial-miss',
  'confidence',
] as const)('reconstructs subpixel SSR history without borrowing incompatible receivers (%s)', async (kind) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = readFileSync(resolve('packages/shader/src/ssr-temporal.wgsl'), 'utf8');
  const compiled = await compiler.compileShader(
    `${source}
@group(1) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_history() {
  // Half-resolution history centers are full pixels 0.5 and 2.5. A
  // half-full-pixel jitter change is a quarter-history-pixel displacement.
  let coordinates = array<vec2<f32>, 5>(vec2<f32>(0.125), vec2<f32>(0.25, 0.125),
    vec2<f32>(0.375), vec2<f32>(0.5, 0.125), vec2<f32>(0.625));
  for (var i = 0u; i < 5u; i++) {
    result[i] = sampleSsrHistory(coordinates[i], vec2<u32>(4u), 4.0, vec3<f32>(0.0, 0.0, 1.0)).color;
  }
}`,
    {
      id: 'forgeax_ssr::temporal',
      imports: {
        'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
        'forgeax_pbr::gbuffer': gbufferSource,
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = () =>
    device
      .createTexture({
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        format: 'rgba32float',
        textureBindingViewDimension: '2d',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap();
  const history = texture(),
    surface = texture();
  const params = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const output = device
    .createBuffer({ size: 80, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 80, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    const upload = (target: typeof history, data: number[]) =>
      device.queue
        .writeTexture(
          { texture: target },
          new Float32Array(data),
          { bytesPerRow: 32, rowsPerImage: 2 },
          { width: 2, height: 2, depthOrArrayLayers: 1 },
        )
        .unwrap();
    // Independent linear radiance field C(x,y)=(2+4x,4y,1), with x/y in history pixels.
    upload(
      history,
      [0, 1, 2, 3].flatMap((i) => [
        2 + 4 * (i % 2),
        4 * Math.floor(i / 2),
        1,
        kind === 'depth-edge' && i % 2 === 1 ? 8 : 4,
      ]),
    );
    upload(
      surface,
      [0, 1, 2, 3].flatMap((i) => [
        0,
        // G keeps seven oct-normal bits and a clear source-reactive low bit.
        kind === 'normal-edge' && i % 2 === 1 ? 254 / 255 : 128 / 255,
        kind === 'normal-edge' && i % 2 === 1 ? 1 : 0.5,
        kind === 'missing'
          ? 0
          : kind === 'partial-miss'
            ? i % 2 === 0
              ? 1
              : 0
            : kind === 'confidence'
              ? i % 2 === 0
                ? 0.25
                : 0.75
              : 1,
      ]),
    );
    device.queue.writeBuffer(params, 0, new Float32Array([1, 0.9, 0.02, 0.9, 0, 0, 0, 0])).unwrap();
    const inputs = device
      .createBindGroupLayout({
        entries: [
          ...[3, 9].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
          })),
          { binding: 6, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const outputs = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [inputs, outputs] }).unwrap(),
        compute: { module, entryPoint: 'probe_history' },
      })
      .unwrap();
    const input = device
      .createBindGroup({
        layout: inputs,
        entries: [
          {
            binding: 3,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(history, {}).unwrap(),
            },
          },
          {
            binding: 9,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(surface, {}).unwrap(),
            },
          },
          { binding: 6, resource: { kind: 'buffer', value: { buffer: params } } },
        ],
      })
      .unwrap();
    const result = device
      .createBindGroup({
        layout: outputs,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, input);
    pass.setBindGroup(1, result);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0))];
    mapped.unmap();
    const expected =
      kind === 'plane'
        ? [2, 0, 1, 1, 3, 0, 1, 1, 4, 2, 1, 1, 5, 0, 1, 1, 6, 4, 1, 1]
        : kind === 'confidence'
          ? [2, 0, 1, 0.25, 4, 0, 1, 0.375, 5, 2, 1, 0.5, 5.6, 0, 1, 0.625, 6, 4, 1, 0.75]
          : kind === 'missing'
            ? Array(20).fill(0)
            : [2, 0, 1, 1, 2, 0, 1, 0.75, 2, 2, 1, 0.5, 2, 0, 1, 0.25, 0, 0, 0, 0];
    values.forEach((value, index) => {
      const target = expected[index];
      if (target === undefined) throw new Error(`Unexpected output lane ${index}`);
      expect(value, `${kind} lane ${index}`).toBeCloseTo(target, 5);
    });
  } finally {
    device.destroyTexture(history).unwrap();
    device.destroyTexture(surface).unwrap();
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
