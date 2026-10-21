import { decompressZstd } from '@forgeax/engine-codec';
import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import type { ArtifactDescriptor, AssetArtifactError, PackageRequest } from '@forgeax/engine-types';
import { encodeBase64, err, ok, type Result } from '@forgeax/engine-types';
import { sha256 as hashSha256 } from '@noble/hashes/sha2.js';
import { ArtifactCache } from '../internal/artifact-cache.js';
import {
  bytesOf,
  type PackageFetcher,
  type PackageReadFailure,
  readPackage,
} from '../internal/package-read.js';
import { traceAssetLoadPhase } from './load-trace';

export interface ArtifactReadRequest {
  readonly packageUrl: string;
  readonly guid: string;
  readonly artifactKey: string;
  readonly descriptor: ArtifactDescriptor;
}

type ArtifactFetcher = PackageFetcher;

function failure(
  code: AssetArtifactError['code'],
  request: ArtifactReadRequest,
  expected: string,
  hint: string,
  observed: string,
): AssetArtifactError {
  if (code === 'asset-artifact-missing') {
    return {
      code,
      expected,
      hint,
      detail: {
        guid: request.guid,
        artifactKey: request.artifactKey,
        path: request.descriptor.path,
        observed,
        expected,
      },
    };
  }
  return {
    code,
    expected,
    hint,
    detail: {
      guid: request.guid,
      artifactKey: request.artifactKey,
      observed,
      expected,
    },
  };
}

export function artifactUrl(packageUrl: string, path: string): string {
  try {
    return new URL(path, new URL(packageUrl, globalThis.location?.href)).toString();
  } catch {
    const queryIndex = packageUrl.search(/[?#]/);
    const cleanPackageUrl = queryIndex < 0 ? packageUrl : packageUrl.slice(0, queryIndex);
    const slash = cleanPackageUrl.lastIndexOf('/');
    return `${slash < 0 ? '' : cleanPackageUrl.slice(0, slash + 1)}${path}`;
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return hashSha256(bytes);
  // Web Crypto snapshots the exact view before returning its Promise.
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : (bytes.slice().buffer as ArrayBuffer);
  return new Uint8Array(await subtle.digest('SHA-256', input));
}

async function decodeOuter(
  bytes: Uint8Array,
  request: ArtifactReadRequest,
): Promise<Result<Uint8Array, AssetArtifactError>> {
  const encoding = request.descriptor.contentEncoding ?? 'identity';
  if (encoding === 'identity') return ok(bytes);
  if (encoding !== 'zstd') {
    return err(
      failure(
        'asset-artifact-encoding-unsupported',
        request,
        "contentEncoding 'identity' or 'zstd'",
        'change the descriptor to a supported outer content encoding and re-cook the package',
        encoding,
      ),
    );
  }
  const decoded = await decompressZstd(bytes);
  if (!decoded.ok) {
    return err(
      failure(
        'asset-artifact-decode-failed',
        request,
        'valid bytes for the declared outer content encoding',
        're-cook the artifact and verify the stored bytes before loading again',
        JSON.stringify(decoded.error.detail),
      ),
    );
  }
  return ok(decoded.value);
}

async function verifyBytes(
  bytes: Uint8Array,
  request: ArtifactReadRequest,
): Promise<Result<Uint8Array, AssetArtifactError>> {
  const expectedLength = request.descriptor.byteLength;
  if (expectedLength !== undefined && expectedLength !== bytes.byteLength) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `decoded artifact byteLength ${expectedLength}`,
        're-cook the package or update its artifact descriptor to match the bytes',
        String(bytes.byteLength),
      ),
    );
  }
  const integrity = request.descriptor.integrity;
  if (integrity === undefined) return ok(bytes);
  const digest = await sha256(bytes);
  const expectedDigest = integrity.digest.startsWith('sha256:')
    ? integrity.digest.slice('sha256:'.length)
    : integrity.digest;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const matches = /^[0-9a-f]{64}$/i.test(expectedDigest)
    ? expectedDigest.toLowerCase() === hex
    : expectedDigest === encodeBase64(digest);
  if (!matches) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `sha256 digest ${integrity.digest}`,
        're-cook the artifact or replace the corrupted stored bytes',
        hex,
      ),
    );
  }
  return ok(bytes);
}

