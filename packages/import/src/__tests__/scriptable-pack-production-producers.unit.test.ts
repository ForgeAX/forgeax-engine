import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackSceneComponent } from '@forgeax/engine-pack/source';
import { createTextureGeneratorPackCooker } from '@forgeax/engine-shader-compiler';
import type {
  AnimationClip,
  Asset,
  AssetGuid as AssetGuidType,
  GpuTextureAsset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  SceneAsset,
  TerrainAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createStandardAssetOutputProducerRegistry } from '../scriptable-pack-build.js';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const MATERIAL_GUID = guid('019ffa97-3000-7000-8000-000000000001');
const MESH_GUID = guid('019ffa97-3000-7000-8000-000000000002');
const EQUIRECT_GUID = guid('019ffa97-3000-7000-8000-000000000005');
const sceneComponents = [
  {
    name: 'ScriptablePackTestMeshFilter',
    fields: { assetHandle: 'asset<mesh>' },
  },
  {
    name: 'ScriptablePackTestMeshRenderer',
    fields: { materials: 'array<asset<material>>' },
  },
] satisfies readonly ScriptablePackSceneComponent[];

const OUTPUT_GUID = guid('019ffa97-3000-7000-8000-000000000010');
const ATLAS_GUID = guid('019ffa97-3000-7000-8000-000000000011');

function canonicalAttributes(vertexCount: number): MeshAsset['attributes'] {
  return {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
}

const particleProgram = {
  format: 'forgeax-vfx-program-5',
  fingerprint: 'sha256:scriptable-pack-matrix',
  emitters: [
    {
      id: 'default',
      module: 'matrix/default',
      capacity: 16,
      backend: { required: 'gpu' },
      space: 'local',
      schedule: {},
      bounds: {},
      renderers: [],
      simulationWhenCulled: 'pause',
      wgsl: 'fn main() {}',
      reflection: {},
    },
  ],
} as const;

const specialAssets = [
  {
    kind: 'navigation-mesh',
    version: 'recast-poly/1',
    sourceDigest: 'fixture',
    settings: {
      radius: 0.3,
      height: 1.8,
      maxSlopeDeg: 45,
      maxStep: 0.3,
      cellSize: 0.1,
      cellHeight: 0.05,
    },
    vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1],
    polygons: [[0, 1, 2]],
  } satisfies Extract<Asset, { kind: 'navigation-mesh' }>,
  {
    kind: 'terrain',
    materialEncoding: { kind: 'weights' },
    columns: 2,
    rows: 2,
    spacing: 1,
    subsectionVertices: 2,
    heights: new Float32Array(4),
    weights: new Float32Array(0),
    layers: [],
    heightRange: [0, 0],
    grids: [AssetGuid.format(MESH_GUID)],
    sections: [
      {
        x: 0,
        z: 0,
        minHeight: 0,
        maxHeight: 0,
        activeLayers: [],
        heightTexture: AssetGuid.format(ATLAS_GUID),
        weightTexture: AssetGuid.format(ATLAS_GUID),
        material: AssetGuid.format(MATERIAL_GUID),
      },
    ],
  } satisfies TerrainAsset,
  {
    kind: 'gpu-texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    source: { kind: 'generated', generator: AssetGuid.format(OUTPUT_GUID), output: 'color' },
  } satisfies GpuTextureAsset,
] as const satisfies readonly Asset[];

