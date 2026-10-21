import { type CookedMaterialRecord, serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  createRuntimePackPublication,
  encodeMaterialProgramWire,
} from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ArtifactDescriptor, MaterialAsset, MaterialParameter } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssetReference, runtimeAssets } from '../internal';
import { MaterialGenerationCache } from '../material/generation-cache';
import { inspectMaterialRuntime } from '../material/inspection.js';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import {
  assertMaterialStaticSelection,
  materialParametersToParamSchema,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '../material/runtime-shader.js';
import {
  MATERIAL_CONTEXT,
  materialPublicationFixture,
  materialRecordFixture,
} from './fixtures/material-publication.js';

function parseGuid(value: string) {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}

function projection(registry: AssetRegistry, guid: string) {
  const handle = runtimeAssetReference(registry, guid);
  if (handle === undefined) throw new Error('missing accepted material');
  return registry.getMaterialProjectionForPayload(
    runtimeAssets(registry).borrow<MaterialAsset>(handle).unwrap(),
  );
}

function load(publication: MaterialPublication | undefined, references = true) {
  return createMaterialLoader({
    loadPublication: async () => publication,
    loadReference: async () => references,
  }).load({
    guid: publication?.guid ?? 'missing',
    specializationKey:
      (publication?.record as CookedMaterialRecord | undefined)?.specializationKey ?? 'missing',
  });
}

async function withPack(
  record: CookedMaterialRecord,
  transport: 'inline' | 'hex' | 'base64' | 'finalized' | 'shared',
  run: (registry: AssetRegistry, shaders: ShaderRegistry) => Promise<void>,
  cooked = true,
) {
  return withPackRecords([record], transport, run, cooked);
}

async function withPackRecords(
  records: readonly CookedMaterialRecord[],
  transport: 'inline' | 'hex' | 'base64' | 'finalized' | 'shared',
  run: (registry: AssetRegistry, shaders: ShaderRegistry) => Promise<void>,
  cooked = true,
) {
  const first = records[0];
  if (first === undefined) throw new Error('material pack fixture requires one record');
  const packageUrl = '/materials/water-materials.pack.json';
  const descriptors: Record<string, ArtifactDescriptor> = {};
  if (transport === 'hex' || transport === 'base64')
    for (const record of records)
      for (const { artifact } of record.programs)
        descriptors[artifact.path] = {
          path: artifact.path,
          mediaType: artifact.mediaType,
          contentEncoding: 'identity',
          byteLength: artifact.bytes.byteLength,
          integrity: {
            algorithm: 'sha256',
            digest:
              transport === 'hex'
                ? artifact.digest
                : Buffer.from(artifact.digest.slice(7), 'hex').toString('base64'),
          },
        };
  const inlinePack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: records.map((record) => ({
      guid: record.guid,
      kind: 'material',
      payload: {
        kind: 'material',
        ...record.resolved,
        ...(cooked ? { cooked: JSON.parse(serializeCookedMaterialRecord(record)) } : {}),
      },
      refs: [],
      artifacts: descriptors,
    })),
  };
  const pack =
    transport === 'finalized'
      ? (
          await finalizePackageTransportSource(
            {
              assets: inlinePack.assets.map((asset) => ({
                ...asset,
                artifacts: Object.fromEntries(
                  records.flatMap((record) =>
                    record.programs.map(
                      ({ artifact }) =>
                        [
                          artifact.path,
                          { mediaType: artifact.mediaType, bytes: artifact.bytes },
                        ] as const,
                    ),
                  ),
                ),
              })),
            },
            {
              base: '/',
              packagePath: packageUrl.slice(1),
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          )
        ).pack
      : inlinePack;
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'materials.pack',
    sourceRevision: 'fixture',
    packageUrl,
    pack: { assets: pack.assets },
  });
  const body =
    transport === 'shared' ? encodeMaterialProgramWire(publication.pack) : publication.pack;
  if (transport === 'shared')
    expect(body).toMatchObject({ schemaVersion: 'pack-material-programs/1' });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/pack-index.json'))
      return new Response(
        JSON.stringify(
          records.map((record) => ({
            guid: record.guid,
            packageUrl,
            kind: 'material',
            sourcePath: 'materials.pack',
            publication: publication.publication,
          })),
        ),
      );
    if (url.endsWith('.pack.json')) return new Response(JSON.stringify(body));
    const program = records
      .flatMap((record) => record.programs)
      .find(({ artifact }) => url.endsWith(artifact.path));
    if (program !== undefined) return new Response(new Uint8Array(program.artifact.bytes));
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Loader must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  try {
    const registry = new AssetRegistry({ shaderRegistry: shaders });
    registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    registry.configurePackIndex('/pack-index.json');
    await run(registry, shaders);
    expect(fetcher).toHaveBeenCalled();
    if (transport === 'finalized') {
      for (const record of records)
        for (const { artifact } of record.programs) {
          expect(
            fetcher.mock.calls.some(([url]) =>
              String(url).endsWith(`${record.guid}/${artifact.path}`),
            ),
          ).toBe(true);
        }
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('material runtime readiness', () => {
  it('loads shared program metadata through the public GUID path with distinct material values', async () => {
    const parameters = [{ name: 'roughness', type: 'f32' as const, default: 0.5 }];
    const first = materialRecordFixture({
      guid: '019f0000-0000-7000-8000-000000000711',
      parameters,
      values: { roughness: 0.2 },
    });
    const second = materialRecordFixture({
      guid: '019f0000-0000-7000-8000-000000000712',
      parameters,
      values: { roughness: 0.8 },
    });
    await withPackRecords([first, second], 'shared', async (registry) => {
      const a = await registry.load(first.guid, 'material');
      const b = await registry.load(second.guid, 'material');
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      expect(projection(registry, first.guid)).toMatchObject({
        artifactHash: first.artifactDigest,
      });
      expect(projection(registry, second.guid)).toMatchObject({
        artifactHash: second.artifactDigest,
      });
      expect(
        runtimeAssets(registry).borrow<MaterialAsset>(a.unwrap()).unwrap().values?.roughness,
      ).toBe(0.2);
      expect(
        runtimeAssets(registry).borrow<MaterialAsset>(b.unwrap()).unwrap().values?.roughness,
      ).toBe(0.8);
    });
  });
  it('retains the float-data texture contract across runtime projection', () => {
    expect(
      materialParametersToParamSchema([
        { name: 'lookup', type: 'texture', sampleType: 'unfilterable-float' },
      ]),
    ).toEqual([{ name: 'lookup', type: 'texture2d', sampleType: 'unfilterable-float' }]);
  });

  it('preserves root declarations and numeric defaults without Standard injection', () => {
    expect(
      materialParametersToParamSchema([
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'roughness', type: 'f32', default: 0.5 },
        { name: 'baseColorTexture', type: 'texture' },
      ]),
    ).toEqual([
      { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
      { name: 'roughness', type: 'f32', default: 0.5 },
      { name: 'baseColorTexture', type: 'texture2d' },
    ]);
    expect(
      materialParametersToParamSchema([
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
      ]),
    ).toHaveLength(1);
  });

  it('rejects boolean parameters instead of silently dropping them from the ABI', () => {
    expect(() =>
      materialParametersToParamSchema(
        [{ name: 'useClearcoat', type: 'bool', default: false }],
        'material/bool',
      ),
    ).toThrow('material-parameter-type-unsupported');
    try {
      materialParametersToParamSchema([{ name: 'useClearcoat', type: 'bool' }], 'material/bool');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-parameter-type-unsupported',
        detail: {
          stage: 'runtime',
          material: 'material/bool',
          parameter: 'useClearcoat',
        },
      });
    }
  });

  it('loads independent scalar map references, channels and coordinates without repacking', async () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'metallicTexture', type: 'texture' },
      { name: 'roughnessTexture', type: 'texture' },
      { name: 'alphaTexture', type: 'texture' },
      { name: 'metallicChannel', type: 'f32', default: 2 },
      { name: 'roughnessChannel', type: 'f32', default: 1 },
      { name: 'alphaChannel', type: 'f32', default: 1 },
    ];
    const record = materialRecordFixture({
      parameters,
      values: {
        metallicTexture: { texture: 'texture/metallic' },
        roughnessTexture: {
          texture: 'texture/roughness',
          coordinates: { set: 1, transform: { offset: [0.5, 0], scale: [2, 1] } },
        },
        alphaTexture: { texture: 'texture/alpha' },
        metallicChannel: 0,
        roughnessChannel: 3,
        alphaChannel: 0,
      },
    });
    const ready = await load(materialPublicationFixture(record));
    expect(ready.status).toBe('Ready');
    if (ready.status !== 'Ready') throw new Error('Expected Ready');
    expect(ready.record.parameterContract).toEqual(record.parameterContract);
    expect(inspectMaterialRuntime(ready).parameterContract).toEqual(record.parameterContract);
  });

  it('preserves transmission, IOR, attenuation and texture declarations in the published snapshot', async () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'transmission', type: 'f32', default: 0 },
      { name: 'ior', type: 'f32', default: 1.5 },
      { name: 'thickness', type: 'f32', default: 0 },
      { name: 'attenuationColor', type: 'vec3', default: [1, 1, 1] },
      { name: 'attenuationDistance', type: 'f32' },
      { name: 'transmissionTexture', type: 'texture' },
      { name: 'thicknessTexture', type: 'texture' },
    ];
    const record = materialRecordFixture({
      parameters,
      values: {
        transmission: 0.8,
        ior: 1.45,
        thickness: 0.25,
        attenuationColor: [0.9, 0.95, 1],
        attenuationDistance: 4,
        transmissionTexture: { texture: 'texture/transmission' },
        thicknessTexture: { texture: 'texture/thickness' },
      },
    });
    const ready = await load(materialPublicationFixture(record));
    expect(ready.status).toBe('Ready');
    if (ready.status !== 'Ready') throw new Error('Expected Ready');
    expect(ready.record.parameterContract).toEqual(record.parameterContract);
    expect(inspectMaterialRuntime(ready).parameterContract).toEqual(record.parameterContract);
    expect(materialParametersToParamSchema(parameters).map((parameter) => parameter.type)).toEqual([
      'f32',
      'f32',
      'f32',
      'vec3',
      'f32',
      'texture2d',
      'texture2d',
    ]);
  });

  it('reports Standard layer presence and zero factors without classifying custom receipts', async () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ];
    const standard = materialRecordFixture({
      parameters,
      values: { clearcoat: 0 },
      passes: [
        { name: 'forward', program: { module: 'forgeax_material::standard' } },
        { name: 'shadow-caster', program: { module: 'forgeax_material::standard' } },
      ],
    });
    const ready = await load(materialPublicationFixture(standard));
    expect(inspectMaterialRuntime(ready)).toMatchObject({
      readiness: 'ready',
      standard: {
        mode: 'physical',
        layers: [{ name: 'clearcoat', parameters: ['clearcoat', 'clearcoatRoughness'] }],
        passFamily: ['forward', 'shadow'],
      },
      parameterContract: { values: { clearcoat: 0 } },
    });
    const custom = await load(
      materialPublicationFixture(materialRecordFixture({ parameters, values: { clearcoat: 0 } })),
    );
    expect(custom.status).toBe('Ready');
    if (custom.status !== 'Ready') throw new Error('Expected Ready');
    expect(inspectMaterialRuntime(custom).standard).toBeUndefined();
  });

  it('requires a complete publication and all references before Ready', async () => {
    const record = materialRecordFixture();
    const ready = await load(materialPublicationFixture(record));
    expect(inspectMaterialRuntime(ready)).toMatchObject({
      materialGuid: record.guid,
      readiness: 'ready',
      publicationGeneration: 7,
      artifactDigest: record.artifactDigest,
      sourceClosure: record.sourceClosure,
    });
    const referenced = { ...record, refs: { ...record.refs, textures: ['texture/missing'] } };
    expect(await load(materialPublicationFixture(referenced), false)).toMatchObject({
      status: 'Error',
      error: { code: 'material-reference-not-ready' },
    });
    expect(await load(undefined)).toMatchObject({
      status: 'Error',
      error: { code: 'material-specialization-not-cooked' },
    });
  });

  it('rejects missing bytes, corrupt bytes and incomplete publication identities', async () => {
    const record = materialRecordFixture();
    const publication = materialPublicationFixture(record);
    expect(await load({ ...publication, artifacts: {} })).toMatchObject({
      status: 'Error',
      error: { code: 'asset-artifact-missing' },
    });
    const artifacts = Object.fromEntries(
      record.programs.map(({ artifact }) => [
        artifact.path,
        { bytes: new TextEncoder().encode('tampered') },
      ]),
    );
    expect(await load({ ...publication, artifacts })).toMatchObject({
      status: 'Error',
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
    expect(
      await load({ ...publication, record: { ...record, publicationGeneration: undefined } }),
    ).toMatchObject({ status: 'Error', error: { code: 'material-cook-record-invalid' } });
  });

  it('keeps publication generations distinct in the cache', async () => {
    const cache = new MaterialGenerationCache();
    let calls = 0;
    const loader = async () => ++calls;
    expect(await cache.resolve('material', 'program', loader, 7)).toBe(1);
    expect(await cache.resolve('material', 'program', loader, 8)).toBe(2);
  });

  it.each([
    'inline',
    'hex',
    'finalized',
  ] as const)('loads every program through GUID and %s transport without registering authored module IDs', async (transport) => {
    const record = materialRecordFixture({
      passes: [
        { name: 'Forward', program: { module: 'game::forward' } },
        { name: 'ShadowCaster', program: { module: 'game::shadow' } },
      ],
    });
    await withPack(record, transport, async (registry, shaders) => {
      const loaded = await registry.load(record.guid, 'material');
      expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
      expect(projection(registry, record.guid)).toMatchObject({
        artifactHash: record.artifactDigest,
      });
      for (const program of record.programs)
        expect(shaders.findMaterialArtifact(program.specializationKey)).toMatchObject({
          ok: true,
          value: { source: new TextDecoder().decode(program.artifact.bytes) },
        });
      for (const pass of record.resolved.passes)
        expect(shaders.findMaterialArtifact(pass.program.module).ok).toBe(false);
    });
  });

  it('rejects noncanonical Pack artifact digests before Material admission', async () => {
    const record = materialRecordFixture();
    await withPack(record, 'base64', async (registry, shaders) => {
      expect(await registry.load(record.guid, 'material')).toMatchObject({
        ok: false,
        error: { code: 'asset-package-invalid' },
      });
      for (const program of record.programs)
        expect(shaders.findMaterialArtifact(program.specializationKey).ok).toBe(false);
    });
  });

  it('loads two independently authored medium Surface assets by stable GUID from one JSON pack', async () => {
    const dynamicInput = {
      name: 'waterEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' },
        { name: 'time', type: 'f32' },
      ],
      maxRecords: 8,
      maxDomains: 2,
      maxPageBytes: 256,
      maxBindings: 1,
      maxEventsPerSample: 4,
    } as const;
    const first = materialRecordFixture({
      guid: '019f0000-0000-7000-8000-000000000702',
      passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
      surface: {
        model: 'single-layer-medium',
        module: 'game::water_surface_a',
        dynamicInput,
      },
    });
    const second = materialRecordFixture({
      guid: '019f0000-0000-7000-8000-000000000703',
      passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
      surface: {
        model: 'single-layer-medium',
        module: 'game::water_surface_b',
        dynamicInput,
      },
    });
    await withPackRecords([first, second], 'inline', async (registry) => {
      expect(await registry.load(first.guid, 'material')).toMatchObject({ ok: true });
      expect(await registry.load(second.guid, 'material')).toMatchObject({ ok: true });
      expect(projection(registry, first.guid)?.surface).toMatchObject({
        model: 'single-layer-medium',
        module: 'game::water_surface_a',
      });
      expect(projection(registry, second.guid)?.surface).toMatchObject({
        model: 'single-layer-medium',
        module: 'game::water_surface_b',
      });
    });
  });

  it('loads inline cooked Engine templates and selects backend-specific programs by context', async () => {
    const fallback = {
      ...MATERIAL_CONTEXT,
      backend: 'webgl2' as const,
      capability: 'uniform-fallback' as const,
    };
    const record = materialRecordFixture({
      passes: [
        {
          name: 'Forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'game::surface' },
          },
        },
      ],
      contexts: [MATERIAL_CONTEXT, fallback],
    });
    await withPack(record, 'inline', async (registry, shaders) => {
      const loaded = await registry.load(record.guid, 'material');
      expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
      const projected = projection(registry, record.guid);
      if (projected === undefined) throw new Error('Missing projection');
      const native = selectMaterialPassProgram(projected, 'Forward', MATERIAL_CONTEXT);
      const downlevel = selectMaterialPassProgram(projected, 'Forward', fallback);
      expect(native.specializationKey).not.toBe(downlevel.specializationKey);
      expect(shaders.findMaterialArtifact(native.specializationKey).ok).toBe(true);
      expect(shaders.findMaterialArtifact(downlevel.specializationKey).ok).toBe(true);
    });
  });

  it('does not treat a modern publication without an explicit address as direct', () => {
    const record = materialRecordFixture();
    const program = record.programs[0];
    if (program === undefined || program.selections[0] === undefined)
      throw new Error('material fixture program is missing');
    const projection = projectMaterialRecord({
      ...record,
      programs: [
        {
          ...program,
          selections: [
            {
              ...program.selections[0],
              entry: 'vs_main',
              abi: {
                directEntry: 'vs_main',
                sceneIndexEntry: 'vs_scene_index',
                materialRow: { addressUnitBytes: 16, byteLength: 16, fields: [] },
                resourceSlots: [],
                uvSets: [],
                vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
                alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
                reflection: {
                  layoutIdentity: 'layout',
                  resourceSlots: [],
                  vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
                },
                receiptIdentity: 'layout',
                generation: 1,
              },
            },
          ],
        },
      ],
    });
    expect(() => selectMaterialPassProgram(projection, 'Forward', MATERIAL_CONTEXT)).toThrow(
      'no unique published program',
    );
  });

  it('keeps the Engine builtin route available without a cooked publication', async () => {
    const record = materialRecordFixture({
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    });
    await withPack(
      record,
      'inline',
      async (registry) => {
        expect(await registry.load(record.guid, 'material')).toMatchObject({
          ok: true,
        });
        expect(projection(registry, record.guid)).toBeUndefined();
      },
      false,
    );
  });
});

