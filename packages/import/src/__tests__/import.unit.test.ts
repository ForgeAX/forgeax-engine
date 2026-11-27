import type {
  Asset,
  ImportContext,
  ImportedAsset,
  Importer,
  ImportResult,
} from '@forgeax/engine-types';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';
import { projectImportPack } from '../pack-value.js';

function stubImporter(key: string): Importer {
  return {
    key,
    import: (_ctx: ImportContext): ImportResult => ({
      ok: true,
      value: { assets: [], sourceDependencies: [] },
    }),
  };
}

const GUID_A = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const GUID_B = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const GUID_UNDECLARED = 'ffffffff-0c86-79da-aa76-b0984c86d45c';

const MESH_POD = {
  kind: 'mesh' as const,
  vertices: new Float32Array(),
  indices: new Uint16Array(),
  attributes: {},
} as unknown as Asset;

function okFs(bytes = new Uint8Array([1, 2, 3])) {
  return {
    readSource: async () => ({ ok: true as const, value: bytes }),
  };
}

function failFs() {
  return {
    readSource: async () => ({ ok: false as const, error: new Error('ENOENT no such file') }),
  };
}

function meta(importer: string, guids: readonly string[]): RunImportMeta {
  return {
    importer,
    source: 'model.gltf',
    subAssets: guids.map((g, i) => ({
      guid: g,
      sourceIndex: i,
      sourceKey: `fixture:mesh:${g}`,
      kind: 'mesh',
    })),
  };
}

function registryWith(
  key: string,
  impl: (ctx: ImportContext) => readonly ImportedAsset[] | Promise<readonly ImportedAsset[]>,
): ImporterRegistry {
  const reg = new ImporterRegistry();
  reg.register({
    key,
    import: async (ctx) => ({
      ok: true,
      value: {
        assets: (await impl(ctx)).map((asset) => ({
          ...asset,
          artifacts:
            (asset as unknown as { artifacts?: Readonly<Record<string, unknown>> }).artifacts ?? {},
        })),
        sourceDependencies: [],
      },
    }),
  });
  return reg;
}

function mesh(guid: string): ImportedAsset {
  return { guid, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} };
}

