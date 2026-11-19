import {
  type Asset,
  canonicalJson,
  err,
  ok,
  type Result,
  sha256,
  WATER_ADVANCED_DEBUG_WRITER_ORDER,
  WATER_BODY_DEFAULT_SHAPE_DILATION_M,
  type WaterBodyGeometrySnapshot,
  type WaterWaveSetSource,
  type WaterWaveSource,
} from '@forgeax/engine-types';
import { resolveWaterSplinePoints } from './body-spline.js';
import type { WaterAsset, WaterBodyAsset, WaterBodySourceAsset, WaterError } from './contracts.js';
import { validWaterFluidConfiguration } from './fluid-simulation.js';
import { migrateWaterPayload, waterSplineDigestProjection } from './payload-migration.js';
import { requireWaterValue } from './required-value.js';
import { MAX_WATER_MESH_TESSELLATION_FACTOR } from './water-mesh-budget.js';

function validDispersiveOcean(value: WaterValidationRecord, visualFftV2 = false): boolean {
  const gpuFinite = (candidate: unknown): candidate is number =>
    finite(candidate) && Number.isFinite(Math.fround(candidate));
  const gpuPositive = (candidate: unknown): candidate is number =>
    gpuFinite(candidate) && Math.fround(candidate) > 0;
  if (
    !closedObject(value, [
      'algorithm',
      'fftResolution',
      'domainLengthM',
      'centerXZ',
      'baseHeightM',
      'referenceDepthM',
      'gravityMPerSec2',
      'sourceSlabBoundariesM',
      'collisions',
      'maximumIntervalSeconds',
      'entryWaveMultiplier',
      'surfaceTransportMultiplier',
      'waveDampingPerSecond',
      'boundary',
      'foam',
      'normalRtFormat',
      'gridMesh',
      ...(visualFftV2 ? ['visualNormalDetailFft'] : []),
    ])
  )
    return false;
  const n = value.fftResolution;
  if (
    invalidDispersiveLattice(value, n, gpuFinite) ||
    invalidDispersivePhysicalControls(value, n, gpuFinite, gpuPositive)
  )
    return false;
  if (!validDispersiveSlabs(value, gpuFinite, gpuPositive)) return false;
  if (!validDispersiveCollision(value.collisions, gpuPositive)) return false;
  const edge = value.boundary;
  if (edge?.kind === 'periodic') {
    if (!closedObject(edge, ['kind'])) return false;
  } else if (
    !closedObject(edge, ['kind', 'widthM', 'dampingPerSecond']) ||
    edge.kind !== 'absorbing' ||
    !gpuPositive(edge.widthM) ||
    edge.widthM >= value.domainLengthM / 2 ||
    !gpuPositive(edge.dampingPerSecond)
  )
    return false;
  const foam = value.foam;
  return (
    closedObject(foam, ['slopeThreshold', 'emissionPerSecond', 'decayPerSecond']) &&
    ['slopeThreshold', 'emissionPerSecond', 'decayPerSecond'].every(
      (key) => gpuFinite(foam[key]) && foam[key] >= 0,
    )
  );
}

function validVisualNormalDetailFft(value: unknown, textureGuids: readonly string[]): boolean {
  const config = asWaterRecord(value);
  const gpuFinite = (candidate: unknown): candidate is number =>
    finite(candidate) && Number.isFinite(Math.fround(candidate));
  const gpuPositive = (candidate: unknown): candidate is number =>
    gpuFinite(candidate) && Math.fround(candidate) > 0;
  if (
    !config ||
    !closedObject(config, [
      'noiseTextureGuid',
      'fftResolution',
      'domainLengthM',
      'normalDomainSizeM',
      'gravityMPerSec2',
      'phillipsAmplitude',
      'windAngleDegrees',
      'windSpeedMPerSec',
      'windAlignment',
      'timeScale',
      'slosh',
      'normalRtFormat',
    ])
  )
    return false;
  const resolution = config.fftResolution;
  return (
    guid(config.noiseTextureGuid) &&
    textureGuids.includes(config.noiseTextureGuid) &&
    Number.isInteger(resolution) &&
    resolution >= 8 &&
    resolution <= 1024 &&
    (resolution & (resolution - 1)) === 0 &&
    ['domainLengthM', 'normalDomainSizeM', 'gravityMPerSec2', 'timeScale'].every((key) =>
      gpuPositive(config[key]),
    ) &&
    gpuPositive(Math.fround(config.domainLengthM) / resolution) &&
    gpuPositive(Math.fround(config.normalDomainSizeM) / resolution) &&
    ['phillipsAmplitude', 'windAngleDegrees', 'windSpeedMPerSec', 'windAlignment', 'slosh'].every(
      (key) => gpuFinite(config[key]),
    ) &&
    config.phillipsAmplitude >= 0 &&
    ['rgba16float', 'rgba32float'].includes(config.normalRtFormat)
  );
}

const KINDS = [
  'water-body',
  'water-zone',
  'water-wave-set',
  'water-brush-recipe',
  'water-simulation-recipe',
] as const;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const guid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const finiteVec = (value: unknown, size: number): value is readonly number[] =>
  Array.isArray(value) && value.length === size && Array.from(value).every(finite);
// Dynamic fields are used only behind object and closed-key schema checks.
// biome-ignore lint/suspicious/noExplicitAny: runtime validation requires reading variant fields before narrowing each closed schema
type WaterValidationRecord = Record<string, any>;

function asWaterRecord(value: unknown): WaterValidationRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as WaterValidationRecord)
    : undefined;
}

function versionedSplineOrientationValid(point: WaterValidationRecord): boolean {
  const q = point.rotationQuat as readonly number[] | undefined;
  if (!q || !finiteVec(q, 4) || Math.abs(Math.hypot(...q) - 1) > 1e-5 || point.rollAngle !== 0)
    return false;
  const upLength = Math.hypot(...point.up);
  if (!Number.isFinite(upLength) || upLength <= 0) return false;
  const expectedUp = [
    2 *
      (requireWaterValue(q[0]) * requireWaterValue(q[1]) -
        requireWaterValue(q[3]) * requireWaterValue(q[2])),
    1 -
      2 *
        (requireWaterValue(q[0]) * requireWaterValue(q[0]) +
          requireWaterValue(q[2]) * requireWaterValue(q[2])),
    2 *
      (requireWaterValue(q[1]) * requireWaterValue(q[2]) +
        requireWaterValue(q[3]) * requireWaterValue(q[0])),
  ];
  if (
    point.up.some(
      (value: number, axis: number) =>
        Math.abs(value / upLength - requireWaterValue(expectedUp[axis])) > 1e-5,
    )
  )
    return false;
  for (const tangent of [point.arriveRotationQuat, point.leaveRotationQuat]) {
    if (
      tangent !== undefined &&
      (!finiteVec(tangent, 4) || Math.abs(Math.hypot(...tangent) - 1) > 1e-5)
    )
      return false;
  }
  return true;
}
const freeze = <T>(value: T): T => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])),
  ) as T;
};
const COOKED_BODY_FIELDS = [
  'riverSegmentMeshGuids',
  'visibleMeshGuid',
  'waterInfoMeshGuid',
  'dilatedWaterInfoMeshGuid',
  'brushShapeMeshGuid',
  'collisionMeshGuid',
  'waterGeometryVersion',
  'oceanCenterM',
  'geometryAuthoringWorldMatrixM',
  'geometrySnapshot',
] as const;
function validWaterGeometryProducts(asset: WaterValidationRecord): boolean {
  if (invalidBodyShapeDilation(asset)) return false;
  if (asset.waterGeometryVersion !== undefined && asset.waterGeometryVersion !== 2) return false;
  if (
    asset.type === 'custom' &&
    asset.flags?.affectsWaterMesh === true &&
    !guid(asset.customMeshOverrideGuid)
  )
    return false;
  if (
    asset.dilatedWaterInfoMeshGuid !== undefined &&
    (!guid(asset.dilatedWaterInfoMeshGuid) ||
      asset.type === 'custom' ||
      asset.flags?.affectsWaterInfo !== true ||
      asset.shapeDilationM === 0)
  )
    return false;
  if (asset.waterGeometryVersion === 2 && asset.flags?.affectsWaterInfo === true) {
    if (!guid(asset.waterInfoMeshGuid)) return false;
    if (
      asset.type !== 'custom' &&
      (asset.shapeDilationM ?? WATER_BODY_DEFAULT_SHAPE_DILATION_M) > 0 &&
      !guid(asset.dilatedWaterInfoMeshGuid)
    )
      return false;
  }
  return true;
}
export function waterQueryFootprintDigest(
  source: WaterBodySourceAsset,
  footprint: Omit<WaterBodyGeometrySnapshot['queryFootprint'], 'digest'>,
  cooked?: Pick<WaterBodyAsset, 'oceanCenterM' | 'geometryAuthoringWorldMatrixM'>,
): string {
  const inputs = {
    type: source.type,
    spline: waterSplineDigestProjection(source.spline),
    queryFootprint: source.queryFootprint,
    oceanExtentM: source.oceanExtentM,
    centerOnWaterZone: source.centerOnWaterZone,
    savedZoneLocationWorldXZ: source.savedZoneLocationWorldXZ,
    oceanCenterM: cooked?.oceanCenterM,
    geometryAuthoringWorldMatrixM: cooked?.geometryAuthoringWorldMatrixM,
    geometryCook: source.geometryCook,
  };
  return sha256(
    canonicalJson({
      version: footprint.version,
      inputs,
      outer: footprint.outer,
      holes: footprint.holes,
    }),
  );
}
export function waterMeshFootprintDigest(
  source: WaterBodySourceAsset,
  footprint: Omit<NonNullable<WaterBodyGeometrySnapshot['waterMeshFootprint']>, 'digest'>,
): string {
  return sha256(
    canonicalJson({
      version: footprint.version,
      meshGuid: source.type === 'custom' ? source.customMeshOverrideGuid : undefined,
      rings: footprint.rings,
    }),
  );
}
export function waterCollisionDescriptorDigest(
  source: WaterBodySourceAsset,
  descriptor: NonNullable<WaterBodyGeometrySnapshot['collisionDescriptor']> extends infer D
    ? D extends { digest: string }
      ? Omit<D, 'digest'>
      : never
    : never,
): string {
  const spline =
    source.type === 'river' || source.type === 'lake'
      ? waterSplineDigestProjection(source.spline)
      : undefined;
  const heightOffsetM = source.type === 'ocean' ? source.heightOffsetM : undefined;
  const inputs = {
    type: source.type,
    spline,
    baseHeightM: source.baseHeightM,
    heightOffsetM,
    collision: source.collision,
  };
  return sha256(
    canonicalJson({
      version: descriptor.version,
      inputs,
      footprint: descriptor.footprint,
      minimumYM: descriptor.minimumYM,
      maximumYM: descriptor.maximumYM,
      riverSegmentConvexes: descriptor.riverSegmentConvexes,
      ...(descriptor.version === 2
        ? {
            riverSegmentConvexTopCapVertexIndices: descriptor.riverSegmentConvexTopCapVertexIndices,
          }
        : {}),
      ...('customMesh' in descriptor ? { customMesh: descriptor.customMesh } : {}),
    }),
  );
}

