import { terrainVertexCoordinates } from './lod.js';

/** Frozen geometry facts of one drawn subsection; packed bytes use the cooked mip order. */
export interface TerrainSurface {
  readonly vertices: number;
  readonly width: number;
  readonly lod: number;
  readonly neighbors: readonly number[];
  readonly heightRange: readonly [number, number];
  readonly heights: Uint8Array;
}

function height(surface: TerrainSurface, x: number, z: number, mip: number): number {
  let offset = 0,
    size = surface.vertices;
  for (let i = 0; i < mip; i++) {
    offset += size * size * 4;
    size /= 2;
  }
  const index = offset + (z * size + x) * 4;
  const f = Math.fround;
  const q = ((surface.heights[index] ?? 0) << 8) | (surface.heights[index + 1] ?? 0);
  const min = f(surface.heightRange[0]),
    max = f(surface.heightRange[1]);
  if (q === 0) return min;
  if (q === 65535) return max;
  const step = f(f(max - min) / 65535);
  return q <= 32767 ? f(min + f(q * step)) : f(max - f((65535 - q) * step));
}

/** Reconstruct the same two-mip XZ/height morph as the cooked vertex shader. */
export function terrainSurfaceVertex(
  surface: TerrainSurface,
  x: number,
  z: number,
  sectionOrigin: readonly [number, number] = [0, 0],
  translation: readonly [number, number, number] = [0, 0, 0],
): readonly [number, number, number] {
  const drawLod = Math.floor(surface.lod),
    n = surface.vertices / 2 ** drawLod;
  let lod = surface.lod;
  if (x === 0) lod = Math.max(lod, surface.neighbors[0] ?? lod);
  if (x === n - 1) lod = Math.max(lod, surface.neighbors[1] ?? lod);
  if (z === 0) lod = Math.max(lod, surface.neighbors[2] ?? lod);
  if (z === n - 1) lod = Math.max(lod, surface.neighbors[3] ?? lod);
  const p = terrainVertexCoordinates(x, z, surface.vertices, drawLod, lod),
    size = surface.vertices / 2 ** p.mip,
    nextSize = Math.max(2, size / 2);
  const h0 = height(
    surface,
    Math.round(p.currentX * (size - 1)),
    Math.round(p.currentZ * (size - 1)),
    p.mip,
  );
  const h1 = height(
    surface,
    Math.round(p.nextX * (nextSize - 1)),
    Math.round(p.nextZ * (nextSize - 1)),
    Math.min(p.mip + 1, Math.log2(surface.vertices) - 1),
  );
  const f = Math.fround;
  return [
    f(f(f(p.x * f(surface.width)) + f(sectionOrigin[0])) + f(translation[0])),
    f(f(f(h0 * f(1 - p.alpha)) + f(h1 * p.alpha)) + f(translation[1])),
    f(f(f(p.z * f(surface.width)) + f(sectionOrigin[1])) + f(translation[2])),
  ];
}

/** Canonical height on the submitted topology/mips/pose, subject to shader f32 arithmetic error. */
export function terrainSurfaceHeight(
  surface: TerrainSurface,
  x: number,
  z: number,
  sectionOrigin: readonly [number, number] = [0, 0],
  translation: readonly [number, number, number] = [0, 0, 0],
): number | undefined {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    x < Math.fround(Math.fround(sectionOrigin[0]) + Math.fround(translation[0])) ||
    z < Math.fround(Math.fround(sectionOrigin[1]) + Math.fround(translation[2])) ||
    x >
      Math.fround(
        Math.fround(Math.fround(surface.width) + Math.fround(sectionOrigin[0])) +
          Math.fround(translation[0]),
      ) ||
    z >
      Math.fround(
        Math.fround(Math.fround(surface.width) + Math.fround(sectionOrigin[1])) +
          Math.fround(translation[2]),
      )
  )
    return undefined;
  const n = surface.vertices / 2 ** Math.floor(surface.lod);
  const triangle = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
  ): number | undefined => {
    const ax = a[0] ?? 0,
      az = a[2] ?? 0,
      bx = b[0] ?? 0,
      bz = b[2] ?? 0,
      cx = c[0] ?? 0,
      cz = c[2] ?? 0;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (d === 0 || !Number.isFinite(d)) return undefined;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d,
      v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d,
      w = 1 - u - v;
    if (u < -1e-7 || v < -1e-7 || w < -1e-7) return undefined;
    return u * (a[1] ?? 0) + v * (b[1] ?? 0) + w * (c[1] ?? 0);
  };
  for (let iz = 0; iz < n - 1; iz++)
    for (let ix = 0; ix < n - 1; ix++) {
      const a = terrainSurfaceVertex(surface, ix, iz, sectionOrigin, translation),
        b = terrainSurfaceVertex(surface, ix + 1, iz, sectionOrigin, translation),
        c = terrainSurfaceVertex(surface, ix, iz + 1, sectionOrigin, translation),
        d = terrainSurfaceVertex(surface, ix + 1, iz + 1, sectionOrigin, translation);
      const h = triangle(a, c, b) ?? triangle(b, c, d);
      if (h !== undefined) return h;
    }
  return undefined;
}
