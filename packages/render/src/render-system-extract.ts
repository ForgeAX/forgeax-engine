import type { GpuDrawSelection } from './gpu-driven/draw-selection';
import type { FrameList } from './scene/frame-list';
import type { DispatchList } from './scene/material-dispatch';
import { spriteUvRegion } from './sprite-region';

export type { DispatchList } from './scene/material-dispatch';

import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  type MaterialCookRasterContext,
  materialProgramContextForPass,
} from '@forgeax/engine-pack/material-cook';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { buildPlanarReflectionView } from './capture/planar-view';
import { LensEffects, resolveLensEffects } from './components/lens-effects';
import { LensFlare, resolveLensFlare } from './components/lens-flare';
import { Outline, resolveOutline } from './components/outline';
import { PlanarReflection, PlanarReflectionInvalidError } from './components/planar-reflection';
import {
  MaterialResource,
  materialResource,
  runtimeMaterialShaderIdForMaterial,
} from './material-resource';
import type { LightTextureSource } from './prepare/extended-lighting/spot-modifiers';
import { computeProjectionMatrix } from './record/helpers';
import { textureDigest } from './texture-digest';

export { textureDigest } from './texture-digest';

// @forgeax/engine-runtime - RenderSystem Extract stage (D-S2 + plan-strategy R-15
// fallback split). Pure ECS query phase: walks Camera / DirectionalLight /
// the merged-MeshRenderer renderable archetype and produces SoA-free snapshot
// arrays consumed by the Record stage.
//
// Carve-out from render-system.ts (review round 1 finding #3 - 505 line cap
// fallback split into 3 files; main + extract + record). The public API remains
// limited to the renderer contract; this module is an owner-local
// implementation seam consumed through relative imports.
//
// w15 (feat-20260511-asset-system-v1 M5 / plan-strategy D-P4) +
// feat-20260513-component-naming-bevy-align M3 / D-2 (merged) +
// feat-20260517-merge-mesh-renderer-material-renderer M2 / w5 (rename) +
// M3 / w9 (single-query convergence; this commit):
//   The previous 4-query alpha split (one full-archetype query gating on
//   Transform + MeshFilter + MeshRenderer without Instances; one direct
//   archetype-graph walk for the instanced variant; two fallback queries
//   on Transform+MeshFilter without MeshRenderer / MeshFilter without
//   Transform; one trailing dispatch query gating on MeshRenderer alone)
//   collapses into ONE archetype-graph walk gated on `MeshRenderer`
//   component presence (plan-strategy section 2.2 case A archetype-
//   natural-absence + section 3.2 sequence diagram "with: [MeshRenderer]
//   (sole)"). Inside the loop
//   the four D-Q7 dispositions land:
//     - case A (no MeshRenderer)  : not in domain; archetype absent. No
//                                   fire; no renderable; no dispatch.
//     - case B (material === 0)   : missing-spec sentinel; defaultMaterial
//                                   Snapshot fills the slot. No fire.
//     - case C (non-zero handle unresolved): assets.get(handle).err with the entity
//                                   carrying the full T+MF+MR renderable
//                                   archetype -> structured RhiError(
//                                   `asset-not-registered`) routed through
//                                   the World Layer-3 ErrorHandler + entity
//                                   skipped from RenderableSnapshot[] +
//                                   from MaterialDispatchSnapshot[]; with a
//                                   non-renderable archetype (MeshRenderer
//                                   only / lacking T or MF) the dangling
//                                   handle stays a silent skip (charter F1
//                                   surface minimization: AI users without
//                                   render intent should not see render
//                                   errors).
//     - resolved                  : populated MaterialSnapshot (5 fields)
//                                   + MaterialDispatchSnapshot dispatch
//                                   entry (regardless of T+MF presence,
//                                   preserving the dispatch-only counter
//                                   semantics).
//
// D-Q7 three-tier subtable (SSOT mirrored in `packages/runtime/README.md`
// §ECS render bridge D-Q7 `MeshRenderer` three-tier subtable +
// `components/mesh-renderer.ts` head JSDoc; AGENTS.md §Component naming
// + §Breaking changes 2026-05-17 row references this surface):
//   - case A archetype absent : silent skip; no onError; not in
//                               RenderableSnapshot[]; hint literal N/A
//                               (charter "ergonomic omission, not a
//                               misuse"; AC-09).
//   - case B missing-spec     : `material === undefined` ->
//                               `defaultMaterialSnapshot()` mid-grey
//                               unlit; no onError; entity present in
//                               RenderableSnapshot[] with default
//                               material; hint literal: `'pass
//                               undefined or omit field to request
//                               default material'` (AC-10).
//   - case C dangling-ref     : `assets.get(handle).err` for a non-zero
//                               handle (strict path, isRenderable === true) ->
//                               `RhiError({ code: 'asset-not-
//                               registered', detail: { assetHandle },
//                               hint: 'register material via
//                               assetRegistry.register(asset) before
//                               spawn, or remove the material field
//                               to fall back to default' })` routed
//                               through World Layer-3 ErrorHandler;
//                               entity skipped from
//                               RenderableSnapshot[] +
//                               MaterialDispatchSnapshot[]; mirrors
//                               `MeshFilter.assetHandle` dangling path. A
//                               scalar shared<T> slot 0 is the unbound,
//                               non-renderable state and is skipped
//                               (charter proposition 5; AC-11).
//
// World owns Instances.transforms. Extraction borrows the managed array during
// the read phase and retains a detached projection only when its values change.
// RenderScene accepts that projection with the source publication; recording
// owns device residency, upload revisions and backend-specific chunking.
// SpriteInstances remains the independent 2D component and snapshot contract.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  assertMaterialStaticSelection,
  findMaterialPassProgram,
  materialParametersToParamSchema as projectMaterialParametersToParamSchema,
  runtimeMaterialShaderId,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import {
  type Component,
  type ComponentSchema,
  type EntityHandle,
  type Query,
  Time,
  type World,
} from '@forgeax/engine-ecs';
import { readRenderArrayView, routeWorldError } from '@forgeax/engine-ecs/projection';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { AssetGuid, type AssetGuid as AssetGuidBytes } from '@forgeax/engine-pack/guid';
import { RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_STANDARD_SURFACE_MODULE,
  type MaterialShaderArtifact,
  rayMaterialNeedsCoverage,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  standardProjectionMask,
  standardSampleReuseMask,
  standardTextureMask,
  TONEMAP_PARAMS_LAYOUT,
} from '@forgeax/engine-shader';
import type {
  MaterialAsset,
  MaterialColorParameterSchema,
  MaterialParameter,
  MaterialPass,
  MaterialProgramAbi,
  MaterialRenderState,
  MaterialSurfaceModel,
  MaterialTextureCoordinates,
  MaterialTextureValue,
  MeshLodLevel,
  ParamSchemaEntry,
  TextureAsset,
} from '@forgeax/engine-types';
import {
  derive,
  materialProgramUsesSkin,
  materialValuesToLinearRuntime,
  toShared,
} from '@forgeax/engine-types';
import { buildCubeCameraFaceViews } from './capture/cube-views';
import {
  AmbientOcclusion,
  antialiasFromF32,
  BarrelDistortion,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  CameraView,
  CubeCamera,
  cameraExposureFromColumns,
  cameraProjectionFromF32,
  cubeCameraUpdateIntentFromF32,
  DynamicResolution,
  Fog,
  fogModeFromU32,
  MotionBlur,
  ReflectionProbe,
  reflectionProbeUpdateIntentFromF32,
  ScreenSpaceReflection,
  tonemapFromF32,
  tonemapToU32,
  transparencyFromF32,
  validateCameraBloom,
  validateCameraProjectionOffset,
  validateDynamicResolutionCamera,
} from './components';
import { validateBarrelDistortionParameters } from './components/barrel-distortion';
import { CAMERA_VIEW_DEFAULTS } from './components/camera-view';
import { ClippingPlanes, extractClippingPlanes } from './components/clipping-planes';
import { DepthOfField } from './components/depth-of-field';
import { DirectionalLight } from './components/directional-light';
import {
  type DirectionalShadowQuality,
  directionalShadowFilterRadiusTexels,
  directionalShadowQualityFromF32,
  SHADOW_RASTER_GUARD_TEXELS,
} from './components/directional-shadow-filter';
import type { LightValidationError } from './components/light-helpers';
import { resolveStereoCamera, StereoCamera, stereoEyeCamera } from './components/stereo-camera';
import { selectEnvironment } from './environment/frame';
import { ShadowInvalidConfigError } from './errors/render';
import {
  type DirectionalShadowCascadeFit,
  projectDirectionalShadow,
} from './extract/directional-shadow-projection';
import type {
  EnvironmentFrame,
  FogCandidate,
  FogFrame,
  FogSelectionFailure,
} from './extract/environment';
import { readEnvironmentPose } from './extract/environment-gate';
import type { GpuDrivenDrawSnapshot } from './extract/gpu-driven';
import { resolveVisibility, type VisibilitySnapshot } from './extract/visibility';
import {
  depthOfFieldRequestFailure,
  resolveDepthOfFieldParams,
} from './features/depth-of-field/depth-of-field-params';
import { resolveMotionBlurParams } from './features/motion-blur/motion-blur-params';
import type {
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
import type { InstanceCollectionId, InstanceProjectionStore } from './instances';
import type {
  MeshMaterialBindingDiagnostic,
  MeshMaterialBindingSource,
} from './mesh-material-bindings';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
} from './pbr-pipeline';
import type { PointsLinesRetainedSnapshot } from './points-lines/snapshot';
import { type RenderResourceScope, renderAssetRevision } from './publication/resource-scope';
import type { ReflectionProbeFact } from './reflection/projection';
import type { CameraSnapshot, CubeCameraSnapshot, PhysicalViewExtent } from './render-contract';
import { getActiveCamera, selectActiveCameraIndex } from './systems/active-camera';
import { selectPasses } from './systems/pass-selector';
import type { RenderTarget } from './targets/contracts';
import type { MaterialTextureSource } from './textures/canvas-texture';
import { isRenderTextureSourceToken } from './textures/source-token';
import { resolveSelectedVolumetricLight, type VolumetricFogLightKind } from './volume/capability';
import {
  type ValidatedVolumetricFog,
  type VolumeDensityBinding,
  VolumetricFog,
  type VolumetricFogAuthoring,
} from './volume/component';
import { extractVolumetricFog } from './volume/extract';
import type { VolumeProjectorTuple } from './volume/temporal';

/**
 * DirectionalLightSnapshot — sun-like infinite light variant of the
 * `LightSnapshot` discriminated union (M2 / w16 / AC-03). Host pre-multiplies
 * `color * intensity` so the shader sees the radiance term directly (charter
 * P4 host-side parity); `direction` stays in raw outgoing-vector form so the
 * shader can negate it once for BRDF (`let l = normalize(-light.direction)`).
 *
 * Plan-strategy D-S1 (3) (LightSnapshot to GPU buffer bucket 1:1 mapping).
 */
export interface DirectionalLightSnapshot {
  readonly kind: 'directional';
  /** Validated u32 surface direct-light channels. */
  readonly lightingChannels?: number;
  readonly entity?: EntityHandle;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  /** Screen-space contact shadow ray length in meters; 0 disables it. */
  readonly contactShadowLength: number;
}

/** Resolved immutable IES asset and its composition-local GPU layer. */
export interface IesProfileSnapshot {
  readonly iesProfileHandle?: number;
  readonly iesProfileSlice?: number;
  readonly iesProfileData?: Uint8Array;
}

/**
 * PointLightSnapshot — omnidirectional point variant. `position` from the
 * companion Transform; `invRangeSquared = 1 / range^2` host-folded via
 * `computeInvRangeSquared` (range = +Infinity -> 0; range = 0 -> 1e8 NaN
 * protection per D-S5).
 */
export interface PointLightSnapshot extends IesProfileSnapshot {
  /** Distance exponent; omitted authoring snapshots use the default 2. */
  readonly decay?: number;
  readonly kind: 'point';
  /** Validated u32 surface direct-light channels. */
  readonly lightingChannels?: number;
  readonly entity?: EntityHandle | number;
  /** World identity stamped by the composited extract owner. */
  readonly worldId?: number;
  readonly position: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  /** Transform axes used only by an authored IES profile; scale is discarded. */
  readonly axisX?: Vec3;
  readonly axisY?: Vec3;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 + M4 / T-M4-4:
   * cube_array atlas layer index for this light's shadow map (0..capacity-1
   * for admitted shadow casters; sentinel `-1` for non-admitted lights).
   * Default `-1` per
   * plan-strategy §D-2 — record stage / shader skips shadow sampling when the
   * lane equals the sentinel. Joined with `pointShadow[]` by entity at the
   * end of extract; HDRP record stage threads `shadowAtlasLayer + shadowNear +
   * shadowFar` through the unified direct-light metadata payload.
   */
  readonly shadowAtlasLayer?: number;
  /**
   * Per-face perspective near plane (matches `PointLightShadow.nearPlane`).
   * Used by HDRP `evalPointShadowed` for depth-ref reconstruction; URP keeps
   * the projection constants in its dedicated shadow-parameter buffer.
   */
  readonly shadowNear?: number;
  /**
   * Per-face perspective far plane (matches `PointLightShadow.farPlane`).
   * It is consumed with the shadow atlas layer through the shared
   * shadow-parameter buffer; DirectLightSlot carries only the layer identity.
   */
  readonly shadowFar?: number;
  /** Vogel footprint diameter; 1 selects hardware PCF, 3 defaults to radius 1. */
  readonly pcfKernelSize?: number;
}

/**
 * PointShadowSnapshot — extract-stage view of one shadow-casting point light
 * (feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7).
 *
 * `entity` is the spawning entity (joins PointLight + PointLightShadow on the
 * same archetype); `position` is the light world-space position resolved from
 * the companion Transform (mirrors PointLightSnapshot.position).
 * `shadowMatrices` is the 96-float packed mat4[6] table (column-major,
 * 6 mat4 * 16 floats = 384 bytes) ready for UBO upload.
 *
 * Plan-strategy §D-3: the record stage allocates a dynamic-offset uniform
 * buffer (384 B per-light, aligned to minUniformBufferOffsetAlignment, WebGPU
 * min 256 -> 512 B stride). Extract owns the host-side `Float32Array(96)`;
 * record owns the GPU `RhiBuffer` lifetime.
 *
 * `mapSize` / `nearPlane` / `farPlane` ride here so record stage can size the
 * cube atlas faces and feed shader the proj constants without re-querying ECS.
 * `shadowAtlasLayer` is assigned by extract in spawn order up to the renderer
 * atlas capacity; over-budget requests retain the sentinel `-1` so the
 * downstream DirectLightSlot packing carries no invalid layer identity.
 */
export interface PointShadowSnapshot {
  readonly shadowCasterChannels?: number;
  readonly shadowAutoUpdate?: boolean;
  readonly shadowRevision?: number;
  /** Spawning entity index (joins PointLight + PointLightShadow + Transform). */
  readonly entity: number;
  /** World identity stamped by the composited extract owner. */
  readonly worldId?: number;
  /** World-space light position (sourced from companion Transform). */
  readonly position: Vec3;
  /** PointLightShadow.mapSize (per-face cube square dimension; 512 default). */
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  readonly depthBias: number;
  readonly normalBias: number;
  readonly pcfKernelSize?: number;
  readonly shadowFilter?: number;
  readonly shadowBiasMode?: number;
  readonly shadowIntensity?: number;
  readonly shadowBlurSamples?: number;
  /**
   * Atlas layer assigned by extract in spawn order while capacity remains.
   * Sentinel -1 is used for a request that cannot be admitted and is
   * reserved by the shader-side DirectLightSlot metadata for no-shadow lights.
   */
  readonly shadowAtlasLayer: number;
  /**
   * 6 view-proj mat4 in face order [+X, -X, +Y, -Y, +Z, -Z] packed into one
   * Float32Array(96). 16 floats per face = 64 B; 6 * 64 = 384 B raw. The
   * record stage pads each slot to 512 B (256 alignment) when packing into
   * the per-light dynamic-offset UBO (plan-strategy §D-3).
   */
  readonly shadowMatrices: Float32Array;
}

/**
 * SpotLightSnapshot — cone-restricted variant. `position` from companion
 * Transform; `direction` raw outgoing-vector; `cosInner` / `cosOuter` host
 * pre-converted via `degToCos` so the shader sees only cosines (D-S2).
 *
 * feat-20260625-spot-light-shadow-mapping M1 w5: added shadow fields.
 * castShadow (bool) gates shadow projection; lightViewProj is the perspective
 * light-view-projection matrix computed in extract (undefined when castShadow
 * is false, dir degenerates, or the light is clipped). shadowAtlasTile
 * (i32 sentinel -1) is the allocated tile index 0..3 or -1 for unassigned
 * (plan-strategy D-4). mapSize / nearPlane / farPlane are the source
 * component shadow parameters carried through to the record stage. The
 * author-facing `shadowIntensity` remains in [0,1] and is copied unchanged;
 * shader consumers apply it only to shadow visibility, never to candela
 * radiance.
 */
export interface SpotLightSnapshot extends IesProfileSnapshot {
  readonly shadowMapAspect?: number;
  readonly shadowCasterChannels?: number;
  readonly shadowAutoUpdate?: boolean;
  readonly shadowRevision?: number;
  readonly kind: 'spot';
  /** Validated u32 surface direct-light channels. */
  readonly lightingChannels?: number;
  /** Entity identity is branded in extracted frames; numeric fixtures remain compatible. */
  readonly entity?: EntityHandle | number;
  /** World identity stamped by the composited extract owner. */
  readonly worldId?: number;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly cosInner: number;
  readonly cosOuter: number;
  /** Shared asset identities projected from the authored modifier fields. */
  readonly cookieHandle?: number;
  /** Resource-array slice identities; absent means the modifier falls back. */
  readonly cookieSlice?: number;
  /** Resolved authored payloads; absent means the renderer keeps identity LKG. */
  readonly cookieSource?: LightTextureSource;
  /** Aspect-only UV matrix paired with `cookieSlice`; upload is dirty-ranged. */
  readonly cookieMatrix?: Float32Array;
  /**
   * Legacy projector payload projected into the shared Cookie array lane when
   * the adapter exposes the extended-lighting topology. The projector keeps
   * its lightViewProj sampling semantics; only the texture transport is
   * shared with authored Cookie resources.
   */
  readonly projectorSlice?: number;
  readonly projectorSource?: LightTextureSource;
  readonly projectorMatrix?: Float32Array;
  readonly rollDeg?: number;
  // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
  readonly castShadow: boolean;
  readonly lightViewProj: Float32Array | undefined;
  readonly mapSize: number;
  readonly nearPlane: number;
  readonly farPlane: number;
  readonly shadowAtlasTile: number;
  /** Fraction of sampled shadow visibility to retain; 1 = fully opaque shadow. */
  readonly shadowIntensity?: number;
  readonly shadowBlurSamples?: number;
  readonly depthBias?: number;
  readonly normalBias?: number;
  readonly pcfKernelSize?: number;
  readonly shadowFilter?: number;
  readonly shadowBiasMode?: number;
  /** Authoritative TextureAsset projector resolved from the SpotLight handle. */
  readonly projectorHandle?: AssetHandle<'texture'>;
  readonly projectorAsset?: TextureAsset;
  readonly projectorGuid?: string;
  readonly projectorGeneration?: number;
  readonly projectorRevision?: number;
}