/** Stable semantic identity for the River geometry and query facts carried by a Bake. */
export function waterRiverBakeGeometryProjectionHash(body: WaterBodyAsset): string | undefined {
  if (body.type !== 'river') return undefined;
  const geometry = body.geometrySnapshot;
  const descriptor = geometry?.collisionDescriptor;
  const convexes = descriptor?.riverSegmentConvexes;
  const topCaps = descriptor?.riverSegmentConvexTopCapVertexIndices;
  if (!geometry?.queryFootprint || !geometry.queryVolume) return undefined;
  if (
    !body.collision.enabled
      ? descriptor !== null
      : descriptor?.version !== 2 ||
        !convexes ||
        !topCaps ||
        convexes.length === 0 ||
        topCaps.length !== convexes.length ||
        convexes.some(
          (segment, segmentIndex) =>
            segment.length === 0 ||
            segment.length !== topCaps[segmentIndex]?.length ||
            segment.some((hull, hullIndex) => {
              const roles = topCaps[segmentIndex]?.[hullIndex];
              return (
                hull.length !== 8 ||
                roles?.length !== 4 ||
                roles.some((index, roleIndex) => index !== [4, 5, 6, 7][roleIndex])
              );
            }),
        )
  )
    return undefined;

  const spline = {
    closed: body.spline.closed,
    ...(body.spline.interpolationVersion === undefined
      ? {}
      : {
          interpolationVersion: waterSplineDigestProjection(body.spline).interpolationVersion,
        }),
    ...(body.spline.metadataDefaults === undefined
      ? {}
      : {
          metadataDefaults: {
            widthM: body.spline.metadataDefaults.widthM,
            depthM: body.spline.metadataDefaults.depthM,
            velocityMPerSec: body.spline.metadataDefaults.velocityMPerSec,
          },
        }),
    points: body.spline.points.map((point) => ({
      inputKey: point.inputKey,
      ...(point.interpolationMode === undefined
        ? {}
        : { interpolationMode: point.interpolationMode }),
      ...(point.rotationQuat === undefined ? {} : { rotationQuat: point.rotationQuat }),
      ...(point.arriveRotationQuat === undefined
        ? {}
        : { arriveRotationQuat: point.arriveRotationQuat }),
      ...(point.leaveRotationQuat === undefined
        ? {}
        : { leaveRotationQuat: point.leaveRotationQuat }),
      positionM: point.positionM,
      arriveTangentM: point.arriveTangentM,
      leaveTangentM: point.leaveTangentM,
      up: point.up,
      rollAngle: point.rollAngle,
      angleUnit: point.angleUnit,
      widthM: point.widthM,
      depthM: point.depthM,
      velocityMPerSec: point.velocityMPerSec,
    })),
  };
  return sha256(
    canonicalJson({
      version: 'water-river-query-geometry/1',
      source: {
        spline,
        baseHeightM: body.baseHeightM,
        collision: {
          type: body.collision.type,
          enabled: body.collision.enabled,
          collisionHeightOffsetM: body.collision.collisionHeightOffsetM,
        },
        geometryCook: body.geometryCook,
      },
      queryFootprint: {
        version: geometry.queryFootprint.version,
        outer: geometry.queryFootprint.outer,
        holes: geometry.queryFootprint.holes,
      },
      queryVolume: {
        version: geometry.queryVolume.version,
        minimumYM: geometry.queryVolume.minimumYM,
        maximumYM: geometry.queryVolume.maximumYM,
      },
      collisionDescriptor:
        descriptor == null
          ? null
          : {
              version: descriptor.version,
              footprint: descriptor.footprint,
              minimumYM: descriptor.minimumYM,
              maximumYM: descriptor.maximumYM,
              riverSegmentConvexes: convexes,
              riverSegmentConvexTopCapVertexIndices: topCaps,
            },
    }),
  );
}
function hermiteRange(
  startY: number,
  endY: number,
  startTangentY: number,
  endTangentY: number,
  keyDelta: number,
  offsetStart = 0,
  offsetEnd = 0,
): readonly [number, number] {
  const a = 2 * startY - 2 * endY + keyDelta * (startTangentY + endTangentY);
  const b = -3 * startY + 3 * endY - keyDelta * (2 * startTangentY + endTangentY);
  const c = keyDelta * startTangentY - (offsetEnd - offsetStart);
  const d = startY - offsetStart;
  const evaluate = (t: number) => ((a * t + b) * t + c) * t + d;
  const values = [evaluate(0), evaluate(1)];
  const qa = 3 * a,
    qb = 2 * b,
    qc = c;
  const scale = Math.max(1, Math.abs(qa), Math.abs(qb), Math.abs(qc));
  if (Math.abs(qa) <= Number.EPSILON * scale * 8) {
    if (Math.abs(qb) > Number.EPSILON * scale * 8) {
      const root = -qc / qb;
      if (root > 0 && root < 1) values.push(evaluate(root));
    }
  } else {
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)])
        if (t > 0 && t < 1) values.push(evaluate(t));
    }
  }
  return [Math.min(...values), Math.max(...values)];
}
function riverVerticalExtrema(source: WaterBodySourceAsset): readonly [number, number] {
  const points = resolveWaterSplinePoints(source.spline);
  let minimumY = Number.POSITIVE_INFINITY,
    maximumY = Number.NEGATIVE_INFINITY;
  const segmentCount = source.spline.closed ? points.length : points.length - 1;
  const closedKeyDelta =
    points.length > 1
      ? requireWaterValue(points[1]).inputKey - requireWaterValue(points[0]).inputKey
      : 1;
  for (let index = 0; index < segmentCount; index++) {
    const start = requireWaterValue(points[index]),
      end = requireWaterValue(points[(index + 1) % points.length]);
    const keyDelta = index === points.length - 1 ? closedKeyDelta : end.inputKey - start.inputKey;
    if (start.interpolationMode === 'linear') {
      minimumY = Math.min(
        minimumY,
        start.positionM[1] - start.depthM,
        end.positionM[1] - end.depthM,
      );
      maximumY = Math.max(maximumY, start.positionM[1], end.positionM[1]);
      continue;
    }
    const top = hermiteRange(
      start.positionM[1],
      end.positionM[1],
      start.leaveTangentM[1],
      end.arriveTangentM[1],
      keyDelta,
    );
    const bottom = hermiteRange(
      start.positionM[1],
      end.positionM[1],
      start.leaveTangentM[1],
      end.arriveTangentM[1],
      keyDelta,
      start.depthM,
      end.depthM,
    );
    minimumY = Math.min(minimumY, bottom[0]);
    maximumY = Math.max(maximumY, top[1]);
  }
  if (segmentCount === 0) {
    const point = requireWaterValue(points[0]);
    return [point.positionM[1] - point.depthM, point.positionM[1]];
  }
  return [minimumY, maximumY];
}
export function waterQueryVolume(
  source: WaterBodySourceAsset,
): Omit<WaterBodyGeometrySnapshot['queryVolume'], 'digest'> {
  const surface = source.baseHeightM + (source.type === 'ocean' ? (source.heightOffsetM ?? 0) : 0);
  const riverRange = source.type === 'river' ? riverVerticalExtrema(source) : undefined;
  const waveMinimum = riverRange?.[0] ?? surface;
  const waveMaximum = riverRange?.[1] ?? surface;
  let minimumYM =
    waveMinimum - Math.max(source.maxWaveHeightM, source.underwaterSettings?.maxDepthM ?? 0);
  let maximumYM = waveMaximum + source.maxWaveHeightM;
  if (source.collision.enabled && source.type === 'lake' && source.collision.channelDepthM) {
    minimumYM = Math.min(minimumYM, source.baseHeightM - source.collision.channelDepthM);
    maximumYM = Math.max(
      maximumYM,
      source.baseHeightM + (source.collision.collisionHeightOffsetM ?? 0),
    );
  }
  if (
    source.type === 'ocean' &&
    source.collision.enabled &&
    source.collision.collisionHalfHeightM
  ) {
    const center =
      surface -
      source.collision.collisionHalfHeightM +
      (source.collision.collisionHeightOffsetM ?? 0) / 2;
    const half =
      source.collision.collisionHalfHeightM + (source.collision.collisionHeightOffsetM ?? 0) / 2;
    minimumYM = Math.min(minimumYM, center - half);
    maximumYM = Math.max(maximumYM, center + half);
  }
  if (minimumYM === maximumYM) {
    minimumYM -= 5e-5;
    maximumYM += 5e-5;
  }
  return { version: 1, minimumYM, maximumYM };
}
export function waterQueryVolumeDigest(
  source: WaterBodySourceAsset,
  volume: Omit<WaterBodyGeometrySnapshot['queryVolume'], 'digest'>,
): string {
  const inputs = {
    type: source.type,
    spline: waterSplineDigestProjection(source.spline),
    baseHeightM: source.baseHeightM,
    heightOffsetM: source.heightOffsetM,
    maxWaveHeightM: source.maxWaveHeightM,
    underwaterSettings: source.underwaterSettings,
    collision: source.collision,
  };
  return sha256(
    canonicalJson({
      version: volume.version,
      inputs,
      minimumYM: volume.minimumYM,
      maximumYM: volume.maximumYM,
    }),
  );
}
function validGeometrySnapshot(asset: WaterValidationRecord): boolean {
  const snapshot = asset.geometrySnapshot;
  if (snapshot === undefined) return true;
  if (
    !closedObject(snapshot, [
      'queryFootprint',
      'queryVolume',
      'waterMeshFootprint',
      'collisionDescriptor',
    ])
  )
    return false;
  const boundary = (value: WaterValidationRecord) =>
    closedObject(value, ['outer', 'holes']) &&
    validPolygon(value.outer) &&
    Array.isArray(value.holes) &&
    value.holes.every(validPolygon);
  const query = snapshot.queryFootprint;
  if (
    !closedObject(query, ['version', 'digest', 'outer', 'holes']) ||
    query.version !== 1 ||
    typeof query.digest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(query.digest) ||
    !boundary({ outer: query.outer, holes: query.holes })
  )
    return false;
  const descriptor = snapshot.collisionDescriptor;
  const source = Object.fromEntries(
    Object.entries(asset).filter(
      ([key]) => !(COOKED_BODY_FIELDS as readonly string[]).includes(key),
    ),
  ) as WaterBodySourceAsset;
  const waterMeshFootprint = snapshot.waterMeshFootprint;
  const customWaterMeshOptIn = source.type === 'custom' && source.flags?.affectsWaterMesh === true;
  if (customWaterMeshOptIn !== (waterMeshFootprint !== undefined)) return false;
  if (!validGeometryWaterMeshFootprint(source, waterMeshFootprint, customWaterMeshOptIn))
    return false;
  if (descriptor !== null && !validGeometryCollisionDescriptor(source, descriptor, boundary))
    return false;
  const queryVolume = snapshot.queryVolume;
  if (invalidGeometryQueryVolume(source, queryVolume)) return false;
  if (invalidGeometryCollisionParticipation(source, descriptor)) return false;
  return validGeometrySnapshotDigests(asset, source, query, descriptor);
}
export function validateWaterAsset(value: unknown): Result<WaterAsset, WaterError> {
  value = migrateWaterPayload(value);
  const fail = (expected: string): Result<WaterAsset, WaterError> =>
    err({
      code: 'invalid-source',
      expected,
      hint: 'repair the water asset payload before publishing it',
    });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('a water asset object');
  const asset = value as WaterValidationRecord;
  if (!KINDS.includes(asset.kind)) return fail('one of the five water asset kinds');
  const closed = (record: unknown, keys: readonly string[]) =>
    !!record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.keys(record).every(
      (key) =>
        keys.includes(key) ||
        (record === asset && asset.kind === 'water-body' && key === 'shapeDilationM'),
    );
  if (asset.kind === 'water-body') {
    const problem = validateWaterBodyPayload(asset, closed, fail);
    if (problem !== undefined) return problem;
  } else if (asset.kind === 'water-zone') {
    const problem = validateWaterZonePayload(asset, closed, fail);
    if (problem !== undefined) return problem;
  } else if (asset.kind === 'water-wave-set') {
    const problem = validateWaterWaveSetPayload(asset, closed, fail);
    if (problem !== undefined) return problem;
  } else if (asset.kind === 'water-brush-recipe') {
    const problem = validateWaterBrushRecipePayload(asset, closed, fail);
    if (problem !== undefined) return problem;
  } else if (asset.kind === 'water-simulation-recipe') {
    const problem = validateWaterSimulationRecipePayload(asset, closed, fail);
    if (problem !== undefined) return problem;
  }
  return ok(value as WaterAsset);
}
function validAdvancedRigidMeshCollisions(value: unknown): boolean {
  const config = asWaterRecord(value);
  if (config?.kind === 'disabled') return closedObject(config, ['kind']);
  return (
    config !== undefined &&
    config !== null &&
    ['simple', 'distance-field'].includes(config.kind) &&
    closedObject(config, [
      'kind',
      'accurate',
      'useWaterHeightForCollision',
      'collisionGroups',
      'collisionOffsetCells',
      'overlapThicknessCells',
      'softCollisionFalloffM',
      'maxElements',
    ]) &&
    typeof config.accurate === 'boolean' &&
    typeof config.useWaterHeightForCollision === 'boolean' &&
    Number.isInteger(config.collisionGroups) &&
    config.collisionGroups >= 0 &&
    config.collisionGroups <= 0xffffffff &&
    finite(config.collisionOffsetCells) &&
    Number.isFinite(Math.fround(config.collisionOffsetCells)) &&
    finite(config.overlapThicknessCells) &&
    Number.isFinite(Math.fround(config.overlapThicknessCells)) &&
    config.overlapThicknessCells >= 0 &&
    finite(config.softCollisionFalloffM) &&
    Number.isFinite(Math.fround(config.softCollisionFalloffM)) &&
    config.softCollisionFalloffM >= 0 &&
    validAdvancedRigidCollisionLimits(config)
  );
}

function validAdvancedDebug(
  value: unknown,
  profile: keyof typeof WATER_ADVANCED_DEBUG_WRITER_ORDER,
): boolean {
  const debug = asWaterRecord(value);
  if (
    !debug ||
    !closedObject(debug, ['enabled', 'writers', 'foamEmission']) ||
    typeof debug.enabled !== 'boolean' ||
    typeof debug.foamEmission !== 'boolean' ||
    (profile !== 'river-shallow/2' && debug.foamEmission) ||
    !Array.isArray(debug.writers)
  )
    return false;
  const allowed: readonly string[] = WATER_ADVANCED_DEBUG_WRITER_ORDER[profile];
  const kinds = new Set<string>();
  return debug.writers.every((value: unknown) => {
    const writer = asWaterRecord(value);
    if (
      !writer ||
      typeof writer.kind !== 'string' ||
      !allowed.includes(writer.kind) ||
      kinds.has(writer.kind)
    )
      return false;
    kinds.add(writer.kind);
    return writer.kind === 'height-collider-speed'
      ? closedObject(writer, ['kind', 'speedMultiplier']) &&
          finite(writer.speedMultiplier) &&
          Number.isFinite(Math.fround(writer.speedMultiplier)) &&
          writer.speedMultiplier >= 0
      : closedObject(writer, ['kind']);
  });
}
function validAdvancedSubsteps(value: unknown): boolean {
  const config = asWaterRecord(value);
  if (
    !config ||
    !closedObject(config, ['numSteps', 'simSpeed', 'timeStepSource', 'deltaLimit']) ||
    !Number.isInteger(config.numSteps) ||
    config.numSteps <= 0 ||
    config.numSteps > 64 ||
    !finite(config.simSpeed) ||
    config.simSpeed <= 0 ||
    config.timeStepSource !== 'frame-delta'
  )
    return false;
  const limit = asWaterRecord(config.deltaLimit);
  return limit?.kind === 'source-default'
    ? closedObject(limit, ['kind'])
    : limit?.kind === 'application-cap' &&
        closedObject(limit, ['kind', 'maximumDeltaSeconds']) &&
        finite(limit.maximumDeltaSeconds) &&
        limit.maximumDeltaSeconds > 0;
}
function validAdvancedFoam(value: unknown): boolean {
  const foam = asWaterRecord(value);
  if (
    !foam ||
    !closedObject(foam, [
      'advectionVelocityMultiplier',
      'dissipationRatePerSecond',
      'dissipationSubtractionPerSecond',
      'minimum',
      'maximum',
      'emission',
    ]) ||
    ![
      'advectionVelocityMultiplier',
      'dissipationRatePerSecond',
      'dissipationSubtractionPerSecond',
      'minimum',
      'maximum',
    ].every((key) => finite(foam[key]) && foam[key] >= 0) ||
    foam.maximum < foam.minimum
  )
    return false;
  const emission = asWaterRecord(foam.emission);
  return (
    !!emission &&
    closedObject(emission, [
      'vorticity',
      'curvature',
      'speed',
      'depthDifference',
      'multiplier',
      'maximum',
      'depthRestrictionRangeM',
      'speedRestrictionRangeMPerSec',
    ]) &&
    ['multiplier', 'maximum'].every((key) => finite(emission[key]) && emission[key] >= 0) &&
    ['depthRestrictionRangeM', 'speedRestrictionRangeMPerSec'].every(
      (key) =>
        finiteVec(emission[key], 2) &&
        requireWaterValue(emission[key][0]) >= 0 &&
        requireWaterValue(emission[key][1]) > requireWaterValue(emission[key][0]),
    ) &&
    ['vorticity', 'curvature', 'speed', 'depthDifference'].every((key) => {
      const criterion = asWaterRecord(emission[key]);
      return (
        !!criterion &&
        closedObject(criterion, ['range', 'multiplier']) &&
        finiteVec(criterion.range, 2) &&
        requireWaterValue(criterion.range[0]) <= requireWaterValue(criterion.range[1]) &&
        finite(criterion.multiplier) &&
        criterion.multiplier >= 0 &&
        (criterion.multiplier === 0 ||
          requireWaterValue(criterion.range[0]) < requireWaterValue(criterion.range[1]))
      );
    })
  );
}
function validRiverBakedGrid(
  value: unknown,
  bakeExtentM: readonly number[],
  gridResolution: readonly number[],
): boolean {
  const grid = asWaterRecord(value);
  const commonKeys = [
    'version',
    'textureGuid',
    'sourceRecipeGuid',
    'sourceRecipeVersion',
    'sourceBodyGuid',
    'sourceBodyGeneration',
    'simulationGeneration',
    'sequence',
    'frameId',
    'deviceGeneration',
    'graphGeneration',
    'width',
    'height',
    'originXZ',
    'originYM',
    'spacingXZ',
  ];
  const v2Keys = [
    ...commonKeys,
    'normalTextureGuid',
    'normalBasis',
    'sourceWorldMatrixM',
    'sourceGeometryProjectionHash',
    'sourceFrame',
  ];
  const sourceFrame = grid?.sourceFrame as Record<string, unknown> | undefined;
  return Boolean(
    grid &&
      (grid.version === 'water-river-bake/1'
        ? closedObject(grid, commonKeys)
        : validRiverBakedGridV2(grid, sourceFrame, v2Keys)) &&
      ['textureGuid', 'sourceRecipeGuid', 'sourceBodyGuid'].every((key) => guid(grid[key])) &&
      typeof grid.sourceRecipeVersion === 'string' &&
      grid.sourceRecipeVersion.length > 0 &&
      [
        'sourceBodyGeneration',
        'simulationGeneration',
        'sequence',
        'frameId',
        'deviceGeneration',
        'graphGeneration',
      ].every((key) => Number.isSafeInteger(grid[key]) && grid[key] >= 0) &&
      ['width', 'height'].every(
        (key) => Number.isSafeInteger(grid[key]) && grid[key] >= 3 && grid[key] <= 1024,
      ) &&
      finiteVec(grid.originXZ, 2) &&
      finite(grid.originYM) &&
      finiteVec(grid.spacingXZ, 2) &&
      grid.spacingXZ.every((component: number) => component > 0) &&
      (grid.version !== 'water-river-bake/2' ||
        (gridResolution[0] === grid.width &&
          gridResolution[1] === grid.height &&
          requireWaterValue(grid.spacingXZ[0]) === requireWaterValue(bakeExtentM[0]) / grid.width &&
          requireWaterValue(grid.spacingXZ[1]) ===
            requireWaterValue(bakeExtentM[1]) / grid.height)),
  );
}
function validCollision(value: unknown, bodyType: string): boolean {
  const collision = asWaterRecord(value);
  if (!collision) return false;
  const derivedPolygon =
    (bodyType === 'lake' || bodyType === 'ocean') &&
    collision.type === 'polygon' &&
    collision.points === undefined;
  const bodyCompatible = compatibleWaterCollisionType(collision, bodyType);
  return Boolean(
    bodyCompatible &&
      typeof collision.enabled === 'boolean' &&
      ['none', 'river-prism', 'polygon', 'custom-mesh'].includes(collision.type) &&
      (collision.points === undefined ||
        (Array.isArray(collision.points) &&
          collision.points.every((p: unknown) => finiteVec(p, 2)))) &&
      (collision.meshGuid === undefined || guid(collision.meshGuid)) &&
      validWaterCollisionShape(collision, bodyType, derivedPolygon),
  );
}
function validWave(value: unknown): value is WaterWaveSource {
  const wave = asWaterRecord(value);
  if (!wave) return false;
  return Boolean(
    finiteVec(wave.directionXZ, 2) &&
      Math.hypot(...wave.directionXZ) > 0 &&
      finite(wave.wavelengthM) &&
      wave.wavelengthM > 0 &&
      finite(wave.amplitudeM) &&
      wave.amplitudeM >= 0 &&
      finite(wave.steepness),
  );
}
function validPolygon(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    !Array.from(value).every((point) => finiteVec(point, 2))
  )
    return false;
  const points = value as readonly (readonly [number, number])[];
  const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
    (requireWaterValue(b[0]) - requireWaterValue(a[0])) *
      (requireWaterValue(c[1]) - requireWaterValue(a[1])) -
    (requireWaterValue(b[1]) - requireWaterValue(a[1])) *
      (requireWaterValue(c[0]) - requireWaterValue(a[0]));
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = requireWaterValue(points[i]),
      b = requireWaterValue(points[(i + 1) % points.length]);
    if (a[0] === b[0] && a[1] === b[1]) return false;
    twiceArea += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === (i + 1) % points.length || i === (j + 1) % points.length) continue;
      const c = requireWaterValue(points[j]),
        d = requireWaterValue(points[(j + 1) % points.length]);
      if (waterPolygonEdgesIntersect(a, b, c, d, cross)) return false;
    }
  }
  return Number.isFinite(twiceArea) && Math.abs(twiceArea) > Number.EPSILON;
}
function closedObject(value: unknown, keys: readonly string[]): value is WaterValidationRecord {
  const record = asWaterRecord(value);
  return Boolean(record && Object.keys(record).every((key) => keys.includes(key)));
}
function validBrushActor(value: unknown, version: number): boolean {
  if (typeof value === 'string') return version === 0 && value.length > 0;
  const actor = asWaterRecord(value);
  if (
    !actor ||
    (actor.actorId !== undefined && (typeof actor.actorId !== 'string' || !actor.actorId)) ||
    (version === 1 &&
      actor.actorId === undefined &&
      actor.kind !== 'body' &&
      actor.kind !== 'island')
  )
    return false;
  if (actor.kind === 'body') return validBrushBodyActor(actor, version);
  const allowedKeys =
    version === 1
      ? ['kind', 'actorId', 'fullName', 'sourceKey', 'heightOffsetM', 'spline', 'rules']
      : [
          'kind',
          'actorId',
          'fullName',
          'sourceKey',
          'heightOffsetM',
          'spline',
          'terrainRules',
          'rules',
        ];
  const legacyRules = actor.terrainRules;
  const terrainRulesValid = version === 1 || validLegacyBrushTerrainRules(legacyRules);
  const fullNameValid =
    version === 0
      ? actor.fullName === undefined ||
        (typeof actor.fullName === 'string' && actor.fullName.length > 0)
      : typeof actor.fullName === 'string' && actor.fullName.length > 0;
  return Boolean(
    validBrushIslandActor(actor, version, allowedKeys, fullNameValid, terrainRulesValid),
  );
}
function validBrushSplinePoint(splineValue: unknown, pointValue: unknown): boolean {
  const spline = asWaterRecord(splineValue);
  const point = asWaterRecord(pointValue);
  if (!spline || !point) return false;
  return (
    validBrushSplineCoordinates(point) &&
    validBrushSplineOrientation(spline, point) &&
    validBrushSplineMetadata(point)
  );
}
function validBrushActorRules(value: unknown): boolean {
  const rules = asWaterRecord(value);
  return Boolean(
    rules &&
      closedObject(rules, [
        'falloff',
        'blend',
        'blurring',
        'curlNoise',
        'curves',
        'displacement',
        'smoothBlending',
        'terracing',
        'weightSettings',
      ]) &&
      validBrushFalloff(rules) &&
      validBrushBlend(rules) &&
      validBrushBlurring(rules) &&
      validBrushCurlNoise(rules) &&
      validBrushCurves(rules) &&
      validBrushDisplacement(rules) &&
      validBrushSmoothBlending(rules) &&
      validBrushTerracing(rules) &&
      validBrushWeightSettings(rules),
  );
}
function validBrushTerrainCapture(value: unknown): boolean {
  const capture = asWaterRecord(value);
  if (
    !capture ||
    !closedObject(capture, ['worldMatrixM', 'boundsXZ', 'resolutionPx', 'layerNameToIndex']) ||
    !finiteVec(capture.worldMatrixM, 16) ||
    !closedObject(capture.boundsXZ, ['minM', 'maxM']) ||
    !finiteVec(capture.boundsXZ.minM, 2) ||
    !finiteVec(capture.boundsXZ.maxM, 2) ||
    requireWaterValue(capture.boundsXZ.minM[0]) >= requireWaterValue(capture.boundsXZ.maxM[0]) ||
    requireWaterValue(capture.boundsXZ.minM[1]) >= requireWaterValue(capture.boundsXZ.maxM[1]) ||
    invalidBrushCaptureRaster(capture)
  )
    return false;
  const matrix = capture.worldMatrixM as number[];
  const affine =
    Math.abs(requireWaterValue(matrix[3])) <= 1e-8 &&
    Math.abs(requireWaterValue(matrix[7])) <= 1e-8 &&
    Math.abs(requireWaterValue(matrix[11])) <= 1e-8 &&
    Math.abs(requireWaterValue(matrix[15]) - 1) <= 1e-8;
  const cross = (a: number[], b: number[]) => [
    requireWaterValue(a[1]) * requireWaterValue(b[2]) -
      requireWaterValue(a[2]) * requireWaterValue(b[1]),
    requireWaterValue(a[2]) * requireWaterValue(b[0]) -
      requireWaterValue(a[0]) * requireWaterValue(b[2]),
    requireWaterValue(a[0]) * requireWaterValue(b[1]) -
      requireWaterValue(a[1]) * requireWaterValue(b[0]),
  ];
  const dot = (a: number[], b: number[]) =>
    requireWaterValue(a[0]) * requireWaterValue(b[0]) +
    requireWaterValue(a[1]) * requireWaterValue(b[1]) +
    requireWaterValue(a[2]) * requireWaterValue(b[2]);
  const determinant = dot(
    [requireWaterValue(matrix[0]), requireWaterValue(matrix[1]), requireWaterValue(matrix[2])],
    cross(
      [requireWaterValue(matrix[4]), requireWaterValue(matrix[5]), requireWaterValue(matrix[6])],
      [requireWaterValue(matrix[8]), requireWaterValue(matrix[9]), requireWaterValue(matrix[10])],
    ),
  );
  const entries = Object.entries(capture.layerNameToIndex);
  const indices = entries.map(([, index]) => index);
  const terrainPlaneDeterminant =
    requireWaterValue(matrix[0]) * requireWaterValue(matrix[10]) -
    requireWaterValue(matrix[8]) * requireWaterValue(matrix[2]);
  return (
    affine &&
    Number.isFinite(determinant) &&
    Math.abs(determinant) > 1e-12 &&
    Number.isFinite(terrainPlaneDeterminant) &&
    Math.abs(terrainPlaneDeterminant) > 1e-12 &&
    entries.length > 0 &&
    entries.every(
      ([name, index]) => !!name && Number.isSafeInteger(index) && (index as number) >= 0,
    ) &&
    new Set(indices).size === indices.length
  );
}
export function validateWaterRuntimeBody(
  value: unknown,
): Result<import('./contracts.js').WaterBodyAsset, WaterError> {
  const checked = validateWaterAsset(value);
  if (!checked.ok || checked.value.kind !== 'water-body')
    return err({
      code: 'invalid-source',
      expected: 'valid m/Y-up WaterBody payload',
      hint: 'publish a WaterBody in the ForgeAX Pack coordinate convention',
    });
  // Source and cooked bodies share schema admission; geometry digest validation
  // above establishes the cooked-only fields before runtime admission.
  const body = checked.value as WaterBodyAsset;
  if (
    !body.geometrySnapshot ||
    (body.collision.enabled && !body.geometrySnapshot.collisionDescriptor)
  )
    return err({
      code: 'invalid-source',
      expected:
        'Pack-cooked WaterBody with digest-verified query and enabled collision descriptors',
      hint: 'cook this body through the Pack Water geometry cooker before runtime admission',
    });
  return ok(body);
}
export function validateWaterRuntimeAsset(value: unknown): Result<
  Extract<
    Asset,
    {
      kind: `water-${string}`;
    }
  >,
  WaterError
