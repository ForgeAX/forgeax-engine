import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const GUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pack() {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      { guid: GUID_A, kind: 'host-blob', payload: { value: 'a' }, refs: [], artifacts: {} },
      { guid: GUID_B, kind: 'host-blob', payload: { value: 'b' }, refs: [], artifacts: {} },
    ],
  };
}

function registryWithLoader() {
  const registry = new AssetRegistry({} as never);
  registry.loaders.register({
    kind: 'host-blob',
    load: (payload) => ({ kind: 'host-blob', ...payload }),
  });
  return registry;
}

describe('registry package cache', () => {
  it('fetches and parses a shared package once for concurrent assets', async () => {
    const registry = registryWithLoader();
    registry.configurePackIndex('/pack-index.json');
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('pack-index.json')) {
        return new Response(
          JSON.stringify([
            { guid: GUID_A, packageUrl: '/shared.pack.json', kind: 'host-blob', sourcePath: 'a' },
            { guid: GUID_B, packageUrl: '/shared.pack.json', kind: 'host-blob', sourcePath: 'b' },
          ]),
        );
      }
      return new Response(JSON.stringify(pack()));
    });
    vi.stubGlobal('fetch', fetcher);

    const [a, b] = await Promise.all([
      registry.loadByGuid<{ kind: string; value: string }>(registry.parseGuid(GUID_A)),
      registry.loadByGuid<{ kind: string; value: string }>(registry.parseGuid(GUID_B)),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('shared.pack.json'))).toHaveLength(1);
  });
});
