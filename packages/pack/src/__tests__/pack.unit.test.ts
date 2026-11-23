import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackErrorCode, PackErrorDetail } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasImageInput } from '../atlas/shelf-pack.js';
import { shelfPack } from '../atlas/shelf-pack.js';
import { PackError } from '../errors.js';
import { AssetGuid, PackageId } from '../guid.js';
import { createFileSystemPackAuthoringGateway } from '../pack-authoring-node.js';
import { validateProducerContract, validateProducerOutputs } from '../producer-contract.js';
import { scan } from '../scanner.js';
import { validateMeta, validatePackV2 } from '../schema-compiled.js';
import { metaFixture } from './support/direct-pack-fixture.js';

async function scanPaths(roots: string[]): Promise<string[]> {
  const result = await scan(roots);
  if (!result.ok) throw new Error(`scan failed unexpectedly: ${result.error.code}`);
  return result.value;
}

async function verifyInventory(root: string) {
  const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
  return (await gateway.execute({ operation: 'asset.verify', requestId: 'verify' })).unwrap();
}

describe('w4 producer conformance matrix', () => {
  const providers = [
    ['gltf', 'scene'],
    ['image', 'texture'],
    ['fbx', 'mesh'],
    ['audio', 'audio'],
    ['font', 'font'],
    ['host-fixture', 'host/blob'],
  ] as const;

  it('accepts every built-in importer and one open host provider through one contract', () => {
    for (const [provider, kind] of providers) {
      const result = validateProducerContract({
        packageId: `pkg/${provider}`,
        provenance: { provider, version: '1.0.0' },
        revision: { digest: `sha256:${provider}`, observedAt: 1, rootId: 'root-a' },
        sourceKey: `${provider}:main`,
        sourceIndex: 0,
        kind,
      });
      expect(result.ok, provider).toBe(true);
    }
  });

  it('returns structured ambiguity for a multi-output provider without keys', () => {
    const result = validateProducerOutputs([
      { guid: 'a', kind: 'host/blob', sourceIndex: 0 },
      { guid: 'b', kind: 'host/blob', sourceIndex: 1 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('source-index-ambiguous');
  });
});

const VALID_HELLO_GLTF_META = {
  schemaVersion: 1,
  kind: 'external-asset-package',
  importer: 'gltf',
  source: 'box.gltf',
  importSettings: {
    defaultSceneIndex: 0,
    diagnostics: {
      matrixTrsCoexistNodes: [],
      nodeNames: ['Box', 'MainCamera'],
      unsupportedExtensions: [],
    },
  },
  subAssets: [
    { guid: '019e2b88-aece-7b6e-bbfe-45d6453d21f3', kind: 'mesh', sourceIndex: 0 },
    { guid: '019e2b88-aecf-7e78-9888-655f0ec62ebc', kind: 'material', sourceIndex: 0 },
    { guid: '019e2b88-aecf-7e78-9888-6560222ee28a', kind: 'scene', sourceIndex: 0 },
  ],
};

describe('glTF Meta schema', () => {
  it.each([
    1,
    '1.0.0',
  ])('accepts the importer-emitted shape with schema version %s', (schemaVersion) => {
    expect(validateMeta({ ...VALID_HELLO_GLTF_META, schemaVersion })).toBe(true);
    expect(validateMeta.errors).toBeNull();
  });

  it('diagnoses the misspelled source index', () => {
    const [mesh] = VALID_HELLO_GLTF_META.subAssets;
    expect(
      validateMeta({
        ...VALID_HELLO_GLTF_META,
        subAssets: [{ guid: mesh.guid, kind: mesh.kind, sourceIndx: mesh.sourceIndex }],
      }),
    ).toBe(false);
    expect(
      validateMeta.errors?.some(
        ({ keyword }) => keyword === 'required' || keyword === 'additionalProperties',
      ),
    ).toBe(true);
  });

  it.each([
    [undefined, 'required'],
    ['', 'minLength'],
  ])('rejects importer %j', (importer, keyword) => {
    const { importer: _original, ...rest } = VALID_HELLO_GLTF_META;
    expect(validateMeta(importer === undefined ? rest : { ...rest, importer })).toBe(false);
    expect(validateMeta.errors).toContainEqual(expect.objectContaining({ keyword }));
  });

  it.each([
    'image',
    'gltf',
    'audio',
    'font',
    'video',
  ])('accepts importer %s and custom nested settings', (importer) => {
    expect(
      validateMeta({
        ...VALID_HELLO_GLTF_META,
        importer,
        importSettings: {
          ...VALID_HELLO_GLTF_META.importSettings,
          compression: 'zstd',
          diagnostics: {
            ...VALID_HELLO_GLTF_META.importSettings.diagnostics,
            extension: { present: true },
          },
        },
      }),
    ).toBe(true);
  });
});

describe('material inventory and deferred cook validation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pack-material-inventory-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const cases = {
    valid: { name: 'valid', kind: 'material', paramSchema: [{ name: 'roughness', type: 'f32' }] },
    deferred: { name: 'deferred', kind: 'material', paramSchema: [{ name: 'x', type: 'boolean' }] },
    texture: { name: 'texture', kind: 'texture' },
  };
  const { valid, deferred, texture } = cases;

  it.each([
    { inputs: [valid], materialCount: 1 },
    { inputs: [deferred], materialCount: 1 },
    { inputs: [texture], materialCount: 0 },
    { inputs: [valid, deferred], materialCount: 2 },
    { inputs: [valid, texture], materialCount: 1 },
  ])('inventories $inputs and counts $materialCount material outputs', async ({
    inputs,
    materialCount,
  }) => {
    const paths = inputs.map(({ name }) => join(root, `${name}.pack.json`));
    for (const [index, { name, kind, paramSchema }] of inputs.entries()) {
      await writeFile(
        paths[index],
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: `aa000000-0000-4000-8000-00000000000${index + 1}`,
          assets: {
            [name]: {
              kind,
              refs: [],
              payload:
                paramSchema === undefined
                  ? {}
                  : { materialShader: 'forgeax::default-standard-pbr', paramSchema, values: {} },
            },
          },
        }),
      );
    }
    const entries = await scanPaths([root]);
    expect(entries).toEqual(expect.arrayContaining(paths));
    expect(entries).toHaveLength(paths.length);
    expect((await verifyInventory(root)).summary?.materialCount).toBe(materialCount);
  });
});

