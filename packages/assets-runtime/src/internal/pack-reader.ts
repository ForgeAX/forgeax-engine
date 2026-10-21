import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import type {
  AssetEnvelopeV2,
  AssetLoadError,
  AssetPublicationTuple,
  PackageFetcher,
  PackV2,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { packEnvelopeIssue } from './pack-envelope.js';
import { readPackage } from './package-read.js';
import { readRetainedPackJson } from './retained-pack-json.js';
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

/** Freeze an owned value; never pass a mutable retained Pack to this helper. */
export function freezePackValue<T>(value: T): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezePackValue(child);
  }
  return value;
}

function sameTuple(left: AssetPublicationTuple, right: AssetPublicationTuple): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.generation === right.generation &&
    left.digest === right.digest &&
    left.outputSetDigest === right.outputSetDigest
  );
}

export class PackReader {
  private readonly fetcher: PackageFetcher | undefined;
  private readonly lifetime = new AbortController();
  private readonly verified = new Map<string, VerifiedPack>();
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
    const cached = this.verified.get(key);
    if (cached !== undefined) return ok(cached);
    let request = this.pending.get(key);
    if (request === undefined) {
      const current = this.fetchAndVerify(packageUrl, expected, this.lifetime.signal, fetcher).then(
        (result) => {
          if (this.pending.get(key) === current) {
            this.pending.delete(key);
            if (result.ok) this.verified.set(key, result.value);
          }
          return result;
        },
      );
      this.pending.set(key, current);
      request = current;
    }
    return waitForAsset(request, AbortSignal.any([signal, this.lifetime.signal]), packageUrl);
  }

  dispose(): void {
    this.lifetime.abort();
    this.pending.clear();
    this.verified.clear();
  }

  private async fetchAndVerify(
    packageUrl: string,
    expected: AssetPublicationTuple,
    signal: AbortSignal,
    boundFetcher?: PackageFetcher,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    const fetcher = boundFetcher ?? this.fetcher ?? globalThis.fetch.bind(globalThis);
    const read = await readPackage(fetcher, packageUrl, readRetainedPackJson, { signal });
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
    const value = read.value;
    const verified = this.verify(value, expected);
    if (!verified.ok && verified.error.code === 'asset-package-invalid') {
      return invalid(packageUrl, verified.error.detail.reason);
    }
    return verified;
  }

  private key(packageUrl: string, tuple: AssetPublicationTuple): string {
    return `${packageUrl}\u0000${tuple.scopeId}\u0000${tuple.generation}\u0000${tuple.digest}\u0000${tuple.outputSetDigest}`;
  }

  verify(value: unknown, expected: AssetPublicationTuple): Result<VerifiedPack, AssetLoadError> {
    const decoded = decodeMaterialProgramWire(value);
    if (!decoded.ok) return invalid('', 'invalid material program table');
    value = decoded.value;
    const checked = validatePackEnvelope(value, expected);
    if (!checked.ok) return checked;
    return ok(freezePackValue(value as VerifiedPack));
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
