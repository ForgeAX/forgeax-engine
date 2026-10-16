import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type Asset,
  type MaterialAsset,
  standardMaterialParameters,
  standardSurfaceParameters,
  type TerrainAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { makeLoadContext } from '../registry/load-by-guid.js';

it.each([
  'heightTexture',
  'weightTexture',
] as const)('rejects a partial same-GUID %s rewrite before first rendering', (field) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000001'),
    guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const layer = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: [1, 1, 1, 1] },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  } as Asset;
  const outputs = buildTerrainAssets(
    {
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array([0, 0, 0, 1]),
      weights: new Float32Array(4).fill(1),
      layers: [{ material: guid('layer'), blend: 'weight' }],
    },
    guid,
    { [guid('layer')]: layer },
  ).unwrap();
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.catalog(guid('layer'), layer).unwrap();
  for (const [key, asset] of Object.entries(outputs)) registry.catalog(guid(key), asset).unwrap();
  const root = defined(registry.lookup<TerrainAsset>(guid('terrain')));
  expect(registry.terrainClosureCurrent(root)).toBe(true);
  const texture = defined(registry.lookup<TextureAsset>(defined(root.sections[0])[field]));
  registry
    .catalog(defined(root.sections[0])[field], {
      ...texture,
      data: new Uint8Array(texture.data).fill(255),
    })
    .unwrap();
  expect(registry.lookup(guid('terrain'))).toBe(root);
  expect(registry.terrainClosureCurrent(root)).toBe(false);
  // A new root may only acquire its own complete closure. The old root stays unavailable.
  expect(registry.catalog(guid('terrain'), { ...root }).ok).toBe(false);
  expect(registry.lookup(guid('terrain'))).toBe(root);
  expect(registry.terrainClosureCurrent(root)).toBe(false);
});

it.each([
  'terrainColorLayers',
  'terrainNormalHeightLayers',
  'terrainOrmLayers',
  'terrainEmissionLayers',
  'mode-default',
  'mode-value',
  'control-sampler',
  'array-sampler',
] as const)('rejects an author-incoherent derived surface rewrite: %s', (mutation) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000002'),
    guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const layer: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: [0.2, 0.4, 0.7, 1] },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const outputs = buildTerrainAssets(
    {
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array([0, 0, 0, 1]),
      weights: new Float32Array(4).fill(1),
      layers: [{ material: guid('layer'), blend: 'weight' }],
    },
    guid,
    { [guid('layer')]: layer },
  ).unwrap();
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.catalog(guid('layer'), layer).unwrap();
  for (const [key, asset] of Object.entries(outputs)) registry.catalog(guid(key), asset).unwrap();
  const root = defined(registry.lookup<TerrainAsset>(guid('terrain'))),
    section = defined(root.sections[0]),
    material = defined(registry.lookup<MaterialAsset>(section.material));
  expect(registry.terrainClosureCurrent(root)).toBe(true);
  if (mutation === 'mode-default')
    registry
      .catalog(section.material, {
        ...material,
        parameters: material.parameters?.map((p) =>
          p.name === 'terrainLayerModes' ? { ...p, default: [2, 3, 3, 3] } : p,
        ),
      })
      .unwrap();
  else if (mutation === 'mode-value')
    registry
      .catalog(section.material, {
        ...material,
        values: { ...material.values, terrainLayerModes: [2, 3, 3, 3] },
      })
      .unwrap();
  else if (mutation === 'control-sampler')
    registry
      .catalog(guid('control-sampler'), {
        ...outputs['control-sampler'],
        kind: 'sampler',
        magFilter: 'nearest',
      } as Asset)
      .unwrap();
  else if (mutation === 'array-sampler')
    registry
      .catalog(section.material, {
        ...material,
        values: {
          ...material.values,
          terrainColorLayers: {
            texture: guid('section/0/terrain-color-layers'),
            sampler: guid('control-sampler'),
          },
        },
      })
      .unwrap();
  else {
    const textureGuid = material.values?.[mutation];
    expect(typeof textureGuid).toBe('string');
    const texture = defined(registry.lookup<TextureAsset>(textureGuid as string)),
      data = new Uint8Array(texture.data);
    data[0] = (data[0] ?? 0) ^ 1;
    registry.catalog(textureGuid as string, { ...texture, data }).unwrap();
  }
  expect(registry.terrainClosureCurrent(root)).toBe(false);
  expect(registry.catalog(guid('terrain'), { ...root }).ok).toBe(false);
  expect(registry.lookup(guid('terrain'))).toBe(root);
});

