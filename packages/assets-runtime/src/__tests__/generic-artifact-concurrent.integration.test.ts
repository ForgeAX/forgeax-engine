import { createHash } from 'node:crypto';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type ArtifactDescriptor, type AssetLoadError, err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { ArtifactCache } from '../internal/artifact-cache';
import { runtimeAssetReference } from '../internal/runtime-assets';

const GUID = '01900000-0000-7000-8000-000000000043';
const PACKAGE = 'https://runtime.invalid/generic/pack.json';
const kind = defineAssetKind<{
  bytes: Record<string, Uint8Array>;
  streams: Record<string, string>;
}>('binary-bundle');
const descriptor = (path: string): ArtifactDescriptor => ({
  path,
  mediaType: 'application/octet-stream',
  contentEncoding: 'identity',
  byteLength: 2,
  integrity: {
    algorithm: 'sha256',
    digest: `sha256:${createHash('sha256')
      .update(path === 'second.bin' ? Uint8Array.of(2, 3) : Uint8Array.of(1, 2))
      .digest('hex')}`,
  },
});
const failure = (reason: string): AssetLoadError => ({
  code: 'asset-package-invalid',
  expected: 'valid artifact paths and successful owned reads',
  hint: 'repair this binary bundle',
  detail: { guid: GUID, reason },
});

function deferredPack(
  artifacts: Record<string, ArtifactDescriptor> = {
    first: descriptor('first.bin'),
    second: descriptor('second.bin'),
  },
  beforeConsume?: (registry: AssetRegistry) => void,
) {
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    packageUrl: PACKAGE,
    sourcePath: 'bundle.pack',
    sourceRevision: '1',
    pack: { assets: [{ guid: GUID, kind: kind.kind, payload: {}, refs: [], artifacts }] },
  });
  const pack = publication.pack;
  const originalPack = JSON.stringify(pack);
  const requests: { url: string; release: (response: Response) => void; released: boolean }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === PACKAGE) return new Response(JSON.stringify(pack));
    return new Promise<Response>((release) => requests.push({ url, release, released: false }));
  });
  const registry = new AssetRegistry();
  const consume = vi.fn((bytes: Record<string, Uint8Array>, streams: Record<string, string>) =>
    ok({ bytes, streams }),
  );
  const decode = vi.fn(
    async ({
      envelope,
      artifacts: reader,
      signal,
    }: import('@forgeax/engine-types').AssetDecoderInput<{
      bytes: Record<string, Uint8Array>;
      streams: Record<string, string>;
    }>) => {
      // This domain requests only its declared inputs; Registry owns their transport lifetime.
      const entries = Object.entries(envelope.artifacts);
      const reads = await Promise.allSettled(
        entries.map(async ([, input]) => {
          if (input.delivery === 'stream') {
            const url = reader.locate?.(input);
            return url === undefined ? err(failure(input.path)) : ok(url);
          }
          return reader.read(input);
        }),
      );
      beforeConsume?.(registry);
      if (signal.aborted) return err(failure('cancelled domain preparation'));
      const bytes: Record<string, Uint8Array> = {};
      const streams: Record<string, string> = {};
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const read = reads[index];
        if (!entry || !read) throw new Error('missing read');
        if (read.status === 'rejected') return err(failure(String(read.reason)));
        if (!read.value.ok) return read.value;
        if (typeof read.value.value === 'string') streams[entry[0]] = read.value.value;
        else bytes[entry[0]] = read.value.value;
      }
      return consume(bytes, streams);
    },
  );
  registry.installDecoder(kind, { decode });
  registry.setCatalogSource({
    enumerate: async () =>
      ok([
        {
          guid: GUID,
          kind: kind.kind,
          packageUrl: PACKAGE,
          sourcePath: 'bundle.pack',
          publication: publication.publication,
        },
      ]),
    openPackage: () => fetcher,
    subscribe: () => () => {},
  });
  const loads: Promise<unknown>[] = [];
  const load = () => {
    const pending = registry.load(GUID, kind);
    loads.push(pending);
    return pending;
  };
  const release = (index: number, bytes = Uint8Array.of(index + 1, index + 2)) => {
    const request = requests[index];
    if (!request) throw new Error(`missing deferred request ${index}`);
    request.released = true;
    request.release(new Response(bytes));
  };
  const drain = async () => {
    for (let n = 0; n < 30; n++) {
      for (let i = 0; i < requests.length; i++) if (!requests[i]?.released) release(i);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await Promise.all(loads);
    registry.dispose();
    vi.restoreAllMocks();
  };
  const bothStarted = () =>
    vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 300, interval: 5 });
  return {
    registry,
    consume,
    decode,
    requests,
    fetcher,
    pack,
    originalPack,
    load,
    release,
    drain,
    bothStarted,
  };
}

