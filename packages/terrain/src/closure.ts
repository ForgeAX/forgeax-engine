import { createTerrainGrids } from '@forgeax/engine-geometry';
import {
  type Asset,
  type MaterialAsset,
  ok,
  type Result,
  resolveMaterialAsset,
  standardSurfaceParameters,
  type TerrainAsset,
  type TerrainError,
  type TerrainMaterialEncoding,
  type TerrainSource,
} from '@forgeax/engine-types';
import { cookTerrain } from './cook.js';
import { terrainDerivedGeometryValid } from './height-packing.js';
import { createTerrainLayerPlan, terrainLayerModes } from './layer-plan.js';
import { terrainTextureGuid } from './texture-binding.js';

const controlSampler = {
  kind: 'sampler',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const;
const arrayFields = [
  'terrainColorLayers',
  'terrainNormalHeightLayers',
  'terrainOrmLayers',
  'terrainEmissionLayers',
] as const;
const arraySourceKey = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
function terrainPasses(encoding: TerrainMaterialEncoding): NonNullable<MaterialAsset['passes']> {
  const surface =
    encoding.kind === 'ids'
      ? 'forgeax_material::terrain_id_surface'
      : 'forgeax_material::terrain_surface';
  return [
    {
      name: 'forward',
      program: {
        module: 'forgeax_material::standard',
        moduleSlots: { surface },
      },
      renderState: { tags: { LightMode: 'Forward' } },
    },
    {
      name: 'deferred',
      program: {
        module: 'forgeax_material::standard',
        fragmentEntry: 'fs_gbuffer',
        moduleSlots: { surface },
      },
      renderState: { tags: { LightMode: 'Deferred' } },
    },
    {
      name: 'shadow-caster',
      program: {
        module: 'forgeax::default-shadow-caster',
        moduleSlots: { surface },
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
    },
    grids = createTerrainGrids(source.subsectionVertices);
  grids.forEach((mesh, i) => {
    outputs[`grid/${i}`] = mesh;
  });
  const ids = materialEncoding.kind === 'ids';
  const arrayLayers = ids ? source.layers.length : 4;
  const plan = createTerrainLayerPlan(
    source,
    ids ? 1 : cooked.value.sections.length,
    assets,
    arrayLayers,
  );
  if (!plan.ok) return plan;
  const extent = plan.value.extent;
  for (const [si, section] of cooked.value.sections.entries()) {
    outputs[`section/${si}/height`] = section.height;
    outputs[`section/${si}/weights`] = section.weights;
    const arrayPrefix = ids ? 'layers' : `section/${si}`;
    if (!ids || si === 0) {
      const arrays = arrayFields.map(() => new Uint8Array(extent * extent * arrayLayers * 4 * 2));
      const views = arrays.map((data) => new DataView(data.buffer));
      for (let slice = 0; slice < arrayLayers; slice++)
        for (let z = 0; z < extent; z++)
          for (let x = 0; x < extent; x++) {
            const texel = plan.value.texel(ids ? slice : section.activeLayers[slice], x, z);
            if (!texel.ok) return texel;
            for (const [t, view] of views.entries())
              for (let c = 0; c < 4; c++)
                view.setUint16(
                  ((slice * extent * extent + z * extent + x) * 4 + c) * 2,
                  texel.value[t]?.[c] ?? 0,
                  true,
                );
          }
      for (const [t, field] of arrayFields.entries()) {
        const data = arrays[t];
        if (data === undefined) throw new Error('terrain array derivation lost a channel');
        outputs[`${arrayPrefix}/${arraySourceKey(field)}`] = {
          kind: 'texture',
          format: 'rgba16float',
          colorSpace: 'linear',
          shape: {
            viewDimension: '2d-array',
            extent: { width: extent, height: extent, layers: arrayLayers },
          },
          data,
          mips: { kind: 'none' },
        };
      }
    }
    const modes = terrainLayerModes(source, section.activeLayers);
    outputs[`section/${si}/material`] = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([
        { name: 'terrainHeightTexture', type: 'texture' },
        { name: 'terrainWeightTexture', type: 'texture' },
        ...arrayFields.map((name) => ({ name, type: 'texture_2d_array' as const })),
        {
          name: 'terrainSection',
          type: 'vec4',
          default: [
            section.x,
            section.z,
            (source.subsectionVertices - 1) * source.spacing,
            source.subsectionVertices,
          ],
        },
        {
          name: 'terrainLod',
          type: 'vec4',
          default: [0, 0, cooked.value.heightRange[0], cooked.value.heightRange[1]],
        },
        { name: 'terrainNeighbors', type: 'vec4', default: [0, 0, 0, 0] },
        { name: 'terrainShadowFamily', type: 'f32', default: 0 },
        { name: 'terrainLayerModes', type: 'vec4', default: modes },
      ]),
      values: {
        terrainHeightTexture: guid(`section/${si}/height`),
        terrainWeightTexture: {
          texture: guid(`section/${si}/weights`),
          sampler: guid('control-sampler'),
        },
        ...Object.fromEntries(
          arrayFields.map((name) => [name, guid(`${arrayPrefix}/${arraySourceKey(name)}`)]),
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
      heightTexture: guid(`section/${i}/height`),
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
  const ids = root.materialEncoding.kind === 'ids';
  const arrayLayers = ids ? root.layers.length : 4;
  const plan = createTerrainLayerPlan(
    root,
    ids ? 1 : root.sections.length,
    Object.fromEntries(closure),
    arrayLayers,
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
  const extent = plan.value.extent;
  const checkedArrays = new Set<string>();
  for (const section of root.sections) {
    const resolved = resolveMaterialAsset(section.material, table);
    if (!resolved.ok) return false;
    const material = resolved.value.asset;
    if (!same(material.passes, terrainPasses(root.materialEncoding))) return false;
    const values = {
      ...Object.fromEntries(
        (material.parameters ?? []).flatMap((p) =>
          p.default === undefined ? [] : [[p.name, p.default]],
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
      typeof control.sampler !== 'string' ||
      !same(closure.get(control.sampler.toLowerCase()), controlSampler)
    )
      return false;
    const arrays: (DataView | undefined)[] = [];
    const arrayGuids: string[] = [];
    for (const field of arrayFields) {
      const guid = terrainTextureGuid(values[field]);
      if (guid === undefined) return false;
      const asset = closure.get(guid.toLowerCase());
      if (
        asset?.kind !== 'texture' ||
        asset.format !== 'rgba16float' ||
        asset.colorSpace !== 'linear' ||
        asset.shape.viewDimension !== '2d-array' ||
        asset.shape.extent.width !== extent ||
        asset.shape.extent.height !== extent ||
        asset.shape.extent.layers !== arrayLayers ||
        asset.mips.kind !== 'none' ||
        asset.data.byteLength !== extent * extent * arrayLayers * 4 * 2
      )
        return false;
      const key = `${field}:${guid.toLowerCase()}`;
      arrayGuids.push(key);
      arrays.push(
        ids && checkedArrays.has(key)
          ? undefined
          : new DataView(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength),
      );
    }
    if (arrays.some((array) => array !== undefined))
      for (let slice = 0; slice < arrayLayers; slice++)
        for (let z = 0; z < extent; z++)
          for (let x = 0; x < extent; x++) {
            const texel = plan.value.texel(ids ? slice : section.activeLayers[slice], x, z);
            if (!texel.ok) return false;
            for (const [t, array] of arrays.entries())
              for (let c = 0; c < 4; c++)
                if (
                  array !== undefined &&
                  array.getUint16(
                    ((slice * extent * extent + z * extent + x) * 4 + c) * 2,
                    true,
                  ) !== texel.value[t]?.[c]
                )
                  return false;
          }
    for (const guid of arrayGuids) checkedArrays.add(guid);
  }
  return true;
}
