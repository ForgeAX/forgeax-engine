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
import { box3, frustum, type Vec3 } from '@forgeax/engine-math';
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
  MeshAsset,
  MeshLodLevel,
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
  ShadowParticipation,
  SortKey,
  SpriteInstances,
  SpriteRegionOverride,
} from './components';
import type { DirectionalShadowQuality } from './components/directional-shadow-filter';
import { GlyphText } from './components/glyph-text';
import type { LightValidationError } from './components/light-helpers';
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
  resolveMeshMaterialBindings,
} from './mesh-material-bindings';
import { isStandardPbrSkinMaterialShader } from './pbr-pipeline';
import { expandPointsLinesBounds } from './points-lines/bounds';
import type { PointsLinesRetainedSnapshot, PointsLinesStyle } from './points-lines/snapshot';
import { IES_SLICE_CAPACITY } from './prepare/extended-lighting/resources';
import { renderAsset, worldRenderResources } from './publication/resource-scope';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import type {
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  DispatchEntry,
  DispatchList,
  ExtractedFrame,
  ExtractedLights,
  ExtractFramesOwner,
  InstancesSnapshot,
  MaterialProgramSelection,
  MaterialSnapshot,
  MaterialSnapshotCache,
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
  const cameraOwner = typeof owner === 'number' ? owner : owner.cameraOwner;
  const resourceOwner = typeof owner === 'number' ? owner : owner.resourceOwner;
  const cameraEntityKey = typeof owner === 'number' ? undefined : owner.cameraEntityKey;
  const renderableRequest = options.renderables ?? 'full';
  const renderableMode = typeof renderableRequest === 'object' ? 'full' : renderableRequest;
  const partialEntitiesByWorld =
    typeof renderableRequest === 'object' ? renderableRequest.entitiesByWorld : undefined;
  const retainHidden = options.retainHidden ?? typeof renderableRequest === 'object';

  const failedWorlds = new Set<World>();
  // Resource-owner selection is a frame-level concern. Select Fog once before
  // per-world extraction so non-owner worlds do not scan their ECS tables for
  // a value that the merge layer will discard.
  const resourceOwnerWorld = worlds[resourceOwner];
  const resourceOwnerFog =
    resourceOwnerWorld === undefined ? null : (selectFogFrame(resourceOwnerWorld) ?? null);
  // ── D-2: per-world extract with error isolation ────────────────────────
  //
  // Each world runs extractFrame over the final state published by
  // world.update(). Failure in one world is caught, routed to that world's
  // _routeError (systemName carries worldId for source identification),
  // and the world's contribution is skipped (AC-09 graceful degradation).

  // The camera-owner frame must be extracted first: non-owner worlds do not
  // carry the surfaced camera, but their renderables still need to be tested
  // against that camera's frustum. Frames are placed back into worlds[] order
  // before merge so queue / directional-light / worldId semantics stay stable.
  const succeededFrames: ExtractedFrame[] = [];
  const succeededIndices: number[] = [];

  const extractionOrder = Array.from({ length: worlds.length }, (_, wi) => wi).sort((a, b) => {
    if (a === cameraOwner) return -1;
    if (b === cameraOwner) return 1;
    return a - b;
  });
  const framesByWorld = new Map<number, ExtractedFrame>();

  for (const wi of extractionOrder) {
    const world = worlds[wi];
    if (world === undefined || failedWorlds.has(world)) continue;
    try {
      const isCameraOwner = wi === cameraOwner;
      const cameraOwnerFrame = framesByWorld.get(cameraOwner);
      const prepared = prepareExtractContext(world, {
        ...(assets !== undefined ? { assets } : {}),
        resourceOwnerFog: wi === resourceOwner ? resourceOwnerFog : null,
        ...(materialSnapshotCachesByWorld === undefined
          ? {}
          : {
              materialSnapshotContexts:
                materialSnapshotCachesByWorld.get(worldRenderResources(world)) ??
                (() => {
                  const cache: MaterialSnapshotContexts = new Map();
                  materialSnapshotCachesByWorld.set(worldRenderResources(world), cache);
                  return cache;
                })(),
            }),
        ...(options.materialContext === undefined
          ? {}
          : { materialContext: options.materialContext }),
        cull: options.cull === 'none' ? 'none' : isCameraOwner ? 'self' : 'external',
        renderables: renderableMode,
        ...(isCameraOwner && cameraEntityKey !== undefined ? { cameraEntityKey } : {}),
        ...(isCameraOwner && options.viewExtent !== undefined
          ? { viewExtent: options.viewExtent }
          : {}),
        ...(partialEntitiesByWorld?.[wi] === undefined
          ? {}
          : { renderableEntities: partialEntitiesByWorld[wi] }),
        retainHidden,
        ...(options.preparationMesh?.world === world
          ? { preparationMesh: options.preparationMesh }
          : {}),
        worldId: wi,
        ...(options.getMaterialShaderArtifact === undefined
          ? {}
          : { getMaterialShaderArtifact: options.getMaterialShaderArtifact }),
        ...(options.instanceCollections === undefined
          ? {}
          : { instanceCollections: options.instanceCollections }),
        ...(cameraOwnerFrame === undefined ? {} : { cullCameras: cameraOwnerFrame.cameras }),
      });
      const frame = extractFrame(world, prepared);

      framesByWorld.set(wi, frame);
    } catch (err) {
      // Camera effect parameters are part of the public render contract. Keep
      // their typed validation error on the renderer path so draw() can return
      // a RenderError and publish the invalid inspection state; ordinary
      // per-world extraction failures retain the existing world-local route.
      if (err instanceof MotionBlurValidationError || err instanceof ProjectedDecalInvalidError)
        throw err;
      // Per-world failure: route to world's own error handler, skip contribution.
      try {
        createWorldInternalView(world)._routeError(err, {
          severity: Severity.Error,
          systemName: `RenderSystem.extractFrames(world[${wi}])`,
        });
      } catch {
        // If _routeError itself throws, the world already failed — skip silently.
      }
    }
  }

  // Restore the caller's world order after the camera-owner-first extraction.
  for (let wi = 0; wi < worlds.length; wi++) {
    const frame = framesByWorld.get(wi);
    if (frame === undefined) continue;
    succeededFrames.push(frame);
    succeededIndices.push(wi);
  }

  // ── D-3: merge semantics ───────────────────────────────────────────────

  // AC-04: renderables — concat by worlds[] order, stamp worldId.
  const renderables: RenderableSnapshot[] = [];
  const dispatchEntries: DispatchEntry[] = [];
  const visibilitySnapshots: VisibilitySnapshot[] = [];
  const featureVisibilitySnapshots: RenderFeatureWorldVisibilitySnapshot[] = [];
  const hiddenEntityReports: RenderFeatureHiddenEntityReport[] = [];

  for (let fi = 0; fi < succeededFrames.length; fi++) {
    const f = succeededFrames[fi];
    const wId = succeededIndices[fi];
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

    // D-3: dispatch — per-world renderableIndex rebased by base offset.
    for (const d of f.dispatch) {
      dispatchEntries.push({ ...d, renderableIndex: (d.renderableIndex ?? 0) + base });
    }
  }

  // Stable sort dispatch by queue value.
  dispatchEntries.sort((a, b) => (a.queue ?? 0) - (b.queue ?? 0));

  // AC-04: lights — point[]/spot[] concat; directional first-hit in
  // succeededFrames order (which preserves worlds[] order for successful
  // frames); directionalCount sum.
  const point: PointLightSnapshot[] = [];
  const spot: SpotLightSnapshot[] = [];
  const rect: RectAreaDirectLightSnapshot[] = [];
  let nextIesSlice = 0;
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  let lightViewProj: readonly Float32Array[] | undefined;
  let splitPlanes: Float32Array | undefined;
  let cascadeCount: number | undefined;
  let cascadeBlend: number | undefined;
  let shadowMapSize: number | undefined;
  let depthBias: number | undefined;
  let normalBias: number | undefined;
  let directionalShadowQuality: DirectionalShadowQuality | undefined;
  let directionalShadowError: LightValidationError | undefined;
  const pointShadow: PointShadowSnapshot[] = [];
  // bug-20260710-editor-cross-world-shadow: carry the raw CSM config +
  // direction of the first-hit directional so the merge layer can recompute
  // matrices against the SURFACED (cameraOwner) camera — the light and the
  // camera may live in different worlds (editor super-composite).
  let directionalCsmConfig: DirectionalCsmConfig | undefined;
  let directionalCsmDirection: Vec3 | undefined;
  for (let fi = 0; fi < succeededFrames.length; fi += 1) {
    const f = succeededFrames[fi];
    const wId = succeededIndices[fi] ?? 0;
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
        if (slice === undefined && world !== undefined) {
          createWorldInternalView(world)._routeError(
            createLightResourceUnavailable({
              entity: 'entity' in light ? (light.entity ?? 0) : 0,
              feature: 'ies',
              generation: 0,
              sourceKey: `${wId}:${handle}`,
              reason: 'capacity',
              expected: `at most ${IES_SLICE_CAPACITY} distinct IES profiles per composition`,
              actual: 'IES array capacity exhausted',
              hint: 'share profiles or reduce distinct profiles; excess modifiers are identity',
            }),
            { severity: Severity.Error, systemName: 'RenderSystem.extract (ies-profile)' },
          );
        }
      }
      const slice = iesSlices.get(handle);
      return { ...light, iesProfileSlice: slice };
    };
    for (const p of f.lights.point) point.push({ ...withIesSlice(p), worldId: wId });
    for (const s of f.lights.spot) spot.push({ ...withIesSlice(s), worldId: wId });
    for (const r of f.lights.rect) rect.push(withIesSlice(r));
    for (const ps of f.lights.pointShadow) pointShadow.push({ ...ps, worldId: wId });
    if (directional === undefined && f.lights.directional !== undefined) {
      directional = f.lights.directional;
      // Carry CSM shadow fields from the first-hit directional's world.
      lightViewProj = f.lights.lightViewProj;
      splitPlanes = f.lights.splitPlanes;
      cascadeCount = f.lights.cascadeCount;
      cascadeBlend = f.lights.cascadeBlend;
      shadowMapSize = f.lights.shadowMapSize;
      depthBias = f.lights.depthBias;
      normalBias = f.lights.normalBias;
      directionalShadowQuality = f.lights.directionalShadowQuality;
      directionalShadowError = f.lights.directionalShadowError;
      directionalCsmConfig = f.lights.directionalCsmConfig;
      directionalCsmDirection = f.lights.directionalCsmDirection;
    }
    directionalCount += f.lights.directionalCount;
  }

  // AC-05/06 + w4 owner split (D-3 / R-6): cameras come from the cameraOwner
  // world; skylight / skybox / postProcessParams come from the resourceOwner
  // world (holistic snapshot selection). Scan succeededIndices once to locate
  // each owner's surviving frame. When cameraOwner === resourceOwner both
  // resolve to the same frame — byte-identical to the pre-w4 single-owner path.
  let cameraOwnerFrame: ExtractedFrame | undefined;
  let resourceOwnerFrame: ExtractedFrame | undefined;
  for (let fi = 0; fi < succeededFrames.length; fi++) {
    if (succeededIndices[fi] === cameraOwner) cameraOwnerFrame = succeededFrames[fi];
    if (succeededIndices[fi] === resourceOwner) resourceOwnerFrame = succeededFrames[fi];
  }
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
      worldId: cameraOwner,
      projectedDecals,
    })) ?? [];
  const auxiliaryCameras =
    cameraOwnerFrame?.auxiliaryCameras.map((camera) => ({ ...camera, worldId: cameraOwner })) ?? [];
  const cubeCameras = cameraOwnerFrame !== undefined ? [...cameraOwnerFrame.cubeCameras] : [];

  // bug-20260710-editor-cross-world-shadow: RECOMPUTE directional CSM matrices
  // against the surfaced camera. In a single-world app the per-world extract
  // already produced correct matrices (light+camera share the world), and this
  // recompute uses the same config and camera. In the editor super-composite
  // the directional light's world has NO camera, so
  // its per-world `lightViewProj` is undefined/degenerate; the surfaced camera
  // lives in the cameraOwner world. Pairing them here is the ONLY place both
  // are visible. Point/spot shadows are camera-independent (light-space only)
  // and need no merge-layer fix-up.
  const mergeCam = cameras[0];
  if (directionalCsmConfig !== undefined && directionalCsmDirection !== undefined) {
    const csm = computeDirectionalCsm(directionalCsmDirection, directionalCsmConfig, mergeCam);
    if (csm !== null) {
      lightViewProj = csm.lightViewProj;
      splitPlanes = csm.splitPlanes;
      cascadeCount = csm.cascadeCount;
      cascadeBlend = csm.cascadeBlend;
      shadowMapSize = csm.shadowMapSize;
      directionalShadowQuality = csm.directionalShadowQuality;
    }
    // csm === null (no surfaced camera at all): keep the per-world carry —
    // there is no better data, and a cameraless frame renders nothing anyway.
  }

  const lights: ExtractedLights = {
    directional,
    directionalCount,
    point,
    spot,
    rect,
    lightViewProj,
    splitPlanes,
    cascadeCount,
    cascadeBlend,
    shadowMapSize,
    depthBias,
    normalBias,
    directionalShadowQuality,
    directionalShadowError,
    pointShadow,
    directionalCsmConfig,
    directionalCsmDirection,
  };

  const volumetricFog = resourceOwnerFrame?.volumetricFog;
  const cloudLayer = resourceOwnerFrame?.cloudLayer;
  const skylight = resourceOwnerFrame?.skylight;
  const skylightCount = resourceOwnerFrame?.skylightCount ?? 0;
  const skybox = resourceOwnerFrame?.skybox;
  const skyboxCount = resourceOwnerFrame?.skyboxCount ?? 0;
  const fog = resourceOwnerFrame?.fog;
  const fogFailure = resourceOwnerFrame?.fogFailure;
  const environment = resourceOwnerFrame?.environment;
  const lightProbes = succeededFrames.flatMap((frame, index) => {
    const worldId = succeededIndices[index] ?? 0;
    return (frame.lightProbes ?? []).map((probe) => ({ ...probe, worldId }));
  });
  // User-authored PostProcessParams entities are singleton scene resources, so
  // they come from the resourceOwner world (holistic snapshot selection).
  const postProcessParams = new Map(resourceOwnerFrame?.postProcessParams);
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 1): the
  // engine built-in Standard tonemap param is NOT a scene resource — the
  // per-world extractFrame bridges it from that world's own `cameras[0]`
  // (Camera.exposure / whitePoint / tonemap is the SSOT). It therefore lives on
  // the CAMERA-owner frame, not the resource-owner frame. In the split-owner
  // editor topology the resourceOwner world has no Camera, so its frame carries
  // no Standard tonemap entry; taking postProcessParams from resourceOwner
  // alone drops it, the tonemap pass's params UBO stays zero-filled
  // (exposure=0 => tonemapped output is uniformly black), and the whole frame
  // reads black even though geometry drew into the HDR target. Overlay the
  // camera-owner frame's tonemap param (its SSOT source) so the surfaced
  // camera's exposure/whitePoint/mode reach the tonemap pass. When
  // cameraOwner === resourceOwner this is a no-op (identical entry). The 'na'
  // Standard tonemap identity mirrors the engine provider key set at the
  // bottom of extractFrame (SSOT: same identity, same 16B layout).
  const OUTPUT_TRANSFORM_PARAM_KEY = STANDARD_OUTPUT_TRANSFORM_FEATURE_ID;
  const cameraTonemapParam = cameraOwnerFrame?.postProcessParams.get(OUTPUT_TRANSFORM_PARAM_KEY);
  if (cameraTonemapParam !== undefined) {
    postProcessParams.set(OUTPUT_TRANSFORM_PARAM_KEY, cameraTonemapParam);
  } else {
    // The camera-owner world produced no tonemap param (no Camera surfaced
    // there this frame); do not leave a stale resource-owner entry that would
    // apply a foreign camera's exposure. Removing it lets the tonemap pass fall
    // back to its param-less zero path only when genuinely no camera exists.
    postProcessParams.delete(OUTPUT_TRANSFORM_PARAM_KEY);
  }

  // D-3: frustumStats — culled/total summed across worlds.
  const frustumStats = {
    culled: succeededFrames.reduce((s, f) => s + f.frustumStats.culled, 0),
    total: succeededFrames.reduce((s, f) => s + f.frustumStats.total, 0),
  };
  const visibilityStats = {
    explicitlyHidden: succeededFrames.reduce((s, f) => s + f.visibilityStats.explicitlyHidden, 0),
  };
  const materialTextureSources: MaterialTextureSourceStats = {
    sourceFieldsVisited: 0,
    producerRoutes: {},
  };
  for (const frame of succeededFrames) {
    const stats = frame.materialTextureSources;
    if (stats === undefined) continue;
    materialTextureSources.sourceFieldsVisited += stats.sourceFieldsVisited;
    for (const [route, count] of Object.entries(stats.producerRoutes)) {
      materialTextureSources.producerRoutes[route] =
        (materialTextureSources.producerRoutes[route] ?? 0) + count;
    }
  }
  const reflectionProbes = succeededFrames.flatMap((f, index) => {
    const worldId = succeededIndices[index] ?? 0;
    return (f.reflectionProbes ?? []).map((probe) => ({ ...probe, worldId }));
  });

  return {
    projectedDecals,
    cameras,
    auxiliaryCameras,
    cubeCameras,
    reflectionProbes,
    lights,
    ...(volumetricFog === undefined
      ? {}
      : { volumetricFog: { ...volumetricFog, worldId: resourceOwner } }),
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    renderables,
    dispatch: dispatchEntries,
    skylight,
    skylightCount,
    lightProbes,
    skybox,
    skyboxCount,
    fog,
    ...(fogFailure === undefined ? {} : { fogFailure }),
    environment,
    environmentReady: resourceOwnerFrame !== undefined && environment !== undefined,
    frustumStats,
    visibilityStats,
    materialTextureSources,
    postProcessParams,
    visibilitySnapshots,
    featureVisibilitySnapshots,
    hiddenEntityReports,
  };
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
  const {
    assets: contextAssets,
    materialSnapshotContexts,
    cull: cullMode,
    resourceOwnerFog,
    getMaterialShaderArtifact,
    instanceCollections,
    renderableEntities,
    retainHidden,
  } = context;
  const assets = world.assets === undefined ? contextAssets : runtimeAssetRegistry(world.assets);
  const skinComponent = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  // Environment reads are owned by the retained resource projection and are
  // established at the frame boundary; record never revisits World state.
  const fog =
    resourceOwnerFog === undefined ? selectFogFrame(world) : (resourceOwnerFog ?? undefined);
  const fogFailure = fogState(world).failure;
  const visibility = context.visibility.hasAnyHiddenIntent ? context.visibility : undefined;
  const materialTextureSourceStats: MaterialTextureSourceStats = {
    sourceFieldsVisited: 0,
    producerRoutes: {},
  };

  const worldInternal = createWorldInternalView(world);
  const admitSkinMaterial = (
    entity: EntityHandle,
    hasSkin: boolean,
    skeleton: number | undefined,
    shader: string | undefined,
    selections: readonly MaterialProgramSelection[] | undefined,
    mesh: number | undefined,
  ): boolean => {
    const wantsSkin =
      selections?.some((selection) => materialProgramUsesSkin(selection.abi)) === true ||
      isStandardPbrSkinMaterialShader(shader);
    if (hasSkin && skeleton !== undefined && skeleton !== 0 && !wantsSkin) {
      worldInternal._routeError(new SkinMaterialMismatchError(entity, shader), {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (skin-material-mismatch)',
      });
      return false;
    }
    if (wantsSkin && mesh !== undefined && mesh !== 0) {
      const current = runtimeAssets(world.assets).resolveAsset<MeshAsset>(
        mesh as AssetHandle<'mesh'>,
      );
      if (current.ok) {
        const indices = current.value.attributes.skinIndex !== undefined;
        const weights = current.value.attributes.skinWeight !== undefined;
        if (!indices || !weights) {
          const missing = !indices && !weights ? 'both' : !indices ? 'skinIndex' : 'skinWeight';
          worldInternal._routeError(new MaterialSkinAttrMissingError(entity, missing), {
            severity: Severity.Error,
            systemName: 'RenderSystem.extract (material-skin-attr-missing)',
          });
          return false;
        }
      }
    }
    return true;
  };
  const {
    cameras,
    auxiliaryCameras,
    cubeCameras,
    reflectionProbes,
    lights,
    environment,
    volumetricFog,
    cloudLayer,
    skylight,
    skylightCount,
    lightProbes,
    skybox,
    skyboxCount,
  } = extractWorldEnvironment(world, context, worldInternal, fog);
  const projectedDecals = extractProjectedDecals(world, context);
  for (const [i, camera] of cameras.entries()) cameras[i] = { ...camera, projectedDecals };
  const shadowFrusta = cullMode === 'none' ? [] : buildShadowFrusta(lights);

  // feat-20260528-frustum-culling M3 / w10: precompute per-camera frustum
  // planes so entities can be tested against all cameras in the inner loop.
  // Cameras with degenerate projection parameters (e.g. zero fov, zero aspect)
  // are skipped — entities are always-visible for those. Frustum plane cache
  // stored as Float32Array[] parallel to the cameras[] array.
  //
  // feat-20260708-composited-multi-world-rendering M2 / D-4: a composite
  // non-owner world uses the camera-owner snapshots, not its own cameras.
  // This keeps culling correct when the surfaced camera and renderables live
  // in different worlds. The explicit 'none' mode remains the always-visible
  // escape hatch for callers that genuinely need it.
  const cullingCameras = cullMode === 'external' ? (context.cullCameras ?? []) : cameras;
  const frustumPlanes = cullMode === 'none' ? [] : buildCameraFrusta(cullingCameras);

  const renderables: RenderableSnapshot[] = [];
  // feat-20260528-frustum-culling M3 / w11: frustum culling counters.
  let frustumCulled = 0;
  let frustumTotal = 0;
  const explicitlyHidden = new Set<EntityHandle>();
  // feat-20260520-2d-sprite-layer-mvp M-3 / w22 (@new-surface): three-
  // bucket dispatch arrays. The legacy `materialDispatch` field stays as
  // a back-compat union (opaque + transparent + overlay back-compat
  // entries) so the pre-w25 RenderSystem.draw consumer loop keeps
  // working until M-3 / w25 lands the bucket-aware record. Plan-strategy
  // §6.1 (back-compat field stays until M-4 acceptance round green).
  // M3 / w26: single dispatch list replaces old three-bucket model
  // (plan-strategy D-3). Entries built per-entity per-pass inside the
  // archetype walk, then sorted by queue at the end.
  let dispatch: DispatchEntry[] = [];
  // Keep the derived material snapshot and its resolved passes local to this
  // extraction. Shared handles are immutable inputs for the frame, while
  // dispatch entries still need to be rebuilt for each entity.
  const materialCaches = new Map<string, MaterialSnapshotCache>();
  // tweak-20260611 M1: MeshRenderer renderable archetype walk routes
  // through one World-owned Query. K-2 sniffing scheme B
  // (`row.get(X) !== undefined` edge sniff) replaces the prior
  // `arch.components.some` row-internal back-door. K-3 invariant: the
  // variable-length array reads (`MeshRenderer.materials`, SpriteInstances
  // arrays) still flow through `_getArrayView`; explicit Instances bytes come
  // from the renderer-owned collection store.
  //
  // archVersion remains the content fingerprint for SpriteInstances' managed
  // arrays; explicit Instances use the collection revision below and never
  // need an archetype graph access for their matrix bytes.
  // feat-20260521-sprite-atlas-animation M3 / T-16: SpriteRegionOverride
  // column id for the sprite-bucket per-entity region override read
  void SpriteRegionOverride;

  const meshRendererQuery =
    context.renderables === 'none'
      ? []
      : world
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
  // QueryRow deliberately exposes component data, not an archetype version.
  // SpriteInstances still uses a content fingerprint for its managed arrays;
  // explicit Instances use the renderer-owned collection revision below.
  const resolveArchVersion = (entity: EntityHandle): number => {
    const values = [
      worldInternal._getArrayView(entity, SpriteInstances, 'transforms'),
      worldInternal._getArrayView(entity, SpriteInstances, 'regions'),
    ];
    let hash = 2166136261;
    for (const value of values) {
      hash = Math.imul(hash ^ (value?.length ?? 0), 16777619) >>> 0;
      if (value === undefined) continue;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ Math.fround(value[index] ?? 0), 16777619) >>> 0;
      }
    }
    return hash;
  };
  // Pending entries are created with the current renderables.length, which is
  // exactly the slot this entity receives if it survives culling. No other
  // renderable can be pushed between staging and this entity's push, so publish
  // the original fresh entries instead of cloning every submesh descriptor.
  // A culled entity still discards its private pending array unchanged.
  const flushPendingDispatch = (pending: DispatchList): void => {
    for (const entry of pending) dispatch.push(entry);
  };
  const requestedRows =
    renderableEntities === undefined
      ? meshRendererQuery
      : {
          *[Symbol.iterator]() {
            for (const entity of renderableEntities) {
              const row = meshRendererQuery.at(entity as EntityHandle);
              if (row !== undefined) yield row;
            }
          },
        };
  for (const row of requestedRows) {
    // K-2 archetype-edge sniff (scheme B): a missing optional component
    // surfaces as an absent bundle key, not a row-internal optional chain.
    // Presence-only checks use QueryRow.has so large array-bearing components
    // are not materialised merely to answer a boolean question.
    // The required query component owns this scalar. Read it without
    // materialising MeshRenderer's unrelated variable-length materials array.
    const lightingChannels = world[worldRead].getFieldValue(
      row.entity,
      MeshRenderer,
      'lightingChannels',
    ) as number;
    const channelsError = validateChannelMask(lightingChannels);
    if (channelsError !== null) {
      worldInternal._routeError(channelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (lighting-channels)',
      });
      continue;
    }
    const preparationMesh =
      context.preparationMesh?.entity === row.entity ? context.preparationMesh : undefined;
    const preparePipelines =
      preparationMesh !== undefined ||
      world[worldRead].getFieldValue(row.entity, MeshRenderer, 'preparePipelines') === 1;
    const hasTransform = row.has(Transform);
    const meshFilter = row.get(MeshFilter);
    const hasInstances = row.has(Instances);
    const skin = row.get(skinComponent);
    const morphWeightsView = worldInternal._getArrayView(row.entity, MorphWeights, 'weights');
    const hasMeshFilter = meshFilter !== undefined;
    const hasSkin = skin !== undefined;
    const capsuleShadowRequested = world.hasComponent(row.entity, CapsuleShadow);
    const participationRead = world.hasComponent(row.entity, ShadowParticipation)
      ? world.get(row.entity, ShadowParticipation)
      : undefined;
    const shadowChannelsError = participationRead?.ok
      ? validateChannelMask(participationRead.value.channels, 'shadowChannels')
      : null;
    if (shadowChannelsError !== null) {
      worldInternal._routeError(shadowChannelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (shadow-channels)',
      });
      continue;
    }
    const shadowCastDisabled =
      participationRead?.ok === true && participationRead.value.cast === false;
    const shadowReceiveDisabled =
      participationRead?.ok === true && participationRead.value.receive === false;
    const mobilityRead = world.hasComponent(row.entity, Mobility)
      ? world.get(row.entity, Mobility)
      : undefined;
    const mobilityStatic =
      mobilityRead?.ok === true && mobilityRead.value.kind === MobilityKindValue.static;
    // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10:
    // SpriteInstances optional component archetype-edge sniff. Three structured
    // EcsError codes fire at the row-loop entry (D-6 fail-fast at extract):
    //   - 'sprite-instances-mutually-exclusive-with-instances'
    //       (hasInstances && hasSpriteInstances) — Instances + SpriteInstances peers.
    //   - 'sprite-instances-requires-sprite-shading-model'
    //       (materialSnap.materialShaderId !== 'forgeax::sprite') — non-sprite material.
    //   - 'sprite-instances-count-mismatch'
    //       (transforms.length / 16 !== regions.length / 4) — stride pair desync.
    const hasSpriteInstances = row.has(SpriteInstances);
    const points = row.get(Points);
    const lines = row.get(Lines);
    const sortKey = row.get(SortKey)?.value;
    const pointsLinesComponent =
      points !== undefined ? 'Points' : lines !== undefined ? 'Lines' : undefined;
    const isRenderable = hasTransform && hasMeshFilter;

    // The resolved world transform is read per-entity from the single
    // `GlobalTransform.world` mat4 (propagateTransforms output) inside the row
    // loop below. Normal structural paths materialize this carrier through
    // Transform's generic ECS requirement; keep the defensive row check because
    // an owner can explicitly remove a required component during recovery.
    const fAssetHandle = preparationMesh?.meshHandle ?? meshFilter?.assetHandle;
    // feat-20260520-2d-sprite-layer-mvp M-3 / w22: Layer column read here;
    // value folded into each DispatchEntry so the render-system sort can use
    // it as the primary transparent-sort key without a second ECS round-trip.
    const fLayerValue = row.get(Layer)?.value;
    // feat-20260608-tilemap-object-layer-rendering M3 / m3-t5: tilemap-spawned
    // per-cell render entities (the ones `tilemap-chunk-extract-system`
    // pushes via `spawnDerivedRenderEntities`) reach this loop via the same
    // archetype edge that carries a sprite entity -- they all wear
    // `MeshFilter.assetHandle === HANDLE_QUAD` + a `forgeax::sprite`-shaded
    // material asset + the sprite-bucket `values.region` rectangle.
    // They share one Y-sort path with sprites: `TransparentSortCache`
    // (systems/transparent-dispatch.ts) derives footY = posY - pivotY *
    // |scaleY| from each RenderableSnapshot, so the post-flip pivot baked into
    // Transform.posY by `effectivePivotYForTilemapFlip` is the only pivot SSOT.
    // The detection lives on the material side -- detect a
    // tilemap-spawned entity by `MeshFilter.assetHandle === HANDLE_QUAD`
    // plus the `forgeax::sprite` shader id on `MeshRenderer.material`'s
    // first pass + non-empty `values.region`; no new public ECS
    // marker component lands (charter F1 minimum surface).
    //
    // Layer.value is now folded into each DispatchEntry.layer (fLayerValue
    // column, read once per archetype pass above). render-system.ts
    // `TransparentSortCache` applies (layer ASC, sortValue ASC) for all
    // transparent-sort modes (0/1/2) using posY/pivotY/sizeY from the
    // parallel renderables[] snapshot -- no second ECS round-trip needed.
    // feat-20260527-sprite-nineslice M4 / w17 (AC-14): SpriteRegionOverride
    // per-entity UV sub-rectangle. When the entity carries this component the
    // 4-float `[uMin, vMin, uW, vH]` override displaces the asset-side
    // `values.region` for this entity only — downstream 9-slice logic
    // measures slices against this effective region.zw, so a half-width sub-
    // sprite reduces the anchor budget to 0.5 rather than the asset's 1.0.
    //
    // SpriteRegionOverride.region is a fixed stride-4 value. Per-row reads
    // route through `_getArrayView` for the zero-copy row window
    // row-window slice (consistent with the variable-length array column
    // reads -- K-3 carve-out keeps `_getArrayView` as the row-accessor of
    // record for each non-scalar column).
    const hasSpriteRegionOverride = row.has(SpriteRegionOverride);
    // feat-20260523-skin-skeleton-animation M2 / T-21: Skin component
    // column views for coexistence check + joint despawn fail-fast.
    // `skeleton` holds the packed Handle<SkeletonAsset>; `joints` holds
    // the packed Entity u32 array (N x one u32 each).
    const skinSkeletonView = skin?.skeleton;

    let archVersion = 0;
    if (hasInstances || hasSpriteInstances) {
      // All rows in this callback share one archetype.  Only these two
      // instance-bearing paths consume the version in their cache key.
      archVersion = resolveArchVersion(row.entity);
    }

    {
      // feat-20260608 M2 / w11: read materials array via _getArrayView
      const entity = row.entity;
      const authorVisible = !(isRenderable && visibility?.effective(entity) === 'hidden');
      if (!authorVisible) explicitlyHidden.add(entity);
      if (!authorVisible && !retainHidden) {
        continue;
      }
      // A scalar shared<T> field uses slot 0 as the schema-level unbound
      // sentinel. An entity carrying an unbound MeshFilter is not a
      // renderable yet; keep it out of frame validation. Non-zero handles
      // still follow the normal resolve/error path below.
      if (isRenderable && fAssetHandle === 0) {
        continue;
      }
      const layerVal = fLayerValue ?? 0;
      // bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu M2.5
      // (carries PR #598 feat-20260703 D-7): dispatch entries for this entity
      // are staged locally and flushed into the shared `dispatch[]` array
      // ONLY when the entity survives the frustum-cull `continue` below —
      // same cull-passed branch as the paired `renderables.push`. Prior to
      // this fix the three `dispatch.push` sites ran before the cull check,
      // so a culled entity left dangling entries whose `renderableIndex`
      // aliased the slot a LATER visible entity occupied — surfacing as the
      // pbr-mesh-array-bgl vs hdrp-unified-bgl-group2 BGL/PL mismatch on
      // the deferred-shading smoke (PR #598 CI). Pure ordering fix; cull
      // logic and MeshRenderer contract unchanged.
      const pendingDispatch: DispatchEntry[] = [];
      const materialsView = worldInternal._getArrayView(entity, MeshRenderer, 'materials') as
        | Uint32Array
        | undefined;
      const materialCount = materialsView?.length ?? 0;
      let materialHandles = Array.from(materialsView ?? []);
      let materialBindingSources: MeshMaterialBindingSource[] = materialHandles.map(
        () => 'renderer-override',
      );
      let materialBindingDiagnostics: MeshMaterialBindingDiagnostic[] = [];
      let gpuDrivenMesh: MeshAsset | undefined;

      // Resolve instance overrides against mesh-owned slot defaults once.
      const fAssetHandleVal = fAssetHandle;
      if (
        fAssetHandleVal !== undefined &&
        fAssetHandleVal !== 0 &&
        assets !== undefined &&
        assets !== null
      ) {
        const meshHandle = fAssetHandleVal as AssetHandle<'mesh'>;
        const meshRes =
          preparationMesh === undefined
            ? runtimeAssets(world.assets).resolveAsset<Asset>(meshHandle)
            : ok(preparationMesh.mesh);
        if (meshRes.ok && meshRes.value.kind === 'mesh') {
          const meshAsset = meshRes.value as MeshAsset;
          const guid = (meshRes.value as { guid?: string }).guid ?? '<no-guid>';
          gpuDrivenMesh = meshAsset;
          // extractFrames is also a public read path and can run before the
          // Renderer.draw pre-render stage. GlyphText proves the derived mesh
          // owns exactly one Default slot; arbitrary meshes still fail closed
          // and never infer slot topology from their submeshes.
          if (!Array.isArray(meshAsset.materialSlots) && world.get(entity, GlyphText).ok) {
          }
          const resolvedBindings = resolveMeshMaterialBindings(meshAsset, materialsView ?? [], {
            isValidOverride(handle) {
              const resolved = runtimeAssets(world.assets).resolveAsset(
                handle as AssetHandle<'material'>,
              );
              return resolved.ok && resolved.value.kind === 'material';
            },
            resolveMeshDefault(defaultGuid) {
              return resolveRuntimeAssetReference(
                worldRenderResources(world),
                defaultGuid,
                'material',
              ) as number | undefined;
            },
          });
          if (!resolvedBindings.ok) {
            if (resolvedBindings.code === 'mesh-material-slots-missing') {
              worldInternal._routeError(
                new AssetError({
                  code: 'load-failed',
                  expected: 'every MeshAsset producer supplies materialSlots[]',
                  hint: `fix the MeshAsset producer; renderer inheritance never guesses slot topology (mesh=${guid}, entity=${entity}, vertices=${meshAsset.vertices.length}, indices=${meshAsset.indices?.length ?? 0})`,
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
              continue;
            }
            const materialGuid =
              typeof resolvedBindings.defaultMaterial === 'number'
                ? String(resolvedBindings.defaultMaterial)
                : AssetGuid.format(resolvedBindings.defaultMaterial);
            worldInternal._routeError(
              new AssetError({
                code: 'load-failed',
                expected: `MeshAsset materialSlots[${resolvedBindings.slotIndex}] default ${materialGuid} is ready and a MaterialAsset`,
                hint: `assets.load(meshGuid, 'mesh') must recursively load the declared default material; mesh=${guid}, slot=${resolvedBindings.slotIndex}, material=${materialGuid}`,
                detail: {
                  referencedByGuid: guid,
                  referencedByKind: 'mesh',
                  subAssetGuid: materialGuid,
                  sourceField: {
                    fieldName: 'materialSlots',
                    arrayIndex: resolvedBindings.slotIndex,
                  },
                },
              }),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (mesh-default-not-ready)',
              },
            );
            continue;
          }
          materialHandles = resolvedBindings.bindings.map((binding) => binding.handle);
          materialBindingSources = resolvedBindings.bindings.map((binding) => binding.source);
          materialBindingDiagnostics = resolvedBindings.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            detail:
              diagnostic.code === 'mesh-renderer-material-override-overflow'
                ? {
                    expectedCount: meshAsset.materialSlots.length,
                    actualCount: materialCount,
                    meshAssetGuid: guid,
                  }
                : {
                    meshAssetGuid: guid,
                    slotIndex: diagnostic.slotIndex,
                    handle: diagnostic.handle ?? 0,
                  },
          }));
          for (const diagnostic of resolvedBindings.diagnostics) {
            worldInternal._routeError(
              new AssetError({
                code: diagnostic.code,
                expected:
                  diagnostic.code === 'mesh-renderer-material-override-overflow'
                    ? `materials.length <= materialSlots.length (${meshAsset.materialSlots.length})`
                    : `materials[${diagnostic.slotIndex}] resolves to a live MaterialAsset`,
                hint: ASSET_ERROR_HINTS[diagnostic.code],
                detail:
                  diagnostic.code === 'mesh-renderer-material-override-overflow'
                    ? {
                        expectedCount: meshAsset.materialSlots.length,
                        actualCount: materialCount,
                        meshAssetGuid: guid,
                      }
                    : {
                        meshAssetGuid: guid,
                        slotIndex: diagnostic.slotIndex,
                        handle: diagnostic.handle ?? 0,
                      },
              }),
              {
                severity: Severity.Warning,
                systemName: `RenderSystem.extract (${diagnostic.code})`,
              },
            );
          }
        }
      }

      if (materialHandles.length === 0) {
        materialHandles = [0];
        materialBindingSources = ['engine-default'];
      }

      const vertexColorAvailable = gpuDrivenMesh?.attributes.color !== undefined;
      const geometry: MaterialCookRasterContext['geometry'] = hasSkin
        ? 'skinned'
        : hasSpriteInstances
          ? 'sprite-instances'
          : 'mesh';
      const cacheKey = `${geometry}:${vertexColorAvailable}`;
      let geometryMaterialCache = materialCaches.get(cacheKey);
      if (geometryMaterialCache === undefined) {
        geometryMaterialCache = new Map();
        materialCaches.set(cacheKey, geometryMaterialCache);
      }
      const geometryPersistentCache = materialSnapshotContext(
        materialSnapshotContexts,
        geometry,
        vertexColorAvailable,
      );
      const geometryMaterialContext =
        context.materialContext === undefined
          ? undefined
          : { ...context.materialContext, geometry };

      // Use the first material handle for the entity-level snapshot
      // (shading-model dispatch routing + multi-pass DispatchEntry. Per-
      // submesh materials[i>=1] are resolved by `resolveMaterialSnapshot`
      // below into the `materials[]` array, used by the record stage to
      // upload N material UBO slots and bind the i-th slot before the
      // i-th submesh draw.) -- feat-20260608 M5 amend / w11-a.
      const handleRaw = materialHandles[0] ?? 0;

      const cachedCandidate = handleRaw !== 0 ? geometryMaterialCache.get(handleRaw) : undefined;
      const cachedMaterial = cachedCandidate;

      let materialSnap: MaterialSnapshot;
      let materialProgramSelections: readonly MaterialProgramSelection[] | undefined;

      if (cachedMaterial !== undefined) {
        materialSnap = cachedMaterial.snapshot;
        materialProgramSelections = cachedMaterial.programSelections;
        if (
          hasSkin &&
          !admitSkinMaterial(
            entity,
            hasSkin,
            skinSkeletonView,
            materialSnap.materialShaderId,
            materialProgramSelections,
            fAssetHandleVal,
          )
        )
          continue;
        if (isRenderable) {
          appendMaterialDispatchEntries(
            pendingDispatch,
            cachedMaterial.snapshot.passes,
            entity,
            handleRaw,
            renderables.length,
            layerVal,
            0,
            materialSnap.materialProgramKeys,
          );
        }
      } else if (handleRaw === 0 || assets === undefined || assets === null) {
        // case B: missing-spec sentinel -> mid-grey defaultMaterialSnapshot.
        materialSnap = defaultMaterialSnapshot(handleRaw);
      } else {
        const tagged = handleRaw as AssetHandle<'material'>;
        const stableCandidate = readPersistentMaterialSnapshot(
          geometryPersistentCache,
          handleRaw,
          worldRenderResources(world),
        );
        const stablePersistentCached = stableCandidate;
        if (stablePersistentCached !== undefined) {
          geometryMaterialCache.set(handleRaw, stablePersistentCached);
          materialSnap = stablePersistentCached.snapshot;
          materialProgramSelections = stablePersistentCached.programSelections;
          if (
            hasSkin &&
            !admitSkinMaterial(
              entity,
              hasSkin,
              skinSkeletonView,
              materialSnap.materialShaderId,
              materialProgramSelections,
              fAssetHandleVal,
            )
          )
            continue;
          if (isRenderable) {
            appendMaterialDispatchEntries(
              pendingDispatch,
              stablePersistentCached.snapshot.passes,
              entity,
              handleRaw,
              renderables.length,
              layerVal,
              0,
              materialSnap.materialProgramKeys,
            );
          }
        } else {
          const res = runtimeAssets(world.assets).resolveAsset(tagged);
          if (!res.ok) {
            if (isRenderable) {
              const rhiErr = new RhiError({
                code: 'asset-not-registered',
                expected: 'MeshRenderer.material in AssetRegistry',
                hint: 'bind a live material reference from the same asset owner via assets.load or assets.create',
                detail: { assetHandle: handleRaw },
              });
              worldInternal._routeError(rhiErr, {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (material asset-not-registered)',
              });
            }
            continue;
          }
          const asset = res.value;
          if (asset.kind !== 'material') {
            materialSnap = defaultMaterialSnapshot(handleRaw);
          } else {
            // Programs and values come from the same accepted runtime material.
            const programOwner = asset;
            const allPasses = programOwner.passes ?? [];
            const materialContext = geometryMaterialContext;
            try {
              materialProgramSelections = materialProgramSelectionsForMaterial(
                programOwner,
                assets,
                materialContext,
                'direct',
                vertexColorAvailable,
              );
            } catch (error) {
              // A standalone mesh can only satisfy a cooked skinned program
              // through a Skin-bearing mesh. Probe that same exact owner
              // selection only when the resolved mesh really lacks the
              // advertised attributes; otherwise retain the producer's exact
              // publication error instead of guessing from module names/order.
              if (isMissingMaterialProgram(error) && materialContext?.geometry === 'mesh') {
                try {
                  const skinnedSelections = materialProgramSelectionsForMaterial(
                    programOwner,
                    assets,
                    {
                      ...materialContext,
                      geometry: 'skinned',
                    },
                    'direct',
                    vertexColorAvailable,
                  );
                  if (
                    skinnedSelections?.some((selection) =>
                      materialProgramUsesSkin(selection.abi),
                    ) === true &&
                    gpuDrivenMesh !== undefined
                  ) {
                    const hasSkinIndex = gpuDrivenMesh.attributes.skinIndex !== undefined;
                    const hasSkinWeight = gpuDrivenMesh.attributes.skinWeight !== undefined;
                    if (!hasSkinIndex || !hasSkinWeight) {
                      const missing =
                        !hasSkinIndex && !hasSkinWeight
                          ? 'both'
                          : !hasSkinIndex
                            ? 'skinIndex'
                            : 'skinWeight';
                      worldInternal._routeError(new MaterialSkinAttrMissingError(entity, missing), {
                        severity: Severity.Error,
                        systemName: 'RenderSystem.extract (material-skin-attr-missing)',
                      });
                      continue;
                    }
                  }
                } catch {
                  // Preserve the original exact-context publication error.
                }
              }
              throw error;
            }
            materialSnap = prepareMaterialSnapshot({
              handle: handleRaw,
              world: worldRenderResources(world),
              assets,
              material: programOwner,
              programSelections: materialProgramSelections,
              materialContext,
              textureSourceStats: materialTextureSourceStats,
              vertexColorAvailable,
              geometry,
            });
            if (
              !admitSkinMaterial(
                entity,
                hasSkin,
                skinSkeletonView,
                materialSnap.materialShaderId,
                materialProgramSelections,
                fAssetHandleVal,
              )
            )
              continue;

            {
              const stored = storeMaterialSnapshot(
                geometryPersistentCache ?? geometryMaterialCache,
                handleRaw,
                materialSnap,
                worldRenderResources(world),
                materialProgramSelections,
              );
              materialSnap = stored.snapshot;
              geometryMaterialCache.set(handleRaw, stored);
              geometryPersistentCache?.set(handleRaw, stored);
            }

            // Build dispatch entries from resolved passes.
            if (isRenderable) {
              appendMaterialDispatchEntries(
                pendingDispatch,
                allPasses,
                entity,
                handleRaw,
                renderables.length,
                layerVal,
                0,
                materialSnap.materialProgramKeys,
              );
            }
          }
        }
      }

      // feat-20260609 M2/M5 corrective fixup: default-material entities
      // (handleRaw===0 / case-B MeshRenderer{data:{}}) must produce
      // ShadowCaster dispatch entries so the shadow pass includes them.
      // The pre-existing logic only builds dispatch entries from
      // resolved material assets; defaultMaterialSnapshot() (mid-grey unlit)
      // left dispatch empty, causing shadow-m2/m3 test failures.
      // Requirements §10.5: shadow-casting is default behaviour; the
      // per-entity opt-out is ShadowParticipation { cast: false }.
      //
      // CHARTER NOTE (feat-20260609 T-005-a): the URP literals
      // `LightMode: 'ShadowCaster'` / `LightMode: 'Forward'` below are a
      // local URP-bridge — they mirror what `Materials.unlit()` produces
      // at the asset layer.  The default-material
      // handle=0 path bypasses asset registration, so we synthesize the
      // same dispatch shape inline.  Follow-up cleanup (F-1 from
      // implement-review R1): thread default materials through the
      // Materials factory so this block can call into the shared
      // passes[] producer.
      // tweak-20260701 M1: `materialSnap.shadingModel === 'unlit'` removed —
      // for handleRaw===0, defaultMaterialSnapshot() was always unlit
      // (the shadingModel check was a tautology); the isRenderable &&
      // handleRaw===0 guard alone preserves the exact same dispatch shape.
      if (isRenderable && handleRaw === 0) {
        const shadowCasterTags: Record<string, string> = { LightMode: 'ShadowCaster' };
        const nextRenderableIndex = renderables.length;
        // M2.5: stage into pendingDispatch; flushed at the renderable push
        // site below only when the entity survives cull.
        pendingDispatch.push({
          entityIndex: entity,
          materialHandle: 0,
          renderableIndex: nextRenderableIndex,
          passIndex: 0,
          queue: 2000,
          layer: layerVal,
          ...(participationRead?.ok && participationRead.value.channels !== 0xffffffff
            ? { shadowChannels: participationRead.value.channels }
            : {}),
          tags: shadowCasterTags,
          renderState: undefined,
          defines: undefined,
          vertexEntry: 'vs_main',
          fragmentEntry: undefined,
          materialShaderId: 'forgeax::default-shadow-caster',
        });
        // Also add a Forward pass entry so the entity renders in the
        // main scene pass (mirrors Materials.unlit default).
        appendMaterialDispatchEntries(
          pendingDispatch,
          [DEFAULT_FORWARD_PASS],
          entity,
          0,
          nextRenderableIndex,
          layerVal,
          1,
        );
      }

      if (isRenderable) {
        // Static source membership only; actual demand resolves the shared pose.
        let skinBinding:
          | { readonly skeleton: number; readonly joints: readonly number[] }
          | undefined;
        if (hasSkin) {
          const skeletonHandleRaw = skinSkeletonView;
          if (
            skeletonHandleRaw !== undefined &&
            skeletonHandleRaw !== 0 &&
            assets !== undefined &&
            assets !== null
          ) {
            // Skin + Instances coexistence is forbidden (D-10).
            if (hasInstances) {
              worldInternal._routeError(new SkinInstancesCoexistForbiddenError(entity), {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (skin-instances-coexist)',
              });
              continue;
            }
            // (a) Resolve skeleton asset; on failure -> skeleton-resolve-failed.
            const skeletonHandle = skeletonHandleRaw as AssetHandle<'skeleton'>;
            const skeletonRes = runtimeAssets(world.assets).resolveAsset<SkeletonAsset>(
              skeletonHandle,
            );
            if (!skeletonRes.ok || skeletonRes.value.kind !== 'skeleton') {
              worldInternal._routeError(new SkeletonResolveFailedError(entity, skeletonHandleRaw), {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (skeleton-resolve-failed)',
              });
              continue;
            }
            const skeleton = skeletonRes.value;
            // (b) Reuse the Skin row already read for its skeleton handle;
            // the old path repeated a second whole-row world.get here.
            const skinJoints = skin?.joints;
            if (skinJoints === undefined) {
              continue;
            }
            const jointsLength = skinJoints.length;
            if (jointsLength !== skeleton.jointCount) {
              worldInternal._routeError(
                new JointCountMismatchError(entity, skeleton.jointCount, jointsLength),
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (joint-count-mismatch)',
                },
              );
              // Keep nonempty static membership; actual fixed-frame demand rejects an incompatible resource.
            }
            if (jointsLength === 0) continue; // Invalid static membership never crosses the protocol boundary.
            // Static Binding admission does not read or duplicate dynamic joint matrices.
            skinBinding = {
              skeleton: skeletonHandleRaw,
              joints: Object.freeze(Array.from(skinJoints, Number)),
            };
          }
        }

        // A pbr-skin PSO requires the complete three-binding group(2) skin
        // projection. Do not publish a renderable or its staged dispatch when
        // palette extraction was unavailable; the record stage must never
        // reinterpret a skinned vertex stream through an ordinary mesh group.
        if (skinBinding === undefined && hasSkin) {
          if (
            materialSnap.materialShaderId === 'forgeax::pbr-skin' ||
            materialProgramSelections?.some((selection) =>
              materialProgramUsesSkin(selection.abi),
            ) === true
          ) {
            pendingDispatch.length = 0;
            continue;
          }
        }

        // feat-20260601 D-3: read the resolved world mat4 (propagateTransforms
        // output) straight from the GlobalTransform.world column array view. The
        // record stage copies these 16 floats into the mesh SSBO with zero
        // per-snapshot `mat4.compose` (AC-07). A stale slot (generation gone)
        // skips the renderable, mirroring the Instances dangling-row sweep.
        // tweak-20260611 M1 / K-3: `_getArrayView` call survives untouched;
        // only the `entity` source switched to `bundle.Entity.self[i]`.
        const worldView = readPresentationWorldMatrix(world, entity);
        if (worldView === undefined) {
          continue;
        }
        const worldMat = new Float32Array(worldView);
        const transformSnap: TransformSnapshot = { world: worldMat };
        // feat-20260608 M5 amend / w11-a: per-submesh `materials[]` array
        // aligned 1-1 with `MeshAsset.submeshes[]`. materials[0] === the
        // representative entity-level snapshot already built; materials[i>=1]
        // use the same material preparation and cache. When the
        // entity has no materialsView (case-B sentinel) the array is a single
        // mid-grey default mirroring the legacy single-material path so the
        // record stage's per-submesh UBO upload loop trivially writes one
        // slot, no special branch.
        const materialsArr: MaterialSnapshot[] = [materialSnap];
        if (assets !== undefined && assets !== null) {
          for (let mi = 1; mi < materialHandles.length; mi++) {
            const subHandle = materialHandles[mi] ?? 0;
            const subCache = geometryMaterialCache;
            const cachedSubmaterial = subCache.get(subHandle);
            materialsArr.push(
              cachedSubmaterial?.snapshot ??
                resolveMaterialSnapshot(
                  subHandle,
                  worldRenderResources(world),
                  assets,
                  subCache,
                  geometryPersistentCache,
                  geometryMaterialContext,
                  materialTextureSourceStats,
                  vertexColorAvailable,
                ),
            );
          }
        }
        if (isRenderable && assets !== undefined && assets !== null) {
          for (let mi = 1; mi < materialHandles.length; mi++) {
            const subHandle = materialHandles[mi] ?? 0;
            if (subHandle === handleRaw) continue;
            const subEntry =
              geometryMaterialCache.get(subHandle) ??
              readPersistentMaterialSnapshot(
                geometryPersistentCache,
                subHandle,
                worldRenderResources(world),
              );
            appendMaterialDispatchEntries(
              pendingDispatch,
              subEntry?.snapshot.passes ?? (subHandle === 0 ? [DEFAULT_FORWARD_PASS] : []),
              entity,
              subHandle,
              renderables.length,
              layerVal,
              0,
              materialsArr[mi]?.materialProgramKeys,
            );
          }
        }

        // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 /
        // w10: SpriteInstances validation + snapshot materialisation.
        // Three structured EcsError fires at this single point (plan-strategy
        // D-6 "fail-fast at the render domain entry, not at ECS spawn-time"):
        let spriteInstancesSnap: SpriteInstancesSnapshot | undefined;
        if (hasSpriteInstances) {
          // (1) mutually exclusive with Instances (peers — pick one).
          if (hasInstances) {
            worldInternal._routeError(
              new SpriteInstancesMutuallyExclusiveWithInstancesError(entity),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (sprite-instances-mutually-exclusive)',
              },
            );
            continue;
          }
          // The immutable author program owns geometry semantics even when
          // program selection returns a cooked artifact key.
          if (!materialUsesSpriteGeometry(materialSnap)) {
            worldInternal._routeError(
              new SpriteInstancesRequiresSpriteShaderError(
                entity,
                materialSnap.materialShaderId ?? 'undefined',
              ),
              {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (sprite-instances-requires-sprite-shader)',
              },
            );
            continue;
          }
          // (3) count mismatch — transforms.length / 16 === regions.length / 4
          // (transforms.length=0 + regions.length=0 is the zero-instance lawful
          // boundary; both derivations are 0 and equality holds, so no fire).
          const transforms = worldInternal._getArrayView(entity, SpriteInstances, 'transforms');
          const regions = worldInternal._getArrayView(entity, SpriteInstances, 'regions');
          if (transforms !== undefined && regions !== undefined) {
            const transformsLength = transforms.length;
            const regionsLength = regions.length;
            // Stride sanity: transforms must be mod 16, regions must be mod 4.
            // A stride violation expresses as a count mismatch under the
            // canonical derivation transforms/16 vs regions/4 — fire the
            // count-mismatch code (the same code carries detail.expectedStride).
            const tCount = transformsLength / 16;
            const rCount = regionsLength / 4;
            if (transformsLength % 16 !== 0 || regionsLength % 4 !== 0 || tCount !== rCount) {
              worldInternal._routeError(
                new SpriteInstancesCountMismatchError(transformsLength, regionsLength),
                {
                  severity: Severity.Error,
                  systemName: 'RenderSystem.extract (sprite-instances-count-mismatch)',
                },
              );
              continue;
            }
            // Validation passes — build the snapshot. transforms.length === 0
            // is lawful (zero-instance) and produces instanceCount=0; the
            // record stage skips drawIndexed when instanceCount===0.
            const transformsCopy = new Float32Array(transforms);
            const regionsCopy = new Float32Array(regions);
            spriteInstancesSnap = {
              transforms: transformsCopy,
              regions: regionsCopy,
              instanceCount: tCount,
              cacheKey: entity,
              archVersion,
            };
          }
        }

        let localAabb: Float32Array | undefined;
        let lods: readonly MeshLodLevel[] | undefined;
        let lodHysteresis: number | undefined;
        let morph: MorphSnapshot | undefined;
        const assetHandleRaw = Math.round(fAssetHandle ?? 0);
        if (assetHandleRaw !== 0) {
          const meshRes =
            preparationMesh === undefined
              ? runtimeAssets(world.assets).resolveAsset(assetHandleRaw as AssetHandle<'mesh'>)
              : ok(preparationMesh.mesh);
          if (meshRes.ok && meshRes.value.kind === 'mesh') {
            const meshAsset = meshRes.value as MeshAsset;
            lods = meshAsset.lods;
            lodHysteresis = meshAsset.lodHysteresis;
            morph = morphSnapshotFor(meshAsset, morphWeightsView);
            const meshAabb = hasSkin ? undefined : meshAsset.aabb;
            // Morph targets can expand the authored bounds. Keep the
            // specialized lane conservative until a target-aware bounds
            // projection is available; a false-positive draw is preferable
            // to culling a valid deformed vertex.
            if (morph === undefined && isFiniteAabb(meshAabb)) {
              localAabb = new Float32Array(meshAabb);
            }
          }
        }

        const displacementRadius = standardDisplacementRadius(materialsArr);
        localAabb = expandDisplacementBounds(localAabb, displacementRadius);
        // Bind-pose bounds cannot enclose arbitrary animated joint scale. Until
        // a pose enclosure is available, displaced skins remain conservatively visible.
        if (hasSkin && displacementRadius > 0) localAabb = undefined;

        const pointsLinesStyle: PointsLinesStyle | undefined =
          points !== undefined
            ? (() => {
                const shape = pointShapeFromU32(points.shape);
                return shape === undefined
                  ? undefined
                  : { kind: 'points' as const, sizePx: points.sizePx, shape };
              })()
            : lines === undefined
              ? undefined
              : {
                  kind: 'lines' as const,
                  width: lines.width,
                  widthUnits: lines.widthUnits,
                  cap: lines.cap,
                  dashSize: lines.dashSize,
                  gapSize: lines.gapSize,
                  dashOffset: lines.dashOffset,
                };
        const cullingLocalAabb = expandPointsLinesBounds(localAabb ?? [], pointsLinesStyle);
        const pointsLines =
          pointsLinesComponent === undefined
            ? undefined
            : ({
                worldId: context.worldId,
                entityKey: entity,
                component: pointsLinesComponent,
                meshHandle: assetHandleRaw,
                materialHandle: handleRaw,
                style: pointsLinesStyle,
                layer: layerVal,
                ...(participationRead?.ok && participationRead.value.channels !== 0xffffffff
                  ? { shadowChannels: participationRead.value.channels }
                  : {}),
                sortKey,
                visible: true,
                sourceBounds: cullingLocalAabb,
                viewport: { width: 0, height: 0, dpr: 1 },
                projection: identityProjection(),
              } satisfies PointsLinesRetainedSnapshot);

        // Instances are snapshotted before the CPU visibility decision so the
        // culling owner can derive the union of every instance's transformed
        // mesh bounds. The same detached snapshot is then carried to record;
        // do not re-read the collection after culling (a mutation must not
        // make the cull and draw disagree within one frame).
        let instancesSnap: InstancesSnapshot | undefined;
        if (hasInstances) {
          const transforms =
            worldInternal._getArrayView(entity, Instances, 'transforms') ?? new Float32Array();
          const projected =
            instanceCollections === undefined
              ? validateInstanceTransforms(transforms)
              : instanceCollections.project(world, entity, transforms, {
                  epoch: readMutationEpoch(world),
                  changedSince: (since) =>
                    readArrayRangesChangedSince(world, entity, Instances, 'transforms', since),
                });
          if (projected instanceof Error) {
            worldInternal._routeError(projected, {
              severity: Severity.Error,
              systemName: 'RenderSystem.extract (Instances transforms)',
            });
            continue;
          }
          instancesSnap = {
            transforms: projected?.transforms ?? new Float32Array(transforms),
            instanceCount: transforms.length / 16,
            cacheKey: entity,
            archVersion: projected === undefined ? archVersion : 0,
            ...(projected === undefined
              ? {}
              : {
                  collectionId: projected.collectionId,
                  revision: projected.revision,
                  generations: projected.generations,
                  ...(projected.dirtyRanges === undefined
                    ? {}
                    : { dirtyRanges: projected.dirtyRanges }),
                }),
          };
        }

        const baseRenderable: RenderableSnapshot = {
          ...(hasSpriteRegionOverride
            ? {
                spriteRegion: spriteUvRegion(
                  worldInternal._getArrayView(entity, SpriteRegionOverride, 'region'),
                  0,
                  0,
                ),
              }
            : {}),
          layer: layerVal,
          ...(participationRead?.ok && participationRead.value.channels !== 0xffffffff
            ? { shadowChannels: participationRead.value.channels }
            : {}),
          ...(shadowCastDisabled || pointsLinesComponent !== undefined
            ? { shadowCaster: false as const }
            : {}),
          lightingChannels,
          assetHandle: Math.round(fAssetHandle ?? 0),
          transform: transformSnap,
          ...(lods === undefined ? {} : { lods }),
          ...(lodHysteresis === undefined ? {} : { lodHysteresis }),
          ...(localAabb !== undefined ? { localAabb: cullingLocalAabb } : {}),
          material: MaterialResource.from(materialSnap),
          materials: materialsArr.map(MaterialResource.from),
          materialBindingSources,
          materialOverrides: captureMaterialOverrides(
            Array.from(materialsView ?? [], (handle) => {
              if (handle === 0 || assets == null) return undefined;
              const current = runtimeAssets(world.assets).resolveAsset(handle);
              if (!current.ok || current.value.kind !== 'material') return undefined;
              return MaterialResource.from(
                resolveMaterialSnapshot(
                  handle,
                  worldRenderResources(world),
                  assets,
                  geometryMaterialCache,
                  geometryPersistentCache,
                  geometryMaterialContext,
                  materialTextureSourceStats,
                  vertexColorAvailable,
                ),
              );
            }),
          ),
          materialBindingDiagnostics,
          worldId: context.worldId,
          entityKey: entity,
          ...(authorVisible ? {} : { authorVisible: false }),
          ...(skinBinding === undefined ? {} : { skinBinding }),
          ...(capsuleShadowRequested ? { capsuleShadowRequested: true } : {}),
          ...(morph !== undefined ? { morph } : {}),
          ...(instancesSnap !== undefined ? { instances: instancesSnap } : {}),
          ...(spriteInstancesSnap !== undefined ? { spriteInstances: spriteInstancesSnap } : {}),
          ...(pointsLines !== undefined ? { pointsLines } : {}),
        };
        const gpuDrivenDraws = buildGpuDrivenDraws({
          mesh: gpuDrivenMesh,
          materials: materialsArr,
          fallbackMaterial: materialSnap,
          deformation: skinBinding === undefined ? 'rigid' : 'skin',
          ...(getMaterialShaderArtifact === undefined ? {} : { getMaterialShaderArtifact }),
          ...(lods === undefined
            ? {}
            : {
                lodMeshes: lods.map((lod) => {
                  const lower = renderAsset(worldRenderResources(world), lod.mesh);
                  return lower?.kind === 'mesh' ? lower : undefined;
                }),
              }),
        });
        for (const draw of gpuDrivenDraws) {
          if (draw.preparationError === undefined) continue;
          worldInternal._routeError(draw.preparationError, {
            severity: Severity.Error,
            systemName: `RenderSystem.extract (gpu-driven-preparation:${draw.preparationError.code})`,
          });
        }
        const renderable =
          morph === undefined && gpuDrivenDraws.length > 0
            ? { ...baseRenderable, gpuDrivenDraws }
            : baseRenderable;

        // Material passes stay shared; participation only filters this entity's
        // ShadowCaster work, so every shadow map and cull test sees it absent.
        // Screen-space points and lines have no world-space footprint to cast.
        if (shadowCastDisabled || pointsLinesComponent !== undefined) {
          for (let i = pendingDispatch.length - 1; i >= 0; i -= 1) {
            if (pendingDispatch[i]?.tags.LightMode === 'ShadowCaster') pendingDispatch.splice(i, 1);
          }
        }

        const pipelinePreparation = preparePipelines
          ? pendingDispatch.map(
              ({ entityIndex: _entityIndex, renderableIndex: _renderableIndex, ...pass }) => pass,
            )
          : undefined;

        // feat-20260528-frustum-culling M3 / w10: frustum culling check.
        // Skip the entity if a valid AABB exists AND ALL cameras' frusta
        // reject the world-space AABB. Missing or malformed AABBs are
        // conservative always-visible fallbacks; valid culling bounds are
        // producer-owned finite local-space AABBs. Culling is unconditional
        // engine behavior; there is no per-entity opt-out.
        if (localAabb !== undefined) {
          // An empty or malformed Instances payload has no meaningful bounds.
          // Keep it conservative (the draw path later emits zero instances)
          // instead of manufacturing the entity's identity bounds. For a
          // valid payload, derive one world-space union for CPU culling while
          // leaving the mesh-local AABB untouched for GPU per-instance cull.
          // With no camera frustum every entity is visible, so the union
          // bound would only feed a test whose result is already known.
          const cullActive = frustumPlanes.length > 0;
          const derivedInstancesBounds =
            !cullActive || instancesSnap === undefined || instancesSnap.instanceCount === 0
              ? undefined
              : deriveInstancesUnionBounds({
                  meshAabb: cullingLocalAabb,
                  entityWorld: transformSnap.world,
                  transforms: instancesSnap.transforms,
                });
          if (instancesSnap?.instanceCount === 0) {
            // No instance can contribute a visible bound. The retained
            // snapshot still records instanceCount=0 for the record stage.
          } else if (!cullActive) {
            frustumTotal += 1;
          } else if (
            hasInstances &&
            (instancesSnap === undefined || derivedInstancesBounds === undefined)
          ) {
            // Missing/malformed derived facts are a conservative no-cull
            // result. The stride validator above already rejects malformed
            // lengths; this branch covers non-finite producer matrices/AABB.
          } else {
            // feat-20260601 D-3: cull AABB uses the resolved world mat4
            // directly (no compose) -- same source the record stage feeds
            // the mesh SSBO, so cull stays same-source with render (AC-05).
            const worldAabb = box3.create();
            if (derivedInstancesBounds !== undefined) {
              worldAabb[0] = derivedInstancesBounds[0] ?? 0;
              worldAabb[1] = derivedInstancesBounds[1] ?? 0;
              worldAabb[2] = derivedInstancesBounds[2] ?? 0;
              worldAabb[3] = derivedInstancesBounds[3] ?? 0;
              worldAabb[4] = derivedInstancesBounds[4] ?? 0;
              worldAabb[5] = derivedInstancesBounds[5] ?? 0;
            } else {
              box3.transformBox3(worldAabb, cullingLocalAabb, transformSnap.world);
            }

            // Test against all cameras. Entity is visible if one camera
            // frustum intersects the world-space AABB (or planes are empty
            // from degenerate projection).
            frustumTotal += 1;
            let visible = frustumPlanes.length === 0;
            for (let ci = 0; ci < frustumPlanes.length; ci++) {
              const planes = frustumPlanes[ci] as Float32Array;
              if (planes.length === 0) {
                visible = true;
                break;
              }
              if (frustum.intersectsBox(planes as frustum.Frustum, worldAabb as box3.Box3Like)) {
                visible = true;
                break;
              }
            }
            if (!visible) {
              frustumCulled += 1;
              const shadowVisible =
                shadowFrusta.length > 0 &&
                pendingDispatch.some((entry) => entry.tags.LightMode === 'ShadowCaster') &&
                shadowFrusta.some((lightPlanes) =>
                  frustum.intersectsBox(lightPlanes, worldAabb as box3.Box3Like),
                );
              if (!shadowVisible && pipelinePreparation === undefined) continue;
              // Shadow-only renderables stay in the detached snapshot for the
              // depth passes, but must not leak their forward/transparent
              // dispatch entries into the main camera submission.
              for (let i = pendingDispatch.length - 1; i >= 0; i -= 1) {
                if (pendingDispatch[i]?.tags.LightMode !== 'ShadowCaster') {
                  pendingDispatch.splice(i, 1);
                }
              }
            }
          }
        }

        // Retain hidden snapshots for incremental composition, but never
        // publish their display or ShadowCaster passes to either record lane.
        if (!authorVisible) pendingDispatch.length = 0;
        // Pose and capsule shadow admission belong to the selected fixed frame's actual demand.
        const renderableWithShadowPasses =
          !mobilityStatic && !shadowReceiveDisabled
            ? renderable
            : {
                ...renderable,
                ...(mobilityStatic ? { mobility: 'static' as const } : {}),
                ...(shadowReceiveDisabled ? { shadowReceiver: false as const } : {}),
              };
        flushPendingDispatch(pendingDispatch);
        renderables.push(
          pipelinePreparation === undefined
            ? renderableWithShadowPasses
            : {
                ...renderableWithShadowPasses,
                pipelinePreparation,
              },
        );
      }

      // feat-20260520-2d-sprite-layer-mvp M-3 / w22 + w25: finalise the
      // pending DispatchEntry with the renderableIndex pointing at the
      // RenderableSnapshot we just pushed (when isRenderable === true).
      // The check below also covers a sprite entity that survives the
      // dangling-Instances branch (silent skip with `dispatchEntry !==
      // null` early-continue) — in that case renderableIndex is still set
      // to the just-pushed slot which is correct because materialDispatch
      // already captures the dispatch position.
    }
  }

  if (context.renderables !== 'none' && assets != null)
    extractTerrainSources(
      world,
      assets,
      context.materialContext,
      context.worldId,
      renderables,
      dispatch,
      renderableEntities,
      visibility,
      retainHidden,
      explicitlyHidden,
    );

  if (context.renderables !== 'none')
    extractGlyphSources(
      world,
      context.worldId,
      renderables,
      renderableEntities,
      visibility,
      retainHidden,
      explicitlyHidden,
    );

  if (context.renderables !== 'none')
    extractTilemapSources(
      world,
      context.worldId,
      renderables,
      renderableEntities,
      visibility,
      retainHidden,
      explicitlyHidden,
    );

  // M3 / w26: sort dispatch entries by queue (ascending, stable sort)
  // per plan-strategy D-3.
  dispatch = sortDispatchByQueue(dispatch);
  // D-1: collect PostProcessParams entities into Map<shaderId, Uint8Array>.
  // Last-one-wins when multiple entities bear the same shader id (mirrors
  // Camera.exposure -> CameraSnapshot pattern; extract stage only reads).
  const postProcessParams: Map<string, Uint8Array> = new Map();
  const postProcessParamsQuery = world.query({ with: [PostProcessParams] }).unwrap();
  for (const row of postProcessParamsQuery) {
    const entity = row.entity;
    const read = world.get(entity, PostProcessParams);
    if (!read.ok) continue;
    postProcessParams.set(read.value.shader, read.value.data);
  }

  // feat-20260621 M-A3 / w13 (D-5): engine built-in tonemap data-driven
  // provider. The engine bridges the active camera's `Camera.exposure /
  // whitePoint / tonemap` onto the SAME unified params channel custom
  // post-processes use — `Camera.exposure` stays the AI-user-facing SSOT (D-5),
  // the engine itself acts as the provider for the Standard tonemap shader
  // id. The 16B layout keeps the prior recordTonemapPass packing
  // (render-system-record.ts pre-w14): Float32 [exposure, whitePoint, _,
  // ditherEnabled], with the mode u32 occupying the third 4-byte slot via
  // tonemapToU32 (SSOT in camera.ts). The final Output Transform makes a
  // per-pass copy and writes ditherEnabled at byte offset 12; the extracted
  // camera snapshot remains the SSOT. Run AFTER the user-entity collection above so the engine's
  // built-in provider is authoritative for its own reserved key (a user entity
  // can never shadow the Standard tonemap identity. The single active camera mirrors
  // recordFrame's `activeCameras[0]` selection.
  const tonemapCamera = cameras[0];
  if (tonemapCamera !== undefined) {
    postProcessParams.set(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, tonemapParams(tonemapCamera));
  }

  return {
    projectedDecals,
    cameras,
    auxiliaryCameras,
    cubeCameras,
    reflectionProbes,
    lights,
    environment,
    environmentReady: true,
    ...(volumetricFog === undefined ? {} : { volumetricFog }),
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    renderables,
    dispatch,
    skylight,
    skylightCount,
    lightProbes,
    skybox,
    skyboxCount,
    fog,
    ...(fogFailure === undefined ? {} : { fogFailure }),
    frustumStats: { culled: frustumCulled, total: frustumTotal },
    visibilityStats: { explicitlyHidden: explicitlyHidden.size },
    materialTextureSources: materialTextureSourceStats,
    postProcessParams,
    visibilitySnapshots: [context.visibility],
    featureVisibilitySnapshots: [{ world, snapshot: context.visibility }],
    hiddenEntityReports: [...explicitlyHidden].map((entity) => ({ world, entity })),
  };
}

function identityProjection(): Float32Array {
  const projection = new Float32Array(16);
  projection[0] = 1;
  projection[5] = 1;
  projection[10] = 1;
  projection[15] = 1;
  return projection;
}
