import { halfFloat, rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';

/** World scale used to author the footprint. The sampled material owns the actual runtime scale. */
export const ALPINE_LAYOUT_METERS = 144_000;
export const ALPINE_SEED = 0x41_4c_50_39;
export const SIZE = { 'layout-pattern': 1024, 'layout-mask': 1024, 'height-profile': 256, 'body-noise': 128 } as const;
export type AlpineTextureRole = keyof typeof SIZE;
export const ALPINE_ROLES = Object.keys(SIZE) as AlpineTextureRole[];
const TILE_KM = ALPINE_LAYOUT_METERS / 1_000;
const saturate = (value: number) => Math.min(1, Math.max(0, value));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapped = (value: number) => value - Math.floor(value + 0.5);
function smooth(a: number, b: number, value: number) {
  const t = saturate((value - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const repeat = (value: number) => value - Math.floor(value);

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
    const slice = (k: number, dz: number) => mix(
      mix(gradient(hash(ix, iy, k), fx, fy, dz), gradient(hash(jx, iy, k), fx - 1, fy, dz), tx),
      mix(gradient(hash(ix, jy, k), fx, fy - 1, dz), gradient(hash(jx, jy, k), fx - 1, fy - 1, dz), tx),
      ty,
    );
    return 1.45 * mix(slice(iz, fz), slice(jz, fz - 1), tz);
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

function weatherOctaves(seed: number, period: number) {
  const broad = gradientField(seed, period);
  const medium = gradientField(seed + 1, period * 2);
  const fine = gradientField(seed + 2, period * 4);
  const wisps = gradientField(seed + 3, period * 8);
  return (u: number, v: number) => 0.60 * broad(u, v) + 0.25 * medium(u, v) + 0.11 * fine(u, v) + 0.04 * wisps(u, v);
}

function weatherField() {
  const seeds = rng.create(ALPINE_SEED).fork('weather');
  const grad = (label: string, period: number) => gradientField(seeds.fork(label).seed, period);
  const climate = grad('climate', 4);
  const warpU = grad('warp-u', 8), warpV = grad('warp-v', 8);
  const foldU = grad('fold-u', 37), foldV = grad('fold-v', 37);
  const cumulus = weatherOctaves(seeds.fork('cumulus').seed, 12);
  const crests = weatherOctaves(seeds.fork('crests').seed, 15);
  const banks = weatherOctaves(seeds.fork('banks').seed, 7);
  const regionalTexture = grad('mask-grain', 23);

  return (u: number, v: number) => {
    // All offsets belong to the world tile. The wrap keeps opposite edges continuous.
    const broadU = u + 0.042 * warpU(u, v);
    const broadV = v + 0.042 * warpV(u, v);
    const x = broadU + 0.009 * foldU(broadU, broadV);
    const y = broadV + 0.009 * foldV(broadU, broadV);
    const regional = climate(x, y);
    const rangeKm = TILE_KM * Math.hypot(wrapped(x), wrapped(y)) + 7 * regional;
    const clearing = smooth(0.8, 4.1, rangeKm);
    const far = smooth(20, 56, rangeKm);

    const cell = cumulus(x + 0.132, y - 0.069);
    const crest = crests(x - 0.084, y + 0.156);
    const mass = 0.5 + 0.77 * cell + 0.14 * regional;
    const puffs = smooth(mix(0.408, 0.506, far), mix(0.704, 0.781, far), mass);
    const middle = clearing * mix(0.94, 0.67, far) * puffs;
    const tower = clearing * (1 - 0.65 * far) * 0.94 * smooth(0.487, 0.768, mass + 0.17 * crest)
      * smooth(0.16, 0.61, puffs);

    // Integer shears make the elongated field periodic both along and across the bands.
    const bank = 0.51 + 0.71 * banks(x + 0.35, x + 3 * y - 0.21) + 0.12 * regional;
    const distanceBand = smooth(8, 19, rangeKm) * (1 - 0.58 * smooth(43, 76, rangeKm));
    const low = 0.92 * smooth(0.519, 0.748, bank) * distanceBand;
    const mask = smooth(0.28, 0.78, Math.max(middle, tower))
      * mix(0.22, 0.82, smooth(-0.4, 0.4, regional + 0.25 * regionalTexture(x, y)));
    return { lanes: [low, middle, tower, 0] as const, mask };
  };
}

function heightProfile(height: number, coverage: number) {
  // An absent lane lands on a zero-padded edge of the repeating LUT.
  const weight = smooth(0.018, 0.31, coverage) * (1 - smooth(0.955, 0.995, coverage));
  const growth = saturate(coverage / 0.91);
  const lift = Math.sqrt(growth);
  const lobe = (center: number, widthBelow: number, widthAbove: number, peak: number) => {
    const distance = (height - center) / (height < center ? widthBelow : widthAbove);
    const response = peak - 0.27 * (Math.hypot(distance, 0.12) - 0.12);
    return weight * saturate(response) * smooth(0.013, 0.051, height) * (1 - smooth(0.84, 0.955, height));
  };
  return [
    lobe(mix(0.067, 0.119, growth), 0.081, mix(0.055, 0.118, growth), 0.46 + 0.143 * lift),
    lobe(mix(0.117, 0.318, growth), mix(0.14, 0.30, growth), mix(0.11, 0.275, growth), 0.425 + 0.219 * lift),
    lobe(mix(0.190, 0.448, growth), mix(0.155, 0.375, growth), mix(0.155, 0.305, growth), 0.418 + 0.256 * lift),
    0,
  ] as const;
}

function bodyField() {
  const seeds = rng.create(ALPINE_SEED).fork('volume');
  const perlin = (label: string, period: number) => gradientField(seeds.fork(label).seed, period);
  const worley = (label: string, period: number) => cellField(seeds.fork(label).seed, period);
  const broad = perlin('mass', 5), medium = perlin('folds', 10), fine = perlin('wisps', 20), grain = perlin('grain', 40);
  const warp = perlin('warp', 6), warpDetail = perlin('warp-detail', 12);
  const lobes = worley('lobes', 6), folds = worley('folds', 12), details = worley('detail', 24), pores = worley('pores', 36);
  return (u: number, v: number, w: number) => {
    const p = broad(u, v, w), m = medium(u, v, w), f = fine(u, v, w), g = grain(u, v, w);
    const cell = lobes(u, v, w), fold = folds(u, v, w), detail = details(u, v, w), pore = pores(u, v, w);
    return [
      0.62 + 0.40 * warp(u, v, w) + 0.17 * warpDetail(u, v, w) + 0.045 * g,
      0.48 + 0.36 * p + 0.14 * m + 0.068 * f + 0.027 * g + 0.74 * (cell - 0.43) + 0.29 * (fold - 0.43),
      0.47 + 0.34 * f + 0.13 * g + 0.73 * (detail - 0.43) + 0.18 * (pore - 0.43),
      0.48 + 0.9 * (pore - 0.43) + 0.1 * g,
    ] as const;
  };
}

export function makeAlpineTexture(role: AlpineTextureRole, size: number = SIZE[role]): TextureAsset & { data: Uint8Array } {
  const volume = role === 'body-noise';
  const unorm = role === 'layout-mask';
  const depth = volume ? size : 1;
  const data = new Uint8Array(size * size * depth * (unorm ? 4 : 8));
  const half = new DataView(data.buffer);
  const weather = role === 'layout-pattern' || unorm ? weatherField() : undefined;
  const field = volume ? bodyField() : role === 'height-profile' ? heightProfile :
    unorm ? (u: number, v: number) => {
      const { mask } = weather!(u - 0.5, v - 0.5);
      return [mask * 0.85, mask, mask * 0.91, 0] as const;
    } : (u: number, v: number) => weather!(u, v).lanes;
  for (let z = 0; z < depth; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const texel = field((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size);
    const offset = 4 * (x + size * (y + size * z));
    for (const channel of [0, 1, 2, 3] as const) {
      if (unorm) data[offset + channel] = Math.round(255 * saturate(texel[channel]));
      else half.setUint16(2 * (offset + channel), halfFloat.f32ToF16(volume ? texel[channel] : saturate(texel[channel])), true);
    }
  }
  return {
    kind: 'texture', format: unorm ? 'rgba8unorm' : 'rgba16float', colorSpace: 'linear', data,
    shape: volume ? { viewDimension: '3d', extent: { width: size, height: size, depth } } :
      { viewDimension: '2d', extent: { width: size, height: size } }, mips: { kind: 'none' },
  };
}
