import type {
  GraphAccess,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder, Texture } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { PointShadowAtlasUninitializedError } from './errors/render';
import type { RenderFeatureShadowDraws } from './features/render-graph-raster';
import {
  captureShadowViewIdentity,
  directionalShadowViewIdentity,
  staticShadowViewIdentity,
} from './gpu-driven/shadow-view-identity';
import {
  type ShadowDirtyRect,
  type ShadowViewGraphProjection,
  type ShadowViewIdentity,
  shadowViewIdentityKey,
  shadowViewRasterAccesses,
} from './gpu-driven/shadow-views';
import {
  MIN_SHADOW_ARRAY_LAYERS,
  SHADOW_DEPTH_LAYER_USAGE,
  type ShadowDepthLayers,
} from './shadow-depth-layers';
import type { TerrainShadowReceiver } from './terrain/shadow-family';

type ProjectGpuDrivenShadow = (
  identity: ShadowViewIdentity,
  cameraPyramid?: GraphTextureView,
) => Result<ShadowViewGraphProjection | undefined, RenderGraphError>;

import { renderAblation } from './diagnostics/render-ablation';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from './gpu-texture-usage';
import type { ShadowViewInvalidationReason } from './inspection-types';
import type { WaterInfoGraphTargets } from './pipeline/standard-build-context';
import {
  addCurrentShadowSelection,
  currentDirectionalShadowCount,
} from './record/current-shadow-selection';
import { waterMaterialRecordContext } from './record/main-pass';
import type { _InternalRenderPipelineContext } from './record/render-context';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  encodeStaticShadowPass,
} from './record/shadow-pass';
import type { RenderPipelineFrame, RenderPipelineTopology } from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from './shadow-atlas';
import { SPOT_SHADOW_LAYERS } from './world/render-lights';

export interface TypedShadowTargets {
  readonly directional?: RenderPipelineTarget | undefined;
  readonly spot?: RenderPipelineTarget | undefined;
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
    const logical = directionalShadowViewIdentity(identity.index);
    const final = gpuShadowViews?.invalidationReason(logical);
    if (final !== undefined) return final;
    // An active final view without a static view belongs to a light that
    // disabled its static cache; the final view alone decides.
    const staticReason = gpuShadowViews?.invalidationReason(staticShadowViewIdentity(logical));
    return (
      (staticReason === 'uncached' ? undefined : staticReason) ?? context.directionalShadowCacheMiss
    );
  }
  if (gpuShadowViews !== undefined) return gpuShadowViews.invalidationReason(identity);
  if (identity.kind !== 'directional') return 'uncached';
  const cascades = context.directionalShadowCascadeMiss;
  return cascades !== undefined && identity.index < cascades.length
    ? cascades[identity.index]
    : context.directionalShadowCacheMiss;
}

type ShadowPreparationDemand = (
  frame: RenderPipelineFrame,
  identity: ShadowViewIdentity,
) => boolean;
const shadowPreparationByGraph = new WeakMap<
  RenderGraphBuilder<RenderPipelineFrame>,
  Map<string, ShadowPreparationDemand> | null
>();

/** Private compiled-graph demand; unknown/custom views retain ordinary preparation. */
export function shadowPipelinePreparationDemand(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const views = shadowPreparationByGraph.get(graph);
  return views == null
    ? undefined
    : (
        frame: RenderPipelineFrame,
        identity: ShadowViewIdentity,
        includeStaticLayer = false,
      ): boolean => {
        const exact = views.get(shadowViewIdentityKey(identity));
        const demand = exact ?? views.get(identity.kind);
        if (demand === undefined || demand(frame, identity)) return true;
        // A direct draw serves both physical layers of a logical light view.
        // Dynamic atlas subgraphs only register a kind and have no static child.
        if (!includeStaticLayer || exact === undefined) return false;
        const layer = staticShadowViewIdentity(identity);
        return views.get(shadowViewIdentityKey(layer))?.(frame, layer) ?? false;
      };
}

function registerShadowPreparation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  identity: ShadowViewIdentity | AtlasShadowKind,
  demand: ShadowPreparationDemand,
): void {
  let views = shadowPreparationByGraph.get(graph);
  if (views === null) return;
  // Terrain family targets can re-record the logical GPU view independently.
  // Keep full preparation until those extra target dependencies share demand.
  if (typeof identity !== 'string' && identity.terrainReceiver !== undefined) {
    shadowPreparationByGraph.set(graph, null);
    return;
  }
  if (views === undefined) {
    views = new Map();
    shadowPreparationByGraph.set(graph, views);
  }
  views.set(typeof identity === 'string' ? identity : shadowViewIdentityKey(identity), demand);
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
  /** Records that the staged frame leaves the target behind its view. */
  readonly discard?: () => void;
  /** Why an empty target holds no depth when no graph compile emptied it. */
  readonly emptyReason?: () => ShadowViewInvalidationReason | undefined;
}

/** A static layer that rebuilds from a cleared target forces its final layer to recompose. */
function staticLayerEmptied(reason: ShadowViewInvalidationReason | undefined): boolean {
  return reason === 'graph-compiled' || reason === 'merged-static-layer';
}

/**
 * A new graph rasters automatic final maps even when the view cache hits, so
 * removed feature casters cannot leave stale depth. Static layers have no
 * feature casters and retain their pool-proven cache. Frozen maps retain their
 * submitted target across graph changes; an empty target always initializes.
 * Later frames raster only a missed view or a feature-drawn view the
 * pool cannot prove. Every decision and its draw count land in the frame's
 * shadow raster ledger.
 */
/**
 * Whether this point / spot view belongs to a light that emits zero radiance
 * this frame. Its atlas layer stays held, so no other light's layer, map size
 * or allocation order moves when it toggles.
 */
function shadowLightIsDark(
  context: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
): boolean {
  const dark = context.frameState.darkShadowViews;
  if (dark === undefined) return false;
  if (identity.kind === 'point') return dark.point.size > 0 && dark.point.has(identity.index);
  if (identity.kind === 'spot') return dark.spot.size > 0 && dark.spot.has(identity.index);
  return false;
}

