// @forgeax/engine-runtime - RendererState record stage: per-frame lighting.

import { standardViewRecording } from '../pipeline/standard-forward-output';
// feat-20260704 M5/w31: further-split from frame.ts (AC-05 <=1500 lines/file).
// Pure leaf helpers invoked once each from recordFrame; behavior verbatim.

import { mat4, vec3 } from '@forgeax/engine-math';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  type RhiDevice,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import type { AssetHandle, ManifestEntry } from '@forgeax/engine-types';
import { err, fnv1a32, ok, type Result } from '@forgeax/engine-types';
import { meshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import { standardBloomAdmitted } from '../bloom-admission';
import { hasCapsuleShadowDemand } from '../capsule-shadow/inspection';
import { planarReflectionViewEntries } from '../capture/planar-material';
import { getOrCreateDirectDfgLut } from '../device/direct-dfg-lut';
import { ablateLocalLights } from '../diagnostics/render-ablation';
import {
  type AtmosphereViews,
  atmosphereBindings,
  DIRECT_DFG_VIEW_SLOT,
  directDfgViewBinding,
  FORWARD_HIZ_VIEW_SLOT,
  FORWARD_SCREEN_SURFACE_VIEW_SLOT,
  FORWARD_SSR_COLOR_VIEW_SLOT,
  pushAtmosphereBindingResources,
  retainViewGroup,
  skyViewBindings,
  TRANSMISSION_BACKDROP_VIEW_SLOT,
  viewLayoutSlots,
} from '../environment/bindings';
import {
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
  type RenderError,
  RendererOperationError,
  StandardClusterTransportUnavailableError,
} from '../errors/render';
import {
  type ClusterViewResources,
  clusterViewBindings,
  createHdrpClusterMembershipBindGroup,
  getOrCreateHdrpBuffers,
  type HdrpBuffers,
  hdrpBuffersCurrent,
  packClusterUniform,
} from '../hdrp-buffers';
import type {
  ReflectedDirectLightSlotLayout,
  StandardClusterReflectedAbi,
} from '../light-buffer-layout';
import { forwardPunctualShadowPlan } from '../pipeline/forward-punctual-shadow-plan';
import { currentForwardShadowReceiver } from '../pipeline/forward-shadow-admission';
import {
  DEFERRED_CHANNEL_MAPPING_MASK,
  prepareDeferredLightingChannels,
} from '../pipeline/standard-lighting/deferred-channels';
import {
  createStandardLocalLights,
  sameLocalLightSources,
  standardLocalLightEmitsNothing,
} from '../pipeline/standard-lighting/local-lights';
import {
  type PreparedStandardLighting,
  prepareStandardLighting,
} from '../pipeline/standard-lighting/prepare';
import { lightSlotWorkOf, projectLightSlotWork } from '../pipeline/standard-lighting/slot-work';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  type StandardClusterTransport,
  selectStandardClusterTransport,
} from '../pipeline/standard-lighting/transport';
import { DEFAULT_CLUSTER_GRID, DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { prepareLightTextureSliceResample } from '../prepare/extended-lighting/light-texture-resample';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
  writeCookieSliceMipChain,
} from '../prepare/extended-lighting/resources';
import type { LightTextureSource } from '../prepare/extended-lighting/spot-modifiers';
import type { RenderResourceScope } from '../publication/resource-scope';
import { createPrimitiveBindGroup } from '../reflection/primitive-bindings';
import type { CameraSnapshot, RenderHdrpClusterPhase } from '../render-contract';
import type {
  DirectionalLightSnapshot,
  IesProfileSnapshot,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import { type FrameList, rasterRowsOf } from '../scene/frame-list';
import { hasRasterDemand } from '../scene/raster-demand';
import {
  SHADOW_ATLAS_DEFAULT_FACE_SIZE,
  SHADOW_ATLAS_DEFAULT_LAYERS,
  ShadowAtlas,
} from '../shadow-atlas';
import { ssaoUsesLighting } from '../ssao-config';
import type { ViewLights } from '../world/render-lights';
import {
  clusterLocalLightLimit,
  clusterLocalLights,
  warnStandardClusterEntryCap,
  warnStandardLocalLightCap,
} from './cluster-local-lights';
import { captureClusterWorkSample } from './cluster-work-conformance';
// extendedLighting keeps Spot modifier factors on the existing light record
// path; no additional render pass or submit owner is introduced.
import type { BindGroupCounts, RenderFrameState } from './frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from './frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix, isLitMaterialSnapshot } from './helpers';
import { LightTable } from './light-table';
import {
  bindGroupChainLeaf2,
  findFromChain,
  getOrCreateFromChain,
  MESH_PER_ENTITY_STRIDE,
  MESH_UBO_FULL_ARRAY_BYTES,
  rememberBindGroup,
} from './mesh-ssbo';
import type { PipelineState, RecordProfileRunner, RenderSystemInternals } from './render-context';
import { standardLightingPipelineDemand } from './view-pipeline-demand';
import { SHADOW_PARAMS_BYTES, VIEW_UNIFORM_BYTES } from './view-ubo';

export function projectDeviceOwnedBindGroup<T>(
  state:
    | {
        readonly device: RhiDevice;
        readonly layout: BindGroupLayout;
        readonly bindGroup: T;
      }
    | null
    | undefined,
  device: RhiDevice,
  layout: BindGroupLayout | null,
): T | null {
  return state !== null && state !== undefined && state.device === device && state.layout === layout
    ? state.bindGroup
    : null;
}

function runHdrpClusterProfilePhase<T>(
  runner: RecordProfileRunner | undefined,
  phase: RenderHdrpClusterPhase,
  action: () => T,
): T {
  return runner === undefined ? action() : runner(phase, action);
}

function mapClusterUploadFailure(
  resource: string,
  error: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail?: unknown;
  },
): RendererOperationError<'device-operation-failed'> {
  return new RendererOperationError('device-operation-failed', {
    operation: 'draw',
    cause: {
      code: error.code,
      expected: `device queue upload succeeds for Standard Cluster ${resource}`,
      hint: `repair the device write for Standard Cluster ${resource} and retry the frame`,
      detail: error,
    },
  });
}

function publishedFeatureShaderEntry(
  internals: RenderSystemInternals,
  identifier: string,
): ManifestEntry | undefined {
  const source = internals.getFeatureShaderSource?.(identifier);
  if (source === undefined) return undefined;
  for (const entry of internals.shaderRegistry?.entries() ?? []) {
    if (entry.wgsl === source) return entry;
  }
  return undefined;
}

/** Retained View bind-group chain key; filled and consumed synchronously. */
const viewChainKeys: object[] = [];
/** Neutral binner origin for infinite-range directional members. */

/** Only the closed stock pipeline/grid qualifies; borrowed declarations stay live. */
function stockClusterMembership(
  frameState: RenderFrameState,
  grid: PreparedStandardLighting['layout']['grid'],
) {
  return standardViewRecording(frameState.activePipeline) && grid === DEFAULT_CLUSTER_GRID
    ? frameState.standardClusterMembership
    : undefined;
}

const forwardSurfaceBindingKey = {};
const planarBindingKey = {};
const transmissionBindingKey = {};

export interface ViewBindGroupTargets {
  readonly viewBindGroupLayout?: BindGroupLayout | undefined;
  readonly sceneDepth?: TextureView | undefined;
  readonly hiZ?: TextureView | undefined;
  readonly ssrColor?: TextureView | undefined;
  /** Prepared auto layouts are identified by their pipeline and layout accessor. */
  readonly viewLayoutIdentity?: readonly object[] | undefined;
  /** Create the sampled view only on a successful bind-group cache miss. */
  readonly sceneDepthTexture?: Texture | undefined;
  readonly directionalShadow?: TextureView | undefined;
  readonly spotShadow?: TextureView | undefined;
  readonly cloudShadow?: TextureView | undefined;
  readonly cluster?: ClusterViewResources | undefined;
  readonly sky?: Parameters<typeof skyViewBindings>[0] | undefined;
  readonly planarReflection?: TextureView | undefined;
  readonly transmissionBackdrop?: TextureView | undefined;
  readonly forwardScreenSurface?: TextureView | undefined;
  readonly atmosphere?: AtmosphereViews | undefined;
  readonly projector?: TextureView | undefined;
  readonly projectorSampler?: import('@forgeax/engine-rhi').Sampler | undefined;
}

