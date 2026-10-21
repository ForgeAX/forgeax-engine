import type {
  GraphAccess,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { PointShadowAtlasUninitializedError } from './errors/render';
import type { RenderFeatureShadowDraws } from './features/render-graph-raster';
import {
  type ShadowDirtyRect,
  type ShadowViewIdentity,
  type ShadowViewProjection,
  shadowViewIdentityKey,
  shadowViewRasterAccesses,
} from './gpu-driven/shadow-views';
import { SHADOW_DEPTH_LAYER_USAGE, type ShadowDepthLayers } from './shadow-depth-layers';
import { addVarianceShadowPasses, type VarianceShadowView } from './shadow-variance';

type ProjectGpuDrivenShadow = (
  identity: ShadowViewIdentity,
  cameraPyramid?: GraphTextureView,
) => Result<ShadowViewProjection | undefined, RenderGraphError>;

import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from './gpu-texture-usage';
import type { ShadowViewInvalidationReason } from './inspection-types';
import type { _InternalRenderPipelineContext } from './record/render-context';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  encodeStaticShadowPass,
} from './record/shadow-pass';
import type { RenderPipelineFrame, RenderPipelineTopology } from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';

export interface TypedShadowTargets {
  readonly directional?: RenderPipelineTarget | undefined;
  readonly moments?: RenderPipelineTarget | undefined;
  readonly spot: RenderPipelineTarget;
  readonly point?: RenderPipelineTarget | undefined;
}

/**
 * A cache miss is a per-view fact. With a GPU view pool, the pool owns every
 * view's decision; without one only the directional producer cache can prove
 * a retained layer, so point and spot views re-raster.
 */
function shadowViewCacheMiss(
  frame: RenderPipelineFrame,
  identity: ShadowViewIdentity,
): ShadowViewInvalidationReason | undefined {
  const context = frame as _InternalRenderPipelineContext;
  const gpuShadowViews = context.gpuDrivenShadowViews;
  if (identity.terrainReceiver !== undefined) {
    const logical = { kind: 'directional' as const, index: identity.index };
    return (
      gpuShadowViews?.invalidationReason(logical) ??
      gpuShadowViews?.invalidationReason({ ...logical, layer: 'static' }) ??
      context.directionalShadowCacheMiss
    );
  }
  if (gpuShadowViews !== undefined) return gpuShadowViews.invalidationReason(identity);
  if (identity.kind !== 'directional') return 'uncached';
  const cascades = context.directionalShadowCascadeMiss;
  return cascades !== undefined && identity.index < cascades.length
    ? cascades[identity.index]
    : context.directionalShadowCacheMiss;
}

type ShadowPreparationDemand = (frame: RenderPipelineFrame) => boolean;
const shadowPreparationByGraph = new WeakMap<
  RenderGraphBuilder<RenderPipelineFrame>,
  Map<string, ShadowPreparationDemand> | null
>();

/** Private compiled-graph demand; unknown/custom views retain ordinary preparation. */
export function shadowPipelinePreparationDemand(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const views = shadowPreparationByGraph.get(graph);
  return views == null
    ? undefined
    : (frame: RenderPipelineFrame, identity: ShadowViewIdentity): boolean =>
        views.get(shadowViewIdentityKey(identity))?.(frame) ?? true;
}

function registerShadowPreparation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  identity: ShadowViewIdentity,
  demand: ShadowPreparationDemand,
): void {
  let views = shadowPreparationByGraph.get(graph);
  if (views === null) return;
  // Terrain family targets can re-record the logical GPU view independently.
  // Keep full preparation until those extra target dependencies share demand.
  if (identity.terrainReceiver !== undefined) {
    shadowPreparationByGraph.set(graph, null);
    return;
  }
  if (views === undefined) {
    views = new Map();
    shadowPreparationByGraph.set(graph, views);
  }
  views.set(shadowViewIdentityKey(identity), demand);
}

