import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, SchemaOf, ShapeOf, World } from '@forgeax/engine-ecs';
import { routeWorldError, SpawnLightInvalidBoundsError } from '@forgeax/engine-ecs/projection';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, IesProfileAsset, TextureAsset } from '@forgeax/engine-types';
import { type ExtractedCloudLayer, extractCloudLayer } from '../cloud/extract';
import {
  Atmosphere,
  DirectionalLight,
  GradientSky,
  LightProbe,
  PointLight,
  PointLightShadow,
  RectAreaLight,
  SkyboxBackground,
  Skylight,
  SpotLight,
} from '../components';
import {
  computeInvRangeSquared,
  degToCos,
  type LightValidationError,
  resolvePunctualShadowFarPlane,
  validateDirectionalLightData,
  validateLightProbeData,
  validateRectAreaLightData,
} from '../components/light-helpers';
import { validateChannelMask } from '../components/lighting-channels';
import { validatePointLightDecay } from '../components/point-light';
import { selectEnvironment } from '../environment/frame';
import { createLightResourceUnavailable } from '../errors/render';
import type {
  EnvironmentCandidate,
  EnvironmentFrame,
  GradientSkyFrame,
} from '../extract/environment';
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
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  ExtractedFrame,
  IesProfileSnapshot,
  LightProbeSnapshot,
  LightRoster,
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
  type createWorldInternalView,
  extractVolumeSnapshot,
  Severity,
  selectCameraRoles,
} from '../render-system-extract';
import { readEnvironmentPose } from './environment-gate';

type WorldInternalView = ReturnType<typeof createWorldInternalView>;
type RgbTuple = readonly [number, number, number];