/** Read the admitted extended View resources once, in the original eager order. */
function extendedViewLightingResources(pipelineState: PipelineState, extendedLighting: boolean) {
  const iesProfileTextureView = pipelineState.iesProfileTextureView;
  const cookieTextureView = pipelineState.cookieTextureView;
  const cookieMatrixBuffer = pipelineState.cookieMatrixBuffer;
  const ltcLambertTextureView = pipelineState.ltcLambertTextureView;
  const ltcGgxTextureView = pipelineState.ltcGgxTextureView;
  return extendedLighting &&
    iesProfileTextureView !== undefined &&
    cookieTextureView !== undefined &&
    cookieMatrixBuffer !== undefined &&
    ltcLambertTextureView !== undefined &&
    ltcGgxTextureView !== undefined
    ? {
        sampler: pipelineState.defaultSampler,
        iesProfileTextureView,
        cookieTextureView,
        ltcLambertTextureView,
        ltcGgxTextureView,
        cookieMatrixBuffer,
      }
    : undefined;
}

/** Resolve only the current View resources used by a fullscreen lighting receiver. */
function requireViewBindingCurrent(current: (() => boolean) | undefined): void {
  if (current?.() === false)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'current View binding inputs before and after native creation',
      hint: 'discard the stale preparation and retry from its actual owners',
    });
}

/** A physical View can survive its recording context through retained GPU bindings. */
function directDfgViewReader(
  device: RhiDevice,
  scope: RenderSystemInternals['deviceScope'],
): () => TextureView {
  const owner = scope === undefined ? undefined : new WeakRef(scope);
  return () => {
    const current = owner?.deref();
    if (current === undefined || !current.isAlive())
      throw new Error('View direct DFG requires a live device scope');
    return getOrCreateDirectDfgLut(device, current).unwrap().view;
  };
}

function resolveSceneDepthView(
  device: RhiDevice,
  targets: ViewBindGroupTargets | undefined,
): TextureView | undefined {
  const depth = targets?.sceneDepthTexture;
  return depth === undefined
    ? targets?.sceneDepth
    : device.createTextureView(depth, { aspect: 'depth-only', dimension: '2d' }).unwrap();
}

export function buildViewBindGroup(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  bindGroupCounts: BindGroupCounts,
  graphTargets?: ViewBindGroupTargets,
  readOnly = false,
  current?: () => boolean,
): BindGroup | null {
  const shadowSampler = pipelineState.perPassResources.shadowSampler;
  if (shadowSampler === null) {
    return null;
  }
  const graphShadowView = graphTargets?.directionalShadow;
  const b3View =
    graphShadowView !== undefined ? graphShadowView : pipelineState.shadowArrayFallbackTextureView;
  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: bind the real
  // ShadowAtlas cube_array view when point shadows are active in this
  // frame; otherwise the 1x1x6 fallback (cleared to 1.0 = fully lit).
  const pointShadowAtlas = frameState.pointShadowAtlas;
  const atlasViewMaybe = pointShadowAtlas?.isAllocated() ? pointShadowAtlas.getAtlasView() : null;
  const b5View =
    atlasViewMaybe !== null ? atlasViewMaybe : pipelineState.shadowAtlasFallbackTextureView;
  // feat-20260625-spot-light-shadow-mapping M2 / w21 (D-1 fragment side +
  // D-5): bind the real spot shadow array view (graph-owned) when spot
  // shadows run this frame; otherwise the depth-array fallback cleared to
  // 1.0 (fully lit), the same `texture_depth_2d_array` shape as binding 3.
  const graphSpotShadowView = graphTargets?.spotShadow;
  const b8View =
    graphSpotShadowView !== undefined
      ? graphSpotShadowView
      : pipelineState.shadowArrayFallbackTextureView;
  const cloudShadowView = graphTargets?.cloudShadow ?? pipelineState.defaultWhiteTextureView;
  const extendedLighting = pipelineState.extendedLightingAvailable ?? true;
  const extendedLightingResources = extendedViewLightingResources(pipelineState, extendedLighting);
  if (extendedLighting && extendedLightingResources === undefined) {
    return null;
  }
  const projectorAvailable = pipelineState.projectorAvailable !== false;
  const lowLimitCloudBindings = !extendedLighting && !projectorAvailable;
  const b11View = graphTargets?.projector ?? pipelineState.defaultWhiteTextureView;
  const b12Sampler = graphTargets?.projectorSampler ?? pipelineState.defaultSampler;
  const sky = graphTargets?.sky ?? pipelineState.skylightFallback;

  const captureViewBindingKey = () => {
    // The chain key is rebuilt into one retained array on every pass that
    // binds the View group; entries are built only on a cache miss.
    const keys = viewChainKeys;
    keys.length = 0;
    keys.push(
      internals.device,
      internals.deviceScope ?? internals.device,
      pipelineState.viewUniformBuffer,
    );
    const cluster = graphTargets?.cluster;
    if (cluster !== undefined) {
      keys.push(cluster.clusterUniformBuffer);
      if (cluster.kind === 'texture') keys.push(cluster.view);
      else
        keys.push(cluster.lightDataBuffer, cluster.clusterGridBuffer, cluster.lightIndexListBuffer);
    }
    const viewLayout = graphTargets?.viewBindGroupLayout ?? pipelineState.viewBindGroupLayout;
    keys.push(...(graphTargets?.viewLayoutIdentity ?? [viewLayout]));
    if (graphTargets?.hiZ !== undefined && graphTargets.ssrColor !== undefined)
      keys.push(graphTargets.hiZ, graphTargets.ssrColor);
    if (graphTargets?.sceneDepthTexture !== undefined) keys.push(graphTargets.sceneDepthTexture);
    else if (graphTargets?.sceneDepth !== undefined) keys.push(graphTargets.sceneDepth);
    pushAtmosphereBindingResources(keys, pipelineState, graphTargets?.atmosphere, viewLayout);
    if (sky != null) keys.push(sky.skySh, sky.intensityBuffer, sky.brdfLutView);
    if (graphTargets?.planarReflection !== undefined)
      keys.push(planarBindingKey, graphTargets.planarReflection);
    if (graphTargets?.transmissionBackdrop !== undefined)
      keys.push(transmissionBindingKey, graphTargets.transmissionBackdrop);
    const slots = viewLayoutSlots(viewLayout);
    if (graphTargets?.forwardScreenSurface !== undefined)
      keys.push(forwardSurfaceBindingKey, graphTargets.forwardScreenSurface);
    const pushTexture = (binding: number, texture: TextureView) => {
      if (slots === undefined || slots.has(binding)) keys.push(texture);
    };
    pushTexture(3, b3View);
    keys.push(shadowSampler);
    pushTexture(5, b5View);
    keys.push(pipelineState.shadowParamsBuffer);
    pushTexture(8, b8View);
    if (extendedLightingResources !== undefined) {
      keys.push(extendedLightingResources.sampler, extendedLightingResources.cookieMatrixBuffer);
      pushTexture(11, extendedLightingResources.iesProfileTextureView);
      pushTexture(12, extendedLightingResources.cookieTextureView);
      pushTexture(13, extendedLightingResources.ltcLambertTextureView);
      pushTexture(14, extendedLightingResources.ltcGgxTextureView);
    } else if (projectorAvailable) {
      pushTexture(11, b11View);
      keys.push(b12Sampler);
    }
    if (!lowLimitCloudBindings) pushTexture(16, cloudShadowView);
    keys.push(pipelineState.viewLinearSampler ?? pipelineState.defaultSampler);
    return { keys, viewLayout };
  };
  const { keys, viewLayout } = captureViewBindingKey();
  if (readOnly) return findFromChain(frameState.viewBindGroupCache, keys, 'view-main') ?? null;
  requireViewBindingCurrent(current);
  return getOrCreateFromChain(
    frameState.viewBindGroupCache,
    keys,
    'view-main',
    () => {
      const sceneDepth = resolveSceneDepthView(internals.device, graphTargets);
      const entries: BindGroupEntry[] = [
        ...atmosphereBindings(pipelineState, graphTargets?.atmosphere, viewLayout),
        ...(sceneDepth === undefined
          ? []
          : [
              {
                binding: 1,
                resource: { kind: 'textureView' as const, value: sceneDepth },
              },
            ]),
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: pipelineState.viewUniformBuffer, size: VIEW_UNIFORM_BYTES },
          },
        },
        {
          binding: 3,
          resource: {
            kind: 'textureView',
            value: b3View,
          },
        },
        {
          binding: 4,
          resource: {
            kind: 'sampler',
            value: shadowSampler,
          },
        },
        ...(internals.device.caps.storageBuffer
          ? [
              {
                binding: 5,
                resource: { kind: 'textureView' as const, value: b5View },
              },
              {
                binding: 6,
                resource: {
                  kind: 'buffer' as const,
                  value: { buffer: pipelineState.shadowParamsBuffer },
                },
              },
            ]
          : []),
        // feat-20260613-csm-cascaded-shadow-maps M5 / w28 (rebased to
        // binding 7 on 2026-06-13 to make room for point-shadow 5/6):
        // forward shaders declare binding 7 in common.wgsl (shared
        // view BGL) but never reference it; only shadow_caster.wgsl
        // reads it. Host writes a stable singleton buffer so every
        // forward bind group entry stays populated.
        {
          binding: 7,
          resource: {
            kind: 'buffer',
            value: { buffer: pipelineState.shadowCasterCascadeBuffer },
          },
        },
        // feat-20260625-spot-light-shadow-mapping M3 / w21 (D-5):
        // spot shadow 2D atlas (real spotShadowDepth view when spot
        // shadows run this frame, else the 1x1 depth fallback). Always-on.
        {
          binding: 8,
          resource: {
            kind: 'textureView',
            value: b8View,
          },
        },
        ...(extendedLightingResources === undefined && projectorAvailable
          ? [
              {
                binding: 11,
                resource: {
                  kind: 'textureView' as const,
                  value: b11View,
                },
              },
              {
                binding: 12,
                resource: {
                  kind: 'sampler' as const,
                  value: b12Sampler,
                },
              },
            ]
          : []),
        ...(extendedLightingResources !== undefined
          ? [
              {
                binding: FORWARD_HIZ_VIEW_SLOT,
                resource: {
                  kind: 'textureView' as const,
                  value: graphTargets?.hiZ ?? pipelineState.defaultWhiteTextureView,
                },
              },
              {
                binding: FORWARD_SSR_COLOR_VIEW_SLOT,
                resource: {
                  kind: 'textureView' as const,
                  value: graphTargets?.ssrColor ?? pipelineState.defaultWhiteTextureView,
                },
              },
              {
                binding: 9,
                resource: {
                  kind: 'sampler' as const,
                  value: extendedLightingResources.sampler,
                },
              },
              {
                binding: 11,
                resource: {
                  kind: 'textureView' as const,
                  value: extendedLightingResources.iesProfileTextureView,
                },
              },
              {
                binding: 12,
                resource: {
                  kind: 'textureView' as const,
                  value: extendedLightingResources.cookieTextureView,
                },
              },
              {
                binding: 13,
                resource: {
                  kind: 'textureView' as const,
                  value: extendedLightingResources.ltcLambertTextureView,
                },
              },
              {
                binding: 14,
                resource: {
                  kind: 'textureView' as const,
                  value: extendedLightingResources.ltcGgxTextureView,
                },
              },
              {
                binding: 15,
                resource: {
                  kind: 'buffer' as const,
                  value: {
                    buffer: extendedLightingResources.cookieMatrixBuffer,
                    size: COOKIE_MATRIX_BYTES,
                  },
                },
              },
            ]
          : []),
        ...(lowLimitCloudBindings
          ? []
          : [
              {
                binding: 16,
                resource: {
                  kind: 'textureView' as const,
                  value: cloudShadowView,
                },
              },
            ]),
        {
          binding: 17,
          resource: {
            kind: 'sampler' as const,
            value: pipelineState.viewLinearSampler ?? pipelineState.defaultSampler,
          },
        },
        // feat-20260625-spot-light-shadow-mapping w25: the per-spot
        // fragment-read lightViewProj matrices fold into the View UBO
        // (binding 0, `view.spotLightViewProj`) — no standalone binding 9
        // (WebGL2 fragment uniform-buffer budget). binding 10 is the
        // dedicated vertex-only Points/Lines viewport UBO.
      ];
      const retainedEntries: BindGroupEntry[] = [
        ...entries,
        ...(sky == null ? [] : skyViewBindings(sky)),
        {
          binding: TRANSMISSION_BACKDROP_VIEW_SLOT,
          resource: {
            kind: 'textureView',
            value: graphTargets?.transmissionBackdrop ?? pipelineState.defaultWhiteTextureView,
          },
        },
        ...planarReflectionViewEntries(
          pipelineState.viewUniformBuffer,
          graphTargets?.planarReflection,
          pipelineState.defaultWhiteTextureView,
        ),
        ...(graphTargets?.cluster === undefined ? [] : clusterViewBindings(graphTargets.cluster)),
        {
          binding: FORWARD_SCREEN_SURFACE_VIEW_SLOT,
          resource: {
            kind: 'textureView',
            value: graphTargets?.forwardScreenSurface ?? pipelineState.defaultWhiteTextureView,
          },
        },
      ];
      const loadDirectDfg = directDfgViewReader(internals.device, internals.deviceScope);
      const slots = viewLayoutSlots(viewLayout);
      if (slots?.has(DIRECT_DFG_VIEW_SLOT))
        retainedEntries.push(directDfgViewBinding(loadDirectDfg()));
      const viewBindGroupResult = internals.device.createBindGroup({
        label: 'pbr-view-bg',
        layout: viewLayout,
        entries:
          slots === undefined
            ? entries
            : retainedEntries.filter(({ binding }) => slots.has(binding)),
      });
      if (!viewBindGroupResult.ok) throw viewBindGroupResult.error;
      requireViewBindingCurrent(current);
      retainViewGroup(
        viewBindGroupResult.value,
        viewLayout,
        retainedEntries,
        sky ?? undefined,
        loadDirectDfg,
      );
      return viewBindGroupResult.value;
    },
    bindGroupCounts,
  );
}

