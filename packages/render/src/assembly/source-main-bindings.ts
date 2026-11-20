import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { GraphTextureView } from '@forgeax/engine-render-graph';
import { ok, RhiError, type TextureView } from '@forgeax/engine-rhi';
import { atmosphereVolumeViews } from '../environment/luts';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { SourceRasterPassBindings } from '../gpu-driven/source-raster-bundles';
import { getOrCreateHdrpBuffers } from '../hdrp-buffers';
import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import { clusterMeshBindingCurrent } from '../record/cluster-mesh-binding-preparation';
import {
  buildPerFrameBindGroups,
  buildViewBindGroup,
  captureGlobalMeshBindingsCurrent,
} from '../record/frame-lighting';
import type { InstalledFrameGraph } from '../record/frame-snapshot';
import {
  createPerSubmeshMaterialBgDeps,
  materialBindingByteOffset,
  resolveClusterMeshBinding,
} from '../record/main-pass';
import { buildPerSubmeshMaterialBg, prepareMaterialSkylight } from '../record/main-pass-material';
import { materialMatchesPass } from '../record/material-pass-selection';
import { MaterialUniformRecording } from '../record/material-uniforms';
import { viewReflectionProbesOf } from '../world/reflection-systems';
import { viewStandardLightingOf } from '../world/standard-lighting-systems';
import { viewFrameOf } from '../world/view-frame-systems';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';

type NativeMain =
  ReturnType<
    GpuDrivenProduction['prepareMainGraphProjection']
  > extends import('@forgeax/engine-types').Result<infer T, unknown>
    ? T
    : never;
function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'reprepare the actual Source and its original main Pass bindings',
  });
}

type BindingDemand = NonNullable<
  import('../record/scene-pipeline-preparation').ScenePipelineDemand['bindings']
>;
type MainScope = ReturnType<typeof captureMainBindingScope>;

/** Original material, View and Cluster factories; no recording context, encoding or synthetic frame. */
export function* prepareSourceMainBindings(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  source: RenderResourceScope,
  native: NativeMain,
  installed: InstalledFrameGraph,
  current: () => boolean,
): Generator<void, { readonly isCurrent: () => boolean; readonly release: () => void }> {
  const scope = captureMainBindingScope(world, entity, owner, source, native, installed, current);
  let issued = false;
  try {
    yield* prepareGlobalBindings(scope);
    for (const preparation of installed.scenePipelinePreparations ?? []) {
      if (preparation.kind === 'utility') continue;
      const demand = preparation.demand;
      if (demand === undefined || demand.bindings === undefined)
        throw invalid('native canonical Pass binding demand');
      yield* preparePassBindings(scope, demand, demand.bindings);
    }
    const isCurrent = () =>
      !scope.graph.isRetired() &&
      native.isCurrent() &&
      scope.receipts.every((receipt) => receipt());
    if (!scope.live() || !isCurrent()) throw invalid('complete current main bindings');
    issued = true;
    return { isCurrent, release: () => scope.uniforms.complete() };
  } finally {
    if (!issued) scope.uniforms.complete();
  }
}

