import type { PackageFetcher } from '@forgeax/engine-types';
import {
  copyPreparedAsset,
  prepareAssetPayload,
  validateAssetReferences,
} from '../prepare-payload.js';
import { captureTerrainClosure } from '../terrain-closure.js';
// @forgeax/engine-assets-runtime -- load-by-guid + pack-fetch collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w7, D-4). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). This is the largest method cluster (loadByGuid
// + the DDC / pack-index / pack-file fetch + parse pipeline).

import { decompressZstd } from '@forgeax/engine-codec';
import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import { isEngineMaterial } from '@forgeax/engine-shader';
import {
  type ArtifactDescriptor,
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetCompression,
  AssetError,
  type AssetErrorCode,
  type AssetErrorDetail,
  type AssetRef,
  type CatalogSubject,
  type ImageError,
  type ImageMetadata,
  type LoadContext,
  type MaterialAsset,
  type MeshAsset,
  materialChildForbiddenFields,
  type ParseErrorDetail,
} from '@forgeax/engine-types';
import type { AssetRegistry, ParsedPackFile } from '../asset-registry';
import { packEnvelopeIssue } from '../internal/pack-envelope.js';
import { bytesOf, type PackageReadFailure, readPackage } from '../internal/package-read.js';
import { validatePublicationReferences } from '../internal/publication-references.js';
import { cloneRetainedPackPayload } from '../internal/retained-material-facts.js';
import { readRetainedPackJson } from '../internal/retained-pack-json.js';
import {
  createMaterialLoader,
  type MaterialLoadError,
  type MaterialLoadRequest,
  type MaterialPublication,
  type MaterialReady,
} from '../material/loader';
import { artifactUrl } from './artifact-io';
import { type CatalogRecord, resolveCatalogAssetUrl } from './catalog';
import { buildBreadcrumbHint, createSceneChildContextLookup } from './instantiate';
import { traceAssetLoadPhase } from './load-trace';
import { resolveRuntimeProjection } from './runtime-projection';

/**
 * Load an asset and all its transitively referenced sub-assets by GUID;
 * returns `ok(handle)` only when the asset and every sub-asset are in the
 * registry.
 *
 * **Post-condition:** `ok(payload)` is returned ONLY when the asset AND every
 * transitively referenced sub-asset (per the asset envelope's `refs[]`) are
 * present in this registry. The implementation walks `envelope.refs` and
 * recursively calls `loadByGuid` on each ref before cataloguing the top-level
 * asset. The resolved value is the PAYLOAD `T`
 * (D-17), never a handle -- mint a column handle with
 * `world.allocSharedRef('Kind', payload)` when one is needed (e.g. before
 * `instantiate`).
 *
 * Two paths:
 * - **Dev / fallback** (no `configurePackIndex` call): synchronous catalogue
 *   lookup wrapped in `Promise.resolve`. Returns `Err(asset-not-found)` if not
 *   catalogued.
 * - **Prod** (after `configurePackIndex(url)`): fetches `pack-index.json`
 *   on the first call (cached as a `Map<guid, {packageUrl, kind}>`), then
 *   fetches the individual resource URL and parses the asset payload, then
 *   catalogues it (GUID -> payload) and returns the payload.
 *
 * Error union: `AssetError | PackError | ImageError | RhiError` (closed -- no
 * new codes were introduced by the recursive walk; every code is pre-existing).
 *
 * An in-flight `Map` (D-5) deduplicates concurrent calls for the same GUID and
 * prevents stack overflow on cycles (A->B->A).
 *
 * **Breaking-change classification:** this is a semantic strengthening, not a
 * shape change. Sub-assets catalogued by a prior `catalog(guid, payload)` /
 * `loadByGuid` call are protected by the catalogue fast-path: the recursive
 * walk hits cache on every node and incurs zero additional fetch.
 *
 * @example
 * ```ts
 * const res = await engine.assets.loadByGuid<SceneAsset>(sceneGuid);
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':
 *       // top GUID or any sub-asset GUID is missing from the catalog
 *       break;
 *     case 'asset-fetch-failed':
 *       // network / CORS
 *       break;
 *     case 'asset-parse-failed':
 *       // payload malformed
 *       break;
 *     // ... AssetErrorCode | PackErrorCode | ImageErrorCode | RhiErrorCode exhaustive
 *   }
 *   return;
 * }
 * ```
 */
export async function loadByGuid<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  parentContext?: {
    sceneEntityKey?: string;
    componentField?: string;
  },
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  const key = AssetGuid.format(guid).toLowerCase();
  const isCurrent = currentLoad(registry, key);
  const before = validateRegistryReferences(registry, key);
  if (!before.ok) {
    registry.invalidate(key);
    return before;
  }
  const result = await loadByGuidInternal<T>(registry, guid, parentContext, new Set());
  if (!isCurrent()) return invalidated(key);
  if (!result.ok) return result;
  const loaded = result.value as Asset;
  if (loaded.kind === 'terrain' && !captureTerrainClosure(registry, loaded)) {
    registry.invalidate(key);
    return err(
      new AssetError({
        code: 'asset-invalidated',
        expected: 'an unchanged complete terrain closure',
        hint: 'reload the entire terrain publication',
      }),
    );
  }
  const after = validateRegistryReferences(registry, key);
  if (!after.ok) registry.invalidate(key);
  return after.ok ? result : after;
}

/** Reuse the accepted Catalog projection; no second dependency graph for the legacy reader. */
export function validateRegistryReferences(
  registry: AssetRegistry,
  guid: string,
): Result<void, AssetError> {
  const lookup = (key: string) => registry.packIndexCache?.get(key.toLowerCase());
  const checked = validatePublicationReferences(guid, lookup(guid), lookup);
  return checked.ok
    ? checked
    : err(
        new AssetError({
          code: 'asset-invalidated',
          expected: checked.error.expected,
          hint: checked.error.hint,
        }),
      );
}

function currentLoad(registry: AssetRegistry, guidKey: string): () => boolean {
  const generation = registry.generations.get(guidKey) ?? 0;
  const globalGeneration = registry.globalGeneration;
  return () =>
    generation === (registry.generations.get(guidKey) ?? 0) &&
    globalGeneration === registry.globalGeneration;
}

function invalidated(guidKey: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalidated',
      expected: `GUID ${guidKey} to remain current until publication`,
      hint: ASSET_ERROR_HINTS['asset-invalidated'],
    }),
  );
}

function cookedRecordFromPayload(payload: Record<string, unknown>): unknown {
  if (payload.schemaVersion === 'material-cook/4') return payload;
  if (payload.cooked !== null && typeof payload.cooked === 'object') return payload.cooked;
  if (payload.record !== null && typeof payload.record === 'object') return payload.record;
  return undefined;
}