/** Produces light, camera and atmosphere facts once, before renderable projection. */
export function extractWorldEnvironment(
  world: World,
  context: Pick<PreparedExtractContext, 'assets' | 'cameraEntityKey' | 'worldId' | 'viewExtent'>,
  worldInternal: WorldInternalView,
  fog: ExtractedFrame['fog'],
) {
  const { assets } = context;
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
  const volumetricFogSource = extractVolumeSnapshot(world, assets, worldInternal);
  const cloudLayer = extractCloudLayerOrRoute(world, worldInternal);

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
  const sun = extractDirectionalLights(world, worldInternal);
  const directionalShadowError = validateDirectionalShadow(sun, worldInternal);

  const iesProfiles = new Map<number, IesProfileSnapshot>();
  // Spot Cookies, Spot projectors, and RectAreaLight source textures share
  // one light-texture array. A slice is keyed by the TextureAsset handle, so
  // every consumer of the same asset reads the same prepared mip chain.
  const lightTextureSlices = new Map<number, number>();
  const points = extractPointLights(world, context.worldId, worldInternal, iesProfiles);
  const spotSnapshots = extractSpotLights(
    world,
    context,
    worldInternal,
    iesProfiles,
    lightTextureSlices,
  );
  const rectSnapshots = extractRectAreaLights(
    world,
    worldInternal,
    iesProfiles,
    lightTextureSlices,
  );
  const volumetricFog = attachVolumeSpotProjector(volumetricFogSource, spotSnapshots);

  const directionalShadow = directionalShadowSource(sun, directionalShadowError);
  const pointShadowSnapshots = extractPointShadows(world, context.worldId, worldInternal);
  joinPointShadowLayers(points.snapshots, points.entities, pointShadowSnapshots);
  const castsShadow = sun.castShadow === true;

  const lights: LightRoster = {
    directional: sun.directional,
    directionalCount: sun.directionalCount,
    point: points.snapshots,
    spot: spotSnapshots,
    rect: rectSnapshots,
    depthBias: castsShadow ? sun.shadowFields?.depthBias : undefined,
    normalBias: castsShadow ? sun.shadowFields?.normalBias : undefined,
    directionalShadowError,
    pointShadow: pointShadowSnapshots,
    directionalCsmConfig: directionalShadow?.directionalCsmConfig,
    directionalCsmDirection: directionalShadow?.directionalCsmDirection,
  };

  // A caster may be outside the display camera while still contributing to a
  // light's shadow map. Keep the light-space visibility projection alongside
  // camera culling so the direct extraction path and persistent composition
  // retain the same shadow-only rule.
  const { skylight, skylightCount } = extractSkylight(world);
  const lightProbes = extractLightProbes(world, context.worldId, worldInternal);
  const { skybox, skyboxCount } = extractSkybox(world);
  const environment = selectWorldEnvironment(world, skylight, skybox, sun.directional, fog);

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

function routeExtractError(
  worldInternal: WorldInternalView,
  error: Parameters<WorldInternalView['_routeError']>[0],
  systemName: string,
): void {
  worldInternal._routeError(error, { severity: Severity.Error, systemName });
}

function extractCloudLayerOrRoute(
  world: World,
  worldInternal: WorldInternalView,
): ExtractedCloudLayer | undefined {
  const extractedCloudLayer = extractCloudLayer(world);
  if (extractedCloudLayer.ok) return extractedCloudLayer.value;
  routeExtractError(worldInternal, extractedCloudLayer.error, 'RenderSystem.extract (cloud-layer)');
  return undefined;
}

/** Routes an invalid lighting or caster channel mask; the light is then skipped. */
function admitLightChannels(
  worldInternal: WorldInternalView,
  lightingChannels: number,
  shadowCasterChannels?: number,
): boolean {
  const channelsError =
    validateChannelMask(lightingChannels) ??
    (shadowCasterChannels === undefined
      ? null
      : validateChannelMask(shadowCasterChannels, 'shadowCasterChannels'));
  if (channelsError === null) return true;
  routeExtractError(worldInternal, channelsError, 'RenderSystem.extract (lighting-channels)');
  return false;
}

/** Host-side pre-multiplication: color *= intensity (charter P4). */
function scaledLightColor(color: ArrayLike<number>, intensity: number): Vec3 {
  return vec3.create(
    (color[0] ?? 1) * intensity,
    (color[1] ?? 1) * intensity,
    (color[2] ?? 1) * intensity,
  );
}

function copyPresentationWorldMatrix(world: World, entity: EntityHandle): Float32Array | undefined {
  const view = readEnvironmentPose(world, entity);
  return view === undefined ? undefined : new Float32Array(view);
}

/** A light archetype without a Transform column sits at the origin. */
function worldTranslationOf(worldMat: Float32Array | undefined): Vec3 {
  return worldMat !== undefined
    ? mat4.getTranslation(vec3.create(), worldMat)
    : vec3.create(0, 0, 0);
}

function quaternionOf(rotation: ArrayLike<number>): [number, number, number, number] {
  return [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
}

function rgbTuple(channels: ArrayLike<number>): RgbTuple {
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function directionalShadowFieldsOf(l: Readonly<ShapeOf<SchemaOf<typeof DirectionalLight>>>) {
  return {
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
    shadowMapAspect: l.shadowMapAspect,
    shadowCasterChannels: l.shadowCasterChannels,
    shadowAutoUpdate: l.shadowAutoUpdate,
    shadowRevision: l.shadowRevision,
    staggerCascades: l.staggerCascades,
    staticShadowCache: l.staticShadowCache,
    shadowProjection: l.shadowProjection,
    shadowViewProjection: new Float32Array(l.shadowViewProjection),
    shadowBiasMode: l.shadowBiasMode,
    shadowRadius: l.shadowRadius,
    shadowIntensity: l.shadowIntensity,
    shadowBlurSamples: l.shadowBlurSamples,
  };
}

/**
 * First hit wins; record-stage N>1 fail-fast (M3 / w19) flags duplicates.
 * feat-20260621 M2: shadow fields come from the first-hit DirectionalLight.
 * castShadow defaults to false; only an explicit opt-in requests CSM.
 */
function extractDirectionalLights(world: World, worldInternal: WorldInternalView) {
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  let castShadow: boolean | undefined;
  let shadowFields: ReturnType<typeof directionalShadowFieldsOf> | undefined;
  for (const row of world.query({ read: [DirectionalLight] }).unwrap()) {
    const l = row.get(DirectionalLight);
    if (!admitLightChannels(worldInternal, l.lightingChannels, l.shadowCasterChannels)) continue;
    directionalCount += 1;
    if (directional !== undefined) continue;
    directional = {
      kind: 'directional',
      lightingChannels: l.lightingChannels,
      entity: row.entity,
      direction: vec3.create(l.direction[0] ?? 0, l.direction[1] ?? -1, l.direction[2] ?? 0),
      color: scaledLightColor(l.color, l.intensity),
      intensity: l.intensity,
      contactShadowLength: l.contactShadowLength,
    };
    castShadow = l.castShadow;
    shadowFields = directionalShadowFieldsOf(l);
  }
  return { directional, directionalCount, castShadow, shadowFields };
}

type DirectionalExtraction = ReturnType<typeof extractDirectionalLights>;

function validateDirectionalShadow(
  sun: DirectionalExtraction,
  worldInternal: WorldInternalView,
): LightValidationError | undefined {
  if (sun.directional === undefined || sun.shadowFields === undefined) return undefined;
  const validation = validateDirectionalLightData({
    direction: sun.directional.direction,
    contactShadowLength: sun.directional.contactShadowLength,
    castShadow: sun.castShadow,
    ...sun.shadowFields,
  });
  if (validation.ok) return undefined;
  routeExtractError(worldInternal, validation.error, 'RenderSystem.extract (directional-shadow)');
  return validation.error;
}

/** Resolves an IES profile once per handle; an unresolved modifier is identity. */
function resolveIesProfile(
  world: World,
  worldInternal: WorldInternalView,
  cache: Map<number, IesProfileSnapshot>,
  handle: number | undefined,
  entity: number,
): IesProfileSnapshot {
  if (handle === undefined || Number(handle) === 0) return {};
  const key = Number(handle);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolved = runtimeAssets(world.assets).resolveAsset<IesProfileAsset>(handle);
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
    routeExtractError(
      worldInternal,
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
      'RenderSystem.extract (ies-profile)',
    );
  }
  cache.set(key, result);
  return result;
}

/** Assigns one shared light-texture array slice per TextureAsset handle. */
function assignLightTextureSlice(
  slices: Map<number, number>,
  handle: number | undefined,
  source: LightTextureSource | undefined,
): number | undefined {
  if (handle === undefined || handle <= 0) return undefined;
  const existing = slices.get(handle);
  if (existing !== undefined || source === undefined) return existing;
  if (slices.size >= COOKIE_SLICE_CAPACITY) return undefined;
  const slice = slices.size;
  slices.set(handle, slice);
  return slice;
}

/** IES profiles orient by the light's local X/Y axes. */
function iesAxesOf(worldMat: Float32Array | undefined) {
  return {
    axisX: vec3.normalize(
      vec3.create(),
      vec3.create(worldMat?.[0] ?? 1, worldMat?.[1] ?? 0, worldMat?.[2] ?? 0),
    ),
    axisY: vec3.normalize(
      vec3.create(),
      vec3.create(worldMat?.[4] ?? 0, worldMat?.[5] ?? 1, worldMat?.[6] ?? 0),
    ),
  };
}

function extractPointLights(
  world: World,
  worldId: PreparedExtractContext['worldId'],
  worldInternal: WorldInternalView,
  iesProfiles: Map<number, IesProfileSnapshot>,
) {
  const snapshots: PointLightSnapshot[] = [];
  // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4: track entity per
  // snapshot index so the post-extract pointShadow join can stamp
  // `shadowAtlasLayer + shadowNear + shadowFar` onto the matching PointLight.
  const entities: number[] = [];
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
      routeExtractError(worldInternal, decayError, 'RenderSystem.extract (point-light-decay)');
      continue;
    }
    if (!admitLightChannels(worldInternal, p.lightingChannels)) continue;
    const entityId = row.entity;
    // K-2 scheme B: archetype-edge sniff -- `bundle.Transform` key is absent
    // when the archetype does not carry the Transform column.
    const worldMat =
      row.get(GlobalTransform) !== undefined
        ? copyPresentationWorldMatrix(world, entityId)
        : undefined;
    const position = worldTranslationOf(worldMat);
    const ies = resolveIesProfile(world, worldInternal, iesProfiles, p.iesProfile, entityId);
    snapshots.push({
      kind: 'point',
      decay: Math.fround(p.decay),
      lightingChannels: p.lightingChannels,
      entity: entityId,
      worldId,
      position,
      color: scaledLightColor(p.color, p.intensity),
      intensity: p.intensity,
      invRangeSquared: computeInvRangeSquared(p.range),
      ...ies,
      ...(Number(p.iesProfile) > 0 ? iesAxesOf(worldMat) : {}),
    });
    entities.push(entityId);
  }
  return { snapshots, entities };
}