/** RectArea direct-light snapshot carried by the unified slot contract. */
export interface RectAreaDirectLightSnapshot extends IesProfileSnapshot {
  readonly kind: 'rect-area';
  readonly entity?: EntityHandle | number;
  /** World identity stamped by the composited extract owner. */
  readonly worldId?: number;
  /** Validated u32 surface direct-light channels. */
  readonly lightingChannels?: number;
  readonly position: Vec3;
  readonly color: Vec3;
  readonly intensity: number;
  readonly invRangeSquared: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly axisX: Vec3;
  readonly axisY: Vec3;
  readonly shadowAtlasTile?: number;
  /** Slot of the authored `RectAreaLight.sourceTexture` handle. */
  readonly sourceTextureHandle?: number;
  /**
   * Light-texture array slice and the source that fills it (CPU mip chain or
   * GPU resample). The slice is shared with Spot Cookies and projectors of
   * the same asset; absent means the emitter is uniform (texture factor 1).
   */
  readonly cookieSlice?: number;
  readonly cookieSource?: LightTextureSource;
}

/** Normalized world-space frame used by Rect extraction, culling, and BRDF. */
export interface RectAreaWorldFrame {
  readonly center: Vec3;
  readonly axisX: Vec3;
  readonly axisY: Vec3;
  readonly normal: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** Build the single normalized Rect frame shared by direct and cluster paths. */
export function buildRectAreaWorldFrame(input: {
  readonly center: ArrayLike<number>;
  readonly axisX: ArrayLike<number>;
  readonly axisY: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}): RectAreaWorldFrame {
  const center = vec3.create(input.center[0] ?? 0, input.center[1] ?? 0, input.center[2] ?? 0);
  const axisX = vec3.normalize(
    vec3.create(),
    vec3.create(input.axisX[0] ?? 0, input.axisX[1] ?? 0, input.axisX[2] ?? 0),
  );
  const axisY = vec3.normalize(
    vec3.create(),
    vec3.create(input.axisY[0] ?? 0, input.axisY[1] ?? 0, input.axisY[2] ?? 0),
  );
  const normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisX, axisY));
  normal[0] = normal[0] === 0 ? 0 : (normal[0] ?? 0);
  normal[1] = normal[1] === 0 ? 0 : (normal[1] ?? 0);
  normal[2] = normal[2] === 0 ? 0 : (normal[2] ?? 0);
  return {
    center,
    axisX,
    axisY,
    normal,
    halfWidth: Math.max(0, input.width * 0.5),
    halfHeight: Math.max(0, input.height * 0.5),
  };
}

/** Return true only on the authored front side of a one-sided Rect. */
export function rectAreaFacesPoint(frame: RectAreaWorldFrame, point: ArrayLike<number>): boolean {
  const toPoint = vec3.create(
    (point[0] ?? 0) - (frame.center[0] ?? 0),
    (point[1] ?? 0) - (frame.center[1] ?? 0),
    (point[2] ?? 0) - (frame.center[2] ?? 0),
  );
  return vec3.dot(frame.normal, toPoint) > 0;
}

/** Project a world point onto the finite authored Rect boundary. */
export function closestPointOnRectArea(frame: RectAreaWorldFrame, point: ArrayLike<number>): Vec3 {
  const toPoint = vec3.create(
    (point[0] ?? 0) - (frame.center[0] ?? 0),
    (point[1] ?? 0) - (frame.center[1] ?? 0),
    (point[2] ?? 0) - (frame.center[2] ?? 0),
  );
  const localX = Math.min(
    frame.halfWidth,
    Math.max(-frame.halfWidth, vec3.dot(toPoint, frame.axisX)),
  );
  const localY = Math.min(
    frame.halfHeight,
    Math.max(-frame.halfHeight, vec3.dot(toPoint, frame.axisY)),
  );
  return vec3.create(
    (frame.center[0] ?? 0) + (frame.axisX[0] ?? 0) * localX + (frame.axisY[0] ?? 0) * localY,
    (frame.center[1] ?? 0) + (frame.axisX[1] ?? 0) * localX + (frame.axisY[1] ?? 0) * localY,
    (frame.center[2] ?? 0) + (frame.axisX[2] ?? 0) * localX + (frame.axisY[2] ?? 0) * localY,
  );
}

/**
 * LightSnapshot — discriminated union of the directional and punctual
 * variants. AI users + the record stage perform an exhaustive switch on
 * `kind`; missing arms are caught at compile time (no `default`,
 * `assertNever`-style guards). Plan-strategy R-10.
 */
export type LightSnapshot =
  | DirectionalLightSnapshot
  | PointLightSnapshot
  | SpotLightSnapshot
  | RectAreaDirectLightSnapshot;

/**
 * The light sources of a frame: what extraction and the publication receiver
 * produce, and what the Render World light owner adopts and stamps with its
 * atlas layers. Renderer readers never read a frame's roster; they read the
 * owner's adopted roster through a view's {@link ViewLights}. Cascades are
 * not a source fact: each view fits its own (see `world/render-lights.ts`).
 *
 * `directional` is the first directional light; `directionalCount` counts
 * every DirectionalLight so record can warn when more than one exists.
 */
export interface LightRoster {
  readonly directional: DirectionalLightSnapshot | undefined;
  readonly directionalCount: number;
  readonly point: readonly PointLightSnapshot[];
  readonly spot: readonly SpotLightSnapshot[];
  readonly rect: readonly RectAreaDirectLightSnapshot[];
  /** Constant shadow-bias floor of a shadow-casting directional light. */
  readonly depthBias: number | undefined;
  /** Slope-based shadow-bias coefficient of a shadow-casting directional light. */
  readonly normalBias: number | undefined;
  /** Structured author-config failure; the candidate is withheld from record. */
  readonly directionalShadowError: LightValidationError | undefined;
  /**
   * Shadow-casting point lights, each with its six face matrices and the
   * cube layer the light owner granted (-1 before adoption or without a free
   * layer).
   */
  readonly pointShadow: readonly PointShadowSnapshot[];
  /** Directional shadow configuration a view fits its cascades from; undefined without a shadow. */
  readonly directionalCsmConfig: DirectionalCsmConfig | undefined;
  /** Light direction the cascades are fitted along. */
  readonly directionalCsmDirection: Vec3 | undefined;
}

/**
 * SkylightSnapshot -- extract-stage view of one Skylight entity
 * (feat-20260520-skylight-ibl-cubemap M4 / t26).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage drives the internal
 * lazy cubemap projection from it and resolves the projected GPU cubemap via
 * `GpuResidencyCache.getCubemapGpuView(...)` and related helpers
 * (feat-20260630 M3 / w16-w18). The snapshot carries NO projection status
 * field: the status truth lives in the store's CubemapGpuEntry (D-3 SSOT);
 * record queries it once per frame.
 *
 * `intensity` defaults to 1.0 via the Skylight component token defaults
 * (plan-strategy D-6: Skylight data flows through existing extract->record
 * pipeline; no independent ECS system).
 */
export interface SkylightSnapshot {
  /** Direction-independent diffuse irradiance; independent of IBL color/intensity. */
  readonly ambientIrradiance?: readonly [number, number, number];
  /** Fixed world-space environment capture origin from the Skylight Transform. */
  readonly capturePosition?: readonly [number, number, number];
  // 0 = no equirect supplied -> solid-color ambient via the white fallback
  // cube (record falls to fallback resources when no IBL views are cached).
  readonly equirectHandle: number;
  readonly color: readonly [number, number, number];
  /** World-space downward diffuse tint; absent or all-zero keeps uniform `color`. */
  readonly groundColor?: readonly [number, number, number];
  readonly intensity: number;
  /** Environment-space quaternion [x, y, z, w], identity by default. */
  readonly rotation: readonly [number, number, number, number];
  // feat-20260630 M3 / w19: the WINNING Skylight entity's packed handle (first
  // archetype hit). Carried so the multi-Skylight once-warn can name which
  // entity is used and which is ignored (F-8: warn carries conflicting entity
  // info). 0 only if the bundle had no live entity (never happens for a hit).
  readonly entityHandle: number;
}

/** Local diffuse probe facts; specular remains owned by Skylight/ReflectionProbe. */
export interface LightProbeSnapshot {
  readonly identity: string;
  /** World identity stamped by the composited extract owner. */
  readonly worldId?: number;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly irradiance: Float32Array;
  readonly admitted: boolean;
}

/**
 * SkyboxSnapshot -- extract-stage view of one SkyboxBackground entity
 * (feat-20260531-skybox-env-background M2 / w5).
 *
 * `equirectHandle` carries the packed u32 handle for
 * `Handle<EquirectAsset, 'shared'>`; the record stage resolves the projected
 * GPU cubemap via `GpuResidencyCache.getCubemapGpuView(...)`.
 *
 * `mode` carries the raw `f32` column value (`SKYBOX_MODE_CUBEMAP = 0`).
 * First hit wins per plan-strategy D-6; multi-entity once-warn in record stage.
 */
export interface SkyboxSnapshot {
  readonly equirectHandle: number;
  readonly mode: number;
  /** Environment-space quaternion [x, y, z, w], identity by default. */
  readonly rotation: readonly [number, number, number, number];
  // feat-20260630 M3 / w19: the WINNING SkyboxBackground entity's packed handle
  // (first archetype hit), so the multi-SkyboxBackground once-warn can name the
  // used entity (F-8 parity with the Skylight warn).
  readonly entityHandle: number;
}

/**
 * Resource-owner projection for an ECS VolumetricFog collection.
 *
 * The renderer carries the validated authoring facts and the source POD all
 * the way to the record stage.  No profile flag or source/catalog byte is
 * allowed to enable the graph: `status: 'available'` is produced only after
 * the ECS component, its shared TextureAsset, and the volume validator all
 * agree on every linear 3D density owner.
 */
export interface ExtractedVolumetricFog {
  readonly additional?: readonly ExtractedVolumetricFog[];
  readonly status: 'off' | 'available' | 'degraded';
  readonly fog?: ValidatedVolumetricFog;
  readonly densityHandle?: AssetHandle<'texture'>;
  readonly densityAsset?: TextureAsset;
  readonly guid?: string;
  readonly generation?: number;
  readonly digest?: string;
  readonly worldId?: number;
  /** Canonical simulation time projected from this World for authored medium motion. */
  readonly worldTimeSeconds?: number;
  /** Required same-World light selected by the authoring component. */
  readonly lightEntity?: EntityHandle;
  readonly lightKind?: VolumetricFogLightKind;
  /** Optional Point+Spot pair identities consumed by the volume integrator. */
  readonly pointLightEntity?: EntityHandle;
  readonly spotLightEntity?: EntityHandle;
  /** Accepted projector tuple shared by surface and volume when authored. */
  readonly projector?: VolumeProjectorTuple;
  /** The resolved projector payload shared with the surface light snapshot. */
  readonly projectorHandle?: AssetHandle<'texture'>;
  readonly projectorAsset?: TextureAsset;
}

export interface RenderableSnapshot {
  readonly glyph?: import('./glyph-source').GlyphRenderSource;
  readonly tilemap?: import('./tilemap-geometry').TilemapRenderSource;
  /** Source-local identity for an actual native child draw, without a derived entity. */
  readonly nativeDraw?: { readonly key: string };
  /** Fixed renderer-owned layout geometry; it has no asset identity. */
  readonly generatedMesh?: import('@forgeax/engine-types').MeshAsset;
  /** Instance animation UVs, composed with the accepted shared material only when drawn. */
  readonly spriteRegion?: import('./sprite-region').SpriteRegion;
  readonly layer?: number;
  /** Authored participation, independent of the current material Pass roster. */
  readonly shadowCaster?: false;
  /** Explicit non-drawing material pass preparation, independent of visibility. */
  readonly pipelinePreparation?: readonly Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'>[];
  readonly terrain?: import('./terrain/source.js').TerrainRenderSource;
  readonly terrainSection?: {
    readonly source: import('./terrain/source.js').TerrainDrawSource;
    readonly index: number;
    readonly lod: number;
    readonly neighbors: readonly number[];
  };

  /** Authored hierarchical visibility; retained hidden rows remain addressable. */
  readonly authorVisible?: boolean;
  readonly assetHandle?: number;
  readonly transform: TransformSnapshot;
  /** Producer-authored lower-detail references projected from MeshAsset. */
  readonly lods?: readonly MeshLodLevel[];
  readonly lodHysteresis?: number;
  /** Finite producer-owned local bounds retained for persistent CPU view work. */
  readonly localAabb?: Float32Array;
  /** Indexed single-submesh facts consumed by the first GPU-driven rigid lane. */
  readonly gpuDrivenDraws?: readonly GpuDrivenDrawSnapshot[];
  /** Shared renderer resource bindings. Recording reads their accepted snapshots. */
  readonly material: MaterialResource;
  readonly materials: readonly MaterialResource[];
  /** Authored entity overrides; zero or absent entries inherit the current Mesh slot. */
  readonly materialOverrides?: readonly (MaterialResource | undefined)[];
  /** Per-slot provenance trace from the shared mesh-material resolver. */
  readonly materialBindingSources: readonly MeshMaterialBindingSource[];
  /** Active structured override diagnostics for this renderable. */
  readonly materialBindingDiagnostics?: readonly MeshMaterialBindingDiagnostic[];
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1: the worldId
   * of the world this renderable was extracted from. Defaults to 0 in
   * single-world path (extractFrame always assigns 0). The merge layer
   * (extractFrames in M2) stamps the correct worldId per world before
   * the record stage consumes it. Combined with `entityKey` via
   * `worldEntityKey(worldId, entityKey)` to form per-entity cache keys.
   *
   * Never rewrite `entityKey` itself — consumers that need the real
   * entity handle (video provider, etc.) read the bare `entityKey`.
   */
  readonly worldId: number;
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w3: packed Entity u32
   * (encodeEntity(indexSlot, generation)) surface'd from the extract
   * stage. Stable per-entity identity for the record stage cache keys
   * (material / instances / per-frame clean-up) without re-querying the
   * World (charter P5 Pipeline Isolation: record stage only consumes
   * snapshot POD). Reuses the encodeEntity calculation already performed
   * at :1293 for the Instances path, and now also computed for plain
   * (non-Instances) renderables.
   *
   * Never rewrite this field — cache keys use `worldEntityKey(worldId, entityKey)`,
   * not the bare entityKey alone (D-1).
   */
  readonly entityKey: number;
  /**
   * feat-20260514 M3 (w15): when the entity carries an `Instances` component
   * the extract stage materialises a fresh `Float32Array` snapshot of the
   * packed mat4 transforms (16 f32 per instance, stride 16) plus a stable
   * `cacheKey` (the entity's packed u32) and the `archVersion` (used by the
   * record stage to invalidate its per-entity GPU buffer cache when the
   * archetype storage grew). Absent (`undefined`) means the record stage
   * falls back to the shared 1-element identity-mat4 storage buffer +
   * `drawIndexed(.., 1, ..)`.
   */
  readonly instances?: InstancesSnapshot;
  /**
   * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10
   * (plan-strategy D-1 + D-9): when the entity carries a `SpriteInstances`
   * component the extract stage materialises a paired snapshot — packed mat4
   * `transforms` (16 f32, stride 16) + per-instance UV `regions` (4 f32,
   * stride 4) — plus the same cache fingerprint pair (`cacheKey` = entity
   * packed u32, `archVersion` = archetype version stamp at snapshot time).
   * The record stage interleaves the two arrays into an 80B-per-instance
   * single GPU buffer routed through `@group(3) @binding(0)` (BGL unchanged,
   * D-1). Absent (`undefined`) means the entity is not a `SpriteInstances`
   * carrier; the record stage falls back to its existing sprite path
   * (material UBO region + identity-instance buffer).
   *
   * Three structured `EcsError` codes fire at extract entry and skip the
   * renderable on violation (charter P3 explicit failure):
   *   - `'sprite-instances-mutually-exclusive-with-instances'`
   *   - `'sprite-instances-requires-sprite-shading-model'`
   *   - `'sprite-instances-count-mismatch'`
   */
  readonly spriteInstances?: SpriteInstancesSnapshot;
  /** Static author membership. Dynamic joint facts belong to the fixed shared Skin root. */
  readonly skinBinding?: import('./scene/skin-scene-inputs').SkinBindingInput;
  /** Author request evaluated only by actual capsule-shadow demand. */
  readonly capsuleShadowRequested?: true;
  /** Present when the entity declares `Mobility static`: shadow caches skip observation. */
  readonly mobility?: 'static';
  /** Present when `ShadowParticipation.receive` is false: surface skips shadow sampling. */
  readonly shadowReceiver?: false;
  readonly shadowChannels?: number;
  /** Validated receiver mask, shared by every material section and instance. */
  readonly lightingChannels?: number;
  /**
   * ECS-owned morph weights. Presence binds a renderer-owned per-entity vertex
   * stream deformed from the asset's target deltas (GPU compute when
   * available); a new snapshot is the only weight-change signal.
   */
  readonly morph?: MorphSnapshot;
  /** Renderer-owned previous-frame facts attached during temporal projection. */
  readonly temporal?: RenderableTemporalSnapshot;
  /** Detached M2 authoring facts for the optional Points/Lines projection. */
  readonly pointsLines?: PointsLinesRetainedSnapshot;
  /** Renderer-owned per-object probe record uploaded at group(3) binding(1). */
  readonly probeBlendRecord?: import('./scene/probe-blend-record').ProbeBlendRecord;
}

export type RenderablePreviousSource = 'last-submitted' | 'current-seed';
export type RenderableReactiveReason =
  | 'new-slot'
  | 'generation-reuse'
  | 'reentered'
  | 'geometry-revision'
  | 'material-revision'
  | 'displacement-source'
  | 'skinning-deformation';
export interface RenderableTemporalSnapshot {
  readonly previousSource: RenderablePreviousSource;
  /** True only when current and previous geometry belong to one stable source identity. */
  readonly motionValid: boolean;
  /** Color-history invalidation is independent from motion validity. */
  readonly reactive: boolean;
  readonly reactiveReasons: readonly RenderableReactiveReason[];
  readonly previousTransform: TransformSnapshot;
  readonly previousInstances: InstancesSnapshot | undefined;
}

export interface MorphSnapshot {
  readonly weights: Float32Array;
  readonly targetCount: number;
}

export type { GpuDrivenDrawSnapshot } from './extract/gpu-driven';

export interface InstancesSnapshot {
  /** Renderer-owned collection identity. */
  readonly collectionId?: InstanceCollectionId;
  /** Packed column-major mat4 transforms (16 f32 per instance). */
  readonly transforms: Float32Array;
  /** Monotonic per-ordinal identity generations, when the collection owns them. */
  readonly generations?: Uint32Array;
  /** Number of instances (transforms.length / 16). */
  readonly instanceCount: number;
  /** Collection revision captured by this detached frame snapshot. */
  readonly revision?: number;
  /** Coalesced matrix ordinals dirtied since the previous authoring update. */
  readonly dirtyRanges?: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  /** Stable per-entity GPU buffer cache key (the packed Entity u32). */
  readonly cacheKey: number;
  /**
   * Archetype version stamp at snapshot time. The record stage compares this
   * against its cached version per cacheKey; a bump means the underlying
   * BufferPool slot may have grown / been reallocated, forcing a fresh
   * `device.createBuffer + queue.writeBuffer` round.
   */
  readonly archVersion: number;
}

/**
 * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10:
 * extract-stage view of a `SpriteInstances` carrier (2D peer of
 * `InstancesSnapshot`).
 *
 * Field shapes mirror `InstancesSnapshot` so the record-stage cache protocol
 * (`(cacheKey, archVersion, byteLength)` fingerprint triple) is reused
 * verbatim. The byte length consumed at upload time is the sum
 * `transforms.byteLength + regions.byteLength` (= 80*N for N instances,
 * plan-strategy D-1 interleaved single-buffer); the record stage builds the
 * 80B/instance interleaved buffer once per (entity, archVersion, byteLength)
 * fingerprint change.
 */