/**
 * feat-20260704 M3/w18: per-frame bind-group cache resolution, extracted
 * verbatim from `recordFrame`. Walks the handle-identity WeakMap caches
 * (feat-20260531 M2 + feat-20260622 M3) to resolve or lazily create the view
 * (@group 0) and mesh (@group 2) bind groups. Raster groups may be null with no validated meshes; the Cluster
 * producer follows the accepted lighting topology independently. `bindGroupCounts` accounting +
 * cache maps are threaded through explicitly.
 *
 * @internal
 */
export function buildPerFrameBindGroups(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  hasValidated: boolean,
  bindGroupCounts: BindGroupCounts,
  graphTargets?: ViewBindGroupTargets & {
    readonly viewBindGroupLayout?: BindGroupLayout;
    readonly sceneDepth?: TextureView;
  },
  includeView = true,
  standardLighting?: StandardTopologyInputValue,
  current?: () => boolean,
): {
  viewBindGroup: BindGroup | null;
  meshBindGroup: BindGroup | null;
  clusterViewReady: boolean;
  hdrpClusterMembershipBindGroup: BindGroup | null;
} {
  requireViewBindingCurrent(current);
  // View main (#1) chain = b0(viewUniformBuffer), b3(graph shadowDepth view or
  // shadowArrayFallbackTextureView), b4(shadowSampler), b5(atlas view), b6
  // (shadowParams); variant 'view-main'. Cluster entries are projected with the View.
  // Mesh (#2) chain = inner b0 buffer (meshStorageBuffer.buffer); variant 'mesh'.
  let viewBindGroup: BindGroup | null = null;
  let meshBindGroup: BindGroup | null = null;
  // The prepared Standard topology supplies the Cluster View resources.
  // A missing declaration is the prewarm /
  // non-Standard path and must not allocate or bind the Cluster bundle based
  // on the install-time pipeline identity alone.
  const clusteredLighting = standardLighting?.kind === 'clustered';
  const membershipLayout = pipelineState.hdrpClusterMembershipBindGroupLayout;
  const membership = frameState.hdrpClusterMembership;
  // The graph's Cluster producer also serves RenderFeature consumers and
  // warmup frames with no ordinary meshes. Its lifetime follows the accepted
  // lighting topology, not the ordinary raster validation count.
  const expectedHdrpBuffers = clusteredLighting
    ? getOrCreateHdrpBuffers(
        internals,
        frameState.installedPipelineConfig?.clusterGrid,
        frameState.standardClusterTextureExtent,
      )
    : null;
  const currentMembership =
    expectedHdrpBuffers !== null &&
    expectedHdrpBuffers.kind === 'storage' &&
    membership?.clusterGridBuffer === expectedHdrpBuffers.clusterGridBuffer
      ? projectDeviceOwnedBindGroup(membership, internals.device, membershipLayout)
      : null;
  // Selection may run before lighting preparation. Only the writer retires a
  // membership binding when its device, layout or buffers actually change.
  const hdrpClusterMembershipBindGroup: BindGroup | null = clusteredLighting
    ? currentMembership
    : null;
  if (hasValidated) {
    // Shadow atlas view comes from the typed graph target.
    // Graph owns the texture lifecycle; record-stage reads the resolved
    // view each frame (D-2 SSOT). When the graph has not allocated the
    // target (castShadow:false or shadowMapSize=0),
    // `getColorTargetView` returns undefined and we fall through to the
    // 1x1 fallback view that keeps the BGL satisfied.
    if (includeView) {
      viewBindGroup = buildViewBindGroup(
        internals,
        frameState,
        pipelineState,
        bindGroupCounts,
        { ...graphTargets, cluster: expectedHdrpBuffers ?? undefined },
        false,
        current,
      );
      if (viewBindGroup === null) {
        return {
          viewBindGroup: null,
          meshBindGroup: null,
          clusterViewReady: false,
          hdrpClusterMembershipBindGroup,
        };
      }
    }

    // M3 / w10 (D-3 hard constraint): use the inner `.buffer` as the
    // WeakMap chain key so the cache tracks the underlying GPU buffer
    // identity. The wrapper object's identity is stable across grow
    // events; using the wrapper would defeat AC-07 cache invalidation.
    meshBindGroup = meshSlotBindGroup(
      internals.device,
      frameState,
      pipelineState,
      bindGroupCounts,
      0,
      current,
    );
  }
  requireViewBindingCurrent(current);
  return {
    viewBindGroup,
    meshBindGroup,
    clusterViewReady: expectedHdrpBuffers !== null,
    hdrpClusterMembershipBindGroup,
  };
}