describe('shelfPack', () => {
  function image(name: string, width: number, height: number): AtlasImageInput {
    return { name, width, height, pixels: new Uint8Array(width * height * 4) };
  }

  it.each([
    [
      '100 uniform sprites',
      Array.from({ length: 100 }, (_, i) => image(`s${String(i).padStart(3, '0')}`, 32, 32)),
    ],
    [
      'mixed sprite sizes',
      [
        image('big-128', 128, 128),
        image('mid-64', 64, 64),
        image('mid-64-b', 64, 64),
        image('small-32', 32, 32),
        image('small-32-b', 32, 32),
        image('tall-32x96', 32, 96),
      ],
    ],
  ] as const)('places %s completely inside a nonoverlapping atlas', (_name, inputs) => {
    const result = shelfPack(inputs, { maxAtlasSize: 4096 });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { atlasWidth, atlasHeight, regions } = result.value;
    expect(regions).toHaveLength(inputs.length);
    expect(atlasWidth).toBeLessThanOrEqual(4096);
    expect(atlasHeight).toBeLessThanOrEqual(4096);
    expect(atlasWidth * atlasHeight).toBeGreaterThanOrEqual(
      inputs.reduce((area, item) => area + item.width * item.height, 0),
    );
    const expected = new Map(inputs.map(({ name, width, height }) => [name, [width, height]]));
    for (const [index, region] of regions.entries()) {
      const { name, x, y, w, h } = region;
      expect([w, h]).toEqual(expected.get(name));
      expected.delete(name);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(atlasWidth);
      expect(y + h).toBeLessThanOrEqual(atlasHeight);
      for (const other of regions.slice(index + 1))
        expect(
          x < other.x + other.w && other.x < x + w && y < other.y + other.h && other.y < y + h,
        ).toBe(false);
    }
  });

  it('returns structured errors for empty and oversized inputs', () => {
    expect(shelfPack([], { maxAtlasSize: 4096 })).toMatchObject({
      ok: false,
      error: { code: 'atlas-empty-input', detail: { receivedCount: 0 } },
    });
    expect(shelfPack([image('giant', 5000, 5000)], { maxAtlasSize: 4096 })).toMatchObject({
      ok: false,
      error: {
        code: 'atlas-size-exceeded',
        detail: { name: 'giant', width: 5000, height: 5000, maxAtlasSize: 4096 },
      },
    });
  });
});

