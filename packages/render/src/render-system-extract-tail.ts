import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, QueryRow, World } from '@forgeax/engine-ecs';
import {
  createEntityLookup,
  type EntityLookupColumns,
  isQueryIterating,
} from '@forgeax/engine-ecs/internal';
import {
  readArrayRangesChangedSince,
  readMutationEpoch,
  readRenderArrayView,
} from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  describeMeshDraw,
  isFiniteAabb,
  type MeshDrawDescription,
} from '@forgeax/engine-geometry';
import { box3, frustum } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { RhiError } from '@forgeax/engine-rhi';
import {
  ChildOf,
  GlobalTransform,
  Mobility,
  MorphWeights,
  readPresentationWorldMatrix,
  WaterBodyInstance,
} from '@forgeax/engine-scene';
import { mobilityFromRow } from '@forgeax/engine-scene/internal';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  JointCountMismatchError,
  SkeletonResolveFailedError,
  Skin,
  SkinInstancesCoexistForbiddenError,
} from '@forgeax/engine-skinning';
import type {
  Asset,
  AssetHandle,
  MaterialAsset,
  MeshAsset,
  SkeletonAsset,
} from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError, materialProgramUsesSkin, ok } from '@forgeax/engine-types';
import type { WaterMeshViewInput, WaterSystem } from '@forgeax/engine-water';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine-water';
import {
  buildWaterZoneMeshViewForRenderer,
  createWaterMeshLayoutReceipt,
  waterZoneMeshViewForRenderer,
} from '@forgeax/engine-water/internal';
import { materialRasterSourceFacts } from './assembly/material/assembly';
import { buildCameraFrusta } from './camera-frusta';
import { setPlanarCaptureDemand } from './capture/planar-material';
import {
  Instances,
  Layer,
  Lines,
  MeshFilter,
  MeshRenderer,
  Points,
  PostProcessParams,
  pointShapeFromU32,
  pointSizeUnitsFromU32,
  ShadowParticipation,
  SortKey,
  SpriteInstances,
  SpriteRegionOverride,
} from './components';
import { CAMERA_VIEW_DEFAULTS, cameraViewExtent } from './components/camera-view';
import { GpuMeshVertexSource } from './components/gpu-mesh-vertex-source';
import { validateChannelMask } from './components/lighting-channels';
import { type StereoEye, stereoEyeCameras, stereoEyeViewport } from './components/stereo-camera';
import { ProjectedDecalInvalidError } from './decals/component';
import { extractProjectedDecals } from './decals/extract';
import { meshSlotBindingDeps } from './entity-materials';
import {
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from './errors/component-validation';
import { GpuDrivenPreparationError } from './errors/gpu-driven';
import {
  createLightResourceUnavailable,
  MaterialSkinAttrMissingError,
  SkinMaterialMismatchError,
} from './errors/render';
import { createEnvironmentQuery } from './extract/environment-gate';
import { buildGpuDrivenDraws } from './extract/gpu-driven';
import { extractWorldEnvironment } from './extract/world-environment';
import { captureHiddenEntities, NO_HIDDEN_ENTITY_REPORTS } from './features/hidden-entity-reports';
import { MotionBlurValidationError } from './features/motion-blur/motion-blur-params';
import { renderFeatureViewIdentity } from './features/view';
import { extractGlyphSources } from './glyph-source';
import { type InstanceProjectionStore, validateInstanceTransforms } from './instances';
import { deriveInstancesUnionBounds } from './instances-derived-bounds';
import {
  captureMaterialRasterPrograms,
  type MaterialProgramSelection,
  type MaterialRasterPrograms,
  materialProgramSelectionsForMaterial,
  type SourceMaterialProgramDemand,
} from './material-program-selection';
import { MaterialResource, materialUsesSpriteGeometry } from './material-resource';
import { captureMaterialSource, materialSourceMatchesCurrent } from './material-source';
import {
  type MeshMaterialBindingDiagnostic,
  type MeshMaterialBindingSource,
  type ResolveMeshMaterialBindingsResult,
  resolveMeshMaterialBindings,
} from './mesh-material-bindings';
import { morphChannels } from './morph-attributes';
import { isStandardPbrSkinMaterialShader } from './pbr-pipeline';
import { expandPointsLinesBounds } from './points-lines/bounds';
import type { PointsLinesRetainedSnapshot, PointsLinesStyle } from './points-lines/snapshot';
import { IES_SLICE_CAPACITY } from './prepare/extended-lighting/resources';
import { worldRenderResources } from './publication/resource-scope';
import { type CameraSnapshot, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import type {
  DispatchEntry,
  EnvironmentFrameGate,
  ExtractedFrame,
  InstancesSnapshot,
  LightRoster,
  MaterialSnapshot,
  MaterialSnapshotCache,
  MaterialSnapshotCacheEntry,
  MaterialSnapshotContexts,
  MaterialTextureSourceStats,
  MorphSnapshot,
  PointLightSnapshot,
  PreparedExtractContext,
  RectAreaDirectLightSnapshot,
  RenderableSnapshot,
  SpotLightSnapshot,
  SpriteInstancesSnapshot,
  TransformSnapshot,
  WaterMeshOwnerSource,
  WaterMeshSourceState,
  WaterMeshViewFacts,
  WorldInternalView,
} from './render-system-extract';
import {
  appendMaterialDispatchEntries,
  cameraForView,
  createWorldInternalView,
  DEFAULT_FORWARD_PASS,
  defaultMaterialSnapshot,
  fogState,
  materialSnapshotContext,
  prepareExtractContext,
  prepareMaterialSnapshot,
  readPersistentMaterialSnapshot,
  resolveMaterialSnapshot,
  resolveRuntimeAssetReference,
  Severity,
  selectFogFrame,
  sortDispatchByQueue,
  storeMaterialSnapshot,
  tonemapParams,
} from './render-system-extract';
import { CapturedSceneTransform, ScenePoseWriter } from './scene/captured-transform';
import { EMPTY_FRAME_ROWS } from './scene/frame-list';
import { captureMaterialOverrides } from './scene/mesh-materials';
import { renderSourceLayout } from './scene/render-source';
import { buildShadowFrusta } from './scene/shadow-visibility';
import { sharedAabb } from './scene/shared-aabb';
import type { SkinBindingInput } from './scene/skin-scene-inputs';
import { spriteUvRegion } from './sprite-region';
import {
  expandDisplacementBounds,
  standardDisplacementRadius,
} from './standard-displacement-bounds';
import { getActiveCamera } from './systems/active-camera';
import { extractTerrainSources } from './terrain/source.js';
import { extractTilemapSources } from './tilemap-source';
import {
  buildWaterGpuMeshZone,
  type WaterGpuMeshDraw,
  type WaterGpuMeshZone,
} from './water/gpu-mesh-source';
import { requireWaterBodyBakedSources } from './water/material-admission';
import {
  offsetWaterMeshAdmissionDraw,
  ownWaterMaterialAdmissionSource,
  ownWaterMaterialOwner,
  retainWaterMeshCandidateAdmissionDraw,
} from './water/mesh-source-admission';

const collectPostProcessParamsQuery = createEnvironmentQuery({ with: [PostProcessParams] });

function isMissingMaterialProgram(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === 'material-specialization-not-cooked'
  );
}

export function extractSource(
  world: World,
  assets?: AssetRegistry | null,
  materialSnapshotContexts?: MaterialSnapshotContexts,
  options: {
    readonly materialContext?: MaterialCookRasterContext;
    readonly materialProgramDemand?: SourceMaterialProgramDemand | undefined;
    readonly cull?: 'normal' | 'none';
    readonly cameraEntityKey?: number;
    readonly view?: import('./render-contract').ResolvedViewCamera;
    readonly renderables?:
      | 'full'
      | 'none'
      | {
          readonly kind: 'partial';
          readonly entities: ReadonlySet<number>;
        };
    readonly retainHidden?: boolean;
    readonly waterMeshSourceState?: WaterMeshSourceState;
    readonly waterMeshViewFacts?: WaterMeshViewFacts;
    /** Private preparation overlay; never mutates the entity's accepted MeshFilter. */
    readonly preparationMesh?: {
      readonly world: World;
      readonly entity: number;
      readonly meshHandle: AssetHandle<'mesh'>;
      readonly mesh: MeshAsset;
    };
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
    /** Change-driven environment entries (a source's publisher owns one). */
    readonly environmentGate?: EnvironmentFrameGate;
    readonly environmentLightingOnly?: boolean;
    readonly cameraSource?: import('./extract/environment-frame-gate').EnvironmentCameraReader;
  } = {},
): ExtractedFrame {
  const request = options.renderables ?? 'full';
  let frame: ExtractedFrame;
  try {
    type ExtractRequest = NonNullable<Parameters<typeof prepareExtractContext>[1]>;
    const input: {
      -readonly [K in keyof ExtractRequest]: ExtractRequest[K];
    } = {
      cull: options.cull === 'none' ? 'none' : 'self',
      renderables: typeof request === 'object' ? 'full' : request,
      retainHidden: options.retainHidden ?? typeof request === 'object',
    };
    const applyExtractInputs = () => {
      if (assets !== undefined) input.assets = assets;
      if (materialSnapshotContexts !== undefined)
        input.materialSnapshotContexts = materialSnapshotContexts;
      if (options.materialContext !== undefined) input.materialContext = options.materialContext;
      if (options.materialProgramDemand !== undefined)
        input.materialProgramDemand = options.materialProgramDemand;
      if (options.preparationMesh?.world === world) input.preparationMesh = options.preparationMesh;
      if (options.getMaterialShaderArtifact !== undefined)
        input.getMaterialShaderArtifact = options.getMaterialShaderArtifact;
      if (options.instanceCollections !== undefined)
        input.instanceCollections = options.instanceCollections;
      if (options.environmentGate !== undefined) input.environmentGate = options.environmentGate;
      if (options.environmentLightingOnly) input.environmentLightingOnly = true;
      if (options.cameraSource !== undefined) input.cameraSource = options.cameraSource;
      if (typeof request === 'object') input.renderableEntities = request.entities;
      if (options.cameraEntityKey !== undefined) input.cameraEntityKey = options.cameraEntityKey;
      if (options.view !== undefined) input.view = options.view;
      if (options.waterMeshSourceState !== undefined)
        input.waterMeshSourceState = options.waterMeshSourceState;
      if (options.waterMeshViewFacts !== undefined)
        input.waterMeshViewFacts = options.waterMeshViewFacts;
    };
    applyExtractInputs();
    const context = prepareExtractContext(world, input);
    frame = extractFrame(world, context);
  } catch (error) {
    if (error instanceof MotionBlurValidationError || error instanceof ProjectedDecalInvalidError)
      throw error;
    try {
      createWorldInternalView(world)._routeError(error, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extractSource',
      });
    } catch {
      /* Already routed by the source owner. */
    }
    return emptyExtractedFrame();
  }
  const gate = options.environmentGate;
  if (gate !== undefined && options.environmentLightingOnly)
    return {
      ...frame,
      lights: gate.finalizeLighting(world, (routedError) =>
        finalizeLights(world, frame.lights, routedError),
      ),
    };
  const environment =
    gate === undefined
      ? sourceEnvironment(world, frame)
      : gate.finalize(world, 'environment', (routedError) =>
          sourceEnvironment(world, frame, routedError),
        );
  return { ...frame, ...environment };
}
/** Retain each unchanged environment entry even when another entry changes. */
export function sourceEnvironment(world: World, frame: ExtractedFrame, routedError?: () => void) {
  return {
    ...(frame.projectedDecals === undefined ? {} : { projectedDecals: frame.projectedDecals }),
    cameras: frame.cameras,
    auxiliaryCameras: frame.auxiliaryCameras,
    cubeCameras: frame.cubeCameras,
    ...(frame.reflectionProbes === undefined ? {} : { reflectionProbes: frame.reflectionProbes }),
    lights: finalizeLights(world, frame.lights, routedError),
    ...(frame.volumetricFog === undefined ? {} : { volumetricFog: frame.volumetricFog }),
    ...(frame.cloudLayer === undefined ? {} : { cloudLayer: frame.cloudLayer }),
    skylight: frame.skylight,
    skylightCount: frame.skylightCount,
    ...(frame.lightProbes === undefined ? {} : { lightProbes: frame.lightProbes }),
    skybox: frame.skybox,
    skyboxCount: frame.skyboxCount,
    fog: frame.fog,
    ...(frame.fogFailure === undefined ? {} : { fogFailure: frame.fogFailure }),
    environment: frame.environment,
    environmentReady: frame.environmentReady,
    postProcessParams: frame.postProcessParams,
  };
}
/** A failed source contributes no drawable or environment facts. */
function emptyExtractedFrame(): ExtractedFrame {
  return {
    cameras: [],
    auxiliaryCameras: [],
    cubeCameras: [],
    reflectionProbes: [],
    projectedDecals: [],
    lights: {
      directional: undefined,
      directionalCount: 0,
      additionalDirectional: [],
      point: [],
      spot: [],
      rect: [],
      pointShadow: [],
      depthBias: undefined,
      normalBias: undefined,
      directionalShadowError: undefined,
      directionalCsmConfig: undefined,
      directionalCsmDirection: undefined,
    },
    environment: undefined,
    environmentReady: false,
    renderables: [],
    dispatch: [],
    skylight: undefined,
    skylightCount: 0,
    lightProbes: [],
    skybox: undefined,
    skyboxCount: 0,
    fog: undefined,
    frustumStats: { culled: 0, total: 0 },
    visibilityStats: { explicitlyHidden: 0 },
    materialTextureSources: { sourceFieldsVisited: 0, producerRoutes: {} },
    postProcessParams: new Map(),
    visibilitySnapshot: undefined,
    hiddenEntityReports: [],
  };
}
function publishesPlanarCapture(
  auxiliaryCameras: readonly { readonly planarReflection?: unknown }[] | undefined,
): boolean {
  return auxiliaryCameras?.some((camera) => camera.planarReflection !== undefined) ?? false;
}
/** IES slots belong to this Renderer source; handles cannot alias another source. */
function finalizeLights(world: World, lights: LightRoster, routedError?: () => void): LightRoster {
  const slices = new Map<number, number | undefined>();
  let nextSlice = 0;
  const withSlice = <
    T extends PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot,
  >(
    light: T,
  ): T => {
    const handle = light.iesProfileHandle;
    if (handle === undefined || light.iesProfileData === undefined) return light;
    if (!slices.has(handle)) {
      const slice = nextSlice < IES_SLICE_CAPACITY ? nextSlice++ : undefined;
      slices.set(handle, slice);
      if (slice === undefined) {
        routeIesCapacity(world, light, handle);
        routedError?.();
      }
    }
    return { ...light, iesProfileSlice: slices.get(handle) };
  };
  return {
    ...lights,
    point: lights.point.map(withSlice),
    spot: lights.spot.map(withSlice),
    rect: lights.rect.map(withSlice),
  };
}

function routeIesCapacity(
  world: World,
  light: PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot,
  handle: number,
): void {
  createWorldInternalView(world)._routeError(
    createLightResourceUnavailable({
      entity: 'entity' in light ? (light.entity ?? 0) : 0,
      feature: 'ies',
      generation: 0,
      sourceKey: `${handle}`,
      reason: 'capacity',
      expected: `at most ${IES_SLICE_CAPACITY} distinct IES profiles per source`,
      actual: 'IES array capacity exhausted',
      hint: 'share profiles or reduce distinct profiles; excess modifiers are identity',
    }),
    { severity: Severity.Error, systemName: 'RenderSystem.extract (ies-profile)' },
  );
}

