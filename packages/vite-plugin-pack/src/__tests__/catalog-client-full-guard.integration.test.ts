import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createCatalogClient } from '../catalog-client.js';
import { CATALOG_DELTA_EVENT } from '../catalog-transport.js';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/fixture.pack.json',
  kind: 'mesh',
  sourcePath: 'fixture.mesh',
};

describe('catalog client full transport guard', () => {
  it('rejects malformed and scope-mismatched HMR payloads, then re-enumerates', async () => {
    const listeners = new Set<(data: unknown) => void>();
    let enumerateCalls = 0;
    const client = createCatalogClient(
      async () => {
        enumerateCalls += 1;
        return [entry];
      },
      {
        on: (_event, listener) => listeners.add(listener),
        off: (_event, listener) => listeners.delete(listener),
      },
    );
    const received: CatalogDelta[] = [];
    client.subscribe((delta) => received.push(delta));

    for (const listener of listeners) listener({ added: [entry], changed: [], removed: [7] });
    await Promise.resolve();
    expect(client.desynchronized()).toBe(false);
    expect(enumerateCalls).toBe(1);
    expect(received).toEqual([]);

    for (const listener of listeners) {
      listener({ added: [entry], changed: [], removed: [], scopeId: 'game', generation: 2 });
    }
    expect(received).toHaveLength(1);
    expect(CATALOG_DELTA_EVENT).toBe('forgeax:catalog-delta');
  });
});
