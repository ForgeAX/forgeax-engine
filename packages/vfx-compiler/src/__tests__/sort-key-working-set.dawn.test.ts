/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it.each([3, 32, 257])('retains stable sort order at capacity %i', async (capacity) => {
  const result = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'sorted',
          capacity,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1000 },
          schedule: { rate: 0 },
          program: { module: 'sort.wgsl' },
          renderers: [
            {
              kind: 'billboard',
              material: 'material',
              sorting: 'custom-ascending',
              attributes: { sort: { source: 'custom', name: 'order' } },
            },
          ],
        },
      ],
    },
    {
      'sort.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxCustom { order: f32, };
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {}`,
      },
    },
  );
  const emitter = result.unwrap().program.emitters[0];
  if (emitter === undefined) throw new Error('Missing emitter');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const buffer = (data: Float32Array | Uint32Array, uniform = false) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage:
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC |
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE),
    });
    buffers.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  try {
    device.pushErrorScope('validation');
    const reflected = emitter.reflection.bindings[0];
    if (reflected === undefined) throw new Error('Missing reflected bindings');
    const layout = device.createBindGroupLayout({
      entries: reflected.entries.map((entry) => {
        if (entry.buffer === undefined) throw new Error('Expected reflected buffer binding');
        return {
          binding: entry.binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { ...entry.buffer },
        };
      }),
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: emitter.wgsl }),
        entryPoint: 'forgeax_vfx_sort_main',
      },
    });
    const particles = new Float32Array(capacity * 28);
    const keys = Float32Array.from({ length: capacity }, (_, i) =>
      i % 7 === 0 ? Number.NaN : (i % 5) - 2,
    );
    for (let i = 0; i < capacity; i++) particles.set([i % 11, i % 3, capacity - i], i * 28);
    const runtime = new Float32Array(76),
      words = new Uint32Array(runtime.buffer);
    for (const start of [8, 44]) for (let i = 0; i < 4; i++) runtime[start + i * 5] = 1;
    const runtimeBuffer = buffer(runtime, true),
      alive = buffer(new Uint32Array(capacity));
    const counters = buffer(new Uint32Array(6));
    const entries = new Map([
      [0, buffer(particles)],
      [1, runtimeBuffer],
      [2, alive],
      [3, counters],
      [4, buffer(new Uint32Array(5))],
      [5, buffer(new Uint32Array(capacity * 2 + 4))],
      [6, buffer(new Float32Array(capacity * 31))],
      [11, buffer(keys)],
    ]);
    const group = device.createBindGroup({
      layout,
      entries: [...entries].map(([binding, value]) => ({ binding, resource: { buffer: value } })),
    });
    const readback = device.createBuffer({
      size: capacity * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(readback);
    for (const count of [...new Set([0, 1, Math.min(3, capacity), capacity])]) {
      for (const mode of [0, 2, 3, 4, 5, 6]) {
        // Both tested nontrivial capacities are coprime with seven.
        const order = Array.from({ length: count }, (_, i) => (i * 7) % count);
        const expected = [...order];
        const key = (i: number) =>
          mode === 3 || mode === 4
            ? (keys[i] ?? Number.NaN)
            : mode === 5
              ? (i % 11) ** 2 + (i % 3) ** 2 + (capacity - i) ** 2
              : capacity - i;
        if (mode >= 2)
          for (let i = 1; i < count; i++) {
            const candidate = expected[i];
            if (candidate === undefined) throw new Error('Missing candidate');
            let cursor = i;
            while (cursor > 0) {
              const previous = expected[cursor - 1];
              if (previous === undefined) throw new Error('Missing previous');
              if (
                mode === 4 || mode === 5
                  ? key(previous) >= key(candidate)
                  : key(previous) <= key(candidate)
              )
                break;
              expected[cursor--] = previous;
            }
            expected[cursor] = candidate;
          }
        words[75] = mode;
        device.queue.writeBuffer(runtimeBuffer, 0, runtime);
        device.queue.writeBuffer(counters, 0, new Uint32Array([count, 0, 0, 0, 0, 0]));
        if (count > 0) device.queue.writeBuffer(alive, 0, new Uint32Array(order));
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(alive, 0, readback, 0, capacity * 4);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = [...new Uint32Array(readback.getMappedRange()).slice(0, count)];
        readback.unmap();
        expect(actual, `count=${count} mode=${mode}`).toEqual(expected);
      }
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of buffers) value.destroy();
    device.destroy();
  }
});