interface ShadowViewRaster {
  /** Observe the same raster reason without committing graph/target state. */
  readonly reasonFor: (
    frame: RenderPipelineFrame,
    follow?: ShadowViewInvalidationReason,
  ) => ShadowViewInvalidationReason | undefined;
  /**
   * Decides this frame's raster. `follow` names the reason a view that would
   * otherwise hit still rasters because the layer it composes was rebuilt.
   */
  readonly executeIf: (
    frame: RenderPipelineFrame,
    follow?: ShadowViewInvalidationReason,
  ) => boolean;
  /** The reason decided this frame; undefined on a hit. */
  readonly reason: () => ShadowViewInvalidationReason | undefined;
  /**
   * Regions a static-layer content miss re-rasters over its retained depth;
   * undefined on a hit or a miss that clears the layer.
   */
  readonly dirtyRects: () => readonly ShadowDirtyRect[] | undefined;
  readonly encode: (
    frame: RenderPipelineFrame,
    pass: RhiRenderPassEncoder,
    encode: (pass: RhiRenderPassEncoder) => void,
    passName?: string,
  ) => void;
}

/** A target that outlives the compiled graph, with the depth it retains. */
interface RetainedShadowTarget {
  /** Whether the target holds depth from a submitted raster. */
  readonly retained: () => boolean;
  /** Records that the staged frame rasters the target. */
  readonly rastered: () => void;
}

/**
 * A new graph rasters automatic final maps even when the view cache hits, so
 * removed feature casters cannot leave stale depth. Static layers have no
 * feature casters and retain their pool-proven cache. Frozen maps retain their
 * submitted target across graph changes; an empty target always initializes.
 * Later frames raster only a missed view or a feature-drawn view the
 * pool cannot prove. Every decision and its draw count land in the frame's
 * shadow raster ledger; `identity === undefined` marks the empty spot target,
 * which is no view.
 */
function shadowViewRaster(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  identity: ShadowViewIdentity | undefined,
  shadowFeatures: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined,
  target?: RetainedShadowTarget,
): ShadowViewRaster {
  let graphCompiled = true;
  let slot = -1;
  let decided: ShadowViewInvalidationReason | undefined;
  let dirtyRects: readonly ShadowDirtyRect[] | undefined;
  const reasonFor = (
    frame: RenderPipelineFrame,
    follow?: ShadowViewInvalidationReason,
  ): ShadowViewInvalidationReason | undefined => {
    const empty = target === undefined ? graphCompiled : !target.retained();
    const context = frame as _InternalRenderPipelineContext;
    const policy = identity === undefined ? undefined : context.shadowUpdatePolicy?.(identity);
    if (
      identity?.kind === 'point' &&
      policy?.auto === false &&
      context.frameState.shadowRaster.hasRevision(identity, policy.revision)
    )
      return undefined;
    if (!empty && identity !== undefined && policy !== undefined) {
      if (!context.frameState.shadowRaster.hasRevision(identity, policy.revision))
        return 'source-changed';
      if (!policy.auto) return undefined;
    }
    // Automatic maps must observe graph membership changes, including a
    // feature that has stopped drawing shadows. Frozen maps retain their data.
    return empty || (graphCompiled && identity?.layer !== 'static')
      ? 'graph-compiled'
      : identity === undefined
        ? undefined
        : shadowFeatures !== undefined
          ? 'feature-draws'
          : (shadowViewCacheMiss(frame, identity) ?? follow);
  };
  if (identity !== undefined)
    registerShadowPreparation(graph, identity, (frame) => reasonFor(frame) !== undefined);
  return {
    reasonFor,
    dirtyRects: () => dirtyRects,
    reason: () => decided,
    executeIf: (frame, follow) => {
      const reason = reasonFor(frame, follow);
      graphCompiled = false;
      decided = reason;
      if (reason !== undefined) target?.rastered();
      const context = frame as _InternalRenderPipelineContext;
      // A fresh graph target holds no retained depth to redraw over.
      dirtyRects =
        identity === undefined ||
        identity.terrainReceiver !== undefined ||
        reason === undefined ||
        reason === 'graph-compiled'
          ? undefined
          : context.gpuDrivenShadowViews?.dirtyRects(identity);
      slot =
        identity === undefined
          ? -1
          : context.frameState.shadowRaster.evaluate(
              identity,
              reason,
              context.gpuDrivenShadowViews?.texelCulled(identity),
              context.gpuDrivenShadowViews?.cameraCulled(identity),
              dirtyRects?.length,
              context.shadowUpdatePolicy?.(identity)?.revision,
            );
      return reason !== undefined;
    },
    encode: (frame, pass, encode, passName) => {
      if (slot < 0) {
        encode(pass);
        return;
      }
      (frame as _InternalRenderPipelineContext).frameState.shadowRaster.encode(
        slot,
        pass,
        encode,
        passName,
      );
    },
  };
}

