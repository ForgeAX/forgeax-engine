import { interleavedMesh, meshAssetDecoder, prepareMeshData } from '@forgeax/engine-geometry';
import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import type {
  ArtifactDescriptor,
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
  MeshAsset,
  PackageFetcher,
  PluginAssetDefinition,
  Result,
} from '@forgeax/engine-types';
import { err, isValidAssetGuidString, ok } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source.js';
import type { MeshGeometry } from '../mesh-geometry.js';
import { validateAssetReferences } from '../prepare-payload.js';
import {
  type ArtifactReadRequest,
  type BundledArtifactRead,
  prefetchArtifactBundle,
  readArtifact,
  readBundledArtifact,
} from '../registry/artifact-io.js';
import { CatalogReplica } from '../registry/catalog-state.js';
import { copyAssetData } from './asset-data.js';
import { AssetGraph, type AssetGraphSnapshot } from './asset-graph.js';
import { BundleStore } from './bundle-store.js';
import type { DecoderRegistry } from './decoder-registry.js';
import { freezeRuntimePayload } from './immutable-payload.js';
import { PackReader, type VerifiedPack } from './pack-reader.js';
import { bytesOf, readPackage } from './package-read.js';
import {
  validatePublicationReferenceRoots,
  validatePublicationReferences,
} from './publication-references.js';
import { type RetentionBudget, realmRetention } from './retention-budget.js';
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
  /** Prefer split Render residency for a static Mesh or a scene's draw-only Mesh references. */
  readonly usage?: 'render';
}

interface SourceLoadOptions extends AssetLoadOptions {
  readonly refresh?: boolean;
  readonly readScope?: PackScope;
}

type AssetSourceSnapshot = AssetGraphSnapshot & {
  readonly scopeId: string;
  readonly realm: string;
  readonly generation: number;
  readonly bundleTransfers: ReturnType<BundleStore<AssetLoadError>['transfers']['snapshot']>;
};

type PackEnvelope = VerifiedPack['assets'][number];
interface OpenedPack {
  readonly assets: ReadonlyMap<string, PackEnvelope>;
  readonly fetcher: PackageFetcher;
}
/** Packs opened by one closure load, keyed by package URL and publication. */
type PackScope = Map<string, Promise<Result<OpenedPack, AssetLoadError>>>;

// Leave connections available for publications still being produced.
const EARLY_SCENE_PACK_LIMIT = 8;
const EARLY_SCENE_BUNDLE_LIMIT = 3;

export interface SourceEntry {
  readonly identity: symbol;
  readonly value: unknown;
  readonly kind: string;
  readonly refs: readonly string[];
  readonly references: 'eager' | 'deferred';
  readonly publication: AssetPublicationTuple & AssetPublicationEnvelope;
  readonly digest: string;
  readonly decoderIdentity: symbol | undefined;
  readonly meshBody?: PackEnvelope;
  readonly nativeMesh?: true;
}

export interface AdoptedAssetSource {
  readonly guid: string;
  readonly kind: string;
  readonly revision: number;
  readonly source: AssetSource | undefined;
  readonly publication: (AssetPublicationTuple & AssetPublicationEnvelope) | undefined;
  readonly contentKey: string | undefined;
  readonly decoderIdentity?: symbol | undefined;
}

export type MeshArtifactStorage = 'publication' | 'retained-bytes';
export type MeshArtifactFailure = 'source-unavailable' | 'recovery-budget-exceeded';

interface FixedMeshArtifact {
  readonly bytes: number;
  readonly storage: MeshArtifactStorage;
  read(): Promise<MeshAsset>;
  release(): void;
  releaseDecodedSource(): void;
}

export function standaloneMeshBody(envelope: PackEnvelope): { readonly meshBody?: PackEnvelope } {
  return envelope.kind === 'mesh' &&
    envelope.artifacts.body?.integrity !== undefined &&
    Object.keys(envelope.artifacts).length === 1
    ? { meshBody: envelope }
    : {};
}

