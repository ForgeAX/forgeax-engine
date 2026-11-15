import { createHash } from 'node:crypto';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { type AssetArtifactError, err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BundleStore } from '../internal/bundle-store';
import {
  type ArtifactReadRequest,
  artifactUrl,
  readArtifact,
  readBundledArtifact,
} from '../registry/artifact-io';
import { defined } from './assert-defined';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bodies = [Uint8Array.of(10, 11, 12), Uint8Array.of(20, 21), Uint8Array.of(30)];
const bundle = encodeAssetBundle(bodies);
const stored = bundle.bytes;

function request(guid: string, entry = 0, bytes: Uint8Array = stored): ArtifactReadRequest {
  const body = defined(bodies[entry]);
  return {
    guid,
    packageUrl: 'https://game.test/map.pack.json',
    artifactKey: 'body',
    descriptor: {
      path: 'bundles/map.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'identity',
      byteLength: body.byteLength,
      integrity: { algorithm: 'sha256', digest: hash(body) },
      byteRange: { ...defined(bundle.windows[entry]), bundleDigest: hash(bytes) },
    },
  };
}
const fetcher = () => vi.fn(async () => new Response(stored.slice()));
const store = () => new BundleStore<AssetArtifactError>();

async function bundled(
  bundles: BundleStore<AssetArtifactError>,
  request: ArtifactReadRequest,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const detail = { guid: request.guid, artifactKey: request.artifactKey };
  const read = await readBundledArtifact(bundles, request, {
    fetcher: fetch,
    url: artifactUrl(request.packageUrl, request.descriptor.path),
    unreadable: (error) =>
      'code' in error
        ? error
        : {
            code: 'asset-artifact-missing',
            expected: 'a readable Bundle',
            hint: error.observed,
            detail: {
              ...detail,
              path: request.descriptor.path,
              observed: error.observed,
              expected: 'a readable Bundle',
            },
          },
    rejected: (error) => error,
    invalid: (reason) => ({
      code: 'asset-artifact-integrity-mismatch',
      expected: 'one complete Bundle entry',
      hint: 'rebuild the player package',
      detail: { ...detail, observed: reason, expected: 'one complete Bundle entry' },
    }),
  });
  // One Bundle read can fail several owners; each reports its own request.
  return read.ok
    ? read
    : err({ ...read.error, detail: { ...read.error.detail, ...detail } } as AssetArtifactError);
}