export interface SpriteInstancesSnapshot {
  /** Packed column-major mat4 transforms (16 f32 per instance, stride 16). */
  readonly transforms: Float32Array;
  /** Per-instance UV vec4 regions (4 f32 per instance, stride 4). */
  readonly regions: Float32Array;
  /**
   * Number of instances. Derived from `transforms.length / 16` (equivalently
   * `regions.length / 4`); the extract-entry validator guarantees the two
   * derivations agree, otherwise it fires
   * `'sprite-instances-count-mismatch'` and skips the renderable.
   */
  readonly instanceCount: number;
  /** Stable per-entity GPU buffer cache key (the packed Entity u32, D-9). */
  readonly cacheKey: number;
  /** Archetype version stamp at snapshot time (cache invalidation fingerprint). */
  readonly archVersion: number;
}

/**
 * TransformSnapshot: extract-stage view of one entity's resolved world
 * transform (feat-20260601 D-3). Holds the single `world` mat4 (column-major
 * 16 floats, copied from the entity's `GlobalTransform.world` view written by
 * propagateTransforms). The record stage copies these 16 floats straight into
 * the mesh SSBO slot (zero `mat4.compose`); position / scale consumers derive
 * from the mat4 via `mat4.getTranslation` / basis-column lengths.
 */
export interface TransformSnapshot {
  readonly world: Float32Array;
}

/**
 * MaterialSnapshot: extract-stage view of one entity's material asset (M2 / w6
 * of feat-20260517-merge-mesh-renderer-material-renderer; plan-strategy section 2.3).
 *
 * Adds optional `baseColorTexture` + `sampler` slots (consumed by the record
 * stage's textured-material code path; M3 / w10 dropped the cast-over-firstMaterial
 * pattern in favour of direct snapshot field reads).
 *
 * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4 extends
 * the snapshot with `metallicRoughnessTexture` and `normalTexture`
 * so the record stage can wire PBR texture bindings 4 and 6
 * from real GPU views instead of placeholder 1x1 white / flat-normal views.
 *
 * Bounded scope: the snapshot tracks only what the record stage actually
 * consumes today (charter proposition 5 consistent abstraction; YAGNI for
 * future-proof field bloat). Future MaterialAsset extensions (emissive / etc)
 * drive snapshot extensions when the record stage starts consuming them, not
 * vice-versa.
 *
 * tweak-20260701 M1: `shadingModel` field removed — shader identity via
 * {@link materialShaderId} is the single source of truth for material dispatch.
 */
export interface MaterialSnapshot {
  /** Common position proof of every actual selected Pass of this accepted material. */
  readonly positionBounds?: MaterialProgramAbi['positionBounds'];
  /** Inputs of this shared preparation; publications preserve the selected resource identity. */
  readonly materialContext?: Pick<MaterialSnapshotContext, 'geometry' | 'vertexColor'>;
  /** Reflected entry contracts of the exact accepted programs, shared with their registry. */
  readonly materialEntryPoints?: Readonly<
    Record<string, readonly import('@forgeax/engine-types').ShaderEntryPointReads[]>
  >;
  /** Complete accepted pass set, shared by every binding of this material. */
  readonly passes: readonly MaterialPass[];
  /** The producer owns immutable numeric values and their parameter ABI for this snapshot. */
  readonly immutableValues?: true;
  readonly baseColor: Vec3;
  readonly metallic: number;
  readonly roughness: number;
  /** Root-owned Surface model, independent of the cooked program byte identity. */
  readonly surfaceModel?: MaterialSurfaceModel | undefined;
  /** Whether this material publishes a Deferred pass consumed before the forward-only lane. */
  readonly deferredPass?: boolean | undefined;
  /** Authored Standard PBR specular color in linear runtime color space. */
  readonly specularColor?: readonly [number, number, number] | undefined;
  /**
   * Schema-driven material shader identifier (feat-20260523 M4-T05).
   * Populated when the material asset uses the schema-driven path
   * (payload.materialShader set). Undefined for unlit/sprite legacy
   * materials and for case-B defaultMaterialSnapshot.
   *
   * The record stage uses this as the pipeline cache key first-level
   * discriminator (M4-T06).
   */
  readonly materialShaderId?: string | undefined;
  readonly materialProgramKeys?: Readonly<Record<string, string>> | undefined;
  /** Frozen facts from the exact accepted payload; never re-read current GUID at submit. */
  readonly materialPublication?:
    | {
        readonly identity: import('./render-contract').MaterialDrawObservation['publication'];
        readonly programs: readonly import('./render-contract').MaterialDrawObservation['program'][];
      }
    | undefined;
  /** Accepted derivatives of the same Surface, selected from one material publication.
   * Ray coverage is exact; Card geometry coverage does not consume that flag. */
  readonly materialSurfacePrograms?:
    | Readonly<{
        'ray-hit'?: { readonly programKey: string; readonly evaluateCoverage: boolean };
        'card-capture'?: { readonly programKey: string };
      }>
    | undefined;
  /** Producer-selected scene-index program keys, when a cooked publication carries them. */
  readonly materialSceneIndexProgramKeys?:
    | Readonly<Record<string, MaterialSceneIndexProgramKey>>
    | undefined;
  /**
   * Stable source handle for the material asset. Record uses this only for
   * same-frame assembly reuse; GPU bind-group validity still comes from the
   * resource-identity cache.
   */
  readonly materialHandle?: number | undefined;
  /**
   * The selected forward-pass state for this exact material. A mesh can bind
   * different materials to its submeshes, so pipeline selection must read the
   * state from the submesh snapshot rather than the entity's first material.
   */
  readonly renderState?: MaterialRenderState | undefined;
  /**
   * Schema-driven parameter snapshot (feat-20260523 M4-T05).
   * Populated alongside materialShaderId. Maps param name to its
   * runtime-resolved value: number for scalar params, number[] for
   * vec/color params, string (GUID) for texture2d/sampler params.
   */
  readonly paramSnapshot?: Readonly<Record<string, number | number[] | string>> | undefined;
  /** Effective MaterialAsset parameter contract used to lay out this snapshot. */
  readonly materialParamSchema?: readonly ParamSchemaEntry[] | undefined;
  /** Authored texture presence, separate from the shared GPU layout schema. */
  readonly standardTextureMask?: number | undefined;
  /** Authored per-slot UV set and KHR texture transform metadata. */
  readonly textureCoordinates?: ReadonlyMap<string, MaterialTextureCoordinates> | undefined;
  /**
   * User-region texture handles keyed by paramSchema field name
   * (feat-20260621-learn-render-5-5-parallax M2 / w7). The SSOT carrier for
   * EVERY texture the shader's `derive(paramSchema).textureFieldNames`
   * declares — `baseColorTexture` / `metallicRoughnessTexture` /
   * `normalTexture` for built-in standard-PBR, plus each custom field such as
   * `heightTexture` (LO 5.5 parallax). The record stage iterates this map to
   * assemble the user-region bind group per the per-shader BGL (w8), so a 4th
   * (or Nth) texture flows end-to-end without a hardcoded field list.
   *
   * Populated by iterating `textureFieldNames`; absent keys mean the
   * paramValue was missing / mis-typed (record falls back to default white).
   * `emissiveTexture` / `occlusionTexture` are included here as ordinary
   * Standard user-region fields; the production layout does not duplicate
   * them in an engine injection region.
   */
  readonly textureHandles?: ReadonlyMap<string, AssetHandle<'texture'>> | undefined;
  /** Explicitly authored texture fields that must resolve before GPU admission. */
  readonly authoredTextureFields?: ReadonlySet<string> | undefined;
  /** Runtime target or Canvas sources; never projected as TextureAsset handles. */
  readonly textureSources?: ReadonlyMap<string, MaterialTextureSource> | undefined;
  /**
   * User-region texture field names whose paramValue resolved to a VideoAsset
   * (kind `'video'`) rather than a static TextureAsset
   * (feat-20260623-world-space-video-asset M4 / w14, D-5). The video GUID
   * occupies the same texture2d values slot a static texture would (P4:
   * one binding shape), but extract routes it here instead of `textureHandles`
   * so the record stage pulls the current-frame view from the transient
   * DynamicTextureStore (D-3) instead of `GpuResidencyCache.ensureResident`
   * (which has no `video` arm; AC-08). Each entry also carries the resolved
   * clip handle so the record stage can key the per-frame upload.
   *
   * Producer/consumer split (charter P5 / AC-07 gate): extract owns the
   * asset->snapshot translation; record consumes this POD field only — it never
   * reaches back into the MaterialAsset to learn a field is video-sourced.
   */
  readonly videoTextureFields?: ReadonlyMap<string, AssetHandle<'video'>> | undefined;
  /** Authored sampler handles keyed by their matching texture parameter. */
  readonly samplerHandles?: ReadonlyMap<string, AssetHandle<'sampler'>> | undefined;
  /** Explicitly authored sampler fields that must resolve before GPU admission. */
  readonly authoredSamplerFields?: ReadonlySet<string> | undefined;
  readonly baseColorTexture?: AssetHandle<'texture'> | undefined;
  /**
   * PBR metallic-roughness texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 4, falling
   * back to a 1x1 white placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added so the record stage can wire real metallic-roughness
   * textures from Sponza glTF materials (M3 writes the handle into
   * SchemaDrivenMaterialAsset values; M4 extract carries it through to the snapshot).
   */
  readonly metallicRoughnessTexture?: AssetHandle<'texture'> | undefined;
  /**
   * PBR tangent-space normal texture handle (present for PBR/sprite/skin
   * shaders). Undefined for the default-unlit shader
   * (materialShaderId === 'forgeax::default-unlit'). The record stage reads
   * this to write GPU view at material bind-group binding 6, falling
   * back to a (0.5,0.5,1.0) flat-normal placeholder when undefined.
   *
   * feat-20260522-learn-render-3-1-sponza-model-loading-with-multi-l M4:
   * field added symmetrically with metallicRoughnessTexture so the record
   * stage can wire real normal textures from Sponza glTF materials.
   */
  readonly normalTexture?: AssetHandle<'texture'> | undefined;
  /** Scalar applied to tangent-space normal XY after the normal texture sample. */
  readonly normalScale?: readonly [number, number] | undefined;
  readonly emissive?: readonly [number, number, number] | undefined;
  readonly emissiveIntensity?: number | undefined;
  readonly emissiveTexture?: AssetHandle<'texture'> | undefined;
  readonly occlusionTexture?: AssetHandle<'texture'> | undefined;
  readonly occlusionStrength?: number | undefined;
  /**
   * Transparent composition flag derived from the first pass's
   * `renderState.blend` presence on the underlying
   * {@link MaterialPass} (feat-20260626-collapse M2: blend
   * presence is the SSOT after `MaterialPass.transparent` was
   * dropped in M1).
   *
   * The record stage reads this to drive both the LDR split-pass
   * decision and the premultiplied-alpha blend resolution on the
   * generic materialShaderId pipeline path — shader-agnostic, decoupled
   * from the legacy `shadingModel` discriminant (feat-20260625 M2 D-3,
   * finalised in w15; `shadingModel` field removed in tweak-20260701 M1).
   *
   * This describes the primary-pass snapshot for consumers that need a
   * material summary. Actual draw routing and the LDR split read the selected
   * DispatchEntry.renderState, so mixed opaque/transparent Passes remain valid.
   *
   * Type is `boolean | undefined` (derived): `undefined` means "no
   * passes / unknown"; consumers must read `=== true` / `!== true` to
   * stay correct under both populated and absent cases.
   */
  readonly transparent?: boolean | undefined;
}

/**
 * One producer-selected scene-index program, retaining the effective Pass
 * kind so record does not infer shadow/depth semantics from an authored name.
 */
export interface MaterialSceneIndexProgramKey {
  readonly specializationKey: string;
  readonly pass: 'forward' | 'shadow' | 'depth';
}

export interface MaterialSnapshotCacheEntry {
  readonly snapshot: MaterialSnapshot;
  readonly programSelections?: readonly MaterialProgramSelection[];
  readonly assetRevision: number;
}

export type MaterialSnapshotCache = Map<number, MaterialSnapshotCacheEntry>;
export interface MaterialSnapshotContext {
  readonly geometry: MaterialCookRasterContext['geometry'];
  readonly vertexColor: boolean;
  readonly cache: MaterialSnapshotCache;
}

export type MaterialSnapshotContexts = Map<string, MaterialSnapshotContext>;
export type MaterialSnapshotCachesByWorld = WeakMap<RenderResourceScope, MaterialSnapshotContexts>;

export function materialSnapshotContext(
  contexts: MaterialSnapshotContexts,
  geometry: MaterialCookRasterContext['geometry'],
  vertexColor: boolean,
): MaterialSnapshotCache {
  const key = `${geometry}:${vertexColor}`;
  let context = contexts.get(key);
  if (context === undefined) {
    context = { geometry, vertexColor, cache: new Map() };
    contexts.set(key, context);
  }
  return context.cache;
}

export function gpuDrivenMaterialResourceClass(material: MaterialSnapshot): string {
  const textures = [...(material.textureHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const samplers = [...(material.samplerHandles?.entries() ?? [])]
    .map(([name, handle]) => [name, Number(handle)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    textures,
    samplers,
    video: [...(material.videoTextureFields?.keys() ?? [])].sort(),
  });
}

// === DispatchEntry — M3 / w26 single dispatch list (feat-20260526-material-asset-multipass-renderstate) ===
//
// Plan-strategy D-3: single dispatch list sorted by queue value,
// replacing the old three-bucket opaque/transparent/overlay dispatch.
// Each entry carries the per-pass render-state and entry-point
// data from the resolved MaterialPass so the record stage
// reads them without re-resolving the material.

export interface DispatchEntry {
  readonly entityIndex: number;
  readonly materialHandle: number;
  readonly renderableIndex: number;
  readonly passIndex: number;
  readonly queue: number;
  /**
   * Signed i32 from the entity's {@link Layer} component value (default 0 for
   * entities without a Layer). Primary sort key for the transparent-dispatch
   * sort in {@link render-system.ts}: lower value = drawn first (behind).
   */
  readonly layer: number;
  readonly tags: Record<string, string>;
  readonly renderState: MaterialRenderState | undefined;
  readonly defines: Record<string, string> | undefined;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly materialShaderId: string | undefined;
  /**
   * Stencil reference value from {@link MaterialPass.stencilReference}
   * (draw-call dynamic state). Folded during extract for per-draw consumption
   * in the record stage. `undefined` when the pass does not set a reference
   * value (record stage falls back to WebGPU default 0).
   */
  readonly stencilReference?: number;
}

/**
 * Stable-sort dispatch entries by `queue` value ascending.
 * Returns a new sorted array (does not mutate the input).
 * Same-queue entries preserve insertion order (AC-11 stable-order guarantee).
 */
export function sortDispatchByQueue<E extends { readonly queue: number }>(
  entries: readonly E[],
): E[] {
  // Array.prototype.sort is stable per ES2019 spec (V8 7.0+ / Node 12+).
  return entries.slice().sort((a, b) => a.queue - b.queue);
}

export const DEFAULT_FORWARD_PASS: MaterialPass = {
  name: 'forward',
  program: { module: 'forgeax::default-unlit', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
  renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
};

export function appendMaterialDispatchEntries(
  pendingDispatch: DispatchEntry[],
  passes: readonly MaterialPass[],
  entity: EntityHandle,
  materialHandle: number,
  renderableIndex: number,
  layer: number,
  passIndexOffset = 0,
  materialProgramKeys?: Readonly<Record<string, string>>,
): void {
  const matchedPasses = selectPasses(passes, {});
  for (let pIdx = 0; pIdx < matchedPasses.length; pIdx++) {
    const pass = matchedPasses[pIdx];
    if (pass === undefined) continue;
    const passState = (pass.renderState ?? {}) as MaterialRenderState & {
      readonly tags?: Record<string, string>;
      readonly queue?: number;
      readonly stencilReference?: number;
    };
    const authoredShaderId = runtimeMaterialShaderId(pass.program.module, pass.name);
    const dispatchShaderId =
      materialProgramKeys === undefined ? authoredShaderId : materialProgramKeys[pass.name];
    if (materialProgramKeys !== undefined && dispatchShaderId === undefined)
      throw new Error(`Missing published material program for Pass ${pass.name}`);
    pendingDispatch.push({
      entityIndex: entity,
      materialHandle,
      renderableIndex,
      passIndex: passIndexOffset + pIdx,
      queue: passState.queue ?? 2000,
      layer,
      // Cooked Forward/Deferred artifacts have different byte identities.
      // Temporal still projects their shared authored geometry/opacity once.
      tags:
        materialProgramKeys !== undefined &&
        isCanonicalStandardPbrMaterialShader(authoredShaderId) &&
        passState.tags?.SurfaceKind !== 'full-custom'
          ? {
              ...passState.tags,
              SurfaceKind: 'standard',
              ...(pass.program.moduleSlots?.surface === undefined
                ? {}
                : { SurfaceModule: pass.program.moduleSlots.surface }),
              GeometryVariant:
                passState.tags?.GeometryVariant ??
                (isStandardPbrSkinMaterialShader(authoredShaderId) ? 'skinned' : 'rigid'),
            }
          : (passState.tags ?? {}),
      renderState: pipelineRenderState(passState, pass.outputs),
      // Material module identity is already closed in the cooked program.
      // It must never become a draw-time define map.
      defines: undefined,
      vertexEntry: pass.program.vertexEntry,
      fragmentEntry: pass.program.fragmentEntry,
      materialShaderId: dispatchShaderId,
      ...(passState.stencilReference !== undefined && {
        stencilReference: passState.stencilReference,
      }),
    });
  }
}

/**
 * Row access for an uncompacted GPU-lane frame. Every row outside
 * `residual(selection)` is drawn by `selection`, so frame consumers visit
 * residual rows and changes, never the whole frame.
 */
export interface GpuOwnedFrame {
  /** Draw rows keeping a CPU-recorded draw under `selection`, in slot order. */
  residual(selection: GpuDrawSelection): readonly RenderableSnapshot[];
  /** Slot set of the same residual rows, retained from topology and selection diffs. */
  residualSet(selection: GpuDrawSelection): import('./scene/frame-set').FrameSet;
  /** Scene rows of the same residual set; readers of Scene facts never resolve frame rows. */
  residualSlots(
    selection: GpuDrawSelection,
  ): readonly import('./scene/render-scene-types').RenderSceneSlot[];
  /** Whether the frame's material query gives a row a display (non-ShadowCaster) Pass. */
  displays(row: RenderableSnapshot): boolean;
  /** One frame row by source identity, without enumerating the frame. */
  row(worldId: number, entity: number): RenderableSnapshot | undefined;
  /** The slot roster the frame covers. */
  readonly slots: import('./scene/scene-slots').SceneSlotFrame;
}

/**
 * Fixed evidence of one frame's camera admission. Between two frames of the
 * same cull, `cameraVisible` can answer differently only for slots in either
 * `hidden` diff or `residual` diff, and, when `frusta` differ, for slots
 * outside `residual`, whose rows are tested on demand.
 */
export interface CameraAdmission {
  /** Residual slots the camera rejects. */
  readonly hidden: import('./scene/frame-set').FrameSet;
  /** Slots the residual cull tests. */
  readonly residual: import('./scene/frame-set').FrameSet;
  /** Equal identities carry equal camera frusta. */
  readonly frusta: object;
}

export interface ExtractedFrame {
  readonly projectedDecals?: readonly import('./decals/extract').ProjectedDecalSnapshot[];
  readonly cameras: CameraSnapshot[];
  /** Auxiliary target cameras selected after the display camera is fixed. */
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  /** Cube capture intents extracted beside the display camera in one pass. */
  readonly cubeCameras: readonly CubeCameraSnapshot[];
  /** Reflection probe facts projected from the same World extraction. */
  readonly reflectionProbes?: readonly ReflectionProbeFact[];
  readonly lights: LightRoster;
  /** Resource-owner environment facts selected once at the extract boundary. */
  readonly environment: EnvironmentFrame | undefined;
  /** False when the resource-owner world failed environment/fog selection. */
  readonly environmentReady: boolean;
  /** One resource-owner volume projection; absent means no authored fog. */
  readonly volumetricFog?: ExtractedVolumetricFog;
  /** Resource-owner CloudLayer facts selected once at the extract boundary. */
  readonly cloudLayer?: import('./cloud/extract').ExtractedCloudLayer;
  readonly renderables: FrameList<RenderableSnapshot>;
  /**
   * Single dispatch list sorted by queue value (ascending, stable sort).
   * Replaces the old opaqueDispatch / transparentDispatch / overlayDispatch
   * three-bucket model per plan-strategy D-3.
   */
  readonly dispatch: DispatchList;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  /** World-local diffuse probe candidates; never a direct-light slot. */
  readonly lightProbes?: readonly LightProbeSnapshot[];
  readonly skybox: SkyboxSnapshot | undefined;
  readonly skyboxCount: number;
  /** Resource-owner Fog facts selected once at the frame boundary. */
  readonly fog: FogFrame | undefined;
  /** Last invalid Fog update retained alongside the current valid/LKG frame. */
  readonly fogFailure?: FogSelectionFailure;
  /**
   * feat-20260528-frustum-culling M3 / w11: frustum culling statistics
   * collected during the extract phase. `total` is the count of entities
   * that reached the culling decision point; `culled` is the count of
   * those that were removed from renderables by frustum culling.
   */
  readonly frustumStats: { readonly culled: number; readonly total: number };
  /** Current camera-frustum rejects kept in persistent GPU admission. */
  readonly cameraVisible?: ((source: RenderableSnapshot) => boolean) | undefined;
  /** Fixed evidence of `cameraVisible`: what may answer differently since another frame. */
  readonly cameraAdmission?: CameraAdmission | undefined;
  /** Present when an uncompacted GPU-lane frame leaves GPU-owned rows unenumerated. */
  readonly gpuOwned?: GpuOwnedFrame;
  /** Candidate entities rejected by author visibility before resource parsing. */
  readonly visibilityStats: { readonly explicitlyHidden: number };
  /** Detached material-source probe accounting for this extraction. */
  readonly materialTextureSources?: MaterialTextureSourceStats;
  /**
   * Per-frame post-process params snapshot collected from PostProcessParams
   * entities (D-1: data-driven params channel). Maps shader id to the
   * raw data bytes (Uint8Array = FieldValueType<'buffer'>). Last-one-wins
   * when multiple entities bear the same shader id.
   * Empty map when no PostProcessParams entities exist.
   */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
  /** Visibility snapshots prepared for each contributing World. */
  readonly visibilitySnapshots: readonly VisibilitySnapshot[];
  /** World-labelled snapshots passed to generic RenderFeature extraction. */
  readonly featureVisibilitySnapshots: readonly RenderFeatureWorldVisibilitySnapshot[];
  /** Built-in hidden candidates, retained for host-side producer deduplication. */
  readonly hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[];
}

export type CameraTargetUpdate = 'once' | 'on-demand' | 'continuous';

export interface CameraTargetCandidate {
  readonly worldId: number;
  readonly entityKey: number;
  readonly target?: RenderTarget;
  /** Written layer of `target`; omitted means layer 0. */
  readonly targetLayer?: number;
  readonly requestVersion: number;
  readonly update: CameraTargetUpdate;
}

export interface CameraTargetRejection {
  readonly entityKey: number;
  readonly reason: 'budget' | 'display-target' | 'duplicate-target';
}

export interface CameraTargetSelection {
  readonly display: CameraTargetCandidate | undefined;
  readonly auxiliary: readonly CameraTargetCandidate[];
  readonly rejected: readonly CameraTargetRejection[];
}

export function selectCameraTargetViews(
  candidates: readonly CameraTargetCandidate[],
  options: { readonly displayEntityKey?: number; readonly budget: number },
): CameraTargetSelection {
  const display = candidates.find(
    (candidate) =>
      candidate.entityKey === options.displayEntityKey && candidate.target === undefined,
  );
  const rejected: CameraTargetRejection[] = [];
  const ordered = candidates
    .filter((candidate) => candidate.target !== undefined)
    .sort((left, right) => left.worldId - right.worldId || left.entityKey - right.entityKey);
  const auxiliary: CameraTargetCandidate[] = [];
  // The budget counts targets, not writers: every distinct-layer writer of a
  // selected layered target records in the same frame, so one frame fills
  // all authored layers of that target.
  const seenLayers = new Map<RenderTarget, Set<number>>();
  const selectedTargets = new Set<RenderTarget>();
  for (const candidate of ordered) {
    const layer = candidate.targetLayer ?? 0;
    const layers = candidate.target === undefined ? undefined : seenLayers.get(candidate.target);
    const duplicate = layers?.has(layer) ?? false;
    if (candidate.target !== undefined) {
      if (layers === undefined) seenLayers.set(candidate.target, new Set([layer]));
      else layers.add(layer);
    }
    if (candidate.entityKey === options.displayEntityKey) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'display-target' });
      continue;
    }
    if (candidate.target === undefined || duplicate) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'duplicate-target' });
      continue;
    }
    if (
      !selectedTargets.has(candidate.target) &&
      selectedTargets.size >= Math.max(0, options.budget)
    ) {
      rejected.push({ entityKey: candidate.entityKey, reason: 'budget' });
      continue;
    }
    selectedTargets.add(candidate.target);
    auxiliary.push(candidate);
  }
  return {
    display,
    auxiliary: Object.freeze(auxiliary),
    rejected: Object.freeze(rejected),
  };
}

