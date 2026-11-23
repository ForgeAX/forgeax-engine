import { createHash } from 'node:crypto';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { readArtifact } from '../registry/artifact-io';

const guid = '11111111-1111-4111-8111-111111111111';
const bytes = Uint8Array.of(1, 2, 3);
const integrity = {
  algorithm: 'sha256',
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
} as const;

function read(changes: Partial<ArtifactDescriptor>, fetcher: typeof fetch) {
  return readArtifact(
    {
      packageUrl: 'https://example.test/packages/main.pack.json',
      guid,
      artifactKey: 'source',
      descriptor: { path: 'payload.bin', mediaType: 'application/octet-stream', ...changes },
    },
    fetcher,
  );
}

describe('artifact I/O', () => {
  it('rejects an empty media type before fetching bytes', async () => {
    const fetcher = vi.fn();
    expect(await read({ mediaType: '' }, fetcher)).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-media-unsupported' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    '../outside.bin',
    '%2e%2e/outside.bin',
    '%252e%252e/outside.bin',
    '/absolute.bin',
    'https://evil.example/outside.bin',
    '..\\outside.bin',
  ])('rejects unsafe locator %s before reading', async (path) => {
    const fetcher = vi.fn();
    expect(await read({ path }, fetcher)).toMatchObject({
      ok: false,
      error: {
        code: 'asset-artifact-path-invalid',
        detail: { guid, artifactKey: 'source' },
        hint: expect.stringContaining('package-relative'),
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a normalized package-relative artifact and leaves its asset codec metadata to the caller', async () => {
    const fetcher = vi.fn(async () => new Response(bytes));
    expect(
      await read(
        {
          path: './payload.bin',
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', profile: 'uastc' },
          contentEncoding: 'identity',
        },
        fetcher,
      ),
    ).toEqual({ ok: true, value: bytes });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://example.test/packages/payload.bin');
  });

  it('returns structured missing and unsupported encoding errors', async () => {
    expect(
      await read({ path: 'missing.bin' }, async () => new Response(null, { status: 404 })),
    ).toMatchObject({ ok: false, error: { code: 'asset-artifact-missing' } });
    expect(await read({ contentEncoding: 'brotli' as never }, vi.fn())).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-encoding-unsupported' },
    });
  });

  it.each([
    ['valid', bytes],
    ['corrupt', Uint8Array.of(3, 2, 1)],
    ['missing', null],
  ] as const)('verifies a %s stream body against the published digest', async (state, body) => {
    const fetcher = vi.fn(async () => new Response(body, { status: body === null ? 404 : 200 }));
    const result = await read(
      {
        delivery: 'stream',
        path: 'cover.png',
        mediaType: 'image/png',
        byteLength: bytes.byteLength,
        integrity,
      },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (state === 'valid') expect(result).toEqual({ ok: true, value: bytes });
    else
      expect(result).toMatchObject({
        ok: false,
        error: {
          code:
            state === 'missing' ? 'asset-artifact-missing' : 'asset-artifact-integrity-mismatch',
        },
      });
  });

  it('reports a same-sized body with the wrong digest as an integrity mismatch', async () => {
    expect(
      await read(
        {
          contentEncoding: 'identity',
          byteLength: bytes.byteLength,
          integrity,
        },
        async () => new Response(Uint8Array.of(3, 2, 1)),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'asset-artifact-integrity-mismatch',
        expected: expect.stringContaining('sha256'),
        detail: { guid, artifactKey: 'source', observed: expect.any(String) },
      },
    });
  });
});
