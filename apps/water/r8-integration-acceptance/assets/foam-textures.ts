import { rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { COAST_SEED } from '../src/identity';

export const COAST_FOAM_TILING_M = 4.8;

export function coastFoamTextures(): Readonly<{ height: TextureAsset; normal: TextureAsset }> {
  const size = 512;
  const stream = rng.create(COAST_SEED).fork('porous-ocean-foam');
  const cells = [22, 93].map(count => ({
    count,
    points: Array.from({ length: count * count }, () => [
      stream.range(0.05, 0.95), stream.range(0.05, 0.95),
      stream.range(0.12, 0.65), stream.range(0.12, 0.62),
    ] as const),
  }));
  const smooth = (minimum: number, maximum: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
    return t * t * (3 - 2 * t);
  };
  const variation = [4, 9, 23].map(count => ({
    count, values: Array.from({ length: count * count }, () => stream.next()),
  }));
  const mottling = (u: number, v: number) => variation.reduce((sum, layer, index) => {
    const x = u * layer.count, y = v * layer.count;
    const ix = Math.floor(x), iy = Math.floor(y);
    const sx = smooth(0, 1, x - ix), sy = smooth(0, 1, y - iy);
    const at = (dx: number, dy: number) => layer.values[
      ((iy + dy + layer.count) % layer.count) * layer.count + (ix + dx + layer.count) % layer.count
    ]!;
    return sum + [0.55, 0.3, 0.15][index]! * (
      (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy)
      + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy
    );
  }, 0);
  const film = (u: number, v: number, layer: typeof cells[number]) => {
    const x = u * layer.count, y = v * layer.count;
    const ix = Math.floor(x), iy = Math.floor(y);
    let distance = Number.POSITIVE_INFINITY;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const gx = (ix + dx + layer.count) % layer.count;
        const gy = (iy + dy + layer.count) % layer.count;
        const point = layer.points[gy * layer.count + gx]!;
        distance = Math.min(distance, Math.hypot(
          (x - ix - dx - point[0]) / point[2],
          (y - iy - dy - point[1]) / point[3],
        ));
      }
    return smooth(0.64, 1.4, distance);
  };
  const heights = new Float32Array(size * size);
  const heightBytes = new Uint8Array(size * size * 4);
  const normalBytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Integer periods and wrapped feature cells preserve both image seams.
      const warpedU = u + 0.006 * Math.sin(2 * Math.PI * (7 * v + 0.3 * Math.sin(10 * Math.PI * u)));
      const warpedV = v + 0.007 * Math.sin(2 * Math.PI * (5 * u + 0.4 * Math.sin(14 * Math.PI * v)));
      const coarse = film(warpedU, warpedV, cells[0]!);
      const fine = film(warpedU, warpedV, cells[1]!);
      const height = Math.max(0, Math.min(1,
        0.035 + 0.9 * coarse * (0.72 + 0.28 * fine) * (0.38 + 0.85 * mottling(u, v))
        + 0.035 * Math.sin(2 * Math.PI * (113 * u + 89 * v))));
      const index = y * size + x;
      heights[index] = height;
      heightBytes.fill(Math.round(height * 255), index * 4, index * 4 + 3);
      heightBytes[index * 4 + 3] = 255;
    }
  const at = (x: number, y: number) => heights[((y + size) % size) * size + (x + size) % size]!;
  const heightScale = 0.004 * size / COAST_FOAM_TILING_M;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 0.5 * heightScale;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 0.5 * heightScale;
      const length = Math.hypot(nx, ny, 1), index = (y * size + x) * 4;
      normalBytes[index] = Math.round((0.5 + nx / length * 0.5) * 255);
      normalBytes[index + 1] = Math.round((0.5 + ny / length * 0.5) * 255);
      normalBytes[index + 2] = Math.round((0.5 + 0.5 / length) * 255);
      normalBytes[index + 3] = 255;
    }
  const texture = (data: Uint8Array): TextureAsset => ({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    data,
    mips: { kind: 'generate' },
  });
  return { height: texture(heightBytes), normal: texture(normalBytes) };
}
