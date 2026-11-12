import { type EquirectAsset, err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import type { Region2 } from './compute/region-ts';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import { type RegionInput, toRegion } from './region2d';

/**
 * Procedural textures (design 13): deterministic RGBA8 `TextureAsset`s generated in
 * TypeScript at build time, so materials and decals need no image files. Noise is an
 * integer hash of the lattice cell and seed; every generator tiles seamlessly.
 */

/** Linear RGBA in [0, 1]. */
export type Rgba = readonly [number, number, number, number];

export interface TextureOptions {
  /** 'srgb' for colors, 'linear' (default) for data such as normals and roughness. */
  readonly colorSpace?: 'srgb' | 'linear';
  /** A box-filtered mip chain packed with the texture (default true). */
  readonly mips?: boolean;
  /**
   * Alpha-test cutoff: each mip level scales its alpha so the fraction of texels at or
   * above the cutoff matches level 0 (the `mask` filter of `mipChain`).
   */
  readonly alphaCutoff?: number;
}

function requireSize(name: string, value: number): Result<number, ModelingError> {
  if (!Number.isInteger(value) || value < 1 || value > 4096) {
    return err(
      modelingError('model-invalid-argument', `${name} is an integer in [1, 4096]`, {
        [name]: value,
      }),
    );
  }
  return ok(value);
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** `x^e` for x in (0, 1] and e in [0, 1): a product of exact square-root chains (24 bits of e). */
function powFraction(x: number, e: number): number {
  let out = 1;
  let root = x;
  let rest = e;
  for (let k = 0; k < 24; k++) {
    root = Math.sqrt(root);
    rest *= 2;
    if (rest >= 1) {
      out *= root;
      rest -= 1;
    }
  }
  return out;
}

function encodeSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * powFraction(v, 1 / 2.4) - 0.055;
}

/** Pack per-texel colors into a texture; `texel(x, y)` returns linear RGBA. */
export function textureFrom(
  width: number,
  height: number,
  texel: (x: number, y: number) => Rgba,
  options: TextureOptions = {},
): Result<TextureAsset, ModelingError> {
  const w = requireSize('width', width);
  if (!w.ok) return w;
  const h = requireSize('height', height);
  if (!h.ok) return h;
  const base = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) base.set(texel(x, y), (y * width + x) * 4);
  }
  return ok(packTexture(width, height, base, options, 'color'));
}

/**
 * A material-ID texture (sRGB palette colors): its mips point-sample level 0, so every
 * level holds only the IDs of level 0; a box filter would blend neighbouring IDs into
 * colors that match no slot.
 * @internal
 */
export function idTexture(
  width: number,
  height: number,
  texel: (x: number, y: number) => Rgba,
  mips: boolean,
): Result<TextureAsset, ModelingError> {
  const w = requireSize('width', width);
  if (!w.ok) return w;
  const h = requireSize('height', height);
  if (!h.ok) return h;
  const base = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) base.set(texel(x, y), (y * width + x) * 4);
  }
  return ok(packTexture(width, height, base, { colorSpace: 'srgb', mips }, 'id'));
}

/**
 * Encode linear float texels (normal maps: unit XYZ stored as v * 0.5 + 0.5) with the
 * delivery mip chain (`filterLevels`) packed mip-major, so every consumer samples
 * prefiltered levels.
 */
function packTexture(
  width: number,
  height: number,
  base: Float64Array,
  options: TextureOptions,
  content: 'color' | 'normal' | 'id',
): TextureAsset {
  const srgb = options.colorSpace === 'srgb';
  const cutoff = options.alphaCutoff;
  const normals = content === 'normal';
  const kind: FilterKind =
    content === 'id' ? 'nearest' : normals ? 'normal' : cutoff !== undefined ? 'mask' : 'linear';
  if (normals)
    for (let i = 0; i < base.length; i++) if (i % 4 !== 3) base[i] = (base[i] as number) * 2 - 1;
  const sizes = mipSizes(width, height, options.mips !== false);
  const levels = writeLevels(filterLevels(base, sizes, kind, cutoff), sizes, kind, srgb);
  const data = new Uint8Array(levels.reduce((n, l) => n + l.byteLength, 0));
  let offset = 0;
  for (const level of levels) {
    data.set(level, offset);
    offset += level.byteLength;
  }
  return {
    kind: 'texture',
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    shape: { viewDimension: '2d', extent: { width, height } },
    mips: levels.length === 1 ? { kind: 'none' } : { kind: 'packed', levelCount: levels.length },
    data,
  };
}

