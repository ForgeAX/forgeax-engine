import { createHash } from 'node:crypto';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import { describe, expect, it, vi } from 'vitest';
import { BundleTransferDiagnostics } from '../internal/bundle-diagnostics.js';
import { ArtifactReadCache, type ArtifactReadRequest } from '../registry/artifact-io.js';

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('Bundle transfer evidence', () => {
  it('does not require a browser performance clock in native hosts', () => {
    vi.stubGlobal('performance', undefined);
    try {
      const diagnostic = new BundleTransferDiagnostics();
      expect(diagnostic.snapshot()).toMatchObject({
        clock: 'unix-ms',
        sampledAtMs: expect.any(Number),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    true,
    false,
  ])('distinguishes actual Range bodies from whole-file fallbacks (range=%s)', async (supportsRange) => {
    const bodies = [Uint8Array.of(11, 12), Uint8Array.of(21, 22, 23)];
    const bundle = encodeAssetBundle(bodies);
    const cache = new ArtifactReadCache();
    const request = (entry: number): ArtifactReadRequest => {
      const body = bodies[entry];
      const window = bundle.windows[entry];
      if (body === undefined || window === undefined) throw new Error('fixture entry');
      return {
        guid: `owner-${entry}`,
        packageUrl: 'https://game.test/map.pack.json',
        artifactKey: 'body',
        descriptor: {
          path: 'assets/bundles/map.bin',
          mediaType: 'application/octet-stream',
          byteLength: body.byteLength,
          integrity: { algorithm: 'sha256', digest: digest(body) },
          byteRange: { ...window, bundleDigest: digest(bundle.bytes) },
        },
      };
    };
    const fetcher = async (
      _url: string,
      init?: { readonly headers?: Readonly<Record<string, string>> },
    ) => {
      const range = init?.headers?.range;
      const match = range?.match(/bytes=(\d+)-(\d+)/);
      const ranged = supportsRange && match !== undefined && match !== null;
      const bytes = ranged
        ? bundle.bytes.slice(Number(match[1]), Number(match[2]) + 1)
        : bundle.bytes.slice();
      return new Response(bytes, {
        status: ranged ? 206 : 200,
        headers: { 'content-length': String(bytes.length) },
      });
    };
    const first = (await cache.readArtifact(request(0), fetcher)).unwrap();
    expect(first).toEqual(bodies[0]);
    // Trimming resident entries forces a later read without relying on GC timing.
    cache.releaseCompleted();
    const before = cache.inspectTransfers();
    expect((await cache.readArtifact(request(1), fetcher)).unwrap()).toEqual(bodies[1]);
    const after = cache.inspectTransfers();
    expect(after.totals.rangeReads - before.totals.rangeReads).toBe(1);
    expect(after.totals.requestedRangeBytes - before.totals.requestedRangeBytes).toBe(3);
    expect(after.totals.responseEntityBytes - before.totals.responseEntityBytes).toBe(
      supportsRange ? 3 : bundle.bytes.length,
    );
    expect(after.totals.wholeBundleFallbacks - before.totals.wholeBundleFallbacks).toBe(
      supportsRange ? 0 : 1,
    );
    expect(after.totals.fullReads).toBe(1);
    expect(after.totals.decodedEntryBytes).toBe(5);
    expect(after.httpCache).toBe('not-observable');
    expect(after.bundles[0]?.url).toBe('https://game.test/assets/bundles/map.bin');
    after.totals.fullReads = 999;
    expect(cache.inspectTransfers().totals.fullReads).toBe(1);
  });

  it('bounds per-Bundle detail while keeping exact totals and separate byte meanings', () => {
    const diagnostic = new BundleTransferDiagnostics();
    for (let i = 0; i < 200; i++)
      diagnostic.observe(`https://game.test/${i}\0sha256:${i}`, 4, {
        status: 206,
        entityBytes: 4,
        contentLength: 2,
      });
    const snapshot = diagnostic.snapshot();
    expect(snapshot.bundles).toHaveLength(128);
    expect(snapshot.omittedDetailUpdates).toBeGreaterThan(0);
    expect(snapshot.totals.rangeReads).toBe(200);
    expect(snapshot.totals.responseEntityBytes).toBe(800);
    expect(snapshot.totals.declaredContentLengthBytes).toBe(400);
    expect(snapshot.totals.wholeBundleFallbacks).toBe(0);
  });
});