/**
 * Internal world surface used by extract for archetype-graph traversal and
 * error routing. The packed `Entity` handle for a row is read directly from
 * the essential id=0 `Entity` column (`arch.columns.get(Entity.id).get('self')`)
 * -- no generation lookup / encodeEntity rebuild (feat-20260602 M2).
 */
type RenderErrorContext = {
  readonly systemName: string;
  /** Retained as diagnostic metadata for legacy render call sites. */
  readonly severity?: 'error' | 'warning';
};

type ArrayFieldView = ArrayLike<number>;

/**
 * Render's old zero-copy ECS calls now use the explicit public projection
 * boundary. The optimized ECS owner keeps storage behind `World`; render
 * receives a detached array snapshot and routes failures through the same
 * projection owner.
 */
export type WorldInternalView = {
  _routeError(error: unknown, ctx: RenderErrorContext): void;
  _getArrayView<N extends string, S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<N, S>,
    fieldName: string,
  ): ArrayFieldView | undefined;
};

export const Severity = Object.freeze({ Error: 'error', Warning: 'warning' } as const);

export function createWorldInternalView(world: World): WorldInternalView {
  return {
    _routeError(error, ctx) {
      routeWorldError(world, error, { systemName: ctx.systemName });
    },
    _getArrayView(entity, component, fieldName) {
      return readRenderArrayView(world, entity, component, fieldName) as ArrayFieldView | undefined;
    },
  };
}

export function resolveCameraTarget(
  world: World,
  raw: number | undefined,
): RenderTarget | undefined {
  if (raw === undefined || raw <= 0) return undefined;
  const resolved = world.sharedRefs.resolve<'RenderTarget', RenderTarget>(
    toShared<'RenderTarget'>(Math.round(raw)),
  );
  return resolved.ok ? resolved.value : undefined;
}

/** Full authored map vocabulary when a Standard shader has not registered yet. */
export const BUILTIN_MATERIAL_TEXTURE_FIELDS: readonly string[] = [
  ...derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA).textureFieldNames,
];
const BUILTIN_MATERIAL_TEXTURE_FIELD_SET = new Set(BUILTIN_MATERIAL_TEXTURE_FIELDS);
const BUILTIN_BASE_COLOR_TEXTURE_FIELD_SET = new Set(['baseColorTexture']);

export function materialTextureFields(
  shaderId: string | undefined,
  fields: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (fields !== undefined && fields.size > 0) return fields;
  if (
    shaderId === 'forgeax::default-standard-pbr' ||
    shaderId === 'forgeax::default-standard-pbr-skin' ||
    shaderId === 'forgeax::pbr-skin'
  ) {
    return BUILTIN_MATERIAL_TEXTURE_FIELD_SET;
  }
  if (
    shaderId === 'forgeax::default-unlit' ||
    shaderId === 'forgeax::sprite' ||
    shaderId === 'forgeax::sprite-lit'
  ) {
    return BUILTIN_BASE_COLOR_TEXTURE_FIELD_SET;
  }
  return fields;
}

function declaredMaterialTextureFields(
  shaderId: string | undefined,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  assets: AssetRegistry,
): ReadonlySet<string> | undefined {
  return materialTextureFields(
    shaderId,
    paramSchema !== undefined
      ? derive(paramSchema).textureFieldNames
      : shaderId !== undefined
        ? assets.materialShaderTextureFieldNames(shaderId)
        : undefined,
  );
}

/** Preserve authored-vs-default intent for the GPU resource readiness gate. */
export function collectAuthoredMaterialTextureFields(
  values: Readonly<Record<string, unknown>>,
  shaderId: string | undefined,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  assets: AssetRegistry,
): ReadonlySet<string> | undefined {
  const fields = declaredMaterialTextureFields(shaderId, paramSchema, assets);
  if (fields === undefined) return undefined;
  const authored = new Set<string>();
  for (const field of fields) {
    if (Object.hasOwn(values, field)) authored.add(field);
  }
  return authored.size === 0 ? undefined : authored;
}

/** Preserve explicit sampler intent; omitted samplers use the default sampler. */
export function collectAuthoredMaterialSamplerFields(
  values: Readonly<Record<string, unknown>>,
  textureFields: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  const authored = new Set<string>();
  for (const field of textureFields ?? []) {
    if (materialTextureValue(values[field])?.sampler !== undefined) authored.add(field);
  }
  if (Object.hasOwn(values, 'sampler') && values.sampler !== undefined) {
    authored.add('baseColorTexture');
  }
  return authored.size === 0 ? undefined : authored;
}

export { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';

/**
 * Select the runtime identity for one resolved material. A cooked publication
 * owns the composed material artifact identity; the authored pass module is
 * the built-in fallback used before that publication is ready.
 */
export function materialProgramKeysForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  vertexColorAvailable = false,
): Readonly<Record<string, string>> | undefined {
  return materialProgramKeysForAddress(material, assets, context, 'direct', vertexColorAvailable);
}

/** Raster remains usable without a ray program; a ray consumer must refuse that absence. */
export function materialSurfaceProgramsForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  effective: Parameters<typeof rayMaterialNeedsCoverage>[0],
): MaterialSnapshot['materialSurfacePrograms'] {
  if (
    context === undefined ||
    context.backend === 'webgl2' ||
    context.capability === 'uniform-fallback' ||
    context.geometry !== 'mesh' ||
    context.instrumentation !== 'none'
  )
    return undefined;
  const projection = materialProjectionForSelection(material, assets);
  const pass = material.passes?.find((entry) => entry.name.toLowerCase() === 'forward');
  if (projection === undefined || pass === undefined) return undefined;
  const programs: NonNullable<MaterialSnapshot['materialSurfacePrograms']> = {};
  for (const surfaceContext of ['ray-hit', 'card-capture'] as const) {
    try {
      const selected = findMaterialPassProgram(projection, pass.name, {
        backend: context.backend,
        capability: 'storage-buffer',
        pipeline: 'ray',
        geometry: 'mesh',
        pass: surfaceContext,
        profile: 'forgeax-material-ray-v1',
        toolchain: context.toolchain,
        instrumentation: 'none',
      });
      if (selected === undefined) continue;
      Object.assign(programs, {
        [surfaceContext]:
          surfaceContext === 'ray-hit'
            ? {
                programKey: selected.specializationKey,
                evaluateCoverage: rayMaterialNeedsCoverage(effective),
              }
            : { programKey: selected.specializationKey },
      });
    } catch (error) {
      if (
        isMissingMaterialProgram(error) &&
        (error as { detail?: { matches?: number } }).detail?.matches === 0
      )
        continue;
      throw error;
    }
  }
  return Object.keys(programs).length === 0 ? undefined : programs;
}

/**
 * Return the exact direct/scene-index programs selected for one renderer
 * context.  The selection result is kept next to the key projection so
 * consumers that validate a mesh contract can inspect the producer ABI
 * without rebuilding pass/context matching from payload order.
 */
export interface MaterialProgramSelection {
  readonly pass: string;
  readonly context: MaterialCookRasterContext;
  readonly specializationKey: string;
  readonly abi?: MaterialProgramAbi;
}

function materialProjectionForSelection(material: MaterialAsset, assets: AssetRegistry) {
  const projection = assets.getMaterialProjectionForPayload(material);
  assertMaterialStaticSelection(material.staticSwitches, projection);
  return projection;
}

export function materialProgramSelectionsForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  address: 'direct' | 'scene-index' = 'direct',
  vertexColorAvailable = false,
): readonly MaterialProgramSelection[] | undefined {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined) return undefined;
  if (context === undefined)
    throw new Error('Published material selection requires renderer-owned compiler context');
  return (material.passes ?? []).map((pass) => {
    const mode = String(
      (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
    );
    const selectedContext = materialProgramContextForPass(context, mode);
    const selected = selectMaterialPassProgram(
      projection,
      pass.name,
      selectedContext,
      address,
      vertexColorAvailable,
    );
    return {
      pass: pass.name,
      context: selectedContext,
      specializationKey: selected.specializationKey,
      ...(selected.abi === undefined ? {} : { abi: selected.abi }),
    };
  });
}

/** Freeze lineage from the accepted payload and its already selected programs. */
export function materialPublicationForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  selected: readonly MaterialProgramSelection[] | undefined,
  vertexColorAvailable = false,
): MaterialSnapshot['materialPublication'] {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined || selected === undefined) return undefined;
  return Object.freeze({
    identity: Object.freeze({
      materialGuid: projection.materialGuid,
      publicationGeneration: projection.publicationGeneration,
      specializationKey: projection.specializationKey,
      artifactHash: projection.artifactHash,
    }),
    programs: Object.freeze(
      selected.map((program) =>
        Object.freeze({
          pass: program.pass,
          context: Object.freeze({ ...program.context }),
          address: 'direct' as const,
          specializationKey: program.specializationKey,
          artifactHash: selectMaterialPassProgram(
            projection,
            program.pass,
            program.context,
            'direct',
            vertexColorAvailable,
          ).artifactHash,
        }),
      ),
    ),
  });
}

/** Resolve the producer's scene-index program key for each cooked Pass. */
export function materialSceneIndexProgramKeysForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  vertexColorAvailable = false,
): Readonly<Record<string, MaterialSceneIndexProgramKey>> | undefined {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined) return undefined;
  if (context === undefined)
    throw new Error('Published material selection requires renderer-owned compiler context');
  const entries: Record<string, MaterialSceneIndexProgramKey> = {};
  for (const pass of material.passes ?? []) {
    const mode = String(
      (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
    );
    const selectedContext = materialProgramContextForPass(context, mode);
    try {
      const selected = findMaterialPassProgram(
        projection,
        pass.name,
        selectedContext,
        'scene-index',
        vertexColorAvailable,
      );
      if (selected === undefined) continue;
      entries[pass.name] = {
        specializationKey: selected.specializationKey,
        pass: selectedContext.pass,
      };
    } catch (error) {
      if (!isMissingMaterialProgram(error)) throw error;
    }
  }
  return Object.keys(entries).length === 0 ? undefined : entries;
}

function isMissingMaterialProgram(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === 'material-specialization-not-cooked'
  );
}

function materialProgramKeysForAddress(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  address: 'direct' | 'scene-index',
  vertexColorAvailable = false,
): Readonly<Record<string, string>> | undefined {
  const selections = materialProgramSelectionsForMaterial(
    material,
    assets,
    context,
    address,
    vertexColorAvailable,
  );
  return selections === undefined
    ? undefined
    : Object.fromEntries(
        selections.map(({ pass, specializationKey }) => [pass, specializationKey]),
      );
}

/** The authored Surface/root defines semantics; cooked program hashes do not. */
export function materialSurfaceModel(
  passes: readonly MaterialPass[],
  declared: MaterialSurfaceModel | undefined,
): MaterialSurfaceModel | undefined {
  if (declared !== undefined) return declared;
  const authored = runtimeMaterialShaderIdForMaterial(passes, undefined);
  return isCanonicalStandardPbrMaterialShader(authored) &&
    !passes.some(
      (pass) =>
        (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.SurfaceKind ===
        'full-custom',
    )
    ? 'standard'
    : undefined;
}

export function pipelineRenderState(
  renderState:
    | (MaterialRenderState & {
        readonly tags?: Readonly<Record<string, string>>;
        readonly queue?: number;
        readonly stencilReference?: number;
      })
    | undefined,
  outputs?: MaterialPass['outputs'],
): MaterialRenderState | undefined {
  if (renderState === undefined && outputs === undefined) return undefined;
  const {
    cullMode,
    depthCompare,
    depthWriteEnabled,
    colorWriteMask,
    depthBias,
    depthBiasSlopeScale,
    depthBiasClamp,
    blend,
    alphaToCoverageEnabled,
    stencil,
    stencilReadMask,
    stencilWriteMask,
    frontFace,
    fog,
  } = renderState ?? {};
  const projected: MaterialRenderState = {
    ...(outputs !== undefined && { outputs }),
    ...(cullMode !== undefined && { cullMode }),
    ...(depthCompare !== undefined && { depthCompare }),
    ...(depthWriteEnabled !== undefined && { depthWriteEnabled }),
    ...(colorWriteMask !== undefined && { colorWriteMask }),
    ...(depthBias !== undefined && { depthBias }),
    ...(depthBiasSlopeScale !== undefined && { depthBiasSlopeScale }),
    ...(depthBiasClamp !== undefined && { depthBiasClamp }),
    ...(blend !== undefined && { blend }),
    ...(alphaToCoverageEnabled !== undefined && { alphaToCoverageEnabled }),
    ...(stencil !== undefined && { stencil }),
    ...(stencilReadMask !== undefined && { stencilReadMask }),
    ...(stencilWriteMask !== undefined && { stencilWriteMask }),
    ...(frontFace !== undefined && { frontFace }),
    ...(fog !== undefined && { fog }),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export function resolveRuntimeAssetReference<K extends string>(
  world: RenderResourceScope,
  reference: string | import('@forgeax/engine-types').AssetGuid | AssetHandle<K>,
  kind: K,
): AssetHandle<K> | undefined {
  if (typeof reference === 'number') {
    const asset = world.resolveAsset(reference);
    return asset.ok && asset.value.kind === kind ? reference : undefined;
  }
  const guid = typeof reference === 'string' ? reference : AssetGuid.format(reference);
  const handle = world.handleForGuid(guid);
  if (handle === undefined) return undefined;
  const asset = world.resolveAsset(handle);
  return asset.ok && asset.value.kind === kind ? (handle as AssetHandle<K>) : undefined;
}

/** Select the bound VideoAsset; frame ownership stays with VideoSourceProvider. */
export function resolveVideoFieldHandle(
  value: unknown,
  world: RenderResourceScope,
  _assetsRef: AssetRegistry,
): AssetHandle<'video'> | undefined {
  const texture = materialTextureValue(value);
  const reference = texture?.texture ?? value;
  if (typeof reference === 'number')
    return resolveRuntimeAssetReference(world, reference as AssetHandle<'video'>, 'video');
  const guid = assetReferenceText(reference);
  return guid === undefined ? undefined : resolveRuntimeAssetReference(world, guid, 'video');
}

export function materialTextureValue(value: unknown): MaterialTextureValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const textureValue = value as Partial<MaterialTextureValue>;
  return typeof textureValue.texture === 'number' ||
    typeof textureValue.texture === 'string' ||
    textureValue.texture instanceof Uint8Array ||
    isRenderTextureSourceToken(textureValue.source)
    ? (textureValue as MaterialTextureValue)
    : undefined;
}

export function assetReferenceText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array && isAssetGuidBytes(value)) return AssetGuid.format(value);
  return undefined;
}