/** Capture exact original global mesh/Cluster cache leaves; later reads cannot create. */
export function captureGlobalMeshBindingsCurrent(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipeline: PipelineState,
  groups: ReturnType<typeof buildPerFrameBindGroups>,
  hdrp: HdrpBuffers | null,
): () => boolean {
  const buffer = meshSsboBuffer(pipeline.meshStorageBuffer, 0);
  const layout = pipeline.meshBindGroupLayout;
  const cache = frameState.meshBindGroupCache;
  const meshKeys = [layout, buffer];
  const member = frameState.hdrpClusterMembership;
  const membershipLayout = pipeline.hdrpClusterMembershipBindGroupLayout;
  return () =>
    frameState.meshBindGroupCache === cache &&
    meshSsboBuffer(pipeline.meshStorageBuffer, 0) === buffer &&
    pipeline.meshBindGroupLayout === layout &&
    findFromChain(cache, meshKeys, 'mesh') === groups.meshBindGroup &&
    frameState.hdrpClusterMembership === member &&
    pipeline.hdrpClusterMembershipBindGroupLayout === membershipLayout &&
    (hdrp === null || hdrpBuffersCurrent(internals, hdrp));
}

/**
 * The Standard topology a frame takes: storage-capable devices always keep the
 * Cluster ABI, others only when local lights exist. The one authority shared by
 * frame lighting and the Points/Lines lane.
 */
export function standardTopologyKind(
  storageBuffer: boolean,
  localLightCount: number,
): StandardTopologyInputValue['kind'] {
  return !storageBuffer && localLightCount === 0 ? 'no-local-lights' : 'clustered';
}

/**
 * feat-20260704 M3/w18: per-frame lighting preparation, extracted verbatim from
 * `recordFrame`. (1) pin the point + spot shadow snapshot lists onto frameState
 * for the shadow caster
 * pass closures + lazy-allocate the point-shadow cube_array atlas on first
 * non-empty frame (AC-09 zero-shadow zero-alloc). (3) derive the directional
 * fallback and the unified local-light corpus used by Standard Cluster.
 *
 * @internal
 */
export function prepareFrameLighting(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  lights: ViewLights,
  camera: CameraSnapshot | undefined,
  pipelineState?: Pick<
    PipelineState,
    | 'hdrpClusterMembershipPipeline'
    | 'hdrpClusterMembershipBindGroupLayout'
    | 'standardClusterAbi'
    | 'pbrPipelineLayout'
  >,
  renderables?: FrameList<RenderableSnapshot>,
  receiverDomain = renderables,
): Result<
  {
    light: DirectionalLightSnapshot;
    pointLights: ViewLights['point'];
    spotLights: ViewLights['spot'];
    rectLights: ViewLights['rect'];
    totalLightCount: number;
    standard: StandardTopologyInputValue;
  },
  RenderError
> {
  prepareFrameShadowSnapshots(internals, frameState, lights);

  const profile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const directional = lights.directional;
  const directionalLight =
    profile?.contactShadows === false && directional && directional.contactShadowLength > 0
      ? { ...directional, contactShadowLength: 0 }
      : directional;
  const pointLights = lights.point;
  const spotLights = lights.spot;
  const rectLights = lights.rect;
  const light: DirectionalLightSnapshot = directionalLight ?? {
    kind: 'directional' as const,
    direction: vec3.create(0, -1, 0),
    color: vec3.create(0, 0, 0),
    intensity: 0,
    contactShadowLength: 0,
    sourceAngle: 0,
  };
  const totalLightCount =
    (directionalLight !== undefined ? 1 : 0) +
    (lights.additionalDirectional?.length ?? 0) +
    pointLights.length +
    spotLights.length +
    rectLights.length;
  const standard = prepareStandardLightingTopology(
    internals,
    frameState,
    lights,
    camera,
    directionalLight,
    pipelineState,
    renderables,
    receiverDomain,
  );
  if (!standard.ok) return standard;
  return ok({
    light,
    pointLights,
    spotLights,
    rectLights,
    totalLightCount,
    standard: standard.value,
  });
}

function prepareFrameShadowSnapshots(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  lights: ViewLights,
): void {
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t2:
  // the AC-04/AC-22 "shadow disabled by missing component" once-warn is gone.
  // After merging DirectionalLightShadow into DirectionalLight there is no
  // orphan-shadow / missing-companion configuration to warn about -- castShadow
  // defaults true on the single component, so the warn condition can never
  // arise. The error class + RuntimeErrorCode member have been removed in M4 (m4-t2).
  // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
  // project lights.pointShadow onto frameState so the URP point shadow caster
  // pass can read the snapshot list during graph execute. Lazy-allocate the
  // cube_array atlas on first non-empty frame; zero-shadow scenes never
  // touch the GPU here (AC-09). The snapshot list is stable for the
  // duration of recordFrame; its count is part of the typed topology key.
  frameState.pointShadowSnapshots = lights.pointShadow;
  // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): pin the spot
  // snapshots for the spotShadowDepth caster pass closure. The spot atlas is
  // a graph-owned typed target, not a runtime ShadowAtlas, so graph compilation
  // owns the depth texture lifetime.
  frameState.spotShadowSnapshots = lights.spot;
  frameState.darkShadowViews = darkShadowViews(lights, frameState.darkShadowViews);
  if (lights.pointShadow.length > 0) {
    if (frameState.pointShadowAtlas === null) {
      const firstSnap = lights.pointShadow[0];
      const faceSize = firstSnap?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE;
      frameState.pointShadowAtlas = new ShadowAtlas(internals.device, {
        faceSize,
        layers: SHADOW_ATLAS_DEFAULT_LAYERS,
      });
    }
    try {
      frameState.pointShadowAtlas.ensure();
    } catch (e) {
      if (
        e instanceof PointShadowAtlasUninitializedError ||
        e instanceof PointShadowAtlasBoundsViolationError
      ) {
        internals.errorRegistry.fire(e);
      } else {
        throw e;
      }
    }
  }
}

const EMPTY_LOCAL_LIGHT_WORK = projectLightSlotWork(Object.freeze([]));
const NO_DARK_VIEWS: ReadonlySet<number> = new Set();

/** Shadow views of dark lights; the previous sets are kept while unchanged. */
function darkShadowViews(
  lights: ViewLights,
  previous: RenderFrameState['darkShadowViews'],
): NonNullable<RenderFrameState['darkShadowViews']> {
  let point: Set<number> | undefined;
  for (const light of lights.point) {
    const layer = light.shadowAtlasLayer;
    if (layer === undefined || layer < 0 || !standardLocalLightEmitsNothing('point', light))
      continue;
    point ??= new Set();
    point.add(layer);
  }
  let spot: Set<number> | undefined;
  for (const light of lights.spot) {
    if (!light.castShadow || light.shadowAtlasTile < 0) continue;
    if (!standardLocalLightEmitsNothing('spot', light)) continue;
    spot ??= new Set();
    spot.add(light.shadowAtlasTile);
  }
  if (previous === undefined) return { point: point ?? NO_DARK_VIEWS, spot: spot ?? NO_DARK_VIEWS };
  const samePoint = sameMembers(previous.point, point);
  const sameSpot = sameMembers(previous.spot, spot);
  if (samePoint && sameSpot) return previous;
  return {
    point: samePoint ? previous.point : (point ?? NO_DARK_VIEWS),
    spot: sameSpot ? previous.spot : (spot ?? NO_DARK_VIEWS),
  };
}

function sameMembers(a: ReadonlySet<number>, b: ReadonlySet<number> | undefined): boolean {
  if (b === undefined) return a.size === 0;
  if (a.size !== b.size) return false;
  for (const value of b) if (!a.has(value)) return false;
  return true;
}

