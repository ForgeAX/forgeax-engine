import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import type {
  Asset,
  AssetArtifactReader,
  AssetDecoder,
  AssetDecoderInput,
  AssetDecoderLease,
  AssetKind,
  AssetLoadError,
  AssetPublicationTuple,
  BuiltinAssetKind,
  BuiltinAssetPayload,
  PackageFetcher,
  PluginAssetDefinition,
  Result,
} from '@forgeax/engine-types';
import { err, isValidAssetGuidString, ok } from '@forgeax/engine-types';
import { defineAssetKind } from '../asset-kind.js';
import type { CatalogSource } from '../catalog-source.js';
import { pluginAssetDecoder } from '../loaders/plugin.js';
import { ArtifactCache } from './artifact-cache.js';
import { AssetGraph, type AssetGraphSnapshot } from './asset-graph.js';
import { CatalogSession, type CatalogSessionOptions } from './catalog-session.js';
import { DecoderRegistry } from './decoder-registry.js';
import { freezeRuntimePayload } from './immutable-payload.js';
import { PackReader } from './pack-reader.js';
import { bytesOf, readPackage } from './package-read.js';
import { validatePublicationReferences } from './publication-references.js';
import type { RuntimeCatalogRow } from './validate-runtime-row.js';
import { validateRuntimeRow } from './validate-runtime-row.js';
import { assetLoadCancelled, waitForAsset } from './wait-for-asset.js';

export interface AssetRegistryOptions extends CatalogSessionOptions {
  readonly catalog: CatalogSource;
  readonly fetcher?: PackageFetcher;
  readonly maxConcurrentReads?: number;
}

export interface AssetLoadOptions {
  readonly signal?: AbortSignal;
}

export type AssetRegistrySnapshot = AssetGraphSnapshot;

export interface AssetRegistry {
  readPluginDefinition(guid: string): Promise<Result<PluginAssetDefinition, AssetLoadError>>;
  installDecoder<P, K extends string>(
    kind: AssetKind<P, K>,
    decoder: AssetDecoder<P>,
  ): AssetDecoderLease;
  load<K extends BuiltinAssetKind>(
    guid: string,
    kind: K,
    options?: AssetLoadOptions,
  ): Promise<Result<BuiltinAssetPayload<K>, AssetLoadError>>;
  load<P, K extends string>(
    guid: string,
    kind: AssetKind<P, K>,
    options?: AssetLoadOptions,
  ): Promise<Result<P, AssetLoadError>>;
  snapshot(): AssetRegistrySnapshot;
  subscribe(listener: (snapshot: AssetRegistrySnapshot) => void): () => void;
  dispose(): void;
}

/** Internal render projection; the root Registry keeps only its five actions. */
export interface AssetRegistryResolver {
  readonly epoch: number;
  lookup<T extends Asset>(guid: string): T | undefined;
  guidOf(asset: Asset): string | undefined;
}

const REGISTRY_RESOLVER = Symbol.for('forgeax.assets-runtime.registry-resolver');
type RegistryWithResolver = AssetRegistry & {
  [REGISTRY_RESOLVER]?: AssetRegistryResolver;
};