export function isAssetGuidBytes(value: Uint8Array): value is AssetGuidBytes {
  return value.byteLength === 16;
}

export function materialNormalScale(
  values: Readonly<Record<string, unknown>>,
): readonly [number, number] {
  const scale = values.normalScale;
  return Array.isArray(scale) &&
    scale.length === 2 &&
    Number.isFinite(scale[0]) &&
    Number.isFinite(scale[1])
    ? [scale[0], scale[1]]
    : [1, 1];
}

const standardRoughness = STANDARD_PIPELINE_PARAM_SCHEMA.find(
  (entry) => entry.name === 'roughness',
);
const DEFAULT_MATERIAL_ROUGHNESS = Number(
  standardRoughness?.type === 'f32' ? standardRoughness.default : undefined,
);

/** Value projection shared by primary and secondary material extraction. */
export function materialValueSnapshot(
  values: Readonly<Record<string, unknown>>,
): Pick<
  MaterialSnapshot,
  | 'baseColor'
  | 'metallic'
  | 'roughness'
  | 'specularColor'
  | 'normalScale'
  | 'emissive'
  | 'emissiveIntensity'
  | 'occlusionStrength'
> & { paramSnapshot: Record<string, number | number[] | string> } {
  const baseColor = values.baseColor as readonly number[] | undefined;
  const specularColor = values.specularColor as readonly number[] | undefined;
  const emissive = values.emissive as readonly number[] | undefined;
  const paramSnapshot: Record<string, number | number[] | string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number' || typeof value === 'string') paramSnapshot[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
      paramSnapshot[key] = value;
    }
  }
  return {
    baseColor: vec3.create(baseColor?.[0] ?? 1, baseColor?.[1] ?? 1, baseColor?.[2] ?? 1),
    metallic: typeof values.metallic === 'number' ? values.metallic : 0,
    roughness: typeof values.roughness === 'number' ? values.roughness : DEFAULT_MATERIAL_ROUGHNESS,
    normalScale: materialNormalScale(values),
    ...(specularColor !== undefined && {
      specularColor: [specularColor[0] ?? 1, specularColor[1] ?? 1, specularColor[2] ?? 1] as const,
    }),
    ...(emissive !== undefined && {
      emissive: [emissive[0] ?? 0, emissive[1] ?? 0, emissive[2] ?? 0] as const,
    }),
    ...(typeof values.emissiveIntensity === 'number' && {
      emissiveIntensity: values.emissiveIntensity,
    }),
    ...(typeof values.occlusionStrength === 'number' && {
      occlusionStrength: values.occlusionStrength,
    }),
    paramSnapshot,
  };
}

export function materialTextureRef(value: unknown): unknown {
  return materialTextureValue(value)?.texture ?? value;
}

export function collectMaterialTextureCoordinates(
  values: Readonly<Record<string, unknown>>,
): Map<string, MaterialTextureCoordinates> {
  const out = new Map<string, MaterialTextureCoordinates>();
  // Texture transforms belong to the value itself. Walking every authored
  // value keeps the route closed when Standard gains another physical map
  // without adding another renderer-side field inventory.
  for (const [field, value] of Object.entries(values)) {
    if (!field.endsWith('Texture')) continue;
    const coordinates = materialTextureValue(value)?.coordinates;
    if (coordinates !== undefined) out.set(field, coordinates);
  }
  return out;
}

/**
 * Return the schema-owned fields that may carry a texture source handle.
 * Numeric material values are otherwise scalar parameters (roughness,
 * metallic, custom steps, ...), so probing them through SharedRefStore is
 * both wasted work and an accidental dependency on slot-number collisions.
 */
export function materialTextureSourceFields(
  schema: readonly ParamSchemaEntry[] | undefined,
): ReadonlySet<string> | undefined {
  if (schema === undefined) return undefined;
  const fields = new Set<string>();
  for (const entry of schema) {
    if (entry.type.startsWith('texture')) fields.add(entry.name);
  }
  return fields;
}

export interface MaterialTextureSourceStats {
  sourceFieldsVisited: number;
  producerRoutes: Record<string, number>;
}

/** Read only declared material source slots; no World handles or consumer lookup. */
export function collectMaterialTextureSources(
  values: Readonly<Record<string, unknown>>,
  textureFields?: ReadonlySet<string>,
  stats?: MaterialTextureSourceStats,
): Map<string, MaterialTextureSource> {
  const out = new Map<string, MaterialTextureSource>();
  for (const [field, value] of Object.entries(values)) {
    if (textureFields !== undefined && !textureFields.has(field)) continue;
    if (stats !== undefined) stats.sourceFieldsVisited += 1;
    const source = materialTextureValue(value)?.source;
    if (!isRenderTextureSourceToken(source)) continue;
    if (stats !== undefined) {
      stats.producerRoutes[source.source] = (stats.producerRoutes[source.source] ?? 0) + 1;
    }
    out.set(field, source as MaterialTextureSource);
  }
  return out;
}

export function collectMaterialTextureSamplers(
  values: Readonly<Record<string, unknown>>,
  resolveSampler: (value: unknown) => AssetHandle<'sampler'> | undefined,
): Map<string, AssetHandle<'sampler'>> {
  const out = new Map<string, AssetHandle<'sampler'>>();
  for (const [field, value] of Object.entries(values)) {
    const sampler = resolveSampler(materialTextureValue(value)?.sampler);
    if (sampler !== undefined) out.set(field, sampler);
  }
  const legacySampler = resolveSampler(values.sampler);
  if (legacySampler !== undefined && !out.has('baseColorTexture')) {
    out.set('baseColorTexture', legacySampler);
  }
  return out;
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): collect the
 * user-region texture handles for a material by iterating the shader's
 * `derive(paramSchema).textureFieldNames` SSOT (via
 * `AssetRegistry.materialShaderTextureFieldNames`). Each declared texture
 * field whose paramValue resolves to a handle lands in the returned map keyed
 * by field name; this is the single path through which an arbitrary number of user-region
 * textures (8 Standard or 9+ custom, e.g. parallax `heightTexture`) flow.
 *
 * When the shader is not registered the built-in Standard field set is used
 * so standard materials still resolve. Emissive and occlusion are ordinary
 * schema-driven user-region textures in that set.
 *
 * feat-20260623-world-space-video-asset M4 / w14 (D-5): a field whose paramValue
 * catalogues to a VideoAsset is routed into `videoOut` (a VideoAsset-branded
 * handle) instead of the TextureAsset map, so the record stage pulls its view
 * from the transient DynamicTextureStore (D-3) rather than the static
 * ensureResident cache (AC-08). The video GUID still has to be in this
 * `textureFieldNames` traversal set or it is never inspected (R-7) — that
 * membership is asserted in w13.
 */
export function collectUserRegionTextureHandles(
  pv: Readonly<Record<string, unknown>>,
  shaderId: string | undefined,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
  assetsRef: AssetRegistry,
  world: RenderResourceScope,
  resolveTex: (value: unknown, brand: 'texture') => AssetHandle<'texture'> | undefined,
  videoOut: Map<string, AssetHandle<'video'>>,
): Map<string, AssetHandle<'texture'>> {
  const fields =
    materialTextureFields(
      shaderId,
      paramSchema !== undefined
        ? derive(paramSchema).textureFieldNames
        : shaderId !== undefined
          ? assetsRef.materialShaderTextureFieldNames(shaderId)
          : undefined,
    ) ?? BUILTIN_MATERIAL_TEXTURE_FIELDS;
  const out = new Map<string, AssetHandle<'texture'>>();
  for (const field of fields) {
    // D-5: a video-kind paramValue is routed to the transient path (videoOut),
    // NOT minted as a TextureAsset (which would crash the record-stage
    // ensureResident, AC-08). A static field falls through to resolveTex.
    const videoHandle = resolveVideoFieldHandle(pv[field], world, assetsRef);
    if (videoHandle !== undefined) {
      videoOut.set(field, videoHandle);
      continue;
    }
    const handle = resolveTex(materialTextureRef(pv[field]), 'texture');
    if (handle !== undefined) out.set(field, handle);
  }
  return out;
}

interface StandardSampleInputs {
  readonly textureHandles: ReadonlyMap<string, number>;
  readonly samplerHandles: ReadonlyMap<string, number>;
  readonly textureCoordinates: ReadonlyMap<string, MaterialTextureCoordinates>;
}

function sameSampleCoordinates(
  a: MaterialTextureCoordinates | undefined,
  b: MaterialTextureCoordinates | undefined,
): boolean {
  return (
    (a?.set ?? 0) === (b?.set ?? 0) &&
    (a?.transform?.offset?.[0] ?? 0) === (b?.transform?.offset?.[0] ?? 0) &&
    (a?.transform?.offset?.[1] ?? 0) === (b?.transform?.offset?.[1] ?? 0) &&
    (a?.transform?.scale?.[0] ?? 1) === (b?.transform?.scale?.[0] ?? 1) &&
    (a?.transform?.scale?.[1] ?? 1) === (b?.transform?.scale?.[1] ?? 1) &&
    (a?.transform?.rotation ?? 0) === (b?.transform?.rotation ?? 0) &&
    (a?.physicalUvScale?.[0] ?? 1) === (b?.physicalUvScale?.[0] ?? 1) &&
    (a?.physicalUvScale?.[1] ?? 1) === (b?.physicalUvScale?.[1] ?? 1)
  );
}

export function materialStandardTextureMask(
  parameters: readonly MaterialParameter[] | undefined,
  shaderId: string | undefined,
  values: Readonly<Record<string, unknown>>,
  sampling?: StandardSampleInputs,
): number | undefined {
  // The stock depth writer consumes the same Standard texture override even
  // when it is the material's only pass (for example a camera-layer caster).
  if (
    !isCanonicalStandardPbrMaterialShader(shaderId) &&
    shaderId !== 'forgeax::default-shadow-caster'
  )
    return undefined;
  const presence = standardTextureMask(
    // Canonical materials may provide values without redeclaring the root
    // schema. Pruning must agree with the texture binder in that route too.
    DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
      (entry) =>
        entry.type === 'texture2d' &&
        (values[entry.name] !== undefined ||
          parameters?.some(
            (parameter) => parameter.name === entry.name && parameter.default !== undefined,
          )),
    ),
  );
  const projection = standardProjectionMask(
    (name) => values[name] ?? parameters?.find((parameter) => parameter.name === name)?.default,
  );
  if (sampling === undefined) return presence + projection;
  return (
    presence +
    projection +
    standardSampleReuseMask(presence, (source, target) => {
      const texture = sampling.textureHandles.get(source);
      if (texture === undefined || texture !== sampling.textureHandles.get(target)) return false;
      if (sampling.samplerHandles.get(source) !== sampling.samplerHandles.get(target)) return false;
      return sameSampleCoordinates(
        sampling.textureCoordinates.get(source),
        sampling.textureCoordinates.get(target),
      );
    })
  );
}

/**
 * Project one material's authoring parameters into the runtime ABI.
 *
 * Engine-owned Standard roots are compiled against the canonical superset
 * schema even when the authoring asset omits optional physical fields. A
 * compact authored schema would move later UBO members (for example `ior`)
 * into the wrong slots. Custom material roots keep their own published
 * parameter projection.
 */
export function materialParametersToParamSchema(
  parameters: readonly MaterialParameter[],
  shaderId?: string,
  registeredParamSchema?: readonly ParamSchemaEntry[],
): readonly ParamSchemaEntry[] {
  if (isCanonicalStandardPbrMaterialShader(shaderId)) return STANDARD_PIPELINE_PARAM_SCHEMA;
  // The selected program owns its immutable ABI. Empty manifest entries do
  // not describe an ABI and retain the authored/built-in fallback below.
  // Reusing an admitted layout avoids re-projecting author fields and deriving
  // the same layout on every value update.
  if (registeredParamSchema !== undefined && registeredParamSchema.length > 0)
    return registeredParamSchema;
  // Built-in programs keep their compiled ABI even when authoring declarations
  // reorder texture fields or include CPU-only inputs such as sprite flips.
  if (shaderId === 'forgeax::sprite' || shaderId === 'forgeax::sprite-lit')
    return DEFAULT_SPRITE_PARAM_SCHEMA;
  if (parameters.length === 0) {
    if (registeredParamSchema !== undefined) return registeredParamSchema;
  }
  return projectMaterialParametersToParamSchema(parameters);
}

/**
 * Select the parameter ABI for one resolved material. The canonical Standard
 * schema is valid only for the selected built-in program. A published program
 * uses its admitted parameter schema, even when its Surface module is
 * Engine-owned. Uncompiled custom Surfaces retain the authored projection.
 */
export function materialParamSchemaForMaterial(
  parameters: readonly MaterialParameter[],
  selectedShaderId: string | undefined,
  passes: readonly MaterialPass[],
  assets?: AssetRegistry,
): readonly ParamSchemaEntry[] {
  const firstPass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  const surfaceModule = firstPass?.program.moduleSlots?.surface;
  const schemaShaderId =
    surfaceModule === undefined || surfaceModule === DEFAULT_STANDARD_SURFACE_MODULE
      ? selectedShaderId
      : undefined;
  const registered =
    selectedShaderId === undefined ||
    (schemaShaderId === undefined &&
      selectedShaderId === runtimeMaterialShaderIdForMaterial(passes, undefined))
      ? undefined
      : assets?.shaderRegistry.materialArtifact(selectedShaderId);
  return materialParametersToParamSchema(parameters, schemaShaderId, registered?.paramSchema);
}

/**
 * Resolve color semantics from the material asset first and the shader schema
 * for fields the asset does not redeclare. Generated and historical pack
 * materials commonly omit `parameters`, while the shader registry still owns
 * the complete parameter contract.
 */
export function materialColorParameterSchema(
  parameters: readonly MaterialParameter[],
  shaderId: string | undefined,
  assets: AssetRegistry,
): readonly MaterialColorParameterSchema[] {
  if (shaderId === undefined) return parameters;
  const shader = assets.shaderRegistry.materialArtifact(shaderId);
  // Source Workers prepare values before a GPU owner installs built-in programs.
  // Color semantics use the same canonical fallback as their parameter ABI.
  const schema = materialParametersToParamSchema([], shaderId, shader?.paramSchema);
  if (schema.length === 0) return parameters;

  const byName = new Map<string, MaterialColorParameterSchema>(
    schema.map((parameter) => [parameter.name, parameter]),
  );
  for (const parameter of parameters) byName.set(parameter.name, parameter);
  return [...byName.values()];
}

export function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (!isDeepFrozen(child, seen)) return false;
  }
  return true;
}

/** Asset revisions validate the complete shared material without resolving its contents again. */
export function readPersistentMaterialSnapshot(
  cache: MaterialSnapshotCache | undefined,
  handleRaw: number,
  world: RenderResourceScope,
): MaterialSnapshotCacheEntry | undefined {
  const entry = cache?.get(handleRaw);
  return entry !== undefined && renderAssetRevision(world, handleRaw) === entry.assetRevision
    ? entry
    : undefined;
}

export function storeMaterialSnapshot(
  cache: MaterialSnapshotCache,
  handleRaw: number,
  snapshot: MaterialSnapshot,
  world: RenderResourceScope,
  programSelections?: readonly MaterialProgramSelection[],
): MaterialSnapshotCacheEntry {
  const accepted = { ...snapshot, immutableValues: true as const };
  const previous = cache.get(handleRaw);
  const resource = previous === undefined ? undefined : materialResource(previous.snapshot);
  if (resource === undefined) new MaterialResource(accepted);
  else resource.adopt(accepted);
  const entry: MaterialSnapshotCacheEntry = {
    snapshot: accepted,
    ...(programSelections === undefined ? {} : { programSelections }),
    assetRevision: renderAssetRevision(world, handleRaw) ?? 0,
  };
  cache.set(handleRaw, entry);
  return entry;
}

