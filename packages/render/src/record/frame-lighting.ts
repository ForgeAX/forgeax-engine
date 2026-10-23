import type { AssetHandle } from '@forgeax/engine-types';
import { fnv1a32 } from '@forgeax/engine-types';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { standardBloomAdmitted } from '../bloom-admission';
import { type AtmosphereViews, atmosphereBindings } from '../environment/bindings';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { FrameList } from '../scene/frame-list';
// @forgeax/engine-runtime - RenderSystem record stage: per-frame lighting.
// feat-20260704 M5/w31: further-split from frame.ts (AC-05 <=1500 lines/file).
// Pure leaf helpers invoked once each from recordFrame; behavior verbatim.

import { vec3 } from '@forgeax/engine-math';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type RhiDevice,
  RhiError,
  type TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
  type RenderError,
  RendererOperationError,
  StandardClusterTransportUnavailableError,
} from '../errors/render';
import {
  createHdrpClusterMembershipBindGroup,
  createHdrpUnifiedBindGroup,
  getOrCreateHdrpBuffers,
  packClusterUniform,
} from '../hdrp-buffers';
import { DIRECT_LIGHT_SLOT_FLOAT_COUNT, packDirectLightSlot } from '../light-buffer-layout';
import {
  type PreparedStandardLighting,
  prepareStandardLighting,
} from '../pipeline/standard-lighting/prepare';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import {
  type StandardClusterTransport,
  selectStandardClusterTransport,
} from '../pipeline/standard-lighting/transport';
import { DEFAULT_CLUSTER_GRID, DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { resampleLightTextureSlice } from '../prepare/extended-lighting/light-texture-resample';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
  writeCookieSliceMipChain,
} from '../prepare/extended-lighting/resources';
import type { LightTextureSource } from '../prepare/extended-lighting/spot-modifiers';
import type { ReflectionProbeTable } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';
import type { CameraSnapshot, RenderHdrpClusterPhase } from '../render-contract';
import type {
  DirectionalLightSnapshot,
  ExtractedLights,
  IesProfileSnapshot,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import {
  SHADOW_ATLAS_DEFAULT_FACE_SIZE,
  SHADOW_ATLAS_DEFAULT_LAYERS,
  ShadowAtlas,
} from '../shadow-atlas';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';
import { buildSsaoUniformPayload } from '../ssao-uniform';
// extendedLighting keeps Spot modifier factors on the existing light record
// path; no additional render pass or submit owner is introduced.
import type { BindGroupCounts, RenderFrameState } from './frame-snapshot';
import {
  computeProjectionMatrix,
  computeViewMatrix,
  isLitMaterialSnapshot,
  warnMultiLightDirectional,
} from './helpers';
import {
  getOrCreateFromChain,
  MESH_PER_ENTITY_STRIDE,
  MESH_UBO_FULL_ARRAY_BYTES,
} from './mesh-ssbo';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RecordProfileRunner,
  RenderSystemInternals,
} from './render-context';
import { POINTS_LINES_VIEW_BYTES, SHADOW_PARAMS_BYTES, VIEW_UNIFORM_BYTES } from './view-ubo';

interface StandardReflectionProbeBinding {
  readonly probeIndex: number | undefined;
  readonly useSkylight: boolean;
}

export function resolveReflectionProbeBinding(
  selection: ReflectionProbeSelectionResult,
  table?: ReflectionProbeTable,
): StandardReflectionProbeBinding {
  if (selection.kind !== 'probe') return { probeIndex: undefined, useSkylight: true };
  const primitiveKey = `${selection.worldId}:${selection.entityKey}`;
  const tableIndex = table?.cpuIndexByPrimitive(primitiveKey);
  return { probeIndex: tableIndex ?? selection.entityKey, useSkylight: false };
}

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

