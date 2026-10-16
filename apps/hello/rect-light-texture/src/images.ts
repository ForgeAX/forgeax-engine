// apps/hello/rect-light-texture - procedural light images. Each one is drawn
// once in linear float RGB and encoded into the storage format it exercises,
// so the gallery covers every uncompressed sourceTexture encoding and sizes
// from 128x64 up to a 1024x512 source that must be box-filtered down.

import type { TextureAsset } from '@forgeax/engine-types';

export type GalleryImage = 'stained-glass' | 'sunset' | 'tv-bars' | 'neon' | 'blinds' | 'rainbow';

export type SourceEncoding =
  | 'rgba8unorm-srgb'
  | 'rgba8unorm'
  | 'bgra8unorm-srgb'
  | 'r8unorm'
  | 'rgba16float'
  | 'rgba32float';

export interface GalleryEntry {
  readonly width: number;
  readonly height: number;
  readonly encoding: SourceEncoding;
  /** Linear RGB at normalized (u, v), v = 0 at the image top. */
  readonly paint: (u: number, v: number) => readonly [number, number, number];
}

type Rgb = readonly [number, number, number];

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const srgbToLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const linearRgb = (c: Rgb): Rgb => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
const fromSrgb = (r: number, g: number, b: number): Rgb => [
  srgbToLinear(r / 255),
  srgbToLinear(g / 255),
  srgbToLinear(b / 255),
];

function hueToRgb(hue: number): Rgb {
  const h = ((hue % 1) + 1) % 1;
  const channel = (offset: number) =>
    Math.min(1, Math.max(0, Math.abs(((h * 6 + offset) % 6) - 3) - 1));
  return [channel(0), channel(4), channel(2)];
}

/** Deterministic Voronoi seeds (LCG) shared by every render of the image. */
const GLASS_SEEDS = (() => {
  let state = 0x2f6b1d;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const palette: Rgb[] = [
    fromSrgb(200, 20, 40),
    fromSrgb(20, 60, 190),
    fromSrgb(240, 170, 20),
    fromSrgb(30, 150, 70),
    fromSrgb(120, 30, 160),
    fromSrgb(20, 160, 190),
  ];
  return Array.from({ length: 36 }, (_, index) => ({
    x: next() * 2,
    y: next(),
    color: palette[index % palette.length] as Rgb,
  }));
})();

function stainedGlass(u: number, v: number): Rgb {
  const x = u * 2;
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  let color: Rgb = [0, 0, 0];
  for (const seed of GLASS_SEEDS) {
    const distance = Math.hypot(x - seed.x, v - seed.y);
    if (distance < nearest) {
      second = nearest;
      nearest = distance;
      color = seed.color;
    } else if (distance < second) {
      second = distance;
    }
  }
  // Lead came between cells and around the frame.
  const lead = 1 - smoothstep(0.008, 0.02, second - nearest);
  const frame = 1 - smoothstep(0.015, 0.035, Math.min(u, 1 - u, v, 1 - v) * 2);
  const glow = 0.75 + 0.25 * Math.cos((nearest / 0.12) * Math.PI);
  return mixRgb(
    [color[0] * glow, color[1] * glow, color[2] * glow],
    [0.01, 0.01, 0.01],
    Math.max(lead, frame),
  );
}

function sunset(u: number, v: number): Rgb {
  const zenith = fromSrgb(20, 30, 90);
  const horizon = fromSrgb(255, 120, 40);
  let sky = mixRgb(zenith, horizon, smoothstep(0.05, 0.72, v));
  const sunDistance = Math.hypot((u - 0.68) * 2, v - 0.52);
  // The disc is HDR (3x) and clips in the 8-bit light slice; the halo shows
  // the smooth part of the range that survives.
  const halo = Math.exp(-sunDistance * 7) * 0.9;
  sky = [sky[0] + halo, sky[1] + halo * 0.55, sky[2] + halo * 0.2];
  if (sunDistance < 0.075) sky = [3, 2.4, 1.6];
  const ridge =
    0.74 + 0.05 * Math.sin(u * 13.0) + 0.03 * Math.sin(u * 31.0 + 1.3) + 0.015 * Math.sin(u * 77.0);
  return v > ridge ? [0.004, 0.003, 0.008] : sky;
}

const BAR_COLORS: readonly Rgb[] = [
  [0.75, 0.75, 0.75],
  [0.75, 0.75, 0],
  [0, 0.75, 0.75],
  [0, 0.75, 0],
  [0.75, 0, 0.75],
  [0.75, 0, 0],
  [0, 0, 0.75],
];

function tvBars(u: number, v: number): Rgb {
  const bar = Math.min(6, Math.floor(u * 7));
  if (v < 0.67) return linearRgb(BAR_COLORS[bar] as Rgb);
  if (v < 0.75) {
    const reverse = bar % 2 === 0 ? (BAR_COLORS[6 - bar] as Rgb) : ([0.03, 0.03, 0.03] as Rgb);
    return linearRgb(reverse);
  }
  // PLUGE row: navy, white, purple, then black steps.
  if (u < 0.18) return fromSrgb(0, 33, 76);
  if (u < 0.36) return [1, 1, 1];
  if (u < 0.54) return fromSrgb(50, 0, 106);
  return u < 0.8 ? [0.002, 0.002, 0.002] : [0.012, 0.012, 0.012];
}

