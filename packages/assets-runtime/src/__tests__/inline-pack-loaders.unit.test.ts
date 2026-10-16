// @forgeax/engine-assets-runtime -- inline pack-payload loader coverage
// (fix issue #709). Each loader is a pure (payload, refs, ctx) -> Asset|undefined
// function; exercise the accept + reject arms of all eight, plus the
// wireDefaultLoaders / createDefaultLoaderRegistry seed-table helpers.

import { createHash } from 'node:crypto';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { cookMeshDistanceFieldProduct, packMeshBin } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { LoadContext, MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LoaderRegistry } from '../loader-registry';
import {
  animationClipLoader,
  animationGraphLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  samplerLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from '../loaders/inline-pack';
import { createDefaultLoaderRegistry, wireDefaultLoaders } from '../wire-default-loaders';

const emptyCtx = {} as LoadContext;

describe('meshLoader', () => {
  it.each([
    0.5,
    { resolution: 12 },
  ])('snapshots checked field identity through ordinary Mesh publication: %j', async (sampling) => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const product = await cookMeshDistanceFieldProduct(mesh, 'mesh-field', sampling, [0]);
    const field = product.artifacts['distance-field.bin'];
    if (!field.assetCodec) throw new Error('expected field codec');
    const artifact = {
      integrity: {
        algorithm: 'sha256' as const,
        digest: `sha256:${createHash('sha256').update(field.bytes).digest('hex')}`,
      },
      assetCodec: { ...field.assetCodec },
    };
    const expected = structuredClone(artifact);
    const registry = new LoaderRegistry();
    registry.register(meshLoader);
    const pending = registry.loadPack(
      {
        guid: 'mesh-field',
        kind: 'mesh',
        payload: { ...mesh, distanceField: product.payload },
        refs: [],
        artifacts: {
          'distance-field.bin': {
            descriptor: { path: 'distance-field.bin', mediaType: field.mediaType, ...artifact },
            bytes: field.bytes,
          },
        },
      },
      emptyCtx,
    );
    artifact.integrity.digest = `sha256:${'0'.repeat(64)}`;
    artifact.assetCodec.profile = 'changed-while-attachment-pending';
    expect(await pending).toMatchObject({
      ok: true,
      value: { distanceField: { artifact: expected } },
    });
  });

  it('admits geometric policy on the same GUID and rejects stale geometry, sidedness and codec', async () => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const product = await cookMeshDistanceFieldProduct(
      mesh,
      'collision-mesh',
      { resolution: 12 },
      [0],
    );
    const field = product.artifacts['distance-field.bin'];
    const registry = new LoaderRegistry();
    registry.register(meshLoader);
    if (!field.assetCodec) throw new Error('missing codec');
    const publication = {
      guid: 'collision-mesh',
      kind: 'mesh' as const,
      payload: { ...mesh, distanceField: product.payload },
      refs: [],
      artifacts: {
        'distance-field.bin': {
          descriptor: {
            path: 'distance-field.bin',
            mediaType: field.mediaType,
            assetCodec: field.assetCodec,
            integrity: {
              algorithm: 'sha256' as const,
              digest: `sha256:${createHash('sha256').update(field.bytes).digest('hex')}`,
            },
          },
          bytes: field.bytes,
        },
      },
    };
    expect(await registry.loadPack(publication, emptyCtx)).toMatchObject({
      ok: true,
      value: {
        distanceField: {
          policy: { kind: 'signed-solid' },
          artifact: { assetCodec: { profile: 'geometric/5' } },
        },
      },
    });
    const moved = mesh.attributes.position?.slice();
    if (!(moved instanceof Float32Array)) throw new Error('missing positions');
    moved[0] = (moved[0] ?? 0) + 0.1;
    for (const bad of [
      {
        ...publication,
        payload: { ...publication.payload, attributes: { ...mesh.attributes, position: moved } },
      },
      {
        ...publication,
        payload: {
          ...publication.payload,
          distanceField: { sectionSidedness: [1 as const] },
        },
      },
      {
        ...publication,
        artifacts: {
          'distance-field.bin': {
            ...publication.artifacts['distance-field.bin'],
            descriptor: {
              ...publication.artifacts['distance-field.bin'].descriptor,
              assetCodec: { ...field.assetCodec, profile: 'sampled-visibility/5' },
            },
          },
        },
      },
    ])
      expect((await registry.loadPack(bad, emptyCtx)).ok).toBe(false);
  });

  it('requires artifact integrity before exposing distance field publication identity', async () => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const product = await cookMeshDistanceFieldProduct(mesh, 'mesh-field', 0.5, [0]);
    const field = product.artifacts['distance-field.bin'];
    if (!field.assetCodec) throw new Error('expected field codec');
    const registry = new LoaderRegistry();
    registry.register(meshLoader);
    const result = await registry.loadPack(
      {
        guid: 'mesh-field',
        kind: 'mesh',
        payload: { ...mesh, distanceField: product.payload },
        refs: [],
        artifacts: {
          'distance-field.bin': {
            descriptor: {
              path: 'distance-field.bin',
              mediaType: field.mediaType,
              assetCodec: field.assetCodec,
            },
            bytes: field.bytes,
          },
        },
      },
      emptyCtx,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-parse-failed',
        detail: { reason: 'mesh distance field artifact integrity is missing' },
      },
    });
  });

  it('rejects legacy mesh binaries without a white/default fallback', () => {
    const output = meshLoader.loadPack?.(
      {
        guid: 'mesh-legacy',
        payload: {},
        artifacts: { body: { bytes: new Uint8Array([2, 0, 0]) } },
      } as never,
      emptyCtx,
    );
    expect(output).toMatchObject({ ok: false, error: { sourceKey: 'mesh-legacy' } });
  });

  it('normalises Array vertices/indices into typed arrays with a default submesh', () => {
    const out = meshLoader.load(
      { vertices: new Array(12).fill(0), indices: [0, 0, 0] },
      undefined,
      emptyCtx,
    );
    expect(out).toBeDefined();
    const mesh = out as {
      kind: string;
      vertices: Float32Array;
      indices?: Uint16Array;
      submeshes: unknown[];
    };
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
    expect(mesh.submeshes).toHaveLength(1);
  });

  it('loads the canonical Pack v2 procedural mesh descriptor', () => {
    const out = meshLoader.load({ geometry: 'procedural-cube' }, undefined, emptyCtx) as {
      kind: string;
      vertices: Float32Array;
      indices?: Uint16Array | Uint32Array;
      submeshes: unknown[];
    };
    expect(out.kind).toBe('mesh');
    expect(out.vertices.length).toBeGreaterThan(0);
    expect(out.indices).toBeDefined();
    expect(out.indices instanceof Uint16Array || out.indices instanceof Uint32Array).toBe(true);
    expect(out.submeshes).toHaveLength(1);
  });

  it('drops an empty index array (vertex-only path)', () => {
    const out = meshLoader.load(
      { vertices: new Float32Array(12), indices: [] },
      undefined,
      emptyCtx,
    ) as {
      indices?: unknown;
    };
    expect(out.indices).toBeUndefined();
  });

  it('accepts skinIndex/skinWeight as arrays', () => {
    const out = meshLoader.load(
      {
        vertices: new Float32Array(18),
        attributes: { skinIndex: [0, 1, 2, 3], skinWeight: [1, 0, 0, 0] },
      },
      undefined,
      emptyCtx,
    ) as { attributes: { skinIndex: unknown; skinWeight: unknown } };
    expect(out.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(out.attributes.skinWeight).toBeInstanceOf(Float32Array);
  });

  it('rejects a non-array/non-typed vertices payload', () => {
    expect(meshLoader.load({ vertices: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('rejects a malformed skinIndex', () => {
    expect(
      meshLoader.load(
        { vertices: new Float32Array(12), attributes: { skinIndex: 'bad' } },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });
});

describe('meshLoader strict v4 inline artifact', () => {
  it('resolves lower-detail mesh refs from the enclosing pack table', () => {
    const lodGuid = '019d0000-0000-7000-8000-000000000008';
    const lod = AssetGuid.parse(lodGuid);
    if (!lod.ok) throw new Error('fixture guid must parse');
    const packed = packMeshBin(
      {
        vertices: new Float32Array(12),
        indices: Uint16Array.of(0, 1, 0),
        attributes: {
          position: new Float32Array(3),
          normal: new Float32Array(3),
          uv: new Float32Array(2),
          tangent: new Float32Array(4),
        },
        lods: [{ mesh: lod.value, screenCoverage: 0.5 }],
      },
      'mesh/lod-root',
      [lodGuid],
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const output = meshLoader.loadPack?.(
      {
        guid: 'mesh-lod-root',
        kind: 'mesh',
        payload: {},
        refs: [lodGuid],
        artifacts: { body: { bytes: packed.value } },
      } as never,
      emptyCtx,
    );
    expect(output).toMatchObject({ kind: 'mesh' });
    if (output === undefined || (typeof output === 'object' && output !== null && 'ok' in output))
      return;
    const mesh = output as {
      readonly lods?: readonly { readonly mesh: Uint8Array; readonly screenCoverage: number }[];
    };
    expect(mesh.lods).toHaveLength(1);
    expect(mesh.lods?.[0]?.screenCoverage).toBe(0.5);
    expect(AssetGuid.format(mesh.lods?.[0]?.mesh as never)).toBe(lodGuid);
  });

  it('routes a malformed inline mesh artifact as a structured error and publishes no asset', () => {
    const output = meshLoader.loadPack?.(
      {
        guid: 'mesh-guid',
        kind: 'mesh',
        payload: {},
        refs: [],
        artifacts: {
          body: {
            descriptor: {
              path: 'mesh.bin',
              mediaType: 'application/x-forgeax-mesh',
              assetCodec: { name: 'mesh-binary', version: '5' },
            },
            bytes: new Uint8Array([3, 0, 0]),
          },
        },
      } as never,
      emptyCtx,
    );
    expect(output).toMatchObject({
      ok: false,
      error: { sourceKey: 'mesh-guid', recovery: expect.stringContaining('re-cook') },
    });
  });
});

describe('sceneLoader', () => {
  it('parses a scene payload into a SceneAsset', () => {
    const out = sceneLoader.load(
      { entities: { 'entity-0': { components: {} } } },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('scene');
  });

  it('returns undefined for a malformed scene payload', () => {
    expect(sceneLoader.load({ entities: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('routes an out-of-bounds ref error inline as { ok:false, error }', () => {
    const out = sceneLoader.load(
      { entities: { 'entity-0': { components: { MeshFilter: { assetHandle: 9 } } } } },
      ['only-one-guid'],
      emptyCtx,
    );
    expect(out).toMatchObject({ ok: false });
  });
});

describe('materialLoader', () => {
  it.each([
    { passes: [{ name: 'forward', program: { module: 'forgeax::default-standard-pbr' } }] },
    { parent: 'root-material' },
  ])('preserves root and child static feature choices through payload loading: %j', (contract) => {
    const staticSwitches = { clearcoat: true, textures: false } as const;
    const loaded = materialLoader.load(
      { ...contract, staticSwitches, values: { clearcoat: 0.85 } },
      [],
      emptyCtx,
    ) as MaterialAsset;
    expect(loaded.staticSwitches).toEqual(staticSwitches);
    expect(loaded.values?.clearcoat).toBe(0.85);
  });

  it.each([
    { clearcoat: 1 },
    { unknownLayer: true },
    null,
  ])('rejects malformed static feature choices: %j', (staticSwitches) => {
    expect(
      materialLoader.load(
        {
          passes: [{ name: 'forward', program: { module: 'forgeax::default-standard-pbr' } }],
          staticSwitches,
          values: {},
        },
        [],
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('builds a material from passes + values', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: { roughness: 0.5 },
      },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('material');
  });

  it('preserves the authored parameter schema and color space', () => {
    const parameters = [
      { name: 'tint', type: 'color', colorSpace: 'linear' },
      { name: 'flowTexture', type: 'texture' },
    ] as const;
    const out = materialLoader.load(
      {
        passes: [{ name: 'particle-billboard', program: { module: 'sample::flow' } }],
        parameters,
        values: { tint: [0.2, 0.6, 1, 1] },
        colorSpace: 'linear',
      },
      undefined,
      emptyCtx,
    ) as MaterialAsset;

    expect(out.parameters).toEqual(parameters);
    expect(out.colorSpace).toBe('linear');
  });

  it.each([
    { passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }] },
    { parent: '01935b00-0000-7000-8000-000000000001' },
  ])('preserves explicit static selections through root and child loading: %j', (contract) => {
    const staticSwitches = { clearcoat: true, textures: false };
    const out = materialLoader.load(
      { ...contract, staticSwitches, values: { clearcoat: 0 } },
      undefined,
      emptyCtx,
    ) as MaterialAsset;
    expect(out.staticSwitches).toEqual(staticSwitches);
    expect(out.values).toEqual({ clearcoat: 0 });
  });

  it.each([
    null,
    { clearcoat: 1 },
    { unknownLayer: true },
  ])('rejects malformed static selections: %j', (staticSwitches) => {
    expect(
      materialLoader.load(
        {
          passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
          staticSwitches,
        },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('preserves typed particle inputs for VFX material projection', () => {
    const particleInputs = [
      { name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 },
    ] as const;
    const out = materialLoader.load(
      {
        passes: [{ name: 'particle-billboard', program: { module: 'sample::flow' } }],
        particleInputs,
        values: { baseColor: [1, 0.2, 0.01, 1] },
      },
      undefined,
      emptyCtx,
    ) as MaterialAsset;

    expect(out.particleInputs).toEqual(particleInputs);
  });

  it('resolves a numeric parent ref-index to a parentGuid string', () => {
    const out = materialLoader.load({ values: {}, parent: 1 }, ['g0', 'g1'], emptyCtx) as {
      parentGuid?: string;
    };
    expect(out.parentGuid).toBe('g1');
  });

  it('preserves child scalars while resolving explicit texture and sampler references', () => {
    const out = materialLoader.load(
      {
        parent: 0,
        values: {
          emissionStrength: 0,
          pigmentStrength: 0,
          surfaceMetallic: 0,
          bandCount: 1,
          sideShade: 0.84,
          albedo: { texture: 1, sampler: 2 },
        },
      },
      ['parent-guid', 'texture-guid', 'sampler-guid'],
      emptyCtx,
    ) as MaterialAsset & { parentGuid: string };
    expect(out.parentGuid).toBe('parent-guid');
    expect(out.values).toEqual({
      emissionStrength: 0,
      pigmentStrength: 0,
      surfaceMetallic: 0,
      bandCount: 1,
      sideShade: 0.84,
      albedo: { texture: 'texture-guid', sampler: 'sampler-guid' },
    });
  });

  it.each([
    ['colorSpace', { colorSpace: 'linear' }],
    ['passes', { passes: [{ name: 'main', program: { module: 'x' } }] }],
    ['parameters', { parameters: [{ name: 'roughness', type: 'f32' }] }],
    ['passes:undefined', { passes: undefined }],
  ] as const)('rejects a parent-bearing child with own %s', (_field, forbidden) => {
    expect(
      materialLoader.load(
        { parent: '01935b00-0000-7000-8000-000000000001', values: {}, ...forbidden },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('preserves an authored parent GUID without requiring a refs index', () => {
    const out = materialLoader.load(
      { values: { baseColor: [1, 0, 0, 1] }, parent: '01935b00-0000-7000-8000-000000000001' },
      undefined,
      emptyCtx,
    ) as { parentGuid?: string };
    expect(out.parentGuid).toBe('01935b00-0000-7000-8000-000000000001');
  });

  it('returns undefined when a parent ref-index is out of bounds', () => {
    expect(materialLoader.load({ values: {}, parent: 9 }, ['g0'], emptyCtx)).toBeUndefined();
  });

  it('resolves shader-declared texture paramValue ref-indices to GUIDs', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: (id: string) =>
        id === 'forgeax::pbr' ? new Set(['baseColorTexture']) : undefined,
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ name: 'm', program: { module: 'forgeax::pbr' } }],
        values: { baseColorTexture: 0, roughness: 5 },
      },
      ['tex-guid'],
      ctx,
    ) as { values: Record<string, unknown> };
    expect(out.values.baseColorTexture).toEqual({ texture: 'tex-guid' });
    expect(out.values.roughness).toBe(5); // non-texture int untouched
  });

  it('uses authored parameters to distinguish texture refs from zero-valued scalars', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'main', program: { module: 'late::standard' } }],
        parameters: [
          { name: 'metallic', type: 'f32' },
          { name: 'baseColorTexture', type: 'texture', optional: true },
        ],
        values: { metallic: 0, baseColorTexture: 0 },
      },
      ['texture-guid'],
      emptyCtx,
    ) as MaterialAsset;

    expect(out.values?.metallic).toBe(0);
    expect(out.values?.baseColorTexture).toEqual({ texture: 'texture-guid' });
  });

  it('preserves parented scalar values without a local schema', () => {
    const out = materialLoader.load(
      {
        parent: 0,
        values: {
          emissionStrength: 0,
          roughness: 1,
          direction: -1,
          baseColorTexture: { texture: 1, sampler: 2 },
        },
      },
      ['parent-guid', 'texture-guid', 'sampler-guid'],
      emptyCtx,
    ) as MaterialAsset & { parentGuid: string };

    expect(out.parentGuid).toBe('parent-guid');
    expect(out.values).toEqual({
      emissionStrength: 0,
      roughness: 1,
      direction: -1,
      baseColorTexture: { texture: 'texture-guid', sampler: 'sampler-guid' },
    });
  });

  it('does not infer scalar types from refs when a shader contract is not registered', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'forward', program: { module: 'late::material' } }],
        values: { emissionStrength: 0, roughness: 1 },
      },
      ['parent-guid', 'texture-guid'],
      emptyCtx,
    ) as MaterialAsset;
    expect(out.values).toEqual({ emissionStrength: 0, roughness: 1 });
  });

  it('treats an authored all-scalar parameter schema as authoritative', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'main', program: { module: 'late::standard' } }],
        parameters: [{ name: 'metallic', type: 'f32' }],
        values: { metallic: 0 },
      },
      ['texture-guid'],
      emptyCtx,
    ) as MaterialAsset;

    expect(out.values?.metallic).toBe(0);
  });

  it('resolves nested texture and sampler ref-indices while preserving authored fields', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: () => new Set(['baseColorTexture']),
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ name: 'm', program: { module: 'forgeax::pbr' } }],
        values: {
          baseColorTexture: {
            texture: 0,
            sampler: 1,
            coordinates: { set: 1, transform: { scale: [2, 3] } },
          },
        },
      },
      ['tex-guid', 'sampler-guid'],
      ctx,
    ) as { values: Record<string, unknown> };
    expect(out.values.baseColorTexture).toEqual({
      texture: 'tex-guid',
      sampler: 'sampler-guid',
      coordinates: { set: 1, transform: { scale: [2, 3] } },
    });
  });

  it('resolves transmission and thickness texture refs through authored contract', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
        parameters: [
          { name: 'transmissionTexture', type: 'texture' },
          { name: 'thicknessTexture', type: 'texture' },
        ],
        values: {
          transmission: 0.8,
          ior: 1.45,
          thickness: 0.25,
          transmissionTexture: { texture: 0, sampler: 1, coordinates: { set: 2 } },
          thicknessTexture: { texture: 2, sampler: 3, coordinates: { set: 3 } },
        },
      },
      ['texture-transmission', 'sampler-linear', 'texture-thickness', 'sampler-nearest'],
      emptyCtx,
    ) as MaterialAsset;

    expect(out.values).toMatchObject({
      transmission: 0.8,
      ior: 1.45,
      thickness: 0.25,
      transmissionTexture: {
        texture: 'texture-transmission',
        sampler: 'sampler-linear',
        coordinates: { set: 2 },
      },
      thicknessTexture: {
        texture: 'texture-thickness',
        sampler: 'sampler-nearest',
        coordinates: { set: 3 },
      },
    });
  });

  it('resolves nested texture values when the shader schema is present but empty', () => {
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::pbr-skin' } }],
        values: { baseColor: [1, 1, 1, 1], metallic: 0, baseColorTexture: { texture: 0 } },
      },
      ['tex-guid'],
      {
        ...emptyCtx,
        getMaterialShaderTextureFieldNames: () => new Set(),
      },
    ) as MaterialAsset;

    expect(out.values).toBeDefined();
    if (!out.values) throw new Error('material loader must preserve material values');
    expect(out.values.baseColorTexture).toEqual({ texture: 'tex-guid' });
    expect(out.values.metallic).toBe(0);
  });

  it('removes identity coordinates from structured texture references', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: () => new Set(['baseColorTexture']),
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::pbr' } }],
        values: {
          baseColorTexture: {
            texture: 0,
            coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } },
          },
        },
      },
      ['tex-guid'],
      ctx,
    ) as MaterialAsset;

    expect(out.values?.baseColorTexture).toEqual({ texture: 'tex-guid' });
  });

  it('preserves coordinate extension metadata instead of treating it as identity', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: () => new Set(['baseColorTexture']),
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::pbr' } }],
        values: {
          baseColorTexture: {
            texture: 0,
            coordinates: { transform: { metadata: 'keep' } },
          },
        },
      },
      ['tex-guid'],
      ctx,
    ) as { values: Record<string, unknown> };

    expect(out.values.baseColorTexture).toEqual({
      texture: 'tex-guid',
      coordinates: { transform: { metadata: 'keep' } },
    });
  });

  it('returns undefined for a passes-less, parent-less material', () => {
    expect(materialLoader.load({}, undefined, emptyCtx)).toBeUndefined();
  });
});