describe('standard ScriptablePack output producers', () => {
  it('publishes the deduplicated renderer dependency closure of a particle effect', async () => {
    const material = AssetGuid.format(MATERIAL_GUID);
    const mesh = AssetGuid.format(MESH_GUID);
    const asset: ParticleEffectAsset = {
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: particleProgram.fingerprint,
      emitters: [{ id: 'default', capacity: 16 }],
      program: {
        ...particleProgram,
        emitters: [
          {
            ...particleProgram.emitters[0],
            renderers: [
              { kind: 'billboard', material },
              { kind: 'mesh', material, mesh },
            ],
          },
        ],
      },
    };
    const producer = createStandardAssetOutputProducerRegistry().get('particle-effect');
    if (producer === undefined) throw new Error('Missing particle producer');
    const result = await producer.produce({
      guid: AssetGuid.format(OUTPUT_GUID),
      sourceKey: 'vfx/closure',
      asset,
    });
    if (!result.ok) throw result.error;
    expect(result.value.refs.map((ref) => ref.guid)).toEqual([material, mesh].sort());
    expect(result.value.payload).toMatchObject({
      program: {
        emitters: [
          {
            renderers: [
              { kind: 'billboard', material },
              { kind: 'mesh', material, mesh },
            ],
          },
        ],
      },
    });
  });
  it('registers the production producer versions for all ordinary Asset kinds', () => {
    const registry = createStandardAssetOutputProducerRegistry();
    expect(registry.versions()).toEqual({
      'animation-clip': 'animation-clip/3',
      'animation-graph': 'ordinary-pod/1',
      audio: 'ordinary-pod/1',
      equirect: 'ordinary-pod/1',
      font: 'ordinary-pod/1',
      'ies-profile': 'ordinary-pod/1',
      material: 'material-pack/2',
      mesh: 'mesh-binary/8',
      'particle-effect': 'particle-effect/4',
      plugin: 'plugin-definition/1',
      'render-pipeline': 'ordinary-pod/1',
      sampler: 'ordinary-pod/1',
      scene: 'scene-pack/4',
      skeleton: 'ordinary-pod/1',
      skin: 'ordinary-pod/1',
      texture: 'texture-pack/3',
      'gpu-texture': 'gpu-texture/1',
      'texture-generator': 'texture-generator/1',
      terrain: 'ordinary-pod/1',
      'navigation-mesh': 'ordinary-pod/1',
      tileset: 'ordinary-pod/1',
      video: 'ordinary-pod/1',
      'water-body': 'water-runtime/2',
      'water-zone': 'water-runtime/2',
      'water-wave-set': 'water-runtime/2',
      'water-brush-recipe': 'water-runtime/2',
      'water-simulation-recipe': 'water-runtime/2',
    });
  });

  it('produces generator programs and GPU texture, terrain and navigation source facts', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    const source = {
      kind: 'texture-generator',
      values: {},
      inputs: {},
      transient: {},
      outputs: {
        color: {
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
        },
      },
      passes: [
        {
          kind: 'raster',
          program: { module: 'test::matrix', fragmentEntry: 'color' },
          reads: {},
          writes: ['color'],
        },
      ],
    };
    const cooker = createTextureGeneratorPackCooker([], {
      sourceSnapshot: {
        roots: [],
        engine: [],
        project: [
          {
            moduleId: 'test::matrix',
            path: '/matrix.wgsl',
            source:
              '#define_import_path test::matrix\n@fragment fn color() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
          },
        ],
        identity: 'matrix',
      },
    });
    const generated = await cooker.cook({ guid: AssetGuid.format(OUTPUT_GUID), source });
    const gpuProducer = registry.get('texture-generator');
    if (gpuProducer === undefined) throw new Error('Generator producer missing');
    const gpu = await gpuProducer.produce({
      guid: AssetGuid.format(OUTPUT_GUID),
      sourceKey: 'matrix/generator',
      asset: generated.payload as Asset,
    });
    expect(gpu.ok).toBe(true);
    if (gpu.ok)
      expect(gpu.value.artifacts.programs?.assetCodec).toEqual({
        name: 'forgeax-texture-generator-programs',
        version: '1',
      });
    for (const [index, asset] of specialAssets.entries()) {
      const producer = registry.get(asset.kind);
      if (producer === undefined) throw new Error(`Missing ${asset.kind} producer`);
      const result = (
        await producer.produce({
          guid: AssetGuid.format(OUTPUT_GUID),
          sourceKey: `matrix/${index}/${asset.kind}`,
          asset,
        })
      ).unwrap();
      expect(result.payload.kind ?? asset.kind).toBe(asset.kind);
      expect(
        Object.keys(result.payload).length +
          result.refs.length +
          Object.keys(result.artifacts).length,
      ).toBeGreaterThan(0);
      if (asset.kind === 'gpu-texture') {
        expect(result.payload).toEqual({ kind: asset.kind, source: asset.source });
        expect(result.artifacts).toEqual({});
        expect(result.refs).toEqual([{ guid: asset.source.generator }]);
      }
    }
  });

  it('serializes a scene through component schemas and emits recursive GUID refs', async () => {
    const registry = createStandardAssetOutputProducerRegistry(sceneComponents);
    const producer = registry.get('scene');
    expect(producer).toBeDefined();
    if (producer === undefined) return;

    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        hero: {
          components: {
            ScriptablePackTestMeshFilter: { assetHandle: AssetGuid.format(MESH_GUID) },
            ScriptablePackTestMeshRenderer: {
              materials: [AssetGuid.format(MATERIAL_GUID)],
            },
          },
        },
      },
    };
    const result = await producer.produce({
      guid: '019ffa97-3000-7000-8000-000000000003',
      sourceKey: 'scene/showcase',
      asset: scene,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toMatchObject({
      entities: {
        hero: {
          components: {
            ScriptablePackTestMeshFilter: { assetHandle: 0 },
            ScriptablePackTestMeshRenderer: { materials: [1] },
          },
        },
      },
    });
    expect(result.value.refs).toEqual([
      {
        guid: AssetGuid.format(MESH_GUID),
        sourceField: {
          componentName: 'ScriptablePackTestMeshFilter',
          fieldName: 'assetHandle',
        },
        sceneEntityKey: 'hero',
      },
      {
        guid: AssetGuid.format(MATERIAL_GUID),
        sourceField: {
          componentName: 'ScriptablePackTestMeshRenderer',
          fieldName: 'materials',
          arrayIndex: 0,
        },
        sceneEntityKey: 'hero',
      },
    ]);
  });

  it('fails closed when a scene component schema is not declared by the Pack', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    const producer = registry.get('scene');
    expect(producer).toBeDefined();
    if (producer === undefined) return;

    const result = await producer.produce({
      guid: '019ffa97-3000-7000-8000-000000000004',
      sourceKey: 'scene/unknown-component',
      asset: {
        kind: 'scene',
        entities: { mystery: { components: { Mystery: { asset: 'not-a-ref' } } } },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'import-internal-error',
        detail: { reason: expect.stringContaining('missing from sceneComponents') },
      },
    });
  });

  it('deduplicates one shared scene GUID across multiple component fields', async () => {
    const registry = createStandardAssetOutputProducerRegistry([
      ...sceneComponents,
      { name: 'Skylight', fields: { equirect: 'asset<equirect>' } },
      { name: 'SkyboxBackground', fields: { equirect: 'asset<equirect>' } },
    ]);
    const producer = registry.get('scene');
    expect(producer).toBeDefined();
    if (producer === undefined) return;

    const result = await producer.produce({
      guid: '019ffa97-3000-7000-8000-000000000006',
      sourceKey: 'scene/environment',
      asset: {
        kind: 'scene',
        entities: {
          skylight: {
            components: { Skylight: { equirect: AssetGuid.format(EQUIRECT_GUID) } },
          },
          skybox: {
            components: { SkyboxBackground: { equirect: AssetGuid.format(EQUIRECT_GUID) } },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toHaveLength(1);
    expect(result.value.refs[0]?.guid).toBe(AssetGuid.format(EQUIRECT_GUID));
    expect(result.value.payload).toMatchObject({
      entities: {
        skylight: { components: { Skylight: { equirect: 0 } } },
        skybox: { components: { SkyboxBackground: { equirect: 0 } } },
      },
    });
  });

  it('packs mesh bytes and projects material parent references', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    const mesh = registry.get('mesh');
    const material = registry.get('material');
    expect(mesh).toBeDefined();
    expect(material).toBeDefined();
    if (mesh === undefined || material === undefined) return;

    const meshAsset: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(48),
      indices: new Uint16Array([0]),
      attributes: canonicalAttributes(4),
      submeshes: [],
      materialSlots: [{ slotName: 'Default', defaultMaterial: MATERIAL_GUID }],
    };
    const meshResult = await mesh.produce({
      guid: AssetGuid.format(MESH_GUID),
      sourceKey: 'mesh/generated',
      asset: meshAsset,
    });
    expect(meshResult.ok).toBe(true);
    if (meshResult.ok)
      expect(meshResult.value.artifacts.body?.bytes.byteLength).toBeGreaterThan(28);

    const materialAsset: MaterialAsset = { kind: 'material', parent: MATERIAL_GUID };
    const materialResult = await material.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/generated',
      asset: materialAsset,
    });
    expect(materialResult.ok).toBe(true);
    if (materialResult.ok) {
      expect(materialResult.value.payload).toMatchObject({ parent: 0 });
      expect(materialResult.value.refs).toEqual([
        { guid: AssetGuid.format(MATERIAL_GUID), sourceField: { fieldName: 'parent' } },
      ]);
    }
  });

  it('keeps ordinary output identities and serialized bytes stable across builds', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    const inputs = [
      {
        guid: AssetGuid.format(MESH_GUID),
        sourceKey: 'mesh/generated',
        asset: createBoxGeometry(1, 1, 1).unwrap(),
      },
      {
        guid: AssetGuid.format(MATERIAL_GUID),
        sourceKey: 'material/generated',
        asset: { kind: 'material' as const, values: {} },
      },
      {
        guid: AssetGuid.format(guid('019ffa97-3000-7000-8000-000000000003')),
        sourceKey: 'scene/generated',
        asset: { kind: 'scene' as const, entities: {} },
      },
    ];
    for (const input of inputs) {
      const producer = registry.get(input.asset.kind);
      if (producer === undefined) throw new Error(`Missing ${input.asset.kind} producer`);
      const first = (await producer.produce(input)).unwrap();
      expect((await producer.produce(input)).unwrap()).toEqual(first);
      expect(first.payload).not.toHaveProperty('scriptableKind');
    }
  });
});