// ---- noise ----------------------------------------------------------------------------

/** Hash of an integer lattice point and seed to [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Tileable value noise with `period` lattice cells per tile, at tile coordinates in [0, 1). */
export function valueNoise(u: number, v: number, period: number, seed = 0): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const at = (i: number, j: number) => hash2(wrap(i, period), wrap(j, period), seed);
  const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx;
  const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}

/** Sum of octaves of value noise, normalized to [0, 1]. */
export function fractalNoise(
  u: number,
  v: number,
  period: number,
  octaves: number,
  seed = 0,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, p, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/** Tangent-space normal map from unit normals per texel (each mip level renormalized). */
export function normalTexture(
  width: number,
  height: number,
  normalAt: (x: number, y: number) => readonly [number, number, number],
  options: Pick<TextureOptions, 'mips'> = {},
): Result<TextureAsset, ModelingError> {
  const w = requireSize('width', width);
  if (!w.ok) return w;
  const h = requireSize('height', height);
  if (!h.ok) return h;
  const base = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [nx, ny, nz] = normalAt(x, y);
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      base.set(
        [(nx / len) * 0.5 + 0.5, (ny / len) * 0.5 + 0.5, (nz / len) * 0.5 + 0.5, 1],
        (y * width + x) * 4,
      );
    }
  }
  return ok(packTexture(width, height, base, options, 'normal'));
}

/**
 * Tangent-space normal map (glTF convention: +X right, +Y toward increasing v) from a
 * tileable height field in texels; `strength` scales the slope.
 */
export function normalFromHeight(
  width: number,
  height: number,
  heightAt: (x: number, y: number) => number,
  strength: number,
  options: Pick<TextureOptions, 'mips'> = {},
): Result<TextureAsset, ModelingError> {
  const w = requireSize('width', width);
  if (!w.ok) return w;
  const h0 = requireSize('height', height);
  if (!h0.ok) return h0;
  const field = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) field[y * width + x] = heightAt(x, y);
  const h = (x: number, y: number) => field[wrap(y, height) * width + wrap(x, width)] as number;
  const base = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = ((h(x + 1, y) - h(x - 1, y)) / 2) * strength;
      const dy = ((h(x, y + 1) - h(x, y - 1)) / 2) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      base.set(
        [(-dx / len) * 0.5 + 0.5, (-dy / len) * 0.5 + 0.5, (1 / len) * 0.5 + 0.5, 1],
        (y * width + x) * 4,
      );
    }
  }
  return ok(packTexture(width, height, base, options, 'normal'));
}

// ---- raster ---------------------------------------------------------------------------

