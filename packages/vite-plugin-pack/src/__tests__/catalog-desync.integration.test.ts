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

describe('Catalog transport desynchronization', () => {
  it('does not deliver malformed HMR and recovers through a full enumerate', async () => {
    const listeners = new Set<(data: unknown) => void>();
    let enumerateCalls = 0;
    const client = createCatalogClient(
      async () => {
        enumerateCalls += 1;
        return [entry];
      },
      {
        on(event, listener) {
          expect(event).toBe(CATALOG_DELTA_EVENT);
          listeners.add(listener);
        },
        off(_event, listener) {
          listeners.delete(listener);
        },
      },
    );
    const received: CatalogDelta[] = [];
    client.subscribe((delta) => received.push(delta));

    for (const listener of listeners) listener({ added: [entry], changed: [], removed: [7] });
    expect(client.desynchronized()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.desynchronized()).toBe(false);
    expect(enumerateCalls).toBe(1);
    expect(received).toEqual([]);
  });

  it('deduplicates semantic deltas when only object key order changes', () => {
    const listeners = new Set<(data: unknown) => void>();
    const client = createCatalogClient(async () => [entry], {
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    });
    const received: CatalogDelta[] = [];
    client.subscribe((delta) => received.push(delta));

    const first: CatalogDelta = { added: [entry], changed: [], removed: [] };
    const reordered: CatalogEntry = {
      sourcePath: entry.sourcePath,
      kind: entry.kind,
      packageUrl: entry.packageUrl,
      guid: entry.guid,
    };
    const second: CatalogDelta = { added: [reordered], changed: [], removed: [] };
    for (const listener of listeners) {
      listener(first);
      listener(second);
    }
    expect(received).toEqual([first]);
  });
});
