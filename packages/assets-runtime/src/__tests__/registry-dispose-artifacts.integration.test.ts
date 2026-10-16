import { createHash } from 'node:crypto';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createAssetRegistry, createCatalogSource, defineAssetKind } from '../index.js';
import { ArtifactCache } from '../internal/artifact-cache.js';

it('Registry.dispose aborts artifact I/O and rejects late cache refill from an ignoring transport', async () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  const bytes = Uint8Array.of(1, 2, 3);
  const descriptor = {
    path: 'body.bin',
    mediaType: 'application/octet-stream',
    contentEncoding: 'identity' as const,
    byteLength: bytes.length,
    integrity: {
      algorithm: 'sha256' as const,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
  const { pack, publication } = createRuntimePackPublication({
    pack: {
      assets: [
        { guid, kind: 'test-bytes', payload: {}, refs: [], artifacts: { body: descriptor } },
      ],
    },
    scopeId: 'test',
    sourcePath: 'test.pack.ts',
    sourceRevision: 'r1',
    packageUrl: '/test.pack.json',
    generation: 1,
  });
  let finishBody!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finishBody = resolve;
  });
  let entered!: (signal: AbortSignal) => void;
  const reading = new Promise<AbortSignal>((resolve) => {
    entered = resolve;
  });
  let cache: ArtifactCache | undefined;
  const read = ArtifactCache.prototype.read;
  const spy = vi.spyOn(ArtifactCache.prototype, 'read').mockImplementation(function (
    this: ArtifactCache,
    ...args
  ) {
    cache = this;
    return read.apply(this, args);
  });
  let decoded!: () => void;
  const finished = new Promise<void>((resolve) => {
    decoded = resolve;
  });
  const registry = createAssetRegistry({
    scopeId: 'test',
    catalog: createCatalogSource({
      entries: [
        {
          guid,
          kind: 'test-bytes',
          sourcePath: 'test.pack.ts',
          packageUrl: '/test.pack.json',
          publication,
        },
      ],
    }),
    fetcher: async (url, init) => {
      if (String(url).endsWith('.pack.json')) return Response.json(pack);
      if (!init?.signal) throw new Error('artifact read lacks owner signal');
      entered(init.signal);
      return response;
    },
  });
  const kind = defineAssetKind<Uint8Array, 'test-bytes'>('test-bytes');
  registry.installDecoder(kind, {
    decode: async (input) => {
      const result = await input.artifacts.read(descriptor);
      decoded();
      return result.ok ? ok(result.value) : result;
    },
  });
  try {
    const pending = registry.load(guid, kind);
    const signal = await reading;
    registry.dispose();
    expect(signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-runtime-disposed' } });
    finishBody(new Response(bytes));
    await finished;
    expect(cache?.snapshot()).toMatchObject({ entries: 0, pending: 0 });
    expect(registry.snapshot()).toMatchObject({ ready: [], pending: 0, resources: 0 });
  } finally {
    registry.dispose();
    spy.mockRestore();
  }
});

it('observes cancellation before and during a shared cold Catalog read', async () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const enumerate = vi.fn(async () => {
    await gate;
    return ok([]);
  });
  const registry = createAssetRegistry({ catalog: { enumerate, subscribe: () => () => {} } });
  const aborted = new AbortController();
  aborted.abort();
  expect(await registry.load(guid, 'mesh', { signal: aborted.signal })).toMatchObject({
    ok: false,
    error: { code: 'asset-load-cancelled' },
  });
  expect(enumerate).not.toHaveBeenCalled();
  const controller = new AbortController();
  const cancelled = registry.load(guid, 'mesh', { signal: controller.signal });
  const live = registry.load(guid, 'mesh');
  controller.abort();
  expect(await cancelled).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
  finish();
  expect(await live).toMatchObject({ ok: false, error: { code: 'asset-not-found' } });
  expect(enumerate).toHaveBeenCalledTimes(1);
  registry.dispose();
});
