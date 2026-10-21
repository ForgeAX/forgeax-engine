import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../../render/src/features/host';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeaturePlanSignatureSnapshot,
  type RenderFeatureSignatureTokenReuseMetrics,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignature,
} from '../../../render/src/features/plan';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import { cookedEffectFixture } from '../../../vfx/src/__tests__/cooked-effect-fixture';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

const camera = {
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
const layout = {
  version: 3,
  parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:controlled-layout',
};
const rawEffect = {
  guid: 'controlled-layout',
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: 'sha256:controlled-layout',
  emitters: [{ id: 'emitter', capacity: 4 }],
  program: {
    format: 'forgeax-vfx-program-4',
    fingerprint: 'sha256:controlled-layout',
    emitters: [
      {
        id: 'emitter',
        module: 'controlled-layout.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 1, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// controlled layout, not a native shader compilation test',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_update_main',
            'forgeax_vfx_billboard_main',
          ],
          bindings: [{ entries: [] }],
          layout,
          dataInterfaces: [],
          eventChannels: [],
          events: [],
          eventEntryPoint: 'forgeax_vfx_event_main',
          stages: [],
          renderers: [
            {
              topology: 'billboard',
              resource: 'billboardInstances',
              capacity: 4,
              overflow: 'drop-newest',
              enabled: true,
              shaderInputs: [],
              attributes: {},
              materialInputs: [],
            },
          ],
        },
        renderers: [{ kind: 'billboard', material: 'controlled-material' }],
      },
    ],
  },
} as unknown as VfxGpuEffectAsset;
const effect = await cookedEffectFixture(rawEffect);

function describePlan(plan: RenderFeatureWorkPlan) {
  return {
    resourceOrder: plan.resources.map((r) => r.name),
    passOrder: plan.passes.map((p) => p.name),
    activePassOrder: plan.passes.filter((p) => p.enabled !== false).map((p) => p.name),
    simulationBindings: plan.passes.flatMap((pass) =>
      pass.kind === 'compute' && pass.enabled !== false
        ? pass.dispatches
            .filter(
              (dispatch) =>
                /^forgeax_vfx_update(?:_compact)?_main$/.test(dispatch.entryPoint) &&
                (dispatch.kind !== 'direct' || dispatch.workgroups[0] > 0),
            )
            .map((dispatch) => dispatch.bindings ?? pass.bindings)
        : [],
    ),
    resetParticles: plan.passes.flatMap((pass) =>
      pass.kind === 'copy' && pass.enabled !== false
        ? pass.copies
            .filter((copy) => copy.enabled !== false && copy.destination.endsWith('.particles'))
            .map((copy) => copy.destination)
        : [],
    ),
    rasterDrawOrder: plan.passes.flatMap((p) =>
      p.kind === 'raster' ? p.draws.map((draw) => draw.program) : [],
    ),
    resources: Object.fromEntries(
      plan.resources.map((r) => [
        r.name,
        renderFeaturePlanSignature({ resources: [r], passes: [] }),
      ]),
    ),
    passes: Object.fromEntries(
      plan.passes.map((p) => [p.name, renderFeaturePlanSignature({ resources: [], passes: [p] })]),
    ),
    signature: renderFeaturePlanSignature(plan),
  };
}

it('distinguishes actual managed VFX queued/retained ordering from tick-count topology', async () => {
  const world = new World({ assets: new AssetRegistry() });
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, effect))
    .unwrap();
  const players = Array.from({ length: 2 }, (_, i) =>
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: i + 1, timeScale: 1 },
      })
      .unwrap(),
  );
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const host = createRenderFeatureHost([feature]).unwrap();
  const frame = (frameNumber: number, label: string) => {
    const queued = runtime.snapshot().map((i) => ({
      player: Number(i.player),
      reset: i.reset,
      phaseTick: i.phaseTick,
      sequence: i.sequence,
    }));
    const batch = runRenderFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [world],
        owner: 0,
        frameNumber,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
        selectedView: camera,
      },
    ]);
    expect(batch.frame.errors).toEqual([]);
    const shared = batch.frame.plans[0],
      view = batch.views.get('main')?.plans[0];
    if (shared === undefined || view === undefined)
      throw new Error('Missing actual scoped VFX plan');
    const row = {
      label,
      queued,
      frame: describePlan(shared.plan),
      view: describePlan(view.plan),
      viewPlan: view.plan,
    };
    batch.frame.onSubmitted();
    for (const v of batch.views.values()) v.onSubmitted();
    batch.onSubmitted();
    for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
    return row;
  };
  try {
    world.update(1 / 60).unwrap();
    const both = frame(1, 'both-queued');
    expect(runtime.snapshot()).toHaveLength(0);
    const firstPlayer = players[0];
    if (firstPlayer === undefined) throw new Error('Missing first managed particle player');
    world.set(firstPlayer, ParticleEffectPlayer, { timeScale: 0 }).unwrap();
    world.update(1 / 60).unwrap();
    const one = frame(2, 'first-retained-second-queued');
    expect(both.frame.simulationBindings).toHaveLength(2);
    expect(new Set(both.frame.simulationBindings).size).toBe(2);
    expect(both.frame.resetParticles).toHaveLength(2);
    expect(new Set(both.frame.resetParticles).size).toBe(2);
    expect(one.frame.simulationBindings).toHaveLength(1);
    expect(one.frame.resetParticles).toEqual([]);
    expect(one.view.resources).toEqual(both.view.resources);
    expect(one.view.passes).not.toEqual(both.view.passes);
    expect(one.view.rasterDrawOrder).toEqual([...both.view.rasterDrawOrder].reverse());
    expect(one.view.resourceOrder).toEqual(both.view.resourceOrder);
    expect(one.view.passOrder).not.toEqual(both.view.passOrder);
    expect(one.view.signature).not.toBe(both.view.signature);
    // Stable declarations still reuse immutable module tokens when the ordered
    // passes change. This isolates signature work, not native shader execution.
    const previous = cloneRenderFeaturePlanSignatureSnapshot(both.viewPlan);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const next = cloneRenderFeaturePlanSignatureSnapshot(one.viewPlan, previous);
      expect(next.resources).toBe(previous.resources);
      expect(next).not.toBe(previous);
      expect(
        stringify.mock.calls.filter(
          ([value]) => typeof value === 'string' && value.includes('controlled layout'),
        ),
      ).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }

    const retained = frame(3, 'both-retained-no-fixed-tick');
    expect(retained.frame.resources).toEqual(one.frame.resources);
    expect(retained.frame.resourceOrder).toEqual(one.frame.resourceOrder);
    expect(retained.frame.activePassOrder).toEqual([]);
    expect(retained.view.resources).toEqual(one.view.resources);
    expect(retained.view.resourceOrder).toEqual(one.view.resourceOrder);
    expect(retained.view.passOrder).toEqual(both.view.passOrder);
    expect(retained.view.passes).toEqual(both.view.passes);
    expect(retained.view.rasterDrawOrder).toEqual(both.view.rasterDrawOrder);
  } finally {
    gpu.dispose().unwrap();
    host.dispose().unwrap();
    await ctx.fiber.dispose();
  }
});