/** Shared preparation for first use, submesh bindings and asset-only adoption. */
export function prepareMaterialSnapshot({
  handle: handleRaw,
  world,
  assets: assetsRef,
  material: programOwner,
  programSelections,
  materialContext,
  textureSourceStats: materialTextureSourceStats,
  vertexColorAvailable = false,
  geometry = materialContext?.geometry ?? 'mesh',
}: {
  readonly handle: number;
  readonly world: RenderResourceScope;
  readonly assets: AssetRegistry;
  readonly material: MaterialAsset;
  readonly programSelections: readonly MaterialProgramSelection[] | undefined;
  readonly materialContext?: MaterialCookRasterContext | undefined;
  readonly textureSourceStats?: MaterialTextureSourceStats | undefined;
  readonly vertexColorAvailable?: boolean;
  readonly geometry?: MaterialCookRasterContext['geometry'];
}): MaterialSnapshot {
  const resolved = {
    passes: programOwner.passes ?? [],
    parameters: programOwner.parameters ?? [],
    values: programOwner.values ?? {},
    colorSpace: programOwner.colorSpace,
    surface: programOwner.surface,
  };
  const allPasses = resolved.passes;
  const materialProgramKeys =
    programSelections === undefined
      ? undefined
      : Object.fromEntries(
          programSelections.map(({ pass, specializationKey }) => [pass, specializationKey]),
        );
  const materialSceneIndexProgramKeys = materialSceneIndexProgramKeysForMaterial(
    programOwner,
    assetsRef,
    materialContext,
    vertexColorAvailable,
  );
  const materialSurfacePrograms = materialSurfaceProgramsForMaterial(
    programOwner,
    assetsRef,
    materialContext,
    resolved,
  );
  const firstPassShader = runtimeMaterialShaderIdForMaterial(allPasses, materialProgramKeys);
  const pv = materialValuesToLinearRuntime(
    resolved.values,
    materialColorParameterSchema(resolved.parameters ?? [], firstPassShader, assetsRef),
    resolved.colorSpace,
  ) as Readonly<Record<string, unknown>>;
  const valueSnapshot = materialValueSnapshot(pv);
  const paramSnap = valueSnapshot.paramSnapshot;

  const materialParamSchema = materialParamSchemaForMaterial(
    resolved.parameters ?? [],
    firstPassShader,
    allPasses,
    assetsRef,
  );
  const resolveTexLike = <B extends string>(
    value: unknown,
    brand: B,
  ): AssetHandle<B> | undefined => {
    if (typeof value === 'number') {
      const asset = world.resolveAsset(value);
      return asset.ok && asset.value.kind === brand ? (value as AssetHandle<B>) : undefined;
    }
    const guid = assetReferenceText(value);
    return guid === undefined ? undefined : resolveRuntimeAssetReference(world, guid, brand);
  };
  const authoredTextureFields = collectAuthoredMaterialTextureFields(
    resolved.values,
    firstPassShader,
    materialParamSchema.length > 0 ? materialParamSchema : undefined,
    assetsRef,
  );
  const authoredSamplerFields = collectAuthoredMaterialSamplerFields(
    resolved.values,
    authoredTextureFields,
  );
  const authoredShader = runtimeMaterialShaderIdForMaterial(allPasses, undefined);
  if (authoredShader === 'forgeax::sprite' || authoredShader === 'forgeax::sprite-lit') {
    const region = paramSnap.region;
    const values = typeof region === 'object' ? region : undefined;
    paramSnap.region = spriteUvRegion(values, 0, 0);
    paramSnap.flipX = typeof pv.flipX === 'number' ? pv.flipX : 0;
    paramSnap.flipY = typeof pv.flipY === 'number' ? pv.flipY : 0;
    paramSnap.slicesAndMode ??= [0, 0, 0, 0];
  }
  const videoTextureFields = new Map<string, AssetHandle<'video'>>();
  const textureHandles = collectUserRegionTextureHandles(
    pv,
    firstPassShader,
    materialParamSchema.length > 0 ? materialParamSchema : undefined,
    assetsRef,
    world,
    resolveTexLike,
    videoTextureFields,
  );
  const samplerHandles = collectMaterialTextureSamplers(pv, (value) =>
    resolveTexLike(materialTextureRef(value), 'sampler'),
  );
  if (authoredShader === 'forgeax::sprite' || authoredShader === 'forgeax::sprite-lit') {
    const slices = paramSnap.slicesAndMode;
    if (Array.isArray(slices) && (slices[3] ?? 0) < 0) {
      const handle = samplerHandles.get('baseColorTexture');
      const sampler = handle === undefined ? undefined : world.resolveAsset(handle);
      if (
        sampler?.ok &&
        sampler.value.kind === 'sampler' &&
        (sampler.value.addressModeU !== 'repeat' || sampler.value.addressModeV !== 'repeat')
      )
        assetsRef.metrics?.increment('nineslice.tile-needs-repeat-sampler');
    }
  }
  const textureSources = collectMaterialTextureSources(
    pv,
    materialTextureSourceFields(materialParamSchema.length > 0 ? materialParamSchema : undefined),
    materialTextureSourceStats,
  );
  const emissiveTextureHandle = textureHandles.get('emissiveTexture');
  const occlusionTextureHandle = textureHandles.get('occlusionTexture');
  const textureCoordinates = collectMaterialTextureCoordinates(pv);
  // Named user-region fields are derived from the map (sprite + legacy reads).
  const baseColorTextureHandle = textureHandles.get('baseColorTexture');
  const metallicRoughnessTextureHandle = textureHandles.get('metallicRoughnessTexture');
  const normalTextureHandle = textureHandles.get('normalTexture');

  const surfaceModel = materialSurfaceModel(allPasses, resolved.surface?.model);
  const materialEntryPoints: Record<
    string,
    readonly import('@forgeax/engine-types').ShaderEntryPointReads[]
  > = {};
  let positionBounds: MaterialProgramAbi['positionBounds'] =
    allPasses.length === 0 ? undefined : 'standard-input';
  for (const pass of allPasses) {
    const key =
      materialProgramKeys?.[pass.name] ?? runtimeMaterialShaderId(pass.program.module, pass.name);
    const shader =
      key === undefined ? undefined : assetsRef.shaderRegistry.findMaterialArtifact(key);
    if (
      shader?.ok !== true ||
      shader.value.receipt?.positionBounds !== 'standard-input' ||
      (geometry === 'skinned' &&
        (shader.value.receipt === undefined || !materialProgramUsesSkin(shader.value.receipt)))
    )
      positionBounds = undefined;
    const reads = shader?.ok ? shader.value.program.entryPoints : undefined;
    if (reads !== undefined) materialEntryPoints[pass.name] = reads;
  }
  const snapshot: MaterialSnapshot = {
    ...(positionBounds === undefined ? {} : { positionBounds }),
    materialContext: { geometry, vertexColor: vertexColorAvailable },
    passes: allPasses,
    ...valueSnapshot,
    ...(surfaceModel === undefined ? {} : { surfaceModel }),
    deferredPass: allPasses.some(
      (pass) =>
        String(
          (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
        ) === 'Deferred',
    ),
    materialShaderId: firstPassShader,
    materialProgramKeys,
    materialEntryPoints,
    materialPublication: materialPublicationForMaterial(
      programOwner,
      assetsRef,
      programSelections,
      vertexColorAvailable,
    ),
    materialSceneIndexProgramKeys,
    materialSurfacePrograms,
    materialHandle: handleRaw,
    renderState: pipelineRenderState(allPasses[0]?.renderState, allPasses[0]?.outputs),
    ...(materialParamSchema.length > 0 && { materialParamSchema }),
    standardTextureMask: materialStandardTextureMask(resolved.parameters, firstPassShader, pv, {
      textureHandles,
      samplerHandles,
      textureCoordinates,
    }),
    ...(textureCoordinates.size > 0 && { textureCoordinates }),
    ...(authoredTextureFields === undefined ? {} : { authoredTextureFields }),
    ...(authoredSamplerFields === undefined ? {} : { authoredSamplerFields }),
    ...(textureHandles.size > 0 && { textureHandles }),
    ...(textureSources.size > 0 && { textureSources }),
    ...(videoTextureFields.size > 0 && { videoTextureFields }),
    ...(samplerHandles.size > 0 && { samplerHandles }),
    ...(baseColorTextureHandle !== undefined && { baseColorTexture: baseColorTextureHandle }),
    ...(metallicRoughnessTextureHandle !== undefined && {
      metallicRoughnessTexture: metallicRoughnessTextureHandle,
    }),
    ...(normalTextureHandle !== undefined && { normalTexture: normalTextureHandle }),
    ...(emissiveTextureHandle !== undefined && { emissiveTexture: emissiveTextureHandle }),
    ...(occlusionTextureHandle !== undefined && { occlusionTexture: occlusionTextureHandle }),
    // feat-city-glb Bug 5 (per-submesh transparency): derive `transparent`
    // from the first pass's `renderState.blend` presence, identical to the
    // entity-level snapshot builder (extractFrame archetype loop). Without
    // this, per-submesh materials (materials[i>=1], e.g. a glTF BLEND decal
    // submesh on a multi-material mesh) never carry the transparent flag, so
    // the record stage's LDR split + blend routing treats them as opaque and
    // their alpha=0 texels composite as black.
    transparent: allPasses[0]?.renderState?.blend !== undefined,
  };
  return snapshot;
}

/** Resolve one accepted material through the renderer's context-local cache. */
export function resolveMaterialSnapshot(
  handleRaw: number,
  world: RenderResourceScope,
  assetsRef: AssetRegistry,
  materialSnapshotCache?: MaterialSnapshotCache,
  persistentMaterialSnapshotCache?: MaterialSnapshotCache,
  materialContext?: MaterialCookRasterContext,
  materialTextureSourceStats?: MaterialTextureSourceStats,
  vertexColorAvailable = false,
  geometry: MaterialCookRasterContext['geometry'] = materialContext?.geometry ?? 'mesh',
): MaterialSnapshot {
  if (world.world?.assets !== undefined) assetsRef = runtimeAssetRegistry(world.world.assets);
  if (handleRaw === 0) return defaultMaterialSnapshot(handleRaw);
  const cached = materialSnapshotCache?.get(handleRaw);
  if (cached !== undefined) return cached.snapshot;
  const stablePersistentCached = readPersistentMaterialSnapshot(
    persistentMaterialSnapshotCache,
    handleRaw,
    world,
  );
  if (stablePersistentCached !== undefined) {
    materialSnapshotCache?.set(handleRaw, stablePersistentCached);
    return stablePersistentCached.snapshot;
  }
  const tagged = handleRaw as AssetHandle<'material'>;
  const res = world.resolveAsset(tagged);
  if (!res.ok) return defaultMaterialSnapshot(handleRaw);
  const asset = res.value;
  if (asset.kind !== 'material') return defaultMaterialSnapshot(handleRaw);
  const programSelections = materialProgramSelectionsForMaterial(
    asset,
    assetsRef,
    materialContext,
    'direct',
    vertexColorAvailable,
  );
  const snapshot = prepareMaterialSnapshot({
    handle: handleRaw,
    world,
    assets: assetsRef,
    material: asset,
    programSelections,
    materialContext,
    textureSourceStats: materialTextureSourceStats,
    vertexColorAvailable,
    geometry,
  });
  const cache = persistentMaterialSnapshotCache ?? materialSnapshotCache;
  const cacheEntry =
    cache === undefined
      ? undefined
      : storeMaterialSnapshot(cache, handleRaw, snapshot, world, programSelections);
  if (cacheEntry !== undefined) {
    materialSnapshotCache?.set(handleRaw, cacheEntry);
  }
  return cacheEntry?.snapshot ?? snapshot;
}

/**
 * PSSM (Parallel-Split Shadow Maps) split plane computation.
 *
 * Formula (plan-strategy D-8, research F1):
 *   C_i = λ·n·(f/n)^(i/m) + (1-λ)·(n + i/m·(f-n))
 *   where i = 1..m, n = near, f = far, m = cascadeCount
 *
 * The coverage range is [camera near, DirectionalLight.shadowDistance] — the
 * near end derives from the active camera, the far end is the shadowDistance
 * knob. Returns strictly monotonic view-space z depths (positive).
 *
 * When `far <= near + ε` (ε=1e-6), throws ShadowInvalidConfigError
 * (charter P3 explicit failure — research F2 guarantees formula stability
 * but degenerate configuration must be surfaced to the caller).
 *
 * @param nearPlane - near of the shadow casting range (from the camera near)
 * @param farPlane - far of the shadow casting range (DirectionalLight.shadowDistance)
 * @param cascadeCount - number of cascades (1..4)
 * @param splitLambda - PSSM split weight (0 = pure uniform, 1 = pure log)
 * @returns Array of m split depths (view-space z); length = cascadeCount,
 *   guaranteed strictly monotonic, last element = far.
 *
 * @internal exported for w6/w7 testing only; production callers route through
 *   extractFrame which validates cascadeCount/splitLambda via component schema.
 */
export function pssmSplit(
  nearPlane: number,
  farPlane: number,
  cascadeCount: number,
  splitLambda: number,
): Float32Array {
  const EPS = 1e-6;
  if (farPlane <= nearPlane + EPS) {
    throw new ShadowInvalidConfigError('shadowDistance', farPlane, {
      kind: 'lower-bound',
      value: nearPlane + EPS,
      operator: '>=',
    });
  }

  const result = new Float32Array(cascadeCount);
  const m = cascadeCount;
  const n = nearPlane;
  const f = farPlane;
  const ratio = f / n;

  for (let i = 1; i <= m; i++) {
    const t = i / m;
    const logPart = n * ratio ** t;
    const uniformPart = n + t * (f - n);
    result[i - 1] = splitLambda * logPart + (1 - splitLambda) * uniformPart;
  }

  return result;
}

// feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-5 (plan-strategy §D-3,
// requirements §5.3): 6-face view-proj matrix table for one omnidirectional
// shadow caster.
//
/**
 * Build 6 face view-proj matrices for an omnidirectional shadow caster
 * (point-light cube map). Returns 6 mat4 (column-major 16-float each) in face
 * order [+X, -X, +Y, -Y, +Z, -Z] matching the WebGPU cube-camera layer
 * convention.
 *
 * Derive face directions from the shared CubeCamera owner, then reflect clip X
 * to match WebGPU cubemap texel orientation. The point-shadow raster lane
 * mirrors authored front-face winding when it uses these reflected matrices.
 *
 * The returned `Mat4[]` length is always exactly 6. Caller can flatten into a
 * 96-float (6 mat4) Float32Array for UBO upload (T-M1-7).
 *
 * @param lightPos world-space position of the point light (from companion Transform)
 * @param near near plane distance (PointLightShadow.nearPlane)
 * @param far  far plane distance  (PointLightShadow.farPlane)
 */
export function buildPointShadowMatrices(lightPos: Vec3, near: number, far: number): Mat4[] {
  return buildCubeCameraFaceViews({ position: lightPos, near, far }).map(({ viewProjection }) => {
    for (const offset of [0, 4, 8, 12]) viewProjection[offset] = -(viewProjection[offset] ?? 0);
    return viewProjection;
  });
}

/**
 * bug-20260710-editor-cross-world-shadow: the camera-frustum subset of
 * {@link CameraSnapshot} that the directional-CSM matrix builder consumes.
 * Extracted so the builder can run both inside {@link extractFrame} (single
 * world) AND at the {@link extractFrames} merge layer, where the camera and the
 * directional light may originate in DIFFERENT worlds (the editor
 * editorWorld/sceneWorld super-composite). A cameraless world produces zero
 * lightViewProj matrices, so the merge layer MUST recompute using the surfaced
 * camera — see {@link computeDirectionalCsm}.
 */
/** The camera facts a directional cascade fit reads. */
export const CSM_CAMERA_KEYS = [
  'world',
  'fov',
  'aspect',
  'near',
  'far',
  'projection',
  'orthoLeft',
  'orthoRight',
  'orthoBottom',
  'orthoTop',
  'projectionOffset',
] as const satisfies readonly (keyof CameraSnapshot)[];

export type CsmCameraData = Pick<CameraSnapshot, (typeof CSM_CAMERA_KEYS)[number]>;

/**
 * The raw directional-shadow config a DirectionalLight carries on its
 * {@link LightRoster}; each view fits its cascades from it.
 */
export interface DirectionalCsmConfig {
  readonly shadowMapAspect?: number;
  readonly shadowCasterChannels?: number;
  readonly shadowAutoUpdate?: boolean;
  readonly shadowRevision?: number;
  /** Explicit reverse-Z world-to-clip projection, otherwise camera-fitted CSM. */
  readonly shadowViewProjection?: Float32Array;
  readonly shadowBiasMode?: number;
  readonly shadowRadius?: number;
  readonly shadowIntensity?: number;
  readonly shadowBlurSamples?: number;
  /** Authored CPU cascade cadence; absent means disabled. */
  readonly staggerCascades?: boolean;
  /** `false` drops the GPU-driven static cascade layer; absent means enabled. */
  readonly staticShadowCache?: false;
  readonly cascadeCount: number;
  readonly splitLambda: number;
  readonly cascadeBlend: number;
  readonly mapSize: number;
  readonly shadowDistance: number;
  readonly shadowFilter: number;
  readonly shadowAngularRadius: number;
  readonly maxPenumbraTexels: number;
}

/**
 * bug-20260710-editor-cross-world-shadow: computed directional-CSM output —
 * the per-cascade light-view-projection matrices plus the derived cascade
 * metadata. Returned by {@link computeDirectionalCsm}; `undefined` when the
 * config or camera is missing (caller leaves the fields undefined).
 */
export interface DirectionalCsmResult {
  readonly lightViewProj: Float32Array[];
  readonly splitPlanes: Float32Array;
  readonly cascadeCount: number;
  readonly cascadeBlend: number;
  readonly shadowMapSize: number;
  readonly directionalShadowQuality: DirectionalShadowQuality;
}

/** Pages per directional cascade edge; a cascade center snaps to whole pages. */
const DIRECTIONAL_SHADOW_PAGES = 16;

/** Cascade calls may reenter through public camera getters. */
function createSliceSphereScratch() {
  return {
    inverse: mat4.create(),
    world: mat4.create(),
    axis: vec3.create(),
    forward: vec3.create(),
    origin: vec3.create(),
    right: vec3.create(),
    up: vec3.create(),
  };
}
const sliceSphereFrames = [createSliceSphereScratch()];
let sliceSphereDepth = 0;

/**
 * World-space bounding sphere of the camera view slice between view depths
 * `near` and `far`. The radius derives only from the projection parameters,
 * so it is identical for every camera orientation and position.
 */
function cascadeSliceSphere(
  camera: CsmCameraData,
  near: number,
  far: number,
): { readonly center: Vec3; readonly radius: number } {
  let scratch = sliceSphereFrames[sliceSphereDepth];
  if (scratch === undefined) {
    scratch = createSliceSphereScratch();
    sliceSphereFrames[sliceSphereDepth] = scratch;
  }
  sliceSphereDepth++;
  try {
    return computeSliceSphere(camera, near, far, scratch);
  } finally {
    sliceSphereDepth--;
  }
}

function computeSliceSphere(
  camera: CsmCameraData,
  near: number,
  far: number,
  scratch: ReturnType<typeof createSliceSphereScratch>,
): { readonly center: Vec3; readonly radius: number } {
  // A singular camera transform reads as identity, matching mat4.invert.
  // Every scratch below is fully overwritten before it is read.
  const world = mat4.invert(scratch.world, mat4.invert(scratch.inverse, camera.world));
  const forward = vec3.normalize(
    scratch.forward,
    vec3.set(scratch.axis, -(world[8] as number), -(world[9] as number), -(world[10] as number)),
  );
  const origin = vec3.set(
    scratch.origin,
    world[12] as number,
    world[13] as number,
    world[14] as number,
  );
  let depth: number;
  let radius: number;
  let offsetX = 0;
  let offsetY = 0;
  if (camera.projection === 'orthographic') {
    const halfWidth = (camera.orthoRight - camera.orthoLeft) * 0.5;
    const halfHeight = (camera.orthoTop - camera.orthoBottom) * 0.5;
    offsetX =
      (camera.orthoRight + camera.orthoLeft) * 0.5 -
      (camera.projectionOffset?.[0] ?? 0) * halfWidth;
    offsetY =
      (camera.orthoTop + camera.orthoBottom) * 0.5 -
      (camera.projectionOffset?.[1] ?? 0) * halfHeight;
    depth = (near + far) * 0.5;
    radius = Math.hypot(halfWidth, halfHeight, (far - near) * 0.5);
  } else {
    const tanY = Math.tan(camera.fov * 0.5);
    const tanX = tanY * camera.aspect;
    const slope = tanX * tanX + tanY * tanY;
    depth = Math.min(far, (near + far) * 0.5 * (1 + slope));
    // Off-axis lenses shear both axes; retain an orientation-invariant enclosure.
    const shearX = -(camera.projectionOffset?.[0] ?? 0) * tanX;
    const shearY = -(camera.projectionOffset?.[1] ?? 0) * tanY;
    offsetX = shearX * depth;
    offsetY = shearY * depth;
    radius = Math.sqrt((far - depth) ** 2 + far * far * slope) + Math.hypot(shearX, shearY) * far;
  }
  const right = vec3.normalize(
    scratch.right,
    vec3.set(scratch.axis, world[0] as number, world[1] as number, world[2] as number),
  );
  const up = vec3.normalize(
    scratch.up,
    vec3.set(scratch.axis, world[4] as number, world[5] as number, world[6] as number),
  );
  const center = vec3.create(
    (origin[0] as number) +
      (forward[0] as number) * depth +
      (right[0] as number) * offsetX +
      (up[0] as number) * offsetY,
    (origin[1] as number) +
      (forward[1] as number) * depth +
      (right[1] as number) * offsetX +
      (up[1] as number) * offsetY,
    (origin[2] as number) +
      (forward[2] as number) * depth +
      (right[2] as number) * offsetX +
      (up[2] as number) * offsetY,
  );
  return { center, radius };
}

/** Retain a page until its receiver sphere and upstream caster reach leave its guard band. */
function retainedCascadeCovers(
  retained: Float32Array | undefined,
  current: Float32Array,
  sphere: { readonly center: Vec3; readonly radius: number },
  casterReach: number,
  mapSize: number,
  filterRadius: number,
  normalBiasWorld: number,
): retained is Float32Array {
  if (retained === undefined || retained.length !== 16) return false;
  // Equal linear terms prove the same light basis, resolution and depth span.
  // Only translation may differ: never stretch a retained depth publication.
  for (let index = 0; index < 12; index += 1) {
    if (retained[index] !== current[index]) return false;
  }
  const center = mat4.transformVec3(vec3.create(), retained, sphere.center);
  const scale = (row: number) =>
    Math.hypot(retained[row] ?? 0, retained[row + 4] ?? 0, retained[row + 8] ?? 0);
  // Keep the filter footprint inside the existing guard; no larger map/extent.
  const edge = 1 - (2 * (filterRadius + SHADOW_RASTER_GUARD_TEXELS)) / mapSize;
  const radius = sphere.radius + Math.abs(normalBiasWorld);
  return (
    Math.abs(center[0] ?? Number.NaN) + radius * scale(0) <= edge &&
    Math.abs(center[1] ?? Number.NaN) + radius * scale(1) <= edge &&
    (center[2] ?? Number.NaN) - radius * scale(2) >= 0 &&
    (center[2] ?? Number.NaN) + (radius + casterReach) * scale(2) <= 1
  );
}

/**
 * bug-20260710-editor-cross-world-shadow: pure directional-CSM matrix builder,
 * extracted verbatim from the former inline block in {@link extractFrame} (the
 * PSSM split + per-cascade frustum-slice AABB fit + orthographic light
 * projection). It is now a free function so BOTH the per-world extract and the
 * cross-world merge layer can call it — the merge layer is the only place that
 * pairs the first-hit directional light of one world with the surfaced camera
 * of another (editor super-composite). Returns `null` when there is no camera
 * to fit against (a cameraless world's directional light yields no matrices —
 * the caller leaves lightViewProj undefined rather than emitting zero matrices
 * that the WGSL reader would sample as NaN → "fully lit").
 *
 * Keeps the prior PSSM lambda, toward-light Z reach RC-2 fix, and clip-space
 * matrix / tile-placement-in-shader split. The XY fit is additionally snapped
 * to the cascade's shadow-texel grid so camera motion cannot continuously
 * shimmer a receiver across raster texel boundaries.
 */
export function computeDirectionalCsm(
  direction: Vec3,
  config: DirectionalCsmConfig,
  cameraData: CsmCameraData | undefined,
  retainedMatrices?: readonly Float32Array[],
  normalBiasWorld = 0.05,
): DirectionalCsmResult | null {
  const cascadeCount = Math.round(config.cascadeCount);
  const quality = directionalShadowQualityFromF32(
    config.shadowFilter ?? (DirectionalLight.fields.shadowFilter.default as number),
    config.shadowAngularRadius ?? (DirectionalLight.fields.shadowAngularRadius.default as number),
    config.maxPenumbraTexels ?? (DirectionalLight.fields.maxPenumbraTexels.default as number),
  );
  if (quality === undefined) return null;
  if (config.shadowViewProjection !== undefined) {
    const matrix = config.shadowViewProjection;
    const rowLength = (row: number) =>
      Math.hypot(matrix[row] ?? 0, matrix[row + 4] ?? 0, matrix[row + 8] ?? 0);
    const splitPlanes = new Float32Array(16);
    splitPlanes[0] = 3.4028234663852886e38;
    splitPlanes[1] = 2 / rowLength(0) / config.mapSize;
    splitPlanes[2] = 1 / rowLength(2);
    return {
      lightViewProj: [
        new Float32Array(matrix),
        ...Array.from({ length: 3 }, () => new Float32Array(16)),
      ],
      splitPlanes,
      cascadeCount: 1,
      cascadeBlend: 0,
      shadowMapSize: config.mapSize,
      directionalShadowQuality: quality,
    };
  }
  const filterRadius = directionalShadowFilterRadiusTexels(quality);
  // Coverage range: near from the active camera near (no separate near knob);
  // far is capped by both the component's shadowDistance and camera far. Fallback near (0.1) only when no
  // camera exists — but matrices are gated on cameraData below anyway.
  const sNear = cameraData?.near ?? 0.1;
  const sFar = Math.min(config.shadowDistance, cameraData?.far ?? config.shadowDistance);

  // PSSM covers only the active camera frustum, capped by the light range.
  const splits = pssmSplit(sNear, sFar, cascadeCount, config.splitLambda);
  // Light view matrix: camera at origin, looking along the light direction.
  const lightDirN = vec3.normalize(vec3.create(), direction);
  const lightTarget = vec3.create(lightDirN[0] ?? 0, lightDirN[1] ?? 0, lightDirN[2] ?? 0);
  const lightView = mat4.create();
  mat4.lookAt(lightView, vec3.create(0, 0, 0), lightTarget, vec3.create(0, 1, 0));

  // Camera view-projection for frustum-corner computation. Without a camera the
  // frustum cannot be fit — bail so the caller emits no matrices (undefined),
  // NOT zero matrices (which read as NaN in the shadow shader → no shadow).
  if (cameraData === undefined) return null;
  const resultLightViewProjs: Float32Array[] = [];
  const cascadeFits: DirectionalShadowCascadeFit[] = [];
  const full = cascadeSliceSphere(cameraData, sNear, sFar);
  const pageTexels = config.mapSize / DIRECTIONAL_SHADOW_PAGES;
  const usableTexels = config.mapSize - 2 * pageTexels;

  for (let cIdx = 0; cIdx < 4; cIdx++) {
    if (cIdx >= cascadeCount) {
      resultLightViewProjs.push(new Float32Array(16));
      continue;
    }
    // The receiver blends into this cascade before the preceding split.
    // Fit that same overlap instead of sampling outside the next projection.
    const previousSplit = splits[cIdx - 1] ?? sNear;
    const cascadeNear =
      cIdx === 0 ? sNear : Math.max(sNear, previousSplit * (1 - config.cascadeBlend));
    const cascadeFar = splits[cIdx] ?? sFar;
    // A bounding sphere of the slice keeps the extent independent of camera
    // rotation, and snapping its light-space center to whole pages keeps the
    // projection bit-identical until the camera crosses a page. One page of
    // margin on every side contains the sphere across any snap. The retained
    // shadow cache compares matrices exactly, so this stability is what lets
    // a moving camera reuse unchanged cascades.
    const sphere = cascadeSliceSphere(cameraData, cascadeNear, cascadeFar);
    const center = vec3.create();
    mat4.transformVec3(center, lightView, sphere.center);
    const texel = (2 * sphere.radius) / usableTexels;
    const page = pageTexels * texel;
    const snap = (value: number) => Math.round(value / page) * page;
    const centerX = snap(center[0] ?? 0);
    const centerY = snap(center[1] ?? 0);
    const centerZ = snap(center[2] ?? 0);
    const half = sphere.radius + page;
    const minX = centerX - half;
    const maxX = centerX + half;
    const minY = centerY - half;
    const maxY = centerY + half;
    const minZ = centerZ - half;
    // A receiver's caster can sit behind the display camera, toward the light
    // beyond the receiver slice. Reaching past the whole shadow range's sphere
    // admits every such caster without a rotation-dependent bound.
    const nearZ = centerZ + half + 2 * full.radius;
    const orthoProj = mat4.create();
    mat4.orthographicReverseZ(orthoProj, minX, maxX, maxY, minY, -nearZ, -minZ);
    // lightViewProj = orthoProj * lightView — pure clip-space [-1,1]. Atlas
    // tile placement is handled by the per-cascade viewport + fragment-side UV
    // math (evalDirectional), so shadow_caster.gl_Position stays clip-space.
    cascadeFits.push({
      split: splits[cIdx] ?? sFar,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ: nearZ,
    });
    const matrix = new Float32Array(mat4.multiply(mat4.create(), orthoProj, lightView));
    const retained = retainedMatrices?.[cIdx];
    resultLightViewProjs.push(
      retainedCascadeCovers(
        retained,
        matrix,
        sphere,
        2 * full.radius,
        config.mapSize,
        filterRadius,
        normalBiasWorld,
      )
        ? retained
        : matrix,
    );
  }

  const projection = projectDirectionalShadow(
    cascadeFits,
    config.mapSize,
    config.shadowFilter ?? (DirectionalLight.fields.shadowFilter.default as number),
    config.shadowAngularRadius ?? (DirectionalLight.fields.shadowAngularRadius.default as number),
    config.maxPenumbraTexels ?? (DirectionalLight.fields.maxPenumbraTexels.default as number),
  );
  if (projection === undefined) return null;

  return {
    lightViewProj: resultLightViewProjs,
    splitPlanes: projection.splitPlanes,
    cascadeCount,
    cascadeBlend: config.cascadeBlend,
    shadowMapSize: config.mapSize,
    directionalShadowQuality: projection.directionalShadowQuality,
  };
}

/**
 * feat-20260709-editor-world-partition M1 / w4 (AC-08, plan-strategy §2 D-3):
 * the owner index that previously served BOTH cameras and singleton render
 * resources (skylight / skybox / postProcessParams) is split into two
 * independent indices. `cameraOwner` selects the world whose cameras are
 * surfaced; `resourceOwner` selects the world whose singleton resources are
 * surfaced. A single number is accepted as the backward-compatible legacy form
 * where `cameraOwner === resourceOwner === owner` (single-world callers +
 * frame-loop stay byte-identical; the hard `{ owner }` cutover lands in M2).
 */
export interface ExtractFramesOwner {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  /** Explicit display-camera entity selected by the frame owner. */
  readonly cameraEntityKey?: number;
}

export interface PreparedExtractContext {
  readonly materialContext?: MaterialCookRasterContext | undefined;
  readonly assets: AssetRegistry | null | undefined;
  readonly materialSnapshotContexts: MaterialSnapshotContexts;
  /** `undefined` keeps direct extractFrame's local Fog semantics; `null` means
   * the frame owner already selected that no Fog is present for this world. */
  readonly resourceOwnerFog: FogFrame | null | undefined;
  readonly cull: 'self' | 'none' | 'external';
  readonly cullCameras: readonly CameraSnapshot[] | undefined;
  /** Explicit display-camera entity for this world's camera-owner extract. */
  readonly cameraEntityKey?: number;
  readonly viewExtent?: PhysicalViewExtent;
  readonly renderables: 'full' | 'none';
  readonly renderableEntities: ReadonlySet<number> | undefined;
  readonly retainHidden: boolean;
  readonly preparationMesh?: {
    readonly entity: number;
    readonly meshHandle: AssetHandle<'mesh'>;
    readonly mesh: MeshAsset;
  };
  /** World identity used to form cross-world producer ownership keys. */
  readonly worldId: number;
  readonly visibility: VisibilitySnapshot;
  /** Producer-owned artifact lookup; extraction only, never record-time asset reads. */
  readonly getMaterialShaderArtifact:
    | ((
        materialShaderId: string,
        request?: {
          readonly vertexColorAvailable?: boolean;
          readonly deformation?: 'rigid' | 'skin';
          readonly variantSet?: string;
          readonly pass?: 'forward' | 'shadow' | 'depth';
          readonly address?: 'direct' | 'scene-index';
        },
      ) => MaterialShaderArtifact | undefined)
    | undefined;
  /** Renderer-private projection of World-authored instance matrices. */
  readonly instanceCollections: InstanceProjectionStore | undefined;
  /** Retains this World's environment entries until one of their inputs changes. */
  readonly environmentGate?: EnvironmentFrameGate;
}

/** The change-driven environment owner of a source's extraction. */
export type EnvironmentFrameGate = import('./extract/environment-gate').EnvironmentGate<
  import('./render-system-extract-tail').WorldEnvironmentPart,
  ReturnType<typeof import('./render-system-extract-tail').mergeEnvironment>
>;

const ALL_VISIBLE: VisibilitySnapshot = {
  diagnostics: [],
  hasAnyIntent: false,
  hasAnyHiddenIntent: false,
  get: () => undefined,
  effective: () => 'visible',
};

function collectCameraSnapshots(world: World): CameraSnapshot[] {
  const cameras: CameraSnapshot[] = [];
  const cameraQuery = world
    .query({
      read: [Camera],
      optional: [
        CameraView,
        MotionBlur,
        DynamicResolution,
        ScreenSpaceReflection,
        AmbientOcclusion,
        DepthOfField,
        BarrelDistortion,
        LensEffects,
        LensFlare,
        ClippingPlanes,
        Outline,
        PlanarReflection,
        StereoCamera,
      ],
      with: [Transform, GlobalTransform],
    })
    .unwrap();
  for (const row of cameraQuery) {
    const cam = row.get(Camera);
    const cameraView = row.get(CameraView);
    const clipping = extractClippingPlanes(row.get(ClippingPlanes));
    const planar = row.get(PlanarReflection);
    if (planar !== undefined && cam.target !== 0 && cameraView === undefined)
      throw new PlanarReflectionInvalidError('camera');
    if (planar !== undefined && (planar.target === 0 || planar.updateIntervalFrames < 1))
      throw new PlanarReflectionInvalidError(
        planar.target === 0 ? 'target' : 'updateIntervalFrames',
      );
    const motionBlur = row.get(MotionBlur);
    const barrelDistortion = row.get(BarrelDistortion);
    const lensEffects = resolveLensEffects(row.get(LensEffects));
    if (!lensEffects.ok) throw lensEffects.error;
    const lensFlare = resolveLensFlare(row.get(LensFlare));
    if (!lensFlare.ok) throw lensFlare.error;
    const outline = resolveOutline(row.get(Outline));
    if (!outline.ok) throw outline.error;
    const motionBlurResult = resolveMotionBlurParams(motionBlur);
    if (!motionBlurResult.ok) throw motionBlurResult.error;
    const motionBlurParams = motionBlurResult.value;
    const depthOfField = row.get(DepthOfField);
    const dynamicResolution = row.get(DynamicResolution);
    const screenSpaceReflection = row.get(ScreenSpaceReflection);
    const ambientOcclusion = row.get(AmbientOcclusion);
    const projection = cameraProjectionFromF32(cam.projection);
    const depthOfFieldResult = resolveDepthOfFieldParams(depthOfField, {
      projection,
      fov: cam.fov,
      near: cam.near,
      far: cam.far,
    });
    const depthOfFieldError = depthOfFieldResult.ok
      ? undefined
      : depthOfFieldRequestFailure(depthOfFieldResult.error);
    const entity = row.entity;
    const view = readEnvironmentPose(world, entity);
    if (view === undefined) continue;
    const worldMat = new Float32Array(view);
    const target = resolveCameraTarget(world, cam.target);
    const hasNonDefaultOutput =
      cam.exposureMode !== CAMERA_EXPOSURE_MODE_MANUAL ||
      cam.exposure !== 1 ||
      cam.temperature !== 6504 ||
      cam.tint !== 0 ||
      cam.colorLut !== 0 ||
      cam.colorLutStrength !== Camera.fields.colorLutStrength.default;
    const output = hasNonDefaultOutput
      ? {
          exposure: cameraExposureFromColumns(cam),
          temperature: cam.temperature,
          tint: cam.tint,
          colorLut: cam.colorLut,
          colorLutStrength: cam.colorLutStrength,
        }
      : undefined;
    const antialias = antialiasFromF32(cam.antialias);
    const dynamicResolutionResult = validateDynamicResolutionCamera(dynamicResolution, antialias);
    if (!dynamicResolutionResult.ok) throw dynamicResolutionResult.error;
    const barrelDistortionResult = validateBarrelDistortionParameters(barrelDistortion);
    if (!barrelDistortionResult.ok) throw barrelDistortionResult.error;
    const stereoData = row.get(StereoCamera);
    const stereo =
      stereoData === undefined
        ? undefined
        : resolveStereoCamera(stereoData, {
            projection,
            near: cam.near,
            target: target !== undefined,
            planarReflection: planar !== undefined,
          });
    // A stereo camera always composes as a view; without CameraView it covers the screen.
    const composedView = cameraView ?? (stereo === undefined ? undefined : CAMERA_VIEW_DEFAULTS);
    const snapshot: CameraSnapshot = {
      entityKey: entity as number,
      ...(composedView === undefined
        ? {}
        : {
            view: {
              viewport: new Float32Array(composedView.viewport),
              order: composedView.order,
              resolutionScale: composedView.resolutionScale,
              updateInterval: composedView.updateInterval,
              enabled: composedView.enabled,
            },
          }),
      ...(stereo === undefined ? {} : { stereo }),
      ...(target === undefined ? {} : { target }),
      ...(target === undefined || cam.targetLayer === 0 ? {} : { targetLayer: cam.targetLayer }),
      historyVersion: cam.historyVersion,
      position: mat4.getTranslation(vec3.create(), worldMat),
      world: worldMat,
      fov: cam.fov,
      aspect: cam.aspect,
      autoAspect: cam.autoAspect,
      projectionOffset: validateCameraProjectionOffset(cam.projectionOffset),
      near: cam.near,
      far: cam.far,
      projection,
      orthoLeft: cam.left,
      orthoRight: cam.right,
      orthoBottom: cam.bottom,
      orthoTop: cam.top,
      tonemap: tonemapFromF32(cam.tonemap),
      exposure: cam.exposure,
      whitePoint: cam.whitePoint,
      ...(output === undefined ? {} : { output }),
      antialias,
      transparency: transparencyFromF32(cam.transparency),
      ...(dynamicResolutionResult.value === undefined
        ? {}
        : { dynamicResolution: dynamicResolutionResult.value }),
      bloom: validateCameraBloom(
        cam.bloom,
        cam.bloomThreshold,
        cam.bloomIntensity,
        cam.bloomSmoothWidth,
        cam.bloomRadius,
      ),
      bloomThreshold: cam.bloomThreshold,
      bloomIntensity: cam.bloomIntensity,
      bloomSmoothWidth: cam.bloomSmoothWidth,
      bloomRadius: cam.bloomRadius,
      clearColor: [
        cam.clearColor[0] ?? 0,
        cam.clearColor[1] ?? 0,
        cam.clearColor[2] ?? 0,
        cam.clearColor[3] ?? 1,
      ],
      ...(depthOfFieldResult.ok && depthOfFieldResult.value !== undefined
        ? { depthOfField: depthOfFieldResult.value }
        : {}),
      ...(depthOfFieldError === undefined ? {} : { depthOfFieldError }),
      ...(motionBlurParams === undefined
        ? {}
        : {
            motionBlur: {
              shutterAngle: motionBlurParams.shutterAngle,
              maxRadiusPixels: motionBlurParams.maxRadiusPixels,
              sampleCount: motionBlurParams.sampleCount,
              targetFps: motionBlurParams.targetFps,
            },
          }),
      ...(clipping === undefined ? {} : { clipping }),
      ...(outline.value === undefined ? {} : { outline: outline.value }),
      ...(lensEffects.value === undefined ? {} : { lensEffects: lensEffects.value }),
      ...(lensFlare.value === undefined ? {} : { lensFlare: lensFlare.value }),
      ...(barrelDistortion === undefined ? {} : { barrelDistortion: barrelDistortionResult.value }),
      ...(ambientOcclusion === undefined
        ? {}
        : {
            ambientOcclusion: {
              algorithm: ambientOcclusion.algorithm,
              radius: ambientOcclusion.radius,
              bias: ambientOcclusion.bias,
              intensity: ambientOcclusion.intensity,
              directLightingStrength: ambientOcclusion.directLightingStrength,
              quality: ambientOcclusion.quality,
              thickness: ambientOcclusion.thickness,
              distanceExponent: ambientOcclusion.distanceExponent,
              distanceFallOff: ambientOcclusion.distanceFallOff,
              resolutionScale: ambientOcclusion.resolutionScale,
            },
          }),
      ...(screenSpaceReflection === undefined
        ? {}
        : {
            screenSpaceReflection: {
              maxDistance: screenSpaceReflection.maxDistance,
              thickness: screenSpaceReflection.thickness,
              maxRoughness: screenSpaceReflection.maxRoughness,
            },
          }),
    };
    cameras.push(snapshot);
    if (planar !== undefined) {
      const reflectionTarget = resolveCameraTarget(world, planar.target);
      if (reflectionTarget === undefined) throw new PlanarReflectionInvalidError('target');
      const { view: _view, ...capture } = snapshot;
      const { target: _target, ...reflection } = planar;
      cameras.push({
        ...capture,
        target: reflectionTarget,
        planarReflection: { ...reflection, normal: new Float32Array(planar.normal) },
      });
    }
  }
  const planarTargets = new Set<RenderTarget>();
  const otherTargets = new Set(
    cameras
      .filter((camera) => camera.planarReflection === undefined)
      .map((camera) => camera.target),
  );
  for (const camera of collectCubeCameraSnapshots(world)) otherTargets.add(camera.target);
  for (const camera of cameras) {
    if (camera.planarReflection === undefined || camera.target === undefined) continue;
    if (planarTargets.has(camera.target) || otherTargets.has(camera.target))
      throw new PlanarReflectionInvalidError('target-writer');
    planarTargets.add(camera.target);
  }
  return cameras;
}

export function collectCubeCameraSnapshots(world: World): CubeCameraSnapshot[] {
  const snapshots: CubeCameraSnapshot[] = [];
  const query = world.query({ read: [CubeCamera], with: [Transform, GlobalTransform] }).unwrap();
  for (const row of query) {
    const camera = row.get(CubeCamera);
    const target = resolveCameraTarget(world, camera.target);
    if (target === undefined) continue;
    const view = readEnvironmentPose(world, row.entity);
    if (view === undefined) continue;
    snapshots.push({
      entityKey: row.entity as number,
      target,
      position: [view[12] ?? 0, view[13] ?? 0, view[14] ?? 0],
      near: camera.near,
      far: camera.far,
      updateIntent: cubeCameraUpdateIntentFromF32(camera.updateIntent),
      requestVersion: camera.requestVersion,
      faceBudget: camera.faceBudget,
    });
  }
  return snapshots;
}

export function collectReflectionProbeFacts(world: World): ReflectionProbeFact[] {
  const facts: ReflectionProbeFact[] = [];
  const query = world
    .query({ read: [ReflectionProbe], with: [Transform, GlobalTransform] })
    .unwrap();
  for (const row of query) {
    const probe = row.get(ReflectionProbe);
    const view = readEnvironmentPose(world, row.entity);
    if (view === undefined) {
      continue;
    }
    facts.push({
      worldId: 0,
      entityKey: row.entity as number,
      center: [view[12] ?? 0, view[13] ?? 0, view[14] ?? 0],
      halfExtents: [
        probe.halfExtents[0] ?? 0,
        probe.halfExtents[1] ?? 0,
        probe.halfExtents[2] ?? 0,
      ],
      priority: probe.priority,
      intensity: probe.intensity,
      resolution: probe.resolution,
      boxProjection: probe.boxProjection,
      revision: probe.invalidationVersion,
      updateIntent: reflectionProbeUpdateIntentFromF32(probe.updateIntent),
      invalidationVersion: probe.invalidationVersion,
    });
  }
  return facts;
}

interface CameraRoleSelection {
  readonly display: readonly CameraSnapshot[];
  readonly auxiliary: readonly CameraSnapshot[];
}

/** Both World extraction and publication rendering derive one camera's physical aspect here. */
export function cameraForView(
  cameras: readonly CameraSnapshot[],
  entityKey: number | undefined,
  extent: PhysicalViewExtent,
): CameraSnapshot | undefined {
  const camera = cameras.find(
    (item) => item.planarReflection === undefined && item.entityKey === entityKey,
  );
  if (camera === undefined) return undefined;
  const physical = {
    ...camera,
    aspect: camera.autoAspect === false ? camera.aspect : extent.width / extent.height,
  };
  // A stereo eye derives its offset and off-axis frustum from the physical aspect.
  return extent.eye === undefined ? physical : stereoEyeCamera(physical, extent.eye);
}

/**
 * Rebuild view-dependent planar captures from authoring facts and the selected
 * display camera. Non-planar auxiliary cameras are capture views, recorded by
 * their own view entity, never by a display recording.
 */
export function projectAuxiliaryCamerasForView(
  display: CameraSnapshot | undefined,
  auxiliary: readonly CameraSnapshot[],
): readonly CameraSnapshot[] {
  return auxiliary.flatMap((camera) => {
    const planar = camera.planarReflection;
    if (planar === undefined) return [];
    if (display === undefined || camera.entityKey !== display.entityKey) return [];
    const reflected = buildPlanarReflectionView({
      world: display.world,
      projection: computeProjectionMatrix(display),
      plane: [...planar.normal, planar.distance],
      clipBias: planar.clipBias,
    });
    if (reflected === undefined) return [];
    return [
      {
        ...display,
        ...(display.clipping === undefined
          ? {}
          : {
              clipping: {
                planes: display.clipping.planes.map((plane) => [...plane] as const),
                intersection: display.clipping.intersection === true,
                clipShadows: false,
              },
            }),
        ...(camera.entityKey === undefined ? {} : { entityKey: camera.entityKey }),
        ...(camera.target === undefined ? {} : { target: camera.target }),
        world: reflected.world,
        position: reflected.position,
        captureProjection: reflected.projection,
        planarReflection: planar,
        clearColor: [0, 0, 0, 0] as const,
      },
    ];
  });
}

export function selectCameraRoles(
  world: World,
  requestedEntityKey?: number,
  viewExtent?: PhysicalViewExtent,
): CameraRoleSelection {
  const snapshots = collectCameraSnapshots(world);
  const cameras = snapshots.filter((camera) => camera.planarReflection === undefined);
  const planar = snapshots.filter((camera) => camera.planarReflection !== undefined);
  const views = cameras.filter((camera) => camera.view !== undefined);
  const viewCamera =
    viewExtent === undefined ? undefined : cameraForView(cameras, requestedEntityKey, viewExtent);
  const displayEntities = cameras
    .filter((camera) => camera.target === undefined && camera.view === undefined)
    .map((camera) => camera.entityKey ?? 0);
  const hasExplicitSelection = requestedEntityKey !== undefined;
  const activeCameraIndex = selectActiveCameraIndex(
    displayEntities,
    hasExplicitSelection ? requestedEntityKey : getActiveCamera(world)?.entity,
  );
  // An explicit FrameCamera selection is authoritative. If it does not name a
  // display camera, retain the existing no-camera error path instead of
  // silently selecting the first camera. ActiveCamera keeps its established
  // first-hit fallback when no explicit frame selection is supplied.
  const displayEntityKey = hasExplicitSelection
    ? displayEntities[activeCameraIndex]
    : (displayEntities[activeCameraIndex] ?? displayEntities[0]);
  const display =
    viewExtent !== undefined
      ? viewCamera === undefined
        ? []
        : [viewCamera]
      : views.length > 0
        ? views
        : displayEntityKey === undefined
          ? []
          : cameras.filter((camera) => camera.entityKey === displayEntityKey);
  const candidates: CameraTargetCandidate[] = cameras
    .filter((camera) => camera.view === undefined)
    .map((camera) => ({
      worldId: 0,
      entityKey: camera.entityKey ?? 0,
      ...(camera.target === undefined ? {} : { target: camera.target }),
      ...(camera.targetLayer === undefined ? {} : { targetLayer: camera.targetLayer }),
      requestVersion: 0,
      update: 'continuous',
    }));
  const selected = selectCameraTargetViews(candidates, {
    ...(displayEntityKey === undefined ? {} : { displayEntityKey }),
    budget: 1,
  });
  const auxiliary = selected.auxiliary.flatMap((candidate) =>
    cameras.filter((camera) => camera.entityKey === candidate.entityKey),
  );
  // Retain every camera's authored reflection across publication. Each RenderSystem
  // projects only its own view before recording; source extraction never picks a winner.
  return { display, auxiliary: [...auxiliary, ...planar] };
}

export function extractCameraSnapshots(world: World): CameraSnapshot[] {
  return [...selectCameraRoles(world).display];
}

export function tonemapParams(camera: CameraSnapshot): Uint8Array {
  const bytes = new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize);
  const view = new DataView(bytes.buffer);
  view.setFloat32(TONEMAP_PARAMS_LAYOUT.exposureOffset, camera.exposure, true);
  view.setFloat32(TONEMAP_PARAMS_LAYOUT.whitePointOffset, camera.whitePoint, true);
  view.setUint32(TONEMAP_PARAMS_LAYOUT.modeOffset, tonemapToU32(camera.tonemap), true);
  return bytes;
}