export function morphSnapshotFor(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'morphTargets'>,
  weights: ArrayLike<number> | undefined,
): MorphSnapshot | undefined {
  const targets = mesh.morphTargets;
  if (targets === undefined || targets.length === 0 || weights === undefined) return undefined;
  if (weights.length !== targets.length) return undefined;
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const vertexCount = deriveVertexCount(mesh.vertices, layout);
  if (
    vertexCount === undefined ||
    vertexCount <= 0 ||
    morphChannels(mesh, layout, vertexCount) === undefined
  )
    return undefined;
  const copied = new Float32Array(weights.length);
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? Number.NaN;
    if (!Number.isFinite(weight)) return undefined;
    copied[index] = weight;
  }
  // Zero weights are the source vertex stream exactly. An authored but idle
  // morph target must not disable skin scene-index admission or dispatch work.
  if (copied.every((weight) => weight === 0)) return undefined;
  return { weights: copied, targetCount: targets.length };
}

/**
 * Conservative bounds of the morphed positions: the base enclosure plus, per
 * target, the weighted per-axis delta interval. Cost is one pass over the
 * targets, paid only when the renderable is extracted (its weights changed).
 */
export function morphLocalAabb(
  base: ArrayLike<number>,
  mesh: Pick<MeshAsset, 'morphTargets'>,
  morph: MorphSnapshot,
): Float32Array {
  const bounds = new Float64Array(6);
  for (let axis = 0; axis < 6; axis++) bounds[axis] = base[axis] as number;
  const targets = mesh.morphTargets ?? [];
  for (let target = 0; target < targets.length; target++) {
    const weight = morph.weights[target] ?? 0;
    const deltas = targets[target]?.position;
    if (weight === 0 || deltas === undefined) continue;
    for (let axis = 0; axis < 3; axis++) {
      let low = 0;
      let high = 0;
      for (let at = axis; at < deltas.length; at += 3) {
        const delta = (deltas[at] as number) * weight;
        if (delta < low) low = delta;
        else if (delta > high) high = delta;
      }
      bounds[axis] = (bounds[axis] as number) + low;
      bounds[axis + 3] = (bounds[axis + 3] as number) + high;
    }
  }
  // Round outward so the f32 box still encloses the f64 interval.
  const result = new Float32Array(6);
  for (let axis = 0; axis < 6; axis++) {
    const value = bounds[axis] as number;
    const rounded = Math.fround(value);
    result[axis] =
      axis < 3
        ? rounded > value
          ? nextFloat32(rounded, -1)
          : rounded
        : rounded < value
          ? nextFloat32(rounded, 1)
          : rounded;
  }
  return result;
}

function nextFloat32(value: number, direction: 1 | -1): number {
  const bits = new Float32Array([value]);
  const words = new Int32Array(bits.buffer);
  if (value === 0) {
    words[0] = direction > 0 ? 1 : -2147483647;
    return bits[0] as number;
  }
  words[0] = (words[0] as number) + (value > 0 === direction > 0 ? 1 : -1);
  return bits[0] as number;
}

/** One World's environment entries: what an {@link EnvironmentGate} retains between frames. */
export type WorldEnvironmentPart = ReturnType<typeof extractEnvironmentPart>;

function extractEnvironmentPart(
  world: World,
  context: PreparedExtractContext,
  worldInternal: WorldInternalView,
) {
  const fog = selectFogFrame(world);
  const fogFailure = fogState(world).failure;
  const environment = extractWorldEnvironment(world, context, worldInternal, fog);
  const projectedDecals = extractProjectedDecals(world, context);
  const cameras = environment.cameras;
  for (const [i, camera] of cameras.entries()) cameras[i] = { ...camera, projectedDecals };
  const postProcessParams = collectPostProcessParams(world, cameras[0]);
  return { fog, fogFailure, environment, projectedDecals, postProcessParams };
}

export function extractFrame(world: World, context: PreparedExtractContext): ExtractedFrame {
  // Environment reads are owned by the retained resource projection and are
  // established at the frame boundary; record never revisits World state.
  const worldInternal = createWorldInternalView(world);
  const gate = context.environmentLightingOnly ? undefined : context.environmentGate;
  const { fog, fogFailure, environment, projectedDecals, postProcessParams } =
    gate === undefined
      ? extractEnvironmentPart(world, context, worldInternal)
      : gate.read(
          world,
          `${context.cameraEntityKey}:${getActiveCamera(world)?.entity}:${context.view?.extent.width}x${context.view?.extent.height}:${context.view?.extent.eye}`,
          (routedError) => {
            const part = extractEnvironmentPart(world, context, {
              ...worldInternal,
              _routeError(error, ctx) {
                routedError();
                worldInternal._routeError(error, ctx);
              },
            });
            if (part.fogFailure !== undefined) routedError();
            return {
              value: part,
              // Volumetric fog and cloud layers carry World Time.
              timeDependent:
                part.environment.volumetricFog !== undefined ||
                part.environment.cloudLayer !== undefined,
            };
          },
        );
  const cameras = environment.cameras;
  // Planar receivers shade forward only while this source publishes a capture.
  setPlanarCaptureDemand(world, publishesPlanarCapture(environment.auxiliaryCameras));
  const scope = extractGeometry(world, context, worldInternal, environment.lights, cameras);
  return {
    projectedDecals,
    cameras,
    auxiliaryCameras: environment.auxiliaryCameras,
    cubeCameras: environment.cubeCameras,
    reflectionProbes: environment.reflectionProbes,
    lights: environment.lights,
    environment: environment.environment,
    environmentReady: true,
    ...(environment.volumetricFog === undefined
      ? {}
      : { volumetricFog: environment.volumetricFog }),
    ...(environment.cloudLayer === undefined ? {} : { cloudLayer: environment.cloudLayer }),
    renderables: scope?.renderables ?? EMPTY_FRAME_ROWS,
    ...(scope?.waterMeshOwnerRefresh === undefined
      ? {}
      : { waterMeshOwnerRefreshes: [scope.waterMeshOwnerRefresh] }),
    dispatch: scope === undefined ? EMPTY_FRAME_ROWS : sortDispatchByQueue(scope.dispatch),
    skylight: environment.skylight,
    skylightCount: environment.skylightCount,
    lightProbes: environment.lightProbes,
    skybox: environment.skybox,
    skyboxCount: environment.skyboxCount,
    fog,
    ...(fogFailure === undefined ? {} : { fogFailure }),
    frustumStats: { culled: scope?.frustumCulled ?? 0, total: scope?.frustumTotal ?? 0 },
    visibilityStats: { explicitlyHidden: scope?.explicitlyHidden.size ?? 0 },
    materialTextureSources: scope?.materialTextureSources ?? {
      sourceFieldsVisited: 0,
      producerRoutes: {},
    },
    postProcessParams,
    visibilitySnapshot: context.visibility,
    hiddenEntityReports:
      scope === undefined
        ? NO_HIDDEN_ENTITY_REPORTS
        : captureHiddenEntities(scope.explicitlyHidden),
  };
}

/** One material geometry lane: its snapshot caches and compiler context share one key. */
interface MaterialLane {
  readonly geometry: MaterialCookRasterContext['geometry'];
  readonly vertexColorAvailable: boolean;
  /** Derived snapshots local to this extraction; dispatch is still rebuilt per entity. */
  readonly cache: MaterialSnapshotCache;
  readonly persistent: MaterialSnapshotCache;
  readonly materialContext: MaterialCookRasterContext | undefined;
}

/** Allocate mesh readers only for a producer that can emit geometry or restore water-owned rows. */
function extractGeometry(
  world: World,
  context: PreparedExtractContext,
  worldInternal: WorldInternalView,
  lights: LightRoster,
  cameras: readonly CameraSnapshot[],
): WorldExtraction | undefined {
  let scope: WorldExtraction | undefined;
  if (context.renderables !== 'none') {
    scope = createWorldExtraction(world, context, worldInternal, lights, cameras);
    extractMeshRenderers(scope);
    extractDerivedRenderSources(scope);
  }
  const water = world.hasResource(WATER_SYSTEM_RESOURCE)
    ? world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    : undefined;
  if (water !== undefined || context.waterMeshSourceState?.system !== undefined) {
    scope ??= createWorldExtraction(world, context, worldInternal, lights, cameras);
    extractWaterMeshSources(scope, water);
  }
  return scope;
}

/** Mutable state of one extractFrame call: its outputs, caches and cull counters. */
function createWorldExtraction(
  world: World,
  context: PreparedExtractContext,
  worldInternal: WorldInternalView,
  lights: LightRoster,
  cameras: readonly CameraSnapshot[],
  expectedPoseRows = context.renderableEntities?.size,
) {
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  const materialLanes = new Map<string, MaterialLane>();
  const materialTextureSources: MaterialTextureSourceStats = {
    sourceFieldsVisited: 0,
    producerRoutes: {},
  };
  // A resolved view can supply its own culling camera snapshots. Explicit
  // 'none' bypasses culling; degenerate projection planes retain visibility.
  const cullingCameras = context.cull === 'external' ? (context.cullCameras ?? []) : cameras;
  return {
    world,
    context,
    worldInternal,
    cameras,
    assets: world.assets === undefined ? context.assets : runtimeAssetRegistry(world.assets),
    visibility: context.visibility.hasAnyHiddenIntent ? context.visibility : undefined,
    materialLanes,
    materialTextureSources,
    renderables,
    dispatch,
    waterMeshOwnerRefresh: undefined as
      | NonNullable<ExtractedFrame['waterMeshOwnerRefreshes']>[number]
      | undefined,
    explicitlyHidden: new Set<EntityHandle>(),
    shadowFrusta: context.cull === 'none' ? [] : buildShadowFrusta(lights, cameras[0]),
    frustumPlanes: context.cull === 'none' ? [] : buildCameraFrusta(cullingCameras),
    // feat-20260528-frustum-culling M3 / w11: frustum culling counters.
    frustumCulled: 0,
    frustumTotal: 0,
    preparedPose: false,
    poses: new ScenePoseWriter(expectedPoseRows),
    cullPose: undefined as Float32Array | undefined,
  };
}

type WorldExtraction = ReturnType<typeof createWorldExtraction>;

/** Select initial mesh programs without publishing a frame or routing scene errors. */
export function prepareSourceMeshPrograms(
  world: World,
  options: Pick<
    NonNullable<Parameters<typeof prepareExtractContext>[1]>,
    'assets' | 'materialContext' | 'materialProgramDemand'
  >,
): void {
  const context = prepareExtractContext(world, { ...options, cull: 'none', retainHidden: true });
  const internal = createWorldInternalView(world);
  const scope = createWorldExtraction(
    world,
    context,
    {
      ...internal,
      _routeError(error, detail) {
        if (detail.severity === Severity.Error) throw error;
      },
    },
    emptyExtractedFrame().lights,
    [],
  );
  extractMeshRenderers(scope);
}

/** Engine-only roster read; ordinary extraction retains its Query filtering. */
export function extractInactiveMeshMember(
  world: World,
  context: PreparedExtractContext,
  entity: EntityHandle,
) {
  const internal = createWorldInternalView(world);
  const scope = createWorldExtraction(
    world,
    { ...context, cull: 'none', retainHidden: true },
    {
      ...internal,
      _routeError(error, ctx) {
        if (ctx.severity === Severity.Warning) internal._routeError(error, ctx);
        else throw error;
      },
    },
    emptyExtractedFrame().lights,
    [],
    1,
  );
  scope.preparedPose = true;
  const source = meshExtractionSource(world);
  extractMeshRendererRow(scope, entity, new MeshRendererRowRead(source));
  return {
    renderables: scope.renderables,
    dispatch: scope.dispatch,
    hidden: scope.explicitlyHidden.has(entity),
  };
}

// The query owns admission and order. Archetype membership is shared with source observation.
function queryMeshRenderers(world: World) {
  return world.query({ read: [MeshRenderer] }).unwrap();
}

// Each named field addresses one scalar column in the ECS lookup.
const meshFieldLayout: (readonly [number, string])[] = [];
function meshField(component: number, field: string): number {
  return meshFieldLayout.push([component, field]) - 1;
}
const MeshField = {
  lightingChannels: meshField(0, 'lightingChannels'),
  renderLayers: meshField(0, 'renderLayers'),
  frustumCulled: meshField(0, 'frustumCulled'),
  preparePipelines: meshField(0, 'preparePipelines'),
  cast: meshField(1, 'cast'),
  receive: meshField(1, 'receive'),
  shadowChannels: meshField(1, 'channels'),
  mesh: meshField(2, 'assetHandle'),
  skeleton: meshField(3, 'skeleton'),
  sortKey: meshField(4, 'value'),
  layer: meshField(5, 'value'),
  mobility: meshField(6, 'kind'),
  parent: meshField(7, 'parent'),
};

/** The World owns component identity and table storage. Only column addresses survive extraction. */
function createMeshExtractionSource(world: World, skin: typeof Skin) {
  const lookup = createEntityLookup(
    world,
    [MeshRenderer, ShadowParticipation, MeshFilter, skin, SortKey, Layer, Mobility, ChildOf],
    meshFieldLayout,
  );
  let query: ReturnType<typeof queryMeshRenderers> | undefined;
  return {
    skin,
    lookup,
    layout: renderSourceLayout(world),
    query() {
      query ??= queryMeshRenderers(world);
      return isQueryIterating(query) ? queryMeshRenderers(world) : query;
    },
  };
}

type MeshExtractionSource = ReturnType<typeof createMeshExtractionSource>;
const meshExtractionSources = new WeakMap<World, MeshExtractionSource>();
const EMPTY_MESH_FIELDS: EntityLookupColumns['fields'] = [];

function meshExtractionSource(world: World): MeshExtractionSource {
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  let source = meshExtractionSources.get(world);
  if (source?.skin !== skin) {
    source = createMeshExtractionSource(world, skin);
    meshExtractionSources.set(world, source);
  }
  return source;
}

/** Walk MeshRenderer rows in query order, or in the requested partial entity order. */
function extractMeshRenderers(
  scope: WorldExtraction,
  requested = scope.context.renderableEntities,
): void {
  const source = meshExtractionSource(scope.world);
  const query = source.query();
  const read = new MeshRendererRowRead(source);
  const visit = (row: QueryRow) => extractMeshRendererRow(scope, row.entity, read);
  if (requested === undefined) query.forEach(visit);
  else query.forEachAt(requested as ReadonlySet<EntityHandle>, visit);
}

/** Terrain, glyph and tilemap producers append to the same renderable/dispatch lists. */
function extractDerivedRenderSources(scope: WorldExtraction): void {
  const { world, context, renderables, visibility, explicitlyHidden } = scope;
  const requested = context.renderableEntities;
  let terrain: Set<number> | undefined,
    glyph: Set<number> | undefined,
    tilemap: Set<number> | undefined;
  if (requested !== undefined) {
    const read = renderSourceLayout(world);
    for (const entity of requested) {
      const layout = read(entity as EntityHandle);
      if (layout?.terrain) {
        terrain ??= new Set();
        terrain.add(entity);
      }
      if (layout?.glyph) {
        glyph ??= new Set();
        glyph.add(entity);
      }
      if (layout?.tilemap) {
        tilemap ??= new Set();
        tilemap.add(entity);
      }
    }
  }
  if (scope.assets != null && (requested === undefined || terrain !== undefined))
    extractTerrainSources(
      world,
      scope.assets,
      context.materialContext,
      renderables,
      scope.dispatch,
      terrain,
      visibility,
      context.retainHidden,
      explicitlyHidden,
    );
  if (requested === undefined || glyph !== undefined)
    extractGlyphSources(
      world,
      renderables,
      glyph,
      visibility,
      context.retainHidden,
      explicitlyHidden,
    );
  if (requested === undefined || tilemap !== undefined)
    extractTilemapSources(
      world,
      renderables,
      tilemap,
      visibility,
      context.retainHidden,
      explicitlyHidden,
    );
}

