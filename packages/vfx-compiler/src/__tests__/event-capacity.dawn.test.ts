/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it.each([
  { eventSlots: 4, liveSlot: 3, previousEvents: 0 },
  { eventSlots: 4, liveSlot: 1, previousEvents: 100 },
  { eventSlots: 1, liveSlot: 3, previousEvents: 0 },
])('reserves free slots across ticks (event slots=$eventSlots, live slot=$liveSlot, previous events=$previousEvents)', async ({
  eventSlots,
  liveSlot,
  previousEvents,
}) => {
  const cooked = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'events',
          capacity: 4,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          schedule: { rate: 0 },
          program: { module: 'event.wgsl' },
          renderers: [{ kind: 'mesh', material: 'material', mesh: 'mesh' }],
          channels: [{ id: 'hit', capacity: 2, overflow: 'drop-newest' }],
          events: [
            { id: 'hit', channel: 'hit', subEmitter: 'events', fanOut: 2, recursionDepth: 1 },
          ],
        },
      ],
    },
    {
      'event.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxCustom { heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {}`,
      },
    },
  );
  if (!cooked.ok) throw cooked.error;
  const emitter = cooked.value.program.emitters[0];
  if (emitter === undefined) throw new Error('Missing emitter');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Missing Dawn adapter');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [];
  const make = (data: Uint32Array, uniform = false) => {
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
  const read = async (source: GPUBuffer) => {
    const target = device.createBuffer({
      size: source.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    owned.push(target);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, target, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(target.getMappedRange()).slice();
    target.unmap();
    return Array.from(result);
  };
  try {
    device.pushErrorScope('validation');
    const particles = new Uint32Array(4 * 28);
    particles[liveSlot * 28 + 24] = 99;
    particles[liveSlot * 28 + 25] = 1;
    const runtime = new Uint32Array(76);
    runtime[4] = 4;
    runtime[7] = 1;
    runtime[61] = 2;
    const scratch = new Uint32Array(12);
    scratch[liveSlot] = 1;
    const events = new Uint32Array((2 + eventSlots) * 8);
    for (const [index, sequence] of [10, 20].entries()) {
      events[index * 8 + 5] = sequence;
      events[index * 8 + 7] = 2;
    }
    const customStride = emitter.reflection.layout.customLayout.stride / 4;
    const buffers = new Map([
      [0, make(particles)],
      [1, make(runtime, true)],
      [2, make(new Uint32Array([liveSlot, 0, 0, 0]))],
      [3, make(new Uint32Array([1, 0, previousEvents, previousEvents, 0, 0]))],
      [4, make(new Uint32Array([6, 1, 0, 0, 0]))],
      [5, make(scratch)],
      [8, make(events)],
      [11, make(new Uint32Array(4 * customStride).fill(7))],
    ]);
    const at = (binding: number) => {
      const buffer = buffers.get(binding);
      if (!buffer) throw new Error(`Missing test binding ${binding}`);
      return buffer;
    };
    const layout = device.createBindGroupLayout({
      entries: [...buffers.keys()].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 1 ? 'uniform' : 'storage' },
      })),
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: emitter.wgsl }),
        entryPoint: 'forgeax_vfx_event_main',
      },
    });
    const group = device.createBindGroup({
      layout,
      entries: [...buffers].map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const actualParticles = await read(at(0));
    const counts = await read(at(3));
    const indirect = await read(at(4));
    const indices = await read(at(2));
    const flags = await read(at(5));
    const custom = await read(at(11));
    const emitted = await read(at(8));
    const freeSlots = [0, 1, 2, 3].filter((slot) => slot !== liveSlot);
    expect((await device.popErrorScope())?.message).toBeUndefined();
    expect(actualParticles[liveSlot * 28 + 24]).toBe(99);
    const accepted = eventSlots >= 2 ? 2 : 0;
    expect(counts).toEqual([
      1 + accepted,
      0,
      previousEvents + accepted,
      previousEvents + accepted,
      accepted ? 1 : 2,
      accepted ? 1 : 2,
    ]);
    expect(indirect[1]).toBe(1 + accepted);
    expect(indices.slice(0, 1 + accepted)).toEqual([liveSlot, ...freeSlots.slice(0, accepted)]);
    expect(flags.slice(0, 4)).toEqual(
      [0, 1, 2, 3].map((slot) =>
        Number(slot === liveSlot || freeSlots.slice(0, accepted).includes(slot)),
      ),
    );
    if (accepted)
      expect(freeSlots.slice(0, accepted).map((slot) => actualParticles[slot * 28 + 24])).toEqual([
        10, 11,
      ]);
    expect(custom[liveSlot * customStride]).toBe(7);
    if (accepted)
      expect(freeSlots.slice(0, accepted).map((slot) => custom[slot * customStride])).toEqual([
        0, 0,
      ]);
    if (accepted) expect([emitted[2 * 8 + 5], emitted[3 * 8 + 5]]).toEqual([10, 11]);
    // The next scheduled spawn consumes the canonical scan's updated free
    // ranks. It must use the remaining hole, not overwrite event children.
    device.pushErrorScope('validation');
    runtime[5] = 1;
    runtime[6] = 200;
    device.queue.writeBuffer(at(1), 0, runtime);
    const next = device.createCommandEncoder();
    const nextPass = next.beginComputePass();
    for (const entryPoint of [
      'forgeax_vfx_scan_blocks_main',
      'forgeax_vfx_scan_block_offsets_main',
      'forgeax_vfx_add_offsets_main',
      'forgeax_vfx_compact_main',
      'forgeax_vfx_spawn_main',
    ]) {
      nextPass.setPipeline(
        device.createComputePipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module: device.createShaderModule({ code: emitter.wgsl }), entryPoint },
        }),
      );
      nextPass.setBindGroup(0, group);
      nextPass.dispatchWorkgroups(1);
    }
    nextPass.end();
    device.queue.submit([next.finish()]);
    const nextParticles = await read(at(0));
    expect((await device.popErrorScope())?.message).toBeUndefined();
    expect(nextParticles[liveSlot * 28 + 24]).toBe(99);
    expect(nextParticles[(freeSlots[accepted] ?? -1) * 28 + 24]).toBe(200);
    if (accepted)
      expect(freeSlots.slice(0, accepted).map((slot) => nextParticles[slot * 28 + 24])).toEqual([
        10, 11,
      ]);
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});