async function loadMaterialPublicationByGuid(
  registry: AssetRegistry,
  request: MaterialLoadRequest,
  isCurrent = currentLoad(registry, request.guid.toLowerCase()),
  boundFetcher?: PackageFetcher,
): Promise<MaterialPublication | undefined> {
  const parsedGuid = AssetGuid.parse(request.guid);
  if (!parsedGuid.ok) return undefined;
  const resolved = await resolveCatalogEntry(registry, request.guid.toLowerCase());
  if (!resolved.ok) throw resolved.error;
  const entry = resolved.value;
  if (!isCurrent() || entry === undefined) return undefined;
  const fetcher = boundFetcher ?? registry.openPackage(entry.packageUrl);
  let pack = registry.packFiles.get(entry.packageUrl)?.value;
  if (pack === undefined) {
    const fetched = await fetchAndCachePackFile(
      registry,
      entry.packageUrl,
      request.guid.toLowerCase(),
      fetcher,
    );
    if (!isCurrent() || !fetched.ok) return undefined;
    pack = registry.packFiles.get(entry.packageUrl)?.value;
  }
  const asset = pack?.assets.find(
    (candidate) => candidate.guid.toLowerCase() === request.guid.toLowerCase(),
  );
  if (asset === undefined || asset.kind !== 'material') return undefined;
  let record = cookedRecordFromPayload(asset.payload);
  if (record === undefined) return undefined;
  const artifacts: Record<string, { bytes: Uint8Array; digest?: string }> = {};
  const descriptors = Object.entries(asset.artifacts ?? {});
  // Legacy inline-only records keep the original validation and byte route.
  if (descriptors.length === 0) {
    const parsed = validateCookedMaterialRecord(record);
    if (!parsed.ok) return { guid: request.guid, record };
    for (const { artifact } of parsed.value.programs)
      artifacts[artifact.path] ??= { bytes: artifact.bytes, digest: artifact.digest };
    return { guid: request.guid, record, artifacts };
  }

  // Compact production transport restores bytes before the existing complete
  // record validator runs. Inline records retain their bytes for equality checks.
  const rawPrograms = (record as { programs?: unknown }).programs;
  if (!Array.isArray(rawPrograms)) return { guid: request.guid, record };
  const artifactReads = new Map<string, ReturnType<typeof registry.artifactCache.read>>();
  const pendingPrograms = rawPrograms
    .map(async (rawProgram) => {
      if (rawProgram === null || typeof rawProgram !== 'object') return undefined;
      const program = rawProgram as Record<string, unknown>;
      if (program.artifact === null || typeof program.artifact !== 'object') return undefined;
      const artifact = program.artifact as Record<string, unknown>;
      if (typeof artifact.path !== 'string' || typeof artifact.digest !== 'string')
        return undefined;

      // Start independent reads together; retain first-path deduplication and the
      // original ordered publication/error decision below.
      let pending = artifactReads.get(artifact.path);
      if (pending === undefined) {
        const artifactKey = artifact.path;
        const descriptor = asset.artifacts?.[artifactKey];
        if (descriptor === undefined)
          return {
            publication: {
              guid: request.guid,
              record,
              artifactError: {
                code: 'asset-artifact-missing',
                expected: `one artifact descriptor for '${artifact.path}'`,
              },
            } satisfies MaterialPublication,
          };
        // Share the bound publication read with generic GUID loading. The
        // descriptor and material record still verify the bytes independently;
        // GUID invalidation clears both consumers' cached and pending reads.
        pending = registry.artifactCache.readArtifact(
          { packageUrl: entry.packageUrl, guid: request.guid, artifactKey, descriptor },
          fetcher,
        );
        artifactReads.set(artifact.path, pending);
      }
      const loaded = await pending;
      if (!isCurrent()) return undefined;
      if (!loaded.ok)
        return {
          publication: {
            guid: request.guid,
            record,
            artifactError: {
              code:
                loaded.error.code === 'asset-artifact-integrity-mismatch'
                  ? loaded.error.code
                  : 'asset-artifact-missing',
              expected: loaded.error.expected,
              actual: loaded.error.detail.observed,
            },
          } satisfies MaterialPublication,
        };
      return { program, artifact, path: artifact.path, bytes: loaded.value };
    })
    .map((pending) =>
      pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
  const hydratedPrograms: unknown[] = [];
  for (const pending of pendingPrograms) {
    const settled = await pending;
    if ('error' in settled) throw settled.error;
    if (!isCurrent()) return undefined;
    const hydrated = settled.value;
    if (hydrated === undefined) return { guid: request.guid, record };
    if ('publication' in hydrated) return hydrated.publication;
    artifacts[hydrated.path] ??= { bytes: hydrated.bytes };
    hydratedPrograms.push(
      hydrated.artifact.bytes === undefined
        ? { ...hydrated.program, artifact: { ...hydrated.artifact, bytes: hydrated.bytes } }
        : hydrated.program,
    );
  }
  record = { ...(record as Record<string, unknown>), programs: hydratedPrograms };
  // The material loader owns complete record validation after hydration.
  return { guid: request.guid, record, artifacts };
}

export async function loadMaterialReadyByGuid(
  registry: AssetRegistry,
  request: MaterialLoadRequest,
): Promise<MaterialReady | MaterialLoadError> {
  const isCurrent = currentLoad(registry, request.guid.toLowerCase());
  const publication = await loadMaterialPublicationByGuid(registry, request, isCurrent);
  return loadMaterialReadyPublication(registry, request, publication, isCurrent);
}

function publicationSpecializationKey(publication: MaterialPublication | undefined): string {
  const record = publication?.record;
  if (record === null || typeof record !== 'object') return '';
  const specializationKey = (record as { readonly specializationKey?: unknown }).specializationKey;
  return typeof specializationKey === 'string' ? specializationKey : '';
}

async function loadMaterialReadyPublication(
  registry: AssetRegistry,
  request: MaterialLoadRequest,
  publication: MaterialPublication | undefined,
  isCurrent = currentLoad(registry, request.guid.toLowerCase()),
): Promise<MaterialReady | MaterialLoadError> {
  const fence = (): MaterialLoadError | undefined => {
    const checked = validateRegistryReferences(registry, request.guid);
    if (isCurrent() && checked.ok) return undefined;
    return {
      status: 'Error',
      error: {
        code: 'material-reference-not-ready',
        expected: checked.ok
          ? 'the same material publication until readiness completes'
          : checked.error.expected,
        hint: 'restore the recorded material and reference versions before switching consumers',
        retryable: true,
        recoveryActions: ['retry-material-load'],
        detail: { ...request },
      },
    };
  };
  const before = fence();
  if (before) {
    if (isCurrent()) registry.recordMaterialReadiness(request.guid, before);
    return before;
  }
  const loader = createMaterialLoader({
    loadPublication: async () => publication,
    loadReference: async (guid) => {
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) return true;
      const result = await loadByGuid(registry, parsed.value);
      return result.ok;
    },
  });
  const loaded = await loader.load(request);
  const readiness = fence() ?? loaded;
  if (isCurrent()) registry.recordMaterialReadiness(request.guid, readiness);
  return readiness;
}

/** Owned base geometry for source processing, without Asset/Ready authority. */
export type MeshGeometrySource = Pick<
  MeshAsset,
  'vertices' | 'attributes' | 'indices' | 'submeshes' | 'aabb'
>;

/** Read a published Mesh root without admitting it or its render dependencies. */
export async function readMeshGeometryByGuid(
  registry: AssetRegistry,
  guid: AssetGuid,
): Promise<Result<MeshGeometrySource, AssetError | ImageError | RhiError>> {
  const key = AssetGuid.format(guid).toLowerCase();
  const isCurrent = currentLoad(registry, key);
  const fail = (expected: string) =>
    err(
      new AssetError({
        code: 'asset-parse-failed',
        expected,
        hint: 'read an existing Mesh publication; use loadByGuid for render-ready Assets',
        detail: { sourcePath: key },
      }),
    );
  const geometry = (asset: Asset): Result<MeshGeometrySource, AssetError> => {
    if (asset.kind !== 'mesh') return fail('Mesh geometry from a Mesh publication');
    try {
      // A registered custom decoder may retain its output. Both ready and
      // freshly decoded payloads must leave this read with private storage.
      const prepared = prepareAssetPayload(copyPreparedAsset(asset));
      if (!prepared.ok) return prepared;
      const mesh = prepared.value as MeshAsset;
      return ok({
        vertices: mesh.vertices,
        attributes: mesh.attributes,
        submeshes: mesh.submeshes,
        ...(mesh.indices === undefined ? {} : { indices: mesh.indices }),
        ...(mesh.aabb === undefined ? {} : { aabb: mesh.aabb }),
      });
    } catch {
      return fail('independently owned, attached Mesh geometry storage');
    }
  };
  const existing = registry.assetCatalog.get(key)?.payload;
  if (existing !== undefined) return geometry(existing);
  if (registry.packIndexUrl === undefined && !registry.hasCatalogSource)
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `Mesh GUID ${key} in the Catalog`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    );
  const resolved = await resolveCatalogEntry(registry, key);
  if (!isCurrent()) return invalidated(key);
  if (!resolved.ok) return resolved;
  const entry = resolved.value;
  if (entry === undefined)
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `published Mesh GUID ${key}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  if (entry.kind !== 'mesh') return fail('Mesh geometry from a Mesh Catalog row');
  const projection = resolveRuntimeProjection(key, entry);
  if (!projection.ok) return projection;
  if (projection.value?.lifecycle !== undefined && projection.value.lifecycle !== 'current')
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `current Mesh publication for ${key}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  const root = await loadPackV2Asset(registry, key, entry.packageUrl, isCurrent);
  if (!isCurrent()) return invalidated(key);
  if (root === undefined) return fail('a Pack v2 Mesh publication');
  if (!root.ok) return root;
  // The existing decoder verifies artifacts and Mesh metadata. No decoded
  // root enters catalog/load-state/World registration after this read.
  return geometry(root.value.asset);
}