function standardScreenTransportDemand(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot | undefined,
  directionalLight: DirectionalLightSnapshot | undefined,
  renderables?: FrameList<RenderableSnapshot>,
): boolean {
  const environment = frameState.environmentFrame?.source;
  if (
    !internals.device.caps.storageBuffer &&
    environment?.kind === 'atmosphere' &&
    !environment.atmosphere.backgroundOnly
  )
    return true;
  if ((frameState.cameraStandardProfile ?? internals.standardProfile)?.renderPath === 'deferred')
    return false;
  return (
    (directionalLight?.contactShadowLength ?? 0) > 0 ||
    (camera?.projectedDecals?.length ?? 0) > 0 ||
    hasCapsuleShadowDemand(renderables)
  );
}

/**
 * The Cluster's local lights for one view. Over the limit the Cluster keeps
 * the first lights in canonical order, drops the rest and warns once; within
 * it the roster passes through untouched. A camera-less view has none.
 */
function admitStandardLocalLights(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  lights: ViewLights,
  camera: CameraSnapshot | undefined,
  slotCapacity: number | undefined,
): {
  readonly work: ReturnType<typeof projectLightSlotWork>;
  readonly droppedLocalLights: number;
} {
  if (camera === undefined) return { work: EMPTY_LOCAL_LIGHT_WORK, droppedLocalLights: 0 };
  const admitted = clusterLocalLights(internals, lights, slotCapacity);
  warnStandardLocalLightCap(
    frameState,
    admitted,
    clusterLocalLightLimit(internals, lights, slotCapacity),
  );
  const published = lights.localLightPublication;
  if (
    admitted.dropped === 0 &&
    published !== undefined &&
    sameLocalLightSources(published.sources, lights)
  ) {
    const local = ablateLocalLights(published.work.local);
    return {
      work: local === published.work.local ? published.work : projectLightSlotWork(local),
      droppedLocalLights: 0,
    };
  }
  const kept =
    admitted.dropped === 0
      ? lights
      : { ...admitted.kept, additionalDirectional: lights.additionalDirectional ?? [] };
  return {
    work: projectLightSlotWork(ablateLocalLights(createStandardLocalLights(kept))),
    droppedLocalLights: admitted.dropped,
  };
}

function prepareStandardLightingTopology(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  lights: ViewLights,
  camera: CameraSnapshot | undefined,
  directionalLight: DirectionalLightSnapshot | undefined,
  pipelineState:
    | Pick<
        PipelineState,
        | 'hdrpClusterMembershipPipeline'
        | 'hdrpClusterMembershipBindGroupLayout'
        | 'standardClusterAbi'
        | 'pbrPipelineLayout'
      >
    | undefined,
  renderables?: FrameList<RenderableSnapshot>,
  receiverDomain = renderables,
): Result<StandardTopologyInputValue, RenderError> {
  const clusterGrid = frameState.installedPipelineConfig?.clusterGrid ?? DEFAULT_CLUSTER_GRID;
  const reflectedAbi = pipelineState?.standardClusterAbi ?? internals.standardClusterAbi;
  const lightCount = internals.standardProfile?.lightCount ?? DEFAULT_STANDARD_PROFILE.lightCount;
  const { work, droppedLocalLights } = admitStandardLocalLights(
    internals,
    frameState,
    lights,
    camera,
    reflectedAbi?.directLightSlot.capacity,
  );
  const local = work.local;
  const needsScreenTransport = standardScreenTransportDemand(
    internals,
    frameState,
    camera,
    directionalLight,
    renderables,
  );
  const requiresCluster =
    standardLightingPipelineDemand(
      camera !== undefined,
      lights,
      needsScreenTransport,
      internals.device,
      pipelineState?.pbrPipelineLayout,
      reflectedAbi !== undefined,
    ).lightingKind === 'clustered';
  if (requiresCluster && reflectedAbi === undefined) {
    return err(
      new StandardClusterTransportUnavailableError(
        local.length,
        'the published Standard PBR variant is missing compatible Cluster reflection',
      ),
    );
  }
  const viewCamera = camera ?? makeZeroCameraFallbackSnapshot();
  const profile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const renderPath = profile?.renderPath ?? DEFAULT_STANDARD_PROFILE.renderPath;
  const deferredChannelProjection =
    camera !== undefined &&
    receiverDomain !== undefined &&
    renderPath === 'deferred' &&
    profile?.gbufferFormat !== 'default' &&
    profile?.deferredDirectionalShadowReceiver === 'projected'
      ? prepareDeferredLightingChannels(receiverDomain, local, directionalLight)
      : 0;
  const prepared = prepareStandardLighting(
    {
      directional: directionalLight,
      local,
      view: computeViewMatrix(viewCamera, mat4.create()),
      projection: computeProjectionMatrix(viewCamera, mat4.create()),
      near: viewCamera.near,
      far: viewCamera.far,
      grid: clusterGrid,
      lightCount,
      ...(droppedLocalLights === 0 ? {} : { droppedLocalLights }),
      renderPath,
      ...(deferredChannelProjection === 0 ? {} : { deferredChannelProjection }),
    },
    reflectedAbi?.directLightSlot.capacity,
    frameState.hdrpClusterBinScratch,
    stockClusterMembership(frameState, clusterGrid),
    work,
  );
  if (!prepared.ok) return prepared;
  if (camera !== undefined)
    warnStandardClusterEntryCap(
      frameState,
      prepared.value,
      prepared.value.layout.lightIndexListCapacity,
    );
  // Keep the published lighting layout resident when it can use the Cluster
  // transport. Screen AO has its own sampled binding on both backends.
  if (!requiresCluster) {
    return ok({ kind: 'no-local-lights', prepared: prepared.value });
  }
  const transport = selectStandardClusterTransport(
    {
      compute: internals.device.caps.compute,
      storageBuffer: internals.device.caps.storageBuffer,
      maxTextureDimension2D: internals.device.limits.maxTextureDimension2D,
      membershipPipelineReady:
        pipelineState !== undefined &&
        pipelineState.hdrpClusterMembershipPipeline !== null &&
        pipelineState.hdrpClusterMembershipBindGroupLayout !== null,
    },
    prepared.value,
    reflectedAbi,
  );
  if (!transport.ok) return transport;

  return ok({ kind: 'clustered', prepared: prepared.value, transport: transport.value });
}

const MODIFIER_DIGESTS = new WeakMap<Uint8Array, number>();

// Prepared light-texture chains are cached per immutable asset, so memoizing
// by payload identity keeps the steady-state frame from rehashing ~350 KiB
// per textured light while a changed payload still re-uploads.
function modifierDigest(data: Uint8Array): number {
  const cached = MODIFIER_DIGESTS.get(data);
  if (cached !== undefined) return cached;
  const hash = fnv1a32(data);
  const digest = hash >>> 0;
  MODIFIER_DIGESTS.set(data, digest);
  return digest;
}

/** Compare the submitted float values, including the sign of zero. NaNs are rewritten. */
function sameModifierMatrix(written: Float32Array | undefined, matrix: Float32Array): boolean {
  if (written?.length !== matrix.length) return false;
  for (let i = 0; i < matrix.length; i++) {
    const value = matrix[i];
    if (value !== written[i] || (value === 0 && !Object.is(value, written[i]))) return false;
  }
  return true;
}

const WHITE_LIGHT_TEXTURE_CHAIN = new Uint8Array(COOKIE_SLICE_MIP_CHAIN_BYTES).fill(255);

/**
 * Upload authored light modifier payloads into the renderer-owned array
 * lanes: shared Point/Spot/Rect IES profiles, and the shared light-texture array fed by Spot
 * Cookies, Spot projectors, and RectAreaLight source textures. CPU-prepared
 * mip chains are written directly; block-compressed sources are resampled on
 * the GPU once per payload. A failed resample reports its error once and
 * leaves the slice white, so the light renders untextured.
 */