it('retains audio and sub-animation GUID closure in timeline key order', async () => {
  const registry = createStandardAssetOutputProducerRegistry();
  const events = [
    {
      time: 0.1,
      targetId: '00000000000000000000000000000000' as AnimationClip['channels'][number]['targetId'],
      action: { kind: 'audio' as const, clip: AssetGuid.format(ATLAS_GUID), fromPosition: 0 },
    },
    {
      time: 0.2,
      targetId: '00000000000000000000000000000000' as AnimationClip['channels'][number]['targetId'],
      action: { kind: 'animation' as const, clip: AssetGuid.format(OUTPUT_GUID), fromPosition: 0 },
    },
    {
      time: 0.3,
      targetId: '00000000000000000000000000000000' as AnimationClip['channels'][number]['targetId'],
      action: { kind: 'audio' as const, clip: null, fromPosition: 0 },
    },
  ];
  const producer = registry.get('animation-clip');
  if (producer === undefined) throw new Error('missing animation producer');
  const result = await producer.produce({
    guid: AssetGuid.format(OUTPUT_GUID),
    sourceKey: 'timeline/closure',
    asset: { kind: 'animation-clip', duration: 1, channels: [], events },
  });
  if (!result.ok) throw result.error;
  expect(result.value.refs.map((ref) => ref.guid)).toEqual([
    AssetGuid.format(ATLAS_GUID),
    AssetGuid.format(OUTPUT_GUID),
  ]);
  expect(result.value.payload).toMatchObject({ events });
});