function shadowViewRaster(
  graph: RenderGraphBuilder<RenderPipelineFrame> | undefined,
  identity: ShadowViewIdentity,
  shadowFeatures: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined,
  target?: RetainedShadowTarget,
): ShadowViewRaster {
  let graphCompiled = true;
  let slot = -1;
  let decided: ShadowViewInvalidationReason | undefined;
  let dirtyRects: readonly ShadowDirtyRect[] | undefined;
  // Set while this view's light emits nothing: its casters were not rastered
  // and its pool culling was not prepared, so the retained depth is stale.
  let skippedDark = false;
  const isEmpty = (): boolean => (target === undefined ? graphCompiled : !target.retained());
  const reasonFor = (
    frame: RenderPipelineFrame,
    follow?: ShadowViewInvalidationReason,
  ): ShadowViewInvalidationReason | undefined => {
    const context = frame as _InternalRenderPipelineContext;
    if (shadowLightIsDark(context, identity)) return undefined;
    // A light that lights again re-rasters its whole view before sampling it.
    if (skippedDark && !isEmpty()) return 'source-changed';
    return litReasonFor(frame, follow);
  };
  const litReasonFor = (
    frame: RenderPipelineFrame,
    follow?: ShadowViewInvalidationReason,
  ): ShadowViewInvalidationReason | undefined => {
    const empty = isEmpty();
    const context = frame as _InternalRenderPipelineContext;
    const policy = context.shadowUpdatePolicy?.(identity);
    if (
      identity.kind === 'point' &&
      policy?.auto === false &&
      context.frameState.shadowRaster.hasRevision(identity, policy.revision)
    )
      return undefined;
    if (!empty && policy !== undefined) {
      if (!context.frameState.shadowRaster.hasRevision(identity, policy.revision))
        return 'source-changed';
      if (!policy.auto) return undefined;
    }
    // Automatic maps must observe graph membership changes, including a
    // feature that has stopped drawing shadows. Frozen maps retain their data.
    if (empty) return target?.emptyReason?.() ?? 'graph-compiled';
    return graphCompiled && identity.layer !== 'static'
      ? 'graph-compiled'
      : shadowFeatures !== undefined
        ? 'feature-draws'
        : (shadowViewCacheMiss(frame, identity) ?? follow);
  };
  if (graph !== undefined)
    registerShadowPreparation(graph, identity, (frame) => reasonFor(frame) !== undefined);
  return {
    reasonFor,
    dirtyRects: () => dirtyRects,
    reason: () => decided,
    executeIf: (frame, follow) => {
      const context = frame as _InternalRenderPipelineContext;
      if (shadowLightIsDark(context, identity)) {
        // A dark light's map is never sampled with weight: skip its casters
        // and keep it out of the raster ledger, like UE's black-light cull.
        skippedDark = true;
        decided = undefined;
        dirtyRects = undefined;
        slot = -1;
        return false;
      }
      const reason = reasonFor(frame, follow);
      const relit = skippedDark && reason !== undefined;
      skippedDark = false;
      graphCompiled = false;
      decided = reason;
      if (reason !== undefined) target?.rastered();
      // A fresh graph target holds no retained depth to redraw over, and a
      // relit view missed every change made while it was dark.
      dirtyRects =
        identity.terrainReceiver !== undefined ||
        reason === undefined ||
        reason === 'graph-compiled' ||
        relit
          ? undefined
          : context.gpuDrivenShadowViews?.dirtyRects(identity);
      slot = context.frameState.shadowRaster.evaluate(
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

function createShadowArrayTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  size: number,
  layers: number,
  sampledLayerCount: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(
    graph,
    label,
    {
      format: 'depth32float',
      size: { width: size, height: size, depthOrArrayLayers: layers },
    },
    { dimension: '2d-array', aspect: 'depth-only', arrayLayerCount: sampledLayerCount },
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
  sampledLayerCount = layers,
): Result<RenderPipelineTarget, RenderGraphError> {
  if (staticLayers === undefined)
    return createShadowArrayTarget(graph, label, size, layers, sampledLayerCount);
  const texture = graph.importTexture(
    label,
    {
      format: 'depth32float',
      size: { width: size, height: size, depthOrArrayLayers: layers },
      usage: SHADOW_DEPTH_LAYER_USAGE,
    },
    () => staticLayers.texture(label, size, layers),
    {
      prepare: (current) =>
        staticLayers.prepareTexture(label, size, layers, current, sampledLayerCount),
      current: () => staticLayers.residentTexture(label, size, layers),
    },
  );
  if (!texture.ok) return texture;
  const view = graph.importView(
    texture.value,
    {
      label: `${label}.view`,
      dimension: '2d-array',
      aspect: 'depth-only',
      arrayLayerCount: sampledLayerCount,
    },
    () => staticLayers.view(label, undefined, sampledLayerCount),
  );
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: 'depth32float',
    sampleCount: 1,
    residentView: () =>
      staticLayers.residentTexture(label, size, layers) === undefined
        ? undefined
        : staticLayers.residentView(label, undefined, sampledLayerCount),
  });
}

/** The parent only receives the whole sampled array. The directional writer owns
 * its shape and per-cascade views. Prospective preparation still targets its original request. */
function currentDirectionalTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  owner: ShadowDepthLayers,
  initialSize: number,
  initialCount: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  const label = 'directional-shadow-depth';
  const initialLayers = Math.max(MIN_SHADOW_ARRAY_LAYERS, initialCount);
  const texture = graph.importTexture(
    label,
    {
      format: 'depth32float',
      size: { width: initialSize, height: initialSize, depthOrArrayLayers: initialLayers },
      usage: SHADOW_DEPTH_LAYER_USAGE,
    },
    (frame) => {
      const recording = frame as _InternalRenderPipelineContext;
      return owner.currentDirectionalTexture(
        recording.directionalDepthSize ?? recording.pipelineState.perPassResources.shadowMapSize,
        currentDirectionalShadowCount(recording),
      );
    },
    {
      prepare: (current) => owner.prepareTexture(label, initialSize, initialLayers, current),
      current: () => owner.residentTexture(label, initialSize, initialLayers),
      resolvedExtent: (texture) => owner.extent(label, texture),
    },
  );
  if (!texture.ok) return texture;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d-array', aspect: 'depth-only' },
    () => owner.view(label),
  );
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: 'depth32float',
    sampleCount: 1,
    residentView: () =>
      owner.residentTexture(label, initialSize, initialLayers) === undefined
        ? undefined
        : owner.residentView(label),
  });
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
    encodeDirect: (pass, frame, resources) => {
      // Diagnostic ablation: keep the pass and its clear, drop the casters.
      if (renderAblation()?.shadowRaster === false) return;
      raster.encode(frame, pass, (counted) => encode(counted, frame, resources), name);
    },
  });
}