async function loadByGuidInternal<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  parentContext:
    | {
        sceneEntityKey?: string;
        componentField?: string;
      }
    | undefined,
  ancestry: ReadonlySet<string>,
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  const guidKey = AssetGuid.format(guid).toLowerCase();

  // feat-20260614 M8 (D-17): the registry catalogues GUID -> payload and
  // returns the PAYLOAD (never a handle). Fast path: already catalogued
  // (covers dev catalog() + prod cached repeat calls).
  const existing = registry.assetCatalog.get(guidKey);
  if (existing !== undefined) {
    const state = registry.loadState.get(guidKey);
    if (state?.status === 'provisional') {
      // A provisional value is only a legal bridge for a true SCC back-edge.
      // A sibling or unrelated concurrent load must await its owning promise;
      // otherwise the parent reaches promoteReady while the dependency is
      // still provisional and reports a spurious public-readiness failure.
      if (ancestry.has(guidKey)) {
        const provisional = registry.loadState.getProvisional<T>(guidKey);
        if (provisional !== undefined) return ok(provisional);
      } else {
        const inFlight = registry.inFlight.get(guidKey);
        if (inFlight !== undefined) {
          return inFlight as Promise<Result<T, AssetError | ImageError | RhiError>>;
        }
      }
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `GUID ${guidKey} to be promoted to Ready before public load`,
          hint: 'wait for the active load to finish or retry after the referenced assets are ready',
        }),
      );
    }
    if (state?.status === 'ready' || (state === undefined && registry.packIndexUrl === undefined)) {
      const ready = registry.loadState.getReady<T>(guidKey);
      if (ready !== undefined) return ok(ready);
      if (state === undefined) return ok(existing.payload as T);
    }
  }

  // In-flight dedup (D-5 / B-10): if another call is already loading this
  // GUID, return that same Promise — covers (a) concurrent same-GUID calls
  // and (b) cycle A→B→A termination (B reaches A's in-flight entry).
  const inFlightPromise = registry.inFlight.get(guidKey);
  if (inFlightPromise !== undefined) {
    return inFlightPromise as Promise<Result<T, AssetError | ImageError | RhiError>>;
  }

  // Prod fetch path: only enabled when packIndexUrl is configured.
  if (registry.packIndexUrl !== undefined || registry.hasCatalogSource) {
    const isCurrent = currentLoad(registry, guidKey);
    const promise = (async () => {
      try {
        const result = await loadByGuidProd<T>(
          registry,
          guid,
          guidKey,
          parentContext,
          ancestry,
          isCurrent,
        );
        return isCurrent() ? result : invalidated(guidKey);
      } catch (cause) {
        if (!isCurrent()) return invalidated(guidKey);
        throw cause;
      }
    })();
    registry.inFlight.set(guidKey, promise);
    try {
      return await promise;
    } finally {
      if (registry.inFlight.get(guidKey) === promise) registry.inFlight.delete(guidKey);
    }
  }

  // Dev / fallback: synchronous catalogue miss (no network).
  return Promise.resolve(
    err(
      new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${guidKey} catalogued in AssetRegistry`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    ),
  );
}

/**
 * Internal: prod fetch path for `loadByGuid`.
 * Fetches pack-index.json (cached), then fetches the pack file, parses the
 * asset payload, and registers it.
 */
export async function loadByGuidProd<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  parentContext?: {
    sceneEntityKey?: string;
    componentField?: string;
  },
  ancestry: ReadonlySet<string> = new Set(),
  isCurrent = currentLoad(registry, guidKey),
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 lazy iron law):
  // wrap the DDC fetch + load path so a DDC miss can be routed through the
  // injected ImportTransport (studio form) or fail-fast with
  // `asset-not-imported` (shipped form, AC-22). The load path after a
  // successful DDC resolve is identical in both forms -- zero branches on
  // `registry.importTransport` (AC-23 key invariant).
  //
  // A DDC miss is: (a) the GUID is absent from the catalog, OR (b) the
  // `.pack.json` fetch returns `asset-not-found` / `asset-fetch-failed`.
  // In case (a) the transport is probed first (the pack-index may have been
  // built before the asset was imported); in case (b) the transport is the
  // only fallback (the pack file is genuinely missing).

  traceAssetLoadPhase('catalog.resolve.start', { guid: guidKey });
  const resolved = await resolveCatalogEntry(registry, guidKey);
  if (!resolved.ok) return resolved;
  const entry = resolved.value;
  if (!isCurrent()) return invalidated(guidKey);
  traceAssetLoadPhase('catalog.resolve.complete', {
    guid: guidKey,
    ...(entry === undefined ? {} : { packageUrl: entry.packageUrl }),
    detail: { found: entry !== undefined },
  });
  if (entry !== undefined) {
    const projection = resolveRuntimeProjection(guidKey, entry);
    if (!projection.ok) return projection;
    if (projection.value?.lifecycle !== undefined && projection.value.lifecycle !== 'current') {
      return transportOrFail<T>(registry, guid, guidKey, undefined, isCurrent);
    }
    // Catalog hit: try the DDC load path.
    const result = await ddcLoad<T>(
      registry,
      guid,
      guidKey,
      entry,
      parentContext,
      ancestry,
      isCurrent,
    );
    if (result.ok) return result;
    // DDC miss: only route through transport when the error indicates a
    // missing pack file (not a parse / validation failure inside the pack) or
    // an unimported texture source (feat-20260604 M2 / D-1: import-on-demand).
    // `texture-source-not-imported` is an AssetError, so it passes the
    // `instanceof AssetError` guard naturally. `image-decode-failed` is an
    // ImageError (a genuinely corrupt imported .bin) -- it fails the guard and
    // is therefore never transport-eligible (Risk-1), so a real decode
    // failure is never silently lazy-imported.
    const ddcError = result.error;
    const transportEligible =
      ddcError instanceof AssetError &&
      (ddcError.code === 'asset-not-found' ||
        ddcError.code === 'asset-fetch-failed' ||
        ddcError.code === 'texture-source-not-imported' ||
        // perf-20260706: the raw-container fail-fast (mesh/material/scene whose
        // packageUrl is still a .glb/.gltf/.fbx) surfaces source-not-imported;
        // it is transport-eligible so the import runs once and rewrites the row
        // to .bin/.pack.json (the shipped form, with no transport, fails fast).
        // Distinct from the generic asset-not-imported, which must stay
        // NON-eligible so the parent-missing breadcrumb is never masked.
        ddcError.code === 'source-not-imported');
    if (transportEligible) {
      return transportOrFail<T>(registry, guid, guidKey, ddcError, isCurrent);
    }
    return result;
  }

  // Catalog miss: the GUID is not in the pack-index. In the studio form the
  // import transport can lazily create the missing DDC.
  return transportOrFail<T>(registry, guid, guidKey, undefined, isCurrent);
}

/**
 * Resolve the catalog entry for a GUID, lazily fetching the pack-index on
 * first call. A successful miss is `ok(undefined)`; admission failures retain
 * their original error and never become an absent GUID or import fallback.
 */
export async function resolveCatalogEntry(
  registry: AssetRegistry,
  guidKey: string,
): Promise<Result<CatalogRecord | undefined, AssetError>> {
  const key = guidKey.toLowerCase();
  // Re-fetch the pack-index when it has never been fetched (=== undefined) OR
  // when the cached Map lacks this GUID. The miss case covers invalidate(guid)
  // round-2 M-A, which deletes the per-GUID index entry (targeted, bystanders
  // survive) without nuking the whole Map to undefined: the next loadByGuid
  // must re-consult the source so the GUID re-resolves and its freshly-cleared
  // body cache re-fetches. A genuinely absent GUID re-fetches once then still
  // misses, falling through to the transport / asset-not-found path as before.
  if (registry.packIndexCache === undefined || !registry.packIndexCache.has(key)) {
    // AssetRegistry joins the accepted URL-backed CatalogSource baseline with
    // this GUID lookup when both explicitly name the same authority. This
    // keeps enumerateCatalog() -> loadByGuid() and concurrent callers on one
    // per-instance fetch while preserving the legacy path for distinct sources.
    const catalogResult = await registry.ensurePackIndexCache(
      registry.packIndexCache !== undefined,
    );
    if (!catalogResult.ok) return catalogResult;
  }
  return ok(registry.packIndexCache?.get(key));
}

/**
 * feat-20260618 M3 (D-2): once the pack-index is parsed, group every row by
 * its `packageUrl` and register each package fully -- all of its GUIDs and
 * their entry display names in one `registerPackage` call. Registering the
 * whole package at once (rather than one GUID per load) means the package
 * cardinality is known up front, so `resolveName` preserves an explicit entry
 * name for both single- and multi-asset packages and uses the package basename
 * only as a fallback. There is no incremental 1->N promotion needed on the
 * prod path. The name travels entry -> Package, never through the payload
 * (Risk-3 JSON-roundtrip safety), and covers both the sync (parseAssetPayload)
 * and async (texture/font) loads.
 */
export function registerPackagesFromIndex(
  registry: AssetRegistry,
  catalog: Map<
    string,
    {
      packageUrl: string;
      name?: string;
      sourcePath?: string;
      subject?: CatalogSubject;
    }
  >,
): void {
  const byPath = new Map<string, { guids: string[]; names: Map<string, string> }>();
  for (const [guidKey, entry] of catalog) {
    // Imported outputs are published under generated DDC/package URLs, but
    // their stable package identity is the authored source. Keeping that
    // source path here preserves `sky.hdr` (and equivalent source names) for
    // single-asset lazy imports; authored internal packages retain their
    // package URL semantics.
    const packagePath =
      entry.subject === 'imported-output' && entry.sourcePath !== undefined
        ? entry.sourcePath
        : entry.packageUrl;
    let group = byPath.get(packagePath);
    if (group === undefined) {
      group = { guids: [], names: new Map() };
      byPath.set(packagePath, group);
    }
    group.guids.push(guidKey);
    if (entry.name !== undefined) group.names.set(guidKey, entry.name);
  }
  for (const [path, group] of byPath) {
    registry._registerPackage(path, group.guids, group.names);
  }
}

/**
 * Load an asset through the DDC (catalog entry -> fetch pack -> loader.load
 * -> register). Returns `Err(asset-not-found)` or `Err(asset-fetch-failed)`
 * on DDC miss (the caller then decides whether to route through the
 * import transport).
 *
 * This path is IDENTICAL in studio and shipped forms -- the only difference
 * between the two is whether `registry.importTransport` exists when the caller
 * falls back to `transportOrFail` (AC-23 key invariant).
 */
export async function ddcLoad<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  entry: {
    packageUrl: string;
    kind: string;
    name?: string;
    metadata?: ImageMetadata | undefined;
    compression?: AssetCompression;
  },
  parentContext?: {
    sceneEntityKey?: string;
    componentField?: string;
  },
  ancestry: ReadonlySet<string> = new Set(),
  isCurrent = currentLoad(registry, guidKey),
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  if (typeof entry.packageUrl !== 'string' || entry.packageUrl.length === 0) {
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `catalog entry for GUID ${guidKey} to contain a packageUrl locator`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }
  traceAssetLoadPhase('pack.load.start', {
    guid: guidKey,
    packageUrl: entry.packageUrl,
  });
  const fetcher = registry.openPackage(entry.packageUrl);
  const packResult = await loadPackV2Asset(registry, guidKey, entry.packageUrl, isCurrent, fetcher);
  if (!isCurrent()) return invalidated(guidKey);
  traceAssetLoadPhase('pack.load.complete', {
    guid: guidKey,
    packageUrl: entry.packageUrl,
    detail: { ok: packResult?.ok === true },
  });
  if (packResult === undefined) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `Pack v2 package for GUID ${guidKey}`,
        hint: 'legacy top-level asset payloads are not accepted',
      }),
    );
  }
  if (!packResult.ok) {
    return packResult as Result<T, AssetError>;
  }

  const asset = packResult.value.asset;
  // feat-20260622 M4 / w12: project the pack-entry refs[] (GUID strings) into
  // AssetRef[] for the envelope. The on-disk pack.json refs[] carries only
  // GUID strings (sourceField / sceneEntityKey are stripped at the
  // serialization boundary, w7 D-10), so prod-loaded edges have no per-entity
  // metadata — the scene breadcrumb fallback (buildSceneChildContext) still
  // walks the payload for entity/field detail. Dev-server register paths that
  // carry rich AssetRef[] keep their edge metadata end-to-end.
  const packRefs: readonly AssetRef[] = packResult.value.refs.map((g) => ({ guid: g }));

  registry.loadState.begin(
    guidKey,
    registry.loaders.referencePolicy(asset.kind) === 'deferred'
      ? []
      : packRefs.map((ref) => ref.guid),
  );

  // The provisional record lets cycle back-edges terminate internally while
  // lookup()/inspect() remain limited to the ready domain.
  // tweak-20260609 M1: catalogue the asset BEFORE recursing into its
  // sub-assets. This way, when a cycle (A→B→A) reaches back to A during
  // B's recursion, A is already catalogued (fast-path hit) and the inFlight
  // Promise for A can be fulfilled. The inFlight entry in `loadByGuid` is
  // the second line of defense — it catches concurrent same-GUID calls
  // before the asset is catalogued.
  const registerResult = registerParsedAsset<T>(registry, guid, asset, guidKey, packRefs);
  if (!registerResult.ok) {
    purgeFailedLoad(registry, guidKey, entry.packageUrl, registerResult.error);
    return registerResult;
  }
  const registeredPayload = registerResult.value;
  registry.loadState.resolveAsset(guidKey, registeredPayload);
  // The material parent edge loads through the unified refs loop below;
  // `catalog` already normalized a wire `parentGuid` into `parent`.
  const registeredAsset = registeredPayload as Asset;
  const parentGuidKey =
    registeredAsset.kind === 'material' && registeredAsset.parent !== undefined
      ? AssetGuid.format(registeredAsset.parent).toLowerCase()
      : undefined;

  // feat-20260622 M4 / w12 (D-5): the recursion source is the just-catalogued
  // envelope's refs[]. The for-loop is kind-agnostic
  // — every AssetRef carries the GUID to recurse on; scene/material/skin all
  // flow through this one loop. Each edge optionally carries sourceField /
  // sceneEntityKey; when present the childContext is built straight from the
  // edge, otherwise the scene branch falls back to walking the payload
  // (buildSceneChildContext) so the prod-path breadcrumb keeps its entity /
  // field detail (on-disk refs[] are GUID-string-only, w7 D-10).
  const envelope = registry.assetCatalog.get(guidKey);
  const refs: readonly AssetRef[] =
    registry.loaders.referencePolicy(asset.kind) === 'deferred' ? [] : (envelope?.refs ?? []);
  if (refs.length > 0) {
    const sceneChildContext =
      asset.kind === 'scene' ? createSceneChildContextLookup(registry, asset) : undefined;
    const subResults = await Promise.all(
      refs.map((ref) => {
        const refGuidKey = ref.guid.toLowerCase();
        const parsedRef = AssetGuid.parse(ref.guid);
        if (!parsedRef.ok) {
          return Promise.resolve({
            guidKey: refGuidKey,
            result: err(
              new AssetError({
                code: 'asset-parse-failed',
                expected: `valid sub-asset GUID referenced by ${asset.kind} ${guidKey}`,
                hint: `refs[] entry '${ref.guid}' is not a valid UUID format`,
              }),
            ) as Result<Asset, AssetError | ImageError | RhiError>,
            childContext: undefined as
              | {
                  sceneEntityKey?: string;
                  componentField?: string;
                  sourceField?: {
                    componentName?: string;
                    fieldName: string;
                    arrayIndex?: number;
                  };
                }
              | undefined,
            isParentEdge: false,
            edge: ref,
          });
        }
        let childContext:
          | {
              sceneEntityKey?: string;
              componentField?: string;
              sourceField?: {
                componentName?: string;
                fieldName: string;
                arrayIndex?: number;
              };
            }
          | undefined;
        if (ref.sceneEntityKey !== undefined || ref.sourceField !== undefined) {
          childContext = {};
          if (ref.sceneEntityKey !== undefined) childContext.sceneEntityKey = ref.sceneEntityKey;
          if (ref.sourceField?.fieldName !== undefined) {
            childContext.componentField =
              (ref.sourceField.componentName !== undefined
                ? `${ref.sourceField.componentName}.`
                : '') +
              ref.sourceField.fieldName +
              (ref.sourceField.arrayIndex !== undefined ? `[${ref.sourceField.arrayIndex}]` : '');
            childContext.sourceField = ref.sourceField;
          }
        } else if (sceneChildContext !== undefined) {
          childContext = sceneChildContext(refGuidKey, guidKey);
        }
        // feat-20260622 M5 / w17 (D-8): the material parent edge. Identify it
        // by either the rich dev-path marker (sourceField.fieldName==='parent')
        // or the prod-path GUID match against the resolved parent GUID
        // (on-disk refs[] strip sourceField, w7 D-10, so the GUID is the only
        // signal). The parent edge carries the distinct `loading parent
        // material X for child Y` breadcrumb (AC-10) instead of the generic
        // buildBreadcrumbHint form, and is guarded to be a material.
        const isParentEdge =
          asset.kind === 'material' &&
          (ref.sourceField?.fieldName === 'parent' ||
            (parentGuidKey !== undefined && refGuidKey === parentGuidKey));
        const childAncestry = new Set(ancestry);
        childAncestry.add(guidKey);
        return loadByGuidInternal(
          registry,
          parsedRef.value,
          childContext ?? parentContext,
          childAncestry,
        ).then((r) => ({
          guidKey: refGuidKey,
          result: r,
          childContext,
          isParentEdge,
          edge: ref,
        }));
      }),
    );

    if (!isCurrent()) return invalidated(guidKey);

    // If any sub-asset load failed, propagate the first error enriched with
    // parent breadcrumb.
    for (const {
      guidKey: subGuidKey,
      result: subResult,
      childContext: subChildContext,
      isParentEdge,
      edge: subEdge,
    } of subResults) {
      // feat-20260622 M5 / w17: parent-edge breadcrumb migration (former Path
      // B). On load failure, carry the distinct `loading parent material X for
      // child Y: <subErr.hint>` form (AC-10 downstream literal assertion) and
      // propagate the parent's own error code verbatim.
      if (isParentEdge && !subResult.ok) {
        const subErr = subResult.error;
        const code: AssetErrorCode =
          subErr instanceof AssetError ? subErr.code : 'asset-parse-failed';
        purgeFailedLoad(registry, guidKey, entry.packageUrl, subErr);
        return err(
          new AssetError({
            code,
            expected: subErr.expected,
            hint: `loading parent material ${subGuidKey} for child ${guidKey}: ${
              subErr.hint ?? ''
            }`,
            ...(subErr instanceof AssetError && subErr.detail !== undefined
              ? { detail: subErr.detail as Readonly<AssetErrorDetail> }
              : {}),
          }),
        );
      }
      // feat-20260622 M5 / w17: parent edge loaded but is not a material —
      // same guard the former Path B carried, with the matching breadcrumb.
      if (isParentEdge && subResult.ok && subResult.value?.kind !== 'material') {
        const error = new AssetError({
          code: 'asset-parse-failed',
          expected: `parent GUID ${subGuidKey} to reference a MaterialAsset`,
          hint: `loading parent material ${subGuidKey} for child ${guidKey}: referenced asset is ${subResult.value?.kind ?? 'unknown'}, not 'material'`,
        });
        purgeFailedLoad(registry, guidKey, entry.packageUrl, error);
        return err(error);
      }
      if (!subResult.ok) {
        const subErr = subResult.error;
        const breadcrumb = buildBreadcrumbHint(
          guidKey,
          asset.kind,
          subGuidKey,
          subChildContext ?? parentContext,
        );
        const code: AssetErrorCode =
          subErr instanceof AssetError ? subErr.code : 'asset-fetch-failed';
        // feat-20260622 verify r1: deliver the breadcrumb provenance in
        // structured form so AI users locate the broken edge by property
        // access (charter P3), not by parsing the hint. Preserve the sub
        // error's own detail when it carries one (more specific); otherwise
        // expose the edge provenance (entity / source field).
        // Prefer the rich dev-path edge provenance; on the prod path the
        // on-disk edge is GUID-only (sourceField stripped, w7 D-10), so fall
        // back to the entity-walk-recovered provenance carried on the
        // childContext (verify r1).
        const provEntityKey = subEdge?.sceneEntityKey ?? subChildContext?.sceneEntityKey;
        const provSourceField = subEdge?.sourceField ?? subChildContext?.sourceField;
        const breadcrumbDetail: Readonly<AssetErrorDetail> = {
          referencedByGuid: guidKey,
          referencedByKind: asset.kind,
          subAssetGuid: subGuidKey,
          ...(provEntityKey !== undefined ? { sceneEntityKey: provEntityKey } : {}),
          ...(provSourceField !== undefined ? { sourceField: provSourceField } : {}),
        };
        const detail: Readonly<AssetErrorDetail> =
          subErr instanceof AssetError && subErr.detail !== undefined
            ? subErr.detail
            : breadcrumbDetail;
        purgeFailedLoad(registry, guidKey, entry.packageUrl, subErr);
        return err(
          new AssetError({
            code,
            expected: subErr.expected,
            hint: `${breadcrumb} / ${subErr.hint ?? ''}`,
            detail,
          }),
        );
      }
    }
  }

  // A Mesh default is a typed dependency, not merely a loadable GUID. This
  // check deliberately lives outside the `refs.length > 0` branch: a producer
  // that puts a default GUID in the payload but omits the matching refs[] edge
  // must fail closed instead of publishing a Mesh whose dependency closure is
  // incomplete.
  const typedReferenceError = validateAssetReferences(
    asset,
    guidKey,
    refs,
    (key) => registry.assetCatalog.get(key)?.payload.kind,
  );
  if (typedReferenceError) {
    purgeFailedLoad(registry, guidKey, entry.packageUrl, typedReferenceError);
    return err(typedReferenceError);
  }

  registry.loadState.promoteReady(guidKey);
  if (asset.kind === 'terrain' && !captureTerrainClosure(registry, asset)) {
    const error = new AssetError({
      code: 'asset-invalidated',
      expected: 'the complete terrain closure adopted with this root',
      hint: 'reload the whole terrain publication after repairing partial dependency replacement',
    });
    purgeFailedLoad(registry, guidKey, entry.packageUrl, error);
    return err(error);
  }
  traceAssetLoadPhase('catalog.promote-ready.complete', {
    guid: guidKey,
    packageUrl: entry.packageUrl,
  });
  if (registry.loadState.getReady(guidKey) === undefined) {
    const error = new AssetError({
      code: 'asset-parse-failed',
      expected: `GUID ${guidKey} and all referenced assets to be public-ready`,
      hint: 'retry after every referenced GUID has loaded successfully',
    });
    purgeFailedLoad(registry, guidKey, entry.packageUrl, error);
    return err(error);
  }
  if (registeredAsset.kind === 'material') {
    const publication = await loadMaterialPublicationByGuid(
      registry,
      {
        guid: guidKey,
        specializationKey: '',
      },
      isCurrent,
      fetcher,
    );
    if (!isCurrent()) return invalidated(guidKey);
    const hasCookedPublication =
      publication !== undefined &&
      (publication.record !== undefined || publication.artifacts !== undefined);
    if (!isEngineMaterial(registeredAsset) || hasCookedPublication) {
      await loadMaterialReadyPublication(
        registry,
        {
          guid: guidKey,
          specializationKey: publicationSpecializationKey(publication),
        },
        publication,
        isCurrent,
      );
      if (!isCurrent()) return invalidated(guidKey);
    }
  }
  return ok(registeredPayload as T);
}

