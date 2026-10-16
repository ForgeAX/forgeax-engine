import { AssetGuid, definePack } from '@forgeax/engine-pack/source';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  ok,
  standardSurfaceParameters,
  type Asset,
  type MaterialAsset,
  type TerrainSource,
} from '@forgeax/engine-types';
import { materialPackageId } from '../src/identity.ts';

const guid = (key: string) => AssetGuid.format(AssetGuid.derive(materialPackageId, key));
export default definePack({
  schemaVersion: '2.0.0',
  packageId: materialPackageId,
  name: 'Terrain material specialization pair',
  build: () => {
    const columns = 127,
      rows = 127;
    const heights = new Float32Array(columns * rows),
      weights = new Float32Array(columns * rows * 4);
    for (let z = 0; z < rows; z++)
      for (let x = 0; x < columns; x++) {
        const i = z * columns + x;
        heights[i] =
          13 * Math.sin(x * 0.049) * Math.cos(z * 0.044) +
          8 * Math.exp(-((x - 85) ** 2 + (z - 43) ** 2) / 300) +
          2 * Math.sin(x * 0.31) * Math.sin(z * 0.28);
        const t = (x / (columns - 1)) * 3,
          bottom = Math.min(2, Math.floor(t));
        weights[i * 4 + bottom] = 1 - (t - bottom);
        weights[i * 4 + bottom + 1] = t - bottom;
      }
    const colors = [
      [0.1, 0.29, 0.055, 1],
      [0.36, 0.29, 0.22, 1],
      [0.23, 0.12, 0.045, 1],
      [0.5, 0.45, 0.3, 1],
    ];
    const authors: Record<string, Asset> = {};
    for (const [i, color] of colors.entries()) {
      authors[`texture/${i}`] = {
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 64, height: 64 } },
        mips: { kind: 'none' },
        data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, c) =>
          c % 4 === 3
            ? 255
            : Math.round(
                (color[c % 4] ?? 0) *
                  (0.88 +
                    0.12 *
                      Math.sin((Math.floor(c / 4) % 64) * 0.9) *
                      Math.cos(Math.floor(c / 256) * 0.6)) *
                  255,
              ),
        ),
      };
      authors[`layer/${i}`] = {
        kind: 'material',
        colorSpace: 'linear',
        parameters: standardSurfaceParameters([{ name: 'baseColorTexture', type: 'texture' }]),
        values: { baseColor: [1, 1, 1, 1], baseColorTexture: guid(`texture/${i}`), roughness: 0.9 },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
      } satisfies MaterialAsset;
    }
    const source: TerrainSource = {
      columns,
      rows,
      spacing: 1,
      subsectionVertices: 64,
      heights,
      weights,
      layers: colors.map((_, i) => ({ material: guid(`layer/${i}`), blend: 'weight' })),
    };
    const assets = Object.fromEntries(
      Object.entries(authors).map(([key, value]) => [guid(key), value]),
    );
    const outputs: Record<string, Asset> = { ...authors };
    outputs['static-caster-material'] = {
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [0.5, 0.5, 0.5, 1], roughness: 1 },
      surface: { model: 'standard', module: 'forgeax_material::default_standard_surface' },
      passes: [
        { name: 'forward', program: { module: 'forgeax_material::standard' } },
        { name: 'shadow-caster', program: { module: 'forgeax::default-shadow-caster' } },
      ],
    } satisfies MaterialAsset;
    for (const kind of ['weights', 'ids'] as const) {
      const built = buildTerrainAssets(
        source,
        (key) => guid(`${kind}/${key}`),
        assets,
        kind === 'ids' ? { kind, maxWeightError: 0.001 } : { kind },
      );
      if (!built.ok) return built;
      for (const [key, value] of Object.entries(built.value)) outputs[`${kind}/${key}`] = value;
    }
    return ok(outputs);
  },
});