describe('static publication selection', () => {
  it('rejects a changed choice against an already compiled publication', () => {
    const projection = projectMaterialRecord({
      ...materialRecordFixture(),
      resolved: {
        ...materialRecordFixture().resolved,
        staticSwitches: { textures: false },
      },
    });
    expect(() => assertMaterialStaticSelection({ textures: false }, projection)).not.toThrow();
    expect(() => assertMaterialStaticSelection({ textures: true }, projection)).toThrowError(
      expect.objectContaining({ code: 'material-specialization-not-cooked' }),
    );
  });
  it('admits inherited programs during creation and refuses an unpublished child switch', async () => {
    const base = materialRecordFixture();
    const record = {
      ...base,
      authored: {
        kind: 'material',
        passes: base.resolved.passes as NonNullable<MaterialAsset['passes']>,
        parameters: base.resolved.parameters,
        values: base.resolved.values,
        staticSwitches: { textures: false },
      } satisfies MaterialAsset,
      resolved: { ...base.resolved, staticSwitches: { textures: false } },
    };
    await withPack(record, 'inline', async (registry) => {
      const parentHandle = (await registry.load(record.guid, 'material')).unwrap();
      const parent = runtimeAssets(registry).borrow<MaterialAsset>(parentHandle).unwrap();
      expect(parent?.kind).toBe('material');
      const child = registry
        .create({
          kind: 'material',
          parent: parseGuid(record.guid),
          values: {},
        })
        .unwrap();
      expect(registry.read(child).unwrap().parent).toBeUndefined();
      expect(
        registry.create({
          kind: 'material',
          parent: parseGuid(record.guid),
          staticSwitches: { textures: false },
        }).ok,
      ).toBe(true);
      const unpublished = registry.create({
        kind: 'material',
        parent: parseGuid(record.guid),
        staticSwitches: { textures: true },
      });
      expect(unpublished.ok).toBe(false);
      if (!unpublished.ok)
        expect(unpublished.error.code).toBe('material-specialization-not-cooked');
    });
  });
});