async function loadPackV2Asset(
  registry: AssetRegistry,
  guidKey: string,
  packageUrl: string,
  isCurrent: () => boolean,
  fetcher: PackageFetcher = registry.openPackage(packageUrl),
): Promise<
  | Result<
      {
        asset: Asset;
        refs: readonly string[];
      },
      AssetError
    >
  | undefined
> {
  const prepared = registry.loadState.getPrepared<Asset>(guidKey);
  if (prepared !== undefined)
    return ok({
      asset: copyPreparedAsset(prepared),
      refs: registry.loadState.get(guidKey)?.refs ?? [],
    });
  traceAssetLoadPhase('pack.v2.start', { guid: guidKey, packageUrl });
  const cached = registry.packFiles.get(packageUrl)?.value;
  if (cached === undefined) {
    const inFlight = registry.packFiles.get(packageUrl)?.pending;
    if (inFlight !== undefined) await inFlight.catch(() => undefined);
    if (!isCurrent()) return invalidated(guidKey);
    traceAssetLoadPhase('pack.fetch.start', { guid: guidKey, packageUrl });
    const fetched =
      registry.packFiles.get(packageUrl)?.value === undefined
        ? await fetchAndCachePackFile(registry, packageUrl, guidKey, fetcher)
        : undefined;
    if (!isCurrent()) return invalidated(guidKey);
    traceAssetLoadPhase('pack.fetch.complete', {
      guid: guidKey,
      packageUrl,
      detail: {
        cached: registry.packFiles.get(packageUrl)?.value !== undefined,
        ok: fetched?.ok ?? true,
      },
    });
    if (registry.packFiles.get(packageUrl)?.value === undefined) {
      if (fetched === undefined) {
        return err(
          new AssetError({
            code: 'asset-fetch-failed',
            expected: `pack file ${packageUrl} to be cached after its shared fetch`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        );
      }
      return fetched as unknown as Result<{ asset: Asset; refs: readonly string[] }, AssetError>;
    }
  }
  const pack = registry.packFiles.get(packageUrl)?.value;
  if (pack?.schemaVersion !== '2.0.0') return undefined;
  const asset = pack.assets.find((candidate) => candidate.guid.toLowerCase() === guidKey);
  traceAssetLoadPhase('pack.parse.complete', {
    guid: guidKey,
    packageUrl,
    detail: { found: asset !== undefined, kind: asset?.kind },
  });
  if (asset === undefined) {
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${guidKey} present in Pack v2 package ${packageUrl}`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    );
  }
  const streams: Record<string, { descriptor: ArtifactDescriptor; url: string }> = {};
  const artifacts: Record<string, { descriptor: ArtifactDescriptor; bytes: Uint8Array }> = {};
  const pendingArtifacts = Object.entries(asset.artifacts ?? {})
    .map(async ([artifactKey, descriptor]) => {
      if (descriptor.delivery === 'stream')
        return { stream: true as const, artifactKey, descriptor };
      const artifact = await registry.artifactCache.readArtifact(
        { packageUrl, guid: guidKey, artifactKey, descriptor },
        fetcher,
      );
      return { stream: false as const, artifactKey, descriptor, artifact };
    })
    .map((pending) =>
      pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
  for (const pending of pendingArtifacts) {
    const settled = await pending;
    if ('error' in settled) throw settled.error;
    const loadedArtifact = settled.value;
    const { artifactKey, descriptor } = loadedArtifact;
    if (loadedArtifact.stream) {
      const path = validateArtifactPath(descriptor.path, {
        packageRoot: packageUrl,
        guid: guidKey,
        artifactKey,
      });
      if (!path.ok)
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: path.error.expected,
            hint: path.error.hint,
            detail: { sourcePath: `${packageUrl}#${artifactKey}` },
          }),
        );
      streams[artifactKey] = { descriptor, url: artifactUrl(packageUrl, path.value) };
      continue;
    }
    if (!isCurrent()) return invalidated(guidKey);
    const artifact = loadedArtifact.artifact;
    if (!artifact.ok)
      return artifact as unknown as Result<{ asset: Asset; refs: readonly string[] }, AssetError>;
    artifacts[artifactKey] = { descriptor, bytes: artifact.value };
  }
  if (!isCurrent()) return invalidated(guidKey);
  traceAssetLoadPhase('loader.load.start', { guid: guidKey, packageUrl });
  const loaded = await registry.loaders.loadPack(
    {
      guid: guidKey,
      kind: asset.kind,
      payload: cloneRetainedPackPayload(asset.payload),
      refs: asset.refs ?? [],
      artifacts,
      streams,
    },
    makeLoadContext(registry, fetcher),
  );
  traceAssetLoadPhase('loader.load.complete', {
    guid: guidKey,
    packageUrl,
    detail: { ok: loaded.ok },
  });
  if (!loaded.ok) return err(loaded.error as AssetError);
  if (loaded.value === undefined || typeof loaded.value !== 'object') {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `loader '${asset.kind}' to return an asset payload`,
        hint: 'register a loader that accepts the Pack v2 asset-local input',
      }),
    );
  }
  return ok({ asset: loaded.value as Asset, refs: asset.refs ?? [] });
}

