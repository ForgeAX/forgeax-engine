import { recordContext } from '../world/view-record-context';
// The graph-topology inputs of one view that depend on its lights, scene
// roster and device: shadow map sizes, terrain receivers, the cloud shadow
// projection, analytic fog activity and the volumetric fog projection. Only
// `render-view-topology` (RenderPrepare) computes them for a Render World
// view; recording and graph compile read the stored result.

import { RhiError } from '@forgeax/engine-rhi';
import type { ExtractedCloudLayer } from '../cloud/extract';
import { cloudShadowResolutionForQuality } from '../cloud/parameters';
import { type CloudShadowProjection, createCloudShadowProjection } from '../cloud/shadow';
import { type FogFrame, fogIsActive } from '../extract/environment';
import type { RenderResourceScope } from '../publication/resource-scope';
import type {
  CameraSnapshot,
  SpotLightProjectorFrameContext,
  VolumetricFogFrameContext,
} from '../render-contract';
import type { ExtractedVolumetricFog, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { type TerrainShadowReceiver, terrainShadowReceivers } from '../terrain/shadow-family';
import { hasVolumetricFogCapability } from '../volume/capability';
import type { ViewLights } from '../world/render-lights';
import type { RenderFrameState } from './frame-snapshot';
import { resolveShadowMapSize, resolveSpotShadowMapSize } from './frame-targets';
import type { PipelineState, RenderSystemInternals } from './render-context';
import { prepareVolumetricFogFrame, stageVolumetricFogParams } from './volume-params';
import { volumetricFogForView } from './volume-view';

/** Resolve the stable world-space projection shared by cloud and lighting. */
export function cloudShadowProjectionFor(
  cloudLayer: ExtractedCloudLayer | undefined,
):
  | (CloudShadowProjection & { readonly baseHeight: number; readonly thickness: number })
  | undefined {
  if (cloudLayer?.sunDirection === undefined) return undefined;
  return {
    ...createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: cloudLayer.sunDirection,
      range: cloudLayer.params.shadowRange,
      resolution: cloudShadowResolutionForQuality(cloudLayer.params.quality),
    }),
    baseHeight: cloudLayer.params.baseHeight,
    thickness: cloudLayer.params.thickness,
  };
}

/**
 * Resolve the SpotLight-owned cookie independently of volumetric fog. Surface
 * lighting must keep the authored projector when the fog component is absent;
 * otherwise the view bind group silently falls back to white and changes the
 * direct-light energy on the floor. A fog-selected projector is preferred so
 * the surface and volume lanes consume one identity, with the first authored
 * projector as the deterministic scene fallback.
 */
function prepareSpotLightProjectorFrame(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  lights: ViewLights,
  fog: ExtractedVolumetricFog | undefined,
): SpotLightProjectorFrameContext | undefined {
  const preferred =
    fog?.projectorHandle === undefined
      ? undefined
      : lights.spot.find((light) => light.projectorHandle === fog.projectorHandle);
  const source =
    preferred ??
    lights.spot.find(
      (light) =>
        light.projectorHandle !== undefined &&
        light.projectorAsset !== undefined &&
        light.lightViewProj !== undefined,
    );
  if (
    source === undefined ||
    source.projectorHandle === undefined ||
    source.projectorAsset === undefined
  ) {
    return undefined;
  }
  const ownerWorld = worlds[fog?.worldId ?? 0] ?? world;
  const resident = internals.gpuStore.ensureResident(
    source.projectorHandle,
    source.projectorAsset,
    ownerWorld,
  );
  if (!resident.ok || !('texture' in resident.value)) {
    if (!resident.ok) {
      internals.errorRegistry.fire(
        resident.error instanceof RhiError
          ? resident.error
          : new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'SpotLight projector residency to resolve a GPU texture',
              hint: 'repair the authored projector TextureAsset payload and retry the next frame',
              detail: { error: resident.error },
            }),
      );
    }
    return undefined;
  }
  const sampler = internals.device.createSampler({
    label: 'spot-projector-linear-clamp',
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!sampler.ok) {
    internals.errorRegistry.fire(sampler.error);
    return undefined;
  }
  return {
    texture: resident.value.texture.handle,
    view: resident.value.view,
    sampler: sampler.value,
    spotIndex: lights.spot.indexOf(source),
    lightSlotIndex: lights.point.length + lights.spot.indexOf(source),
  };
}

