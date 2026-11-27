import { runtimeArtifactDescriptorIssue } from '@forgeax/engine-pack/bundle';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { withCombinedSignal } from '@forgeax/engine-platform';
import type {
  AssetLoadError,
  AssetPublicationTuple,
  PackageFetcher,
  PackV2,
  Result,
} from '@forgeax/engine-types';
import { err, isValidAssetGuidString, ok } from '@forgeax/engine-types';
import { freezeRuntimePayload } from './immutable-payload.js';
import { readDocumentJson } from './pack-json.js';
import { readPackage } from './package-read.js';
import { assetLoadCancelled, waitForAsset } from './wait-for-asset.js';

interface PackReaderOptions {
  readonly fetcher?: PackageFetcher;
}

type PackExpectation = Omit<AssetPublicationTuple, 'scopeId'> & {
  readonly scopeId?: string | undefined;
};

export type VerifiedPack = PackV2<unknown>;

function invalid(guid: string, reason: string): Result<never, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a verified Pack v2 envelope with complete runtime artifacts',
    hint: 're-cook the Pack v2 publication and retry the current tuple',
    detail: { guid, reason },
  });
}

function sameTuple(left: AssetPublicationTuple, right: PackExpectation): boolean {
  return (
    (right.scopeId === undefined || left.scopeId === right.scopeId) &&
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
    const read = await readPackage(fetcher, packageUrl, readDocumentJson, { signal });
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
    return this.verify(read.value, expected, packageUrl);
  }

  private key(packageUrl: string, tuple: AssetPublicationTuple): string {
    return `${packageUrl}\u0000${tuple.scopeId}\u0000${tuple.generation}\u0000${tuple.digest}\u0000${tuple.outputSetDigest}`;
  }

  /** Open an independent candidate/capture without entering the live in-flight cache. */
  async openDetached(
    packageUrl: string,
    expected: PackExpectation,
    fetcher: PackageFetcher,
    signal?: AbortSignal,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    const response = await fetcher(packageUrl, signal === undefined ? undefined : { signal });
    if (!response.ok) throw new TypeError('candidate Pack unavailable');
    const raw = await readDocumentJson(response);
    signal?.throwIfAborted();
    return this.verify(raw, expected);
  }

  /** Verify a raw document; private candidates may infer scope from the decoded Pack. */
  verify(
    value: unknown,
    expected: PackExpectation,
    packageUrl?: string,
  ): Result<VerifiedPack, AssetLoadError> {
    const decoded = decodeMaterialProgramWire(value);
    return decoded.ok
      ? this.admit(decoded.value, expected, packageUrl)
      : invalid(
          packageUrl ?? '',
          packageUrl === undefined ? 'invalid material program table' : 'invalid JSON',
        );
  }

  private admit(
    value: unknown,
    expected: PackExpectation,
    packageUrl?: string,
  ): Result<VerifiedPack, AssetLoadError> {
    const checked = validatePackEnvelope(value, expected);
    if (!checked.ok && packageUrl !== undefined && checked.error.code === 'asset-package-invalid')
      return invalid(packageUrl, checked.error.detail.reason);
    return checked.ok ? ok(freezeRuntimePayload(value as VerifiedPack)) : checked;
  }
}

/** Complete Pack validation without freezing or retaining the caller's mutable input. */
export function validatePackEnvelope(
  value: unknown,
  expected: PackExpectation,
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
  return validatePackAssets(pack.assets);
}

function validatePackAssets(assets: unknown): Result<void, AssetLoadError> {
  if (!Array.isArray(assets)) return invalid('', 'assets');
  const guids = new Set<string>();
  for (const raw of assets) {
    if (!record(raw)) return invalid('', 'envelope');
    const { guid, kind, payload, refs, artifacts } = raw;
    if (!isValidAssetGuidString(guid)) return invalid('', 'guid');
    if (typeof kind !== 'string' || kind.length === 0) return invalid('', 'kind');
    if (payload === undefined) return invalid('', 'payload');
    if (refs !== undefined) {
      if (!Array.isArray(refs)) return invalid('', 'refs');
      const bad = refs.findIndex((ref) => !isValidAssetGuidString(ref));
      if (bad !== -1) return invalid('', `refs[${bad}]`);
    }
    const key = guid.toLowerCase();
    if (guids.has(key)) return invalid(guid, 'duplicate guid');
    guids.add(key);
    if (artifacts !== undefined && !record(artifacts)) return invalid('', 'artifacts');
    if (refs === undefined || artifacts === undefined)
      return invalid(guid, 'asset envelope fields');
    const result = validatePackArtifacts(guid, artifacts);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

function validatePackArtifacts(
  guid: string,
  artifacts: Record<string, unknown>,
): Result<void, AssetLoadError> {
  for (const [key, descriptor] of Object.entries(artifacts)) {
    const issue = key ? runtimeArtifactDescriptorIssue(descriptor) : 'descriptor';
    if (issue === 'delivery') return invalid(guid, `artifact ${key}`);
    if (issue !== undefined)
      return invalid('', issue === 'descriptor' ? `artifacts.${key}` : `artifacts.${key}.${issue}`);
  }
  return ok(undefined);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
