import { AssetGuid, definePack } from '@forgeax/engine-pack/source';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  ok,
  standardSurfaceParameters,
  type Asset,
  type MaterialAsset,
  type TerrainSource,
  type TextureAsset,
} from '@forgeax/engine-types';
import { packageId } from '../src/identity.ts';

// Real dev HMR probes replace this constant and restore the exact source bytes.
const HEIGHT_OFFSET = 0;
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const material = (color: readonly number[], roughness: number): MaterialAsset => ({
  kind: 'material',
  colorSpace: 'linear',
  parameters: standardSurfaceParameters([]),
  values: { baseColor: color, roughness },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
});
const linearHeight: TextureAsset = {
  kind: 'texture',
  format: 'rgba8unorm',
  colorSpace: 'linear',
  shape: { viewDimension: '2d', extent: { width: 16, height: 16 } },
  mips: { kind: 'none' },
  data: Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) =>
    i % 4 === 3
      ? 255
      : Math.round(
          (0.5 + 0.4 * Math.sin(Math.floor(i / 4) % 16) * Math.cos(Math.floor(i / 64))) * 255,
        ),
  ),
};
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  name: 'Landscape terrain foundation',
  build: () => {
    const columns = 125,
      rows = 125,
      heights = new Float32Array(columns * rows),
      weights = new Float32Array(columns * rows * 3);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const i = z * columns + x;
        const h =
          13 * Math.sin(x * 0.049) * Math.cos(z * 0.044) +
          8 * Math.exp(-((x - 85) ** 2 + (z - 43) ** 2) / 300) +
          2 * Math.sin(x * 0.31) * Math.sin(z * 0.28);
        heights[i] = h + HEIGHT_OFFSET;
        const rock = Math.min(0.95, Math.max(0, (h - 1) / 16));
        weights[i * 3] = 1 - rock;
        weights[i * 3 + 1] = rock;
        const road = Math.abs(z - 62 - 9 * Math.sin(x * 0.035));
        weights[i * 3 + 2] = Math.max(0, Math.min(0.95, (4 - road) / 2));
      }
    const authors: Record<string, Asset> = {
      'layer/grass': material([0.1, 0.29, 0.055, 1], 0.9),
      'layer/rock': material([0.36, 0.29, 0.22, 1], 0.8),
      'layer/road': material([0.23, 0.12, 0.045, 1], 0.96),
      'layer/height': linearHeight,
    };
    const source: TerrainSource = {
      columns,
      rows,
      spacing: 1,
      subsectionVertices: 32,
      heights,
      weights,
      layers: [
        { material: guid('layer/grass'), blend: 'weight' },
        {
          material: guid('layer/rock'),
          blend: 'height',
          height: guid('layer/height'),
          heightRange: [0, 1],
        },
        { material: guid('layer/road'), blend: 'alpha' },
      ],
    };
    const built = buildTerrainAssets(
      source,
      guid,
      Object.fromEntries(Object.entries(authors).map(([key, value]) => [guid(key), value])),
    );
    return built.ok ? ok({ ...authors, ...built.value }) : built;
  },
});