/** The Geometry decoder receives a private view of this verified standalone body. */
export async function decodeStandaloneMeshBody(
  envelope: PackEnvelope,
  bytes: Uint8Array,
): Promise<MeshAsset> {
  return (
    await meshAssetDecoder.decode({
      envelope: envelope as AssetDecoderInput<MeshAsset>['envelope'],
      artifacts: {
        read: async () => ok(bytes),
        program: async () => err(artifactError(envelope.guid, 'mesh program')),
        locate: () => undefined,
      },
      signal: new AbortController().signal,
    })
  ).unwrap();
}

function nativeMeshProjection(envelope: RuntimePackEnvelope['assets'][number]): {
  readonly nativeMesh?: true;
} {
  const payload = envelope.payload as Partial<MeshAsset> | null;
  return envelope.kind === 'mesh' && payload?.vertices instanceof Float32Array
    ? { nativeMesh: true }
    : {};
}

export interface AssetSource {
  readonly catalog: CatalogReplica;
  readonly catalogSource: CatalogSource;
  openLoadScope(): PackScope;
  withDecodedClosure<T>(guid: string, read: () => Promise<T>): Promise<T>;
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
    standaloneMeshes: ReadonlySet<string>,
    decoderIdentities: ReadonlyMap<string, symbol | undefined>,
  ): void;
  trimReadCache(): void;
  canTakeMesh(root: string, guid: string, entry: SourceEntry): boolean;
  takeMesh(guid: string): void;
  retainMeshArtifact(
    guid: string,
    expected: AssetPublicationTuple,
    decoderIdentity: symbol | undefined,
    signal?: AbortSignal,
    bodyEnvelope?: SourceEntry['meshBody'],
  ): Promise<Result<FixedMeshArtifact, MeshArtifactFailure>>;
  invalidate(guid: string): void;
  revision(guid: string): number;
  readPluginDefinition(guid: string): Promise<Result<PluginAssetDefinition, AssetLoadError>>;
  readMeshGeometry(
    guid: string,
    options?: AssetLoadOptions,
  ): Promise<Result<MeshGeometry, AssetLoadError>>;
  installDecoder<P, K extends string>(
    kind: AssetKind<P, K>,
    decoder: AssetDecoder<P>,
  ): AssetDecoderLease;
  load<K extends BuiltinAssetKind>(
    guid: string,
    kind: K,
    options?: SourceLoadOptions,
  ): Promise<Result<BuiltinAssetPayload<K>, AssetLoadError>>;
  load<P, K extends string>(
    guid: string,
    kind: AssetKind<P, K>,
    options?: SourceLoadOptions,
  ): Promise<Result<P, AssetLoadError>>;
  entry(guid: string): SourceEntry | undefined;
  checkCurrent(guid: string): Result<void, AssetLoadError>;
  checkCurrentMany(guids: Iterable<string>): Result<void, AssetLoadError>;
  snapshot(): AssetSourceSnapshot;
  subscribe(listener: (snapshot: AssetGraphSnapshot) => void): () => void;
  dispose(): void;
}

