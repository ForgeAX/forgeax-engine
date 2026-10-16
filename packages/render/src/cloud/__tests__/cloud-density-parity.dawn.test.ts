/// <reference types="@webgpu/types" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateCloudDensity } from '../density';
import { CLOUD_VIEW_FULLSCREEN_WGSL } from '../feature';
import { cloudIncidentLight } from '../optics';
import { validateCloudLayer } from '../parameters';

// Execute both production WGSL definitions. A source-text comparison cannot
// detect a hash constant mismatch or a different body/envelope interpretation.
describe('cloud density CPU/GPU parity', () => {
  it('uses the same formation and density in cached-field generation and both analytic shaders', async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    const params = validateCloudLayer({
      baseHeight: 0,
      thickness: 1,
      scale: 1,
      seed: 42,
      coverage: 0.8,
      density: 1,
      wind: [0, 0, 0],
    });
    if (!params.ok) throw params.error;
    const shared = readFileSync(
      new URL('../../../../shader/src/cloud.wgsl', import.meta.url),
      'utf8',
    );
    try {
      for (const source of [CLOUD_VIEW_FULLSCREEN_WGSL, shared]) {
        const helpers = source.slice(
          source.indexOf('fn cloud_hash3('),
          source.indexOf(source === shared ? 'fn cloud_density(' : 'fn cloud_analytic_density('),
        );
        const code = `
          const CLOUD_VERTICAL_NOISE_CELLS: f32 = 2.0;
          ${helpers}
          @group(0) @binding(0) var<storage, read_write> output: array<f32>;
          @compute @workgroup_size(64)
          fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let p = vec3<f32>(f32(id.x % 13u) / 13.0, (f32(id.x % 11u) + 0.5) / 11.0, f32(id.x % 17u) / 17.0);
            output[id.x] = cloud_compose_density(p.y, cloud_formation_field(p, 42u), 0.8);
          }`;
        const module = device.createShaderModule({ code });
        const info = await module.getCompilationInfo();
        expect(info.messages.filter((message) => message.type === 'error')).toEqual([]);
        const pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        });
        const output = device.createBuffer({
          size: 512,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
          size: 512,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        try {
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: output } }],
            }),
          );
          pass.dispatchWorkgroups(2);
          pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, 512);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const values = new Float32Array(readback.getMappedRange());
          let maxError = 0;
          for (let i = 0; i < 128; i++) {
            const point = [(i % 13) / 13, ((i % 11) + 0.5) / 11, (i % 17) / 17];
            maxError = Math.max(
              maxError,
              Math.abs(
                (values[i] ?? Number.NaN) - evaluateCloudDensity(params.value, point).density,
              ),
            );
          }
          expect(maxError).toBeLessThan(0.001);
          readback.unmap();
        } finally {
          output.destroy();
          readback.destroy();
        }
      }
    } finally {
      device.destroy();
    }
  });
});

describe('cloud incident light CPU/GPU parity', () => {
  it('uses the volume light basis and the same phase and fill in the CPU oracle', async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    const output = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const helpers = CLOUD_VIEW_FULLSCREEN_WGSL.slice(
        CLOUD_VIEW_FULLSCREEN_WGSL.indexOf('fn cloud_henyey_greenstein('),
        CLOUD_VIEW_FULLSCREEN_WGSL.indexOf('fn cloud_ray_jitter('),
      );
      const module = device.createShaderModule({
        code: `
        struct Light { sunRadiance: vec4<f32> };
        var<private> cloud: Light = Light(vec4<f32>(1.0));
        ${helpers}
        @group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let t = f32(id.x % 8u) / 7.0;
          let angle = f32((id.x / 8u) % 4u) / 1.5 - 1.0;
          let height = f32(id.x / 32u);
          output[id.x] = vec4<f32>(cloud_incident_light(t, angle, height), 1.0);
        }`,
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: output } }],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 1024);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange());
      for (let i = 0; i < 64; i++) {
        const expected = cloudIncidentLight(
          (i % 8) / 7,
          (Math.floor(i / 8) % 4) / 1.5 - 1,
          Math.floor(i / 32),
        );
        for (const channel of [0, 1, 2] as const)
          expect(values[i * 4 + channel]).toBeCloseTo(expected[channel], 4);
      }
      readback.unmap();
      // An unoccluded sideways ray must retain direct and multiple scattering
      // in the shared light units; an accidental extra 1/(4*pi) dims this badly.
      expect(cloudIncidentLight(1, 0, 1)[0]).toBeGreaterThan(1);
    } finally {
      output.destroy();
      readback.destroy();
      device.destroy();
    }
  });
});
