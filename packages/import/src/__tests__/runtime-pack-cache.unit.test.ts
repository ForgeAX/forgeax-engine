import { expect, it, vi } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import type { RuntimePackContent } from '../runtime-pack.js';
import { type RuntimePackCacheStore, RuntimePackPersistentCache } from '../runtime-pack-cache.js';

const packageId = '01900000-0000-7000-8000-000000000199';
const content: RuntimePackContent = {
  source: {
    schemaVersion: '3.0.0',
    packageId,
    assets: { sampler: { kind: 'sampler', payload: { kind: 'sampler' }, refs: [] } },
  },
};

it('reopens a committed entry and treats altered bytes as a miss', async () => {
  const records = new Map<string, Uint8Array<ArrayBuffer>>();
  const store: RuntimePackCacheStore = {
    read: async (key) => records.get(key),
    write: async (key, bytes) => {
      records.set(key, bytes);
    },
  };
  const first = new RuntimePackPersistentCache(store);
  first.write('recipe', content);
  await vi.waitFor(() => expect(records.size).toBe(1));
  first.dispose();
  const reopened = new RuntimePackPersistentCache(store);
  expect(await reopened.read('recipe', packageId, { sampler: 'sampler' }, content)).toEqual(
    content,
  );
  expect(await reopened.read('recipe', packageId, { sampler: 'mesh' }, content)).toBeUndefined();
  const record = records.get('recipe');
  if (!record) throw new Error('missing cache record');
  record[0] = (record[0] ?? 0) ^ 1;
  expect(await reopened.read('recipe', packageId, { sampler: 'sampler' }, content)).toBeUndefined();
  reopened.dispose();
});

it('persists independently published Packs while a write is in flight', async () => {
  const { promise: firstWrite, resolve: releaseFirstWrite } = testGate();
  const write = vi.fn(async (key: string) => {
    if (key === 'first') await firstWrite;
  });
  const cache = new RuntimePackPersistentCache({ read: vi.fn(), write });
  try {
    cache.write('first', content);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    cache.write('second', content);
    expect(write).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await vi.waitFor(() =>
      expect(write.mock.calls.map(([key]) => key)).toEqual(['first', 'second']),
    );
  } finally {
    releaseFirstWrite();
    cache.dispose();
  }
});

it('aborts a blocked cache read without waiting for the storage implementation', async () => {
  vi.useFakeTimers();
  const read = vi.fn((_key: string, _signal: AbortSignal) => new Promise<Uint8Array>(() => {}));
  const cache = new RuntimePackPersistentCache({ read, write: vi.fn() });
  try {
    const pending = cache.read('recipe', packageId, { sampler: 'sampler' }, content);
    await vi.advanceTimersByTimeAsync(251);
    await expect(pending).resolves.toBeUndefined();
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
  } finally {
    cache.dispose();
    vi.useRealTimers();
  }
});
