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
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../../render/src/__tests__/feature-frame-driver';
import { createRenderFeatureHost } from '../../../render/src/features/host';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import type { RenderFeatureWork } from '../../../render/src/features/types';
import { encodeEventBuffer } from '../feature/event-resources';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

const camera = {
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
async function fixture(
  storageLimit = 8,
  nativePlanning = true,
  dynamicInputs = false,
  retainedResources = true,
) {
  const cooked = (
    await cookParticleCodeEffect(
      {
        schemaVersion: 3,
        ...(dynamicInputs ? { parameters: { gain: { type: 'f32', default: 1 } } } : {}),
        emitters: [
          {
            id: 'spark',
            ...(dynamicInputs
              ? {
                  channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
                  events: [
                    {
                      id: 'impact-event',
                      channel: 'impact',
                      subEmitter: 'spark',
                      fanOut: 2,
                      recursionDepth: 1,
                    },
                  ],
                }
              : {}),
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
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>,c:ptr<function,VfxCustom>){(*c).heat=${dynamicInputs ? 'vfx_parameters().gain' : '1.0'};}
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
      retainedResources,
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
    const batch = prepareFeatureFrame(
      host,
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
      // Separate settlement from leases so tests can retain completed old plans.
      settle(submit = true) {
        if (submit) submitFeatureFrame(host);
        else abortFeatureFrame(host);
      },
      release() {
        for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
      },
      close(submit = true) {
        this.settle(submit);
        this.release();
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
              resource.data?.byteLength === 2 * 352,
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
        expect(binding.size).toBe(320);
        expect(buffer?.kind).toBe('buffer');
        if (buffer?.kind !== 'buffer') throw new Error('Missing ordinary projection uniform');
        expect(buffer.usage).toContain('uniform');
        expect(
          buffer.uploads?.some(
            (upload) => upload.offset === (binding.offset ?? 0) && upload.data.byteLength === 320,
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
        f.uploads.filter((entry) => entry.scope !== 'frame' && entry.bytes === 320),
      ).toHaveLength(4);
    }
    row.close();
  } finally {
    await f.close();
  }
});

function plannedInputBytes(work: readonly RenderFeatureWork[]): number[][] {
  const bytes = (value: ArrayBufferView) => [
    ...new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  ];
  return work.flatMap((row) =>
    row.resources.flatMap((resource) => {
      if (resource.kind !== 'buffer') return [];
      return [
        ...(resource.data === undefined ? [] : [bytes(resource.data)]),
        ...(resource.uploads ?? []).map((upload) => bytes(upload.data)),
      ];
    }),
  );
}

it.each([
  false,
  true,
])('preserves current events and parameters while retaining only core storage: %s', async (retainCore) => {
  const f = await fixture(8, true, true, retainCore);
  const heldPlans: ReturnType<typeof f.frame>[] = [];
  const cameraBefore = [...camera.position];
  try {
    f.world.update(1 / 60).unwrap();
    const change = (gain: number, eventCount: number) => {
      for (const player of f.players) {
        const instance = f.runtime.getInstance(player);
        expect(instance, `player must have a current instance before gain ${gain}`).toBeDefined();
        f.runtime.patchParameters(player, { gain }).unwrap();
        for (let index = 0; index < eventCount; index++)
          instance
            ?.submit({
              channel: 'impact',
              sequence: gain * 10 + index,
              payload: { position: [gain, index, -gain], strength: gain / 10 },
            })
            .unwrap();
      }
      camera.position[0] = gain;
      f.world.update(1 / 60).unwrap();
    };
    // The public runtime captures three different parameter/event snapshots.
    change(3, 2);
    change(5, 1);
    const expected = f.runtime.snapshot().map((intent) => ({
      parameters: [...intent.parameterBlock],
      events: [...encodeEventBuffer(intent)],
    }));
    expect(expected.some((row) => row.events.slice(0, 64).every((value) => value === 255))).toBe(
      true,
    );
    const held = f.frame();
    heldPlans.push(held);
    const originalHeld = structuredClone(held.work);
    expect(
      held.work
        .flatMap((row) => row.resources)
        .some(
          (resource) =>
            resource.kind === 'compute-bindings' &&
            resource.entries.some((entry) => (entry.offset ?? 0) > 0),
        ),
    ).toBe(true);
    const actual = plannedInputBytes(held.work);
    for (const tick of expected) {
      expect(actual).toContainEqual(tick.parameters);
      expect(actual).toContainEqual(tick.events);
    }
    // A subsequent candidate invalidates the unsubmitted current transaction;
    // its already published input arrays must nevertheless remain readable.
    change(7, 0);
    const aborted = f.frame();
    heldPlans.push(aborted);
    const originalAborted = structuredClone(aborted.work);
    expect(held.work).toEqual(originalHeld);
    const queued = f.runtime.snapshot().map((intent) => intent.sequence);
    aborted.settle(false);
    expect(f.runtime.snapshot().map((intent) => intent.sequence)).toEqual(queued);
    const retried = f.frame();
    heldPlans.push(retried);
    for (const intent of f.runtime.snapshot()) {
      expect(plannedInputBytes(retried.work)).toContainEqual([...intent.parameterBlock]);
      expect(plannedInputBytes(retried.work)).toContainEqual([...encodeEventBuffer(intent)]);
    }
    retried.settle();
    expect(f.runtime.snapshot()).toHaveLength(0);
    const originalSubmitted = structuredClone(retried.work);
    change(9, 0);
    const next = f.frame();
    next.close();
    expect(retried.work).toEqual(originalSubmitted);
    expect(aborted.work).toEqual(originalAborted);
    expect(held.work).toEqual(originalHeld);
    for (const player of f.players)
      f.world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
    f.world.update(1 / 60).unwrap();
    f.frame().close();
    expect(f.runtime.snapshot()).toHaveLength(0);
    for (const player of f.players)
      f.world.set(player, ParticleEffectPlayer, { playing: true }).unwrap();
    // Restart/recovery must still use the ordinary current input declarations.
    f.runtime.recover();
    // Recovery intentionally clears instances. The authored Player restarts on
    // the next real update; keep that queued tick in the same byte/ACK oracle.
    f.world.update(1 / 60).unwrap();
    change(11, 1);
    const recovered = f.frame(1);
    for (const intent of f.runtime.snapshot()) {
      expect(plannedInputBytes(recovered.work)).toContainEqual([...intent.parameterBlock]);
      expect(plannedInputBytes(recovered.work)).toContainEqual([...encodeEventBuffer(intent)]);
    }
    recovered.close();
    expect(f.runtime.snapshot()).toHaveLength(0);
    // The original implementation reaches this assertion with no admitted core.
    // This is a behavior RED after the same input/ACK/lifetime controls above.
    expect(f.admissions.some((row) => row.scope === 'frame' && row.uniformBuffers === 0)).toBe(
      retainCore,
    );
    expect(f.uploads.filter((row) => row.scope === 'frame' && row.bytes === 320)).toEqual([]);
  } finally {
    for (const plan of heldPlans) plan.release();
    camera.position.set(cameraBefore);
    await f.close();
  }
});
