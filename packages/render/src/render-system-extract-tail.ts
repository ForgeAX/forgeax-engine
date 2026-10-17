import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  resolveAssetHandle,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
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
import { box3, frustum, type Mat4, mat4, type Vec3 } from '@forgeax/engine-math';
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
  JointEntityDanglingError,
  SkeletonResolveFailedError,
  Skin,
  SkinInstancesCoexistForbiddenError,
} from '@forgeax/engine-skinning';
import type {
  Asset,
  Handle,
  MaterialAsset,
  MeshAsset,
  MeshLodLevel,
  SkeletonAsset,
} from '@forgeax/engine-types';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  derive,
  isTriangleTopology,
  materialValuesToLinearRuntime,
  ok,
  toShared,
} from '@forgeax/engine-types';
import { buildCameraFrusta } from './camera-frusta';
import { type CapsuleShadowSnapshot, poseShadowCapsules } from './capsule-shadow/world-capsules';
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
import { validateLightingChannels } from './components/lighting-channels';
import { ProjectedDecalInvalidError } from './decals/component';
import { extractProjectedDecals } from './decals/extract';
import {
  createLightResourceUnavailable,
  MaterialSkinAttrMissingError,
  SkinMaterialMismatchError,
} from './errors/render';
import {
  buildGpuDrivenDraws,
  gpuDrivenShadowDrawKey,
  gpuDrivenSourceDrawItemIndex,
} from './extract/gpu-driven';
import type { VisibilitySnapshot } from './extract/visibility';
import { extractWorldEnvironment } from './extract/world-environment';
import { MotionBlurValidationError } from './features/motion-blur/motion-blur-params';
import type {
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from './features/types';
import { ensureGlyphMeshMaterialSlots } from './glyph-text-layout-system';
import { type InstanceProjectionStore, validateInstanceTransforms } from './instances';
import { deriveInstancesUnionBounds } from './instances-derived-bounds';
import {
  type MeshMaterialBindingDiagnostic,
  type MeshMaterialBindingSource,
  resolveMeshMaterialBindings,
} from './mesh-material-bindings';
import { isStandardPbrSkinMaterialShader } from './pbr-pipeline';
import { expandPointsLinesBounds } from './points-lines/bounds';
import type { PointsLinesRetainedSnapshot, PointsLinesStyle } from './points-lines/snapshot';
import { IES_SLICE_CAPACITY } from './prepare/extended-lighting/resources';
import { worldEntityKey } from './record/frame-snapshot';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from './render-contract';
import type {
  CsmCameraData,
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  DispatchEntry,
  ExtractedFrame,
  ExtractedLights,
  ExtractFramesOwner,
  ExtractPipelineSurface,
  InstancesSnapshot,
  MaterialProgramSelection,
  MaterialSnapshot,
  MaterialSnapshotCache,
  MaterialSnapshotCachesByWorld,
  MaterialTextureSourceCache,
  MaterialTextureSourceStats,
  MorphSnapshot,
  PointLightSnapshot,
  PointShadowSnapshot,
  PreparedExtractContext,
  RectAreaDirectLightSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
  SpotLightSnapshot,
  SpriteInstancesSnapshot,
  TransformSnapshot,
} from './render-system-extract';
import {
  appendMaterialDispatchEntries,
  assetReferenceText,
  BUILTIN_MATERIAL_TEXTURE_FIELDS,
  collectAuthoredMaterialSamplerFields,
  collectAuthoredMaterialTextureFields,
  collectMaterialTextureCoordinates,
  collectMaterialTextureSamplers,
  collectMaterialTextureSources,
  computeDirectionalCsm,
  createWorldInternalView,
  DEFAULT_FORWARD_PASS,
  defaultMaterialSnapshot,
  fogState,
  internSharedRefFromGuid,
  isEngineInjectedTextureField,
  materialColorParameterSchema,
  materialParamSchemaForMaterial,
  materialProgramSelectionsForMaterial,
  materialPublicationForMaterial,
  materialSceneIndexProgramKeysForMaterial,
  materialStandardTextureMask,
  materialSurfaceModel,
  materialSurfaceProgramsForMaterial,
  materialTextureFields,
  materialTextureRef,
  materialTextureSourceFields,
  materialValueSnapshot,
  pipelineRenderState,
  prepareExtractContext,
  readPersistentMaterialSnapshot,
  readStablePersistentMaterialSnapshot,
  resolveMaterialSnapshot,
  resolveVideoFieldHandle,
  runtimeMaterialShaderIdForMaterial,
  Severity,
  selectFogFrame,
  shadowCasterCpuReason,
  sortDispatchByQueue,
  storeMaterialSnapshot,
  tonemapParams,
} from './render-system-extract';
import { buildShadowFrusta } from './scene/shadow-visibility';
import { skinPosedBounds, skinPosedBoundsCache } from './skin-posed-bounds';
import {
  expandDisplacementBounds,
  standardDisplacementRadius,
} from './standard-displacement-bounds';
import { prepareSkinPalette } from './systems/skin-palette-allocator';
import type { SkinPaletteReceipt, SkinPose } from './systems/skin-palette-types';
import { extractTerrainSources } from './terrain/source.js';

function skinPaletteIdentity(world: World, entity: number): string {
  return `skin:${world.identity}:${entity}`;
}

// The existing persistent cache is scoped to one extraction owner. Skin and
// vertex-color program contexts must never consume its ordinary mesh entries.
const skinMaterialCaches = new WeakMap<
  MaterialSnapshotCache,
  Map<boolean, MaterialSnapshotCache>
>();
function skinMaterialCache(
  owner: MaterialSnapshotCache | undefined,
  vertexColor: boolean,
): MaterialSnapshotCache | undefined {
  if (owner === undefined) return undefined;
  let contexts = skinMaterialCaches.get(owner);
  if (contexts === undefined) {
    contexts = new Map();
    skinMaterialCaches.set(owner, contexts);
  }
  let cache = contexts.get(vertexColor);
  if (cache === undefined) {
    cache = new Map();
    contexts.set(vertexColor, cache);
  }
  return cache;
}

// Self-contained Pack materials can prove immutability without invoking any
// author getter or following a potentially mutable foreign parent. Inherited,
// accessor-bearing and mutable skin sources keep their original projection.
function frozenSkinMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return ['string', 'number', 'boolean'].includes(typeof value);
  if (seen.has(value)) return true;
  try {
    const root = seen.size === 0;
    const prototype = Object.getPrototypeOf(value);
    if (
      !Object.isFrozen(value) ||
      (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    )
      return false;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
      if (root && key === 'parent' && descriptor.value !== undefined) return false;
      if (!frozenSkinMaterial(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// A frozen author payload does not freeze the registry's accepted program
// owner. Readiness and program replacement can occur without a catalog epoch.
const frozenSkinMaterialOwners = new WeakMap<
  MaterialSnapshot,
  (assets: AssetRegistry) => boolean
>();
function rememberFrozenSkinMaterial(
  snapshot: MaterialSnapshot,
  material: MaterialAsset,
  assets: AssetRegistry,
  selections: readonly MaterialProgramSelection[] | undefined,
): void {
  const projection = assets.getMaterialProjectionForPayload(material);
  const programs = (material.passes ?? []).map(({ program }) => ({
    module: program.module,
    artifact: assets.shaderRegistry.materialArtifact(program.module),
  }));
  const specializations = (selections ?? []).map(({ specializationKey }) => ({
    key: specializationKey,
    artifact: assets.getMaterialArtifact(specializationKey),
  }));
  frozenSkinMaterialOwners.set(
    snapshot,
    (current) =>
      current === assets &&
      current.getMaterialProjectionForPayload(material) === projection &&
      programs.every(
        ({ module, artifact }) => current.shaderRegistry.materialArtifact(module) === artifact,
      ) &&
      specializations.every(({ key, artifact }) => current.getMaterialArtifact(key) === artifact),
  );
}
function frozenSkinMaterialSnapshotCurrent(
  snapshot: MaterialSnapshot,
  assets: AssetRegistry | undefined | null,
): boolean {
  try {
    return assets != null && frozenSkinMaterialOwners.get(snapshot)?.(assets) === true;
  } catch {
    // Re-enter the original resolver, which owns the material diagnostic.
    return false;
  }
}

function materialProgramSelectionRequiresSkin(selection: {
  readonly abi?: {
    readonly skinPaletteAddress?: unknown;
    readonly vertexInputs?: readonly { readonly semantic?: unknown }[];
  };
}): boolean {
  if (selection.abi?.skinPaletteAddress !== undefined) return true;
  const semantics = new Set((selection.abi?.vertexInputs ?? []).map((input) => input.semantic));
  return semantics.has('skinIndex') && semantics.has('skinWeight');
}

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
  pipelineState?: ExtractPipelineSurface | null,
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
      readonly meshHandle: Handle<'MeshAsset', 'shared'>;
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

  // ── D-2: frame-level side effects live here ────────────────────────────
  //
  // resetForFrame is called exactly once per frame, at the extractFrames
  // entry. The skinPaletteAllocator cursor is reset before each per-world
  // extract runs, so sequential per-world allocation yields non-overlapping
  // palette slices (AC-08).
  const skinPaletteAllocator = pipelineState?.skinPaletteAllocator ?? null;
  // A partial request is still normalized to the producer's full renderable
  // query, but it is not a full allocator reconciliation.  beginFrame/endFrame
  // mark every persistent identity not visited by this selected subset as
  // detached; doing that here would release untouched palettes.  Only the
  // explicit full request is allowed to reconcile the identity set.
  const reconcileSkinFrame = renderableRequest === 'full';
  if (skinPaletteAllocator !== null && reconcileSkinFrame) {
    skinPaletteAllocator.beginFrame();
    skinPaletteAllocator.resetForFrame();
  }

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
    const skinComponent = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
    try {
      if (skinPaletteAllocator !== null && partialEntitiesByWorld !== undefined) {
        for (const entityKey of partialEntitiesByWorld[wi] ?? []) {
          if (!world.hasComponent(entityKey as EntityHandle, skinComponent)) {
            skinPaletteAllocator.releasePersistentSlice(skinPaletteIdentity(world, entityKey));
          }
        }
      }
      const isCameraOwner = wi === cameraOwner;
      const cameraOwnerFrame = framesByWorld.get(cameraOwner);
      const prepared = prepareExtractContext(world, {
        ...(assets !== undefined ? { assets } : {}),
        ...(pipelineState !== undefined ? { pipelineState } : {}),
        resourceOwnerFog: wi === resourceOwner ? resourceOwnerFog : null,
        ...(materialSnapshotCachesByWorld === undefined
          ? {}
          : {
              materialSnapshotCache:
                materialSnapshotCachesByWorld.get(world) ??
                (() => {
                  const cache: MaterialSnapshotCache = new Map();
                  materialSnapshotCachesByWorld.set(world, cache);
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

  // Reconcile persistent palette identities from the extracted producer
  // projection. Identities absent after a detach are fence-retired by the
  // allocator; surviving identities keep their stable slices.
  if (skinPaletteAllocator !== null && reconcileSkinFrame) {
    skinPaletteAllocator.endFrame();
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
  const shadowCasterEntityKeys = new Set<number>();
  const shadowCasterDrawKeys = new Set<string>();
  const shadowCasterMembership = new Map<string, ShadowCasterMembership>();
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
    for (const key of f.shadowCasterEntityKeys) shadowCasterEntityKeys.add(key);
    for (const key of f.shadowCasterDrawKeys) shadowCasterDrawKeys.add(key);
    for (const membership of f.shadowCasterMembership ?? []) {
      const rebased = { ...membership, renderableIndex: membership.renderableIndex + base };
      const key = gpuDrivenShadowDrawKey(
        rebased.worldEntity,
        rebased.materialHandle,
        rebased.drawItemIndex,
        rebased.passIndex,
      );
      shadowCasterMembership.set(key, rebased);
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
    const mergeCameraData: CsmCameraData | undefined =
      mergeCam !== undefined
        ? {
            world: mergeCam.world,
            fov: mergeCam.fov,
            aspect: mergeCam.aspect,
            near: mergeCam.near,
            far: mergeCam.far,
            projection: mergeCam.projection,
            orthoLeft: mergeCam.orthoLeft,
            orthoRight: mergeCam.orthoRight,
            orthoBottom: mergeCam.orthoBottom,
            orthoTop: mergeCam.orthoTop,
            ...(mergeCam.eye === undefined ? {} : { eye: mergeCam.eye }),
          }
        : undefined;
    const csm = computeDirectionalCsm(
      directionalCsmDirection,
      directionalCsmConfig,
      mergeCameraData,
    );
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
    numericSharedRefProbes: 0,
    sourceCacheHits: 0,
    sourceCacheMisses: 0,
    producerRoutes: {},
  };
  for (const frame of succeededFrames) {
    const stats = frame.materialTextureSources;
    if (stats === undefined) continue;
    materialTextureSources.sourceFieldsVisited += stats.sourceFieldsVisited;
    materialTextureSources.numericSharedRefProbes += stats.numericSharedRefProbes;
    materialTextureSources.sourceCacheHits += stats.sourceCacheHits;
    materialTextureSources.sourceCacheMisses += stats.sourceCacheMisses;
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
    shadowCasterEntityKeys,
    shadowCasterDrawKeys,
    ...(shadowCasterMembership.size === 0
      ? {}
      : { shadowCasterMembership: [...shadowCasterMembership.values()] }),
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
    assets,
    pipelineState,
    materialSnapshotCache: persistentMaterialSnapshotCache,
    cull: cullMode,
    resourceOwnerFog,
    getMaterialShaderArtifact,
    instanceCollections,
    renderableEntities,
    retainHidden,
  } = context;
  const skinComponent = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  // Environment reads are owned by the retained resource projection and are
  // established at the frame boundary; record never revisits World state.
  const fog =
    resourceOwnerFog === undefined ? selectFogFrame(world) : (resourceOwnerFog ?? undefined);
  const fogFailure = fogState(world).failure;
  const visibility = context.visibility.hasAnyHiddenIntent ? context.visibility : undefined;
  const skinPaletteAllocator = pipelineState?.skinPaletteAllocator ?? null;
  const materialTextureSourceStats: MaterialTextureSourceStats = {
    sourceFieldsVisited: 0,
    numericSharedRefProbes: 0,
    sourceCacheHits: 0,
    sourceCacheMisses: 0,
    producerRoutes: {},
  };
  const materialTextureSourceCache: MaterialTextureSourceCache = new Map();

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
      selections?.some(materialProgramSelectionRequiresSkin) === true ||
      isStandardPbrSkinMaterialShader(shader);
    if (hasSkin && skeleton !== undefined && skeleton !== 0 && !wantsSkin) {
      worldInternal._routeError(new SkinMaterialMismatchError(entity, shader), {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (skin-material-mismatch)',
      });
      return false;
    }
    if (wantsSkin && mesh !== undefined && mesh !== 0) {
      const current = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(mesh));
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
  const shadowMembershipEntries: ShadowCasterMembership[] = [];
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
  const flushPendingDispatch = (pending: readonly DispatchEntry[]): void => {
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
    const channelsError = validateLightingChannels(lightingChannels);
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
        const meshHandle = toShared<'MeshAsset'>(fAssetHandleVal);
        const meshRes =
          preparationMesh === undefined
            ? resolveAssetHandle<Asset>(world, meshHandle)
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
            ensureGlyphMeshMaterialSlots(world, meshHandle);
          }
          const resolvedBindings = resolveMeshMaterialBindings(meshAsset, materialsView ?? [], {
            isValidOverride(handle) {
              const resolved = resolveAssetHandle(world, toShared<'MaterialAsset'>(handle));
              return resolved.ok && resolved.value.kind === 'material';
            },
            resolveMeshDefault(defaultGuid) {
              const guidText = AssetGuid.format(defaultGuid);
              if (assets.lookup<Asset>(guidText)?.kind !== 'material') return undefined;
              return internSharedRefFromGuid(world, assets, guidText, 'MaterialAsset') as
                | number
                | undefined;
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
            const materialGuid = AssetGuid.format(resolvedBindings.defaultMaterial);
            worldInternal._routeError(
              new AssetError({
                code: 'load-failed',
                expected: `MeshAsset materialSlots[${resolvedBindings.slotIndex}] default ${materialGuid} is ready and a MaterialAsset`,
                hint: `loadByGuid(meshGuid) must recursively load the declared default material; mesh=${guid}, slot=${resolvedBindings.slotIndex}, material=${materialGuid}`,
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
      const geometryPersistentCache = hasSkin
        ? skinMaterialCache(persistentMaterialSnapshotCache, vertexColorAvailable)
        : geometry === 'mesh' && !vertexColorAvailable
          ? persistentMaterialSnapshotCache
          : undefined;
      // Secondary materials use the existing plain resolver. Its entries must
      // never become primary skin admission records on another entity.
      let secondaryMaterialCache = geometryMaterialCache;
      if (hasSkin && materialHandles.length > 1) {
        const secondaryKey = `${cacheKey}:secondary`;
        let secondary = materialCaches.get(secondaryKey);
        if (secondary === undefined) {
          secondary = new Map();
          materialCaches.set(secondaryKey, secondary);
        }
        secondaryMaterialCache = secondary;
      }
      const secondaryPersistentCache = hasSkin ? undefined : geometryPersistentCache;
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

      const cachedCandidate =
        handleRaw !== 0 && !hasSpriteRegionOverride
          ? geometryMaterialCache.get(handleRaw)
          : undefined;
      const cachedMaterial =
        cachedCandidate !== undefined &&
        (!hasSkin || frozenSkinMaterialSnapshotCurrent(cachedCandidate.snapshot, assets))
          ? cachedCandidate
          : undefined;

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
            cachedMaterial.passes,
            entity,
            handleRaw,
            renderables.length,
            layerVal,
            materialSnap.paramSnapshot,
            0,
            materialSnap.materialProgramKeys,
          );
        }
      } else if (handleRaw === 0 || assets === undefined || assets === null) {
        // case B: missing-spec sentinel -> mid-grey defaultMaterialSnapshot.
        materialSnap = defaultMaterialSnapshot(handleRaw);
      } else {
        const tagged = toShared<'MaterialAsset'>(handleRaw);
        const stableCandidate = !hasSpriteRegionOverride
          ? readStablePersistentMaterialSnapshot(geometryPersistentCache, handleRaw, assets, world)
          : undefined;
        const stablePersistentCached =
          stableCandidate !== undefined &&
          (!hasSkin || frozenSkinMaterialSnapshotCurrent(stableCandidate.snapshot, assets))
            ? stableCandidate
            : undefined;
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
              stablePersistentCached.passes,
              entity,
              handleRaw,
              renderables.length,
              layerVal,
              materialSnap.paramSnapshot,
              0,
              materialSnap.materialProgramKeys,
            );
          }
        } else {
          const res = resolveAssetHandle(world, tagged);
          if (!res.ok) {
            if (isRenderable) {
              const rhiErr = new RhiError({
                code: 'asset-not-registered',
                expected: 'MeshRenderer.material in AssetRegistry',
                hint: 'catalog the material via assetRegistry.catalog(guid, asset) + world.allocSharedRef before spawn, or remove the material field to fall back to default',
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
            // Program selection belongs to the shared source; RuntimeMaterialValue
            // only projects the numeric parameter content resolved below.
            const source = world.sharedRefs.resolve<string, Asset>(tagged);
            const programOwner =
              source.ok && source.value.kind === 'material' ? source.value : asset;
            // feat-20260529 M3 / w11: material parent chain inheritance via
            // read-through _materialWalk accessor (plan-strategy D-6).
            // The old direct asset.passes / asset.values read never
            // walked the parent chain, causing broken-inheritance (root cause).
            const resolvedResult = walkMaterialPassesOverSharedRefs(world, tagged, assets);
            if (!resolvedResult.ok) {
              // AC-09 / S-7 / q8=A: passes-empty or cycle must fire structured
              // error through _routeError (same routing as asset-not-registered
              // branch above). Silent continue is forbidden because it produces
              // a black screen indistinguishable from a content bug.
              const err = resolvedResult.error;
              switch (err.code) {
                case 'material-parent-not-found':
                case 'material-no-effective-pass':
                case 'material-value-unknown':
                case 'material-value-type-mismatch':
                case 'material-contract-program-mismatch':
                  worldInternal._routeError(err, {
                    severity: Severity.Error,
                    systemName: `RenderSystem.extract (${err.code})`,
                  });
                  break;
                case 'material-circular-inheritance':
                  worldInternal._routeError(err, {
                    severity: Severity.Error,
                    systemName: 'RenderSystem.extract (material-circular-inheritance)',
                  });
                  break;
                default:
                  // Exhaustive guard: unhandled error codes from _materialWalk
                  // surface an internal assertion to avoid silent continuation.
                  worldInternal._routeError(err, {
                    severity: Severity.Error,
                    systemName: `RenderSystem.extract (_materialWalk: ${err.code})`,
                  });
              }
              continue;
            }
            const resolved = resolvedResult.value;
            const allPasses = resolved.passes;
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
                    skinnedSelections?.some(materialProgramSelectionRequiresSkin) === true &&
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
            const materialProgramKeys =
              materialProgramSelections === undefined
                ? undefined
                : Object.fromEntries(
                    materialProgramSelections.map(({ pass, specializationKey }) => [
                      pass,
                      specializationKey,
                    ]),
                  );
            const materialSceneIndexProgramKeys = materialSceneIndexProgramKeysForMaterial(
              programOwner,
              assets,
              materialContext,
              vertexColorAvailable,
            );
            const materialSurfacePrograms = materialSurfaceProgramsForMaterial(
              programOwner,
              assets,
              materialContext,
              resolved,
            );
            const firstPassShader = runtimeMaterialShaderIdForMaterial(
              allPasses,
              materialProgramKeys,
            );
            const pv = materialValuesToLinearRuntime(
              resolved.values,
              materialColorParameterSchema(resolved.parameters ?? [], firstPassShader, assets),
              resolved.colorSpace,
            ) as Readonly<Record<string, unknown>>;

            const valueSnapshot = materialValueSnapshot(pv);
            const paramSnap = valueSnapshot.paramSnapshot;

            const materialParamSchema = materialParamSchemaForMaterial(
              resolved.parameters ?? [],
              firstPassShader,
              allPasses,
              assets,
            );
            // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
            // bidirectional Skin <-> pbr-skin material fail-fast at extract.
            // Skin component without a forgeax::pbr-skin first-pass material
            // would draw with a non-skin shader against the 18-float vertex
            // buffer (joints/weights bytes interpreted as garbage). Conversely
            // a forgeax::pbr-skin material against a 12-float (unskinned) mesh
            // would have @location(4)/@location(5) read uninitialized memory.
            // Both cases route through `_routeError` + `continue` so a single
            // misconfigured entity does NOT abort the whole frame's draw list
            // (charter P3 explicit failure + plan-decisions D-5 over `return err`).
            if (
              !admitSkinMaterial(
                entity,
                hasSkin,
                skinSkeletonView,
                firstPassShader,
                materialProgramSelections,
                fAssetHandleVal,
              )
            )
              continue;
            // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12 (D-3):
            // sprite materials now flow through the same generic paramSchema-
            // driven extract path PBR / unlit use. The narrow `forgeax::sprite`
            // exception block below covers exactly 2 plan-authorised cases:
            //   1. SpriteRegionOverride per-entity region displacement (Q4=a)
            //   2. flipX / flipY -> region fold (plan-strategy D-8)
            // No legacy values field-name shim; demos and SpriteParamValues
            // are UBO-aligned (no `texture` / `baseColor` / `pivot` / `slices`
            // / `sliceMode` keys reaching this code path). AGENTS.md §Change
            // stance: "no shim layer, no v1/v2 dual-path".
            //
            // feat-20260624 M1' / t6: `'forgeax::sprite-lit'` walks the same
            // sprite-family vertex path (VsOut byte-identical, paramSchema
            // mirror) so the SAME 2 folds apply — extending `isSprite` to
            // cover both shader ids keeps the narrowing-point count at 1
            // (plan-strategy §1.6 + D-1: mirror sprite, no new branch).
            const firstPassModule = runtimeMaterialShaderIdForMaterial(allPasses, undefined);
            const isSprite =
              firstPassModule === 'forgeax::sprite' || firstPassModule === 'forgeax::sprite-lit';

            // feat-20260613-material-paramschema-driven-binding M4 / w23
            // (D-5 graceful): paramSchema-driven texture-field validation.
            // For each handle-shaped paramValue (typeof === 'number'),
            // verify it actually points at a registered texture asset
            // when the field is declared as a texture in the shader's
            // paramSchema; mis-typed handles (e.g. a scalar f32 stored as
            // int 0 the M4 / w22 graceful fallback resolved to a wrong
            // sub-asset) are dropped here so the record stage falls back
            // to MISSING_TEXTURE_HANDLE (default white) without raising.
            const validateTextureHandle = (
              fieldName: string,
              raw: unknown,
            ): Handle<'TextureAsset', 'shared'> | undefined => {
              // feat-20260614 M8 (D-19): a string value is an embedded texture
              // GUID; resolve it to a column handle via catalog + allocSharedRef
              // before validation. A number is an already-minted column handle.
              let handle: Handle<'TextureAsset', 'shared'>;
              const textureRef = materialTextureRef(raw);
              const textureGuid = assetReferenceText(textureRef);
              if (textureGuid !== undefined) {
                if (assets === null || assets === undefined) return undefined;
                // M4: intern so the GUID mints one stable handle per World
                // instead of a fresh slot every frame (GPU residency relies on
                // a stable handleSlot). onLastRelease -> gpuStore.evictTexture.
                const interned = internSharedRefFromGuid(
                  world,
                  assets,
                  textureGuid,
                  'TextureAsset',
                );
                if (interned === undefined) return undefined;
                handle = interned;
              } else if (typeof textureRef === 'number') {
                handle = toShared<'TextureAsset'>(textureRef);
              } else {
                return undefined;
              }
              if (assets === null || assets === undefined) return handle;
              const declaredFields = materialTextureFields(
                firstPassShader,
                materialParamSchema.length > 0
                  ? derive(materialParamSchema).textureFieldNames
                  : firstPassShader !== undefined
                    ? assets.materialShaderTextureFieldNames(firstPassShader)
                    : undefined,
              );
              // Shader not registered (R-4 cross-worktree path) -> trust the
              // raw handle and let the record stage / GPU layer surface each
              // mismatch via MISSING_TEXTURE_HANDLE.
              if (declaredFields === undefined) return handle;
              // Field is not declared as a texture by the shader -> the
              // loader's "try every int" fallback misclassified a scalar;
              // drop the slot so the record stage uses the default white.
              if (
                !declaredFields.has(fieldName) &&
                !isEngineInjectedTextureField(firstPassShader, fieldName)
              ) {
                return undefined;
              }
              // Field declared as texture: verify the handle's asset kind.
              const assetRes = resolveAssetHandle(world, handle);
              if (!assetRes.ok) return undefined;
              const kind = (assetRes.value as { kind?: string }).kind;
              if (kind !== 'texture') return undefined;
              return handle;
            };
            // feat-20260614 M8 (D-19): resolve a sampler / texture paramValue
            // that may be an embedded GUID string (catalog + allocSharedRef) or
            // an already-minted column handle (number passthrough).
            const resolveParamHandle = <B extends string>(
              raw: unknown,
              brand: B,
            ): Handle<B, 'shared'> | undefined => {
              const value = materialTextureRef(raw);
              if (typeof value === 'number') return toShared<B>(value);
              const guid = assetReferenceText(value);
              if (guid !== undefined) {
                if (assets === null || assets === undefined) return undefined;
                // M4: intern the GUID -> column-handle resolution (one stable
                // handle per (world, guid, brand), reused across frames).
                return internSharedRefFromGuid(world, assets, guid, brand);
              }
              return undefined;
            };
            // feat-20260621-learn-render-5-5-parallax M2 / w7 (D-3): iterate the
            // shader's derive(paramSchema).textureFieldNames SSOT so the Nth
            // user-region texture (e.g. parallax heightTexture) is validated +
            // carried, replacing the hardcoded 3-field list. validateTextureHandle
            // already drops fields a shader doesn't declare as a texture.
            const userRegionFields =
              materialTextureFields(
                firstPassShader,
                materialParamSchema.length > 0
                  ? derive(materialParamSchema).textureFieldNames
                  : firstPassShader !== undefined && assets !== null && assets !== undefined
                    ? assets.materialShaderTextureFieldNames(firstPassShader)
                    : undefined,
              ) ?? BUILTIN_MATERIAL_TEXTURE_FIELDS;
            const authoredTextureFields = collectAuthoredMaterialTextureFields(
              resolved.values,
              firstPassShader,
              materialParamSchema.length > 0 ? materialParamSchema : undefined,
              assets,
            );
            const authoredSamplerFields = collectAuthoredMaterialSamplerFields(
              resolved.values,
              authoredTextureFields,
            );
            const textureHandles = new Map<string, Handle<'TextureAsset', 'shared'>>();
            const videoTextureFields = new Map<string, Handle<'VideoAsset', 'shared'>>();
            for (const field of userRegionFields) {
              // D-5: a video-kind paramValue routes to the transient path
              // (videoTextureFields), NOT validateTextureHandle (which drops
              // kind!=='texture', the R-7 silent-fail path). Static fields fall
              // through to validateTextureHandle unchanged.
              const videoHandle =
                assets !== null && assets !== undefined
                  ? resolveVideoFieldHandle(pv[field], world, assets)
                  : undefined;
              if (videoHandle !== undefined) {
                videoTextureFields.set(field, videoHandle);
                continue;
              }
              const handle = validateTextureHandle(field, pv[field]);
              if (handle !== undefined) textureHandles.set(field, handle);
            }
            const baseColorTextureHandle = textureHandles.get('baseColorTexture');
            const metallicRoughnessTextureHandle = textureHandles.get('metallicRoughnessTexture');
            const normalTextureHandle = textureHandles.get('normalTexture');
            const samplerHandles = collectMaterialTextureSamplers(pv, (value) =>
              resolveParamHandle(materialTextureRef(value), 'SamplerAsset'),
            );
            const emissiveTextureHandle = validateTextureHandle(
              'emissiveTexture',
              pv.emissiveTexture,
            );
            const occlusionTextureHandle = validateTextureHandle(
              'occlusionTexture',
              pv.occlusionTexture,
            );
            const textureCoordinates = collectMaterialTextureCoordinates(pv);
            const textureSources = collectMaterialTextureSources(
              pv,
              world,
              materialTextureSourceFields(
                materialParamSchema.length > 0 ? materialParamSchema : undefined,
              ),
              materialTextureSourceStats,
              materialTextureSourceCache,
            );

            // feat-20260625 M2 / w6: first-pass transparency flag folds into
            // MaterialSnapshot.transparent so the record stage can drive the
            // LDR split + premultiplied-alpha blend decision without
            // re-reading passes[]. feat-20260626-collapse M2: derive from
            // `passes[0].renderState.blend !== undefined` (blend presence is
            // the SSOT after MaterialPass.transparent was dropped).
            // Result is plain boolean (always defined here) — written as-is
            // into the snapshot (`boolean | undefined` field, see L759).
            const firstPassTransparent: boolean = allPasses[0]?.renderState?.blend !== undefined;

            // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12 (D-8):
            // narrow `forgeax::sprite` extract block --- folds the legacy user
            // values format (flipX / flipY / slices / sliceMode + free
            // region / pivot) into the UBO-aligned paramSnapshot vec4 fields
            // (region / pivotAndSize / slicesAndMode + colorTint). Also folds
            // per-entity SpriteRegionOverride (Q4=a). After this block the
            // generic else branch picks up the snapshot via the same writer
            // path PBR / unlit use; no more shadingModel='sprite' arm, no
            // spriteFields POD (AC-02 / AC-07: extract has exactly 2 hard
            // `forgeax::sprite` checks --- this fold + the slices mesh swap on
            // the record side).
            if (isSprite) {
              // SpriteRegionOverride: per-entity per-frame region displacement.
              let overrideRegion: readonly [number, number, number, number] | undefined;
              if (hasSpriteRegionOverride) {
                const overrideView = worldInternal._getArrayView(
                  entity,
                  SpriteRegionOverride,
                  'region',
                ) as Float32Array | undefined;
                if (overrideView !== undefined && overrideView.length >= 4) {
                  overrideRegion = [
                    overrideView[0] ?? 0,
                    overrideView[1] ?? 0,
                    overrideView[2] ?? 1,
                    overrideView[3] ?? 1,
                  ];
                }
              }
              // Region resolution priority: SpriteRegionOverride > paramSnapshot.
              // region (UBO-aligned user input) > [0,0,1,1] identity.
              const regionPv = paramSnap.region as readonly number[] | undefined;
              let regionX = overrideRegion?.[0] ?? regionPv?.[0] ?? 0;
              let regionY = overrideRegion?.[1] ?? regionPv?.[1] ?? 0;
              let regionZ = overrideRegion?.[2] ?? regionPv?.[2] ?? 1;
              let regionW = overrideRegion?.[3] ?? regionPv?.[3] ?? 1;
              // flipX / flipY fold into region (D-8): the shader does
              // `uv * region.zw + region.xy`, so flipping along U is a sign
              // negation of region.z plus an origin offset.
              const flipXPv = typeof pv.flipX === 'number' ? pv.flipX : 0;
              const flipYPv = typeof pv.flipY === 'number' ? pv.flipY : 0;
              if (flipXPv !== 0) {
                regionX += regionZ;
                regionZ = -regionZ;
              }
              if (flipYPv !== 0) {
                regionY += regionW;
                regionW = -regionW;
              }
              paramSnap.region = [regionX, regionY, regionZ, regionW];
              // Guard: slicesAndMode must be present and zero for non-9-slice
              // sprites so the record-stage UBO writer (applyParamSnapshotToUbo)
              // writes [0,0,0,0] at offset 48 instead of leaving the
              // buildPbrMaterialUboPayload PBR baseline (e.g. occlusionStrength=1
              // at that slot). A non-zero slicesAndMode trips `useSlices=true`
              // in sprite.wgsl, which degenerates HANDLE_QUAD geometry → invisible.
              if (!('slicesAndMode' in paramSnap)) {
                (paramSnap as Record<string, unknown>).slicesAndMode = [0, 0, 0, 0];
              }
            }

            // Generic materialShaderId snapshot --- sprite included now flows
            // through this single branch (plan-strategy D-3 / AC-01 / AC-02 /
            // AC-07). The sprite block above only writes paramSnap.region (D-8
            // SpriteRegionOverride + flip fold); the rest of the UBO is filled
            // by the same paramSchema-driven path PBR / unlit use.
            materialSnap = {
              ...valueSnapshot,
              surfaceModel: materialSurfaceModel(allPasses, resolved.surface?.model),
              deferredPass: allPasses.some(
                (pass) =>
                  String(
                    (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ??
                      pass.name,
                  ) === 'Deferred',
              ),
              materialShaderId: firstPassShader,
              materialProgramKeys,
              materialPublication: materialPublicationForMaterial(
                programOwner,
                assets,
                materialProgramSelections,
                vertexColorAvailable,
              ),
              materialSceneIndexProgramKeys,
              materialSurfacePrograms,
              materialHandle: handleRaw,
              renderState: pipelineRenderState(allPasses[0]?.renderState),
              ...(materialParamSchema.length > 0 && { materialParamSchema }),
              standardTextureMask: materialStandardTextureMask(
                resolved.parameters,
                firstPassShader,
                pv,
                { textureHandles, samplerHandles, textureCoordinates },
              ),
              ...(textureCoordinates.size > 0 && { textureCoordinates }),
              ...(authoredTextureFields === undefined ? {} : { authoredTextureFields }),
              ...(samplerHandles.size > 0 && { samplerHandles }),
              ...(authoredSamplerFields === undefined ? {} : { authoredSamplerFields }),
              ...(textureHandles.size > 0 && { textureHandles }),
              ...(textureSources.size > 0 && { textureSources }),
              ...(videoTextureFields.size > 0 && { videoTextureFields }),
              ...(baseColorTextureHandle !== undefined && {
                baseColorTexture: baseColorTextureHandle,
              }),
              ...(metallicRoughnessTextureHandle !== undefined && {
                metallicRoughnessTexture: metallicRoughnessTextureHandle,
              }),
              ...(normalTextureHandle !== undefined && { normalTexture: normalTextureHandle }),
              ...(emissiveTextureHandle !== undefined && {
                emissiveTexture: emissiveTextureHandle,
              }),
              ...(occlusionTextureHandle !== undefined && {
                occlusionTexture: occlusionTextureHandle,
              }),
              transparent: firstPassTransparent,
            };

            if (!hasSpriteRegionOverride && (!hasSkin || frozenSkinMaterial(asset))) {
              const stored = storeMaterialSnapshot(
                geometryMaterialCache,
                handleRaw,
                materialSnap,
                allPasses,
                asset,
                assets,
                world,
                materialProgramSelections,
              );
              materialSnap = stored.snapshot;
              if (hasSkin)
                rememberFrozenSkinMaterial(materialSnap, asset, assets, materialProgramSelections);
              if (stored.crossFrameSafe) geometryPersistentCache?.set(handleRaw, stored);
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
                paramSnap,
                0,
                materialProgramKeys,
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
          tags: shadowCasterTags,
          renderState: undefined,
          defines: undefined,
          vertexEntry: 'vs_main',
          fragmentEntry: undefined,
          materialShaderId: 'forgeax::default-shadow-caster',
          paramSnapshot: {},
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
          {},
          1,
        );
      }

      if (isRenderable) {
        // feat-20260612 M2 / m2-6: Skin + Instances coexistence + per-joint
        // dangling fail-fast + real palette slice allocation. Replaces the
        // T-21 placeholder ({0,0} discriminator-only sentinel) with full
        // resolve / validate / write chain (D-9 reset already fired at
        // extractFrame entry; per-entity allocate + writeJointPalette here).
        let skinSlice: SkinPaletteReceipt | undefined;
        let skinPose: SkinPose | undefined;
        let posedCapsules: Float32Array | undefined;
        let skeletonHasCapsules = false;
        const skinIdentity = hasSkin ? skinPaletteIdentity(world, entity) : undefined;
        const releaseSkinIdentity = (): void => {
          if (skinIdentity !== undefined) {
            skinPaletteAllocator?.releasePersistentSlice(skinIdentity);
          }
        };
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
              releaseSkinIdentity();
              continue;
            }
            // (a) Resolve skeleton asset; on failure -> skeleton-resolve-failed.
            const skeletonHandle = toShared<'SkeletonAsset'>(skeletonHandleRaw);
            const skeletonRes = resolveAssetHandle<SkeletonAsset>(world, skeletonHandle);
            if (!skeletonRes.ok || skeletonRes.value.kind !== 'skeleton') {
              worldInternal._routeError(new SkeletonResolveFailedError(entity, skeletonHandleRaw), {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (skeleton-resolve-failed)',
              });
              releaseSkinIdentity();
              continue;
            }
            const skeleton = skeletonRes.value;
            // (b) Reuse the Skin row already read for its skeleton handle;
            // the old path repeated a second whole-row world.get here.
            const skinJoints = skin?.joints;
            if (skinJoints === undefined) {
              releaseSkinIdentity();
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
              releaseSkinIdentity();
              continue;
            }
            // (c) Resolve only each joint's GlobalTransform.world column. The
            // transient view is consumed before a structural mutation and
            // therefore preserves the same dangling-joint behavior without
            // constructing every other Transform field.
            // Build mat4 list eagerly so write happens once per entity (no
            // half-written slice on dangling).
            const jointWorlds = new Array<Mat4>(skeleton.jointCount);
            // One owned backing store survives publication as one clone, rather
            // than one ArrayBuffer allocation and clone for every joint.
            const jointWorldStorage = new Float32Array(skeleton.jointCount * 16);
            let jointDangling = -1;
            for (let jIdx = 0; jIdx < skeleton.jointCount; jIdx++) {
              const jointEntityRaw = skinJoints[jIdx] ?? 0;
              const jointEntity = jointEntityRaw as EntityHandle;
              const jointWorld = readPresentationWorldMatrix(world, jointEntity);
              if (jointWorld === undefined) {
                jointDangling = jIdx;
                break;
              }
              // The allocator consumes the canonical Mat4 brand. Copy the
              // column view into that owner-created value so the ECS storage
              // view never crosses the math brand boundary by assertion.
              const jointWorldMat = mat4.view(jointWorldStorage, jIdx);
              jointWorldMat.set(jointWorld);
              jointWorlds[jIdx] = jointWorldMat;
            }
            if (jointDangling >= 0) {
              worldInternal._routeError(new JointEntityDanglingError(entity, jointDangling), {
                severity: Severity.Error,
                systemName: 'RenderSystem.extract (joint-entity-dangling)',
              });
              releaseSkinIdentity();
              continue;
            }
            // (d) Slice the IBM flat Float32Array into per-joint Float32Arrays.
            //     skeleton.inverseBindMatrices length === jointCount * 16.
            const ibmFlat = skeleton.inverseBindMatrices;
            const ibms: Float32Array[] = new Array<Float32Array>(skeleton.jointCount);
            for (let jIdx = 0; jIdx < skeleton.jointCount; jIdx++) {
              ibms[jIdx] = ibmFlat.subarray(jIdx * 16, jIdx * 16 + 16);
            }
            if (capsuleShadowRequested && skeleton.shadowCapsules !== undefined) {
              skeletonHasCapsules = true;
              posedCapsules = poseShadowCapsules(skeleton.shadowCapsules, ibms, jointWorlds);
            }
            // (e) Retain current pose facts. Bounds and palette allocation
            // follow mesh resolution so the cull and draw share this pose.
            skinPose = {
              identity: skinPaletteIdentity(world, entity),
              generation: ((skeletonHandleRaw >>> 0) ^ skeleton.jointCount) >>> 0,
              jointCount: skeleton.jointCount,
              inverseBindMatrices: ibms,
              jointWorlds,
            };
          }
        }

        // A pbr-skin PSO requires the complete three-binding group(2) skin
        // projection. Do not publish a renderable or its staged dispatch when
        // palette extraction was unavailable; the record stage must never
        // reinterpret a skinned vertex stream through an ordinary mesh group.
        if (skinSlice === undefined && skinPose === undefined && hasSkin) {
          releaseSkinIdentity();
          if (
            materialSnap.materialShaderId === 'forgeax::pbr-skin' ||
            materialProgramSelections?.some(materialProgramSelectionRequiresSkin) === true
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
          releaseSkinIdentity();
          continue;
        }
        const worldMat = new Float32Array(worldView);
        const transformSnap: TransformSnapshot = { world: worldMat };
        // feat-20260608 M5 amend / w11-a: per-submesh `materials[]` array
        // aligned 1-1 with `MeshAsset.submeshes[]`. materials[0] === the
        // representative entity-level snapshot already built; materials[i>=1]
        // are resolved via `resolveMaterialSnapshot` (a non-sprite, single-
        // pass-equivalent resolver — sprite per-submesh is OOS-1). When the
        // entity has no materialsView (case-B sentinel) the array is a single
        // mid-grey default mirroring the legacy single-material path so the
        // record stage's per-submesh UBO upload loop trivially writes one
        // slot, no special branch.
        const materialsArr: MaterialSnapshot[] = [materialSnap];
        if (assets !== undefined && assets !== null) {
          for (let mi = 1; mi < materialHandles.length; mi++) {
            const subHandle = materialHandles[mi] ?? 0;
            const subCache = secondaryMaterialCache;
            const cachedSubmaterial = subCache.get(subHandle);
            materialsArr.push(
              cachedSubmaterial?.snapshot ??
                resolveMaterialSnapshot(
                  subHandle,
                  world,
                  assets,
                  subCache,
                  secondaryPersistentCache,
                  geometryMaterialContext,
                  materialTextureSourceStats,
                  materialTextureSourceCache,
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
              secondaryMaterialCache.get(subHandle) ??
              readPersistentMaterialSnapshot(secondaryPersistentCache, subHandle, assets, world);
            appendMaterialDispatchEntries(
              pendingDispatch,
              subEntry?.passes ?? (subHandle === 0 ? [DEFAULT_FORWARD_PASS] : []),
              entity,
              subHandle,
              renderables.length,
              layerVal,
              materialsArr[mi]?.paramSnapshot,
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
          // (2) requires sprite shader — the per-instance UV region is
          // consumed by the sprite vertex shader path only (plan-strategy D-4
          // axis on sprite.wgsl). Post-collapse (PR #520): sprite is no longer
          // a `shadingModel` enum member; identification is via the first-pass
          // `materialShaderId === 'forgeax::sprite'` (OOS-1 path retained).
          //
          // feat-20260624 M1' / t6: `'forgeax::sprite-lit'` also walks the same
          // per-instance UV region vertex path (VsOut byte-identical, paramSchema
          // mirror); accept either shader id.
          // Cooked materials were admitted by the exact sprite-instances
          // context above. Their runtime ID is an artifact key, not a module.
          if (
            materialSnap.materialProgramKeys === undefined &&
            materialSnap.materialShaderId !== 'forgeax::sprite' &&
            materialSnap.materialShaderId !== 'forgeax::sprite-lit'
          ) {
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
              ? resolveAssetHandle(world, toShared<'MeshAsset'>(assetHandleRaw))
              : ok(preparationMesh.mesh);
          if (meshRes.ok && meshRes.value.kind === 'mesh') {
            const meshAsset = meshRes.value as MeshAsset;
            lods = meshAsset.lods;
            lodHysteresis = meshAsset.lodHysteresis;
            morph = morphSnapshotFor(meshAsset, morphWeightsView);
            if (skinPose !== undefined) {
              const bounds = skinPosedBounds(
                meshAsset,
                skinPose,
                worldMat,
                skinPosedBoundsCache(world, skinPose.identity),
                world[worldRead].getFieldValue(
                  row.entity,
                  MeshRenderer,
                  'conservativeSkinBounds',
                ) === 1,
              );
              if (bounds !== undefined) skinPose = { ...skinPose, bounds };
            }
            const meshAabb = hasSkin ? skinPose?.bounds : meshAsset.aabb;
            // Morph targets can expand the authored bounds. Keep the
            // specialized lane conservative until a target-aware bounds
            // projection is available; a false-positive draw is preferable
            // to culling a valid deformed vertex.
            if (morph === undefined && isFiniteAabb(meshAabb)) {
              localAabb = new Float32Array(meshAabb);
            }
          }
        }

        if (skinPose !== undefined && skinPaletteAllocator !== null) {
          skinSlice = prepareSkinPalette(skinPose, skinPaletteAllocator);
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
                meshGeneration: assets?.catalogEpoch ?? 0,
                materialHandle: handleRaw,
                materialGeneration: assets?.catalogEpoch ?? 0,
                style: pointsLinesStyle,
                layer: layerVal,
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
          lightingChannels,
          assetHandle: Math.round(fAssetHandle ?? 0),
          transform: transformSnap,
          ...(lods === undefined ? {} : { lods }),
          ...(lodHysteresis === undefined ? {} : { lodHysteresis }),
          ...(localAabb !== undefined ? { localAabb: cullingLocalAabb } : {}),
          material: materialSnap,
          materials: materialsArr,
          materialBindingSources,
          materialBindingDiagnostics,
          worldId: context.worldId,
          entityKey: entity,
          ...(authorVisible ? {} : { authorVisible: false }),
          ...(skinSlice !== undefined ? { skin: skinSlice } : {}),
          ...(skinPose === undefined ? {} : { skinPose }),
          ...(skin?.joints === undefined
            ? {}
            : { skinJointEntities: Array.from(skin.joints, (joint) => Number(joint)) }),
          ...(morph !== undefined ? { morph } : {}),
          ...(instancesSnap !== undefined ? { instances: instancesSnap } : {}),
          ...(spriteInstancesSnap !== undefined ? { spriteInstances: spriteInstancesSnap } : {}),
          ...(pointsLines !== undefined ? { pointsLines } : {}),
        };
        const gpuDrivenDraws =
          skinPose === undefined || skinSlice !== undefined
            ? buildGpuDrivenDraws({
                mesh: gpuDrivenMesh,
                materials: materialsArr,
                fallbackMaterial: materialSnap,
                baseSnapshot: baseRenderable,
                ...(getMaterialShaderArtifact === undefined ? {} : { getMaterialShaderArtifact }),
                ...(lods === undefined
                  ? {}
                  : {
                      lodMeshes: lods.map((lod) => {
                        const lower = assets?.lookup<Asset>(lod.mesh);
                        return lower?.kind === 'mesh' ? lower : undefined;
                      }),
                    }),
              })
            : [];
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
        const localShadowMembershipEntries: ShadowCasterMembership[] = [];
        if (gpuDrivenMesh !== undefined) {
          const worldEntity = worldEntityKey(context.worldId, entity);
          for (const [drawItemIndex, submesh] of gpuDrivenMesh.submeshes.entries()) {
            if (!isTriangleTopology(submesh.topology)) {
              continue;
            }
            const material = materialsArr[submesh.materialSlot] ?? materialSnap;
            const materialHandle = material.materialHandle ?? -1;
            const shadowEntries = pendingDispatch.filter(
              (entry) =>
                entry.tags.LightMode === 'ShadowCaster' && entry.materialHandle === materialHandle,
            );
            const draw = renderable.gpuDrivenDraws?.find(
              (candidate, compactIndex) =>
                gpuDrivenSourceDrawItemIndex(candidate, compactIndex) === drawItemIndex,
            );
            const cpuReason = shadowCasterCpuReason(
              material,
              draw,
              shadowEntries,
              morph,
              skinSlice,
            );
            for (const entry of shadowEntries) {
              const membership: ShadowCasterMembership = {
                worldEntity,
                renderableIndex: renderables.length,
                drawItemIndex,
                materialHandle,
                passIndex: entry.passIndex,
                ...(entry.materialShaderId === undefined
                  ? {}
                  : { materialShaderId: entry.materialShaderId }),
                ...(entry.vertexEntry === undefined ? {} : { vertexEntry: entry.vertexEntry }),
                ...(entry.fragmentEntry === undefined
                  ? {}
                  : { fragmentEntry: entry.fragmentEntry }),
                ...(entry.renderState === undefined ? {} : { renderState: entry.renderState }),
                ...(cpuReason === undefined ? {} : { cpuReason }),
                gpuDrivenEligible: cpuReason === undefined,
              };
              shadowMembershipEntries.push(membership);
              localShadowMembershipEntries.push(membership);
            }
          }
        }
        const shadowCasterPasses = localShadowMembershipEntries.map((membership) => ({
          drawItemIndex: membership.drawItemIndex,
          materialHandle: membership.materialHandle,
          passIndex: membership.passIndex,
          ...(membership.materialShaderId === undefined
            ? {}
            : { materialShaderId: membership.materialShaderId }),
          ...(membership.vertexEntry === undefined ? {} : { vertexEntry: membership.vertexEntry }),
          ...(membership.fragmentEntry === undefined
            ? {}
            : { fragmentEntry: membership.fragmentEntry }),
          ...(membership.renderState === undefined ? {} : { renderState: membership.renderState }),
          ...(membership.cpuReason === undefined ? {} : { cpuReason: membership.cpuReason }),
        }));
        const capsuleShadow: CapsuleShadowSnapshot | undefined = !capsuleShadowRequested
          ? undefined
          : !hasSkin
            ? { status: 'not-skinned' }
            : !skeletonHasCapsules || posedCapsules === undefined
              ? { status: 'no-shadow-capsules' }
              : pendingDispatch.some((entry) => entry.tags.LightMode === 'ShadowCaster')
                ? { status: 'ready', capsules: posedCapsules }
                : { status: 'no-shadow-caster-pass' };
        const renderableWithShadowPasses =
          shadowCasterPasses.length === 0 &&
          capsuleShadow === undefined &&
          !mobilityStatic &&
          !shadowReceiveDisabled
            ? renderable
            : {
                ...renderable,
                ...(shadowCasterPasses.length === 0 ? {} : { shadowCasterPasses }),
                ...(capsuleShadow === undefined ? {} : { capsuleShadow }),
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

  // M3 / w26: sort dispatch entries by queue (ascending, stable sort)
  // per plan-strategy D-3.
  dispatch = sortDispatchByQueue(dispatch);
  const shadowCasterEntityKeys = new Set<number>();
  const shadowCasterDrawKeys = new Set<string>();
  const shadowCasterMembership = new Map<string, ShadowCasterMembership>();
  for (const entry of dispatch) {
    if (entry.tags.LightMode !== 'ShadowCaster') continue;
    const renderable = renderables[entry.renderableIndex];
    if (renderable !== undefined) {
      const worldEntity = worldEntityKey(renderable.worldId, renderable.entityKey);
      shadowCasterEntityKeys.add(worldEntity);
    }
  }
  for (const membership of shadowMembershipEntries) {
    const key = gpuDrivenShadowDrawKey(
      membership.worldEntity,
      membership.materialHandle,
      membership.drawItemIndex,
      membership.passIndex,
    );
    shadowCasterDrawKeys.add(key);
    shadowCasterMembership.set(key, membership);
    shadowCasterEntityKeys.add(membership.worldEntity);
  }

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
    shadowCasterEntityKeys,
    shadowCasterDrawKeys,
    ...(shadowCasterMembership.size === 0
      ? {}
      : { shadowCasterMembership: [...shadowCasterMembership.values()] }),
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