it('keeps managed module snapshots exact without reserializing shared programs', async () => {
  const world = new World({ assets: new AssetRegistry() });
  const asset = (tag: string): VfxGpuEffectAsset => ({
    ...effect,
    guid: tag,
    programFingerprint: `sha256:${tag}`,
    program: {
      ...effect.program,
      fingerprint: `sha256:${tag}`,
      emitters: effect.program.emitters.map((emitter) => ({
        ...emitter,
        wgsl: `// controlled layout ${tag}\n`.repeat(1000) + emitter.wgsl,
      })),
    },
  });
  const handles = ['first', 'second', 'third'].map((tag) =>
    runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, asset(tag)))
      .unwrap(),
  );
  const sharedHandles = handles.slice(0, 2);
  const thirdHandle = handles[2];
  if (thirdHandle === undefined) throw new Error('Missing third controlled effect');
  const players = Array.from({ length: 16 }, (_, index) =>
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: sharedHandles[index % 2] ?? thirdHandle,
          playing: true,
          seed: index + 1,
          timeScale: 1,
        },
      })
      .unwrap(),
  );
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const host = createRenderFeatureHost([
    gpuParticleRenderFeature({ camera: { read: () => camera } }),
  ]).unwrap();
  let previousFrame: RenderFeaturePlanSignatureSnapshot | undefined;
  let previousView: RenderFeaturePlanSignatureSnapshot | undefined;
  const frame = (frameNumber: number) => {
    world.update(1 / 60).unwrap();
    const batch = runRenderFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [world],
        owner: 0,
        frameNumber,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
        selectedView: camera,
      },
    ]);
    try {
      expect(batch.frame.errors).toEqual([]);
      const plans = [batch.frame.plans[0]?.plan, batch.views.get('main')?.plans[0]?.plan];
      const metrics: RenderFeatureSignatureTokenReuseMetrics = {
        lookups: 0,
        hits: 0,
        remembered: 0,
        serializedCharacters: 0,
        environmentFallbacks: 0,
        budgetFallbacks: 0,
      };
      for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];
        if (plan === undefined) throw new Error('Missing actual scoped VFX plan');
        const previous = index === 0 ? previousFrame : previousView;
        const expected = cloneRenderFeaturePlanSignatureSnapshot(plan, previous);
        const actual = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan, previous, metrics);
        expect(actual).toEqual(expected);
        if (index === 0) previousFrame = expected;
        else previousView = expected;
      }
      batch.frame.onSubmitted();
      for (const view of batch.views.values()) view.onSubmitted();
      batch.onSubmitted();
      // The real host already admitted these immutable programs. Further signature
      // snapshots must use the owned nodes instead of scanning shader bodies.
      expect(metrics.serializedCharacters).toBe(0);
      expect(metrics.hits).toBe(0);
      return plans[0]?.resources.filter((resource) => resource.kind === 'compute-program').length;
    } finally {
      for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
    }
  };
  try {
    expect(frame(1)).toBe(2);
    const added = world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: thirdHandle,
          playing: true,
          seed: 17,
          timeScale: 1,
        },
      })
      .unwrap();
    expect(frame(2)).toBe(3);
    const retired = players[0];
    if (retired === undefined) throw new Error('Missing first managed player');
    world.despawn(retired).unwrap();
    expect(frame(3)).toBe(3);
    world.set(added, ParticleEffectPlayer, { timeScale: 0 }).unwrap();
    expect(frame(4)).toBe(3);
    const changed = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, asset('changed-wgsl')))
      .unwrap();
    world.set(added, ParticleEffectPlayer, { effect: changed, timeScale: 1 }).unwrap();
    expect(frame(5)).toBe(3);
    for (const player of [...players.slice(1), added]) world.despawn(player).unwrap();
    for (let index = 0; index < 16; index++) {
      world
        .spawn({
          component: ParticleEffectPlayer,
          data: {
            effect: runtimeAssetRegistry(world.assets)
              .create(runtimeEffectFixture(world, asset(`unique-${index}`)))
              .unwrap(),
            playing: true,
            seed: index + 1,
            timeScale: 1,
          },
        })
        .unwrap();
    }
    expect(frame(6)).toBe(16);
  } finally {
    gpu.dispose().unwrap();
    host.dispose().unwrap();
    await context.fiber.dispose();
  }
});
