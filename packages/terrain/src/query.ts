import type { TerrainSource } from '@forgeax/engine-types';

/** The 10->01 diagonal is shared by mesh, gameplay queries and heightfield conversion. */
export function terrainHeight(source: TerrainSource, x: number, z: number): number | undefined {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    x < 0 ||
    z < 0 ||
    x > (source.columns - 1) * source.spacing ||
    z > (source.rows - 1) * source.spacing
  )
    return undefined;
  return terrainSampleHeight(
    source,
    Math.min(x / source.spacing, source.columns - 1),
    Math.min(z / source.spacing, source.rows - 1),
  );
}

/** Cook and closure admission sample author triangles without a metres round trip. */
export function terrainSampleHeight(
  source: TerrainSource,
  u: number,
  v: number,
): number | undefined {
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < 0 ||
    v < 0 ||
    u > source.columns - 1 ||
    v > source.rows - 1
  )
    return undefined;
  const ix = Math.min(Math.floor(u), source.columns - 2);
  const iz = Math.min(Math.floor(v), source.rows - 2);
  const a = u - ix;
  const b = v - iz;
  const at = (dx: number, dz: number) => source.heights[(iz + dz) * source.columns + ix + dx] ?? 0;
  const h00 = at(0, 0),
    h10 = at(1, 0),
    h01 = at(0, 1),
    h11 = at(1, 1);
  return Math.fround(
    a + b <= 1
      ? h00 + a * (h10 - h00) + b * (h01 - h00)
      : h11 + (1 - b) * (h10 - h11) + (1 - a) * (h01 - h11),
  );
}

/** Rapier's height matrix is Z-fast column-major, unlike author X-fast input. */
export function terrainHeightfield(source: TerrainSource): {
  readonly rows: number;
  readonly columns: number;
  readonly heights: Float32Array;
  readonly scale: readonly [number, number, number];
  readonly origin: readonly [number, number, number];
} {
  const heights = new Float32Array(source.heights.length);
  for (let z = 0; z < source.rows; z++)
    for (let x = 0; x < source.columns; x++)
      heights[x * source.rows + z] = source.heights[z * source.columns + x] ?? 0;
  const width = (source.columns - 1) * source.spacing,
    depth = (source.rows - 1) * source.spacing;
  return {
    rows: source.rows - 1,
    columns: source.columns - 1,
    heights,
    scale: [width, 1, depth],
    origin: [width / 2, 0, depth / 2],
  };
}
