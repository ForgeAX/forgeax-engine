import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';

const GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('registry concurrency counters', () => {
  it('deduplicates concurrent same-GUID fetch and parse work', async () => {
    const registry = new AssetRegistry();
    const kind = defineAssetKind<{ value: number }>('counter-node');
    const decode = vi.fn(async ({ envelope }: AssetDecoderInput<{ value: number }>) =>
      ok(envelope.payload),
    );
    registry.installDecoder(kind, { decode });
    const packageUrl = 'https://counter.invalid/counter.pack.json';
    const sourcePath = 'counter.pack.ts';
    const publication = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath,
      sourceRevision: 'fixture',
      packageUrl,
      pack: {
        assets: [{ guid: GUID, kind: kind.kind, payload: { value: 1 }, refs: [], artifacts: {} }],
      },
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(publication.pack)));
    registry.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid: GUID,
            kind: kind.kind,
            packageUrl,
            sourcePath,
            publication: publication.publication,
          },
        ],
        fetch: fetcher,
      }),
    );
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => registry.load(GUID, kind)));
      const handles = results.map((result) => result.unwrap());
      expect(new Set(handles).size).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledTimes(1);
      for (const handle of handles) {
        expect(registry.read(handle).unwrap()).toEqual({ kind: kind.kind, value: 1 });
        registry.release(handle).unwrap();
      }
    } finally {
      registry.dispose();
    }
  });
});
