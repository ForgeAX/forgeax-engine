import { createHash } from 'node:crypto';
import { createPackageResponse } from '@forgeax/engine-pack/runtime';
import { ok, type PackageResponse } from '@forgeax/engine-types';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ArtifactReadCache, type ArtifactReadRequest } from '../registry/artifact-io';

const bytes = Uint8Array.of(1, 2, 3);
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function request(guid: string, changes: Partial<ArtifactReadRequest> = {}): ArtifactReadRequest {
  return {
    guid,
    packageUrl: 'https://example.test/main.pack.json',
    artifactKey: 'program',
    descriptor: {
      path: 'shared.wgsl',
      mediaType: 'text/wgsl',
      byteLength: bytes.length,
      integrity: { algorithm: 'sha256', digest },
    },
    ...changes,
  };
}
const response = () => new Response(bytes.slice());

it.each([
  'sequential',
  'concurrent',
] as const)('shares the same verified artifact URL across packages: %s', async (mode) => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const first = request('first', { packageUrl: 'https://example.test/first.pack.json' });
  const second = request('second', { packageUrl: 'https://example.test/second.pack.json' });
  const left = cache.readArtifact(first, fetcher);
  if (mode === 'sequential') await left;
  const [a, b] = await Promise.all([left, cache.readArtifact(second, fetcher)]);
  expect(a.unwrap()).toEqual(bytes);
  expect(b.unwrap()).toEqual(bytes);
  expect(a.unwrap()).not.toBe(b.unwrap());
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith('https://example.test/shared.wgsl');
});

it.each([
  './shared.wgsl',
  '%73hared.wgsl',
])('shares only after normalizing the package-relative path: %s', async (path) => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const second = request('second', { packageUrl: 'https://example.test/other.pack.json' });
  const results = await Promise.all([
    cache.readArtifact(request('first'), fetcher),
    cache.readArtifact({ ...second, descriptor: { ...second.descriptor, path } }, fetcher),
  ]);
  for (const result of results) expect(result.unwrap()).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('https://example.test/shared.wgsl');
});

