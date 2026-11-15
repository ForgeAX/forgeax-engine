import { halfFloat, rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { periodicPerlin, periodicWorley } from './texture-noise.ts';

export interface CloudTextureValues {
  readonly seed: number;
  readonly resolution: 'standard' | 'preview';
  readonly patternFrequency: number;
  readonly patternCoverage: number;
  readonly maskFrequency: number;
  readonly maskContrast: number;
  readonly profileBaseOffset: number;
  readonly profileThickness: number;
  readonly profileSoftness: number;
  readonly bodyFrequency: number;
  readonly bodyWorleyMix: number;
  readonly bodyDetail: number;
}

export const referenceTextureRecipe = {
  seed: 0x4e554245,
  dimensions: { pattern: 1024, mask: 1024, profile: 256, body: 128 },
  previewDimensions: { pattern: 256, mask: 256, profile: 128, body: 32 },
  colorSpace: 'linear',
} as const;

export type CloudTextureRole = keyof typeof referenceTextureRecipe.dimensions;
const saturate = (x: number) => Math.max(0, Math.min(1, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function layoutField(role: 'pattern' | 'mask', values: CloudTextureValues) {
  const stream = rng.create(values.seed).fork(role);
  const frequency = role === 'pattern' ? values.patternFrequency : values.maskFrequency;
  const lanes = Array.from({ length: 4 }, (_, channel) => {
    const lane = stream.fork(String(channel));
    const period = role === 'pattern' ? Math.max(2, Math.round(frequency * [0.5, 1, 2, 0.5][channel])) : frequency;
    return [1, 2, 4, 8].map((scale, i) => periodicPerlin(lane.fork(String(i)).seed, period * scale));
  });
  const warpX = periodicPerlin(stream.fork('warp-x').seed, Math.max(2, Math.round(frequency / 2)));
  const warpY = periodicPerlin(stream.fork('warp-y').seed, Math.max(2, Math.round(frequency / 2)));
  const fineX = periodicPerlin(stream.fork('fine-x').seed, frequency * 4);
  const fineY = periodicPerlin(stream.fork('fine-y').seed, frequency * 4);
  return (u: number, v: number, output: Float32Array, at: number) => {
    const warp = role === 'pattern' ? 1.8 / frequency : 0.8 / frequency;
    const broadX = u + warp * warpX(u, v, 0), broadY = v + warp * warpY(u, v, 0);
    const x = broadX + 0.3 / frequency * fineX(broadX, broadY, 0);
    const y = broadY + 0.3 / frequency * fineY(broadX, broadY, 0);
    for (let channel = 0; channel < 4; channel++) {
      const fields = lanes[channel];
      const f = 0.5 + 0.95 * (0.64 * fields[0](x, y, 0)
        + 0.21 * fields[1](x, y, 0) + 0.1 * fields[2](x, y, 0) + 0.05 * fields[3](x, y, 0));
      if (role === 'mask') {
        // A periodic regional footprint, with shared turbulence and independent type edges.
        const dx = Math.sin(Math.PI * (x - [0.46, 0.5, 0.54, 0.5][channel]));
        const dy = Math.sin(Math.PI * (y - [0.52, 0.46, 0.5, 0.5][channel]));
        const envelope = 1 - 1.1 * Math.sqrt(dx * dx + dy * dy);
        output[at + channel] = channel === 3 ? 0 : saturate(0.5 + values.maskContrast
          * (smooth(0, 0.9, envelope + 0.35 * (f - 0.5)) - 0.5));
      }
      else {
        const threshold = 0.69 - values.patternCoverage * 0.48 + [0.015, -0.045, -0.025, -0.025][channel];
        output[at + channel] = smooth(threshold, threshold + (channel === 2 ? 0.5 : 0.37), f);
      }
    }
  };
}

/** Periodic bilinear/trilinear reconstruction keeps authoring work tied to field bandwidth. */
function resampleGrid(grid: Float32Array, cells: number, size: number, volume: boolean,
  put: (at: number, value: number) => void): void {
  const coordinates = Array.from({ length: size }, (_, i) => {
    const p = (i + 0.5) * cells / size - 0.5;
    const lo = Math.floor(p);
    return { lo: (lo + cells) % cells, hi: (lo + 1) % cells, t: p - lo };
  });
  for (let z = 0; z < (volume ? size : 1); z++) {
    const az = volume ? coordinates[z] : { lo: 0, hi: 0, t: 0 };
    for (let y = 0; y < size; y++) {
      const ay = coordinates[y];
      const front0 = cells * (ay.lo + cells * az.lo), front1 = cells * (ay.hi + cells * az.lo);
      const back0 = cells * (ay.lo + cells * az.hi), back1 = cells * (ay.hi + cells * az.hi);
      for (let x = 0; x < size; x++) {
        const ax = coordinates[x], at = (x + size * (y + size * z)) * 4;
        for (let c = 0; c < 4; c++) {
          const front = mix(mix(grid[(ax.lo + front0) * 4 + c], grid[(ax.hi + front0) * 4 + c], ax.t),
            mix(grid[(ax.lo + front1) * 4 + c], grid[(ax.hi + front1) * 4 + c], ax.t), ay.t);
          const back = volume ? mix(mix(grid[(ax.lo + back0) * 4 + c], grid[(ax.hi + back0) * 4 + c], ax.t),
            mix(grid[(ax.lo + back1) * 4 + c], grid[(ax.hi + back1) * 4 + c], ax.t), ay.t) : front;
          put(at + c, mix(front, back, az.t));
        }
      }
    }
  }
}

/** Signed height-distance encoded around 0.5, as consumed by the canonical density kernel. */
export function profileValue(height: number, layout: number, channel: number, values: CloudTextureValues): number {
  const y = saturate(layout), root = Math.sqrt(y);
  const centers = [0.16 + 0.18 * y, 0.5 + 0.1 * y, 0.9, 0.76 - 0.26 * y];
  const peaks = [0.47 + 0.15 * root, 0.446 + 0.17 * root, 0.5 + 0.04 * y, 0.48 + 0.24 * y];
  const slopes = [0.4, 0.37 + 0.13 * root, 0.5, 0.35];
  const distance = (height - values.profileBaseOffset - centers[channel]) / values.profileThickness;
  const radius = values.profileSoftness * 0.2;
  return saturate(peaks[channel] - slopes[channel] * Math.sqrt(distance * distance + radius * radius));
}

/** Pure source generation: no UE pixels, filesystem, time, or unseeded randomness. */
export function referenceTexture(role: CloudTextureRole, values: CloudTextureValues): TextureAsset {
  const size = (values.resolution === 'preview'
    ? referenceTextureRecipe.previewDimensions : referenceTextureRecipe.dimensions)[role];
  const volume = role === 'body', unorm = role === 'mask';
  const data = new Uint8Array(size ** (volume ? 3 : 2) * 4 * (unorm ? 1 : 2));
  const output = new DataView(data.buffer);
  const put = (at: number, value: number) => {
    if (unorm) data[at] = Math.round(255 * saturate(value));
    else output.setUint16(at * 2, halfFloat.f32ToF16(role === 'body' ? value : saturate(value)), true);
  };
  if (role === 'pattern' || role === 'mask') {
    const sample = layoutField(role, values);
    const cells = Math.min(size, Math.max(256, (role === 'pattern' ? values.patternFrequency : values.maskFrequency) * 32));
    const grid = new Float32Array(cells * cells * 4);
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++)
      sample((x + 0.5) / cells, (y + 0.5) / cells, grid, (x + cells * y) * 4);
    resampleGrid(grid, cells, size, false, put);
  } else if (role === 'profile') {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++) put((x + size * y) * 4 + c,
        profileValue((x + 0.5) / size, (y + 0.5) / size, c, values));
  } else {
    const random = rng.create(values.seed).fork('body');
    const frequency = values.bodyFrequency;
    const band = (multiple: number) => Math.min(size / 2, frequency * multiple);
    const perlin = periodicPerlin(random.fork('perlin').seed, band(2));
    const detail = periodicPerlin(random.fork('detail').seed, band(4));
    const micro = periodicPerlin(random.fork('micro').seed, band(8));
    const warp = periodicPerlin(random.fork('warp').seed, band(1));
    const warpDetail = periodicPerlin(random.fork('warp-detail').seed, band(2));
    const cells = periodicWorley(random.fork('cells').seed, band(2));
    const fineCells = periodicWorley(random.fork('fine-cells').seed, band(4));
    const microCells = periodicWorley(random.fork('micro-cells').seed, band(8));
    const count = size;
    const grid = new Float32Array(count ** 3 * 4);
    for (let z = 0; z < count; z++) for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
      const u = (x + 0.5) / count, v = (y + 0.5) / count, w = (z + 0.5) / count;
      const p = perlin(u, v, w), fine = detail(u, v, w), grain = micro(u, v, w);
      const cellular = cells(u, v, w), small = fineCells(u, v, w), tiny = microCells(u, v, w);
      const body = mix(0.45 + 0.8 * p, 0.45 + 1.1 * (cellular - 0.48) + 0.3 * p, values.bodyWorleyMix);
      const at = (x + count * (y + count * z)) * 4;
      grid[at] = 0.534 + 0.52 * warp(u, v, w) + 0.16 * warpDetail(u, v, w) + 0.06 * grain;
      grid[at + 1] = body + values.bodyDetail * (0.24 * fine + 0.12 * grain + 0.3 * (small - 0.48));
      grid[at + 2] = 0.433 + 0.58 * fine + 0.22 * grain + values.bodyDetail * 0.8 * (small - 0.48);
      grid[at + 3] = 0.45 + 1.1 * (tiny - 0.48) + 0.1 * grain;
    }
    resampleGrid(grid, count, size, true, put);
  }
  return {
    kind: 'texture', format: unorm ? 'rgba8unorm' : 'rgba16float', colorSpace: 'linear', data,
    shape: volume ? { viewDimension: '3d', extent: { width: size, height: size, depth: size } }
      : { viewDimension: '2d', extent: { width: size, height: size } },
    mips: { kind: 'none' },
  };
}
