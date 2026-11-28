import { halfFloat, rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { sunDirection, type SunFields } from '../sun-controls.ts';
import { referenceCamera } from '../terrain.ts';
import { dawnFields, makeDawnTexture } from './dawn-textures.ts';
import { NUBIS_BOSS_SUN, NUBIS_LAYER, NUBIS_LAYOUT_METERS, NUBIS_PLANET_RADIUS, NUBIS_SUNLIT_SUN, type NubisMode } from './presets.ts';

export const SIZE = { 'layout-pattern': 1024, 'layout-mask': 1024, 'height-profile': 256, 'body-noise': 128 } as const;
export const NUBIS_ROLES = Object.keys(SIZE) as (keyof typeof SIZE)[];
export type NubisRole = keyof typeof SIZE;
type Vec2 = readonly [number, number];
type Pixel = readonly [number, number, number, number];
type Profile = readonly [base: number, top: number, baseFade: number, topFade: number];
const BLACK: Pixel = [0, 0, 0, 0];
// The profile uses a wrapping sampler. Leave room for an inactive row on both sides.
export const PROFILE_LAYOUT_MAX = 1 - 3 / SIZE['height-profile'];
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const repeat = (value: number) => value - Math.floor(value);
const wrapDelta = (value: number) => repeat(value + 0.5) - 0.5;
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const stageOrigin = referenceCamera();
export const stageUv: Vec2 = [-stageOrigin.z / NUBIS_LAYOUT_METERS, stageOrigin.x / NUBIS_LAYOUT_METERS];

type StandardNubisMode = Exclude<NubisMode, 'nubis-dawn'>;

export const LOOKS = {
  'nubis-sunlit': {
    seed: 79681, period: 9, cells: 0.77, detail: 0.87,
    weatherFrequency: 9, coverage: 0.67, turbulence: 0.82,
    profileGain: [0.59, 0.785], densityCenter: 0.300, densityGain: 0.66, densityTarget: 0.431,
    profiles: [[0.11, 0.31, 0.053, 0.104], [0.155, 0.49, 0.073, 0.119], [0.237, 0.64, 0.081, 0.167]],
  },
  'nubis-boss': {
    seed: 98143, period: 7, cells: 0.68, detail: 1,
    weatherFrequency: 8, coverage: 0.63, turbulence: 0.94,
    profileGain: [0.60, 0.787], densityCenter: 0.274, densityGain: 0.66, densityTarget: 0.418,
    profiles: [[0.102, 0.35, 0.061, 0.11], [0.126, 0.63, 0.075, 0.143], [0.218, 0.77, 0.09, 0.173]],
  },
} as const satisfies Record<StandardNubisMode, { seed: number; period: number; cells: number; detail: number;
  weatherFrequency: number; coverage: number; turbulence: number;
  profileGain: readonly [number, number]; densityCenter: number; densityGain: number; densityTarget: number;
  profiles: readonly (Profile | null)[] }>;

/** The outer-shell intersections used for the ground camera's direction to the sun. */
export function sunSegment(sun: SunFields): readonly [Vec2, Vec2] {
  const [outX, outY, outZ] = sunDirection(sun);
  const dx = -outX, dy = -outY, dz = -outZ;
  const eyeY = NUBIS_PLANET_RADIUS + stageOrigin.y;
  const dot = stageOrigin.x * dx + eyeY * dy + stageOrigin.z * dz;
  const eyeSq = stageOrigin.x ** 2 + eyeY ** 2 + stageOrigin.z ** 2;
  const toUv = (height: number): Vec2 => {
    const radius = NUBIS_PLANET_RADIUS + height;
    const difference = radius ** 2 - eyeSq;
    const t = difference / (Math.sqrt(dot ** 2 + difference) + dot);
    return [-(stageOrigin.z + t * dz) / NUBIS_LAYOUT_METERS, (stageOrigin.x + t * dx) / NUBIS_LAYOUT_METERS];
  };
  return [toUv(NUBIS_LAYER.bottomMeters), toUv(NUBIS_LAYER.bottomMeters + NUBIS_LAYER.thicknessMeters)];
}

export function bossSunSegment(): readonly [Vec2, Vec2] {
  return sunSegment(NUBIS_BOSS_SUN);
}

function apertureDistance([start, end]: readonly [Vec2, Vec2]) {
  const spanU = end[0] - start[0], spanV = end[1] - start[1];
  const middleU = (start[0] + end[0]) * 0.5, middleV = (start[1] + end[1]) * 0.5;
  return (u: number, v: number) => {
    const du = wrapDelta(u - middleU) + spanU * 0.5, dv = wrapDelta(v - middleV) + spanV * 0.5;
    const t = clamp((du * spanU + dv * spanV) / (spanU ** 2 + spanV ** 2));
    const lateral = du * spanV - dv * spanU;
    const distanceKm = Math.hypot(du - t * spanU, dv - t * spanV) * NUBIS_LAYOUT_METERS / 1_000;
    return { t, lateral, distanceKm };
  };
}

function gradientField(seed: number, period: number) {
  const random = rng.create(seed);
  const permutation = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let i = 255; i > 0; i--) {
    const j = random.int(0, i);
    const first = permutation[i]!;
    permutation[i] = permutation[j]!;
    permutation[j] = first;
  }
  const hash = (x: number, y: number, z: number) =>
    permutation[(x + permutation[(y + permutation[z]!) & 255]!) & 255]!;
  const gradient = (h: number, x: number, y: number, z: number) => {
    const u = (h & 8) === 0 ? x : y;
    const v = (h & 12) === 0 ? y : (h & 13) === 12 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  const fade = (t: number) => t ** 3 * (t * (6 * t - 15) + 10);
  return (u: number, v: number, w = 0) => {
    const x = repeat(u) * period, y = repeat(v) * period, z = repeat(w) * period;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const jx = (ix + 1) % period, jy = (iy + 1) % period, jz = (iz + 1) % period;
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const tx = fade(fx), ty = fade(fy), tz = fade(fz);
    const slice = (k: number, dz: number) => lerp(
      lerp(gradient(hash(ix, iy, k), fx, fy, dz), gradient(hash(jx, iy, k), fx - 1, fy, dz), tx),
      lerp(gradient(hash(ix, jy, k), fx, fy - 1, dz), gradient(hash(jx, jy, k), fx - 1, fy - 1, dz), tx),
      ty,
    );
    return 1.45 * lerp(slice(iz, fz), slice(jz, fz - 1), tz);
  };
}

function cellField(seed: number, period: number) {
  const random = rng.create(seed);
  const points = Float32Array.from({ length: period ** 3 * 3 }, () => 0.12 + random.next() * 0.76);
  const index = (n: number) => (n % period + period) % period;
  return (u: number, v: number, w: number) => {
    const x = repeat(u) * period, y = repeat(v) * period, z = repeat(w) * period;
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    let nearest = 2;
    for (let cz = k - 1; cz <= k + 1; cz++) for (let cy = j - 1; cy <= j + 1; cy++) {
      const row = (index(cz) * period + index(cy)) * period;
      for (let cx = i - 1; cx <= i + 1; cx++) {
        const point = 3 * (row + index(cx));
        const dx = cx + points[point]! - x, dy = cy + points[point + 1]! - y, dz = cz + points[point + 2]! - z;
        nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
      }
    }
    return 1 - Math.sqrt(nearest);
  };
}

// Keep the same octave weighting and two scales of coordinate warp as Generated Clouds.
function weatherOctaves(seed: number, period: number, fineWeight = 1) {
  const coarse = gradientField(seed, period);
  const broad = gradientField(seed + 1, period * 2);
  const fine = gradientField(seed + 2, period * 4);
  const grain = gradientField(seed + 3, period * 8);
  if (fineWeight === 1) {
    return (u: number, v: number, slice: number) => 0.64 * coarse(u, v, slice) + 0.21 * broad(u, v, slice)
      + 0.10 * fine(u, v, slice) + 0.05 * grain(u, v, slice);
  }
  const weight = 0.85 + 0.15 * fineWeight;
  return (u: number, v: number, slice: number) => (0.64 * coarse(u, v, slice) + 0.21 * broad(u, v, slice)
    + fineWeight * (0.10 * fine(u, v, slice) + 0.05 * grain(u, v, slice))) / weight;
}

export function nubisFields(mode: NubisMode) {
  if (mode === 'nubis-dawn') return dawnFields();
  const look = LOOKS[mode];
  const seed = look.seed;
  const frequency = look.weatherFrequency;
  const isBoss = mode === 'nubis-boss';
  const warpU = gradientField(seed + 1, Math.round(frequency / 2));
  const warpV = gradientField(seed + 2, Math.round(frequency / 2));
  const fineU = gradientField(seed + 3, frequency * 4);
  const fineV = gradientField(seed + 4, frequency * 4);
  const lowWeather = weatherOctaves(seed + 17, frequency);
  const midWeather = weatherOctaves(seed + 29, frequency + 2);
  const tallWeather = weatherOctaves(seed + 41, frequency + 4);
  const rifts = gradientField(seed + 53, frequency * 6);
  const maskWeather = weatherOctaves(seed + 67, 4);
  const distantWeather = weatherOctaves(seed + 83, 7);
  const distanceToBossSun = apertureDistance(bossSunSegment());
  const distanceToDaySun = apertureDistance(sunSegment(NUBIS_SUNLIT_SUN));
  const hole = (u: number, v: number) => {
    const { t, lateral, distanceKm } = distanceToBossSun(u, v);
    const rim = fineU(u, v, 0.43) + 0.35 * rifts(u, v, 0.25);
    const radius = lerp(0.54, lateral < 0 ? 4.0 : 3.0, t) * (1 + 0.36 * rim);
    return smooth(radius, radius + lerp(0.35, 0.85, t), distanceKm);
  };
  const daylightGap = (u: number, v: number) => {
    const { t, distanceKm } = distanceToDaySun(u, v);
    const edge = fineV(u, v, 0.47);
    const width = lerp(0.38, 1.6, t) * (1 + 0.56 * edge);
    return lerp(0.13, 1, smooth(width, width + lerp(0.64, 1.7, t), distanceKm));
  };
  const coordinates = (u: number, v: number): Vec2 => {
    const strength = look.turbulence / frequency;
    const coarseU = u + strength * warpU(u, v, 0.29);
    const coarseV = v + strength * warpV(u, v, 0.71);
    return [coarseU + strength * 0.23 * fineU(coarseU, coarseV, 0.18),
      coarseV + strength * 0.23 * fineV(coarseU, coarseV, 0.67)];
  };
  const regionalDensity = (u: number, v: number, x: number, y: number) => {
    // A fixed world-space fade with a warped transition. Near clouds stay in place as the camera turns.
    const distanceKm = NUBIS_LAYOUT_METERS / 1_000 * Math.hypot(wrapDelta(u - stageUv[0]), wrapDelta(v - stageUv[1]));
    const group = distantWeather(x, y, 0.36);
    const far = smooth(10, 31, distanceKm + 5 * group);
    const groupStrength = smooth(-0.12, 0.30, group);
    const sparse = lerp(isBoss ? 0.16 : 0.11, isBoss ? 0.73 : 0.67, groupStrength);
    return lerp(1, sparse, far);
  };
  const pattern = (u: number, v: number): Pixel => {
    const opening = isBoss ? hole(u, v) : daylightGap(u, v);
    if (opening === 0) return BLACK;
    const [x, y] = coordinates(u, v);
    const density = PROFILE_LAYOUT_MAX * opening * regionalDensity(u, v, x, y);
    const low = lowWeather(x, y, 0.41);
    const middle = midWeather(x, y, 0.69);
    const top = tallWeather(x, y, 0.25);
    const cut = Math.max(0, -rifts(x, y, 0.34));
    const threshold = 0.70 - 0.48 * look.coverage;
    const weather = (isBoss ? 0.52 : 0.56) + 0.42 * low + 0.57 * middle - 0.12 * cut;
    const body = smooth(threshold - 0.018, threshold + 0.29, weather);
    const lower = 0.59 * smooth(0.48, 0.78, 0.47 + 0.74 * low + 0.07 * middle - 0.12 * cut);
    const crest = smooth(isBoss ? 0.50 : 0.56, 0.82, weather + 0.34 * top - 0.10 * cut);
    const high = crest * (isBoss ? 0.96 : 0.83);
    return [lower * density, body * density, high * density, 0];
  };
  const mask = (u: number, v: number): Pixel => {
    // The runtime mask samples half a tile away from the pattern.
    const mapU = u - 0.5, mapV = v - 0.5;
    const [r, g, b] = pattern(mapU, mapV);
    const support = smooth(0, 0.16, Math.max(r, g, b));
    if (support === 0) return BLACK;
    const [x, y] = coordinates(mapU, mapV);
    const density = support * regionalDensity(mapU, mapV, x, y);
    const regionalInfluence = (offset: number) => 0.18 * density * smooth(0.34, 0.76,
      0.46 + 0.57 * maskWeather(x + offset, y, 0.42));
    return [regionalInfluence(0), regionalInfluence(0.07), regionalInfluence(-0.08), 0];
  };
  const profile = (height: number, encodedLayout: number): Pixel => {
    const layout = clamp(encodedLayout / PROFILE_LAYOUT_MAX);
    const active = smooth(0, 0.14, layout) * (1 - smooth(PROFILE_LAYOUT_MAX, 1 - 1 / SIZE['height-profile'], encodedLayout));
    if (active === 0) return BLACK;
    const weak = (1 - layout) ** 1.5;
    const peak = lerp(look.profileGain[0], look.profileGain[1], Math.sqrt(layout));
    const lane = (i: 0 | 1 | 2) => {
      const shape = look.profiles[i];
      if (!shape) return 0;
      const [base, top, bottomFade, topFade] = shape;
      const foot = base + 0.07 * weak + bottomFade * 0.5;
      const crown = top - 0.18 * weak - topFade * 0.5;
      // Keep the authored boundary midpoints and soften the density ramp around them.
      const lowerWidth = Math.max(0.112, bottomFade * 1.65);
      const upperWidth = Math.max(0.135, topFade * 1.5);
      const core = smooth(foot - lowerWidth * 0.5, foot + lowerWidth * 0.5, height)
        * (1 - smooth(crown - upperWidth * 0.5, crown + upperWidth * 0.5, height));
      const shoulder = smooth(foot - lowerWidth, foot - lowerWidth * 0.22, height)
        * (1 - smooth(crown + upperWidth * 0.22, crown + upperWidth, height));
      return active * (0.37 * shoulder + (peak - 0.37) * core);
    };
    return [lane(0), lane(1), lane(2), 0];
  };
  return { pattern, mask, profile };
}

function bodyField(mode: StandardNubisMode, size: number) {
  const look = LOOKS[mode];
  const period = (multiplier: number) => Math.min(Math.max(2, Math.floor(size / 2)), look.period * multiplier);
  const base = gradientField(look.seed + 17, period(1));
  const small = gradientField(look.seed + 38, period(2));
  const grain = gradientField(look.seed + 43, period(5));
  const coarseCell = cellField(look.seed + 59, period(1));
  const erosionCell = cellField(look.seed + 67, period(3));
  const microCell = cellField(look.seed + 79, period(5));
  const warp = gradientField(look.seed + 74, Math.min(5, period(1)));
  return (u: number, v: number, w: number): Pixel => {
    const warpedU = u + 0.028 * warp(u, v, w);
    const large = base(warpedU, v, w);
    const fine = small(warpedU, v, w);
    const micro = grain(u, v, w);
    const billow = coarseCell(warpedU, v, w) - 0.51;
    const eroder = erosionCell(u, v, w);
    const microStructure = microCell(u, v, w);
    const erosion = smooth(0.21, 0.70, 0.74 * eroder + 0.26 * microStructure + 0.21 * micro);
    const body = lerp(0.62 * large, 1.3 * billow + 0.26 * large, look.cells);
    const density = 0.54 + body + look.detail * (0.30 * fine + 0.13 * micro - 0.48 * erosion);
    return [0.68 + 0.8 * (0.50 * warp(u + 0.3, v, w) + 0.19 * fine),
      look.densityTarget + look.densityGain * (density - look.densityCenter),
      0.16 + 0.78 * erosion + 0.18 * micro,
      0.48 + 0.98 * (microStructure - 0.46) + 0.15 * micro];
  };
}

// Filter only the G density carrier. The tile wraps on all three axes before interpolation.
function filterBodyDensity(data: Uint8Array, size: number): void {
  const count = size ** 3;
  let source = new Float32Array(count);
  let target = new Float32Array(count);
  for (let i = 0; i < count; i++) source[i] = data[i * 4 + 1]!;
  const verticalStride = size * size;
  const strides = [1, size, verticalStride, verticalStride];
  for (const stride of strides) {
    const wrapOffset = (size - 1) * stride;
    for (let i = 0; i < count; i++) {
      const axis = Math.floor(i / stride) % size;
      const before = i + (axis === 0 ? wrapOffset : -stride);
      const after = i + (axis === size - 1 ? -wrapOffset : stride);
      target[i] = 0.25 * (source[before]! + 2 * source[i]! + source[after]!);
    }
    [source, target] = [target, source];
  }
  for (let i = 0; i < count; i++) data[4 * i + 1] = Math.round(lerp(data[4 * i + 1]!, source[i]!, 0.90));
}

export function makeNubisTexture(mode: NubisMode, role: NubisRole, size: number = SIZE[role]): TextureAsset & { data: Uint8Array } {
  if (mode === 'nubis-dawn') return makeDawnTexture(role, size);
  const volume = role === 'body-noise';
  const packed = volume || role === 'layout-mask';
  const depth = volume ? size : 1;
  const data = new Uint8Array(size * size * depth * (packed ? 4 : 8));
  const half = new DataView(data.buffer);
  const fields = role === 'body-noise' ? undefined : nubisFields(mode);
  const field = role === 'layout-pattern' ? fields!.pattern : role === 'layout-mask' ? fields!.mask
    : role === 'height-profile' ? fields!.profile : bodyField(mode, size);
  const byteOrder = [2, 1, 0, 3] as const;
  for (let z = 0; z < depth; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const pixel = field((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size);
    const offset = (x + size * (y + size * z)) * 4;
    for (const channel of [0, 1, 2, 3] as const) {
      const lane = clamp(pixel[channel]);
      if (packed) data[offset + byteOrder[channel]] = Math.round(lane * 255);
      else half.setUint16((offset + channel) * 2, halfFloat.f32ToF16(lane), true);
    }
  }
  if (volume) filterBodyDensity(data, size);
  return { kind: 'texture', format: packed ? 'bgra8unorm' : 'rgba16float', colorSpace: 'linear', data,
    shape: volume ? { viewDimension: '3d', extent: { width: size, height: size, depth } }
      : { viewDimension: '2d', extent: { width: size, height: size } }, mips: { kind: 'none' } };
}