/**
 * Extract is the single direction-normalization owner for direct-light
 * snapshots. URP and HDRP preserve this value downstream. A degenerate
 * direction is routed and kept unnormalized; it skips the shadow projection.
 */
function normalizeSpotDirection(direction: ArrayLike<number>, worldInternal: WorldInternalView) {
  const x = direction[0] ?? 0;
  const y = direction[1] ?? -1;
  const z = direction[2] ?? 0;
  const length = Math.sqrt(x * x + y * y + z * z);
  const valid = length > 1e-6;
  if (!valid) {
    routeExtractError(
      worldInternal,
      new SpawnLightInvalidBoundsError('SpotLight', 'direction', [x, y, z]),
      'RenderSystem.extract (spot-direction)',
    );
    return { direction: vec3.create(x, y, z), valid };
  }
  return { direction: vec3.create(x / length, y / length, z / length), valid };
}

/**
 * Resolve the legacy projector before assigning array slices so the
 * extended-lighting path can reuse its texture transport without losing the
 * old lightViewProj projection semantics.
 */
function resolveSpotProjector(
  world: World,
  assets: PreparedExtractContext['assets'],
  worldInternal: WorldInternalView,
  projector: number,
) {
  const handle = Math.round(Number(projector)) as AssetHandle<'texture'>;
  const resolved = runtimeAssets(world.assets).resolveAsset<TextureAsset>(handle);
  if (resolved.ok && resolved.value.kind === 'texture') {
    return {
      handle,
      asset: resolved.value,
      guid: assets?.guidOf(handle) ?? `handle:${Number(handle)}`,
    };
  }
  routeExtractError(
    worldInternal,
    resolved.ok
      ? new RhiError({
          code: 'asset-not-registered',
          expected: 'SpotLight.projector resolves to a TextureAsset',
          hint: 'load the authored projector TextureAsset before assigning SpotLight.projector',
          detail: { assetHandle: Number(handle) },
        })
      : resolved.error,
    'RenderSystem.extract (spot-projector)',
  );
  return undefined;
}

function resolveSpotCookie(world: World, cookie: number) {
  const cookieHandle = Number(cookie) > 0 ? Number(cookie) : undefined;
  if (cookieHandle === undefined) return { cookieHandle, cookieProjection: undefined };
  const cookieAsset = runtimeAssets(world.assets).resolveAsset<TextureAsset>(cookieHandle);
  const cookieProjection =
    cookieAsset.ok && cookieAsset.value.kind === 'texture'
      ? prepareCookieProjection(cookieAsset.value)
      : undefined;
  return { cookieHandle, cookieProjection };
}

/**
 * D-1: perspective(outerConeDeg*2, aspect=1, near, far) x lookAt(pos, pos+dir).
 * FOV = outerConeDeg * 2 in degrees; mat4.perspective takes fov in radians.
 */
function spotLightViewProjection(
  position: Vec3,
  direction: Vec3,
  outerConeDeg: number,
  nearPlane: number,
  farPlane: number,
): Float32Array {
  const target = vec3.create(
    (position[0] ?? 0) + (direction[0] ?? 0),
    (position[1] ?? 0) + (direction[1] ?? 0),
    (position[2] ?? 0) + (direction[2] ?? 0),
  );
  const fov = outerConeDeg * 2 * (Math.PI / 180);
  const proj = mat4.create();
  mat4.perspectiveReverseZ(proj, fov, 1, nearPlane, farPlane);
  const view = mat4.create();
  mat4.lookAt(view, position, target, vec3.create(0, 1, 0));
  const lightViewProj = new Float32Array(16);
  // Reinterpret the Float32Array surface field as a Mat4 out-param; a
  // factory would force a needless alloc+copy. brand-cast-ok
  mat4.multiply(lightViewProj as Mat4, proj, view);
  return lightViewProj;
}

