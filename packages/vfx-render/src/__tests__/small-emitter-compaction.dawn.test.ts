import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
/// <reference types="@webgpu/types" />

import { World } from '@forgeax/engine-ecs';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import { planPasses, singleViewContext, vfxTestEmitter } from './vfx-frame-fixture.js';

const entries = [
  'spawn',
  'update',
  'scan_blocks',
  'scan_block_offsets',
  'add_offsets',
  'compact',
].map((name) => `forgeax_vfx_${name}_main`);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing compaction fixture value');
  return value;
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it.each([
  1, 3, 9, 16, 256, 257,
])('preserves canonical particle state across ticks and replay at capacity %i', async (capacity) => {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'small-compaction',
            capacity,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [1000, 0, 0], radius: 1 },
            schedule: { rate: 0 },
            program: { module: 'compaction.wgsl' },
            renderers: [{ kind: 'billboard', material: 'material' }],
          },
        ],
      },
      {
        'compaction.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){
  (*p).lifetime=select(0.025,0.07,ctx.particleId%2u==0u);
}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){ (*p).position.x+=ctx.delta; }`,
        },
      },
    )
  ).unwrap();
  const emitter = cooked.program.emitters[0];
  if (emitter === undefined) throw new Error('Missing cooked emitter');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Missing Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const groups = Math.ceil(capacity / 256);
  const world = new World();
  const player = world.spawn().unwrap();
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: identity(),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const reference = vfxTestEmitter(world, emitter as never, cooked.fingerprint);
  let sequence = 0;
  const plannedDispatches = (tick: number, cycle: number, spawnCount: number) => {
    const intent = {
      sequence: ++sequence,
      player,
      emitter: reference,

      programFingerprint: runtimeAssets(world.assets)
        .resolveAsset<import('@forgeax/engine-vfx').VfxGpuEffectAsset>(
          reference.effect,
          reference.revision,
        )
        .unwrap().program.fingerprint,
      reset: tick === 0,
      delta: 1 / 60,
      initialDelta: 1 / 60,
      elapsed: (tick + 1) / 60,
      phaseTick: tick,
      tick,
      seed: 7,
      playCycle: cycle,
      spawnCount,
      firstParticleId: 1000 + tick * capacity,
      instanceGeneration: 0,
      channelInputs: [],
      eventCounters: {},
      parameterBlock: new Uint8Array(),
    };
    const frame = {
      frameNumber: sequence,
      worlds: [
        {
          sourceWorldIndex: 0,
          worldId: 0,
          runtimeId: 0,
          renderGeneration: 0,
          camera,
          views: [{ identity: 'main', camera }],
          intents: [intent],
          retained: [],
          materials: new Map(),
          meshes: new Map(),
          emitterState: new Map([
            [
              `${Number(player)}:${emitter.id}`,
              {
                enabled: true,
                localToWorld: identity(),
                player,
                emitter: reference,
              },
            ],
          ]),
        },
      ],
    };
    const plan = feature
      .plan(
        frame as never,
        singleViewContext({
          targets: [],
          caps: {} as never,
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
          generation: 0,
          frame: { frameNumber: sequence } as never,
          sceneData: {} as never,
        }),
      )
      .unwrap();
    const pass = planPasses(plan).find((pass) => pass.name.endsWith('.simulate'));
    if (pass?.kind !== 'compute') throw new Error('Missing planned simulation');
    expect(pass.dispatches.map((dispatch) => dispatch.entryPoint)).toEqual(
      groups === 1 ? ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_compact_main'] : entries,
    );
    return pass.dispatches;
  };
  const make = (words: number, usage = GPUBufferUsage.STORAGE) => {
    const buffer = device.createBuffer({
      size: words * 4,
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    owned.push(buffer);
    return buffer;
  };
  try {
    device.pushErrorScope('validation');
    const layout = device.createBindGroupLayout({
      entries: Array.from({ length: 7 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 1 ? 'uniform' : 'storage' },
      })),
    });
    const module = device.createShaderModule({ code: emitter.wgsl });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = new Map(
      [
        ...entries,
        ...(groups === 1
          ? ['forgeax_vfx_scan_compact_main', 'forgeax_vfx_update_compact_main']
          : []),
      ].map((entryPoint) => [
        entryPoint,
        device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } }),
      ]),
    );
    const sizeWords = [capacity * 28, 76, capacity, 6, 5, capacity * 2 + groups, capacity * 31];
    const states = (groups === 1 ? [0, 1] : [0, 1, 2]).map(() => {
      const buffers = sizeWords.map((words, binding) =>
        make(words, binding === 1 ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE),
      );
      const group = device.createBindGroup({
        layout,
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      return { buffers, group };
    });
    const staging = device.createBuffer({
      size: sizeWords.reduce((sum, size) => sum + size, 0) * 4 * states.length,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    owned.push(staging);
    for (const [pattern, alive] of [
      () => true,
      () => false,
      (index: number) => index % 2 === 0,
    ].entries()) {
      // Replay restores the same initial state; no old block-total value can
      // become a future global prefix or change scheduled-spawn hole ranks.
      for (let replay = 0; replay < 2; replay += 1) {
        const initial = sizeWords.map((words) => new Uint32Array(words));
        const particleFloats = new Float32Array(required(initial[0]).buffer);
        let count = 0;
        for (let index = 0; index < capacity; index += 1) {
          required(initial[5])[capacity + index] = count;
          if (alive(index)) {
            required(initial[5])[index] = 1;
            required(initial[0])[index * 28 + 24] = index;
            required(initial[0])[index * 28 + 25] = 1;
            particleFloats[index * 28 + 7] = 0.04 + (index % 3) * 0.025;
            required(initial[2])[count++] = index;
          }
        }
        required(initial[3])[0] = count;
        required(initial[4]).set([6, count, 0, 0, 0]);
        for (const state of states)
          state.buffers.forEach((buffer, binding) => {
            device.queue.writeBuffer(buffer, 0, required(initial[binding]));
          });
        for (let tick = 0; tick < 6; tick += 1) {
          const spawnCount = tick % 3 === 0 ? capacity + 2 : tick % 3 === 1 ? 0 : 2;
          const selected = plannedDispatches(tick, pattern * 2 + replay, spawnCount);
          const runtime = new Uint32Array(76);
          new Float32Array(runtime.buffer)[0] = 1 / 60;
          runtime.set(
            [tick, 7, pattern * 2 + replay, capacity, spawnCount, 1000 + tick * capacity, 1],
            1,
          );
          const encoder = device.createCommandEncoder();
          states.forEach((state, variant) => {
            if (variant === 2 && (pattern !== 0 || replay !== 0 || tick !== 0)) return;
            device.queue.writeBuffer(required(state.buffers[1]), 0, runtime);
            const pass = encoder.beginComputePass();
            pass.setBindGroup(0, state.group);
            const dispatches =
              variant === 0 || variant === 2
                ? entries.map((entryPoint, index) => ({
                    entryPoint,
                    workgroups: [index === 3 ? 1 : groups] as const,
                  }))
                : selected;
            for (const dispatch of dispatches) {
              // Deliberately omit both offsets across two blocks. This must
              // produce the wrong alive count, proving the readback can fail.
              if (variant === 2 && dispatch.entryPoint.includes('offsets')) continue;
              pass.setPipeline(required(pipelines.get(dispatch.entryPoint)));
              if (!('workgroups' in dispatch)) throw new Error('Unexpected indirect simulation');
              pass.dispatchWorkgroups(
                required(dispatch.workgroups[0]),
                dispatch.workgroups[1],
                dispatch.workgroups[2],
              );
            }
            pass.end();
          });
          let offset = 0;
          for (const state of states)
            for (const buffer of state.buffers) {
              encoder.copyBufferToBuffer(buffer, 0, staging, offset, buffer.size);
              offset += buffer.size;
            }
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          const bytes = new Uint32Array(staging.getMappedRange()).slice();
          staging.unmap();
          const stateWords = sizeWords.reduce((sum, size) => sum + size, 0);
          offset = 0;
          sizeWords.forEach((size, binding) => {
            const compared = binding === 5 ? capacity * 2 : size;
            expect(bytes.slice(stateWords + offset, stateWords + offset + compared)).toEqual(
              bytes.slice(offset, offset + compared),
            );
            offset += size;
          });
          const scratchOffset = sizeWords.slice(0, 5).reduce((sum, size) => sum + size, 0);
          const scratch = bytes.slice(scratchOffset, scratchOffset + capacity * 2);
          let prefix = 0;
          for (let index = 0; index < capacity; index += 1) {
            expect(scratch[capacity + index]).toBe(prefix);
            prefix += required(scratch[index]);
          }
          const countersOffset = sizeWords.slice(0, 3).reduce((sum, size) => sum + size, 0);
          expect(bytes[countersOffset]).toBe(prefix);
          if (groups > 1 && pattern === 0 && replay === 0 && tick === 0) {
            expect([bytes[countersOffset], bytes[stateWords * 2 + countersOffset]]).toEqual([
              capacity,
              1,
            ]);
          }
          expect(bytes[countersOffset + required(sizeWords[3]) + 1]).toBe(prefix);
          const indicesOffset = required(sizeWords[0]) + required(sizeWords[1]);
          expect(Array.from(bytes.slice(indicesOffset, indicesOffset + prefix))).toEqual(
            Array.from({ length: capacity }, (_, index) => index).filter(
              (index) => scratch[index] !== 0,
            ),
          );
        }
      }
    }
    expect((await device.popErrorScope())?.message).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});