export function prepareExtractContext(
  world: World,
  options: {
    readonly materialContext?: MaterialCookRasterContext;
    readonly assets?: AssetRegistry | null;
    readonly materialSnapshotContexts?: MaterialSnapshotContexts;
    readonly resourceOwnerFog?: FogFrame | null;
    readonly cull?: 'self' | 'none' | 'external';
    readonly cullCameras?: readonly CameraSnapshot[];
    readonly cameraEntityKey?: number;
    readonly viewExtent?: PhysicalViewExtent;
    readonly renderables?: 'full' | 'none';
    readonly renderableEntities?: ReadonlySet<number>;
    readonly retainHidden?: boolean;
    readonly preparationMesh?: {
      readonly entity: number;
      readonly meshHandle: AssetHandle<'mesh'>;
      readonly mesh: MeshAsset;
    };
    readonly worldId?: number;
    readonly getMaterialShaderArtifact?: (
      materialShaderId: string,
      request?: {
        readonly vertexColorAvailable?: boolean;
        readonly deformation?: 'rigid' | 'skin';
        readonly variantSet?: string;
        readonly pass?: 'forward' | 'shadow' | 'depth';
        readonly address?: 'direct' | 'scene-index';
      },
    ) => MaterialShaderArtifact | undefined;
    readonly instanceCollections?: InstanceProjectionStore;
    readonly environmentGate?: EnvironmentFrameGate;
  } = {},
): PreparedExtractContext {
  const renderables = options.renderables ?? 'full';
  return {
    materialContext: options.materialContext,
    assets: options.assets,
    materialSnapshotContexts: options.materialSnapshotContexts ?? new Map(),
    resourceOwnerFog: options.resourceOwnerFog,
    cull: options.cull ?? 'self',
    cullCameras: options.cullCameras,
    ...(options.cameraEntityKey === undefined ? {} : { cameraEntityKey: options.cameraEntityKey }),
    ...(options.viewExtent === undefined ? {} : { viewExtent: options.viewExtent }),
    renderables,
    worldId: options.worldId ?? 0,
    renderableEntities: options.renderableEntities,
    retainHidden: options.retainHidden ?? false,
    ...(options.preparationMesh === undefined ? {} : { preparationMesh: options.preparationMesh }),
    visibility: renderables === 'none' ? ALL_VISIBLE : resolveVisibility(world),
    getMaterialShaderArtifact: options.getMaterialShaderArtifact,
    instanceCollections: options.instanceCollections,
    ...(options.environmentGate === undefined ? {} : { environmentGate: options.environmentGate }),
  };
}

