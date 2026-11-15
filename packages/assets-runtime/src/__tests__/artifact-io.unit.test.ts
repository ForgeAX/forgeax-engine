import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { readArtifact } from '../registry/artifact-io';

const GUID = '11111111-1111-4111-8111-111111111111';

function descriptor(path: string, changes: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return { path, mediaType: 'application/octet-stream', ...changes };
}

function response(bytes: Uint8Array, ok = true): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: ok ? 200 : 404 });
}

describe('artifact I/O', () => {
  it('rejects an empty media type before fetching artifact bytes', async () => {
    const fetcher = vi.fn();
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/packages/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor('payload.bin', { mediaType: '' }),
      },
      fetcher,
    );

    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error.code).toBe('asset-artifact-media-unsupported');
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
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/packages/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor(path),
      },
      fetcher,
    );

    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error.code).toBe('asset-artifact-path-invalid');
      expect(result.error.detail.guid).toBe(GUID);
      expect(result.error.detail.artifactKey).toBe('source');
      expect(result.error.hint).toContain('package-relative');
    }
  });

  it('reads a normalized package-relative artifact and preserves asset codec metadata as data', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(Uint8Array.of(1, 2, 3)));
    const result = await readArtifact(
      {
        packageUrl: 'https://example.test/packages/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor('./payload.bin', {
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', profile: 'uastc' },
          contentEncoding: 'identity',
        }),
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, value: Uint8Array.of(1, 2, 3) });
    expect(fetcher).toHaveBeenCalledWith('https://example.test/packages/payload.bin');
  });

  it('returns structured missing, encoding, and integrity failures', async () => {
    const missing = await readArtifact(
      {
        packageUrl: 'https://example.test/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor('missing.bin'),
      },
      vi.fn().mockResolvedValue(response(new Uint8Array(), false)),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('asset-artifact-missing');

    const unsupported = await readArtifact(
      {
        packageUrl: 'https://example.test/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor('payload.bin', { contentEncoding: 'brotli' as never }),
      },
      vi.fn(),
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe('asset-artifact-encoding-unsupported');

    const integrity = await readArtifact(
      {
        packageUrl: 'https://example.test/main.pack.json',
        guid: GUID,
        artifactKey: 'source',
        descriptor: descriptor('payload.bin', {
          integrity: { algorithm: 'sha256', digest: 'not-the-digest' },
        }),
      },
      vi.fn().mockResolvedValue(response(Uint8Array.of(1, 2, 3))),
    );
    expect(integrity.ok).toBe(false);
    if (!integrity.ok) {
      expect(integrity.error.code).toBe('asset-artifact-integrity-mismatch');
      expect(integrity.error.detail.guid).toBe(GUID);
      expect(integrity.error.detail.artifactKey).toBe('source');
    }
  });
});
