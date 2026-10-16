import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Texture } from '@forgeax/engine-rhi';
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

// Invoke the complete production resolve on a real GPU. Its input contains
// both colors of a subpixel edge, so the history remains inside color bounds.
async function resolveCoverage(source: string, edge: boolean) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const textures: Texture[] = [];
  const upload = (values: number[]) => {
    const texture = device
      .createTexture({
        size: { width: 3, height: 3, depthOrArrayLayers: 1 },
        format: 'rgba16float',
        textureBindingViewDimension: '2d',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap();
    textures.push(texture);
    device.queue
      .writeTexture(
        { texture },
        new Uint16Array(values),
        { bytesPerRow: 24, rowsPerImage: 3 },
        { width: 3, height: 3, depthOrArrayLayers: 1 },
      )
      .unwrap();
    return { texture, view: device.createTextureView(texture, {}).unwrap() };
  };
  const repeat = (value: number[]) => Array.from({ length: 9 }, () => value).flat();
  const colorValues = repeat([0x3800, 0x3800, 0x3800, 0x3c00]);
  colorValues.splice(0, 4, 0, 0, 0, 0x3c00);
  colorValues.splice(32, 4, 0x3c00, 0x3c00, 0x3c00, 0x3c00);
  const color = upload(colorValues);
  const history = upload(repeat([0x3400, 0x3400, 0x3400, 0x3c00]));
  const currentTemporal = upload(repeat([0, 0, 0x4000, 0]));
  const historyTemporal = upload(repeat([0, 0, 0xbc00, 0x3c00]));
  const age = upload(repeat([0, 0, 0, 0]));
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }).unwrap();
  const params = device
    .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const output = device
    .createBuffer({ size: 48, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 48, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  try {
    const module = createShaderModuleImmediate(device, {
      code: `${source}
@group(0) @binding(0) var<storage, read_write> probeResult : array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_coverage() {
  let result = fs_taa_resolve(FullscreenOutput(vec4<f32>(1.5, 1.5, 0.0, 1.0), vec2<f32>(0.5)));
  probeResult[0] = result.color;
  probeResult[1] = result.temporal;
  probeResult[2] = vec4<f32>(result.stability);
}`,
    }).unwrap();
    const outputLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const inputLayout = device
      .createBindGroupLayout({
        entries: [
          ...[0, 2, 4, 6, 9, 10].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
          })),
          ...[1, 3, 5, 7].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            sampler: { type: 'filtering' as const },
          })),
          { binding: 8, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
          {
            binding: 11,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
          },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [outputLayout, inputLayout] })
          .unwrap(),
        compute: { module, entryPoint: 'probe_coverage' },
      })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const inputGroup = device
      .createBindGroup({
        layout: inputLayout,
        entries: [
          ...[color, history, historyTemporal, currentTemporal].map((surface, i) => ({
            binding: i * 2,
            resource: { kind: 'textureView' as const, value: surface.view },
          })),
          ...[1, 3, 5, 7].map((binding) => ({
            binding,
            resource: { kind: 'sampler' as const, value: sampler },
          })),
          { binding: 8, resource: { kind: 'buffer', value: { buffer: params } } },
          { binding: 9, resource: { kind: 'textureView', value: age.view } },
          { binding: 10, resource: { kind: 'textureView', value: age.view } },
          { binding: 11, resource: { kind: 'textureView', value: currentTemporal.view } },
        ],
      })
      .unwrap();
    const results = [];
    for (const mode of ['stationary', 'reactive', 'moving', 'reset', 'absent'] as const) {
      const temporal = repeat([
        mode === 'moving' ? 0x3000 : 0,
        0,
        mode === 'absent' ? 0xbc00 : 0x4000,
        mode === 'reactive' ? 0x3c00 : 0,
      ]);
      if (edge) temporal.splice(0, 4, 0, 0, 0xbc00, 0x3c00);
      device.queue
        .writeTexture(
          { texture: currentTemporal.texture },
          new Uint16Array(temporal),
          { bytesPerRow: 24, rowsPerImage: 3 },
          { width: 3, height: 3, depthOrArrayLayers: 1 },
        )
        .unwrap();
      device.queue
        .writeBuffer(params, 0, new Uint32Array([0, 0, mode === 'reset' ? 0 : 1, 200, 0, 0, 0, 0]))
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, outputGroup);
      pass.setBindGroup(1, inputGroup);
      pass.dispatchWorkgroups(1, 1, 1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 48);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapping = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      results.push([...new Float32Array(mapping.getMappedRange().unwrap().slice(0))]);
      mapping.unmap();
    }
    return results;
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    for (const buffer of [params, output, readback]) device.destroyBuffer(buffer).unwrap();
  }
}

it('accumulates mixed coverage while preserving uniform disocclusion and fast-motion/reactive/reset guards', async () => {
  const source = readFileSync(resolve('packages/shader/src/taa-resolve.wgsl'), 'utf8').replace(
    /^#define_import_path.*$/gm,
    '',
  );
  const edge = await resolveCoverage(source, true);
  const stationary = edge[0];
  if (stationary === undefined) throw new Error('Missing stationary coverage sample');
  // Karis blend of current 0.5 and history 0.25 with weight 0.95.
  expect(stationary[0]).toBeCloseTo(
    (0.5 * (0.05 / 1.5) + 0.25 * (0.95 / 1.25)) / (0.05 / 1.5 + 0.95 / 1.25),
    3,
  );
  expect(stationary[8]).toBeCloseTo(1 / 255, 7);
  for (const result of edge.slice(1)) {
    expect(result[0]).toBe(0.5);
    expect(result[8]).toBe(0);
  }
  const uniform = await resolveCoverage(source, false);
  for (const result of uniform) {
    expect(result[0]).toBe(0.5);
    expect(result[8]).toBe(0);
  }
});