/** Cookie and projector texture transport fields on a SpotLightSnapshot. */
function spotLightTextureFields(
  cookieHandle: number | undefined,
  cookieSlice: number | undefined,
  cookieProjection: ReturnType<typeof prepareCookieProjection> | undefined,
  projectorSlice: number | undefined,
  projectorProjection: ReturnType<typeof prepareCookieProjection> | undefined,
) {
  const cookieSource = cookieProjection?.source;
  const projectorSource = projectorProjection?.source;
  return {
    ...(cookieHandle === undefined
      ? {}
      : {
          cookieHandle,
          ...(cookieSlice === undefined ? {} : { cookieSlice }),
        }),
    ...(cookieSource === undefined ? {} : { cookieSource }),
    ...(cookieProjection === undefined ? {} : { cookieMatrix: cookieProjection.matrix }),
    ...(projectorSlice === undefined ? {} : { projectorSlice }),
    ...(projectorSource === undefined ? {} : { projectorSource }),
    ...(projectorProjection === undefined ? {} : { projectorMatrix: projectorProjection.matrix }),
  };
}

function spotProjectorIdentityFields(projector: ReturnType<typeof resolveSpotProjector>) {
  return projector === undefined
    ? {}
    : {
        projectorHandle: projector.handle,
        projectorAsset: projector.asset,
        projectorGuid: projector.guid,
        projectorGeneration: 1,
        projectorRevision: 1,
      };
}

function extractSpotLights(
  world: World,
  context: Pick<PreparedExtractContext, 'assets' | 'worldId'>,
  worldInternal: WorldInternalView,
  iesProfiles: Map<number, IesProfileSnapshot>,
  lightTextureSlices: Map<number, number>,
): SpotLightSnapshot[] {
  const spotSnapshots: SpotLightSnapshot[] = [];
  const spotLightQuery = world
    .query({
      read: [SpotLight],
      optional: [Transform, GlobalTransform],
    })
    .unwrap();
  for (const row of spotLightQuery) {
    const s = row.get(SpotLight);
    if (!admitLightChannels(worldInternal, s.lightingChannels, s.shadowCasterChannels)) continue;
    const worldMat =
      row.get(GlobalTransform) !== undefined
        ? copyPresentationWorldMatrix(world, row.entity)
        : undefined;
    const position = worldTranslationOf(worldMat);
    const { direction: dirN, valid: hasValidDirection } = normalizeSpotDirection(
      s.direction,
      worldInternal,
    );

    // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
    const castShadow = s.castShadow;
    const shadowProjection = resolvePunctualShadowFarPlane(s.range, s.nearPlane, s.farPlane);
    const sFarPlane = shadowProjection.ok ? shadowProjection.value : s.farPlane;
    const { cookieHandle, cookieProjection } = resolveSpotCookie(world, s.cookie);
    // `shared<T>` columns are u32-backed and zero-filled when the optional
    // field is absent. Treat only a positive handle as an authored projector;
    // checking nullish values alone would turn the zero sentinel into a
    // phantom projector matrix and an avoidable asset-not-found diagnostic.
    const hasProjector = Number(s.projector) > 0;
    const projector = hasProjector
      ? resolveSpotProjector(world, context.assets, worldInternal, s.projector)
      : undefined;
    const projectorProjection =
      projector === undefined ? undefined : prepareCookieProjection(projector.asset);
    const cookieSlice = assignLightTextureSlice(
      lightTextureSlices,
      cookieHandle,
      cookieProjection?.source,
    );
    const projectorSlice = assignLightTextureSlice(
      lightTextureSlices,
      projector === undefined ? undefined : Number(projector.handle),
      projectorProjection?.source,
    );
    let lightViewProj: Float32Array | undefined;

    // A projector needs the same perspective transform even when its SpotLight
    // has no shadow atlas tile. The matrix remains a derived light fact; the
    // shadow tile stays -1 so shadow visibility is still independently gated.
    const needsProjection = castShadow || hasProjector;
    if (needsProjection && !shadowProjection.ok) {
      routeExtractError(
        worldInternal,
        shadowProjection.error,
        'RenderSystem.extract (spot-shadow-projection)',
      );
    }
    if (needsProjection && hasValidDirection && shadowProjection.ok) {
      lightViewProj = spotLightViewProjection(
        position,
        dirN,
        s.outerConeDeg,
        s.nearPlane,
        sFarPlane,
      );
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
      color: scaledLightColor(s.color, s.intensity),
      intensity: s.intensity,
      invRangeSquared: computeInvRangeSquared(s.range),
      cosInner: degToCos(s.innerConeDeg),
      cosOuter: degToCos(s.outerConeDeg),
      ...resolveIesProfile(world, worldInternal, iesProfiles, s.iesProfile, row.entity),
      ...spotLightTextureFields(
        cookieHandle,
        cookieSlice,
        cookieProjection,
        projectorSlice,
        projectorProjection,
      ),
      rollDeg: s.rollDeg,
      // ── shadow fields ──
      castShadow,
      lightViewProj:
        s.shadowProjection === 1 ? new Float32Array(s.shadowViewProjection) : lightViewProj,
      mapSize: s.mapSize,
      nearPlane: s.nearPlane,
      farPlane: sFarPlane,
      // The Render World assigns each casting spot a stable tile.
      shadowAtlasTile: -1,
      shadowIntensity: s.shadowIntensity,
      shadowBlurSamples: s.shadowBlurSamples,
      depthBias: s.depthBias,
      normalBias: s.normalBias,
      shadowMapAspect: s.shadowMapAspect,
      shadowCasterChannels: s.shadowCasterChannels,
      shadowAutoUpdate: s.shadowAutoUpdate,
      shadowRevision: s.shadowRevision,
      pcfKernelSize: s.pcfKernelSize,
      shadowFilter: s.shadowFilter,
      shadowBiasMode: s.shadowBiasMode,
      ...spotProjectorIdentityFields(projector),
    });
  }
  return spotSnapshots;
}