function purgeFailedLoad(
  registry: AssetRegistry,
  guidKey: string,
  packageUrl: string,
  error: unknown,
): void {
  const doomed = registry.loadState.fail(guidKey, error);
  for (const key of doomed) {
    if (registry.assetCatalog.delete(key)) registry.catalogEpoch++;
  }
  const state = registry.packFiles.get(packageUrl);
  if (state !== undefined) {
    delete state.value;
    if (state.pending === undefined) registry.packFiles.delete(packageUrl);
  }
}

/**
 * M4 transport fallback: try the injected {@link ImportTransport} to lazily
 * import a missing DDC, then re-enter the DDC load path. When no transport
 * is wired (shipped form), fail fast with `asset-not-imported` (AC-22).
 */
export async function transportOrFail<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  miss: AssetError | undefined,
  isCurrent = currentLoad(registry, guidKey),
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  if (registry.importTransport === undefined) {
    // shipped form: no transport wired -> fail fast, never degrade to
    // runtime import (AC-22, charter P3 explicit failure).
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `GUID ${guidKey} to have been pre-imported at build time or to have an ImportTransport wired`,
        // Keep the DDC read evidence (URL, HTTP/network reason, attempts).
        hint:
          miss === undefined
            ? ASSET_ERROR_HINTS['asset-not-imported']
            : `${ASSET_ERROR_HINTS['asset-not-imported']}; DDC ${miss.code}: ${miss.hint}`,
        ...(miss?.detail === undefined ? {} : { detail: miss.detail }),
      }),
    );
  }

  // studio form: request the transport to import this GUID on-the-fly.
  // After a successful transport call the DDC is available; re-enter the
  // catalog + DDC load path (the transport writes the DDC but does NOT
  // register the asset — that's the Loader's job).
  const transportResult = await registry.importTransport.fetchPack(
    guidKey,
    registry.runtimeBinding,
  );
  if (!isCurrent()) return invalidated(guidKey);
  if (!transportResult.ok) {
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `import transport to fetch pack for GUID ${guidKey}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }

  // Patch ONLY the freshly imported rows into the catalog cache (per-asset
  // incremental, the four-verb redesign 2026-06-06) instead of nuking the
  // cache and re-fetching the whole pack-index. The transport returns the one
  // imported entry (+ sub-asset siblings); each becomes / overwrites a cache
  // row. This keeps 122 concurrent texture imports O(N) instead of O(N^2)
  // whole-catalog re-fetches and never resets a sibling's imported row.
  const importedEntries = 'entries' in transportResult ? transportResult.entries : undefined;
  if (importedEntries !== undefined && importedEntries.length > 0) {
    // F20: serialise packIndexCache writes through a per-cache Promise queue.
    // The "check -> new Map -> set" block is not atomic across concurrent
    // transportOrFail calls; chaining through the queue ensures each patch
    // completes before the next starts, preventing new-Map overwrite races.
    registry.packIndexCachePatchQueue = registry.packIndexCachePatchQueue.then(() => {
      if (!isCurrent()) return;
      if (registry.packIndexCache === undefined) registry.packIndexCache = new Map();
      for (const e of importedEntries) {
        if (typeof e.packageUrl !== 'string' || e.packageUrl.length === 0) continue;
        registry.packIndexCache.set(e.guid.toLowerCase(), {
          packageUrl: resolveCatalogAssetUrl(registry, e.packageUrl),
          kind: e.kind,
          // Carry the transport's derived display name into the cache row.
          // buildCatalog already resolves it through deriveAssetName (authored
          // names are preserved and the source basename is the fallback, so a
          // freshly imported GLB's 1000+ sub-assets show as "<file>.glb" in the
          // Content Browser
          // instead of blank. Dropping it here made listCatalog fall back to
          // `entry.name ?? ''` — the whole-index re-read path (else branch) kept
          // names, so only the incremental patch path was blank.
          ...(e.name !== undefined ? { name: e.name } : {}),
          // Carry refs on the incremental patch path too, else an asset
          // imported via POST /__import shows missing dependency edges until
          // the next full pack-index refresh (feat: listCatalog refs).
          ...(e.refs !== undefined ? { refs: e.refs } : {}),
          ...(e.packageId !== undefined ? { packageId: e.packageId } : {}),
          ...(e.provenance !== undefined ? { provenance: e.provenance } : {}),
          ...(e.revision !== undefined ? { revision: e.revision } : {}),
          ...(e.authoring !== undefined ? { authoring: e.authoring } : {}),
          ...(e.sourceKey !== undefined ? { sourceKey: e.sourceKey } : {}),
          ...(e.sourceIndex !== undefined ? { sourceIndex: e.sourceIndex } : {}),
          ...(e.relations !== undefined ? { relations: e.relations } : {}),
          ...(e.diagnostics !== undefined ? { diagnostics: e.diagnostics } : {}),
          // Carry sourcePath on the incremental patch path too (same red-line
          // as refs above): an asset imported via POST /__import would
          // otherwise expose no source-file path in listCatalog until the next
          // full pack-index refresh, breaking editor CRUD sidecar lookup for
          // freshly imported assets. `sourcePath` is a required PackIndexEntry
          // field, so it is always present on the transport row.
          ...(e.sourcePath !== undefined ? { sourcePath: e.sourcePath } : {}),
        });
      }
    });
    await registry.packIndexCachePatchQueue;
    if (!isCurrent()) return invalidated(guidKey);
  } else {
    // No inline rows -- re-read the whole pack-index so the freshly imported DDC
    // entry is visible (legacy / non-row-returning transports). Dropping the
    // cache first keeps the import's own row change from invalidating this load;
    // forcing the read queues it behind any in-flight read, whose pre-import
    // response must not be the index this load resolves against.
    registry.packIndexCache = undefined;
    await registry.refreshCatalog();
    if (!isCurrent()) return invalidated(guidKey);
  }
  const resolved = await resolveCatalogEntry(registry, guidKey);
  if (!resolved.ok) return resolved;
  const entry = resolved.value;
  if (!isCurrent()) return invalidated(guidKey);
  if (entry === undefined) {
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `import transport to produce a catalog entry for GUID ${guidKey}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }

  // Re-enter the DDC load path (identical to the catalog-hit path).
  return ddcLoad<T>(registry, guid, guidKey, entry, undefined, new Set(), isCurrent);
}

