import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { decompressZstd } from '@forgeax/engine-codec';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readArtifact } from '../registry/artifact-io';

vi.mock('@forgeax/engine-codec', () => ({ decompressZstd: vi.fn() }));

function request(bytes: Uint8Array) {
  return {
    packageUrl: 'https://example.test/main.pack.json',
    guid: '11111111-1111-4111-8111-111111111111',
    artifactKey: 'body',
    descriptor: {
      path: 'body.bin',
      mediaType: 'application/octet-stream',
      contentEncoding: 'zstd' as const,
      byteLength: bytes.byteLength,
      integrity: {
        algorithm: 'sha256' as const,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  };
}

const fetcher = async () => new Response(Uint8Array.of(0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(decompressZstd).mockReset();
});

describe('artifact native digest snapshot', () => {
  it('submits the original exact view and preserves the native pre-await snapshot', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const backing = Uint8Array.of(99, 1, 2, 3, 88);
    const bytes = backing.subarray(1, 4);
    const readRequest = request(bytes);
    vi.mocked(decompressZstd).mockResolvedValue(ok(bytes));
    const nativeDigest = webcrypto.subtle.digest;
    const seen: Array<{ receiver: unknown; data: unknown }> = [];
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(function (
      this: unknown,
      algorithm,
      data,
    ) {
      seen.push({ receiver: this, data });
      const pending = Reflect.apply(nativeDigest, this, [algorithm, data]) as Promise<ArrayBuffer>;
      // Mutate only after the real native call has synchronously captured input.
      backing.fill(7);
      return pending;
    });
    const result = await readArtifact(readRequest, fetcher);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(bytes);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.receiver).toBe(webcrypto.subtle);
    expect(seen[0]?.data).toBe(bytes);
    expect(bytes.byteOffset).toBe(1);
    expect(bytes.byteLength).toBe(3);
    expect([...backing]).toEqual([7, 7, 7, 7, 7]);
  });

  it('snapshots a SharedArrayBuffer range into an accepted ordinary native input', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const backing = new Uint8Array(new SharedArrayBuffer(5));
    backing.set([99, 1, 2, 3, 88]);
    const bytes = backing.subarray(1, 4);
    const readRequest = request(bytes);
    vi.mocked(decompressZstd).mockResolvedValue(ok(bytes));
    const nativeDigest = webcrypto.subtle.digest;
    const submitted: unknown[] = [];
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(function (
      this: unknown,
      algorithm,
      data,
    ) {
      expect(this).toBe(webcrypto.subtle);
      submitted.push(data);
      const pending = Reflect.apply(nativeDigest, this, [algorithm, data]) as Promise<ArrayBuffer>;
      backing.fill(7);
      return pending;
    });
    const result = await readArtifact(readRequest, fetcher);
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    const data = submitted[0];
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...bytes]).toEqual([7, 7, 7]);
  });

  it('keeps the conservative foreign-realm copy and exact native range snapshot', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const backing = runInNewContext('new Uint8Array([99, 1, 2, 3, 88])') as Uint8Array;
    const bytes = backing.subarray(1, 4);
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(bytes.buffer).not.toBeInstanceOf(ArrayBuffer);
    expect(bytes.byteOffset).toBe(1);
    expect(bytes.byteLength).toBe(3);
    const readRequest = request(bytes);
    vi.mocked(decompressZstd).mockResolvedValue(ok(bytes));
    const nativeDigest = webcrypto.subtle.digest;
    const submitted: unknown[] = [];
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(function (
      this: unknown,
      algorithm,
      data,
    ) {
      expect(this).toBe(webcrypto.subtle);
      submitted.push(data);
      const pending = Reflect.apply(nativeDigest, this, [algorithm, data]) as Promise<ArrayBuffer>;
      // The foreign-realm fallback must still capture only the selected range.
      backing.fill(7);
      return pending;
    });
    const result = await readArtifact(readRequest, fetcher);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(bytes);
    expect(submitted).toHaveLength(1);
    const data = submitted[0];
    expect(data).not.toBe(bytes);
    expect(data).not.toBe(bytes.buffer);
    expect(ArrayBuffer.isView(data)).toBe(false);
    expect(Object.prototype.toString.call(data)).toBe('[object ArrayBuffer]');
    expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...backing]).toEqual([7, 7, 7, 7, 7]);
  });

  it('verifies the exact range with portable SHA-256 when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    const bytes = Uint8Array.of(99, 1, 2, 3, 88).subarray(1, 4);
    vi.mocked(decompressZstd).mockResolvedValue(ok(bytes));
    const readRequest = request(bytes);
    const result = await readArtifact(readRequest, fetcher);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(bytes);
    bytes[0] = 7;
    const corrupted = await readArtifact(readRequest, fetcher);
    expect(corrupted).toMatchObject({
      ok: false,
      error: { code: 'asset-artifact-integrity-mismatch' },
    });
  });

  it('propagates an injected digest rejection without a fallback', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = Uint8Array.of(1, 2, 3);
    vi.mocked(decompressZstd).mockResolvedValue(ok(bytes));
    const rejection = new Error('injected digest rejection');
    vi.spyOn(webcrypto.subtle, 'digest').mockRejectedValueOnce(rejection);
    await expect(readArtifact(request(bytes), fetcher)).rejects.toBe(rejection);
  });
});