> {
  if (
    value &&
    typeof value === 'object' &&
    (
      value as {
        kind?: unknown;
      }
    ).kind === 'water-wave-set'
  ) {
    const asset = value as WaterValidationRecord;
    const provenanceValid = validCookedWaveProvenance(asset);
    const source =
      asset.sourceMode === 'generated'
        ? {
            kind: 'generated',
            seed: asset.sourceSeed,
            generatorId: asset.generatorId,
            generatorVersion: asset.generatorVersion,
            generatorConfig: asset.generatorConfig,
          }
        : { kind: 'predefined', waves: asset.waves };
    if (
      closedObject(asset, [
        'kind',
        'sourceMode',
        'sourceSeed',
        'generatorId',
        'generatorVersion',
        'generatorConfig',
        'inputDigest',
        'waves',
        'depthMaskM',
        'maxWaveHeightM',
        'timeSource',
      ]) &&
      ['generated', 'predefined'].includes(asset.sourceMode) &&
      provenanceValid &&
      typeof asset.inputDigest === 'string' &&
      /^[0-9a-f]{64}$/i.test(asset.inputDigest) &&
      asset.inputDigest === sha256(canonicalJson(source)) &&
      Array.isArray(asset.waves) &&
      asset.waves.length > 0 &&
      asset.waves.every(
        (wave: unknown) =>
          closedObject(wave, ['directionXZ', 'wavelengthM', 'amplitudeM', 'steepness']) &&
          validWave(wave),
      ) &&
      finite(asset.depthMaskM) &&
      asset.depthMaskM >= 0 &&
      finite(asset.maxWaveHeightM) &&
      asset.maxWaveHeightM >= 0 &&
      ['fixed-step', 'scene-clock'].includes(asset.timeSource)
    )
      return ok(
        value as Extract<
          Asset,
          {
            kind: `water-${string}`;
          }
        >,
      );
    return err({
      code: 'invalid-source',
      expected: 'cooked WaveSet payload with resolved waves and source digest',
      hint: 'cook authored waveSource data before runtime admission',
    });
  }
  const checked = validateWaterAsset(value);
  if (!checked.ok) return checked as Result<never, WaterError>;
  return ok(
    checked.value as Extract<
      Asset,
      {
        kind: `water-${string}`;
      }
    >,
  );
}
export function cookWaterBodySource(
  source: WaterBodySourceAsset,
): Result<import('./contracts.js').WaterBodyAsset, WaterError> {
  if (COOKED_BODY_FIELDS.some((field) => Object.hasOwn(source as object, field)))
    return err({
      code: 'invalid-source',
      expected:
        'WaterBody source without Pack-owned geometry outputs, snapshots or derived Ocean center',
      hint: 'remove derived geometry fields; the Pack cooker generates and digests those outputs',
    });
  const checked = validateWaterAsset(source);
  if (!checked.ok || checked.value.kind !== 'water-body')
    return checked.ok
      ? err({
          code: 'invalid-source',
          expected: 'water-body source payload',
          hint: 'cook only a WaterBody source',
        })
      : checked;
  return ok(freeze(source));
}
export function cookWaterZoneSource(
  source: import('./contracts.js').WaterZoneSourceAsset,
): Result<import('./contracts.js').WaterZoneAsset, WaterError> {
  const checked = validateWaterAsset(source);
  return checked.ok && checked.value.kind === 'water-zone'
    ? ok(freeze(source))
    : checked.ok
      ? err({
          code: 'invalid-source',
          expected: 'water-zone source payload',
          hint: 'cook only a WaterZone source',
        })
      : checked;
}
export type WaterWaveGeneratorInput = Extract<
  WaterWaveSetSource['waveSource'],
  {
    readonly kind: 'generated';
  }