/**
 * Register a parsed asset POD (the synchronous tail of the DDC load path:
 * `registerWithGuid`). Material parent preload is handled asynchronously
 * inside `ddcLoad` before calling this method; the registered asset is
 * always fully resolved by the time it reaches here.
 *
 * Extracted from the old `loadByGuidProd` body so `ddcLoad` and
 * `transportOrFail` share an identical load path (AC-23 key invariant).
 */
export function registerParsedAsset<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  asset: Asset,
  _guidKey: string,
  refs?: readonly AssetRef[],
): Result<T, AssetError | ImageError | RhiError> {
  // feat-20260614 M8 (D-17): catalogue the parsed payload under its GUID and
  // return the PAYLOAD. `catalog` validates mesh stride + material passes and
  // returns Result.err on failure (no throw), so the loadByGuid surface stays
  // a consistent Result (charter P4 consistent abstraction).
  //
  // feat-20260622 M4 / w12 (D-9): the pack-entry refs[] ride onto the
  // catalogued envelope here so the recursive core can read envelope.refs as
  // its single recursion source.
  return registry.catalog<T>(guid, asset as T, refs) as Result<
    T,
    AssetError | ImageError | RhiError
  >;
}

/**
 * Fetch one pack file, locate the requested asset entry, and either parse it
 * inline or expose the entry to the caller (for kinds that need to preload
 * `refs[]` BEFORE running the loader — currently 'material', whose
 * values handle fields are rewritten to their refs[] GUID strings
 * (feat-20260614 M8 / D-19: GUID verbatim, no handle minting at load time)).
 *
 * bug-20260610 Fix B (M3 / D-4): the fetch+parse result is cached per
 * `packageUrl` in `packFiles`; concurrent calls for the same URL share
 * a single in-flight promise via `packFiles`. Only the raw parsed
 * body is cached — `parseAssetPayload` still runs per-call (CON-2).
 */