/** A fixed body is deliberately independent of the Catalog and decoder scope. */
function pinMeshArtifact(
  budget: RetentionBudget,
  size: number,
  storage: MeshArtifactStorage,
  read: () => Promise<MeshAsset>,
): Result<Omit<FixedMeshArtifact, 'releaseDecodedSource'>, 'recovery-budget-exceeded'> {
  budget.settle(Number.POSITIVE_INFINITY, size);
  if (!budget.fits(size)) return err('recovery-budget-exceeded');
  let retained: (() => Promise<MeshAsset>) | undefined = read;
  budget.add(size);
  return ok({
    bytes: size,
    storage,
    async read() {
      if (retained === undefined) throw new Error('fixed Mesh artifact was released');
      return retained();
    },
    release() {
      if (retained === undefined) return;
      retained = undefined;
      budget.add(-size);
    },
  });
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
  // Resident Bundle entries share the realm's budget; other reads only coalesce.
  const retained = realmRetention();
  // In-flight transport reads only; settled bytes are owned by the decoded asset.
  const inflight = new Map<string, Promise<Result<Uint8Array, AssetLoadError>>>();
  const programs = new Map<string, Promise<Result<Uint8Array, AssetLoadError>>>();
  const bundles = new BundleStore<AssetLoadError>(retained);
  const lifetime = new AbortController();
  const sourceFetcher = (url: string) =>
    options.catalog.openPackage?.(url) ?? options.fetcher ?? globalThis.fetch.bind(globalThis);
  const bundleReadOptions = (
    request: ArtifactReadRequest,
    fetcher: PackageFetcher,
    url: string,
  ): BundledArtifactRead<AssetLoadError> => ({
    fetcher,
    url,
    init: { signal: lifetime.signal },
    unreadable: (failure) => {
      const error = artifactError(request.guid, request.descriptor.path);
      return 'code' in failure
        ? { ...error, expected: failure.expected, hint: failure.hint }
        : error;
    },
    rejected: ({ expected, hint }) => ({
      ...artifactError(request.guid, request.artifactKey),
      expected,
      hint,
    }),
    invalid: (reason) => artifactError(request.guid, reason),
  });
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
    // Concurrent reads share one transport request; each decode validates
    // its own descriptor.
    const url = resolveArtifactUrl(request.packageUrl, path.value);
    const range = descriptor.byteRange;
    const decodeError = (error: { readonly expected: string; readonly hint: string }) => ({
      ...artifactError(request.guid, request.artifactKey),
      expected: error.expected,
      hint: error.hint,
    });
    if (range !== undefined) {
      const reading = readBundledArtifact(
        bundles,
        request,
        bundleReadOptions(request, fetcher, url),
      );
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
    let reading = inflight.get(key);
    if (reading === undefined) {
      const current = readPackage(fetcher, url, bytesOf, { signal: lifetime.signal }).then(
        (read) => (read.ok ? read : err(artifactError(request.guid, descriptor.path))),
      );
      const settled = current.finally(() => {
        if (inflight.get(key) === settled) inflight.delete(key);
      });
      inflight.set(key, settled);
      reading = settled;
    }
    const stored = await waitForAsset(reading, signal, request.guid);
    if (!stored.ok) return stored;
    if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(request.guid));
    const decoded = await readArtifact(request, fetcher, async () => ok(stored.value));
    if (!decoded.ok) return err(decodeError(decoded.error));
    return ok({ stored: stored.value, decoded: decoded.value });
  };
  const decoders = options.decoders;
  // One closure load owns the packs it opens: each pack is decoded once per load
  // and indexed by GUID when opened, so every root in it is a direct lookup.
  const openPack = async (
    url: string,
    tuple: Parameters<PackReader['read']>[1],
    signal: AbortSignal,
  ): Promise<Result<OpenedPack, AssetLoadError>> => {
    const fetcher = sourceFetcher(url);
    const pack = await reader.read(url, tuple, signal, fetcher);
    if (!pack.ok) return pack;
    const assets = new Map<string, PackEnvelope>();
    for (const asset of pack.value.assets) assets.set(asset.guid.toLowerCase(), asset);
    return ok({ assets, fetcher });
  };
  const openClosurePack = (row: RuntimeCatalogRow, scope: PackScope, signal: AbortSignal) => {
    const { packageUrl, publication } = row;
    const { scopeId } = session;
    const { generation, digest, outputSetDigest } = publication;
    const key = `${packageUrl}\u0000${scopeId}\u0000${generation}\u0000${digest}\u0000${outputSetDigest}`;
    const pending = scope.get(key);
    if (pending !== undefined) return pending;
    const opened = openPack(packageUrl, { scopeId, generation, digest, outputSetDigest }, signal);
    scope.set(key, opened);
    const evict = () => {
      if (scope.get(key) === opened) scope.delete(key);
    };
    void opened.then((result) => {
      if (!result.ok) evict();
    }, evict);
    return opened;
  };
  async function prefetchSceneMeshBundle(
    row: RuntimeCatalogRow,
    scope: PackScope,
    started: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const guid = row.guid.toLowerCase();
    const pack = await openClosurePack(row, scope, lifetime.signal);
    if (!pack.ok || signal?.aborted || lifetime.signal.aborted) return;
    const current = currentPublication(guid, { ...row.publication, scopeId: session.scopeId });
    if (
      current?.packageUrl !== row.packageUrl ||
      current.lifecycle === 'stale' ||
      current.publication?.failure
    )
      return;
    if (!decoders.uses('mesh', meshAssetDecoder)) return;
    const envelope = pack.value.assets.get(guid);
    const descriptor = envelope && standaloneMeshBody(envelope).meshBody?.artifacts.body;
    if (descriptor?.byteRange === undefined || descriptor.delivery === 'stream') return;
    const path = validateArtifactPath(descriptor.path, {
      packageRoot: row.packageUrl,
      guid,
      artifactKey: 'body',
    });
    if (!path.ok) return;
    const url = resolveArtifactUrl(row.packageUrl, path.value);
    const key = `${url}\0${descriptor.byteRange.bundleDigest}`;
    const limit = Math.min(EARLY_SCENE_BUNDLE_LIMIT, options.maxConcurrentReads ?? Infinity);
    if (started.size >= limit || started.has(key)) return;
    started.add(key);
    const request = { packageUrl: row.packageUrl, guid, artifactKey: 'body', descriptor };
    await prefetchArtifactBundle(
      bundles,
      request,
      bundleReadOptions(request, pack.value.fetcher, url),
    );
  }

  const startKnownScenePacks = (root: string, scope: PackScope, signal?: AbortSignal) => {
    const limit = Math.min(EARLY_SCENE_PACK_LIMIT, options.maxConcurrentReads ?? Infinity);
    const before = scope.size;
    const queue = [root.toLowerCase()];
    const seen = new Set(queue);
    const started = new Set<string>();
    for (let index = 0; index < queue.length && scope.size - before < limit; index++) {
      const guid = queue[index] as string;
      const row = session.get(guid);
      if (row?.publication === undefined || row.lifecycle === 'stale' || row.publication.failure)
        continue;
      const validated = validateRuntimeRow(row);
      if (!validated.ok) continue;
      if (graph.entry(guid) === undefined) {
        if (row.kind === 'mesh' && decoders.uses('mesh', meshAssetDecoder))
          void prefetchSceneMeshBundle(validated.value, scope, started, signal).catch(() => {});
        else void openClosurePack(validated.value, scope, lifetime.signal);
      }
      if (decoders.referencePolicy(row.kind) === 'deferred') continue;
      for (const ref of row.publication.outputs.find((output) => output.guid.toLowerCase() === guid)
        ?.refs ?? []) {
        const key = ref.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(key);
        }
      }
    }
  };
  const decodeRoot = async (
    guid: string,
    signal: AbortSignal,
    scope: PackScope,
  ): Promise<Result<SourceEntry, AssetLoadError>> => {
    const row = session.get(guid);
    if (row === undefined) return err(missing(guid));
    const validated = validateRuntimeRow(row);
    if (!validated.ok) return validated;
    const publication = validated.value.publication;
    const tuple = freezeRuntimePayload({
      ...publication,
      scopeId: session.scopeId,
    });
    const pack = await openClosurePack(validated.value, scope, signal);
    if (!pack.ok) return pack;
    const { fetcher } = pack.value;
    const envelope = pack.value.assets.get(guid.toLowerCase());
    if (envelope === undefined) return err(missing(guid));
    const output = publication.outputs.find(
      (output) => output.guid.toLowerCase() === guid.toLowerCase(),
    );
    if (output === undefined) return err(missing(guid));
    const read = async (descriptor: ArtifactDescriptor) => {
      if (descriptor.integrity === undefined)
        return Promise.resolve(err(artifactError(guid, descriptor.path)));
      const result = await storedArtifact(
        { packageUrl: row.packageUrl, guid, artifactKey: descriptor.path, descriptor },
        signal,
        fetcher,
      );
      return result.ok ? ok(result.value.decoded) : result;
    };
    const artifacts: AssetArtifactReader = {
      locate: (descriptor) => {
        const path = validateArtifactPath(descriptor.path, {
          packageRoot: row.packageUrl,
          guid,
          artifactKey: descriptor.path,
        });
        return path.ok ? resolveArtifactUrl(row.packageUrl, path.value) : undefined;
      },
      program: (descriptor) => {
        const integrity = descriptor.integrity;
        if (integrity === undefined)
          return Promise.resolve(err(artifactError(guid, descriptor.path)));
        const key = `${integrity.digest}:${descriptor.byteLength}`;
        let resident = programs.get(key);
        if (resident === undefined) {
          resident = read(descriptor);
          programs.set(key, resident);
          void resident.then((result) => {
            if (!result.ok) programs.delete(key);
          });
        }
        return resident;
      },
      read,
    };
    const input: AssetDecoderInput<unknown> = { envelope, artifacts, signal };
    const decoderIdentity = decoders.identity(envelope.kind);
    const references = decoders.referencePolicy(envelope.kind);
    const decoded = await decoders.loadByKind(envelope.kind, input);
    if (!decoded.ok) return decoded;
    if (
      envelope.kind.startsWith('water-') &&
      decoded.value &&
      typeof decoded.value === 'object' &&
      'kind' in decoded.value
    ) {
      for (const ref of envelope.refs) {
        const dependency = await session.require(ref);
        if (!dependency.ok) return dependency;
      }
      const referenceError = validateAssetReferences(
        decoded.value as Asset,
        guid,
        envelope.refs.map((ref) => ({ guid: ref })),
        (target) => session.get(target)?.kind,
      );
      if (referenceError)
        return err({
          code: 'asset-decode-failed',
          expected: referenceError.expected,
          hint: referenceError.hint,
          detail: {
            guid,
            kind: envelope.kind,
            cause: {
              code: referenceError.code,
              expected: referenceError.expected,
              hint: referenceError.hint,
              detail: referenceError.detail,
            },
          },
        });
    }
    if (decoders.identity(envelope.kind) !== decoderIdentity)
      return err({
        code: 'asset-superseded',
        expected: 'the decoder used by this source read',
        hint: 'load with the current decoder lease',
        detail: { guid, generation: tuple.generation },
      });
    return ok({
      identity: Symbol(guid),
      value: freezeRuntimePayload(decoded.value),
      kind: envelope.kind,
      decoderIdentity,
      // The graph decodes this output's references. The publication fence owns package evidence.
      refs: [...new Set(envelope.refs)],
      publication: tuple,
      digest: output.digest,
      references,
      ...standaloneMeshBody(envelope),
    });
  };
  const graph = new AssetGraph<SourceEntry, PackScope>({
    ...(options.maxConcurrentReads === undefined
      ? {}
      : { maxConcurrentReads: options.maxConcurrentReads }),
    read: decodeRoot,
    openScope: () => new Map(),
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

  const startCatalog = async (guid: string): Promise<Result<void, AssetLoadError>> => {
    const started = await session.start();
    if (!started.ok) return err(sourceFailure(guid, started.error.message));
    if (!session.isStale) return ok(undefined);
    const reconciled = await session.reconcile();
    if (!reconciled.ok) return err(sourceFailure(guid, reconciled.error.message));
    const discontinuity = session.discontinuity();
    return discontinuity === undefined ? ok(undefined) : err(discontinuity);
  };

  const registry: AssetSource = {
    catalog: session,
    catalogSource: options.catalog,
    openLoadScope: () => new Map(),
    withDecodedClosure: (guid, read) => graph.withDecodedClosure(guid, read),
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
    canTakeMesh: (root, guid, entry) =>
      entry.meshBody !== undefined &&
      decoders.uses('mesh', meshAssetDecoder) &&
      entry.decoderIdentity === decoders.identity('mesh') &&
      graph.canTakeReady(root, guid, entry),
    takeMesh: (guid) => graph.takeReady(guid),
    retainMeshArtifact: async (
      guid,
      expected,
      decoderIdentity,
      signal = lifetime.signal,
      bodyEnvelope,
    ) => {
      if (
        signal.aborted ||
        !decoders.uses('mesh', meshAssetDecoder) ||
        decoderIdentity !== decoders.identity('mesh')
      )
        return err('source-unavailable');
      const row = session.get(guid);
      const decoded = graph.entry(guid);
      if (
        row === undefined ||
        (bodyEnvelope === undefined &&
          (decoded === undefined || decoded.decoderIdentity !== decoderIdentity)) ||
        !checkCurrent(guid, expected).ok
      )
        return err('source-unavailable');
      const fetcher = sourceFetcher(row.packageUrl);
      const envelope =
        bodyEnvelope ??
        decoded?.meshBody ??
        (decoded && (await generatedMeshBody(row, decoded, guid, signal, fetcher)));
      const body = envelope?.artifacts.body;
      if (envelope === undefined || body === undefined) return err('source-unavailable');
      const pinned = await retainStandaloneMeshBody(
        row.packageUrl,
        envelope,
        body,
        signal,
        fetcher,
      );
      if (!pinned.ok) return pinned;
      if (
        signal.aborted ||
        decoderIdentity !== decoders.identity('mesh') ||
        !checkCurrent(guid, expected).ok
      ) {
        pinned.value.release();
        return err('source-unavailable');
      }
      return ok({
        ...pinned.value,
        releaseDecodedSource: () => {
          if (decoded) graph.discardReady(guid, decoded);
        },
      });
    },
    trimReadCache: () => {
      bundles.trim();
    },
    invalidate: (guid) => {
      graph.invalidate(guid);
    },
    revision: (guid) => graph.revision(guid),
    preparePublication: (pack, rows, values, standaloneMeshes, decoderIdentities) => {
      if (pack.scopeId !== session.scopeId)
        throw new TypeError('prepared publication must belong to the configured Catalog scope');
      const prepared = new Map<string, SourceEntry>();
      for (const row of rows) {
        // The immutable artifact is already prepared and remains available
        // to a first consumer. Keep no decoded cache for unconsumed meshes.
        if (standaloneMeshes.has(row.guid)) continue;
        const envelope = pack.assets.find((asset) => asset.guid === row.guid);
        const output = row.publication?.outputs.find((output) => output.guid === row.guid);
        const value = values.get(row.guid);
        if (!envelope || !output || !value || !row.publication)
          throw new TypeError(`missing prepared publication output ${row.guid}`);
        prepared.set(row.guid.toLowerCase(), {
          identity: Symbol(row.guid),
          value,
          kind: row.kind,
          decoderIdentity: decoderIdentities.get(row.kind),
          refs: [...new Set(envelope.refs)],
          references: decoders.referencePolicy(row.kind),
          // Prepared rows are the Registry's private captured copies, not caller rows.
          publication: freezeRuntimePayload({ ...row.publication, scopeId: session.scopeId }),
          digest: output.digest,
          ...standaloneMeshBody(envelope as PackEnvelope),
          ...nativeMeshProjection(envelope),
        });
      }
      graph.prepare(prepared);
    },
    readMeshGeometry: (guid, loadOptions = {}) =>
      graph.withDecodedClosure(guid, async () => {
        if (!isValidAssetGuidString(guid)) return err(invalidGuid(guid));
        const signal = loadOptions.signal ?? lifetime.signal;
        if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(guid));
        const started = await startCatalog(guid);
        if (!started.ok) return started;
        // Demand only this published output's metadata. References remain checked,
        // but a CPU source read never admits their render dependency closures.
        const admitted = await session.require(guid);
        if (!admitted.ok) return admitted;
        if (admitted.value.kind !== 'mesh') return err(mismatch(guid, 'mesh', admitted.value.kind));
        const before = validatePublicationReferences(guid, admitted.value, (key) =>
          session.get(key),
        );
        if (!before.ok) return before;
        // First demand may publish the declared output. Capture invalidation only
        // after that admission, just as ordinary source loads do.
        const revision = graph.revision(guid);
        const decoderIdentity = decoders.identity('mesh');
        const decoded = await graph.readOutput(
          guid,
          signal,
          (entry) => decoderIdentity !== undefined && entry.decoderIdentity === decoderIdentity,
        );
        if (!decoded.ok) return decoded;
        if (signal.aborted || lifetime.signal.aborted) return err(assetLoadCancelled(guid));
        const requested = admitted.value.publication;
        const actual = decoded.value.publication;
        if (
          graph.revision(guid) !== revision ||
          decoded.value.decoderIdentity !== decoders.identity('mesh') ||
          actual.generation !== requested.generation ||
          actual.digest !== requested.digest ||
          actual.outputSetDigest !== requested.outputSetDigest
        )
          return err({
            code: 'asset-superseded',
            expected: 'the source read to remain current until completion',
            hint: 'retry the current Mesh publication',
            detail: { guid, generation: revision },
          });
        const current = checkCurrent(guid, actual);
        if (!current.ok) return current;
        // Only the CPU geometry leaves; no graph Ready entry or runtime handle is made.
        return copyCpuMeshGeometry(guid, decoded.value.value);
      }),
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
      loadOptions: SourceLoadOptions = {},
    ): Promise<Result<unknown, AssetLoadError>> => {
      if (!isValidAssetGuidString(guid)) return err(invalidGuid(guid));
      if (loadOptions.signal?.aborted) return err(assetLoadCancelled(guid));
      const request = (async () => {
        const expectedKind = typeof kind === 'string' ? kind : kind.kind;
        const started = await startCatalog(guid);
        if (!started.ok) return started;
        const declared = session.get(guid);
        if (declared !== undefined && declared.kind !== expectedKind)
          return err(mismatch(guid, expectedKind, declared.kind));
        const parallelSceneClosure = expectedKind === 'scene' && loadOptions.usage === 'render';
        let scope = loadOptions.readScope;
        if (parallelSceneClosure && !loadOptions.refresh && !loadOptions.signal?.aborted) {
          scope ??= new Map();
          startKnownScenePacks(guid, scope, loadOptions.signal);
        }
        const admitted = await admit(guid, new Set(), loadOptions.refresh);
        if (!admitted.ok) return admitted;
        const row = admitted.value;
        if (row.kind !== expectedKind) return err(mismatch(guid, expectedKind, row.kind));
        const before = validatePublicationReferences(guid, row, (guid) => session.get(guid));
        if (!before.ok) {
          graph.invalidate(guid);
          return before;
        }
        invalidateRetiredDecoders(guid);
        const result = await graph.load(guid, loadOptions.signal, scope, parallelSceneClosure);
        if (!result.ok) return result;
        if (invalidateRetiredDecoders(guid))
          return err({
            code: 'asset-superseded' as const,
            expected: 'the decoded closure to keep its exact owner leases',
            hint: 'load the closure with current decoders',
            detail: { guid, generation: graph.revision(guid) },
          });
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
    checkCurrentMany: (guids) => {
      const rows: [string, CatalogEntry | undefined][] = [];
      for (const guid of guids) {
        const entry = graph.entry(guid);
        if (entry === undefined) return err(missing(guid));
        const current = checkCurrentIdentity(guid, entry.publication);
        if (!current.ok) return current;
        rows.push([guid, current.value]);
      }
      const references = validatePublicationReferenceRoots(rows, (guid) => session.get(guid));
      if (!references.ok && references.error.code === 'asset-dependency-failed')
        graph.invalidate(references.error.detail.guid);
      return references;
    },
    snapshot: () => snapshot(),
    subscribe: (listener) => graph.subscribe(listener),
    dispose: () => {
      lifetime.abort();
      graph.dispose();
      reader.dispose();
      unsubscribeCatalog();
      inflight.clear();
      programs.clear();
      bundles.clear();
      retained.leave(bundles);
      session.dispose();
    },
  };
  // Native Runtime Pack meshes have a producer-owned cooked transport
  // projection under the same immutable publication as their verified value.
  async function generatedMeshBody(
    row: CatalogEntry,
    decoded: SourceEntry,
    guid: string,
    signal: AbortSignal,
    fetcher: PackageFetcher,
  ): Promise<PackEnvelope | undefined> {
    if (!decoded.nativeMesh) return undefined;
    const pack = await reader.read(row.packageUrl, decoded.publication, signal, fetcher);
    if (!pack.ok) return undefined;
    const envelope = pack.value.assets.find((output) => output.guid.toLowerCase() === guid);
    return envelope && standaloneMeshBody(envelope).meshBody;
  }

  async function retainStandaloneMeshBody(
    packageUrl: string,
    envelope: PackEnvelope,
    descriptor: ArtifactDescriptor,
    signal: AbortSignal,
    fetcher: PackageFetcher,
  ): Promise<Result<Omit<FixedMeshArtifact, 'releaseDecodedSource'>, MeshArtifactFailure>> {
    const request = { packageUrl, guid: envelope.guid, artifactKey: descriptor.path, descriptor };
    if (descriptor.byteRange === undefined && descriptor.byteLength !== undefined) {
      const fixed = options.catalog.retainArtifact?.(packageUrl, descriptor.path);
      if (fixed !== undefined)
        return pinMeshArtifact(retained, descriptor.byteLength, 'publication', async () => {
          const bytes = (await readArtifact(request, fixed)).unwrap();
          return decodeStandaloneMeshBody(envelope, bytes);
        });
    }
    const result = await storedArtifact(request, signal, fetcher);
    if (!result.ok) return err('source-unavailable');
    const bytes = result.value.decoded;
    return pinMeshArtifact(retained, bytes.byteLength, 'retained-bytes', () =>
      decodeStandaloneMeshBody(envelope, bytes.slice()),
    );
  }

  function snapshot(): AssetSourceSnapshot {
    return {
      ...graph.snapshot(),
      scopeId: session.scopeId,
      generation: session.generation,
      realm: Object.prototype.toString.call(globalThis),
      bundleTransfers: bundles.transfers.snapshot(),
    };
  }

  /** A cached payload must not be relabelled as the result of a newly installed decoder. */
  function invalidateRetiredDecoders(root: string): boolean {
    const visited = new Set<string>(),
      retired: string[] = [],
      pending = [root];
    while (pending.length > 0) {
      const key = pending.pop() as string;
      if (visited.has(key)) continue;
      visited.add(key);
      const entry = graph.entry(key);
      if (entry === undefined) continue;
      if (entry.decoderIdentity !== decoders.identity(entry.kind)) retired.push(key);
      if (entry.references === 'eager') for (const child of entry.refs) pending.push(child);
    }
    for (const key of retired) graph.invalidate(key);
    return retired.length > 0;
  }
  function checkCurrent(
    guid: string,
    expected: AssetPublicationTuple,
  ): Result<void, AssetLoadError> {
    const current = checkCurrentIdentity(guid, expected);
    if (!current.ok) return current;
    const references = validatePublicationReferences(guid, current.value, (guid) =>
      session.get(guid),
    );
    if (!references.ok) graph.invalidate(guid);
    return references;
  }
  function checkCurrentIdentity(
    guid: string,
    expected: AssetPublicationTuple,
  ): Result<CatalogEntry, AssetLoadError> {
    const row = currentPublication(guid, expected);
    if (row !== undefined) return ok(row);
    graph.invalidate(guid);
    return err({
      code: 'asset-superseded',
      expected: 'the same root publication until its read completes',
      hint: 'load the current Catalog publication',
      detail: { guid, generation: expected.generation },
    });
  }
  function currentPublication(
    guid: string,
    expected: AssetPublicationTuple,
  ): CatalogEntry | undefined {
    const row = session.get(guid);
    const actual = row?.publication;
    if (
      session.isStale ||
      expected.scopeId !== session.scopeId ||
      row === undefined ||
      actual === undefined ||
      actual.generation !== expected.generation ||
      actual.digest !== expected.digest ||
      actual.outputSetDigest !== expected.outputSetDigest
    )
      return undefined;
    return row;
  }
  return registry;
}

function copyCpuMeshGeometry(guid: string, payload: unknown): Result<MeshGeometry, AssetLoadError> {
  const decodedMesh = payload as MeshAsset;
  if (decodedMesh?.kind !== 'mesh')
    return err(sourceFailure(guid, 'decoder returned another payload kind'));
  const geometry = prepareMeshData(decodedMesh, guid);
  if (!geometry.ok) return err(sourceFailure(guid, geometry.error.actual));
  const mesh = interleavedMesh(decodedMesh);
  // A custom decoder can retain its buffers. Reuse only storage just created
  // by the physical-to-canonical projection.
  const details = copyAssetData({
    attributes: mesh.attributes,
    attributeStorage: 'interleaved' as const,
    submeshes: mesh.submeshes,
    ...(mesh.indices === undefined ? {} : { indices: mesh.indices }),
    ...(mesh.aabb === undefined ? {} : { aabb: mesh.aabb }),
  });
  return ok({
    ...details,
    vertices: mesh.vertices === decodedMesh.vertices ? copyAssetData(mesh.vertices) : mesh.vertices,
  });
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
