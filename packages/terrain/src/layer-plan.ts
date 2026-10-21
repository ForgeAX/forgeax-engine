import {
  type Asset,
  type MaterialAsset,
  materialValuesToLinearRuntime,
  ok,
  type Result,
  resolveMaterialAsset,
  standardSurfaceParameters,
  type TerrainError,
  type TerrainSource,
  type TextureAsset,
} from '@forgeax/engine-types';
import { terrainTextureGuid } from './texture-binding.js';
import { terrainFailure } from './validation.js';

const supported = new Set([
  'baseColor',
  'metallic',
  'roughness',
  'emissive',
  'emissiveIntensity',
  'occlusionStrength',
  'normalScale',
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'emissiveTexture',
  'occlusionTexture',
]);

/** Shared scalar facts. Texture identities stay separate from material numbers. */
export interface TerrainMaterialChannels {
  readonly values: Float32Array;
  readonly textures: readonly (string | undefined)[];
}

export const TERRAIN_CHANNEL_TEXTURES = [
  'baseColorTexture',
  'normalTexture',
  'metallicRoughnessTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;

/** One material projection, reused by all Terrain layers that refer to it. */
export function terrainMaterialChannels(
  material: MaterialAsset,
): Result<TerrainMaterialChannels, TerrainError> {
  if (
    material.passes?.some(
      (pass) =>
        pass.program.module !== 'forgeax_material::standard' &&
        pass.program.module !== 'forgeax::default-standard-pbr' &&
        pass.program.module !== 'forgeax::default-shadow-caster',
    ) ||
    (material.surface?.module &&
      material.surface.module !== 'forgeax_material::default_standard_surface')
  )
    return terrainFailure(
      'terrain-layer-invalid',
      'material',
      'Standard base channels with the default Surface; arbitrary shaders cannot use the Terrain layer contract',
    );
  const neutralDefaults = new Map(
    standardSurfaceParameters([]).map((parameter) => [
      parameter.name,
      'default' in parameter ? parameter.default : undefined,
    ]),
  );
  if (
    Object.entries(material.values ?? {}).some(
      ([name, value]) =>
        !supported.has(name) && JSON.stringify(value) !== JSON.stringify(neutralDefaults.get(name)),
    )
  )
    return terrainFailure(
      'terrain-layer-invalid',
      'material',
      'base Standard channels only; unsupported physical or coordinate extensions are explicit errors',
    );
  for (const parameter of material.parameters ?? []) {
    if (
      !supported.has(parameter.name) &&
      'default' in parameter &&
      parameter.default !== undefined &&
      JSON.stringify(parameter.default) !== JSON.stringify(neutralDefaults.get(parameter.name))
    )
      return terrainFailure(
        'terrain-layer-invalid',
        parameter.name,
        'neutral defaults for unsupported Standard physical channels',
      );
  }
  for (const [name, value] of Object.entries(material.values ?? {})) {
    if (name.endsWith('Texture') && value !== undefined && terrainTextureGuid(value) === undefined)
      return terrainFailure(
        'terrain-layer-invalid',
        name,
        'GUID textures with default UV0, repeat addressing and linear filtering; custom texture coordinates or sampler bindings are unsupported by the foundation cooker',
      );
  }
  const defaults = Object.fromEntries(
    (material.parameters ?? []).flatMap((parameter) =>
      !('default' in parameter) || parameter.default === undefined
        ? []
        : [[parameter.name, parameter.default] as const],
    ),
  );
  const values = materialValuesToLinearRuntime(
    { ...defaults, ...material.values },
    material.parameters ?? [],
    material.colorSpace,
  );
  const scalar = (name: string, fallback: number) =>
    typeof values[name] === 'number' ? (values[name] as number) : fallback;
  const vector = (name: string, fallback: readonly number[]) =>
    Array.isArray(values[name]) ? (values[name] as number[]) : fallback;
  const base = vector('baseColor', [1, 1, 1, 1]);
  const emissive = vector('emissive', [0, 0, 0]);
  const normalScale = vector('normalScale', [1, 1]);
  const row = new Float32Array([
    base[0] ?? 1,
    base[1] ?? 1,
    base[2] ?? 1,
    base[3] ?? 1,
    ...[0, 1, 2].map((i) => (emissive[i] ?? 0) * scalar('emissiveIntensity', 0)),
    0,
    normalScale[0] ?? 1,
    normalScale[1] ?? 1,
    scalar('roughness', 0.5),
    scalar('metallic', 0),
    scalar('occlusionStrength', 1),
    0,
    0,
    0,
  ]);
  if (!row.every(Number.isFinite))
    return terrainFailure(
      'terrain-layer-invalid',
      'material channels',
      'finite f32 Standard channels',
    );
  return ok({
    values: row,
    textures: TERRAIN_CHANNEL_TEXTURES.map((name) => terrainTextureGuid(values[name])),
  });
}

/** Validate ordinary sources once; the Renderer samples shared original images. */
export function createTerrainLayerPlan(
  source: TerrainSource,
  assets: Readonly<Record<string, Asset>>,
  active: ReadonlySet<number>,
) {
  const table = Object.fromEntries(
    Object.entries(assets).filter(([, asset]) => asset.kind === 'material'),
  ) as Record<string, MaterialAsset>;
  const layers: TerrainMaterialChannels[] = [];
  for (const layer of source.layers) {
    const resolved = resolveMaterialAsset(String(layer.material), table);
    if (!resolved.ok)
      return terrainFailure(
        'terrain-layer-invalid',
        String(layer.material),
        'a fully resolved ordinary Standard material',
        resolved.error,
      );
    const resolvedMaterial = resolved.value.asset;
    const defaults = Object.fromEntries(
      (resolvedMaterial.parameters ?? []).flatMap((parameter) =>
        !('default' in parameter) ||
        parameter.default === undefined ||
        !supported.has(parameter.name)
          ? []
          : [[parameter.name, parameter.default] as const],
      ),
    );
    const material = { ...resolvedMaterial, values: { ...defaults, ...resolvedMaterial.values } };
    for (const name of ['normalTexture', 'metallicRoughnessTexture', 'occlusionTexture']) {
      const value = material.values?.[name];
      const guid = terrainTextureGuid(value);
      const data = guid === undefined ? undefined : assets[guid];
      if (data?.kind === 'texture' && data.colorSpace !== 'linear')
        return terrainFailure(
          'terrain-layer-invalid',
          name,
          'linear data textures for normal and ORM channels',
        );
    }
    const heightData = layer.blend === 'height' ? assets[layer.height] : undefined;
    if (heightData?.kind === 'texture' && heightData.colorSpace !== 'linear')
      return terrainFailure(
        'terrain-layer-invalid',
        String(layer.material),
        'a linear height blend texture',
      );
    const projected = terrainMaterialChannels(material);
    if (!projected.ok) return projected;
    layers.push(projected.value);
  }
  const textures = new Map<string, TextureAsset>();
  let bytes = 0;
  for (let index = 0; index < source.layers.length; index++) {
    const layer = source.layers[index];
    const channels = layers[index];
    if (layer === undefined || channels === undefined) continue;
    for (const reference of [
      ...channels.textures,
      ...(layer.blend === 'height' ? [String(layer.height)] : []),
    ]) {
      if (reference === undefined) continue;
      const texture = assets[reference];
      if (
        texture?.kind !== 'texture' ||
        !['rgba8unorm', 'rgba8unorm-srgb'].includes(texture.format) ||
        texture.shape.viewDimension !== '2d' ||
        (texture.encoding === undefined &&
          texture.data.length < texture.shape.extent.width * texture.shape.extent.height * 4)
      )
        return terrainFailure(
          'terrain-layer-invalid',
          reference,
          'resident RGBA8 2D source textures, including Image-admitted Basis/KTX2 content',
        );
      if (texture.shape.extent.width > 1024 || texture.shape.extent.height > 1024)
        return terrainFailure(
          'terrain-layer-budget-exceeded',
          reference,
          'at most 1024 samples per source image axis',
        );
      if (active.has(index) && !textures.has(reference)) {
        textures.set(reference, texture);
        bytes += texture.shape.extent.width * texture.shape.extent.height * 4;
      }
    }
  }
  if (bytes > 128 * 1024 * 1024)
    return terrainFailure(
      'terrain-layer-budget-exceeded',
      'layer source bytes',
      'at most 128 MiB of distinct active RGBA8 source images',
    );
  return ok({ layers, textures, bytes });
}

export function terrainLayerModes(source: TerrainSource, active: readonly number[]): number[] {
  return Array.from({ length: 4 }, (_, slice) => {
    const layer = source.layers[active[slice] ?? -1];
    return layer === undefined ? 3 : layer.blend === 'height' ? 1 : layer.blend === 'alpha' ? 2 : 0;
  });
}
