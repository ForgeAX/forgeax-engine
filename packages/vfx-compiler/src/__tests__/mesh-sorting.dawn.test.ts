/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it.each([
  'mesh',
  'billboard',
] as const)('sorts %s particles on the GPU independently of mesh firstIndex', async (kind) => {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'sorted',
            capacity: 3,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 20 },
            schedule: { rate: 0 },
            program: { module: 'sort.wgsl' },
            renderers: [
              {
                kind,
                material: 'material',
                ...(kind === 'mesh' ? { mesh: 'geometry' } : {}),
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
    )
  ).unwrap();
  const emitter = cooked.program.emitters[0];
  if (emitter === undefined) throw new Error('Missing emitter');
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
        entryPoint: 'forgeax_vfx_sort_main',
      },
    });
    const particles = new Float32Array(28 * 3);
    // Depth order 1,2,0 differs from distance order 0,1,2 and custom order 2,0,1.
    particles.set([10, 0, -1], 0);
    particles.set([0, 0, -3], 28);
    particles.set([0, 0, -2], 56);
    const runtime = new Float32Array(76);
    const words = new Uint32Array(runtime.buffer);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // Reverse-Z perspective: near=0.1, far=20, looking down negative Z.
    runtime.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1 / 19.9, -1, 0, 0, 2 / 19.9, 0], 8);
    runtime.set(identity, 44);
    words[63] = 7; // Mesh firstIndex must never select sorting mode.
    const runtimeBuffer = buffer(runtime, true);
    const alive = buffer(new Uint32Array([0, 1, 2]));
    const entries = [
      [0, buffer(particles)],
      [1, runtimeBuffer],
      [2, alive],
      [3, buffer(new Uint32Array([3, 0, 0, 0, 0, 0]))],
      [11, buffer(new Float32Array([2, 3, 1]))],
    ] as const;
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, value]) => ({ binding, resource: { buffer: value } })),
    });
    const readback = device.createBuffer({
      size: 12,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    buffers.push(readback);
    for (const [mode, expected] of [
      [0, [0, 1, 2]],
      [2, [1, 2, 0]],
      [3, [2, 0, 1]],
      [4, [1, 0, 2]],
      [5, [0, 1, 2]],
    ] as const) {
      words[75] = mode;
      device.queue.writeBuffer(runtimeBuffer, 0, runtime);
      device.queue.writeBuffer(alive, 0, new Uint32Array([0, 1, 2]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(alive, 0, readback, 0, 12);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = [...new Uint32Array(readback.getMappedRange())];
      readback.unmap();
      expect(actual, `sorting mode ${mode}`).toEqual(expected);
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of buffers) value.destroy();
    device.destroy();
  }
});
