import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactReadCache, type ArtifactReadRequest, readArtifact } from '../registry/artifact-io';
import { defined } from './assert-defined';

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stored = Uint8Array.of(99, 10, 11, 12, 20, 21, 88);
function request(guid: string, offset = 1, length = 3): ArtifactReadRequest {
  return {
    guid,
    packageUrl: 'https://game.test/map.pack.json',
    artifactKey: 'body',
    descriptor: {
      path: 'chunk.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'identity',
      byteLength: length,
      integrity: { algorithm: 'sha256', digest: hash(stored.slice(offset, offset + length)) },
      byteRange: { offset, length, containerDigest: hash(stored) },
    },
  };
}
const fetcher = () => vi.fn(async () => new Response(stored.slice()));

describe('bounded verified artifact chunks', () => {
  it('evicts completed chunks once the private 4 MiB budget is full', async () => {
    const cache = new ArtifactReadCache();
    const bytes = new Uint8Array(64 * 1024).fill(7);
    const fetch = vi.fn(async () => new Response(bytes.slice()));
    const make = (index: number): ArtifactReadRequest => ({
      ...request(`asset-${index}`),
      descriptor: {
        ...request('unused').descriptor,
        path: `chunk-${index}.bin`,
        byteLength: 1,
        integrity: { algorithm: 'sha256', digest: hash(bytes.slice(0, 1)) },
        byteRange: { offset: 0, length: 1, containerDigest: hash(bytes) },
      },
    });
    for (let index = 0; index < 65; index++)
      expect((await cache.readArtifact(make(index), fetch)).unwrap()).toEqual(Uint8Array.of(7));
    await cache.readArtifact(make(64), fetch);
    expect(fetch).toHaveBeenCalledTimes(65);
    await cache.readArtifact({ ...make(0), guid: 'new-caller' }, fetch);
    expect(fetch).toHaveBeenCalledTimes(66);
  });

  it('reads and verifies one container for concurrent independent windows and keeps decoder bytes private', async () => {
    const cache = new ArtifactReadCache(),
      fetch = fetcher();
    const [left, right] = await Promise.all([
      cache.readArtifact(request('left'), fetch),
      cache.readArtifact(request('right', 4, 2), fetch),
    ]);
    expect(left.unwrap()).toEqual(Uint8Array.of(10, 11, 12));
    expect(right.unwrap()).toEqual(Uint8Array.of(20, 21));
    left.unwrap().fill(0);
    expect((await cache.readArtifact(request('third'), fetch)).unwrap()).toEqual(
      Uint8Array.of(10, 11, 12),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('matches the standalone path and still verifies each artifact digest after a container cache hit', async () => {
    const cache = new ArtifactReadCache(),
      fetch = fetcher();
    expect((await readArtifact(request('standalone'), fetch)).unwrap()).toEqual(
      (await cache.readArtifact(request('first'), fetch)).unwrap(),
    );
    const invalid = request('bad');
    const result = await cache.readArtifact(
      {
        ...invalid,
        descriptor: {
          ...invalid.descriptor,
          integrity: { algorithm: 'sha256', digest: hash(Uint8Array.of(1, 2, 3)) },
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
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects corruption outside the selected window and keeps each pending failure owner', async () => {
    const cache = new ArtifactReadCache();
    const corrupt = stored.slice();
    corrupt[0] = 0;
    const fetch = vi.fn(async () => new Response(corrupt));
    const results = await Promise.all(
      ['left', 'right'].map((guid) => cache.readArtifact(request(guid), fetch)),
    );
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

  it.each([
    'clear',
    'clearPrefix',
    'releaseCompleted',
  ] as const)('releases container reuse on %s', async (operation) => {
    const cache = new ArtifactReadCache(),
      fetch = fetcher();
    await cache.readArtifact(request('first'), fetch);
    if (operation === 'clearPrefix') cache.clearPrefix('first\0');
    else cache[operation]();
    expect((await cache.readArtifact(request('second'), fetch)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not republish an invalidated pending container into the next generation', async () => {
    const cache = new ArtifactReadCache();
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = cache.readArtifact(request('first'), fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    cache.clear();
    release(new Response(stored.slice()));
    await first;
    const next = cache.readArtifact(request('next'), fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release(new Response(stored.slice()));
    expect((await next).ok).toBe(true);
  });

  it.each([
    -1,
    0,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])('rejects invalid/out-of-bounds lengths: %s', async (length) => {
    const cache = new ArtifactReadCache(),
      fetch = fetcher();
    const good = request('bad');
    const result = await cache.readArtifact(
      {
        ...good,
        descriptor: {
          ...good.descriptor,
          byteRange: { ...defined(good.descriptor.byteRange), length },
        },
      },
      fetch,
    );
    expect(result.ok).toBe(false);
  });

  it('keys cached containers by declared content identity rather than mutable URLs', async () => {
    const cache = new ArtifactReadCache();
    const bytes = stored.slice();
    const fetch = vi.fn(async () => new Response(bytes.slice()));
    expect((await cache.readArtifact(request('first'), fetch)).ok).toBe(true);
    bytes[1] = 55;
    const next = request('next');
    const result = await cache.readArtifact(
      {
        ...next,
        descriptor: {
          ...next.descriptor,
          integrity: { algorithm: 'sha256', digest: hash(bytes.slice(1, 4)) },
          byteRange: { offset: 1, length: 3, containerDigest: hash(bytes) },
        },
      },
      fetch,
    );
    expect(result.unwrap()).toEqual(Uint8Array.of(55, 11, 12));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
