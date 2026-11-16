import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { AssetHandle } from '@forgeax/engine-types';
import { sharedFeatureGraphPassPrefix } from '../features/frame-plan';
import { prepareRenderFeatureGraphTextureTargets } from '../features/graph-texture-targets';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
} from '../features/host';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
} from '../features/render-graph-contribution';
import type { RenderFeatureGraphTargetResolver } from '../features/render-graph-raster';
import {
  canonicalSharedGraphTextures,
  publishSharedGraphTextures,
  type SharedGraphTextureExport,
  type SharedGraphTexturePublication,
  sharedGraphTextures,
  sharedGraphTextureTopology,
} from '../features/shared-graph-textures';
import type { RenderResourceScope } from '../publication/resource-scope';
import { activeRenderProfileSession } from '../record/profile-session';
import { type RenderSystemInternals, runProfiledRenderPhase } from '../record/render-context';
import {
  WATER_ADVANCED_FEATURE_IDENTITY,
  waterAdvancedShallowFoamTargets,
} from '../water/advanced-feature';
import { waterFluidRenderFrame } from '../water/fluid-feature';
import {
  addWaterFluidSharedGraph,
  type WaterFluidGraphFrame,
  type WaterFluidMaterialPublication,
} from '../water/fluid-graph';
import {
  WATER_INFO_FEATURE_IDENTITY,
  waterInfoFramePublicationForRenderer,
} from '../water/water-info-feature';

export interface SharedFeatureGraphPublication extends SharedGraphTexturePublication {
  readonly waterFluid: ReadonlyMap<string, WaterFluidMaterialPublication>;
}

/** The existing shared graph publication also retains its exact consumer payloads. */
export function sharedFeatureGraphPublication(
  owner: object | undefined,
): SharedFeatureGraphPublication | undefined {
  return sharedGraphTextures(owner) as SharedFeatureGraphPublication | undefined;
}

/** View producers promoted into the shared graph retain their original scope and pass roster. */
export function sharedFeatureHoistedPlans(
  views: RenderFeatureFrameBatch['views'] | undefined,
): readonly RenderFeaturePlanExecution[] {
  return [...(views?.values() ?? [])]
    .flatMap((view) => view.plans)
    .filter(
      (plan) =>
        plan.featureIdentity === WATER_INFO_FEATURE_IDENTITY ||
        plan.featureIdentity === WATER_ADVANCED_FEATURE_IDENTITY,
    )
    .map(getRenderFeaturePlanExecutionProjection)
    .filter((plan): plan is RenderFeaturePlanExecution => plan !== undefined)
    .map((plan) => ({
      ...plan,
      passes:
        plan.featureIdentity === WATER_INFO_FEATURE_IDENTITY
          ? plan.passes.filter((pass) => pass.name.startsWith('water-info-'))
          : plan.passes,
    }));
}

/** Compile frame-scoped Feature work; execution and retirement belong to Render World. */
export function compileSharedFeatureGraph(
  internals: RenderSystemInternals,
  result: RenderFeatureFrameResult,
  resources: readonly RenderResourceScope[],
  views?: RenderFeatureFrameBatch['views'],
  previous?: import('@forgeax/engine-render-graph').CompiledRenderGraph<WaterFluidGraphFrame>,
): import('@forgeax/engine-render-graph').CompiledRenderGraph<WaterFluidGraphFrame> | undefined {
  const profileSession = activeRenderProfileSession(internals);
  if (profileSession === undefined)
    return compileSharedFeatureGraphOwned(internals, result, resources, views, previous, undefined);
  return runProfiledRenderPhase(profileSession, 'graph/build', () =>
    compileSharedFeatureGraphOwned(internals, result, resources, views, previous, profileSession),
  );
}

