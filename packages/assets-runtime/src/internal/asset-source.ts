import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import type {
  Asset,
  AssetArtifactReader,
  AssetDecoder,
  AssetDecoderInput,
  AssetDecoderLease,
  AssetKind,
  AssetLoadError,
  AssetPublicationEnvelope,
  AssetPublicationTuple,
  BuiltinAssetKind,
  BuiltinAssetPayload,
  CatalogEntry,
  PackageFetcher,
  PluginAssetDefinition,
  Result,
} from '@forgeax/engine-types';
import { err, isValidAssetGuidString, ok } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source.js';
import {
  type ArtifactReadRequest,
  readArtifact,
  readStoredArtifact,
  verifyArtifactBytes,
} from '../registry/artifact-io.js';
import { CatalogReplica } from '../registry/catalog-state.js';
import { ArtifactCache } from './artifact-cache.js';
import { AssetGraph, type AssetGraphSnapshot } from './asset-graph.js';
import { BundleStore } from './bundle-store.js';
import type { DecoderRegistry } from './decoder-registry.js';
import { freezeRuntimePayload } from './immutable-payload.js';
import { PackReader, type VerifiedPack } from './pack-reader.js';
import { bytesOf, readPackage } from './package-read.js';
import { validatePublicationReferences } from './publication-references.js';
import type { RuntimeCatalogRow } from './validate-runtime-row.js';
import { validateRuntimeRow } from './validate-runtime-row.js';
import { assetLoadCancelled, waitForAsset } from './wait-for-asset.js';

export interface AssetSourceOptions {
  readonly scopeId?: string;
  readonly generation?: number;
  readonly catalog: CatalogSource;
  readonly fetcher?: PackageFetcher;
  readonly maxConcurrentReads?: number;
  readonly decoders: DecoderRegistry;
}

export interface AssetLoadOptions {
  readonly signal?: AbortSignal;
}

type AssetSourceSnapshot = AssetGraphSnapshot;

interface SourceEntry {
  readonly value: unknown;
  readonly kind: string;
  readonly refs: readonly string[];
  readonly references: 'eager' | 'deferred';
  readonly publication: AssetPublicationTuple & AssetPublicationEnvelope;
  readonly digest: string;
}

export interface AdoptedAssetSource {
  readonly guid: string;
  readonly kind: string;
  readonly revision: number;
  readonly source: AssetSource | undefined;
  readonly publication: (AssetPublicationTuple & AssetPublicationEnvelope) | undefined;
  readonly contentKey: string | undefined;
}

export interface AssetSource {
  readonly catalog: CatalogReplica;
  readonly catalogSource: CatalogSource;
  readPack(
    row: CatalogEntry,
    signal: AbortSignal,
    fetcher?: PackageFetcher,
  ): Promise<Result<VerifiedPack, AssetLoadError>>;
  readArtifact(
    request: ArtifactReadRequest,
    signal: AbortSignal,
    fetcher?: PackageFetcher,
  ): Promise<Result<{ stored: Uint8Array; decoded: Uint8Array }, AssetLoadError>>;
  preparePublication(
    pack: RuntimePackEnvelope,
    rows: readonly CatalogEntry[],
    values: ReadonlyMap<string, Asset>,
  ): void;
  trimReadCache(): void;
  invalidate(guid: string): void;
  revision(guid: string): number;
  readPluginDefinition(guid: string): Promise<Result<PluginAssetDefinition, AssetLoadError>>;
  installDecoder<P, K extends string>(
    kind: AssetKind<P, K>,
    decoder: AssetDecoder<P>,
  ): AssetDecoderLease;
  load<K extends BuiltinAssetKind>(
    guid: string,
    kind: K,
    options?: AssetLoadOptions & { readonly refresh?: boolean },
  ): Promise<Result<BuiltinAssetPayload<K>, AssetLoadError>>;
  load<P, K extends string>(
    guid: string,
    kind: AssetKind<P, K>,
    options?: AssetLoadOptions & { readonly refresh?: boolean },
  ): Promise<Result<P, AssetLoadError>>;
  entry(guid: string): SourceEntry | undefined;
  checkCurrent(guid: string): Result<void, AssetLoadError>;
  snapshot(): AssetSourceSnapshot;
  subscribe(listener: (snapshot: AssetSourceSnapshot) => void): () => void;
  dispose(): void;
}