/** Coverage in [0, 1] per texel of a region drawn into `rect` = [x0, y0, x1, y1] (region units). */
export function coverage(
  input: RegionInput,
  width: number,
  height: number,
  rect: readonly [number, number, number, number],
  supersample = 4,
): Float32Array {
  const region: Region2 = toRegion(input);
  const edges: [Point2, Point2][] = [];
  for (const shape of region) {
    for (const ring of [shape.outer, ...(shape.holes ?? [])]) {
      for (let i = 0; i < ring.length; i++)
        edges.push([ring[i] as Point2, ring[(i + 1) % ring.length] as Point2]);
    }
  }
  const out = new Float32Array(width * height);
  const s = Math.max(1, Math.floor(supersample));
  const [x0, y0, x1, y1] = rect;
  const sx = (x1 - x0) / (width * s);
  const sy = (y1 - y0) / (height * s);
  const weight = 1 / (s * s);
  const crossings: number[] = [];
  for (let row = 0; row < height * s; row++) {
    const y = y0 + (row + 0.5) * sy;
    crossings.length = 0;
    for (const [a, b] of edges) {
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    crossings.sort((p, q) => p - q);
    const py = Math.floor(row / s);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // Sample columns whose centers fall inside [start, end).
      const c0 = Math.max(0, Math.ceil(((crossings[k] as number) - x0) / sx - 0.5));
      const c1 = Math.min(
        width * s - 1,
        Math.ceil(((crossings[k + 1] as number) - x0) / sx - 0.5) - 1,
      );
      for (let c = c0; c <= c1; c++) {
        const idx = py * width + Math.floor(c / s);
        out[idx] = (out[idx] as number) + weight;
      }
    }
  }
  return out;
}

export interface DecalLayer {
  readonly region: RegionInput;
  /** Linear RGBA; alpha scales the layer's coverage. */
  readonly color: Rgba;
}

export interface DecalTextureOptions extends TextureOptions {
  readonly width: number;
  readonly height: number;
  /** Linear RGBA under every layer. */
  readonly background: Rgba;
  /** Drawn in order, each over the previous ones. */
  readonly layers: readonly DecalLayer[];
  /** Region units covered by the texture (default [0, 0, 1, 1]: the normalized uv1 domain). */
  readonly rect?: readonly [number, number, number, number];
  /** Samples per texel side for coverage (default 4). */
  readonly supersample?: number;
}

/** A decal sheet: anti-aliased regions composited over a background (sRGB by default). */
export function decalTexture(options: DecalTextureOptions): Result<TextureAsset, ModelingError> {
  const w = requireSize('width', options.width);
  if (!w.ok) return w;
  const h = requireSize('height', options.height);
  if (!h.ok) return h;
  const rect = options.rect ?? [0, 0, 1, 1];
  const pixels = new Float32Array(options.width * options.height * 4);
  for (let i = 0; i < options.width * options.height; i++) pixels.set(options.background, i * 4);
  for (const layer of options.layers) {
    const cover = coverage(
      layer.region,
      options.width,
      options.height,
      rect,
      options.supersample ?? 4,
    );
    for (let i = 0; i < cover.length; i++) {
      const a = Math.min(1, cover[i] as number) * layer.color[3];
      if (a === 0) continue;
      for (let k = 0; k < 3; k++) {
        pixels[i * 4 + k] =
          (pixels[i * 4 + k] as number) * (1 - a) + (layer.color[k] as number) * a;
      }
      pixels[i * 4 + 3] = (pixels[i * 4 + 3] as number) * (1 - a) + a;
    }
  }
  return textureFrom(
    options.width,
    options.height,
    (x, y) => {
      const o = (y * options.width + x) * 4;
      return [
        pixels[o] as number,
        pixels[o + 1] as number,
        pixels[o + 2] as number,
        pixels[o + 3] as number,
      ];
    },
    {
      colorSpace: options.colorSpace ?? 'srgb',
      ...(options.mips === undefined ? {} : { mips: options.mips }),
    },
  );
}

/** IEEE half-precision bits of a finite float (round to nearest even; overflow saturates). */
function half(value: number): number {
  const f = new Float32Array([value]);
  const x = new Uint32Array(f.buffer)[0] as number;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7bff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000) >> 13);
  }
  const rounded = (exp << 10) | (mant >> 13);
  const rest = mant & 0x1fff;
  return sign | (rest > 0x1000 || (rest === 0x1000 && (rounded & 1) === 1) ? rounded + 1 : rounded);
}

export interface StudioEnvironmentOptions {
  /** Equirect width (height is half; default 256). */
  readonly width?: number;
  /** Linear radiance of the soft boxes (default 6). */
  readonly softbox?: number;
  /** Linear radiance of the horizon walls (default 0.35). */
  readonly wall?: number;
  /** Linear radiance of the floor (default 0.06). */
  readonly floor?: number;
}