/**
 * wgpu's GL backend maps a one-layer texture to TEXTURE_2D, which cannot be
 * sampled as `texture_depth_2d_array`; layered shadow maps keep two or more.
 */
const MIN_SHADOW_ARRAY_LAYERS = 2;
const SPOT_SHADOW_LAYERS = 4;

function createShadowArrayTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  size: number,
  layers: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(
    graph,
    label,
    {
      format: 'depth32float',
      size: { width: size, height: size, depthOrArrayLayers: layers },
    },
    { dimension: '2d-array', aspect: 'depth-only', arrayLayerCount: layers },
  );
}

function shadowLayerTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  label: string,
  layer: number,
  resolve?: () => import('@forgeax/engine-rhi').TextureView,
): Result<RenderPipelineTarget, RenderGraphError> {
  const descriptor = {
    label,
    dimension: '2d' as const,
    aspect: 'depth-only' as const,
    baseArrayLayer: layer,
    arrayLayerCount: 1,
  };
  const view =
    resolve === undefined
      ? graph.view(target.texture, descriptor)
      : graph.importView(target.texture, descriptor, resolve);
  if (!view.ok) return view;
  return ok({ texture: target.texture, view: view.value, format: target.format, sampleCount: 1 });
}

/**
 * The static layers' array, imported from the renderer-owned store so a
 * recompile keeps the retained depth. Without a store the graph owns it.
 */
function createRetainedShadowArrayTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  staticLayers: ShadowDepthLayers | undefined,
  label: string,
  size: number,
  layers: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  if (staticLayers === undefined) return createShadowArrayTarget(graph, label, size, layers);
  const texture = graph.importTexture(
    label,
    {
      format: 'depth32float',
      size: { width: size, height: size, depthOrArrayLayers: layers },
      usage: SHADOW_DEPTH_LAYER_USAGE,
    },
    () => staticLayers.texture(label, size, layers),
  );
  if (!texture.ok) return texture;
  const view = graph.importView(
    texture.value,
    {
      label: `${label}.view`,
      dimension: '2d-array',
      aspect: 'depth-only',
      arrayLayerCount: layers,
    },
    () => staticLayers.view(label),
  );
  if (!view.ok) return view;
  return ok({ texture: texture.value, view: view.value, format: 'depth32float', sampleCount: 1 });
}

/**
 * Every shadow view owns one array layer and clears it when it rasters, so a
 * miss never erases a neighbouring view retained by a cache hit.
 */
function recordShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  target: RenderPipelineTarget,
  raster: Pick<ShadowViewRaster, 'executeIf' | 'encode'>,
  encode: (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    resources: GraphResourceResolver,
  ) => void,
  extraAccesses: readonly GraphAccess[] = [],
  depthLoadOp: 'clear' | 'load' = 'clear',
): Result<void, RenderGraphError> {
  return graph.addRasterPass(name, {
    accesses: [{ resource: target.view, usage: 'depth-stencil-write' }, ...extraAccesses],
    colorAttachments: [],
    depthStencilAttachment: {
      view: target.view,
      depthLoadOp,
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
    executeIf: raster.executeIf,
    encode: ({ pass, frame, resources }) =>
      raster.encode(frame, pass, (counted) => encode(counted, frame, resources), name),
  });
}

function projectionAccesses(
  projection: Result<ShadowViewProjection | undefined, RenderGraphError> | undefined,
): readonly GraphAccess[] {
  return projection?.ok === true && projection.value?.graphResources !== undefined
    ? shadowViewRasterAccesses(projection.value.graphResources)
    : [];
}

/**
 * A view with a static layer rasters its settled casters into a retained
 * static array layer only when that layer misses. Whenever the final layer
 * rasters, it first copies the static layer and then loads it to add dynamic,
 * residual, and feature casters.
 */
function recordStaticLayeredShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  projectGpuDrivenShadow: ProjectGpuDrivenShadow,
  identity: ShadowViewIdentity,
  name: string,
  target: RenderPipelineTarget,
  staticArray: RenderPipelineTarget,
  staticLayers: ShadowDepthLayers | undefined,
  staticLabel: string,
  layer: number,
  size: number,
  raster: ShadowViewRaster,
  encode: (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    resources: GraphResourceResolver,
  ) => void,
  extraAccesses: readonly GraphAccess[],
  reuseAdjacentShadow = false,
): Result<ShadowViewRaster, RenderGraphError> {
  const staticIdentity: ShadowViewIdentity = Object.freeze({ ...identity, layer: 'static' });
  const staticProjection = projectGpuDrivenShadow(staticIdentity);
  if (!staticProjection.ok) return staticProjection;
  const staticLayer = shadowLayerTarget(
    graph,
    staticArray,
    `${name}-static-layer`,
    layer,
    staticLayers === undefined ? undefined : () => staticLayers.view(staticLabel, layer),
  );
  if (!staticLayer.ok) return staticLayer;
  const staticRaster = shadowViewRaster(
    graph,
    staticIdentity,
    undefined,
    staticLayers === undefined
      ? undefined
      : {
          retained: () => staticLayers.retained(staticLabel, layer),
          rastered: () => staticLayers.rastered(staticLabel, layer),
        },
  );
  registerShadowPreparation(
    graph,
    identity,
    (frame) =>
      raster.reasonFor(
        frame,
        staticRaster.reasonFor(frame) === 'graph-compiled' ? 'static-layer-changed' : undefined,
      ) !== undefined,
  );
  // A pool-proven content miss re-rasters only its dirty regions over the
  // retained layer; any other miss clears it.
  const staticAdded = recordShadowPass(
    graph,
    `${name}.static`,
    staticLayer.value,
    {
      executeIf: (frame) =>
        staticRaster.executeIf(frame) && staticRaster.dirtyRects() === undefined,
      encode: staticRaster.encode,
    },
    (pass, frame) =>
      encodeStaticShadowPass(frame as never, pass, identity, undefined, reuseAdjacentShadow),
    projectionAccesses(staticProjection),
  );
  if (!staticAdded.ok) return staticAdded;
  const partialAdded = recordShadowPass(
    graph,
    `${name}.static-partial`,
    staticLayer.value,
    { executeIf: () => staticRaster.dirtyRects() !== undefined, encode: staticRaster.encode },
    (pass, frame) =>
      encodeStaticShadowPass(
        frame as never,
        pass,
        identity,
        {
          rects: staticRaster.dirtyRects() ?? [],
          size,
        },
        reuseAdjacentShadow,
      ),
    projectionAccesses(staticProjection),
    'load',
  );
  if (!partialAdded.ok) return partialAdded;
  let rasterFinal = false;
  const copied = graph.addCopyPass(`${name}.static-copy`, {
    accesses: [
      { resource: staticLayer.value.view, usage: 'copy-src' },
      { resource: target.view, usage: 'copy-dst' },
    ],
    // A static layer rebuilt from an empty target changes the composed
    // layer even when the final view's own cache hits.
    executeIf: (frame) => {
      rasterFinal = raster.executeIf(
        frame,
        staticRaster.reason() === 'graph-compiled' ? 'static-layer-changed' : undefined,
      );
      return rasterFinal;
    },
    encode: ({ encoder, resources }) => {
      const source = resources.texture(staticArray.texture);
      if (!source.ok) throw source.error;
      const destination = resources.texture(target.texture);
      if (!destination.ok) throw destination.error;
      encoder.copyTextureToTexture(
        { texture: source.value, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        { texture: destination.value, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
    },
  });
  if (!copied.ok) return copied;
  const recorded = recordShadowPass(
    graph,
    name,
    target,
    { executeIf: () => rasterFinal, encode: raster.encode },
    encode,
    extraAccesses,
    'load',
  );
  return recorded.ok ? ok(staticRaster) : recorded;
}

export function addTypedShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  {
    projectGpuDrivenShadow,
    shadowFeatures,
    cameraPyramid,
    staticLayers,
    depthLayers,
    reuseAdjacentShadow = false,
  }: {
    readonly projectGpuDrivenShadow?: ProjectGpuDrivenShadow | undefined;
    readonly shadowFeatures?: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined;
    /** Main-camera HZB used to reject casters with hidden receivers. */
    readonly cameraPyramid?: GraphTextureView | undefined;
    readonly staticLayers?: ShadowDepthLayers | undefined;
    readonly depthLayers?: ShadowDepthLayers | undefined;
    readonly reuseAdjacentShadow?: boolean | undefined;
  } = {},
): Result<TypedShadowTargets, RenderGraphError> {
  const variance: VarianceShadowView[] = [];
  let directional: RenderPipelineTarget | undefined;
  if (topology.shadow.directional !== 'disabled') {
    const { mapSize, cascadeCount, terrainReceivers = [] } = topology.shadow.directional;
    const target = createRetainedShadowArrayTarget(
      graph,
      depthLayers,
      'directional-shadow-depth',
      mapSize,
      Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount * (1 + terrainReceivers.length)),
    );
    if (!target.ok) return target;
    const directionalTarget = target.value;
    directional = directionalTarget;
    let directionalStatic: RenderPipelineTarget | undefined;
    if (projectGpuDrivenShadow !== undefined) {
      const staticTarget = createRetainedShadowArrayTarget(
        graph,
        staticLayers,
        'directional-shadow-static',
        mapSize,
        Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount),
      );
      if (!staticTarget.ok) return staticTarget;
      directionalStatic = staticTarget.value;
    }
    const cascadeWork: {
      readonly accesses: readonly GraphAccess[];
      readonly staticRaster: ShadowViewRaster | undefined;
    }[] = [];
    for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
      const identity = Object.freeze({ kind: 'directional' as const, index: cascade });
      const shadowProjection = projectGpuDrivenShadow?.(identity, cameraPyramid);
      if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
      const layer = shadowLayerTarget(
        graph,
        directionalTarget,
        `directional-shadow-cascade-${cascade}`,
        cascade,
      );
      if (!layer.ok) return layer;
      const raster = shadowViewRaster(
        graph,
        identity,
        shadowFeatures,
        depthLayers === undefined
          ? undefined
          : {
              retained: () => depthLayers.retained('directional-shadow-depth', cascade),
              rastered: () => depthLayers.rastered('directional-shadow-depth', cascade),
            },
      );
      if (topology.shadow.variance?.directional)
        variance.push({
          kind: 'directional',
          index: cascade,
          depth: layer.value,
          size: mapSize,
          rastered: () => raster.reason() !== undefined,
        });
      const encode = (
        pass: RhiRenderPassEncoder,
        frame: RenderPipelineFrame,
        resources: GraphResourceResolver,
      ) =>
        encodeDirectionalShadowPass(
          frame as never,
          pass,
          cascade,
          shadowFeatures === undefined
            ? undefined
            : (view) => shadowFeatures.encode(pass, frame, resources, view),
          undefined,
          reuseAdjacentShadow,
        );
      const accesses = [
        ...projectionAccesses(shadowProjection),
        ...(shadowFeatures?.accesses ?? []),
      ];
      const added =
        projectGpuDrivenShadow !== undefined && directionalStatic !== undefined
          ? recordStaticLayeredShadowPass(
              graph,
              projectGpuDrivenShadow,
              identity,
              `shadowCascade${cascade}`,
              layer.value,
              directionalStatic,
              staticLayers,
              'directional-shadow-static',
              cascade,
              mapSize,
              raster,
              encode,
              accesses,
              reuseAdjacentShadow,
            )
          : recordShadowPass(
              graph,
              `shadowCascade${cascade}`,
              layer.value,
              raster,
              encode,
              accesses,
            );
      if (!added.ok) return added;
      cascadeWork.push({ accesses, staticRaster: added.value ?? undefined });
    }
    for (const [rootIndex, receiver] of terrainReceivers.entries()) {
      for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
        const physicalLayer = cascadeCount * (rootIndex + 1) + cascade;
        const name = `shadowCascade${cascade}.terrain-${receiver.worldId}-${receiver.entityKey}`;
        const layer = shadowLayerTarget(graph, directionalTarget, `${name}.depth`, physicalLayer);
        if (!layer.ok) return layer;
        const identity = Object.freeze({
          kind: 'directional' as const,
          index: cascade,
          terrainReceiver: receiver,
        });
        const raster = shadowViewRaster(
          graph,
          identity,
          shadowFeatures,
          depthLayers === undefined
            ? undefined
            : {
                retained: () => depthLayers.retained('directional-shadow-depth', physicalLayer),
                rastered: () => depthLayers.rastered('directional-shadow-depth', physicalLayer),
              },
        );
        const encode = (
          pass: RhiRenderPassEncoder,
          frame: RenderPipelineFrame,
          resources: GraphResourceResolver,
        ) =>
          encodeDirectionalShadowPass(
            frame as never,
            pass,
            cascade,
            shadowFeatures === undefined
              ? undefined
              : (view) => shadowFeatures.encode(pass, frame, resources, view),
            receiver,
            reuseAdjacentShadow,
          );
        let rasterFinal = false;
        if (directionalStatic !== undefined) {
          // This layer contains only GPU settled casters. Canonical Terrain is
          // a CPU residual and cannot contribute its front faces to it.
          const sourceLayer = shadowLayerTarget(
            graph,
            directionalStatic,
            `${name}.gpu-static`,
            cascade,
          );
          if (!sourceLayer.ok) return sourceLayer;
          const staticArray = directionalStatic;
          const copied = graph.addCopyPass(`${name}.static-copy`, {
            accesses: [
              { resource: sourceLayer.value.view, usage: 'copy-src' },
              { resource: layer.value.view, usage: 'copy-dst' },
            ],
            executeIf: (frame) => {
              // The copied layer can be empty after a rejected submit even
              // when the logical GPU pool hits. Its actual producer, ordered
              // before this copy by the resource read, owns that decision.
              const staticChanged = cascadeWork[cascade]?.staticRaster?.reason() !== undefined;
              rasterFinal = raster.executeIf(
                frame,
                staticChanged ? 'static-layer-changed' : undefined,
              );
              return rasterFinal;
            },
            encode: ({ encoder, resources }) => {
              const source = resources.texture(staticArray.texture);
              if (!source.ok) throw source.error;
              const target = resources.texture(directionalTarget.texture);
              if (!target.ok) throw target.error;
              encoder.copyTextureToTexture(
                { texture: source.value, origin: { x: 0, y: 0, z: cascade } },
                { texture: target.value, origin: { x: 0, y: 0, z: physicalLayer } },
                { width: mapSize, height: mapSize, depthOrArrayLayers: 1 },
              );
            },
          });
          if (!copied.ok) return copied;
        }
        const added = recordShadowPass(
          graph,
          name,
          layer.value,
          directionalStatic === undefined
            ? raster
            : { executeIf: () => rasterFinal, encode: raster.encode },
          encode,
          cascadeWork[cascade]?.accesses ?? [],
          directionalStatic === undefined ? 'clear' : 'load',
        );
        if (!added.ok) return added;
      }
    }
    const observation = graph.addCopyPass('directional-shadow-observation', {
      accesses: [{ resource: directionalTarget.view, usage: 'copy-src' }],
      encode: ({ frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const texture = resources.texture(directionalTarget.texture);
        if (!texture.ok) throw texture.error;
        internal.pipelineState.perPassResources.shadowTexture = texture.value;
      },
    });
    if (!observation.ok) return observation;
  }

  let point: RenderPipelineTarget | undefined;
  if (topology.shadow.pointCount > 0) {
    const texture = graph.importTexture(
      'point-shadow-atlas',
      {
        format: 'depth32float',
        size: {
          width: topology.shadow.pointFaceSize,
          height: topology.shadow.pointFaceSize,
          depthOrArrayLayers: 24,
        },
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
      },
      (frame) => {
        const internal = frame as _InternalRenderPipelineContext;
        const atlas = internal.frameState.pointShadowAtlas?.getTexture();
        if (atlas === null || atlas === undefined) {
          throw new PointShadowAtlasUninitializedError();
        }
        return atlas;
      },
    );
    if (!texture.ok) return texture;
    const cube = graph.view(texture.value, {
      label: 'point-shadow-atlas.cube-array',
      dimension: 'cube-array',
      aspect: 'depth-only',
      arrayLayerCount: 24,
    });
    if (!cube.ok) return cube;
    point = {
      texture: texture.value,
      view: cube.value,
      format: 'depth32float',
      sampleCount: 1,
    };
    let pointStatic: RenderPipelineTarget | undefined;
    if (projectGpuDrivenShadow !== undefined) {
      const staticTarget = createRetainedShadowArrayTarget(
        graph,
        staticLayers,
        'point-shadow-static',
        topology.shadow.pointFaceSize,
        topology.shadow.pointCount * 6,
      );
      if (!staticTarget.ok) return staticTarget;
      pointStatic = staticTarget.value;
    }
    for (let pointIndex = 0; pointIndex < topology.shadow.pointCount; pointIndex += 1) {
      for (let face = 0; face < 6; face += 1) {
        const shadowProjection = projectGpuDrivenShadow?.({
          kind: 'point',
          index: pointIndex,
          face,
        });
        if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
        const identity = Object.freeze({ kind: 'point' as const, index: pointIndex, face });
        const faceView = graph.view(texture.value, {
          label: `point-shadow-${pointIndex}-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: pointIndex * 6 + face,
          arrayLayerCount: 1,
        });
        if (!faceView.ok) return faceView;
        const faceTarget: RenderPipelineTarget = {
          texture: texture.value,
          view: faceView.value,
          format: 'depth32float',
          sampleCount: 1,
        };
        const raster = shadowViewRaster(graph, identity, shadowFeatures);
        const encode = (
          pass: RhiRenderPassEncoder,
          frame: RenderPipelineFrame,
          resources: GraphResourceResolver,
        ) =>
          encodePointShadowPass(
            frame as never,
            pass,
            pointIndex,
            face,
            shadowFeatures === undefined
              ? undefined
              : (view) => shadowFeatures.encode(pass, frame, resources, view),
            reuseAdjacentShadow,
          );
        const accesses = [
          ...projectionAccesses(shadowProjection),
          ...(shadowFeatures?.accesses ?? []),
        ];
        const name = `point-shadow-${pointIndex}-${face}`;
        const added =
          projectGpuDrivenShadow !== undefined && pointStatic !== undefined
            ? recordStaticLayeredShadowPass(
                graph,
                projectGpuDrivenShadow,
                identity,
                name,
                faceTarget,
                pointStatic,
                staticLayers,
                'point-shadow-static',
                pointIndex * 6 + face,
                topology.shadow.pointFaceSize,
                raster,
                encode,
                accesses,
                reuseAdjacentShadow,
              )
            : recordShadowPass(graph, name, faceTarget, raster, encode, accesses);
        if (!added.ok) return added;
      }
    }
  }

  const spot = createRetainedShadowArrayTarget(
    graph,
    depthLayers,
    'spot-shadow-depth',
    topology.shadow.spotCount === 0 ? 1 : topology.shadow.spotMapSize,
    SPOT_SHADOW_LAYERS,
  );
  if (!spot.ok) return spot;
  let spotStatic: RenderPipelineTarget | undefined;
  if (projectGpuDrivenShadow !== undefined && topology.shadow.spotCount > 0) {
    const staticTarget = createRetainedShadowArrayTarget(
      graph,
      staticLayers,
      'spot-shadow-static',
      topology.shadow.spotMapSize,
      SPOT_SHADOW_LAYERS,
    );
    if (!staticTarget.ok) return staticTarget;
    spotStatic = staticTarget.value;
  }
  // Spot shadow tiles are assigned in snapshot order, so pass index i writes
  // the layer the receiver samples through `shadowAtlasTile == i`.
  for (let spotIndex = 0; spotIndex < Math.max(1, topology.shadow.spotCount); spotIndex += 1) {
    const identity = Object.freeze({ kind: 'spot' as const, index: spotIndex });
    const shadowProjection = projectGpuDrivenShadow?.(identity, cameraPyramid);
    if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
    const layer = shadowLayerTarget(graph, spot.value, `spot-shadow-layer-${spotIndex}`, spotIndex);
    if (!layer.ok) return layer;
    const name = topology.shadow.spotCount === 0 ? 'spot-shadow' : `spot-shadow-${spotIndex}`;
    // The one-texel empty target only supplies the initialized no-shadow binding.
    // A light-count change rebuilds this graph and initializes a new one.
    const raster = shadowViewRaster(
      graph,
      topology.shadow.spotCount > 0 ? identity : undefined,
      shadowFeatures,
      depthLayers === undefined
        ? undefined
        : {
            retained: () => depthLayers.retained('spot-shadow-depth', spotIndex),
            rastered: () => depthLayers.rastered('spot-shadow-depth', spotIndex),
          },
    );
    if (topology.shadow.variance?.spots.includes(spotIndex))
      variance.push({
        kind: 'spot',
        index: spotIndex,
        depth: layer.value,
        size: topology.shadow.spotMapSize,
        rastered: () => raster.reason() !== undefined,
      });
    const encode = (
      pass: RhiRenderPassEncoder,
      frame: RenderPipelineFrame,
      resources: GraphResourceResolver,
    ) =>
      encodeSpotShadowPass(
        frame as never,
        pass,
        spotIndex,
        shadowFeatures === undefined
          ? undefined
          : (view) => shadowFeatures.encode(pass, frame, resources, view),
        reuseAdjacentShadow,
      );
    const accesses = [...projectionAccesses(shadowProjection), ...(shadowFeatures?.accesses ?? [])];
    const added =
      projectGpuDrivenShadow !== undefined && spotStatic !== undefined
        ? recordStaticLayeredShadowPass(
            graph,
            projectGpuDrivenShadow,
            identity,
            name,
            layer.value,
            spotStatic,
            staticLayers,
            'spot-shadow-static',
            spotIndex,
            topology.shadow.spotMapSize,
            raster,
            encode,
            accesses,
            reuseAdjacentShadow,
          )
        : recordShadowPass(graph, name, layer.value, raster, encode, accesses);
    if (!added.ok) return added;
  }

  const moments = addVarianceShadowPasses(graph, variance, depthLayers);
  if (!moments.ok) return moments;
  return ok({ directional, spot: spot.value, point, moments: moments.value });
}
