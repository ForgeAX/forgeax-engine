import { CLOUD_VERTICAL_CELLS } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CloudLayerCacheInvalidError, type CloudLayerError } from '../errors/cloud';
import {
  CLOUD_QUALITY_PROFILES,
  type CloudQualityProfile,
  cloudLayerFormationKey,
  type ValidatedCloudLayer,
} from './parameters';

export interface CloudDensityCache {
  readonly sourceKey: string;
  readonly resolution: number;
  /** R8 normalized density values in z-major, y, x order. */
  readonly data: Uint8Array;
  /**
   * Weather, body and erosion bases in three contiguous R8 planes. `data` is
   * retained as a diagnostic projection for callers that still need the
   * composed density; runtime sampling uses these formation planes so coverage,
   * density and wind remain evaluation controls.
   */
  readonly formationData: Uint8Array;
  readonly formationByteLength: number;
  /** Bytes uploaded for the reusable formation planes. */
  readonly byteLength: number;
  readonly digest: string;
}

export interface CloudDensityCacheSnapshot {
  readonly sourceKey: string;
  readonly resolution: number;
  readonly data: Uint8Array;
  readonly formationData?: Uint8Array;
  readonly digest: string;
}

export interface CloudDensitySample {
  readonly density: number;
  readonly heightFraction: number;
  readonly noise: number;
  readonly weather?: number;
  readonly body?: number;
  readonly erosion?: number;
}

export interface CloudFormationSample {
  readonly weather: number;
  readonly body: number;
  readonly erosion: number;
  readonly noise: number;
}

/**
 * The cache is one world-space period. Keep several lattice cells inside that
 * period so a street view sees separate cloud bodies instead of one broad
 * slab. The lattice wraps at the same boundary as the cache, which prevents
 * the old seam from turning into a repeated horizontal band.
 */
const CLOUD_SHAPE_CELLS = 4;
const CLOUD_WEATHER_CELLS = 2;
const CLOUD_DETAIL_CELLS = CLOUD_SHAPE_CELLS * 3;

// One advective cache period contains four horizontal and two vertical body cells.
// Integer periods on every axis make the formation continuous when wind wraps
// through the cache boundary instead of introducing a seam at y = 0/1.
export { CLOUD_VERTICAL_CELLS };

// The cache keeps one advective period, while the formation itself gets two
// smooth vertical lobes inside that period so the street view does not read as
// a single sheet. Both are integer-period fields, so the cache seam remains
// exact.
const CLOUD_VERTICAL_NOISE_CELLS = 2;
const CLOUD_DETAIL_VERTICAL_CELLS = 3;

function saturate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = saturate((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function wrapInteger(value: number, period: number): number {
  const wrapped = value % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/** Deterministic integer hash. Every octave uses the same seeded function. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x | 0, 0x45d9f3b);
  value = Math.imul(value ^ Math.imul(y | 0, 0x119de1f3), 0x45d9f3b);
  value = Math.imul(value ^ Math.imul(z | 0, 0x3449f), 0x45d9f3b);
  value ^= seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 13), 0x27d4eb2d);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function valueNoise(
  x: number,
  y: number,
  z: number,
  seed: number,
  periodX = 0,
  periodY = 0,
  periodZ = 0,
): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const lattice = (cellX: number, cellY: number, cellZ: number): number =>
    hash3(
      periodX > 0 ? wrapInteger(cellX, periodX) : cellX,
      periodY > 0 ? wrapInteger(cellY, periodY) : cellY,
      periodZ > 0 ? wrapInteger(cellZ, periodZ) : cellZ,
      seed,
    );
  const c000 = lattice(ix, iy, iz);
  const c100 = lattice(ix + 1, iy, iz);
  const c010 = lattice(ix, iy + 1, iz);
  const c110 = lattice(ix + 1, iy + 1, iz);
  const c001 = lattice(ix, iy, iz + 1);
  const c101 = lattice(ix + 1, iy, iz + 1);
  const c011 = lattice(ix, iy + 1, iz + 1);
  const c111 = lattice(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  return x00 + (x10 - x00) * uy + (x01 + (x11 - x01) * uy - (x00 + (x10 - x00) * uy)) * uz;
}

/** Bounded Worley-like cellular term used to erode the high frequency field. */
function cellularNoise(
  x: number,
  y: number,
  z: number,
  seed: number,
  periodXZ = CLOUD_DETAIL_CELLS,
  periodY = 0,
): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  let nearest = Number.POSITIVE_INFINITY;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const random = hash3(
          wrapInteger(ix + dx, periodXZ),
          periodY > 0 ? wrapInteger(iy + dy, periodY) : iy + dy,
          wrapInteger(iz + dz, periodXZ),
          seed ^ 0x9e3779b9,
        );
        const px = dx + fract(random * 17.0) - fx;
        const py = dy + fract(random * 31.0) - fy;
        const pz = dz + fract(random * 47.0) - fz;
        nearest = Math.min(nearest, px * px + py * py + pz * pz);
      }
    }
  }
  return 1 - saturate(Math.sqrt(nearest) * 1.25);
}