function projectionAccesses(
  projection: Result<ShadowViewGraphProjection | undefined, RenderGraphError> | undefined,
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
 *
 * When the light's view itself changed this frame the static layer cannot be
 * reused, so rebuilding it only to copy it out costs a raster pass, a layer
 * copy and its bandwidth for nothing. The final layer then clears and encodes
 * static and dynamic casters in one pass, and the static layer is discarded.
 * The settled view keeps that merged depth until its own content misses; only
 * then does the static layer rebuild and the split resume.
 * `singlePass` is false when another target copies the static layer.
 */
/**
 * Frames a merged static view stays merged after its light stops moving even
 * when its dynamic casters change, before it rebuilds the cached static layer. Mirrors UE's
 * ComputeWholeSceneShadowCacheModes (ShadowSetup.cpp), which renders a light
 * that moved recently uncached rather than refreshing its static cache.
 */
export const MERGED_STATIC_HYSTERESIS_FRAMES = 8;

function recordStaticLayeredShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  projectGpuDrivenShadow: ProjectGpuDrivenShadow | undefined,
  identity: ShadowViewIdentity,
  name: string,
  target: RenderPipelineTarget,
  staticArray: RenderPipelineTarget,
  staticLayers: ShadowDepthLayers | undefined,
  staticLabel: string,
  layer: number,
  size: number,
  raster: ShadowViewRaster,
  encode: ShadowPassEncoder,
  extraAccesses: readonly GraphAccess[],
  reuseAdjacentShadow = false,
  singlePass = true,
): Result<ShadowViewRaster, RenderGraphError> {
  const staticIdentity: ShadowViewIdentity = Object.freeze(staticShadowViewIdentity(identity));
  const staticProjection = projectGpuDrivenShadow?.(staticIdentity);
  if (staticProjection !== undefined && !staticProjection.ok) return staticProjection;
  const staticLayer = shadowLayerTarget(
    graph,
    staticArray,
    `${name}-static-layer`,
    layer,
    staticLayers === undefined ? undefined : () => staticLayers.view(staticLabel, layer),
  );
  if (!staticLayer.ok) return staticLayer;
  const staticTarget = skippableStaticLayer(retainedShadowLayer(staticLayers, staticLabel, layer));
  const staticRaster = shadowViewRaster(graph, staticIdentity, undefined, staticTarget);
  registerShadowPreparation(
    graph,
    identity,
    (frame) =>
      raster.reasonFor(
        frame,
        staticLayerEmptied(staticRaster.reasonFor(frame)) ? 'static-layer-changed' : undefined,
      ) !== undefined,
  );
  const encodeStatic: ShadowPassEncoder = (pass, frame) =>
    encodeStaticShadowPass(frame as never, pass, identity, undefined, reuseAdjacentShadow);
  const staticAccesses = projectionAccesses(staticProjection);
  let merged = false;
  // Frames since the pool last reported this view moving; a light that pauses
  // briefly keeps merging instead of rebuilding the layer it just discarded.
  let sinceMoved = MERGED_STATIC_HYSTERESIS_FRAMES;
  // A pool-proven content miss re-rasters only its dirty regions over the
  // retained layer; any other miss clears it.
  const staticAdded = recordShadowPass(
    graph,
    `${name}.static`,
    staticLayer.value,
    {
      executeIf: (frame) => {
        const rebuild = staticRaster.executeIf(frame) && staticRaster.dirtyRects() === undefined;
        // The pool's view verdict, not the layer's: a layer this path skipped
        // last frame reports no depth, yet a still-moving view stays merged.
        const moving =
          shadowViewCacheMiss(frame, staticIdentity) === 'view-changed' &&
          raster.reasonFor(frame) !== undefined;
        sinceMoved = moving ? 0 : Math.min(sinceMoved + 1, MERGED_STATIC_HYSTERESIS_FRAMES);
        // Within the window a view merged last frame stays merged: its
        // stale depth would otherwise force a static rebuild, a copy and the
        // final raster on the first frame the light holds still. After it,
        // the layer rebuilds only once the final view misses on its own: a
        // view whose dynamic casters hold still never reads the split.
        merged =
          singlePass &&
          rebuild &&
          (moving ||
            (merged &&
              (sinceMoved < MERGED_STATIC_HYSTERESIS_FRAMES ||
                raster.reasonFor(frame) === undefined)));
        if (merged) staticTarget.discard();
        return rebuild && !merged;
      },
      encode: staticRaster.encode,
    },
    encodeStatic,
    staticAccesses,
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
    staticAccesses,
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
    // While merged the final layer already holds static and dynamic depth;
    // the static layer it left empty is no reason to raster it again.
    executeIf: (frame) => {
      rasterFinal = raster.executeIf(
        frame,
        !merged && staticLayerEmptied(staticRaster.reason()) ? 'static-layer-changed' : undefined,
      );
      return rasterFinal && !merged;
    },
    encodeDirect: (encoder, _graphframe, resources) => {
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
  const single = recordShadowPass(
    graph,
    `${name}.single`,
    target,
    // Each view's ledger slot counts its own casters in the shared pass.
    { executeIf: () => rasterFinal && merged, encode: (_frame, pass, both) => both(pass) },
    (pass, frame, resources) => {
      staticRaster.encode(
        frame,
        pass,
        (counted) => encodeStatic(counted, frame, resources),
        `${name}.static`,
      );
      raster.encode(frame, pass, (counted) => encode(counted, frame, resources), name);
    },
    [...staticAccesses, ...extraAccesses],
  );
  if (!single.ok) return single;
  const recorded = recordShadowPass(
    graph,
    name,
    target,
    { executeIf: () => rasterFinal && !merged, encode: raster.encode },
    encode,
    extraAccesses,
    'load',
  );
  return recorded.ok ? ok(staticRaster) : recorded;
}

export interface CurrentShadowViews {
  readonly directional?: true;
  readonly point: boolean;
  readonly spot: boolean;
}

const POINT_VIEWS = Object.freeze({ point: true, spot: false });
const SPOT_VIEWS = Object.freeze({ point: false, spot: true });
const LOCAL_VIEWS = Object.freeze({ point: true, spot: true });

/** Ordinary depth rasters write fixed atlas ports. Static splits
 * retain their separately declared layer dependencies. */
export function currentShadowViews(
  shadow: RenderPipelineTopology['shadow'],
  directDirectional = false,
): CurrentShadowViews | undefined {
  const point = shadow.pointCount > 0 && !shadow.pointStaticMask;
  const spot = shadow.spotCount > 0 && !shadow.spotStaticMask;
  const sun = shadow.directional;
  if (directDirectional && sun !== 'disabled' && !sun.terrainReceivers?.length)
    return { point, spot, directional: true };
  return point ? (spot ? LOCAL_VIEWS : POINT_VIEWS) : spot ? SPOT_VIEWS : undefined;
}

interface TypedShadowPassOptions {
  readonly currentViews?: CurrentShadowViews | undefined;
  readonly currentReceiverDepth?: boolean | undefined;
  readonly waterInfoTargets?: WaterInfoGraphTargets;
  readonly surfaceFluidSimulation?: import('./water/fluid-graph').WaterFluidGraphInputs;
  readonly projectGpuDrivenShadow?: ProjectGpuDrivenShadow | undefined;
  readonly shadowFeatures?: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined;
  /** Main-camera HZB used to reject casters with hidden receivers. */
  readonly cameraPyramid?: GraphTextureView | undefined;
  readonly staticLayers?: ShadowDepthLayers | undefined;
  readonly depthLayers?: ShadowDepthLayers | undefined;
  readonly reuseAdjacentShadow?: boolean | undefined;
}

type ResolvedTypedShadowPassOptions = TypedShadowPassOptions & {
  readonly water: boolean;
};

type ShadowPassEncoder = (
  pass: RhiRenderPassEncoder,
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
) => void;

type DirectionalShadowTopology = Exclude<
  RenderPipelineTopology['shadow']['directional'],
  'disabled'
>;

/** Per-cascade facts the terrain receiver layers of the same cascade reuse. */
interface DirectionalCascadeWork {
  readonly accesses: readonly GraphAccess[];
  readonly staticRaster: ShadowViewRaster | undefined;
}

function retainedShadowLayer(
  layers: ShadowDepthLayers | undefined,
  label: string,
  layer: number,
): RetainedShadowTarget | undefined {
  if (layers === undefined) return undefined;
  return {
    retained: () => layers.retained(label, layer),
    rastered: () => layers.rastered(label, layer),
    discard: () => layers.discard(label, layer),
  };
}

/**
 * A static layer that can be skipped for a frame. Once skipped it reports no
 * retained depth, so the next decision rebuilds it from a cleared target even
 * when the view pool proves a hit; a graph-owned layer starts that way.
 */
function skippableStaticLayer(inner: RetainedShadowTarget | undefined) {
  let stale = inner === undefined;
  // Set while the merged single pass, not a graph compile, left the layer empty.
  let skipped = false;
  return {
    retained: () => !stale && (inner?.retained() ?? true),
    rastered: () => {
      stale = false;
      skipped = false;
      inner?.rastered();
    },
    discard: () => {
      stale = true;
      skipped = true;
      inner?.discard?.();
    },
    emptyReason: () => (skipped ? 'merged-static-layer' : undefined),
  } satisfies RetainedShadowTarget;
}

function featureShadowEncoder(
  shadowFeatures: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined,
  pass: RhiRenderPassEncoder,
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
):
  | ((view: Parameters<RenderFeatureShadowDraws<RenderPipelineFrame>['encode']>[3]) => void)
  | undefined {
  return shadowFeatures === undefined
    ? undefined
    : (view) => shadowFeatures.encode(pass, frame, resources, view);
}

function shadowPassAccesses(
  shadowProjection: Result<ShadowViewGraphProjection | undefined, RenderGraphError> | undefined,
  shadowFeatures: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined,
  waterInfoTargets?: WaterInfoGraphTargets,
  fluid?: TypedShadowPassOptions['surfaceFluidSimulation'],
): GraphAccess[] {
  return [
    ...projectionAccesses(shadowProjection),
    ...(shadowFeatures?.accesses ?? []),
    ...[...(waterInfoTargets?.values() ?? [])].map((target) => ({
      resource: target.view,
      usage: 'sampled-read' as const,
    })),
    ...(fluid === undefined
      ? []
      : [
          { resource: fluid.fields, usage: 'sampled-read' as const },
          { resource: fluid.descriptors, usage: 'storage-read' as const },
        ]),
  ];
}

function waterShadowFrame(
  frame: RenderPipelineFrame,
  resources: GraphResourceResolver,
  options: ResolvedTypedShadowPassOptions,
) {
  if (!options.water) return frame as _InternalRenderPipelineContext;
  const context = waterMaterialRecordContext(
    frame as _InternalRenderPipelineContext,
    options.waterInfoTargets === undefined
      ? undefined
      : { targets: options.waterInfoTargets, resources },
  );
  const fluid = options.surfaceFluidSimulation;
  return fluid === undefined
    ? context
    : {
        ...context,
        surfaceFluidSimulation: {
          fields: resources.textureView(fluid.fields).unwrap(),
          descriptors: resources.buffer(fluid.descriptors).unwrap(),
        },
      };
}

/** The static layer array GPU-settled casters raster into, when the view pool owns them. */
function createStaticShadowArrayTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: TypedShadowPassOptions,
  admitted: boolean,
  label: string,
  size: number,
  layers: number,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (
    !admitted ||
    (options.projectGpuDrivenShadow === undefined && options.staticLayers === undefined)
  )
    return ok(undefined);
  return createRetainedShadowArrayTarget(graph, options.staticLayers, label, size, layers);
}

function addDirectionalCascadePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: ResolvedTypedShadowPassOptions,
  directionalTarget: RenderPipelineTarget,
  directionalStatic: RenderPipelineTarget | undefined,
  mapSize: number,
  cascade: number,
  staticLayerShared: boolean,
): Result<DirectionalCascadeWork, RenderGraphError> {
  const { projectGpuDrivenShadow, shadowFeatures, reuseAdjacentShadow } = options;
  const identity = directionalShadowViewIdentity(cascade);
  const shadowProjection = projectGpuDrivenShadow?.(identity, options.cameraPyramid);
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
    retainedShadowLayer(options.depthLayers, 'directional-shadow-depth', cascade),
  );
  const encode: ShadowPassEncoder = (pass, frame, resources) =>
    encodeDirectionalShadowPass(
      waterShadowFrame(frame, resources, options),
      pass,
      cascade,
      featureShadowEncoder(shadowFeatures, pass, frame, resources),
      undefined,
      reuseAdjacentShadow,
    );
  const accesses = shadowPassAccesses(
    shadowProjection,
    shadowFeatures,
    options.waterInfoTargets,
    options.surfaceFluidSimulation,
  );
  const added =
    directionalStatic !== undefined
      ? recordStaticLayeredShadowPass(
          graph,
          projectGpuDrivenShadow,
          identity,
          `shadowCascade${cascade}`,
          layer.value,
          directionalStatic,
          options.staticLayers,
          'directional-shadow-static',
          cascade,
          mapSize,
          raster,
          encode,
          accesses,
          reuseAdjacentShadow,
          // Terrain receiver families copy this static layer.
          !staticLayerShared,
        )
      : recordShadowPass(graph, `shadowCascade${cascade}`, layer.value, raster, encode, accesses);
  if (!added.ok) return added;
  return ok({ accesses, staticRaster: added.value ?? undefined });
}

function addTerrainReceiverCascadePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: ResolvedTypedShadowPassOptions,
  directionalTarget: RenderPipelineTarget,
  directionalStatic: RenderPipelineTarget | undefined,
  mapSize: number,
  receiver: TerrainShadowReceiver,
  physicalLayer: number,
  cascade: number,
  cascadeWork: DirectionalCascadeWork | undefined,
): Result<void, RenderGraphError> {
  const { shadowFeatures, reuseAdjacentShadow } = options;
  const name = `shadowCascade${cascade}.terrain-${receiver.entityKey}`;
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
    retainedShadowLayer(options.depthLayers, 'directional-shadow-depth', physicalLayer),
  );
  const encode: ShadowPassEncoder = (pass, frame, resources) =>
    encodeDirectionalShadowPass(
      waterShadowFrame(frame, resources, options),
      pass,
      cascade,
      featureShadowEncoder(shadowFeatures, pass, frame, resources),
      receiver,
      reuseAdjacentShadow,
    );
  if (directionalStatic === undefined) {
    return recordShadowPass(graph, name, layer.value, raster, encode, cascadeWork?.accesses ?? []);
  }
  let rasterFinal = false;
  // This layer contains only GPU settled casters. Canonical Terrain is
  // a CPU residual and cannot contribute its front faces to it.
  const sourceLayer = shadowLayerTarget(graph, directionalStatic, `${name}.gpu-static`, cascade);
  if (!sourceLayer.ok) return sourceLayer;
  const copied = graph.addCopyPass(`${name}.static-copy`, {
    accesses: [
      { resource: sourceLayer.value.view, usage: 'copy-src' },
      { resource: layer.value.view, usage: 'copy-dst' },
    ],
    executeIf: (frame) => {
      // The copied layer can be empty after a rejected submit even
      // when the logical GPU pool hits. Its actual producer, ordered
      // before this copy by the resource read, owns that decision.
      const staticChanged = cascadeWork?.staticRaster?.reason() !== undefined;
      rasterFinal = raster.executeIf(frame, staticChanged ? 'static-layer-changed' : undefined);
      return rasterFinal;
    },
    encodeDirect: (encoder, _graphframe, resources) => {
      const source = resources.texture(directionalStatic.texture);
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
  return recordShadowPass(
    graph,
    name,
    layer.value,
    { executeIf: () => rasterFinal, encode: raster.encode },
    encode,
    cascadeWork?.accesses ?? [],
    'load',
  );
}

function addDirectionalShadowObservation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  directionalTarget: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addCopyPass('directional-shadow-observation', {
    accesses: [{ resource: directionalTarget.view, usage: 'copy-src' }],
    encodeDirect: (_graphencoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const texture = resources.texture(directionalTarget.texture);
      if (!texture.ok) throw texture.error;
      internal.pipelineState.perPassResources.shadowTexture = texture.value;
    },
  });
}

function addDirectionalShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  directional: DirectionalShadowTopology,
  options: ResolvedTypedShadowPassOptions,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { mapSize, cascadeCount, staticLayer = true, terrainReceivers = [] } = directional;
  if (options.currentViews?.directional === true && options.depthLayers !== undefined) {
    const current = currentDirectionalTarget(graph, options.depthLayers, mapSize, cascadeCount);
    if (!current.ok) return current;
    const recorded = addCurrentShadowRasters(graph, 'directional', current.value, options);
    if (!recorded.ok) return recorded;
    const observed = addDirectionalShadowObservation(graph, current.value);
    return observed.ok ? current : observed;
  }
  const usedLayerCount = cascadeCount * (1 + terrainReceivers.length);
  const target = createRetainedShadowArrayTarget(
    graph,
    options.depthLayers,
    'directional-shadow-depth',
    mapSize,
    Math.max(MIN_SHADOW_ARRAY_LAYERS, usedLayerCount),
    usedLayerCount,
  );
  if (!target.ok) return target;
  const directionalTarget = target.value;
  const staticTarget = createStaticShadowArrayTarget(
    graph,
    options,
    staticLayer,
    'directional-shadow-static',
    mapSize,
    Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount),
  );
  if (!staticTarget.ok) return staticTarget;
  const directionalStatic = staticTarget.value;
  const cascadeWork: DirectionalCascadeWork[] = [];
  for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
    const added = addDirectionalCascadePass(
      graph,
      options,
      directionalTarget,
      directionalStatic,
      mapSize,
      cascade,
      terrainReceivers.length > 0,
    );
    if (!added.ok) return added;
    cascadeWork.push(added.value);
  }
  for (const [rootIndex, receiver] of terrainReceivers.entries()) {
    for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
      const added = addTerrainReceiverCascadePass(
        graph,
        options,
        directionalTarget,
        directionalStatic,
        mapSize,
        receiver,
        cascadeCount * (rootIndex + 1) + cascade,
        cascade,
        cascadeWork[cascade],
      );
      if (!added.ok) return added;
    }
  }
  const observation = addDirectionalShadowObservation(graph, directionalTarget);
  return observation.ok ? ok(directionalTarget) : observation;
}