/** RectAreaLight world frame; a light without a Transform column sits at the origin. */
function rectAreaWorldFrameOf(
  world: World,
  entity: EntityHandle,
  hasTransform: boolean,
  width: number,
  height: number,
) {
  const worldMat = hasTransform
    ? new Float32Array(readEnvironmentPose(world, entity) ?? [])
    : undefined;
  const position = worldTranslationOf(worldMat);
  const frame = buildRectAreaWorldFrame({
    center: position,
    axisX: [worldMat?.[0] ?? 1, worldMat?.[1] ?? 0, worldMat?.[2] ?? 0],
    axisY: [worldMat?.[4] ?? 0, worldMat?.[5] ?? 1, worldMat?.[6] ?? 0],
    width,
    height,
  });
  return { position, frame };
}

/** Resolves a RectAreaLight source texture into the shared light-texture array. */
function resolveRectSourceTexture(
  world: World,
  worldInternal: WorldInternalView,
  lightTextureSlices: Map<number, number>,
  sourceTexture: number,
) {
  const resolved = runtimeAssets(world.assets).resolveAsset<TextureAsset>(sourceTexture);
  const projection =
    resolved.ok && resolved.value.kind === 'texture'
      ? prepareCookieProjection(resolved.value)
      : undefined;
  if (projection === undefined) {
    routeExtractError(
      worldInternal,
      resolved.ok
        ? new RhiError({
            code: 'asset-not-registered',
            expected:
              'RectAreaLight.sourceTexture resolves to a 2D TextureAsset: uncompressed rgba8unorm[-srgb], bgra8unorm[-srgb], r8unorm, rgba16float, rgba32float, or a BC/ETC2/ASTC block format whose colorSpace matches its -srgb suffix',
            hint: 'assign a 2D image texture (not a cube, array or 3D texture) whose colorSpace matches its format before assigning RectAreaLight.sourceTexture; the light renders untextured until then',
            detail: { assetHandle: Number(sourceTexture) },
          })
        : resolved.error,
      'RenderSystem.extract (rect-source-texture)',
    );
  }
  const sourceTextureHandle = Number(sourceTexture);
  const sourceTextureSource = projection?.source;
  const sourceTextureSlice = assignLightTextureSlice(
    lightTextureSlices,
    sourceTextureHandle,
    sourceTextureSource,
  );
  return {
    sourceTextureHandle,
    ...(sourceTextureSlice === undefined || sourceTextureSource === undefined
      ? {}
      : { cookieSlice: sourceTextureSlice, cookieSource: sourceTextureSource }),
  };
}

function extractRectAreaLights(
  world: World,
  worldInternal: WorldInternalView,
  iesProfiles: Map<number, IesProfileSnapshot>,
  lightTextureSlices: Map<number, number>,
): RectAreaDirectLightSnapshot[] {
  const rectSnapshots: RectAreaDirectLightSnapshot[] = [];
  const rectLightQuery = world
    .query({
      read: [RectAreaLight],
      optional: [Transform, GlobalTransform],
    })
    .unwrap();
  for (const row of rectLightQuery) {
    const light = row.get(RectAreaLight);
    if (!admitLightChannels(worldInternal, light.lightingChannels)) continue;
    const validation = validateRectAreaLightData({
      intensity: light.intensity,
      color: light.color,
      width: light.width,
      height: light.height,
      range: light.range,
    });
    if (!validation.ok) {
      routeExtractError(worldInternal, validation.error, 'RenderSystem.extract (rect-area-light)');
      continue;
    }
    const { position, frame } = rectAreaWorldFrameOf(
      world,
      row.entity,
      row.get(GlobalTransform) !== undefined,
      light.width,
      light.height,
    );
    const sourceTexture =
      light.sourceTexture !== undefined && Number(light.sourceTexture) > 0
        ? resolveRectSourceTexture(world, worldInternal, lightTextureSlices, light.sourceTexture)
        : {};
    rectSnapshots.push({
      kind: 'rect-area',
      entity: row.entity,
      lightingChannels: light.lightingChannels,
      position,
      color: scaledLightColor(light.color, light.intensity),
      intensity: light.intensity,
      invRangeSquared: computeInvRangeSquared(light.range),
      halfWidth: frame.halfWidth,
      halfHeight: frame.halfHeight,
      axisX: frame.axisX,
      axisY: frame.axisY,
      ...resolveIesProfile(world, worldInternal, iesProfiles, light.iesProfile, row.entity),
      ...sourceTexture,
    });
  }
  return rectSnapshots;
}

/**
 * The SpotLight is the sole projector owner. Once all light snapshots have
 * been extracted, publish its accepted TextureAsset tuple on the volume
 * snapshot so surface and volume consume the same identity and revision.
 */