function heightEnvelope(height: number, body: number, weather: number): number {
  // Let each body choose its own crown height. A fixed upper edge reads as a
  // horizontal slab from the street camera; tying the crown to the cached body
  // makes dense cells grow upward while sparse cells dissolve earlier.
  const lowerEdge = 0.05 + (1 - body) * 0.1;
  const crownEdge = Math.min(0.96, 0.6 + body * 0.3 + weather * 0.08);
  return (
    smoothstep(lowerEdge, Math.min(1, lowerEdge + 0.12), height) *
    (1 - smoothstep(crownEdge, Math.min(1, crownEdge + 0.14), height))
  );
}

/** Coverage shapes the macro body; detail removes material only at its boundary. */
function composeCloudDensity(
  height: number,
  formation: CloudFormationSample,
  coverage: number,
): number {
  const threshold = 1 - coverage * (0.45 + formation.weather * 0.55);
  const covered = smoothstep(0, 0.4, (formation.body - threshold) / Math.max(0.001, 1 - threshold));
  const shaped = covered * heightEnvelope(height, formation.body, formation.weather);
  const erosion = (1 - formation.erosion) * 0.18;
  return saturate((shaped - erosion) / (1 - erosion));
}

function formationField(
  x: number,
  y: number,
  z: number,
  seed: number,
  detailRepeat = 1,
): CloudFormationSample {
  // A low-frequency height-aware warp breaks axis-aligned horizontal sheets
  // while keeping the cache periodic on every axis. The warp is evaluated once while
  // the reusable formation cache is built, so runtime ray steps pay no extra
  // noise cost.
  const macroWarpX =
    valueNoise(
      x * CLOUD_WEATHER_CELLS,
      y * CLOUD_VERTICAL_NOISE_CELLS + 3.0,
      z * CLOUD_WEATHER_CELLS,
      seed + 41023,
      CLOUD_WEATHER_CELLS,
      2,
      CLOUD_WEATHER_CELLS,
    ) - 0.5;
  const macroWarpZ =
    valueNoise(
      x * CLOUD_WEATHER_CELLS + 5.0,
      y * CLOUD_VERTICAL_NOISE_CELLS - 7.0,
      z * CLOUD_WEATHER_CELLS,
      seed + 41023,
      CLOUD_WEATHER_CELLS,
      2,
      CLOUD_WEATHER_CELLS,
    ) - 0.5;
  const bodyX = x + macroWarpX * 0.3;
  const bodyZ = z + macroWarpZ * 0.3;
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  let weight = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    const tilePeriod = CLOUD_SHAPE_CELLS * frequency;
    sum +=
      valueNoise(
        bodyX * tilePeriod,
        y * frequency * CLOUD_VERTICAL_NOISE_CELLS,
        bodyZ * tilePeriod,
        seed + octave * 1013,
        tilePeriod,
        frequency * CLOUD_VERTICAL_NOISE_CELLS,
        tilePeriod,
      ) * amplitude;
    weight += amplitude;
    amplitude *= 0.4;
    frequency *= 2;
  }
  // Perlin-Worley-style body remapping: the broad fBm controls the volume and
  // the cellular field only breaks its boundary. Keeping these values
  // separate is what lets a runtime coverage edit preserve the authored cloud
  // bodies instead of regenerating a final alpha volume.
  const broad = sum / weight;
  // Periodic Worley cells provide bounded breakup. The broad field remains
  // dominant so one cache period reads as a few connected formations instead
  // of a repeated grid of small spheres.
  const cells = cellularNoise(
    bodyX * CLOUD_SHAPE_CELLS,
    y * CLOUD_VERTICAL_NOISE_CELLS,
    bodyZ * CLOUD_SHAPE_CELLS,
    seed + 5011,
    CLOUD_SHAPE_CELLS,
    CLOUD_VERTICAL_NOISE_CELLS,
  );
  // Let the broad field carry the silhouette and use cellular noise as a
  // bounded breakup term. A broad-dominant mix keeps the same cache and ray
  // budget while yielding fewer, wider and less spherical cumulus masses.
  const body = saturate(broad * 0.85 + cells * 0.15 + 0.15);
  const weather = smoothstep(
    0.34,
    0.66,
    valueNoise(
      x * CLOUD_WEATHER_CELLS,
      0.37,
      z * CLOUD_WEATHER_CELLS,
      seed + 17041,
      CLOUD_WEATHER_CELLS,
      1,
      CLOUD_WEATHER_CELLS,
    ),
  );
  const detailX = x * detailRepeat;
  const detailY = y * detailRepeat;
  const detailZ = z * detailRepeat;
  const warpX =
    valueNoise(
      detailX * CLOUD_WEATHER_CELLS,
      detailY * 2 + 11.0,
      detailZ * CLOUD_WEATHER_CELLS,
      seed + 29011,
      CLOUD_WEATHER_CELLS,
      2,
      CLOUD_WEATHER_CELLS,
    ) - 0.5;
  const warpZ =
    valueNoise(
      detailX * CLOUD_WEATHER_CELLS + 7.0,
      detailY * 2 - 5.0,
      detailZ * CLOUD_WEATHER_CELLS,
      seed + 29011,
      CLOUD_WEATHER_CELLS,
      2,
      CLOUD_WEATHER_CELLS,
    ) - 0.5;
  const erosion = cellularNoise(
    (detailX + warpX * 0.22) * CLOUD_DETAIL_CELLS,
    detailY * CLOUD_DETAIL_VERTICAL_CELLS,
    (detailZ + warpZ * 0.22) * CLOUD_DETAIL_CELLS,
    seed + 7919,
    CLOUD_DETAIL_CELLS,
    CLOUD_DETAIL_VERTICAL_CELLS,
  );
  const noise = body;
  return { weather, body, erosion, noise };
}

