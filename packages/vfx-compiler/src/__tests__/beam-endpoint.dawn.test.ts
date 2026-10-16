/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it('projects both beam endpoints through the emitter transform on the GPU', async () => {
  const cooked = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'beam',
          capacity: 1,
          backend: { required: 'gpu' },
          space: 'local',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          schedule: { rate: 0 },
          program: { module: 'beam.wgsl' },
          renderers: [
            { kind: 'beam', material: 'material', capacity: 1, endpointField: 'velocity' },
          ],
        },
      ],
    },
    {
      'beam.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
      },
    },
  );
  if (!cooked.ok) throw cooked.error;
  const emitter = cooked.value.program.emitters[0];
  if (emitter === undefined) throw new Error('Missing cooked emitter');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const buffer = (data: Float32Array | Uint32Array, uniform = false) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(value, 0, data);
    buffers.push(value);
    return value;
  };
  try {
    device.pushErrorScope('validation');
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: emitter.wgsl }),
        entryPoint: 'forgeax_vfx_beam_main',
      },
    });
    const particle = new Float32Array(28);
    particle.set([1, 2, 3], 0);
    particle.set([1, 0, 1, 2], 4);
    const runtime = new Float32Array(76);
    runtime.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 8);
    new Uint32Array(runtime.buffer)[62] = 1;
    const output = buffer(new Float32Array(12));
    const runtimeBuffer = buffer(runtime, true);
    const entries = [
      [0, buffer(particle)],
      [1, runtimeBuffer],
      [2, buffer(new Uint32Array([0]))],
      [3, buffer(new Uint32Array([1, 0, 0, 0, 0, 0]))],
      [4, buffer(new Uint32Array([6, 0, 0, 0, 0]))],
      [6, output],
    ] as const;
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, value]) => ({ binding, resource: { buffer: value } })),
    });
    const readback = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    buffers.push(readback);
    for (const [matrix, expected] of [
      [
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        [1, 2, 3, 3, 2, 5],
      ],
      // Rotate 90 degrees around Z, scale (2, 3, 4), translate (5, 6, 7).
      [
        [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1],
        [-1, 8, 19, -1, 12, 27],
      ],
    ] as const) {
      runtime.set(matrix, 44);
      device.queue.writeBuffer(runtimeBuffer, 0, runtime);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 48);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = Array.from(new Float32Array(readback.getMappedRange()).slice(0, 6));
      readback.unmap();
      expect(actual).toEqual(expected);
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of buffers) value.destroy();
    device.destroy();
  }
});
