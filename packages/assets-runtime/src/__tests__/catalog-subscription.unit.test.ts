import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

describe('AssetRegistry.subscribeCatalog', () => {
  it('isolates throwing listeners and makes unsubscribe idempotent', async () => {
    let emit: ((delta: { added: []; changed: []; removed: [] }) => void) | undefined;
    const source = {
      enumerate: async () => ({ ok: true as const, value: [] }),
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
    };
    const assets = new AssetRegistry({ shaderRegistry: {} as never });
    assets.setCatalogSource(source as never);
    (await assets.enumerateCatalog()).unwrap();
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
    assets.dispose();
  });
});