function importPointShadowAtlas(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  faceSize: number,
): ReturnType<RenderGraphBuilder<RenderPipelineFrame>['importTexture']> {
  return graph.importTexture(
    'point-shadow-atlas',
    {
      format: 'depth32float',
      size: {
        width: faceSize,
        height: faceSize,
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
}

function addPointShadowFacePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: ResolvedTypedShadowPassOptions,
  atlas: RenderPipelineTarget['texture'],
  pointStatic: RenderPipelineTarget | undefined,
  faceSize: number,
  pointIndex: number,
  face: number,
): Result<void | ShadowViewRaster, RenderGraphError> {
  const { projectGpuDrivenShadow, shadowFeatures, reuseAdjacentShadow } = options;
  const shadowProjection = projectGpuDrivenShadow?.({
    kind: 'point',
    index: pointIndex,
    face,
  });
  if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
  const identity = captureShadowViewIdentity({ kind: 'point', index: pointIndex, face });
  const faceView = graph.view(atlas, {
    label: `point-shadow-${pointIndex}-${face}`,
    dimension: '2d',
    aspect: 'depth-only',
    baseArrayLayer: pointIndex * 6 + face,
    arrayLayerCount: 1,
  });
  if (!faceView.ok) return faceView;
  const faceTarget: RenderPipelineTarget = {
    texture: atlas,
    view: faceView.value,
    format: 'depth32float',
    sampleCount: 1,
  };
  const raster = shadowViewRaster(graph, identity, shadowFeatures);
  const encode: ShadowPassEncoder = (pass, frame, resources) =>
    encodePointShadowPass(
      waterShadowFrame(frame, resources, options),
      pass,
      pointIndex,
      face,
      featureShadowEncoder(shadowFeatures, pass, frame, resources),
      reuseAdjacentShadow,
    );
  const accesses = shadowPassAccesses(
    shadowProjection,
    shadowFeatures,
    options.waterInfoTargets,
    options.surfaceFluidSimulation,
  );
  const name = `point-shadow-${pointIndex}-${face}`;
  return pointStatic !== undefined
    ? recordStaticLayeredShadowPass(
        graph,
        projectGpuDrivenShadow,
        identity,
        name,
        faceTarget,
        pointStatic,
        options.staticLayers,
        'point-shadow-static',
        pointIndex * 6 + face,
        faceSize,
        raster,
        encode,
        accesses,
        reuseAdjacentShadow,
      )
    : recordShadowPass(graph, name, faceTarget, raster, encode, accesses);
}

type AtlasShadowKind = 'directional' | 'point' | 'spot';

function activeShadowLayers(frame: RenderPipelineFrame, kind: AtlasShadowKind): number {
  const internal = frame as _InternalRenderPipelineContext;
  if (kind === 'directional') return (1 << currentDirectionalShadowCount(internal)) - 1;
  const state = internal.frameState;
  let mask = 0;
  if (kind === 'point') {
    for (const light of state.pointShadowSnapshots) {
      const layer = light.shadowAtlasLayer;
      if (layer >= 0 && layer < SHADOW_ATLAS_DEFAULT_LAYERS) mask |= 1 << layer;
    }
  } else {
    for (const light of state.spotShadowSnapshots) {
      const layer = light.shadowAtlasTile;
      if (light.lightViewProj !== undefined && layer >= 0 && layer < SPOT_SHADOW_LAYERS)
        mask |= 1 << layer;
    }
  }
  return mask;
}

function shadowRasterName(kind: AtlasShadowKind, layer: number, face: number): string {
  if (kind === 'directional') return `shadowCascade${layer}`;
  return kind === 'point' ? `point-shadow-${layer}-${face}` : `spot-shadow-${layer}`;
}

/** One ordered writer for an imported atlas. Actual lights issue the current faces;
 * recorder state belongs only to occupied layers and borrows the frame only during encode. */
function addCurrentShadowRasters(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  kind: AtlasShadowKind,
  target: RenderPipelineTarget,
  options: ResolvedTypedShadowPassOptions,
): Result<RenderPipelineTarget, RenderGraphError> {
  const faceCount = kind === 'point' ? 6 : 1;
  const layers = options.depthLayers;
  const depthLabel = kind === 'directional' ? 'directional-shadow-depth' : 'spot-shadow-depth';
  const views: ({ raster: ShadowViewRaster; command: RenderGraphNativePass } | undefined)[] = [];
  let issuedLayers = 0;
  let issuedTexture: Texture | undefined;
  let recording: _InternalRenderPipelineContext | undefined;
  let resources: GraphResourceResolver | undefined;
  const createView = (layer: number, face: number) => {
    const name = shadowRasterName(kind, layer, face);
    const identity =
      kind === 'directional'
        ? directionalShadowViewIdentity(layer)
        : captureShadowViewIdentity(
            kind === 'point' ? { kind, index: layer, face } : { kind, index: layer },
          );
    const raster = shadowViewRaster(
      undefined,
      identity,
      options.shadowFeatures,
      kind === 'point' ? undefined : retainedShadowLayer(layers, depthLabel, layer),
    );
    const encode = (pass: RhiRenderPassEncoder) => {
      const frame = recording as _InternalRenderPipelineContext;
      const inputs = resources as GraphResourceResolver;
      const water = waterShadowFrame(frame, inputs, options);
      const features = featureShadowEncoder(options.shadowFeatures, pass, frame, inputs);
      if (kind === 'point')
        encodePointShadowPass(water, pass, layer, face, features, options.reuseAdjacentShadow);
      else if (kind === 'spot')
        encodeSpotShadowPass(water, pass, layer, features, options.reuseAdjacentShadow);
      else
        encodeDirectionalShadowPass(
          water,
          pass,
          layer,
          features,
          undefined,
          options.reuseAdjacentShadow,
        );
    };
    const view =
      kind === 'point'
        ? recording?.frameState.pointShadowAtlas?.faceView(layer, face)
        : layers?.view(depthLabel, layer);
    if (view === undefined) throw new Error(`Missing physical depth view for ${name}`);
    const command: RenderGraphNativePass = {
      kind: 'raster',
      name,
      descriptor: {
        label: name,
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      },
      encode(pass) {
        if (renderAblation()?.shadowRaster !== false)
          raster.encode(recording as _InternalRenderPipelineContext, pass, encode, name);
      },
    };
    return { raster, command };
  };
  registerShadowPreparation(graph, kind, (frame, identity) => {
    if (identity.layer === 'static' || identity.terrainReceiver !== undefined) return true;
    if ((activeShadowLayers(frame, kind) & (1 << identity.index)) === 0) return false;
    if (kind === 'directional') {
      const recording = frame as _InternalRenderPipelineContext;
      const count = currentDirectionalShadowCount(recording);
      if (
        layers?.residentTexture(
          depthLabel,
          recording.directionalDepthSize ?? recording.pipelineState.perPassResources.shadowMapSize,
          Math.max(MIN_SHADOW_ARRAY_LAYERS, count),
        ) === undefined
      )
        return true;
    }
    const view = views[identity.index * faceCount + (identity.face ?? 0)];
    return view === undefined || view.raster.reasonFor(frame) !== undefined;
  });
  const added = graph.addSubgraphPass(`${kind}-shadow-views`, {
    profilePasses: () => {
      const layerCount =
        kind === 'point' ? SHADOW_ATLAS_DEFAULT_LAYERS : kind === 'spot' ? SPOT_SHADOW_LAYERS : 4;
      return Array.from({ length: layerCount * faceCount }, (_, index) => ({
        kind: 'raster',
        name: shadowRasterName(kind, Math.floor(index / faceCount), index % faceCount),
      }));
    },
    accesses: [
      { resource: target.view, usage: 'depth-stencil-write' },
      ...shadowPassAccesses(
        undefined,
        options.shadowFeatures,
        options.waterInfoTargets,
        options.surfaceFluidSimulation,
      ),
    ],
    commandsDirect(frame, resolved, issue, serial) {
      recording = frame as _InternalRenderPipelineContext;
      resources = resolved;
      try {
        const texture = resources.texture(target.texture).unwrap();
        const owner =
          kind === 'point'
            ? recording.frameState.pointShadowAtlas?.getTexture()
            : layers?.allocation(depthLabel);
        if (texture !== owner)
          throw new Error(`The ${kind} shadow atlas changed after resolving its depth port`);
        if (texture !== issuedTexture) {
          views.length = 0;
          issuedLayers = 0;
          issuedTexture = texture;
        }
        const active = activeShadowLayers(recording, kind);
        for (let removed = issuedLayers & ~active; removed !== 0; removed &= removed - 1) {
          const start = (31 - Math.clz32(removed & -removed)) * faceCount;
          views.fill(undefined, start, start + faceCount);
        }
        issuedLayers = active;
        for (let mask = active; mask !== 0; mask &= mask - 1) {
          const layer = 31 - Math.clz32(mask & -mask);
          for (let face = 0; face < faceCount; face++) {
            const address = layer * faceCount + face;
            const view = views[address] ?? createView(layer, face);
            views[address] = view;
            if (view.raster.executeIf(recording)) issue(serial, view.command);
          }
        }
      } finally {
        recording = undefined;
        resources = undefined;
      }
    },
    appendPassNames(frame, output) {
      for (let mask = activeShadowLayers(frame, kind); mask !== 0; mask &= mask - 1) {
        const layer = 31 - Math.clz32(mask & -mask);
        for (let face = 0; face < faceCount; face++)
          output.push(
            views[layer * faceCount + face]?.command.name ?? shadowRasterName(kind, layer, face),
          );
      }
    },
  });
  return added.ok ? ok(target) : added;
}

function addPointShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shadow: RenderPipelineTopology['shadow'],
  options: ResolvedTypedShadowPassOptions,
): Result<RenderPipelineTarget, RenderGraphError> {
  const texture = importPointShadowAtlas(graph, shadow.pointFaceSize);
  if (!texture.ok) return texture;
  const cube = graph.view(texture.value, {
    label: 'point-shadow-atlas.cube-array',
    dimension: 'cube-array',
    aspect: 'depth-only',
    arrayLayerCount: 24,
  });
  if (!cube.ok) return cube;
  const point: RenderPipelineTarget = {
    texture: texture.value,
    view: cube.value,
    format: 'depth32float',
    sampleCount: 1,
  };
  if (options.currentViews?.point === true)
    return addCurrentShadowRasters(graph, 'point', point, options);
  const staticTarget = createStaticShadowArrayTarget(
    graph,
    options,
    (shadow.pointStaticMask ?? 0) !== 0,
    'point-shadow-static',
    shadow.pointFaceSize,
    // Sized to the held cube layers; resizing carries the retained faces across.
    (32 - Math.clz32(shadow.pointStaticMask ?? 0)) * 6,
  );
  if (!staticTarget.ok) return staticTarget;
  for (let pointIndex = 0; pointIndex < shadow.pointCount; pointIndex += 1) {
    for (let face = 0; face < 6; face += 1) {
      const added = addPointShadowFacePass(
        graph,
        options,
        texture.value,
        ((shadow.pointStaticMask ?? 0) & (1 << pointIndex)) !== 0 ? staticTarget.value : undefined,
        shadow.pointFaceSize,
        pointIndex,
        face,
      );
      if (!added.ok) return added;
    }
  }
  return ok(point);
}

function addSpotShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shadow: RenderPipelineTopology['shadow'],
  options: ResolvedTypedShadowPassOptions,
  spot: RenderPipelineTarget,
  spotStatic: RenderPipelineTarget | undefined,
  spotIndex: number,
): Result<void | ShadowViewRaster, RenderGraphError> {
  const { projectGpuDrivenShadow, shadowFeatures, reuseAdjacentShadow } = options;
  const identity = captureShadowViewIdentity({ kind: 'spot', index: spotIndex });
  const shadowProjection = projectGpuDrivenShadow?.(identity, options.cameraPyramid);
  if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
  const layer = shadowLayerTarget(graph, spot, `spot-shadow-layer-${spotIndex}`, spotIndex);
  if (!layer.ok) return layer;
  const name = `spot-shadow-${spotIndex}`;
  const raster = shadowViewRaster(
    graph,
    identity,
    shadowFeatures,
    retainedShadowLayer(options.depthLayers, 'spot-shadow-depth', spotIndex),
  );
  const encode: ShadowPassEncoder = (pass, frame, resources) =>
    encodeSpotShadowPass(
      waterShadowFrame(frame, resources, options),
      pass,
      spotIndex,
      featureShadowEncoder(shadowFeatures, pass, frame, resources),
      reuseAdjacentShadow,
    );
  const accesses = shadowPassAccesses(
    shadowProjection,
    shadowFeatures,
    options.waterInfoTargets,
    options.surfaceFluidSimulation,
  );
  return spotStatic !== undefined
    ? recordStaticLayeredShadowPass(
        graph,
        projectGpuDrivenShadow,
        identity,
        name,
        layer.value,
        spotStatic,
        options.staticLayers,
        'spot-shadow-static',
        spotIndex,
        shadow.spotMapSize,
        raster,
        encode,
        accesses,
        reuseAdjacentShadow,
      )
    : recordShadowPass(graph, name, layer.value, raster, encode, accesses);
}

function addSpotShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shadow: RenderPipelineTopology['shadow'],
  options: ResolvedTypedShadowPassOptions,
): Result<RenderPipelineTarget, RenderGraphError> {
  const spot = createRetainedShadowArrayTarget(
    graph,
    options.depthLayers,
    'spot-shadow-depth',
    shadow.spotMapSize,
    SPOT_SHADOW_LAYERS,
    options.currentViews?.spot === true ? SPOT_SHADOW_LAYERS : shadow.spotCount,
  );
  if (!spot.ok) return spot;
  const activeSpot = spot.value;
  if (options.currentViews?.spot === true)
    return addCurrentShadowRasters(graph, 'spot', activeSpot, options);
  const spotStatic = createStaticShadowArrayTarget(
    graph,
    options,
    (shadow.spotStaticMask ?? 0) !== 0,
    'spot-shadow-static',
    shadow.spotMapSize,
    Math.max(MIN_SHADOW_ARRAY_LAYERS, 32 - Math.clz32(shadow.spotStaticMask ?? 0)),
  );
  if (!spotStatic.ok) return spotStatic;
  // Pass i writes tile i, the layer the Render World holds for one casting
  // spot; the receiver samples it through `shadowAtlasTile == i`.
  for (let spotIndex = 0; spotIndex < shadow.spotCount; spotIndex += 1) {
    const added = addSpotShadowPass(
      graph,
      shadow,
      options,
      activeSpot,
      ((shadow.spotStaticMask ?? 0) & (1 << spotIndex)) !== 0 ? spotStatic.value : undefined,
      spotIndex,
    );
    if (!added.ok) return added;
  }
  return ok(activeSpot);
}