describe('Import runner', () => {
  it('returns product facts for downstream Pack publication', async () => {
    const ids = [GUID_A, GUID_B];
    const result = await runImport(
      meta('gltf', ids),
      registryWith('gltf', () => ids.map(mesh)),
      okFs(),
    );
    if (!result.ok) throw result.error;
    if ('skipped' in result.value) throw new Error('fixture must produce content');
    expect(result.value.product.assets).toHaveLength(ids.length);
    expect(result.value).not.toHaveProperty('pack');
    const pack = projectImportPack(result.value.product);
    expect(pack.kind).toBe('internal-text-package');
    expect(pack.assets.map(({ guid }) => guid)).toEqual(ids);
  });

  it.each([
    {
      case: 'no produced outputs',
      declared: [GUID_A],
      produced: [],
      code: 'import-produced-no-assets',
      detail: { missingGuids: [GUID_A] },
    },
    {
      case: 'one missing output',
      declared: [GUID_A, GUID_B],
      produced: [GUID_A],
      code: 'import-produced-no-assets',
      detail: { missingGuids: [GUID_B] },
    },
    {
      case: 'undeclared output',
      declared: [GUID_A],
      produced: [GUID_UNDECLARED],
      code: 'guid-mismatch',
      detail: { unexpectedGuids: [GUID_UNDECLARED] },
    },
  ])('rejects $case at the declaration boundary', async ({ declared, produced, code, detail }) => {
    const registry = registryWith('gltf', () => produced.map(mesh));
    expect(await runImport(meta('gltf', declared), registry, okFs())).toMatchObject({
      ok: false,
      error: { code, detail },
    });
  });

  it('reports missing importer registration before reading the source', async () => {
    const registry = new ImporterRegistry();
    registry.register(stubImporter('image'));
    expect(await runImport(meta('gltf', [GUID_A]), registry, okFs())).toMatchObject({
      ok: false,
      error: {
        code: 'importer-not-registered',
        detail: { importer: 'gltf', registeredImporters: ['image'] },
      },
    });
  });

  it('reports a failed Result from the source reader', async () => {
    expect(
      await runImport(
        meta('gltf', [GUID_A]),
        registryWith('gltf', () => [mesh(GUID_A)]),
        failFs(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'source-read-failed', detail: { source: 'model.gltf' } },
    });
  });

  it.each([
    'throw',
    'reject',
  ] as const)('(f2) contains %s source-reader failures and retries the same runner inputs', async (failureMode) => {
    const badSource = 'model.gltf';
    const healthySource = 'healthy-sibling.gltf';
    const secretReason = 'secret source bytes and GUID must stay private';
    const failure = Object.assign(new Error(secretReason), { code: 'EAGAIN' });
    let mode: 'failing' | 'healthy' = 'failing';
    const reads: string[] = [];
    let importerCalls = 0;

    const importer: Importer = {
      key: 'gltf',
      import: async (ctx) => {
        importerCalls += 1;
        const source = await ctx.readSource();
        if (!source.ok) throw new Error('unexpected importer source refusal');
        const guid = ctx.subAssets[0]?.guid ?? GUID_A;
        return { ok: true, value: { assets: [mesh(guid)], sourceDependencies: [] } };
      },
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const fs = {
      readSource: (sourcePath: string) => {
        reads.push(sourcePath);
        if (sourcePath === badSource && mode === 'failing') {
          return failureMode === 'throw'
            ? (() => {
                throw failure;
              })()
            : Promise.reject(failure);
        }
        return Promise.resolve({ ok: true as const, value: new Uint8Array([1, 2, 3]) });
      },
    };
    const badMeta = meta('gltf', [GUID_A]);
    const healthyMeta = { ...meta('gltf', [GUID_B]), source: healthySource };

    const first = await runImport(badMeta, registry, fs);
    expect(first.ok).toBe(false);
    expect(importerCalls).toBe(0);
    expect(reads).toEqual([badSource]);
    if (!first.ok) {
      expect(first.error).toBeInstanceOf(ImportError);
      expect(first.error.code).toBe('source-read-failed');
      expect(first.error.expected).toBe(`readable source file at meta.source "${badSource}"`);
      expect(first.error.hint).toBe(IMPORT_ERROR_HINTS['source-read-failed']);
      expect(first.error.detail).toEqual({ source: badSource, reason: 'transient' });
      expect(JSON.stringify(first.error)).not.toContain(secretReason);
      expect(JSON.stringify(first.error)).not.toContain(GUID_A);
    }

    const healthySibling = await runImport(healthyMeta, registry, fs);
    expect(healthySibling.ok).toBe(true);
    expect(importerCalls).toBe(1);
    if (healthySibling.ok && !('skipped' in healthySibling.value)) {
      expect(healthySibling.value.product.sourceDependencies).toEqual([healthySource]);
      expect(projectImportPack(healthySibling.value.product).assets[0]?.guid).toBe(GUID_B);
    }

    mode = 'healthy';
    const second = await runImport(badMeta, registry, fs);
    const third = await runImport(badMeta, registry, fs);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(importerCalls).toBe(3);
    expect(reads.filter((path) => path === badSource)).toHaveLength(5);
    expect(reads.filter((path) => path === healthySource)).toHaveLength(2);
    if (second.ok && !('skipped' in second.value) && third.ok && !('skipped' in third.value)) {
      expect(second.value.product.sourceDependencies).toEqual([badSource]);
      expect(projectImportPack(second.value.product)).toEqual(
        projectImportPack(third.value.product),
      );
      expect(second.value.cookProducts).toEqual(third.value.cookProducts);
    }
  });

  it('skips reserved shader work and dispatches the selected registered importer', async () => {
    const called: string[] = [];
    const registry = new ImporterRegistry();
    for (const key of ['gltf', 'image', 'shader']) {
      registry.register({
        key,
        import: () => {
          called.push(key);
          return { ok: true, value: { assets: [mesh(GUID_A)], sourceDependencies: [] } };
        },
      });
    }
    expect(await runImport(meta('shader', [GUID_A]), registry, okFs())).toMatchObject({
      ok: true,
      value: { skipped: 'shader' },
    });
    expect((await runImport(meta('image', [GUID_A]), registry, okFs())).ok).toBe(true);
    expect(called).toEqual(['image']);
  });

  it.each([
    {
      name: 'throwing',
      produce: () => {
        throw new Error('boom inside importer');
      },
      error: { code: 'import-internal-error', detail: { reason: 'boom inside importer' } },
    },
    {
      name: 'malformed',
      produce: () => ({ ok: true }) as never,
      error: {
        code: 'import-internal-error',
        hint: expect.stringContaining('branch on err.detail'),
      },
    },
    {
      name: 'structured',
      produce: () => ({
        ok: false as const,
        error: new ImportError({
          code: 'source-read-failed',
          expected: 'a readable source',
          hint: IMPORT_ERROR_HINTS['source-read-failed'],
          detail: { source: 'model.gltf', reason: 'ENOENT' },
        }),
      }),
      error: {
        code: 'source-read-failed',
        detail: { source: 'model.gltf' },
        hint: expect.stringContaining('check the path'),
      },
    },
  ])('keeps $name importer failures structured', async ({ produce, error }) => {
    const registry = new ImporterRegistry();
    registry.register({ key: 'gltf', import: produce });
    expect(await runImport(meta('gltf', [GUID_A]), registry, okFs())).toMatchObject({
      ok: false,
      error,
    });
  });
});
describe('ImporterRegistry', () => {
  it('retains the registered importer and insertion order across rejected replacements', () => {
    const reg = new ImporterRegistry();
    const gltf = stubImporter('gltf');
    expect(reg.get('gltf')).toBeUndefined();
    reg.register(gltf);
    reg.register(stubImporter('image'));
    expect(() => reg.register(stubImporter('gltf'))).toThrow('duplicate importer gltf');
    expect(reg.get('gltf')).toBe(gltf);
    expect(reg.registeredImporters()).toEqual(['gltf', 'image']);
  });

  it.each([
    stubImporter(''),
    { key: 'gltf', import: undefined as unknown as Importer['import'] },
  ])('rejects invalid registration of $key', (input) => {
    const registry = new ImporterRegistry();
    expect(() => registry.register(input)).toThrow(TypeError);
  });
});
