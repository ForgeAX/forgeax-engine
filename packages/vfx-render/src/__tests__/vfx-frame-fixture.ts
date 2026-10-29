import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AssetVersion,
  runtimeAssetRegistry,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAsset,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import { afterEach } from 'vitest';
import { validateRenderFeaturePlan } from '../../../render/src/features/plan';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { prepareRuntimeParticleEffect } from '../../../vfx/src/runtime-prepare';
import { gpuParticleRenderFeature as createFeature } from '../feature/gpu-particle-feature';

const pinnedFixtures = new Set<AssetVersion<VfxGpuEffectAsset>>();
const fixtureAssets: { assets: AssetRegistry; handle: number }[] = [];
afterEach(() => {
  for (const { assets, handle } of fixtureAssets) assets.release(handle).unwrap();
  fixtureAssets.length = 0;
});
afterEach(() => {
  for (const version of pinnedFixtures) version.dispose();
  pinnedFixtures.clear();
});
const fixtureDefinitions = new WeakMap<World, Map<string, AssetVersion<VfxGpuEffectAsset>>>();

/** Repeated hand-written tick fixtures name one complete definition, captured by the real owner. */
function fixtureVersion(world: World, effect: VfxGpuEffectAsset) {
  if (world.assets === undefined) world.bindAssets(new AssetRegistry()).unwrap();
  let definitions = fixtureDefinitions.get(world);
  if (definitions === undefined) {
    definitions = new Map();
    fixtureDefinitions.set(world, definitions);
  }
  const key = JSON.stringify(effect);
  let version = definitions.get(key);
  if (version === undefined) {
    const assets = runtimeAssetRegistry(world.assets);
    const handle = assets.create(runtimeEffectFixture(world, effect)).unwrap();
    version = runtimeAssets(assets).pin<VfxGpuEffectAsset>(handle).unwrap();
    assets.release(handle).unwrap();
    definitions.set(key, version);
    pinnedFixtures.add(version);
  }
  return { handle: version.handle, revision: version.revision };
}

export function vfxTestEmitter(
  world: World,
  emitter: VfxGpuTickIntent['emitter'],
  fingerprint: string,
  reference?: { effect: number; revision: number; id: string },
) {
  if (world.assets === undefined) world.bindAssets(new AssetRegistry()).unwrap();
  const assets = runtimeAssetRegistry(world.assets);
  const definition: VfxGpuEffectAsset = {
    guid: 'fixture',
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: fingerprint,
    emitters: [{ id: emitter.id, capacity: emitter.capacity }],
    program: { format: 'forgeax-vfx-program-4', fingerprint, emitters: [emitter] },
  };
  const handle =
    reference === undefined
      ? assets.create(runtimeEffectFixture(world, definition)).unwrap()
      : (reference.effect as import('@forgeax/engine-types').AssetHandle<'particle-effect'>);
  if (reference === undefined) fixtureAssets.push({ assets, handle });
  else assets.replace(handle, runtimeEffectFixture(world, definition)).unwrap();
  const version = runtimeAssets(assets).pin<VfxGpuEffectAsset>(handle).unwrap();
  pinnedFixtures.add(version);
  return Object.assign(reference ?? {}, {
    effect: version.handle,
    revision: version.revision,
    id: emitter.id,
  });
}

/** Supply an immutable effect owner for deliberately hand-authored intent fixtures. */
export function vfxTestIntent(
  world: World,
  intent: Omit<VfxGpuTickIntent, 'effect'> & { effect?: VfxGpuEffectAsset },
): VfxGpuTickIntent {
  const effect = runtimeEffectFixture(
    world,
    intent.effect ?? {
      kind: 'particle-effect' as const,
      schemaVersion: 3 as const,
      guid: 'fixture',
      programFingerprint: intent.programFingerprint,
      emitters: [{ id: intent.emitter.id, capacity: intent.emitter.capacity }],
      program: {
        format: 'forgeax-vfx-program-4' as const,
        fingerprint: intent.programFingerprint,
        emitters: [intent.emitter],
      },
    },
  );
  const prepared = prepareRuntimeParticleEffect(effect).unwrap();
  const emitter = prepared.program.emitters.find((row) => row.id === intent.emitter.id);
  if (emitter === undefined) throw new Error('Prepared effect is missing its emitter');
  return {
    ...intent,
    programFingerprint: prepared.program.fingerprint,
    effect: prepared,
    emitter,
  };
}

/** Drive the same source-extract / render-plan / source-ack sequence as the feature host. */
export function gpuParticleRenderFeature(
  options: Parameters<typeof createFeature>[0],
): ReturnType<typeof createFeature> {
  const cameras = new Map<World, NonNullable<ReturnType<typeof options.camera.read>>>();
  return withVfxFrameSubmission(
    createFeature({
      ...options,
      camera: { read: (world, views) => cameras.get(world) ?? options.camera.read(world, views) },
    }),
    cameras,
  );
}

