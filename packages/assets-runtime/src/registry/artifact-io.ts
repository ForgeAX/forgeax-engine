import {
  copyRetainedZstdBytes,
  decompressRetainedZstd,
  decompressZstd,
} from '@forgeax/engine-codec';
import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import {
  artifactDigestHex,
  decodedArtifactRangeIssue,
  matchesArtifactSha256,
  selectDecodedArtifactBytes,
  storedArtifactRangeIssue,
} from '@forgeax/engine-pack/bundle';
import type { ArtifactDescriptor, AssetArtifactError, PackageRequest } from '@forgeax/engine-types';
import { beginLoadTimeline, err, ok, type Result } from '@forgeax/engine-types';
import { sha256 as hashSha256 } from '@noble/hashes/sha2.js';
import type { BundleTransferObservation } from '../internal/bundle-diagnostics.js';
import type { BundleStore } from '../internal/bundle-store.js';
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

export async function decodeArtifactTransport(
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
  const decoded = await (request.descriptor.mediaType === 'text/wgsl'
    ? decompressRetainedZstd(bytes)
    : decompressZstd(bytes));
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

export async function finishArtifactBytes(
  bytes: Uint8Array,
  request: ArtifactReadRequest,
): Promise<Result<Uint8Array, AssetArtifactError>> {
  const selected = selectDecodedArtifactBytes(bytes, request.descriptor);
  if (!selected.ok)
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        'a bounded decoded artifact window',
        'rebuild the player package and retry',
        selected.error,
      ),
    );
  const verified = await verifyArtifactBytes(selected.value, request);
  if (verified.ok && selected.value !== bytes)
    copyRetainedZstdBytes(bytes, verified.value, request.descriptor.decodedRange?.offset ?? 0);
  return verified;
}

export async function verifyArtifactBytes(
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
  if (!matchesArtifactSha256(integrity.digest, digest)) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `sha256 digest ${integrity.digest}`,
        're-cook the artifact or replace the corrupted stored bytes',
        artifactDigestHex(digest),
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
  entry = false,
  observe?: (response: BundleTransferObservation) => void,
): Promise<Result<Uint8Array, PackageReadFailure | AssetArtifactError>> {
  const window =
    entry && range !== undefined
      ? { ...init, headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
      : init;
  const read = await readPackage(
    fetcher,
    url,
    async (response) => {
      const bytes = await bytesOf(response);
      const header = response.headers.get('content-length');
      const length = header === null ? NaN : Number(header);
      observe?.({
        status: response.status,
        entityBytes: bytes.byteLength,
        contentLength: Number.isSafeInteger(length) && length >= 0 ? length : null,
      });
      return bytes;
    },
    window,
  );
  if (!read.ok || range === undefined) return read;
  // A whole Bundle is always longer than one entry; the entry's owner verifies it.
  if (entry && read.value.byteLength === range.length) return read;
  return verifyArtifactBytes(read.value, {
    ...request,
    descriptor: {
      path: request.descriptor.path,
      mediaType: request.descriptor.mediaType,
      integrity: { algorithm: 'sha256', digest: range.bundleDigest },
    },
  });
}

export interface BundledArtifactRead<Failure> {
  readonly fetcher: ArtifactFetcher;
  /** Resolved Bundle file URL. */
  readonly url: string;
  readonly init?: PackageRequest;
  /** The Bundle could not be read or did not match its digest. */
  unreadable(error: PackageReadFailure | AssetArtifactError): Failure;
  /** This owner's entry failed to decode or verify. */
  rejected(error: AssetArtifactError): Failure;
  /** The stored window is not one complete Bundle entry. */
  invalid(reason: string): Failure;
}

/** Read one Bundle entry through the resident Bundle store and verify it for `request`. */
export async function readBundledArtifact<Failure>(
  bundles: BundleStore<Failure>,
  request: ArtifactReadRequest,
  read: BundledArtifactRead<Failure>,
): Promise<Result<Uint8Array, Failure>> {
  const { descriptor } = request;
  const range = descriptor.byteRange;
  if (range === undefined) return err(read.invalid('no Bundle window'));
  const { url, fetcher } = read;
  const grouped = descriptor.decodedRange !== undefined;
  const rejected = (result: Result<Uint8Array, AssetArtifactError>) =>
    result.ok ? result : err(read.rejected(result.error));
  const entry = await bundles.read({
    url,
    range,
    fetch: async (window) => {
      const fetched = await readStoredArtifact(
        request,
        fetcher,
        url,
        range,
        read.init,
        window,
        (response) =>
          bundles.transfers.observe(
            `${url}\0${range.bundleDigest}`,
            window ? range.length : undefined,
            response,
          ),
      );
      return fetched.ok ? fetched : err(read.unreadable(fetched.error));
    },
    finish: async (stored) =>
      rejected(
        grouped
          ? await decodeArtifactTransport(stored, request)
          : await readArtifact(request, fetcher, async () => ok(stored)),
      ),
    reuse: async (copy) =>
      grouped ? ok(copy) : rejected(await verifyArtifactBytes(copy, request)),
    invalid: read.invalid,
    // A decoded group is read only to select and verify a private member.
    shared: grouped,
    ...(descriptor.integrity === undefined || grouped
      ? {}
      : { digest: descriptor.integrity.digest }),
  });
  // A decoded group is shared; each owner selects and verifies its own range.
  return entry.ok && grouped ? rejected(await finishArtifactBytes(entry.value, request)) : entry;
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
  const decodedIssue = decodedArtifactRangeIssue(request.descriptor);
  if (decodedIssue !== undefined)
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        'a bounded decoded artifact window',
        'rebuild the player package and retry',
        decodedIssue,
      ),
    );
  if (storedArtifactRangeIssue(request.descriptor) !== undefined)
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
  const endDecode = beginLoadTimeline('decode', url, {
    stage: 'artifact',
    encoding,
    guid: request.guid,
  });
  const decoded = await decodeArtifactTransport(bytes, request);
  if (!decoded.ok) return decoded;
  traceAssetLoadPhase('artifact.decode.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { byteLength: decoded.value.byteLength },
  });
  const verified = await finishArtifactBytes(decoded.value, request);
  endDecode(decoded.value.byteLength, { verified: verified.ok });
  traceAssetLoadPhase('artifact.verify.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { ok: verified.ok },
  });
  return verified;
}
