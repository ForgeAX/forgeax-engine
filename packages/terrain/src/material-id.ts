import { ok, type Result, type TerrainError, type TerrainSource } from '@forgeax/engine-types';
import { terrainFailure } from './validation.js';

const DEFAULT = 255;

/** Author bilinear control, including the exact all-zero Standard default. */
function author(source: TerrainSource, x: number, z: number): number[] {
  const ix = Math.min(Math.floor(x), source.columns - 2);
  const iz = Math.min(Math.floor(z), source.rows - 2);
  const a = x - ix,
    b = z - iz;
  const weights = source.layers.map((_, layer) => {
    const at = (dx: number, dz: number) =>
      source.weights[((iz + dz) * source.columns + ix + dx) * source.layers.length + layer] ?? 0;
    return (at(0, 0) * (1 - a) + at(1, 0) * a) * (1 - b) + (at(0, 1) * (1 - a) + at(1, 1) * a) * b;
  });
  weights.push(weights.every((weight) => weight === 0) ? 1 : 0);
  return weights;
}

function encode(weights: readonly number[]): readonly number[] {
  const ranked = weights
    .map((weight, id) => ({ weight, id }))
    .sort((a, b) => b.weight - a.weight || a.id - b.id);
  const bottom = ranked[0],
    top = ranked[1];
  if (bottom === undefined) throw new Error('terrain ID control lost its author layers');
  const sum = bottom.weight + (top?.weight ?? 0);
  const blend = sum > 0 ? Math.round(((top?.weight ?? 0) / sum) * 65535) : 0;
  const id = (value: number) => (value === weights.length - 1 ? DEFAULT : value);
  return [
    id(bottom.id),
    blend === 0 ? id(bottom.id) : id(top?.id ?? bottom.id),
    blend >>> 8,
    blend & 255,
  ];
}

function decoded(bytes: Uint8Array, node: number, count: number): number[] {
  const result = Array<number>(count + 1).fill(0);
  const blend = (((bytes[node * 4 + 2] ?? 0) << 8) | (bytes[node * 4 + 3] ?? 0)) / 65535;
  const bottom = bytes[node * 4] ?? DEFAULT,
    top = bytes[node * 4 + 1] ?? DEFAULT;
  result[bottom === DEFAULT ? count : bottom] = 1 - blend;
  const topIndex = top === DEFAULT ? count : top;
  result[topIndex] = (result[topIndex] ?? 0) + blend;
  return result;
}

const distance = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, weight, i) => sum + Math.abs(weight - (b[i] ?? 0)), 0) / 2;

/**
 * RG = author layer IDs; BA = unsigned 16-bit top weight. No hardware filtering
 * of IDs. Repair only removes top IDs, so previously processed triangles remain valid.
 * All subsection edges are repaired once in a shared author-resolution control grid.
 */
export function cookTerrainIds(
  source: TerrainSource,
  maxWeightError: number,
): Result<readonly Uint8Array[], TerrainError> {
  if (!Number.isFinite(maxWeightError) || maxWeightError < 0 || maxWeightError > 1)
    return terrainFailure(
      'terrain-layer-invalid',
      'maxWeightError',
      'finite total-variation budget in [0,1]',
    );
  if (source.layers.some((layer) => layer.blend !== 'weight'))
    return terrainFailure(
      'terrain-layer-invalid',
      'materialEncoding',
      'ID specialization accepts pure weight layers; height and ordered alpha retain the ordinary Landscape route',
    );
  let zero = false,
    nonzero = false;
  for (let sample = 0; sample < source.heights.length; sample++) {
    let sum = 0;
    for (let l = 0; l < source.layers.length; l++)
      sum += source.weights[sample * source.layers.length + l] ?? 0;
    zero ||= sum === 0;
    nonzero ||= sum !== 0;
  }
  if (zero && nonzero)
    return terrainFailure(
      'terrain-layer-invalid',
      'weights',
      'uniformly normalized weight groups or an entirely zero default field; mixed zero coverage cannot be encoded by one blend weight',
    );

  const n = source.subsectionVertices,
    quads = n - 1;
  const nx = (source.columns - 1) / quads,
    nz = (source.rows - 1) / quads;
  const columns = source.columns,
    rows = source.rows;
  const sections = Array.from({ length: nx * nz }, () => new Uint8Array(n * n * 4));
  const point = (x: number, z: number) => author(source, x, z);
  const bytes = new Uint8Array(columns * rows * 4);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++) bytes.set(encode(point(x, z)), (z * columns + x) * 4);
  for (let z = 0; z < rows - 1; z++)
    for (let x = 0; x < columns - 1; x++) {
      const p = z * columns + x;
      for (const triangle of [
        [p, p + 1, p + columns],
        [p + columns + 1, p + columns, p + 1],
      ]) {
        const allowed = new Set(triangle.map((node) => bytes[node * 4] ?? DEFAULT));
        const candidates = triangle
          .map((node) => ({
            node,
            id: bytes[node * 4 + 1] ?? DEFAULT,
            weight: ((bytes[node * 4 + 2] ?? 0) << 8) | (bytes[node * 4 + 3] ?? 0),
          }))
          .sort((a, b) => b.weight - a.weight || a.id - b.id);
        for (const candidate of candidates)
          if (candidate.weight > 0 && allowed.size < 3) allowed.add(candidate.id);
        for (const candidate of candidates)
          if (!allowed.has(candidate.id)) {
            bytes[candidate.node * 4 + 1] = bytes[candidate.node * 4] ?? DEFAULT;
            bytes[candidate.node * 4 + 2] = 0;
            bytes[candidate.node * 4 + 3] = 0;
          }
      }
    }
  // Conservative whole-cell bound: interpolated corner error plus the
  // bilinear cross term. On either 10->01 triangle its factor is <=1/4.
  // This covers every point, rather than treating a sparse probe as a proof.
  let error = 0;
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++) {
      error = Math.max(
        error,
        distance(point(x, z), decoded(bytes, z * columns + x, source.layers.length)),
      );
      if (x + 1 < columns && z + 1 < rows) {
        const corners = [
          [x, z],
          [x + 1, z],
          [x, z + 1],
          [x + 1, z + 1],
        ];
        const weights = corners.map(([cx = 0, cz = 0]) => point(cx, cz));
        const cornerError = Math.max(
          ...corners.map(([cx = 0, cz = 0], i) =>
            distance(weights[i] ?? [], decoded(bytes, cz * columns + cx, source.layers.length)),
          ),
        );
        const cross =
          (weights[0] ?? []).reduce(
            (sum, value, l) =>
              sum +
              Math.abs(
                value - (weights[1]?.[l] ?? 0) - (weights[2]?.[l] ?? 0) + (weights[3]?.[l] ?? 0),
              ),
            0,
          ) / 2;
        const universal = Math.max(
          ...weights.map((row) => (1 + row.reduce((sum, value) => sum + value, 0)) / 2),
        );
        error = Math.max(error, Math.min(cornerError + cross / 4, universal));
      }
    }
  if (error > maxWeightError)
    return terrainFailure(
      'terrain-layer-budget-exceeded',
      'materialCompression',
      'every author-resolution cell fits the explicit total-variation budget, including layer removal, quantization and bilinear-to-triangle interpolation',
      { bound: error, budget: maxWeightError },
    );
  for (let sz = 0; sz < nz; sz++)
    for (let sx = 0; sx < nx; sx++)
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const from = (sz * quads + z) * columns + sx * quads + x;
          sections[sz * nx + sx]?.set(bytes.subarray(from * 4, from * 4 + 4), (z * n + x) * 4);
        }
  return ok(sections);
}