function neon(u: number, v: number): Rgb {
  const x = u * 2;
  const pink: Rgb = [1, 0.05, 0.45];
  const cyan: Rgb = [0.05, 0.85, 1];
  const tube = (distance: number) => Math.exp(-((distance / 0.012) ** 2)) + 0.25 * Math.exp(-distance / 0.05);
  const ring = tube(Math.abs(Math.hypot(x - 0.55, v - 0.5) - 0.3));
  const inner = tube(Math.abs(Math.hypot(x - 0.55, v - 0.5) - 0.16));
  // A zigzag (lightning) on the right in cyan.
  const zig = 0.5 + 0.18 * (2 * Math.abs(((x - 1.05) * 3.2) % 2 - 1) - 1);
  const zigzag = x > 1.05 && x < 1.8 ? tube(Math.abs(v - zig)) : 0;
  return [
    0.008 + pink[0] * (ring + inner) + cyan[0] * zigzag,
    0.006 + pink[1] * (ring + inner) + cyan[1] * zigzag,
    0.014 + pink[2] * (ring + inner) + cyan[2] * zigzag,
  ];
}

function blinds(u: number, v: number): Rgb {
  // A window seen from inside: bright sky through horizontal slats, a dark
  // mullion cross and a darker frame. Stored as R8, so it is grayscale.
  const frame = Math.min(u, 1 - u, v * 0.5, (1 - v) * 0.5) < 0.03;
  const mullion = Math.abs(u - 0.5) < 0.012 || Math.abs(v - 0.5) < 0.02;
  if (frame || mullion) return [0.02, 0.02, 0.02];
  const slat = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * 11);
  const sky = 0.35 + 0.65 * (1 - v);
  const value = sky * smoothstep(0.25, 0.55, slat);
  return [value, value, value];
}

function rainbow(u: number, v: number): Rgb {
  const hue = hueToRgb(u * 0.85);
  const white = smoothstep(0.55, 1, v);
  return mixRgb(hue, [0.8, 0.8, 0.8], white);
}

export const GALLERY: Readonly<Record<GalleryImage, GalleryEntry>> = {
  'stained-glass': { width: 512, height: 256, encoding: 'rgba8unorm-srgb', paint: stainedGlass },
  sunset: { width: 384, height: 192, encoding: 'rgba16float', paint: sunset },
  'tv-bars': { width: 300, height: 170, encoding: 'bgra8unorm-srgb', paint: tvBars },
  neon: { width: 1024, height: 512, encoding: 'rgba8unorm-srgb', paint: neon },
  blinds: { width: 256, height: 128, encoding: 'r8unorm', paint: blinds },
  rainbow: { width: 128, height: 64, encoding: 'rgba32float', paint: rainbow },
};

function floatToHalf(value: number): number {
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 0x1f) return sign | 0x7c00;
  return sign | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}

const linearToSrgbByte = (value: number) => {
  const v = Math.min(1, Math.max(0, value));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
};
const linearByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

function paintLinear(entry: GalleryEntry): Float32Array {
  const pixels = new Float32Array(entry.width * entry.height * 3);
  for (let y = 0; y < entry.height; y++) {
    for (let x = 0; x < entry.width; x++) {
      const rgb = entry.paint((x + 0.5) / entry.width, (y + 0.5) / entry.height);
      pixels.set(rgb, (y * entry.width + x) * 3);
    }
  }
  return pixels;
}

function encode(pixels: Float32Array, count: number, encoding: SourceEncoding): Uint8Array {
  switch (encoding) {
    case 'rgba8unorm-srgb':
    case 'rgba8unorm':
    case 'bgra8unorm-srgb': {
      const toByte = encoding === 'rgba8unorm' ? linearByte : linearToSrgbByte;
      const swap = encoding === 'bgra8unorm-srgb';
      const out = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const r = toByte(pixels[i * 3] ?? 0);
        const g = toByte(pixels[i * 3 + 1] ?? 0);
        const b = toByte(pixels[i * 3 + 2] ?? 0);
        out.set(swap ? [b, g, r, 255] : [r, g, b, 255], i * 4);
      }
      return out;
    }
    case 'r8unorm': {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) out[i] = linearByte(pixels[i * 3] ?? 0);
      return out;
    }
    case 'rgba16float': {
      const out = new Uint16Array(count * 4);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = floatToHalf(pixels[i * 3 + c] ?? 0);
        out[i * 4 + 3] = floatToHalf(1);
      }
      return new Uint8Array(out.buffer);
    }
    case 'rgba32float': {
      const out = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        out.set([pixels[i * 3] ?? 0, pixels[i * 3 + 1] ?? 0, pixels[i * 3 + 2] ?? 0, 1], i * 4);
      }
      return new Uint8Array(out.buffer);
    }
  }
}

export interface GalleryTextures {
  /** The light's sourceTexture in the entry's own storage format. */
  readonly source: TextureAsset;
  /** An sRGB RGBA8 copy for the visible emitter quad's unlit material. */
  readonly display: TextureAsset;
  /** Linear mean RGB of the light image, clipped as the light slice sees it. */
  readonly mean: readonly [number, number, number];
}

function textureAsset(
  width: number,
  height: number,
  format: SourceEncoding,
  data: Uint8Array,
): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format,
    colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
    mips: { kind: 'none' },
    data,
  };
}

export function createGalleryTextures(image: GalleryImage): GalleryTextures {
  const entry = GALLERY[image];
  const count = entry.width * entry.height;
  const pixels = paintLinear(entry);
  const mean: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const gray = entry.encoding === 'r8unorm';
    for (let c = 0; c < 3; c++) {
      mean[c as 0 | 1 | 2] += Math.min(1, Math.max(0, pixels[i * 3 + (gray ? 0 : c)] ?? 0)) / count;
    }
  }
  return {
    source: textureAsset(entry.width, entry.height, entry.encoding, encode(pixels, count, entry.encoding)),
    display: textureAsset(
      entry.width,
      entry.height,
      'rgba8unorm-srgb',
      encode(pixels, count, 'rgba8unorm-srgb'),
    ),
    mean,
  };
}
