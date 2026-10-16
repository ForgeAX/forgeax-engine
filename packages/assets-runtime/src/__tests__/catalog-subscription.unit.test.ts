import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

describe('AssetRegistry.subscribeCatalog', () => {
  it('isolates throwing listeners and makes unsubscribe idempotent', () => {
    let emit: ((delta: { added: []; changed: []; removed: [] }) => void) | undefined;
    const source = {
      enumerate: async () => ({ ok: true as const, value: [] }),
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
    };
    const assets = new AssetRegistry({} as never);
    assets.setCatalogSource(source as never);
    const broken = vi.fn(() => {
      throw new Error('listener failed');
    });
    const received = vi.fn();
    const dispose = assets.subscribeCatalog(broken);
    assets.subscribeCatalog(received);

    emit?.({ added: [], changed: [], removed: [] });
    expect(received).toHaveBeenCalledTimes(1);
    dispose();
    dispose();
  });
});