export function writeLightModifierTextures(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
  lights: Pick<ViewLights, 'point' | 'spot' | 'rect'>,
  frameState?: RenderFrameState,
): void {
  const iesTexture = pipelineState.iesProfileTexture;
  const cookieTexture = pipelineState.cookieTexture;
  const cookieMatrixBuffer = pipelineState.cookieMatrixBuffer;
  if (iesTexture === undefined && cookieTexture === undefined && cookieMatrixBuffer === undefined)
    return;
  let state = pipelineState.spotModifierUploadState;
  if (state === undefined) {
    state = { ies: new Map(), cookie: new Map(), cookieMatrix: new Map() };
    pipelineState.spotModifierUploadState = state;
  } else if (state.cookieMatrix === undefined) {
    state = { ...state, cookieMatrix: new Map() };
    pipelineState.spotModifierUploadState = state;
  }
  const uploadState = state;
  const writeChain = (slice: number, chain: Uint8Array): void => {
    if (cookieTexture === undefined) return;
    const result = writeCookieSliceMipChain(internals.device, cookieTexture, slice, chain);
    if (!result.ok) throw result.error;
  };
  const uploadLightTexture = (
    slice: number | undefined,
    source: LightTextureSource | undefined,
    matrix?: Float32Array,
  ): void => {
    if (slice !== undefined && source !== undefined && cookieTexture) {
      const payload = source.kind === 'mip-chain' ? source.data : source.asset.data;
      const digest = modifierDigest(payload);
      const alreadyQueued =
        frameState?.pendingLightTextureResamples?.some((pending) => pending.slice === slice) ===
        true;
      if (uploadState.cookie.get(slice) !== digest && !alreadyQueued) {
        if (source.kind === 'mip-chain') {
          if (source.data.byteLength === COOKIE_SLICE_MIP_CHAIN_BYTES) {
            writeChain(slice, source.data);
            uploadState.cookie.set(slice, digest);
          }
        } else {
          const resamplePrograms = {
            compute: publishedFeatureShaderEntry(
              internals,
              LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
            ),
            fragment: publishedFeatureShaderEntry(
              internals,
              LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
            ),
          };
          const resampled = prepareLightTextureSliceResample({
            device: internals.device,
            factory: internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory,
            programs: resamplePrograms,
            target: cookieTexture,
            slice: slice,
            asset: source.asset,
          });
          if (!resampled.ok) {
            internals.errorRegistry.fire(resampled.error);
            writeChain(slice, WHITE_LIGHT_TEXTURE_CHAIN);
            uploadState.cookie.set(slice, digest);
          } else if (frameState === undefined) {
            resampled.value.discard();
            internals.errorRegistry.fire(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'GPU resampling work is attached to a Renderer-owned frame graph',
                hint: 'queue the prepared result on the active RenderFrameState before recording',
              }),
            );
            writeChain(slice, WHITE_LIGHT_TEXTURE_CHAIN);
            uploadState.cookie.set(slice, digest);
          } else {
            const pending = frameState.pendingLightTextureResamples ?? [];
            pending.push({
              slice: slice,
              work: resampled.value,
              onSubmitted: () => uploadState.cookie.set(slice as number, digest),
            });
            frameState.pendingLightTextureResamples = pending;
          }
        }
      }
    }
    if (slice !== undefined && matrix !== undefined && cookieMatrixBuffer) {
      const written = uploadState.cookieMatrix.get(slice);
      if (!sameModifierMatrix(written, matrix)) {
        const result = internals.device.queue.writeBuffer(
          cookieMatrixBuffer,
          slice * 16 * Float32Array.BYTES_PER_ELEMENT,
          matrix,
        );
        if (!result.ok) throw result.error;
        if (written?.length === matrix.length) written.set(matrix);
        else uploadState.cookieMatrix.set(slice, matrix.slice());
      }
    }
  };
  let uploadedIesSlices: Set<number> | undefined;
  const uploadIes = (profile: IesProfileSnapshot): void => {
    if (
      profile.iesProfileSlice !== undefined &&
      profile.iesProfileData !== undefined &&
      iesTexture
    ) {
      uploadedIesSlices ??= new Set();
      if (uploadedIesSlices.has(profile.iesProfileSlice)) return;
      uploadedIesSlices.add(profile.iesProfileSlice);
      if (profile.iesProfileData.byteLength === IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2) {
        const digest = modifierDigest(profile.iesProfileData);
        if (uploadState.ies.get(profile.iesProfileSlice) !== digest) {
          const result = internals.device.queue.writeTexture(
            {
              texture: iesTexture,
              mipLevel: 0,
              origin: { x: 0, y: 0, z: profile.iesProfileSlice },
            },
            profile.iesProfileData,
            { offset: 0, bytesPerRow: IES_SLICE_WIDTH * 2, rowsPerImage: IES_SLICE_HEIGHT },
            { width: IES_SLICE_WIDTH, height: IES_SLICE_HEIGHT, depthOrArrayLayers: 1 },
          );
          if (!result.ok) throw result.error;
          uploadState.ies.set(profile.iesProfileSlice, digest);
        }
      }
    }
  };
  for (const point of lights.point) uploadIes(point);
  for (const spot of lights.spot) {
    uploadIes(spot);
    // Cookie and projector keep distinct shader projections (cookieMatrices
    // vs View.spotLightViewProj); only the texture transport is shared, and
    // the direct-light metadata selects the one in use.
    uploadLightTexture(spot.cookieSlice, spot.cookieSource, spot.cookieMatrix);
    uploadLightTexture(spot.projectorSlice, spot.projectorSource, spot.projectorMatrix);
  }
  for (const rect of lights.rect) {
    uploadIes(rect);
    uploadLightTexture(rect.cookieSlice, rect.cookieSource);
  }
}

/**
 * feat-20260704 M3/w18: write the point-shadow params UBO (bound at viewBg
 * binding 6), extracted verbatim from `recordFrame`.
 *
 * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 4 lanes x vec4<f32>;
 * lane[shadowAtlasLayer] = (near, far, depthBias, normalBias). Lanes for non-shadow
 * slots stay zero (the WGSL sample path is gated by PointLight.shadowAtlasLayer
 * >= 0). Always writes the complete Point/Spot block so stale non-zero lanes from a previous
 * frame's allocation cannot poison the current frame. The Render World light
 * roster keeps its arrays until a light changes, so a buffer already holding
 * this roster's block is not rewritten.
 *
 * @internal
 */
export function writeShadowParamsBuffer(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
): void {
  const written = frameState.shadowParamsSource;
  if (
    written !== undefined &&
    written.buffer === pipelineState.shadowParamsBuffer &&
    written.point === frameState.pointShadowSnapshots &&
    written.spot === frameState.spotShadowSnapshots
  )
    return;
  const SHADOW_PARAMS_LANE_COUNT = 4;
  const SHADOW_PARAMS_FLOATS_PER_LANE = 4;
  const shadowParamsArr = new Float32Array(SHADOW_PARAMS_BYTES / Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < frameState.pointShadowSnapshots.length; i++) {
    const ps = frameState.pointShadowSnapshots[i];
    if (ps === undefined) continue;
    const layer = ps.shadowAtlasLayer;
    if (layer < 0 || layer >= SHADOW_PARAMS_LANE_COUNT) continue;
    const base = layer * SHADOW_PARAMS_FLOATS_PER_LANE;
    const near = ps.nearPlane;
    const far = ps.farPlane;
    shadowParamsArr[base] = near;
    shadowParamsArr[base + 1] = far;
    shadowParamsArr[base + 2] = ps.depthBias;
    // normalBias is authored in cube texels; one texel of a 90-degree face
    // spans 2 / mapSize world units per unit of light distance.
    shadowParamsArr[base + 3] =
      ps.shadowBiasMode === 1 ? ps.normalBias : (ps.normalBias * 2) / Math.max(ps.mapSize, 1);
    shadowParamsArr.set(ps.position, 48 + base);
    shadowParamsArr[51 + base] = 0;
    shadowParamsArr.set(
      [
        ps.pcfKernelSize ?? 3,
        ps.shadowBiasMode ?? 0,
        ps.shadowIntensity ?? 1,
        ps.shadowFilter ?? 6,
      ],
      16 + base,
    );
  }
  for (const spot of frameState.spotShadowSnapshots) {
    const layer = spot.shadowAtlasTile;
    if (layer < 0 || layer >= 4) continue;
    shadowParamsArr.set(
      [
        spot.pcfKernelSize ?? 3,
        spot.shadowBiasMode ?? 0,
        spot.shadowFilter ?? 6,
        spot.shadowMapAspect ?? 1,
      ],
      32 + layer * 4,
    );
  }
  const shadowParamsWriteRes = internals.device.queue.writeBuffer(
    pipelineState.shadowParamsBuffer,
    0,
    shadowParamsArr,
  );
  if (!shadowParamsWriteRes.ok) {
    delete frameState.shadowParamsSource;
    internals.errorRegistry.fire(shadowParamsWriteRes.error);
    return;
  }
  frameState.shadowParamsSource = {
    buffer: pipelineState.shadowParamsBuffer,
    point: frameState.pointShadowSnapshots,
    spot: frameState.spotShadowSnapshots,
  };
}

/**
 * feat-20260704 M3/w18: zero-light standard-material once-warn, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10): fires once per
 * RendererState lifetime when the 0-light three-condition conjunction holds — no
 * Skylight, 0 direct light (totalLightCount === 0), AND at least one builtin
 * standard/PBR material (which renders black with no light). Custom shaders
 * own their lighting contract and cannot be classified by this generic
 * diagnostic.
 *
 * @internal
 */
