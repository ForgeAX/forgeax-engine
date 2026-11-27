import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type {
  Component,
  EntityHandle,
  QuerySpan,
  SchemaOf,
  ShapeOf,
  World,
} from '@forgeax/engine-ecs';
import { readRenderArrayView, routeWorldError } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { createPresentationMatrixReader } from '@forgeax/engine-scene/internal';
import type { AssetHandle, IesProfileAsset, TextureAsset } from '@forgeax/engine-types';
import { packedPointShadowMatrices } from '../capture/cube-views';
import { type ExtractedCloudLayer, extractStandardCloudLayer } from '../cloud/extract';
import { selectCloudLightingEnvironment } from '../cloud/lighting/environment';
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
import { RenderFeatureEnvironment } from '../components/render-feature-environment';
import {
  RenderTargetEnvironment,
  type RenderTargetEnvironmentSource,
} from '../components/render-target-environment';
import { selectEnvironment } from '../environment/frame';
import { SpawnLightInvalidBoundsError } from '../errors/component-validation';
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
  buildRectAreaWorldFrame,
  collectCubeCameraSnapshots,
  collectReflectionProbeFacts,
  type createWorldInternalView,
  extractVolumeSnapshot,
  Severity,
  selectCameraRoles,
} from '../render-system-extract';
import type { EnvironmentLightingReader } from './environment-frame-gate';
import {
  createEnvironmentQuery,
  noteEnvironmentPose,
  readEnvironmentPose,
} from './environment-gate';

const extractDirectionalLightsQuery = createEnvironmentQuery({ read: [DirectionalLight] });
const extractPointLightsQuery = createEnvironmentQuery({ read: [PointLight] });
const extractSpotLightsQuery = createEnvironmentQuery({
  read: [SpotLight],
  optional: [Transform, GlobalTransform],
});
const extractRectAreaLightsQuery = createEnvironmentQuery({
  read: [RectAreaLight],
  optional: [Transform, GlobalTransform],
});
const extractPointShadowsQuery = createEnvironmentQuery({
  read: [Transform, GlobalTransform, PointLightShadow, PointLight],
});
const extractSkylightQuery = createEnvironmentQuery({
  read: [Skylight],
  optional: [GlobalTransform],
});
const extractLightProbesQuery = createEnvironmentQuery({ read: [LightProbe, GlobalTransform] });
const extractSkyboxQuery = createEnvironmentQuery({ read: [SkyboxBackground] });
const environmentCandidatesOfQuery = createEnvironmentQuery({
  read: [Atmosphere],
  optional: [GlobalTransform],
});

type WorldInternalView = ReturnType<typeof createWorldInternalView>;
type RgbTuple = readonly [number, number, number];

/** Produces light, camera and atmosphere facts once, before renderable projection. */
export function extractWorldEnvironment(
  world: World,
  context: Pick<
    PreparedExtractContext,
    'assets' | 'cameraEntityKey' | 'view' | 'environmentLightingOnly' | 'cameraSource'
  > & {
    readonly environmentGate?: EnvironmentLightingReader;
  },
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

  const cameraRoles = selectCameraRoles(
    world,
    context.cameraEntityKey,
    context.view,
    context.cameraSource ?? (context.environmentLightingOnly ? undefined : context.environmentGate),
  );
  const cameras = [...cameraRoles.display];
  const auxiliaryCameras = cameraRoles.auxiliary;
  const cubeCameras = collectCubeCameraSnapshots(world);
  const reflectionProbes = collectReflectionProbeFacts(world);

  // Three-query union (M2 / w16 / AC-03): directional has no Transform
  // dependency (sun-like infinite-source semantics); point + spot pull
  // position from the companion Transform via the joined queries.
  // Host-side pre-multiplication: color *= intensity (charter P4); cone
  // deg -> cos (D-S2); range -> 1/range^2 (D-S5).
  const lighting =
    context.environmentGate === undefined
      ? extractWorldLighting(world, context, worldInternal)
      : context.environmentGate.readLighting(world, (routedError) => ({
          value: extractWorldLighting(world, context, {
            ...worldInternal,
            _routeError(error, errorContext) {
              routedError();
              worldInternal._routeError(error, errorContext);
            },
          }),
          timeDependent: false,
        }));
  const { lights, spotSnapshots, directional } = lighting;
  const volumetricFog = attachVolumeSpotProjector(volumetricFogSource, spotSnapshots);

  // A caster may be outside the display camera while still contributing to a
  // light's shadow map. Keep the light-space visibility projection alongside
  // camera culling so the direct extraction path and persistent composition
  // retain the same shadow-only rule.
  const { skylight, skylightCount } = extractSkylight(world);
  const lightProbes = extractLightProbes(world, worldInternal);
  const { skybox, skyboxCount } = extractSkybox(world);
  const environment = selectWorldEnvironment(world, skylight, skybox, directional, fog);

  return {
    cameras,
    auxiliaryCameras,
    cubeCameras,
    reflectionProbes,
    lights,
    environment,
    volumetricFog,
    cloudLayer:
      cloudLayer === undefined
        ? cloudLayer
        : {
            ...cloudLayer,
            lightEnvironment: selectCloudLightingEnvironment(
              environment.source.kind === 'atmosphere',
              skylight,
              environment.source.kind === 'atmosphere' && directional !== undefined
                ? {
                    atmosphere: environment.source.atmosphere,
                    directionToLight: [
                      -(directional.direction[0] ?? 0),
                      -(directional.direction[1] ?? 0),
                      -(directional.direction[2] ?? 0),
                    ],
                  }
                : undefined,
            ),
          },
    skylight,
    skylightCount,
    lightProbes,
    skybox,
    skyboxCount,
  };
}

export interface WorldLightingPart {
  readonly lights: LightRoster;
  readonly spotSnapshots: SpotLightSnapshot[];
  readonly directional: DirectionalLightSnapshot | undefined;
}