type WaterOwnerMeshDraw =
  | {
      readonly materialKey: string;
      readonly draw: import('@forgeax/engine-water').WaterMeshOwnerDraw;
    }
  | {
      readonly materialKey: string;
      readonly gpu: WaterGpuMeshDraw;
      readonly source: WaterGpuMeshZone;
    };

function waterMeshSourceAtMaterialOffset(
  source: WaterMeshOwnerSource['source'],
  materialOffset: number,
): WaterMeshOwnerSource['source'] {
  if (materialOffset === 0) return source;
  return Object.freeze({
    ...source,
    materialStartIndex: source.materialStartIndex + materialOffset,
    views: Object.freeze(
      source.views.map((view) =>
        Object.freeze({
          viewIdentity: view.viewIdentity,
          draws: Object.freeze(
            view.draws.map((draw) => offsetWaterMeshAdmissionDraw(draw, materialOffset)),
          ),
        }),
      ),
    ),
  });
}

function composeWaterMeshOwnerRow(
  scope: WorldExtraction,
  owner: WaterMeshOwnerSource,
  ordinary: RenderableSnapshot | undefined,
): RenderableSnapshot {
  const waterMaterials = owner.materials;
  const waterMeshSource = waterMeshSourceAtMaterialOffset(
    owner.source,
    ordinary?.materials.length ?? 0,
  );
  const defaultMaterial = MaterialResource.from(defaultMaterialSnapshot(0));
  const material = ordinary?.material ?? waterMaterials[0] ?? defaultMaterial;
  const materials = [...(ordinary?.materials ?? []), ...waterMaterials];
  if (materials.length === 0) materials.push(material);
  const materialBindingSources = [
    ...(ordinary?.materialBindingSources ?? []),
    ...waterMaterials.map(() => 'mesh-default' as const),
  ];
  if (materialBindingSources.length === 0) materialBindingSources.push('mesh-default');
  const {
    waterMeshSource: _waterMeshSource,
    waterOwner: _waterOwner,
    waterMeshTiles: _waterMeshTiles,
    ...ordinaryFacts
  } = ordinary ?? {};
  return {
    ...ordinaryFacts,
    waterMeshSource,
    layer: ordinary?.layer ?? 0,
    ...(ordinary?.shadowCaster === undefined
      ? { shadowCaster: false as const }
      : { shadowCaster: ordinary.shadowCaster }),
    authorVisible: ordinary?.authorVisible ?? true,
    transform: ordinary?.transform ?? {
      world: new Float32Array(
        readPresentationWorldMatrix(scope.world, owner.entityKey as EntityHandle) ?? [
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ],
      ),
    },
    material,
    materials,
    materialOverrides: ordinary?.materialOverrides ?? [],
    materialBindingSources,
    materialBindingDiagnostics: ordinary?.materialBindingDiagnostics ?? [],
    entityKey: owner.entityKey,
    lightingChannels: ordinary?.lightingChannels ?? 0xffff_ffff,
  };
}

/** Address just the requested water owners in the frame's ordinary output list. Derived
 * extraction appends rows, so each suffix is joined once and ordinary insertion order survives. */
class WaterMeshOwnerRows {
  private readonly positions = new Map<number, number>();
  private scanned = 0;

  constructor(
    private readonly rows: RenderableSnapshot[],
    owners: readonly number[],
  ) {
    for (const entity of owners) this.include(entity);
  }

  include(entity: number): void {
    if (this.positions.has(entity)) return;
    this.positions.set(entity, -1);
    this.scanned = 0;
  }

  read(entity: number): RenderableSnapshot | undefined {
    this.include(entity);
    while (this.scanned < this.rows.length) {
      const index = this.scanned++;
      const key = (this.rows[index] as RenderableSnapshot).entityKey;
      if (this.positions.get(key) === -1) this.positions.set(key, index);
    }
    return this.rows[this.positions.get(entity) as number];
  }

  replace(row: RenderableSnapshot): void {
    this.read(row.entityKey);
    const index = this.positions.get(row.entityKey) as number;
    if (index >= 0) this.rows[index] = row;
    else {
      this.positions.set(row.entityKey, this.rows.length);
      this.rows.push(row);
      this.scanned = this.rows.length;
    }
  }
}

function extractMissingWaterOwnerMeshRows(
  scope: WorldExtraction,
  owners: WaterMeshOwnerRows,
  entities: Iterable<number>,
): void {
  const missing = new Set<number>();
  for (const entity of entities) {
    if (owners.read(entity) === undefined) missing.add(entity);
  }
  if (missing.size === 0) return;
  extractDerivedRenderSources({
    ...scope,
    context: {
      ...scope.context,
      renderables: 'full',
      renderableEntities: missing,
    },
  });
  extractMeshRenderers(scope, missing);
}

function validWaterMeshViewFacts(
  facts: WaterMeshViewFacts | undefined,
): WaterMeshViewFacts | undefined {
  return facts?.version === 1 &&
    Number.isSafeInteger(facts.canvasExtent.width) &&
    facts.canvasExtent.width > 0 &&
    Number.isSafeInteger(facts.canvasExtent.height) &&
    facts.canvasExtent.height > 0 &&
    Number.isSafeInteger(facts.maxRenderShortSide) &&
    facts.maxRenderShortSide >= 0
    ? facts
    : undefined;
}

function waterMeshCameraViews(
  sourceCamera: CameraSnapshot,
  context: PreparedExtractContext,
): readonly { readonly camera: CameraSnapshot; readonly frustumResolved: boolean }[] {
  if (
    context.view !== undefined ||
    context.waterMeshCameraRosterResolved === true ||
    sourceCamera.eye !== undefined
  )
    return [{ camera: sourceCamera, frustumResolved: true }];

  const eyes: readonly (StereoEye | undefined)[] =
    sourceCamera.stereo === undefined ? [undefined] : ['left', 'right'];
  const facts = validWaterMeshViewFacts(context.waterMeshViewFacts);
  const authoredView = sourceCamera.view ?? CAMERA_VIEW_DEFAULTS;
  return eyes.flatMap((eye) => {
    if (facts !== undefined) {
      const maxRenderShortSide =
        facts.maxRenderShortSide === 0
          ? authoredView.maxRenderShortSide
          : authoredView.maxRenderShortSide === 0
            ? facts.maxRenderShortSide
            : Math.min(authoredView.maxRenderShortSide, facts.maxRenderShortSide);
      const cappedView = { ...authoredView, maxRenderShortSide };
      const view =
        eye === undefined || sourceCamera.stereo === undefined
          ? cappedView
          : {
              ...cappedView,
              viewport: stereoEyeViewport(
                cappedView.viewport,
                sourceCamera.stereo,
                eye,
                new Float32Array(4),
              ),
            };
      const extent = cameraViewExtent(view, facts.canvasExtent.width, facts.canvasExtent.height);
      const camera = cameraForView([sourceCamera], sourceCamera.entityKey, {
        width: extent.renderWidth,
        height: extent.renderHeight,
        ...(eye === undefined ? {} : { eye }),
      });
      if (camera !== undefined) return [{ camera, frustumResolved: true }];
    }

    const camera =
      eye === undefined
        ? sourceCamera
        : stereoEyeCameras(sourceCamera).find((candidate) => candidate.eye?.side === eye);
    if (camera === undefined) return [];
    return [
      {
        camera,
        frustumResolved: sourceCamera.autoAspect === false,
      },
    ];
  });
}

const EMPTY_WATER_MESH_REFRESH = Object.freeze({
  worldId: 0,
  system: undefined,
  inputKey: '',
  ownerEntityKeys: Object.freeze([]),
  ownerSources: Object.freeze([]),
});