export async function fetchPackFile(
  registry: AssetRegistry,
  packageUrl: string,
  guidKey: string,
  _kind: string,
): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
  // ── cache hit ───────────────────────────────────────────────────────
  const cached = registry.packFiles.get(packageUrl)?.value;
  if (cached !== undefined) {
    const assetEntry = cached.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${packageUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return parseAndReturnAsset(registry, assetEntry);
  }

  // ── in-flight dedup ─────────────────────────────────────────────────
  const inFlight = registry.packFiles.get(packageUrl)?.pending;
  if (inFlight !== undefined) {
    try {
      const packFile = await inFlight;
      const assetEntry = packFile.assets.find(
        (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
      );
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${packageUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return parseAndReturnAsset(registry, assetEntry);
    } catch {
      // In-flight promise rejected (network failure) — fall through to
      // re-fetch. The in-flight entry was already cleaned by the
      // catch block in the original miss path.
    }
  }

  // ── miss: fetch + parse + cache ─────────────────────────────────────
  return fetchAndCachePackFile(registry, packageUrl, guidKey);
}

/**
 * Parse the asset payload from a pack-file entry and return the result.
 * Extracted so cache-hit and in-flight-dedup paths share the same
 * parseAssetPayload + error-wrapping logic.
 */
export function parseAndReturnAsset(
  registry: AssetRegistry,
  assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  },
): Result<{ asset: Asset; refs: readonly string[] }, AssetError> {
  const parsed = parseAssetPayload(registry, assetEntry.kind, assetEntry.payload, assetEntry.refs);
  // F21: the scene loader returns its structured ParseErrorDetail inline via
  // the LoaderOutput `{ ok: false, error }` arm, surfaced here through
  // parseAssetPayload's return value -- no shared instance slot.
  if (parsed !== undefined && typeof parsed === 'object' && 'ok' in parsed) {
    const e = (parsed as { readonly ok: false; readonly error: ParseErrorDetail }).error;
    const detail = {
      entityKey: e.entityKey,
      component: e.component,
      field: e.field,
      index: e.index,
      refsLength: e.refsLength,
    };
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `refs index ${e.index} within [0, ${e.refsLength})`,
        detail,
        hint:
          `at node key=${e.entityKey}, component=${e.component}, ` +
          `field=${e.field}: index ${e.index} is out of bounds ` +
          `(refs has ${e.refsLength} entries)`,
      }),
    );
  }
  if (parsed === undefined) {
    const parent =
      typeof assetEntry.payload.parent === 'string'
        ? assetEntry.payload.parent
        : typeof assetEntry.payload.parent === 'number' &&
            Number.isInteger(assetEntry.payload.parent)
          ? assetEntry.refs?.[assetEntry.payload.parent]
          : undefined;
    const childForValidation =
      assetEntry.kind === 'material' && typeof parent === 'string'
        ? ({ ...assetEntry.payload, parent } as unknown as MaterialAsset)
        : undefined;
    const forbidden =
      childForValidation === undefined ? [] : materialChildForbiddenFields(childForValidation);
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `parseable asset payload for kind ${assetEntry.kind}`,
        hint:
          forbidden.length > 0
            ? 'remove root-owned colorSpace, passes, and parameters from the child payload'
            : ASSET_ERROR_HINTS['asset-parse-failed'],
        ...(forbidden.length > 0
          ? { detail: { field: 'material-child-contract', got: forbidden } }
          : {}),
      }),
    );
  }
  // feat-20260622 M4 / w12: surface the pack-entry refs[] (GUID-string
  // projection) alongside the parsed payload so ddcLoad can store them on
  // the catalogued envelope. The recursive core then reads envelope.refs
  // as the single recursion source (D-5), never re-deriving them from
  // the payload.
  return ok({ asset: parsed as Asset, refs: assetEntry.refs ?? [] });
}

function packageReadFailed(url: string, failure: PackageReadFailure): AssetError {
  return new AssetError({
    code: 'asset-fetch-failed',
    expected: `readable package resource at ${url}`,
    hint: `${failure.observed} after ${failure.attempts} request(s); ${ASSET_ERROR_HINTS['asset-fetch-failed']}`,
    detail: { field: 'request', value: url, reason: failure.observed },
  });
}

