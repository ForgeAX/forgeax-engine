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
  it.each([
    ['ordinary', () => Uint8Array.of(99, 1, 2, 3, 88)],
    [
      'shared',
      () => {
        const view = new Uint8Array(new SharedArrayBuffer(5));
        view.set([99, 1, 2, 3, 88]);
        return view;
      },
    ],
    ['foreign-realm', () => runInNewContext('new Uint8Array([99, 1, 2, 3, 88])') as Uint8Array],
  ] as const)('captures the exact %s range before the native hash yields', async (mode, makeBacking) => {
    vi.stubGlobal('crypto', webcrypto);
    const backing = makeBacking();
    const bytes = backing.subarray(1, 4);
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(bytes.byteOffset).toBe(1);
    expect(bytes.byteLength).toBe(3);
    if (mode === 'foreign-realm') expect(bytes.buffer).not.toBeInstanceOf(ArrayBuffer);
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
      // Mutate after the native call has captured its input.
      backing.fill(7);
      return pending;
    });
    const result = await readArtifact(readRequest, fetcher);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(bytes);
    expect(submitted).toHaveLength(1);
    const data = submitted[0];
    if (mode === 'ordinary') expect(data).toBe(bytes);
    else {
      expect(data).not.toBe(bytes.buffer);
      if (mode === 'shared') expect(data).toBeInstanceOf(ArrayBuffer);
      else {
        expect(data).not.toBe(bytes);
        expect(ArrayBuffer.isView(data)).toBe(false);
        expect(Object.prototype.toString.call(data)).toBe('[object ArrayBuffer]');
      }
      expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([1, 2, 3]);
    }
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
