import {
  err,
  ok,
  type Result,
  type TerrainAsset,
  type TerrainError,
  type TerrainSource,
} from '@forgeax/engine-types';
import { terrainAxisEndpoint, terrainHeightBounds } from './height-bounds.js';

export function terrainFailure(
  code: TerrainError['code'],
  field: string,
  expected: string,
  actual?: unknown,
): Result<never, TerrainError> {
  return err({
    code,
    expected,
    hint: 'repair the terrain source before cooking or publication',
    detail: { field, actual },
  });
}

/** Validate bounded, finite, hole-free author input before allocating derived data. */
export function validateTerrain(source: TerrainSource): Result<TerrainSource, TerrainError> {
  if (source && 'holes' in source)
    return terrainFailure('terrain-input-invalid', 'holes', 'hole-free heightfield input');
  if (
    !source ||
    !Number.isSafeInteger(source.columns) ||
    !Number.isSafeInteger(source.rows) ||
    source.columns < 2 ||
    source.rows < 2 ||
    source.columns * source.rows > 4_194_304
  )
    return terrainFailure(
      'terrain-input-invalid',
      'dimensions',
      '2..4194304 finite samples in an integer rectangular grid',
    );
  const n = source.subsectionVertices;
  if (
    !Number.isInteger(n) ||
    n < 2 ||
    n > 128 ||
    (n & (n - 1)) !== 0 ||
    (source.columns - 1) % (n - 1) !== 0 ||
    (source.rows - 1) % (n - 1) !== 0
  )
    return terrainFailure(
      'terrain-input-invalid',
      'subsectionVertices',
      'power-of-two 2..128 vertices and complete subsections',
    );
  if (!Number.isFinite(source.spacing) || source.spacing <= 0)
    return terrainFailure(
      'terrain-input-invalid',
      'spacing',
      'positive finite sample spacing in metres',
    );
  if (
    [
      source.spacing,
      (source.columns - 1) * source.spacing,
      (source.rows - 1) * source.spacing,
      terrainAxisEndpoint((source.columns - n) * source.spacing, (n - 1) * source.spacing),
      terrainAxisEndpoint((source.rows - n) * source.spacing, (n - 1) * source.spacing),
    ].some((value) => !Number.isFinite(Math.fround(value)) || Math.fround(value) <= 0)
  )
    return terrainFailure(
      'terrain-input-invalid',
      'spacing',
      'positive sample spacing and X/Z extents representable as finite f32 metres',
    );
  if (
    !(source.heights instanceof Float32Array) ||
    source.heights.length !== source.columns * source.rows ||
    source.heights.some((h) => !Number.isFinite(h))
  )
    return terrainFailure(
      'terrain-input-invalid',
      'heights',
      'one finite f32 height per sample; holes and NaN are unsupported',
    );
  let min = Infinity,
    max = -Infinity;
  for (const height of source.heights) {
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  const span = Math.max(max - min, 1e-6);
  if (
    !Number.isFinite(Math.fround(span)) ||
    !(min + span > min) ||
    terrainHeightBounds(min, max, [min, min + span]).some(
      (value) => !Number.isFinite(Math.fround(value)),
    )
  )
    return terrainFailure(
      'terrain-input-invalid',
      'heightRange',
      'finite f32 height decode and conservative GPU bounds',
      { min, max, span },
    );
  if (!Array.isArray(source.layers) || source.layers.length < 1 || source.layers.length > 32)
    return terrainFailure('terrain-layer-invalid', 'layers', '1..32 ordered Standard layers');
  for (const layer of source.layers) {
    if (
      !layer ||
      typeof layer.material !== 'string' ||
      !layer.material ||
      !['weight', 'height', 'alpha'].includes(layer.blend)
    )
      return terrainFailure(
        'terrain-layer-invalid',
        'layers',
        'material GUID and closed weight/height/alpha blend',
      );
    if (
      layer.blend === 'height' &&
      (!layer.height ||
        !layer.heightRange ||
        layer.heightRange.length !== 2 ||
        !layer.heightRange.every(Number.isFinite) ||
        layer.heightRange[0] >= layer.heightRange[1])
    )
      return terrainFailure(
        'terrain-layer-invalid',
        'heightRange',
        'height texture GUID and ordered finite linear range',
      );
  }
  if (
    !(source.weights instanceof Float32Array) ||
    source.weights.length !== source.heights.length * source.layers.length ||
    source.weights.some((w) => !Number.isFinite(w) || w < 0 || w > 1)
  )
    return terrainFailure(
      'terrain-layer-invalid',
      'weights',
      'sample-major finite weights in [0,1] for every author layer',
    );
  const weighted = source.layers.flatMap((l, i) => (l.blend === 'alpha' ? [] : [i]));
  for (let s = 0; s < source.heights.length; s++) {
    let sum = 0;
    for (const i of weighted) sum += source.weights[s * source.layers.length + i] ?? 0;
    if (sum !== 0 && Math.abs(sum - 1) > 1e-5)
      return terrainFailure(
        'terrain-layer-invalid',
        'weights',
        'nonzero author weight group sums to one within 1e-5',
        { sample: s, sum },
      );
  }
  return ok(source);
}

/** Derived grid count and X-fast section roster are shared by every admission route. */
export function terrainDerivedLayoutValid(terrain: TerrainAsset): boolean {
  const n = terrain.subsectionVertices,
    nx = (terrain.columns - 1) / (n - 1);
  if (
    !terrain.materialEncoding ||
    !['weights', 'ids'].includes(terrain.materialEncoding.kind) ||
    (terrain.materialEncoding.kind === 'ids' &&
      (!Number.isFinite(terrain.materialEncoding.maxWeightError) ||
        terrain.materialEncoding.maxWeightError < 0 ||
        terrain.materialEncoding.maxWeightError > 1 ||
        terrain.layers.some((layer) => layer.blend !== 'weight'))) ||
    !Array.isArray(terrain.heightRange) ||
    terrain.heightRange.length !== 2 ||
    !terrain.heightRange.every(Number.isFinite) ||
    terrain.heightRange[1] <= terrain.heightRange[0] ||
    !Array.isArray(terrain.grids) ||
    terrain.grids.length !== Math.log2(n) ||
    !Array.isArray(terrain.sections) ||
    terrain.sections.length !== nx * ((terrain.rows - 1) / (n - 1))
  )
    return false;
  return terrain.sections.every(
    (section, i) =>
      section &&
      section.x === (i % nx) * (n - 1) * terrain.spacing &&
      section.z === Math.floor(i / nx) * (n - 1) * terrain.spacing &&
      Number.isFinite(section.minHeight) &&
      Number.isFinite(section.maxHeight) &&
      section.minHeight <= section.maxHeight &&
      Array.isArray(section.activeLayers) &&
      section.activeLayers.length <= (terrain.materialEncoding.kind === 'ids' ? 32 : 4) &&
      section.activeLayers.every(
        (layer: number, j: number) =>
          Number.isInteger(layer) &&
          layer >= 0 &&
          layer < terrain.layers.length &&
          (j === 0 || layer > (section.activeLayers[j - 1] ?? -1)),
      ),
  );
}