/** Light content changes independently of the display camera's pose. */
function extractWorldLighting(
  world: World,
  context: Pick<PreparedExtractContext, 'assets'> & {
    readonly environmentGate?: EnvironmentLightingReader;
  },
  worldInternal: WorldInternalView,
): WorldLightingPart {
  const sun = extractDirectionalLights(world, worldInternal);
  const directionalShadowError = validateDirectionalShadow(sun, worldInternal);

  const iesProfiles = new Map<number, IesProfileSnapshot>();
  // Spot Cookies, Spot projectors, and RectAreaLight source textures share
  // one light-texture array. A slice is keyed by the TextureAsset handle, so
  // every consumer of the same asset reads the same prepared mip chain.
  const lightTextureSlices = new Map<number, number>();
  const cache = sourceLightingCache(world, context.environmentGate);
  const points = extractPointLights(world, worldInternal, iesProfiles, cache);
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

  const directionalShadow = directionalShadowSource(sun, directionalShadowError);
  const pointShadowSnapshots = extractPointShadows(world, worldInternal, cache);
  const castsShadow = sun.castShadow === true;

  const lights: LightRoster = {
    directional: sun.directional,
    directionalCount: sun.directionalCount,
    additionalDirectional: sun.additional,
    ignoredDirectionalShadowCasters: sun.ignoredShadowCasters,
    point: joinPointShadowLayers(points, pointShadowSnapshots),
    spot: spotSnapshots,
    rect: rectSnapshots,
    depthBias: castsShadow ? sun.shadowFields?.depthBias : undefined,
    normalBias: castsShadow ? sun.shadowFields?.normalBias : undefined,
    directionalShadowError,
    pointShadow: pointShadowSnapshots,
    directionalCsmConfig: directionalShadow?.directionalCsmConfig,
    directionalCsmDirection: directionalShadow?.directionalCsmDirection,
  };

  return { lights, spotSnapshots, directional: sun.directional };
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
  const extractedCloudLayer = extractStandardCloudLayer(world);
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
function scaledLightColor(
  world: World,
  entity: EntityHandle,
  component: Component,
  intensity: number,
): Vec3 {
  return vec3.create(
    (world[worldRead].getArrayElement(entity, component, 'color', 0) as number) * intensity,
    (world[worldRead].getArrayElement(entity, component, 'color', 1) as number) * intensity,
    (world[worldRead].getArrayElement(entity, component, 'color', 2) as number) * intensity,
  );
}

/** A light archetype without a Transform column sits at the origin. */
function worldTranslationOf(worldMat: Float32Array | undefined): Vec3 {
  return worldMat !== undefined
    ? mat4.getTranslation(vec3.create(), worldMat)
    : vec3.create(0, 0, 0);
}

function quaternionTuple(values: ArrayLike<number>): [number, number, number, number] {
  return [values[0] as number, values[1] as number, values[2] as number, values[3] as number];
}

function rgbTuple(values: ArrayLike<number>): RgbTuple {
  return [values[0] as number, values[1] as number, values[2] as number];
}

type DirectionalColumns = ReturnType<QuerySpan<readonly [typeof DirectionalLight]>['get']>;

function directionalShadowFieldsOf(columns: DirectionalColumns, row: number) {
  const projection = columns.shadowProjection[row] as number;
  return {
    cascadeCount: columns.cascadeCount[row] as number,
    splitLambda: columns.splitLambda[row] as number,
    cascadeBlend: columns.cascadeBlend[row] as number,
    mapSize: columns.mapSize[row] as number,
    depthBias: columns.depthBias[row] as number,
    normalBias: columns.normalBias[row] as number,
    shadowDistance: columns.shadowDistance[row] as number,
    shadowFilter: columns.shadowFilter[row] as number,
    shadowAngularRadius: columns.shadowAngularRadius[row] as number,
    maxPenumbraTexels: columns.maxPenumbraTexels[row] as number,
    shadowMapAspect: columns.shadowMapAspect[row] as number,
    shadowCasterChannels: columns.shadowCasterChannels[row] as number,
    shadowAutoUpdate: columns.shadowAutoUpdate[row] === 1,
    shadowRevision: columns.shadowRevision[row] as number,
    staggerCascades: columns.staggerCascades[row] === 1,
    staticShadowCache: columns.staticShadowCache[row] === 1,
    shadowProjection: projection,
    shadowViewProjection:
      projection === 1 ? columns.shadowViewProjection.slice(row * 16, row * 16 + 16) : undefined,
    shadowBiasMode: columns.shadowBiasMode[row] as number,
    shadowRadius: columns.shadowRadius[row] as number,
    shadowIntensity: columns.shadowIntensity[row] as number,
  };
}

/**
 * The sun lane (View sun, CSM, contact shadows, atmosphere) goes to the first
 * admitted DirectionalLight with castShadow; without one, to the first
 * admitted light. Every other light is an unshadowed Cluster member, as in
 * Three.js where only castShadow lights own a shadow map, so entity order
 * never decides which light shadows. There is one CSM: further castShadow
 * lights are reported as `ignoredDirectionalShadowCasters` for the record-stage warn.
 */
function extractDirectionalLights(world: World, worldInternal: WorldInternalView) {
  let primary: DirectionalLightSnapshot | undefined;
  let shadowFields: ReturnType<typeof directionalShadowFieldsOf> | undefined;
  const additional: DirectionalLightSnapshot[] = [];
  const ignoredShadowCasters: EntityHandle[] = [];
  let count = 0;
  for (const span of extractDirectionalLightsQuery(world).unwrap().spans().unwrap()) {
    const entities = span.entities;
    const columns = span.get(DirectionalLight);
    for (let row = 0; row < entities.length; row++) {
      const channels = columns.lightingChannels[row] as number;
      if (!admitLightChannels(worldInternal, channels, columns.shadowCasterChannels[row] as number))
        continue;
      const entity = entities[row] as EntityHandle;
      const offset = row * 3;
      const intensity = columns.intensity[row] as number;
      const snapshot: DirectionalLightSnapshot = {
        kind: 'directional',
        lightingChannels: channels,
        entity,
        direction: vec3.create(
          columns.direction[offset] as number,
          columns.direction[offset + 1] as number,
          columns.direction[offset + 2] as number,
        ),
        color: vec3.create(
          (columns.color[offset] as number) * intensity,
          (columns.color[offset + 1] as number) * intensity,
          (columns.color[offset + 2] as number) * intensity,
        ),
        intensity,
        perPixelAtmosphereTransmittance: columns.perPixelAtmosphereTransmittance[row] === 1,
        contactShadowLength: columns.contactShadowLength[row] as number,
        sourceAngle: columns.sourceAngle[row] as number,
      };
      count++;
      const casts = columns.castShadow[row] === 1;
      if (casts && primary === undefined) {
        primary = snapshot;
        shadowFields = directionalShadowFieldsOf(columns, row);
      } else {
        additional.push(snapshot);
        if (casts) ignoredShadowCasters.push(entity);
      }
    }
  }
  return {
    directional: primary ?? additional.shift(),
    additional,
    directionalCount: count,
    castShadow: primary !== undefined,
    shadowFields,
    ignoredShadowCasters,
  };
}

type DirectionalExtraction = ReturnType<typeof extractDirectionalLights>;

function validateDirectionalShadow(
  sun: DirectionalExtraction,
  worldInternal: WorldInternalView,
): LightValidationError | undefined {
  if (sun.directional === undefined) return undefined;
  const validation = validateDirectionalLightData({
    direction: sun.directional.direction,
    contactShadowLength: sun.directional.contactShadowLength,
    sourceAngle: sun.directional.sourceAngle,
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
function iesAxesOf(worldMat: ArrayLike<number> | undefined, offset: number) {
  const x = vec3.create(
    worldMat?.[offset] ?? 1,
    worldMat?.[offset + 1] ?? 0,
    worldMat?.[offset + 2] ?? 0,
  );
  const y = vec3.create(
    worldMat?.[offset + 4] ?? 0,
    worldMat?.[offset + 5] ?? 1,
    worldMat?.[offset + 6] ?? 0,
  );
  return { axisX: vec3.normalize(x, x), axisY: vec3.normalize(y, y) };
}

interface SourceLightingCache {
  readonly world: World;
  points: readonly PointLightSnapshot[];
  pose?: ReturnType<typeof createPresentationMatrixReader>;
  shadowFrame: number;
  shadows?: Map<number, PackedPointShadow>;
}
const sourceLightingCaches = new WeakMap<EnvironmentLightingReader, SourceLightingCache>();

function sourceLightingCache(
  world: World,
  owner: EnvironmentLightingReader | undefined,
): SourceLightingCache {
  const previous = owner === undefined ? undefined : sourceLightingCaches.get(owner);
  if (previous?.world === world) return previous;
  const cache: SourceLightingCache = { world, points: [], shadowFrame: 0 };
  if (owner !== undefined) sourceLightingCaches.set(owner, cache);
  return cache;
}

function projectedPointVector(previous: Vec3 | undefined, x: number, y: number, z: number): Vec3 {
  if (
    previous &&
    Object.is(previous[0], x) &&
    Object.is(previous[1], y) &&
    Object.is(previous[2], z)
  )
    return previous;
  return vec3.create(x, y, z);
}

/** Publish immutable rows in query order. An ordinary edit replaces only its row. */
function extractPointLights(
  world: World,
  worldInternal: WorldInternalView,
  iesProfiles: Map<number, IesProfileSnapshot>,
  owner: SourceLightingCache,
): readonly PointLightSnapshot[] {
  const previous = owner.points;
  let next: PointLightSnapshot[] | undefined;
  let reordered: Map<number, PointLightSnapshot> | undefined;
  let count = 0;
  for (const span of extractPointLightsQuery(world).unwrap().spans().unwrap()) {
    const entities = span.entities;
    const columns = span.get(PointLight);
    const hasGlobal = world.hasComponent(entities[0] as EntityHandle, GlobalTransform);
    if (hasGlobal) owner.pose ??= createPresentationMatrixReader(world);
    const reader = hasGlobal ? owner.pose : undefined;
    for (let row = 0; row < entities.length; row++) {
      const entity = entities[row] as EntityHandle;
      const sourceDecay = columns.decay[row] as number;
      const decayError = validatePointLightDecay(sourceDecay);
      if (decayError !== null) {
        routeExtractError(worldInternal, decayError, 'RenderSystem.extract (point-light-decay)');
        continue;
      }
      const channels = columns.lightingChannels[row] as number;
      if (!admitLightChannels(worldInternal, channels)) continue;
      noteEnvironmentPose(entity);
      const pose = reader?.locate(entity) ? reader.values : undefined;
      const offset = reader?.offset ?? 0;
      const x = pose?.[offset + 12] ?? 0;
      const y = pose?.[offset + 13] ?? 0;
      const z = pose?.[offset + 14] ?? 0;
      const intensity = columns.intensity[row] as number;
      const rgb = row * 3;
      const r = Math.fround((columns.color[rgb] as number) * intensity);
      const g = Math.fround((columns.color[rgb + 1] as number) * intensity);
      const b = Math.fround((columns.color[rgb + 2] as number) * intensity);
      const decay = Math.fround(sourceDecay);
      const invRangeSquared = computeInvRangeSquared(columns.range[row] as number);
      const profile = columns.iesProfile.get(row);
      let snapshot = previous[count];
      if (snapshot !== undefined && snapshot.entity !== entity && reordered === undefined) {
        reordered = new Map();
        for (const light of previous) reordered.set(light.entity as number, light);
      }
      if (snapshot?.entity !== entity) snapshot = reordered?.get(entity);
      const position = projectedPointVector(snapshot?.position, x, y, z);
      const color = projectedPointVector(snapshot?.color, r, g, b);
      if (
        profile ||
        snapshot === undefined ||
        snapshot.iesProfileHandle !== undefined ||
        snapshot.position !== position ||
        snapshot.color !== color ||
        !Object.is(snapshot.intensity, intensity) ||
        !Object.is(snapshot.decay, decay) ||
        !Object.is(snapshot.lightingChannels, channels) ||
        !Object.is(snapshot.invRangeSquared, invRangeSquared)
      ) {
        const axes = profile ? iesAxesOf(pose, offset) : undefined;
        snapshot = {
          kind: 'point',
          entity,
          position,
          color,
          intensity,
          decay,
          lightingChannels: channels,
          invRangeSquared,
          ...(profile
            ? resolveIesProfile(world, worldInternal, iesProfiles, profile, entity)
            : undefined),
          ...axes,
        };
      }
      if (next === undefined && snapshot !== previous[count]) next = previous.slice(0, count);
      next?.push(snapshot);
      count++;
    }
  }
  owner.points = next ?? (count === previous.length ? previous : previous.slice(0, count));
  return owner.points;
}

/**
 * Extract is the single direction-normalization owner for direct-light
 * snapshots. URP and HDRP preserve this value downstream. A degenerate
 * direction is routed and kept unnormalized; it skips the shadow projection.
 */
function normalizeSpotDirection(
  direction: ArrayLike<number>,
  offset: number,
  worldInternal: WorldInternalView,
) {
  const x = direction[offset] ?? 0;
  const y = direction[offset + 1] ?? -1;
  const z = direction[offset + 2] ?? 0;
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
  context: Pick<PreparedExtractContext, 'assets'>,
  worldInternal: WorldInternalView,
  iesProfiles: Map<number, IesProfileSnapshot>,
  lightTextureSlices: Map<number, number>,
): SpotLightSnapshot[] {
  const spotSnapshots: SpotLightSnapshot[] = [];
  const spotLightQuery = extractSpotLightsQuery(world).unwrap();
  for (const batch of spotLightQuery.batches().unwrap()) {
    const entities = batch.entities;
    const rows = batch.kind === 'indexed' ? batch.rows : undefined;
    const first = batch.kind === 'range' ? batch.start : 0;
    const hasWorld = batch.read(GlobalTransform, 'world') !== undefined;
    const lightingChannelsColumn = batch.read(SpotLight, 'lightingChannels');
    const shadowCasterChannelsColumn = batch.read(SpotLight, 'shadowCasterChannels');
    const castShadowColumn = batch.read(SpotLight, 'castShadow');
    const rangeColumn = batch.read(SpotLight, 'range');
    const decayColumn = batch.read(SpotLight, 'decay');
    const nearPlaneColumn = batch.read(SpotLight, 'nearPlane');
    const farPlaneColumn = batch.read(SpotLight, 'farPlane');
    const outerConeDegColumn = batch.read(SpotLight, 'outerConeDeg');
    const intensityColumn = batch.read(SpotLight, 'intensity');
    const innerConeDegColumn = batch.read(SpotLight, 'innerConeDeg');
    const rollDegColumn = batch.read(SpotLight, 'rollDeg');
    const mapSizeColumn = batch.read(SpotLight, 'mapSize');
    const shadowIntensityColumn = batch.read(SpotLight, 'shadowIntensity');
    const depthBiasColumn = batch.read(SpotLight, 'depthBias');
    const normalBiasColumn = batch.read(SpotLight, 'normalBias');
    const shadowMapAspectColumn = batch.read(SpotLight, 'shadowMapAspect');
    const shadowAutoUpdateColumn = batch.read(SpotLight, 'shadowAutoUpdate');
    const shadowRevisionColumn = batch.read(SpotLight, 'shadowRevision');
    const pcfKernelSizeColumn = batch.read(SpotLight, 'pcfKernelSize');
    const staticShadowCacheColumn = batch.read(SpotLight, 'staticShadowCache');
    const shadowFilterColumn = batch.read(SpotLight, 'shadowFilter');
    const shadowBiasModeColumn = batch.read(SpotLight, 'shadowBiasMode');
    const shadowProjectionColumn = batch.read(SpotLight, 'shadowProjection');
    const colorColumn = batch.read(SpotLight, 'color');
    const directionColumn = batch.read(SpotLight, 'direction');
    for (let ordinal = 0; ordinal < batch.count; ordinal++) {
      const physicalRow = rows === undefined ? first + ordinal : (rows[ordinal] as number);
      const entity = entities[physicalRow] as EntityHandle;
      const vectorOffset = physicalRow * 3;
      const sLightingChannels = lightingChannelsColumn[physicalRow] as number;
      const sShadowCasterChannels = shadowCasterChannelsColumn[physicalRow] as number;
      const sCastShadow = castShadowColumn[physicalRow] === 1;
      const sRange = rangeColumn[physicalRow] as number;
      const sDecay = decayColumn[physicalRow] as number;
      const decayError = validatePointLightDecay(sDecay, 'SpotLight');
      if (decayError !== null) {
        routeExtractError(worldInternal, decayError, 'RenderSystem.extract (spot-light-decay)');
        continue;
      }
      const sNearPlane = nearPlaneColumn[physicalRow] as number;
      const authoredFarPlane = farPlaneColumn[physicalRow] as number;
      const sCookie = world[worldRead].getFieldValue(entity, SpotLight, 'cookie') as number;
      const sProjector = world[worldRead].getFieldValue(entity, SpotLight, 'projector') as number;
      const sOuterConeDeg = outerConeDegColumn[physicalRow] as number;
      const sIntensity = intensityColumn[physicalRow] as number;
      const sInnerConeDeg = innerConeDegColumn[physicalRow] as number;
      const sIesProfile = world[worldRead].getFieldValue(entity, SpotLight, 'iesProfile') as number;
      const sRollDeg = rollDegColumn[physicalRow] as number;
      const sShadowProjection = shadowProjectionColumn[physicalRow] as number;
      const sMapSize = mapSizeColumn[physicalRow] as number;
      const sShadowIntensity = shadowIntensityColumn[physicalRow] as number;
      const sDepthBias = depthBiasColumn[physicalRow] as number;
      const sNormalBias = normalBiasColumn[physicalRow] as number;
      const sShadowMapAspect = shadowMapAspectColumn[physicalRow] as number;
      const sShadowAutoUpdate = shadowAutoUpdateColumn[physicalRow] === 1;
      const sShadowRevision = shadowRevisionColumn[physicalRow] as number;
      const sPcfKernelSize = pcfKernelSizeColumn[physicalRow] as number;
      const sShadowFilter = shadowFilterColumn[physicalRow] as number;
      const sShadowBiasMode = shadowBiasModeColumn[physicalRow] as number;
      if (!admitLightChannels(worldInternal, sLightingChannels, sShadowCasterChannels)) continue;
      const pose = hasWorld ? readEnvironmentPose(world, entity) : undefined;
      const position =
        pose === undefined
          ? vec3.create(0, 0, 0)
          : vec3.create(pose[12] as number, pose[13] as number, pose[14] as number);
      const { direction: dirN, valid: hasValidDirection } = normalizeSpotDirection(
        directionColumn,
        vectorOffset,
        worldInternal,
      );

      // ── shadow fields (feat-20260625-spot-light-shadow-mapping M1) ──
      const castShadow = sCastShadow;
      const shadowProjection = resolvePunctualShadowFarPlane(sRange, sNearPlane, authoredFarPlane);
      const sFarPlane = shadowProjection.ok ? shadowProjection.value : authoredFarPlane;
      const { cookieHandle, cookieProjection } = resolveSpotCookie(world, sCookie);
      // `shared<T>` columns are u32-backed and zero-filled when the optional
      // field is absent. Treat only a positive handle as an authored projector;
      // checking nullish values alone would turn the zero sentinel into a
      // phantom projector matrix and an avoidable asset-not-found diagnostic.
      const hasProjector = Number(sProjector) > 0;
      const projector = hasProjector
        ? resolveSpotProjector(world, context.assets, worldInternal, sProjector)
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
      if (sShadowProjection === 1) {
        lightViewProj = new Float32Array(
          readRenderArrayView(world, entity, SpotLight, 'shadowViewProjection') as Float32Array,
        );
      } else if (needsProjection && hasValidDirection && shadowProjection.ok) {
        lightViewProj = spotLightViewProjection(
          position,
          dirN,
          sOuterConeDeg,
          sNearPlane,
          sFarPlane,
        );
      }

      spotSnapshots.push({
        kind: 'spot',
        lightingChannels: sLightingChannels,
        entity,
        // D-6: position reflects world transform; direction stays sourced
        // from SpotLight.direction (NOT rotated by the parent).
        position,
        direction: dirN,
        color: vec3.create(
          (colorColumn[vectorOffset] as number) * sIntensity,
          (colorColumn[vectorOffset + 1] as number) * sIntensity,
          (colorColumn[vectorOffset + 2] as number) * sIntensity,
        ),
        intensity: sIntensity,
        invRangeSquared: computeInvRangeSquared(sRange),
        decay: Math.fround(sDecay),
        cosInner: degToCos(sInnerConeDeg),
        cosOuter: degToCos(sOuterConeDeg),
        ...resolveIesProfile(world, worldInternal, iesProfiles, sIesProfile, entity),
        ...spotLightTextureFields(
          cookieHandle,
          cookieSlice,
          cookieProjection,
          projectorSlice,
          projectorProjection,
        ),
        rollDeg: sRollDeg,
        // ── shadow fields ──
        castShadow,
        lightViewProj,
        ...(sShadowProjection === 1 ? { authoredShadowMatrix: true as const } : {}),
        mapSize: sMapSize,
        nearPlane: sNearPlane,
        farPlane: sFarPlane,
        // The Render World assigns each casting spot a stable tile.
        shadowAtlasTile: -1,
        shadowIntensity: sShadowIntensity,
        depthBias: sDepthBias,
        normalBias: sNormalBias,
        shadowMapAspect: sShadowMapAspect,
        shadowCasterChannels: sShadowCasterChannels,
        shadowAutoUpdate: sShadowAutoUpdate,
        ...(staticShadowCacheColumn[physicalRow] === 1 ? { staticShadowCache: true as const } : {}),
        shadowRevision: sShadowRevision,
        pcfKernelSize: sPcfKernelSize,
        shadowFilter: sShadowFilter,
        shadowBiasMode: sShadowBiasMode,
        ...spotProjectorIdentityFields(projector),
      });
    }
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
  const rectLightQuery = extractRectAreaLightsQuery(world).unwrap();
  for (const row of rectLightQuery) {
    const lightLightingChannels = world[worldRead].getFieldValue(
      row.entity,
      RectAreaLight,
      'lightingChannels',
    ) as number;
    const lightIntensity = world[worldRead].getFieldValue(
      row.entity,
      RectAreaLight,
      'intensity',
    ) as number;
    const lightWidth = world[worldRead].getFieldValue(row.entity, RectAreaLight, 'width') as number;
    const lightHeight = world[worldRead].getFieldValue(
      row.entity,
      RectAreaLight,
      'height',
    ) as number;
    const lightRange = world[worldRead].getFieldValue(row.entity, RectAreaLight, 'range') as number;
    const lightSourceTexture = world[worldRead].getFieldValue(
      row.entity,
      RectAreaLight,
      'sourceTexture',
    ) as ShapeOf<SchemaOf<typeof RectAreaLight>>['sourceTexture'];
    const lightIesProfile = world[worldRead].getFieldValue(
      row.entity,
      RectAreaLight,
      'iesProfile',
    ) as ShapeOf<SchemaOf<typeof RectAreaLight>>['iesProfile'];
    if (!admitLightChannels(worldInternal, lightLightingChannels)) continue;
    const validation = validateRectAreaLightData({
      intensity: lightIntensity,
      color: readRenderArrayView(world, row.entity, RectAreaLight, 'color') as Float32Array,
      width: lightWidth,
      height: lightHeight,
      range: lightRange,
    });
    if (!validation.ok) {
      routeExtractError(worldInternal, validation.error, 'RenderSystem.extract (rect-area-light)');
      continue;
    }
    const { position, frame } = rectAreaWorldFrameOf(
      world,
      row.entity,
      row.has(GlobalTransform),
      lightWidth,
      lightHeight,
    );
    const sourceTexture =
      lightSourceTexture !== undefined && Number(lightSourceTexture) > 0
        ? resolveRectSourceTexture(world, worldInternal, lightTextureSlices, lightSourceTexture)
        : {};
    rectSnapshots.push({
      kind: 'rect-area',
      entity: row.entity,
      lightingChannels: lightLightingChannels,
      position,
      color: scaledLightColor(world, row.entity, RectAreaLight, lightIntensity),
      intensity: lightIntensity,
      invRangeSquared: computeInvRangeSquared(lightRange),
      halfWidth: frame.halfWidth,
      halfHeight: frame.halfHeight,
      axisX: frame.axisX,
      axisY: frame.axisY,
      ...resolveIesProfile(world, worldInternal, iesProfiles, lightIesProfile, row.entity),
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
    ...(sf.shadowViewProjection === undefined
      ? {}
      : { shadowViewProjection: sf.shadowViewProjection }),
    shadowMapAspect: sf.shadowMapAspect,
    shadowCasterChannels: sf.shadowCasterChannels,
    shadowAutoUpdate: sf.shadowAutoUpdate,
    shadowRevision: sf.shadowRevision,
    shadowBiasMode: sf.shadowBiasMode,
    shadowRadius: sf.shadowRadius,
    shadowIntensity: sf.shadowIntensity,
    cascadeCount: sf.cascadeCount,
    splitLambda: sf.splitLambda,
    cascadeBlend: sf.cascadeBlend,
    mapSize: sf.mapSize,
    shadowDistance: sf.shadowDistance,
    shadowFilter: sf.shadowFilter,
    shadowAngularRadius: sf.shadowAngularRadius,
    maxPenumbraTexels: sf.maxPenumbraTexels,
    ...(sf.staggerCascades ? { staggerCascades: true } : {}),
    ...(sf.staticShadowCache ? { staticShadowCache: true as const } : {}),
  };
}

/**
 * The shadow configuration and direction a view fits its cascades from,
 * gated on the sun-lane owner's castShadow (default false) and a valid config.
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

interface PackedPointShadow {
  seen: number;
  x: number;
  y: number;
  z: number;
  near: number;
  far: number;
  packed: Float32Array;
}
const PACKED_POINT_SHADOW_LIMIT = 4096;

/**
 * Six face view-projection matrices packed into Float32Array(96). The table is a
 * pure function of position, near and far, so an unchanged light keeps the
 * previous frame's array (same identity) instead of rebuilding 18 matrices.
 */
function packPointShadowMatrices(
  cache: SourceLightingCache,
  entity: number,
  lightPos: Vec3,
  nearPlane: number,
  farPlane: number,
) {
  cache.shadows ??= new Map();
  const perSource = cache.shadows;
  const x = lightPos[0] ?? 0;
  const y = lightPos[1] ?? 0;
  const z = lightPos[2] ?? 0;
  const hit = perSource.get(entity);
  if (
    hit !== undefined &&
    hit.x === x &&
    hit.y === y &&
    hit.z === z &&
    hit.near === nearPlane &&
    hit.far === farPlane
  ) {
    hit.seen = cache.shadowFrame;
    return hit.packed;
  }
  const packed = packedPointShadowMatrices(lightPos, nearPlane, farPlane);
  if (hit !== undefined || perSource.size < PACKED_POINT_SHADOW_LIMIT)
    perSource.set(entity, {
      x,
      y,
      z,
      near: nearPlane,
      far: farPlane,
      packed,
      seen: cache.shadowFrame,
    });
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
  worldInternal: WorldInternalView,
  cache: SourceLightingCache,
): PointShadowSnapshot[] {
  const pointShadowSnapshots: PointShadowSnapshot[] = [];
  cache.shadowFrame++;
  const pointShadowQuery = extractPointShadowsQuery(world).unwrap();
  for (const batch of pointShadowQuery.batches().unwrap()) {
    const entities = batch.entities;
    const rows = batch.kind === 'indexed' ? batch.rows : undefined;
    const first = batch.kind === 'range' ? batch.start : 0;
    const range = batch.read(PointLight, 'range');
    const shadowCasterChannels = batch.read(PointLightShadow, 'shadowCasterChannels');
    const shadowProjection = batch.read(PointLightShadow, 'shadowProjection');
    const nearPlane = batch.read(PointLightShadow, 'nearPlane');
    const farPlane = batch.read(PointLightShadow, 'farPlane');
    const mapSize = batch.read(PointLightShadow, 'mapSize');
    const depthBias = batch.read(PointLightShadow, 'depthBias');
    const normalBias = batch.read(PointLightShadow, 'normalBias');
    const shadowAutoUpdate = batch.read(PointLightShadow, 'shadowAutoUpdate');
    const shadowRevision = batch.read(PointLightShadow, 'shadowRevision');
    const shadowFilter = batch.read(PointLightShadow, 'shadowFilter');
    const shadowBiasMode = batch.read(PointLightShadow, 'shadowBiasMode');
    const shadowIntensity = batch.read(PointLightShadow, 'shadowIntensity');
    const pcfKernelSize = batch.read(PointLightShadow, 'pcfKernelSize');
    const staticShadowCache = batch.read(PointLightShadow, 'staticShadowCache');
    for (let ordinal = 0; ordinal < batch.count; ordinal++) {
      const row = rows === undefined ? first + ordinal : (rows[ordinal] as number);
      const entity = entities[row] as EntityHandle;
      const psShadowCasterChannels = shadowCasterChannels[row] as number;
      const psNearPlane = nearPlane[row] as number;
      const channelsError = validateChannelMask(psShadowCasterChannels, 'shadowCasterChannels');
      if (channelsError !== null) {
        routeExtractError(worldInternal, channelsError, 'RenderSystem.extract (shadow-channels)');
        continue;
      }
      const wRow = readEnvironmentPose(world, entity);
      if (wRow === undefined) continue;
      const lightPos =
        shadowProjection[row] === 1
          ? vec3.clone(
              readRenderArrayView(
                world,
                entity,
                PointLightShadow,
                'shadowPosition',
              ) as Float32Array,
            )
          : vec3.create(wRow[12] ?? 0, wRow[13] ?? 0, wRow[14] ?? 0);
      const projection = resolvePunctualShadowFarPlane(
        range[row] as number,
        psNearPlane,
        farPlane[row] as number,
      );
      if (!projection.ok) {
        routeExtractError(
          worldInternal,
          projection.error,
          'RenderSystem.extract (point-shadow-projection)',
        );
        continue;
      }
      const resolvedFar = projection.value;
      pointShadowSnapshots.push({
        entity: entity,
        position: lightPos,
        mapSize: mapSize[row] as number,
        nearPlane: psNearPlane,
        farPlane: resolvedFar,
        depthBias: depthBias[row] as number,
        normalBias: normalBias[row] as number,
        shadowCasterChannels: psShadowCasterChannels,
        shadowAutoUpdate: shadowAutoUpdate[row] === 1,
        ...(staticShadowCache[row] === 1 ? { staticShadowCache: true as const } : {}),
        shadowRevision: shadowRevision[row] as number,
        shadowFilter: shadowFilter[row] as number,
        shadowBiasMode: shadowBiasMode[row] as number,
        shadowIntensity: shadowIntensity[row] as number,
        pcfKernelSize: pcfKernelSize[row] ?? 3,
        // The Render World assigns each request a stable cube layer.
        shadowAtlasLayer: -1,
        shadowMatrices: packPointShadowMatrices(cache, entity, lightPos, psNearPlane, resolvedFar),
      });
    }
  }
  // Release despawned and disabled lights at extraction, including below the capacity limit.
  if (
    cache.shadows !== undefined &&
    (cache.shadows.size > pointShadowSnapshots.length ||
      cache.shadows.size === PACKED_POINT_SHADOW_LIMIT)
  )
    for (const [entity, shadow] of cache.shadows)
      if (shadow.seen !== cache.shadowFrame) cache.shadows.delete(entity);
  return pointShadowSnapshots;
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
 * join pointShadow snapshots into the matching PointLightSnapshot so the
 * record stage threads `shadowNear + shadowFar` through the unified
 * direct-light metadata payload; the Render World stamps the light's stable
 * `shadowAtlasLayer`. Shadow metadata belongs to the frame, independently of the source light rows.
 */
function joinPointShadowLayers(
  pointSnapshots: readonly PointLightSnapshot[],
  pointShadowSnapshots: readonly PointShadowSnapshot[],
): readonly PointLightSnapshot[] {
  if (pointShadowSnapshots.length === 0) return pointSnapshots;
  let joined: PointLightSnapshot[] | undefined;
  const shadowByEntity = new Map<number, PointShadowSnapshot>();
  for (const ps of pointShadowSnapshots) shadowByEntity.set(ps.entity, ps);
  for (let i = 0; i < pointSnapshots.length; i++) {
    const light = pointSnapshots[i] as PointLightSnapshot;
    if (light.entity === undefined) continue;
    const ps = shadowByEntity.get(light.entity);
    if (ps === undefined) continue;
    joined ??= pointSnapshots.slice();
    joined[i] = {
      ...light,
      shadowAtlasLayer: ps.shadowAtlasLayer,
      ...(ps.shadowIntensity === undefined ? {} : { shadowIntensity: ps.shadowIntensity }),
      shadowNear: ps.nearPlane,
      shadowFar: ps.farPlane,
      pcfKernelSize: ps.pcfKernelSize ?? 3,
    };
  }
  return joined ?? pointSnapshots;
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
  light: ShapeOf<SchemaOf<typeof Skylight>>,
): SkylightSnapshot {
  const captureWorld = readEnvironmentPose(world, entity);
  const targetEnvironment = world.hasComponent(entity, RenderTargetEnvironment)
    ? world.get(entity, RenderTargetEnvironment).unwrap()
    : undefined;
  const featureEnvironment = world.hasComponent(entity, RenderFeatureEnvironment)
    ? world.get(entity, RenderFeatureEnvironment).unwrap()
    : undefined;
  return {
    ...(targetEnvironment !== undefined
      ? {
          targetEnvironment: world.sharedRefs
            .resolve<'RenderTargetEnvironmentSource', RenderTargetEnvironmentSource>(
              targetEnvironment.source,
            )
            .unwrap(),
        }
      : {}),
    ...(featureEnvironment === undefined ? {} : { featureEnvironment }),
    ...(captureWorld === undefined
      ? {}
      : {
          capturePosition: [
            captureWorld[12] ?? 0,
            captureWorld[13] ?? 0,
            captureWorld[14] ?? 0,
          ] as const,
        }),
    equirectHandle: Number(light.generatedEquirect) || Number(light.equirect) || 0,
    color: rgbTuple(light.color),
    groundColor: rgbTuple(light.groundColor),
    ambientIrradiance: rgbTuple(light.ambientIrradiance),
    intensity: light.intensity,
    rotation: quaternionTuple(light.rotation),
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
  const skylightQuery = extractSkylightQuery(world).unwrap();
  let skylight: SkylightSnapshot | undefined;
  let skylightCount = 0;
  skylightQuery.forEach((row) => {
    skylightCount += 1;
    if (skylight === undefined) skylight = skylightSnapshotOf(world, row.entity, row.get(Skylight));
  });
  return { skylight, skylightCount };
}

const NO_LIGHT_PROBES: readonly LightProbeSnapshot[] = Object.freeze([]);

function extractLightProbes(
  world: World,
  worldInternal: WorldInternalView,
): readonly LightProbeSnapshot[] {
  const lightProbeQuery = extractLightProbesQuery(world).unwrap();
  let lightProbes: LightProbeSnapshot[] | undefined;
  lightProbeQuery.forEach((row) => {
    const probeIrradiance = readRenderArrayView(
      world,
      row.entity,
      LightProbe,
      'irradiance',
    ) as Float32Array;
    const probeRadius = world[worldRead].getFieldValue(row.entity, LightProbe, 'radius') as number;
    const validation = validateLightProbeData({
      irradiance: probeIrradiance,
      radius: probeRadius,
    });
    if (!validation.ok) {
      routeExtractError(worldInternal, validation.error, 'RenderSystem.extract (light-probe)');
      return;
    }
    const transform = readEnvironmentPose(world, row.entity);
    if (transform === undefined) return;
    lightProbes ??= [];
    lightProbes.push({
      identity: String(row.entity),
      position: [transform[12] ?? 0, transform[13] ?? 0, transform[14] ?? 0],
      radius: probeRadius,
      irradiance: new Float32Array(probeIrradiance),
      admitted: true,
    });
  });
  return lightProbes ?? NO_LIGHT_PROBES;
}

/**
 * feat-20260531-skybox-env-background M2 / w5: first archetype hit wins
 * (mirrors Skylight pattern); multi-entity once-warn in record stage uses
 * skyboxCount.
 */
function extractSkybox(world: World) {
  const skyboxQuery = extractSkyboxQuery(world).unwrap();
  let skybox: SkyboxSnapshot | undefined;
  let skyboxCount = 0;
  skyboxQuery.forEach((row) => {
    skyboxCount += 1;
    if (skybox !== undefined) return;
    const source = row.get(SkyboxBackground);
    const featureEnvironment = world.hasComponent(row.entity, RenderFeatureEnvironment)
      ? world.get(row.entity, RenderFeatureEnvironment).unwrap()
      : undefined;
    if (
      source.generatedEquirect ||
      source.equirect !== undefined ||
      featureEnvironment !== undefined
    ) {
      skybox = {
        equirectHandle: Number(source.generatedEquirect) || Number(source.equirect) || 0,
        ...(featureEnvironment === undefined ? {} : { featureEnvironment }),
        mode: source.mode,
        rotation: quaternionTuple(source.rotation),
        // w19: winning entity handle for the multi-SkyboxBackground warn (F-8).
        entityHandle: row.entity,
      };
    }
  });
  return { skybox, skyboxCount };
}

function atmosphereParametersOf(
  atmosphere: ShapeOf<SchemaOf<typeof Atmosphere>>,
  atmosphereWorld: ArrayLike<number> | undefined,
  skylight: SkylightSnapshot | undefined,
) {
  const groundX = atmosphereWorld?.[12] ?? 0;
  const groundY = atmosphereWorld?.[13] ?? 0;
  const groundZ = atmosphereWorld?.[14] ?? 0;
  return {
    backgroundOnly: atmosphere.backgroundOnly,
    planetRadius: atmosphere.planetRadius,
    atmosphereHeight: atmosphere.atmosphereHeight,
    groundOrigin: [groundX, groundY, groundZ] as const,
    capturePosition: skylight?.capturePosition ?? ([groundX, groundY + 1, groundZ] as const),
    rayleighScattering: rgbTuple(atmosphere.rayleighScattering),
    rayleighScaleHeight: atmosphere.rayleighScaleHeight,
    mieScattering: atmosphere.mieScattering,
    mieAbsorption: atmosphere.mieAbsorption,
    mieScaleHeight: atmosphere.mieScaleHeight,
    mieAnisotropy: atmosphere.mieAnisotropy,
    absorption: rgbTuple(atmosphere.absorption),
    absorptionPeakHeight: atmosphere.absorptionPeakHeight,
    absorptionHalfWidth: atmosphere.absorptionHalfWidth,
    groundAlbedo: rgbTuple(atmosphere.groundAlbedo),
    multipleScattering: atmosphere.multipleScattering,
    transmittanceMinLightElevationDegrees: atmosphere.transmittanceMinLightElevationDegrees,
    sunAngularRadius: atmosphere.sunAngularRadius,
    aerialPerspectiveStart: atmosphere.aerialPerspectiveStart,
    aerialPerspectiveDistanceScale: atmosphere.aerialPerspectiveDistanceScale,
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
  const atmosphereQuery = environmentCandidatesOfQuery(world).unwrap();
  atmosphereQuery.forEach((row) => {
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
  });
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
  });
  if (!environmentSelection.ok) {
    routeWorldError(world, environmentSelection.error, {
      systemName: 'RenderSystem.extract (environment-selection)',
    });
    throw environmentSelection.error;
  }
  return environmentSelection.value;
}