describe('structured Pack errors', () => {
  const metaPath = 'assets/scene.gltf.meta.json';
  const guid = '018e7a4d-1234-7abc-8def-000000000001';
  const issue = { instancePath: '/guid', message: 'must match UUID format' };
  const cases = [
    ['pack-malformed-meta', { path: metaPath, ajvErrors: [issue] }],
    ['pack-malformed-pack', { path: 'assets/scene.pack.json', ajvErrors: [issue] }],
    ['pack-guid-malformed', { raw: 'not-a-uuid', reason: 'invalid spelling' }],
    ['pack-orphan-meta', { metaPath, expectedFile: 'assets/scene.gltf' }],
    ['pack-meta-missing', { filePath: 'assets/scene.gltf' }],
    ['pack-guid-collision', { paths: ['assets/a.pack.json', 'assets/b.pack.json'], guid }],
    ['pack-cyclic-reference', { cycle: [guid, 'sibling', guid] }],
    ['pack-subasset-index-out-of-range', { metaPath, sourceIndex: 5, max: 3 }],
  ] satisfies readonly (readonly [PackErrorCode, PackErrorDetail])[];

  it.each(cases)('preserves the code, recovery and details for %s', (code, detail) => {
    const expected = 'a valid Pack declaration';
    const hint = 'repair it and rescan';
    expect(new PackError({ code, detail, expected, hint })).toMatchObject({
      code,
      detail,
      expected,
      hint,
    });
  });
});

describe('scanner rejects conflicting or invalid authored sources', () => {
  const A = '018e7a4d-1234-7abc-8def-000000000001';
  const B = '018e7a4d-1234-7abc-8def-000000000002';
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scanner-fail-fast-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  function pack(name: string, packageId: string, refs: string[] = []) {
    return writeFile(
      join(root, `${name}.pack.json`),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { 'mesh/main': { kind: 'mesh', payload: {}, refs } },
      }),
    );
  }

  it('reports colliding package identities with both paths', async () => {
    await Promise.all([pack('a', A), pack('b', A)]);
    expect(await scan([root])).toMatchObject({
      ok: false,
      error: {
        code: 'pack-guid-collision',
        detail: {
          guid: A,
          paths: expect.arrayContaining([join(root, 'a.pack.json'), join(root, 'b.pack.json')]),
        },
      },
    });
  });

  it('reports the closed GUID cycle in direct Pack refs', async () => {
    const parsePackage = (id: string) => {
      const parsed = PackageId.parse(id);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    };
    const ref = (id: string) => AssetGuid.format(AssetGuid.derive(parsePackage(id), 'mesh/main'));
    await Promise.all([pack('a', A, [ref(B)]), pack('b', B, [ref(A)])]);
    const result = await scan([root]);
    if (result.ok || result.error.code !== 'pack-cyclic-reference')
      throw new Error('expected a Pack reference cycle');
    const { cycle } = result.error.detail;
    expect(cycle).toHaveLength(3);
    expect(cycle[0]).toBe(cycle[2]);
  });

  it('reports invalid subasset evidence before checking the source', async () => {
    const path = join(root, 'hero.png.meta.json');
    await writeFile(
      path,
      metaFixture('hero.png', 'image', [{ sourceIndex: 0, kind: 'TextureAsset' }]),
    );
    const result = await scan([root]);
    if (result.ok || result.error.code !== 'pack-malformed-meta')
      throw new Error('expected invalid Meta');
    expect(result.error.detail.path).toBe(path);
    expect(result.error.detail.ajvErrors.length).toBeGreaterThan(0);
  });
});