it.each([
  '../shared.wgsl',
  '%2e%2e/shared.wgsl',
  '/shared.wgsl',
  'https://example.test/shared.wgsl',
])('rejects an invalid path before looking up an already shared URL: %s', async (path) => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  expect((await cache.readArtifact(request('first'), fetcher)).unwrap()).toEqual(bytes);
  const invalid = request('invalid', { packageUrl: 'https://example.test/nested/other.pack.json' });
  const result = await cache.readArtifact(
    { ...invalid, descriptor: { ...invalid.descriptor, path } },
    fetcher,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'asset-artifact-path-invalid', detail: { guid: 'invalid' } },
  });
  expect((await cache.readArtifact(request('third'), fetcher)).unwrap()).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('shares pending native reads without retaining completed bytes when WeakRef is unavailable', async () => {
  vi.stubGlobal('WeakRef', undefined);
  try {
    const cache = new ArtifactReadCache();
    let finish!: (response: PackageResponse) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<PackageResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const first = cache.readArtifact(request('first'), fetcher);
    expect(cache.readArtifact(request('first'), fetcher)).toBe(first);
    const second = cache.readArtifact(
      request('second', { packageUrl: 'https://example.test/other.pack.json' }),
      fetcher,
    );
    expect(cache.releaseCompleted()).toBe(0);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(createPackageResponse(bytes));
    const [left, right] = await Promise.all([first, second]);
    expect(left.unwrap()).toEqual(bytes);
    expect(right.unwrap()).toEqual(bytes);
    expect(left.unwrap()).not.toBe(right.unwrap());
    expect(cache.peek('first\0https://example.test/main.pack.json\0program')).toBeUndefined();
    expect(cache.releaseCompleted()).toBe(0);
    const reloaded = cache.readArtifact(request('first'), fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    finish(createPackageResponse(bytes));
    expect((await reloaded).unwrap()).toEqual(bytes);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('verifies each GUID and gives its decoder private bytes after sharing the transfer', async () => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const hash = vi.spyOn(globalThis.crypto.subtle, 'digest');
  try {
    const first = (await cache.readArtifact(request('first'), fetcher)).unwrap();
    first[0] = 9;
    const second = (
      await cache.readArtifact(
        request('second', { packageUrl: 'https://example.test/other.pack.json' }),
        fetcher,
      )
    ).unwrap();
    expect(second).toEqual(bytes);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    hash.mockRestore();
  }
});

it.each([
  'url',
  'path',
  'mediaType',
  'digest',
  'digestRepresentation',
  'length',
  'lengthOmitted',
  'encoding',
  'unverified',
] as const)('keeps distinct publication descriptors out of the shared read: %s', async (kind) => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  let first = request('first');
  let second = request('second', { packageUrl: 'https://example.test/other.pack.json' });
  if (kind === 'url')
    second = { ...second, packageUrl: 'https://example.test/other/main.pack.json' };
  if (kind === 'path')
    second = { ...second, descriptor: { ...second.descriptor, path: 'other.wgsl' } };
  if (kind === 'mediaType')
    second = { ...second, descriptor: { ...second.descriptor, mediaType: 'text/plain' } };
  if (kind === 'digest')
    second = {
      ...second,
      descriptor: {
        ...second.descriptor,
        integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
      },
    };
  if (kind === 'digestRepresentation')
    second = {
      ...second,
      descriptor: {
        ...second.descriptor,
        integrity: { algorithm: 'sha256', digest: digest.slice('sha256:'.length) },
      },
    };
  if (kind === 'length')
    second = { ...second, descriptor: { ...second.descriptor, byteLength: 4 } };
  if (kind === 'lengthOmitted') {
    const { byteLength: _, ...descriptor } = second.descriptor;
    second = { ...second, descriptor };
  }
  if (kind === 'encoding')
    second = { ...second, descriptor: { ...second.descriptor, contentEncoding: 'zstd' } };
  if (kind === 'unverified') {
    const unverified = { path: 'shared.wgsl', mediaType: 'text/wgsl', byteLength: bytes.length };
    first = { ...first, descriptor: unverified };
    second = { ...second, descriptor: unverified };
  }
  expect((await cache.readArtifact(first, fetcher)).ok).toBe(true);
  const result = await cache.readArtifact(second, fetcher);
  expect(result.ok).toBe(!['digest', 'length', 'encoding'].includes(kind));
  if (!result.ok) expect(result.error.detail.guid).toBe('second');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('treats omitted and explicit identity encoding as the same transport contract', async () => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const second = request('second', { packageUrl: 'https://example.test/other.pack.json' });
  const results = await Promise.all([
    cache.readArtifact(request('first'), fetcher),
    cache.readArtifact(
      { ...second, descriptor: { ...second.descriptor, contentEncoding: 'identity' } },
      fetcher,
    ),
  ]);
  for (const result of results) expect(result.unwrap()).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('releases completed cross-package transfers without changing borrowed GUID bytes', async () => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const first = (await cache.readArtifact(request('first'), fetcher)).unwrap();
  expect(cache.releaseCompleted()).toBe(2);
  const second = (
    await cache.readArtifact(
      request('second', { packageUrl: 'https://example.test/other.pack.json' }),
      fetcher,
    )
  ).unwrap();
  expect(fetcher).toHaveBeenCalledTimes(2);
  second[0] = 9;
  expect(first).toEqual(bytes);
});

it.each([
  'corrupt',
  'missing',
] as const)('retries a failed shared %s read with each caller identity intact', async (kind) => {
  // Rejection eviction/retry assumes a live reuse hint. Keep its referents
  // alive; collection is an allowed cache miss and has its own control below.
  const hints: object[] = [];
  const NativeWeakRef = WeakRef;
  vi.stubGlobal(
    'WeakRef',
    class<T extends object> extends NativeWeakRef<T> {
      constructor(value: T) {
        super(value);
        hints.push(value);
      }
    },
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
    hints.length = 0;
  });
  const cache = new ArtifactReadCache();
  let fail = true;
  const fetcher = vi.fn(async () =>
    fail
      ? new Response(Uint8Array.of(9, 2, 3), { status: kind === 'missing' ? 404 : 200 })
      : response(),
  );
  const results = await Promise.all([
    cache.readArtifact(request('first'), fetcher),
    cache.readArtifact(
      request('second', { packageUrl: 'https://example.test/other.pack.json' }),
      fetcher,
    ),
  ]);
  for (const [index, result] of results.entries()) {
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { guid: index === 0 ? 'first' : 'second' } },
    });
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  fail = false;
  expect((await cache.readArtifact(request('first'), fetcher)).unwrap()).toEqual(bytes);
  expect(
    (
      await cache.readArtifact(
        request('second', { packageUrl: 'https://example.test/other.pack.json' }),
        fetcher,
      )
    ).unwrap(),
  ).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  'guid',
  'entry',
  'all',
] as const)('does not retain a cleared pending transfer or let its late failure erase the replacement: %s', async (kind) => {
  const cache = new ArtifactReadCache();
  let finish!: (response: Response) => void;
  let calls = 0;
  const fetcher = vi.fn(async () =>
    ++calls === 1
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : response(),
  );
  const old = cache.readArtifact(request('first'), fetcher);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  if (kind === 'guid') cache.clearPrefix('first\0');
  else if (kind === 'entry') cache.clear('first\0https://example.test/main.pack.json\0program');
  else cache.clear();
  expect(
    (
      await cache.readArtifact(
        request('second', { packageUrl: 'https://example.test/second.pack.json' }),
        fetcher,
      )
    ).unwrap(),
  ).toEqual(bytes);
  finish(new Response(Uint8Array.of(9, 2, 3)));
  expect((await old).ok).toBe(false);
  expect(
    (
      await cache.readArtifact(
        request('third', { packageUrl: 'https://example.test/third.pack.json' }),
        fetcher,
      )
    ).unwrap(),
  ).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('refetches a collected shared transfer without changing already loaded GUID bytes', async () => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const first = (await cache.readArtifact(request('first'), fetcher)).unwrap();
  const collected = vi.spyOn(WeakRef.prototype, 'deref').mockReturnValueOnce(undefined);
  try {
    const second = (await cache.readArtifact(request('second'), fetcher)).unwrap();
    expect(second).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    second[0] = 8;
    expect((await cache.readArtifact(request('first'), fetcher)).unwrap()).toBe(first);
    expect(first).toEqual(bytes);
  } finally {
    collected.mockRestore();
  }
});

it('reloads a collected decoder result instead of pinning every successful GUID forever', async () => {
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  await cache.readArtifact(request('first'), fetcher);
  const collected = vi.spyOn(WeakRef.prototype, 'deref').mockReturnValue(undefined);
  try {
    expect((await cache.readArtifact(request('first'), fetcher)).unwrap()).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    collected.mockRestore();
  }
});

it('does not cache an unexpected decoder rejection', async () => {
  const cache = new ArtifactReadCache();
  const reader = vi.fn(async () => {
    if (reader.mock.calls.length === 1) throw new Error('decoder unavailable');
    return ok(bytes);
  });
  await expect(cache.read('first', reader)).rejects.toThrow('decoder unavailable');
  expect((await cache.read('first', reader)).unwrap()).toEqual(bytes);
  expect(reader).toHaveBeenCalledTimes(2);
});

it('refetches collected weak hints while preserving verified caller-owned bytes', async () => {
  let collected = false;
  vi.stubGlobal(
    'WeakRef',
    class<T extends object> {
      constructor(private readonly value: T) {}
      deref(): T | undefined {
        return collected ? undefined : this.value;
      }
    },
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const cache = new ArtifactReadCache();
  const fetcher = vi.fn(async () => response());
  const first = (await cache.readArtifact(request('first'), fetcher)).unwrap();
  expect(fetcher).toHaveBeenCalledTimes(1);
  collected = true;
  const second = (await cache.readArtifact(request('second'), fetcher)).unwrap();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(first).toEqual(bytes);
  expect(second).toEqual(bytes);
  second[0] = 9;
  expect(first).toEqual(bytes);
});
