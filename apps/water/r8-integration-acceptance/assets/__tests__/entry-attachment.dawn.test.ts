import { AssetGuid } from '@forgeax/engine/pack/source';
import { createVfxEffectContract, vfxParticleCoreField } from '@forgeax/engine/vfx';
import { cookParticleCodeEffect } from '@forgeax/engine/vfx-compiler';
import { expect, it } from 'vitest';
import { WATER_R8_PACKAGE } from '../../src/identity';
import { ironBallEntry } from '../coast.pack';
import { waterEntryModules } from '../entry-program';
import { waterEntrySplashParameters } from '../entry-splash';
import { WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS } from '../vfx/water-entry-splash-material-inputs';

it('moves the attached sheet with the surface and leaves released drops on their own ballistic trajectory', async () => {
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, key));
  const cooked = (
    await cookParticleCodeEffect(ironBallEntry, waterEntryModules, {
      [guid('material/water-entry-splash')]: WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS,
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Expected actual Dawn adapter');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [];
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const collision = {
    entryPosition: [0, -0.324, 0],
    entryVelocity: [0, -5.9, 0],
    surfaceNormal: [0, 1, 0],
    entryRadiusM: 0.6,
  };
  const values = waterEntrySplashParameters(collision);
  const field = (name: Parameters<typeof vfxParticleCoreField>[0]) =>
    vfxParticleCoreField(name).offset / 4;
  const buffer = (size: number, uniform = false) => {
    const result = device.createBuffer({
      size,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    owned.push(result);
    return result;
  };
  try {
    for (const kind of ['tongue', 'drops'] as const) {
      const emitter = cooked.artifact.program.emitters[kind === 'tongue' ? 2 : 0];
      if (!emitter) throw new Error('Missing cooked entry emitter');
      const contract = createVfxEffectContract(emitter.reflection.layout);
      const bindings = [0, 1, 2, 3, 4, 5, 6, 10, 11];
      // Program v5 includes split time lanes and gridEmissionCount, even for
      // this emitter's ordinary update entrypoint.
      const sizes = [112, 320, 4, 28, 20, 12, 124, 112, 64];
      const buffers = sizes.map((size, index) =>
        buffer(size, [1, 10].includes(bindings[index] ?? -1)),
      );
      const selected = (binding: number) => {
        const value = buffers[bindings.indexOf(binding)];
        if (!value) throw new Error('Missing GPU fixture binding');
        return value;
      };
      const layout = device.createBindGroupLayout({
        entries: bindings.map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: binding === 1 || binding === 10 ? 'uniform' : 'storage' },
        })),
      });
      const module = device.createShaderModule({ code: emitter.wgsl });
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'forgeax_vfx_update_main' },
      });
      const group = device.createBindGroup({
        layout,
        entries: bindings.map((binding) => ({ binding, resource: { buffer: selected(binding) } })),
      });
      const state = new Float32Array(28);
      state[field('age')] = kind === 'tongue' ? 0.56 : 0.01;
      state[field('lifetime')] = 2;
      state[field('material_random')] = 0.2;
      new Uint32Array(state.buffer)[field('alive')] = 1;
      device.queue.writeBuffer(selected(0), 0, state);
      device.queue.writeBuffer(selected(5), 0, new Uint32Array([1, 0, 0]));
      const run = async (delta: number, offsetM: number) => {
        const runtime = new Float32Array(80);
        runtime[0] = delta;
        new Uint32Array(runtime.buffer)[4] = 1;
        device.queue.writeBuffer(selected(1), 0, runtime);
        const parameter = contract
          .packParameters(
            contract
              .createValues({
                ...values,
                surfaceOffsetM: [0, offsetM, 0],
                surfaceVelocityMps: [0, 0, 0],
              })
              .unwrap(),
          )
          .unwrap();
        device.queue.writeBuffer(selected(10), 0, parameter);
        const staging = device.createBuffer({
          size: 112,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        owned.push(staging);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(selected(0), 0, staging, 0, 112);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(staging.getMappedRange()).slice();
        staging.unmap();
        expect(result.every(Number.isFinite)).toBe(true);
        return result;
      };
      if (kind === 'tongue') {
        const first = await run(0, 0);
        const attached = await run(0, 0.367);
        expect(first[1]).toBeCloseTo(-0.324, 5);
        expect(attached[1]).toBeCloseTo(0.043, 5);
        expect(attached[field('mesh_scale') + 1]).toBeGreaterThan(0.2);
      } else {
        const attached = await run(0.01, 0.367);
        expect(attached[1]).toBeGreaterThan(0.043);
        const released = await run(0.35, 0.367);
        const free = await run(0.05, -10);
        for (const axis of [0, 1, 2]) {
          const gravity = axis === 1 ? -9.81 : 0;
          expect(free[axis]).toBeCloseTo(
            (released[axis] ?? 0) +
              (released[field('velocity') + axis] ?? 0) * 0.05 +
              0.5 * gravity * 0.05 ** 2,
            5,
          );
          expect(free[field('velocity') + axis]).toBeCloseTo(
            (released[field('velocity') + axis] ?? 0) + gravity * 0.05,
            5,
          );
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    for (const value of owned) value.destroy();
    device.destroy();
    await device.queue.onSubmittedWorkDone();
  }
});