export async function readStoredArtifact(
  request: ArtifactReadRequest,
  fetcher: ArtifactFetcher,
  url: string,
  range?: ArtifactDescriptor['byteRange'],
  init?: PackageRequest,
): Promise<Result<Uint8Array, PackageReadFailure | AssetArtifactError>> {
  const read = await readPackage(fetcher, url, bytesOf, init);
  if (!read.ok || range === undefined) return read;
  return verifyBytes(read.value, {
    ...request,
    descriptor: {
      path: request.descriptor.path,
      mediaType: request.descriptor.mediaType,
      integrity: { algorithm: 'sha256', digest: range.containerDigest },
    },
  });
}

export async function readArtifact(
  request: ArtifactReadRequest,
  fetcher: ArtifactFetcher = (url, init) => globalThis.fetch(url, init),
  readBytes: (
    url: string,
    range?: ArtifactDescriptor['byteRange'],
  ) => Promise<Result<Uint8Array, PackageReadFailure | AssetArtifactError>> = async (
    url,
    range,
  ) => {
    const read = await readStoredArtifact(request, fetcher, url, range);
    return !read.ok || range === undefined
      ? read
      : ok(read.value.slice(range.offset, range.offset + range.length));
  },
): Promise<Result<Uint8Array, AssetArtifactError>> {
  if (request.descriptor.mediaType.trim().length === 0) {
    return err(
      failure(
        'asset-artifact-media-unsupported',
        request,
        'a non-empty durable artifact mediaType',
        'set the artifact mediaType during production and re-publish the package',
        request.descriptor.mediaType,
      ),
    );
  }
  const path = validateArtifactPath(request.descriptor.path, {
    packageRoot: request.packageUrl,
    guid: request.guid,
    artifactKey: request.artifactKey,
  });
  if (!path.ok) return path;

  const encoding = request.descriptor.contentEncoding ?? 'identity';
  if (encoding !== 'identity' && encoding !== 'zstd') {
    return err(
      failure(
        'asset-artifact-encoding-unsupported',
        request,
        "contentEncoding 'identity' or 'zstd'",
        'change the descriptor to a supported outer content encoding and re-cook the package',
        encoding,
      ),
    );
  }

  const range = request.descriptor.byteRange;
  if (
    range !== undefined &&
    (range === null ||
      typeof range !== 'object' ||
      typeof range.containerDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(range.containerDigest) ||
      !Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range.length) ||
      range.length <= 0 ||
      !Number.isSafeInteger(range.offset + range.length) ||
      request.descriptor.delivery !== undefined ||
      (request.descriptor.contentEncoding ?? 'identity') !== 'identity' ||
      request.descriptor.integrity === undefined)
  )
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        'a safe stored byte window with individual artifact integrity and no streaming delivery',
        'rebuild the artifact transport and retry the same GUID',
        'invalid byteRange',
      ),
    );

  const url = artifactUrl(request.packageUrl, path.value);
  traceAssetLoadPhase('artifact.fetch.start', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { url },
  });
  const read = await readBytes(url, range);
  if (!read.ok) {
    if ('code' in read.error)
      return err(
        failure(
          read.error.code,
          request,
          read.error.expected,
          read.error.hint,
          read.error.detail.observed,
        ),
      );
    return err(
      failure(
        'asset-artifact-missing',
        request,
        `readable artifact at ${path.value}`,
        `${read.error.observed} at ${url}; publish the artifact at the declared package-relative path and retry the load (${read.error.attempts} request(s))`,
        read.error.observed,
      ),
    );
  }
  if (range !== undefined && read.value.byteLength !== range.length)
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `stored artifact window length ${range.length}`,
        'rebuild the artifact transport and retry the same GUID',
        String(read.value.byteLength),
      ),
    );
  const bytes = read.value;
  traceAssetLoadPhase('artifact.body.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { byteLength: bytes.byteLength },
  });
  const decoded = await decodeOuter(bytes, request);
  if (!decoded.ok) return decoded;
  traceAssetLoadPhase('artifact.decode.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { byteLength: decoded.value.byteLength },
  });
  const verified = await verifyBytes(decoded.value, request);
  traceAssetLoadPhase('artifact.verify.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { ok: verified.ok },
  });
  return verified;
}

export class ArtifactReadCache {
  private readonly chunks = new ArtifactCache<PackageReadFailure | AssetArtifactError>(
    4 * 1024 * 1024,
    256,
  );
  private readonly cache = new Map<
    string,
    Promise<Result<Uint8Array, AssetArtifactError>> | WeakRef<Uint8Array>
  >();
  private readonly transfers = new Map<
    string,
    Promise<Result<Uint8Array, PackageReadFailure>> | WeakRef<Uint8Array>
  >();