/**
 * A procedural HDR studio for image-based lighting (rgba16float equirect): a dark
 * floor, graded walls, a soft top light and two long soft boxes, so metals and clear
 * coats have something to reflect without an image file.
 */
export function studioEnvironment(
  options: StudioEnvironmentOptions = {},
): Result<EquirectAsset, ModelingError> {
  const width = options.width ?? 256;
  const w = requireSize('width', width);
  if (!w.ok) return w;
  const height = Math.max(1, Math.floor(width / 2));
  const softbox = options.softbox ?? 6;
  const wall = options.wall ?? 0.35;
  const floor = options.floor ?? 0.06;
  const data = new Uint8Array(width * height * 8);
  const view = new DataView(data.buffer);
  const box = (u: number, v: number, cu: number, cv: number, hu: number, hv: number) => {
    const du = Math.abs(((u - cu + 1.5) % 1) - 0.5) / hu;
    const dv = Math.abs(v - cv) / hv;
    const d = Math.max(du, dv);
    return d >= 1 ? 0 : d < 0.8 ? 1 : (1 - d) / 0.2;
  };
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      // v = 0 is straight up, 0.5 the horizon.
      let r = v > 0.5 ? floor : wall * (0.55 + 0.45 * (v / 0.5));
      r += softbox * 0.5 * box(u, v, 0.5, 0.04, 0.5, 0.06);
      r += softbox * box(u, v, 0.18, 0.3, 0.035, 0.16);
      r += softbox * box(u, v, 0.68, 0.33, 0.06, 0.1);
      const o = (y * width + x) * 8;
      view.setUint16(o, half(r), true);
      view.setUint16(o + 2, half(r * 0.98), true);
      view.setUint16(o + 4, half(r * 0.95), true);
      view.setUint16(o + 6, half(1), true);
    }
  }
  return ok({
    kind: 'equirect',
    width,
    height,
    format: 'rgba16float',
    colorSpace: 'linear',
    data,
  });
}

// ---- the mip filter: raw textures and block-compressed deliveries ----------

/**
 * Channel layout of a delivery texture: `normal` keeps tangent-space X and Y
 * (Z is rebuilt by the shader), `ormh` packs occlusion, roughness, metalness and height
 * (glTF order, linear), `color` is a base color in its own color space, `mask` is a
 * color whose alpha is an alpha-tested cutout keeping its coverage on every level.
 */
export type DeliveryLayout = 'normal' | 'ormh' | 'color' | 'mask';

export interface MipChainOptions {
  readonly layout: DeliveryLayout;
  /**
   * `ormh` only: the tangent-space normal map of the same surface and size. Each level's
   * roughness (G) is widened by the normal variance the level averages away (Toksvig:
   * the shortening of the mean normal), so distant bumps read rougher instead of
   * sparkling.
   */
  readonly roughnessFromNormal?: TextureAsset;
  /** `mask` only: the material's alpha cutoff (default 0.5). */
  readonly alphaCutoff?: number;
}

export interface MipChain {
  readonly layout: DeliveryLayout;
  readonly width: number;
  readonly height: number;
  /** Tight RGBA8 levels, level 0 first, each `max(1, size >> k)`. */
  readonly levels: readonly Uint8Array[];
  /** `rg` for normal maps: X in R, Y in G (B holds Z for uncompressed previews). */
  readonly channels: 'rg' | 'rgba';
  readonly colorSpace: 'srgb' | 'linear';
  /** Versioned filter policy; a change re-encodes every texture (part of the encode key). */
  readonly policy: string;
}

/** Bump on any change to the filtering below: it is part of every encode key. */
const MIP_POLICY = {
  normal: 'normal-rg-renorm/1',
  ormh: 'ormh-box/1',
  ormhToksvig: 'ormh-box-toksvig/2',
  color: 'color-box-linear/1',
  mask: 'mask-coverage/1',
} as const;