function compileSharedFeatureGraphOwned(
  internals: RenderSystemInternals,
  result: RenderFeatureFrameResult,
  resources: readonly RenderResourceScope[],
  views: RenderFeatureFrameBatch['views'] | undefined,
  previous:
    | import('@forgeax/engine-render-graph').CompiledRenderGraph<WaterFluidGraphFrame>
    | undefined,
  profileSession: import('@forgeax/engine-profiler').RecorderSession | undefined,
): import('@forgeax/engine-render-graph').CompiledRenderGraph<WaterFluidGraphFrame> | undefined {
  const executions = result.plans
    .map(getRenderFeaturePlanExecutionProjection)
    .filter((plan): plan is RenderFeaturePlanExecution => plan !== undefined);
  const fluid = waterFluidRenderFrame(internals.featureHost?.features);
  const firstFluid = fluid?.simulations[0];
  const fluidActive =
    fluid !== undefined && (firstFluid !== undefined || fluid.contactFoam !== undefined);
  // Persistent producers keep one graph owner across consumer readiness changes.
  const hoisted = sharedFeatureHoistedPlans(views);
  if (
    !fluidActive &&
    hoisted.every((plan) => plan.passes.length === 0) &&
    executions.every((plan) => plan.passes.length === 0) &&
    !internals.featureSceneInputs?.hasSharedWork
  )
    return;
  const builder = new RenderGraphBuilder<WaterFluidGraphFrame>();
  const sceneInputs = internals.featureSceneInputs?.import(builder);
  const state = createRenderFeatureProjectionState();
  internals.featureSceneInputs?.contribute(builder, state.buffers);
  const projection = {
    state,
    resolveTarget: (target: Parameters<RenderFeatureGraphTargetResolver>[0]) =>
      typeof target === 'object'
        ? sceneInputs?.get(target as import('../features/targets').RenderFeatureTargetHandle)
        : undefined,
    reportError: (error: import('../errors/render').RenderError) =>
      internals.errorRegistry.fire(error),
  };
  // Frame-scoped consumers can sample graph textures produced by Water's view
  // plans. Declare the complete graph roster before resolving any consumer;
  // otherwise an earlier VFX projection cannot resolve its current-frame
  // Water target. Keep each producer's original scope and pass-name identity.
  const declared = prepareRenderFeatureGraphTextureTargets(builder, state.graphTextures, [
    ...hoisted,
    ...executions,
  ]);
  if (!declared.ok) throw declared.error;
  const projectHoistedPlans = () => {
    for (const execution of hoisted) {
      const added = projectRenderFeaturePlans(builder, [execution], {
        ...projection,
        ...(execution.scope === undefined
          ? {}
          : { passNamePrefix: sharedFeatureGraphPassPrefix(execution.scope) }),
      });
      if (!added.ok) throw added.error;
    }
  };
  projectHoistedPlans();
  // Producer writes must precede frame consumers so the graph derives the
  // current-frame dependency and rejects neither the read nor its lineage.
  const projected = projectRenderFeaturePlans(builder, executions, projection);
  if (!projected.ok) throw projected.error;
  const exported: SharedGraphTextureExport[] = [];
  const waterFluid = new Map<string, WaterFluidMaterialPublication>();
  const captureSharedTextureExports = () => {
    for (const [target, resolved] of state.graphTextures.targets) {
      if (
        target.descriptor === undefined ||
        target.name === undefined ||
        target.materialSource !== true
      )
        continue;
      exported.push({
        target,
        name: target.name,
        label: resolved.label,
        scope: resolved.scope,
        descriptor: target.descriptor,
        view: target.view ?? {},
      });
    }
  };
  captureSharedTextureExports();
  if (fluidActive) {
    const waterInfo = internals.featureHost?.features.find(
      (feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY,
    );
    const viewIdentities = new Set(views?.keys());
    if (fluid.waterInfoViewIdentity !== undefined) viewIdentities.add(fluid.waterInfoViewIdentity);
    for (const viewIdentity of viewIdentities) {
      const publication =
        waterInfo === undefined
          ? undefined
          : waterInfoFramePublicationForRenderer(
              waterInfo,
              viewIdentity,
              fluid.frameNumber,
              fluid.deviceGeneration,
            );
      waterFluid.set(viewIdentity, { render: fluid, waterInfo: publication });
    }
    const publication =
      fluid.waterInfoViewIdentity === undefined
        ? undefined
        : waterFluid.get(fluid.waterInfoViewIdentity)?.waterInfo;
    const added = addWaterFluidSharedGraph({
      graph: builder,
      waterFluid: fluid,
      waterInfoPublication: publication,
      viewIdentity: fluid.waterInfoViewIdentity,
      resolveImpulseNoise(entry) {
        const source = entry.impulseNoise;
        const scope = resources[entry.worldIndex];
        if (source === undefined || scope === undefined) return;
        const resolved = scope.resolveAsset(source.handle, source.revision);
        if (!resolved.ok || resolved.value.kind !== 'texture') return;
        const resident = internals.gpuStore.ensureResident(
          source.handle as AssetHandle<'texture'>,
          resolved.value,
          scope,
        );
        if (!resident.ok) throw resident.error;
        return { texture: resident.value.texture.handle, asset: resolved.value };
      },
      getFeatureGraphTextureBinding(name, viewIdentity) {
        const matches = [...state.graphTextures.targets].filter(
          ([target, resolved]) => target.name === name && resolved.scope === `view:${viewIdentity}`,
        );
        const match = matches.length === 1 ? matches[0] : undefined;
        return match === undefined ? undefined : { view: match[1].view, format: match[0].format };
      },
      resolveShallowFoamSource(source) {
        const targets = waterAdvancedShallowFoamTargets(source, hoisted);
        if (targets === undefined) return;
        const foam = state.graphTextures.targets.get(targets.foam);
        const mapping = state.graphTextures.targets.get(targets.mapping);
        if (foam === undefined || mapping === undefined) return;
        return {
          foam: { view: foam.view, format: targets.foam.format },
          mapping: { view: mapping.view, format: targets.mapping.format },
        };
      },
    });
    if (!added.ok) throw added.error;
    exported.push(...added.value);
  }
  const textures = canonicalSharedGraphTextures(exported);
  const compileOptions = {
    device: internals.device,
    surfaceSize: {
      width: internals.canvas.width,
      height: internals.canvas.height,
    },
    ...(previous === undefined ? {} : { reuseResourcesFrom: previous }),
  };
  const compiled =
    profileSession === undefined
      ? builder.compile(compileOptions)
      : runProfiledRenderPhase(profileSession, 'graph/compile', () =>
          builder.compile(compileOptions),
        );
  if (!compiled.ok) throw compiled.error;
  const publishCompiledSharedGraph = () => {
    if (internals.featureHost !== undefined) {
      const publication: SharedFeatureGraphPublication = {
        graph: compiled.value as import('@forgeax/engine-render-graph').CompiledRenderGraph<
          import('@forgeax/engine-render-graph').RenderGraphFrame
        >,
        textures,
        passes: new Set(hoisted.flatMap((execution) => execution.passes)),
        topologyKey: sharedGraphTextureTopology(textures),
        waterFluid,
      };
      publishSharedGraphTextures(internals.featureHost, publication);
    }
  };
  publishCompiledSharedGraph();
  return compiled.value;
}