export function addTypedShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: Pick<RenderPipelineTopology, 'shadow' | 'water'>,
  options: TypedShadowPassOptions = {},
): Result<TypedShadowTargets, RenderGraphError> {
  const resolvedOptions: ResolvedTypedShadowPassOptions = {
    ...options,
    water: topology.water === true,
  };
  const shadow = topology.shadow;
  if (
    options.currentReceiverDepth !== undefined &&
    (shadow.directional !== 'disabled' || shadow.pointCount > 0 || shadow.spotCount > 0)
  ) {
    const selected = addCurrentShadowSelection(
      graph,
      shadow.directional === 'disabled' ? 0 : shadow.directional.cascadeCount,
      options.currentReceiverDepth,
      options.currentViews?.directional === true,
    );
    if (!selected.ok) return selected;
  }
  let directional: RenderPipelineTarget | undefined;
  if (topology.shadow.directional !== 'disabled') {
    const added = addDirectionalShadowPasses(graph, topology.shadow.directional, resolvedOptions);
    if (!added.ok) return added;
    directional = added.value;
  }
  let point: RenderPipelineTarget | undefined;
  if (topology.shadow.pointCount > 0) {
    const added = addPointShadowPasses(graph, topology.shadow, resolvedOptions);
    if (!added.ok) return added;
    point = added.value;
  }
  let spot: RenderPipelineTarget | undefined;
  if (shadow.spotCount > 0) {
    const result = addSpotShadowPasses(graph, shadow, resolvedOptions);
    if (!result.ok) return result;
    spot = result.value;
  }
  return ok({ directional, spot, point });
}