it.each([
  false,
  true,
])('admits the ordinary JSON material-ref projection for a complete terrain (textured=%s)', (textured) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000003');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    mips: { kind: 'none' },
    data: new Uint8Array([64, 128, 192, 255]),
  };
  const layer: MaterialAsset = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters(
      textured ? standardMaterialParameters(new Set(['baseColorTexture'])) : [],
    ),
    values: {
      baseColor: [0.2, 0.4, 0.7, 1],
      ...(textured ? { baseColorTexture: guid('texture') } : {}),
    },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const derived = buildTerrainAssets(
    {
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array([0, 0, 0, 1]),
      weights: new Float32Array(4).fill(1),
      layers: [{ material: guid('layer'), blend: 'weight' }],
    },
    guid,
    { [guid('layer')]: layer, [guid('texture')]: texture },
  ).unwrap();
  const outputs: Record<string, Asset> = { texture, layer, ...derived };
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const kinds = new Map(Object.entries(outputs).map(([key, asset]) => [guid(key), asset.kind]));
  for (const [key, asset] of Object.entries(outputs)) {
    if (asset.kind !== 'material') {
      if (asset.kind !== 'terrain') registry.catalog(guid(key), asset).unwrap();
      continue;
    }
    const refs: string[] = [];
    const wire = (value: unknown): unknown => {
      if (typeof value === 'string' && ['texture', 'sampler'].includes(kinds.get(value) ?? '')) {
        let index = refs.indexOf(value);
        if (index < 0) {
          index = refs.length;
          refs.push(value);
        }
        return index;
      }
      if (Array.isArray(value)) return value.map(wire);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]));
      return value;
    };
    const payload = JSON.parse(JSON.stringify({ ...asset, values: wire(asset.values) })) as Record<
      string,
      unknown
    >;
    const loaded = defined(
      defined(registry.loaders.get('material')).load(payload, refs, makeLoadContext(registry)),
    );
    registry.catalog(guid(key), loaded).unwrap();
  }
  const root = registry.catalog(guid('terrain'), defined(outputs.terrain)).unwrap() as TerrainAsset;
  expect(registry.terrainClosureCurrent(root)).toBe(true);
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

it.each([
  'shift',
  'drop',
  'reverse',
] as const)('rejects a noncanonical derived section roster through catalog: %s', (mutation) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000008');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const layer: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: [1, 1, 1, 1] },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const outputs = buildTerrainAssets(
    {
      columns: 3,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: new Float32Array(6),
      weights: new Float32Array(6).fill(1),
      layers: [{ material: guid('layer'), blend: 'weight' }],
    },
    guid,
    { [guid('layer')]: layer },
  ).unwrap();
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.catalog(guid('layer'), layer).unwrap();
  for (const [key, asset] of Object.entries(outputs)) registry.catalog(guid(key), asset).unwrap();
  const root = defined(registry.lookup<TerrainAsset>(guid('terrain')));
  const sections =
    mutation === 'shift'
      ? root.sections.map((section, i) => (i === 1 ? { ...section, x: 1.1 } : section))
      : mutation === 'drop'
        ? root.sections.slice(0, -1)
        : [...root.sections].reverse();
  expect(registry.catalog(guid('terrain'), { ...root, sections }).ok).toBe(false);
  expect(registry.lookup(guid('terrain'))).toBe(root);
  expect(registry.terrainClosureCurrent(root)).toBe(true);
});