/** Stage the accepted parameter payload into the writable slot for a degraded
 * source frame. This keeps the accepted GPU buffer immutable until submit
 * succeeds while still allowing the LKG graph to update its history flag. */
function stageAcceptedVolumetricFogFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  accepted: VolumetricFogFrameContext | undefined,
): VolumetricFogFrameContext | undefined {
  if (accepted === undefined) return undefined;
  const params = frameState.volumetricFogParams.accepted?.params;
  if (params === undefined) return accepted;
  const paramsBuffer = stageVolumetricFogParams(internals, frameState, params);
  if (paramsBuffer === undefined) return accepted;
  return { ...accepted, paramsBuffer };
}

/** The volume projection this frame renders and the accepted state it may replace. */
export function prepareFrameVolumetricFog(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  lights: ViewLights,
  volumetricFog: ExtractedVolumetricFog | undefined,
) {
  const capability = hasVolumetricFogCapability(
    internals.device.caps,
    internals.volumetricFogShaders,
  );
  const viewFog = capability
    ? volumetricFogForView(
        volumetricFog,
        camera,
        recordContext(internals).canvas.width,
        recordContext(internals).canvas.height,
      )
    : volumetricFog;
  const spotLightProjector = prepareSpotLightProjectorFrame(
    internals,
    world,
    worlds,
    lights,
    volumetricFog,
  );
  const prepared = prepareVolumetricFogFrame(
    internals,
    frameState,
    world,
    worlds,
    viewFog,
    lights,
    capability,
    spotLightProjector,
  );
  // A degraded authored snapshot must keep consuming the last accepted GPU
  // projection. The current source is still surfaced as a diagnostic, but
  // it must not replace the graph/context that produced the last good frame.
  // An absent component is different: a successful no-volume frame retires
  // the accepted projection and compiles the normal graph.
  const acceptedFallback =
    capability && viewFog !== undefined && prepared === undefined
      ? frameState.volumetricFogAccepted
      : undefined;
  const baseContext =
    prepared ??
    (acceptedFallback === undefined
      ? undefined
      : stageAcceptedVolumetricFogFrame(
          internals,
          frameState,
          frameState.volumetricFogAcceptedContext,
        ));
  const graphFog = capability ? (prepared === undefined ? acceptedFallback : viewFog) : undefined;
  return {
    capability,
    viewFog,
    viewCulled: volumetricFog?.status === 'available' && viewFog === undefined,
    spotLightProjector,
    prepared,
    acceptedFallback,
    graphFog,
    baseContext,
    // A volume graph replacement is provisional whenever it can affect the
    // accepted volume projection: authoring degradation (which consumes the
    // LKG graph), an authored replacement, and an explicit fog-off transition.
    // Non-volume frames retain the legacy immediate graph retirement path.
    topologyCandidate:
      (graphFog?.status === 'available' && baseContext !== undefined) ||
      (graphFog === undefined && frameState.volumetricFogAccepted !== undefined) ||
      (volumetricFog?.status === 'degraded' && acceptedFallback !== undefined),
  };
}

export type FrameVolumetricFog = ReturnType<typeof prepareFrameVolumetricFog>;