/**
 * `normal`: mean of the level-0 unit normals; `linear`: box; `mask`: box with coverage-kept
 * alpha; `nearest`: point sampling (IDs).
 */
type FilterKind = 'normal' | 'linear' | 'mask' | 'nearest';

function mipSizes(width: number, height: number, mips: boolean): [number, number][] {
  const sizes: [number, number][] = [[width, height]];
  while (mips) {
    const [w, h] = sizes[sizes.length - 1] as [number, number];
    if (w === 1 && h === 1) break;
    sizes.push([Math.max(1, w >> 1), Math.max(1, h >> 1)]);
  }
  return sizes;
}

/** One 2x2 point step: each texel keeps its top-left source texel. */
function pointDown(src: Float64Array, w: number, h: number): Float64Array {
  const lw = Math.max(1, w >> 1);
  const lh = Math.max(1, h >> 1);
  const out = new Float64Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const s = (Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2)) * 4;
      out.set(src.subarray(s, s + 4), (y * lw + x) * 4);
    }
  }
  return out;
}

/** One 2x2 box step (edges clamp for odd sizes) over RGBA floats. */
function boxDown(src: Float64Array, w: number, h: number): Float64Array {
  const lw = Math.max(1, w >> 1);
  const lh = Math.max(1, h >> 1);
  const out = new Float64Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const o = (y * lw + x) * 4;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const s = (Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * 4;
        for (let k = 0; k < 4; k++)
          out[o + k] = (out[o + k] as number) + (src[s + k] as number) / 4;
      }
    }
  }
  return out;
}

const coverageOf = (px: Float64Array, cutoff: number, scale: number): number => {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (Math.min(1, (px[i] as number) * scale) >= cutoff) n++;
  return n / (px.length / 4);
};

/**
 * Float levels of `base` (linear RGBA; normals as XYZ in [-1, 1]): normal levels hold the
 * unnormalized mean of the level-0 unit normals (its length is the Toksvig input), every
 * other channel the box mean. A `mask` scales each level's alpha so the fraction of
 * texels at or above `cutoff` equals level 0's (alpha-test coverage).
 */
function filterLevels(
  base: Float64Array,
  sizes: readonly [number, number][],
  kind: FilterKind,
  cutoff = 0.5,
): Float64Array[] {
  if (kind === 'normal') {
    for (let i = 0; i < base.length; i += 4) {
      const x = base[i] as number;
      const y = base[i + 1] as number;
      const z = base[i + 2] as number;
      const len = Math.sqrt(x * x + y * y + z * z);
      base.set(len > 0 ? [x / len, y / len, z / len] : [0, 0, 1], i);
    }
  }
  // Each level box-filters the previous unscaled mean; a mask scales only its output.
  const means = [base];
  const levels = [base];
  const target = kind === 'mask' ? coverageOf(base, cutoff, 1) : 0;
  for (let k = 1; k < sizes.length; k++) {
    const [w, h] = sizes[k - 1] as [number, number];
    const previous = means[k - 1] as Float64Array;
    const mean = kind === 'nearest' ? pointDown(previous, w, h) : boxDown(previous, w, h);
    means.push(mean);
    if (kind !== 'mask') {
      levels.push(mean);
      continue;
    }
    let lo = 0;
    let hi = 256;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (coverageOf(mean, cutoff, mid) < target) lo = mid;
      else hi = mid;
    }
    const miss = (scale: number) => Math.abs(coverageOf(mean, cutoff, scale) - target);
    const scale = miss(hi) <= miss(lo) ? hi : lo;
    const out = Float64Array.from(mean);
    for (let i = 3; i < out.length; i += 4) out[i] = Math.min(1, (out[i] as number) * scale);
    levels.push(out);
  }
  return levels;
}