>;
export type WaterWaveGenerator = (
  source: WaterWaveGeneratorInput,
) => Result<readonly WaterWaveSource[], WaterError>;
export const SIMPLE_GERSTNER_WAVE_GENERATOR_ID = 'forgeax.gerstner.simple';
export const SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION = '1';
export type SimpleGerstnerWaveGeneratorConfig = Readonly<{
  count: number;
  randomness: number;
  wavelengthMinM: number;
  wavelengthMaxM: number;
  wavelengthFalloff: number;
  amplitudeMinM: number;
  amplitudeMaxM: number;
  amplitudeFalloff: number;
  windAngleDegrees: number;
  directionAngularSpreadDegrees: number;
  largeWaveSteepness: number;
  smallWaveSteepness: number;
  steepnessFalloff: number;
}>;
function simpleGerstnerConfig(value: unknown): SimpleGerstnerWaveGeneratorConfig | undefined {
  const keys = [
    'count',
    'randomness',
    'wavelengthMinM',
    'wavelengthMaxM',
    'wavelengthFalloff',
    'amplitudeMinM',
    'amplitudeMaxM',
    'amplitudeFalloff',
    'windAngleDegrees',
    'directionAngularSpreadDegrees',
    'largeWaveSteepness',
    'smallWaveSteepness',
    'steepnessFalloff',
  ];
  if (!closedObject(value, keys)) return undefined;
  const config = value as SimpleGerstnerWaveGeneratorConfig;
  if (
    !keys.every((key) => finite((value as Record<string, unknown>)[key])) ||
    !Number.isSafeInteger(config.count) ||
    config.count < 1 ||
    config.count > 4096 ||
    config.randomness < 0 ||
    !(config.wavelengthMinM > 0) ||
    config.wavelengthMaxM < config.wavelengthMinM ||
    config.wavelengthFalloff < 0 ||
    config.amplitudeMinM < 0 ||
    config.amplitudeMaxM < config.amplitudeMinM ||
    config.amplitudeFalloff < 0 ||
    config.windAngleDegrees < -180 ||
    config.windAngleDegrees > 180 ||
    config.directionAngularSpreadDegrees < 0 ||
    config.largeWaveSteepness < 0 ||
    config.smallWaveSteepness < 0 ||
    config.steepnessFalloff < 0
  )
    return undefined;
  return config as SimpleGerstnerWaveGeneratorConfig;
}
function generateSimpleGerstner(
  source: WaterWaveGeneratorInput,
): Result<readonly WaterWaveSource[], WaterError> {
  const config = simpleGerstnerConfig(source.generatorConfig);
  if (!config)
    return err({
      code: 'invalid-source',
      expected:
        'Simple Gerstner config with bounded count/ranges, nonnegative falloffs and valid wind spread',
      hint: 'provide count, wavelength/amplitude ranges and falloffs, wind angle/spread, and steepness range',
    });
  if (!Number.isInteger(source.seed) || source.seed < -2147483648 || source.seed > 2147483647)
    return err({
      code: 'invalid-source',
      expected: 'signed 32-bit deterministic wave seed',
      hint: 'use an integer seed in [-2147483648, 2147483647]',
    });
  // Deterministic wave generation uses an LCG seed,
  // top-bit float fraction, randomized alpha, wind spread and large-to-small steepness.
  const f32 = Math.fround;
  const randomBits = new Uint32Array(1);
  const randomFloat = new Float32Array(randomBits.buffer);
  let seed = source.seed >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 196314165) + 907633515) >>> 0;
    randomBits[0] = 0x3f800000 | (seed >>> 9);
    return f32(requireWaterValue(randomFloat[0]) - 1);
  };
  const range = (min: number, max: number) =>
    f32(f32(min) + f32(f32(f32(max) - f32(min)) * random()));
  const lerp = (min: number, max: number, alpha: number) =>
    f32(f32(min) + f32(f32(f32(max) - f32(min)) * alpha));
  const pow = (base: number, exponent: number) => f32(base ** exponent);
  const degreesToRadians = (degrees: number) => f32(f32(degrees) * f32(Math.PI / 180));
  const windAngle = degreesToRadians(config.windAngleDegrees);
  const windX = f32(Math.cos(windAngle));
  const windZ = f32(Math.sin(windAngle));
  const inverseCount = f32(1 / config.count);
  const randomnessMin = f32(f32(config.randomness) * f32(-inverseCount));
  const randomnessMax = f32(f32(config.randomness) * inverseCount);
  const waves: WaterWaveSource[] = [];
  for (let index = 0; index < config.count; index++) {
    const alpha = Math.max(
      0,
      Math.min(1, f32(f32(1 - f32(index / config.count)) + range(randomnessMin, randomnessMax))),
    );
    let directionXZ: readonly [number, number] = [windX, windZ];
    if (index > 0) {
      const angle = degreesToRadians(
        range(-config.directionAngularSpreadDegrees, config.directionAngularSpreadDegrees),
      );
      const cosine = f32(Math.cos(angle));
      const sine = f32(Math.sin(angle));
      directionXZ = [
        f32(f32(windX * cosine) - f32(windZ * sine)),
        f32(f32(windX * sine) + f32(windZ * cosine)),
      ];
    }
    const steepnessAlpha = pow(f32(index / config.count), config.steepnessFalloff);
    waves.push(
      Object.freeze({
        directionXZ: Object.freeze(directionXZ),
        wavelengthM: lerp(
          config.wavelengthMinM,
          config.wavelengthMaxM,
          pow(alpha, config.wavelengthFalloff),
        ),
        amplitudeM: Math.max(
          lerp(config.amplitudeMinM, config.amplitudeMaxM, pow(alpha, config.amplitudeFalloff)),
          0.0001,
        ),
        steepness: lerp(config.largeWaveSteepness, config.smallWaveSteepness, steepnessAlpha),
      }),
    );
  }
  return ok(Object.freeze(waves));
}
export class WaterWaveGeneratorRegistry {
  readonly #generators = new Map<string, WaterWaveGenerator>();
  register(
    generatorId: string,
    generatorVersion: string,
    generate: WaterWaveGenerator,
  ): Result<void, WaterError> {
    if (!generatorId.trim() || !generatorVersion.trim() || typeof generate !== 'function')
      return err({
        code: 'invalid-source',
        expected: 'a named, versioned deterministic Wave generator',
        hint: 'register a generator with its exact source generatorId and generatorVersion',
      });
    const key = `${generatorId}\u0000${generatorVersion}`;
    if (this.#generators.has(key))
      return err({
        code: 'invalid-source',
        expected: `one immutable registration for ${generatorId}@${generatorVersion}`,
        hint: 'choose a new generator version instead of replacing an existing registration',
      });
    this.#generators.set(key, generate);
    return ok(undefined);
  }
  resolve(generatorId: string, generatorVersion: string): WaterWaveGenerator | undefined {
    return this.#generators.get(`${generatorId}\u0000${generatorVersion}`);
  }
}
const builtInWaveGenerators = new WaterWaveGeneratorRegistry();
builtInWaveGenerators.register(
  SIMPLE_GERSTNER_WAVE_GENERATOR_ID,
  SIMPLE_GERSTNER_WAVE_GENERATOR_VERSION,
  generateSimpleGerstner,
);
function plainNumericConfig(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === 'boolean' || finite(entry),
    )
  );
}
export function cookWaterWaveSetSource(
  source: WaterWaveSetSource,
  generators?: WaterWaveGeneratorRegistry | WaterWaveGenerator,
): Result<import('./contracts.js').WaterWaveSetAsset, WaterError> {
  const checked = validateWaterAsset(source);
  if (!checked.ok || checked.value.kind !== 'water-wave-set')
    return checked.ok
      ? err({
          code: 'invalid-source',
          expected: 'water-wave-set source payload',
          hint: 'cook only a WaterWaveSet source',
        })
      : checked;
  let waves: readonly WaterWaveSource[];
  if (source.waveSource.kind === 'generated') {
    const builtIn = builtInWaveGenerators.resolve(
      source.waveSource.generatorId,
      source.waveSource.generatorVersion,
    );
    const generate =
      builtIn ??
      (generators instanceof WaterWaveGeneratorRegistry
        ? generators.resolve(source.waveSource.generatorId, source.waveSource.generatorVersion)
        : generators);
    if (!generate)
      return err({
        code: 'invalid-source',
        expected: `registered deterministic generator ${source.waveSource.generatorId}@${source.waveSource.generatorVersion}`,
        hint: 'install the matching generator before cooking',
      });
    let first: Result<readonly WaterWaveSource[], WaterError>;
    let second: Result<readonly WaterWaveSource[], WaterError>;
    try {
      first = generate(source.waveSource);
      second = generate(source.waveSource);
    } catch {
      return err({
        code: 'invalid-source',
        expected: 'deterministic wave generator output',
        hint: 'fix the generator and cook again',
      });
    }
    if (!first.ok || !second.ok || canonicalJson(first.value) !== canonicalJson(second.value))
      return err({
        code: 'invalid-source',
        expected: 'repeatable deterministic output from the declared generator version',
        hint: 'fix the generator or source configuration',
      });
    waves = first.value;
  } else waves = source.waveSource.waves;
  if (!waves.length || !waves.every(validWave))
    return err({
      code: 'invalid-source',
      expected: 'at least one finite wave with non-zero direction and positive wavelength',
      hint: 'repair the wave list or generator output',
    });
  const generatedHeightBound = waves.reduce((sum, wave) => sum + wave.amplitudeM, 0);
  if (source.maxWaveHeightM < generatedHeightBound)
    return err({
      code: 'invalid-source',
      expected: 'maxWaveHeightM at least the sum of WaveSet wave amplitudes',
      hint: 'increase the conservative WaveSet height bound before cooking',
      detail: { amplitudeBoundM: generatedHeightBound, maxWaveHeightM: source.maxWaveHeightM },
    });
  const generated = source.waveSource.kind === 'generated';
  return ok(
    freeze({
      kind: 'water-wave-set',
      sourceMode: source.waveSource.kind,
      ...(generated
        ? {
            sourceSeed: source.waveSource.seed,
            generatorId: source.waveSource.generatorId,
            generatorVersion: source.waveSource.generatorVersion,
            generatorConfig: source.waveSource.generatorConfig,
          }
        : {}),
      inputDigest: sha256(canonicalJson(source.waveSource)),
      waves,
      depthMaskM: source.depthMaskM,
      maxWaveHeightM: source.maxWaveHeightM,
      timeSource: source.timeSource,
    }),
  );
}
export function cookWaterBrushRecipeSource(
  source: import('@forgeax/engine-types').WaterBrushRecipeSource,
): Result<import('./contracts.js').WaterBrushRecipeAsset, WaterError> {
  const checked = validateWaterAsset(source);
  return checked.ok && checked.value.kind === 'water-brush-recipe'
    ? ok(freeze(source))
    : checked.ok
      ? err({
          code: 'invalid-source',
          expected: 'water-brush-recipe source payload',
          hint: 'cook only a WaterBrushRecipe source',
        })
      : checked;
}
export function cookWaterSimulationRecipeSource(
  source: import('@forgeax/engine-types').WaterSimulationRecipeSource,
): Result<import('./contracts.js').WaterSimulationRecipeAsset, WaterError> {
  const checked = validateWaterAsset(source);
  return checked.ok && checked.value.kind === 'water-simulation-recipe'
    ? ok(freeze(source))
    : checked.ok
      ? err({
          code: 'invalid-source',
          expected: 'water-simulation-recipe source payload',
          hint: 'cook only a WaterSimulationRecipe source',
        })
      : checked;
}
export function cookWaterAsset(
  source: unknown,
  options: {
    readonly waveGenerators?: WaterWaveGeneratorRegistry;
    readonly generateWaves?: WaterWaveGenerator;
  } = {},
): Result<
  Extract<
    Asset,
    {
      kind: `water-${string}`;
    }
  >,
  WaterError
> {
  const checked = validateWaterAsset(source);
  if (!checked.ok) return checked as Result<never, WaterError>;
  switch (checked.value.kind) {
    case 'water-body':
      return cookWaterBodySource(checked.value);
    case 'water-zone':
      return cookWaterZoneSource(checked.value);
    case 'water-wave-set':
      return cookWaterWaveSetSource(checked.value, options.waveGenerators ?? options.generateWaves);
    case 'water-brush-recipe':
      return cookWaterBrushRecipeSource(checked.value);
    case 'water-simulation-recipe':
      return cookWaterSimulationRecipeSource(checked.value);
  }
}