describe('inline ordinary asset matrix', () => {
  it('loads render-pipeline and tileset descriptors after a JSON roundtrip', () => {
    const registry = createDefaultLoaderRegistry();
    expect(registry.get('render-pipeline')).toBeDefined();
    expect(registry.get('tileset')).toBeDefined();

    const renderPipeline = registry
      .get('render-pipeline')
      ?.load(
        { kind: 'render-pipeline', pipelineId: 'forgeax::standard', renderPath: 'forward' },
        undefined,
        emptyCtx,
      );
    const tileset = registry.get('tileset')?.load(
      {
        kind: 'tileset',
        atlases: ['019d0000-0000-7000-8000-000000000001'],
        tileWidth: 1,
        tileHeight: 1,
        columns: 1,
        rows: 1,
        regions: [{ x: 0, y: 0, width: 1, height: 1 }],
        tiles: [{ regionIndex: 0 }],
      },
      undefined,
      emptyCtx,
    );
    expect(renderPipeline).toMatchObject({ kind: 'render-pipeline' });
    expect(tileset).toMatchObject({ kind: 'tileset' });
  });
});

describe('skeletonLoader', () => {
  it('accepts a valid inverseBindMatrices/jointCount pair', () => {
    const out = skeletonLoader.load(
      { inverseBindMatrices: new Array(16).fill(0), jointCount: 1 },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('skeleton');
  });

  it('round-trips producer-authored conservative bounds from JSON-shaped payloads', () => {
    const out = skeletonLoader.load(
      { inverseBindMatrices: new Array(16).fill(0), jointCount: 1, bounds: [-2, -1, -3, 2, 1, 3] },
      undefined,
      emptyCtx,
    );
    expect(out).toMatchObject({
      kind: 'skeleton',
      bounds: new Float32Array([-2, -1, -3, 2, 1, 3]),
    });
  });

  it('rejects a stride mismatch (byteLength !== jointCount*64)', () => {
    expect(
      skeletonLoader.load(
        { inverseBindMatrices: new Array(16).fill(0), jointCount: 2 },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('rejects a non-array inverseBindMatrices', () => {
    expect(
      skeletonLoader.load({ inverseBindMatrices: 'bad', jointCount: 0 }, undefined, emptyCtx),
    ).toBeUndefined();
  });
});

describe('skinLoader', () => {
  it('accepts a valid skeletonGuid + jointPaths', () => {
    const out = skinLoader.load({ skeletonGuid: 'g', jointPaths: ['a', 'b'] }, undefined, emptyCtx);
    expect((out as { kind?: string }).kind).toBe('skin');
  });

  it('rejects a missing skeletonGuid or non-string joint path', () => {
    expect(skinLoader.load({ jointPaths: [] }, undefined, emptyCtx)).toBeUndefined();
    expect(
      skinLoader.load({ skeletonGuid: 'g', jointPaths: [1] }, undefined, emptyCtx),
    ).toBeUndefined();
  });
});

describe('animationClipLoader', () => {
  it('retains cubic tangents through JSON Cook transport and rejects malformed samplers', () => {
    const payload = {
      duration: 2,
      channels: [
        {
          targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
          property: 'translation',
          sampler: {
            input: [0, 2],
            output: [0, 0, 0, 0, 0, 0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0, 0],
            interpolation: 'CUBICSPLINE',
          },
        },
      ],
    };
    const loaded = animationClipLoader.load(
      JSON.parse(JSON.stringify(payload)),
      undefined,
      emptyCtx,
    ) as unknown as {
      channels: { sampler: { input: Float32Array; output: Float32Array; interpolation: string } }[];
    };
    expect(loaded.channels[0]?.sampler).toEqual({
      input: new Float32Array([0, 2]),
      output: new Float32Array(requireValue(payload.channels[0]).sampler.output),
      interpolation: 'CUBICSPLINE',
    });
    for (const sampler of [
      { input: [0, 0], output: requireValue(payload.channels[0]).sampler.output },
      { input: [0, 2], output: [0, 0, 0, 1, 2, 3] },
      {
        input: [0, 2],
        output: [...requireValue(payload.channels[0]).sampler.output.slice(0, -1), NaN],
      },
    ])
      expect(
        animationClipLoader.load(
          {
            ...payload,
            channels: [
              { ...payload.channels[0], sampler: { ...sampler, interpolation: 'CUBICSPLINE' } },
            ],
          },
          undefined,
          emptyCtx,
        ),
      ).toBeUndefined();
  });
  it('retains property bindings and STEP values across the JSON transport', () => {
    const channel = (output: unknown, interpolation = 'STEP') => ({
      targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
      property: 'property',
      binding: 'state',
      sampler: { input: [0, 1], output, interpolation },
    });
    for (const output of [
      [false, true],
      ['idle', 'run'],
      [0, 1],
    ]) {
      const raw = JSON.parse(JSON.stringify({ duration: 1, channels: [channel(output)] }));
      const decoded = animationClipLoader.load(raw, undefined, emptyCtx) as unknown as {
        channels: [{ binding: string; sampler: { output: ArrayLike<unknown> } }];
      };
      expect(decoded.channels[0].binding).toBe('state');
      expect(Array.from(decoded.channels[0].sampler.output)).toEqual(output);
    }
    expect(
      animationClipLoader.load(
        { channels: [channel(['idle', 'run'], 'LINEAR')] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
    expect(
      animationClipLoader.load(
        { channels: [{ ...channel([0, 1]), binding: '' }] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });
  it('accepts a valid channel with LINEAR sampler arrays', () => {
    const out = animationClipLoader.load(
      {
        duration: 1,
        channels: [
          {
            targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
            property: 'translation',
            sampler: { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: 'LINEAR' },
          },
        ],
      },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('animation-clip');
  });

  it('rejects legacy, dual, and malformed target wires', () => {
    const sampler = { input: [0], output: [0, 0, 0], interpolation: 'LINEAR' };
    const loadChannel = (channel: Record<string, unknown>) =>
      animationClipLoader.load(
        { channels: [{ ...channel, property: 'translation', sampler }] },
        undefined,
        emptyCtx,
      );

    expect(loadChannel({ targetPath: ['root'] })).toBeUndefined();
    expect(
      loadChannel({
        targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
        targetPath: ['root'],
      }),
    ).toBeUndefined();
    expect(loadChannel({ targetId: 'A95DA0EC669159F98273E8F86D8AD9F2' })).toBeUndefined();
    expect(loadChannel({ targetId: 'a95da0ec669159f98273e8f86d8ad9f' })).toBeUndefined();
  });

  it('rejects a bad property / missing sampler / bad interpolation', () => {
    expect(
      animationClipLoader.load(
        { channels: [{ targetId: 'a95da0ec669189f98273e8f86d8ad9f2', property: 'bogus' }] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
    expect(
      animationClipLoader.load(
        { channels: [{ targetId: 'a95da0ec669189f98273e8f86d8ad9f2', property: 'scale' }] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
    expect(
      animationClipLoader.load(
        {
          channels: [
            {
              targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
              property: 'scale',
              sampler: { input: [0], output: [0], interpolation: 'CUBIC' },
            },
          ],
        },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('rejects a non-array channels payload', () => {
    expect(animationClipLoader.load({ channels: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });
});

describe('wireDefaultLoaders / createDefaultLoaderRegistry', () => {
  it('loads a serialised sampler descriptor', () => {
    expect(
      samplerLoader.load(
        { addressModeU: 'repeat', magFilter: 'linear', maxAnisotropy: 16 },
        undefined,
        emptyCtx,
      ),
    ).toEqual({
      kind: 'sampler',
      addressModeU: 'repeat',
      magFilter: 'linear',
      maxAnisotropy: 16,
    });
    expect(samplerLoader.load({ addressModeU: 'invalid' }, undefined, emptyCtx)).toBeUndefined();
    expect(samplerLoader.load({ maxAnisotropy: '16' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('keeps animation graph loader in assets-runtime', () => {
    expect(animationGraphLoader.kind).toBe('animation-graph');
  });
  it('wires the engine default kinds and leaves shader unregistered', () => {
    const reg = wireDefaultLoaders(new LoaderRegistry());
    for (const kind of [
      'mesh',
      'scene',
      'sampler',
      'material',
      'skeleton',
      'skin',
      'animation-clip',
      'texture',
      'font',
      'equirect',
      'video',
    ]) {
      expect(reg.get(kind)).toBeDefined();
    }
    expect(reg.get('shader')).toBeUndefined();
  });

  it('selects an explicit host owner before default seeding', () => {
    const audio = { kind: 'audio', load: () => undefined } as never;
    const reg = wireDefaultLoaders(new LoaderRegistry(), [audio]);
    expect(reg.get('audio')).toBe(audio);
  });

  it('createDefaultLoaderRegistry returns a fresh pre-wired registry', () => {
    const reg = createDefaultLoaderRegistry();
    expect(reg.get('mesh')).toBeDefined();
    expect(INLINE_PACK_LOADERS.length).toBe(12); // ordinary inline loader matrix
  });
});

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