/** Evaluate the reusable weather/body/erosion bases at one world position. */
export function evaluateCloudFormation(
  params: ValidatedCloudLayer,
  position: ArrayLike<number>,
  timeSeconds = 0,
): CloudFormationSample {
  const windX = (params.wind[0] ?? 0) * timeSeconds;
  const windY = (params.wind[1] ?? 0) * timeSeconds;
  const windZ = (params.wind[2] ?? 0) * timeSeconds;
  const relativeHeight =
    ((position[1] ?? 0) - params.baseHeight) / Math.max(1e-6, params.thickness);
  const advectedHeight =
    relativeHeight + (windY * params.scale) / Math.max(1e-6, CLOUD_VERTICAL_CELLS);
  return formationField(
    ((position[0] ?? 0) + windX) * params.scale,
    fract(advectedHeight) * CLOUD_VERTICAL_CELLS,
    ((position[2] ?? 0) + windZ) * params.scale,
    params.seed,
  );
}

/** Analytic field used for cache generation, CPU diagnostics and recovery. */
export function evaluateCloudDensity(
  params: ValidatedCloudLayer,
  position: ArrayLike<number>,
  timeSeconds = 0,
): CloudDensitySample {
  const relativeHeight =
    ((position[1] ?? 0) - params.baseHeight) / Math.max(1e-6, params.thickness);
  if (relativeHeight <= 0 || relativeHeight >= 1 || params.density <= 0 || params.coverage <= 0) {
    return { density: 0, heightFraction: saturate(relativeHeight), noise: 0 };
  }
  const windX = (params.wind[0] ?? 0) * timeSeconds;
  const windY = (params.wind[1] ?? 0) * timeSeconds;
  const windZ = (params.wind[2] ?? 0) * timeSeconds;
  const x = ((position[0] ?? 0) + windX) * params.scale;
  const advectedHeight =
    relativeHeight + (windY * params.scale) / Math.max(1e-6, CLOUD_VERTICAL_CELLS);
  const y = fract(advectedHeight) * CLOUD_VERTICAL_CELLS;
  const z = ((position[2] ?? 0) + windZ) * params.scale;
  const formation = formationField(x, y, z, params.seed, 3);
  const noise = formation.noise;
  return {
    density: composeCloudDensity(relativeHeight, formation, params.coverage) * params.density,
    heightFraction: relativeHeight,
    noise,
    weather: formation.weather,
    body: formation.body,
    erosion: formation.erosion,
  };
}

function cacheIndex(resolution: number, x: number, y: number, z: number): number {
  return z * resolution * resolution + y * resolution + x;
}