function validateWaterBodyPayload(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  {
    if (
      asset.transitionContinuity !== undefined &&
      (asset.type !== 'river' ||
        !closed(asset.transitionContinuity, ['target', 'endpoint', 'reachM', 'blendWidthM']) ||
        asset.transitionContinuity.target !== 'ocean' ||
        asset.transitionContinuity.endpoint !== 'end' ||
        !finite(asset.transitionContinuity.reachM) ||
        !finite(asset.transitionContinuity.blendWidthM) ||
        asset.transitionContinuity.blendWidthM <= 0 ||
        asset.transitionContinuity.reachM <= asset.transitionContinuity.blendWidthM)
    )
      return fail(
        'optional River terminal continuity with finite positive blend width and longer endpoint reach',
      );
    const problem = validateBodySchema(asset, closed, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodySpline(asset, closed, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodyAssetReferences(asset, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodyCollisionNumbers(asset, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodyCollisionExtent(asset, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodyOceanAndCustomSettings(asset, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBodyRenderingSettings(asset, fail);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function validateWaterZonePayload(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !closed(asset, [
      'kind',
      'extentM',
      'tileSizeM',
      'tessellationFactor',
      'lodScale',
      'gpuMesh',
      'waterInfo',
      'farExtentM',
      'farMaterialGuid',
      'farMeshBoundary',
      'farWaterLevelM',
      'farOwnerBodyGuid',
      'priority',
    ]) ||
    !closed(asset.extentM, ['spanXM', 'spanZM']) ||
    (asset.farExtentM !== undefined && !closed(asset.farExtentM, ['spanXM', 'spanZM'])) ||
    !closed(asset.waterInfo, [
      'resolution',
      'format',
      'blurRadius',
      'localTessellation',
      'localExtentM',
    ]) ||
    !closed(asset.waterInfo?.resolution, ['widthPx', 'heightPx'])
  )
    return fail('closed WaterZone schema in meters and XZ');
  if (
    asset.gpuMesh !== undefined &&
    (!closed(asset.gpuMesh, ['supersampling', 'msaaSamples', 'occlusion']) ||
      !Number.isInteger(asset.gpuMesh.supersampling) ||
      asset.gpuMesh.supersampling < 1 ||
      asset.gpuMesh.supersampling > 8 ||
      ![1, 4].includes(asset.gpuMesh.msaaSamples) ||
      !['disabled', 'hzb', 'precise', 'hzb-precise'].includes(asset.gpuMesh.occlusion))
  )
    return fail('GPU WaterMesh supersampling 1..8, WebGPU MSAA 1/4 and a closed occlusion mode');
  const extent = asset.extentM;
  const info = asset.waterInfo;
  const resolution = info?.resolution;
  const hasFarWaterLevel = asset.farWaterLevelM !== undefined;
  const hasFarOwner = asset.farOwnerBodyGuid !== undefined;
  // The accepted range follows template allocation limits.
  function invalidTileSizeMAndTessellationFactorAndLodScaleFields1(): boolean {
    return (
      !extent ||
      !finite(extent.spanXM) ||
      !finite(extent.spanZM) ||
      extent.spanXM <= 0 ||
      extent.spanZM <= 0 ||
      !finite(asset.tileSizeM) ||
      asset.tileSizeM <= 0 ||
      !Number.isInteger(asset.tessellationFactor) ||
      asset.tessellationFactor < 0 ||
      asset.tessellationFactor > MAX_WATER_MESH_TESSELLATION_FACTOR ||
      !finite(asset.lodScale) ||
      asset.lodScale <= 0 ||
      !resolution ||
      !Number.isInteger(resolution.widthPx) ||
      resolution.widthPx <= 0 ||
      !Number.isInteger(resolution.heightPx)
    );
  }
  function invalidFarExtentMAndSpanXMAndSpanZMFields2(): boolean {
    return (
      resolution.heightPx <= 0 ||
      !['rgba16f', 'rgba32f'].includes(info.format) ||
      !finite(info.blurRadius) ||
      info.blurRadius < 0 ||
      typeof info.localTessellation !== 'boolean' ||
      (info.localExtentM !== undefined &&
        (!Array.isArray(info.localExtentM) ||
          info.localExtentM.length !== 3 ||
          info.localExtentM.some((value: unknown) => !finite(value) || value <= 0))) ||
      (asset.farExtentM &&
        (!finite(asset.farExtentM.spanXM) ||
          !finite(asset.farExtentM.spanZM) ||
          asset.farExtentM.spanXM <= 0 ||
          asset.farExtentM.spanZM <= 0)) ||
      (asset.farMaterialGuid !== undefined && !guid(asset.farMaterialGuid))
    );
  }
  function invalidFarMeshBoundaryAndFarExtentMAndFarMaterialGuidFields3(): boolean {
    return (
      (asset.farMeshBoundary !== undefined &&
        !['zone', 'view-window'].includes(asset.farMeshBoundary)) ||
      (asset.farMeshBoundary === 'view-window' &&
        (!info.localTessellation ||
          asset.farExtentM === undefined ||
          asset.farMaterialGuid === undefined)) ||
      hasFarWaterLevel !== hasFarOwner ||
      (hasFarWaterLevel && (!finite(asset.farWaterLevelM) || asset.farExtentM === undefined)) ||
      (hasFarOwner && !guid(asset.farOwnerBodyGuid))
    );
  }
  if (
    invalidTileSizeMAndTessellationFactorAndLodScaleFields1() ||
    invalidFarExtentMAndSpanXMAndSpanZMFields2() ||
    invalidFarMeshBoundaryAndFarExtentMAndFarMaterialGuidFields3()
  )
    return fail(
      `finite Zone dimensions, WaterInfo settings, ForgeAX-budgeted TessellationFactor in [0, ${MAX_WATER_MESH_TESSELLATION_FACTOR}], view-window far boundary with local tessellation, far extent and material, and paired no-Ocean far level/owner with far extent`,
    );
  return undefined;
}

function validateWaterWaveSetPayload(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  {
    const problem = validateWaveSetSchema(asset, closed, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateWaveSetSource(asset, fail);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function validateWaterBrushRecipePayload(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  {
    const problem = validateBrushRecipeSchema(asset, closed, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBrushRecipeInputs(asset, fail);
    if (problem !== undefined) return problem;
  }
  {
    const problem = validateBrushRecipeDependencies(asset, fail);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function validateWaterSimulationRecipePayload(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !closed(
      asset,
      asset.system === 'fluid-simulation'
        ? [
            'kind',
            'system',
            'configurationVersion',
            'solverMode',
            'terrainMode',
            'resolution',
            'virtualFps',
            'maxStepsPerFrame',
            'gridExtentM',
            'waveFoam',
            'targets',
            'injectionLimits',
            'maxImpulses',
            'impulseNoiseGuid',
            'parameters',
            'shallowFoamEnabled',
            'foamEnabled',
            'materialGuids',
            'textureGuids',
          ]
        : [
            'kind',
            'system',
            'configurationVersion',
            'enabledFeatures',
            'shallowStageConfig',
            'substepConfig',
            'riverBakeConfig',
            'oceanPatchConfig',
            'materialGuids',
            'textureGuids',
          ],
    )
  )
    return fail('closed SimulationRecipe schema');
  if (
    !Array.isArray(asset.materialGuids) ||
    !asset.materialGuids.every(guid) ||
    !Array.isArray(asset.textureGuids) ||
    !asset.textureGuids.every(guid)
  )
    return fail('simulation material and texture GUID lists');
  if (asset.system === 'fluid-simulation') {
    if (!validWaterFluidConfiguration(asset) || !guid(asset.impulseNoiseGuid))
      return fail(
        'version-1 built-in fluid settings, empty materialGuids/textureGuids and per-channel injection limits',
      );
  } else if (asset.system === 'water-advanced') {
    const problem0 = validateAdvancedFeatureConfiguration(asset, fail);
    if (problem0 !== undefined) return problem0;
    const problem1 = validateAdvancedShallowConfiguration(asset, closed, fail);
    if (problem1 !== undefined) return problem1;
    const problem2 = validateAdvancedRiverBakeConfiguration(asset, closed, fail);
    if (problem2 !== undefined) return problem2;
    const problem3 = validateAdvancedOceanPatchConfiguration(asset, closed, fail);
    if (problem3 !== undefined) return problem3;
    const problem4 = validateDisabledAdvancedConfiguration(asset, fail);
    if (problem4 !== undefined) return problem4;
  } else return fail('fluid-simulation or water-advanced');
  return undefined;
}

function validateBodySchema(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.type === 'custom' &&
    asset.flags?.affectsWaterInfo === true &&
    asset.customMeshOverrideGuid === undefined
  )
    return fail('Custom WaterInfo participation requires customMeshOverrideGuid');
  if (
    asset.type === 'custom' &&
    asset.flags?.affectsWaterMesh === true &&
    asset.customMeshOverrideGuid === undefined
  )
    return fail('Custom WaterMesh participation requires customMeshOverrideGuid');
  function invalidSplineAndInterpolationVersionAndMetadataDefaultsFields1(): boolean {
    return (
      !closed(asset, [
        'kind',
        'type',
        'spline',
        'baseHeightM',
        'fixedWaterDepthM',
        'overlapPriority',
        'maxWaveHeightM',
        'maxWaveHeightOffsetM',
        'channelDepthM',
        'shapeDilationM',
        'surfaceMaterialGuid',
        'flags',
        'collision',
        'queryFootprint',
        'zoneGuid',
        'oceanExtentM',
        'centerOnWaterZone',
        'savedZoneLocationWorldXZ',
        'oceanCenterM',
        'waveSetGuid',
        'heightOffsetM',
        'customMeshOverrideGuid',
        'riverToLakeTransitionMaterialGuid',
        'riverToOceanTransitionMaterialGuid',
        'transitionContinuity',
        'waterInfoMaterialGuid',
        'lodMaterialGuid',
        'underwaterPostProcessMaterialGuid',
        'underwaterSettings',
        'geometryCook',
        'renderOptions',
        'waveBounds',
        ...COOKED_BODY_FIELDS,
      ]) ||
      !closed(asset.spline, ['closed', 'points', 'metadataDefaults', 'interpolationVersion']) ||
      (asset.spline.interpolationVersion !== undefined &&
        asset.spline.interpolationVersion !== 'water-spline/2') ||
      (asset.spline.metadataDefaults !== undefined &&
        (!closed(asset.spline.metadataDefaults, [
          'widthM',
          'depthM',
          'velocityMPerSec',
          'audioIntensity',
        ]) ||
          ['widthM', 'depthM', 'velocityMPerSec', 'audioIntensity'].some(
            (key) => !finite(asset.spline.metadataDefaults[key]),
          ) ||
          asset.spline.metadataDefaults.widthM < 0 ||
          asset.spline.metadataDefaults.depthM < 0)) ||
      !closed(asset.flags, ['affectsWaterInfo', 'affectsWaterMesh', 'affectsLandscape']) ||
      !closed(asset.collision, [
        'collisionGroups',
        'type',
        'enabled',
        'points',
        'meshGuid',
        'channelDepthM',
        'collisionHalfHeightM',
        'collisionHalfExtentsM',
        'collisionHeightOffsetM',
      ]) ||
      (asset.geometryAuthoringWorldMatrixM !== undefined &&
        !finiteVec(asset.geometryAuthoringWorldMatrixM, 16)) ||
      (asset.underwaterSettings !== undefined &&
        !closed(asset.underwaterSettings, [
          'enabled',
          'priority',
          'maxDepthM',
          'blendRadiusM',
          'blendWeight',
        ]))
    );
  }
  function invalidGeometryCookAndRenderOptionsAndWaveBoundsFields2(): boolean {
    return (
      (asset.geometryCook !== undefined &&
        !closed(asset.geometryCook, ['splineToleranceM', 'collisionToleranceM'])) ||
      (asset.renderOptions !== undefined &&
        !closed(asset.renderOptions, ['castShadow', 'receiveShadow', 'visible'])) ||
      (asset.waveBounds !== undefined &&
        !closed(asset.waveBounds, ['minimumM', 'maximumM', 'edgeBlendWidthM'])) ||
      !validGeometrySnapshot(asset)
    );
  }
  if (
    invalidSplineAndInterpolationVersionAndMetadataDefaultsFields1() ||
    invalidGeometryCookAndRenderOptionsAndWaveBoundsFields2()
  )
    return fail(
      'closed WaterBody schema using only ForgeAX meter fields and a digest-verified geometry snapshot',
    );
  if (!validWaterGeometryProducts(asset))
    return fail(
      'valid Pack water geometry version and required independent WaterInfo/Dilation mesh references',
    );
  return undefined;
}

function validateBodySpline(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !['river', 'lake', 'ocean', 'custom'].includes(asset.type) ||
    !asset.spline ||
    typeof asset.spline.closed !== 'boolean' ||
    (asset.spline.interpolationVersion !== undefined &&
      asset.spline.interpolationVersion !== 'water-spline/2') ||
    !Array.isArray(asset.spline.points) ||
    asset.spline.points.length < 2 ||
    (['river', 'custom'].includes(asset.type) && asset.spline.closed) ||
    (['lake', 'ocean'].includes(asset.type) &&
      (!asset.spline.closed || asset.spline.points.length < 3))
  )
    return fail(
      'River and Custom open splines, Lake and Ocean closed splines, and supported versioned Water spline interpolation',
    );
  for (const [index, point] of asset.spline.points.entries())
    if (
      invalidBodySplineCoordinates(point, index, closed) ||
      invalidBodySplineOrientation(asset, point) ||
      invalidBodySplineMetadata(point)
    )
      return fail(
        'spline points use supported Water modes, canonical rotation keys for water-spline/2, sequential keys, finite positions, tangents, metadata and degree roll',
      );
  return undefined;
}

function validateBodyAssetReferences(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  const refs = [
    asset.surfaceMaterialGuid,
    asset.zoneGuid,
    asset.waveSetGuid,
    asset.customMeshOverrideGuid,
    asset.collision?.meshGuid,
    asset.visibleMeshGuid,
    asset.waterInfoMeshGuid,
    asset.dilatedWaterInfoMeshGuid,
    asset.brushShapeMeshGuid,
    asset.collisionMeshGuid,
    asset.riverToLakeTransitionMaterialGuid,
    asset.riverToOceanTransitionMaterialGuid,
    asset.waterInfoMaterialGuid,
    asset.lodMaterialGuid,
    asset.underwaterPostProcessMaterialGuid,
    ...(Array.isArray(asset.riverSegmentMeshGuids) ? asset.riverSegmentMeshGuids : []),
  ];
  const optionalMeshFields = [
    'visibleMeshGuid',
    'waterInfoMeshGuid',
    'dilatedWaterInfoMeshGuid',
    'brushShapeMeshGuid',
    'collisionMeshGuid',
  ];
  function invalidRiverSegmentMeshGuidsAndLengthAndPointsFields1(): boolean {
    return (
      refs.some((ref) => ref !== undefined && !guid(ref)) ||
      optionalMeshFields.some(
        (field) => asset[field] !== undefined && typeof asset[field] !== 'string',
      ) ||
      (asset.riverSegmentMeshGuids !== undefined &&
        (!Array.isArray(asset.riverSegmentMeshGuids) ||
          asset.riverSegmentMeshGuids.length !== asset.spline.points.length - 1 ||
          new Set(asset.riverSegmentMeshGuids).size !== asset.riverSegmentMeshGuids.length ||
          asset.riverSegmentMeshGuids.some((value: unknown) => !guid(value)))) ||
      (asset.riverSegmentMeshGuids !== undefined &&
        (asset.type !== 'river' || asset.renderOptions?.visible === false)) ||
      (asset.visibleMeshGuid !== undefined && asset.type === 'river') ||
      (asset.waterInfoMeshGuid !== undefined && asset.flags?.affectsWaterInfo !== true)
    );
  }
  function invalidDilatedWaterInfoMeshGuidAndTypeAndFlagsFields2(): boolean {
    return (
      (asset.dilatedWaterInfoMeshGuid !== undefined &&
        (asset.type === 'custom' ||
          asset.flags?.affectsWaterInfo !== true ||
          asset.shapeDilationM === 0)) ||
      (asset.waterGeometryVersion !== undefined && asset.waterGeometryVersion !== 2) ||
      (asset.waterGeometryVersion === 2 &&
        asset.flags?.affectsWaterInfo === true &&
        asset.waterInfoMeshGuid === undefined) ||
      (asset.waterGeometryVersion === 2 &&
        asset.flags?.affectsWaterInfo === true &&
        asset.type !== 'custom' &&
        (asset.shapeDilationM ?? WATER_BODY_DEFAULT_SHAPE_DILATION_M) > 0 &&
        asset.dilatedWaterInfoMeshGuid === undefined)
    );
  }
  function invalidWaterGeometryVersionAndFlagsAndTypeFields3(): boolean {
    return (
      (asset.waterGeometryVersion === 2 &&
        asset.flags?.affectsWaterInfo === true &&
        asset.type === 'custom' &&
        asset.customMeshOverrideGuid === undefined) ||
      (asset.brushShapeMeshGuid !== undefined && asset.flags?.affectsLandscape !== true) ||
      (asset.collisionMeshGuid !== undefined &&
        (!asset.collision?.enabled ||
          asset.type === 'river' ||
          asset.collision.type === 'custom-mesh')) ||
      !finite(asset.baseHeightM) ||
      (asset.fixedWaterDepthM !== undefined &&
        (!finite(asset.fixedWaterDepthM) || asset.fixedWaterDepthM < 0))
    );
  }
  function invalidShapeDilationMAndHeightOffsetMAndTypeFields4(): boolean {
    return (
      (asset.shapeDilationM !== undefined &&
        (!finite(asset.shapeDilationM) || asset.shapeDilationM < 0)) ||
      (asset.heightOffsetM !== undefined && !finite(asset.heightOffsetM)) ||
      (asset.type !== 'ocean' && asset.heightOffsetM !== undefined) ||
      !Number.isInteger(asset.overlapPriority) ||
      !finite(asset.maxWaveHeightM) ||
      asset.maxWaveHeightM < 0 ||
      (asset.maxWaveHeightOffsetM !== undefined &&
        (!finite(asset.maxWaveHeightOffsetM) ||
          asset.maxWaveHeightOffsetM < 0 ||
          asset.maxWaveHeightOffsetM > asset.maxWaveHeightM ||
          (asset.type !== 'river' && asset.type !== 'lake')))
    );
  }
  function invalidChannelDepthMAndFlagsAndCollisionFields5(): boolean {
    return (
      (asset.channelDepthM !== undefined &&
        (!finite(asset.channelDepthM) || asset.channelDepthM < 0)) ||
      !asset.flags ||
      ['affectsWaterInfo', 'affectsWaterMesh', 'affectsLandscape'].some(
        (key) => typeof asset.flags[key] !== 'boolean',
      ) ||
      !validCollision(asset.collision, asset.type) ||
      !validPolygon(asset.queryFootprint)
    );
  }
  if (
    invalidRiverSegmentMeshGuidsAndLengthAndPointsFields1() ||
    invalidDilatedWaterInfoMeshGuidAndTypeAndFlagsFields2() ||
    invalidWaterGeometryVersionAndFlagsAndTypeFields3() ||
    invalidShapeDilationMAndHeightOffsetMAndTypeFields4() ||
    invalidChannelDepthMAndFlagsAndCollisionFields5()
  )
    return fail(
      'valid material/asset GUIDs, nonnegative fixed water depth, wave height and ShapeDilationM, Ocean-only heightOffsetM, complete body flags, collision and non-degenerate simple query polygon',
    );
  if (asset.overlapPriority < -8192 || asset.overlapPriority > 8191)
    return fail('WaterBody overlapPriority in [-8192, 8191]');
  return undefined;
}

function validateBodyCollisionNumbers(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.collision.collisionGroups !== undefined &&
    (!Number.isInteger(asset.collision.collisionGroups) ||
      asset.collision.collisionGroups < 0 ||
      asset.collision.collisionGroups > 0xffffffff)
  )
    return fail('unsigned packed water collisionGroups');
  if (
    asset.collision.channelDepthM !== undefined &&
    (!finite(asset.collision.channelDepthM) || asset.collision.channelDepthM <= 0)
  )
    return fail('positive Lake collision channelDepthM in meters');
  if (
    asset.collision.collisionHalfHeightM !== undefined &&
    (!finite(asset.collision.collisionHalfHeightM) || asset.collision.collisionHalfHeightM <= 0)
  )
    return fail('positive Ocean collisionHalfHeightM in meters');
  if (
    asset.collision.collisionHalfExtentsM !== undefined &&
    (!finiteVec(asset.collision.collisionHalfExtentsM, 2) ||
      asset.collision.collisionHalfExtentsM.some((value: number) => value <= 0))
  )
    return fail('positive Ocean world collision XZ half extents in meters');
  if (
    asset.collision.collisionHeightOffsetM !== undefined &&
    !finite(asset.collision.collisionHeightOffsetM)
  )
    return fail('finite collisionHeightOffsetM in meters');
  return undefined;
}

function validateBodyCollisionExtent(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  return validateLakeCollisionExtent(asset, fail) ?? validateOceanCollisionExtent(asset, fail);
}

function validateBodyOceanAndCustomSettings(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.type === 'ocean' &&
    (!finiteVec(asset.oceanExtentM, 2) || asset.oceanExtentM.some((value: number) => value <= 0))
  )
    return fail('positive Ocean body extent in meters independent from the Zone span');
  if (asset.oceanCenterM !== undefined && !finiteVec(asset.oceanCenterM, 2))
    return fail('finite actor-local Ocean visible center in meters');
  if (asset.centerOnWaterZone !== undefined && typeof asset.centerOnWaterZone !== 'boolean')
    return fail('boolean centerOnWaterZone setting');
  if (asset.savedZoneLocationWorldXZ !== undefined && !finiteVec(asset.savedZoneLocationWorldXZ, 2))
    return fail('finite saved Zone world XZ location in meters');
  if (
    asset.type !== 'ocean' &&
    (asset.oceanCenterM !== undefined ||
      asset.centerOnWaterZone !== undefined ||
      asset.savedZoneLocationWorldXZ !== undefined)
  )
    return fail('Ocean-only center and saved Zone location fields');
  if (asset.type !== 'ocean' && asset.oceanExtentM !== undefined)
    return fail('Ocean-only body extent in meters');
  return validateCustomBodySettings(asset, fail);
}

function validateBodyRenderingSettings(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.underwaterSettings !== undefined &&
    (typeof asset.underwaterSettings.enabled !== 'boolean' ||
      !Number.isInteger(asset.underwaterSettings.priority) ||
      (asset.underwaterSettings.blendRadiusM !== undefined &&
        (!finite(asset.underwaterSettings.blendRadiusM) ||
          asset.underwaterSettings.blendRadiusM < 0)) ||
      (asset.underwaterSettings.blendWeight !== undefined &&
        (!finite(asset.underwaterSettings.blendWeight) ||
          asset.underwaterSettings.blendWeight < 0 ||
          asset.underwaterSettings.blendWeight > 1)) ||
      !finite(asset.underwaterSettings.maxDepthM) ||
      asset.underwaterSettings.maxDepthM < 0)
  )
    return fail('typed underwater settings in meters');
  return validateBodyGeometryAndRenderSettings(asset, fail);
}

function validateWaveSetSchema(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !closed(asset, ['kind', 'waveSource', 'depthMaskM', 'maxWaveHeightM', 'timeSource']) ||
    !closed(
      asset.waveSource,
      asset.waveSource?.kind === 'generated'
        ? ['kind', 'seed', 'generatorId', 'generatorVersion', 'generatorConfig']
        : ['kind', 'waves'],
    ) ||
    (asset.waveSource?.kind === 'predefined' &&
      (!Array.isArray(asset.waveSource.waves) ||
        !asset.waveSource.waves.every((wave: unknown) =>
          closed(wave, ['directionXZ', 'wavelengthM', 'amplitudeM', 'steepness']),
        )))
  )
    return fail('closed WaveSet schema with XZ and meter-valued waves');
  if (
    !asset.waveSource ||
    !['generated', 'predefined'].includes(asset.waveSource.kind) ||
    !finite(asset.depthMaskM) ||
    asset.depthMaskM < 0 ||
    !finite(asset.maxWaveHeightM) ||
    asset.maxWaveHeightM < 0 ||
    !['fixed-step', 'scene-clock'].includes(asset.timeSource)
  )
    return fail('wave source, nonnegative meter dimensions and time source');
  return undefined;
}

function validateWaveSetSource(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  const waves = asset.waveSource.kind === 'generated' ? [] : asset.waveSource.waves;
  if (!Array.isArray(waves)) return fail('predefined wave list');
  if (
    asset.waveSource.kind === 'generated' &&
    (!Number.isSafeInteger(asset.waveSource.seed) ||
      typeof asset.waveSource.generatorId !== 'string' ||
      !asset.waveSource.generatorId ||
      typeof asset.waveSource.generatorVersion !== 'string' ||
      !asset.waveSource.generatorVersion ||
      !asset.waveSource.generatorConfig ||
      typeof asset.waveSource.generatorConfig !== 'object' ||
      Array.isArray(asset.waveSource.generatorConfig) ||
      Object.values(asset.waveSource.generatorConfig).some(
        (v) => typeof v !== 'boolean' && !finite(v),
      ))
  )
    return fail(
      'generated wave safe-integer seed, generator id/version and finite record configuration',
    );
  for (const wave of waves)
    if (!validWave(wave))
      return fail('finite waves with non-zero XZ direction and positive meter wavelength');
  return undefined;
}

function validateBrushRecipeSchema(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !closed(asset, [
      'kind',
      'actorVersion',
      'baseTerrainGuid',
      'sourceBodyGuids',
      'orderedActors',
      'curves',
      'textures',
      'outputTerrainSourceKey',
      'rules',
      'terrainCapture',
    ]) ||
    ![undefined, 0, 1].includes(asset.actorVersion) ||
    !closed(asset.rules, ['falloff', 'blend', 'heightRules', 'weightRules']) ||
    !closed(asset.rules?.falloff, ['type', 'widthM', 'strength']) ||
    !closed(asset.rules?.blend, ['type', 'alpha']) ||
    !closed(asset.rules?.heightRules, ['mode', 'offsetM', 'velocityMPerSec']) ||
    !closed(asset.rules?.weightRules, ['layer', 'value', 'blend']) ||
    !validBrushTerrainCapture(asset.terrainCapture)
  )
    return fail(
      'closed BrushRecipe schema with explicit Terrain pose, bounds, resolution and layer-name mapping',
    );
  return undefined;
}

function validateBrushRecipeInputs(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  const rules = asset.rules;
  const actorIds = Array.isArray(asset.orderedActors)
    ? asset.orderedActors.map((actor: unknown) => {
        if (typeof actor === 'string') return actor;
        if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return undefined;
        const record = actor as WaterValidationRecord;
        return record.actorId ?? record.sourceKey ?? record.bodyGuid;
      })
    : [];
  function invalidBaseTerrainGuidAndSourceBodyGuidsAndEveryFields1(): boolean {
    return (
      !guid(asset.baseTerrainGuid) ||
      !Array.isArray(asset.sourceBodyGuids) ||
      !asset.sourceBodyGuids.every(guid) ||
      !Array.isArray(asset.orderedActors) ||
      !asset.orderedActors.every((actor: unknown) =>
        validBrushActor(actor, asset.actorVersion ?? 0),
      ) ||
      new Set(actorIds).size !== actorIds.length ||
      !Array.isArray(asset.curves) ||
      !asset.curves.every(guid) ||
      !Array.isArray(asset.textures) ||
      !asset.textures.every(guid) ||
      typeof asset.outputTerrainSourceKey !== 'string' ||
      !rules ||
      typeof rules.falloff?.type !== 'string' ||
      !rules.falloff.type ||
      !finite(rules.falloff.widthM) ||
      rules.falloff.widthM < 0
    );
  }
  function invalidSchemaFields2(): boolean {
    return (
      !finite(rules.falloff.strength) ||
      rules.falloff.strength < 0 ||
      typeof rules.blend?.type !== 'string' ||
      !rules.blend.type ||
      !finite(rules.blend.alpha) ||
      rules.blend.alpha < 0 ||
      rules.blend.alpha > 1 ||
      typeof rules.heightRules?.mode !== 'string' ||
      !finite(rules.heightRules.offsetM) ||
      !finite(rules.heightRules.velocityMPerSec) ||
      typeof rules.weightRules?.layer !== 'string' ||
      !finite(rules.weightRules.value) ||
      rules.weightRules.value < 0 ||
      rules.weightRules.value > 1 ||
      typeof rules.weightRules.blend !== 'string' ||
      !rules.weightRules.blend
    );
  }
  if (invalidBaseTerrainGuidAndSourceBodyGuidsAndEveryFields1() || invalidSchemaFields2())
    return fail(
      'base Terrain, source bodies, unique stable actor order, refs and finite legacy Brush defaults',
    );
  return undefined;
}

function validateBrushRecipeDependencies(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  const rules = asset.rules;
  const layerNames = new Set(Object.keys(asset.terrainCapture.layerNameToIndex));
  if (
    asset.actorVersion === 1 &&
    (rules.falloff.type !== 'width' ||
      rules.falloff.widthM !== 0 ||
      rules.falloff.strength !== 1 ||
      rules.blend.type !== 'alpha' ||
      rules.blend.alpha !== 1 ||
      rules.heightRules.mode !== 'offset' ||
      rules.heightRules.offsetM !== 0 ||
      rules.heightRules.velocityMPerSec !== 0 ||
      rules.weightRules.value !== 0 ||
      !['add', 'additive'].includes(rules.weightRules.blend))
  )
    return fail(
      'neutral legacy BrushRecipe globals for typed v1 actors; author operational settings in each actor rules record',
    );
  if (
    !layerNames.has(rules.weightRules.layer) ||
    asset.orderedActors.some(
      (actor: WaterValidationRecord) =>
        actor &&
        typeof actor === 'object' &&
        ((actor.rules?.weightSettings ?? []).some(
          (setting: WaterValidationRecord) => !layerNames.has(setting.layerName),
        ) ||
          ((asset.actorVersion ?? 0) === 0 &&
            actor.kind === 'island' &&
            !layerNames.has(actor.terrainRules.weightLayer)) ||
          (actor.kind === 'body' && !asset.sourceBodyGuids.includes(actor.bodyGuid)) ||
          (actor.rules?.curves.elevationCurveGuid &&
            !asset.curves.includes(actor.rules.curves.elevationCurveGuid)) ||
          (actor.rules?.displacement.textureGuid &&
            !asset.textures.includes(actor.rules.displacement.textureGuid)) ||
          (actor.rules?.weightSettings ?? []).some(
            (setting: WaterValidationRecord) =>
              setting.modulationTextureGuid &&
              !asset.textures.includes(setting.modulationTextureGuid),
          )),
    )
  )
    return fail(
      'every body/dependency and named weight layer resolves through the frozen recipe closure',
    );
  return undefined;
}

function validBrushFalloff(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.falloff, ['mode', 'widthM', 'angleDegrees', 'edgeOffsetM', 'zOffsetM']) &&
    ['width', 'angle'].includes(rules.falloff.mode) &&
    finite(rules.falloff.widthM) &&
    rules.falloff.widthM >= 0 &&
    finite(rules.falloff.angleDegrees) &&
    rules.falloff.angleDegrees >= 0 &&
    rules.falloff.angleDegrees <= 360 &&
    finite(rules.falloff.edgeOffsetM) &&
    finite(rules.falloff.zOffsetM)
  );
}

function validBrushBlend(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.blend, ['type']) &&
    ['alpha', 'min', 'max', 'additive'].includes(rules.blend.type)
  );
}

function validBrushBlurring(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.blurring, ['enabled', 'radiusPx']) &&
    typeof rules.blurring.enabled === 'boolean' &&
    Number.isSafeInteger(rules.blurring.radiusPx) &&
    rules.blurring.radiusPx >= 0 &&
    rules.blurring.radiusPx <= 4096
  );
}