function missing(guid: string): AssetLoadError {
  return {
    code: 'asset-not-found',
    expected: `the current Catalog to contain GUID "${guid}"`,
    hint: 'inspect the producer Catalog and rebuild the missing publication',
    detail: { guid },
  };
}

function mismatch(guid: string, expectedKind: string, actualKind: string): AssetLoadError {
  return {
    code: 'asset-kind-mismatch',
    expected: `Catalog kind "${actualKind}" to match "${expectedKind}"`,
    hint: 'pass the Catalog kind or the matching custom AssetKind token',
    detail: { guid, expectedKind, actualKind },
  };
}

function artifactError(guid: string, reason: string): AssetLoadError {
  return {
    code: 'asset-integrity-failed',
    expected: 'the verified artifact byte length and digest',
    hint: 'verify the artifact digest and recook the Pack',
    detail: {
      guid,
      artifactKey: reason,
      expectedDigest: 'descriptor integrity',
      actualDigest: reason,
    },
  };
}

function invalidGuid(guid: string): AssetLoadError {
  return {
    code: 'asset-guid-invalid',
    expected: 'a 36-character dash-form asset GUID',
    hint: 'pass the producer GUID from the current Catalog row',
    detail: { guid },
  };
}

export function createAssetSource(options: AssetSourceOptions): AssetSource {
  const session = new CatalogReplica(options.catalog, options);
  const admit = async (
    guid: string,
    seen = new Set<string>(),
    refresh = false,
  ): Promise<Result<RuntimeCatalogRow, AssetLoadError>> => {
    const key = guid.toLowerCase();
    if (seen.has(key)) {
      const row = session.get(key);
      return row === undefined ? err(missing(key)) : validateRuntimeRow(row);
    }
    seen.add(key);
    const admitted = await session.require(guid, refresh);
    if (!admitted.ok || decoders.referencePolicy(admitted.value.kind) === 'deferred')
      return admitted;
    for (const ref of admitted.value.publication.outputs.find(
      (output) => output.guid.toLowerCase() === guid.toLowerCase(),
    )?.refs ?? []) {
      const dependency = await admit(ref, seen, refresh);
      if (!dependency.ok) return dependency;
    }
    return admitted;
  };
  const reader = new PackReader(options.fetcher === undefined ? {} : { fetcher: options.fetcher });
  const cache = new ArtifactCache();
  const bundles = new BundleStore<AssetLoadError>();
  const lifetime = new AbortController();
  const sourceFetcher = (url: string) =>
    options.catalog.openPackage?.(url) ?? options.fetcher ?? globalThis.fetch.bind(globalThis);
  const storedArtifact = async (
    request: ArtifactReadRequest,
    signal: AbortSignal,
    fetcher: PackageFetcher = sourceFetcher(request.packageUrl),
  ): Promise<Result<{ stored: Uint8Array; decoded: Uint8Array }, AssetLoadError>> => {
    if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(request.guid));
    const descriptor = request.descriptor;
    const path = validateArtifactPath(descriptor.path, {
      packageRoot: request.packageUrl,
      guid: request.guid,
      artifactKey: request.artifactKey,
    });
    if (!path.ok) return err(artifactError(request.guid, path.error.code));
    // One source cache retains the transport bytes. Domain decode and fixed
    // export share them, while each decode validates its own descriptor.
    const url = resolveArtifactUrl(request.packageUrl, path.value);
    const range = descriptor.byteRange;
    const decodeError = (error: { readonly expected: string; readonly hint: string }) => ({
      ...artifactError(request.guid, request.artifactKey),
      expected: error.expected,
      hint: error.hint,
    });
    if (range !== undefined) {
      const reading = bundles.read({
        url,
        range,
        fetch: async (entry) => {
          const read = await readStoredArtifact(
            request,
            fetcher,
            url,
            range,
            { signal: lifetime.signal },
            entry,
          );
          if (read.ok) return read;
          const error = artifactError(request.guid, descriptor.path);
          return err(
            'code' in read.error
              ? { ...error, expected: read.error.expected, hint: read.error.hint }
              : error,
          );
        },
        finish: async (stored) => {
          const decoded = await readArtifact(request, fetcher, async () => ok(stored));
          return decoded.ok ? decoded : err(decodeError(decoded.error));
        },
        reuse: async (copy) => {
          const verified = await verifyArtifactBytes(copy, request);
          return verified.ok ? verified : err(decodeError(verified.error));
        },
        invalid: (reason) => artifactError(request.guid, reason),
        ...(descriptor.integrity === undefined ? {} : { digest: descriptor.integrity.digest }),
      });
      const decoded = await waitForAsset(reading, signal, request.guid);
      if (!decoded.ok)
        return decoded.error.code === 'asset-integrity-failed'
          ? err({ ...decoded.error, detail: { ...decoded.error.detail, guid: request.guid } })
          : decoded;
      if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(request.guid));
      // Bundle entries move into their extracted value; there is no second stored copy.
      return ok({ stored: decoded.value, decoded: decoded.value });
    }
    const key = JSON.stringify([
      url,
      descriptor.mediaType,
      descriptor.contentEncoding ?? 'identity',
      descriptor.byteLength,
      descriptor.integrity?.algorithm,
      descriptor.integrity?.digest,
    ]);
    const reading = cache.read(key, async () => {
      const read = await readPackage(fetcher, url, bytesOf, { signal: lifetime.signal });
      return read.ok ? read : err(artifactError(request.guid, descriptor.path));
    });
    const stored = await waitForAsset(reading, signal, request.guid);
    if (!stored.ok) return stored;
    if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(request.guid));
    const decoded = await readArtifact(request, fetcher, async () => ok(stored.value));
    if (!decoded.ok) {
      cache.clear(key);
      return err(decodeError(decoded.error));
    }
    return ok({ stored: stored.value, decoded: decoded.value });
  };
  const decoders = options.decoders;
  const graph = new AssetGraph<SourceEntry>({
    ...(options.maxConcurrentReads === undefined
      ? {}
      : { maxConcurrentReads: options.maxConcurrentReads }),
    read: async (guid, signal) => {
      const row = session.get(guid);
      if (row === undefined) return err(missing(guid));
      const fetcher = sourceFetcher(row.packageUrl);
      const validated = validateRuntimeRow(row);
      if (!validated.ok) return validated;
      const publication = validated.value.publication;
      const tuple = {
        ...publication,
        scopeId: session.scopeId,
      };
      const pack = await reader.read(row.packageUrl, tuple, signal, fetcher);
      if (!pack.ok) return pack;
      const envelope = pack.value.assets.find(
        (asset) => asset.guid.toLowerCase() === guid.toLowerCase(),
      );
      if (envelope === undefined) return err(missing(guid));
      const output = publication.outputs.find(
        (output) => output.guid.toLowerCase() === guid.toLowerCase(),
      );
      if (output === undefined) return err(missing(guid));
      const artifacts: AssetArtifactReader = {
        locate: (descriptor) => {
          const path = validateArtifactPath(descriptor.path, {
            packageRoot: row.packageUrl,
            guid,
            artifactKey: descriptor.path,
          });
          return path.ok ? resolveArtifactUrl(row.packageUrl, path.value) : undefined;
        },
        read: async (descriptor) => {
          if (descriptor.integrity === undefined)
            return Promise.resolve(err(artifactError(guid, descriptor.path)));
          const result = await storedArtifact(
            { packageUrl: row.packageUrl, guid, artifactKey: descriptor.path, descriptor },
            signal,
            fetcher,
          );
          return result.ok ? ok(result.value.decoded) : result;
        },
      };
      const input: AssetDecoderInput<unknown> = { envelope, artifacts, signal };
      const decoded = await decoders.loadByKind(envelope.kind, input);
      if (!decoded.ok) return decoded;
      return ok({
        value: freezeRuntimePayload(decoded.value),
        kind: envelope.kind,
        refs: [
          ...new Set([
            ...envelope.refs,
            ...publication.externalEvidence
              .filter((edge) => edge.usage !== 'content')
              .map((edge) => edge.guid),
          ]),
        ],
        publication: tuple,
        digest: output.digest,
        references: decoders.referencePolicy(envelope.kind),
      });
    },
  });

  const unsubscribeCatalog = session.subscribe((delta) => {
    if (session.isStale) return;
    const changed = [
      ...delta.added.map((row) => row.guid),
      ...delta.changed.map((row) => row.guid),
      ...delta.removed,
    ];
    const invalidated = changed.filter((guid) => {
      const cached = graph.entry(guid)?.publication;
      const current = session.get(guid)?.publication;
      return (
        cached === undefined ||
        current === undefined ||
        cached.generation !== current.generation ||
        cached.digest !== current.digest ||
        cached.outputSetDigest !== current.outputSetDigest
      );
    });
    if (invalidated.length) graph.invalidateForCatalogChange(invalidated);
  });

  const registry: AssetSource = {
    catalog: session,
    catalogSource: options.catalog,
    readPack: (row, signal, fetcher = sourceFetcher(row.packageUrl)) => {
      const validated = validateRuntimeRow(row);
      return validated.ok
        ? reader.read(
            row.packageUrl,
            { ...validated.value.publication, scopeId: session.scopeId },
            signal,
            fetcher,
          )
        : Promise.resolve(validated);
    },
    readArtifact: storedArtifact,
    trimReadCache: () => {
      cache.trim();
      bundles.trim();
    },
    invalidate: (guid) => {
      graph.invalidate(guid);
    },
    revision: (guid) => graph.revision(guid),
    preparePublication: (pack, rows, values) => {
      if (pack.scopeId !== session.scopeId)
        throw new TypeError('prepared publication must belong to the configured Catalog scope');
      const prepared = new Map<string, SourceEntry>();
      for (const row of rows) {
        const envelope = pack.assets.find((asset) => asset.guid === row.guid);
        const output = row.publication?.outputs.find((output) => output.guid === row.guid);
        const value = values.get(row.guid);
        if (!envelope || !output || !value || !row.publication)
          throw new TypeError(`missing prepared publication output ${row.guid}`);
        prepared.set(row.guid.toLowerCase(), {
          value,
          kind: row.kind,
          refs: [
            ...new Set([
              ...envelope.refs,
              ...row.publication.externalEvidence
                .filter((edge) => edge.usage !== 'content')
                .map((edge) => edge.guid),
            ]),
          ],
          references: decoders.referencePolicy(row.kind),
          publication: { ...row.publication, scopeId: session.scopeId },
          digest: output.digest,
        });
      }
      graph.prepare(prepared);
    },
    readPluginDefinition: async (guid) => {
      const loaded = await registry.load(guid, 'plugin');
      if (!loaded.ok) return loaded;
      const snapshot = await graph.load(guid);
      if (!snapshot.ok) return snapshot;
      const checked = checkCurrent(guid, snapshot.value.publication);
      if (!checked.ok) return checked;
      const asset = snapshot.value.value as Asset;
      if (asset.kind !== 'plugin') return err(mismatch(guid, 'plugin', asset.kind));
      return ok({
        guid,
        asset,
        evidence: { kind: 'publication', publication: snapshot.value.publication },
      });
    },
    installDecoder: (kind, decoder) => decoders.install(kind, decoder),
    load: (async (
      guid: string,
      kind: BuiltinAssetKind | AssetKind<unknown, string>,
      loadOptions: AssetLoadOptions & { readonly refresh?: boolean } = {},
    ): Promise<Result<unknown, AssetLoadError>> => {
      if (!isValidAssetGuidString(guid)) return err(invalidGuid(guid));
      if (loadOptions.signal?.aborted) return err(assetLoadCancelled(guid));
      const request = (async () => {
        const expectedKind = typeof kind === 'string' ? kind : kind.kind;
        const started = await session.start();
        if (!started.ok) return err(sourceFailure(guid, started.error.message));
        if (session.isStale) {
          const reconciled = await session.reconcile();
          if (!reconciled.ok) return err(sourceFailure(guid, reconciled.error.message));
          const discontinuity = session.discontinuity();
          if (discontinuity !== undefined) return err(discontinuity);
        }
        const declared = session.get(guid);
        if (declared !== undefined && declared.kind !== expectedKind)
          return err(mismatch(guid, expectedKind, declared.kind));
        const admitted = await admit(guid, new Set(), loadOptions.refresh);
        if (!admitted.ok) return admitted;
        const row = admitted.value;
        if (row.kind !== expectedKind) return err(mismatch(guid, expectedKind, row.kind));
        const before = validatePublicationReferences(guid, row, (guid) => session.get(guid));
        if (!before.ok) {
          graph.invalidate(guid);
          return before;
        }
        const result = await graph.load(guid, loadOptions.signal);
        if (!result.ok) return result;
        const current = checkCurrent(guid, result.value.publication);
        if (!current.ok) return current;
        const after = validatePublicationReferences(guid, row, (guid) => session.get(guid));
        if (!after.ok) {
          graph.invalidate(guid);
          return after;
        }
        return result.ok ? ok(result.value.value) : result;
      })();
      return loadOptions.signal === undefined
        ? request
        : waitForAsset(request, loadOptions.signal, guid);
    }) as AssetSource['load'],
    entry: (guid) => graph.entry(guid),
    checkCurrent: (guid) => {
      const entry = graph.entry(guid);
      return entry === undefined ? err(missing(guid)) : checkCurrent(guid, entry.publication);
    },
    snapshot: () => graph.snapshot(),
    subscribe: (listener) => graph.subscribe(listener),
    dispose: () => {
      lifetime.abort();
      graph.dispose();
      reader.dispose();
      unsubscribeCatalog();
      cache.clear();
      bundles.clear();
      session.dispose();
    },
  };
  function checkCurrent(
    guid: string,
    expected: AssetPublicationTuple,
  ): Result<void, AssetLoadError> {
    const row = session.get(guid);
    const actual = row?.publication;
    if (
      session.isStale ||
      expected.scopeId !== session.scopeId ||
      actual?.generation !== expected.generation ||
      actual.digest !== expected.digest ||
      actual.outputSetDigest !== expected.outputSetDigest
    ) {
      graph.invalidate(guid);
      return err({
        code: 'asset-superseded',
        expected: 'the same root publication until its read completes',
        hint: 'load the current Catalog publication',
        detail: { guid, generation: expected.generation },
      });
    }
    const references = validatePublicationReferences(guid, row, (guid) => session.get(guid));
    if (!references.ok) graph.invalidate(guid);
    return references;
  }
  return registry;
}

function resolveArtifactUrl(packageUrl: string, path: string): string {
  const separator = packageUrl.lastIndexOf('/');
  const packageDirectory = separator < 0 ? '' : packageUrl.slice(0, separator + 1);
  try {
    return new URL(path, new URL(packageDirectory, globalThis.location?.href)).toString();
  } catch {
    return `${packageDirectory}${path.replace(/^\//, '')}`;
  }
}

function sourceFailure(guid: string, reason: string): AssetLoadError {
  return {
    code: 'asset-package-invalid',
    expected: 'a verified Catalog source',
    hint: 'repair the producer Catalog and retry',
    detail: { guid, reason },
  };
}