/**
 * feat-20260704 M3/w18: per-frame bind-group cache resolution, extracted
 * verbatim from `recordFrame`. Walks the handle-identity WeakMap caches
 * (feat-20260531 M2 + feat-20260622 M3) to resolve or lazily create the view
 * (@group 0), mesh (@group 2), and — when HDRP is active — HDRP-unified cluster
 * bind groups. Raster groups may be null with no validated meshes; the Cluster
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
  graphTargets?: {
    readonly directionalShadow?: TextureView | undefined;
    readonly spotShadow?: TextureView | undefined;
    readonly shadowMoments?: TextureView | undefined;
    readonly cloudShadow?: TextureView | undefined;
    readonly atmosphere?: AtmosphereViews | undefined;
    readonly projector?: TextureView | undefined;
    readonly projectorSampler?: import('@forgeax/engine-rhi').Sampler | undefined;
  },
  includeView = true,
  standardLighting?: StandardTopologyInputValue,
): {
  viewBindGroup: BindGroup | null;
  meshBindGroup: BindGroup | null;
  hdrpClusterBindGroup: BindGroup | null;
  hdrpClusterMembershipBindGroup: BindGroup | null;
} {
  // View main (#1) chain = b0(viewUniformBuffer), b3(graph shadowDepth view or
  // shadowArrayFallbackTextureView), b4(shadowSampler), b5(atlas view), b6
  // (shadowParams); variant 'view-main'. Local lights are never mirrored in
  // the view group: Standard consumes the one Cluster group(2) payload.
  // Mesh (#2) chain = inner b0 buffer (meshStorageBuffer.buffer); variant 'mesh'.
  let viewBindGroup: BindGroup | null = null;
  let meshBindGroup: BindGroup | null = null;
  // Standard clustered group(2) bind group. Non-null when the prepared
  // topology selects the cluster transport and its persistent allocation
  // succeeds; consumed by encodeMainPass at `setBindGroup(2, ...)`.
  let hdrpClusterBindGroup: BindGroup | null = null;
  // The prepared Standard topology is the per-frame authority for whether
  // group(2) carries Cluster storage. A missing declaration is the prewarm /
  // non-Standard path and must not allocate or bind the Cluster bundle based
  // on the install-time pipeline identity alone.
  const clusteredLighting = standardLighting?.kind === 'clustered';
  const membershipLayout = pipelineState.hdrpClusterMembershipBindGroupLayout;
  const membership = frameState.hdrpClusterMembership;
  // The graph's Cluster producer also serves RenderFeature consumers and
  // warmup frames with no ordinary meshes. Its lifetime follows the accepted
  // lighting topology, not the ordinary raster validation count.
  const expectedHdrpBuffers = clusteredLighting
    ? getOrCreateHdrpBuffers(internals, frameState.installedPipelineConfig?.clusterGrid)
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
      const shadowSampler = pipelineState.perPassResources.shadowSampler;
      if (shadowSampler === null) {
        return {
          viewBindGroup: null,
          meshBindGroup: null,
          hdrpClusterBindGroup: null,
          hdrpClusterMembershipBindGroup,
        };
      }
      const graphShadowView = graphTargets?.directionalShadow;
      const b3View =
        graphShadowView !== undefined
          ? graphShadowView
          : pipelineState.shadowArrayFallbackTextureView;
      // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: bind the real
      // ShadowAtlas cube_array view when point shadows are active in this
      // frame; otherwise the 1x1x6 fallback (cleared to 1.0 = fully lit).
      const pointShadowAtlas = frameState.pointShadowAtlas;
      const atlasViewMaybe = pointShadowAtlas?.isAllocated()
        ? pointShadowAtlas.getAtlasView()
        : null;
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
      const iesProfileTextureView = pipelineState.iesProfileTextureView;
      const cookieTextureView = pipelineState.cookieTextureView;
      const cookieMatrixBuffer = pipelineState.cookieMatrixBuffer;
      const ltcLambertTextureView = pipelineState.ltcLambertTextureView;
      const ltcGgxTextureView = pipelineState.ltcGgxTextureView;
      const extendedLightingResources =
        extendedLighting &&
        iesProfileTextureView !== undefined &&
        cookieTextureView !== undefined &&
        cookieMatrixBuffer !== undefined &&
        ltcLambertTextureView !== undefined &&
        ltcGgxTextureView !== undefined
          ? {
              moments: graphTargets?.shadowMoments ?? cookieTextureView,
              sampler: pipelineState.defaultSampler,
              iesProfileTextureView,
              cookieTextureView,
              ltcLambertTextureView,
              ltcGgxTextureView,
              cookieMatrixBuffer,
            }
          : undefined;
      if (extendedLighting && extendedLightingResources === undefined) {
        return {
          viewBindGroup: null,
          meshBindGroup: null,
          hdrpClusterBindGroup: null,
          hdrpClusterMembershipBindGroup,
        };
      }
      const extendedLightingViews =
        extendedLightingResources !== undefined
          ? [
              extendedLightingResources.moments,
              extendedLightingResources.sampler,
              extendedLightingResources.iesProfileTextureView,
              extendedLightingResources.cookieTextureView,
              extendedLightingResources.ltcLambertTextureView,
              extendedLightingResources.ltcGgxTextureView,
              extendedLightingResources.cookieMatrixBuffer,
            ]
          : [];
      const projectorAvailable = pipelineState.projectorAvailable !== false;
      const lowLimitCloudBindings = !extendedLighting && !projectorAvailable;
      const b11View = graphTargets?.projector ?? pipelineState.defaultWhiteTextureView;
      const b12Sampler = graphTargets?.projectorSampler ?? pipelineState.defaultSampler;
      const atmosphereEntries = atmosphereBindings(pipelineState, graphTargets?.atmosphere);
      viewBindGroup = getOrCreateFromChain(
        frameState.viewBindGroupCache,
        [
          pipelineState.viewUniformBuffer,
          ...atmosphereEntries.map((entry) => entry.resource.value as object),
          b3View,
          shadowSampler,
          b5View,
          pipelineState.shadowParamsBuffer,
          b8View,
          ...extendedLightingViews,
          ...(extendedLightingResources === undefined && projectorAvailable
            ? [b11View, b12Sampler]
            : []),
          pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
          ...(lowLimitCloudBindings
            ? []
            : [cloudShadowView, pipelineState.viewLinearSampler ?? pipelineState.defaultSampler]),
        ],
        'view-main',
        () => {
          const entries: BindGroupEntry[] = [
            ...atmosphereEntries,
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
            {
              binding: 10,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
                  size: POINTS_LINES_VIEW_BYTES,
                },
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
                    binding: 24,
                    resource: {
                      kind: 'textureView' as const,
                      value: extendedLightingResources.moments,
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
                  {
                    binding: 17,
                    resource: {
                      kind: 'sampler' as const,
                      value: pipelineState.viewLinearSampler ?? pipelineState.defaultSampler,
                    },
                  },
                ]),
            // feat-20260625-spot-light-shadow-mapping w25: the per-spot
            // fragment-read lightViewProj matrices fold into the View UBO
            // (binding 0, `view.spotLightViewProj`) — no standalone binding 9
            // (WebGL2 fragment uniform-buffer budget). binding 10 is the
            // dedicated vertex-only Points/Lines viewport UBO.
          ];
          const viewBindGroupResult = internals.device.createBindGroup({
            label: 'pbr-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries,
          });
          if (!viewBindGroupResult.ok) throw viewBindGroupResult.error;
          return viewBindGroupResult.value;
        },
        bindGroupCounts,
      );
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
    );

    // feat-20260609-hdrp-cluster-fragment-ggx M4 / w19: when HDRP is active,
    // build the unified group(2) BindGroup that carries the mesh SSBO at
    // binding 0 + the 4 cluster buffers at bindings 3..6. The bindGroup
    // shares the mesh SSBO with URP's `meshBindGroup` (same `meshStorageBuffer.buffer`
    // + same per-entity stride), so the dynamic offset issued at
    // `setBindGroup(2, ...)` covers binding 0 of either layout. Cached
    // alongside `meshBindGroupCache` keyed on the mesh SSBO + cluster
    // buffer identities; cache invalidates on a buffer-grow event the same
    // way the mesh path does (handle id rotation).
    if (clusteredLighting) {
      const hdrpBuffers = expectedHdrpBuffers;
      if (hdrpBuffers !== null) {
        // D-3: buffer dimension uses the inner `.buffer` (same constraint
        // as the mesh path) so a grow event rotates the chain key.
        hdrpClusterBindGroup = getOrCreateFromChain(
          frameState.meshBindGroupCache,
          [meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer, hdrpBuffers],
          'hdrp-unified',
          () => {
            const bg = createHdrpUnifiedBindGroup(
              internals,
              hdrpBuffers,
              meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer,
            );
            if (bg === null) {
              throw new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'HDRP unified BindGroup creation succeeds when HDRP is active',
                hint: 'inspect prior errorRegistry events for createBindGroup failure detail',
              });
            }
            return bg;
          },
          bindGroupCounts,
        );
      }
    }
  }
  return { viewBindGroup, meshBindGroup, hdrpClusterBindGroup, hdrpClusterMembershipBindGroup };
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
  lights: ExtractedLights,
  camera: CameraSnapshot,
  pipelineState?: Pick<
    PipelineState,
    'hdrpClusterMembershipPipeline' | 'hdrpClusterMembershipBindGroupLayout'
  >,
): Result<
  {
    light: DirectionalLightSnapshot;
    pointLights: ExtractedLights['point'];
    spotLights: ExtractedLights['spot'];
    rectLights: ExtractedLights['rect'];
    totalLightCount: number;
    standard: StandardTopologyInputValue;
  },
  RenderError
> {
  if (lights.directionalCount > 1) {
    warnMultiLightDirectional(frameState, lights.directionalCount);
  }
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

  // ExtractedLights three-arm consumption (R-10 preparation; M2 / w16):
  //
  //   - lights.directional : feeds the View UBO at slot [16..23]
  //                          (lightDir + lightColor; existing path).
  //   - lights.point/spot/rect[] : packed into the one unified Standard
  //                                Cluster payload below. No per-kind light
  //                                transport exists at the renderer boundary.
  //
  // Each variant carries the discriminant `kind` so the record-time packing
  // call sites can run exhaustive switch (charter P2 + AC-03).
  const directionalLight: DirectionalLightSnapshot | undefined = lights.directional;
  const pointLights = lights.point;
  const spotLights = lights.spot;
  const rectLights = lights.rect;

  // Case C: 0 DirectionalLight = legitimate scene; the View UBO falls
  // back to a zero-intensity directional payload so the shader's
  // `view.lightDir * view.lightColor` term contributes nothing
  // (physically-correct black under standard, untouched under unlit).
  const light: DirectionalLightSnapshot = directionalLight ?? {
    kind: 'directional' as const,
    direction: vec3.create(0, -1, 0),
    color: vec3.create(0, 0, 0),
    intensity: 0,
    contactShadowLength: 0,
  };

  const totalLightCount =
    (directionalLight !== undefined ? 1 : 0) +
    pointLights.length +
    spotLights.length +
    rectLights.length;

  const clusterGrid = frameState.installedPipelineConfig?.clusterGrid ?? DEFAULT_CLUSTER_GRID;
  const local = [
    ...pointLights.map((source) => ({
      kind: 'point' as const,
      shadowed: source.shadowAtlasLayer !== undefined && source.shadowAtlasLayer >= 0,
      position: source.position,
      range:
        Number.isFinite(source.invRangeSquared) && source.invRangeSquared > 0
          ? Math.sqrt(1 / source.invRangeSquared)
          : Number.POSITIVE_INFINITY,
      source,
    })),
    ...spotLights.map((source) => ({
      kind: 'spot' as const,
      shadowed:
        source.castShadow && source.shadowAtlasTile >= 0 && source.lightViewProj !== undefined,
      position: source.position,
      range:
        Number.isFinite(source.invRangeSquared) && source.invRangeSquared > 0
          ? Math.sqrt(1 / source.invRangeSquared)
          : Number.POSITIVE_INFINITY,
      source,
    })),
    ...rectLights.map((source) => ({
      kind: 'rect-area' as const,
      shadowed: false,
      position: source.position,
      range:
        (Number.isFinite(source.invRangeSquared) && source.invRangeSquared > 0
          ? Math.sqrt(1 / source.invRangeSquared)
          : Number.POSITIVE_INFINITY) + Math.hypot(source.halfWidth, source.halfHeight),
      source,
    })),
  ];
  const prepared = prepareStandardLighting({
    directional: directionalLight,
    local,
    view: computeViewMatrix(camera),
    projection: computeProjectionMatrix(camera),
    near: camera.near,
    far: camera.far,
    grid: clusterGrid,
    lightCount: internals.standardProfile?.lightCount ?? DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath:
      (frameState.cameraStandardProfile ?? internals.standardProfile)?.renderPath ??
      DEFAULT_STANDARD_PROFILE.renderPath,
  });
  if (!prepared.ok) return prepared;
  // Storage-capable Standard frames keep the same Cluster ABI even when the
  // local-light corpus is empty.  Directional-only scenes still need the
  // unified mesh group(2) contract so their PBR draws do not select a second
  // local-light layout; the existing transport emits a zero-light payload and
  // the graph remains structurally identical. No-storage local lights use the
  // complete CPU texture projection selected below.
  if (!internals.device.caps.storageBuffer && prepared.value.local.length === 0) {
    return ok({
      light,
      pointLights,
      spotLights,
      rectLights,
      totalLightCount,
      standard: { kind: 'no-local-lights', prepared: prepared.value },
    });
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
  );
  if (!transport.ok) return transport;

  return ok({
    light,
    pointLights,
    spotLights,
    rectLights,
    totalLightCount,
    standard: { kind: 'clustered', prepared: prepared.value, transport: transport.value },
  });
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

interface LightTextureUpload {
  readonly slice: number | undefined;
  readonly source: LightTextureSource | undefined;
  readonly matrix: Float32Array | undefined;
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
  lights: Pick<ExtractedLights, 'point' | 'spot' | 'rect'>,
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
  const uploadLightTexture = (modifier: LightTextureUpload): void => {
    const source = modifier.source;
    if (modifier.slice !== undefined && source !== undefined && cookieTexture) {
      const payload = source.kind === 'mip-chain' ? source.data : source.asset.data;
      const digest = modifierDigest(payload);
      if (uploadState.cookie.get(modifier.slice) !== digest) {
        if (source.kind === 'mip-chain') {
          if (source.data.byteLength === COOKIE_SLICE_MIP_CHAIN_BYTES) {
            writeChain(modifier.slice, source.data);
            uploadState.cookie.set(modifier.slice, digest);
          }
        } else {
          const resampled = resampleLightTextureSlice({
            device: internals.device,
            factory: internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory,
            target: cookieTexture,
            slice: modifier.slice,
            asset: source.asset,
          });
          if (!resampled.ok) {
            internals.errorRegistry.fire(resampled.error);
            writeChain(modifier.slice, WHITE_LIGHT_TEXTURE_CHAIN);
          }
          uploadState.cookie.set(modifier.slice, digest);
        }
      }
    }
    if (modifier.slice !== undefined && modifier.matrix !== undefined && cookieMatrixBuffer) {
      const matrixBytes = new Uint8Array(
        modifier.matrix.buffer,
        modifier.matrix.byteOffset,
        modifier.matrix.byteLength,
      );
      const digest = modifierDigest(matrixBytes);
      if (uploadState.cookieMatrix.get(modifier.slice) !== digest) {
        const result = internals.device.queue.writeBuffer(
          cookieMatrixBuffer,
          modifier.slice * 16 * Float32Array.BYTES_PER_ELEMENT,
          modifier.matrix,
        );
        if (!result.ok) throw result.error;
        uploadState.cookieMatrix.set(modifier.slice, digest);
      }
    }
  };
  const uploadedIesSlices = new Set<number>();
  const uploadIes = (profile: IesProfileSnapshot): void => {
    if (
      profile.iesProfileSlice !== undefined &&
      profile.iesProfileData !== undefined &&
      iesTexture
    ) {
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
    uploadLightTexture({
      slice: spot.cookieSlice,
      source: spot.cookieSource,
      matrix: spot.cookieMatrix,
    });
    uploadLightTexture({
      slice: spot.projectorSlice,
      source: spot.projectorSource,
      matrix: spot.projectorMatrix,
    });
  }
  for (const rect of lights.rect) {
    uploadIes(rect);
    uploadLightTexture({ slice: rect.cookieSlice, source: rect.cookieSource, matrix: undefined });
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
 * frame's allocation cannot poison the current frame.
 *
 * @internal
 */