/** RGBA8 bytes of float levels: normals renormalized, sRGB colors encoded. */
function writeLevels(
  levels: readonly Float64Array[],
  sizes: readonly [number, number][],
  kind: FilterKind,
  srgb: boolean,
  roughnessLengths?: readonly Float64Array[],
): Uint8Array[] {
  return levels.map((px, k) => {
    const [w, h] = sizes[k] as [number, number];
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (kind === 'normal') {
        const x = px[i * 4] as number;
        const y = px[i * 4 + 1] as number;
        const z = px[i * 4 + 2] as number;
        const len = Math.sqrt(x * x + y * y + z * z);
        const n = len > 0 ? [x / len, y / len, z / len] : [0, 0, 1];
        for (let c = 0; c < 3; c++) out[i * 4 + c] = byte((n[c] as number) * 0.5 + 0.5);
        out[i * 4 + 3] = byte(px[i * 4 + 3] as number);
        continue;
      }
      for (let c = 0; c < 4; c++) {
        let v = px[i * 4 + c] as number;
        // Level 0 is the authored roughness: its mean normal is the texel's own unit normal.
        if (c === 1 && k > 0 && roughnessLengths !== undefined)
          v = toksvigRoughness(v, roughnessLengths[k]?.[i] as number);
        out[i * 4 + c] = byte(srgb && c !== 3 ? encodeSrgb(Math.max(0, Math.min(1, v))) : v);
      }
    }
    return out;
  });
}

/**
 * A single-channel r16unorm texture (the 16-bit height source) with the linear box
 * chain of `filterLevels` packed mip-major, so 16-bit maps share the one mip filter.
 * @internal
 */
export function r16Texture(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
  mips: boolean,
): TextureAsset {
  const base = new Float64Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) base[(y * width + x) * 4] = value(x, y);
  const sizes = mipSizes(width, height, mips);
  const levels = filterLevels(base, sizes, 'linear');
  const data = new Uint8Array(sizes.reduce((n, [w, h]) => n + w * h * 2, 0));
  let offset = 0;
  for (const level of levels) {
    for (let i = 0; i < level.length; i += 4) {
      const q = Math.round(Math.max(0, Math.min(1, level[i] as number)) * 65535);
      data[offset++] = q & 255;
      data[offset++] = q >> 8;
    }
  }
  return {
    kind: 'texture',
    format: 'r16unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width, height } },
    mips: levels.length === 1 ? { kind: 'none' } : { kind: 'packed', levelCount: levels.length },
    data,
  };
}

function level0(texture: TextureAsset, name: string): Result<Uint8Array, ModelingError> {
  const { width, height } = texture.shape.extent;
  if (
    texture.shape.viewDimension !== '2d' ||
    texture.encoding !== undefined ||
    (texture.format !== 'rgba8unorm' && texture.format !== 'rgba8unorm-srgb') ||
    texture.data.length < width * height * 4
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        `${name} is an unencoded 2d rgba8unorm(-srgb) texture with its level 0 texels`,
        { format: texture.format, encoding: texture.encoding, input: name },
      ),
    );
  }
  if (width % 4 !== 0 || height % 4 !== 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        `${name} has a size divisible by 4 (block-compressed level 0)`,
        { width, height, input: name },
      ),
    );
  }
  return ok(texture.data.subarray(0, width * height * 4));
}

/**
 * Toksvig: a mean normal of length `len` widens a lobe of perceptual roughness `r`.
 * With alpha = r^2 and the matching Blinn-Phong power s = 2 / alpha^2 - 2, the
 * filtered power is s * len / (len + s * (1 - len)); returns its perceptual roughness.
 */
export function toksvigRoughness(r: number, len: number): number {
  const alpha = Math.max(r * r, 1e-4);
  const s = 2 / (alpha * alpha) - 2;
  const l = Math.max(1e-6, Math.min(1, len));
  const filtered = (s * l) / (l + s * (1 - l));
  return Math.min(1, Math.sqrt(Math.sqrt(2 / (filtered + 2))));
}