export function withVfxFrameSubmission(
  feature: ReturnType<typeof createFeature>,
  cameras = new Map<
    World,
    Parameters<ReturnType<typeof createFeature>['plan']>[0]['worlds'][number]['camera']
  >(),
): ReturnType<typeof createFeature> {
  type Feature = ReturnType<typeof createFeature>;
  type Frame = Parameters<Feature['plan']>[0];
  type Source = {
    world: World;
    runtime: object;
    camera: Frame['worlds'][number]['camera'];
    intents: unknown[];
  };
  const sources = new WeakMap<object, { current: Source; runtime: object }>();
  const frames = new Map<number, { data: Frame; feedback: unknown }>();
  const extract = feature.extract.bind(feature);
  let sourceWorlds: readonly World[] = [];
  feature.extract = (context) => {
    sourceWorlds = context.worlds;
    return extract({ ...context, views: context.views ?? [{ identity: 'main', render: true }] });
  };
  const plan = feature.plan.bind(feature);
  const submitted = feature.onFrameSubmitted?.bind(feature);
  const aborted = feature.onFrameAborted?.bind(feature);
  feature.plan = (input, context) => {
    let data = input;
    if (input.worlds.some((row) => 'world' in row)) {
      const legacy = input as unknown as { frameNumber: number; worlds: Source[] };
      cameras.clear();
      for (const row of legacy.worlds) {
        let source = sources.get(row.runtime);
        if (source === undefined) {
          source = { current: row, runtime: {} };
          const state = source;
          source.runtime = new Proxy(row.runtime, {
            get(target, key) {
              if (key === 'snapshot')
                return () =>
                  state.current.intents.map((intent) =>
                    vfxTestIntent(state.current.world, intent as VfxGpuTickIntent),
                  );
              const value = Reflect.get(target, key);
              if (value !== undefined)
                return typeof value === 'function' ? value.bind(target) : value;
              if (key === 'renderGeneration') return 0;
              if (key === 'effectVersion')
                return (effect: VfxGpuEffectAsset) => fixtureVersion(state.current.world, effect);
              if (key === 'forEachEmitterSource') return () => {};
              if (key === 'lastCommittedEmitter') return () => undefined;
              return value;
            },
          });
          sources.set(row.runtime, source);
        }
        source.current = row;
        cameras.set(row.world, row.camera);
        row.world.insertResource(VFX_GPU_RUNTIME_RESOURCE_KEY, source.runtime);
      }
      data = feature
        .extract({
          worlds: legacy.worlds.map((row) => row.world),
          owner: 0,
          frameNumber: legacy.frameNumber,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
    }
    const result = plan(
      structuredClone(data),
      singleViewContext({
        ...context,
        resolveAsset:
          context.resolveAsset ??
          ((index, handle, revision) => {
            const world = sourceWorlds[index];
            if (world === undefined) throw new Error(`Missing fixture source World ${index}`);
            return runtimeAssets(world.assets).resolveAsset(handle, revision);
          }),
      }),
    );
    if (result.ok) frames.set(data.frameNumber, { data, feedback: result.value.sourceFeedback });
    return result;
  };
  feature.onFrameSubmitted = (frame, submission) => {
    submitted?.(frame, submission);
    const candidate = frames.get(frame.frameNumber);
    frames.delete(frame.frameNumber);
    if (candidate !== undefined)
      feature.onSourceFrameSubmitted?.(candidate.data, structuredClone(candidate.feedback));
  };
  feature.onFrameAborted = (frame) => {
    frames.delete(frame.frameNumber);
    aborted?.(frame);
  };
  return feature;
}

/** Keep fixture setup concise while exercising the canonical scoped feature contract. */
export function singleViewContext(
  context: Omit<RenderFeaturePlanContext, 'views'> &
    Partial<RenderFeaturePlanView> & { readonly views?: RenderFeaturePlanContext['views'] },
): RenderFeaturePlanContext {
  return {
    ...context,
    views: context.views ?? [
      {
        identity: 'main',
        render: true,
        frame: context.frame,
        targets: context.targets ?? [],
        sceneData: context.sceneData ?? ({} as never),
        ...(context.selectedView === undefined ? {} : { selectedView: context.selectedView }),
      },
    ],
  };
}

export const planResources = (plan: RenderFeaturePlan) =>
  plan.work.flatMap((work) => work.resources);
/** Actual submitted work; disabled declarations retain topology only. */
export const planPasses = (plan: RenderFeaturePlan) =>
  plan.work.flatMap((work) => work.passes).filter((pass) => pass.enabled !== false);

export function freezeVfxPlan(
  identity: string,
  plan: RenderFeaturePlan,
  targets: RenderFeaturePlanView['targets'],
) {
  const shared = plan.work.find((work) => work.scope === 'frame');
  for (const work of plan.work) {
    const closure =
      work.scope === 'frame'
        ? work
        : {
            resources: [...(shared?.resources ?? []), ...work.resources],
            passes: [...(shared?.passes ?? []), ...work.passes],
          };
    const result = validateRenderFeaturePlan(identity, closure, targets);
    if (!result.ok) return result;
  }
  return ok(plan);
}