function captureMainBindingScope(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  source: RenderResourceScope,
  native: NativeMain,
  installed: InstalledFrameGraph,
  current: () => boolean,
) {
  const { internals, frameState } = owner;
  const pipeline = recordContext(internals).getPipelineState();
  const staged = viewFrameOf(world, entity)?.result;
  const lighting = viewStandardLightingOf(world, entity);
  if (
    pipeline === null ||
    staged?.ok !== true ||
    lighting?.kind !== 'prepared' ||
    !lighting.lighting.ok
  )
    throw invalid('actual Source frame, pipeline and lighting');
  const { skylight, skylightCount } = staged.value;
  const reflection = viewReflectionProbesOf(world, entity);
  if (reflection?.ok !== true) throw invalid('actual prepared reflection resources');
  const counts = { createBindGroup: 0, keys: [] as string[] };
  const receipts: (() => boolean)[] = [];
  const graph = installed.graph;
  const resolve = (port: GraphTextureView): TextureView => {
    const view = graph.createdTextureView(port);
    if (view === undefined) throw invalid('actual fixed created Pass view');
    receipts.push(() => graph.createdTextureView(port) === view);
    return view;
  };
  const targetView = (target: import('../render-pipeline').RenderPipelineTarget): TextureView => {
    const actual = graph.createdTextureView(target.view);
    if (actual !== undefined) return resolve(target.view);
    const resident = target.residentView?.();
    if (resident === undefined) throw invalid('the exact resident imported Pass view');
    receipts.push(() => target.residentView?.() === resident);
    return resident;
  };
  const live = () => current() && native.isCurrent() && !graph.isRetired();
  if (!live()) throw invalid('current Source main binding demand');
  const hdrp =
    lighting.lighting.value.standard.kind === 'clustered'
      ? getOrCreateHdrpBuffers(
          internals,
          frameState.installedPipelineConfig?.clusterGrid,
          frameState.standardClusterTextureExtent,
        )
      : null;
  return {
    internals,
    frameState,
    pipeline,
    skylight,
    skylightCount,
    reflection,
    counts,
    receipts,
    graph,
    resolve,
    targetView,
    live,
    hdrp,
    standard: lighting.lighting.value.standard,
    source,
    native,
    uniforms: new MaterialUniformRecording(),
  };
}

function* prepareGlobalBindings(scope: MainScope): Generator<void> {
  const { internals, frameState, pipeline, counts, receipts, live, standard } = scope;
  const fallback = buildViewBindGroup(
    internals,
    frameState,
    pipeline,
    counts,
    undefined,
    false,
    live,
  );
  if (fallback === null) throw invalid('actual fallback View binding');
  receipts.push(
    () => buildViewBindGroup(internals, frameState, pipeline, counts, undefined, true) === fallback,
  );
  yield;
  const groups = buildPerFrameBindGroups(
    internals,
    frameState,
    pipeline,
    true,
    counts,
    undefined,
    false,
    standard,
    live,
  );
  const groupsCurrent = captureGlobalMeshBindingsCurrent(
    internals,
    frameState,
    pipeline,
    groups,
    scope.hdrp,
  );
  if (!groupsCurrent()) throw invalid('current global mesh and clustered bindings');
  receipts.push(groupsCurrent);
  if (!live()) throw invalid('current frame-global main bindings');
  yield;
}

function passTargets(scope: MainScope, bindings: BindingDemand) {
  const { resolve, targetView } = scope;
  return {
    directionalShadow:
      bindings.directionalShadow === undefined ? undefined : targetView(bindings.directionalShadow),
    spotShadow: bindings.spotShadow === undefined ? undefined : targetView(bindings.spotShadow),
    shadowMoments:
      bindings.shadowMoments === undefined ? undefined : targetView(bindings.shadowMoments),
    cloudShadow: bindings.cloudShadow === undefined ? undefined : targetView(bindings.cloudShadow),
    atmosphere:
      bindings.environment?.atmosphere?.execution === 'compute-volume'
        ? atmosphereVolumeViews(
            { textureView: (port: GraphTextureView) => ok(resolve(port)) },
            bindings.environment.atmosphere,
          )
        : undefined,
  };
}