/** One shadow target another graph rastered this frame, as its executing graph resolved it. */
export interface ResolvedShadowTarget {
  readonly texture: import('@forgeax/engine-rhi').Texture;
  readonly view: import('@forgeax/engine-rhi').TextureView;
}

export type ResolvedShadowTargets = {
  readonly [K in keyof TypedShadowTargets]?: ResolvedShadowTarget | undefined;
};

/** The display view's shadows, set by its graph around the receiving view's execution. */
export interface SharedShadowSource {
  current: ResolvedShadowTargets | undefined;
}

/**
 * Import the shadow maps the display view rastered this frame instead of
 * rastering them again. The receiving view records with the display view's
 * lights, so its topology names the same targets in the same layout.
 */
export function importSharedShadowTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: Pick<RenderPipelineTopology, 'shadow'>,
  source: SharedShadowSource,
): Result<TypedShadowTargets, RenderGraphError> {
  const shadow = topology.shadow;
  const resolved = (kind: keyof TypedShadowTargets): ResolvedShadowTarget => {
    const target = source.current?.[kind];
    if (target === undefined)
      throw new Error(`The display view's ${kind} shadow resolves before its receivers execute`);
    return target;
  };
  const importArray = (
    kind: keyof TypedShadowTargets,
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float',
    dimension: '2d-array' | 'cube-array',
    usage: number,
  ): Result<RenderPipelineTarget, RenderGraphError> => {
    const texture = graph.importTexture(
      `${label}.shared`,
      { format, size: { width: size, height: size, depthOrArrayLayers: layers }, usage },
      () => resolved(kind).texture,
    );
    if (!texture.ok) return texture;
    const view = graph.importView(
      texture.value,
      {
        label: `${label}.shared.view`,
        dimension,
        aspect: format === 'depth32float' ? 'depth-only' : 'all',
        arrayLayerCount: layers,
      },
      () => resolved(kind).view,
    );
    if (!view.ok) return view;
    return ok({ texture: texture.value, view: view.value, format, sampleCount: 1 });
  };
  let directional: RenderPipelineTarget | undefined;
  if (shadow.directional !== 'disabled') {
    const { mapSize, cascadeCount, terrainReceivers = [] } = shadow.directional;
    const imported = importArray(
      'directional',
      'directional-shadow-depth',
      mapSize,
      Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount * (1 + terrainReceivers.length)),
      'depth32float',
      '2d-array',
      SHADOW_DEPTH_LAYER_USAGE,
    );
    if (!imported.ok) return imported;
    directional = imported.value;
  }
  let point: RenderPipelineTarget | undefined;
  if (shadow.pointCount > 0) {
    const imported = importArray(
      'point',
      'point-shadow-atlas',
      shadow.pointFaceSize,
      24,
      'depth32float',
      'cube-array',
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    );
    if (!imported.ok) return imported;
    point = imported.value;
  }
  let spot: RenderPipelineTarget | undefined;
  if (shadow.spotCount > 0) {
    const result = importArray(
      'spot',
      'spot-shadow-depth',
      shadow.spotMapSize,
      SPOT_SHADOW_LAYERS,
      'depth32float',
      '2d-array',
      SHADOW_DEPTH_LAYER_USAGE,
    );
    if (!result.ok) return result;
    spot = result.value;
  }
  return ok({ directional, spot, point });
}

/**
 * Record the frame's planar mirror once this graph's shadows are written. The
 * mirror samples them as they are, so it rasterises no shadow of its own; its
 * receivers read `planarView` after this pass.
 */
export function addPlanarReflectionPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  shadows: TypedShadowTargets,
  planarView: GraphTextureView | undefined,
): Result<void, RenderGraphError> {
  if (planarView === undefined) return ok(undefined);
  const targets = (['directional', 'spot', 'point'] as const).flatMap((kind) => {
    const target = shadows[kind];
    return target === undefined ? [] : [[kind, target] as const];
  });
  return graph.addSubgraphPass('planar-reflection', {
    profilePasses: () => [{ kind: 'copy', name: 'planar-reflection' }],
    accesses: [
      ...targets.map(([, target]) => ({ resource: target.view, usage: 'sampled-read' as const })),
      { resource: planarView, usage: 'color-attachment' },
    ],
    commandsDirect: (frame, resources, issue, recording) => {
      const record = (frame as _InternalRenderPipelineContext).planarReflectionCapture;
      if (record === undefined) return;
      const resolved: Partial<Record<keyof TypedShadowTargets, ResolvedShadowTarget>> = {};
      for (const [kind, target] of targets) {
        const texture = resources.texture(target.texture);
        if (!texture.ok) throw texture.error;
        const view = resources.textureView(target.view);
        if (!view.ok) throw view.error;
        resolved[kind] = { texture: texture.value, view: view.value };
      }
      issue(recording, { kind: 'copy', name: 'planar-reflection', encode: () => record(resolved) });
    },
  });
}