function digestBytes(data: Uint8Array): string {
  // FNV-1a is stable and intentionally cheap; this is an identity receipt,
  // not a cryptographic integrity boundary.
  let hash = 0x811c9dc5;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Build one canonical, periodic formation cache. */
export function buildCloudDensityCache(
  params: ValidatedCloudLayer,
  profile: CloudQualityProfile = CLOUD_QUALITY_PROFILES[params.quality],
): CloudDensityCache {
  const resolution = Math.max(4, Math.floor(profile.cacheResolution));
  const data = new Uint8Array(resolution * resolution * resolution);
  const formationData = new Uint8Array(data.byteLength * 3);
  const position = [0, 0, 0];
  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      position[1] = params.baseHeight + ((y + 0.5) / resolution) * params.thickness;
      for (let x = 0; x < resolution; x += 1) {
        // One cache period is one noise period in world space. This makes the
        // x/z addressing periodic and lets advection wrap without seams.
        position[0] = (x + 0.5) / resolution / params.scale;
        position[2] = (z + 0.5) / resolution / params.scale;
        const index = cacheIndex(resolution, x, y, z);
        const formation = evaluateCloudFormation(params, position, 0);
        formationData[index] = Math.round(saturate(formation.weather) * 255);
        formationData[data.byteLength + index] = Math.round(saturate(formation.body) * 255);
        formationData[data.byteLength * 2 + index] = Math.round(saturate(formation.erosion) * 255);
      }
    }
  }
  const cache: CloudDensityCache = {
    sourceKey: cloudLayerFormationKey(params),
    resolution,
    data,
    formationData,
    formationByteLength: formationData.byteLength,
    byteLength: formationData.byteLength,
    digest: digestBytes(formationData),
  };
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        position[0] = (x + 0.5) / resolution / params.scale;
        position[1] = params.baseHeight + ((y + 0.5) / resolution) * params.thickness;
        position[2] = (z + 0.5) / resolution / params.scale;
        data[cacheIndex(resolution, x, y, z)] = Math.round(
          saturate(sampleCloudDensity(cache, params, position)) * 255,
        );
      }
    }
  }
  return Object.freeze(cache);
}

/** Export a detached snapshot suitable for persistence or a worker boundary. */
export function snapshotCloudDensityCache(cache: CloudDensityCache): CloudDensityCacheSnapshot {
  return Object.freeze({
    sourceKey: cache.sourceKey,
    resolution: cache.resolution,
    data: new Uint8Array(cache.data),
    formationData: new Uint8Array(cache.formationData),
    digest: cache.digest,
  });
}

/** Reconstruct a cache without running the procedural generator again. */
export function reconstructCloudDensityCache(
  params: ValidatedCloudLayer,
  snapshot: CloudDensityCacheSnapshot,
): Result<CloudDensityCache, CloudLayerError> {
  const expectedKey = cloudLayerFormationKey(params);
  if (snapshot.sourceKey !== expectedKey) {
    return err(new CloudLayerCacheInvalidError(snapshot.sourceKey, 'source key mismatch'));
  }
  if (
    !Number.isInteger(snapshot.resolution) ||
    snapshot.resolution < 4 ||
    snapshot.resolution > 256 ||
    snapshot.data.byteLength !== snapshot.resolution ** 3 ||
    (snapshot.formationData !== undefined &&
      snapshot.formationData.byteLength !== snapshot.resolution ** 3 * 3)
  ) {
    return err(
      new CloudLayerCacheInvalidError(snapshot.sourceKey, 'resolution and payload length mismatch'),
    );
  }
  const formationData =
    snapshot.formationData === undefined
      ? new Uint8Array(snapshot.data.length * 3).fill(0)
      : new Uint8Array(snapshot.formationData);
  const digest = digestBytes(formationData);
  if (digest !== snapshot.digest) {
    return err(new CloudLayerCacheInvalidError(snapshot.sourceKey, 'payload digest mismatch'));
  }
  const data = new Uint8Array(snapshot.data);
  return ok(
    Object.freeze({
      sourceKey: snapshot.sourceKey,
      resolution: snapshot.resolution,
      data,
      formationData,
      formationByteLength: formationData.byteLength,
      byteLength: formationData.byteLength,
      digest,
    }),
  );
}

function wrapped(value: number, resolution: number): number {
  const result = value - Math.floor(value);
  return Math.min(resolution - 1e-6, Math.max(0, result * resolution));
}

