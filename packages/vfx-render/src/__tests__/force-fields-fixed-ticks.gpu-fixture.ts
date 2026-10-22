import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import type { VfxGpuProgram } from '@forgeax/engine-vfx';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
  vfxParticleCoreField,
} from '@forgeax/engine-vfx';
import { expect } from 'vitest';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBindingsRef,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuProgramRef,
} from '../../../render/src/features/prepared-gpu-work';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { singleViewContext } from './vfx-frame-fixture';

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixed-field test resource');
  return value;
}

export async function verifyFixedFieldTicks(cooked: {
  readonly fingerprint: string;
  readonly program: Omit<VfxGpuProgram, 'fingerprint'>;
}): Promise<void> {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  native.pushErrorScope('validation');
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const fieldTexture = (x: number): TextureAsset => {
    const data = new Uint8Array(8 * 8 * 8 * 16);
    const view = new DataView(data.buffer);
    for (let offset = 0; offset < data.byteLength; offset += 16) view.setFloat32(offset, x, true);
    return {
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: 8, height: 8, depth: 8 } },
      format: 'rgba32float',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data,
    };
  };
  const texture = assets.create(fieldTexture(1)).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
    })
    .unwrap();
  const effect = assets
    .create({
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: cooked.fingerprint,
      emitters: [{ id: 'field', capacity: 4 }],
      program: {
        ...cooked.program,
        fingerprint: cooked.fingerprint,
        emitters: cooked.program.emitters.map((emitter) => ({
          ...emitter,
          renderers: emitter.renderers.map((renderer) => ({ ...renderer, material })),
          forceFields: required(emitter.forceFields).map((field) =>
            field.kind === 'vector' ? { ...field, texture } : field,
          ),
        })),
      },
    })
    .unwrap();
  world.spawn({ component: ParticleEffectPlayer, data: { effect } }).unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(transform),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
    }),
  });
  let frameNumber = 0;
  const fieldUploadBytes: number[] = [];
  const execute = async () => {
    const source = feature
      .extract({
        worlds: [world],
        owner: 0,
        views: [{ identity: 'main', render: true }],
        frameNumber: ++frameNumber,
      })
      .unwrap();
    const plan = feature
      .plan(
        source,
        singleViewContext({
          targets: [],
          caps: device.caps,
          generation: 0,
          frame: { frameNumber },
          sceneData: {} as never,
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
        }),
      )
      .unwrap();
    const work = required(plan.work.find((work) => work.scope === 'frame'));
    fieldUploadBytes.push(
      work.resources.reduce(
        (bytes, resource) =>
          bytes +
          (resource.kind === 'buffer' &&
          resource.name.includes('.force-fields.') &&
          resource.name.includes('.upload.')
            ? (resource.data?.byteLength ?? 0)
            : 0),
        0,
      ),
    );
    const session = owner.beginFeature(feature.identity, 0);
    const programs = new Map<string, RenderFeatureGpuProgramRef>();
    const buffers = new Map<string, RenderFeatureGpuBufferRef>();
    const bindings = new Map<string, RenderFeatureGpuBindingsRef>();
    for (const resource of work.resources) {
      if (resource.kind === 'compute-program')
        programs.set(
          resource.name,
          session.prepareProgram(resource.name, resource.program).unwrap(),
        );
      if (resource.kind === 'buffer')
        buffers.set(
          resource.name,
          session
            .prepareBuffer(resource.name, { ...resource, usage: [...resource.usage, 'copy-src'] })
            .unwrap(),
        );
    }
    for (const resource of work.resources)
      if (resource.kind === 'compute-bindings')
        bindings.set(
          resource.name,
          session
            .prepareBindings(resource.name, {
              program: required(programs.get(resource.program)),
              entries: resource.entries.map((entry) => ({
                binding: entry.binding,
                buffer: required(buffers.get(entry.resource)),
              })),
            })
            .unwrap(),
        );
    const encoder = device.createCommandEncoder().unwrap();
    for (const pass of work.passes) {
      if (pass.enabled === false) continue;
      if (pass.kind === 'copy')
        for (const copy of pass.copies) {
          if (copy.enabled === false) continue;
          const from = required(session.resolveBuffer(required(buffers.get(copy.source))));
          const to = required(session.resolveBuffer(required(buffers.get(copy.destination))));
          encoder.copyBufferToBuffer(
            from.buffer,
            copy.sourceOffset ?? 0,
            to.buffer,
            copy.destinationOffset ?? 0,
            copy.size,
          );
        }
      else if (pass.kind === 'compute') {
        const resolved = session
          .resolveComputePass(feature.identity, {
            program: required(programs.get(pass.program)),
            bindings: required(bindings.get(pass.bindings)),
            dispatches: pass.dispatches.map((dispatch) => {
              if (dispatch.kind !== 'direct') throw new Error('Unexpected indirect field dispatch');
              return {
                entryPoint: dispatch.entryPoint,
                workgroups: dispatch.workgroups,
                ...(dispatch.bindings === undefined
                  ? {}
                  : { bindings: required(bindings.get(dispatch.bindings)) }),
              };
            }),
          })
          .unwrap();
        const compute = encoder.beginComputePass();
        for (const dispatch of resolved.dispatches) {
          if (!('workgroups' in dispatch)) throw new Error('Unexpected indirect field dispatch');
          compute.setPipeline(dispatch.pipeline);
          compute.setBindGroup(0, dispatch.bindGroup);
          compute.dispatchWorkgroups(...dispatch.workgroups);
        }
        compute.end();
      }
    }
    const particle = required([...buffers].find(([name]) => name.endsWith('.particles')))[1];
    const buffer = required(session.resolveBuffer(particle));
    const readback = device.createBuffer({ size: buffer.size, usage: 1 | 8 }).unwrap();
    encoder.copyBufferToBuffer(buffer.buffer, 0, readback, 0, buffer.size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const velocity = new DataView(mapped.getMappedRange().unwrap()).getFloat32(
      vfxParticleCoreField('velocity').offset,
      true,
    );
    mapped.unmap();
    device.destroyBuffer(readback).unwrap();
    feature.onFrameSubmitted?.(source, {
      works: [
        {
          scope: 'frame',
          passes: work.passes
            .filter((pass) => pass.enabled !== false)
            .map((pass) => ({ name: pass.name })),
        },
      ],
    });
    feature.onSourceFrameSubmitted?.(source, plan.sourceFeedback);
    for (const lease of session.commitFrame()) lease.release().unwrap();
    return velocity;
  };
  try {
    world.update(1 / 60).unwrap();
    const initial = await execute();
    world.update(1 / 60).unwrap();
    assets.replace(texture, fieldTexture(3)).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(2);
    const queued = await execute();
    expect(queued - initial).toBeCloseTo(4 / 60, 6);
    // The wrong latest-only field would add 6/60 to both queued ticks.
    expect(Math.abs(queued - initial - 6 / 60)).toBeGreaterThan(0.02);
    world.update(1 / 60).unwrap();
    const edited = new Uint8Array(16);
    new DataView(edited.buffer).setFloat32(0, 5, true);
    assets
      .writeRange(texture, {
        origin: { x: 4, y: 4, z: 4 },
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        data: edited,
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const narrow = await execute();
    expect(narrow - queued).toBeCloseTo(8 / 60, 6);
    expect(fieldUploadBytes[0]).toBe(176 + 8192);
    expect(fieldUploadBytes.at(-1)).toBe(16);
    for (let frame = 3; frame < 60; frame++) {
      world.update(1 / 60).unwrap();
      await execute();
    }
    expect(fieldUploadBytes.slice(3).every((bytes) => bytes === 0)).toBe(true);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    await ctx.fiber.dispose();
    owner.dispose().unwrap();
    assets.dispose();
  }
}
