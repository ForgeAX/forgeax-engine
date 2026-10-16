/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

it.each([
  {
    name: 'rotated reflected Scale3',
    orientation: [0.5, 0.5, 0.5, 0.5],
    scale: [-2, 3, 4],
    valid: true,
  },
  { name: 'zero quaternion', orientation: [0, 0, 0, 0], scale: [-2, 3, 4], valid: false },
  { name: 'singular Scale3', orientation: [0.5, 0.5, 0.5, 0.5], scale: [-2, 0, 4], valid: false },
  {
    name: 'invisible particle',
    orientation: [0.5, 0.5, 0.5, 0.5],
    scale: [-2, 3, 4],
    alive: 0,
    valid: false,
  },
])('projects $name on the GPU independently of the camera', async ({
  orientation,
  scale,
  alive = 1,
  valid,
}) => {
  const cooked = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'mesh',
          capacity: 1,
          backend: { required: 'gpu' },
          space: 'local',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          schedule: { rate: 0 },
          program: { module: 'mesh.wgsl' },
          renderers: [
            { kind: 'mesh', material: 'material', mesh: 'geometry' },
            {
              kind: 'mesh',
              material: 'material',
              mesh: 'geometry',
              lighting: 'unlit',
              receiveShadows: false,
            },
            { kind: 'mesh', material: 'material', mesh: 'geometry', receiveShadows: false },
            { kind: 'mesh', material: 'material', mesh: 'geometry', lighting: 'unlit' },
          ],
        },
      ],
    },
    {
      'mesh.wgsl': {
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
        entryPoint: 'forgeax_vfx_mesh_main',
      },
    });
    const particle = new Float32Array(28);
    particle.set([1, 2, 3], 0);
    particle.set(orientation, 16);
    particle.set(scale, 20);
    const particleWords = new Uint32Array(particle.buffer);
    particleWords[24] = 1; // id
    particleWords[25] = alive; // default mesh visibility semantic
    const runtime = new Float32Array(76);
    runtime.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 8);
    new Uint32Array(runtime.buffer)[62] = 1;
    const output = buffer(new Float32Array(18));
    const runtimeBuffer = buffer(runtime, true);
    const indirectSeed = new Uint32Array(20);
    for (let renderer = 0; renderer < 4; renderer++) indirectSeed[renderer * 5 + 1] = 13;
    const indirect = buffer(indirectSeed);
    const entries = [
      [0, buffer(particle)],
      [1, runtimeBuffer],
      [2, buffer(new Uint32Array([0]))],
      [3, buffer(new Uint32Array([1, 0, 0, 0, 0, 0]))],
      [4, indirect],
      [6, output],
    ] as const;
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, value]) => ({ binding, resource: { buffer: value } })),
    });
    const readback = device.createBuffer({
      size: 72,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    buffers.push(readback);
    // 120 degrees about (1,1,1), reflected Scale3, then entity scale/translation.
    const matrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
    const expected = valid ? [7, 12, 19, 0, -6, 0, 0, 0, 12, 8, 0, 0] : Array<number>(18).fill(0);
    for (const [rendererIndex, controls] of [
      [1, 1],
      [0, 0],
      [1, 0],
      [0, 1],
    ].entries()) {
      for (const cameraScale of [1, 17]) {
        new Uint32Array(runtime.buffer)[60] = rendererIndex;
        new Uint32Array(runtime.buffer)[61] = 3 + rendererIndex;
        new Uint32Array(runtime.buffer)[63] = 7 + rendererIndex;
        runtime[8] = cameraScale;
        runtime.set(matrix, 44);
        device.queue.writeBuffer(runtimeBuffer, 0, runtime);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, 72);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
        const readCommand = device.createCommandEncoder();
        readCommand.copyBufferToBuffer(indirect, rendererIndex * 20, readback, 0, 20);
        device.queue.submit([readCommand.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        expect([...new Uint32Array(readback.getMappedRange()).slice(0, 5)]).toEqual([
          3 + rendererIndex,
          13,
          7 + rendererIndex,
          0,
          0,
        ]);
        readback.unmap();
        const validationError = await device.popErrorScope();
        expect(validationError?.message).toBeUndefined();
        device.pushErrorScope('validation');
        for (const [index, value] of expected.entries())
          expect(actual[index]).toBeCloseTo(value, 5);
        if (valid) expect(actual.slice(16, 18)).toEqual(controls);
      }
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const value of buffers) value.destroy();
    device.destroy();
  }
});
