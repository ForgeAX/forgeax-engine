import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { getOrCreateFromChain, getOrCreateFromChainResult } from '../mesh-ssbo';

describe('mesh bind-group cache chains', () => {
  it('keeps variable-depth material resource chains isolated', () => {
    const root = new WeakMap<object, unknown>();
    const shared = { shared: true };
    const coatSampler = { coatSampler: true };
    const coatTexture = { coatTexture: true };
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const long = getOrCreateFromChain(
      root,
      [shared, coatSampler, coatTexture],
      'material-shared',
      () => ({ id: 'long' }) as never,
      counts,
    );
    const short = getOrCreateFromChain(
      root,
      [shared, coatSampler],
      'material-shared',
      () => ({ id: 'short' }) as never,
      counts,
    );

    expect(
      getOrCreateFromChain(
        root,
        [shared, coatSampler],
        'material-shared',
        () => ({ id: 'unexpected' }) as never,
        counts,
      ),
    ).toBe(short);
    expect(long).not.toBe(short);
    expect(counts.createBindGroup).toBe(2);
  });

  it('propagates bind-group creation failures without poisoning the cache', () => {
    const root = new WeakMap<object, unknown>();
    const resource = {};
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const failure = { code: 'rhi-device-lost' };
    const failed = getOrCreateFromChainResult(
      root,
      [resource],
      'retryable',
      () => err(failure),
      counts,
    );
    expect(failed).toEqual({ ok: false, error: failure });
    expect(counts.createBindGroup).toBe(0);

    const created = { id: 'created' } as never;
    const recovered = getOrCreateFromChainResult(
      root,
      [resource],
      'retryable',
      () => ok(created),
      counts,
    );
    expect(recovered).toEqual({ ok: true, value: created });
    expect(counts.createBindGroup).toBe(1);
    expect(
      getOrCreateFromChainResult(
        root,
        [resource],
        'retryable',
        () => {
          throw new Error('cache miss after recovery');
        },
        counts,
      ),
    ).toEqual({ ok: true, value: created });
  });
});