/** @internal Linear value of an sRGB-encoded channel in [0, 1]. */
export function decodeSrgb(v: number): number {
  if (v <= 0.04045) return v / 12.92;
  const t = (v + 0.055) / 1.055;
  return t * t * powFraction(t, 0.4);
}

/** Float level 0 of rgba8 bytes: normals to XYZ in [-1, 1], sRGB colors to linear. */
function floatBase(bytes: Uint8Array, kind: FilterKind, srgb: boolean): Float64Array {
  const base = new Float64Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] as number) / 255;
    base[i] = i % 4 === 3 ? v : kind === 'normal' ? v * 2 - 1 : srgb ? decodeSrgb(v) : v;
  }
  return base;
}

/**
 * The delivery mip chain of a baked or procedural texture, filtered in float from its
 * level 0 by the same filter as every packed TextureAsset: normals average the unit
 * level-0 normals and renormalize every level; `ormh` and linear colors box-filter,
 * sRGB colors filter in linear light, masks keep their alpha-test coverage; with
 * `roughnessFromNormal` each `ormh` level widens its roughness by Toksvig. Encoders take
 * the levels as they are (`basisEncode({ levels })`), so no encoder filter shortens
 * normals.
 */
export function mipChain(
  texture: TextureAsset,
  options: MipChainOptions,
): Result<MipChain, ModelingError> {
  const { layout } = options;
  const bytes = level0(texture, layout);
  if (!bytes.ok) return bytes;
  if (options.roughnessFromNormal !== undefined && layout !== 'ormh') {
    return err(
      modelingError('model-invalid-argument', 'roughnessFromNormal belongs to an ormh layout', {
        layout,
      }),
    );
  }
  const cutoff = options.alphaCutoff ?? 0.5;
  if (options.alphaCutoff !== undefined && (layout !== 'mask' || !(cutoff > 0 && cutoff < 1))) {
    return err(
      modelingError('model-invalid-argument', 'alphaCutoff is in (0, 1) on a mask layout', {
        layout,
        alphaCutoff: options.alphaCutoff,
      }),
    );
  }
  const { width, height } = texture.shape.extent;
  const sizes = mipSizes(width, height, true);
  const kind: FilterKind = layout === 'normal' ? 'normal' : layout === 'mask' ? 'mask' : 'linear';
  const srgb = (layout === 'color' || layout === 'mask') && texture.colorSpace === 'srgb';
  let lengths: Float64Array[] | undefined;
  if (options.roughnessFromNormal !== undefined) {
    const n = options.roughnessFromNormal.shape.extent;
    if (n.width !== width || n.height !== height) {
      return err(
        modelingError('model-invalid-argument', 'roughnessFromNormal has the ormh size', {
          ormh: [width, height],
          normal: [n.width, n.height],
        }),
      );
    }
    const normalBytes = level0(options.roughnessFromNormal, 'roughnessFromNormal');
    if (!normalBytes.ok) return normalBytes;
    lengths = filterLevels(floatBase(normalBytes.value, 'normal', false), sizes, 'normal').map(
      (m) => {
        const out = new Float64Array(m.length / 4);
        for (let i = 0; i < out.length; i++) {
          const x = m[i * 4] as number;
          const y = m[i * 4 + 1] as number;
          const z = m[i * 4 + 2] as number;
          out[i] = Math.sqrt(x * x + y * y + z * z);
        }
        return out;
      },
    );
  }
  const levels = writeLevels(
    filterLevels(floatBase(bytes.value, kind, srgb), sizes, kind, cutoff),
    sizes,
    kind,
    srgb,
    lengths,
  );
  return ok({
    layout,
    width,
    height,
    levels,
    channels: layout === 'normal' ? 'rg' : 'rgba',
    colorSpace: srgb ? 'srgb' : 'linear',
    policy:
      layout === 'ormh' && lengths !== undefined ? MIP_POLICY.ormhToksvig : MIP_POLICY[layout],
  });
}