export function warnZeroLightStandard(
  frameState: Pick<RenderFrameState, 'warnedZeroLightStandard'>,
  renderables: FrameList<RenderableSnapshot>,
  skylight: SkylightSnapshot | undefined,
  totalLightCount: number,
): void {
  if (skylight !== undefined || totalLightCount !== 0 || frameState.warnedZeroLightStandard) return;
  if (hasLitRasterDemand(renderables)) {
    frameState.warnedZeroLightStandard = true;
    console.warn(
      '[forgeax] standard material renders black with 0 lights of every type (no Skylight, and directional + point + spot all empty); spawn at least one light (Skylight, DirectionalLight, PointLight, or SpotLight) or switch material to an unlit shader (Materials.unlit(...)). See AGENTS.md section Breaking changes 2026-05-19.',
    );
  }
}

/** Read the admitted source domain; no observation of inactive retained rows. */
function hasLitRasterDemand(renderables: FrameList<RenderableSnapshot>): boolean {
  for (const row of rasterRowsOf(renderables))
    if (hasRasterDemand(row) && isLitMaterialSnapshot(row.material.snapshot)) return true;
  return false;
}

const LIGHT_TABLES = new WeakMap<object, LightTable>();

/** The light table of a storage bundle; a replaced bundle starts a fresh table. */
export function lightTableOf(
  internals: RenderSystemInternals,
  buffers: Extract<NonNullable<ReturnType<typeof getOrCreateHdrpBuffers>>, { kind: 'storage' }>,
  layout: ReflectedDirectLightSlotLayout,
): LightTable {
  let table = LIGHT_TABLES.get(buffers);
  if (table === undefined) {
    table = new LightTable(internals.device, buffers.lightDataBuffer, layout);
    LIGHT_TABLES.set(buffers, table);
  }
  return table;
}

function captureClusterTableWork(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  input: {
    readonly clusterTransportGeneration: number;
    readonly clusterUsedRows?: number;
    readonly clusterRowBytes?: number;
    readonly transport: 'storage-buffer' | 'cpu-texture';
    readonly scope: 'light-data-buffer' | 'cluster-texture-host-regions';
    readonly packedLightSlots: number;
    readonly acceptedWriteBytes: number;
    readonly writeSucceeded: boolean;
    readonly errorCode?: string;
  },
): void {
  const capture = frameState.standardClusterWorkConformance;
  const installed = frameState.compiledFrameGraph;
  if (capture === undefined || !capture.enabled || installed == null) return;
  captureClusterWorkSample(capture, {
    frameNumber: frameState.frameNumber,
    viewEntityKey: camera.entityKey ?? 0,
    deviceGeneration: internals.deviceScope?.generation ?? 0,
    graphGeneration: installed.targets.graphGeneration,
    ...input,
  });
}

interface ClusterWriteResources {
  readonly hdrpBuffers: HdrpBuffers;
  readonly reflectedAbi: StandardClusterReflectedAbi;
  readonly gpuMembership: boolean;
}

function resolveClusterWriteResources(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  prepared: PreparedStandardLighting,
  transport: StandardClusterTransport,
  gpuMembershipPipelineReady: boolean,
  membershipBindGroupLayout: BindGroupLayout | null,
  pipelineState: PipelineState | undefined,
): Result<ClusterWriteResources, RenderError> {
  const reflectedAbi = pipelineState?.standardClusterAbi ?? internals.standardClusterAbi;
  if (reflectedAbi === undefined) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the published Standard PBR variant is missing compatible Cluster reflection',
      ),
    );
  }
  const gpuMembership = transport.producer === 'gpu';
  if (gpuMembership && (!gpuMembershipPipelineReady || membershipBindGroupLayout === null)) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the selected GPU Cluster producer requires a ready membership pipeline and bind-group layout',
      ),
    );
  }
  const hdrpBuffers = getOrCreateHdrpBuffers(
    internals,
    prepared.layout.grid,
    frameState.standardClusterTextureExtent,
  );
  if (hdrpBuffers === null) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the selected Standard Cluster transport could not allocate its persistent buffers',
      ),
    );
  }
  const existingMembership = projectDeviceOwnedBindGroup(
    frameState.hdrpClusterMembership,
    internals.device,
    membershipBindGroupLayout,
  );
  const membershipMatchesBuffers =
    existingMembership !== null &&
    hdrpBuffers.kind === 'storage' &&
    frameState.hdrpClusterMembership?.clusterGridBuffer === hdrpBuffers.clusterGridBuffer;
  if (!membershipMatchesBuffers) frameState.hdrpClusterMembership = null;
  if (
    gpuMembership &&
    hdrpBuffers.kind === 'storage' &&
    membershipBindGroupLayout !== null &&
    frameState.hdrpClusterMembership === null
  ) {
    const bindGroup = createHdrpClusterMembershipBindGroup(
      internals,
      hdrpBuffers,
      membershipBindGroupLayout,
    );
    if (bindGroup === null) {
      return err(
        new StandardClusterTransportUnavailableError(
          prepared.local.length,
          'the selected GPU Cluster producer could not create its membership bind group',
        ),
      );
    }
    frameState.hdrpClusterMembership = {
      device: internals.device,
      layout: membershipBindGroupLayout,
      bindGroup,
      clusterGridBuffer: hdrpBuffers.clusterGridBuffer,
    };
  }
  return ok({ hdrpBuffers, reflectedAbi, gpuMembership });
}

function buildClusterUniformPayload(
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  prepared: PreparedStandardLighting,
  hdrpBuffers: HdrpBuffers,
  reflectedAbi: StandardClusterReflectedAbi,
): Uint8Array {
  const clusterSsaoConfig = frameState.installedPipelineConfig?.ambientOcclusion;
  const clusterSsaoIntensity = ssaoUsesLighting(clusterSsaoConfig)
    ? (clusterSsaoConfig?.intensity ?? 1.0)
    : 0;
  return new Uint8Array(
    packClusterUniform({
      grid: prepared.layout.grid,
      near: camera.near,
      far: camera.far,
      ssaoIntensity: clusterSsaoIntensity,
      lightCount: prepared.membershipLightCount,
      directionalLightCount: prepared.local.length - prepared.membershipLightCount,
      ...(frameState.standardClusterTextureExtent?.screen === undefined
        ? {}
        : { screen: frameState.standardClusterTextureExtent.screen }),
      reflectedAbi,
      ...(hdrpBuffers.kind === 'texture'
        ? {
            textureAddressing: {
              width: hdrpBuffers.layout.width,
              gridOffset: hdrpBuffers.layout.gridOffset,
              indexOffset: hdrpBuffers.layout.indexOffset,
            },
          }
        : {}),
      clusterGridStrideU32: prepared.layout.clusterGridStrideU32,
      clusterGridCountWordOffsetU32: prepared.layout.clusterGridCountWordOffsetU32,
    }),
  );
}

function projectedShadowChannels(
  frameState: RenderFrameState,
  prepared: PreparedStandardLighting,
): Uint8Array | undefined {
  const receiver = currentForwardShadowReceiver(frameState);
  if (receiver?.mode !== 'screen' || receiver.punctual === undefined) return;
  const plan = forwardPunctualShadowPlan(prepared, receiver.directional !== false, receiver);
  return plan.kind === 'projected' ? plan.channels : undefined;
}

/**
 * Write the one prepared Standard Cluster payload into the persistent buffers.
 * Membership has already been derived by `prepareFrameLighting`; this function
 * only packs/uploads that immutable result and never re-runs the binner.
 *
 * @internal
 */
