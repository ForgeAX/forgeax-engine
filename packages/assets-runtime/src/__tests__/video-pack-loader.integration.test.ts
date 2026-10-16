// M59: exercise the Pack v2 video loader through AssetRegistry's default
// registry, including failure cleanup and same-GUID invalidate/reload.

import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const GUID = 'f1b3d000-1111-4aaa-9eee-aa1111112222';

describe('Pack v2 video loader recovery', () => {
  it('fails before publication, then retries the same GUID with a repaired descriptor', async () => {
    const registry = new AssetRegistry({} as never);
    expect(registry.loaders.get('video')).toBeDefined();
    registry.configurePackIndex('/pack-index.json');

    let repaired = false;
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith('/pack-index.json')) {
        return new Response(
          JSON.stringify([
            {
              guid: GUID,
              packageUrl: '/video.pack.json',
              kind: 'video',
              sourcePath: 'cutscene.webm',
            },
          ]),
        );
      }
      if (!url.endsWith('/video.pack.json')) {
        throw new Error(`unexpected media fetch: ${url}`);
      }
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: GUID,
              kind: 'video',
              payload: {
                url: repaired ? '/cutscene.webm' : 'javascript:alert(1)',
              },
              refs: [],
              artifacts: {},
            },
          ],
        }),
      );
    });

    try {
      const first = await registry.loadByGuid(registry.parseGuid(GUID));
      expect(first.ok).toBe(false);
      if (first.ok) return;
      expect(first.error.code).toBe('asset-parse-failed');
      expect(registry.lookup(GUID)).toBeUndefined();
      expect(registry.assetCatalog.has(GUID)).toBe(false);
      expect(fetchCalls).toEqual(['/pack-index.json', '/video.pack.json']);

      repaired = true;
      registry.invalidate(GUID);
      const retried = await registry.loadByGuid(registry.parseGuid(GUID));
      expect(retried).toEqual({ ok: true, value: { kind: 'video', url: '/cutscene.webm' } });
      expect(registry.lookup(GUID)).toEqual({ kind: 'video', url: '/cutscene.webm' });
      expect(registry.assetCatalog.get(GUID)?.payload).toEqual({
        kind: 'video',
        url: '/cutscene.webm',
      });
      expect(fetchCalls).toEqual([
        '/pack-index.json',
        '/video.pack.json',
        '/pack-index.json',
        '/video.pack.json',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