function attachVolumeSpotProjector(
  volumetricFog: ReturnType<typeof extractVolumeSnapshot>,
  spotSnapshots: readonly SpotLightSnapshot[],
): ReturnType<typeof extractVolumeSnapshot> {
  if (volumetricFog === undefined) return volumetricFog;
  let volumeSpot: SpotLightSnapshot | undefined;
  if (volumetricFog.spotLightEntity !== undefined) {
    volumeSpot = spotSnapshots.find((light) => light.entity === volumetricFog.spotLightEntity);
  } else if (volumetricFog.lightKind === 'spot') {
    volumeSpot = spotSnapshots.find((light) => light.entity === volumetricFog.lightEntity);
  }
  if (
    volumetricFog.status !== 'available' ||
    volumeSpot?.projectorAsset === undefined ||
    volumeSpot.projectorHandle === undefined
  ) {
    return volumetricFog;
  }
  const projectorHandle = volumeSpot.projectorHandle;
  return {
    ...volumetricFog,
    projector: {
      guid: volumeSpot.projectorGuid ?? `handle:${Number(projectorHandle)}`,
      generation: volumeSpot.projectorGeneration ?? 1,
      view: '2d',
      sampler: 'linear-clamp-to-edge',
      projection: 'spot-projection',
      revision: volumeSpot.projectorRevision ?? 1,
    },
    projectorHandle,
    projectorAsset: volumeSpot.projectorAsset,
  };
}

function directionalCsmConfigOf(
  sf: ReturnType<typeof directionalShadowFieldsOf>,
): DirectionalCsmConfig {
  return {
    ...(sf.shadowProjection === 1 ? { shadowViewProjection: sf.shadowViewProjection } : {}),
    shadowMapAspect: sf.shadowMapAspect,
    shadowCasterChannels: sf.shadowCasterChannels,
    shadowAutoUpdate: sf.shadowAutoUpdate,
    shadowRevision: sf.shadowRevision,
    shadowBiasMode: sf.shadowBiasMode,
    shadowRadius: sf.shadowRadius,
    shadowIntensity: sf.shadowIntensity,
    shadowBlurSamples: sf.shadowBlurSamples,
    cascadeCount: sf.cascadeCount,
    splitLambda: sf.splitLambda,
    cascadeBlend: sf.cascadeBlend,
    mapSize: sf.mapSize,
    shadowDistance: sf.shadowDistance,
    shadowFilter: sf.shadowFilter,
    shadowAngularRadius: sf.shadowAngularRadius,
    maxPenumbraTexels: sf.maxPenumbraTexels,
    ...(sf.staggerCascades ? { staggerCascades: true } : {}),
    ...(sf.staticShadowCache ? {} : { staticShadowCache: false as const }),
  };
}

/**
 * The shadow configuration and direction a view fits its cascades from,
 * gated on castShadow (default false, first hit wins) and a valid config.
 */
function directionalShadowSource(
  sun: DirectionalExtraction,
  shadowError: LightValidationError | undefined,
) {
  const { directional, shadowFields: sf } = sun;
  if (directional === undefined || sun.castShadow !== true || shadowError !== undefined) {
    return undefined;
  }
  if (sf === undefined) return undefined;
  return {
    directionalCsmConfig: directionalCsmConfigOf(sf),
    directionalCsmDirection: directional.direction,
  };
}

