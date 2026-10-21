import { createTerrainGrids } from '@forgeax/engine-geometry';
import {
  type Asset,
  type MaterialAsset,
  ok,
  type Result,
  resolveMaterialAsset,
  TERRAIN_MATERIAL_PARAMETERS,
  type TerrainAsset,
  type TerrainError,
  type TerrainMaterialEncoding,
  type TerrainSource,
} from '@forgeax/engine-types';
import { cookTerrain } from './cook-terrain.js';
import { terrainDerivedGeometryValid } from './height-packing.js';
import { createTerrainLayerPlan, terrainLayerModes } from './layer-plan.js';

const controlSampler = {
  kind: 'sampler',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const;
function terrainPasses(encoding: TerrainMaterialEncoding): NonNullable<MaterialAsset['passes']> {
  const module =
    encoding.kind === 'ids' ? 'forgeax::standard-terrain-ids' : 'forgeax::standard-terrain';
  return [
    {
      name: 'forward',
      program: {
        module,
      },
      renderState: { tags: { LightMode: 'Forward' } },
    },
    {
      name: 'deferred',
      program: {
        module,
        fragmentEntry: 'fs_gbuffer',
      },
      renderState: { tags: { LightMode: 'Deferred' } },
    },
    {
      name: 'shadow-caster',
      program: {
        module: `${module}-shadow`,
      },
      renderState: { cullMode: 'none', tags: { LightMode: 'ShadowCaster' } },
    },
  ];
}

/**
 * Build an ordinary Pack output closure. The Pack owns stable GUID derivation;
 * this kernel never creates identities, opens files, compiles shaders or loads a device.
 */
export function buildTerrainAssets(
  source: TerrainSource,
  guid: (key: string) => string,
  assets: Readonly<Record<string, Asset>>,
  materialEncoding: TerrainMaterialEncoding = { kind: 'weights' },
): Result<Readonly<Record<string, Asset>>, TerrainError> {
  const cooked = cookTerrain(source, materialEncoding);
  if (!cooked.ok) return cooked;
  const outputs: Record<string, Asset> = {
      'control-sampler': controlSampler,
      height: cooked.value.height,
    },
    grids = createTerrainGrids(source.subsectionVertices);
  grids.forEach((mesh, i) => {
    outputs[`grid/${i}`] = mesh;
  });
  const active = new Set(cooked.value.sections.flatMap((section) => [...section.activeLayers]));
  const plan = createTerrainLayerPlan(source, assets, active);
  if (!plan.ok) return plan;
  for (const [si, section] of cooked.value.sections.entries()) {
    outputs[`section/${si}/weights`] = section.weights;
    const modes = terrainLayerModes(source, section.activeLayers);
    outputs[`section/${si}/material`] = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: TERRAIN_MATERIAL_PARAMETERS,
      values: {
        terrainSection: [
          section.x,
          section.z,
          (source.subsectionVertices - 1) * source.spacing,
          source.subsectionVertices,
        ],
        terrainLod: [
          0,
          0,
          (source.columns - 1) / (source.subsectionVertices - 1),
          (source.rows - 1) / (source.subsectionVertices - 1),
        ],
        terrainLayerModes: modes,
        terrainHeightTexture: guid('height'),
        terrainWeightTexture: {
          texture: guid(`section/${si}/weights`),
          sampler: guid('control-sampler'),
        },
        terrainLayerIndices: Array.from(
          { length: 4 },
          (_, index) => section.activeLayers[index] ?? -1,
        ),
      },
      passes: terrainPasses(materialEncoding),
    };
  }
  outputs.terrain = {
    ...source,
    kind: 'terrain',
    materialEncoding,
    heightRange: cooked.value.heightRange,
    grids: grids.map((_, i) => guid(`grid/${i}`)),
    sections: cooked.value.sections.map((section, i) => ({
      x: section.x,
      z: section.z,
      minHeight: section.minHeight,
      maxHeight: section.maxHeight,
      activeLayers: section.activeLayers,
      heightTexture: guid('height'),
      weightTexture: guid(`section/${i}/weights`),
      material: guid(`section/${i}/material`),
    })),
  } satisfies TerrainAsset;
  return ok(outputs);
}

/** Admit the same geometry and streamed Standard texels the producer cooks. */
export function terrainDerivedClosureValid(
  root: TerrainAsset,
  closure: ReadonlyMap<string, Asset>,
): boolean {
  if (!terrainDerivedGeometryValid(root, closure)) return false;
  const plan = createTerrainLayerPlan(
    root,
    Object.fromEntries(closure),
    new Set(root.sections.flatMap((section) => [...section.activeLayers])),
  );
  if (!plan.ok) return false;
  const table = Object.fromEntries(
    [...closure].filter((row): row is [string, MaterialAsset] => row[1].kind === 'material'),
  );
  const same = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (
      typeof a !== 'object' ||
      a === null ||
      typeof b !== 'object' ||
      b === null ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
    );
  };
  for (const section of root.sections) {
    const resolved = resolveMaterialAsset(String(section.material), table);
    if (!resolved.ok) return false;
    const material = resolved.value.asset;
    if (!same(material.passes, terrainPasses(root.materialEncoding))) return false;
    if (!same(material.parameters, TERRAIN_MATERIAL_PARAMETERS)) return false;
    const values = {
      ...Object.fromEntries(
        (material.parameters ?? []).flatMap((p) =>
          !('default' in p) || p.default === undefined ? [] : [[p.name, p.default]],
        ),
      ),
      ...material.values,
    };
    if (!same(values.terrainLayerModes, terrainLayerModes(root, section.activeLayers)))
      return false;
    const control = values.terrainWeightTexture;
    if (
      typeof control !== 'object' ||
      control === null ||
      Object.keys(control).length !== 2 ||
      !('texture' in control) ||
      control.texture !== section.weightTexture ||
      !('sampler' in control) ||
      (typeof control.sampler !== 'string' && typeof control.sampler !== 'number') ||
      !same(closure.get(String(control.sampler).toLowerCase()), controlSampler)
    )
      return false;
    if (
      !same(
        values.terrainLayerIndices,
        Array.from({ length: 4 }, (_, index) => section.activeLayers[index] ?? -1),
      )
    )
      return false;
  }
  return true;
}