function extractWaterMeshSources(scope: WorldExtraction, water: WaterSystem | undefined): void {
  const { world, context } = scope;
  if (water === undefined) {
    const previous = context.waterMeshSourceState;
    if (previous?.system !== undefined) {
      extractMissingWaterOwnerMeshRows(
        scope,
        new WaterMeshOwnerRows(scope.renderables, previous.ownerEntityKeys),
        previous.ownerEntityKeys,
      );
      scope.waterMeshOwnerRefresh = EMPTY_WATER_MESH_REFRESH;
    }
    return;
  }
  const acceptedInput = context.waterMeshSourceState;
  const ownerRows = new WaterMeshOwnerRows(scope.renderables, acceptedInput?.ownerEntityKeys ?? []);
  const bodySnapshots = water.snapshots();
  const resolveWaterMeshCameraRoster = () => {
    const cameraRoster =
      context.view !== undefined
        ? context.view.camera === undefined
          ? []
          : [context.view.camera]
        : context.cull === 'external'
          ? (context.cullCameras ?? [])
          : scope.cameras;
    return cameraRoster;
  };
  const cameraRoster = resolveWaterMeshCameraRoster();
  const camerasByView = new Map<
    string,
    { readonly camera: CameraSnapshot; readonly frustumResolved: boolean }
  >();
  const captureWaterMeshCameras = () => {
    for (const sourceCamera of cameraRoster) {
      if (sourceCamera.target !== undefined || sourceCamera.view?.enabled === false) continue;
      for (const { camera, frustumResolved } of waterMeshCameraViews(sourceCamera, context)) {
        if (camera.target !== undefined || camera.view?.enabled === false) continue;
        camerasByView.set(renderFeatureViewIdentity(camera), { camera, frustumResolved });
      }
    }
  };
  captureWaterMeshCameras();
  const displayViews = [...camerasByView.entries()]
    .map(([viewIdentity, facts]) => ({ viewIdentity, ...facts }))
    .sort((left, right) =>
      left.viewIdentity < right.viewIdentity ? -1 : left.viewIdentity > right.viewIdentity ? 1 : 0,
    );
  const views = displayViews.map((view) => {
    const packedFrustum = view.frustumResolved ? buildCameraFrusta([view.camera])[0] : undefined;
    const frustumPlanes =
      packedFrustum === undefined
        ? undefined
        : Array.from({ length: 6 }, (_, planeIndex) => ({
            normal: [
              packedFrustum[planeIndex * 4] ?? 0,
              packedFrustum[planeIndex * 4 + 1] ?? 0,
              packedFrustum[planeIndex * 4 + 2] ?? 0,
            ] as const,
            distance: packedFrustum[planeIndex * 4 + 3] ?? 0,
          }));
    return { ...view, packedFrustum, frustumPlanes };
  });
  if (context.view === undefined)
    water?.retireWaterMeshViewsExcept(views.map((view) => view.viewIdentity));
  const bodyFacts = bodySnapshots.map((body) => {
    const match = /^scene-entity:(\d+)$/.exec(body.guid);
    const entity = match === null ? undefined : (Number(match[1]) as EntityHandle);
    if (entity !== undefined) ownerRows.include(entity);
    const entityLive =
      entity !== undefined &&
      Number.isSafeInteger(entity) &&
      world.hasComponent(entity, WaterBodyInstance);
    const visibility = entityLive ? (scope.visibility?.effective(entity) ?? 'visible') : 'missing';
    const receipt = (kind: 'geometry' | 'waterInfo') => {
      const value = body.outputReceipts[kind];
      return value === undefined ? null : [value.outputGeneration, value.digest];
    };
    return [
      body.guid,
      body.sourceVersion,
      body.sceneGeneration,
      body.binding.kind,
      body.binding.kind === 'bound' ? body.binding.zoneGuid : (body.binding.requestedGuid ?? null),
      body.binding.kind === 'bound' ? body.binding.zoneGeneration : 0,
      body.asset.flags.affectsWaterMesh,
      body.asset.renderOptions?.visible !== false,
      entityLive,
      visibility,
      body.outputs.geometry,
      body.outputGenerations.geometry,
      body.dirty.has('geometry'),
      receipt('geometry'),
      body.outputs.waterInfo,
      body.outputGenerations.waterInfo,
      body.dirty.has('waterInfo'),
      receipt('waterInfo'),
    ];
  });
  const waterBodiesPresent = bodySnapshots.some((body) => body.asset.flags.affectsWaterMesh);
  const viewFacts = views.map((view) => [
    view.viewIdentity,
    ...view.camera.position,
    view.packedFrustum === undefined ? null : Array.from(view.packedFrustum),
  ]);
  const captureWaterMeshZones = () => {
    const zones =
      water !== undefined && waterBodiesPresent && views.length > 0 ? water.zoneSnapshots() : [];
    return zones;
  };
  const zones = captureWaterMeshZones();
  const zoneFacts = zones.map((zone) => [
    zone.guid,
    zone.generation,
    ...zone.worldMatrixM,
    zone.asset.extentM.spanXM,
    zone.asset.extentM.spanZM,
    zone.asset.tileSizeM,
    zone.asset.tessellationFactor,
    zone.asset.lodScale,
    zone.asset.waterInfo.format,
    zone.asset.farExtentM ?? null,
    zone.asset.farMaterialGuid ?? null,
    zone.asset.gpuMesh ?? null,
  ]);
  const ownerRostersByView = new Map<string, ReadonlySet<string>>();
  const ownerRosterFacts =
    water !== undefined && waterBodiesPresent
      ? views.map((view) => {
          const ownerKeys = water
            .waterMeshOwnerRoster(view.viewIdentity)
            .map((owner) =>
              JSON.stringify([
                owner.bodyGuid,
                owner.bodyGeneration,
                owner.zoneGuid,
                owner.zoneGeneration,
                owner.waterInfoFormat,
              ]),
            )
            .sort();
          ownerRostersByView.set(view.viewIdentity, new Set(ownerKeys));
          return [view.viewIdentity, ownerKeys];
        })
      : null;
  const captureWaterMeshMaterialContext = () => {
    const materialWorld = worldRenderResources(world);
    const waterMaterialCache = materialSnapshotContext(
      context.materialSnapshotContexts,
      'mesh',
      false,
    );
    const materialKeys = new Set<string>();
    const captureWaterMeshMaterialKeys = () => {
      for (const body of bodySnapshots) {
        if (!body.asset.flags.affectsWaterMesh) continue;
        for (const key of [
          body.asset.surfaceMaterialGuid,
          body.asset.riverToLakeTransitionMaterialGuid,
          body.asset.riverToOceanTransitionMaterialGuid,
        ])
          if (key !== undefined) materialKeys.add(key);
      }
      for (const zone of zones)
        if (zone.asset.farMaterialGuid !== undefined) materialKeys.add(zone.asset.farMaterialGuid);
    };
    captureWaterMeshMaterialKeys();
    return { materialWorld, waterMaterialCache, materialKeys };
  };
  const { materialWorld, waterMaterialCache, materialKeys } = captureWaterMeshMaterialContext();
  const materialRecords = world.assets === undefined ? undefined : runtimeAssets(world.assets);
  const materialFacts = [...materialKeys].sort().map((key) => {
    const handle = materialWorld.handleForGuid(key);
    if (handle === undefined) return [key, null];
    const asset = materialWorld.resolveAsset(handle);
    // The runtime graph already flattens material parents into actual resource dependencies.
    const revisions: Array<readonly [number, number | null]> = [];
    const pending = [handle];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const dependency = pending.pop();
      if (dependency === undefined || visited.has(dependency)) continue;
      visited.add(dependency);
      revisions.push([dependency, materialWorld.assetRevision(dependency) ?? null]);
      const dependencies = materialRecords?.dependencies(dependency);
      if (dependencies?.ok) pending.push(...dependencies.value);
    }
    return [key, handle, asset.ok ? asset.value.kind : null, revisions];
  });
  const inputKey = JSON.stringify([
    waterBodiesPresent ? viewFacts : null,
    bodyFacts,
    zoneFacts,
    ownerRosterFacts,
    materialFacts,
    water?.bakedQueryRevision,
  ]);
  if (
    acceptedInput !== undefined &&
    acceptedInput.system === water &&
    acceptedInput.inputKey === inputKey &&
    acceptedInput.ownerSources !== undefined
  ) {
    const restoreAcceptedWaterMeshRows = (ownerSources: readonly WaterMeshOwnerSource[]) => {
      const requested = (entity: number) =>
        context.renderables !== 'none' &&
        (context.renderableEntities === undefined || context.renderableEntities.has(entity));
      for (const owner of ownerSources) {
        if (
          !requested(owner.entityKey) ||
          !world.hasComponent(owner.entityKey as EntityHandle, WaterBodyInstance) ||
          scope.visibility?.effective(owner.entityKey as EntityHandle) === 'hidden'
        )
          continue;
        const ordinary = ownerRows.read(owner.entityKey);
        ownerRows.replace(composeWaterMeshOwnerRow(scope, owner, ordinary));
      }
    };
    restoreAcceptedWaterMeshRows(acceptedInput.ownerSources);
    return;
  }
  scope.waterMeshOwnerRefresh = Object.freeze({
    worldId: 0,
    system: water,
    inputKey,
    ownerEntityKeys: Object.freeze([]),
    ownerSources: Object.freeze([]),
  });
  extractMissingWaterOwnerMeshRows(scope, ownerRows, acceptedInput?.ownerEntityKeys ?? []);
  if (water === undefined || !waterBodiesPresent || views.length === 0) return;
  const waterMeshEntities = new Set<EntityHandle>();
  const captureWaterMeshEntities = () => {
    for (const body of bodySnapshots) {
      if (!body.asset.flags.affectsWaterMesh || body.binding.kind !== 'bound') continue;
      const match = /^scene-entity:(\d+)$/.exec(body.guid);
      if (!match) continue;
      const entity = Number(match[1]) as EntityHandle;
      if (
        Number.isSafeInteger(entity) &&
        world.hasComponent(entity, WaterBodyInstance) &&
        scope.visibility?.effective(entity) !== 'hidden'
      )
        waterMeshEntities.add(entity);
    }
  };
  captureWaterMeshEntities();
  if (waterMeshEntities.size === 0) return;
  extractMissingWaterOwnerMeshRows(scope, ownerRows, waterMeshEntities);
  type SelectedOwnerDraws = {
    bodyGuid: string;
    bodyGeneration: number;
    zoneGuid: string;
    zoneGeneration: number;
    targetFormat: 'rgba16float' | 'rgba32float';
    draws: WaterOwnerMeshDraw[];
  };
  type SelectedOwnerViews = Omit<SelectedOwnerDraws, 'draws'> & {
    readonly views: Map<string, readonly WaterOwnerMeshDraw[]>;
  };
  const selectedOwners = new Map<string, SelectedOwnerViews>();
  const groupPublication = (
    publication: import('@forgeax/engine-water').WaterZoneMeshPublication,
    roster: ReadonlySet<string>,
  ) => {
    const groups = new Map<string, SelectedOwnerDraws>();
    for (const bucket of publication.receipt.buckets)
      for (const draw of bucket.ownerDraws) {
        if (publication.sourceGenerations[draw.ownerGuid] !== draw.ownerGeneration) continue;
        const rosterKey = JSON.stringify([
          draw.ownerGuid,
          draw.ownerGeneration,
          publication.zoneGuid,
          publication.zoneGeneration,
          publication.waterInfoFormat,
        ]);
        if (!roster.has(rosterKey)) continue;
        const owner = groups.get(rosterKey) ?? {
          bodyGuid: draw.ownerGuid,
          bodyGeneration: draw.ownerGeneration,
          zoneGuid: publication.zoneGuid,
          zoneGeneration: publication.zoneGeneration,
          targetFormat: publication.waterInfoFormat,
          draws: [],
        };
        if (
          owner.bodyGeneration !== draw.ownerGeneration ||
          owner.zoneGuid !== publication.zoneGuid ||
          owner.zoneGeneration !== publication.zoneGeneration ||
          owner.targetFormat !== publication.waterInfoFormat
        )
          continue;
        owner.draws.push({ materialKey: bucket.materialKey, draw });
        groups.set(rosterKey, owner);
      }
    return groups;
  };
  const selectWaterMeshViewOwners = (water: WaterSystem) => {
    for (const view of views) {
      const committedPublications: import('@forgeax/engine-water').WaterZoneMeshPublication[] = [];
      const candidatePublications: import('@forgeax/engine-water').WaterZoneMeshPublication[] = [];
      const failedZones: Array<{ readonly guid: string; readonly generation: number }> = [];
      const roster = ownerRostersByView.get(view.viewIdentity) ?? new Set<string>();
      const captureViewZonePublications = (water: WaterSystem) => {
        for (const zone of zones) {
          const input: WaterMeshViewInput = {
            viewId: view.viewIdentity,
            observerM: [
              view.camera.position[0] ?? 0,
              view.camera.position[1] ?? 0,
              view.camera.position[2] ?? 0,
            ],
            ...(view.frustumPlanes === undefined ? {} : { frustumPlanes: view.frustumPlanes }),
          };
          const built = buildWaterZoneMeshViewForRenderer(
            water,
            zone.guid,
            zone.generation,
            zone.asset,
            input,
          );
          const committed = waterZoneMeshViewForRenderer(water, zone.guid, view.viewIdentity);
          if (committed !== undefined) committedPublications.push(committed);
          if (built.ok) candidatePublications.push(built.value);
          else failedZones.push({ guid: zone.guid, generation: zone.generation });
        }
      };
      captureViewZonePublications(water);
      const selectedForView = new Map<string, SelectedOwnerDraws>();
      const committedOwnerKeys = new Set<string>();
      const committedBodyGuids = new Set<string>();
      const selectViewPublishedOwners = () => {
        for (const publication of committedPublications)
          for (const [ownerKey, owner] of groupPublication(publication, roster)) {
            if (selectedForView.has(ownerKey)) continue;
            selectedForView.set(ownerKey, owner);
            committedOwnerKeys.add(ownerKey);
            committedBodyGuids.add(owner.bodyGuid);
          }
        for (const publication of candidatePublications)
          for (const [ownerKey, owner] of groupPublication(publication, roster)) {
            if (committedBodyGuids.has(owner.bodyGuid) && !committedOwnerKeys.has(ownerKey))
              continue;
            selectedForView.set(ownerKey, owner);
          }
      };
      selectViewPublishedOwners();
      const selectViewGpuMeshOwners = () => {
        for (const zone of zones) {
          if (!zone.asset.gpuMesh) continue;
          const admittedBodies = bodySnapshots.filter((body) => {
            const entity =
              body.instanceEntity ?? Number(/^scene-entity:(\d+)$/.exec(body.guid)?.[1]);
            return (
              waterMeshEntities.has(entity as EntityHandle) &&
              roster.has(
                JSON.stringify([
                  body.guid,
                  body.sceneGeneration,
                  zone.guid,
                  zone.generation,
                  zone.asset.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
                ]),
              )
            );
          });
          const built = buildWaterGpuMeshZone(world.identity, zone, admittedBodies, {
            identity: view.viewIdentity,
            position: view.camera.position,
            farTiles:
              (
                candidatePublications.find((publication) => publication.zoneGuid === zone.guid) ??
                committedPublications.find((publication) => publication.zoneGuid === zone.guid)
              )?.receipt.instances ?? [],
          });
          if (!built.ok) {
            scope.worldInternal._routeError(
              new GpuDrivenPreparationError('resource-not-ready', {
                reason: 'water-mesh-publication-missing',
                owner: 'geometry',
                expected: built.error.expected,
              }),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (water-gpu-mesh-source)',
              },
            );
            continue;
          }
          if (built.value === undefined) continue;
          const source = built.value;
          const anchor = source.bodies[0];
          if (anchor === undefined) {
            scope.worldInternal._routeError(
              new GpuDrivenPreparationError('resource-not-ready', {
                reason: 'water-mesh-publication-missing',
                owner: 'geometry',
                expected: 'a non-empty Water GPU mesh source body roster',
                actual: 'empty body roster',
              }),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (water-gpu-mesh-source)',
              },
            );
            continue;
          }
          const targetFormat =
            zone.asset.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float';
          const key = JSON.stringify([
            anchor.guid,
            anchor.generation,
            zone.guid,
            zone.generation,
            targetFormat,
          ]);
          const farDraws = selectedForView.get(key)?.draws ?? [];
          selectedForView.set(key, {
            bodyGuid: anchor.guid,
            bodyGeneration: anchor.generation,
            zoneGuid: zone.guid,
            zoneGeneration: zone.generation,
            targetFormat,
            draws: [
              ...farDraws,
              ...source.materials.map((materialKey, materialBucket) => ({
                materialKey,
                source,
                gpu: {
                  zoneKey: source.key,
                  materialBucket,
                  viewIndex: 0,
                  viewCount: 1,
                  materialCount: source.materials.length,
                  tileCapacity: source.tileCapacity,
                  sourceBodies: source.bodies.map((body) => ({
                    guid: body.guid,
                    generation: body.generation,
                  })),
                },
              })),
            ],
          });
        }
      };
      selectViewGpuMeshOwners();
      const selectedOwnerGuids = new Set(
        [...selectedForView.values()].map((owner) => owner.bodyGuid),
      );
      const reportMissingViewMeshOwners = () => {
        for (const zone of failedZones)
          for (const body of bodySnapshots) {
            if (
              body.asset.zoneGuid !== zone.guid ||
              !body.asset.flags.affectsWaterMesh ||
              body.binding.kind !== 'bound' ||
              body.binding.zoneGeneration !== zone.generation ||
              selectedOwnerGuids.has(body.guid)
            )
              continue;
            scope.worldInternal._routeError(
              new GpuDrivenPreparationError('resource-not-ready', {
                reason: 'water-mesh-publication-missing',
                owner: 'geometry',
                expected:
                  'a current or retained generation-qualified WaterMesh publication and matching WaterInfo/wave closure',
              }),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (water-mesh-not-ready)',
              },
            );
          }
      };
      reportMissingViewMeshOwners();
      for (const [ownerKey, owner] of selectedForView) {
        const selected = selectedOwners.get(ownerKey) ?? {
          bodyGuid: owner.bodyGuid,
          bodyGeneration: owner.bodyGeneration,
          zoneGuid: owner.zoneGuid,
          zoneGeneration: owner.zoneGeneration,
          targetFormat: owner.targetFormat,
          views: new Map<string, readonly WaterOwnerMeshDraw[]>(),
        };
        selected.views.set(view.viewIdentity, owner.draws);
        selectedOwners.set(ownerKey, selected);
      }
    }
  };
  selectWaterMeshViewOwners(water);
  const replacedEntities = new Set<EntityHandle>();
  const ownerSources = new Map<number, WaterMeshOwnerSource>();
  let retryMaterials = false;
  const publishSelectedWaterMeshOwners = (water: WaterSystem) => {
    for (const owner of selectedOwners.values()) {
      const ownerGuid = owner.bodyGuid;
      const entityMatch = /^scene-entity:(\d+)$/.exec(ownerGuid);
      if (!entityMatch) continue;
      const entity = Number(entityMatch[1]) as EntityHandle;
      if (
        !Number.isSafeInteger(entity) ||
        !world.hasComponent(entity, WaterBodyInstance) ||
        scope.visibility?.effective(entity) === 'hidden'
      )
        continue;
      const worldIdentity = world.identity;
      const previousRenderable = replacedEntities.has(entity) ? undefined : ownerRows.read(entity);
      const waterMaterialResources: MaterialResource[] = [];
      const materialIndices = new Map<number, number>();
      const pendingMaterialSources = new Map<number, number>();
      const sourceViews: NonNullable<RenderableSnapshot['waterMeshSource']>['views'][number][] = [];
      let materialFailure:
        | { readonly kind: 'pending'; readonly key: string }
        | { readonly kind: 'missing'; readonly key: string }
        | { readonly kind: 'invalid'; readonly key: string; readonly cause: unknown }
        | undefined;
      const orderedOwnerViews = [...owner.views].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      for (const [viewIdentity, viewDraws] of orderedOwnerViews) {
        const captureWaterMeshSourceViews = () => {
          const sourceDraws: NonNullable<
            RenderableSnapshot['waterMeshSource']
          >['views'][number]['draws'][number][] = [];
          for (const selection of viewDraws) {
            const { materialKey } = selection;
            const draw = 'draw' in selection ? selection.draw : undefined;
            const waterMaterialHandle = resolveRuntimeAssetReference(
              materialWorld,
              materialKey,
              'material',
            );
            if (waterMaterialHandle === undefined || scope.assets == null) {
              const body = water.snapshot(ownerGuid);
              const dependency =
                body?.sceneGeneration === owner.bodyGeneration
                  ? body.dependencies.find(
                      (item) => item.guid === materialKey && item.kind === 'material',
                    )
                  : undefined;
              const handle = materialWorld.handleForGuid(materialKey);
              const resolved =
                handle === undefined ? undefined : materialWorld.resolveAsset(handle);
              materialFailure = {
                kind:
                  dependency?.status === 'pending' && (resolved === undefined || !resolved.ok)
                    ? 'pending'
                    : 'missing',
                key: materialKey,
              };
              break;
            }
            let materialIndex = materialIndices.get(waterMaterialHandle);
            if (materialIndex === undefined) {
              try {
                const createWaterMeshDrawMaterial = (
                  waterMaterialHandle: number,
                  assets: NonNullable<typeof scope.assets>,
                ) => {
                  const retainedMaterial = [
                    ...ownerSources.values(),
                    ...(acceptedInput !== undefined && acceptedInput.system === water
                      ? (acceptedInput.ownerSources ?? [])
                      : []),
                  ]
                    .flatMap((candidate) => candidate.materials)
                    .find(
                      (candidate) =>
                        candidate.snapshot.sourceAssets !== undefined &&
                        candidate.snapshot.sourceAssets.root === waterMaterialHandle &&
                        materialSourceMatchesCurrent(
                          materialWorld,
                          candidate.snapshot.sourceAssets,
                        ),
                    );
                  const materialSnapshot =
                    retainedMaterial?.snapshot ??
                    resolveMaterialSnapshot(
                      waterMaterialHandle,
                      materialWorld,
                      assets,
                      undefined,
                      waterMaterialCache,
                      context.materialContext,
                      scope.materialTextureSources,
                      false,
                      'mesh',
                    );
                  const rejected = waterMaterialCache.get(waterMaterialHandle)?.retry;
                  if (retainedMaterial === undefined && rejected !== undefined)
                    throw rejected.cause;
                  const createdIndex = waterMaterialResources.length;
                  materialIndices.set(waterMaterialHandle, createdIndex);
                  waterMaterialResources.push(
                    retainedMaterial ?? MaterialResource.from(materialSnapshot),
                  );
                  if (materialSnapshot.sourceAssets === undefined)
                    pendingMaterialSources.set(createdIndex, waterMaterialHandle);
                  return createdIndex;
                };
                materialIndex = createWaterMeshDrawMaterial(waterMaterialHandle, scope.assets);
              } catch (cause) {
                materialFailure = { kind: 'invalid', key: materialKey, cause };
                break;
              }
            }
            const validateWaterMeshBakedSources = () => {
              try {
                const candidate = waterMaterialResources[materialIndex]?.snapshot;
                if (candidate === undefined)
                  throw new Error('Water material source is unavailable');
                const transitionBodySources =
                  'gpu' in selection
                    ? selection.gpu.sourceBodies
                    : selection.draw.instances.flatMap((instance) =>
                        instance.transitionRenderIndex === 0 ||
                        instance.transitionBodyGuid === undefined ||
                        instance.transitionBodyGeneration === undefined
                          ? []
                          : [
                              {
                                guid: instance.transitionBodyGuid,
                                generation: instance.transitionBodyGeneration,
                              },
                            ],
                      );
                requireWaterBodyBakedSources(
                  water,
                  [{ guid: ownerGuid, generation: owner.bodyGeneration }, ...transitionBodySources],
                  Object.values(candidate.materialProgramInputs ?? {}),
                );
              } catch (cause) {
                materialFailure = { kind: 'invalid', key: materialKey, cause };
                return true;
              }
              return false;
            };
            if (validateWaterMeshBakedSources()) break;
            const scopedDrawKey = JSON.stringify([
              worldIdentity,
              ownerGuid,
              owner.bodyGeneration,
              owner.zoneGuid,
              owner.zoneGeneration,
              viewIdentity,
              draw?.drawKey ??
                ('gpu' in selection
                  ? [selection.gpu.zoneKey, selection.gpu.materialBucket]
                  : undefined),
            ]);
            if ('gpu' in selection) {
              const source = selection.source,
                bytes = new Uint8Array(0);
              sourceDraws.push(
                Object.freeze({
                  drawKey: scopedDrawKey,
                  materialIndex,
                  mesh: source.mesh,
                  localAabb: new Float32Array([
                    source.originXZ[0],
                    source.yMin,
                    source.originXZ[1],
                    source.originXZ[0] + source.extentXZ[0],
                    source.yMax,
                    source.originXZ[1] + source.extentXZ[1],
                  ]),
                  instanceCount: 1,
                  gpu: selection.gpu,
                  bytes,
                  coverageBytes: bytes,
                  layout: createWaterMeshLayoutReceipt(bytes, bytes),
                  transitionTargets: Object.freeze([]),
                }),
              );
              continue;
            }
            if (draw === undefined) continue;
            let minX = Infinity,
              minY = Infinity,
              minZ = Infinity,
              maxX = -Infinity,
              maxY = -Infinity,
              maxZ = -Infinity;
            for (const instance of draw.instances) {
              minX = Math.min(minX, instance.originXZ[0]);
              minY = Math.min(minY, instance.yMinM);
              minZ = Math.min(minZ, instance.originXZ[1]);
              maxX = Math.max(maxX, instance.originXZ[0] + instance.extentXZ[0]);
              maxY = Math.max(maxY, instance.yMaxM);
              maxZ = Math.max(maxZ, instance.originXZ[1] + instance.extentXZ[1]);
            }
            const drawAabb = new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]);
            sourceDraws.push(
              retainWaterMeshCandidateAdmissionDraw(
                {
                  guid: ownerGuid,
                  generation: owner.bodyGeneration,
                  worldIdentity,
                  zoneGeneration: owner.zoneGeneration,
                },
                viewIdentity,
                {
                  drawKey: scopedDrawKey,
                  materialIndex,
                  mesh: draw.mesh,
                  localAabb: drawAabb,
                  instanceCount: draw.instances.length,
                  bytes: draw.instanceBytes,
                  coverageBytes: draw.coverageBytes,
                  layout: draw.layout,
                  transitionTargets: Object.freeze(
                    draw.instances.flatMap((instance, instanceIndex) =>
                      instance.transitionRenderIndex === 0 ||
                      instance.transitionBodyGuid === undefined ||
                      instance.transitionBodyGeneration === undefined
                        ? []
                        : [
                            Object.freeze({
                              instanceIndex,
                              bodyGuid: instance.transitionBodyGuid,
                              bodyGeneration: instance.transitionBodyGeneration,
                            }),
                          ],
                    ),
                  ),
                },
              ),
            );
          }
          if (materialFailure !== undefined) return;
          sourceViews.push(Object.freeze({ viewIdentity, draws: Object.freeze(sourceDraws) }));
        };
        captureWaterMeshSourceViews();
        if (materialFailure !== undefined) break;
      }
      const capturePendingWaterMaterials = () => {
        if (materialFailure === undefined) {
          for (const [materialIndex, handle] of pendingMaterialSources) {
            try {
              const sourceAssets = captureMaterialSource(materialWorld, handle);
              if (sourceAssets === undefined)
                throw new Error('Accepted Water material source payload is unavailable');
              const material = waterMaterialResources[materialIndex];
              if (material === undefined) throw new Error('Water material source is unavailable');
              const accepted = storeMaterialSnapshot(
                waterMaterialCache,
                handle,
                {
                  ...material.snapshot,
                  sourceAssets,
                },
                materialWorld,
                waterMaterialCache.get(handle)?.programSelections,
              );
              if (accepted.retry !== undefined) throw accepted.retry.cause;
              waterMaterialResources[materialIndex] = MaterialResource.from(accepted.snapshot);
            } catch (cause) {
              materialFailure = { kind: 'invalid', key: String(handle), cause };
              break;
            }
          }
        }
      };
      capturePendingWaterMaterials();
      if (materialFailure !== undefined) {
        retryMaterials = true;
        if (materialFailure.kind !== 'pending')
          scope.worldInternal._routeError(
            new GpuDrivenPreparationError(
              materialFailure.kind === 'missing'
                ? 'resource-not-ready'
                : 'material-resolution-failed',
              {
                reason:
                  materialFailure.kind === 'missing'
                    ? 'material-resource-missing'
                    : 'material-resolution-failed',
                owner: 'material',
                expected:
                  materialFailure.kind === 'missing'
                    ? 'every WaterMesh draw material resolves as a material asset'
                    : 'the WaterMesh material produces a valid renderer snapshot',
                actual: materialFailure.key,
                ...(materialFailure.kind === 'invalid' ? { cause: materialFailure.cause } : {}),
              },
            ),
            { severity: Severity.Error, systemName: 'RenderSystem.extract (water-mesh-material)' },
          );
        const retained =
          acceptedInput !== undefined && acceptedInput.system === water
            ? acceptedInput.ownerSources?.find(
                (candidate) =>
                  candidate.entityKey === entity &&
                  candidate.source.generation === owner.bodyGeneration &&
                  candidate.source.zoneGuid === owner.zoneGuid &&
                  candidate.source.zoneGeneration === owner.zoneGeneration,
              )
            : undefined;
        if (retained !== undefined) {
          const liveViewIds = new Set(owner.views.keys());
          const retainedSource: WaterMeshOwnerSource = {
            ...retained,
            source: {
              ...retained.source,
              views: retained.source.views.filter((view) => liveViewIds.has(view.viewIdentity)),
            },
          };
          ownerSources.set(entity, retainedSource);
          ownerRows.replace(composeWaterMeshOwnerRow(scope, retainedSource, previousRenderable));
          replacedEntities.add(entity);
        }
        continue;
      }
      if (sourceViews.every((view) => view.draws.length === 0)) continue;
      const ownerSource: WaterMeshOwnerSource = Object.freeze({
        entityKey: entity,
        source: Object.freeze({
          guid: ownerGuid,
          generation: owner.bodyGeneration,
          worldIdentity,
          zoneGuid: owner.zoneGuid,
          zoneGeneration: owner.zoneGeneration,
          targetFormat: owner.targetFormat,
          materialStartIndex: 0,
          views: Object.freeze(sourceViews),
        }),
        materials: Object.freeze([...waterMaterialResources]),
      });
      ownerSources.set(entity, ownerSource);
      ownerRows.replace(composeWaterMeshOwnerRow(scope, ownerSource, previousRenderable));
      replacedEntities.add(entity);
    }
  };
  publishSelectedWaterMeshOwners(water);
  const restoreUnreplacedWaterMeshOwners = () => {
    for (const entity of waterMeshEntities) {
      if (replacedEntities.has(entity)) continue;
      const bodyGuid = `scene-entity:${entity}`;
      const body = bodySnapshots.find(
        (snapshot) => snapshot.guid === bodyGuid && snapshot.binding.kind === 'bound',
      );
      const binding = body?.binding;
      if (body === undefined || binding?.kind !== 'bound') continue;
      const zone = zones.find(
        (snapshot) =>
          snapshot.guid === binding.zoneGuid && snapshot.generation === binding.zoneGeneration,
      );
      if (zone === undefined) continue;
      const previousRenderable = ownerRows.read(entity);
      const targetFormat =
        zone.asset.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float';
      const ownerSource: WaterMeshOwnerSource = Object.freeze({
        entityKey: entity,
        source: Object.freeze({
          guid: body.guid,
          generation: body.sceneGeneration,
          worldIdentity: world.identity,
          zoneGuid: binding.zoneGuid,
          zoneGeneration: binding.zoneGeneration,
          targetFormat,
          materialStartIndex: 0,
          views: Object.freeze([]),
        }),
        materials: Object.freeze([]),
      });
      ownerSources.set(entity, ownerSource);
      ownerRows.replace(composeWaterMeshOwnerRow(scope, ownerSource, previousRenderable));
      replacedEntities.add(entity);
    }
  };
  restoreUnreplacedWaterMeshOwners();
  const acceptedOwnerSources = Object.freeze([...ownerSources.values()]);
  scope.waterMeshOwnerRefresh = Object.freeze({
    worldId: 0,
    system: water,
    inputKey: retryMaterials ? (acceptedInput?.inputKey ?? '') : inputKey,
    ownerEntityKeys: Object.freeze(acceptedOwnerSources.map((owner) => owner.entityKey)),
    ownerSources: acceptedOwnerSources,
  });
}

