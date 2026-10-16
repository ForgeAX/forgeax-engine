import { createHash } from 'node:crypto';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { readArtifact } from '../registry/artifact-io';

const GUID = '22222222-2222-4222-8222-222222222222';

describe('artifact integrity and outer encoding', () => {
  it.each([
    'valid',
    'corrupt',
    'missing',
  ] as const)('explicitly reads and verifies a native stream body (%s)', async (state) => {
    const bytes = Uint8Array.of(1, 2, 3);
    const fetcher = vi.fn(async () =>
      state === 'missing'
        ? new Response(null, { status: 404 })
        : new Response(state === 'corrupt' ? Uint8Array.of(3, 2, 1) : bytes),
    );
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/ui.pack.json',
        guid: GUID,
        artifactKey: 'image',
        descriptor: {
          delivery: 'stream',
          path: 'cover.png',
          mediaType: 'image/png',
          byteLength: bytes.byteLength,
          integrity: {
            algorithm: 'sha256',
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
        },
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

  it('rejects an artifact without a durable media type', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.of(1)));
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'payload',
        descriptor: {
          path: 'payload.bin',
          mediaType: '',
        },
      },
      fetcher,
    );

    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error.code).toBe('asset-artifact-media-unsupported');
  });

  it('checks byte length and integrity after outer decoding', async () => {
    const descriptor: ArtifactDescriptor = {
      path: 'payload.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'identity',
      byteLength: 3,
      integrity: {
        algorithm: 'sha256',
        digest: 'sha256-of-decoded-bytes',
      },
    };
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'payload',
        descriptor,
      },
      vi.fn().mockResolvedValue(new Response(Uint8Array.of(1, 2, 3))),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-artifact-integrity-mismatch');
      expect(result.error.expected).toContain('sha256');
      expect(result.error.detail.observed).toBeTruthy();
    }
  });

  it('reports a same-sized published artifact with the wrong digest as an integrity mismatch', async () => {
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'shader',
        descriptor: {
          path: 'shader.wgsl',
          mediaType: 'text/wgsl',
          byteLength: 4,
          integrity: { algorithm: 'sha256', digest: 'sha256:published-digest' },
        },
      },
      vi.fn().mockResolvedValue(new Response(Uint8Array.of(1, 2, 3, 4))),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
  });

  it('does not pass asset codec names to the outer decoder', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.of(7, 8)));
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/pkg.pack.json',
        guid: GUID,
        artifactKey: 'texture',
        descriptor: {
          path: 'texture.data',
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', profile: 'etc1s' },
          contentEncoding: 'identity',
        },
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, value: Uint8Array.of(7, 8) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
