import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackSceneComponent } from '@forgeax/engine-pack/source';
import type {
  AnimationClip,
  AnimationGraph,
  Asset,
  AssetGuid as AssetGuidType,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TerrainAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createStandardAssetOutputProducerRegistry } from '../standard-output-producers.js';

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
const SKELETON_GUID = guid('019ffa97-3000-7000-8000-000000000012');

function canonicalAttributes(vertexCount: number): MeshAsset['attributes'] {
  return {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
}

const particleProgram = {
  format: 'forgeax-vfx-program-4',
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

const matrixAssets = [
  {
    kind: 'mesh',
    vertices: new Float32Array(48),
    indices: new Uint16Array([0]),
    attributes: canonicalAttributes(4),
    submeshes: [],
    materialSlots: [],
  } satisfies MeshAsset,
  { kind: 'material', values: { roughness: 0.5 } } satisfies MaterialAsset,
  { kind: 'scene', entities: {} } satisfies SceneAsset,
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
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([255, 255, 255, 255]),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  } satisfies TextureAsset,
  {
    kind: 'equirect',
    width: 1,
    height: 1,
    format: 'rgba16float',
    data: new Uint8Array(8),
    colorSpace: 'linear',
  } satisfies EquirectAsset,
  { kind: 'sampler', magFilter: 'linear' } satisfies SamplerAsset,
  {
    kind: 'font',
    atlas: ATLAS_GUID,
    sampler: OUTPUT_GUID,
    glyphs: {},
    common: {
      lineHeight: 1,
      base: 1,
      distanceRange: 4,
      pxRange: 4,
      atlasWidth: 1,
      atlasHeight: 1,
    },
  } satisfies FontAsset,
  {
    kind: 'render-pipeline',
    pipelineId: 'forgeax::standard',
    renderPath: 'forward',
  } satisfies RenderPipelineAsset,
  {
    kind: 'tileset',
    atlases: [AssetGuid.format(ATLAS_GUID)],
    tileWidth: 1,
    tileHeight: 1,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    tiles: [{ regionIndex: 0 }],
  } satisfies TilesetAsset,
  { kind: 'video', url: 'https://example.test/scene.webm' } satisfies VideoAsset,
  {
    kind: 'skeleton',
    inverseBindMatrices: new Float32Array(16),
    jointCount: 1,
  } satisfies SkeletonAsset,
  {
    kind: 'skin',
    skeletonGuid: AssetGuid.format(SKELETON_GUID),
    jointPaths: ['root'],
  } satisfies SkinAsset,
  { kind: 'animation-clip', duration: 1, channels: [] } satisfies AnimationClip,
  {
    kind: 'animation-graph',
    nodes: [{ type: 'clip', clip: AssetGuid.format(OUTPUT_GUID), weight: 1 }],
    root: 0,
  } satisfies AnimationGraph,
  {
    kind: 'audio',
    sourceKey: 'audio/matrix',
    mediaType: 'audio/wav',
    bytes: new Uint8Array([82, 73, 70, 70]),
  } satisfies AudioClipAsset,
  {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: particleProgram.fingerprint,
    emitters: [{ id: 'default', capacity: 16 }],
    program: particleProgram,
  } satisfies ParticleEffectAsset,
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
      'animation-clip': 'animation-clip/2',
      'animation-graph': 'ordinary-pod/1',
      audio: 'ordinary-pod/1',
      equirect: 'ordinary-pod/1',
      font: 'ordinary-pod/1',
      'ies-profile': 'ordinary-pod/1',
      material: 'material-pack/2',
      mesh: 'mesh-binary/7',
      'particle-effect': 'particle-effect/4',
      plugin: 'plugin-definition/1',
      'render-pipeline': 'ordinary-pod/1',
      sampler: 'ordinary-pod/1',
      scene: 'scene-pack/4',
      skeleton: 'ordinary-pod/1',
      skin: 'ordinary-pod/1',
      texture: 'texture-pack/1',
      terrain: 'ordinary-pod/1',
      'navigation-mesh': 'ordinary-pod/1',
      tileset: 'ordinary-pod/1',
      video: 'ordinary-pod/1',
    });
  });

  it('provides a real producer contract for every ordinary Asset kind', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    const expectedKinds = [
      'mesh',
      'material',
      'scene',
      'texture',
      'equirect',
      'sampler',
      'font',
      'render-pipeline',
      'tileset',
      'video',
      'skeleton',
      'skin',
      'animation-clip',
      'animation-graph',
      'audio',
      'ies-profile',
      'particle-effect',
      'plugin',
      'terrain',
      'navigation-mesh',
    ] as const;

    expect(Object.keys(registry.versions()).sort()).toEqual([...expectedKinds].sort());
    for (const [index, asset] of matrixAssets.entries()) {
      const producer = registry.get(asset.kind);
      expect(producer, `${asset.kind} producer`).toBeDefined();
      if (producer === undefined) continue;
      const result = await producer.produce({
        guid: AssetGuid.format(OUTPUT_GUID),
        sourceKey: `matrix/${index}/${asset.kind}`,
        asset,
      });
      expect(result.ok, `${asset.kind} producer result`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.payload.kind ?? asset.kind).toBe(asset.kind);
      const hasPayload = Object.keys(result.value.payload).length > 0;
      const hasDescriptor =
        asset.kind === 'video' &&
        'url' in asset &&
        typeof asset.url === 'string' &&
        asset.url.length > 0;
      expect(
        hasPayload ||
          result.value.refs.length + Object.keys(result.value.artifacts).length > 0 ||
          hasDescriptor,
        `${asset.kind} producer facts`,
      ).toBe(true);
    }
  });

  it('publishes media and VFX producer facts without host execution', async () => {
    const registry = createStandardAssetOutputProducerRegistry();
    for (const kind of ['audio', 'video', 'particle-effect'] as const) {
      const asset = matrixAssets.find((candidate) => candidate.kind === kind);
      const producer = registry.get(kind);
      expect(producer, `${kind} producer`).toBeDefined();
      expect(asset, `${kind} fixture`).toBeDefined();
      if (producer === undefined || asset === undefined) continue;
      const result = await producer.produce({
        guid: AssetGuid.format(OUTPUT_GUID),
        sourceKey: `media/${kind}`,
        asset,
      });
      expect(result.ok, `${kind} result`).toBe(true);
      if (!result.ok) continue;
      if (kind === 'video') {
        expect(result.value.payload).toMatchObject({ kind, url: (asset as VideoAsset).url });
      } else {
        expect(Object.keys(result.value.artifacts)).not.toHaveLength(0);
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
    const mesh = registry.get('mesh');
    const material = registry.get('material');
    const scene = registry.get('scene');
    expect(mesh).toBeDefined();
    expect(material).toBeDefined();
    expect(scene).toBeDefined();
    if (mesh === undefined || material === undefined || scene === undefined) return;

    const inputs = [
      {
        guid: AssetGuid.format(MESH_GUID),
        sourceKey: 'mesh/generated',
        asset: createBoxGeometry(1, 1, 1).unwrap(),
        producer: mesh,
      },
      {
        guid: AssetGuid.format(MATERIAL_GUID),
        sourceKey: 'material/generated',
        asset: { kind: 'material' as const, values: {} },
        producer: material,
      },
      {
        guid: AssetGuid.format(guid('019ffa97-3000-7000-8000-000000000003')),
        sourceKey: 'scene/generated',
        asset: { kind: 'scene' as const, entities: {} },
        producer: scene,
      },
    ];
    const first = await Promise.all(
      inputs.map(({ producer, ...input }) => producer.produce(input)),
    );
    const second = await Promise.all(
      inputs.map(({ producer, ...input }) => producer.produce(input)),
    );

    expect(first.map((result) => result.ok)).toEqual([true, true, true]);
    expect(second.map((result) => result.ok)).toEqual([true, true, true]);
    expect(first).toEqual(second);
    for (const result of first) {
      if (!result.ok) continue;
      expect(result.value.payload).not.toHaveProperty('scriptableKind');
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