export function writeShadowParamsBuffer(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
): void {
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
    internals.errorRegistry.fire(shadowParamsWriteRes.error);
  }
}

/**
 * feat-20260704 M3/w18: zero-light standard-material once-warn, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10): fires once per
 * RenderSystem lifetime when the 0-light three-condition conjunction holds — no
 * Skylight, 0 direct light (totalLightCount === 0), AND at least one builtin
 * standard/PBR material (which renders black with no light). Custom shaders
 * own their lighting contract and cannot be classified by this generic
 * diagnostic. Suppressed under NODE_ENV=production.
 *
 * @internal
 */
export function warnZeroLightStandard(
  frameState: RenderFrameState,
  renderables: FrameList<RenderableSnapshot>,
  skylight: SkylightSnapshot | undefined,
  totalLightCount: number,
): void {
  const hasStandardMaterial = renderables.some((r) => isLitMaterialSnapshot(r.material.snapshot));
  if (
    skylight === undefined &&
    totalLightCount === 0 &&
    hasStandardMaterial &&
    !frameState.warnedZeroLightStandard
  ) {
    frameState.warnedZeroLightStandard = true;
    const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] standard material renders black with 0 lights of every type (no Skylight, and directional + point + spot all empty); spawn at least one light (Skylight, DirectionalLight, PointLight, or SpotLight) or switch material to an unlit shader (Materials.unlit(...)). See AGENTS.md section Breaking changes 2026-05-19.',
      );
    }
  }
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
  const configuredClusterGrid = prepared.layout.grid;
  const gpuMembership = transport.producer === 'gpu';
  if (gpuMembership && (!gpuMembershipPipelineReady || membershipBindGroupLayout === null)) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the selected GPU Cluster producer requires a ready membership pipeline and bind-group layout',
      ),
    );
  }
  const hdrpBuffers = getOrCreateHdrpBuffers(internals, configuredClusterGrid);
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

  if (pipelineState !== undefined) {
    const preparedPoints: ExtractedLights['point'][number][] = [];
    const preparedSpots: ExtractedLights['spot'][number][] = [];
    const preparedRects: ExtractedLights['rect'][number][] = [];
    for (const local of prepared.local) {
      if (local.source?.kind === 'point') preparedPoints.push(local.source);
      else if (local.source?.kind === 'spot') preparedSpots.push(local.source);
      else if (local.source?.kind === 'rect-area') preparedRects.push(local.source);
    }
    writeLightModifierTextures(internals, pipelineState, {
      point: preparedPoints,
      spot: preparedSpots,
      rect: preparedRects,
    });
  }

  const gridX = prepared.layout.grid.x;
  const gridY = prepared.layout.grid.y;
  const gridZ = prepared.layout.grid.z;
  const clusterGridBuf = prepared.clusterGrid;
  const lightIndexListBuf = prepared.lightIndexList;
  const lightIndexCount = prepared.membershipEntryCount;

  // Falsify injection point retained for the real prepared payload. It edits
  // only this frame's projection and never creates a second membership owner.
  const envFalsify = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (envFalsify?.FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO) clusterGridBuf.fill(0);

  const hdrpPayload = runHdrpClusterProfilePhase(
    profilePhase,
    'record/scene-state/hdrp-cluster/payload-packing',
    () => {
      const lightDataPayload = new Float32Array(
        prepared.layout.lightDataSlotCount * DIRECT_LIGHT_SLOT_FLOAT_COUNT,
      );
      let slotIdx = 0;
      for (const local of prepared.local) {
        const source = local.source;
        if (source === undefined) return null;
        const projectorSelected =
          projectorLightSlotIndex === undefined ? undefined : projectorLightSlotIndex === slotIdx;
        const packed = packDirectLightSlot(source, projectorSelected);
        lightDataPayload.set(packed, slotIdx * DIRECT_LIGHT_SLOT_FLOAT_COUNT);
        slotIdx += 1;
      }

      // scope-amend-webgl2-ubo: SSAO intensity is folded into the
      // cluster_uniform .w lane (formerly pad), removing the dedicated
      // @binding(9) UBO that pushed fragment-stage UBO count past
      // WebGL2's max_uniform_buffers_per_shader_stage=11. Disabled-SSAO
      // path writes 0, which lighting reads as "no screen AO" (no PSO
      // recompile across enable/disable).
      const clusterSsaoConfig = frameState.installedPipelineConfig?.ssao;
      const clusterSsaoIntensity =
        clusterSsaoConfig !== undefined && clusterSsaoConfig.enabled === true
          ? (clusterSsaoConfig.intensity ?? 1.0)
          : 0;
      const clusterUniformPayload = packClusterUniform(
        { x: gridX, y: gridY, z: gridZ },
        camera.near,
        camera.far,
        clusterSsaoIntensity,
        transport.admittedLightCount,
      );

      return {
        hdrpBuffers,
        lightDataUploadPayload: lightDataPayload.subarray(
          0,
          slotIdx * DIRECT_LIGHT_SLOT_FLOAT_COUNT,
        ),
        clusterUniformPayload: new Uint8Array(clusterUniformPayload),
      };
    },
  );

  if (hdrpPayload === null) {
    return err(
      new StandardClusterTransportUnavailableError(
        prepared.local.length,
        'the prepared Standard Cluster payload could not be materialized',
      ),
    );
  }

  const bufferUpload = runHdrpClusterProfilePhase(
    profilePhase,
    'record/scene-state/hdrp-cluster/buffer-upload',
    (): Result<void, RenderError> => {
      const { hdrpBuffers, lightDataUploadPayload, clusterUniformPayload } = hdrpPayload;
      if (hdrpBuffers.kind === 'texture') {
        const { words, layout, texture } = hdrpBuffers;
        words.set(
          new Uint32Array(
            lightDataUploadPayload.buffer,
            lightDataUploadPayload.byteOffset,
            lightDataUploadPayload.length,
          ),
        );
        words.set(clusterGridBuf, layout.gridOffset);
        words.set(lightIndexListBuf.subarray(0, lightIndexCount), layout.indexOffset);
        const rows = Math.ceil((layout.indexOffset + lightIndexCount) / (layout.width * 4));
        const upload = internals.device.queue.writeTexture(
          { texture },
          words.subarray(0, rows * layout.width * 4),
          { bytesPerRow: layout.width * 16, rowsPerImage: rows },
          { width: layout.width, height: rows, depthOrArrayLayers: 1 },
        );
        if (!upload.ok) return err(mapClusterUploadFailure('integer-texture', upload.error));
      } else {
        const lightDataUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.lightDataBuffer,
          0,
          lightDataUploadPayload,
        );
        if (!lightDataUpload.ok)
          return err(mapClusterUploadFailure('light-data', lightDataUpload.error));

        if (gpuMembership) {
          const lightBoundsUpload = internals.device.queue.writeBuffer(
            hdrpBuffers.lightBoundsBuffer,
            0,
            prepared.lightBounds,
          );
          if (!lightBoundsUpload.ok)
            return err(mapClusterUploadFailure('light-bounds', lightBoundsUpload.error));
        }
        const clusterGridUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.clusterGridBuffer,
          0,
          clusterGridBuf.subarray(0, gridX * gridY * gridZ * 2),
        );
        if (!clusterGridUpload.ok)
          return err(mapClusterUploadFailure('cluster-grid', clusterGridUpload.error));

        if (!gpuMembership && lightIndexCount > 0) {
          const lightIndexListUpload = internals.device.queue.writeBuffer(
            hdrpBuffers.lightIndexListBuffer,
            0,
            lightIndexListBuf.subarray(0, lightIndexCount),
          );
          if (!lightIndexListUpload.ok) {
            return err(mapClusterUploadFailure('light-index-list', lightIndexListUpload.error));
          }
        }
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

  // Prime the same sampled payload used by the graph pass. A failed early
  // upload still aborts this frame through the required-upload error path.
  const ssaoUpload = runHdrpClusterProfilePhase(
    profilePhase,
    'record/scene-state/hdrp-cluster/buffer-upload',
    (): Result<void, RenderError> => {
      if (frameState.installedPipelineConfig?.ssao?.enabled !== true) return ok(undefined);
      const ssaoBufs = getOrCreateSsaoBuffers(internals);
      if (ssaoBufs === null) return ok(undefined);
      const ssaoUniformPayload = buildSsaoUniformPayload(
        camera,
        frameState.installedPipelineConfig?.ssao,
      );

      const ssaoUniformRes = internals.device.queue.writeBuffer(
        ssaoBufs.uniformBuffer,
        0,
        ssaoUniformPayload,
      );
      if (!ssaoUniformRes.ok)
        return err(mapClusterUploadFailure('ssao-uniform', ssaoUniformRes.error));
      return ok(undefined);
    },
  );
  if (!ssaoUpload.ok) return ssaoUpload;
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
    const cubemapView = internals.gpuStore.getCubemapGpuView(
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
): BindGroup {
  const { buffer } = meshSsboBufferBinding(pipelineState.meshStorageBuffer, byteOffset);
  return getOrCreateFromChain(
    frameState.meshBindGroupCache,
    [pipelineState.meshBindGroupLayout, buffer],
    'mesh',
    () => {
      const result = device.createBindGroup({
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
                size: device.caps.storageBuffer
                  ? MESH_PER_ENTITY_STRIDE
                  : MESH_UBO_FULL_ARRAY_BYTES,
              },
            },
          },
        ],
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    bindGroupCounts,
  );
}