function validBrushCurlNoise(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.curlNoise, ['firstAmount', 'firstTiling', 'secondAmount', 'secondTiling']) &&
    ['firstAmount', 'firstTiling', 'secondAmount', 'secondTiling'].every((key) =>
      finite(rules.curlNoise[key]),
    )
  );
}

function validBrushCurves(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.curves, [
      'useCurveChannel',
      'elevationCurveGuid',
      'channelEdgeOffsetM',
      'channelDepthM',
      'curveRampWidthM',
    ]) &&
    typeof rules.curves.useCurveChannel === 'boolean' &&
    optionalBrushGuid(rules.curves.elevationCurveGuid) &&
    finite(rules.curves.channelEdgeOffsetM) &&
    finite(rules.curves.channelDepthM) &&
    rules.curves.channelDepthM >= 0 &&
    finite(rules.curves.curveRampWidthM) &&
    rules.curves.curveRampWidthM >= 0 &&
    (!rules.curves.useCurveChannel ||
      rules.curves.elevationCurveGuid === undefined ||
      guid(rules.curves.elevationCurveGuid))
  );
}

function validBrushDisplacement(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.displacement, [
      'enabled',
      'heightM',
      'textureTiling',
      'textureGuid',
      'midpoint',
      'channel',
      'weightmapInfluence',
    ]) &&
    typeof rules.displacement.enabled === 'boolean' &&
    finite(rules.displacement.heightM) &&
    finite(rules.displacement.textureTiling) &&
    rules.displacement.textureTiling >= 0 &&
    optionalBrushGuid(rules.displacement.textureGuid) &&
    (!rules.displacement.enabled || guid(rules.displacement.textureGuid)) &&
    finite(rules.displacement.midpoint) &&
    Number.isInteger(rules.displacement.channel) &&
    rules.displacement.channel >= 0 &&
    rules.displacement.channel <= 3 &&
    finite(rules.displacement.weightmapInfluence)
  );
}

function validBrushSmoothBlending(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.smoothBlending, ['innerDistanceM', 'outerDistanceM']) &&
    finite(rules.smoothBlending.innerDistanceM) &&
    rules.smoothBlending.innerDistanceM >= 0 &&
    finite(rules.smoothBlending.outerDistanceM) &&
    rules.smoothBlending.outerDistanceM >= 0
  );
}

function validBrushTerracing(rules: WaterValidationRecord): boolean {
  return (
    closedObject(rules.terracing, [
      'alpha',
      'spacingM',
      'smoothness',
      'maskLengthM',
      'maskStartOffsetM',
    ]) &&
    finite(rules.terracing.alpha) &&
    finite(rules.terracing.spacingM) &&
    rules.terracing.spacingM >= 0 &&
    finite(rules.terracing.smoothness) &&
    finite(rules.terracing.maskLengthM) &&
    rules.terracing.maskLengthM >= 0 &&
    finite(rules.terracing.maskStartOffsetM)
  );
}

function validBrushWeightSettings(rules: WaterValidationRecord): boolean {
  return (
    Array.isArray(rules.weightSettings) &&
    rules.weightSettings.every(
      (setting: WaterValidationRecord) =>
        closedObject(setting, [
          'layerName',
          'falloffWidthM',
          'edgeOffsetM',
          'modulationTextureGuid',
          'textureTiling',
          'textureInfluence',
          'midpoint',
          'finalOpacity',
        ]) &&
        typeof setting.layerName === 'string' &&
        setting.layerName.length > 0 &&
        finite(setting.falloffWidthM) &&
        setting.falloffWidthM >= 0 &&
        finite(setting.edgeOffsetM) &&
        optionalBrushGuid(setting.modulationTextureGuid) &&
        finite(setting.textureTiling) &&
        setting.textureTiling >= 0 &&
        finite(setting.textureInfluence) &&
        finite(setting.midpoint) &&
        finite(setting.finalOpacity),
    ) &&
    new Set(rules.weightSettings.map((setting: WaterValidationRecord) => setting.layerName))
      .size === rules.weightSettings.length
  );
}

function optionalBrushGuid(value: unknown): boolean {
  return value === undefined || guid(value);
}

function validBrushSplineCoordinates(point: WaterValidationRecord): boolean {
  return (
    closedObject(point, [
      'inputKey',
      'interpolationMode',
      'positionM',
      'arriveTangentM',
      'leaveTangentM',
      'rotationQuat',
      'arriveRotationQuat',
      'leaveRotationQuat',
      'up',
      'rollAngle',
      'angleUnit',
      'widthM',
      'depthM',
      'velocityMPerSec',
      'audioIntensity',
    ]) &&
    finite(point.inputKey) &&
    (point.interpolationMode === undefined ||
      ['linear', 'curve', 'curve-clamped', 'curve-custom-tangent'].includes(
        point.interpolationMode,
      )) &&
    finiteVec(point.positionM, 3) &&
    finiteVec(point.arriveTangentM, 3) &&
    finiteVec(point.leaveTangentM, 3) &&
    finiteVec(point.up, 3) &&
    Math.hypot(...point.up) > 0
  );
}

function validBrushSplineOrientation(
  spline: WaterValidationRecord,
  point: WaterValidationRecord,
): boolean {
  return (
    (point.rotationQuat === undefined ||
      (finiteVec(point.rotationQuat, 4) && Math.hypot(...point.rotationQuat) > 0)) &&
    (spline.interpolationVersion !== 'water-spline/2' ||
      (point.rotationQuat &&
        ((point.interpolationMode ?? 'curve') !== 'curve-custom-tangent' ||
          (point.arriveRotationQuat && point.leaveRotationQuat)) &&
        versionedSplineOrientationValid(point))) &&
    (point.arriveRotationQuat === undefined ||
      (finiteVec(point.arriveRotationQuat, 4) && Math.hypot(...point.arriveRotationQuat) > 0)) &&
    (point.leaveRotationQuat === undefined ||
      (finiteVec(point.leaveRotationQuat, 4) && Math.hypot(...point.leaveRotationQuat) > 0))
  );
}

function validBrushSplineMetadata(point: WaterValidationRecord): boolean {
  return (
    finite(point.rollAngle) &&
    point.angleUnit === 'degrees' &&
    finite(point.widthM) &&
    point.widthM >= 0 &&
    finite(point.depthM) &&
    point.depthM >= 0 &&
    finite(point.velocityMPerSec) &&
    finite(point.audioIntensity)
  );
}

function invalidDispersiveLattice(
  value: WaterValidationRecord,
  n: number,
  gpuFinite: (value: unknown) => value is number,
): boolean {
  return (
    value.algorithm !== 'mode-projected-gravity/1' ||
    !Number.isInteger(n) ||
    n < 8 ||
    n > 2048 ||
    (n & (n - 1)) !== 0 ||
    !finiteVec(value.centerXZ, 2) ||
    !value.centerXZ.every(gpuFinite) ||
    !gpuFinite(value.baseHeightM)
  );
}

function invalidDispersivePhysicalControls(
  value: WaterValidationRecord,
  n: number,
  gpuFinite: (value: unknown) => value is number,
  gpuPositive: (value: unknown) => value is number,
): boolean {
  return (
    (value.entryWaveMultiplier !== undefined &&
      (!gpuFinite(value.entryWaveMultiplier) || value.entryWaveMultiplier < 0)) ||
    (value.surfaceTransportMultiplier !== undefined &&
      (!gpuFinite(value.surfaceTransportMultiplier) || value.surfaceTransportMultiplier < 0)) ||
    (value.waveDampingPerSecond !== undefined && !gpuPositive(value.waveDampingPerSecond)) ||
    !['domainLengthM', 'referenceDepthM', 'gravityMPerSec2', 'maximumIntervalSeconds'].every(
      (key) => gpuPositive(value[key]),
    ) ||
    !gpuPositive(Math.fround(value.domainLengthM) / n) ||
    !['rgba16float', 'rgba32float'].includes(value.normalRtFormat) ||
    value.gridMesh !== null
  );
}

function validDispersiveCollision(
  c: WaterValidationRecord,
  gpuPositive: (value: unknown) => value is number,
): boolean {
  if (
    !closedObject(c, [
      'kind',
      'collisionGroups',
      'maxElements',
      'fieldStepM',
      'maximumFieldSamplesPerColumn',
    ]) ||
    !['simple', 'distance-field'].includes(c.kind) ||
    !Number.isInteger(c.collisionGroups) ||
    c.collisionGroups < 0 ||
    c.collisionGroups > 0xffffffff ||
    !Number.isInteger(c.maxElements) ||
    c.maxElements < 1 ||
    c.maxElements > 100 ||
    !gpuPositive(c.fieldStepM) ||
    !Number.isInteger(c.maximumFieldSamplesPerColumn) ||
    c.maximumFieldSamplesPerColumn < 2 ||
    c.maximumFieldSamplesPerColumn > 512
  )
    return false;
  return true;
}

function validateLakeCollisionExtent(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.type === 'lake' &&
    asset.collision.enabled &&
    asset.collision.channelDepthM === undefined
  )
    return fail('Lake collision channelDepthM in meters');
  if (
    asset.type === 'lake' &&
    asset.collision.enabled &&
    requireWaterValue(asset.collision.channelDepthM) +
      (asset.collision.collisionHeightOffsetM ?? 0) <=
      0
  )
    return fail(
      'Lake collision half-height channelDepthM/2 + collisionHeightOffsetM/2 must be positive',
    );
  if (asset.type !== 'lake' && asset.collision.channelDepthM !== undefined)
    return fail('Lake-only collision channelDepthM');
  return undefined;
}
function validateOceanCollisionExtent(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.type === 'ocean' &&
    asset.collision.enabled &&
    asset.collision.collisionHalfHeightM === undefined
  )
    return fail('Ocean collisionHalfHeightM in meters');
  if (
    asset.type === 'ocean' &&
    asset.collision.enabled &&
    asset.collision.collisionHalfExtentsM === undefined
  )
    return fail('Ocean collisionHalfExtentsM in world meters, independent of visible OceanExtents');
  if (
    asset.type === 'ocean' &&
    asset.collision.enabled &&
    2 * requireWaterValue(asset.collision.collisionHalfHeightM) +
      (asset.collision.collisionHeightOffsetM ?? 0) <=
      0
  )
    return fail(
      'Ocean collision half-height collisionHalfHeightM + collisionHeightOffsetM/2 must be positive',
    );
  if (asset.type !== 'ocean' && asset.collision.collisionHalfHeightM !== undefined)
    return fail('Ocean-only collisionHalfHeightM');
  if (asset.type !== 'ocean' && asset.collision.collisionHalfExtentsM !== undefined)
    return fail('Ocean-only collisionHalfExtentsM');
  return undefined;
}