/**
 * D-1: collect PostProcessParams entities into Map<shaderId, Uint8Array>.
 * Last-one-wins when multiple entities bear the same shader id.
 *
 * feat-20260621 M-A3 / w13 (D-5): the engine bridges the active camera's
 * `Camera.exposure / whitePoint / tonemap` onto the SAME unified params channel
 * custom post-processes use; `Camera.exposure` stays the AI-user-facing SSOT.
 * The 16B layout is Float32 [exposure, whitePoint, mode(u32), ditherEnabled];
 * the final Output Transform makes a per-pass copy and writes ditherEnabled.
 * It runs after the user-entity collection so the engine's built-in provider is
 * authoritative for its reserved key. The single active camera mirrors
 * recordFrame's `activeCameras[0]` selection.
 */
function collectPostProcessParams(
  world: World,
  tonemapCamera: CameraSnapshot | undefined,
): Map<string, Uint8Array> {
  const postProcessParams: Map<string, Uint8Array> = new Map();
  for (const querySpan of collectPostProcessParamsQuery(world).unwrap().spans().unwrap()) {
    const queryEntities = querySpan.entities;
    for (let queryIndex = 0; queryIndex < querySpan.length; queryIndex++) {
      const queriedEntity = queryEntities[queryIndex] as EntityHandle;

      const read = world.get(queriedEntity, PostProcessParams);
      if (!read.ok) continue;
      postProcessParams.set(read.value.shader, read.value.data);
    }
  }
  if (tonemapCamera !== undefined) {
    postProcessParams.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, tonemapParams(tonemapCamera));
  }
  return postProcessParams;
}

function extractMeshRendererRow(
  scope: WorldExtraction,
  entity: EntityHandle,
  read: MeshRendererRowRead,
): void {
  if (!read.load(scope, entity)) return;
  if (!read.authorVisible) scope.explicitlyHidden.add(entity);
  if (!read.authorVisible && !scope.context.retainHidden) return;
  // A scalar shared<T> field uses slot 0 as the schema-level unbound
  // sentinel. An entity carrying an unbound MeshFilter is not a renderable
  // yet; keep it out of frame validation. Non-zero handles still follow the
  // normal resolve/error path below.
  if (read.isRenderable && read.meshHandle === 0) return;
  // Dispatch entries are staged locally and flushed into the shared list only
  // when the entity survives culling, so a culled entity never leaves entries
  // whose renderableIndex aliases a later visible entity (PR #598).
  const pending = read.pending;
  pending.length = 0;
  const materialsView = scope.worldInternal._getArrayView(entity, MeshRenderer, 'materials') as
    | Uint32Array
    | undefined;
  const bindings = resolveEntityMaterialBindings(scope, read, materialsView);
  if (bindings === undefined) return;
  const lane = materialLaneFor(scope, read, bindings.mesh);
  const primary = resolvePrimaryMaterial(scope, read, lane, bindings, pending);
  if (primary === undefined) return;
  if (read.isRenderable)
    publishRenderable(scope, read, { view: materialsView, bindings, lane, primary }, pending);
}

function admitChannelMask(
  scope: WorldExtraction,
  error: ReturnType<typeof validateChannelMask>,
  source: 'lighting-channels' | 'shadow-channels' | 'render-layers',
): boolean {
  if (error === null) return true;
  scope.worldInternal._routeError(error, {
    severity: Severity.Error,
    systemName: `RenderSystem.extract (${source})`,
  });
  return false;
}

/** One synchronous extraction owns the working row and its unpublished passes.
 * Snapshots and dispatch entries copy the values they publish. Nested extraction gets its own row.
 */
class MeshRendererRowRead {
  readonly pending: DispatchEntry[] = [];
  entity!: EntityHandle;
  layout: ReturnType<MeshExtractionSource['layout']>;
  preparationMesh: PreparedExtractContext['preparationMesh'];
  meshHandle: number | undefined;
  lightingChannels = 0;
  renderLayers = 0;
  authorVisible = true;
  frustumCulled = true;
  isRenderable = false;
  preparePipelines = false;
  skinSkeleton: number | undefined;
  morphWeights: ReturnType<WorldInternalView['_getArrayView']>;
  shadowChannels: number | undefined;
  shadowCastDisabled = false;
  shadowParticipationAuthored = false;
  shadowReceiveDisabled = false;
  mobilityKind: number | undefined;
  mobilityParent: number | undefined;
  sortKey: number | undefined;
  pointsLinesComponent: 'Points' | 'Lines' | undefined;
  layer = 0;
  archVersion = 0;

  constructor(readonly source: MeshExtractionSource) {}