/** Sample the cached field with periodic x/z addressing and wind advection. */
export function sampleCloudDensity(
  cache: CloudDensityCache,
  params: ValidatedCloudLayer,
  position: ArrayLike<number>,
  timeSeconds = 0,
): number {
  const height = ((position[1] ?? 0) - params.baseHeight) / Math.max(1e-6, params.thickness);
  if (height <= 0 || height >= 1 || params.coverage <= 0 || params.density <= 0) return 0;
  const period = 1 / Math.max(1e-6, params.scale);
  const x = wrapped(
    ((position[0] ?? 0) + (params.wind[0] ?? 0) * timeSeconds) / period - 0.5 / cache.resolution,
    cache.resolution,
  );
  const z = wrapped(
    ((position[2] ?? 0) + (params.wind[2] ?? 0) * timeSeconds) / period - 0.5 / cache.resolution,
    cache.resolution,
  );
  // The cache's y axis stores the normalized formation coordinate before
  // vertical advection. Map the authored noise shift back through the same
  // vertical cell aspect used by formationField; the world-space envelope
  // below remains anchored to the current receiver height.
  const advectedHeight =
    height +
    ((params.wind[1] ?? 0) * timeSeconds * params.scale) / Math.max(1e-6, CLOUD_VERTICAL_CELLS);
  const y = wrapped(advectedHeight - 0.5 / cache.resolution, cache.resolution);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = (x0 + 1) % cache.resolution;
  const y1 = (y0 + 1) % cache.resolution;
  const z1 = (z0 + 1) % cache.resolution;
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const stride = cache.resolution ** 3;
  if (cache.formationData === undefined || cache.formationData.byteLength < stride * 3) {
    const sampleLegacy = (sx: number, sy: number, sz: number): number =>
      (cache.data[cacheIndex(cache.resolution, sx, sy, sz)] ?? 0) / 255;
    const c00 =
      sampleLegacy(x0, y0, z0) + (sampleLegacy(x1, y0, z0) - sampleLegacy(x0, y0, z0)) * fx;
    const c10 =
      sampleLegacy(x0, y1, z0) + (sampleLegacy(x1, y1, z0) - sampleLegacy(x0, y1, z0)) * fx;
    const c01 =
      sampleLegacy(x0, y0, z1) + (sampleLegacy(x1, y0, z1) - sampleLegacy(x0, y0, z1)) * fx;
    const c11 =
      sampleLegacy(x0, y1, z1) + (sampleLegacy(x1, y1, z1) - sampleLegacy(x0, y1, z1)) * fx;
    return (
      (c00 + (c10 - c00) * fy + (c01 + (c11 - c01) * fy - (c00 + (c10 - c00) * fy)) * fz) *
      heightEnvelope(height, 1, 0.5) *
      params.density
    );
  }
  const samplePlane = (plane: number, sx: number, sy: number, sz: number): number => {
    const payload = cache.formationData;
    const offset = plane * stride + cacheIndex(cache.resolution, sx, sy, sz);
    return (payload[offset] ?? 0) / 255;
  };
  const sample = (plane: number): number => {
    const repeat = plane === 2 ? 3 : 1;
    const sx = wrapped(
      ((x + 0.5) / cache.resolution) * repeat - 0.5 / cache.resolution,
      cache.resolution,
    );
    const sy = wrapped(
      ((y + 0.5) / cache.resolution) * repeat - 0.5 / cache.resolution,
      cache.resolution,
    );
    const sz = wrapped(
      ((z + 0.5) / cache.resolution) * repeat - 0.5 / cache.resolution,
      cache.resolution,
    );
    const x0 = Math.floor(sx),
      y0 = Math.floor(sy),
      z0 = Math.floor(sz);
    const x1 = (x0 + 1) % cache.resolution,
      y1 = (y0 + 1) % cache.resolution,
      z1 = (z0 + 1) % cache.resolution;
    const fx = sx - x0,
      fy = sy - y0,
      fz = sz - z0;

    const c00 =
      samplePlane(plane, x0, y0, z0) +
      (samplePlane(plane, x1, y0, z0) - samplePlane(plane, x0, y0, z0)) * fx;
    const c10 =
      samplePlane(plane, x0, y1, z0) +
      (samplePlane(plane, x1, y1, z0) - samplePlane(plane, x0, y1, z0)) * fx;
    const c01 =
      samplePlane(plane, x0, y0, z1) +
      (samplePlane(plane, x1, y0, z1) - samplePlane(plane, x0, y0, z1)) * fx;
    const c11 =
      samplePlane(plane, x0, y1, z1) +
      (samplePlane(plane, x1, y1, z1) - samplePlane(plane, x0, y1, z1)) * fx;
    return c00 + (c10 - c00) * fy + (c01 + (c11 - c01) * fy - (c00 + (c10 - c00) * fy)) * fz;
  };
  const weather = sample(0);
  const body = sample(1);
  const erosion = sample(2);
  return (
    composeCloudDensity(height, { weather, body, erosion, noise: body }, params.coverage) *
    params.density
  );
}