describe('resident Asset Bundles', () => {
  it('decodes a shared compressed group and verifies each selected program independently', async () => {
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const programs = [new Uint8Array(2048).fill(17), new Uint8Array(1024).fill(29)];
    const combined = new Uint8Array(3072);
    combined.set(defined(programs[0]));
    combined.set(defined(programs[1]), 2048);
    const encoded = await compressZstd(combined);
    if (!encoded.ok) throw new Error(encoded.error.code);
    const compressed = encoded.value;
    const packed = encodeAssetBundle([compressed]);
    const fetch = vi.fn(async () => new Response(packed.bytes.slice()));
    const requests = programs.map((bytes, index) => ({
      guid: `group-${index}`,
      packageUrl: 'https://game.test/group.pack.json',
      artifactKey: 'body',
      descriptor: {
        path: 'bundles/group.bin',
        mediaType: 'text/wgsl',
        contentEncoding: 'zstd' as const,
        byteLength: bytes.length,
        integrity: { algorithm: 'sha256' as const, digest: hash(bytes) },
        byteRange: { ...defined(packed.windows[0]), bundleDigest: hash(packed.bytes) },
        decodedRange: { offset: index === 0 ? 0 : 2048, length: bytes.length },
      },
    }));
    const cache = store();
    const results = await Promise.all(requests.map((r) => bundled(cache, r, fetch)));
    expect(results.map((r) => r.unwrap())).toEqual(programs);
    expect(fetch).toHaveBeenCalledTimes(1);
    const bad = defined(requests[1]);
    expect(
      (
        await readArtifact(
          {
            ...bad,
            descriptor: {
              ...bad.descriptor,
              decodedRange: { offset: 2500, length: 1024 },
            },
          },
          fetch,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await readArtifact(
          {
            ...bad,
            descriptor: {
              ...bad.descriptor,
              integrity: { algorithm: 'sha256', digest: hash(defined(programs[0])) },
            },
          },
          fetch,
        )
      ).ok,
    ).toBe(false);
  });

  it('fetches one Bundle for concurrent entries and reuses an extracted entry without refetching', async () => {
    const cache = store(),
      fetch = fetcher();
    const [left, right] = await Promise.all([
      bundled(cache, request('left'), fetch),
      bundled(cache, request('right', 1), fetch),
    ]);
    expect(left.unwrap()).toEqual(Uint8Array.of(10, 11, 12));
    expect(right.unwrap()).toEqual(Uint8Array.of(20, 21));
    // Another owner of the same window receives a verified private copy, not a refetch.
    const third = (await bundled(cache, request('third'), fetch)).unwrap();
    expect(third).toEqual(Uint8Array.of(10, 11, 12));
    expect(third).not.toBe(left.unwrap());
    // A mutated extracted value is never copied into a new owner.
    left.unwrap().fill(0);
    expect((await bundled(cache, request('fifth'), fetch)).unwrap()).toEqual(
      Uint8Array.of(10, 11, 12),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await bundled(cache, request('fourth', 2), fetch)).unwrap()).toEqual(Uint8Array.of(30));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('decodes zstd entries and still verifies each artifact digest', async () => {
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const body = new Uint8Array(4096).fill(9);
    const encoded = await compressZstd(body);
    if (!encoded.ok) throw new Error(encoded.error.code);
    const compressed = encoded.value;
    const packed = encodeAssetBundle([compressed]);
    const fetch = vi.fn(async () => new Response(packed.bytes.slice()));
    const descriptor = {
      path: 'bundles/z.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'zstd' as const,
      byteLength: body.byteLength,
      integrity: { algorithm: 'sha256' as const, digest: hash(body) },
      byteRange: { ...defined(packed.windows[0]), bundleDigest: hash(packed.bytes) },
    };
    const base = { packageUrl: 'https://game.test/z.pack.json', artifactKey: 'body' };
    const cache = store();
    expect((await bundled(cache, { ...base, guid: 'z', descriptor }, fetch)).unwrap()).toEqual(
      body,
    );
    const wrong = await bundled(
      store(),
      {
        ...base,
        guid: 'bad',
        descriptor: { ...descriptor, integrity: { algorithm: 'sha256', digest: hash(compressed) } },
      },
      fetch,
    );
    expect(wrong).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch', detail: { guid: 'bad' } },
    });
  });

  it('matches the standalone path and rejects an entry whose digest differs', async () => {
    const cache = store(),
      fetch = fetcher();
    expect((await readArtifact(request('standalone'), fetch)).unwrap()).toEqual(
      (await bundled(cache, request('first'), fetch)).unwrap(),
    );
    const invalid = request('bad', 1);
    const result = await bundled(
      store(),
      {
        ...invalid,
        descriptor: {
          ...invalid.descriptor,
          integrity: { algorithm: 'sha256', digest: hash(Uint8Array.of(1, 2)) },
        },
      },
      fetch,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-artifact-integrity-mismatch',
        detail: { guid: 'bad', artifactKey: 'body' },
      },
    });
  });

  it('rejects a corrupt Bundle for every pending owner from one fetch', async () => {
    const cache = store();
    const corrupt = stored.slice();
    corrupt[corrupt.length - 1] = 0;
    const fetch = vi.fn(async () => new Response(corrupt));
    const results = await Promise.all([
      bundled(cache, request('left'), fetch),
      bundled(cache, request('right', 1), fetch),
    ]);
    for (const [index, result] of results.entries())
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'asset-artifact-integrity-mismatch',
          detail: { guid: index === 0 ? 'left' : 'right' },
        },
      });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a window that is not one complete Bundle entry', async () => {
    const good = request('bad');
    const result = await bundled(
      store(),
      {
        ...good,
        descriptor: {
          ...good.descriptor,
          byteRange: { ...defined(good.descriptor.byteRange), offset: 13 },
        },
      },
      fetcher(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
  });

  it.each(['clear', 'trim'] as const)('drops Bundle residency on %s', async (operation) => {
    const cache = store(),
      fetch = fetcher();
    await bundled(cache, request('first'), fetch);
    cache[operation]();
    expect((await bundled(cache, request('second', 1), fetch)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks for only a released entry once its Bundle was fetched whole', async () => {
    const cache = store();
    const ranges: (string | undefined)[] = [];
    const fetch = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.range;
      ranges.push(range);
      const match = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      return new Response(
        match === null ? stored.slice() : stored.slice(Number(match[1]), Number(match[2]) + 1),
        { status: match === null ? 200 : 206 },
      );
    });
    await bundled(cache, request('first'), fetch);
    cache.trim();
    expect((await bundled(cache, request('second', 1), fetch)).unwrap()).toEqual(
      Uint8Array.of(20, 21),
    );
    const window = defined(bundle.windows[1]);
    expect(ranges).toEqual([undefined, `bytes=${window.offset}-${window.offset + 1}`]);
    // A ranged entry still answers to its own digest.
    const tampered = vi.fn(async () => new Response(Uint8Array.of(0), { status: 206 }));
    expect(await bundled(cache, request('tampered', 2), tampered)).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch', detail: { guid: 'tampered' } },
    });
  });

  it.each([
    -1,
    0,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])('rejects invalid lengths: %s', async (length) => {
    const good = request('bad');
    const result = await bundled(
      store(),
      {
        ...good,
        descriptor: {
          ...good.descriptor,
          byteRange: { ...defined(good.descriptor.byteRange), length },
        },
      },
      fetcher(),
    );
    expect(result.ok).toBe(false);
  });
});