async function readPackFile(
  registry: AssetRegistry,
  packageUrl: string,
  fetcher: PackageFetcher = registry.openPackage(packageUrl),
): Promise<Result<ParsedPackFile, AssetError>> {
  const invalid = (field: string) =>
    err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `valid Pack field ${field} at ${packageUrl}`,
        hint: 'repair the Pack envelope at the reported field and republish, then retry the same GUID',
        detail: { field, value: packageUrl, reason: 'invalid Pack envelope' },
      }),
    );
  const read = await readPackage(fetcher, packageUrl, readRetainedPackJson);
  if (!read.ok) {
    return read.error.malformed ? invalid('JSON') : err(packageReadFailed(packageUrl, read.error));
  }
  const raw = read.value;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as { assets?: unknown }).assets)
  ) {
    return invalid('assets');
  }
  const pack = raw as ParsedPackFile;
  const guids = new Set<string>();
  for (const [index, asset] of pack.assets.entries()) {
    const issue = packEnvelopeIssue(asset);
    if (issue !== undefined) return invalid(`assets[${index}].${issue}`);
    if (
      asset.payload === null ||
      typeof asset.payload !== 'object' ||
      Array.isArray(asset.payload)
    ) {
      return invalid(`assets[${index}].payload`);
    }
    const guid = asset.guid.toLowerCase();
    if (guids.has(guid)) return invalid(`assets[${index}].guid`);
    guids.add(guid);
  }
  return ok(pack);
}

/**
 * Fetch a pack file from the network, parse the JSON body, store the
 * result in the cache, and return the requested asset entry.
 *
 * Registers the in-flight promise in `packFiles` so concurrent
 * callers share a single fetch. On success the body moves to
 * `packFiles`; on failure the in-flight entry is removed so
 * subsequent retries re-fetch (D-7).
 */
export async function fetchAndCachePackFile(
  registry: AssetRegistry,
  packageUrl: string,
  guidKey: string,
  fetcher: PackageFetcher = registry.openPackage(packageUrl),
  isCurrent: () => boolean = () => true,
): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
  const fetchPromise = readPackFile(registry, packageUrl, fetcher).then((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });

  const state = registry.packFiles.get(packageUrl) ?? {};
  state.pending = fetchPromise;
  registry.packFiles.set(packageUrl, state);

  try {
    const packFile = await fetchPromise;
    if (!isCurrent()) {
      registry.settlePackFile(packageUrl, fetchPromise);
      return invalidated(guidKey);
    }
    registry.settlePackFile(packageUrl, fetchPromise, packFile);

    const assetEntry = packFile.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${packageUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return parseAndReturnAsset(registry, assetEntry);
  } catch (e) {
    registry.settlePackFile(packageUrl, fetchPromise);
    if (e instanceof AssetError) {
      return err(e);
    }
    throw e;
  }
}

/**
 * Reconstruct a typed `Asset` from a raw payload object.
 *
 * @param kind The asset kind discriminant (matches the pack entry or
 *   dev-register dispatch).
 * @param payload The serialised asset payload (keys mirror the asset
 *   interface field names).
 * @param refs Pack-file refs array for Handle fields — when a field
 *   value is `number` it resolves to `refs[N]` (glTF-style index).
 *   Optional to preserve compatibility with callers outside the pack
 *   ingestion path (e.g., direct `registerWithGuid`).
 */
export function parseAssetPayload(
  registry: AssetRegistry,
  kind: string,
  payload: Record<string, unknown>,
  refs?: string[],
):
  | Asset
  | Record<string, unknown>
  | undefined
  | { readonly ok: false; readonly error: ParseErrorDetail } {
  // feat-20260603-asset-import-loader-injection M1 / w4: dispatch on
  // `kind` through the injected LoaderRegistry instead of a hardcoded
  // `if (kind === ...)` chain (D-1 / AC-01). The seven inline pack-payload
  // loaders parse synchronously; texture / font live on the upstream
  // loadByGuidProd branch (w6) and are never reached here.
  // feat-20260623 M2 / w5: unknown kinds pass through the raw payload so
  // host-registered loaders can parse their own kind. The engine does not
  // parse payloads it cannot match; parse responsibility is explicit on the
  // missing loader (charter P3).
  const loader = registry.loaders.get(kind);
  if (loader === undefined) return { ...payload, kind };
  const out = loader.load(payload, refs, makeLoadContext(registry));
  // The inline pack-payload loaders are synchronous (`Asset | undefined`);
  // the async texture / font loaders are dispatched from loadByGuidProd, not
  // here. A Promise here would mean a misregistered loader -> treat as a
  // parse miss rather than leaking a thenable into the sync return.
  if (out !== undefined && typeof (out as { then?: unknown }).then === 'function') {
    return undefined;
  }
  // F21: the scene loader returns { ok: false, error: ParseErrorDetail } for
  // structured parse errors. Pass the error arm straight through the return
  // value so the caller constructs a precise AssetError -- no instance slot.
  if (out !== undefined && out !== null && typeof out === 'object' && 'ok' in out) {
    return out as { readonly ok: false; readonly error: ParseErrorDetail };
  }
  return out as Asset | undefined;
}

/**
 * Build the {@link LoadContext} passed to a loader's `load`.
 * `fetchBinary` / `resolveRef` / `device` are wired for the async texture /
 * font loaders (w6).
 */
export function makeLoadContext(
  registry: AssetRegistry,
  fetcher: PackageFetcher = registry.fetchAsset,
): LoadContext {
  return {
    /**
     * feat-20260706 M3 / w19: fetchBinary signature extended per D-2.
     * `opts?.compression` triggers the single decompression gate (AC-02).
     * 'zstd' → lazy-init codec decompressZstd · 'none' / undefined → pass-through.
     * On decompression failure, the codec error is nested in asset-fetch-failed
     * detail (D-8: runtime error union NOT extended).
     */
    fetchBinary: async (url: string, opts?: { readonly compression?: AssetCompression }) => {
      try {
        const read = await readPackage(fetcher, url, bytesOf);
        if (!read.ok) return { ok: false as const, error: packageReadFailed(url, read.error) };
        let bytes: Uint8Array = read.value;

        // --- Decompression gate (AC-02: single gate inside fetchBinary) ---
        if (opts?.compression === 'zstd') {
          const decRes = await decompressZstd(bytes);
          if (!decRes.ok) {
            return {
              ok: false as const,
              error: new AssetError({
                code: 'asset-parse-failed',
                expected: `zstd decompression for ${url}`,
                hint: `[${decRes.error.code}] ${decRes.error.hint}`,
                detail: { sourcePath: url },
              }),
            };
          }
          bytes = new Uint8Array(
            decRes.value.buffer,
            decRes.value.byteOffset,
            decRes.value.byteLength,
          );
        }
        // compression === 'none' / undefined → E1 pass-through

        return { ok: true as const, value: bytes };
      } catch {
        return {
          ok: false as const,
          error: new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${url}) to succeed`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        };
      }
    },
    resolveRef: async (guid: string) => {
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error };
      }
      const r = await loadByGuid(registry, parsed.value);
      if (!r.ok) return { ok: false as const, error: r.error };
      // feat-20260614 M8 (D-19): resolveRef ensures the sub-asset is
      // catalogued (recursive load). The numeric value is vestigial -- the
      // registry mints no handles; callers store the GUID, not this number.
      return { ok: true as const, value: 0 };
    },
    // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
    // expose the registered shader's derive(paramSchema).textureFieldNames to
    // the materialLoader so it can decide which values fields carry
    // refs[] indices without a hardcoded texture-field allowlist Set
    // (AC-03). Returns `undefined` when the shader is not registered (cross-
    // worktree shader-late-register, plan R-4) — the loader then falls back
    // to a graceful "try every int paramValue" walk.
    getMaterialShaderTextureFieldNames: (shaderId: string) => {
      const lookup = registry.shaderRegistry.findMaterialArtifact(shaderId);
      if (!lookup.ok) return undefined;
      return lookup.value.paramSchemaProjection.derivedInterface.textureFieldNames;
    },
    transcodeCaps: registry.transcodeCaps,
    device: undefined,
  };
}

/**
 * Return a runtime snapshot of every catalogued asset. Each entry exposes
 * `{ guid, kind, name }` where `kind` is the asset discriminant string
 * from `payload.kind`. feat-20260614 M8 (D-15): the registry holds no
 * handles -- entries are keyed by GUID (the catalogue key).
 *
 * AI-user narrowing flow (AC-11 + plan-strategy §7.4):
 * ```ts
 * for (const e of registry.inspect().assets) {
 *   if (e.kind === 'texture') {
 *     // re-query via registry.lookup(e.guid) to get the typed Asset value.
 *   }
 * }
 * ```
 */