/** Everything the graph compile and recording read of a view's lights, scene roster and device. */
export interface ViewTopology {
  /** Directional cascade map size resolved against device limits. */
  readonly directionalShadowMapSize: number | undefined;
  readonly spotShadowMapSize: number | undefined;
  /** The size the graph allocates: directional, else spot. */
  readonly shadowMapSize: number | undefined;
  readonly terrainReceivers: readonly TerrainShadowReceiver[];
  readonly cloudShadow: ReturnType<typeof cloudShadowProjectionFor>;
  readonly analyticFog: boolean;
  readonly volume: FrameVolumetricFog;
}

/** What {@link planViewTopology} reads; display media are already absent for a capture view. */
export interface ViewTopologyInput {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly world: RenderResourceScope;
  readonly worlds: readonly RenderResourceScope[];
  readonly camera: CameraSnapshot;
  readonly lights: ViewLights;
  /** The scene roster terrain receivers are read from: the retained shadow roster, else the visible rows. */
  readonly sourceRenderables: FrameList<RenderableSnapshot>;
  readonly volumetricFog: ExtractedVolumetricFog | undefined;
  readonly cloudLayer: ExtractedCloudLayer | undefined;
  readonly analyticFog: FogFrame | undefined;
}

/** The step of {@link planViewTopology} that failed; closed so callers handle each. */
export type ViewTopologyFailureCode =
  | 'view-not-staged'
  | 'shadow-map-size-failed'
  | 'terrain-receivers-failed'
  | 'cloud-shadow-failed'
  | 'volumetric-fog-prepare-failed';

/** A planned topology, or the failed step and its cause; planning never throws. */
export type ViewTopologyOutcome =
  | { readonly kind: 'planned'; readonly topology: ViewTopology }
  | { readonly kind: 'failed'; readonly code: ViewTopologyFailureCode; readonly cause: unknown };

class TopologyStepFailure {
  constructor(
    readonly code: ViewTopologyFailureCode,
    readonly cause: unknown,
  ) {}
}

function step<T>(code: ViewTopologyFailureCode, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw new TopologyStepFailure(code, cause);
  }
}

/** The graph's shadow pass inputs, published beside the topology that sized them. */
function publishShadowPassResources(
  pipelineState: PipelineState,
  lights: ViewLights,
  graphShadowMapSize: number | undefined,
): void {
  const resources = pipelineState.perPassResources;
  resources.shadowMapSize = graphShadowMapSize ?? 0;
  resources.shadowCascadeCount = lights.cascades?.cascadeCount ?? 0;
}

/** The single owner of a view's topology inputs; the schedule and a direct recorder both call it. */
export function planViewTopology(input: ViewTopologyInput): ViewTopologyOutcome {
  const { internals, lights } = input;
  try {
    const directionalShadowMapSize = step('shadow-map-size-failed', () =>
      resolveShadowMapSize(internals, lights),
    );
    const spotShadowMapSize = step('shadow-map-size-failed', () =>
      resolveSpotShadowMapSize(internals, lights),
    );
    const topology: ViewTopology = {
      directionalShadowMapSize,
      spotShadowMapSize,
      shadowMapSize: directionalShadowMapSize ?? spotShadowMapSize,
      terrainReceivers: step('terrain-receivers-failed', () =>
        terrainShadowReceivers(input.sourceRenderables),
      ),
      cloudShadow: step('cloud-shadow-failed', () => cloudShadowProjectionFor(input.cloudLayer)),
      analyticFog: input.analyticFog !== undefined && fogIsActive(input.analyticFog),
      volume: step('volumetric-fog-prepare-failed', () =>
        prepareFrameVolumetricFog(
          internals,
          input.frameState,
          input.world,
          input.worlds,
          input.camera,
          lights,
          input.volumetricFog,
        ),
      ),
    };
    const pipelineState = recordContext(internals).getPipelineState();
    if (pipelineState !== null)
      publishShadowPassResources(pipelineState, lights, topology.shadowMapSize);
    return { kind: 'planned', topology };
  } catch (failure) {
    if (failure instanceof TopologyStepFailure)
      return { kind: 'failed', code: failure.code, cause: failure.cause };
    throw failure;
  }
}