/** Six face view-projection matrices packed into Float32Array(96). */
function packPointShadowMatrices(lightPos: Vec3, nearPlane: number, farPlane: number) {
  const matrices = buildPointShadowMatrices(lightPos, nearPlane, farPlane);
  const packed = new Float32Array(96);
  for (let f = 0; f < 6; f++) {
    const m = matrices[f];
    if (m === undefined) continue;
    for (let k = 0; k < 16; k++) {
      packed[f * 16 + k] = m[k] ?? 0;
    }
  }
  return packed;
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-7 (plan-strategy §D-3,
 * requirements §5.3): query (PointLight + PointLightShadow + Transform)
 * archetype join. For each shadow caster, build 6 face VP matrices and pack
 * into Float32Array(96). Atlas layer is assigned in spawn order while the
 * renderer-owned atlas has capacity; the sentinel -1 is shader-side and
 * applies to non-admitted PointLightShadow requests as well.
 */
function extractPointShadows(
  world: World,
  worldId: PreparedExtractContext['worldId'],
  worldInternal: WorldInternalView,
): PointShadowSnapshot[] {
  const pointShadowSnapshots: PointShadowSnapshot[] = [];
  const pointShadowQuery = world
    .query({ read: [Transform, GlobalTransform, PointLightShadow, PointLight] })
    .unwrap();
  for (const row of pointShadowQuery) {
    const ps = row.get(PointLightShadow);
    const channelsError = validateChannelMask(ps.shadowCasterChannels, 'shadowCasterChannels');
    if (channelsError !== null) {
      routeExtractError(worldInternal, channelsError, 'RenderSystem.extract (shadow-channels)');
      continue;
    }
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
    const wRow = readEnvironmentPose(world, row.entity);
    if (wRow === undefined) continue;
    const lightPos =
      ps.shadowProjection === 1
        ? vec3.clone(ps.shadowPosition)
        : vec3.create(wRow[12] ?? 0, wRow[13] ?? 0, wRow[14] ?? 0);
    const projection = resolvePunctualShadowFarPlane(
      row.get(PointLight).range,
      ps.nearPlane,
      ps.farPlane,
    );
    if (!projection.ok) {
      routeExtractError(
        worldInternal,
        projection.error,
        'RenderSystem.extract (point-shadow-projection)',
      );
      continue;
    }
    const farPlane = projection.value;
    pointShadowSnapshots.push({
      entity: row.entity,
      worldId,
      position: lightPos,
      mapSize: ps.mapSize,
      nearPlane: ps.nearPlane,
      farPlane,
      depthBias: ps.depthBias,
      normalBias: ps.normalBias,
      shadowCasterChannels: ps.shadowCasterChannels,
      shadowAutoUpdate: ps.shadowAutoUpdate,
      shadowRevision: ps.shadowRevision,
      shadowFilter: ps.shadowFilter,
      shadowBiasMode: ps.shadowBiasMode,
      shadowIntensity: ps.shadowIntensity,
      pcfKernelSize: ps.pcfKernelSize ?? 3,
      // The Render World assigns each request a stable cube layer.
      shadowAtlasLayer: -1,
      shadowMatrices: packPointShadowMatrices(lightPos, ps.nearPlane, farPlane),
    });
  }
  return pointShadowSnapshots;
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
 * join pointShadow snapshots into the matching PointLightSnapshot so the
 * record stage threads `shadowNear + shadowFar` through the unified
 * direct-light metadata payload; the Render World stamps the light's stable
 * `shadowAtlasLayer`. Replaces the freshly-built snapshot in place; it is not
 * exposed elsewhere this frame yet.
 */
function joinPointShadowLayers(
  pointSnapshots: PointLightSnapshot[],
  pointSnapshotEntities: readonly number[],
  pointShadowSnapshots: readonly PointShadowSnapshot[],
): void {
  if (pointShadowSnapshots.length === 0) return;
  const shadowByEntity = new Map<number, PointShadowSnapshot>();
  for (const ps of pointShadowSnapshots) shadowByEntity.set(ps.entity, ps);
  for (let i = 0; i < pointSnapshots.length; i++) {
    const ps = shadowByEntity.get(pointSnapshotEntities[i] ?? 0);
    if (ps === undefined) continue;
    pointSnapshots[i] = {
      ...(pointSnapshots[i] as PointLightSnapshot),
      shadowAtlasLayer: ps.shadowAtlasLayer,
      shadowNear: ps.nearPlane,
      shadowFar: ps.farPlane,
      pcfKernelSize: ps.pcfKernelSize ?? 3,
    };
  }
}

/**
 * equirect is OPTIONAL: an omitted field zero-inits to handle 0, which record
 * treats as "no equirect" -> solid-color ambient via the white fallback cube.
 * A Skylight WITHOUT an equirect is still a valid snapshot (the prior
 * `equirectRaw !== undefined` gate dropped color-only skylights, leaving the
 * scene black -- the downstream gap #4).
 */
function skylightSnapshotOf(
  world: World,
  entity: EntityHandle,
  s: Readonly<ShapeOf<SchemaOf<typeof Skylight>>>,
): SkylightSnapshot {
  const captureWorld = readEnvironmentPose(world, entity);
  return {
    ...(captureWorld === undefined
      ? {}
      : {
          capturePosition: [
            captureWorld[12] ?? 0,
            captureWorld[13] ?? 0,
            captureWorld[14] ?? 0,
          ] as const,
        }),
    equirectHandle: s.equirect !== undefined ? Math.round(s.equirect) : 0,
    color: [s.color[0] ?? 1.0, s.color[1] ?? 1.0, s.color[2] ?? 1.0],
    groundColor: [s.groundColor[0] ?? 0, s.groundColor[1] ?? 0, s.groundColor[2] ?? 0],
    ambientIrradiance: [
      s.ambientIrradiance[0] ?? 0,
      s.ambientIrradiance[1] ?? 0,
      s.ambientIrradiance[2] ?? 0,
    ],
    intensity: s.intensity,
    rotation: quaternionOf(s.rotation),
    // w19: winning entity handle for the multi-Skylight once-warn (F-8).
    entityHandle: entity,
  };
}

/**
 * feat-20260520-skylight-ibl-cubemap M4 / t26+t27: first archetype hit wins
 * (mirrors DirectionalLight pattern); multi-Skylight warn in record stage
 * (t27) uses skylightCount.
 */
function extractSkylight(world: World) {
  const skylightQuery = world.query({ read: [Skylight], optional: [GlobalTransform] }).unwrap();
  let skylight: SkylightSnapshot | undefined;
  let skylightCount = 0;
  for (const row of skylightQuery) {
    skylightCount += 1;
    if (skylight === undefined) skylight = skylightSnapshotOf(world, row.entity, row.get(Skylight));
  }
  return { skylight, skylightCount };
}

function extractLightProbes(
  world: World,
  worldId: PreparedExtractContext['worldId'],
  worldInternal: WorldInternalView,
): LightProbeSnapshot[] {
  const lightProbeQuery = world.query({ read: [LightProbe, GlobalTransform] }).unwrap();
  const lightProbes: LightProbeSnapshot[] = [];
  for (const row of lightProbeQuery) {
    const probe = row.get(LightProbe);
    const validation = validateLightProbeData({
      irradiance: probe.irradiance,
      radius: probe.radius,
    });
    if (!validation.ok) {
      routeExtractError(worldInternal, validation.error, 'RenderSystem.extract (light-probe)');
      continue;
    }
    const transform = readEnvironmentPose(world, row.entity);
    if (transform === undefined) continue;
    lightProbes.push({
      identity: String(row.entity),
      worldId,
      position: [transform[12] ?? 0, transform[13] ?? 0, transform[14] ?? 0],
      radius: probe.radius,
      irradiance: new Float32Array(probe.irradiance),
      admitted: true,
    });
  }
  return lightProbes;
}

/**
 * feat-20260531-skybox-env-background M2 / w5: first archetype hit wins
 * (mirrors Skylight pattern); multi-entity once-warn in record stage uses
 * skyboxCount.
 */
function extractSkybox(world: World) {
  const skyboxQuery = world.query({ read: [SkyboxBackground] }).unwrap();
  let skybox: SkyboxSnapshot | undefined;
  let skyboxCount = 0;
  for (const row of skyboxQuery) {
    const s = row.get(SkyboxBackground);
    skyboxCount += 1;
    if (skybox === undefined && s.equirect !== undefined) {
      skybox = {
        equirectHandle: Math.round(s.equirect),
        mode: s.mode,
        rotation: quaternionOf(s.rotation),
        // w19: winning entity handle for the multi-SkyboxBackground warn (F-8).
        entityHandle: row.entity,
      };
    }
  }
  return { skybox, skyboxCount };
}

/** Every GradientSky owner; selection admits exactly one. */
function extractGradientSkies(world: World): GradientSkyFrame[] {
  const skies: GradientSkyFrame[] = [];
  for (const row of world.query({ read: [GradientSky] }).unwrap()) {
    const sky = row.get(GradientSky);
    skies.push({
      entityKey: row.entity,
      zenith: rgbTuple(sky.zenith),
      horizon: rgbTuple(sky.horizon),
      ground: rgbTuple(sky.ground),
      mid: rgbTuple(sky.mid),
      midHeight: sky.midHeight,
      exponent: sky.exponent,
      sunSize: sky.sunSize,
      sunGlow: sky.sunGlow,
      fogBlend: sky.fogBlend,
      toneMapped: sky.toneMapped,
    });
  }
  return skies;
}

function atmosphereParametersOf(
  value: Readonly<ShapeOf<SchemaOf<typeof Atmosphere>>>,
  atmosphereWorld: ArrayLike<number> | undefined,
  skylight: SkylightSnapshot | undefined,
) {
  const groundX = atmosphereWorld?.[12] ?? 0;
  const groundY = atmosphereWorld?.[13] ?? 0;
  const groundZ = atmosphereWorld?.[14] ?? 0;
  return {
    planetRadius: value.planetRadius,
    atmosphereHeight: value.atmosphereHeight,
    groundOrigin: [groundX, groundY, groundZ] as const,
    capturePosition: skylight?.capturePosition ?? ([groundX, groundY + 1, groundZ] as const),
    rayleighScattering: rgbTuple(value.rayleighScattering),
    rayleighScaleHeight: value.rayleighScaleHeight,
    mieScattering: value.mieScattering,
    mieAbsorption: value.mieAbsorption,
    mieScaleHeight: value.mieScaleHeight,
    mieAnisotropy: value.mieAnisotropy,
    absorption: rgbTuple(value.absorption),
    absorptionPeakHeight: value.absorptionPeakHeight,
    absorptionHalfWidth: value.absorptionHalfWidth,
    groundAlbedo: rgbTuple(value.groundAlbedo),
    multipleScattering: value.multipleScattering,
    sunAngularRadius: value.sunAngularRadius,
    aerialPerspectiveStart: value.aerialPerspectiveStart,
    aerialPerspectiveDistanceScale: value.aerialPerspectiveDistanceScale,
  } as const;
}

function environmentCandidatesOf(
  world: World,
  skylight: SkylightSnapshot | undefined,
  skybox: SkyboxSnapshot | undefined,
): EnvironmentCandidate[] {
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
    environmentCandidates.push({
      kind: 'atmosphere',
      entityKey: row.entity,
      sourceKey: `atmosphere:${row.entity}`,
      atmosphere: atmosphereParametersOf(
        row.get(Atmosphere),
        readEnvironmentPose(world, row.entity),
        skylight,
      ),
    });
  }
  return environmentCandidates;
}

/** Sun color is the light color with its pre-multiplied intensity divided back out. */
function sunColorOf(directional: DirectionalLightSnapshot): [number, number, number] {
  const sunIntensity = directional.intensity;
  return sunIntensity > 0
    ? [
        (directional.color[0] ?? 0) / sunIntensity,
        (directional.color[1] ?? 0) / sunIntensity,
        (directional.color[2] ?? 0) / sunIntensity,
      ]
    : [0, 0, 0];
}

/** The environment sun points toward the light: the negated, normalized light direction. */
function sunCandidatesOf(directional: DirectionalLightSnapshot | undefined) {
  if (directional === undefined || directional.entity === undefined) return [];
  const direction = directional.direction;
  const length = Math.hypot(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0);
  if (length <= 1e-6) return [];
  return [
    {
      entityKey: directional.entity,
      direction: [
        -(direction[0] ?? 0) / length,
        -(direction[1] ?? 0) / length,
        -(direction[2] ?? 0) / length,
      ] as [number, number, number],
      color: sunColorOf(directional),
      intensity: directional.intensity,
    },
  ];
}

function selectWorldEnvironment(
  world: World,
  skylight: SkylightSnapshot | undefined,
  skybox: SkyboxSnapshot | undefined,
  directional: DirectionalLightSnapshot | undefined,
  fog: ExtractedFrame['fog'],
): EnvironmentFrame {
  const environmentSelection = selectEnvironment({
    environments: environmentCandidatesOf(world, skylight, skybox),
    fogs: fog === undefined ? [] : [fog],
    suns: sunCandidatesOf(directional),
    skies: extractGradientSkies(world),
    skyboxBackground: skybox !== undefined,
  });
  if (!environmentSelection.ok) {
    routeWorldError(world, environmentSelection.error, {
      systemName: 'RenderSystem.extract (environment-selection)',
    });
    throw environmentSelection.error;
  }
  return environmentSelection.value;
}
