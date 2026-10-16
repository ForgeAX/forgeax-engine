import type { CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { type CatalogListener, createCatalogSource } from '../catalog-source';
import { parseCatalog } from '../registry/catalog';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  name: 'unloaded',
  packageUrl: '/assets/unloaded.pack.json',
  sourcePath: 'assets/unloaded.glb',
};

const richEntry: CatalogEntry = {
  ...entry,
  packageId: 'pkg/runtime',
  provenance: { provider: 'runtime-fixture', version: '1.0.0' },
  revision: { digest: 'sha256:runtime', observedAt: 3, rootId: 'root-runtime' },
  sourceKey: 'runtime/main',
  sourceIndex: 0,
  relations: [
    {
      from: { type: 'asset', id: '11111111-1111-4111-8111-111111111111' },
      to: { type: 'asset', id: '22222222-2222-4222-8222-222222222222' },
      type: 'references',
      provenance: { provider: 'runtime-fixture', version: '1.0.0' },
    },
  ],
  diagnostics: [{ code: 'runtime-warning', severity: 'warning', hint: 'refresh catalog' }],
};

describe('CatalogSource', () => {
  it('enumerates every development or build row without loading its payload', async () => {
    for (const url of ['/__pack/index', '/pack-index.json']) {
      const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [entry] });
      const source = createCatalogSource({ url, fetch });
      const result = await source.enumerate();

      expect(result).toEqual({ ok: true, value: [entry] });
      expect(fetch).toHaveBeenCalledWith(url);
    }
  });

  it('reports an unconfigured source instead of an empty catalog', async () => {
    const result = await createCatalogSource({}).enumerate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('catalog-source-unconfigured');
  });

  it('uses the shared parser to distinguish malformed JSON from a fetch failure', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });

    const result = await createCatalogSource({ url: '/pack-index.json', fetch }).enumerate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
  });

  it('keeps static and URL catalog rows in the same producer-fact shape', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [richEntry] });
    const source = createCatalogSource({ url: '/pack-index.json', fetch });
    const urlResult = await source.enumerate();
    const staticResult = await createCatalogSource({ entries: [richEntry] }).enumerate();

    expect(urlResult).toEqual(staticResult);
    expect(urlResult).toEqual({ ok: true, value: [richEntry] });
  });

  it('rejects a catalog row without a locator instead of returning an empty catalog', () => {
    const result = parseCatalog([
      {
        guid: richEntry.guid,
        kind: richEntry.kind,
        packageId: richEntry.packageId,
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-parse-failed');
      expect(result.error.expected).toContain('packageUrl');
      expect(result.error.hint).toBeTruthy();
    }
  });

  it('reports a stale revision through structured fields', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [richEntry] });
    const result = await createCatalogSource({
      url: '/pack-index.json',
      fetch,
      expectedRevision: { digest: 'sha256:expected', observedAt: 4, rootId: 'root-runtime' },
    }).enumerate();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-parse-failed');
      expect(result.error.expected).toContain('revision');
      expect(result.error.hint).toContain('verified');
      expect(result.error.detail).toMatchObject({
        expectedRevision: { digest: 'sha256:expected' },
        actualRevisions: [{ digest: 'sha256:runtime' }],
      });
    }
  });

  it('uses an idempotent no-op subscription for static catalogs', () => {
    const source = createCatalogSource({ entries: [entry] });
    const listener = vi.fn();
    const dispose = source.subscribe(listener);

    dispose();
    dispose();
    expect(listener).not.toHaveBeenCalled();
  });

  it('forwards an optional catalog subscription', () => {
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_forward: CatalogListener) => unsubscribe);
    const source = createCatalogSource({ subscribe });

    expect(source.subscribe(listener)).toBe(unsubscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const delta = { added: [], changed: [], removed: [] };
    subscribe.mock.calls[0]?.[0](delta);
    expect(listener).toHaveBeenCalledWith(delta);
  });
});
