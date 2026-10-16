import type { CatalogDelta } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createCatalogClient } from '../catalog-client.js';

describe('Catalog client shared guard', () => {
  it('does not deliver malformed deltas from the hot channel', () => {
    const listeners = new Set<(data: unknown) => void>();
    const hot = {
      on: (_event: string, listener: (data: unknown) => void) => listeners.add(listener),
      off: (_event: string, listener: (data: unknown) => void) => listeners.delete(listener),
    };
    const received: CatalogDelta[] = [];
    const client = createCatalogClient(async () => [], hot);
    const unsubscribe = client.subscribe((delta) => received.push(delta));

    for (const listener of listeners) {
      listener({ added: [], changed: [], removed: [42] });
      listener({ added: [], changed: [], removed: [] });
    }

    expect(received).toEqual([{ added: [], changed: [], removed: [] }]);
    unsubscribe();
  });
});
