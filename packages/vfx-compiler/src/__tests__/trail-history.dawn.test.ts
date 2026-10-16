/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it('draws only written trail history, preserves it across render-only frames, and resets reused particles', async () => {
  const cooked = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'trail',
          capacity: 2,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 100 },
          schedule: { rate: 0 },
          program: { module: 'trail.wgsl' },
          renderers: [{ kind: 'trail', material: 'material', capacity: 2, historyLength: 32 }],
        },
      ],
    },
    {
      'trail.wgsl': {
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
  const owned: GPUBuffer[] = [];
  const create = (data: Float32Array | Uint32Array, uniform = false) => {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    owned.push(buffer);
    return buffer;
  };
  try {
    device.pushErrorScope('validation');
    const runtime = new Float32Array(76);
    const words = new Uint32Array(runtime.buffer);
    words[4] = 2;
    words[61] = 32;
    words[62] = 2;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    runtime.set(identity, 8);
    runtime.set(identity, 44);
    const particle = new Float32Array(56);
    const particleWords = new Uint32Array(particle.buffer);
    // Particle slot 1 is deliberately not the alive-list rank 0.
    particle.set([10, 20, 30], 28);
    particleWords[28 + 24] = 7;
    const scratch = new Uint32Array(2 * (32 + 1) * 4);
    const resources = [
      create(particle),
      create(runtime, true),
      create(new Uint32Array([1, 0])),
      create(new Uint32Array([1, 0, 0, 0, 0, 0])),
      create(new Uint32Array([6, 0, 0, 0, 0])),
      create(scratch),
      create(new Float32Array(2 * 31 * 12)),
    ] as const;
    const layout = device.createBindGroupLayout({
      entries: resources.map((_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 1 ? 'uniform' : 'storage' },
      })),
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: emitter.wgsl });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint },
      });
    const history = pipeline('forgeax_vfx_trail_history_main');
    const offsets = pipeline('forgeax_vfx_trail_offsets_main');
    const project = pipeline('forgeax_vfx_trail_main');
    const bindings = device.createBindGroup({
      layout,
      entries: resources.map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const readback = device.createBuffer({
      size: 4 + 2 * 31 * 48,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    owned.push(readback);
    const frame = async (writeHistory: boolean) => {
      device.queue.writeBuffer(resources[0], 0, particle);
      device.queue.writeBuffer(resources[1], 0, runtime);
      const encoder = device.createCommandEncoder();
      for (const selected of [...(writeHistory ? [history] : []), offsets, project]) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(selected);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
        pass.end();
      }
      encoder.copyBufferToBuffer(resources[4], 4, readback, 0, 4);
      encoder.copyBufferToBuffer(resources[6], 0, readback, 4, 2 * 31 * 48);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange().slice(0);
      readback.unmap();
      const count = new DataView(bytes).getUint32(0, true);
      const segments = new Float32Array(bytes, 4);
      return {
        count,
        segments: Array.from({ length: count }, (_, index) =>
          Array.from(segments.slice(index * 12, index * 12 + 6)),
        ),
      };
    };
    expect((await frame(true)).count).toBe(0);
    words[1] = 7;
    particle[28] = 11;
    expect(await frame(true)).toEqual({ count: 1, segments: [[11, 20, 30, 10, 20, 30]] });
    expect(await frame(false)).toEqual({ count: 1, segments: [[11, 20, 30, 10, 20, 30]] });
    words[1] = 50;
    particle[28] = 12;
    expect(await frame(true)).toEqual({
      count: 2,
      segments: [
        [12, 20, 30, 11, 20, 30],
        [11, 20, 30, 10, 20, 30],
      ],
    });
    particleWords[28 + 24] = 8;
    expect((await frame(true)).count).toBe(0);
    device.queue.writeBuffer(resources[5], 0, scratch);
    expect((await frame(true)).count).toBe(0);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});
