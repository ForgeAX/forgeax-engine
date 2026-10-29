import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  prepareVfxGpuEffect,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { createRenderFeatureHost } from '../../../render/src/features/host';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import type { RenderFeatureWork } from '../../../render/src/features/types';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

const camera = {
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
async function fixture(storageLimit = 8, nativePlanning = true) {
  const cooked = (
    await cookParticleCodeEffect(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'spark',
            capacity: 16,
            backend: { required: 'gpu' },
            space: 'world',
            schedule: { rate: 60 },
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
            program: { module: 'spark' },
            renderers: [{ kind: 'billboard', material: 'material' }],
          },
        ],
      },
      {
        spark: {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
struct VfxCustom { heat:f32, }
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>,c:ptr<function,VfxCustom>){(*c).heat=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>,c:ptr<function,VfxCustom>){(*c).heat+=ctx.delta;}`,
        },
      },
    )
  ).unwrap();
  const effect = (
    await prepareVfxGpuEffect({
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45c',
      kind: 'particle-effect',
      payload: cooked.asset as unknown as Record<string, unknown>,
      artifacts: {
        'particle-effect/program.json': {
          descriptor: {
            path: 'program.json',
            mediaType: 'application/vnd.forgeax.vfx-program+json',
          },
          bytes: cooked.artifact.bytes,
        },
      },
    })
  ).unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
      values: { baseColor: [1, 1, 1, 1] },
    })
    .unwrap();
  const world = new World({ assets }),
    handle = assets
      .create({
        ...effect,
        program: {
          ...effect.program,
          emitters: effect.program.emitters.map((emitter) => ({
            ...emitter,
            renderers: emitter.renderers.map((renderer) => ({ ...renderer, material })),
          })),
        },
      })
      .unwrap(),
    players = [0, 1].map((seed) =>
      world
        .spawn({
          component: ParticleEffectPlayer,
          data: { effect: handle, seed, preparePipelines: true },
        })
        .unwrap(),
    );
  assets.release(handle).unwrap();
  assets.release(material).unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]),
    runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY),
    device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    shader = (await rhi.createShaderModule(device, { code: 'structural' })).unwrap();
  const codes: string[] = [],
    gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: (desc) => {
          codes.push(desc.code);
          return ok(shader);
        },
      }),
    }),
    raw = gpuParticleRenderFeature({
      camera: { read: () => camera },
      instanceArenas: true,
      nativePlanning,
      retainedResources: true,
      isolateViewGraph: true,
    });
  const admissions: { scope: string; uniformBuffers: number }[] = [];
  const uploads: { scope: string; bytes: number }[] = [];
  let work: readonly RenderFeatureWork[] = [];
  const feature = {
      ...raw,
      plan(source: Parameters<typeof raw.plan>[0], input: Parameters<typeof raw.plan>[1]) {
        const create = input.createNativePlan;
        const planned = raw.plan(source, {
          ...input,
          limits: { ...input.limits, maxStorageBuffersPerShaderStage: storageLimit },
          ...(create === undefined
            ? {}
            : {
                createNativePlan() {
                  const builder = create();
                  const admission = builder.resourceAdmission;
                  return {
                    ...builder,
                    scope: builder.scope,
                    ...(admission === undefined
                      ? {}
                      : {
                          resourceAdmission: {
                            ...admission,
                            admit(scope, resources) {
                              admissions.push({
                                scope: scope === 'frame' ? 'frame' : scope.view,
                                uniformBuffers: resources.filter(
                                  (resource) =>
                                    resource.kind === 'buffer' &&
                                    resource.usage.includes('uniform'),
                                ).length,
                              });
                              return admission.admit(scope, resources);
                            },
                            upload(scope, name, offset, data) {
                              uploads.push({
                                scope: scope === 'frame' ? 'frame' : scope.view,
                                bytes: data.byteLength,
                              });
                              admission.upload(scope, name, offset, data);
                            },
                          },
                        }),
                    finish(next, feedback, options) {
                      work = next;
                      return builder.finish(next, feedback, options);
                    },
                  };
                },
              }),
        });
        if (planned.ok && planned.value.native === undefined) work = planned.value.work;
        return planned;
      },
    },
    host = createRenderFeatureHost([feature]).unwrap();
  let sequence = 0;
  const frame = (generation = 0) => {
    const frameNumber = ++sequence;
    const batch = host.runFrame(
      ['main', 'side'].map((identity) => ({
        identity,
        render: true,
        worlds: [world],
        owner: 0,
        frameNumber,
        generation,
        caps: device.caps,
        gpuWork: gpu,
        selectedView: camera,
      })),
    );
    expect(batch.frame.errors).toEqual([]);
    for (const view of batch.views.values()) expect(view.errors).toEqual([]);
    return {
      batch,
      work,
      close(submit = true) {
        if (submit) {
          batch.frame.onSubmitted();
          for (const view of batch.views.values()) view.onSubmitted();
          batch.onSubmitted();
        } else batch.onAborted();
        for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
      },
    };
  };
  return {
    world,
    players,
    runtime,
    codes,
    admissions,
    uploads,
    frame,
    async close() {
      gpu.dispose().unwrap();
      host.dispose().unwrap();
      await context.fiber.dispose();
      for (const player of players)
        if (world.get(player, ParticleEffectPlayer).ok) world.despawn(player).unwrap();
      assets.dispose();
    },
  };
}
it('keeps native direct packets frame-private through abort, queued ticks, views, and recovery', async () => {
  const f = await fixture();
  try {
    // Two updates before one render queue two ticks per player.
    f.world.update(1 / 60).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.runtime.snapshot()).toHaveLength(4);
    const aborted = f.frame();
    expect(aborted.work.flatMap((w) => w.resources).some((r) => r.name.endsWith('.table'))).toBe(
      true,
    );
    const retained = structuredClone(aborted.work);
    aborted.close(false);
    expect(f.runtime.snapshot()).toHaveLength(4);
    const accepted = f.frame();
    expect(f.codes.some((code) => code.includes('forgeax_vfx_batch_jobs'))).toBe(true);
    accepted.close();
    expect(f.runtime.snapshot()).toHaveLength(0);
    expect(aborted.work).toEqual(retained);
    const views = accepted.work.filter((w) => w.scope !== 'frame');
    expect(views).toHaveLength(2);
    expect(
      new Set(
        views
          .flatMap((w) => w.resources)
          .filter((r) => r.name.endsWith('.table'))
          .map((r) => r.name),
      ).size,
    ).toBe(2);
    f.runtime.recover();
    f.world.update(1 / 60).unwrap();
    const recovered = f.frame(1);
    recovered.close();
    expect(f.runtime.snapshot()).toHaveLength(0);
    expect(aborted.work).toEqual(retained);
    for (const player of f.players) f.world.despawn(player).unwrap();
    f.world.update(1 / 60).unwrap();
    f.frame(1).close();
  } finally {
    await f.close();
  }
});
it('keeps the original compute ABI when the device cannot bind eight storage buffers', async () => {
  const f = await fixture(7);
  try {
    f.world.update(1 / 60).unwrap();
    const row = f.frame();
    expect(row.work.flatMap((w) => w.resources).some((r) => r.name.endsWith('.table'))).toBe(false);
    expect(f.codes.some((code) => code.includes('forgeax_vfx_batch_jobs'))).toBe(false);
    row.close();
    expect(f.runtime.snapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('uses only the job table for current batch projection runtime bytes', async () => {
  const f = await fixture();
  try {
    f.world.update(1 / 30).unwrap();
    f.frame().close();
    const views = f.admissions.filter((row) => row.scope !== 'frame');
    expect(views).toHaveLength(4);
    expect(views.every((row) => row.uniformBuffers === 0)).toBe(true);
    expect(f.uploads.filter((row) => row.scope !== 'frame')).toEqual([]);
    f.world.update(1 / 60).unwrap();
    const next = f.frame();
    expect(
      next.work
        .filter((row) => row.scope !== 'frame')
        .every((row) =>
          row.resources.some(
            (resource) =>
              resource.kind === 'buffer' &&
              resource.name.endsWith('.table') &&
              resource.data?.byteLength === 2 * 336,
          ),
        ),
    ).toBe(true);
    next.close();
    expect(f.runtime.snapshot()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it.each([
  ['device fallback', 7, true],
  ['ordinary planning', 8, false],
] as const)('keeps projection uniform admission and current uploads for %s', async (_label, limit, nativePlanning) => {
  const f = await fixture(limit, nativePlanning);
  try {
    f.world.update(1 / 60).unwrap();
    const row = f.frame();
    expect(
      row.work
        .flatMap((work) => work.resources)
        .some((resource) => resource.name.endsWith('.table')),
    ).toBe(false);
    if (!nativePlanning) {
      const projections = row.work.flatMap((work) => {
        const resources = new Map(work.resources.map((resource) => [resource.name, resource]));
        return work.resources.flatMap((resource) => {
          if (resource.kind !== 'compute-bindings' || !resource.name.includes('.renderer-'))
            return [];
          const binding = resource.entries.find((entry) => entry.binding === 1);
          return binding === undefined
            ? []
            : [{ binding, buffer: resources.get(binding.resource) }];
        });
      });
      expect(projections).toHaveLength(4);
      for (const { binding, buffer } of projections) {
        expect(binding.size).toBe(304);
        expect(buffer?.kind).toBe('buffer');
        if (buffer?.kind !== 'buffer') throw new Error('Missing ordinary projection uniform');
        expect(buffer.usage).toContain('uniform');
        expect(
          buffer.uploads?.some(
            (upload) => upload.offset === (binding.offset ?? 0) && upload.data.byteLength === 304,
          ),
        ).toBe(true);
      }
    } else {
      expect(f.admissions.filter((entry) => entry.scope !== 'frame')).toHaveLength(4);
      expect(
        f.admissions
          .filter((entry) => entry.scope !== 'frame')
          .every((entry) => entry.uniformBuffers > 0),
      ).toBe(true);
      expect(
        f.uploads.filter((entry) => entry.scope !== 'frame' && entry.bytes === 304),
      ).toHaveLength(4);
    }
    row.close();
  } finally {
    await f.close();
  }
});
