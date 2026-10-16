import type { Asset, ImportContext, Importer, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const MESH = {
  kind: 'mesh',
  vertices: new Float32Array(),
  indices: new Uint16Array(),
  attributes: {},
} as unknown as Asset;

function meta(): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'ui/main.html',
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'mesh' }],
  };
}

describe('import runner dependency observation', () => {
  it('records normalized source and sibling reads exactly once, including retries', async () => {
    const reads: string[] = [];
    const importer: Importer = {
      key: 'fixture',
      async import(ctx: ImportContext): Promise<ImportResult> {
        await ctx.readSibling('./main.css');
        const missing = await ctx.readSibling('icons/missing.svg');
        expect(missing.ok).toBe(false);
        await ctx.readSibling('icons/missing.svg');
        return {
          ok: true,
          value: {
            assets: [{ guid: GUID, kind: 'mesh', payload: MESH, refs: [], artifacts: {} }],
            sourceDependencies: [],
          },
        };
      },
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const result = await runImport(meta(), registry, {
      readSource: async (source) => {
        reads.push(source);
        if (source.endsWith('missing.svg')) return { ok: false, error: new Error('ENOENT') };
        return { ok: true, value: new Uint8Array([1]) };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok && 'product' in result.value) {
      expect(result.value.product.sourceDependencies).toEqual([
        'ui/main.html',
        'ui/main.css',
        'ui/icons/missing.svg',
      ]);
    }
    expect(reads).toEqual([
      'ui/main.html',
      'ui/./main.css',
      'ui/icons/missing.svg',
      'ui/icons/missing.svg',
    ]);
  });

  it('uses host-provided logical identities for dependency fingerprints', async () => {
    const importer: Importer = {
      key: 'fixture',
      async import(ctx: ImportContext): Promise<ImportResult> {
        await ctx.readSibling('./main.css');
        return {
          ok: true,
          value: {
            assets: [{ guid: GUID, kind: 'mesh', payload: MESH, refs: [], artifacts: {} }],
            sourceDependencies: [],
          },
        };
      },
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const result = await runImport(meta(), registry, {
      sourceIdentityFor: (sourcePath) =>
        sourcePath.replace('ui/', '@shared/ui/').replace('\\\\', '/'),
      readSource: async () => ({ ok: true, value: new Uint8Array([1]) }),
    });

    expect(result.ok).toBe(true);
    if (result.ok && 'product' in result.value) {
      expect(result.value.product.sourceDependencies).toEqual([
        '@shared/ui/main.html',
        '@shared/ui/main.css',
      ]);
      expect(result.value.product.sourceRevision).toBe(
        'source:@shared/ui/main.css|@shared/ui/main.html',
      );
    }
  });
});