function* preparePassBindings(
  scope: MainScope,
  demand: import('../record/scene-pipeline-preparation').ScenePipelineDemand,
  bindings: BindingDemand,
): Generator<void> {
  const { internals, frameState, pipeline, counts, receipts, live, hdrp, graph, native, resolve } =
    scope;
  const selected = native.materialBindings.filter((binding) => {
    const material = native.materials.get(binding.material);
    return (
      material !== undefined &&
      materialMatchesPass(
        material,
        demand.pass.selector,
        demand.pass.recordMode,
        demand.pass.excludeSelector,
      )
    );
  });
  if (selected.length === 0) return;
  if (!live()) throw invalid('current main Pass bindings');
  if (
    bindings.transmissionBackdrop !== undefined ||
    bindings.surfacePair !== undefined ||
    bindings.surfaceNearestLayer !== undefined ||
    bindings.surfaceNearestDepth !== undefined
  )
    throw invalid('prepared opaque Source Pass binding domain');
  const targets = passTargets(scope, bindings);
  const view = buildViewBindGroup(internals, frameState, pipeline, counts, targets, false, live);
  if (view === null) throw invalid('actual Pass View binding');
  receipts.push(
    () => buildViewBindGroup(internals, frameState, pipeline, counts, targets, true) === view,
  );
  yield;
  const ssao = bindings.ssao === undefined ? undefined : resolve(bindings.ssao.view);
  let cluster: import('@forgeax/engine-rhi').BindGroup | undefined;
  if (hdrp !== null) {
    const group = resolveClusterMeshBinding(
      {
        runtime: internals,
        cache: frameState.meshBindGroupCache,
        hdrp,
        ssaoView: ssao,
        counts,
        graph,
        graphViews:
          ssao === undefined || bindings.ssao === undefined
            ? undefined
            : { graph, views: [['ssao', bindings.ssao.view, ssao]] },
        current: live,
      },
      native.meshBinding.buffer,
      native.meshBinding.bytes,
    );
    if (group === undefined) throw invalid('actual Source clustered mesh binding');
    cluster = group;
    receipts.push(() => clusterMeshBindingCurrent(frameState.meshBindGroupCache, group));
    yield;
  }
  const materials = yield* preparePassMaterials(scope, bindings, selected);
  (yield* native.prepareBundles({ demand, view, materials, cluster })).unwrap();
}

function* preparePassMaterials(
  scope: MainScope,
  bindings: BindingDemand,
  selected: NativeMain['materialBindings'],
): Generator<void, SourceRasterPassBindings['materials']> {
  const prepared = new Map<
    MaterialResource,
    Map<
      string,
      { readonly group: import('@forgeax/engine-rhi').BindGroup; readonly byteOffset: number }
    >
  >();
  const {
    internals,
    frameState,
    pipeline,
    skylight,
    skylightCount,
    reflection,
    counts,
    receipts,
    source,
    native,
    resolve,
    live,
  } = scope;
  const environmentIbl =
    bindings.environment === undefined
      ? undefined
      : {
          irradiance: resolve(bindings.environment.irradiance),
          prefilter: resolve(bindings.environment.prefilter),
        };
  const materialInputs = {
    runtime: internals,
    pipelineState: pipeline,
    store: internals.gpuStore,
    world: source,
    frameState,
    skylight,
    skylightCount,
    ...(environmentIbl === undefined ? {} : { environmentIbl }),
    reflectionProbes: reflection.value.probes,
    materialBgAssemblyCache: frameState.materialBgAssemblyCache,
    bindGroupCounts: counts,
    gpuDrivenSceneMaterialBuffer: native.materialBuffer,
  };
  const resources = prepareMaterialSkylight(materialInputs).skylightResources;
  const deps = createPerSubmeshMaterialBgDeps(
    materialInputs,
    undefined,
    resources,
    reflection.value.probes.table.rows.length > 0,
  );
  for (const binding of selected) {
    if (!live()) throw invalid('current Source material binding');
    const accepted = native.materials.get(binding.material);
    if (accepted === undefined) throw invalid('actual accepted Source material');
    const group = scope.uniforms.runPrepared(() =>
      buildPerSubmeshMaterialBg(
        deps,
        accepted.snapshot,
        undefined,
        source,
        accepted.snapshot.materialShaderId,
        0,
        binding.resourceClass,
      ),
    );
    const bindingCurrent = frameState.materialBgAssemblyCache.captureBindingCurrent(group);
    if (bindingCurrent === undefined || !live() || !bindingCurrent())
      throw invalid('actual current material binding receipt');
    receipts.push(bindingCurrent);
    scope.uniforms.hold(internals, accepted.snapshot);
    let classes = prepared.get(binding.material);
    if (classes === undefined) {
      classes = new Map();
      prepared.set(binding.material, classes);
    }
    classes.set(binding.resourceClass, {
      group,
      byteOffset: materialBindingByteOffset(materialInputs, accepted.snapshot),
    });
    yield;
  }
  return prepared;
}
