import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { PackReader } from '../internal/pack-reader.js';

const url = 'https://fixture.test/value.pack.json';
const publication = createRuntimePackPublication({
  scopeId: 'asset-runtime',
  sourcePath: 'value.pack',
  sourceRevision: '1',
  packageUrl: url,
  pack: { assets: [] },
});
const readers: PackReader[] = [];

afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
  vi.restoreAllMocks();
});

function fixture() {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async () => {
    await pending;
    return new Response(JSON.stringify(publication.pack));
  });
  const reader = new PackReader({ fetcher });
  readers.push(reader);
  return { reader, fetcher, finish };
}

it('reads a verified Pack without native AbortSignal.any', async () => {
  const any = vi.spyOn(AbortSignal, 'any').mockImplementation(() => {
    throw new TypeError('AbortSignal.any is not a function');
  });
  const f = fixture();
  f.finish();
  const result = await f.reader.read(url, publication.pack, new AbortController().signal);
  expect(result).toEqual({ ok: true, value: publication.pack });
  expect(any).not.toHaveBeenCalled();
});

it('cancels one waiter while preserving a sibling and the shared fetch', async () => {
  const f = fixture();
  const cancelled = new AbortController();
  const sibling = new AbortController();
  const remove = vi.spyOn(sibling.signal, 'removeEventListener');
  const first = f.reader.read(url, publication.pack, cancelled.signal);
  const second = f.reader.read(url, publication.pack, sibling.signal);
  cancelled.abort('caller retired');
  await expect(first).resolves.toMatchObject({
    ok: false,
    error: { code: 'asset-load-cancelled' },
  });
  expect(sibling.signal.aborted).toBe(false);
  f.finish();
  await expect(second).resolves.toEqual({ ok: true, value: publication.pack });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalled();
});

it('cancels pending waiters when the PackReader is disposed', async () => {
  const f = fixture();
  const pending = f.reader.read(url, publication.pack, new AbortController().signal);
  f.reader.dispose();
  await expect(pending).resolves.toMatchObject({
    ok: false,
    error: { code: 'asset-load-cancelled' },
  });
  f.finish();
});