describe('scanner.test.ts', () => {
  let sTmpDir: string | undefined;

  afterEach(async () => {
    if (sTmpDir !== undefined) {
      await rm(sTmpDir, { recursive: true, force: true });
      sTmpDir = undefined;
    }
  });

  async function setupTmpDir(): Promise<string> {
    sTmpDir = await mkdtemp(join(tmpdir(), 'engine-pack-scanner-test-'));
    return sTmpDir;
  }

  describe('scan - empty directory', () => {
    it('returns empty array for an empty directory', async () => {
      const root = await setupTmpDir();
      const results = await scanPaths([root]);
      expect(results).toEqual([]);
    });
  });

  it('discovers Meta and direct Pack sources in subdirectories', async () => {
    const root = await setupTmpDir();
    const directory = join(root, 'assets');
    await mkdir(directory);
    const meta = await writeImageMeta(directory);
    const pack = join(directory, 'assets.pack.json');
    await writeFile(
      pack,
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '018e7a4d-1234-7abc-8def-000000000001',
        assets: {},
      }),
    );
    expect((await scanPaths([root])).sort()).toEqual([meta, pack].sort());
  });

  it.each([
    ['node_modules', 'lib.meta.json'],
    ['.git', 'hooks.meta.json'],
    ['dist', 'bundle.pack.json'],
    ['.forgeax-harness', 'state.meta.json'],
    ['.forgeax', 'game.meta.json'],
  ])('skips %s during automatic traversal', async (name, file) => {
    const directory = join(await setupTmpDir(), name);
    await mkdir(directory);
    await writeFile(join(directory, file), JSON.stringify({ test: true }));
    expect(await scanPaths([sTmpDir])).toEqual([]);
  });

  it('scans an ignored directory when given as an explicit root', async () => {
    const directory = join(await setupTmpDir(), 'node_modules');
    await mkdir(directory);
    const meta = await writeImageMeta(directory);
    expect(await scanPaths([directory])).toEqual([meta]);
  });

  async function writeImageMeta(directory: string) {
    const path = join(directory, 'image.png.meta.json');
    await writeFile(join(directory, 'image.png'), 'fake png');
    await writeFile(path, metaFixture('image.png', 'image', []));
    return path;
  }

  it.each([
    [
      'valid',
      [
        { name: 'color', type: 'color' },
        { name: 'intensity', type: 'f32' },
      ],
    ],
    ['missing', undefined],
    ['legacy type', [{ name: 'color', type: 'float4' }]],
    ['legacy shape', [{ type: 'color' }]],
    ['empty', []],
  ])('ignores %s material parameter schema on a shader sidecar', async (_label, paramSchema) => {
    const root = await setupTmpDir();
    await writeFile(join(root, 'test.wgsl'), '// shader');
    await writeFile(
      join(root, 'test.material.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'shader',
        source: 'test.wgsl',
        importSettings: { materialShaderIdentifier: 'test::shader' },
        subAssets: [
          {
            guid: '00000000-0000-4000-a000-000000000001',
            sourceIndex: 0,
            kind: 'material-shader',
          },
        ],
        paramSchema,
      }),
    );
    expect((await verifyInventory(root)).summary?.materialCount).toBe(0);
  });
});

describe('Meta and Pack schema validation', () => {
  const meshGuid = '01957b3a-1234-7abc-89de-123456789abc';
  const materialGuid = 'a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6';
  const sceneGuid = 'b2c3d4e5-f6a7-7b8c-9d0e-f1a2b3c4d5e6';
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'hero.png',
    importSettings: { compression: 'zstd', mipmap: true },
  };
  const mesh = { guid: meshGuid, sourceIndex: 0, kind: 'mesh' };
  it.each([
    ['one subasset', [mesh], true],
    ['no subassets', [], true],
    [
      'multiple subassets',
      [
        { ...mesh, guid: materialGuid, kind: 'material' },
        { ...mesh, guid: sceneGuid, kind: 'scene' },
      ],
      true,
    ],
    ['missing GUID', [{ sourceIndex: 0, kind: 'mesh' }], false],
    ['invalid GUID', [{ ...mesh, guid: 'not-a-valid-uuid' }], false],
    ['string source index', [{ ...mesh, sourceIndex: 'zero' }], false],
  ])('validates Meta with %s', (_label, subAssets, valid) => {
    expect(validateMeta({ ...meta, subAssets })).toBe(valid);
  });

  const pack = { schemaVersion: '2.0.0', kind: 'internal-text-package' };
  const asset = { guid: meshGuid, kind: 'MaterialAsset', payload: {}, refs: [materialGuid] };
  it.each([
    ['one asset and refs', [asset], true],
    ['no assets', [], true],
    [
      'multiple assets',
      [asset, { ...asset, guid: materialGuid, kind: 'MeshAsset', refs: [] }],
      true,
    ],
    ['built-in handles in refs', [{ ...asset, refs: ['@builtin/HANDLE_CUBE'] }], false],
    ['invalid GUID', [{ ...asset, guid: 'not-a-valid-uuid' }], false],
    ['missing assets', undefined, false],
  ])('validates Pack with %s', (_label, assets, valid) => {
    expect(validatePackV2(assets === undefined ? pack : { ...pack, assets })).toBe(valid);
  });
});

describe('scanner resolves explicit and companion Meta sources', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-companion-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it.each([
    [undefined, true],
    ['hero.png', true],
    [undefined, false],
    ['hero.png', false],
  ] as const)('scans source=%s with companion present=%s', async (source, present) => {
    const metaPath = join(root, 'hero.png.meta.json');
    const expectedFile = join(root, 'hero.png');
    await writeFile(
      metaPath,
      metaFixture(source, 'image', [
        { guid: 'aaaaaaaa-bbbb-4000-8000-000000000001', sourceIndex: 0, kind: 'texture' },
      ]),
    );
    if (present) await writeFile(expectedFile, 'fake png');
    else await writeFile(join(root, 'uncatalogued.png'), 'fake png');
    const result = await scan([root]);
    if (present) expect(result.ok).toBe(true);
    else
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'pack-orphan-meta',
          detail: { metaPath, expectedFile },
        },
      });
  });
});
