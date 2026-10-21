import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { RenderFeaturePlan, RenderFeatureSubmission } from '@forgeax/engine-render';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeaturePlanSignatureSnapshot,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../../../render/src/features/plan';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import {
  createCameraProvider,
  createVfxDataInterfaceRegistry,
} from '../host/data-interface-providers';
import { freezeVfxPlan, planPasses } from './vfx-frame-fixture';

const camera = (x = 0, rotated = false) => ({
  position: new Float32Array([x, 0, 0]),
  right: new Float32Array(rotated ? [0, 0, 1] : [1, 0, 0]),
  up: new Float32Array(rotated ? [1, 0, 0] : [0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
});
const targets = [
  { name: 'color', kind: 'color' as const, format: 'rgba8unorm' as const, sampleCount: 1 as const },
];
const submission = (plan: RenderFeaturePlan): RenderFeatureSubmission => ({
  works: plan.work.map((work) => ({
    scope: work.scope,
    passes: work.passes.map((pass) => ({
      name: pass.name,
      ...(pass.kind === 'compute'
        ? {
            resolvedGpuCompute: {
              dispatches: pass.dispatches.filter(
                (dispatch) => dispatch.kind === 'indirect' || !dispatch.workgroups.includes(0),
              ),
            },
          }
        : {}),
    })),
  })),
});

it.each([
  'renderer',
  'availability-provider',
] as const)('simulates a cooked emitter with %s data interfaces once across view cadence, order, and retries', async (provider) => {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'shared',
            capacity: 8,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
            simulationWhenCulled: 'pause',
            schedule: { rate: 60 },
            program: { module: 'shared.wgsl' },
            renderers: [
              { kind: 'billboard', material: 'particle', sorting: 'view-depth' },
              { kind: 'trail', material: 'particle', capacity: 8, historyLength: 4 },
            ],
          },
        ],
      },
      {
        'shared.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import forgeax_vfx::data::camera
#import forgeax_vfx::data::scene_depth
#import forgeax_vfx::data::noise
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).lifetime = 100.0;
  (*particle).position.y = forgeax_vfx_camera[3][1]
    + textureLoad(forgeax_vfx_scene_depth, vec2<i32>(0, 0), 0)
    + textureLoad(forgeax_vfx_noise, vec2<i32>(0, 0), 0).r;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) { (*particle).position.x += ctx.delta; }`,
        },
      },
    )
  ).unwrap();
  const world = new World({ assets: new AssetRegistry() });
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'shared', capacity: 8 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const effect = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, { ...asset, guid: 'shared-effect' }))
    .unwrap();
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const simulationCamera = camera(500);
  const source = gpuParticleRenderFeature({ camera: { read: () => simulationCamera } });
  let cameraAvailable = true;
  // A different feature instance consumes a structured-cloned publication, as in Render Worker.
  const consumer = gpuParticleRenderFeature({
    camera: { read: () => undefined },
    ...(provider === 'renderer'
      ? {}
      : {
          dataInterfaces: createVfxDataInterfaceRegistry([
            createCameraProvider({ available: () => cameraAvailable }),
          ]),
        }),
  });
  const left = { identity: 'left', render: true, selectedView: camera() };
  const right = { identity: 'right', render: true, selectedView: camera(0, true) };
  const signatureSnapshots = new Map<string, RenderFeaturePlanSignatureSnapshot>();
  let number = 0;
  const frame = (views: readonly (typeof left)[], extractedViews = views) => {
    const frameNumber = ++number;
    const extracted = source
      .extract({ worlds: [world], owner: 0, frameNumber, views: extractedViews })
      .unwrap();
    const plan = consumer
      .plan(structuredClone(extracted), {
        resolveAsset: (_index, handle, revision) =>
          runtimeAssets(world.assets).resolveAsset(handle, revision),
        caps: {} as never,
        generation: 0,
        frame: { frameNumber },
        views: views.map((view) => ({
          ...view,
          targets,
          sceneData: {} as never,
          frame: { frameNumber },
        })),
      })
      .unwrap();
    expect(freezeVfxPlan(consumer.identity, plan, targets).ok).toBe(true);
    for (const work of plan.work) {
      const scope = work.scope === 'frame' ? 'frame' : work.scope.view;
      const previous = signatureSnapshots.get(scope);
      const canonical = renderFeaturePlanSignature(work);
      const snapshot = cloneRenderFeaturePlanSignatureSnapshot(work, previous);
      expect(renderFeaturePlanSignatureSnapshotEquals(work, snapshot)).toBe(true);
      // Reconciliation must not mutate either the producer plan or its exact spelling.
      expect(renderFeaturePlanSignature(work)).toBe(canonical);
      signatureSnapshots.set(scope, snapshot);
    }
    return { extracted, plan };
  };
  const commit = (candidate: ReturnType<typeof frame>) => {
    consumer.onFrameSubmitted?.(candidate.extracted, submission(candidate.plan));
    source.onSourceFrameSubmitted?.(
      candidate.extracted,
      structuredClone(candidate.plan.sourceFeedback),
    );
  };
  try {
    world.update(1 / 60).unwrap();
    const pendingCount = runtime.snapshot().length;
    if (provider === 'availability-provider') {
      cameraAvailable = false;
      const unavailable = frame([left, right]);
      expect(planPasses(unavailable.plan)).toHaveLength(0);
      commit(unavailable);
      expect(runtime.snapshot()).toHaveLength(pendingCount);
      cameraAvailable = true;
    }
    const first = frame([left, right]);
    const shared = first.plan.work.find((work) => work.scope === 'frame');
    if (shared === undefined) throw new Error('missing frame work');
    const simulations = shared.passes.filter((pass) => pass.name.endsWith('.simulate'));
    expect(simulations).toHaveLength(pendingCount);
    expect(shared.resources.filter((resource) => resource.kind === 'scene-depth')).toEqual([
      {
        kind: 'scene-depth',
        name: expect.any(String),
        camera: simulationCamera,
      },
    ]);
    expect(shared.resources.filter((resource) => resource.kind === 'scene-noise')).toHaveLength(1);
    const simulationUniform = shared.resources.find((resource) =>
      resource.name.endsWith('.di-camera'),
    );
    expect(simulationUniform).toMatchObject({
      kind: 'buffer',
      size: 64,
      usage: ['uniform'],
      data: simulationCamera.viewProjection,
    });
    expect(
      shared.passes.filter((pass) => pass.name.endsWith('.history-bindings.write')),
    ).toHaveLength(pendingCount);
    const views = first.plan.work.filter((work) => work.scope !== 'frame');
    expect(views).toHaveLength(2);
    for (const work of views) {
      expect(
        work.resources.some(
          (resource) => resource.kind === 'scene-depth' || resource.kind === 'scene-noise',
        ),
      ).toBe(false);
      expect(work.passes.filter((pass) => pass.kind === 'raster')).toHaveLength(1);
      expect(
        work.passes.flatMap((pass) => (pass.kind === 'raster' ? pass.draws : [])),
      ).toHaveLength(2);
      expect(work.passes.some((pass) => pass.name.endsWith('.simulate'))).toBe(false);
      const projection = work.resources.find(
        (resource) =>
          resource.kind === 'compute-bindings' &&
          resource.name.endsWith('renderer-0.compute-bindings'),
      );
      expect(projection?.kind).toBe('compute-bindings');
      if (projection?.kind !== 'compute-bindings') throw new Error('missing projection bindings');
      expect(projection.entries.find((entry) => entry.binding === 2)?.resource).toContain(
        '.view.renderer-0.alive-indices',
      );
      const copies = work.passes.filter((pass) => pass.kind === 'copy');
      expect(copies).toHaveLength(2);
      expect(copies.map((copy) => (copy.kind === 'copy' ? copy.copies.length : 0))).toEqual([3, 4]);
      expect(copies[1]?.kind === 'copy' && copies[1].copies[3]?.destination).toContain('.history');
      for (const copy of copies) {
        if (copy.kind !== 'copy') throw new Error('missing view copy');
        for (const pair of copy.copies) {
          expect(pair.source).not.toContain('.view.');
          expect(pair.destination).toContain('.view.');
        }
      }
    }
    const bases = views.map((work) => {
      const uniform = work.resources.find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('renderer-0.runtime'),
      );
      if (uniform?.kind !== 'buffer' || uniform.data === undefined)
        throw new Error('missing camera uniform');
      return Array.from(new Float32Array(uniform.data.buffer, uniform.data.byteOffset + 24 * 4, 3));
    });
    expect(bases).toEqual([
      [1, 0, 0],
      [0, 0, 1],
    ]);
    const incomplete = submission(first.plan);
    const acceptedFrame = consumer.inspect().frameNumber;
    consumer.onFrameSubmitted?.(first.extracted, {
      works: incomplete.works.map((work) => ({
        ...work,
        passes: work.passes.filter((pass) => !pass.name.endsWith('.simulate')),
      })),
    });
    expect(consumer.inspect().frameNumber).toBe(acceptedFrame);
    consumer.onFrameAborted?.(first.extracted);
    expect(runtime.snapshot()).toHaveLength(pendingCount);
    const retry = frame([right, left]);
    expect(
      retry.plan.work[0]?.resources.filter((resource) => resource.kind === 'scene-depth'),
    ).toEqual(shared.resources.filter((resource) => resource.kind === 'scene-depth'));
    expect(planPasses(retry.plan).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(
      pendingCount,
    );
    commit(retry);
    expect(runtime.snapshot()).toHaveLength(0);
    // An unacknowledged successor publication must not consume the same simulation again.
    const repeated = consumer
      .plan(structuredClone(retry.extracted), {
        resolveAsset: (_index, handle, revision) =>
          runtimeAssets(world.assets).resolveAsset(handle, revision),
        caps: {} as never,
        generation: 0,
        frame: { frameNumber: number },
        views: [left, right].map((view) => ({
          ...view,
          targets,
          sceneData: {} as never,
          frame: { frameNumber: number },
        })),
      })
      .unwrap();
    expect(planPasses(repeated).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(0);
    // The only visible camera is held this frame. It still contributes visibility for simulation.
    world.update(1 / 60).unwrap();
    const cadence = frame([
      { ...left, selectedView: camera(500) },
      { ...right, render: false },
    ]);
    expect(cadence.plan.work).toHaveLength(2);
    expect(
      planPasses(cadence.plan).filter((pass) => pass.name.endsWith('.simulate')).length,
    ).toBeGreaterThan(0);
    expect(planPasses(cadence.plan).filter((pass) => pass.kind === 'raster')).toHaveLength(0);
    commit(cadence);
    expect(runtime.snapshot()).toHaveLength(0);
    const hiddenViews = [left, right].map((view) => ({ ...view, selectedView: camera(500) }));
    commit(frame(hiddenViews));
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    // The publisher's authored aspect can cull the emitter while the actual view sees it.
    // A no-tick submission still publishes final-view visibility and resumes the source.
    const reentry = frame([left, right], hiddenViews);
    expect(planPasses(reentry.plan).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(
      0,
    );
    commit(reentry);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot().length).toBeGreaterThan(0);
    const resumed = frame([left, right], hiddenViews);
    expect(
      planPasses(resumed.plan).filter((pass) => pass.name.endsWith('.simulate')).length,
    ).toBeGreaterThan(0);
    commit(resumed);
    expect(runtime.snapshot()).toHaveLength(0);
  } finally {
    await context.fiber.dispose();
  }
});
