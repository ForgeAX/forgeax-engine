import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';

/**
 * Numeric Dawn proof for the shared Skylight/ReflectionProbe scalar decode.
 * The material source tests cover both PROBE_BLEND branches; this test keeps
 * the sentinel arithmetic and AO multiplication executable on a real device.
 */
it('decodes regular and probe-sentinel specular environment scales without tint metadata leakage', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = readFileSync(resolve('packages/shader/src/ibl-sampling.wgsl'), 'utf8');
  const compiled = await compiler.compileShader(
    `${source}
@group(0) @binding(0) var<storage, read> cases: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> aoValues: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputs: array<vec4<f32>>;
@compute @workgroup_size(4) fn probe_scale(@builtin(global_invocation_id) id: vec3<u32>) {
  let scale = decodeSpecularEnvironmentScale(cases[id.x].xyz, cases[id.x].w);
  // Probe intensity is applied while blending local and global radiance.
  // The outer scale stays one for either sentinel, including zero intensity.
  // RGB is the decoded scale. Alpha is the same lobe after the material AO
  // factor, matching the detached fallback's post-environment multiplication.
  outputs[id.x] = vec4<f32>(scale, scale.x * aoValues[id.x]);
}`,
    {
      id: 'forgeax::specular-environment-scale-test',
      imports: {
        'forgeax_pbr::ibl_shared': readFileSync(
          resolve('packages/shader/src/ibl-shared.wgsl'),
          'utf8',
        ),
        'forgeax_pbr::brdf': readFileSync(resolve('packages/shader/src/brdf.wgsl'), 'utf8'),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;

  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const cases = device
    .createBuffer({
      size: 64,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const aoValues = device
    .createBuffer({
      size: 16,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const outputs = device
    .createBuffer({ size: 64, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 64, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();

  try {
    device.queue
      .writeBuffer(
        cases,
        0,
        new Float32Array([
          0.25,
          0.5,
          0.75,
          1.5, // regular Skylight: non-unit tint and intensity
          0.2,
          0.4,
          0.8,
          0.25, // regular Skylight: second tint/intensity pair
          3.0,
          -2.0,
          7.0,
          -1.4, // probe sentinel: color lanes are non-zero box metadata
          8.0,
          9.0,
          10.0,
          -1.0, // zero-intensity probe sentinel
        ]),
      )
      .unwrap();
    device.queue.writeBuffer(aoValues, 0, new Float32Array([0.35, 0.8, 0.6, 0.25])).unwrap();

    const layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'read-only-storage' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'read-only-storage' },
          },
          { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'probe_scale' },
      })
      .unwrap();
    const bindGroup = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: cases } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: aoValues } } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: outputs } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(outputs, 0, readback, 0, 64);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();

    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = [...new Float32Array(mapped.getMappedRange().unwrap().slice(0))];
    mapped.unmap();
    const expected = [
      [0.375, 0.75, 1.125, 0.13125],
      [0.05, 0.1, 0.2, 0.04],
      [1, 1, 1, 0.6],
      [1, 1, 1, 0.25],
    ].flat();
    values.forEach((value, index) => {
      const target = expected[index];
      if (target === undefined) throw new Error(`Unexpected output lane ${index}`);
      expect(value, `specular environment scale lane ${index}`).toBeCloseTo(target, 5);
    });
  } finally {
    device.destroyBuffer(cases).unwrap();
    device.destroyBuffer(aoValues).unwrap();
    device.destroyBuffer(outputs).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
