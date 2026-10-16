import { ok } from '@forgeax/engine-rhi';
import { ASSET_ERROR_HINTS, type CatalogDelta, type CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetRegistry,
  type CatalogReconcileResult,
  type CatalogReplicaSnapshot,
} from '../index.js';

const currentEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  sourcePath: 'model.glb',
  packageUrl: '/preview/packages/model',
  revision: { digest: 'sha256:current', observedAt: 7, rootId: 'root-model' },
  diagnostics: [{ code: 'catalog-current', severity: 'info', hint: 'current revision' }],
} as const satisfies CatalogEntry;

function registry(): AssetRegistry {
  return new AssetRegistry({} as never);
}

describe('AssetRegistry.reconcileCatalog public contract', () => {
  it('returns the structured unconfigured Result through the package surface', async () => {
    const assets = registry();

    const result: CatalogReconcileResult = await assets.reconcileCatalog();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'catalog-source-unconfigured',
      expected: 'a configured catalog source',
    });
    expect(result.error.hint).toBe(ASSET_ERROR_HINTS['catalog-source-unconfigured']);
  });

  it('returns the same immutable revision snapshot without authoring writes', async () => {
    let listener: ((delta: CatalogDelta) => void) | undefined;
    const writeMeta = vi.fn();
    const writeSourceBytes = vi.fn();
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    const originalSourceBytes = sourceBytes.slice();
    const source = {
      enumerate: vi.fn(async () => ok([currentEntry])),
      subscribe(next: (delta: CatalogDelta) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      writeMeta,
      writeSourceBytes,
    };
    const assets = registry();
    assets.setCatalogSource(source);
    await assets.enumerateCatalog();
    listener?.({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking', hint: 'reconcile' }],
    });

    const result: CatalogReconcileResult = await assets.reconcileCatalog();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot: CatalogReplicaSnapshot = result.value;
    expect(snapshot).toBe(assets.catalogSnapshot());
    expect(snapshot).toMatchObject({
      stale: false,
      diagnostics: [],
      entries: [
        {
          guid: currentEntry.guid,
          revision: currentEntry.revision,
          diagnostics: currentEntry.diagnostics,
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(writeMeta).not.toHaveBeenCalled();
    expect(writeSourceBytes).not.toHaveBeenCalled();
    expect(sourceBytes).toEqual(originalSourceBytes);
  });
});
