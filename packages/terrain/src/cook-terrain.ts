import {
  numMipLevels,
  ok,
  type Result,
  type TerrainAsset,
  type TerrainError,
  type TerrainMaterialEncoding,
  type TerrainSection,
  type TerrainSource,
  type TextureAsset,
} from '@forgeax/engine-types';
import { terrainHeightAtlas, terrainHeightMipOffset } from './height-atlas.js';
import { terrainSourceHeightRange } from './height-bounds.js';
import { terrainHeightTexel, terrainWeightTexel } from './height-packing.js';
import { cookTerrainIds } from './material-id.js';
import { terrainFailure, validateTerrain } from './validation.js';

export interface CookedTerrainSection
  extends Pick<TerrainSection, 'x' | 'z' | 'minHeight' | 'maxHeight' | 'activeLayers'> {
  readonly weights: TextureAsset;
}
export interface CookedTerrain extends Pick<TerrainAsset, 'heightRange'> {
  readonly height: TextureAsset;
  readonly sections: readonly CookedTerrainSection[];
}

/** Deterministic bounded derivation; stable identities are supplied by Pack, not this kernel. */
export function cookTerrain(
  source: TerrainSource,
  materialEncoding: TerrainMaterialEncoding = { kind: 'weights' },
): Result<CookedTerrain, TerrainError> {
  const checked = validateTerrain(source);
  if (!checked.ok) return checked;
  if (!materialEncoding || !['weights', 'ids'].includes(materialEncoding.kind))
    return terrainFailure('terrain-layer-invalid', 'materialEncoding', 'weights or budgeted IDs');
  const ids =
    materialEncoding.kind === 'ids'
      ? cookTerrainIds(source, materialEncoding.maxWeightError)
      : undefined;
  if (ids && !ids.ok) return ids;
  const { min, max } = terrainSourceHeightRange(source.heights);
  const n = source.subsectionVertices,
    quads = n - 1;
  const sections: CookedTerrainSection[] = [];
  const layerCount = source.layers.length;
  const atlas = terrainHeightAtlas(source);
  const height = new Uint8Array(
    terrainHeightMipOffset(atlas.width, atlas.height, numMipLevels({ width: n, height: n })),
  );
  for (let sz = 0; sz < (source.rows - 1) / quads; sz++)
    for (let sx = 0; sx < (source.columns - 1) / quads; sx++) {
      const active = new Set<number>();
      let low = Infinity,
        high = -Infinity;
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const sample = (sz * quads + z) * source.columns + sx * quads + x;
          const h = source.heights[sample] ?? 0;
          low = Math.min(low, h);
          high = Math.max(high, h);
          for (let l = 0; l < layerCount; l++)
            if ((source.weights[sample * layerCount + l] ?? 0) > 0) active.add(l);
        }
      // Height layers remain active even at zero author weight: UE's epsilon participates.
      for (let l = 0; l < layerCount; l++) if (source.layers[l]?.blend === 'height') active.add(l);
      const activeLayers = [...active].sort((a, b) => a - b);
      if (materialEncoding.kind === 'weights' && activeLayers.length > 4)
        return terrainFailure(
          'terrain-layer-budget-exceeded',
          'activeLayers',
          'at most four active Standard layers per subsection; no silent pruning',
          { sx, sz, layers: activeLayers },
        );
      let byteLength = 0;
      for (let size = n; size >= 1; size /= 2) byteLength += size * size * 4;
      const weights = ids?.ok ? ids.value[sections.length] : new Uint8Array(byteLength);
      if (weights === undefined)
        return terrainFailure(
          'terrain-layer-invalid',
          'materialEncoding',
          'complete ID section roster',
        );
      let offset = 0;
      for (let size = n; size >= 1; size /= 2) {
        for (let z = 0; z < size; z++)
          for (let x = 0; x < size; x++) {
            const fx = sx * quads + (size === 1 ? quads / 2 : (x * quads) / (size - 1));
            const fz = sz * quads + (size === 1 ? quads / 2 : (z * quads) / (size - 1));
            const i = offset + (z * size + x) * 4;
            const mip = Math.log2(n / size);
            const section = sections.length;
            const pixel =
              terrainHeightMipOffset(atlas.width, atlas.height, mip) +
              ((Math.floor(section / atlas.tileColumns) * size + z) * atlas.tileColumns * size +
                (section % atlas.tileColumns) * size +
                x) *
                4;
            height.set(terrainHeightTexel(source, fx, fz), pixel);
            if (!ids) weights.set(terrainWeightTexel(source, activeLayers, fx, fz), i);
          }
        offset += size * size * 4;
      }
      const texture = (data: Uint8Array): TextureAsset => ({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: n, height: n } },
        format: 'rgba8unorm',
        data,
        colorSpace: 'linear',
        mips: { kind: 'packed', levelCount: numMipLevels({ width: n, height: n }) },
      });
      sections.push({
        x: sx * quads * source.spacing,
        z: sz * quads * source.spacing,
        minHeight: low,
        maxHeight: high,
        activeLayers,
        weights: ids ? { ...texture(weights), mips: { kind: 'none' } } : texture(weights),
      });
    }
  return ok({
    heightRange: [min, max],
    height: {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: atlas.width, height: atlas.height } },
      format: 'rgba8unorm',
      data: height,
      colorSpace: 'linear',
      mips: { kind: 'packed', levelCount: numMipLevels({ width: n, height: n }) },
    },
    sections,
  });
}
