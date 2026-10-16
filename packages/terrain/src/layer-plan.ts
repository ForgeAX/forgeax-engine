import {
  type Asset,
  type MaterialAsset,
  materialValuesToLinearRuntime,
  ok,
  type Result,
  resolveMaterialAsset,
  srgbChannelToLinear,
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

/** IEEE binary16 storage; finite values outside its range are rejected by the producer. */
function half(value: number): number {
  const bytes = new Float32Array([value]),
    bits = new Uint32Array(bytes.buffer)[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000,
    e = ((bits >>> 23) & 255) - 127 + 15,
    m = bits & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | ((((m | 0x800000) >>> (1 - e)) + 0x1000) >>> 13);
  return sign | ((e << 10) + ((m + 0x1000) >>> 13));
}

/** Shared bounded Standard sampling plan. Admission compares texels without allocating arrays. */
export function createTerrainLayerPlan(
  source: TerrainSource,
  sectionCount: number,
  assets: Readonly<Record<string, Asset>>,
  arrayLayers = 4,
) {
  const table = Object.fromEntries(
    Object.entries(assets).filter(([, asset]) => asset.kind === 'material'),
  ) as Record<string, MaterialAsset>;
  const layers: MaterialAsset[] = [];
  for (const layer of source.layers) {
    const resolved = resolveMaterialAsset(layer.material, table);
    if (!resolved.ok)
      return terrainFailure(
        'terrain-layer-invalid',
        layer.material,
        'a fully resolved ordinary Standard material',
        resolved.error,
      );
    const resolvedMaterial = resolved.value.asset;
    const defaults = Object.fromEntries(
      (resolvedMaterial.parameters ?? []).flatMap((parameter) =>
        parameter.default === undefined || !supported.has(parameter.name)
          ? []
          : [[parameter.name, parameter.default] as const],
      ),
    );
    const material = { ...resolvedMaterial, values: { ...defaults, ...resolvedMaterial.values } };
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
        layer.material,
        'Standard base channels with the default Surface; arbitrary shaders cannot be baked',
      );
    if (Object.keys(resolvedMaterial.values ?? {}).some((name) => !supported.has(name)))
      return terrainFailure(
        'terrain-layer-invalid',
        layer.material,
        'base Standard channels only; unsupported physical or coordinate extensions are explicit errors',
      );
    const neutralDefaults = new Map(
      standardSurfaceParameters([]).map((parameter) => [parameter.name, parameter.default]),
    );
    for (const parameter of resolvedMaterial.parameters ?? []) {
      if (
        !supported.has(parameter.name) &&
        parameter.default !== undefined &&
        JSON.stringify(parameter.default) !== JSON.stringify(neutralDefaults.get(parameter.name))
      )
        return terrainFailure(
          'terrain-layer-invalid',
          parameter.name,
          'neutral defaults for unsupported Standard physical channels',
        );
    }
    for (const [name, value] of Object.entries(material.values)) {
      if (
        name.endsWith('Texture') &&
        value !== undefined &&
        terrainTextureGuid(value) === undefined
      )
        return terrainFailure(
          'terrain-layer-invalid',
          name,
          'GUID textures with default UV0, repeat addressing and linear filtering; custom texture coordinates or sampler bindings are unsupported by the foundation cooker',
        );
    }
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
        layer.material,
        'a linear height blend texture',
      );
    layers.push(material);
  }
  const texture = (value: unknown): TextureAsset | undefined => {
    const guid = terrainTextureGuid(value);
    if (guid === undefined) return undefined;
    const asset = assets[guid];
    return asset?.kind === 'texture' ? asset : undefined;
  };
  let extent = 1;
  for (const layer of source.layers) {
    const material = layers[source.layers.indexOf(layer)];
    for (const value of [
      ...Object.values(material?.values ?? {}),
      ...(layer.blend === 'height' ? [layer.height] : []),
    ])
      if (terrainTextureGuid(value) !== undefined) {
        const tex = texture(value);
        if (
          tex === undefined ||
          !['rgba8unorm', 'rgba8unorm-srgb'].includes(tex.format) ||
          tex.shape.viewDimension !== '2d' ||
          tex.data.length < tex.shape.extent.width * tex.shape.extent.height * 4
        )
          return terrainFailure(
            'terrain-layer-invalid',
            terrainTextureGuid(value) ?? 'texture',
            'resident uncompressed RGBA8 2D source textures for foundation cooking',
          );
        extent = Math.max(extent, tex.shape.extent.width, tex.shape.extent.height);
      }
  }
  if (sectionCount * extent * extent * 4 * 8 * arrayLayers > 128 * 1024 * 1024)
    return terrainFailure(
      'terrain-layer-budget-exceeded',
      'surface closure bytes',
      'at most 128 MiB of derived Standard layer arrays',
    );
  if (extent > 1024)
    return terrainFailure(
      'terrain-layer-budget-exceeded',
      'layer texture extent',
      'at most 1024 samples per axis for the bounded foundation closure',
    );
  const sample = (value: unknown, u: number, v: number, neutral: readonly number[]): number[] => {
    const tex = texture(value);
    if (!tex) return [...neutral];
    const { width, height } = tex.shape.extent;
    const x = Math.floor(u * width - 0.5),
      z = Math.floor(v * height - 0.5),
      a = u * width - 0.5 - x,
      b = v * height - 0.5 - z;
    const at = (ix: number, iz: number, c: number) => {
      const value =
        (tex.data[
          ((((iz % height) + height) % height) * width + (((ix % width) + width) % width)) * 4 + c
        ] ?? 0) / 255;
      return tex.colorSpace === 'srgb' && c < 3 ? srgbChannelToLinear(value) : value;
    };
    const result = [0, 1, 2, 3].map(
      (c) =>
        (at(x, z, c) * (1 - a) + at(x + 1, z, c) * a) * (1 - b) +
        (at(x, z + 1, c) * (1 - a) + at(x + 1, z + 1, c) * a) * b,
    );
    return result;
  };

  const writers = [...layers.map((_, i) => i), undefined].map((layerIndex) => {
    const index = layerIndex,
      layer = index === undefined ? undefined : source.layers[index],
      material = index === undefined ? undefined : layers[index];
    const defaults = Object.fromEntries(
      (material?.parameters ?? []).flatMap((parameter) =>
        parameter.default === undefined ? [] : [[parameter.name, parameter.default] as const],
      ),
    );
    const values = materialValuesToLinearRuntime(
      { ...defaults, ...material?.values },
      material?.parameters ?? [],
      material?.colorSpace,
    );
    const get = (name: string, fallback: number): number =>
      typeof values[name] === 'number' ? (values[name] as number) : fallback;
    const vector = (name: string, fallback: readonly number[]): readonly number[] =>
      Array.isArray(values[name]) ? (values[name] as number[]) : fallback;
    const base = vector('baseColor', [1, 1, 1, 1]),
      emission = vector('emissive', [0, 0, 0]),
      normalScale = vector('normalScale', [1, 1]);

    return (x: number, z: number): Result<readonly (readonly number[])[], TerrainError> => {
      const u = (x + 0.5) / extent,
        v = (z + 0.5) / extent;
      const color = sample(values.baseColorTexture, u, v, [1, 1, 1, 1]).map(
        (channel, c) => channel * (base[c] ?? 1),
      );
      const nh = sample(values.normalTexture, u, v, [0.5, 0.5, 1, 1]);
      let normal = [
        ((nh[0] ?? 0.5) * 2 - 1) * (normalScale[0] ?? 1),
        ((nh[1] ?? 0.5) * 2 - 1) * (normalScale[1] ?? 1),
        Math.sqrt(Math.max(0, 1 - ((nh[0] ?? 0.5) * 2 - 1) ** 2 - ((nh[1] ?? 0.5) * 2 - 1) ** 2)),
      ];
      const length = Math.hypot(...normal);
      normal = length > 0 ? normal.map((c) => c / length) : [0, 0, 1];
      const height =
        layer?.blend === 'height'
          ? ((sample(layer.height, u, v, [0, 0, 0, 0])[0] ?? 0) - layer.heightRange[0]) /
            (layer.heightRange[1] - layer.heightRange[0])
          : 0;
      const mr = sample(values.metallicRoughnessTexture, u, v, [1, 1, 1, 1]),
        ao = sample(values.occlusionTexture, u, v, [1, 1, 1, 1])[0] ?? 1;
      const orm = [
        1 + (ao - 1) * get('occlusionStrength', 1),
        (mr[1] ?? 1) * get('roughness', 0.5),
        (mr[2] ?? 1) * get('metallic', 0),
        0,
      ];
      const em = sample(values.emissiveTexture, u, v, [1, 1, 1, 1]).map(
        (channel, c) => channel * (emission[c] ?? 0) * get('emissiveIntensity', 0),
      );
      const channels = [color, [...normal, height], orm, em];

      const encoded: number[][] = [];
      for (const channel of channels) {
        const values: number[] = [];
        for (let c = 0; c < 4; c++) {
          const value = channel[c] ?? 0;
          if (!Number.isFinite(value) || Math.abs(value) > 65504)
            return terrainFailure(
              'terrain-layer-invalid',
              'channel',
              'finite binary16-compatible Standard channels',
            );
          values.push(half(value));
        }
        encoded.push(values);
      }
      return ok(encoded);
    };
  });
  return ok({
    extent,
    texel(layer: number | undefined, x: number, z: number) {
      const writer = writers[layer ?? layers.length];
      if (writer === undefined)
        return terrainFailure('terrain-layer-invalid', 'activeLayers', 'a source layer index');
      return writer(x, z);
    },
  });
}

export function terrainLayerModes(source: TerrainSource, active: readonly number[]): number[] {
  return Array.from({ length: 4 }, (_, slice) => {
    const layer = source.layers[active[slice] ?? -1];
    return layer === undefined ? 3 : layer.blend === 'height' ? 1 : layer.blend === 'alpha' ? 2 : 0;
  });
}