function validLegacyBrushTerrainRules(legacyRules: WaterValidationRecord): boolean {
  return Boolean(
    closedObject(legacyRules, ['falloffWidthM', 'heightOffsetM', 'weightLayer', 'weightValue']) &&
      finite(legacyRules.falloffWidthM) &&
      legacyRules.falloffWidthM >= 0 &&
      finite(legacyRules.heightOffsetM) &&
      typeof legacyRules.weightLayer === 'string' &&
      finite(legacyRules.weightValue) &&
      legacyRules.weightValue >= 0 &&
      legacyRules.weightValue <= 1,
  );
}

function validBrushIslandSpline(spline: WaterValidationRecord): boolean {
  return (
    closedObject(spline, ['closed', 'points', 'interpolationVersion']) &&
    (spline.interpolationVersion === undefined ||
      spline.interpolationVersion === 'water-spline/2') &&
    spline.closed === true &&
    Array.isArray(spline.points) &&
    spline.points.length >= 3 &&
    spline.points.every((point: WaterValidationRecord) => validBrushSplinePoint(spline, point)) &&
    validPolygon(
      spline.points.map((point: { positionM: readonly number[] }) => [
        point.positionM[0],
        point.positionM[2],
      ]),
    )
  );
}

function validateAdvancedFeatureConfiguration(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    (asset.configurationVersion !== 1 && asset.configurationVersion !== 2) ||
    !Array.isArray(asset.enabledFeatures) ||
    new Set(asset.enabledFeatures).size !== asset.enabledFeatures.length ||
    asset.enabledFeatures.some(
      (f: unknown) => !['shallow', 'shallowFoam', 'riverBake', 'oceanPatch'].includes(String(f)),
    )
  )
    return fail('closed advanced-water feature list');
  if (asset.configurationVersion === 2 && !asset.enabledFeatures.includes('oceanPatch'))
    return fail('configuration version 2 requires the OceanPatch visual FFT child');
  return undefined;
}

function validateAdvancedShallowConfiguration(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.enabledFeatures.includes('shallow') &&
    (invalidAdvancedShallowSchema(asset, closed) ||
      invalidAdvancedShallowPhysicalState(asset) ||
      invalidAdvancedShallowTransport(asset) ||
      invalidAdvancedShallowOutput(asset))
  )
    return fail('closed shallow stage and positive substep configuration');
  if (
    asset.enabledFeatures.includes('shallowFoam') &&
    (!asset.enabledFeatures.includes('shallow') ||
      asset.shallowStageConfig?.stageProfile !== 'water-body-shallow/2')
  )
    return fail('shallowFoam requires the WaterBody shallow stage profile');
  return undefined;
}

function validateAdvancedRiverBakeConfiguration(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.enabledFeatures.includes('riverBake') &&
    (!asset.enabledFeatures.includes('shallow') ||
      !closed(asset.riverBakeConfig, [
        'sourceBodyGuid',
        'outputSourceKey',
        'bakeExtentM',
        'queryFootprint',
        'bakedGrid',
      ]) ||
      !guid(asset.riverBakeConfig.sourceBodyGuid) ||
      typeof asset.riverBakeConfig.outputSourceKey !== 'string' ||
      !asset.riverBakeConfig.outputSourceKey ||
      !finiteVec(asset.riverBakeConfig.bakeExtentM, 2) ||
      asset.riverBakeConfig.bakeExtentM.some((v: number) => v <= 0) ||
      asset.riverBakeConfig.bakeExtentM.some(
        (v: number, index: number) => v !== asset.shallowStageConfig?.extentM[index],
      ) ||
      !validPolygon(asset.riverBakeConfig.queryFootprint) ||
      asset.shallowStageConfig?.stageProfile !== 'river-shallow/2' ||
      (asset.riverBakeConfig.bakedGrid !== undefined &&
        !validRiverBakedGrid(
          asset.riverBakeConfig.bakedGrid,
          asset.riverBakeConfig.bakeExtentM,
          asset.shallowStageConfig.gridResolution,
        )))
  )
    return fail(
      'River Bake requires shallow, a River source and positive extent with a simple query polygon',
    );
  const riverBakeGrid = asset.riverBakeConfig?.bakedGrid;
  if (
    asset.enabledFeatures.includes('riverBake') &&
    riverBakeGrid?.version === 'water-river-bake/2' &&
    ![riverBakeGrid.textureGuid, riverBakeGrid.normalTextureGuid].every((textureGuid) =>
      asset.textureGuids.some(
        (declaredGuid: string) => declaredGuid.toLowerCase() === textureGuid.toLowerCase(),
      ),
    )
  )
    return fail(
      'version-2 River Bake requires both grid and direct solver-normal textures in the recipe texture closure',
    );
  return undefined;
}

function validateAdvancedOceanPatchConfiguration(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.enabledFeatures.includes('oceanPatch') &&
    (asset.oceanPatchConfig?.algorithm === 'mode-projected-gravity/1'
      ? asset.configurationVersion === 1
        ? !validDispersiveOcean(asset.oceanPatchConfig)
        : !validDispersiveOcean(asset.oceanPatchConfig, true) ||
          !validVisualNormalDetailFft(
            asset.oceanPatchConfig.visualNormalDetailFft,
            asset.textureGuids,
          )
      : !closed(asset.oceanPatchConfig, [
          'windAngleDegrees',
          'windSpeedMPerSec',
          'algorithm',
          'noiseTextureGuid',
          'fftResolution',
          'domainLengthM',
          'normalDomainSizeM',
          'gravityMPerSec2',
          'phillipsAmplitude',
          'windAlignment',
          'timeScale',
          'slosh',
          'chopHack',
          'twiddle',
          'normalization',
          'normalRtFormat',
          'gridMesh',
        ]) ||
        asset.configurationVersion !== 1 ||
        !finite(asset.oceanPatchConfig.windAngleDegrees) ||
        !finite(asset.oceanPatchConfig.windSpeedMPerSec) ||
        !guid(asset.oceanPatchConfig.noiseTextureGuid) ||
        asset.oceanPatchConfig.algorithm !== 'ocean-spectrum-fft/2' ||
        !Number.isInteger(asset.oceanPatchConfig.fftResolution) ||
        asset.oceanPatchConfig.fftResolution < 8 ||
        asset.oceanPatchConfig.fftResolution > 1024 ||
        (asset.oceanPatchConfig.fftResolution & (asset.oceanPatchConfig.fftResolution - 1)) !== 0 ||
        !['domainLengthM', 'normalDomainSizeM', 'gravityMPerSec2', 'timeScale'].every(
          (key) => finite(asset.oceanPatchConfig[key]) && asset.oceanPatchConfig[key] > 0,
        ) ||
        !['phillipsAmplitude', 'windAlignment', 'slosh', 'chopHack'].every((key) =>
          finite(asset.oceanPatchConfig[key]),
        ) ||
        invalidLegacyOceanFftOutput(asset, closed))
  )
    return fail('closed OceanPatch wind, texture, positive FFT, normal format and mesh flag');
  return undefined;
}

function validateDisabledAdvancedConfiguration(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    !asset.enabledFeatures.includes('shallow') &&
    (asset.shallowStageConfig !== undefined || asset.substepConfig !== undefined)
  )
    return fail('shallow-only stage and substep configuration');
  if (!asset.enabledFeatures.includes('riverBake') && asset.riverBakeConfig !== undefined)
    return fail('riverBake-only configuration');
  if (!asset.enabledFeatures.includes('oceanPatch') && asset.oceanPatchConfig !== undefined)
    return fail('oceanPatch-only configuration');
  return undefined;
}

function invalidAdvancedShallowSchema(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
): boolean {
  return (
    !closed(asset.shallowStageConfig, [
      'stageProfile',
      'gridResolution',
      'extentM',
      'baseHeightM',
      'initialDepthM',
      'gravityMPerSec2',
      'frictionPerSecond',
      'maximumVelocityMPerSec',
      'dryDepthM',
      'maximumDepthM',
      'keepWaterDepthInsideColliders',
      'distributeOverlapVolume',
      'advection',
      'advectionVelocityMultiplier',
      'velocityDissipationPerSecond',
      'complexUpwind',
      'upwind',
      'depthLimiter',
      'integrationDepthMax',
      'thinFilmDepthM',
      'thinFilmDampingPerSecond',
      'edgeDissipationEnabled',
      'overlapRadiusCells',
      'overlapVolumeMultiplier',
      'collisionFalloff',
      'rigidMeshCollisions',
      'postSimVelocityBlurRadiusCells',
      'normalSmoothingRadiusCells',
      'normalFoamRange',
      'startFadeSeconds',
      'runLiveSimulation',
      'foam',
      'followPawn',
      'waterInfoRequired',
      'debug',
      'beautyEnabled',
      'materialGuids',
      'normalRtFormat',
    ]) ||
    !['water-body-shallow/2', 'river-shallow/2'].includes(asset.shallowStageConfig.stageProfile)
  );
}

function invalidAdvancedShallowPhysicalState(asset: WaterValidationRecord): boolean {
  return (
    !finiteVec(asset.shallowStageConfig.gridResolution, 2) ||
    !asset.shallowStageConfig.gridResolution.every(
      (v: number) => Number.isInteger(v) && v >= 8 && v <= 1024,
    ) ||
    !finiteVec(asset.shallowStageConfig.extentM, 2) ||
    asset.shallowStageConfig.extentM.some((v: number) => v <= 0) ||
    !finite(asset.shallowStageConfig.baseHeightM) ||
    !finite(asset.shallowStageConfig.initialDepthM) ||
    asset.shallowStageConfig.initialDepthM < 0 ||
    !finite(asset.shallowStageConfig.gravityMPerSec2) ||
    asset.shallowStageConfig.gravityMPerSec2 <= 0 ||
    !finite(asset.shallowStageConfig.frictionPerSecond) ||
    asset.shallowStageConfig.frictionPerSecond < 0 ||
    !finite(asset.shallowStageConfig.maximumVelocityMPerSec) ||
    asset.shallowStageConfig.maximumVelocityMPerSec <= 0 ||
    !finite(asset.shallowStageConfig.dryDepthM) ||
    asset.shallowStageConfig.dryDepthM <= 0 ||
    !finite(asset.shallowStageConfig.maximumDepthM) ||
    asset.shallowStageConfig.maximumDepthM <= asset.shallowStageConfig.dryDepthM ||
    asset.shallowStageConfig.initialDepthM > asset.shallowStageConfig.maximumDepthM
  );
}

function invalidAdvancedShallowTransport(asset: WaterValidationRecord): boolean {
  return (
    ![
      'advectionVelocityMultiplier',
      'velocityDissipationPerSecond',
      'thinFilmDepthM',
      'thinFilmDampingPerSecond',
      'overlapVolumeMultiplier',
    ].every((key) => finite(asset.shallowStageConfig[key]) && asset.shallowStageConfig[key] >= 0) ||
    !finite(asset.shallowStageConfig.integrationDepthMax) ||
    asset.shallowStageConfig.integrationDepthMax <= 0 ||
    !finite(asset.shallowStageConfig.collisionFalloff) ||
    asset.shallowStageConfig.collisionFalloff < 0 ||
    asset.shallowStageConfig.collisionFalloff >= 1 ||
    !validAdvancedRigidMeshCollisions(asset.shallowStageConfig.rigidMeshCollisions) ||
    !['overlapRadiusCells', 'postSimVelocityBlurRadiusCells', 'normalSmoothingRadiusCells'].every(
      (key) =>
        Number.isInteger(asset.shallowStageConfig[key]) &&
        asset.shallowStageConfig[key] >= 0 &&
        asset.shallowStageConfig[key] <= 8,
    ) ||
    !['bilinear', 'cubic'].includes(asset.shallowStageConfig.advection) ||
    ![
      'followPawn',
      'waterInfoRequired',
      'runLiveSimulation',
      'beautyEnabled',
      'keepWaterDepthInsideColliders',
      'distributeOverlapVolume',
      'complexUpwind',
      'upwind',
      'depthLimiter',
      'edgeDissipationEnabled',
    ].every((key) => typeof asset.shallowStageConfig[key] === 'boolean')
  );
}

function invalidAdvancedShallowOutput(asset: WaterValidationRecord): boolean {
  return (
    !validAdvancedFoam(asset.shallowStageConfig.foam) ||
    !finiteVec(asset.shallowStageConfig.normalFoamRange, 2) ||
    !asset.shallowStageConfig.normalFoamRange.every((value: number) =>
      Number.isFinite(Math.fround(value)),
    ) ||
    asset.shallowStageConfig.normalFoamRange[0] > asset.shallowStageConfig.normalFoamRange[1] ||
    !finite(asset.shallowStageConfig.startFadeSeconds) ||
    !Number.isFinite(Math.fround(asset.shallowStageConfig.startFadeSeconds)) ||
    Math.fround(asset.shallowStageConfig.startFadeSeconds) <= 0 ||
    !validAdvancedDebug(asset.shallowStageConfig.debug, asset.shallowStageConfig.stageProfile) ||
    !Array.isArray(asset.shallowStageConfig.materialGuids) ||
    !asset.shallowStageConfig.materialGuids.every(guid) ||
    !['rgba16float', 'rgba32float'].includes(asset.shallowStageConfig.normalRtFormat) ||
    !validAdvancedSubsteps(asset.substepConfig)
  );
}

function validRiverBakedGridV2(
  grid: WaterValidationRecord,
  sourceFrame: Record<string, unknown> | undefined,
  v2Keys: readonly string[],
): boolean {
  return (
    grid.version === 'water-river-bake/2' &&
    closedObject(grid, v2Keys) &&
    guid(grid.normalTextureGuid) &&
    grid.normalBasis === 'lattice-axis0-axis1-up/1' &&
    Array.isArray(grid.sourceWorldMatrixM) &&
    grid.sourceWorldMatrixM.length === 16 &&
    grid.sourceWorldMatrixM.every(finite) &&
    typeof grid.sourceGeometryProjectionHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(grid.sourceGeometryProjectionHash) &&
    closedObject(sourceFrame, ['generation', 'sequence', 'step', 'timeSeconds']) &&
    ['generation', 'sequence', 'step'].every(
      (key) =>
        typeof sourceFrame?.[key] === 'number' &&
        Number.isSafeInteger(sourceFrame?.[key]) &&
        sourceFrame?.[key] >= 0,
    ) &&
    finite(sourceFrame?.timeSeconds) &&
    sourceFrame?.timeSeconds >= 0 &&
    typeof sourceFrame?.step === 'number' &&
    sourceFrame?.step > 0 &&
    sourceFrame?.generation === grid.simulationGeneration &&
    sourceFrame?.sequence === grid.sequence
  );
}

function compatibleWaterCollisionType(collision: WaterValidationRecord, bodyType: string): boolean {
  return bodyType === 'river'
    ? collision.type === 'none' || collision.type === 'river-prism'
    : bodyType === 'lake' || bodyType === 'ocean'
      ? collision.type === 'none' || collision.type === 'polygon'
      : collision.type === 'none' ||
        collision.type === 'polygon' ||
        collision.type === 'custom-mesh';
}

function validWaterCollisionShape(
  collision: WaterValidationRecord,
  bodyType: string,
  derivedPolygon: boolean,
): boolean {
  return (
    (collision.type !== 'none' || !collision.enabled) &&
    (collision.type !== 'polygon' || derivedPolygon || validPolygon(collision.points)) &&
    (collision.type !== 'river-prism' || collision.points === undefined) &&
    (collision.type !== 'custom-mesh' || !collision.enabled || guid(collision.meshGuid)) &&
    ((bodyType !== 'lake' && bodyType !== 'ocean') || collision.points === undefined) &&
    (collision.type !== 'custom-mesh' || collision.points === undefined)
  );
}

