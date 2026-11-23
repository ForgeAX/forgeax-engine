import { createTerrainGrids } from '@forgeax/engine-geometry';
import {
  type Asset,
  type MaterialAsset,
  ok,
  type Result,
  resolveMaterialAsset,
  TERRAIN_MATERIAL_PARAMETERS,
  TERRAIN_WEIGHT_DETAIL_PARAMETERS,
  type TerrainAsset,
  type TerrainError,
  type TerrainMaterialEncoding,
  type TerrainSource,
} from '@forgeax/engine-types';
import { cookTerrain } from './cook-terrain.js';
import { terrainDerivedGeometryValid } from './height-packing.js';
import { createTerrainLayerPlan, terrainLayerModes } from './layer-plan.js';
import { terrainFailure } from './validation.js';

const controlSampler = {
  kind: 'sampler',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const;
const detailSampler = {
  ...controlSampler,
  addressModeU: 'repeat',
  addressModeV: 'repeat',
} as const;

function validWeightDetailTexture(asset: Asset | undefined): boolean {
  return (
    (asset?.kind === 'gpu-texture' || asset?.kind === 'texture') &&
    asset.shape.viewDimension === '2d' &&
    asset.format === 'rgba8unorm' &&
    asset.colorSpace === 'linear'
  );
}

function terrainPasses(
  encoding: TerrainMaterialEncoding,
  hasDetail: boolean,
): NonNullable<MaterialAsset['passes']> {
  const suffix = encoding.kind === 'ids' ? '-ids' : hasDetail ? '-detail' : '';
  const module = `forgeax::standard-terrain${suffix}`;
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
  const detail = source.weightDetail;
  if (detail !== undefined && !validWeightDetailTexture(assets[detail.texture]))
    return terrainFailure(
      'terrain-layer-invalid',
      'weightDetail.texture',
      'a linear RGBA8 2D texture in the Terrain dependency closure',
    );
  const outputs: Record<string, Asset> = {
      'control-sampler': controlSampler,
      ...(detail === undefined ? {} : { 'weight-detail-sampler': detailSampler }),
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
      parameters:
        detail === undefined ? TERRAIN_MATERIAL_PARAMETERS : TERRAIN_WEIGHT_DETAIL_PARAMETERS,
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
        ...(detail === undefined
          ? {}
          : {
              terrainWeightDetail: {
                texture: detail.texture,
                sampler: guid('weight-detail-sampler'),
              },
              terrainWeightDetailParams: [1 / detail.period, detail.strength],
            }),
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
      passes: terrainPasses(materialEncoding, detail !== undefined),
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

function sameTerrainValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameTerrainValue(left[key], right[key]))
  );
}

function weightDetailBindingValid(
  detail: NonNullable<TerrainAsset['weightDetail']>,
  values: NonNullable<MaterialAsset['values']>,
  closure: ReadonlyMap<string, Asset>,
): boolean {
  const bound = values.terrainWeightDetail;
  return (
    typeof bound === 'object' &&
    bound !== null &&
    Object.keys(bound).length === 2 &&
    'texture' in bound &&
    bound.texture === detail.texture &&
    'sampler' in bound &&
    sameTerrainValue(closure.get(String(bound.sampler).toLowerCase()), detailSampler) &&
    sameTerrainValue(values.terrainWeightDetailParams, [1 / detail.period, detail.strength])
  );
}

function weightControlBindingValid(
  control: unknown,
  weightTexture: TerrainAsset['sections'][number]['weightTexture'],
  closure: ReadonlyMap<string, Asset>,
): boolean {
  return (
    typeof control === 'object' &&
    control !== null &&
    Object.keys(control).length === 2 &&
    'texture' in control &&
    control.texture === weightTexture &&
    'sampler' in control &&
    (typeof control.sampler === 'string' || typeof control.sampler === 'number') &&
    sameTerrainValue(closure.get(String(control.sampler).toLowerCase()), controlSampler)
  );
}

function terrainSectionMaterialValid(
  root: TerrainAsset,
  section: TerrainAsset['sections'][number],
  material: MaterialAsset,
  closure: ReadonlyMap<string, Asset>,
): boolean {
  const detail = root.weightDetail;
  const parameters =
    detail === undefined ? TERRAIN_MATERIAL_PARAMETERS : TERRAIN_WEIGHT_DETAIL_PARAMETERS;
  if (
    !sameTerrainValue(
      material.passes,
      terrainPasses(root.materialEncoding, detail !== undefined),
    ) ||
    !sameTerrainValue(material.parameters, parameters)
  )
    return false;
  const values = {
    ...Object.fromEntries(
      (material.parameters ?? []).flatMap((p) =>
        !('default' in p) || p.default === undefined ? [] : [[p.name, p.default]],
      ),
    ),
    ...material.values,
  };
  return (
    sameTerrainValue(values.terrainLayerModes, terrainLayerModes(root, section.activeLayers)) &&
    (detail === undefined || weightDetailBindingValid(detail, values, closure)) &&
    weightControlBindingValid(values.terrainWeightTexture, section.weightTexture, closure) &&
    sameTerrainValue(
      values.terrainLayerIndices,
      Array.from({ length: 4 }, (_, index) => section.activeLayers[index] ?? -1),
    )
  );
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
  const detail = root.weightDetail;
  if (detail !== undefined && !validWeightDetailTexture(closure.get(String(detail.texture))))
    return false;
  const table = Object.fromEntries(
    [...closure].filter((row): row is [string, MaterialAsset] => row[1].kind === 'material'),
  );
  return root.sections.every((section) => {
    const resolved = resolveMaterialAsset(String(section.material), table);
    return resolved.ok && terrainSectionMaterialValid(root, section, resolved.value.asset, closure);
  });
}
