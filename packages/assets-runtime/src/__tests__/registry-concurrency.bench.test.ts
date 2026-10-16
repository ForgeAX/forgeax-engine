import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('registry concurrency counters', () => {
  it('deduplicates concurrent same-GUID fetch and parse work', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'counter-node',
      load: vi.fn((payload) => ({ kind: 'counter-node', ...payload })),
    });
    registry.configurePackIndex('/pack-index.json');
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('pack-index.json')) {
        return new Response(
          JSON.stringify([
            { guid: GUID, packageUrl: '/counter.pack.json', kind: 'counter-node', sourcePath: 'a' },
          ]),
        );
      }
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid: GUID, kind: 'counter-node', payload: { value: 1 }, refs: [], artifacts: {} },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => registry.loadByGuid(registry.parseGuid(GUID))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('counter.pack.json'))).toHaveLength(1);
  });
});