function validGeometryCollisionDescriptor(
  source: WaterBodySourceAsset,
  descriptor: WaterValidationRecord,
  boundary: (value: WaterValidationRecord) => boolean,
): boolean {
  const validRiver = validGeometryRiverConvexes(descriptor);
  const topCapRoles = descriptor.riverSegmentConvexTopCapVertexIndices;
  const validRiverTopCapRoles = validGeometryRiverTopCaps(source, descriptor, topCapRoles);
  const mesh = descriptor.customMesh;
  const validMesh = validGeometryCustomMesh(mesh);
  if (
    !closedObject(descriptor, [
      'version',
      'digest',
      'footprint',
      'minimumYM',
      'maximumYM',
      'riverSegmentConvexes',
      'riverSegmentConvexTopCapVertexIndices',
      'customMesh',
    ]) ||
    (descriptor.version !== 1 && descriptor.version !== 2) ||
    typeof descriptor.digest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(descriptor.digest) ||
    !boundary(descriptor.footprint) ||
    !finite(descriptor.minimumYM) ||
    !finite(descriptor.maximumYM) ||
    descriptor.minimumYM > descriptor.maximumYM ||
    (descriptor.minimumYM === descriptor.maximumYM && mesh === undefined) ||
    !validRiver ||
    !validRiverTopCapRoles ||
    !validMesh
  )
    return false;

  return true;
}

function validGeometryRiverConvexes(descriptor: WaterValidationRecord): boolean {
  return (
    descriptor.riverSegmentConvexes === undefined ||
    (Array.isArray(descriptor.riverSegmentConvexes) &&
      descriptor.riverSegmentConvexes.every(
        (segment: unknown) =>
          Array.isArray(segment) &&
          segment.length > 0 &&
          segment.every(
            (hull: unknown) =>
              Array.isArray(hull) &&
              hull.length >= 4 &&
              hull.every((point: unknown) => finiteVec(point, 3)),
          ),
      ))
  );
}

function validGeometryRiverTopCaps(
  source: WaterBodySourceAsset,
  descriptor: WaterValidationRecord,
  topCapRoles: WaterValidationRecord,
): boolean {
  return descriptor.version === 1
    ? topCapRoles === undefined &&
        !Object.hasOwn(descriptor, 'riverSegmentConvexTopCapVertexIndices')
    : source.type === 'river' &&
        descriptor.customMesh === undefined &&
        !Object.hasOwn(descriptor, 'customMesh') &&
        Array.isArray(descriptor.riverSegmentConvexes) &&
        Array.isArray(topCapRoles) &&
        topCapRoles.length === descriptor.riverSegmentConvexes.length &&
        topCapRoles.every(
          (segment: unknown, segmentIndex: number) =>
            Array.isArray(segment) &&
            segment.length === descriptor.riverSegmentConvexes?.[segmentIndex]?.length &&
            segment.every(
              (indices: unknown, hullIndex: number) =>
                Array.isArray(indices) &&
                indices.length === 4 &&
                indices.every(
                  (index: unknown, roleIndex: number) =>
                    typeof index === 'number' &&
                    Number.isSafeInteger(index) &&
                    index === [4, 5, 6, 7][roleIndex] &&
                    index <
                      (descriptor.riverSegmentConvexes?.[segmentIndex]?.[hullIndex]?.length ?? 0),
                ) &&
                descriptor.riverSegmentConvexes?.[segmentIndex]?.[hullIndex]?.length === 8,
            ),
        );
}

function validGeometryCustomMesh(mesh: WaterValidationRecord): boolean {
  return (
    mesh === undefined ||
    (closedObject(mesh, ['meshGuid', 'vertices', 'indices']) &&
      guid(mesh.meshGuid) &&
      Array.isArray(mesh.vertices) &&
      mesh.vertices.length >= 9 &&
      mesh.vertices.length % 3 === 0 &&
      mesh.vertices.every(finite) &&
      Array.isArray(mesh.indices) &&
      mesh.indices.length >= 3 &&
      mesh.indices.length % 3 === 0 &&
      mesh.indices.every(
        (index: unknown) =>
          typeof index === 'number' &&
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index < mesh.vertices.length / 3,
      ))
  );
}

function invalidGeometryQueryVolume(
  source: WaterBodySourceAsset,
  queryVolume: WaterValidationRecord,
): boolean {
  return (
    !closedObject(queryVolume, ['version', 'digest', 'minimumYM', 'maximumYM']) ||
    queryVolume.version !== 1 ||
    typeof queryVolume.digest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(queryVolume.digest) ||
    !finite(queryVolume.minimumYM) ||
    !finite(queryVolume.maximumYM) ||
    queryVolume.minimumYM >= queryVolume.maximumYM ||
    queryVolume.digest !==
      waterQueryVolumeDigest(source, {
        version: 1,
        minimumYM: queryVolume.minimumYM,
        maximumYM: queryVolume.maximumYM,
      })
  );
}

function waterPolygonEdgesIntersect(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
  cross: (a: readonly number[], b: readonly number[], c: readonly number[]) => number,
): boolean {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  const onSegment = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
    requireWaterValue(q[0]) >= Math.min(requireWaterValue(p[0]), requireWaterValue(r[0])) &&
    requireWaterValue(q[0]) <= Math.max(requireWaterValue(p[0]), requireWaterValue(r[0])) &&
    requireWaterValue(q[1]) >= Math.min(requireWaterValue(p[1]), requireWaterValue(r[1])) &&
    requireWaterValue(q[1]) <= Math.max(requireWaterValue(p[1]), requireWaterValue(r[1]));
  if (
    (abC === 0 && onSegment(a, c, b)) ||
    (abD === 0 && onSegment(a, d, b)) ||
    (cdA === 0 && onSegment(c, a, d)) ||
    (cdB === 0 && onSegment(c, b, d)) ||
    (abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0)
  )
    return true;
  return false;
}

function invalidBodySplineCoordinates(
  point: WaterValidationRecord,
  index: number,
  closed: (record: unknown, keys: readonly string[]) => boolean,
): boolean {
  return (
    !closed(point, [
      'inputKey',
      'interpolationMode',
      'positionM',
      'arriveTangentM',
      'leaveTangentM',
      'rotationQuat',
      'arriveRotationQuat',
      'leaveRotationQuat',
      'up',
      'rollAngle',
      'angleUnit',
      'widthM',
      'depthM',
      'velocityMPerSec',
      'audioIntensity',
    ]) ||
    !finite(point.inputKey) ||
    point.inputKey !== index ||
    (point.interpolationMode !== undefined &&
      !['linear', 'curve', 'curve-clamped', 'curve-custom-tangent'].includes(
        point.interpolationMode,
      )) ||
    !finiteVec(point.positionM, 3) ||
    !finiteVec(point.arriveTangentM, 3) ||
    !finiteVec(point.leaveTangentM, 3) ||
    !finiteVec(point.up, 3) ||
    Math.hypot(...point.up) === 0
  );
}

function invalidBodySplineOrientation(
  asset: WaterValidationRecord,
  point: WaterValidationRecord,
): boolean {
  return (
    (point.rotationQuat !== undefined &&
      (!finiteVec(point.rotationQuat, 4) || Math.hypot(...point.rotationQuat) === 0)) ||
    (point.arriveRotationQuat !== undefined &&
      (!finiteVec(point.arriveRotationQuat, 4) || Math.hypot(...point.arriveRotationQuat) === 0)) ||
    (point.leaveRotationQuat !== undefined &&
      (!finiteVec(point.leaveRotationQuat, 4) || Math.hypot(...point.leaveRotationQuat) === 0)) ||
    (asset.spline.interpolationVersion === 'water-spline/2' &&
      (!point.rotationQuat ||
        ((point.interpolationMode ?? 'curve') === 'curve-custom-tangent' &&
          (!point.arriveRotationQuat || !point.leaveRotationQuat)) ||
        !versionedSplineOrientationValid(point)))
  );
}

function invalidBodySplineMetadata(point: WaterValidationRecord): boolean {
  return (
    !finite(point.rollAngle) ||
    point.angleUnit !== 'degrees' ||
    !finite(point.widthM) ||
    point.widthM < 0 ||
    !finite(point.depthM) ||
    point.depthM < 0 ||
    !finite(point.velocityMPerSec) ||
    !finite(point.audioIntensity)
  );
}

function validCookedWaveProvenance(asset: WaterValidationRecord): boolean {
  return asset.sourceMode === 'generated'
    ? Number.isSafeInteger(asset.sourceSeed) &&
        typeof asset.generatorId === 'string' &&
        asset.generatorId.length > 0 &&
        typeof asset.generatorVersion === 'string' &&
        asset.generatorVersion.length > 0 &&
        plainNumericConfig(asset.generatorConfig)
    : asset.sourceMode === 'predefined' &&
        asset.sourceSeed === undefined &&
        asset.generatorId === undefined &&
        asset.generatorVersion === undefined &&
        asset.generatorConfig === undefined;
}

function validateCustomBodySettings(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.type === 'custom' &&
    asset.customMeshOverrideGuid !== undefined &&
    !guid(asset.customMeshOverrideGuid)
  )
    return fail('optional Custom override mesh GUID');
  if (asset.type !== 'custom' && asset.customMeshOverrideGuid !== undefined)
    return fail('Custom-only override mesh on a Custom body');
  return undefined;
}

function validateBodyGeometryAndRenderSettings(
  asset: WaterValidationRecord,
  fail: (expected: string) => Result<WaterAsset, WaterError>,
): Result<WaterAsset, WaterError> | undefined {
  if (
    asset.geometryCook !== undefined &&
    (!finite(asset.geometryCook.splineToleranceM) ||
      asset.geometryCook.splineToleranceM <= 0 ||
      !finite(asset.geometryCook.collisionToleranceM) ||
      asset.geometryCook.collisionToleranceM <= 0)
  )
    return fail('typed geometry cook tolerances in meters');
  if (
    asset.renderOptions !== undefined &&
    Object.values(asset.renderOptions).some((value) => typeof value !== 'boolean')
  )
    return fail('typed boolean render options');
  if (
    asset.waveBounds !== undefined &&
    (!finite(asset.waveBounds.minimumM) ||
      !finite(asset.waveBounds.maximumM) ||
      asset.waveBounds.minimumM > asset.waveBounds.maximumM ||
      !finite(asset.waveBounds.edgeBlendWidthM) ||
      asset.waveBounds.edgeBlendWidthM < 0)
  )
    return fail('typed meter wave bounds');
  return undefined;
}

function validBrushBodyActor(actor: WaterValidationRecord, version: number): boolean {
  return (
    version === 1 &&
    closedObject(actor, ['kind', 'actorId', 'fullName', 'bodyType', 'bodyGuid', 'rules']) &&
    typeof actor.fullName === 'string' &&
    actor.fullName.length > 0 &&
    ['ocean', 'lake', 'river', 'custom'].includes(actor.bodyType) &&
    guid(actor.bodyGuid) &&
    validBrushActorRules(actor.rules)
  );
}

function validBrushIslandActor(
  actor: WaterValidationRecord,
  version: number,
  allowedKeys: readonly string[],
  fullNameValid: boolean,
  terrainRulesValid: boolean,
): boolean {
  return Boolean(
    actor.kind === 'island' &&
      closedObject(actor, allowedKeys) &&
      fullNameValid &&
      typeof actor.sourceKey === 'string' &&
      actor.sourceKey.length > 0 &&
      (version === 0 || finite(actor.heightOffsetM)) &&
      (version === 0 && actor.heightOffsetM !== undefined ? finite(actor.heightOffsetM) : true) &&
      validBrushIslandSpline(actor.spline) &&
      terrainRulesValid &&
      (version === 0
        ? actor.rules === undefined || validBrushActorRules(actor.rules)
        : validBrushActorRules(actor.rules)),
  );
}

function validDispersiveSlabs(
  value: WaterValidationRecord,
  gpuFinite: (value: unknown) => value is number,
  gpuPositive: (value: unknown) => value is number,
): boolean {
  const slabs: unknown = value.sourceSlabBoundariesM;
  if (
    !Array.isArray(slabs) ||
    slabs.length < 5 ||
    slabs.length > 65 ||
    (slabs.length - 1) % 4 !== 0 ||
    slabs[0] !== -value.referenceDepthM ||
    slabs[slabs.length - 1] !== 0 ||
    !slabs.every(
      (height, index) =>
        gpuFinite(height) &&
        (index === 0 || gpuPositive(Math.fround(height) - Math.fround(slabs[index - 1]))),
    )
  )
    return false;
  return true;
}

function invalidBodyShapeDilation(asset: WaterValidationRecord): boolean {
  return (
    asset.shapeDilationM !== undefined &&
    (!finite(asset.shapeDilationM) || asset.shapeDilationM < 0)
  );
}

function validAdvancedRigidCollisionLimits(config: WaterValidationRecord): boolean {
  return (
    Number.isInteger(config.maxElements) && config.maxElements >= 1 && config.maxElements <= 100
  );
}

function invalidBrushCaptureRaster(capture: WaterValidationRecord): boolean {
  return (
    !finiteVec(capture.resolutionPx, 2) ||
    !capture.resolutionPx.every(
      (dimension: number) => Number.isSafeInteger(dimension) && dimension > 0,
    ) ||
    !capture.layerNameToIndex ||
    typeof capture.layerNameToIndex !== 'object' ||
    Array.isArray(capture.layerNameToIndex)
  );
}

function invalidLegacyOceanFftOutput(
  asset: WaterValidationRecord,
  closed: (record: unknown, keys: readonly string[]) => boolean,
): boolean {
  return (
    !asset.textureGuids.includes(asset.oceanPatchConfig.noiseTextureGuid) ||
    asset.oceanPatchConfig.phillipsAmplitude < 0 ||
    !Number.isInteger(asset.oceanPatchConfig.windAlignment) ||
    asset.oceanPatchConfig.windAlignment < 0 ||
    asset.oceanPatchConfig.windAlignment > 20 ||
    asset.oceanPatchConfig.twiddle !== 'positive' ||
    asset.oceanPatchConfig.normalization !== 'none' ||
    !['rgba16float', 'rgba32float'].includes(asset.oceanPatchConfig.normalRtFormat) ||
    (asset.oceanPatchConfig.gridMesh !== null &&
      (!closed(asset.oceanPatchConfig.gridMesh, ['extentM']) ||
        !finiteVec(asset.oceanPatchConfig.gridMesh.extentM, 2) ||
        asset.oceanPatchConfig.gridMesh.extentM.some((value: number) => value <= 0)))
  );
}

function validGeometryWaterMeshFootprint(
  source: WaterBodySourceAsset,
  waterMeshFootprint: WaterValidationRecord,
  customWaterMeshOptIn: boolean,
): boolean {
  if (
    waterMeshFootprint !== undefined &&
    (!customWaterMeshOptIn ||
      !closedObject(waterMeshFootprint, ['version', 'digest', 'rings']) ||
      waterMeshFootprint.version !== 1 ||
      typeof waterMeshFootprint.digest !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(waterMeshFootprint.digest) ||
      !Array.isArray(waterMeshFootprint.rings) ||
      waterMeshFootprint.rings.length === 0 ||
      !waterMeshFootprint.rings.every(validPolygon) ||
      waterMeshFootprint.digest !==
        waterMeshFootprintDigest(source, { version: 1, rings: waterMeshFootprint.rings }))
  )
    return false;
  return true;
}

function validGeometrySnapshotDigests(
  asset: WaterValidationRecord,
  source: WaterBodySourceAsset,
  query: WaterValidationRecord,
  descriptor: WaterValidationRecord | null,
): boolean {
  return (
    query.digest ===
      waterQueryFootprintDigest(
        source,
        { version: 1, outer: query.outer, holes: query.holes },
        {
          oceanCenterM: asset.oceanCenterM,
          geometryAuthoringWorldMatrixM: asset.geometryAuthoringWorldMatrixM,
        },
      ) &&
    (descriptor === null
      ? !source.collision.enabled
      : source.collision.enabled &&
        descriptor.digest ===
          waterCollisionDescriptorDigest(
            source,
            descriptor as NonNullable<WaterBodyGeometrySnapshot['collisionDescriptor']>,
          ))
  );
}

function invalidGeometryCollisionParticipation(
  source: WaterBodySourceAsset,
  descriptor: WaterValidationRecord | null,
): boolean {
  return (
    (source.collision.enabled && source.type === 'river' && !descriptor?.riverSegmentConvexes) ||
    (source.collision.enabled &&
      source.type === 'custom' &&
      source.collision.type === 'custom-mesh' &&
      descriptor?.customMesh?.meshGuid !== source.collision.meshGuid) ||
    (source.collision.enabled && descriptor === null)
  );
}
