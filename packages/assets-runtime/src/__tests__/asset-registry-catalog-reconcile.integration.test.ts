import { err, ok } from '@forgeax/engine-rhi';
import { AssetError, type CatalogDelta, type CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry, type CatalogReconcileResult } from '../index.js';

const baselineEntry = {
  guid: '22222222-2222-4222-8222-222222222222',
  kind: 'mesh',
  sourcePath: 'failed.glb',
  packageUrl: '/preview/packages/failed',
  revision: { digest: 'sha256:baseline', observedAt: 3, rootId: 'root-failed' },
} as const satisfies CatalogEntry;

function registry(): AssetRegistry {
  return new AssetRegistry({} as never);
}

describe('AssetRegistry.reconcileCatalog recovery integration', () => {
  it('preserves stale gap diagnostics and the source error without silent refresh', async () => {
    let listener: ((delta: CatalogDelta) => void) | undefined;
    const failure = new AssetError({
      code: 'asset-fetch-failed',
      expected: 'an authoritative catalog enumeration',
      hint: 'restore the catalog source and reconcile again',
    });
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce(ok([baselineEntry]))
      .mockResolvedValueOnce(err(failure));
    const writeMeta = vi.fn();
    const writeSourceBytes = vi.fn();
    const assets = registry();
    const source = {
      enumerate,
      subscribe(next: (delta: CatalogDelta) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      writeMeta,
      writeSourceBytes,
    };
    assets.setCatalogSource(source);
    await assets.enumerateCatalog();
    listener?.({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [
        {
          code: 'catalog-gap',
          severity: 'blocking',
          expected: 'contiguous producer revisions',
          hint: 'reconcile',
        },
      ],
    });
    const refreshCatalog = vi.spyOn(assets, 'refreshCatalog');

    const result: CatalogReconcileResult = await assets.reconcileCatalog();

    expect(result).toEqual({ ok: false, error: failure });
    expect(assets.catalogSnapshot()).toMatchObject({
      stale: true,
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking' }],
      entries: [{ guid: baselineEntry.guid, revision: baselineEntry.revision }],
    });
    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(writeMeta).not.toHaveBeenCalled();
    expect(writeSourceBytes).not.toHaveBeenCalled();
  });
});