export function writeHdrpClusterAndSsaoBuffers(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  prepared: PreparedStandardLighting,
  transport: StandardClusterTransport,
  profilePhase?: RecordProfileRunner,
  gpuMembershipPipelineReady = false,
  membershipBindGroupLayout: BindGroupLayout | null = null,
  projectorLightSlotIndex?: number,
  pipelineState?: PipelineState,
): Result<void, RenderError> {
  const resources = resolveClusterWriteResources(
    internals,
    frameState,
    prepared,
    transport,
    gpuMembershipPipelineReady,
    membershipBindGroupLayout,
    pipelineState,
  );
  if (!resources.ok) return resources;
  const { hdrpBuffers, reflectedAbi, gpuMembership } = resources.value;

  const work = lightSlotWorkOf(prepared);
  if (pipelineState !== undefined && (work.point.length || work.spot.length || work.rect.length))
    writeLightModifierTextures(internals, pipelineState, work, frameState);

  const channelMapping = (prepared.deferredChannelProjection ?? 0) & DEFERRED_CHANNEL_MAPPING_MASK;

  if (!work.complete) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the prepared Standard Cluster payload could not be materialized',
      ),
    );
  }

  // scope-amend-webgl2-ubo: SSAO intensity is folded into the cluster_uniform
  // .w lane (formerly pad), removing the dedicated @binding(9) UBO that pushed
  // fragment-stage UBO count past WebGL2's max_uniform_buffers_per_shader_stage=11.
  // Disabled-SSAO path writes 0, which lighting reads as "no screen AO" (no PSO
  // recompile across enable/disable).
  const clusterUniformPayload = buildClusterUniformPayload(
    frameState,
    camera,
    prepared,
    hdrpBuffers,
    reflectedAbi,
  );

  const bufferUpload = runHdrpClusterProfilePhase(
    profilePhase,
    'record/scene-state/hdrp-cluster/buffer-upload',
    (): Result<void, RenderError> => {
      if (hdrpBuffers.kind === 'texture') {
        const membership = hdrpBuffers.table.prepareMembership(prepared);
        const upload = hdrpBuffers.table.write({
          device: internals.device,
          texture: hdrpBuffers.texture,
          layout: hdrpBuffers.layout,
          local: prepared.local,
          projectorSlot: projectorLightSlotIndex,
          channelMapping,
          clusterGrid: membership.grid,
          lightIndices: membership.indices,
          lightIndexCount: membership.indices.length,
        });
        if (frameState.standardClusterWorkConformance?.enabled) {
          const tableInspection = hdrpBuffers.table.inspect();
          captureClusterTableWork(internals, frameState, camera, {
            clusterTransportGeneration: hdrpBuffers.clusterTransportGeneration,
            clusterUsedRows: tableInspection.usedRows,
            clusterRowBytes: tableInspection.rowBytes,
            transport: 'cpu-texture',
            scope: 'cluster-texture-host-regions',
            packedLightSlots: tableInspection.packedLightSlots,
            acceptedWriteBytes: tableInspection.uploadedBytes,
            writeSucceeded: upload.ok,
            ...(!upload.ok ? { errorCode: upload.error.code } : {}),
          });
        }
        if (!upload.ok) return err(mapClusterUploadFailure('integer-texture', upload.error));
      } else {
        const lightTable = lightTableOf(internals, hdrpBuffers, reflectedAbi.directLightSlot);
        const lightDataUpload = lightTable.write(
          prepared.local,
          projectorLightSlotIndex,
          channelMapping,
          projectedShadowChannels(frameState, prepared),
        );
        if (frameState.standardClusterWorkConformance?.enabled) {
          const tableInspection = lightTable.inspect();
          captureClusterTableWork(internals, frameState, camera, {
            clusterTransportGeneration: hdrpBuffers.clusterTransportGeneration,
            transport: 'storage-buffer',
            scope: 'light-data-buffer',
            packedLightSlots: tableInspection.packedSlots,
            acceptedWriteBytes: tableInspection.uploadedBytes,
            writeSucceeded: lightDataUpload.ok,
            ...(!lightDataUpload.ok ? { errorCode: lightDataUpload.error.code } : {}),
          });
        }
        if (!lightDataUpload.ok)
          return err(mapClusterUploadFailure('light-data', lightDataUpload.error));

        const membership = hdrpBuffers.membership.write(
          internals.device.queue,
          hdrpBuffers,
          prepared,
          gpuMembership,
        );
        if (!membership.ok)
          return err(mapClusterUploadFailure(membership.error.product, membership.error.error));
      }

      const clusterUniformUpload = internals.device.queue.writeBuffer(
        hdrpBuffers.clusterUniformBuffer,
        0,
        clusterUniformPayload,
      );
      if (!clusterUniformUpload.ok) {
        return err(mapClusterUploadFailure('cluster-uniform', clusterUniformUpload.error));
      }
      return ok(undefined);
    },
  );
  if (!bufferUpload.ok) return bufferUpload;

  return ok(undefined);
}

/**
 * feat-20260704 M3/w18: resolve `tonemapActive` + `skyboxActive` for this
 * frame, extracted verbatim from `recordFrame`.
 *
 * feat-20260519-tonemap-reinhard-mvp: tonemap is active when the camera carries
 * `tonemap !== 'none'` (routes geometry into the HDR offscreen target + a
 * fullscreen tonemap pass). feat-20260531-skybox-env-background M2 / w9: skybox
 * is active only when a SkyboxBackground entity is present AND tonemap is active
 * (hdrColor is only allocated on the tonemap path). M3 / w20: once-warn when
 * tonemap is 'none' but a skybox exists (config issue, not resource-timing —
 * no structured error). M3 / w18: skybox degrades to clear-colour for a frame
 * while its cubemap view is not yet resident (lazy equirect projection pending
 * / failed; the lazy trigger owns the fire-once-on-failed error).
 *
 * @internal
 */
export function resolveSkyboxActive(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  skybox: SkyboxSnapshot | undefined,
  world: RenderResourceScope,
): { tonemapActive: boolean; skyboxActive: boolean } {
  const tonemapActive = camera.tonemap !== 'none' || standardBloomAdmitted(camera);
  let skyboxActive = skybox !== undefined && tonemapActive;
  // feat-20260531-skybox-env-background M3 / w20: once-warn when camera
  // tonemap is 'none' but a SkyboxBackground entity exists. The skybox
  // pass requires the HDR render target allocated by the tonemap path;
  // without it the skybox is skipped for this frame. This is a config
  // issue, not a resource-timing issue -- don't fire a structured error
  // (plan-strategy D-2 NOTE, charter P3 non-silent).
  if (skybox !== undefined && !tonemapActive && !frameState.warnedSkyboxTonemapNone) {
    frameState.warnedSkyboxTonemapNone = true;
    console.warn(
      '[forgeax] SkyboxBackground: skybox requires tonemap active (camera.tonemap !== "none") to write HDR target. The skybox pass will be skipped for this frame.',
    );
  }
  // feat-20260531-skybox-env-background M3 / w18: degradation when cubemap
  // GPU view is not ready. getCubemapGpuView returns undefined if the
  // equirect-to-cube upload has not completed yet.
  if (skybox !== undefined && tonemapActive) {
    const featureSource = skybox.featureEnvironment;
    const cubemapView = featureSource
      ? internals.viewOwner?.preparedResolver.gpuWork.resolveTextureCube(
          featureSource.feature,
          featureSource.sky,
        )
      : internals.gpuStore.getCubemapGpuView(
          skybox.equirectHandle as AssetHandle<'equirect'>,
          world,
        );
    if (cubemapView === undefined) {
      // The skybox reuses the Skylight's equirect handle; the cubemap
      // projection is driven lazily by the single trigger in `driveLazy
      // EquirectProjection` above (it owns the fire-and-forget launch AND the
      // fire-once-on-failed structured error). While the projection is
      // pending or has failed the cube view is not resident, so the skybox
      // pass degrades to the clear-colour background for this frame
      // (charter P3: it activates once the shared projection flips to
      // 'ready'). No error is fired here -- 'pending' is a normal transition
      // (firing per frame would flood the channel), and 'failed' is reported
      // once by the lazy trigger. (feat-20260630 M3 / w18.)
      skyboxActive = false;
    }
  }
  return { tonemapActive, skyboxActive };
}

/** Color and shadow direct draws share physical-page identity and the same fixed ABI window. */
export function meshSlotBindGroup(
  device: RhiDevice,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  bindGroupCounts: BindGroupCounts,
  byteOffset: number,
  current?: () => boolean,
): BindGroup {
  requireViewBindingCurrent(current);
  return meshBufferBindGroup(
    device,
    frameState,
    pipelineState,
    bindGroupCounts,
    meshSsboBuffer(pipelineState.meshStorageBuffer, byteOffset),
    current,
  );
}

/** Bind the physical buffer selected together with the draw's page-local offset. */
export function meshBufferBindGroup(
  device: RhiDevice,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  bindGroupCounts: BindGroupCounts,
  buffer: Buffer,
  current?: () => boolean,
): BindGroup {
  const bindings = bindGroupChainLeaf2(
    frameState.meshBindGroupCache,
    pipelineState.meshBindGroupLayout,
    buffer,
  );
  const cached = bindings.get('mesh');
  if (cached !== undefined) return cached;
  const result = createPrimitiveBindGroup(device, {
    label: 'pbr-mesh-bg',
    layout: pipelineState.meshBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          kind: 'buffer',
          value: {
            buffer,
            offset: 0,
            size: device.caps.storageBuffer ? MESH_PER_ENTITY_STRIDE : MESH_UBO_FULL_ARRAY_BYTES,
          },
        },
      },
    ],
  });
  if (!result.ok) throw result.error;
  requireViewBindingCurrent(current);
  return rememberBindGroup(bindings, 'mesh', result.value, bindGroupCounts);
}