  load(scope: WorldExtraction, entity: EntityHandle): boolean {
    const lookup = this.source.lookup;
    const fields = lookup.get(entity) ? lookup.columns.fields : EMPTY_MESH_FIELDS;
    const row = lookup.row;
    const lightingChannels = fields[MeshField.lightingChannels]?.view[row] as number;
    if (!admitChannelMask(scope, validateChannelMask(lightingChannels), 'lighting-channels'))
      return false;
    const renderLayers = fields[MeshField.renderLayers]?.view[row] as number;
    if (
      !admitChannelMask(scope, validateChannelMask(renderLayers, 'renderLayers'), 'render-layers')
    )
      return false;
    const shadowChannels = fields[MeshField.shadowChannels]?.view[row];
    const hasParticipation = fields[MeshField.cast] !== undefined;
    if (
      hasParticipation &&
      !admitChannelMask(
        scope,
        validateChannelMask(shadowChannels as number, 'shadowChannels'),
        'shadow-channels',
      )
    )
      return false;
    const layout = this.source.layout(entity);
    const meshHandle = fields[MeshField.mesh]?.view[row];
    this.entity = entity;
    this.layout = layout;
    this.preparationMesh =
      !scope.preparedPose && scope.context.preparationMesh?.entity === entity
        ? scope.context.preparationMesh
        : undefined;
    this.meshHandle = this.preparationMesh?.meshHandle ?? meshHandle;
    this.isRenderable = layout?.transform === true && meshHandle !== undefined;
    this.authorVisible = !(this.isRenderable && scope.visibility?.effective(entity) === 'hidden');
    this.lightingChannels = lightingChannels;
    this.renderLayers = renderLayers;
    this.frustumCulled = fields[MeshField.frustumCulled]?.view[row] !== 0;
    this.preparePipelines =
      this.preparationMesh !== undefined || fields[MeshField.preparePipelines]?.view[row] === 1;
    this.skinSkeleton = fields[MeshField.skeleton]?.view[row];
    this.morphWeights = layout?.morph
      ? scope.worldInternal._getArrayView(entity, MorphWeights, 'weights')
      : undefined;
    this.shadowChannels =
      !hasParticipation || shadowChannels === 0xffffffff ? undefined : shadowChannels;
    this.shadowCastDisabled = hasParticipation && fields[MeshField.cast]?.view[row] !== 1;
    this.shadowParticipationAuthored = hasParticipation;
    this.shadowReceiveDisabled = hasParticipation && fields[MeshField.receive]?.view[row] !== 1;
    this.mobilityKind = fields[MeshField.mobility]?.view[row];
    this.mobilityParent = fields[MeshField.parent]?.view[row];
    this.sortKey = fields[MeshField.sortKey]?.view[row];
    this.pointsLinesComponent = layout?.points ? 'Points' : layout?.lines ? 'Lines' : undefined;
    this.layer = fields[MeshField.layer]?.view[row] ?? 0;
    this.archVersion =
      layout?.instances || layout?.spriteInstances
        ? spriteInstancesArchVersion(scope.worldInternal, entity)
        : 0;
    return true;
  }
}

/**
 * QueryRow deliberately exposes component data, not an archetype version.
 * SpriteInstances still uses a content fingerprint for its managed arrays;
 * explicit Instances use the renderer-owned collection revision.
 */
function spriteInstancesArchVersion(
  worldInternal: WorldInternalView,
  entity: EntityHandle,
): number {
  const transforms = worldInternal._getArrayView(entity, SpriteInstances, 'transforms');
  const regions = worldInternal._getArrayView(entity, SpriteInstances, 'regions');
  return foldArrayViewHash(foldArrayViewHash(2166136261, transforms), regions);
}

function foldArrayViewHash(seed: number, value: ArrayLike<number> | undefined): number {
  let hash = Math.imul(seed ^ (value?.length ?? 0), 16777619) >>> 0;
  if (value === undefined) return hash;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ Math.fround(value[index] ?? 0), 16777619) >>> 0;
  }
  return hash;
}

/** Slot-ordered material handles after instance-override -> mesh-default inheritance. */
interface EntityMaterialBindings {
  readonly handles: readonly number[];
  readonly sources: readonly MeshMaterialBindingSource[];
  readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
  readonly mesh: MeshDrawDescription | undefined;
}

/** The entity's resolved materials; `primary` (slot 0) owns entity-level shading dispatch. */
interface EntityMaterials {
  readonly view: Uint32Array | undefined;
  readonly bindings: EntityMaterialBindings;
  readonly lane: MaterialLane;
  readonly primary: MaterialSelection;
}

type MaterialSelection = Pick<MaterialSnapshotCacheEntry, 'snapshot' | 'programSelections'>;

function resolveEntityMesh(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
): MeshAsset | undefined {
  const handle = Math.round(read.meshHandle ?? 0);
  if (handle === 0) return undefined;
  const resolved =
    read.preparationMesh === undefined
      ? runtimeAssets(scope.world.assets).resolveAsset<Asset>(handle as AssetHandle<'mesh'>)
      : ok(read.preparationMesh.mesh);
  return resolved.ok && resolved.value.kind === 'mesh' ? (resolved.value as MeshAsset) : undefined;
}

function resolveEntityMeshDraw(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
): MeshDrawDescription | undefined {
  const handle = Math.round(read.meshHandle ?? 0);
  if (handle === 0) return undefined;
  if (read.preparationMesh !== undefined) return describeMeshDraw(read.preparationMesh.mesh);
  const result = runtimeAssets(scope.world.assets).meshDraw(handle);
  return result.ok ? result.value : undefined;
}

/** `undefined` means a routed slot failure rejected the entity. */
function resolveEntityMaterialBindings(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materialsView: Uint32Array | undefined,
): EntityMaterialBindings | undefined {
  const mesh = scope.assets == null ? undefined : resolveEntityMeshDraw(scope, read);
  const bindings =
    mesh === undefined
      ? rendererMaterialBindings(materialsView)
      : resolveMeshSlotBindings(scope, read.entity, mesh, materialsView);
  if (bindings === undefined || bindings.handles.length > 0) return bindings;
  return {
    handles: [0],
    sources: ['engine-default'],
    diagnostics: bindings.diagnostics,
    mesh: bindings.mesh,
  };
}

function rendererMaterialBindings(materialsView: Uint32Array | undefined): EntityMaterialBindings {
  const handles = Array.from(materialsView ?? []);
  return {
    handles,
    sources: handles.map((): MeshMaterialBindingSource => 'renderer-override'),
    diagnostics: [],
    mesh: undefined,
  };
}

/** Resolve instance overrides against mesh-owned slot defaults once. */
function resolveMeshSlotBindings(
  scope: WorldExtraction,
  entity: EntityHandle,
  mesh: MeshDrawDescription,
  materialsView: Uint32Array | undefined,
): EntityMaterialBindings | undefined {
  const guid = mesh.guid ?? '<no-guid>';
  const resolved = resolveMeshMaterialBindings(
    mesh,
    materialsView ?? [],
    meshSlotBindingDeps(scope.world),
  );
  if (!resolved.ok) {
    routeMeshSlotFailure(scope, entity, mesh, guid, resolved);
    return undefined;
  }
  const materialCount = materialsView?.length ?? 0;
  const diagnostics = resolved.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    detail: meshBindingDiagnosticDetail(diagnostic, mesh, materialCount, guid),
  }));
  for (const diagnostic of resolved.diagnostics) {
    scope.worldInternal._routeError(
      new AssetError({
        code: diagnostic.code,
        expected:
          diagnostic.code === 'mesh-renderer-material-override-overflow'
            ? `materials.length <= materialSlots.length (${mesh.materialSlots.length})`
            : `materials[${diagnostic.slotIndex}] resolves to a live MaterialAsset`,
        hint: ASSET_ERROR_HINTS[diagnostic.code],
        detail: meshBindingDiagnosticDetail(diagnostic, mesh, materialCount, guid),
      }),
      { severity: Severity.Warning, systemName: `RenderSystem.extract (${diagnostic.code})` },
    );
  }
  return {
    handles: resolved.bindings.map((binding) => binding.handle),
    sources: resolved.bindings.map((binding) => binding.source),
    diagnostics,
    mesh,
  };
}

function meshBindingDiagnosticDetail(
  diagnostic: MeshMaterialBindingDiagnostic,
  mesh: MeshDrawDescription,
  materialCount: number,
  guid: string,
) {
  return diagnostic.code === 'mesh-renderer-material-override-overflow'
    ? {
        expectedCount: mesh.materialSlots.length,
        actualCount: materialCount,
        meshAssetGuid: guid,
      }
    : {
        meshAssetGuid: guid,
        slotIndex: diagnostic.slotIndex,
        handle: diagnostic.handle ?? 0,
      };
}

function routeMeshSlotFailure(
  scope: WorldExtraction,
  entity: EntityHandle,
  mesh: MeshDrawDescription,
  guid: string,
  failure: Extract<ResolveMeshMaterialBindingsResult, { readonly ok: false }>,
): void {
  if (failure.code === 'mesh-material-slots-missing') {
    scope.worldInternal._routeError(
      new AssetError({
        code: 'load-failed',
        expected: 'every MeshAsset producer supplies materialSlots[]',
        hint: `fix the MeshAsset producer; renderer inheritance never guesses slot topology (mesh=${guid}, entity=${entity}, vertices=${mesh.vertexWordCount}, indices=${mesh.indexCount})`,
        detail: {
          referencedByGuid: guid,
          referencedByKind: 'mesh',
          subAssetGuid: '<material-slots-missing>',
          sourceField: { fieldName: 'materialSlots' },
        },
      }),
      {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (mesh-material-slots-missing)',
      },
    );
    return;
  }
  const materialGuid =
    typeof failure.defaultMaterial === 'number'
      ? String(failure.defaultMaterial)
      : AssetGuid.format(failure.defaultMaterial);
  scope.worldInternal._routeError(
    new AssetError({
      code: 'load-failed',
      expected: `MeshAsset materialSlots[${failure.slotIndex}] default ${materialGuid} is ready and a MaterialAsset`,
      hint: `assets.load(meshGuid, 'mesh') must recursively load the declared default material; mesh=${guid}, slot=${failure.slotIndex}, material=${materialGuid}`,
      detail: {
        referencedByGuid: guid,
        referencedByKind: 'mesh',
        subAssetGuid: materialGuid,
        sourceField: { fieldName: 'materialSlots', arrayIndex: failure.slotIndex },
      },
    }),
    { severity: Severity.Error, systemName: 'RenderSystem.extract (mesh-default-not-ready)' },
  );
}

function materialLaneFor(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  mesh: MeshDrawDescription | undefined,
): MaterialLane {
  const vertexColorAvailable = mesh?.layout.attributes.some(({ key }) => key === 'color') === true;
  const geometry: MaterialCookRasterContext['geometry'] =
    read.skinSkeleton !== undefined
      ? 'skinned'
      : read.layout?.spriteInstances
        ? 'sprite-instances'
        : 'mesh';
  const key = `${geometry}:${vertexColorAvailable}`;
  const existing = scope.materialLanes.get(key);
  if (existing !== undefined) return existing;
  const materialContext = scope.context.materialContext;
  const lane: MaterialLane = {
    geometry,
    vertexColorAvailable,
    cache: new Map(),
    persistent: materialSnapshotContext(
      scope.context.materialSnapshotContexts,
      geometry,
      vertexColorAvailable,
    ),
    materialContext: materialContext === undefined ? undefined : { ...materialContext, geometry },
  };
  scope.materialLanes.set(key, lane);
  return lane;
}

/**
 * Slot 0 selects shading-model dispatch and multi-pass DispatchEntry rows;
 * slots >= 1 resolve later into the per-submesh `materials[]` array.
 * `undefined` means skin admission or asset resolution rejected the entity.
 */
function resolvePrimaryMaterial(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  lane: MaterialLane,
  bindings: EntityMaterialBindings,
  pending: DispatchEntry[],
): MaterialSelection | undefined {
  const handle = bindings.handles[0] ?? 0;
  const cached = handle !== 0 ? lane.cache.get(handle) : undefined;
  if (cached !== undefined) return adoptCachedMaterial(scope, read, cached, handle, pending);
  // case B: missing-spec sentinel -> mid-grey defaultMaterialSnapshot.
  if (handle === 0 || scope.assets == null) return { snapshot: defaultMaterialSnapshot(handle) };
  const persistent = readPersistentMaterialSnapshot(
    lane.persistent,
    handle,
    worldRenderResources(scope.world),
  );
  if (persistent === undefined)
    return resolveFreshMaterial(scope, read, lane, handle, scope.assets, bindings.mesh, pending);
  lane.cache.set(handle, persistent);
  return adoptCachedMaterial(scope, read, persistent, handle, pending);
}

function adoptCachedMaterial(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  entry: MaterialSnapshotCacheEntry,
  handle: number,
  pending: DispatchEntry[],
): MaterialSelection | undefined {
  if (
    read.skinSkeleton !== undefined &&
    !admitSkinMaterial(scope, read, entry.snapshot.materialShaderId, entry.programSelections)
  )
    return undefined;
  if (read.isRenderable) {
    appendMaterialDispatchEntries(
      pending,
      entry.snapshot.passes,
      read.entity,
      handle,
      scope.renderables.length,
      read.layer,
      0,
      entry.snapshot.materialProgramKeys,
    );
  }
  return entry;
}

/** Programs and values come from the same accepted runtime material. */
function resolveFreshMaterial(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  lane: MaterialLane,
  handle: number,
  assets: AssetRegistry,
  mesh: MeshDrawDescription | undefined,
  pending: DispatchEntry[],
): MaterialSelection | undefined {
  const resolved = runtimeAssets(scope.world.assets).resolveAsset(
    handle as AssetHandle<'material'>,
  );
  if (!resolved.ok) {
    if (read.isRenderable) routeMaterialNotRegistered(scope, handle);
    return undefined;
  }
  const material = resolved.value;
  if (material.kind !== 'material') return { snapshot: defaultMaterialSnapshot(handle) };
  let programs: MaterialRasterPrograms;
  try {
    programs = captureMaterialRasterPrograms(
      material,
      assets,
      lane.materialContext,
      lane.vertexColorAvailable,
      scope.context.materialProgramDemand?.deferred === false,
    );
  } catch (error) {
    if (rejectsUncookedSkinProgram(scope, read.entity, material, assets, lane, mesh, error))
      return undefined;
    throw error;
  }
  const world = worldRenderResources(scope.world);
  const declarationLayout = lane.persistent.get(handle)?.declarationLayout ?? {};
  const snapshot = prepareMaterialSnapshot({
    declarationLayout,
    handle,
    world,
    assets,
    shaderRegistry: scope.context.assets?.shaderRegistry ?? assets.shaderRegistry,
    material,
    programs,
    materialContext: lane.materialContext,
    textureSourceStats: scope.materialTextureSources,
    vertexColorAvailable: lane.vertexColorAvailable,
    geometry: lane.geometry,
    previousProgramSnapshot: lane.persistent.get(handle)?.snapshot,
    materialProgramDemand: scope.context.materialProgramDemand,
  });
  if (!admitSkinMaterial(scope, read, snapshot.materialShaderId, programs.selections))
    return undefined;
  const stored = storeMaterialSnapshot(
    lane.persistent,
    handle,
    snapshot,
    world,
    programs.selections,
    declarationLayout,
  );
  lane.cache.set(handle, stored);
  lane.persistent.set(handle, stored);
  if (read.isRenderable) {
    appendMaterialDispatchEntries(
      pending,
      stored.snapshot.passes,
      read.entity,
      handle,
      scope.renderables.length,
      read.layer,
      0,
      stored.snapshot.materialProgramKeys,
    );
  }
  return stored;
}

function routeMaterialNotRegistered(scope: WorldExtraction, handle: number): void {
  scope.worldInternal._routeError(
    new RhiError({
      code: 'asset-not-registered',
      expected: 'MeshRenderer.material in AssetRegistry',
      hint: 'bind a live material reference from the same asset owner via assets.load or assets.create',
      detail: { assetHandle: handle },
    }),
    {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (material asset-not-registered)',
    },
  );
}

