import { describe, expect, it } from 'vitest';

import { type CatalogHotChannel, createCatalogClient } from '../catalog-client.js';
import { CATALOG_DELTA_EVENT } from '../catalog-transport.js';
import { reloadAssetHost } from '../index.js';

describe('catalog client', () => {
  it('forwards only a neutral catalog delta and unregisters cleanly', async () => {
    let listener: ((data: unknown) => void) | undefined;
    const hot: CatalogHotChannel = {
      on(event, next) {
        expect(event).toBe(CATALOG_DELTA_EVENT);
        listener = next;
      },
      off(event, next) {
        expect(event).toBe(CATALOG_DELTA_EVENT);
        expect(next).toBe(listener);
        listener = undefined;
      },
    };
    const client = createCatalogClient(async () => [], hot);
    const received: unknown[] = [];
    const unsubscribe = client.subscribe((delta) => received.push(delta));

    listener?.({ added: [], changed: [], removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45a'] });
    listener?.({ kind: 'source' });
    expect(await client.enumerate()).toEqual([]);
    expect(received).toEqual([
      { added: [], changed: [], removed: ['019e2cc6-0c86-79da-aa76-b0984c86d45a'] },
    ]);

    unsubscribe();
    listener?.({ added: [], changed: [], removed: [] });
    expect(received).toHaveLength(1);
  });

  it('makes static sources safely enumerable without a subscription event', async () => {
    const client = createCatalogClient(async () => [], undefined);
    expect(await client.enumerate()).toEqual([]);
    expect(() => client.subscribe(() => {})).not.toThrow();
  });

  it('exposes structured failure fields for malformed enumeration results', async () => {
    const validationFailure = { added: [{ guid: 'invalid' }] };
    const client = createCatalogClient(async () => validationFailure as never, undefined);

    await expect(client.enumerate()).rejects.toMatchObject({
      code: 'route-failed',
      expected: expect.any(String),
      hint: expect.any(String),
      detail: { stage: 'route', subject: 'catalog-enumeration' },
      cause: {
        code: 'catalog-delta-invalid',
        detail: { field: 'added' },
      },
    });
    expect(client.desynchronized()).toBe(true);
  });

  it('requests a full reload only when an engine host explicitly chooses that policy', () => {
    const calls: string[] = [];
    reloadAssetHost()({ ws: { send: (payload) => calls.push(payload.type) } });
    expect(calls).toEqual(['full-reload']);
  });
});