export function getAssetRegistryResolver(registry: AssetRegistry): AssetRegistryResolver {
  const resolver = (registry as RegistryWithResolver)[REGISTRY_RESOLVER];
  if (resolver === undefined) {
    throw new TypeError('AssetRegistry resolver is not owned by this asset runtime');
  }
  return resolver;
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

export function createAssetRegistry(options: AssetRegistryOptions): AssetRegistry {
  const session = new CatalogSession(options.catalog, options);
  const admit = async (
    guid: string,
    seen = new Set<string>(),
  ): Promise<Result<RuntimeCatalogRow, AssetLoadError>> => {
    const admitted = await session.get(guid);
    if (
      !admitted.ok ||
      seen.has(guid.toLowerCase()) ||
      decoders.referencePolicy(admitted.value.kind) === 'deferred'
    )
      return admitted;
    seen.add(guid.toLowerCase());
    for (const ref of admitted.value.publication.outputs.find(
      (output) => output.guid.toLowerCase() === guid.toLowerCase(),
    )?.refs ?? []) {
      const dependency = await admit(ref, seen);
      if (!dependency.ok) return dependency;
    }
    return admitted;
  };
  const reader = new PackReader(options.fetcher === undefined ? {} : { fetcher: options.fetcher });
  const cache = new ArtifactCache();
  const decoders = new DecoderRegistry(
    options.scopeId === undefined ? {} : { scopeId: options.scopeId },
  );
  decoders.install(defineAssetKind('plugin'), pluginAssetDecoder);
  const graph = new AssetGraph<{
    readonly value: unknown;
    readonly refs: readonly string[];
    readonly publication: AssetPublicationTuple;
    readonly references: 'eager' | 'deferred';
  }>({
    ...(options.maxConcurrentReads === undefined
      ? {}
      : { maxConcurrentReads: options.maxConcurrentReads }),
    read: async (guid, signal) => {
      const row = session.current(guid);
      if (row === undefined) return err(missing(guid));
      const fetcher =
        options.catalog.openPackage?.(row.packageUrl) ??
        options.fetcher ??
        globalThis.fetch.bind(globalThis);
      const validated = validateRuntimeRow(row);
      if (!validated.ok) return validated;
      const publication = validated.value.publication;
      const tuple = {
        scopeId: session.snapshot().scopeId,
        generation: publication.generation,
        digest: publication.digest,
        outputSetDigest: publication.outputSetDigest,
      };
      const pack = await reader.read(row.packageUrl, tuple, signal, fetcher);
      if (!pack.ok) return pack;
      const envelope = pack.value.assets.find(
        (asset) => asset.guid.toLowerCase() === guid.toLowerCase(),
      );
      if (envelope === undefined) return err(missing(guid));
      const artifacts: AssetArtifactReader = {
        locate: (descriptor) => {
          const path = validateArtifactPath(descriptor.path, {
            packageRoot: row.packageUrl,
            guid,
            artifactKey: descriptor.path,
          });
          return path.ok ? resolveArtifactUrl(row.packageUrl, path.value) : undefined;
        },
        read: (descriptor) => {
          const integrity = descriptor.integrity;
          if (integrity === undefined)
            return Promise.resolve(err(artifactError(guid, descriptor.path)));
          const key = `${tuple.scopeId}:${tuple.generation}:${tuple.outputSetDigest}:${integrity.digest}`;
          return cache.read(key, async () => {
            const url = resolveArtifactUrl(row.packageUrl, descriptor.path);
            const read = await readPackage(fetcher, url, bytesOf, { signal });
            if (!read.ok) return err(artifactError(guid, descriptor.path));
            const bytes = read.value;
            if (descriptor.byteLength === undefined || bytes.byteLength !== descriptor.byteLength) {
              return err(artifactError(guid, descriptor.path));
            }
            const actualDigest = await sha256(bytes);
            if (actualDigest !== descriptor.integrity?.digest.toLowerCase()) {
              return err(artifactError(guid, `${descriptor.path}:${actualDigest}`));
            }
            return ok(bytes);
          });
        },
      };
      const input: AssetDecoderInput<unknown> = { envelope, artifacts, signal };
      const decoded = await decoders.loadByKind(envelope.kind, input);
      if (!decoded.ok) return decoded;
      return ok({
        value: freezeRuntimePayload(decoded.value),
        refs: [
          ...new Set([
            ...envelope.refs,
            ...publication.externalEvidence
              .filter((edge) => edge.usage !== 'content')
              .map((edge) => edge.guid),
          ]),
        ],
        publication: tuple,
        references: decoders.referencePolicy(envelope.kind),
      });
    },
  });

  let catalogEpoch = session.snapshot().epoch;
  const unsubscribeCatalog = session.subscribe((snapshot) => {
    if (snapshot.epoch === catalogEpoch) return;
    catalogEpoch = snapshot.epoch;
    graph.invalidateForCatalogChange(
      snapshot.stale ? undefined : [...snapshot.changed, ...snapshot.removed],
    );
  });

  const registry: AssetRegistry = {
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
      loadOptions: AssetLoadOptions = {},
    ): Promise<Result<unknown, AssetLoadError>> => {
      if (!isValidAssetGuidString(guid)) return err(invalidGuid(guid));
      if (loadOptions.signal?.aborted) return err(assetLoadCancelled(guid));
      const request = (async () => {
        const expectedKind = typeof kind === 'string' ? kind : kind.kind;
        const started = await session.start();
        if (!started.ok) return err(started.error);
        if (session.snapshot().stale) {
          const reconciled = await session.reconcile();
          if (!reconciled.ok) return err(reconciled.error);
          const discontinuity = session.discontinuity();
          if (discontinuity !== undefined) return err(discontinuity);
        }
        const declared = session.current(guid);
        if (declared !== undefined && declared.kind !== expectedKind)
          return err(mismatch(guid, expectedKind, declared.kind));
        const admitted = await admit(guid);
        if (!admitted.ok) return admitted;
        const row = admitted.value;
        if (row.kind !== expectedKind) return err(mismatch(guid, expectedKind, row.kind));
        const before = validatePublicationReferences(guid, row, (guid) => session.current(guid));
        if (!before.ok) {
          graph.invalidate(guid);
          return before;
        }
        const result = await graph.load(guid, loadOptions.signal);
        if (!result.ok) return result;
        const current = checkCurrent(guid, result.value.publication);
        if (!current.ok) return current;
        const after = validatePublicationReferences(guid, row, (guid) => session.current(guid));
        if (!after.ok) {
          graph.invalidate(guid);
          return after;
        }
        return result.ok ? ok(result.value.value) : result;
      })();
      return loadOptions.signal === undefined
        ? request
        : waitForAsset(request, loadOptions.signal, guid);
    }) as AssetRegistry['load'],
    snapshot: () => graph.snapshot(),
    subscribe: (listener) => graph.subscribe(listener),
    dispose: () => {
      graph.dispose();
      reader.dispose();
      unsubscribeCatalog();
      decoders.dispose();
      cache.clear();
      session.dispose();
    },
  };
  function checkCurrent(
    guid: string,
    expected: AssetPublicationTuple,
  ): Result<void, AssetLoadError> {
    const row = session.current(guid);
    const actual = row?.publication;
    if (
      session.snapshot().stale ||
      expected.scopeId !== session.snapshot().scopeId ||
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
    const references = validatePublicationReferences(guid, row, (guid) => session.current(guid));
    if (!references.ok) graph.invalidate(guid);
    return references;
  }
  const resolver: AssetRegistryResolver = {
    get epoch() {
      return graph.snapshot().epoch;
    },
    lookup: <T extends Asset>(guid: string) => graph.lookup(guid) as T | undefined,
    guidOf: (asset: Asset) => graph.guidOf(asset),
  };
  Object.defineProperty(registry, REGISTRY_RESOLVER, {
    value: resolver,
    enumerable: false,
  });
  return registry;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
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
