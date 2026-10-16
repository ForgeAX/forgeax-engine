import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { routeWorldError, SpawnLightInvalidBoundsError } from '@forgeax/engine-ecs/projection';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, readPresentationWorldMatrix, Transform } from '@forgeax/engine-scene';
import type { Handle, IesProfileAsset, TextureAsset } from '@forgeax/engine-types';
import { handleSlot, toShared } from '@forgeax/engine-types';
import { type ExtractedCloudLayer, extractCloudLayer } from '../cloud/extract';
import {
  Atmosphere,
  DirectionalLight,
  LightProbe,
  PointLight,
  PointLightShadow,
  RectAreaLight,
  SkyboxBackground,
  Skylight,
  SpotLight,
} from '../components';
import {
  type DirectionalShadowQuality,
  directionalShadowQualityFromF32,
} from '../components/directional-shadow-filter';
import {
  computeInvRangeSquared,
  degToCos,
  type LightValidationError,
  validateDirectionalLightData,
  validateLightProbeData,
  validateRectAreaLightData,
} from '../components/light-helpers';
import { validateLightingChannels } from '../components/lighting-channels';
import { validatePointLightDecay } from '../components/point-light';
import { selectEnvironment } from '../environment/frame';
import { createLightResourceUnavailable } from '../errors/render';
import type { EnvironmentCandidate, EnvironmentFrame } from '../extract/environment';
import {
  COOKIE_SLICE_CAPACITY,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
} from '../prepare/extended-lighting/resources';
import {
  type LightTextureSource,
  prepareCookieProjection,
} from '../prepare/extended-lighting/spot-modifiers';
import type {
  CsmCameraData,
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  ExtractedFrame,
  ExtractedLights,
  IesProfileSnapshot,
  LightProbeSnapshot,
  PointLightSnapshot,
  PointShadowSnapshot,
  PreparedExtractContext,
  RectAreaDirectLightSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';
import {
  buildPointShadowMatrices,
  buildRectAreaWorldFrame,
  collectCubeCameraSnapshots,
  collectReflectionProbeFacts,
  computeDirectionalCsm,
  type createWorldInternalView,
  extractVolumeSnapshot,
  pssmSplit,
  Severity,
  selectCameraRoles,
} from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';

/** Produces light, camera and atmosphere facts once, before renderable projection. */
export function extractWorldEnvironment(
  world: World,
  context: Pick<PreparedExtractContext, 'assets' | 'cameraEntityKey' | 'worldId' | 'viewExtent'>,
  worldInternal: ReturnType<typeof createWorldInternalView>,
  fog: ExtractedFrame['fog'],
) {
  const { assets } = context;
  const directionalLightQuery = world.query({ read: [DirectionalLight] }).unwrap();

  // feat-20260601 D-3: camera / point / spot light world transforms are read
  // through the single resolved `GlobalTransform.world` mat4 (written by
  // propagateTransforms).
  //
  // Each segment routes through a World-owned Query with explicit read and
  // optional roles. The packed entity handle for `readWorldMat4Copy` /
  // `_getArrayView` reads comes from `row.entity` -- the
  // archetype-graph back-door (`graph.archetypes` / `arch.components.some`) is gone.
  // Plan-decisions K-2 sniffing scheme B (archetype-edge sniff once via
  // `row.get(X) !== undefined`); K-3 invariant preserved (`_getArrayView`
  // calls survive untouched, only the entity source changes).
  let volumetricFog = extractVolumeSnapshot(world, assets, worldInternal);
  let cloudLayer: ExtractedCloudLayer | undefined;
  const extractedCloudLayer = extractCloudLayer(world);
  if (extractedCloudLayer.ok) {
    cloudLayer = extractedCloudLayer.value;
  } else {
    worldInternal._routeError(extractedCloudLayer.error, {
      severity: Severity.Error,
      systemName: 'RenderSystem.extract (cloud-layer)',
    });
  }

  const cameraRoles = selectCameraRoles(world, context.cameraEntityKey, context.viewExtent);
  const cameras = [...cameraRoles.display];
  const auxiliaryCameras = cameraRoles.auxiliary;
  const cubeCameras = collectCubeCameraSnapshots(world);
  const reflectionProbes = collectReflectionProbeFacts(world);

  // Three-query union (M2 / w16 / AC-03): directional has no Transform
  // dependency (sun-like infinite-source semantics); point + spot pull
  // position from the companion Transform via the joined queries.
  // Host-side pre-multiplication: color *= intensity (charter P4); cone
  // deg -> cos (D-S2); range -> 1/range^2 (D-S5).
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  // feat-20260621 M2: capture shadow fields from the first-hit DirectionalLight.
  // castShadow defaults to true; the CSM path is gated on firstHitCastShadow !== false.
  let firstHitCastShadow: boolean | undefined;
  let firstHitShadowFields:
    | {
        cascadeCount: number;
        splitLambda: number;
        cascadeBlend: number;
        mapSize: number;
        depthBias: number;
        normalBias: number;
        shadowDistance: number;
        shadowFilter: number;
        shadowAngularRadius: number;
        maxPenumbraTexels: number;
        staggerCascades: boolean;
      }
    | undefined;
  for (const row of directionalLightQuery) {
    const l = row.get(DirectionalLight);
    const channelsError = validateLightingChannels(l.lightingChannels);
    if (channelsError !== null) {
      worldInternal._routeError(channelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (lighting-channels)',
      });
      continue;
    }
    directionalCount += 1;
    const intensity = l.intensity;
    const snapshot: DirectionalLightSnapshot = {
      kind: 'directional',
      lightingChannels: l.lightingChannels,
      entity: row.entity,
      direction: vec3.create(l.direction[0] ?? 0, l.direction[1] ?? -1, l.direction[2] ?? 0),
      color: vec3.create(
        (l.color[0] ?? 1) * intensity,
        (l.color[1] ?? 1) * intensity,
        (l.color[2] ?? 1) * intensity,
      ),
      intensity,
      contactShadowLength: l.contactShadowLength,
    };
    if (directional === undefined) {
      // First hit wins; record-stage N>1 fail-fast (M3 / w19) flags duplicates.
      directional = snapshot;
      firstHitCastShadow = l.castShadow;
      firstHitShadowFields = {
        cascadeCount: l.cascadeCount,
        splitLambda: l.splitLambda,
        cascadeBlend: l.cascadeBlend,
        mapSize: l.mapSize,
        depthBias: l.depthBias,
        normalBias: l.normalBias,
        shadowDistance: l.shadowDistance,
        shadowFilter: l.shadowFilter,
        shadowAngularRadius: l.shadowAngularRadius,
        maxPenumbraTexels: l.maxPenumbraTexels,
        staggerCascades: l.staggerCascades,
      };
    }
  }

  let directionalShadowError: LightValidationError | undefined;
  if (directional !== undefined && firstHitShadowFields !== undefined) {
    const validation = validateDirectionalLightData({
      direction: directional.direction,
      contactShadowLength: directional.contactShadowLength,
      castShadow: firstHitCastShadow,
      ...firstHitShadowFields,
    });
    if (!validation.ok) {
      directionalShadowError = validation.error;
      worldInternal._routeError(directionalShadowError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (directional-shadow)',
      });
    }
  }

  const iesProfiles = new Map<number, IesProfileSnapshot>();
  const iesProfile = (
    handle: Handle<'IesProfileAsset', 'shared'> | undefined,
    entity: number,
  ): IesProfileSnapshot => {
    if (handle === undefined || Number(handle) === 0) return {};
    const key = Number(handle);
    const cached = iesProfiles.get(key);
    if (cached !== undefined) return cached;
    const resolved = resolveAssetHandle<IesProfileAsset>(world, handle);
    let result: IesProfileSnapshot = { iesProfileHandle: key };
    if (
      resolved.ok &&
      resolved.value.kind === 'ies-profile' &&
      resolved.value.data.byteLength === IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2
    ) {
      result = {
        iesProfileHandle: key,
        // Cooked assets are immutable. Preserve payload identity so the upload
        // cache hashes once; publication clones metadata without transferring it.
        iesProfileData: resolved.value.data,
      };
    } else {
      worldInternal._routeError(
        !resolved.ok
          ? resolved.error
          : createLightResourceUnavailable({
              entity,
              feature: 'ies',
              generation: 0,
              sourceKey: String(key),
              reason: 'format',
              expected: 'a cooked 256 × 128 r16float IesProfileAsset',
              actual: 'invalid profile payload',
              hint: 'recook the IES profile; the unresolved modifier is identity',
            }),
        { severity: Severity.Error, systemName: 'RenderSystem.extract (ies-profile)' },
      );
    }
    iesProfiles.set(key, result);
    return result;
  };
  const pointSnapshots: PointLightSnapshot[] = [];
  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4: track entity per
  // pointSnapshots index so the post-extract pointShadow join can stamp
  // `shadowAtlasLayer + shadowNear + shadowFar` onto the matching PointLight.
  const pointSnapshotEntities: number[] = [];
  const pointLightQuery = world
    .query({
      read: [PointLight],
      optional: [Transform, GlobalTransform],
    })
    .unwrap();
  for (const row of pointLightQuery) {
    const p = row.get(PointLight);
    const decayError = validatePointLightDecay(p.decay);
    if (decayError !== null) {
      worldInternal._routeError(decayError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (point-light-decay)',
      });
      continue;
    }
    const channelsError = validateLightingChannels(p.lightingChannels);
    if (channelsError !== null) {
      worldInternal._routeError(channelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (lighting-channels)',
      });
      continue;
    }
    // K-2 scheme B: archetype-edge sniff -- `bundle.Transform` key is absent
    // when the archetype does not carry the Transform column.
    const hasTransform = row.get(GlobalTransform) !== undefined;
    const intensity = p.intensity;
    const range = p.range;
    const entityId = row.entity;
    // Position = world-space translation extracted from GlobalTransform.world.
    // A point light archetype without a Transform column sits at the origin.
    let worldMat: Float32Array | undefined;
    if (hasTransform) {
      const view = readPresentationWorldMatrix(world, entityId);
      if (view !== undefined) worldMat = new Float32Array(view);
    }
    const position =
      worldMat !== undefined ? mat4.getTranslation(vec3.create(), worldMat) : vec3.create(0, 0, 0);
    pointSnapshots.push({
      kind: 'point',
      decay: Math.fround(p.decay),
      lightingChannels: p.lightingChannels,
      entity: entityId,
      worldId: context.worldId,
      position,
      color: vec3.create(
        (p.color[0] ?? 1) * intensity,
        (p.color[1] ?? 1) * intensity,
        (p.color[2] ?? 1) * intensity,
      ),
      intensity,
      invRangeSquared: computeInvRangeSquared(range),
      ...iesProfile(p.iesProfile, entityId),
      ...(Number(p.iesProfile) > 0
        ? {
            axisX: vec3.normalize(
              vec3.create(),
              vec3.create(worldMat?.[0] ?? 1, worldMat?.[1] ?? 0, worldMat?.[2] ?? 0),
            ),
            axisY: vec3.normalize(
              vec3.create(),
              vec3.create(worldMat?.[4] ?? 0, worldMat?.[5] ?? 1, worldMat?.[6] ?? 0),
            ),
          }
        : {}),
    });
    pointSnapshotEntities.push(entityId);
  }

  const spotSnapshots: SpotLightSnapshot[] = [];
  const spotLightQuery = world
    .query({
      read: [SpotLight],
      optional: [Transform, GlobalTransform],
    })
    .unwrap();
  // feat-20260625-spot-light-shadow-mapping M1 w5: tile allocation for castShadow spots.
  // Cap = 4 (OOS-5), sentinel -1 = unassigned (plan-strategy D-4).
  // Direction degeneration (near-zero) also skips shadow (requirements $112).
  let spotTileNext = 0;
  // Spot Cookies, Spot projectors, and RectAreaLight source textures share
  // one light-texture array. A slice is keyed by the TextureAsset handle, so
  // every consumer of the same asset reads the same prepared mip chain.
  const lightTextureSlices = new Map<number, number>();
  const lightTextureSlice = (
    handle: number | undefined,
    source: LightTextureSource | undefined,
  ) => {
    if (handle === undefined || handle <= 0) return undefined;
    const existing = lightTextureSlices.get(handle);
    if (existing !== undefined || source === undefined) return existing;
    if (lightTextureSlices.size >= COOKIE_SLICE_CAPACITY) return undefined;
    const slice = lightTextureSlices.size;
    lightTextureSlices.set(handle, slice);
    return slice;
  };
  for (const row of spotLightQuery) {
    const s = row.get(SpotLight);
    const channelsError = validateLightingChannels(s.lightingChannels);
    if (channelsError !== null) {
      worldInternal._routeError(channelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (lighting-channels)',
      });
      continue;
    }
    const hasTransform = row.get(GlobalTransform) !== undefined;
    const intensity = s.intensity;
    const range = s.range;
    const innerConeDeg = s.innerConeDeg;
    const outerConeDeg = s.outerConeDeg;
    let worldMat: Float32Array | undefined;
    if (hasTransform) {
      const entity = row.entity;
      const view = readPresentationWorldMatrix(world, entity);
      if (view !== undefined) worldMat = new Float32Array(view);
    }
    const position =
      worldMat !== undefined ? mat4.getTranslation(vec3.create(), worldMat) : vec3.create(0, 0, 0);
    const dir = vec3.create(s.direction[0] ?? 0, s.direction[1] ?? -1, s.direction[2] ?? 0);

    // Extract is the single direction-normalization owner for direct-light
    // snapshots. URP and HDRP preserve this value downstream.
    const dirLen = Math.sqrt(
      (dir[0] ?? 0) * (dir[0] ?? 0) + (dir[1] ?? 0) * (dir[1] ?? 0) + (dir[2] ?? 0) * (dir[2] ?? 0),
    );
    const EPSILON = 1e-6;
    const hasValidDirection = dirLen > EPSILON;
    if (!hasValidDirection) {
      worldInternal._routeError(
        new SpawnLightInvalidBoundsError('SpotLight', 'direction', [
          dir[0] ?? 0,
          dir[1] ?? 0,
          dir[2] ?? 0,
        ]),
        {
          severity: Severity.Error,
          systemName: 'RenderSystem.extract (spot-direction)',
        },
      );
    }
    const dirN = vec3.create(
      hasValidDirection ? (dir[0] ?? 0) / dirLen : (dir[0] ?? 0),
      hasValidDirection ? (dir[1] ?? 0) / dirLen : (dir[1] ?? 0),
      hasValidDirection ? (dir[2] ?? 0) / dirLen : (dir[2] ?? 0),
    );

    // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
    const castShadow = s.castShadow;
    const sMapSize = s.mapSize;
    const sNearPlane = s.nearPlane;
    const sFarPlane = s.farPlane;
    const cookieAsset =
      s.cookie === undefined ? undefined : resolveAssetHandle<TextureAsset>(world, s.cookie);
    // Resolve the legacy projector before assigning array slices so the
    // extended-lighting path can reuse its texture transport without losing
    // the old lightViewProj projection semantics.
    const hasProjector = Number(s.projector) > 0;
    let projectorHandle: Handle<'TextureAsset', 'shared'> | undefined;
    let projectorAsset: TextureAsset | undefined;
    let projectorGuid: string | undefined;
    if (hasProjector) {
      const candidate = toShared<'TextureAsset'>(Math.round(Number(s.projector)));
      const resolvedProjector = resolveAssetHandle<TextureAsset>(world, candidate);
      if (!resolvedProjector.ok || resolvedProjector.value.kind !== 'texture') {
        worldInternal._routeError(
          resolvedProjector.ok
            ? new RhiError({
                code: 'asset-not-registered',
                expected: 'SpotLight.projector resolves to a TextureAsset',
                hint: 'load the authored projector TextureAsset before assigning SpotLight.projector',
                detail: { assetHandle: Number(candidate) },
              })
            : resolvedProjector.error,
          { severity: Severity.Error, systemName: 'RenderSystem.extract (spot-projector)' },
        );
      } else {
        projectorHandle = candidate;
        projectorAsset = resolvedProjector.value;
        projectorGuid = assets?.guidOf(projectorAsset) ?? `handle:${Number(candidate)}`;
      }
    }
    const cookieProjection =
      cookieAsset?.ok && cookieAsset.value.kind === 'texture'
        ? prepareCookieProjection(cookieAsset.value)
        : undefined;
    const cookieSource = cookieProjection?.source;
    const projectorProjection =
      projectorAsset === undefined ? undefined : prepareCookieProjection(projectorAsset);
    const projectorSource = projectorProjection?.source;
    const cookieHandle = s.cookie === undefined ? undefined : handleSlot(s.cookie);
    const cookieSlice = lightTextureSlice(cookieHandle, cookieSource);
    const projectorSlice = lightTextureSlice(
      projectorHandle === undefined ? undefined : handleSlot(projectorHandle),
      projectorSource,
    );
    const shadowIntensity = s.shadowIntensity;
    // `shared<T>` columns are u32-backed and zero-filled when the optional
    // field is absent. Treat only a positive handle as an authored projector;
    // checking nullish values alone would turn the zero sentinel into a
    // phantom projector matrix and an avoidable asset-not-found diagnostic.
    let lightViewProj: Float32Array | undefined;
    let shadowAtlasTile = -1;

    // A projector needs the same perspective transform even when its SpotLight
    // has no shadow atlas tile. The matrix remains a derived light fact; the
    // shadow tile stays -1 so shadow visibility is still independently gated.
    if ((castShadow || hasProjector) && hasValidDirection) {
      const target = vec3.create(
        (position[0] ?? 0) + (dirN[0] ?? 0),
        (position[1] ?? 0) + (dirN[1] ?? 0),
        (position[2] ?? 0) + (dirN[2] ?? 0),
      );
      // D-1: perspective(outerConeDeg*2, aspect=1, near, far) x lookAt(pos, pos+dir).
      // FOV = outerConeDeg * 2 in degrees; mat4.perspective takes fov in radians.
      const fov = outerConeDeg * 2 * (Math.PI / 180);
      const proj = mat4.create();
      mat4.perspectiveReverseZ(proj, fov, 1, sNearPlane, sFarPlane);
      const view = mat4.create();
      mat4.lookAt(view, position, target, vec3.create(0, 1, 0));
      lightViewProj = new Float32Array(16);
      // Reinterpret the Float32Array surface field as a Mat4 out-param; a
      // factory would force a needless alloc+copy. brand-cast-ok
      mat4.multiply(lightViewProj as Mat4, proj, view);

      // D-4: allocate tile 0..3; 5th+ = -1 sentinel.
      if (castShadow && spotTileNext < 4) {
        shadowAtlasTile = spotTileNext;
        spotTileNext += 1;
      }
    }

    spotSnapshots.push({
      kind: 'spot',
      lightingChannels: s.lightingChannels,
      entity: row.entity,
      worldId: context.worldId,
      // D-6: position reflects world transform; direction stays sourced
      // from SpotLight.direction (NOT rotated by the parent).
      position,
      direction: dirN,
      color: vec3.create(
        (s.color[0] ?? 1) * intensity,
        (s.color[1] ?? 1) * intensity,
        (s.color[2] ?? 1) * intensity,
      ),
      intensity,
      invRangeSquared: computeInvRangeSquared(range),
      cosInner: degToCos(innerConeDeg),
      cosOuter: degToCos(outerConeDeg),
      ...iesProfile(s.iesProfile, row.entity),
      ...(s.cookie === undefined
        ? {}
        : {
            cookieHandle: handleSlot(s.cookie),
            ...(cookieSlice === undefined ? {} : { cookieSlice }),
          }),
      ...(cookieSource === undefined ? {} : { cookieSource }),
      ...(cookieProjection === undefined ? {} : { cookieMatrix: cookieProjection.matrix }),
      ...(projectorSlice === undefined ? {} : { projectorSlice }),
      ...(projectorSource === undefined ? {} : { projectorSource }),
      ...(projectorProjection === undefined ? {} : { projectorMatrix: projectorProjection.matrix }),
      rollDeg: s.rollDeg,
      // ── shadow fields ──
      castShadow,
      lightViewProj,
      mapSize: sMapSize,
      nearPlane: sNearPlane,
      farPlane: sFarPlane,
      shadowAtlasTile,
      shadowIntensity,
      depthBias: s.depthBias,
      normalBias: s.normalBias,
      pcfKernelSize: s.pcfKernelSize,
      ...(projectorHandle === undefined ||
      projectorAsset === undefined ||
      projectorGuid === undefined
        ? {}
        : {
            projectorHandle,
            projectorAsset,
            projectorGuid,
            projectorGeneration: 1,
            projectorRevision: 1,
          }),
    });
  }

  const rectSnapshots: RectAreaDirectLightSnapshot[] = [];
  const rectLightQuery = world
    .query({
      read: [RectAreaLight],
      optional: [Transform, GlobalTransform],
    })
    .unwrap();
  for (const row of rectLightQuery) {
    const light = row.get(RectAreaLight);
    const channelsError = validateLightingChannels(light.lightingChannels);
    if (channelsError !== null) {
      worldInternal._routeError(channelsError, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (lighting-channels)',
      });
      continue;
    }
    const validation = validateRectAreaLightData({
      intensity: light.intensity,
      color: light.color,
      width: light.width,
      height: light.height,
      range: light.range,
    });
    if (!validation.ok) {
      worldInternal._routeError(validation.error, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (rect-area-light)',
      });
      continue;
    }
    const worldView = row.get(GlobalTransform);
    const worldMat =
      worldView === undefined
        ? undefined
        : new Float32Array(readPresentationWorldMatrix(world, row.entity) ?? []);
    const position =
      worldMat !== undefined ? mat4.getTranslation(vec3.create(), worldMat) : vec3.create(0, 0, 0);
    const frame = buildRectAreaWorldFrame({
      center: position,
      axisX: [worldMat?.[0] ?? 1, worldMat?.[1] ?? 0, worldMat?.[2] ?? 0],
      axisY: [worldMat?.[4] ?? 0, worldMat?.[5] ?? 1, worldMat?.[6] ?? 0],
      width: light.width,
      height: light.height,
    });
    let sourceTextureHandle: number | undefined;
    let sourceTextureSlice: number | undefined;
    let sourceTextureSource: LightTextureSource | undefined;
    if (light.sourceTexture !== undefined && Number(light.sourceTexture) > 0) {
      const resolved = resolveAssetHandle<TextureAsset>(world, light.sourceTexture);
      const projection =
        resolved.ok && resolved.value.kind === 'texture'
          ? prepareCookieProjection(resolved.value)
          : undefined;
      if (projection === undefined) {
        worldInternal._routeError(
          resolved.ok
            ? new RhiError({
                code: 'asset-not-registered',
                expected:
                  'RectAreaLight.sourceTexture resolves to a 2D TextureAsset: uncompressed rgba8unorm[-srgb], bgra8unorm[-srgb], r8unorm, rgba16float, rgba32float, or a BC/ETC2/ASTC block format whose colorSpace matches its -srgb suffix',
                hint: 'assign a 2D image texture (not a cube, array or 3D texture) whose colorSpace matches its format before assigning RectAreaLight.sourceTexture; the light renders untextured until then',
                detail: { assetHandle: Number(light.sourceTexture) },
              })
            : resolved.error,
          { severity: Severity.Error, systemName: 'RenderSystem.extract (rect-source-texture)' },
        );
      }
      sourceTextureHandle = handleSlot(light.sourceTexture);
      sourceTextureSource = projection?.source;
      sourceTextureSlice = lightTextureSlice(sourceTextureHandle, sourceTextureSource);
    }
    rectSnapshots.push({
      kind: 'rect-area',
      lightingChannels: light.lightingChannels,
      position,
      color: vec3.create(
        (light.color[0] ?? 1) * light.intensity,
        (light.color[1] ?? 1) * light.intensity,
        (light.color[2] ?? 1) * light.intensity,
      ),
      intensity: light.intensity,
      invRangeSquared: computeInvRangeSquared(light.range),
      halfWidth: frame.halfWidth,
      halfHeight: frame.halfHeight,
      axisX: frame.axisX,
      axisY: frame.axisY,
      ...iesProfile(light.iesProfile, row.entity),
      ...(sourceTextureHandle === undefined ? {} : { sourceTextureHandle }),
      ...(sourceTextureSlice === undefined || sourceTextureSource === undefined
        ? {}
        : { cookieSlice: sourceTextureSlice, cookieSource: sourceTextureSource }),
    });
  }
  // The SpotLight is the sole projector owner. Once all light snapshots have
  // been extracted, publish its accepted TextureAsset tuple on the volume
  // snapshot so surface and volume consume the same identity and revision.
  let volumeSpot: SpotLightSnapshot | undefined;
  const extractedFog = volumetricFog;
  if (extractedFog !== undefined) {
    if (extractedFog.spotLightEntity !== undefined) {
      volumeSpot = spotSnapshots.find((light) => light.entity === extractedFog.spotLightEntity);
    } else if (extractedFog.lightKind === 'spot') {
      volumeSpot = spotSnapshots.find((light) => light.entity === extractedFog.lightEntity);
    }
  }
  if (
    volumetricFog !== undefined &&
    volumetricFog.status === 'available' &&
    volumeSpot?.projectorAsset !== undefined &&
    volumeSpot.projectorHandle !== undefined
  ) {
    const projectorHandle = volumeSpot.projectorHandle;
    const projectorAsset = volumeSpot.projectorAsset;
    volumetricFog = {
      ...volumetricFog,
      projector: {
        guid: volumeSpot.projectorGuid ?? `handle:${Number(volumeSpot.projectorHandle)}`,
        generation: volumeSpot.projectorGeneration ?? 1,
        view: '2d',
        sampler: 'linear-clamp-to-edge',
        projection: 'spot-projection',
        revision: volumeSpot.projectorRevision ?? 1,
      },
      projectorHandle,
      projectorAsset,
    };
  }

  // bug-20260710-editor-cross-world-shadow: CSM matrices are computed by the
  // shared pure {@link computeDirectionalCsm}, called here per-world with THIS
  // world's own `cameras[0]`. In a single-world app the light and camera share
  // the world, so this per-world result is final. In the editor
  // super-composite the light's world may have no camera → this yields no
  // matrices; {@link extractFrames} then RECOMPUTES at
  // the merge layer using the surfaced (cameraOwner) camera + the raw config
  // carried on ExtractedLights. The raw config + direction are surfaced
  // unconditionally so the merge layer can re-run the builder.
  let lightViewProj: Float32Array[] | undefined;
  let splitPlanes: Float32Array | undefined;
  let cascadeCount: number | undefined;
  let cascadeBlend: number | undefined;
  let shadowMapSize: number | undefined;
  let directionalShadowQuality: DirectionalShadowQuality | undefined;
  let directionalCsmConfig: DirectionalCsmConfig | undefined;
  let directionalCsmDirection: Vec3 | undefined;

  // Camera data needed for frustum corner computation (first camera only;
  // multi-camera CSM is OOS-1). Undefined in a cameraless world.
  const cam0 = cameras[0];
  const cameraData: CsmCameraData | undefined =
    cam0 !== undefined
      ? {
          world: cam0.world,
          fov: cam0.fov,
          aspect: cam0.aspect,
          near: cam0.near,
          far: cam0.far,
          projection: cam0.projection,
          orthoLeft: cam0.orthoLeft,
          orthoRight: cam0.orthoRight,
          orthoBottom: cam0.orthoBottom,
          orthoTop: cam0.orthoTop,
          ...(cam0.eye === undefined ? {} : { eye: cam0.eye }),
        }
      : undefined;

  // feat-20260621 M2: CSM computation gated on castShadow from the
  // merged DirectionalLight. castShadow defaults to true (first-hit-wins
  // semantics, D-6 no cardinality cap).
  if (
    directional !== undefined &&
    firstHitCastShadow !== false &&
    directionalShadowError === undefined
  ) {
    const dirSnapshot = directional;
    const sf = firstHitShadowFields;
    if (sf !== undefined) {
      directionalCsmConfig = {
        cascadeCount: sf.cascadeCount,
        splitLambda: sf.splitLambda,
        cascadeBlend: sf.cascadeBlend,
        mapSize: sf.mapSize,
        shadowDistance: sf.shadowDistance,
        shadowFilter: sf.shadowFilter,
        shadowAngularRadius: sf.shadowAngularRadius,
        maxPenumbraTexels: sf.maxPenumbraTexels,
        ...(sf.staggerCascades ? { staggerCascades: true } : {}),
      };
      directionalCsmDirection = dirSnapshot.direction;
      const csm = computeDirectionalCsm(dirSnapshot.direction, directionalCsmConfig, cameraData);
      // Cascade metadata (splitPlanes / count / blend / mapSize) is available
      // even without a camera (splitPlanes needs only near/far); the matrices
      // need the camera. When csm is null (no camera) leave lightViewProj
      // undefined — the merge layer recomputes. Still surface the split/count
      // metadata so a single-world path keeps its prior fields.
      cascadeCount = Math.round(sf.cascadeCount);
      cascadeBlend = sf.cascadeBlend;
      shadowMapSize = sf.mapSize;
      if (csm !== null) {
        lightViewProj = csm.lightViewProj;
        splitPlanes = csm.splitPlanes;
        directionalShadowQuality = csm.directionalShadowQuality;
      } else {
        const sNear = cameraData?.near ?? 0.1;
        const splits = pssmSplit(sNear, sf.shadowDistance, cascadeCount, sf.splitLambda);
        const padded = new Float32Array(16);
        for (let i = 0; i < splits.length; i++) padded[i * 4] = splits[i] ?? 0;
        splitPlanes = padded;
      }
      directionalShadowQuality = directionalShadowQualityFromF32(
        sf.shadowFilter,
        sf.shadowAngularRadius,
        sf.maxPenumbraTexels,
      );
    }
  }

  // feat-20260613-csm M3 / w14 (plan-strategy §D-7): pad the up-to-4
  // splitPlanes into a fixed length-4 Float32Array (unused slots = 0) so
  // the View UBO tail keeps a stable layout regardless of the runtime
  // cascadeCount. Host-side correctness invariant: only the first
  // cascadeCount slots are ever read by the WGSL kernel.
  const paddedSplitPlanes = new Float32Array(16);
  if (splitPlanes !== undefined) {
    for (let i = 0; i < splitPlanes.length; i++) {
      paddedSplitPlanes[i] = splitPlanes[i] ?? 0;
    }
  }

  // feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7 (plan-strategy §D-3,
  // requirements §5.3): query (PointLight + PointLightShadow + Transform)
  // archetype join. For each shadow caster, build 6 face VP matrices and pack
  // into Float32Array(96). Atlas layer is assigned in spawn order while the
  // renderer-owned atlas has capacity; the sentinel -1 is shader-side and
  // applies to non-admitted PointLightShadow requests as well.
  const pointShadowSnapshots: PointShadowSnapshot[] = [];
  {
    const pointShadowQuery = world
      .query({ read: [Transform, GlobalTransform, PointLightShadow], with: [PointLight] })
      .unwrap();
    for (const row of pointShadowQuery) {
      const ps = row.get(PointLightShadow);
      // Read world-space position from GlobalTransform.world (mat4 column-major;
      // translation lives at indices 12..14, mirroring CameraSnapshot.world
      // semantics in this file).
      // feat-20260614 M4 / w13: TypedArrayFor for `array<f32, 16>` now
      // resolves to a concrete `Float32Array` (was `never` pre-w11), which
      // surfaces the row-window slicing -- `t.world` is the stride-16 flat
      // column view; row i lives at `[i*16, (i+1)*16)`. The prior
      // `t.world?.[i]` form silently returned a single element under the
      // `never`-typed bundle path and `wRow[12]` widened to `undefined ?? 0`
      // so light positions clamped to the origin.
      const wRow = readPresentationWorldMatrix(world, row.entity);
      if (wRow === undefined) continue;
      const px = wRow[12] ?? 0;
      const py = wRow[13] ?? 0;
      const pz = wRow[14] ?? 0;
      const lightPos = vec3.create(px, py, pz);
      const mapSize = ps.mapSize;
      const nearPlane = ps.nearPlane;
      const farPlane = ps.farPlane;
      // The renderer, not ECS, owns the atlas budget. Preserve every request
      // for inspection, but emit the shader sentinel for entries that cannot
      // acquire a layer so record never calls faceView outside the atlas.
      const layer =
        pointShadowSnapshots.length < SHADOW_ATLAS_DEFAULT_LAYERS
          ? pointShadowSnapshots.length
          : -1;

      const matrices = buildPointShadowMatrices(lightPos, nearPlane, farPlane);
      const packed = new Float32Array(96);
      for (let f = 0; f < 6; f++) {
        const m = matrices[f];
        if (m === undefined) continue;
        for (let k = 0; k < 16; k++) {
          packed[f * 16 + k] = m[k] ?? 0;
        }
      }
      pointShadowSnapshots.push({
        entity: row.entity,
        worldId: context.worldId,
        position: lightPos,
        mapSize,
        nearPlane,
        farPlane,
        depthBias: ps.depthBias,
        normalBias: ps.normalBias,
        shadowAtlasLayer: layer,
        shadowMatrices: packed,
      });
    }
  }

  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
  // join pointShadow snapshots into the matching PointLightSnapshot so the
  // record stage threads `shadowAtlasLayer + shadowNear + shadowFar` through
  // the unified direct-light metadata payload.
  // Mutates the freshly-built PointLightSnapshot in place; the snapshot is
  // not exposed elsewhere this frame yet (consumed only by lights.point[]).
  if (pointShadowSnapshots.length > 0) {
    const shadowByEntity = new Map<number, PointShadowSnapshot>();
    for (const ps of pointShadowSnapshots) shadowByEntity.set(ps.entity, ps);
    for (let i = 0; i < pointSnapshots.length; i++) {
      const entityId = pointSnapshotEntities[i] ?? 0;
      const ps = shadowByEntity.get(entityId);
      if (ps !== undefined) {
        pointSnapshots[i] = {
          ...(pointSnapshots[i] as PointLightSnapshot),
          shadowAtlasLayer: ps.shadowAtlasLayer,
          shadowNear: ps.nearPlane,
          shadowFar: ps.farPlane,
        };
      }
    }
  }

  const lights: ExtractedLights = {
    directional,
    directionalCount,
    point: pointSnapshots,
    spot: spotSnapshots,
    rect: rectSnapshots,
    lightViewProj,
    splitPlanes: splitPlanes !== undefined ? paddedSplitPlanes : undefined,
    cascadeCount,
    cascadeBlend,
    shadowMapSize,
    depthBias: firstHitCastShadow !== false ? firstHitShadowFields?.depthBias : undefined,
    normalBias: firstHitCastShadow !== false ? firstHitShadowFields?.normalBias : undefined,
    directionalShadowQuality,
    directionalShadowError,
    pointShadow: pointShadowSnapshots,
    // bug-20260710-editor-cross-world-shadow: raw CSM config + light direction
    // so the merge layer can recompute matrices against the surfaced camera.
    directionalCsmConfig,
    directionalCsmDirection,
  };

  // A caster may be outside the display camera while still contributing to a
  // light's shadow map. Keep the light-space visibility projection alongside
  // camera culling so the direct extraction path and persistent composition
  // retain the same shadow-only rule.

  // feat-20260520-skylight-ibl-cubemap M4 / t26+t27: query Skylight entities.
  // First archetype hit wins (mirrors DirectionalLight pattern); multi-Skylight
  // warn in record stage (t27) uses skylightCount.
  const skylightQuery = world.query({ read: [Skylight], optional: [GlobalTransform] }).unwrap();
  let skylight: SkylightSnapshot | undefined;
  let skylightCount = 0;
  for (const row of skylightQuery) {
    const s = row.get(Skylight);
    // equirect is OPTIONAL: an omitted field zero-inits to handle 0, which
    // record treats as "no equirect" -> solid-color ambient via the white
    // fallback cube. A Skylight WITHOUT an equirect is still a valid snapshot
    // (the prior `equirectRaw !== undefined` gate dropped color-only
    // skylights, leaving the scene black -- the downstream gap #4).
    const equirectRaw = s.equirect;
    const intensity = s.intensity;
    const colorR = s.color[0] ?? 1.0;
    const colorG = s.color[1] ?? 1.0;
    const colorB = s.color[2] ?? 1.0;
    const rotation: [number, number, number, number] = [
      s.rotation[0] ?? 0,
      s.rotation[1] ?? 0,
      s.rotation[2] ?? 0,
      s.rotation[3] ?? 1,
    ];
    skylightCount += 1;
    if (skylight === undefined) {
      const captureWorld = readPresentationWorldMatrix(world, row.entity);
      skylight = {
        ...(captureWorld === undefined
          ? {}
          : {
              capturePosition: [
                captureWorld[12] ?? 0,
                captureWorld[13] ?? 0,
                captureWorld[14] ?? 0,
              ] as const,
            }),
        equirectHandle: equirectRaw !== undefined ? Math.round(equirectRaw) : 0,
        color: [colorR, colorG, colorB],
        intensity,
        rotation,
        // w19: winning entity handle for the multi-Skylight once-warn (F-8).
        entityHandle: row.entity,
      };
    }
  }

  const lightProbeQuery = world.query({ read: [LightProbe, GlobalTransform] }).unwrap();
  const lightProbes: LightProbeSnapshot[] = [];
  for (const row of lightProbeQuery) {
    const probe = row.get(LightProbe);
    const validation = validateLightProbeData({
      irradiance: probe.irradiance,
      radius: probe.radius,
    });
    if (!validation.ok) {
      worldInternal._routeError(validation.error, {
        severity: Severity.Error,
        systemName: 'RenderSystem.extract (light-probe)',
      });
      continue;
    }
    const transform = readPresentationWorldMatrix(world, row.entity);
    if (transform === undefined) continue;
    lightProbes.push({
      identity: String(row.entity),
      worldId: context.worldId,
      position: [transform[12] ?? 0, transform[13] ?? 0, transform[14] ?? 0],
      radius: probe.radius,
      irradiance: new Float32Array(probe.irradiance),
      admitted: true,
    });
  }

  // feat-20260531-skybox-env-background M2 / w5: query SkyboxBackground entities.
  // First archetype hit wins (mirrors Skylight pattern); multi-entity
  // once-warn in record stage uses skyboxCount.
  const skyboxQuery = world.query({ read: [SkyboxBackground] }).unwrap();
  let skybox: SkyboxSnapshot | undefined;
  let skyboxCount = 0;
  for (const row of skyboxQuery) {
    const s = row.get(SkyboxBackground);
    const equirectRaw = s.equirect;
    const modeRaw = s.mode;
    const rotation: [number, number, number, number] = [
      s.rotation[0] ?? 0,
      s.rotation[1] ?? 0,
      s.rotation[2] ?? 0,
      s.rotation[3] ?? 1,
    ];
    skyboxCount += 1;
    if (skybox === undefined && equirectRaw !== undefined) {
      skybox = {
        equirectHandle: Math.round(equirectRaw),
        mode: modeRaw,
        rotation,
        // w19: winning entity handle for the multi-SkyboxBackground warn (F-8).
        entityHandle: row.entity,
      };
    }
  }

  const environmentCandidates: EnvironmentCandidate[] = [];
  const imageEnvironment =
    skylight?.equirectHandle !== undefined && skylight.equirectHandle > 0
      ? skylight
      : skybox?.equirectHandle !== undefined && skybox.equirectHandle > 0
        ? skybox
        : undefined;
  if (imageEnvironment !== undefined) {
    environmentCandidates.push({
      kind: 'image',
      entityKey: imageEnvironment.entityHandle,
      sourceKey: `equirect:${imageEnvironment.equirectHandle}`,
    });
  }
  const atmosphereQuery = world.query({ read: [Atmosphere], optional: [GlobalTransform] }).unwrap();
  for (const row of atmosphereQuery) {
    const value = row.get(Atmosphere);
    const tuple = (channels: ArrayLike<number>): readonly [number, number, number] => [
      channels[0] ?? 0,
      channels[1] ?? 0,
      channels[2] ?? 0,
    ];
    const atmosphereWorld = readPresentationWorldMatrix(world, row.entity);
    const atmosphere = {
      planetRadius: value.planetRadius,
      atmosphereHeight: value.atmosphereHeight,
      groundOrigin: [
        atmosphereWorld?.[12] ?? 0,
        atmosphereWorld?.[13] ?? 0,
        atmosphereWorld?.[14] ?? 0,
      ] as const,
      capturePosition:
        skylight?.capturePosition ??
        ([
          atmosphereWorld?.[12] ?? 0,
          (atmosphereWorld?.[13] ?? 0) + 1,
          atmosphereWorld?.[14] ?? 0,
        ] as const),
      rayleighScattering: tuple(value.rayleighScattering),
      rayleighScaleHeight: value.rayleighScaleHeight,
      mieScattering: value.mieScattering,
      mieAbsorption: value.mieAbsorption,
      mieScaleHeight: value.mieScaleHeight,
      mieAnisotropy: value.mieAnisotropy,
      absorption: tuple(value.absorption),
      absorptionPeakHeight: value.absorptionPeakHeight,
      absorptionHalfWidth: value.absorptionHalfWidth,
      groundAlbedo: tuple(value.groundAlbedo),
      multipleScattering: value.multipleScattering,
      sunAngularRadius: value.sunAngularRadius,
      aerialPerspectiveStart: value.aerialPerspectiveStart,
      aerialPerspectiveDistanceScale: value.aerialPerspectiveDistanceScale,
    } as const;
    environmentCandidates.push({
      kind: 'atmosphere',
      entityKey: row.entity,
      sourceKey: `atmosphere:${row.entity}`,
      atmosphere,
    });
  }
  const directionalDirection = directional?.direction;
  const directionalLength =
    directionalDirection === undefined
      ? 0
      : Math.hypot(
          directionalDirection[0] ?? 0,
          directionalDirection[1] ?? 0,
          directionalDirection[2] ?? 0,
        );
  const sunIntensity = directional?.intensity ?? 0;
  const sunColor =
    sunIntensity > 0 && directional !== undefined
      ? ([
          (directional.color[0] ?? 0) / sunIntensity,
          (directional.color[1] ?? 0) / sunIntensity,
          (directional.color[2] ?? 0) / sunIntensity,
        ] as [number, number, number])
      : ([0, 0, 0] as [number, number, number]);
  const sun =
    directional === undefined || directional.entity === undefined || directionalLength <= 1e-6
      ? []
      : [
          {
            entityKey: directional.entity,
            direction: [
              -(directionalDirection?.[0] ?? 0) / directionalLength,
              -(directionalDirection?.[1] ?? 0) / directionalLength,
              -(directionalDirection?.[2] ?? 0) / directionalLength,
            ] as [number, number, number],
            color: sunColor,
            intensity: directional.intensity,
          },
        ];
  const environmentSelection = selectEnvironment({
    environments: environmentCandidates,
    fogs: fog === undefined ? [] : [fog],
    suns: sun,
    lane: 'direct',
  });
  if (!environmentSelection.ok) {
    routeWorldError(world, environmentSelection.error, {
      systemName: 'RenderSystem.extract (environment-selection)',
    });
    throw environmentSelection.error;
  }
  const environment: EnvironmentFrame = environmentSelection.value;

  return {
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
  };
}
