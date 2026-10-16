import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { CatalogReplica } from '../registry/catalog-state.js';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/fixture',
  kind: 'mesh',
  sourcePath: 'fixture.source',
};

describe('CatalogReplica subscription order', () => {
  it('does not lose an early delta and does not double-deliver a listener', async () => {
    const listeners = new Set<(delta: CatalogDelta) => void>();
    const source = {
      enumerate: async () => ({ ok: true as const, value: [entry] }),
      subscribe: vi.fn((listener: (delta: CatalogDelta) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const replica = new CatalogReplica(source as never);
    const received: CatalogDelta[] = [];
    const dispose = replica.subscribe((delta) => received.push(delta));
    await replica.start();

    const delta: CatalogDelta = { added: [], changed: [entry], removed: [] };
    for (const listener of listeners) listener(delta);
    expect(received).toHaveLength(1);
    dispose();
    dispose();
    for (const listener of listeners) listener(delta);
    expect(received).toHaveLength(1);
    expect(source.subscribe).toHaveBeenCalledTimes(1);
  });

  it('returns structured enumerate failure and can recover through reconcile', async () => {
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: 'catalog-enumerate-failed',
          expected: 'a readable producer catalog',
          hint: 'call reconcile after restoring the source',
        },
      })
      .mockResolvedValueOnce({ ok: true as const, value: [entry] });
    const replica = new CatalogReplica({ enumerate, subscribe: () => () => {} } as never);

    const first = await replica.start();
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: 'catalog-enumerate-failed',
        expected: 'a readable producer catalog',
        hint: expect.any(String),
      },
    });
    expect(replica.snapshot().stale).toBe(true);
    await expect(replica.reconcile()).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot()).toMatchObject({ stale: false, entries: [entry] });
    expect(enumerate).toHaveBeenCalledTimes(2);
  });
});
