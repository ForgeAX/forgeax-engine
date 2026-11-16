import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { withCombinedSignal } from '@forgeax/engine-platform';
import type {
  AssetEnvelopeV2,
  AssetLoadError,
  AssetPublicationTuple,
  PackageFetcher,
  PackV2,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { freezeRuntimePayload } from './immutable-payload.js';
import { packEnvelopeIssue } from './pack-envelope.js';
import { readPackJson } from './pack-json.js';
import { readPackage } from './package-read.js';
import { assetLoadCancelled, waitForAsset } from './wait-for-asset.js';

interface PackReaderOptions {
  readonly fetcher?: PackageFetcher;
}

export type VerifiedPack = PackV2<unknown>;

function invalid(guid: string, reason: string): Result<never, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a verified Pack v2 envelope with complete runtime artifacts',
    hint: 're-cook the Pack v2 publication and retry the current tuple',
    detail: { guid, reason },
  });
}

function sameTuple(left: AssetPublicationTuple, right: AssetPublicationTuple): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.generation === right.generation &&
    left.digest === right.digest &&
    left.outputSetDigest === right.outputSetDigest
  );
}

/**
 * One fetch per tuple at a time: concurrent readers of the same Pack share the
 * in-flight request. Settled results are not retained here; asset-source owns
 * the per-guid asset cache and the material program table owns program bytes.
 */
export class PackReader {
  private readonly fetcher: PackageFetcher | undefined;
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<string, Promise<Result<VerifiedPack, AssetLoadError>>>();

  constructor(options: PackReaderOptions = {}) {
    // An injected fetcher is an explicit transport lease and is fixed for the
    // reader lifetime. With no injection, resolve the host fetch at read time:
    // App assembly can precede a dev/test host installing its transport.
    this.fetcher = options.fetcher?.bind(globalThis);
  }

  async read(
    packageUrl: string,
    expected: AssetPublicationTuple,
    signal: AbortSignal,
    fetcher?: PackageFetcher,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    if (signal.aborted || this.lifetime.signal.aborted) return err(assetLoadCancelled(packageUrl));
    const key = this.key(packageUrl, expected);
    let request = this.pending.get(key);
    if (request === undefined) {
      const current = this.fetchAndVerify(
        packageUrl,
        expected,
        this.lifetime.signal,
        fetcher,
      ).finally(() => {
        if (this.pending.get(key) === current) this.pending.delete(key);
      });
      this.pending.set(key, current);
      request = current;
    }
    return withCombinedSignal([signal, this.lifetime.signal], (combined) =>
      waitForAsset(request, combined, packageUrl),
    );
  }

  dispose(): void {
    this.lifetime.abort();
    this.pending.clear();
  }

  private async fetchAndVerify(
    packageUrl: string,
    expected: AssetPublicationTuple,
    signal: AbortSignal,
    boundFetcher?: PackageFetcher,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    const fetcher = boundFetcher ?? this.fetcher ?? globalThis.fetch.bind(globalThis);
    const read = await readPackage(fetcher, packageUrl, readPackJson, { signal });
    if (!read.ok) {
      if (read.error.malformed) return invalid(packageUrl, 'invalid JSON');
      if (signal.aborted) return err(assetLoadCancelled(packageUrl));
      return err({
        code: 'asset-fetch-failed',
        expected: 'HTTP 200 for the current Pack URL',
        hint: `${read.error.observed} after ${read.error.attempts} request(s); verify the package locator and republish the Pack`,
        detail: { guid: packageUrl, packageUrl },
      });
    }
    // readPackJson has already decoded the material program table.
    const checked = validatePackEnvelope(read.value, expected);
    if (!checked.ok && checked.error.code === 'asset-package-invalid') {
      return invalid(packageUrl, checked.error.detail.reason);
    }
    if (!checked.ok) return checked;
    return ok(freezeRuntimePayload(read.value as VerifiedPack));
  }

  private key(packageUrl: string, tuple: AssetPublicationTuple): string {
    return `${packageUrl}\u0000${tuple.scopeId}\u0000${tuple.generation}\u0000${tuple.digest}\u0000${tuple.outputSetDigest}`;
  }

  /** Verify a raw document from a caller that did not decode it (publication capture and validation). */
  verify(value: unknown, expected: AssetPublicationTuple): Result<VerifiedPack, AssetLoadError> {
    const decoded = decodeMaterialProgramWire(value);
    if (!decoded.ok) return invalid('', 'invalid material program table');
    const checked = validatePackEnvelope(decoded.value, expected);
    if (!checked.ok) return checked;
    return ok(freezeRuntimePayload(decoded.value as VerifiedPack));
  }
}

/** Complete Pack validation without freezing or retaining the caller's mutable input. */
export function validatePackEnvelope(
  value: unknown,
  expected: AssetPublicationTuple,
): Result<void, AssetLoadError> {
  if (value === null || typeof value !== 'object') return invalid('', 'Pack is not an object');
  const pack = value as Partial<PackV2<unknown>>;
  if (pack.schemaVersion !== '2.0.0' || pack.kind !== 'internal-text-package') {
    return invalid('', 'schemaVersion or kind');
  }
  if (
    typeof pack.scopeId !== 'string' ||
    !Number.isSafeInteger(pack.generation) ||
    typeof pack.digest !== 'string' ||
    typeof pack.outputSetDigest !== 'string' ||
    !sameTuple(pack as AssetPublicationTuple, expected)
  ) {
    return invalid('', 'publication tuple mismatch');
  }
  if (!Array.isArray(pack.assets)) return invalid('', 'assets');
  const guids = new Set<string>();
  for (const raw of pack.assets) {
    const issue = packEnvelopeIssue(raw);
    if (issue !== undefined) return invalid('', issue);
    const asset = raw as Partial<AssetEnvelopeV2<unknown>>;
    const guid = typeof asset.guid === 'string' ? asset.guid : '';
    if (guid.length === 0 || guids.has(guid.toLowerCase())) return invalid(guid, 'duplicate guid');
    guids.add(guid.toLowerCase());
    if (
      typeof asset.kind !== 'string' ||
      asset.payload === undefined ||
      !Array.isArray(asset.refs) ||
      asset.refs.some((ref) => typeof ref !== 'string') ||
      asset.artifacts === null ||
      typeof asset.artifacts !== 'object'
    ) {
      return invalid(guid, 'asset envelope fields');
    }
    for (const [artifactKey, descriptor] of Object.entries(asset.artifacts)) {
      if (!validArtifact(guid, artifactKey, descriptor)) {
        return invalid(guid, `artifact ${artifactKey}`);
      }
    }
  }
  return ok(undefined);
}

function validArtifact(_guid: string, key: string, value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const descriptor = value as Record<string, unknown>;
  const integrity = descriptor.integrity;
  return (
    key.length > 0 &&
    typeof descriptor.path === 'string' &&
    descriptor.path.length > 0 &&
    typeof descriptor.mediaType === 'string' &&
    descriptor.mediaType.length > 0 &&
    (descriptor.contentEncoding === 'identity' || descriptor.contentEncoding === 'zstd') &&
    Number.isSafeInteger(descriptor.byteLength) &&
    Number(descriptor.byteLength) >= 0 &&
    integrity !== null &&
    typeof integrity === 'object' &&
    (integrity as Record<string, unknown>).algorithm === 'sha256' &&
    typeof (integrity as Record<string, unknown>).digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/i.test(String((integrity as Record<string, unknown>).digest))
  );
}