/**
 * A standalone mesh can only satisfy a cooked skinned program through a
 * Skin-bearing mesh. Probe that same exact owner selection only when the
 * resolved mesh really lacks the advertised attributes; otherwise the caller
 * retains the producer's exact publication error instead of guessing from
 * module names/order. `true` means the missing attributes were routed.
 */
function rejectsUncookedSkinProgram(
  scope: WorldExtraction,
  entity: EntityHandle,
  material: MaterialAsset,
  assets: AssetRegistry,
  lane: MaterialLane,
  mesh: MeshDrawDescription | undefined,
  error: unknown,
): boolean {
  const materialContext = lane.materialContext;
  if (!isMissingMaterialProgram(error) || materialContext?.geometry !== 'mesh') return false;
  try {
    const skinnedSelections = materialProgramSelectionsForMaterial(
      material,
      assets,
      { ...materialContext, geometry: 'skinned' },
      'direct',
      lane.vertexColorAvailable,
    );
    if (
      skinnedSelections?.some((selection) => materialProgramUsesSkin(selection.abi)) !== true ||
      mesh === undefined
    )
      return false;
    return routeMissingSkinAttributes(scope, entity, mesh);
  } catch {
    // Preserve the original exact-context publication error.
    return false;
  }
}

function missingSkinAttributes(
  mesh: MeshDrawDescription,
): 'both' | 'skinIndex' | 'skinWeight' | undefined {
  const indices = mesh.layout.attributes.some(({ key }) => key === 'skinIndex');
  const weights = mesh.layout.attributes.some(({ key }) => key === 'skinWeight');
  if (indices && weights) return undefined;
  if (!indices && !weights) return 'both';
  return !indices ? 'skinIndex' : 'skinWeight';
}

/** `true` means the mesh lacked skin attributes and the error was routed. */
function routeMissingSkinAttributes(
  scope: WorldExtraction,
  entity: EntityHandle,
  mesh: MeshDrawDescription,
): boolean {
  const missing = missingSkinAttributes(mesh);
  if (missing === undefined) return false;
  scope.worldInternal._routeError(new MaterialSkinAttrMissingError(entity, missing), {
    severity: Severity.Error,
    systemName: 'RenderSystem.extract (material-skin-attr-missing)',
  });
  return true;
}

/** Skin-bearing entities need a skin program and skin-program meshes need skin attributes. */
function admitSkinMaterial(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  shader: string | undefined,
  selections: readonly MaterialProgramSelection[] | undefined,
): boolean {
  const wantsSkin =
    selections?.some((selection) => materialProgramUsesSkin(selection.abi)) === true ||
    isStandardPbrSkinMaterialShader(shader);
  const skeleton = read.skinSkeleton;
  if (read.skinSkeleton !== undefined && skeleton !== undefined && skeleton !== 0 && !wantsSkin) {
    scope.worldInternal._routeError(new SkinMaterialMismatchError(read.entity, shader), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (skin-material-mismatch)',
    });
    return false;
  }
  if (!wantsSkin || read.meshHandle === undefined || read.meshHandle === 0) return true;
  const current = runtimeAssets(scope.world.assets).meshDraw(read.meshHandle);
  return !current.ok || !routeMissingSkinAttributes(scope, read.entity, current.value);
}

function publishRenderable(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  pending: DispatchEntry[],
): void {
  if ((materials.bindings.handles[0] ?? 0) === 0)
    stageDefaultMaterialDispatch(scope, read, pending);
  const skinBinding = resolveSkinBinding(scope, read);
  if (skinBinding === false) return;
  // A pbr-skin PSO requires the complete three-binding group(2) skin
  // projection. Do not publish a renderable or its staged dispatch when
  // palette extraction was unavailable; the record stage must never
  // reinterpret a skinned vertex stream through an ordinary mesh group.
  if (
    skinBinding === undefined &&
    read.skinSkeleton !== undefined &&
    requiresSkin(materials.primary)
  ) {
    pending.length = 0;
    return;
  }
  // feat-20260601 D-3: the resolved world mat4 feeds the record stage with
  // zero per-snapshot compose. A stale slot (generation gone) skips the entity.
  const worldView = scope.preparedPose
    ? (scope.worldInternal._getArrayView(read.entity, GlobalTransform, 'world') as
        | Float32Array
        | undefined)
    : readPresentationWorldMatrix(scope.world, read.entity);
  if (worldView === undefined) return;
  const transform = scope.poses.capture(worldView);
  const submeshMaterials = resolveSubmeshMaterials(scope, materials);
  // Without authored ShadowParticipation, a mesh whose every material blends
  // (transparent, additive) casts no shadow, like Three.js castShadow=false.
  if (
    !read.shadowParticipationAuthored &&
    submeshMaterials.every((material) => material.transparent === true)
  )
    read.shadowCastDisabled = true;
  stageSubmeshDispatch(scope, read, materials, submeshMaterials, pending);
  const geometry = resolveRenderableGeometry(scope, read, materials, submeshMaterials);
  if (geometry === undefined) return;
  const renderable = composeRenderable(
    scope,
    read,
    materials,
    submeshMaterials,
    geometry,
    transform,
    skinBinding,
  );
  // Material passes stay shared; participation only filters this entity's
  // ShadowCaster work, so every shadow map and cull test sees it absent.
  // Screen-space points and lines have no world-space footprint to cast.
  if (read.shadowCastDisabled || read.pointsLinesComponent !== undefined)
    removeShadowCasterDispatch(pending);
  const pipelinePreparation = read.preparePipelines
    ? pending.map(
        ({ entityIndex: _entityIndex, renderableIndex: _renderableIndex, ...pass }) => pass,
      )
    : undefined;
  if (
    !admitFrustumVisibility(
      scope,
      read,
      geometry,
      transform,
      pending,
      pipelinePreparation !== undefined,
    )
  )
    return;
  // Retain hidden snapshots for incremental composition, but never publish
  // their display or ShadowCaster passes to either record lane.
  if (!read.authorVisible) pending.length = 0;
  for (const entry of pending) scope.dispatch.push(entry);
  scope.renderables.push(
    withMobilityAndPreparation(scope.world, renderable, read, pipelinePreparation),
  );
}

/**
 * Default-material entities (handle 0) dispatch every Pass of the default
 * snapshot, so shadow casting stays the default behaviour (opt out with
 * ShadowParticipation { cast: false }) and each Pass reads the row ABI of the
 * snapshot's own Unlit program, exactly as `Materials.unlit()` does.
 */
function stageDefaultMaterialDispatch(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  pending: DispatchEntry[],
): void {
  appendMaterialDispatchEntries(
    pending,
    defaultMaterialSnapshot().passes,
    read.entity,
    0,
    scope.renderables.length,
    read.layer,
  );
}

function requiresSkin(material: MaterialSelection): boolean {
  return (
    material.snapshot.materialShaderId === 'forgeax::pbr-skin' ||
    material.programSelections?.some((selection) => materialProgramUsesSkin(selection.abi)) === true
  );
}

/**
 * Static Skin membership; actual demand resolves the shared pose. `false`
 * rejects the entity, `undefined` publishes it without a binding.
 */
function resolveSkinBinding(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
): SkinBindingInput | undefined | false {
  const skeletonHandle = read.skinSkeleton;
  if (skeletonHandle === undefined || skeletonHandle === 0 || scope.assets == null)
    return undefined;
  const entity = read.entity;
  const worldInternal = scope.worldInternal;
  // Skin + Instances coexistence is forbidden (D-10).
  if (read.layout?.instances) {
    worldInternal._routeError(new SkinInstancesCoexistForbiddenError(entity), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (skin-instances-coexist)',
    });
    return false;
  }
  const skeletonRes = runtimeAssets(scope.world.assets).resolveAsset<SkeletonAsset>(
    skeletonHandle as AssetHandle<'skeleton'>,
  );
  if (!skeletonRes.ok || skeletonRes.value.kind !== 'skeleton') {
    worldInternal._routeError(new SkeletonResolveFailedError(entity, skeletonHandle), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (skeleton-resolve-failed)',
    });
    return false;
  }
  const jointCount = skeletonRes.value.jointCount;
  const skinJoints = readRenderArrayView(scope.world, entity, read.source.skin, 'joints');
  if (skinJoints === undefined) return false;
  if (skinJoints.length !== jointCount) {
    // Keep static membership; the fixed-frame demand rejects incompatible resources.
    worldInternal._routeError(new JointCountMismatchError(entity, jointCount, skinJoints.length), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (joint-count-mismatch)',
    });
  }
  if (skinJoints.length === 0) return false;
  const affinePoint = scope.world[worldRead].getFieldValue(entity, read.source.skin, 'affinePoint');
  return {
    skeleton: skeletonHandle,
    joints: Object.freeze(Array.from(skinJoints, Number)),
    ...(affinePoint ? { affinePoint: true } : {}),
  };
}

/**
 * feat-20260608 M5 amend / w11-a: per-submesh `materials[]` aligned 1-1 with
 * `MeshAsset.submeshes[]`; slot 0 is the entity-level snapshot.
 */
function resolveSubmeshMaterials(
  scope: WorldExtraction,
  materials: EntityMaterials,
): MaterialSnapshot[] {
  const resolved: MaterialSnapshot[] = [materials.primary.snapshot];
  const assets = scope.assets;
  if (assets == null) return resolved;
  const { handles } = materials.bindings;
  const lane = materials.lane;
  for (let index = 1; index < handles.length; index += 1) {
    const handle = handles[index] ?? 0;
    resolved.push(
      lane.cache.get(handle)?.snapshot ??
        resolveMaterialSnapshot(
          handle,
          worldRenderResources(scope.world),
          scope.context.assets ?? assets,
          lane.cache,
          lane.persistent,
          lane.materialContext,
          scope.materialTextureSources,
          lane.vertexColorAvailable,
          lane.geometry,
          scope.context.materialProgramDemand,
        ),
    );
  }
  return resolved;
}

function stageSubmeshDispatch(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
  pending: DispatchEntry[],
): void {
  if (scope.assets == null) return;
  const { handles } = materials.bindings;
  const lane = materials.lane;
  const primaryHandle = handles[0] ?? 0;
  for (let index = 1; index < handles.length; index += 1) {
    const handle = handles[index] ?? 0;
    if (handle === primaryHandle) continue;
    const entry =
      lane.cache.get(handle) ??
      readPersistentMaterialSnapshot(lane.persistent, handle, worldRenderResources(scope.world));
    appendMaterialDispatchEntries(
      pending,
      entry?.snapshot.passes ?? (handle === 0 ? [DEFAULT_FORWARD_PASS] : []),
      read.entity,
      handle,
      scope.renderables.length,
      read.layer,
      0,
      submeshMaterials[index]?.materialProgramKeys,
    );
  }
}

/**
 * Sprite/explicit instances, LOD, morph and culling bounds of one renderable.
 * `undefined` means an instance payload was rejected. Instances are
 * snapshotted before the CPU visibility decision so culling and record share
 * one detached snapshot within the frame.
 */
function resolveRenderableGeometry(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
) {
  const spriteInstances = resolveSpriteInstances(scope, read, materials.primary.snapshot);
  if (spriteInstances === false) return undefined;
  const cpuMesh = read.morphWeights === undefined ? undefined : resolveEntityMesh(scope, read);
  const mesh = scope.assets == null ? resolveEntityMeshDraw(scope, read) : materials.bindings.mesh;
  const morph = cpuMesh === undefined ? undefined : morphSnapshotFor(cpuMesh, read.morphWeights);
  const localAabb = renderableLocalAabb(read, mesh, cpuMesh, morph, submeshMaterials);
  const pointsLinesStyle = pointsLinesStyleOf(scope, read);
  const cullingLocalAabb = expandPointsLinesBounds(localAabb ?? [], pointsLinesStyle);
  const instances = resolveInstancesSnapshot(scope, read);
  if (instances === false) return undefined;
  return {
    spriteInstances,
    lods: mesh?.lods,
    lodHysteresis: mesh?.lodHysteresis,
    morph,
    localAabb,
    cullingLocalAabb,
    pointsLinesStyle,
    instances,
  };
}

type RenderableGeometry = NonNullable<ReturnType<typeof resolveRenderableGeometry>>;

/**
 * Producer-owned finite local bounds. Morph targets expand the authored bounds
 * by their weighted deltas. Bind-pose bounds cannot enclose arbitrary animated
 * joint scale, so skinned rows stay conservatively visible (no bounds).
 */
function renderableLocalAabb(
  read: MeshRendererRowRead,
  mesh: MeshDrawDescription | undefined,
  cpuMesh: MeshAsset | undefined,
  morph: MorphSnapshot | undefined,
  submeshMaterials: readonly MaterialSnapshot[],
): Float32Array | undefined {
  const meshAabb = read.skinSkeleton !== undefined ? undefined : mesh?.aabb;
  const authored = !isFiniteAabb(meshAabb)
    ? undefined
    : morph === undefined || cpuMesh === undefined
      ? sharedAabb(meshAabb)
      : morphLocalAabb(meshAabb, cpuMesh, morph);
  const displacementRadius = standardDisplacementRadius(submeshMaterials);
  const expanded = expandDisplacementBounds(authored, displacementRadius);
  return read.skinSkeleton !== undefined && displacementRadius > 0 ? undefined : expanded;
}

function pointsLinesStyleOf(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
): PointsLinesStyle | undefined {
  const scalar = scope.world[worldRead];
  const entity = read.entity;
  if (read.pointsLinesComponent === 'Points') {
    const shape = pointShapeFromU32(scalar.getFieldValue(entity, Points, 'shape') as number);
    const sizeUnits = pointSizeUnitsFromU32(
      scalar.getFieldValue(entity, Points, 'sizeUnits') as number,
    );
    return shape === undefined || sizeUnits === undefined
      ? undefined
      : {
          kind: 'points',
          size: scalar.getFieldValue(entity, Points, 'size') as number,
          minPixelSize: scalar.getFieldValue(entity, Points, 'minPixelSize') as number,
          sizeUnits,
          shape,
        };
  }
  if (read.pointsLinesComponent !== 'Lines') return undefined;
  return {
    kind: 'lines',
    width: scalar.getFieldValue(entity, Lines, 'width') as number,
    widthUnits: scalar.getFieldValue(entity, Lines, 'widthUnits') as number,
    cap: scalar.getFieldValue(entity, Lines, 'cap') as number,
    dashSize: scalar.getFieldValue(entity, Lines, 'dashSize') as number,
    gapSize: scalar.getFieldValue(entity, Lines, 'gapSize') as number,
    dashOffset: scalar.getFieldValue(entity, Lines, 'dashOffset') as number,
  };
}

/** `false` rejects the entity after routing its SpriteInstances error. */
function resolveSpriteInstances(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  material: MaterialSnapshot,
): SpriteInstancesSnapshot | undefined | false {
  if (!read.layout?.spriteInstances) return undefined;
  const { entity } = read;
  const worldInternal = scope.worldInternal;
  // (1) mutually exclusive with Instances (peers — pick one).
  if (read.layout?.instances) {
    worldInternal._routeError(new SpriteInstancesMutuallyExclusiveWithInstancesError(entity), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (sprite-instances-mutually-exclusive)',
    });
    return false;
  }
  // (2) The immutable author program owns geometry semantics even when
  // program selection returns a cooked artifact key.
  if (!materialUsesSpriteGeometry(material)) {
    worldInternal._routeError(
      new SpriteInstancesRequiresSpriteShaderError(
        entity,
        material.materialShaderId ?? 'undefined',
      ),
      {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (sprite-instances-requires-sprite-shader)',
      },
    );
    return false;
  }
  const transforms = worldInternal._getArrayView(entity, SpriteInstances, 'transforms');
  const regions = worldInternal._getArrayView(entity, SpriteInstances, 'regions');
  if (transforms === undefined || regions === undefined) return undefined;
  // (3) A stride violation expresses as a count mismatch under the canonical
  // derivation transforms/16 vs regions/4; zero instances is lawful.
  const instanceCount = transforms.length / 16;
  if (
    transforms.length % 16 !== 0 ||
    regions.length % 4 !== 0 ||
    instanceCount !== regions.length / 4
  ) {
    worldInternal._routeError(
      new SpriteInstancesCountMismatchError(transforms.length, regions.length),
      {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (sprite-instances-count-mismatch)',
      },
    );
    return false;
  }
  return {
    transforms: new Float32Array(transforms),
    regions: new Float32Array(regions),
    instanceCount,
    cacheKey: entity,
    archVersion: read.archVersion,
  };
}