it('overlaps domain-requested reads and isolates accepted bytes from the wire and decoder', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    expect(f.consume).not.toHaveBeenCalled();
    f.release(1);
    f.release(0);
    const handle = (await pending).unwrap();
    const value = f.registry.read(handle).unwrap();
    expect(Object.keys(value.bytes)).toEqual(['first', 'second']);
    expect(value.bytes.first).toEqual(Uint8Array.of(1, 2));
    expect(value.bytes.second).toEqual(Uint8Array.of(2, 3));
    const consumed = f.consume.mock.calls[0]?.[0].first;
    if (consumed === undefined) throw new Error('missing decoded bytes');
    consumed[0] = 99;
    expect(f.registry.read(handle).unwrap().bytes.first).toEqual(Uint8Array.of(1, 2));
    expect(JSON.stringify(f.pack)).toBe(f.originalPack);
  } finally {
    await f.drain();
  }
});

it('preserves domain-declared error order when the second response fails first', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    f.release(1, Uint8Array.of(3, 4, 5));
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-integrity-failed', detail: { artifactKey: 'first.bin' } },
    });
    expect(f.consume).not.toHaveBeenCalled();
    expect(runtimeAssetReference(f.registry, GUID)).toBeUndefined();
  } finally {
    await f.drain();
  }
});

it('does not fetch an unsafe stream and retains the preceding read failure', async () => {
  const f = deferredPack({
    first: descriptor('first.bin'),
    unsafe: { ...descriptor('../outside.bin'), delivery: 'stream' },
    second: descriptor('second.bin'),
  });
  const pending = f.load();
  try {
    await f.bothStarted();
    f.release(1);
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-integrity-failed', detail: { artifactKey: 'first.bin' } },
    });
    expect(f.requests.map((request) => request.url)).toEqual([
      'https://runtime.invalid/generic/first.bin',
      'https://runtime.invalid/generic/second.bin',
    ]);
    expect(f.consume).not.toHaveBeenCalled();
  } finally {
    await f.drain();
  }
});

it.each([
  '../outside.bin',
  'video.webm',
])('admits stream paths without fetching them: %s', async (path) => {
  const f = deferredPack({
    first: descriptor('first.bin'),
    media: { ...descriptor(path), delivery: 'stream' },
    second: descriptor('second.bin'),
  });
  const pending = f.load();
  try {
    await f.bothStarted();
    f.release(1);
    f.release(0);
    const result = await pending;
    if (path.startsWith('..')) {
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
      expect(f.consume).not.toHaveBeenCalled();
    } else {
      expect(f.registry.read(result.unwrap()).unwrap().streams.media).toBe(
        'https://runtime.invalid/generic/video.webm',
      );
    }
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.drain();
  }
});

it('deduplicates transport and decode across concurrent same-GUID callers', async () => {
  const f = deferredPack();
  const first = f.load();
  const second = f.load();
  try {
    await f.bothStarted();
    f.release(1);
    f.release(0);
    expect((await first).unwrap()).toBe((await second).unwrap());
    expect(f.requests).toHaveLength(2);
    expect(f.decode).toHaveBeenCalledTimes(1);
    expect(f.consume).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await f.drain();
  }
});

it('does not adopt an invalidated in-flight domain result', async () => {
  const f = deferredPack();
  const pending = f.load();
  try {
    await f.bothStarted();
    f.registry.invalidate(GUID);
    f.release(1);
    f.release(0);
    expect(await pending).toMatchObject({ ok: false });
    expect(runtimeAssetReference(f.registry, GUID)).toBeUndefined();
  } finally {
    await f.drain();
  }
});

it('handles an unexpected later cache rejection without overriding the preceding integrity failure', async () => {
  const f = deferredPack();
  const read = ArtifactCache.prototype.read;
  const probe = vi.spyOn(ArtifactCache.prototype, 'read').mockImplementation(function (
    this: ArtifactCache,
    key,
    reader,
  ) {
    return key.includes('second.bin')
      ? Promise.reject(new Error('later read probe'))
      : read.call(this, key, reader);
  });
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), { timeout: 300, interval: 5 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.consume).not.toHaveBeenCalled();
    f.release(0, Uint8Array.of(7));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-integrity-failed', detail: { artifactKey: 'first.bin' } },
    });
  } finally {
    await f.drain();
  }
});

it('rejects publication when the source changes during stream-only preparation', async () => {
  const f = deferredPack(
    { media: { ...descriptor('video.webm'), delivery: 'stream' } },
    (registry) => registry.invalidate(GUID),
  );
  try {
    expect(await f.load()).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(0);
    expect(runtimeAssetReference(f.registry, GUID)).toBeUndefined();
  } finally {
    await f.drain();
  }
});