const fogQueries = new WeakMap<World, Query<readonly [typeof Fog]>>();
const fogLkgStates = new WeakMap<
  World,
  { lkg: FogFrame | undefined; failure: FogSelectionFailure | undefined }
>();

export function fogState(world: World): {
  lkg: FogFrame | undefined;
  failure: FogSelectionFailure | undefined;
} {
  const existing = fogLkgStates.get(world);
  if (existing !== undefined) return existing;
  const created = { lkg: undefined, failure: undefined };
  fogLkgStates.set(world, created);
  return created;
}

export function selectFogFrame(world: World): FogFrame | undefined {
  // Query compilation is owned once per World; Query refreshes its matched
  // tables when the ECS structure changes, while iteration reads current Fog
  // values. This keeps the frame boundary free of repeated descriptor work.
  const fogCandidates: FogCandidate[] = [];
  let fogQuery = fogQueries.get(world);
  if (fogQuery === undefined) {
    fogQuery = world.query({ read: [Fog] }).unwrap();
    fogQueries.set(world, fogQuery);
  }
  for (const row of fogQuery) {
    const value = row.get(Fog);
    fogCandidates.push({
      entityKey: row.entity,
      color: [value.color[0] ?? 0, value.color[1] ?? 0, value.color[2] ?? 0],
      density: value.density,
      heightFalloff: value.heightFalloff,
      maxOpacity: value.maxOpacity,
      mode: fogModeFromU32(value.mode),
      near: value.near,
      far: value.far,
    });
  }
  const fogSelection = selectEnvironment({
    environments: [],
    fogs: fogCandidates,
    suns: [],
  });
  const state = fogState(world);
  if (fogSelection.ok) {
    state.lkg = fogSelection.value.fog;
    state.failure = undefined;
    return fogSelection.value.fog;
  }
  state.failure = {
    code: fogSelection.error.code,
    expected: fogSelection.error.expected,
    hint: fogSelection.error.hint,
    detail: Object.freeze({ ...fogSelection.error.detail }),
  };
  routeWorldError(world, fogSelection.error, {
    systemName: 'RenderSystem.extract (fog-selection)',
  });
  if (state.lkg !== undefined) return state.lkg;
  throw fogSelection.error;
}

export function extractVolumeSnapshot(
  world: World,
  assets: AssetRegistry | null | undefined,
  worldInternal: WorldInternalView,
): ExtractedVolumetricFog | undefined {
  const elapsed = world.getResource(Time).elapsed;
  const worldTimeSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const query = world.query({ read: [VolumetricFog] }).unwrap();
  const authorings: VolumetricFogAuthoring[] = [];
  const members: ExtractedVolumetricFog[] = [];
  let selectedLight:
    | {
        readonly entity: EntityHandle;
        readonly kind: VolumetricFogLightKind;
        readonly pointLightEntity?: EntityHandle;
        readonly spotLightEntity?: EntityHandle;
      }
    | undefined;

  for (const row of query) {
    selectedLight = undefined;
    const source = row.get(VolumetricFog);
    if (source.light === null) continue;
    const selected = resolveSelectedVolumetricLight(world, source.light);
    if (selected.status === 'available') {
      const pairSpot = source.spotLight === null ? undefined : source.spotLight;
      selectedLight ??= {
        entity: selected.entity,
        kind: selected.kind,
        ...(selected.kind === 'point' ? { pointLightEntity: selected.entity } : {}),
        ...(pairSpot === undefined ? {} : { spotLightEntity: pairSpot }),
      };
    }
    const densityHandle = Math.round(Number(source.density)) as AssetHandle<'texture'>;
    const resolved = runtimeAssets(world.assets).resolveAsset<TextureAsset>(densityHandle);
    if (!resolved.ok || resolved.value.kind !== 'texture') {
      worldInternal._routeError(
        resolved.ok
          ? new RhiError({
              code: 'asset-not-registered',
              expected: 'VolumetricFog.density resolves to a TextureAsset',
              hint: 'load a TextureAsset before assigning it to VolumetricFog.density',
              detail: { assetHandle: Number(densityHandle) },
            })
          : resolved.error,
        { severity: Severity.Error, systemName: 'RenderSystem.extract (volumetric-density)' },
      );
      return { status: 'degraded', worldTimeSeconds };
    }
    const densityAsset = resolved.value;
    const guid = assets?.guidOf(densityHandle) ?? `handle:${Number(densityHandle)}`;
    const shape = densityAsset.shape;
    const density: VolumeDensityBinding =
      shape.viewDimension === '3d'
        ? {
            guid,
            generation: 1,
            shape: {
              viewDimension: '3d',
              extent: {
                width: shape.extent.width,
                height: shape.extent.height,
                depth: shape.extent.depth,
              },
            },
            format: densityAsset.format,
            colorSpace: densityAsset.colorSpace,
          }
        : {
            guid,
            generation: 1,
            shape: {
              viewDimension: shape.viewDimension,
              extent:
                shape.viewDimension === '2d-array'
                  ? {
                      width: shape.extent.width,
                      height: shape.extent.height,
                      layers: shape.extent.layers,
                    }
                  : { width: shape.extent.width, height: shape.extent.height },
            },
            format: densityAsset.format,
            colorSpace: densityAsset.colorSpace,
          };
    const authoring: VolumetricFogAuthoring = {
      light: source.light,
      density,
      bounds: {
        min: [source.boundsMin[0] ?? 0, source.boundsMin[1] ?? 0, source.boundsMin[2] ?? 0],
        max: [source.boundsMax[0] ?? 0, source.boundsMax[1] ?? 0, source.boundsMax[2] ?? 0],
      },
      extinction: [source.extinction[0] ?? 0, source.extinction[1] ?? 0, source.extinction[2] ?? 0],
      albedo: [source.albedo[0] ?? 0, source.albedo[1] ?? 0, source.albedo[2] ?? 0],
      emission: [source.emission[0] ?? 0, source.emission[1] ?? 0, source.emission[2] ?? 0],
      anisotropy: source.anisotropy,
      maxDistance: source.maxDistance,
      sampling:
        source.sampling === 2 ? 'density-albedo' : source.sampling === 1 ? 'density' : 'noise',
    };
    authorings.push(authoring);
    members.push({
      status: 'available',
      worldTimeSeconds,
      densityHandle,
      densityAsset,
      guid,
      generation: 1,
      digest: textureDigest(densityAsset),
      ...(selectedLight === undefined
        ? {}
        : {
            lightEntity: selectedLight.entity,
            lightKind: selectedLight.kind,
            ...(selectedLight.pointLightEntity === undefined
              ? {}
              : { pointLightEntity: selectedLight.pointLightEntity }),
            ...(selectedLight.spotLightEntity === undefined
              ? {}
              : { spotLightEntity: selectedLight.spotLightEntity }),
          }),
    });
  }

  if (authorings.length === 0) return undefined;
  const extracted = extractVolumetricFog(authorings);
  if (!extracted.ok) {
    worldInternal._routeError(extracted.error, {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (volumetric-fog)',
    });
    return { ...members[0], status: 'degraded' };
  }
  if (extracted.value.status === 'off') return { status: 'off' };
  const validatedMembers = extracted.value.fogs.map((fog, index) => ({
    ...members[index],
    status: 'available' as const,
    fog,
  }));
  return {
    ...validatedMembers[0],
    status: 'available',
    additional: validatedMembers.slice(1),
  };
}

/** Immutable author-independent default; extraction retains its producer identity. */
const DEFAULT_MATERIAL_SNAPSHOT: MaterialSnapshot = Object.freeze({
  positionBounds: 'standard-input',
  // The program every Pass selects; GPU and direct bindings resolve it alike.
  // Its shadow Pass reads the same Unlit row the material table packs, never
  // the Standard ABI of the default shadow caster.
  materialShaderId: 'forgeax::default-unlit',
  passes: Object.freeze([
    {
      name: 'shadow-caster',
      program: { module: 'forgeax::default-unlit', vertexEntry: 'vs_shadow' },
      renderState: { tags: { LightMode: 'ShadowCaster' }, queue: 2000 },
    },
    DEFAULT_FORWARD_PASS,
  ]),
  baseColor: vec3.create(0.5, 0.5, 0.5),
  metallic: 0,
  roughness: 1,
  materialHandle: 0,
});

export function defaultMaterialSnapshot(materialHandle = 0): MaterialSnapshot {
  return materialHandle === 0
    ? DEFAULT_MATERIAL_SNAPSHOT
    : { ...DEFAULT_MATERIAL_SNAPSHOT, materialHandle };
}