/** `false` rejects the entity after routing its Instances projection error. */
function resolveInstancesSnapshot(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
): InstancesSnapshot | undefined | false {
  if (!read.layout?.instances) return undefined;
  const { world, worldInternal } = scope;
  const { entity } = read;
  const collections = scope.context.instanceCollections;
  const transforms =
    worldInternal._getArrayView(entity, Instances, 'transforms') ?? new Float32Array();
  const projected =
    collections === undefined
      ? validateInstanceTransforms(transforms)
      : collections.project(world, entity, transforms, {
          epoch: readMutationEpoch(world),
          changedSince: (since) =>
            readArrayRangesChangedSince(world, entity, Instances, 'transforms', since),
        });
  if (projected instanceof Error) {
    worldInternal._routeError(projected, {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (Instances transforms)',
    });
    return false;
  }
  return {
    transforms: projected?.transforms ?? new Float32Array(transforms),
    instanceCount: transforms.length / 16,
    cacheKey: entity,
    archVersion: projected === undefined ? read.archVersion : 0,
    ...(projected === undefined
      ? {}
      : {
          collectionId: projected.collectionId,
          revision: projected.revision,
          generations: projected.generations,
          ...(projected.dirtyRanges === undefined ? {} : { dirtyRanges: projected.dirtyRanges }),
        }),
  };
}

function composeRenderable(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
  geometry: RenderableGeometry,
  transform: TransformSnapshot,
  skinBinding: SkinBindingInput | undefined,
): RenderableSnapshot {
  // Ordinary meshes do not own a GPU producer. Probe membership before the
  // full component read so absence does not allocate an ECS error per draw.
  const gpuVertex = read.layout?.gpuVertex
    ? scope.world.get(read.entity, GpuMeshVertexSource)
    : undefined;
  return {
    ...(gpuVertex?.ok
      ? {
          gpuVertexSource: { feature: gpuVertex.value.feature, resource: gpuVertex.value.resource },
        }
      : {}),
    ...(read.layout?.spriteRegion
      ? {
          spriteRegion: spriteUvRegion(
            scope.worldInternal._getArrayView(read.entity, SpriteRegionOverride, 'region'),
            0,
            0,
          ),
        }
      : {}),
    layer: read.layer,
    ...(read.shadowChannels === undefined ? {} : { shadowChannels: read.shadowChannels }),
    ...(read.shadowCastDisabled || read.pointsLinesComponent !== undefined
      ? { shadowCaster: false as const }
      : {}),
    lightingChannels: read.lightingChannels,
    renderLayers: read.renderLayers,
    ...(read.frustumCulled ? {} : { frustumCulled: false as const }),
    assetHandle: Math.round(read.meshHandle ?? 0),
    transform,
    ...(geometry.lods === undefined ? {} : { lods: geometry.lods }),
    ...(geometry.lodHysteresis === undefined ? {} : { lodHysteresis: geometry.lodHysteresis }),
    ...(geometry.localAabb !== undefined ? { localAabb: geometry.cullingLocalAabb } : {}),
    material: MaterialResource.from(materials.primary.snapshot),
    materials: submeshMaterials.map(MaterialResource.from),
    materialBindingSources: materials.bindings.sources,
    materialOverrides: captureEntityMaterialOverrides(scope, materials),
    materialBindingDiagnostics: materials.bindings.diagnostics,
    entityKey: read.entity,
    ...renderableAttachments(scope, read, materials, submeshMaterials, geometry, skinBinding),
  };
}

function captureEntityMaterialOverrides(
  scope: WorldExtraction,
  materials: EntityMaterials,
): ReturnType<typeof captureMaterialOverrides> {
  const { world, assets } = scope;
  const lane = materials.lane;
  return captureMaterialOverrides(
    Array.from(materials.view ?? [], (handle) => {
      if (handle === 0 || assets == null) return undefined;
      const current = runtimeAssets(world.assets).resolveAsset(handle);
      if (!current.ok || current.value.kind !== 'material') return undefined;
      return MaterialResource.from(
        resolveMaterialSnapshot(
          handle,
          worldRenderResources(world),
          scope.context.assets ?? assets,
          lane.cache,
          lane.persistent,
          lane.materialContext,
          scope.materialTextureSources,
          lane.vertexColorAvailable,
          lane.geometry,
          scope.context.materialProgramDemand,
        ),
      );
    }),
  );
}

function renderableAttachments(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
  geometry: RenderableGeometry,
  skinBinding: SkinBindingInput | undefined,
): Pick<
  RenderableSnapshot,
  | 'authorVisible'
  | 'skinBinding'
  | 'capsuleShadowRequested'
  | 'morph'
  | 'instances'
  | 'spriteInstances'
  | 'pointsLines'
  | 'gpuDrivenDraws'
  | 'waterOwner'
> {
  const pointsLines = pointsLinesSnapshotOf(read, materials, geometry);
  const water = scope.world.hasResource(WATER_SYSTEM_RESOURCE)
    ? scope.world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    : undefined;
  const body = read.layout?.water ? water?.snapshot(`scene-entity:${read.entity}`) : undefined;
  const binding = body?.binding;
  const zone =
    binding?.kind === 'bound'
      ? water
          ?.zoneSnapshots()
          .find(
            (zone) => zone.guid === binding.zoneGuid && zone.generation === binding.zoneGeneration,
          )
      : undefined;
  return {
    ...(body === undefined || body.asset.flags.affectsWaterMesh
      ? {}
      : {
          waterOwner: ownWaterMaterialOwner({
            guid: body.guid,
            generation: body.sceneGeneration,
            worldIdentity: scope.world.identity,
            zoneGeneration: binding?.kind === 'bound' ? binding.zoneGeneration : 0,
            ...(zone === undefined
              ? {}
              : {
                  zoneGuid: zone.guid,
                  targetFormat:
                    zone.asset.waterInfo.format === 'rgba32f'
                      ? ('rgba32float' as const)
                      : ('rgba16float' as const),
                }),
          }),
        }),
    ...(read.authorVisible ? {} : { authorVisible: false }),
    ...(skinBinding === undefined ? {} : { skinBinding }),
    ...(read.layout?.capsuleShadow ? { capsuleShadowRequested: true as const } : {}),
    ...(geometry.morph !== undefined ? { morph: geometry.morph } : {}),
    ...(geometry.instances !== undefined ? { instances: geometry.instances } : {}),
    ...(geometry.spriteInstances !== undefined
      ? { spriteInstances: geometry.spriteInstances }
      : {}),
    ...(pointsLines !== undefined ? { pointsLines } : {}),
    ...gpuDrivenRenderableFields(
      scope,
      pointsLines !== undefined,
      materials,
      submeshMaterials,
      geometry,
      skinBinding,
    ),
  };
}

function pointsLinesSnapshotOf(
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  geometry: RenderableGeometry,
): PointsLinesRetainedSnapshot | undefined {
  if (read.pointsLinesComponent === undefined) return undefined;
  return {
    entityKey: read.entity,
    component: read.pointsLinesComponent,
    meshHandle: Math.round(read.meshHandle ?? 0),
    materialHandle: materials.bindings.handles[0] ?? 0,
    style: geometry.pointsLinesStyle,
    layer: read.layer,
    ...(read.shadowChannels === undefined ? {} : { shadowChannels: read.shadowChannels }),
    sortKey: read.sortKey,
    visible: true,
    sourceBounds: geometry.cullingLocalAabb,
    viewport: { width: 0, height: 0, dpr: 1 },
    projection: identityProjection(),
  };
}

function gpuDrivenRenderableFields(
  scope: WorldExtraction,
  pointsLines: boolean,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
  geometry: RenderableGeometry,
  skinBinding: SkinBindingInput | undefined,
): Pick<RenderableSnapshot, 'gpuDrivenDraws'> | undefined {
  // The Points/Lines owner draws these rows; the GPU Scene holds no geometry for them.
  if (pointsLines) return undefined;
  const { lods } = geometry;
  const getMaterialShaderArtifact = scope.context.getMaterialShaderArtifact;
  const gpuDrivenDraws = buildGpuDrivenDraws({
    mesh: materials.bindings.mesh,
    materials: submeshMaterials,
    fallbackMaterial: materials.primary.snapshot,
    deformation: skinBinding === undefined ? 'rigid' : 'skin',
    ...(getMaterialShaderArtifact === undefined
      ? {}
      : {
          getMaterialShaderArtifact: (id, request) =>
            scope.assets?.shaderRegistry.isSourceBackedMaterialArtifact(id) === true
              ? materialRasterSourceFacts(scope.assets.shaderRegistry, id, request)
              : getMaterialShaderArtifact(id, request),
        }),
    ...(lods === undefined
      ? {}
      : {
          lodMeshes: lods.map((lod) => {
            const handle =
              typeof lod.mesh === 'number'
                ? lod.mesh
                : worldRenderResources(scope.world).handleForGuid(AssetGuid.format(lod.mesh));
            if (handle === undefined) return undefined;
            const lower = runtimeAssets(scope.world.assets).meshDraw(handle);
            return lower.ok ? lower.value : undefined;
          }),
        }),
  });
  for (const draw of gpuDrivenDraws) {
    if (draw.preparationError === undefined) continue;
    scope.worldInternal._routeError(draw.preparationError, {
      severity: Severity.Error,
      systemName: `RenderSystem.extract (gpu-driven-preparation:${draw.preparationError.code})`,
    });
  }
  return gpuDrivenDraws.length > 0 ? { gpuDrivenDraws } : undefined;
}

function removeShadowCasterDispatch(pending: DispatchEntry[]): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i]?.tags.LightMode === 'ShadowCaster') pending.splice(i, 1);
  }
}

/**
 * Shadow-only renderables stay in the detached snapshot for the depth
 * passes, but must not leak their forward/transparent dispatch entries into
 * the main camera submission.
 */
function retainShadowCasterDispatch(pending: DispatchEntry[]): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i]?.tags.LightMode !== 'ShadowCaster') pending.splice(i, 1);
  }
}

/**
 * feat-20260528-frustum-culling M3 / w10: skip the entity when a valid AABB
 * exists AND every camera frustum rejects it. Missing or malformed bounds are
 * conservative always-visible fallbacks. MeshRenderer can opt out of this test.
 * `false` drops the entity; a shadow-only survivor keeps only ShadowCaster work.
 */
function admitFrustumVisibility(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  geometry: RenderableGeometry,
  transform: TransformSnapshot,
  pending: DispatchEntry[],
  preparing: boolean,
): boolean {
  const { instances } = geometry;
  // No instance can contribute a visible bound; the retained snapshot still
  // records instanceCount=0 for the record stage.
  if (!read.frustumCulled || geometry.localAabb === undefined || instances?.instanceCount === 0)
    return true;
  // With no camera frustum every entity is visible, so the union bound would
  // only feed a test whose result is already known.
  if (scope.frustumPlanes.length === 0) {
    scope.frustumTotal += 1;
    return true;
  }
  const pose = CapturedSceneTransform.storage(transform);
  const instanceBounds =
    instances === undefined
      ? undefined
      : deriveInstancesUnionBounds({
          meshAabb: geometry.cullingLocalAabb,
          entityWorld: CapturedSceneTransform.column(pose),
          entityWorldOffset: CapturedSceneTransform.offset(pose),
          transforms: instances.transforms,
        });
  // Missing/malformed derived facts (non-finite producer matrices/AABB) are a
  // conservative no-cull result.
  if (read.layout?.instances && (instances === undefined || instanceBounds === undefined))
    return true;
  const worldAabb = worldCullingAabb(scope, geometry.cullingLocalAabb, pose, instanceBounds);
  scope.frustumTotal += 1;
  if (intersectsAnyFrustum(scope.frustumPlanes, worldAabb)) return true;
  scope.frustumCulled += 1;
  if (!castsVisibleShadow(scope, pending, worldAabb) && !preparing) return false;
  retainShadowCasterDispatch(pending);
  return true;
}

/** Same-source world bounds as the record stage's mesh SSBO (feat-20260601 D-3). */
function worldCullingAabb(
  scope: WorldExtraction,
  localAabb: Float32Array | readonly number[],
  pose: import('./scene/captured-transform').ScenePoseStorage,
  instanceBounds: ArrayLike<number> | undefined,
): box3.Box3 {
  const worldAabb = box3.create();
  if (instanceBounds === undefined) {
    scope.cullPose ??= new Float32Array(16);
    CapturedSceneTransform.writeStorage(scope.cullPose, 0, pose);
    box3.transformBox3(worldAabb, localAabb, scope.cullPose);
    return worldAabb;
  }
  for (let index = 0; index < 6; index += 1) worldAabb[index] = instanceBounds[index] ?? 0;
  return worldAabb;
}

/** Visible when one camera frustum intersects, or a degenerate camera has no planes. */
function intersectsAnyFrustum(frusta: readonly Float32Array[], worldAabb: box3.Box3): boolean {
  for (const planes of frusta) {
    if (planes.length === 0) return true;
    if (frustum.intersectsBox(planes as frustum.Frustum, worldAabb as box3.Box3Like)) return true;
  }
  return false;
}

function castsVisibleShadow(
  scope: WorldExtraction,
  pending: readonly DispatchEntry[],
  worldAabb: box3.Box3,
): boolean {
  return (
    scope.shadowFrusta.length > 0 &&
    pending.some((entry) => entry.tags.LightMode === 'ShadowCaster') &&
    scope.shadowFrusta.some((lightPlanes) =>
      frustum.intersectsBox(lightPlanes, worldAabb as box3.Box3Like),
    )
  );
}

/** Pose and capsule shadow admission belong to the selected fixed frame's actual demand. */
function withMobilityAndPreparation(
  world: World,
  renderable: RenderableSnapshot,
  read: MeshRendererRowRead,
  pipelinePreparation: RenderableSnapshot['pipelinePreparation'],
): RenderableSnapshot {
  const mobilityStatic =
    mobilityFromRow(world, read.mobilityKind, read.mobilityParent) === 'static';
  const authored =
    !mobilityStatic && !read.shadowReceiveDisabled
      ? renderable
      : {
          ...renderable,
          ...(mobilityStatic ? { mobility: 'static' as const } : {}),
          ...(read.shadowReceiveDisabled ? { shadowReceiver: false as const } : {}),
        };
  return ownWaterMaterialAdmissionSource(
    pipelinePreparation === undefined ? authored : { ...authored, pipelinePreparation },
  );
}

function identityProjection(): Float32Array {
  const projection = new Float32Array(16);
  projection[0] = 1;
  projection[5] = 1;
  projection[10] = 1;
  projection[15] = 1;
  return projection;
}
