// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=2):
//   - packages/import/src/__tests__/import-runner.test.ts
//   - packages/import/src/__tests__/importer-registry.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

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

function stubImporter(key: string): Importer {
  return {
    key,
    import: (_ctx: ImportContext): ImportResult => ({
      ok: true,
      value: { assets: [], sourceDependencies: [] },
    }),
  };
}

{
  // ─── from import-runner.test.ts ───

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
              (asset as unknown as { artifacts?: Readonly<Record<string, unknown>> }).artifacts ??
              {},
          })),
          sourceDependencies: [],
        },
      }),
    });
    return reg;
  }

  describe('import-runner.test.ts', () => {
    describe('import runner (w15 / w17)', () => {
      it('(a) happy path: produces a DDC pack with one row per produced asset', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
          { guid: GUID_B, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
        ]);
        const res = await runImport(meta('gltf', [GUID_A, GUID_B]), reg, okFs());
        expect(res.ok).toBe(true);
        if (res.ok && !('skipped' in res.value)) {
          expect(res.value.pack.kind).toBe('internal-text-package');
          expect(res.value.pack.assets.map((a) => a.guid)).toEqual([GUID_A, GUID_B]);
        }
      });

      it('(a2) product-only mode leaves pack publication to the downstream finalizer', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
        ]);
        const res = await runImport({ ...meta('gltf', [GUID_A]), buildPack: false }, reg, okFs());
        expect(res.ok).toBe(true);
        if (res.ok && !('skipped' in res.value)) {
          expect(res.value.product.assets).toHaveLength(1);
          expect('pack' in res.value).toBe(false);
        }
      });

      it('(b) import-produced-no-assets: importer returns []', async () => {
        const reg = registryWith('gltf', () => []);
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-produced-no-assets');
          expect(res.error.detail).toMatchObject({ missingGuids: [GUID_A] });
        }
      });

      it('(c) guid-mismatch: produced a GUID not declared in subAssets[]', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_UNDECLARED, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
        ]);
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('guid-mismatch');
          expect(res.error.detail).toMatchObject({ unexpectedGuids: [GUID_UNDECLARED] });
        }
      });

      it('(d) import-produced-no-assets: a declared GUID is missing from the produced set', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
        ]);
        const res = await runImport(meta('gltf', [GUID_A, GUID_B]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-produced-no-assets');
          expect(res.error.detail).toMatchObject({ missingGuids: [GUID_B] });
        }
      });

      it('(e) importer-not-registered: no importer for meta.importer', async () => {
        const reg = new ImporterRegistry();
        reg.register({
          key: 'image',
          import: () => ({
            ok: true,
            value: { assets: [], sourceDependencies: [] },
          }),
        });
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('importer-not-registered');
          expect(res.error.detail).toMatchObject({
            importer: 'gltf',
            registeredImporters: ['image'],
          });
        }
      });

      it('(f) source-read-failed: readSource rejects', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
        ]);
        const res = await runImport(meta('gltf', [GUID_A]), reg, failFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('source-read-failed');
          expect(res.error.detail).toMatchObject({ source: 'model.gltf' });
        }
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
            return {
              ok: true,
              value: {
                assets: [
                  {
                    guid,
                    kind: 'mesh',
                    payload: MESH_POD,
                    refs: [],
                    artifacts: {},
                  },
                ],
                sourceDependencies: [],
              },
            };
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
          expect(healthySibling.value.pack.assets[0]?.guid).toBe(GUID_B);
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
          expect(second.value.pack).toEqual(third.value.pack);
          expect(second.value.cookProducts).toEqual(third.value.cookProducts);
        }
      });

      it('(g) import-internal-error: the importer throws', async () => {
        const reg = registryWith('gltf', () => {
          throw new Error('boom inside importer');
        });
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-internal-error');
          expect(res.error.detail).toMatchObject({ reason: 'boom inside importer' });
        }
      });

      it('(h) reserved shader key is skipped (no DDC, no importer call)', async () => {
        const reg = new ImporterRegistry();
        const res = await runImport(meta('shader', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value).toEqual({ skipped: 'shader' });
        }
      });

      it('(i) dispatch: the correct importer is invoked for meta.importer', async () => {
        let invoked = '';
        const reg = new ImporterRegistry();
        reg.register({
          key: 'gltf',
          import: () => {
            invoked = 'gltf';
            return {
              ok: true,
              value: {
                assets: [
                  { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [], artifacts: {} },
                ],
                sourceDependencies: [],
              },
            };
          },
        });
        reg.register({
          key: 'image',
          import: () => {
            invoked = 'image';
            return {
              ok: true,
              value: {
                assets: [
                  { guid: GUID_A, kind: 'texture', payload: MESH_POD, refs: [], artifacts: {} },
                ],
                sourceDependencies: [],
              },
            };
          },
        });
        await runImport(meta('image', [GUID_A]), reg, okFs());
        expect(invoked).toBe('image');
      });

      it('(j) importer failures preserve structured code and actionable hint', async () => {
        const reg = new ImporterRegistry();
        reg.register({
          key: 'gltf',
          import: () => ({
            ok: false,
            error: new ImportError({
              code: 'source-read-failed',
              expected: 'a readable source',
              hint: IMPORT_ERROR_HINTS['source-read-failed'],
              detail: { source: 'model.gltf', reason: 'ENOENT' },
            }),
          }),
        });
        const result = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('source-read-failed');
          expect(result.error.hint).toContain('check the path');
          expect(result.error.detail).toMatchObject({ source: 'model.gltf' });
        }
      });

      it('(k) malformed importer results become structured internal errors', async () => {
        const reg = new ImporterRegistry();
        reg.register({ key: 'gltf', import: () => ({ ok: true }) as never });
        const result = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('import-internal-error');
          expect(result.error.hint).toContain('branch on err.detail');
        }
      });
    });
  });
}

{
  // ─── from importer-registry.test.ts ───

  describe('importer-registry.test.ts', () => {
    describe('ImporterRegistry (w14 / w17)', () => {
      it('register then get returns the registered importer', () => {
        const reg = new ImporterRegistry();
        const gltf = stubImporter('gltf');
        reg.register(gltf);
        expect(reg.get('gltf')).toBe(gltf);
      });

      it('get on an unregistered key returns undefined', () => {
        const reg = new ImporterRegistry();
        expect(reg.get('gltf')).toBeUndefined();
      });

      it('rejects duplicate producer keys without replacing the active importer', () => {
        const reg = new ImporterRegistry();
        const first = stubImporter('gltf');
        const second = stubImporter('gltf');
        reg.register(first);
        expect(() => reg.register(second)).toThrow('duplicate importer gltf');
        expect(reg.get('gltf')).toBe(first);
        expect(reg.registeredImporters().filter((k) => k === 'gltf')).toHaveLength(1);
      });

      it('registeredImporters reflects insertion order', () => {
        const reg = new ImporterRegistry();
        reg.register(stubImporter('gltf'));
        reg.register(stubImporter('image'));
        expect(reg.registeredImporters()).toEqual(['gltf', 'image']);
      });

      it('fail-fast: register throws on empty key', () => {
        const reg = new ImporterRegistry();
        expect(() =>
          reg.register({
            key: '',
            import: () => ({
              ok: true,
              value: { assets: [], sourceDependencies: [] },
            }),
          }),
        ).toThrow(TypeError);
      });

      it('fail-fast: register throws when import is not a function', () => {
        const reg = new ImporterRegistry();
        expect(() =>
          reg.register({ key: 'gltf', import: undefined as unknown as Importer['import'] }),
        ).toThrow(TypeError);
      });
    });
  });
}
