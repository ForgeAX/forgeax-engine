import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

it.each([
  'covered',
  'silhouette',
  'backface',
  'uncovered',
] as const)('retains subpixel HDR radiance and source coverage at the production SSR hit sampler (%s)', async (coverageCase) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = readFileSync(resolve('packages/shader/src/ssr-trace.wgsl'), 'utf8');
  expect(source).toContain(
    'let hitSample = sampleSsrHitSample(hitResult.uv, reflectionDirection);',
  );
  expect(source).toContain('max(hitResult.reactivity, hitSample.reactivity)');
  const compiled = await compiler.compileShader(
    `${source}
@group(1) @binding(0) var<storage, read_write> colors: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_color() {
  let uvs = array<vec2<f32>, 6>(vec2<f32>(0.5), vec2<f32>(0.49, 0.25), vec2<f32>(0.51, 0.25), vec2<f32>(0.0), vec2<f32>(1.0), vec2<f32>(0.25, 0.75));
  for (var i = 0u; i < 6u; i++) {
    let sample = sampleSsrHitSample(uvs[i], vec3<f32>(0.0, 0.0, -1.0));
    colors[i] = sample.color;
    colors[6u + i] = vec4<f32>(sample.reactivity);
  }
}`,
    {
      id: 'forgeax_ssr::trace',
      imports: {
        'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
        'forgeax_pbr::gbuffer': gbufferSource,
        'forgeax_depth_pyramid::sample': readFileSync(
          resolve('packages/shader/src/depth-pyramid-sample.wgsl'),
          'utf8',
        ),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const color = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const output = device
    .createBuffer({ size: 192, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const coverage = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const normals = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'r32uint',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const readback = device
    .createBuffer({ size: 192, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const temporal = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  try {
    device.queue
      .writeTexture(
        { texture: temporal },
        new Float32Array([1 / 128, 0, 2, 0, 0, 0, 2, 0.75, 0, 0, 2, 0, 0, 0, 2, 0]),
        { bytesPerRow: 32, rowsPerImage: 2 },
        { width: 2, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();
    writePackedNormals(
      device,
      normals,
      2,
      2,
      new Float32Array(
        Array.from({ length: 4 }, (_, i) => [
          0.5,
          0.5,
          coverageCase === 'backface' && i % 2 === 1 ? 0 : 1,
          1,
        ]).flat(),
      ),
    );
    const coverageValues =
      coverageCase === 'covered' || coverageCase === 'backface'
        ? [1, 1, 1, 1]
        : coverageCase === 'silhouette'
          ? [1, 0, 1, 0]
          : [0, 0, 0, 0];
    device.queue
      .writeTexture(
        { texture: coverage },
        new Float32Array(coverageValues.flatMap((alpha) => [0, 0, 0, alpha])),
        { bytesPerRow: 32, rowsPerImage: 2 },
        { width: 2, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();
    device.queue
      .writeTexture(
        { texture: color },
        new Float32Array([4, 0, 0, 1, 0, 2, 0, 1, 0, 0, 8, 1, 1, 1, 1, 1]),
        { bytesPerRow: 32, rowsPerImage: 2 },
        { width: 2, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();
    const inputs = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 7,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'uint', viewDimension: '2d' },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          {
            binding: 6,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const outputs = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'storage' },
          },
        ],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [inputs, outputs] }).unwrap(),
        compute: { module, entryPoint: 'probe_color' },
      })
      .unwrap();
    const input = device
      .createBindGroup({
        layout: inputs,
        entries: [
          {
            binding: 7,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(temporal, {}).unwrap(),
            },
          },
          {
            binding: 2,
            resource: { kind: 'textureView', value: device.createTextureView(color, {}).unwrap() },
          },
          {
            binding: 1,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(normals, {}).unwrap(),
            },
          },
          {
            binding: 6,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(coverage, {}).unwrap(),
            },
          },
        ],
      })
      .unwrap();
    const result = device
      .createBindGroup({
        layout: outputs,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: output } },
          },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, input);
    pass.setBindGroup(1, result);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 192);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const reactive = Array.from({ length: 6 }, (_, i) => values[(6 + i) * 4]);
    expect(reactive, 'only admitted color taps may invalidate reflection history').toEqual(
      coverageCase === 'uncovered'
        ? [0, 0, 0, 0, 0, 0]
        : coverageCase === 'covered'
          ? [0.75, 0.75, 0.75, 0.5, 0, 0]
          : [0.5, 0.5, 0.5, 0.5, 0, 0],
    );
    if (coverageCase === 'uncovered') {
      expect([...values], 'sky is not a covered reflection source').toEqual(Array(48).fill(0));
      return;
    }
    if (coverageCase === 'silhouette' || coverageCase === 'backface') {
      expect([...values.slice(0, 4)], 'only the covered red/blue column contributes').toEqual([
        2, 0, 4, 0.5,
      ]);
      expect(values[4]).toBeCloseTo(4, 5);
      expect(values[7]).toBeCloseTo(0.52, 5);
      expect(values[8]).toBeCloseTo(4, 5);
      expect(values[11]).toBeCloseTo(0.48, 5);
      expect([...values.slice(12, 16)]).toEqual([4, 0, 0, 1]);
      expect([...values.slice(16, 20)]).toEqual([0, 0, 0, 0]);
      expect([...values.slice(20, 24)]).toEqual([0, 0, 8, 1]);
      return;
    }
    expect([...values.slice(0, 4)], 'four-texel HDR interpolation').toEqual([1.25, 0.75, 2.25, 1]);
    expect(values[4]).toBeCloseTo(2.08, 5);
    expect(values[8]).toBeCloseTo(1.92, 5);
    expect([...values.slice(12, 16)], 'clamped upper-left edge').toEqual([4, 0, 0, 1]);
    expect([...values.slice(16, 20)], 'clamped lower-right edge').toEqual([1, 1, 1, 1]);
    expect([...values.slice(20, 24)], 'exact texel center').toEqual([0, 0, 8, 1]);
  } finally {
    device.destroyTexture(color).unwrap();
    device.destroyTexture(coverage).unwrap();
    device.destroyTexture(normals).unwrap();
    device.destroyTexture(temporal).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