/** Preserve the complete clustered lighting ABI while selecting a physical mesh page. */
export function clusteredMeshSlotBindGroup(
  c: Pick<
    _InternalRenderPipelineContext,
    'runtime' | 'frameState' | 'pipelineState' | 'bindGroupCounts' | 'hdrpSsaoBlurredView'
  >,
  byteOffset: number,
): BindGroup {
  const { runtime, frameState, pipelineState, bindGroupCounts, hdrpSsaoBlurredView } = c;
  const buffers = getOrCreateHdrpBuffers(runtime, frameState.installedPipelineConfig?.clusterGrid);
  if (buffers === null) {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'clustered draw has the complete Standard lighting resources',
      hint: 'inspect prior cluster allocation errors',
    });
  }
  const { buffer } = meshSsboBufferBinding(pipelineState.meshStorageBuffer, byteOffset);
  return getOrCreateFromChain(
    frameState.meshBindGroupCache,
    [buffer, buffers, ...(hdrpSsaoBlurredView === undefined ? [] : [hdrpSsaoBlurredView])],
    'hdrp-unified',
    () => {
      const group = createHdrpUnifiedBindGroup(
        runtime,
        buffers,
        buffer,
        hdrpSsaoBlurredView === undefined
          ? { enabled: false }
          : { enabled: true, ssaoBlurredView: hdrpSsaoBlurredView },
      );
      if (group === null) {
        throw new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'clustered draw bind group creation succeeds',
          hint: 'inspect prior createBindGroup errors',
        });
      }
      return group;
    },
    bindGroupCounts,
  );
}
