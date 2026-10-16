import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { type CatalogListener, createCatalogSource } from '../catalog-source.js';

const entry: CatalogEntry = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  packageUrl: '/assets/model.pack.json',
  sourcePath: 'assets/model.glb',
};

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('joins concurrent reads only within the same CatalogSource instance', async () => {
  const held = gate();
  let bodyReads = 0;
  class CatalogResponse extends Response {
    override async json() {
      bodyReads++;
      return super.json();
    }
  }
  const fetcher = vi.fn(async () => {
    await held.promise;
    return new CatalogResponse(JSON.stringify([entry]));
  });
  const source = createCatalogSource({ url: '/pack-index.json', fetch: fetcher });
  const first = source.enumerate();
  const second = source.enumerate();
  held.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.ok).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(bodyReads).toBe(1);
  expect(b).toBe(a);
  expect(fetcher).toHaveBeenCalledWith('/pack-index.json');
  await createCatalogSource({ url: '/pack-index.json', fetch: fetcher }).enumerate();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('fetches fresh entries after a successful enumeration settles', async () => {
  let generation = 0;
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify([{ ...entry, name: String(++generation) }])),
  );
  const source = createCatalogSource({ url: '/pack-index.json', fetch: fetcher });
  const first = await source.enumerate();
  const second = await source.enumerate();
  expect(first.ok && first.value[0]?.name).toBe('1');
  expect(second.ok && second.value[0]?.name).toBe('2');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('retries enumeration after a shared malformed-body failure settles', async () => {
  const held = gate();
  let requests = 0;
  const fetcher = vi.fn(async () => {
    const attempt = ++requests;
    await held.promise;
    return new Response(attempt === 1 ? '{' : JSON.stringify([entry]));
  });
  const source = createCatalogSource({ url: '/pack-index.json', fetch: fetcher });
  const first = source.enumerate();
  const joined = source.enumerate();
  held.release();
  const result = await first;
  expect((await joined).ok).toBe(false);
  expect(result.ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await source.enumerate()).ok).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('retires pending identity before forwarding a delta and ignores old settlement', async () => {
  const oldGate = gate();
  const newGate = gate();
  let emit: CatalogListener = () => {};
  let requests = 0;
  const fetcher = vi.fn(async () => {
    const generation = ++requests;
    await (generation === 1 ? oldGate.promise : newGate.promise);
    return new Response(JSON.stringify([{ ...entry, name: String(generation) }]));
  });
  const source = createCatalogSource({
    url: '/pack-index.json',
    fetch: fetcher,
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  let forwarded: ReturnType<typeof source.enumerate> | undefined;
  const delta: CatalogDelta = { added: [], changed: [entry], removed: [] };
  const stop = source.subscribe((actual) => {
    expect(actual).toBe(delta);
    forwarded = source.enumerate();
  });
  const original = source.enumerate();
  emit(delta);
  oldGate.release();
  await original;
  const joinedNew = source.enumerate();
  newGate.release();
  const [fresh, joined] = await Promise.all([forwarded, joinedNew]);
  expect(fresh?.ok && fresh.value[0]?.name).toBe('2');
  expect(joined).toBe(fresh);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stop();
});

it('starts a fresh baseline for two distinct updates reusing the same delta object', async () => {
  const held = gate();
  let emit: CatalogListener = () => {};
  let requests = 0;
  const fetcher = vi.fn(async () => {
    const generation = ++requests;
    await held.promise;
    return new Response(JSON.stringify([{ ...entry, name: String(generation) }]));
  });
  const source = createCatalogSource({
    url: '/pack-index.json',
    fetch: fetcher,
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  const listener = vi.fn();
  const stop = source.subscribe(listener);
  const reused: CatalogDelta = { added: [], changed: [entry], removed: [] };
  const before = source.enumerate();
  emit(reused);
  const firstUpdate = source.enumerate();
  emit(reused);
  const secondUpdate = source.enumerate();
  held.release();
  const results = await Promise.all([before, firstUpdate, secondUpdate]);
  expect(results.map((result) => result.ok && result.value[0]?.name)).toEqual(['1', '2', '3']);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
});