  readArtifact(
    request: ArtifactReadRequest,
    fetcher: ArtifactFetcher,
  ): Promise<Result<Uint8Array, AssetArtifactError>> {
    const key = `${request.guid.toLowerCase()}\0${request.packageUrl}\0${request.artifactKey}`;
    return this.read(key, async () => {
      const { descriptor } = request;
      const { integrity } = descriptor;
      if (descriptor.byteRange !== undefined) {
        return readArtifact(request, fetcher, (url, range) =>
          this.chunks.read(
            `${url}\0${range?.containerDigest}`,
            () => readStoredArtifact(request, fetcher, url, range),
            range,
          ),
        );
      }
      // A mutable URL alone cannot attest shared content. Unverified artifacts
      // retain their original GUID-local transport and invalidation behavior.
      if (integrity === undefined) return readArtifact(request, fetcher);
      let transferKey: string | undefined;
      let transfer:
        | Promise<Result<Uint8Array, PackageReadFailure>>
        | WeakRef<Uint8Array>
        | undefined;
      const result = await readArtifact(request, fetcher, async (url) => {
        transferKey = JSON.stringify([
          url,
          descriptor.mediaType,
          descriptor.contentEncoding ?? 'identity',
          descriptor.byteLength,
          integrity.algorithm,
          integrity.digest,
        ]);
        transfer = this.transfers.get(transferKey);
        if (transfer !== undefined && 'deref' in transfer) {
          const bytes = transfer.deref();
          if (bytes !== undefined) return ok(bytes.slice());
          transfer = undefined;
        }
        if (transfer === undefined) {
          transfer = readPackage(fetcher, url, bytesOf);
          this.transfers.set(transferKey, transfer);
        }
        const bytes = await transfer;
        if (bytes.ok && this.transfers.get(transferKey) === transfer) {
          // Completed transfers must not pin a second raw copy of every asset.
          // Collection is an ordinary cache miss; GUID bytes keep their owner.
          if (typeof WeakRef === 'function') {
            transfer = new WeakRef(bytes.value);
            this.transfers.set(transferKey, transfer);
          } else this.transfers.delete(transferKey);
        }
        // Decode, integrity checks and loader-owned bytes remain GUID-local.
        return bytes.ok ? ok(bytes.value.slice()) : bytes;
      });
      if (!result.ok && transferKey !== undefined && this.transfers.get(transferKey) === transfer)
        this.transfers.delete(transferKey);
      return result;
    });
  }

  /** Borrow only completed bytes; independent fixed captures never wait on domain I/O. */
  peek(key: string): Uint8Array | undefined {
    const existing = this.cache.get(key);
    return existing !== undefined && 'deref' in existing ? existing.deref() : undefined;
  }

  read(
    key: string,
    reader: () => Promise<Result<Uint8Array, AssetArtifactError>>,
  ): Promise<Result<Uint8Array, AssetArtifactError>> {
    const existing = this.cache.get(key);
    if (existing !== undefined && !('deref' in existing)) return existing;
    const bytes = existing?.deref();
    if (bytes !== undefined) return Promise.resolve(ok(bytes));
    const pending = reader();
    this.cache.set(key, pending);
    void pending.then(
      (result) => {
        if (this.cache.get(key) !== pending) return;
        // Decoders own their private bytes. Retain only a reuse hint after
        // completion, not a second copy of every loaded GUID's artifacts.
        if (result.ok && typeof WeakRef === 'function')
          this.cache.set(key, new WeakRef(result.value));
        else this.cache.delete(key);
      },
      () => {
        if (this.cache.get(key) === pending) this.cache.delete(key);
      },
    );
    return pending;
  }

  /** Drop only settled copies; active readers retain their shared request identity. */
  releaseCompleted(): number {
    let released = this.chunks.snapshot().entries;
    this.chunks.trim();
    for (const cache of [this.cache, this.transfers]) {
      for (const [key, entry] of cache) {
        if (!('deref' in entry)) continue;
        cache.delete(key);
        released++;
      }
    }
    return released;
  }

  clear(key?: string): void {
    this.transfers.clear();
    this.chunks.clear();
    if (key === undefined) this.cache.clear();
    else this.cache.delete(key);
  }

  clearPrefix(prefix: string): void {
    // Existing GUID generation fences reject old callers. Clearing physical
    // reads also forces fresh bytes after invalidation, without another lease table.
    this.transfers.clear();
    this.chunks.clear();
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }
}
