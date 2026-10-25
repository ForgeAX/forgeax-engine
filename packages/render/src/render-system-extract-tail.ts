import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  readArrayRangesChangedSince,
  readMutationEpoch,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { isFiniteAabb } from '@forgeax/engine-geometry';
import { box3, frustum } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { RhiError } from '@forgeax/engine-rhi';
import {
  GlobalTransform,
  Mobility,
  MobilityKindValue,
  MorphWeights,
  readPresentationWorldMatrix,
  Transform,
} from '@forgeax/engine-scene';
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
import { buildCameraFrusta } from './camera-frusta';
import {
  CapsuleShadow,
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
import { validateChannelMask } from './components/lighting-channels';
import { ProjectedDecalInvalidError } from './decals/component';
import { extractProjectedDecals } from './decals/extract';
import {
  createLightResourceUnavailable,
  MaterialSkinAttrMissingError,
  SkinMaterialMismatchError,
} from './errors/render';
import { buildGpuDrivenDraws } from './extract/gpu-driven';
import type { VisibilitySnapshot } from './extract/visibility';
import { extractWorldEnvironment } from './extract/world-environment';
import { MotionBlurValidationError } from './features/motion-blur/motion-blur-params';
import type {
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
import { extractGlyphSources } from './glyph-source';
import { type InstanceProjectionStore, validateInstanceTransforms } from './instances';
import { deriveInstancesUnionBounds } from './instances-derived-bounds';
import { MaterialResource, materialUsesSpriteGeometry } from './material-resource';
import {
  type MeshMaterialBindingDiagnostic,
  type MeshMaterialBindingSource,
  type ResolveMeshMaterialBindingsResult,
  resolveMeshMaterialBindings,
} from './mesh-material-bindings';
import { isStandardPbrSkinMaterialShader } from './pbr-pipeline';
import { expandPointsLinesBounds } from './points-lines/bounds';
import type { PointsLinesRetainedSnapshot, PointsLinesStyle } from './points-lines/snapshot';
import { IES_SLICE_CAPACITY } from './prepare/extended-lighting/resources';
import { renderAsset, worldRenderResources } from './publication/resource-scope';
import { type CameraSnapshot, STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import type {
  DispatchEntry,
  ExtractedFrame,
  ExtractedLights,
  ExtractFramesOwner,
  InstancesSnapshot,
  MaterialProgramSelection,
  MaterialSnapshot,
  MaterialSnapshotCache,
  MaterialSnapshotCacheEntry,
  MaterialSnapshotCachesByWorld,
  MaterialSnapshotContexts,
  MaterialTextureSourceStats,
  MorphSnapshot,
  PointLightSnapshot,
  PointShadowSnapshot,
  PreparedExtractContext,
  RectAreaDirectLightSnapshot,
  RenderableSnapshot,
  SpotLightSnapshot,
  SpriteInstancesSnapshot,
  TransformSnapshot,
  WorldInternalView,
} from './render-system-extract';
import {
  appendMaterialDispatchEntries,
  computeDirectionalCsm,
  createWorldInternalView,
  DEFAULT_FORWARD_PASS,
  defaultMaterialSnapshot,
  fogState,
  materialProgramSelectionsForMaterial,
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
import { captureMaterialOverrides } from './scene/mesh-materials';
import { buildShadowFrusta } from './scene/shadow-visibility';
import type { SkinBindingInput } from './scene/skin-scene-inputs';
import { spriteUvRegion } from './sprite-region';
import {
  expandDisplacementBounds,
  standardDisplacementRadius,
} from './standard-displacement-bounds';
import { extractTerrainSources } from './terrain/source.js';
import { extractTilemapSources } from './tilemap-source';

function isMissingMaterialProgram(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === 'material-specialization-not-cooked'
  );
}

export function extractFrames(
  worlds: readonly World[],
  owner: number | ExtractFramesOwner,
  assets?: AssetRegistry | null,
  materialSnapshotCachesByWorld?: MaterialSnapshotCachesByWorld,
  options: {
    readonly materialContext?: MaterialCookRasterContext;
    readonly cull?: 'normal' | 'none';
    readonly viewExtent?: import('./render-contract').PhysicalViewExtent;
    readonly renderables?:
      | 'full'
      | 'none'
      | {
          readonly kind: 'partial';
          readonly entitiesByWorld: readonly (ReadonlySet<number> | undefined)[];
        };
    readonly retainHidden?: boolean;
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
  } = {},
): ExtractedFrame {
  // w4: normalize the owner argument. A bare number is the legacy single-owner
  // form (cameraOwner === resourceOwner); an object carries the two split
  // indices. When they coincide the code path is byte-identical to the pre-w4
  // single-owner behaviour (w1 contract combination 2).
  const owners: ExtractFramesOwner =
    typeof owner === 'number' ? { cameraOwner: owner, resourceOwner: owner } : owner;
  const framesByWorld = extractWorldFrames(
    worlds,
    owners,
    assets,
    materialSnapshotCachesByWorld,
    options,
  );
  // Restore the caller's world order after the camera-owner-first extraction.
  const succeededFrames: ExtractedFrame[] = [];
  const succeededIndices: number[] = [];
  for (let wi = 0; wi < worlds.length; wi++) {
    const frame = framesByWorld.get(wi);
    if (frame === undefined) continue;
    succeededFrames.push(frame);
    succeededIndices.push(wi);
  }
  const merged = mergeRenderables(worlds, succeededFrames, succeededIndices);
  // AC-05/06 + w4 owner split (D-3 / R-6): cameras come from the cameraOwner
  // world; skylight / skybox / postProcessParams come from the resourceOwner
  // world (holistic snapshot selection). When cameraOwner === resourceOwner
  // both resolve to the same frame — byte-identical to the single-owner path.
  const cameraOwnerFrame = framesByWorld.get(owners.cameraOwner);
  const resourceOwnerFrame = framesByWorld.get(owners.resourceOwner);
  const projectedDecals = succeededFrames
    .flatMap((frame, index) =>
      (frame.projectedDecals ?? []).map((decal) => ({
        ...decal,
        worldId: succeededIndices[index] ?? 0,
      })),
    )
    .sort((a, b) => a.order - b.order || a.worldId - b.worldId || a.entityKey - b.entityKey);
  const cameras =
    cameraOwnerFrame?.cameras.map((camera) => ({
      ...camera,
      worldId: owners.cameraOwner,
      projectedDecals,
    })) ?? [];
  const auxiliaryCameras =
    cameraOwnerFrame?.auxiliaryCameras.map((camera) => ({
      ...camera,
      worldId: owners.cameraOwner,
    })) ?? [];
  const cubeCameras = cameraOwnerFrame !== undefined ? [...cameraOwnerFrame.cubeCameras] : [];
  const lights = refitDirectionalCsm(
    mergeLights(worlds, succeededFrames, succeededIndices),
    cameras[0],
  );
  const volumetricFog = resourceOwnerFrame?.volumetricFog;
  const cloudLayer = resourceOwnerFrame?.cloudLayer;
  const fogFailure = resourceOwnerFrame?.fogFailure;
  const environment = resourceOwnerFrame?.environment;
  return {
    projectedDecals,
    cameras,
    auxiliaryCameras,
    cubeCameras,
    reflectionProbes: succeededFrames.flatMap((f, index) => {
      const worldId = succeededIndices[index] ?? 0;
      return (f.reflectionProbes ?? []).map((probe) => ({ ...probe, worldId }));
    }),
    lights,
    ...(volumetricFog === undefined
      ? {}
      : { volumetricFog: { ...volumetricFog, worldId: owners.resourceOwner } }),
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    renderables: merged.renderables,
    dispatch: merged.dispatch,
    skylight: resourceOwnerFrame?.skylight,
    skylightCount: resourceOwnerFrame?.skylightCount ?? 0,
    lightProbes: succeededFrames.flatMap((frame, index) => {
      const worldId = succeededIndices[index] ?? 0;
      return (frame.lightProbes ?? []).map((probe) => ({ ...probe, worldId }));
    }),
    skybox: resourceOwnerFrame?.skybox,
    skyboxCount: resourceOwnerFrame?.skyboxCount ?? 0,
    fog: resourceOwnerFrame?.fog,
    ...(fogFailure === undefined ? {} : { fogFailure }),
    environment,
    environmentReady: resourceOwnerFrame !== undefined && environment !== undefined,
    // D-3: frustumStats — culled/total summed across worlds.
    frustumStats: {
      culled: succeededFrames.reduce((s, f) => s + f.frustumStats.culled, 0),
      total: succeededFrames.reduce((s, f) => s + f.frustumStats.total, 0),
    },
    visibilityStats: {
      explicitlyHidden: succeededFrames.reduce((s, f) => s + f.visibilityStats.explicitlyHidden, 0),
    },
    materialTextureSources: mergeMaterialTextureSources(succeededFrames),
    postProcessParams: ownerPostProcessParams(cameraOwnerFrame, resourceOwnerFrame),
    visibilitySnapshots: merged.visibilitySnapshots,
    featureVisibilitySnapshots: merged.featureVisibilitySnapshots,
    hiddenEntityReports: merged.hiddenEntityReports,
  };
}

type ExtractFramesOptions = NonNullable<Parameters<typeof extractFrames>[4]>;
type WorldExtractRequest = NonNullable<Parameters<typeof prepareExtractContext>[1]>;

/**
 * D-2: per-world extract with error isolation. Each world runs extractFrame
 * over the final state published by world.update(); a failed world routes to
 * its own error handler and its contribution is skipped (AC-09). The
 * camera-owner frame is extracted first because non-owner worlds cull against
 * its surfaced camera.
 */
function extractWorldFrames(
  worlds: readonly World[],
  owners: ExtractFramesOwner,
  assets: AssetRegistry | null | undefined,
  materialSnapshotCachesByWorld: MaterialSnapshotCachesByWorld | undefined,
  options: ExtractFramesOptions,
): Map<number, ExtractedFrame> {
  const { cameraOwner, resourceOwner } = owners;
  // Resource-owner selection is a frame-level concern. Select Fog once before
  // per-world extraction so non-owner worlds do not scan their ECS tables for
  // a value that the merge layer will discard.
  const resourceOwnerWorld = worlds[resourceOwner];
  const resourceOwnerFog =
    resourceOwnerWorld === undefined ? null : (selectFogFrame(resourceOwnerWorld) ?? null);
  const extractionOrder = Array.from({ length: worlds.length }, (_, wi) => wi).sort((a, b) => {
    if (a === cameraOwner) return -1;
    if (b === cameraOwner) return 1;
    return a - b;
  });
  const framesByWorld = new Map<number, ExtractedFrame>();
  for (const wi of extractionOrder) {
    const world = worlds[wi];
    if (world === undefined) continue;
    try {
      const prepared = prepareExtractContext(world, {
        ...worldResourceRequest(world, assets, materialSnapshotCachesByWorld, options),
        resourceOwnerFog: wi === resourceOwner ? resourceOwnerFog : null,
        ...worldViewRequest(wi, owners, options, framesByWorld.get(cameraOwner)),
      });
      framesByWorld.set(wi, extractFrame(world, prepared));
    } catch (err) {
      routeWorldExtractFailure(world, wi, err);
    }
  }
  return framesByWorld;
}

/** Asset, material and preparation inputs owned by one World. */
function worldResourceRequest(
  world: World,
  assets: AssetRegistry | null | undefined,
  materialSnapshotCachesByWorld: MaterialSnapshotCachesByWorld | undefined,
  request: ExtractFramesOptions,
): WorldExtractRequest {
  return {
    ...(assets !== undefined ? { assets } : {}),
    ...(materialSnapshotCachesByWorld === undefined
      ? {}
      : {
          materialSnapshotContexts: materialSnapshotContextsFor(
            materialSnapshotCachesByWorld,
            world,
          ),
        }),
    ...(request.materialContext === undefined ? {} : { materialContext: request.materialContext }),
    ...(request.preparationMesh?.world === world
      ? { preparationMesh: request.preparationMesh }
      : {}),
    ...(request.getMaterialShaderArtifact === undefined
      ? {}
      : { getMaterialShaderArtifact: request.getMaterialShaderArtifact }),
    ...(request.instanceCollections === undefined
      ? {}
      : { instanceCollections: request.instanceCollections }),
  };
}

function materialSnapshotContextsFor(
  cachesByWorld: MaterialSnapshotCachesByWorld,
  world: World,
): MaterialSnapshotContexts {
  const existing = cachesByWorld.get(worldRenderResources(world));
  if (existing !== undefined) return existing;
  const cache: MaterialSnapshotContexts = new Map();
  cachesByWorld.set(worldRenderResources(world), cache);
  return cache;
}

/** Culling, camera selection and renderable membership of one World's view. */
function worldViewRequest(
  wi: number,
  owners: ExtractFramesOwner,
  request: ExtractFramesOptions,
  cameraOwnerFrame: ExtractedFrame | undefined,
): WorldExtractRequest {
  const isCameraOwner = wi === owners.cameraOwner;
  const renderableRequest = request.renderables ?? 'full';
  const partialEntities =
    typeof renderableRequest === 'object' ? renderableRequest.entitiesByWorld[wi] : undefined;
  return {
    cull: request.cull === 'none' ? 'none' : isCameraOwner ? 'self' : 'external',
    renderables: typeof renderableRequest === 'object' ? 'full' : renderableRequest,
    ...(isCameraOwner && owners.cameraEntityKey !== undefined
      ? { cameraEntityKey: owners.cameraEntityKey }
      : {}),
    ...(isCameraOwner && request.viewExtent !== undefined
      ? { viewExtent: request.viewExtent }
      : {}),
    ...(partialEntities === undefined ? {} : { renderableEntities: partialEntities }),
    retainHidden: request.retainHidden ?? typeof renderableRequest === 'object',
    worldId: wi,
    ...(cameraOwnerFrame === undefined ? {} : { cullCameras: cameraOwnerFrame.cameras }),
  };
}

function routeWorldExtractFailure(world: World, wi: number, err: unknown): void {
  // Camera effect parameters are part of the public render contract. Keep
  // their typed validation error on the renderer path so draw() can return
  // a RenderError and publish the invalid inspection state; ordinary
  // per-world extraction failures retain the existing world-local route.
  if (err instanceof MotionBlurValidationError || err instanceof ProjectedDecalInvalidError)
    throw err;
  try {
    createWorldInternalView(world)._routeError(err, {
      severity: Severity.Error,
      systemName: `RenderSystem.extractFrames(world[${wi}])`,
    });
  } catch {
    // If _routeError itself throws, the world already failed — skip silently.
  }
}

/**
 * AC-04: renderables concat by worlds[] order with their worldId stamped; D-3:
 * per-world dispatch renderableIndex is rebased by the base offset, then
 * stable-sorted by queue value.
 */
function mergeRenderables(
  worlds: readonly World[],
  frames: readonly ExtractedFrame[],
  worldIds: readonly number[],
) {
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  const visibilitySnapshots: VisibilitySnapshot[] = [];
  const featureVisibilitySnapshots: RenderFeatureWorldVisibilitySnapshot[] = [];
  const hiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const wId = worldIds[fi];
    if (f === undefined || wId === undefined) continue;
    const base = renderables.length;
    const visibilitySnapshot = f.visibilitySnapshots[0];
    const world = worlds[wId];
    if (visibilitySnapshot !== undefined) {
      visibilitySnapshots.push(visibilitySnapshot);
      if (world !== undefined)
        featureVisibilitySnapshots.push({ world, snapshot: visibilitySnapshot });
    }
    hiddenEntityReports.push(...f.hiddenEntityReports);
    for (const r of f.renderables) {
      renderables.push({
        ...r,
        worldId: wId,
        ...(r.pointsLines === undefined ? {} : { pointsLines: { ...r.pointsLines, worldId: wId } }),
      });
    }
    for (const d of f.dispatch) {
      dispatch.push({ ...d, renderableIndex: (d.renderableIndex ?? 0) + base });
    }
  }
  dispatch.sort((a, b) => (a.queue ?? 0) - (b.queue ?? 0));
  return {
    renderables,
    dispatch,
    visibilitySnapshots,
    featureVisibilitySnapshots,
    hiddenEntityReports,
  };
}

/**
 * AC-04: point/spot/rect/pointShadow concat; the directional light and its
 * CSM carry come from the first world (in worlds[] order) that has one;
 * directionalCount sums.
 */
function mergeLights(
  worlds: readonly World[],
  frames: readonly ExtractedFrame[],
  worldIds: readonly number[],
): ExtractedLights {
  const point: PointLightSnapshot[] = [];
  const spot: SpotLightSnapshot[] = [];
  const rect: RectAreaDirectLightSnapshot[] = [];
  const pointShadow: PointShadowSnapshot[] = [];
  let nextIesSlice = 0;
  let carry: ExtractedLights | undefined;
  let directionalCount = 0;
  for (let fi = 0; fi < frames.length; fi += 1) {
    const f = frames[fi];
    const wId = worldIds[fi] ?? 0;
    if (f === undefined) continue;
    // Handles belong to their World. Allocate the shared GPU array only here,
    // after composition, so two Worlds' handle 1 cannot alias a texture layer.
    const iesSlices = new Map<number, number | undefined>();
    const withIesSlice = <
      T extends PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot,
    >(
      light: T,
    ): T => {
      const handle = light.iesProfileHandle;
      if (handle === undefined || light.iesProfileData === undefined) return light;
      if (!iesSlices.has(handle)) {
        const slice = nextIesSlice < IES_SLICE_CAPACITY ? nextIesSlice++ : undefined;
        iesSlices.set(handle, slice);
        const world = worlds[wId];
        if (slice === undefined && world !== undefined) routeIesCapacity(world, wId, light, handle);
      }
      const slice = iesSlices.get(handle);
      return { ...light, iesProfileSlice: slice };
    };
    for (const p of f.lights.point) point.push({ ...withIesSlice(p), worldId: wId });
    for (const s of f.lights.spot) spot.push({ ...withIesSlice(s), worldId: wId });
    for (const r of f.lights.rect) rect.push(withIesSlice(r));
    for (const ps of f.lights.pointShadow) pointShadow.push({ ...ps, worldId: wId });
    if (carry === undefined && f.lights.directional !== undefined) carry = f.lights;
    directionalCount += f.lights.directionalCount;
  }
  return {
    directional: carry?.directional,
    directionalCount,
    point,
    spot,
    rect,
    lightViewProj: carry?.lightViewProj,
    splitPlanes: carry?.splitPlanes,
    cascadeCount: carry?.cascadeCount,
    cascadeBlend: carry?.cascadeBlend,
    shadowMapSize: carry?.shadowMapSize,
    depthBias: carry?.depthBias,
    normalBias: carry?.normalBias,
    directionalShadowQuality: carry?.directionalShadowQuality,
    directionalShadowError: carry?.directionalShadowError,
    pointShadow,
    // bug-20260710-editor-cross-world-shadow: carry the raw CSM config +
    // direction of the first-hit directional so the merge layer can recompute
    // matrices against the surfaced (cameraOwner) camera.
    directionalCsmConfig: carry?.directionalCsmConfig,
    directionalCsmDirection: carry?.directionalCsmDirection,
  };
}

function routeIesCapacity(
  world: World,
  worldId: number,
  light: PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot,
  handle: number,
): void {
  createWorldInternalView(world)._routeError(
    createLightResourceUnavailable({
      entity: 'entity' in light ? (light.entity ?? 0) : 0,
      feature: 'ies',
      generation: 0,
      sourceKey: `${worldId}:${handle}`,
      reason: 'capacity',
      expected: `at most ${IES_SLICE_CAPACITY} distinct IES profiles per composition`,
      actual: 'IES array capacity exhausted',
      hint: 'share profiles or reduce distinct profiles; excess modifiers are identity',
    }),
    { severity: Severity.Error, systemName: 'RenderSystem.extract (ies-profile)' },
  );
}

/**
 * bug-20260710-editor-cross-world-shadow: recompute directional CSM matrices
 * against the surfaced camera. In the editor super-composite the directional
 * light's world has no camera, so its per-world matrices are degenerate; the
 * merge layer is the only place both are visible. Point/spot shadows are
 * light-space only and need no fix-up. Without any surfaced camera the
 * per-world carry stays (a cameraless frame renders nothing anyway).
 */
function refitDirectionalCsm(
  lights: ExtractedLights,
  camera: CameraSnapshot | undefined,
): ExtractedLights {
  if (lights.directionalCsmConfig === undefined || lights.directionalCsmDirection === undefined)
    return lights;
  const csm = computeDirectionalCsm(
    lights.directionalCsmDirection,
    lights.directionalCsmConfig,
    camera,
  );
  if (csm === null) return lights;
  return {
    ...lights,
    lightViewProj: csm.lightViewProj,
    splitPlanes: csm.splitPlanes,
    cascadeCount: csm.cascadeCount,
    cascadeBlend: csm.cascadeBlend,
    shadowMapSize: csm.shadowMapSize,
    directionalShadowQuality: csm.directionalShadowQuality,
  };
}

/**
 * User-authored PostProcessParams are singleton scene resources from the
 * resourceOwner world. The engine Standard tonemap param is not a scene
 * resource: extractFrame bridges it from that world's own camera, so it lives
 * on the camera-owner frame (feat-20260709-editor-world-partition defect 1).
 * Overlay it so the surfaced camera's exposure reaches the tonemap pass, and
 * drop a stale resource-owner entry when no camera surfaced this frame.
 */
function ownerPostProcessParams(
  cameraOwnerFrame: ExtractedFrame | undefined,
  resourceOwnerFrame: ExtractedFrame | undefined,
): Map<string, Uint8Array> {
  const postProcessParams = new Map(resourceOwnerFrame?.postProcessParams);
  const cameraTonemapParam = cameraOwnerFrame?.postProcessParams.get(
    STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
  );
  if (cameraTonemapParam !== undefined) {
    postProcessParams.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, cameraTonemapParam);
  } else {
    postProcessParams.delete(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
  }
  return postProcessParams;
}

function mergeMaterialTextureSources(
  frames: readonly ExtractedFrame[],
): MaterialTextureSourceStats {
  const merged: MaterialTextureSourceStats = { sourceFieldsVisited: 0, producerRoutes: {} };
  for (const frame of frames) {
    const stats = frame.materialTextureSources;
    if (stats === undefined) continue;
    merged.sourceFieldsVisited += stats.sourceFieldsVisited;
    for (const [route, count] of Object.entries(stats.producerRoutes)) {
      merged.producerRoutes[route] = (merged.producerRoutes[route] ?? 0) + count;
    }
  }
  return merged;
}

export function morphSnapshotFor(
  mesh: Pick<MeshAsset, 'vertices' | 'morphTargets'>,
  weights: ArrayLike<number> | undefined,
): MorphSnapshot | undefined {
  const targets = mesh.morphTargets;
  if (targets === undefined || targets.length === 0 || weights === undefined) return undefined;
  if (weights.length !== targets.length) return undefined;
  const firstPositions = targets[0]?.position;
  if (
    firstPositions === undefined ||
    firstPositions.length === 0 ||
    firstPositions.length % 3 !== 0
  ) {
    return undefined;
  }
  const vertexCount = firstPositions.length / 3;
  if (mesh.vertices.length % vertexCount !== 0) return undefined;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (target?.position?.length !== firstPositions.length) return undefined;
  }
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

export function extractFrame(world: World, context: PreparedExtractContext): ExtractedFrame {
  // feat-20260708-composited-multi-world-rendering M2 / D-2: resetForFrame
  // has been lifted to extractFrames (the frame-level entry point).
  // extractFrame is now a pure world->snapshot function with no frame-level
  // side effects. See plan-decisions PD2 for the reviewer ruling.
  // Environment reads are owned by the retained resource projection and are
  // established at the frame boundary; record never revisits World state.
  const fog =
    context.resourceOwnerFog === undefined
      ? selectFogFrame(world)
      : (context.resourceOwnerFog ?? undefined);
  const fogFailure = fogState(world).failure;
  const worldInternal = createWorldInternalView(world);
  const environment = extractWorldEnvironment(world, context, worldInternal, fog);
  const projectedDecals = extractProjectedDecals(world, context);
  const cameras = environment.cameras;
  for (const [i, camera] of cameras.entries()) cameras[i] = { ...camera, projectedDecals };
  const scope = createWorldExtraction(world, context, worldInternal, environment.lights, cameras);
  if (context.renderables !== 'none') {
    extractMeshRenderers(scope);
    extractDerivedRenderSources(scope);
  }
  // M3 / w26: sort dispatch entries by queue (ascending, stable sort)
  // per plan-strategy D-3.
  const dispatch = sortDispatchByQueue(scope.dispatch);
  const postProcessParams = collectPostProcessParams(world, cameras[0]);
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
    renderables: scope.renderables,
    dispatch,
    skylight: environment.skylight,
    skylightCount: environment.skylightCount,
    lightProbes: environment.lightProbes,
    skybox: environment.skybox,
    skyboxCount: environment.skyboxCount,
    fog,
    ...(fogFailure === undefined ? {} : { fogFailure }),
    frustumStats: { culled: scope.frustumCulled, total: scope.frustumTotal },
    visibilityStats: { explicitlyHidden: scope.explicitlyHidden.size },
    materialTextureSources: scope.materialTextureSources,
    postProcessParams,
    visibilitySnapshots: [context.visibility],
    featureVisibilitySnapshots: [{ world, snapshot: context.visibility }],
    hiddenEntityReports: [...scope.explicitlyHidden].map((entity) => ({ world, entity })),
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

/** Mutable state of one extractFrame call: its outputs, caches and cull counters. */
function createWorldExtraction(
  world: World,
  context: PreparedExtractContext,
  worldInternal: WorldInternalView,
  lights: ExtractedLights,
  cameras: readonly CameraSnapshot[],
) {
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  const materialLanes = new Map<string, MaterialLane>();
  const materialTextureSources: MaterialTextureSourceStats = {
    sourceFieldsVisited: 0,
    producerRoutes: {},
  };
  // feat-20260708-composited-multi-world-rendering M2 / D-4: a composite
  // non-owner world uses the camera-owner snapshots, not its own cameras.
  // This keeps culling correct when the surfaced camera and renderables live
  // in different worlds. The explicit 'none' mode remains the always-visible
  // escape hatch for callers that genuinely need it. Cameras with degenerate
  // projection parameters produce empty planes and keep entities visible.
  const cullingCameras = context.cull === 'external' ? (context.cullCameras ?? []) : cameras;
  return {
    world,
    context,
    worldInternal,
    assets: world.assets === undefined ? context.assets : runtimeAssetRegistry(world.assets),
    visibility: context.visibility.hasAnyHiddenIntent ? context.visibility : undefined,
    materialLanes,
    materialTextureSources,
    renderables,
    dispatch,
    explicitlyHidden: new Set<EntityHandle>(),
    shadowFrusta: context.cull === 'none' ? [] : buildShadowFrusta(lights),
    frustumPlanes: context.cull === 'none' ? [] : buildCameraFrusta(cullingCameras),
    // feat-20260528-frustum-culling M3 / w11: frustum culling counters.
    frustumCulled: 0,
    frustumTotal: 0,
  };
}

type WorldExtraction = ReturnType<typeof createWorldExtraction>;

// tweak-20260611 M1: MeshRenderer renderable archetype walk routes through one
// World-owned Query. Variable-length array reads (`MeshRenderer.materials`,
// SpriteInstances arrays) still flow through `_getArrayView`; explicit
// Instances bytes come from the renderer-owned collection store.
function queryMeshRenderers(world: World, skinComponent: typeof Skin) {
  return world
    .query({
      read: [MeshRenderer],
      optional: [
        Transform,
        GlobalTransform,
        MeshFilter,
        Instances,
        skinComponent,
        Layer,
        MorphWeights,
        SpriteRegionOverride,
        SpriteInstances,
        Points,
        Lines,
        SortKey,
      ],
    })
    .unwrap();
}

type MeshRendererRow = NonNullable<ReturnType<ReturnType<typeof queryMeshRenderers>['at']>>;

/** Walk MeshRenderer rows in query order, or in the requested partial entity order. */
function extractMeshRenderers(scope: WorldExtraction): void {
  const skinComponent =
    (scope.world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  const query = queryMeshRenderers(scope.world, skinComponent);
  const requested = scope.context.renderableEntities;
  if (requested === undefined) {
    for (const row of query) extractMeshRendererRow(scope, row, skinComponent);
    return;
  }
  for (const entity of requested) {
    const row = query.at(entity as EntityHandle);
    if (row !== undefined) extractMeshRendererRow(scope, row, skinComponent);
  }
}

/** Terrain, glyph and tilemap producers append to the same renderable/dispatch lists. */
function extractDerivedRenderSources(scope: WorldExtraction): void {
  const { world, context, renderables, visibility, explicitlyHidden } = scope;
  if (scope.assets != null)
    extractTerrainSources(
      world,
      scope.assets,
      context.materialContext,
      context.worldId,
      renderables,
      scope.dispatch,
      context.renderableEntities,
      visibility,
      context.retainHidden,
      explicitlyHidden,
    );
  extractGlyphSources(
    world,
    context.worldId,
    renderables,
    context.renderableEntities,
    visibility,
    context.retainHidden,
    explicitlyHidden,
  );
  extractTilemapSources(
    world,
    context.worldId,
    renderables,
    context.renderableEntities,
    visibility,
    context.retainHidden,
    explicitlyHidden,
  );
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
  for (const row of world.query({ with: [PostProcessParams] }).unwrap()) {
    const read = world.get(row.entity, PostProcessParams);
    if (!read.ok) continue;
    postProcessParams.set(read.value.shader, read.value.data);
  }
  if (tonemapCamera !== undefined) {
    postProcessParams.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, tonemapParams(tonemapCamera));
  }
  return postProcessParams;
}

function extractMeshRendererRow(
  scope: WorldExtraction,
  row: MeshRendererRow,
  skinComponent: typeof Skin,
): void {
  const entity = row.entity;
  // The required query component owns this scalar. Read it without
  // materialising MeshRenderer's unrelated variable-length materials array.
  const lightingChannels = scope.world[worldRead].getFieldValue(
    entity,
    MeshRenderer,
    'lightingChannels',
  ) as number;
  if (!admitChannelMask(scope, validateChannelMask(lightingChannels), 'lighting-channels')) return;
  const participation = readShadowParticipation(scope.world, entity);
  if (
    participation !== undefined &&
    !admitChannelMask(
      scope,
      validateChannelMask(participation.channels, 'shadowChannels'),
      'shadow-channels',
    )
  )
    return;
  const read = readMeshRendererRow(scope, row, skinComponent, lightingChannels, participation);
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
  const pending: DispatchEntry[] = [];
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
  source: 'lighting-channels' | 'shadow-channels',
): boolean {
  if (error === null) return true;
  scope.worldInternal._routeError(error, {
    severity: Severity.Error,
    systemName: `RenderSystem.extract (${source})`,
  });
  return false;
}

function readShadowParticipation(world: World, entity: EntityHandle) {
  if (!world.hasComponent(entity, ShadowParticipation)) return undefined;
  const participation = world.get(entity, ShadowParticipation);
  return participation.ok ? participation.value : undefined;
}

/**
 * Blended surfaces (light beams, glows, glass, additive VFX) do not occlude
 * light by default: an entity whose every material blends drops its
 * ShadowCaster work unless ShadowParticipation is authored on it, which
 * remains the explicit opt-in (`cast: true`) or opt-out.
 */
function withBlendedShadowDefault(
  read: MeshRendererRowRead,
  materials: readonly MaterialSnapshot[],
): MeshRendererRowRead {
  if (read.shadowParticipationAuthored || read.shadowCastDisabled) return read;
  if (!materials.every((material) => material.transparent === true)) return read;
  return { ...read, shadowCastDisabled: true };
}

function readMobilityStatic(world: World, entity: EntityHandle): boolean {
  if (!world.hasComponent(entity, Mobility)) return false;
  const mobility = world.get(entity, Mobility);
  return mobility.ok && mobility.value.kind === MobilityKindValue.static;
}

/**
 * Presence and scalar reads of one MeshRenderer row. A missing optional
 * component surfaces as an absent bundle key; presence-only checks use
 * QueryRow.has so array-bearing components are not materialised.
 */
function readMeshRendererRow(
  scope: WorldExtraction,
  row: MeshRendererRow,
  skinComponent: typeof Skin,
  lightingChannels: number,
  participation: ReturnType<typeof readShadowParticipation>,
) {
  const entity = row.entity;
  const preparationMesh =
    scope.context.preparationMesh?.entity === entity ? scope.context.preparationMesh : undefined;
  const meshFilter = row.get(MeshFilter);
  const hasInstances = row.has(Instances);
  const hasSpriteInstances = row.has(SpriteInstances);
  const points = row.get(Points);
  const lines = row.get(Lines);
  const pointsLinesComponent: 'Points' | 'Lines' | undefined =
    points !== undefined ? 'Points' : lines !== undefined ? 'Lines' : undefined;
  const isRenderable = row.has(Transform) && meshFilter !== undefined;
  return {
    entity,
    authorVisible: !(isRenderable && scope.visibility?.effective(entity) === 'hidden'),
    lightingChannels,
    preparationMesh,
    preparePipelines:
      preparationMesh !== undefined ||
      scope.world[worldRead].getFieldValue(entity, MeshRenderer, 'preparePipelines') === 1,
    // The resolved world transform is read from `GlobalTransform.world`; keep
    // the defensive Transform check because an owner can explicitly remove a
    // required component during recovery.
    isRenderable,
    meshHandle: preparationMesh?.meshHandle ?? meshFilter?.assetHandle,
    hasInstances,
    skin: row.get(skinComponent),
    morphWeights: scope.worldInternal._getArrayView(entity, MorphWeights, 'weights'),
    capsuleShadowRequested: scope.world.hasComponent(entity, CapsuleShadow),
    shadowChannels:
      participation === undefined || participation.channels === 0xffffffff
        ? undefined
        : participation.channels,
    shadowCastDisabled: participation?.cast === false,
    shadowParticipationAuthored: participation !== undefined,
    shadowReceiveDisabled: participation?.receive === false,
    mobilityStatic: readMobilityStatic(scope.world, entity),
    // SpriteInstances validation fires structured EcsErrors at extraction
    // (D-6 fail-fast at the render domain entry, not at ECS spawn-time).
    hasSpriteInstances,
    points,
    lines,
    sortKey: row.get(SortKey)?.value,
    pointsLinesComponent,
    // Layer is folded into each DispatchEntry so transparent sorting uses it
    // as the primary key without a second ECS round-trip.
    layer: row.get(Layer)?.value ?? 0,
    // SpriteRegionOverride displaces the asset-side `values.region` for this
    // entity only; 9-slice logic measures slices against the effective region.
    hasSpriteRegionOverride: row.has(SpriteRegionOverride),
    // Only the two instance-bearing paths consume the version in their cache key.
    archVersion:
      hasInstances || hasSpriteInstances
        ? spriteInstancesArchVersion(scope.worldInternal, entity)
        : 0,
  };
}

type MeshRendererRowRead = ReturnType<typeof readMeshRendererRow>;

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
  readonly mesh: MeshAsset | undefined;
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

/** `undefined` means a routed slot failure rejected the entity. */
function resolveEntityMaterialBindings(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materialsView: Uint32Array | undefined,
): EntityMaterialBindings | undefined {
  const mesh = scope.assets == null ? undefined : resolveEntityMesh(scope, read);
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
  mesh: MeshAsset,
  materialsView: Uint32Array | undefined,
): EntityMaterialBindings | undefined {
  const world = scope.world;
  const guid = (mesh as { guid?: string }).guid ?? '<no-guid>';
  const resolved = resolveMeshMaterialBindings(mesh, materialsView ?? [], {
    isValidOverride(handle) {
      const material = runtimeAssets(world.assets).resolveAsset(handle as AssetHandle<'material'>);
      return material.ok && material.value.kind === 'material';
    },
    resolveMeshDefault(defaultGuid) {
      return resolveRuntimeAssetReference(worldRenderResources(world), defaultGuid, 'material') as
        | number
        | undefined;
    },
  });
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
  mesh: MeshAsset,
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
  mesh: MeshAsset,
  guid: string,
  failure: Extract<ResolveMeshMaterialBindingsResult, { readonly ok: false }>,
): void {
  if (failure.code === 'mesh-material-slots-missing') {
    scope.worldInternal._routeError(
      new AssetError({
        code: 'load-failed',
        expected: 'every MeshAsset producer supplies materialSlots[]',
        hint: `fix the MeshAsset producer; renderer inheritance never guesses slot topology (mesh=${guid}, entity=${entity}, vertices=${mesh.vertices.length}, indices=${mesh.indices?.length ?? 0})`,
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
  mesh: MeshAsset | undefined,
): MaterialLane {
  const vertexColorAvailable = mesh?.attributes.color !== undefined;
  const geometry: MaterialCookRasterContext['geometry'] =
    read.skin !== undefined ? 'skinned' : read.hasSpriteInstances ? 'sprite-instances' : 'mesh';
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
    read.skin !== undefined &&
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
  mesh: MeshAsset | undefined,
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
  let programSelections: readonly MaterialProgramSelection[] | undefined;
  try {
    programSelections = materialProgramSelectionsForMaterial(
      material,
      assets,
      lane.materialContext,
      'direct',
      lane.vertexColorAvailable,
    );
  } catch (error) {
    if (rejectsUncookedSkinProgram(scope, read.entity, material, assets, lane, mesh, error))
      return undefined;
    throw error;
  }
  const world = worldRenderResources(scope.world);
  const snapshot = prepareMaterialSnapshot({
    handle,
    world,
    assets,
    material,
    programSelections,
    materialContext: lane.materialContext,
    textureSourceStats: scope.materialTextureSources,
    vertexColorAvailable: lane.vertexColorAvailable,
    geometry: lane.geometry,
  });
  if (!admitSkinMaterial(scope, read, snapshot.materialShaderId, programSelections))
    return undefined;
  const stored = storeMaterialSnapshot(lane.persistent, handle, snapshot, world, programSelections);
  lane.cache.set(handle, stored);
  lane.persistent.set(handle, stored);
  if (read.isRenderable) {
    appendMaterialDispatchEntries(
      pending,
      material.passes ?? [],
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
  mesh: MeshAsset | undefined,
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

function missingSkinAttributes(mesh: MeshAsset): 'both' | 'skinIndex' | 'skinWeight' | undefined {
  const indices = mesh.attributes.skinIndex !== undefined;
  const weights = mesh.attributes.skinWeight !== undefined;
  if (indices && weights) return undefined;
  if (!indices && !weights) return 'both';
  return !indices ? 'skinIndex' : 'skinWeight';
}

/** `true` means the mesh lacked skin attributes and the error was routed. */
function routeMissingSkinAttributes(
  scope: WorldExtraction,
  entity: EntityHandle,
  mesh: MeshAsset,
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
  const skeleton = read.skin?.skeleton;
  if (read.skin !== undefined && skeleton !== undefined && skeleton !== 0 && !wantsSkin) {
    scope.worldInternal._routeError(new SkinMaterialMismatchError(read.entity, shader), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (skin-material-mismatch)',
    });
    return false;
  }
  if (!wantsSkin || read.meshHandle === undefined || read.meshHandle === 0) return true;
  const current = runtimeAssets(scope.world.assets).resolveAsset<MeshAsset>(
    read.meshHandle as AssetHandle<'mesh'>,
  );
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
  if (skinBinding === undefined && read.skin !== undefined && requiresSkin(materials.primary)) {
    pending.length = 0;
    return;
  }
  // feat-20260601 D-3: the resolved world mat4 feeds the record stage with
  // zero per-snapshot compose. A stale slot (generation gone) skips the entity.
  const worldView = readPresentationWorldMatrix(scope.world, read.entity);
  if (worldView === undefined) return;
  const transform: TransformSnapshot = { world: new Float32Array(worldView) };
  const submeshMaterials = resolveSubmeshMaterials(scope, materials);
  // Without authored ShadowParticipation, a mesh whose every material blends
  // (transparent, additive) casts no shadow, like Three.js castShadow=false.
  const castRead = withBlendedShadowDefault(read, submeshMaterials);
  stageSubmeshDispatch(scope, castRead, materials, submeshMaterials, pending);
  const geometry = resolveRenderableGeometry(scope, castRead, materials, submeshMaterials);
  if (geometry === undefined) return;
  const renderable = composeRenderable(
    scope,
    castRead,
    materials,
    submeshMaterials,
    geometry,
    transform,
    skinBinding,
  );
  // Material passes stay shared; participation only filters this entity's
  // ShadowCaster work, so every shadow map and cull test sees it absent.
  // Screen-space points and lines have no world-space footprint to cast.
  if (castRead.shadowCastDisabled || castRead.pointsLinesComponent !== undefined)
    removeShadowCasterDispatch(pending);
  const pipelinePreparation = castRead.preparePipelines
    ? pending.map(
        ({ entityIndex: _entityIndex, renderableIndex: _renderableIndex, ...pass }) => pass,
      )
    : undefined;
  if (
    !admitFrustumVisibility(
      scope,
      castRead,
      geometry,
      transform.world,
      pending,
      pipelinePreparation !== undefined,
    )
  )
    return;
  // Retain hidden snapshots for incremental composition, but never publish
  // their display or ShadowCaster passes to either record lane.
  if (!castRead.authorVisible) pending.length = 0;
  for (const entry of pending) scope.dispatch.push(entry);
  scope.renderables.push(withMobilityAndPreparation(renderable, castRead, pipelinePreparation));
}

/**
 * feat-20260609 M2/M5: default-material entities (handle 0) produce
 * ShadowCaster dispatch so shadow-casting stays the default behaviour; the
 * per-entity opt-out is ShadowParticipation { cast: false }. The URP literals
 * mirror what `Materials.unlit()` produces at the asset layer, because the
 * default-material handle bypasses asset registration.
 */
function stageDefaultMaterialDispatch(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  pending: DispatchEntry[],
): void {
  const renderableIndex = scope.renderables.length;
  pending.push({
    entityIndex: read.entity,
    materialHandle: 0,
    renderableIndex,
    passIndex: 0,
    queue: 2000,
    layer: read.layer,
    ...(read.shadowChannels === undefined ? {} : { shadowChannels: read.shadowChannels }),
    tags: { LightMode: 'ShadowCaster' },
    renderState: undefined,
    defines: undefined,
    vertexEntry: 'vs_main',
    fragmentEntry: undefined,
    materialShaderId: 'forgeax::default-shadow-caster',
  });
  // Also add a Forward pass entry so the entity renders in the main scene
  // pass (mirrors Materials.unlit default).
  appendMaterialDispatchEntries(
    pending,
    [DEFAULT_FORWARD_PASS],
    read.entity,
    0,
    renderableIndex,
    read.layer,
    1,
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
  const skin = read.skin;
  const skeletonHandle = skin?.skeleton;
  if (
    skin === undefined ||
    skeletonHandle === undefined ||
    skeletonHandle === 0 ||
    scope.assets == null
  )
    return undefined;
  const entity = read.entity;
  const worldInternal = scope.worldInternal;
  // Skin + Instances coexistence is forbidden (D-10).
  if (read.hasInstances) {
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
  // Reuse the Skin row already read for its skeleton handle.
  const skinJoints = skin.joints;
  if (skinJoints === undefined) return false;
  if (skinJoints.length !== jointCount) {
    // Keep nonempty static membership; actual fixed-frame demand rejects an incompatible resource.
    worldInternal._routeError(new JointCountMismatchError(entity, jointCount, skinJoints.length), {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (joint-count-mismatch)',
    });
  }
  // Invalid static membership never crosses the protocol boundary; static
  // Binding admission does not read or duplicate dynamic joint matrices.
  if (skinJoints.length === 0) return false;
  return { skeleton: skeletonHandle, joints: Object.freeze(Array.from(skinJoints, Number)) };
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
          assets,
          lane.cache,
          lane.persistent,
          lane.materialContext,
          scope.materialTextureSources,
          lane.vertexColorAvailable,
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
  const mesh = resolveEntityMesh(scope, read);
  const morph = mesh === undefined ? undefined : morphSnapshotFor(mesh, read.morphWeights);
  const localAabb = renderableLocalAabb(read, mesh, morph, submeshMaterials);
  const pointsLinesStyle = pointsLinesStyleOf(read);
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
 * Producer-owned finite local bounds. Morph targets can expand the authored
 * bounds, and bind-pose bounds cannot enclose arbitrary animated joint scale,
 * so those lanes stay conservatively visible (no bounds).
 */
function renderableLocalAabb(
  read: MeshRendererRowRead,
  mesh: MeshAsset | undefined,
  morph: MorphSnapshot | undefined,
  submeshMaterials: readonly MaterialSnapshot[],
): Float32Array | undefined {
  const meshAabb = read.skin !== undefined ? undefined : mesh?.aabb;
  const authored =
    morph === undefined && isFiniteAabb(meshAabb) ? new Float32Array(meshAabb) : undefined;
  const displacementRadius = standardDisplacementRadius(submeshMaterials);
  const expanded = expandDisplacementBounds(authored, displacementRadius);
  return read.skin !== undefined && displacementRadius > 0 ? undefined : expanded;
}

function pointsLinesStyleOf(read: MeshRendererRowRead): PointsLinesStyle | undefined {
  const { points, lines } = read;
  if (points !== undefined) {
    const shape = pointShapeFromU32(points.shape);
    const sizeUnits = pointSizeUnitsFromU32(points.sizeUnits);
    return shape === undefined || sizeUnits === undefined
      ? undefined
      : { kind: 'points', size: points.size, sizeUnits, shape };
  }
  if (lines === undefined) return undefined;
  return {
    kind: 'lines',
    width: lines.width,
    widthUnits: lines.widthUnits,
    cap: lines.cap,
    dashSize: lines.dashSize,
    gapSize: lines.gapSize,
    dashOffset: lines.dashOffset,
  };
}

/** `false` rejects the entity after routing its SpriteInstances error. */
function resolveSpriteInstances(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  material: MaterialSnapshot,
): SpriteInstancesSnapshot | undefined | false {
  if (!read.hasSpriteInstances) return undefined;
  const { entity } = read;
  const worldInternal = scope.worldInternal;
  // (1) mutually exclusive with Instances (peers — pick one).
  if (read.hasInstances) {
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
  if (!read.hasInstances) return undefined;
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
  const renderable: RenderableSnapshot = {
    ...(read.hasSpriteRegionOverride
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
    worldId: scope.context.worldId,
    entityKey: read.entity,
    ...renderableAttachments(scope, read, materials, geometry, skinBinding),
  };
  return withGpuDrivenDraws(scope, renderable, materials, submeshMaterials, geometry, skinBinding);
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
          assets,
          lane.cache,
          lane.persistent,
          lane.materialContext,
          scope.materialTextureSources,
          lane.vertexColorAvailable,
        ),
      );
    }),
  );
}

function renderableAttachments(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
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
> {
  const pointsLines = pointsLinesSnapshotOf(scope, read, materials, geometry);
  return {
    ...(read.authorVisible ? {} : { authorVisible: false }),
    ...(skinBinding === undefined ? {} : { skinBinding }),
    ...(read.capsuleShadowRequested ? { capsuleShadowRequested: true as const } : {}),
    ...(geometry.morph !== undefined ? { morph: geometry.morph } : {}),
    ...(geometry.instances !== undefined ? { instances: geometry.instances } : {}),
    ...(geometry.spriteInstances !== undefined
      ? { spriteInstances: geometry.spriteInstances }
      : {}),
    ...(pointsLines !== undefined ? { pointsLines } : {}),
  };
}

function pointsLinesSnapshotOf(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  materials: EntityMaterials,
  geometry: RenderableGeometry,
): PointsLinesRetainedSnapshot | undefined {
  if (read.pointsLinesComponent === undefined) return undefined;
  return {
    worldId: scope.context.worldId,
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

function withGpuDrivenDraws(
  scope: WorldExtraction,
  renderable: RenderableSnapshot,
  materials: EntityMaterials,
  submeshMaterials: readonly MaterialSnapshot[],
  geometry: RenderableGeometry,
  skinBinding: SkinBindingInput | undefined,
): RenderableSnapshot {
  const { lods } = geometry;
  const getMaterialShaderArtifact = scope.context.getMaterialShaderArtifact;
  const gpuDrivenDraws = buildGpuDrivenDraws({
    mesh: materials.bindings.mesh,
    materials: submeshMaterials,
    fallbackMaterial: materials.primary.snapshot,
    deformation: skinBinding === undefined ? 'rigid' : 'skin',
    ...(getMaterialShaderArtifact === undefined ? {} : { getMaterialShaderArtifact }),
    ...(lods === undefined
      ? {}
      : {
          lodMeshes: lods.map((lod) => {
            const lower = renderAsset(worldRenderResources(scope.world), lod.mesh);
            return lower?.kind === 'mesh' ? lower : undefined;
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
  return geometry.morph === undefined && gpuDrivenDraws.length > 0
    ? { ...renderable, gpuDrivenDraws }
    : renderable;
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
 * conservative always-visible fallbacks; culling has no per-entity opt-out.
 * `false` drops the entity; a shadow-only survivor keeps only ShadowCaster work.
 */
function admitFrustumVisibility(
  scope: WorldExtraction,
  read: MeshRendererRowRead,
  geometry: RenderableGeometry,
  worldMatrix: Float32Array,
  pending: DispatchEntry[],
  preparing: boolean,
): boolean {
  const { instances } = geometry;
  // No instance can contribute a visible bound; the retained snapshot still
  // records instanceCount=0 for the record stage.
  if (geometry.localAabb === undefined || instances?.instanceCount === 0) return true;
  // With no camera frustum every entity is visible, so the union bound would
  // only feed a test whose result is already known.
  if (scope.frustumPlanes.length === 0) {
    scope.frustumTotal += 1;
    return true;
  }
  const instanceBounds =
    instances === undefined
      ? undefined
      : deriveInstancesUnionBounds({
          meshAabb: geometry.cullingLocalAabb,
          entityWorld: worldMatrix,
          transforms: instances.transforms,
        });
  // Missing/malformed derived facts (non-finite producer matrices/AABB) are a
  // conservative no-cull result.
  if (read.hasInstances && (instances === undefined || instanceBounds === undefined)) return true;
  const worldAabb = worldCullingAabb(geometry.cullingLocalAabb, worldMatrix, instanceBounds);
  scope.frustumTotal += 1;
  if (intersectsAnyFrustum(scope.frustumPlanes, worldAabb)) return true;
  scope.frustumCulled += 1;
  if (!castsVisibleShadow(scope, pending, worldAabb) && !preparing) return false;
  retainShadowCasterDispatch(pending);
  return true;
}

/** Same-source world bounds as the record stage's mesh SSBO (feat-20260601 D-3). */
function worldCullingAabb(
  localAabb: Float32Array | readonly number[],
  worldMatrix: Float32Array,
  instanceBounds: ArrayLike<number> | undefined,
): box3.Box3 {
  const worldAabb = box3.create();
  if (instanceBounds === undefined) {
    box3.transformBox3(worldAabb, localAabb, worldMatrix);
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
  renderable: RenderableSnapshot,
  read: MeshRendererRowRead,
  pipelinePreparation: RenderableSnapshot['pipelinePreparation'],
): RenderableSnapshot {
  const authored =
    !read.mobilityStatic && !read.shadowReceiveDisabled
      ? renderable
      : {
          ...renderable,
          ...(read.mobilityStatic ? { mobility: 'static' as const } : {}),
          ...(read.shadowReceiveDisabled ? { shadowReceiver: false as const } : {}),
        };
  return pipelinePreparation === undefined ? authored : { ...authored, pipelinePreparation };
}

function identityProjection(): Float32Array {
  const projection = new Float32Array(16);
  projection[0] = 1;
  projection[5] = 1;
  projection[10] = 1;
  projection[15] = 1;
  return projection;
}