describe('BundleStore residency', () => {
  const read = (store: BundleStore<string>, entry: number, fetch: () => Promise<unknown>) =>
    store.read({
      url: 'https://game.test/bundles/map.bin',
      range: { ...defined(bundle.windows[entry]), bundleDigest: hash(stored) },
      fetch: async () => {
        await fetch();
        return ok(stored.slice());
      },
      finish: async (bytes) => ok(bytes),
      reuse: async (copy) => ok(copy),
      invalid: (reason) => reason,
    });

  it('moves an extracted entry out of its resident Bundle', async () => {
    const store = new BundleStore<string>();
    const fetch = vi.fn(async () => undefined);
    const first = (await read(store, 0, fetch)).unwrap();
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 3 });
    expect((await read(store, 1, fetch)).unwrap()).toEqual(Uint8Array.of(20, 21));
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 1 });
    // A refetch restores only entries whose extracted value is no longer alive.
    store.trim();
    expect((await read(store, 2, fetch)).unwrap()).toEqual(Uint8Array.of(30));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.snapshot()).toEqual({ bundles: 0, bytes: 0 });
    expect((await read(store, 0, fetch)).unwrap()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used Bundle beyond its residency budget', async () => {
    const store = new BundleStore<string>(3);
    const other = encodeAssetBundle([Uint8Array.of(1, 2, 3, 4)]);
    await read(store, 1, async () => undefined);
    expect(store.snapshot()).toEqual({ bundles: 1, bytes: 4 });
    await store.read({
      url: 'https://game.test/bundles/other.bin',
      range: { ...defined(other.windows[0]), bundleDigest: hash(other.bytes) },
      fetch: async () => ok(other.bytes.slice()),
      finish: async (bytes) => (bytes.byteLength === 4 ? ok(bytes) : err('length')),
      reuse: async (copy) => ok(copy),
      invalid: (reason) => reason,
    });
    expect(store.snapshot()).toEqual({ bundles: 0, bytes: 0 });
  });
});
