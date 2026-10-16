import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import { copyPackData } from '@forgeax/engine-pack/runtime';
import type { PackageFetcher } from '@forgeax/engine-types';
import { copyPreparedAsset, prepareAssetPayload } from './prepare-payload.js';
import { makeLoadContext } from './registry/load-by-guid.js';
import { readPluginDefinition } from './registry/plugin-definition.js';
import { captureTerrainClosure, terrainClosureCurrent } from './terrain-closure.js';
import {
  type PublicationPreparationServices,
  preparePublicationPayloads,
} from './validate-publication.js';
// @forgeax/engine-assets-runtime - AssetRegistry v2 (feat-20260513-guid-asset-package-system).
//
// Entrypoints (feat-20260614 M8 de-handle cut, D-15/D-17/D-19): the registry
// is a GUID->payload catalogue. It no longer mints or maps handles -- column
// handles are minted on the World via `world.allocSharedRef('Kind', payload)`,
// and resolved through the two-tier `resolveAssetHandle` (BuiltinAssetRegistry
// process-static slots [1,1024) + per-World `world.sharedRefs` slots >=1024).
//
//   - catalog<T extends Asset>(guid, asset): Result<T, AssetError>
//       stores the GUID->payload entry loadByGuid resolves (dev/inline path)
//   - parseGuid(guidStr): AssetGuid
//   - lookup(guid): Asset | undefined          (catalogued payload, no fetch)
//   - loadByGuid<T extends Asset>(guid): Promise<Result<T, AssetError | ImageError | RhiError>>
//       returns the PAYLOAD T (never a handle, D-17)
//       dev/fallback: synchronous catalogue lookup wrapped in Promise
//       prod: fetch(packIndexUrl) -> parse catalog -> fetch entry -> parse Asset
//   - instantiate<T extends SceneAsset>(handle, world, parent?): Result<EntityHandle, ...>
//       handle is a `world.allocSharedRef('SceneAsset', payload)` column handle
//   - inspect(): InspectSnapshot
//
// v1 load(url) removed in feat-20260513-guid-asset-package-system (w12).
// loadByGuid is the replacement; M4/w23 adds real fetch-from-pack-index.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15: the
// `createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`
// triplet is removed alongside the `InstancedBufferAsset` POD; per-entity
// instance transforms are now stored inside the ECS via the `Instances {
// transforms: 'array<f32>' }` component (the RenderSystem record stage owns
// the GPU storage buffer + dirty-version upload). Asset closed-union narrows
// 5 -> 4; the registry surface loses the optional `RhiDevice` constructor
// argument (no remaining device consumer).
//
// Dual-backend audited: the registry is engine-agnostic (no @webgpu/types
// imports + no rhi-webgpu / rhi-wgpu references); the same instance drives
// both dual-impl shim backends through the @forgeax/engine-rhi interface
// SSOT at the consumer site.

import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import { MaterialArtifactRegistry, type ShaderRegistry } from '@forgeax/engine-shader';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetEnvelope,
  AssetError,
  type AssetEvidence,
  type AssetEvidenceError,
  type AssetRef,
  authoringCapabilityForAssetKind,
  type CatalogDelta,
  type CatalogEntry,
  catalogOperationsFor,
  type EngineMetrics,
  type Handle,
  handleSlot,
  type ImageError,
  type ImportTransport,
  type InspectEntry,
  type InspectSnapshot,
  type Loader,
  type MaterialAsset,
  type Package,
  type ParseErrorDetail,
  type RuntimeAssetBinding,
  type SceneAsset,
  type SceneEntity,
  type TagOf,
  type TranscodeCaps,
  type MeshAsset as TypesMeshAsset,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
} from './builtin-asset-registry.js';
import type { LoaderRegistry } from './loader-registry.js';
import { createDefaultLoaderRegistry } from './wire-default-loaders.js';

/**
 * Strip readonly from all fields of T. Used to mutate the MeshAsset.aabb slot
 * after mesh validation passes (the interface is readonly but register-time
 * computation writes the real AABB into the caller's placeholder).
 */

import { componentSchema } from '@forgeax/engine-ecs/internal';
// feat-20260705-runtime-tier2-decomposition M1 / w4 (D-4 F1): the pre-class
// constants, loaders, scene-payload / payload-validate / aabb helpers were
// straight-cut into sibling modules. The thin class value-imports only what its
// method bodies still reference; the full public consumer face (barrel + tests)
// is preserved via the `export ... from` re-export block below (pre-w14 shim,
// removed when consumers repoint in w14/w15).
import type { CatalogListener, CatalogSource } from './catalog-source.js';
import {
  BUILTIN_MESH_GUIDS,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles.js';
import { freezePackValue } from './internal/pack-reader.js';
import { inspectReady, type MaterialRuntimeInfo } from './material/inspection.js';
import type { MaterialLoadError, MaterialReady } from './material/loader.js';
import {
  assertMaterialStaticSelection,
  installMaterialReadyShaders,
  type MaterialRenderProjection,
} from './material/runtime-shader.js';
import { ArtifactReadCache } from './registry/artifact-io.js';
import {
  createRuntimeAssetEvidenceAdapter,
  type RuntimeAssetEvidenceAdapter,
  type RuntimeEvidenceSource,
} from './registry/asset-evidence.js';
import {
  type CatalogRecord,
  fetchPackIndex,
  parseCatalog,
  resolveCatalogAssetUrl,
} from './registry/catalog.js';
import { CatalogReplica, type CatalogReplicaSnapshot } from './registry/catalog-state.js';
import {
  instantiateFlat as instantiateFlatImpl,
  instantiate as instantiateImpl,
  type PostSpawnHook,
  resolveHandleGuid,
  type SceneInstantiateError,
} from './registry/instantiate.js';
import {
  loadByGuid as loadByGuidImpl,
  parseAndReturnAsset as parseAndReturnAssetImpl,
  parseAssetPayload as parseAssetPayloadImpl,
  registerPackagesFromIndex,
} from './registry/load-by-guid.js';
import { LoadStateStore } from './registry/load-state.js';
import type { ScenePublicationFence } from './registry/scene-publication-fence.js';
import {
  detectTileNeedsRepeatSampler,
  materialShaderTextureFieldNames as materialShaderTextureFieldNamesImpl,
} from './registry/validate-material.js';

// Public re-export surface (pre-w14 consumer face preservation): the extracted
// modules are the new SSOT; asset-registry re-exports them until w14/w15 repoint
// every consumer to the sibling modules / the new package.
export {
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles.js';
export {
  animationClipLoader,
  animationGraphLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from './loaders/inline-pack.js';
export {
  equirectLoader,
  fontLoader,
  PACK_ARTIFACT_LOADERS,
  textureLoader,
} from './loaders/pack-artifact.js';
export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate.js';

// ─── Re-exports for engine-runtime-local consumers ──────────────────────────
//
// Legacy re-exports: `Asset` widens to the 4-variant engine-types union;
// `MeshAsset` keeps the engine-types shape (with `attributes`). Consumers
// that previously imported from `./asset-registry` keep working through
// the type alias re-exports below.

export type { Asset, TypesMeshAsset as MeshAsset };

// D-15: the BUILTIN_* mesh payloads moved to builtin-asset-registry.ts (the
// process-static payload SSOT); the shared runtime vertex layout remains owned
// by @forgeax/engine-geometry.
// imported at the top of this file. The constructor still pre-populates the
// handle->payload map from those imports (the map itself retires in w49).

// feat-20260618-asset-and-pack-name-fields M3 (D-1 / D-3): the mutable runtime
// package object every GUID of the same import path shares. `assetGuids` grows
// as `registerPackage` adds GUIDs; `assetCount` (the engine-types `Package`
// view) is derived from `assetGuids.size`, never stored (#2 Derive). The public
// `packageOf(guid)` projects this to the readonly `Package` interface.
interface MutablePackage {
  path: string;
  readonly assetGuids: Set<string>;
}

// ─── Runtime brand helper ──────────────────────────────────────────────────
//
// AC-11 inspect() `.brand` is a 4-member string literal union mirroring the
// engine-types Asset discriminated union. Map a stored Asset value to its
// brand via the `.kind` discriminator (+ `.shadingModel` refinement for
// `MaterialAsset`, preserved for forward compatibility though the runtime
// brand stays at the asset-kind level per AC-11 spec).
//
// feat-20260514 M3 / w15: the `'InstancedBufferAsset'` brand is retired
// alongside the deleted POD + 3 registry methods; the runtime brand union
// shrinks 5 -> 4 to mirror the Asset closed-union shape.
// feat-20260514 w3: re-extends to 5 with the addition of the `'SceneAsset'`
// brand mirroring the new `'scene'` kind in the Asset discriminated union.
// feat-20260618-asset-and-pack-name-fields M1 / w3: AssetBrand moved to
// @forgeax/engine-types (public, single-entry discoverability per charter F1).
// feat-20260608-tilemap-object-layer-rendering M0: AssetBrand union grows
// 13 -> 14 with `'TilesetAsset'` in @forgeax/engine-types.

// feat-20260622 D-4/D-8: the 14-arm assetBrand switch and ASSET_BRAND Record
// table are both retired (PR #496 eliminated the brand concept entirely).
// New Asset union members no longer need a brand mapping; the closed union
// exhaustive switch in test-d files is the sole type-level guard.

// ─── Schema-driven material parse result (feat-20260523 M4-T01) ──────────
// ─── AssetRegistry class ────────────────────────────────────────────────────

/**
 * Asset registry (instance-per-engine; `engine.assets: AssetRegistry | null`).
 *
 * The builtin meshes (`HANDLE_CUBE` / `HANDLE_TRIANGLE` / ...) are served by
 * the process-static `BuiltinAssetRegistry`, so AI users see usable handles in
 * the very first frame without registration ceremony (charter proposition 1).
 *
 * @example Catalogue a texture by GUID, load its payload, and bind a material:
 * ```ts
 * const guid = engine.assets.parseGuid('00000000-0000-7000-8000-000000000001');
 * engine.assets.catalog(guid, myTexture);                       // GUID -> payload
 * const res = await engine.assets.loadByGuid(guid);             // payload (D-17)
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':  // guid not catalogued
 *   }
 *   return;
 * }
 * const material = world.allocSharedRef('MaterialAsset', {       // mint column handle
 *   kind: 'material',
 *   passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, tags: { LightMode: 'Forward' }, queue: 2000 }],
 *   values: { baseColorTexture: res.value },
 * });
 * world.spawn({ component: MeshRenderer, data: { materials: [material] } });
 * ```
 */

// bug-20260610 Fix B: parsed pack-file body stored in the fetchPackFile
// in-memory cache + in-flight dedup maps (D-4). Only the raw JSON shape is
// cached -- parseAssetPayload still runs per-call to look up the per-GUID
// entry (CON-2 register-before-recurse cycle safety).
export interface ParsedPackFile {
  schemaVersion?: string;
  kind?: string;
  assets: Array<{
    guid: string;
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
    artifacts?: Record<string, import('@forgeax/engine-types').ArtifactDescriptor>;
  }>;
}

export type CatalogReconcileError = AssetError;
export type CatalogReconcileResult = Result<CatalogReplicaSnapshot, CatalogReconcileError>;

function catalogSourceUnconfigured<T>(): Result<T, AssetError> {
  return err(
    new AssetError({
      code: 'catalog-source-unconfigured',
      expected: 'a configured catalog source',
      hint: ASSET_ERROR_HINTS['catalog-source-unconfigured'],
    }),
  );
}

export class AssetRegistry {
  readonly #publicationCandidates = new WeakMap<
    RuntimePackEnvelope,
    {
      readonly assets: ReadonlyMap<string, Asset>;
      readonly pack: RuntimePackEnvelope;
      readonly rows: readonly CatalogEntry[];
      readonly epoch: number;
      readonly source: CatalogReplica | undefined;
      readonly generations: ReadonlyMap<string, number>;
    }
  >();

  /** Prepare in a private scope using this consuming owner's loaders and services. */
  async preparePublication(
    rows: readonly CatalogEntry[],
    fetcher: PackageFetcher,
    external: { readonly catalog: CatalogSource; readonly fetcher: PackageFetcher } | undefined,
    services: PublicationPreparationServices,
  ): Promise<Result<ReadonlyMap<string, Asset | (() => Promise<Asset>)>, unknown>> {
    // Capture before yielding: the caller owns its transport envelope, never our proof.
    const key = services.pack;
    const dependencies = new Map(
      [...(services.dependencies ?? [])].map(([guid, pin]) => [
        guid,
        { ...pin, row: structuredClone(pin.row) },
      ]),
    );
    let owned: { rows: readonly CatalogEntry[]; pack: RuntimePackEnvelope | undefined };
    try {
      owned = {
        rows: structuredClone(rows),
        pack: key === undefined ? undefined : (copyPackData(key) as RuntimePackEnvelope),
      };
    } catch (cause) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: 'isolated lossless publication data',
          hint: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    const source = this.catalogReplica;
    const epoch = this.globalGeneration;
    const generations = new Map(
      [...owned.rows.map((row) => row.guid), ...dependencies.keys()].map((guid) => [
        guid,
        this.generations.get(guid) ?? 0,
      ]),
    );
    const baseline = await this.ensurePackIndexCache();
    if (!baseline.ok) return baseline;
    if (source !== this.catalogReplica || epoch !== this.globalGeneration)
      return err(
        new AssetError({
          code: 'asset-invalidated',
          expected: 'unchanged source during preparation',
          hint: 'retry in the current asset context',
        }),
      );
    const context = makeLoadContext(this, fetcher);
    const result = await preparePublicationPayloads(
      owned.rows,
      fetcher,
      external,
      { ...services, pack: owned.pack, dependencies },
      this.loaders,
      {
        ...context,
        resolveRef: async (guid) =>
          owned.rows.some((row) => row.guid === guid) || dependencies.has(guid)
            ? ok(0)
            : context.resolveRef(guid),
      },
    );
    if (!result.ok) return result;
    if (key && owned.pack)
      this.#publicationCandidates.set(key, {
        assets: result.value,
        pack: owned.pack,
        rows: owned.rows,
        source,
        epoch,
        generations,
      });
    // Public retention reads copy on demand. Neither a Map edit nor a byte write can forge readiness.
    return ok(
      new Map(
        [...result.value].map(([guid, asset]) => [guid, async () => copyPreparedAsset(asset)]),
      ),
    );
  }

  /** Commit only a candidate prepared by this owner; it enters existing load state. */
  commitPreparedPublication(pack: RuntimePackEnvelope, beforeCommit?: () => void): void {
    const candidate = this.#publicationCandidates.get(pack);
    const current = () =>
      candidate !== undefined &&
      candidate.epoch === this.globalGeneration &&
      candidate.source === this.catalogReplica &&
      [...candidate.generations].every(
        ([guid, generation]) => (this.generations.get(guid) ?? 0) === generation,
      );
    if (!candidate || !current())
      throw new TypeError('candidate was not prepared in the current asset context');
    const parsed = parseCatalog(candidate.rows, (url) =>
      resolveCatalogAssetUrl(this, url),
    ).unwrap();
    const prepared = candidate.rows.map((row) => {
      const asset = candidate.assets.get(row.guid);
      const envelope = candidate.pack.assets.find((entry) => entry.guid === row.guid);
      if (!asset || !envelope) throw new TypeError(`missing prepared output ${row.guid}`);
      return { guid: row.guid, asset, refs: envelope.refs };
    });
    // Consume before invoking a provider: synchronous observers cannot commit the same proof twice.
    this.#publicationCandidates.delete(pack);
    beforeCommit?.();
    if (!current()) throw new TypeError('asset context changed during publication commit');
    this.applyCatalogRecords(parsed, new Set(parsed.keys()));
    for (const row of prepared) this.loadState.prepare(row.guid, row.asset, row.refs);
    const metadata: ParsedPackFile = {
      ...candidate.pack,
      assets: candidate.pack.assets.map((asset) => ({
        ...asset,
        payload: asset.payload as Record<string, unknown>,
        refs: [...asset.refs],
        artifacts: asset.artifacts as Record<
          string,
          import('@forgeax/engine-types').ArtifactDescriptor
        >,
      })),
    };
    for (const row of candidate.rows) this.cachePackFile(row.packageUrl, metadata);
  }

  readPluginDefinition(guid: string) {
    const replica = this.catalogReplica;
    const binding = this.runtimeBinding;
    const indexUrl = this.packIndexUrl;
    return readPluginDefinition(
      this,
      guid,
      this.catalogSource?.expectedScope?.scopeId ?? binding?.scopeId,
      () =>
        this.catalogReplica === replica &&
        this.runtimeBinding === binding &&
        this.packIndexUrl === indexUrl,
    );
  }
  private catalogSource: CatalogSource | undefined;
  private assetFetcher: PackageFetcher | undefined;
  readonly fetchAsset: PackageFetcher = (input, init) =>
    (this.assetFetcher ?? globalThis.fetch)(input, init);

  openPackage(packageUrl: string): PackageFetcher {
    return (
      this.catalogSource?.openPackage?.(packageUrl) ??
      this.assetFetcher ??
      globalThis.fetch.bind(globalThis)
    );
  }

  get hasCatalogSource(): boolean {
    return this.catalogSource !== undefined;
  }
  private catalogEnumerating: Promise<Result<readonly CatalogEntry[], AssetError>> | undefined;
  private readonly catalogListeners = new Set<CatalogListener>();
  private catalogSourceDispose: (() => void) | undefined;
  private catalogReplica: CatalogReplica | undefined;
  // feat-20260614 M8 (D-15 / D-17 / D-19): the registry is a GUID -> payload
  // catalogue. It holds NO handle concept -- it cannot mint a column handle
  // (it has no World). `loadByGuid` returns the PAYLOAD; column minting
  // (`world.allocSharedRef`) is the caller's job on the ECS/render side.
  // Sub-asset refs embedded in a payload stay as GUID strings (AssetGuid /
  // dash-form), never minted at load time. Keyed by lowercased GUID string.
  // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
  // extracted `./registry/validate-material` free functions (detectTileNeeds-
  // RepeatSampler) can read it. No underscore + genuinely public is the
  // lint-compliant exposure (D-internal R-internal-C ties `@internal` to `_`).
  readonly assetCatalog: Map<string, AssetEnvelope<Asset>> = new Map();
  private guidIndex = new WeakMap<Asset, string>();
  private guidIndexEpoch = -1;

  /** Owner-injected component catalog used for scene breadcrumb projection. */
  readonly componentCatalog: ReadonlyMap<string, Component>;

  // feat-20260618-asset-and-pack-name-fields M3 (D-1): the package index that
  // backs the two-segment asset identity `<packagePath>.<name>`. `packages`
  // maps a lowercased GUID key to its `MutablePackage` (a shared object every
  // GUID of the same import path points at), or `null` for assets with no
  // package (catalog() inline + builtin, D-5). All three registration entry
  // points (catalog / loadByGuid / builtin) funnel through the single
  // `registerPackage` primitive so the display-name invariant lands once (#1 SSOT).
  private readonly packages: Map<string, MutablePackage | null> = new Map();

  // Secondary index path -> shared MutablePackage so every GUID of the same
  // import path points at one object (the 1->N promotion + assetCount derive
  // depend on this sharing). Not a duplicate of `packages` (#2): `packages` is
  // the per-GUID lookup; this is the per-path dedup used only inside
  // registerPackage to find-or-create the shared object.
  private readonly packageByPath: Map<string, MutablePackage> = new Map();

  // Per-GUID stored display names now live on the asset envelope's `name` field
  // (the single home, replacing the retired storedNameOf side table; D-6).
  // resolveName reads `assetCatalog.get(key)?.name` as the `storedName` argument
  // of deriveAssetName. `pendingNames` bridges the one ordering where a name is
  // known before its envelope exists: the prod disk path registers the package
  // (entry names) during resolveCatalogEntry, then catalogues the body later --
  // catalog() drains the pending name into the new envelope, so nothing persists
  // here once the envelope is in place.
  private readonly pendingNames: Map<string, string> = new Map();

  // ─── Prod pack-index fetch state (M4/w23) ──────────────────────────────
  // When packIndexUrl is configured, loadByGuid fetches pack-index.json on
  // first call, caches the parsed catalog in packIndexCache, then fetches
  // each resource URL resolved against that index and registers the asset.
  packIndexUrl: string | undefined = undefined;
  packIndexCache: Map<string, CatalogRecord> | undefined = undefined;
  /** In-flight accepted catalog projection shared by enumeration and GUID load. */
  private catalogPackIndexSync: Promise<Result<Map<string, CatalogRecord>, AssetError>> | undefined;
  /** A targeted or wholesale invalidation requests one fresh source baseline. */
  private catalogPackIndexNeedsRefresh = false;
  /** Fences a late catalog response after invalidation or authority replacement. */
  private catalogPackIndexEpoch = 0;
  /** Current browser-facing asset realm; absent for inline/shipped legacy use. */
  runtimeBinding: RuntimeAssetBinding | undefined = undefined;

  // tweak-20260609 M1: in-flight Map for recursive loadByGuid dedup + cycle
  // prevention (D-5 / B-10). Maps guidKey → Promise<Result<Handle, ...>> so
  // concurrent calls for the same GUID share the same fetch + register chain,
  // and cycles (A→B→A) terminate when the second visit hits the in-flight
  // entry for A instead of re-entering fetch.
  readonly inFlight: Map<string, Promise<Result<unknown, AssetError | ImageError | RhiError>>> =
    new Map();

  /** One URL owns its retained body and current request independently. */
  readonly packFiles = new Map<
    string,
    {
      value?: ParsedPackFile;
      pending?: Promise<ParsedPackFile>;
    }
  >();

  cachePackFile(url: string, value: ParsedPackFile): void {
    const state = this.packFiles.get(url) ?? {};
    state.value = value;
    this.packFiles.set(url, state);
  }

  /** Only the current request may settle; a failed refresh retains a prior body. */
  settlePackFile(url: string, pending: Promise<ParsedPackFile>, value?: ParsedPackFile): void {
    const state = this.packFiles.get(url);
    if (state?.pending !== pending) return;
    delete state.pending;
    if (value !== undefined) state.value = value;
    if (state.value === undefined) this.packFiles.delete(url);
  }
  readonly artifactCache = new ArtifactReadCache();
  readonly loadState = new LoadStateStore();
  /** Current GUID publication; payload projections retain older handle identities separately. */
  private readonly materialPublications = new Map<
    string,
    {
      catalogRevision: number;
      readiness?: MaterialRuntimeInfo | MaterialLoadError;
      projection?: MaterialRenderProjection;
      readinessCatalogRevision?: number;
    }
  >();
  readonly materialArtifactRegistry = new MaterialArtifactRegistry();
  readonly materialPayloadProjections = new WeakMap<object, MaterialRenderProjection>();
  private assetEvidenceAdapter: RuntimeAssetEvidenceAdapter = createRuntimeAssetEvidenceAdapter();

  // feat-20260621-asset-registry-robustness-invalidate-inflight-cach F17c:
  // per-GUID generation counter incremented on each invalidate(guid) call.
  // loadByGuid captures this value at Promise creation and discards the
  // result (returning asset-invalidated) if the generation has changed by
  // the time the fetch completes.
  // F22: invalidateAll increments a single globalGeneration counter instead,
  // which invalidates every in-flight Promise regardless of GUID.
  readonly generations: Map<string, number> = new Map();
  globalGeneration: number = 0;
  /**
   * Monotonic payload-cache epoch. Render-side derived snapshots use this
   * single stamp to skip re-walking an unchanged material parent chain on
   * every frame; catalog/invalidation mutations advance it conservatively.
   */
  catalogEpoch: number = 0;

  // F20: per-cache Promise queue to serialise packIndexCache write operations
  // in transportOrFail. The "check -> new Map() -> set" three-step block is
  // not atomic across concurrent transportOrFail calls; chaining through a
  // single queue Promise ensures each patch completes before the next starts.
  packIndexCachePatchQueue: Promise<void> = Promise.resolve();

  // feat-20260527-sprite-nineslice M4 / w16 + w18 (D-5 + D-9): per-Renderer
  // EngineMetrics shared with the runtime so register-time soft-warns
  // (`nineslice.tile-needs-repeat-sampler` for sliceMode=1 + sampler not
  // 'repeat') and runtime soft-warns (`nineslice.scale-too-small`) increment
  // the SAME counter map. `createRenderer.ts` calls `assets.setMetrics(metrics)`
  // immediately after constructing the registry; standalone test fixtures
  // that do not go through `createRenderer` may leave this null and the
  // soft-warn paths simply no-op (charter P9 graceful degradation: the
  // structured fail-fast branches still fire; only the metric is dropped).
  // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
  // extracted `./registry/validate-material` free functions (detectTileNeeds-
  // RepeatSampler) can read + increment it. No underscore + genuinely public
  // is the lint-compliant exposure (D-internal R-internal-C ties `@internal`
  // to `_`).
  metrics: EngineMetrics | null = null;

  // feat-20260707 M5 / w33 (D-11): device texture-compression caps the Basis
  // texture / equirect arms feed to `selectTranscodeTarget`. `createRenderer`
  // projects `RhiCaps` -> `TranscodeCaps` and calls `setTranscodeCaps` right
  // after construction (D-8 one-line projection). A standalone registry (test /
  // headless) keeps the all-false default, which drives the uncompressed
  // fallback path (section 8 P3, AC-04) rather than a hard failure.
  transcodeCaps: TranscodeCaps = { bc: false, etc2: false, astc: false };

  // feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip M1 (D-1):
  // origin reverse-index: a payload object -> its catalog GUID, for payloads
  // that are NOT the current catalog identity. WeakMap so entries auto-GC when
  // the world despawns and the object is no longer held by sharedRefs.
  // _guidForAsset consults it after the catalog identity scan MISSes.
  // SSOT for the "payload-to-GUID provenance" fact (architecture-principles #1).
  //
  // Two writers populate it:
  //   1. instantiate (registry/instantiate.ts): the resolved SceneAsset copy ->
  //      its original catalog GUID (the deep-copied envelope is never the catalog
  //      identity).
  //   2. feat-20260713 M4 / w15 (D-6, root cause a): catalog() records the
  //      SUPERSEDED payload here when re-cataloguing a GUID with a fresh object.
  //      A handle minted before the override still points at the old object; this
  //      keeps that object reverse-lookupable so save/collect resolves its GUID
  //      instead of failing with a GUID-unresolved error (the 2026-07-06 crash).
  //
  // Key type is `object` (not `SceneAsset`) because both material and scene
  // payloads are recorded (material payloads flow through writer 2).
  /** @internal */
  _originIndex: WeakMap<object, string> = new WeakMap();

  /**
   * Construct a fresh registry pre-populated with the builtin cube + triangle
   * mesh handles (`HANDLE_CUBE` / `HANDLE_TRIANGLE`).
   *
   * feat-20260514 M3 / w15: the previous optional `RhiDevice` constructor
   * argument (consumed by the now-deleted `createInstancedBuffer` triplet)
   * is removed; the registry surface is engine-agnostic again. Per-entity
   * instance transforms now live inside the ECS `Instances { transforms:
   * 'array<f32>' }` component; the RenderSystem record stage owns GPU
   * storage buffer allocation + cap-gate.
   */
  // feat-20260603-asset-import-loader-injection M1 / w5 (D-7): the registry
  // dispatches `parseAssetPayload` / the texture+font upstream branches through
  // this `LoaderRegistry`. feat-20260623 M3 / w9: the loader registry is now
  // internally built by `createDefaultLoaderRegistry()` (public readonly field)
  // so host apps can reach `engine.assets.loaders.register(...)` without a
  // constructor-injection slot or a phantom passthrough wrapper.
  // The loader set is wired at construction from the complete ordinary Asset
  // vocabulary (including video and audio) plus caller-supplied extensions.
  // Assigned here so the optional loaders cannot appear after a load begins.
  readonly loaders: LoaderRegistry;

  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 / AC-22):
  // the optional `ImportTransport` is the *only* difference between the studio
  // form (transport injected, dev DDC miss triggers lazy import) and the shipped
  // form (transport absent, DDC miss fails fast with `asset-not-imported`).
  // The load path AFTER a successful DDC fetch is identical in both forms --
  // zero branching on transport (AC-23 key invariant). Set at construction (no
  // setter, no illegal intermediate state), same D-7 stance as LoaderRegistry.
  readonly importTransport: ImportTransport | undefined;

  // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): optional post-spawn
  // hook invoked by `instantiate` after the scene subtree spawns. The shipped
  // implementation is runtime's `postSpawnResolveJoints` (auto-wire Skin.joints),
  // injected at the sole production assembly point (createRenderer, w10). When
  // absent (standalone / test registries), instantiate skips joint wiring
  // silently. Public so the extracted `./registry/instantiate` free function can
  // read it (D-internal R-internal-C ties `@internal` to a `_` prefix;
  // genuinely-public is the lint-compliant exposure).
  readonly postSpawnHook: PostSpawnHook | undefined;

  /** @internal Stored for M2 validation; TS suppressor reference */
  constructor(
    // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
    // extracted `./registry/validate-material` free functions can read it. No
    // underscore + genuinely public is the lint-compliant exposure (an
    // `@internal` tag would require a `_` prefix per D-internal R-internal-C).
    readonly shaderRegistry: ShaderRegistry,
    importTransport?: ImportTransport | undefined,
    // Caller-supplied loaders extend the ordinary default set. Duplicate kinds
    // are rejected by LoaderRegistry so no consumer can observe replacement
    // order as an accidental ownership rule.
    extraLoaders?: readonly Loader[] | undefined,
    // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): optional
    // post-spawn hook; createRenderer injects `postSpawnResolveJoints`.
    postSpawnHook?: PostSpawnHook | undefined,
    runtimeBinding?: RuntimeAssetBinding | undefined,
    componentCatalog: ReadonlyMap<string, Component> = new Map(),
  ) {
    void this.shaderRegistry;
    this.importTransport = importTransport;
    this.postSpawnHook = postSpawnHook;
    this.runtimeBinding = runtimeBinding;
    this.componentCatalog = componentCatalog;
    this.loaders = createDefaultLoaderRegistry(extraLoaders);
    this.registerBuiltins();
  }

  /**
   * Restore the engine-owned GUID catalogue after a runtime-realm transition.
   *
   * Builtin meshes are process-static engine assets, not game-owned catalog
   * rows. A realm transition clears the user catalog and load caches, but must
   * leave these assets addressable so a scene in the newly bound game can keep
   * resolving its builtin mesh references.
   */
  private registerBuiltins(): void {
    // feat-20260614 M8 (D-15): builtins are GUID-addressable catalogue rows.
    // The builtin payloads also live process-static in BuiltinAssetRegistry
    // (slot < BUILTIN_BASE) for handle-tier resolution; here they are
    // catalogued by GUID so loadByGuid(builtinGuid) returns the payload and
    // scene refs[] pointing at a builtin GUID resolve without a hand-
    // maintained table (docs/feedbacks/2026-06-03 §6.2 Tier 0).
    const builtinByHandle = new Map<number, Asset>([
      [handleSlot(HANDLE_CUBE), BUILTIN_CUBE],
      [handleSlot(HANDLE_TRIANGLE), BUILTIN_TRIANGLE],
      [handleSlot(HANDLE_QUAD), BUILTIN_QUAD],
      [handleSlot(HANDLE_SPHERE), BUILTIN_SPHERE],
      [handleSlot(HANDLE_NINESLICE_QUAD), BUILTIN_NINESLICE_QUAD],
      [handleSlot(HANDLE_CYLINDER), BUILTIN_CYLINDER],
    ]);
    for (const [handle, guidStr] of BUILTIN_MESH_GUIDS) {
      const parsed = AssetGuid.parse(guidStr);
      if (!parsed.ok) {
        throw new Error(`[asset-registry] builtin GUID ${guidStr} is not a valid UUID`);
      }
      const payload = builtinByHandle.get(handleSlot(handle));
      if (payload !== undefined)
        this.assetCatalog.set(guidStr.toLowerCase(), {
          guid: guidStr,
          kind: payload.kind,
          payload,
          refs: [],
        });
      if (payload !== undefined) this.loadState.registerReady(guidStr, payload);
    }
    // D-5: builtin meshes have no import path and no source name -- register
    // them with a null package so resolveName returns '' (the detectable
    // "genuinely no name" signal). They are deliberately NOT given a synthetic
    // package + derived name (memory builtin-guid-preregister-collides).
    this._registerPackage(
      null,
      BUILTIN_MESH_GUIDS.map(([, guidStr]) => guidStr),
    );
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w16 prep + w18 (D-5 + D-9): inject the
   * per-Renderer `EngineMetrics` so register-time soft-warns can bump the same
   * counter map the runtime reads through `renderer.metrics.snapshot()`. Called
   * by `createRenderer` after constructing both the registry and the metrics
   * instance; safe to skip in standalone tests (the soft-warn arms simply do
   * not record).
   */
  setMetrics(metrics: EngineMetrics): void {
    this.metrics = metrics;
  }

  /**
   * feat-20260707 M5 / w33 (D-11): wire the device compression caps used by the
   * Basis texture / equirect transcode arms. `createRenderer` calls this right
   * after construction with `RhiCaps` projected to `TranscodeCaps` (D-8). Left
   * at the all-false default, the loaders transcode to the uncompressed
   * `rgba8unorm` / `rgba16float` fallback (AC-04, section 8 P3).
   */
  setTranscodeCaps(caps: TranscodeCaps): void {
    this.transcodeCaps = caps;
  }

  /**
   * Inject authoritative runtime evidence without importing CLI or Node policy.
   * `inspect(guid)` and `verifyByGuid(guid)` return the shared state model; an
   * omitted capability remains an explicit structured error, never a pass.
   */
  configureAssetEvidence(source: RuntimeEvidenceSource): void {
    this.assetEvidenceAdapter = createRuntimeAssetEvidenceAdapter(source);
  }

  /**
   * @internal — read the metrics handle for register-time soft-warn paths.
   * Returns `null` when no `createRenderer` wired the registry to a renderer
   * (the standalone-test path; the structured fail-fast branches still fire).
   */
  _getMetrics(): EngineMetrics | null {
    return this.metrics;
  }

  /**
   * @internal — reverse-lookup: find the GUID key for a catalogued asset
   * payload by identity comparison (===). Returns the GUID string if found,
   * `undefined` otherwise. Rebuild the derived identity index only when the
   * catalog changes; rendering and scene collection share constant-time reads.
   * The first current identity wins over historical provenance.
   */
  _guidForAsset(asset: Asset): string | undefined {
    if (this.guidIndexEpoch !== this.catalogEpoch) {
      this.guidIndex = new WeakMap();
      for (const [key, envelope] of this.assetCatalog) {
        if (!this.guidIndex.has(envelope.payload)) this.guidIndex.set(envelope.payload, key);
      }
      this.guidIndexEpoch = this.catalogEpoch;
    }
    // feat-20260703 M1 (D-1): fallback to the origin reverse-index. Covers two
    // MISS cases the catalog identity scan cannot: (1) _resolveSceneGuids deep
    // copies — the copy is never the catalogued original; (2) feat-20260713 M4
    // (D-6): a payload superseded by a catalog override, still live behind a
    // handle minted before the override.
    return this.guidIndex.get(asset) ?? this._originIndex.get(asset);
  }

  /** Public identity projection consumed by scene collection boundaries. */
  guidOf(asset: Asset): string | undefined {
    return this._guidForAsset(asset);
  }

  /** Read one accepted Catalog source key without fetching or enumerating assets. */
  sourceKeyOf(guid: string): string | undefined {
    return this.packIndexCache?.get(guid.toLowerCase())?.sourceKey;
  }

  /** Current readiness facts without program bytes; complete owned reads use loadMaterialReadyByGuid. */
  getMaterialReadiness(guid: string): MaterialRuntimeInfo | MaterialLoadError | undefined {
    return this.materialPublications.get(guid.toLowerCase())?.readiness;
  }

  /** Return the current cooked render projection for one material GUID. */
  getMaterialProjection(guid: string): MaterialRenderProjection | undefined {
    return this.materialPublications.get(guid.toLowerCase())?.projection;
  }

  /** Resolve the program owner through the same parent catalogue as the root contract. */
  getMaterialProjectionForPayload(material: MaterialAsset): MaterialRenderProjection | undefined {
    const visited = new Set<MaterialAsset>();
    let current: MaterialAsset = material;
    while (!visited.has(current)) {
      visited.add(current);
      const projection = this.materialPayloadProjections.get(current);
      assertMaterialStaticSelection(
        current.staticSwitches,
        projection,
        this._guidForAsset(current),
      );
      if (projection !== undefined) return projection;
      if (current.parent === undefined) return undefined;
      const parent = this.lookup(current.parent);
      if (parent?.kind !== 'material') return undefined;
      current = parent;
    }
    return undefined;
  }

  /** Return one immutable cooked artifact by specialization key. */
  getMaterialArtifact(specializationKey: string) {
    return this.materialArtifactRegistry.get(specializationKey);
  }

  private materialPublication(key: string) {
    let publication = this.materialPublications.get(key);
    if (publication === undefined) {
      publication = { catalogRevision: 0 };
      this.materialPublications.set(key, publication);
    }
    return publication;
  }

  /** Record the canonical result produced by the production material loader. */
  recordMaterialReadiness(guid: string, readiness: MaterialReady | MaterialLoadError): void {
    const key = guid.toLowerCase();
    if (readiness.status !== 'Ready') {
      const publication = this.materialPublication(key);
      publication.readiness = readiness;
      delete publication.projection;
      return;
    }
    const projection = installMaterialReadyShaders(
      this.shaderRegistry,
      readiness,
      this.materialArtifactRegistry,
    );
    const publication = this.materialPublication(key);
    // Programs already belong to the immutable artifact registry. Keep the
    // existing inspection projection here, never a byte copy per material.
    // The full loader result remains caller-owned and independently writable.
    publication.readiness = freezePackValue(structuredClone(inspectReady(readiness)));
    publication.projection = projection;
    const { catalogRevision, readinessCatalogRevision: previousRevision } = publication;
    if (previousRevision === undefined || previousRevision !== catalogRevision) {
      const currentPayload = this.assetCatalog.get(key)?.payload;
      if (currentPayload?.kind === 'material') {
        this.materialPayloadProjections.set(currentPayload, projection);
      }
    }
    publication.readinessCatalogRevision = catalogRevision;
  }

  /**
   * Configure a catalog URL for `loadByGuid`.
   *
   * Call this once during engine initialization with the URL where
   * `pack-index.json` is served (emitted by `@forgeax/engine-vite-plugin-pack`
   * during `vite build`). In a Vite dev host, use `configureRuntimeBinding`
   * instead so the catalog remains bound to its scope and generation. Once a
   * runtime binding exists, selecting a production catalog URL retains that
   * identity fence, including when the URL is made absolute by the host. The
   * index is also the canonical base URL for every
   * catalog entry: relative, root-relative, and absolute entry URLs are resolved
   * against it before the registry fetches a pack body. After configuration,
   * `loadByGuid` will fetch the catalog on its first invocation and cache it for
   * subsequent calls.
   *
   * @example
   * ```ts
   * engine.assets.configurePackIndex('/pack-index.json');
   * const payloadRes = await engine.assets.loadByGuid(guid); // payload, not a handle (D-17)
   * ```
   */
  configurePackIndex(url: string): void {
    this.catalogPackIndexEpoch++;
    this.packIndexUrl = url;
    this.packIndexCache = undefined; // reset cache if URL changes
    this.catalogPackIndexSync = undefined;
    this.catalogPackIndexNeedsRefresh = false;
  }

  private catalogSourceOwnsPackIndex(): boolean {
    return (
      this.catalogSource !== undefined &&
      (this.assetFetcher !== undefined ||
        (this.catalogSource.url === undefined && this.catalogSource.openPackage !== undefined) ||
        this.packIndexUrl === undefined ||
        (this.catalogSource.url !== undefined && this.catalogSource.url === this.packIndexUrl))
    );
  }

  /**
   * A cache loaded through the unscoped pack-index path cannot prove a later
   * source's producer admission constraints. Constrained sources must run
   * their own enumerate validation before the replica becomes authoritative.
   */
  private catalogSourceCanReusePackIndex(): boolean {
    return (
      this.catalogSource?.expectedRevision === undefined &&
      this.catalogSource?.expectedScope === undefined
    );
  }

  private acceptCatalogEntries(
    entries: readonly CatalogEntry[],
    invalidatedGuids: readonly string[] = [],
  ): Result<Map<string, CatalogRecord>, AssetError> {
    const parsed = parseCatalog(entries, (packageUrl) => resolveCatalogAssetUrl(this, packageUrl));
    if (!parsed.ok) return parsed;
    this.acceptPackIndex(parsed.value, invalidatedGuids);
    return parsed;
  }

  private acceptPackIndex(
    next: Map<string, CatalogRecord>,
    invalidatedGuids: readonly string[] = [],
  ): void {
    // A fresh baseline can contain changes whose deltas never arrived. Retire
    // their payloads while the old rows still locate the cached package bytes.
    // Unchanged rows retain their loaded identity and in-flight requests.
    const invalidated = new Set(invalidatedGuids);
    for (const [guid, previous] of this.packIndexCache ?? []) {
      if (JSON.stringify(previous) !== JSON.stringify(next.get(guid))) invalidated.add(guid);
    }
    for (const guid of invalidated) this.invalidate(guid);
    this.packIndexCache = next;
    registerPackagesFromIndex(this, next);
    this.catalogPackIndexNeedsRefresh = false;
  }

  /** Consume accepted changes without rebuilding unrelated package rows. */
  private acceptCatalogDelta(delta: CatalogDelta): Result<void, AssetError> {
    if (this.packIndexCache === undefined || this.catalogReplica === undefined)
      return ok(undefined);
    const keys = new Set(
      [
        ...delta.added.map((row) => row.guid),
        ...delta.changed.map((row) => row.guid),
        ...delta.removed,
      ].map((guid) => guid.toLowerCase()),
    );
    // The replica may still be buffering a source notification during reconciliation.
    // Its accepted rows, rather than the incoming event, are the authority.
    const entries = [...keys].flatMap((guid) => {
      const row = this.catalogReplica?.get(guid);
      return row === undefined ? [] : [row];
    });
    const parsed = parseCatalog(entries, (url) => resolveCatalogAssetUrl(this, url));
    if (!parsed.ok) return parsed;
    this.applyCatalogRecords(parsed.value, keys);
    return ok(undefined);
  }

  private applyCatalogRecords(
    nextRecords: ReadonlyMap<string, CatalogRecord>,
    keys: ReadonlySet<string>,
  ): void {
    this.packIndexCache ??= new Map();
    const changed = new Map<string, CatalogRecord>();
    const retained = new Map<string, CatalogRecord>();
    for (const guid of keys) {
      if (JSON.stringify(this.packIndexCache.get(guid)) === JSON.stringify(nextRecords.get(guid)))
        continue;
      for (const affected of this.loadState.affected(guid)) {
        const row = this.packIndexCache.get(affected);
        if (!keys.has(affected) && row) retained.set(affected, row);
      }
    }
    for (const guid of keys) {
      const previous = this.packIndexCache.get(guid);
      const next = nextRecords.get(guid);
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      if (previous !== undefined) this.invalidate(guid);
      const pkg = this.packages.get(guid);
      if (pkg) {
        pkg.assetGuids.delete(guid);
        if (pkg.assetGuids.size === 0) this.packageByPath.delete(pkg.path);
      }
      this.packages.delete(guid);
      this.pendingNames.delete(guid);
      if (next !== undefined) {
        this.packIndexCache.set(guid, next);
        changed.set(guid, next);
      }
    }
    for (const [guid, row] of retained) this.packIndexCache.set(guid, row);
    registerPackagesFromIndex(this, changed);
    this.catalogPackIndexNeedsRefresh = false;
  }

  /**
   * Resolve the one accepted pack-index projection for this registry.
   *
   * URL-backed CatalogSource and `configurePackIndex` are joined only when
   * their explicit URL authorities are identical. Their CatalogReplica start
   * or reconcile promise is then shared by enumeration and GUID loading, so a
   * running instance accepts one baseline payload instead of fetching the same
   * URL through two independent paths. Deliberately different sources retain
   * the legacy fetch path and per-instance caches.
   */
  async ensurePackIndexCache(
    force = false,
  ): Promise<Result<Map<string, CatalogRecord>, AssetError>> {
    if (
      !force &&
      this.packIndexCache !== undefined &&
      !this.catalogPackIndexNeedsRefresh &&
      (!this.catalogSourceOwnsPackIndex() || this.catalogSourceCanReusePackIndex())
    ) {
      return ok(this.packIndexCache);
    }

    if (this.catalogSourceOwnsPackIndex() && this.catalogReplica !== undefined) {
      const existing = this.catalogPackIndexSync;
      if (existing !== undefined) {
        if (!force) return existing;
        this.catalogPackIndexNeedsRefresh = true;
        return existing.then(() => this.ensurePackIndexCache(true));
      }

      const replica = this.catalogReplica;
      const epoch = this.catalogPackIndexEpoch;
      const read =
        force || this.catalogPackIndexNeedsRefresh ? replica.reconcile() : replica.start();
      const promise = read.then((result) => {
        if (!result.ok) return result;
        if (epoch !== this.catalogPackIndexEpoch) {
          this.catalogPackIndexNeedsRefresh = true;
          return err(
            new AssetError({
              code: 'asset-invalidated',
              expected: 'the active catalog epoch to remain current',
              hint: 'retry the load against the current runtime binding',
            }),
          );
        }
        if (this.catalogReplica !== replica || !this.catalogSourceOwnsPackIndex()) {
          return err(
            new AssetError({
              code: 'asset-invalidated',
              expected: 'the active catalog source to remain installed',
              hint: 'retry the load against the current runtime binding',
            }),
          );
        }
        // A delta can land after the baseline resolves but before this
        // continuation. Project the replica's current accepted snapshot.
        return this.acceptCatalogEntries(replica.snapshot().entries);
      });
      this.catalogPackIndexSync = promise;
      void promise.then(() => {
        if (this.catalogPackIndexSync === promise) this.catalogPackIndexSync = undefined;
      });
      return promise;
    }

    const existing = this.catalogPackIndexSync;
    if (existing !== undefined) {
      if (!force) return existing;
      this.catalogPackIndexNeedsRefresh = true;
      return existing.then(() => this.ensurePackIndexCache(true));
    }

    const epoch = this.catalogPackIndexEpoch;
    const promise = fetchPackIndex(this).then((result) => {
      if (!result.ok) return result;
      if (epoch !== this.catalogPackIndexEpoch) {
        return err(
          new AssetError({
            code: 'asset-invalidated',
            expected: 'the active catalog epoch to remain current',
            hint: 'retry the load against the current runtime binding',
          }),
        );
      }
      this.acceptPackIndex(result.value);
      return result;
    });
    this.catalogPackIndexSync = promise;
    void promise.then(() => {
      if (this.catalogPackIndexSync === promise) this.catalogPackIndexSync = undefined;
    });
    return promise;
  }

  /**
   * Atomically replace the browser-side asset realm. The binding owns the
   * catalog URL and generation; no cache from the previous game survives the
   * transition.
   */
  configureRuntimeBinding(binding: RuntimeAssetBinding): void {
    this.clearCatalogSource();
    this.runtimeBinding = binding;
    this.configurePackIndex(binding.catalogUrl);
    this.invalidateAll();
    this.registerBuiltins();
  }

  /**
   * feat-20260621 F17c: invalidate a single cached asset by GUID so the next
   * `loadByGuid` performs a genuinely fresh fetch. Clears, for this GUID only:
   * the catalogue entry, the in-flight dedup entry, the cached pack-file body
   * (keyed by the index entry's packageUrl), and the pack-index entry. Then
   * increments the per-GUID generation counter so any still in-flight Promise
   * for this GUID discards its result (returns `asset-invalidated`). The body +
   * index clears are targeted (other GUIDs' cached bodies and index entries
   * survive); deleting the index entry forces `resolveCatalogEntry` to re-fetch
   * the pack-index on the next load, re-resolving the packageUrl whose body
   * cache was just dropped. No-op when the GUID is not catalogued.
   *
   * Does NOT touch `packages` (a re-load's registerPackage overwrites them; D-8)
   * and does NOT trigger GPU resource release (OOS-1,
   * q1 boundary: the asset is CPU-only; GPU resources follow the ECS).
   *
   * @param guid - Case-insensitive GUID string or AssetGuid.
   */
  invalidate(guid: string): void {
    for (const key of this.loadState.affected(guid)) this.invalidateOne(key);
  }

  private invalidateOne(guid: string): void {
    const guidKey = guid.toLowerCase();
    this.artifactCache.clearPrefix(`${guidKey}\0`);
    // D-6: the stored name lives on the envelope; preserve it across the delete
    // (the `packages` mapping survives, so resolveName must still see the name
    // until a re-load's registerPackage overwrites it) by parking it on
    // pendingNames -- the next catalog() of this GUID drains it back.
    const survivingEnvelope = this.assetCatalog.get(guidKey);
    const survivingName = survivingEnvelope?.name;
    if (survivingName !== undefined) this.pendingNames.set(guidKey, survivingName);
    if (survivingEnvelope !== undefined) this._originIndex.set(survivingEnvelope.payload, guidKey);
    this.assetCatalog.delete(guidKey);
    this.loadState.remove(guidKey);
    const material = this.materialPublications.get(guidKey);
    if (material !== undefined) {
      delete material.readiness;
      delete material.projection;
      delete material.readinessCatalogRevision;
    }
    // R-1 hard fix (research-decisions.md): delete inFlight entry so the
    // next loadByGuid does not hit the old Promise whose generation no
    // longer matches (AC-04 requires a fresh fetch, not asset-invalidated).
    this.inFlight.delete(guidKey);
    // Round-2 M-A: widen the clear so a COMPLETED reload re-fetches fresh
    // bytes instead of serving the stale cached body. Ordering is load-bearing:
    // read packageUrl from the index entry FIRST, then delete the body, then
    // delete the index entry. Targeted delete (not wholesale undefined) keeps
    // other GUIDs' cached bodies/index entries intact (per-GUID precision).
    const entry = this.packIndexCache?.get(guidKey);
    if (entry !== undefined) {
      this.packFiles.delete(entry.packageUrl);
    }
    this.packIndexCache?.delete(guidKey);
    this.catalogPackIndexEpoch++;
    if (this.catalogSourceOwnsPackIndex()) this.catalogPackIndexNeedsRefresh = true;
    this.generations.set(guidKey, (this.generations.get(guidKey) ?? 0) + 1);
    this.catalogEpoch++;
  }

  /**
   * Adopt freshly loaded Mesh material slots into an object that is already
   * pinned by live World shared refs. Geometry and GPU-backed fields deliberately
   * remain untouched: this primitive is only for a default-material source
   * override, never a general Mesh reimport. This is the atomic cutover: Catalog,
   * Ready load state, and payload-to-GUID provenance must all name the same
   * object after the call. Call only after invalidate(guid) + loadByGuid(guid)
   * has completed successfully.
   */
  adoptReloadedMeshMaterialSlots(guid: string, livePayload: Asset): Result<Asset, AssetError> {
    const key = guid.toLowerCase();
    const envelope = this.assetCatalog.get(key);
    const freshPayload = this.loadState.getReady<Asset>(key);
    if (envelope === undefined || freshPayload === undefined || envelope.payload !== freshPayload) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${key} to have one freshly loaded Ready payload`,
          hint: 'complete invalidate + loadByGuid before adopting a live Mesh identity',
        }),
      );
    }
    if (livePayload.kind !== 'mesh' || freshPayload.kind !== 'mesh') {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `GUID ${key} live and fresh payloads to both be MeshAsset`,
          hint: 'use Mesh identity adoption only for a recooked MeshAsset',
        }),
      );
    }
    if (this._guidForAsset(livePayload) !== key) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `live Mesh payload to retain GUID provenance for ${key}`,
          hint: 'capture the catalogued live payload before invalidating and reloading the same GUID',
        }),
      );
    }
    if (livePayload === freshPayload) return ok(livePayload);

    (livePayload as unknown as { materialSlots: TypesMeshAsset['materialSlots'] }).materialSlots =
      freshPayload.materialSlots;
    this._originIndex.set(freshPayload as object, key);
    this.assetCatalog.set(key, { ...envelope, payload: livePayload });
    this.loadState.registerReady(key, livePayload);
    this.catalogEpoch++;
    return ok(livePayload);
  }

  /** Release completed raw artifact reads without invalidating publications or active loads. */
  releaseReadCaches(): number {
    // Pack bodies also retain adopted publication metadata and deferred plugin
    // definitions. Their lifetime cannot be inferred from a completed file read.
    return this.artifactCache.releaseCompleted();
  }

  /**
   * feat-20260621 F17c: invalidate ALL cached assets so the next `loadByGuid`
   * re-fetches both the pack-index and the asset body. Clears assetCatalog,
   * inFlight, and packFiles (wholesale), and resets packIndexCache to
   * `undefined` (NOT `.clear()` -- an empty Map would short-circuit
   * `resolveCatalogEntry`'s `=== undefined` re-fetch guard and serve
   * asset-not-imported for every later load; undefined forces a fresh
   * fetchPackIndex). Then increments a single globalGeneration counter so every
   * in-flight Promise (regardless of GUID) discards its result. Returns the
   * number of assets that were catalogued before the call.
   *
   * Idempotent: second call on an already-empty catalogue returns clearedCount 0
   * (AC-06). Does NOT trigger GPU resource release (OOS-1).
   */
  invalidateAll(): { clearedCount: number } {
    const count = this.assetCatalog.size;
    this.artifactCache.clear();
    this.assetCatalog.clear();
    this.loadState.clear();
    this.materialPublications.clear();
    this.inFlight.clear();
    this.globalGeneration++;
    // Round-2 M-A: wholesale clear of the shared body cache, and reset the
    // index cache to UNDEFINED (R2-1) -- NOT .clear(). packFiles uses
    // .clear() because fetchPackFile checks `.get(packageUrl)` per URL, so an
    // empty Map correctly misses and re-fetches. packIndexCache uses =undefined
    // because resolveCatalogEntry's re-fetch guard tests `=== undefined`; an
    // empty Map would short-circuit it and serve asset-not-imported for every
    // later load -- the exact F17b pollution this feat fixes. The asymmetry is
    // intentional; do not normalise the two operations.
    this.packFiles.clear();
    this.packIndexCache = undefined;
    this.catalogPackIndexEpoch++;
    if (this.catalogSourceOwnsPackIndex()) this.catalogPackIndexNeedsRefresh = true;
    this.catalogEpoch++;
    return { clearedCount: count };
  }

  /**
   * Force a re-fetch of the configured pack-index NOW and repopulate the cache,
   * so a synchronous `listCatalog()` immediately reflects assets added on disk
   * since boot (a freshly imported GLB's sub-assets). `loadByGuid`'s lazy
   * re-fetch only fires on a per-GUID miss and `invalidateAll()` merely clears
   * the cache (leaving `listCatalog()` empty until the next load), so neither
   * makes a Content Browser or `loadByGuid`-driven "Add to Scene" see a new
   * asset without a page reload. This does.
   *
   * No-op (returns false) when no pack-index URL is configured (dev inline
   * catalogue path) or the fetch fails — callers keep the stale cache rather
   * than blanking it. Returns true when the cache was repopulated.
   */
  async refreshCatalog(): Promise<boolean> {
    if (this.packIndexUrl === undefined && !this.hasCatalogSource) return false;
    const result = await this.ensurePackIndexCache(true);
    return result.ok;
  }

  /** Read the exact source version; it never grants Ready state or bypasses domain checks. */

  setCatalogSource(source: CatalogSource, fetcher?: PackageFetcher): void {
    this.clearCatalogSource();
    this.catalogSource = source;
    this.assetFetcher = fetcher;
    this.catalogReplica = new CatalogReplica(source);
    this.catalogSourceDispose = this.catalogReplica.subscribe((delta) => {
      if (this.catalogSourceOwnsPackIndex() && delta.authority !== 'degraded') {
        const accepted = this.acceptCatalogDelta(delta);
        if (!accepted.ok) {
          delta = {
            added: [],
            changed: [],
            removed: [],
            authority: 'degraded',
            diagnostics: [
              {
                code: accepted.error.code,
                severity: 'blocking',
                expected: accepted.error.expected,
                hint: accepted.error.hint,
                authority: 'catalog',
              },
            ],
          };
        }
      }
      for (const listener of [...this.catalogListeners]) {
        try {
          listener(delta);
        } catch {
          // One host listener cannot prevent the remaining listeners from seeing a fact.
        }
      }
    });
    if (this.catalogSourceOwnsPackIndex()) {
      if (
        (this.packIndexCache !== undefined &&
          (fetcher !== undefined || source.url === undefined)) ||
        !this.catalogSourceCanReusePackIndex()
      )
        this.catalogPackIndexNeedsRefresh = true;
      const cachedEntries =
        this.packIndexCache !== undefined &&
        !this.catalogPackIndexNeedsRefresh &&
        this.catalogSourceCanReusePackIndex()
          ? [...this.packIndexCache].map(([guid, record]) => ({ guid, ...record }) as CatalogEntry)
          : undefined;
      if (cachedEntries !== undefined) this.catalogReplica.seed(cachedEntries);
      void this.ensurePackIndexCache();
    } else {
      void this.catalogReplica.start();
    }
  }

  /** Stop the catalog transport and remove its replica without clearing payload caches. */
  clearCatalogSource(): void {
    this.catalogPackIndexEpoch++;
    this.catalogReplica?.dispose();
    this.catalogSourceDispose?.();
    this.catalogSourceDispose = undefined;
    this.catalogSource = undefined;
    this.assetFetcher = undefined;
    this.catalogReplica = undefined;
    this.catalogEnumerating = undefined;
    this.catalogPackIndexSync = undefined;
  }

  enumerateCatalog(): Promise<Result<readonly CatalogEntry[], AssetError>> {
    if (this.catalogEnumerating !== undefined) return this.catalogEnumerating;
    if (this.catalogSource === undefined || this.catalogReplica === undefined) {
      return Promise.resolve(catalogSourceUnconfigured());
    }
    const replica = this.catalogReplica;
    const pending =
      this.packIndexUrl !== undefined && this.catalogSource.url === this.packIndexUrl
        ? this.ensurePackIndexCache()
        : replica.start();
    const promise = pending.then((result): Result<readonly CatalogEntry[], AssetError> => {
      if (replica !== this.catalogReplica)
        return err(
          new AssetError({
            code: 'asset-invalidated',
            expected: 'the same Catalog source while enumerating assets',
            hint: 'enumerate the current source after the host transition',
          }),
        );
      // start() joins the initial baseline. Later calls must observe the live replica.
      return result.ok ? ok(replica.snapshot().entries) : result;
    });
    this.catalogEnumerating = promise;
    void promise.then(() => {
      if (this.catalogEnumerating === promise) this.catalogEnumerating = undefined;
    });
    return promise;
  }

  /** Read the immutable catalog projection folded by this registry. */
  catalogSnapshot(): CatalogReplicaSnapshot | undefined {
    return this.catalogReplica?.snapshot();
  }

  /** Explicitly recover the registry's single catalog replica from its configured source. */
  reconcileCatalog(): Promise<CatalogReconcileResult> {
    if (this.catalogSource === undefined || this.catalogReplica === undefined) {
      return Promise.resolve(catalogSourceUnconfigured());
    }
    if (this.catalogSourceOwnsPackIndex()) {
      return this.ensurePackIndexCache(true).then((result) => {
        if (!result.ok) return result;
        return ok(
          this.catalogReplica?.snapshot() ?? {
            version: 0,
            entries: [],
            stale: false,
            diagnostics: [],
          },
        );
      });
    }
    return this.catalogReplica.reconcile();
  }

  subscribeCatalog(listener: CatalogListener): () => void {
    this.catalogListeners.add(listener);
    return () => {
      this.catalogListeners.delete(listener);
    };
  }

  /**
   * Materialise a `SceneAsset` into an existing `World` and return the
   * synthetic root `Entity` (feat-20260514 w31 sugar wrapper; AC-03 +
   * requirements §IN-3; M3: returns Entity not SceneInstanceId).
   *
   * Before spawning, handle-type component fields (e.g. `assetHandle`,
   * `material`, `skeleton`) containing GUID strings are resolved to fresh
   * user-tier `Handle` numbers via `world.allocSharedRef` (feat-20260614 M8
   * D-19 instantiate-time GUID->handle mint; supersedes the pre-D-17
   * `resolveGuid` map). GUIDs that fail to parse or are not catalogued return
   * `AssetError(code='asset-not-found')` with a hint containing the GUID,
   * node localId, and field name.
   *
   * Errors propagate verbatim through the closed
   * `AssetError | PackError | EcsError` union so AI users that already
   * narrow `loadByGuid<SceneAsset>` results reuse the same `switch
   * (err.code)` exhaustively (charter proposition 3 machine-readable
   * union; plan-strategy §3.3 closed-union transparency).
   *
   * @example
   * ```ts
   * const sceneRes = await engine.assets.loadByGuid<SceneAsset>(roomGuid); // payload (D-17)
   * if (!sceneRes.ok) return;
   * const handle = world.allocSharedRef('SceneAsset', sceneRes.value);     // mint column handle
   * const r = engine.assets.instantiate(handle, world);
   * if (!r.ok) {
   *   switch (r.error.code) {
   *     case 'asset-not-found':
   *     case 'pack-cyclic-reference':
   *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
   *   }
   * }
   * ```
   */
  instantiate<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    parent?: EntityHandle,
  ): Result<EntityHandle, SceneInstantiateError> {
    return instantiateImpl(this, handle, world, parent);
  }

  instantiateWithPublicationFence<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    parent: EntityHandle | undefined,
    expectedPublication: ScenePublicationFence,
  ): Result<EntityHandle, SceneInstantiateError>;
  instantiateWithPublicationFence<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    parent: EntityHandle | undefined,
    expectedPublication: ScenePublicationFence,
  ): Result<EntityHandle, SceneInstantiateError> {
    return instantiateImpl(this, handle, world, parent, expectedPublication);
  }

  /**
   * Materialise a `SceneAsset` FLAT into an existing `World` — the "open a scene
   * for authoring" registry entry (#655): NO synthetic SceneInstance root, NO
   * forced `ChildOf` on top-level members. Returns the top-level entity handles.
   * Nested prefabs (`mounts[]`) still materialise as their own SceneInstance
   * anchors. Use {@link instantiate} (anchor) at runtime / Play and for nested
   * prefabs.
   */
  instantiateFlat<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
  ): Result<EntityHandle[], SceneInstantiateError> {
    return instantiateFlatImpl(this, handle, world);
  }

  instantiateFlatWithPublicationFence<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    expectedPublication: ScenePublicationFence,
  ): Result<EntityHandle[], SceneInstantiateError> {
    return instantiateFlatImpl(this, handle, world, expectedPublication);
  }

  private resolveKeyedSceneGuids(
    scene: SceneAsset,
    world: World,
    sceneGuidKey: string | undefined,
    visited: ReadonlySet<string>,
    guidToHandle: Map<string, number>,
    resolvedSceneHandles: Map<string, number>,
  ): Result<SceneAsset, AssetError> {
    const active = new Set(visited);
    if (sceneGuidKey !== undefined) active.add(sceneGuidKey.toLowerCase());

    const resolveComponents = (
      entityKey: string,
      source: Partial<SceneEntity['components']>,
    ): Result<Partial<SceneEntity['components']>, AssetError> => {
      const output: Record<string, Record<string, unknown>> = {};
      for (const [componentName, raw] of Object.entries(source)) {
        if (raw === undefined) continue;
        const fields = { ...(raw as Record<string, unknown>) };
        const token = world.components.resolve(componentName);
        if (token === undefined) {
          output[componentName] = fields;
          continue;
        }
        const schema = componentSchema(token) as Record<string, string>;
        for (const [fieldName, value] of Object.entries(fields)) {
          const fieldType = schema[fieldName];
          if (fieldType?.startsWith('shared<') && typeof value === 'string') {
            const resolved = resolveHandleGuid(
              this,
              world,
              value,
              guidToHandle,
              `${componentName}.${fieldName}`,
              `scene entity ${entityKey}`,
            );
            if (!resolved.ok) return resolved;
            fields[fieldName] = resolved.value;
          } else if (fieldType?.startsWith('array<shared<') && Array.isArray(value)) {
            const array: unknown[] = [];
            for (const [index, item] of value.entries()) {
              if (typeof item !== 'string') {
                array.push(item);
                continue;
              }
              const resolved = resolveHandleGuid(
                this,
                world,
                item,
                guidToHandle,
                `${componentName}.${fieldName}[${index}]`,
                `scene entity ${entityKey}`,
              );
              if (!resolved.ok) return resolved;
              array.push(resolved.value);
            }
            fields[fieldName] = array;
          }
        }
        output[componentName] = fields;
      }
      return ok(output);
    };

    const entities: Record<string, SceneEntity> = {};
    for (const [entityKey, node] of Object.entries(scene.entities)) {
      const components = resolveComponents(entityKey, node.components);
      if (!components.ok) return components;
      let instance = node.instance;
      if (instance !== undefined) {
        const childKey = instance.source.toLowerCase();
        if (active.has(childKey)) {
          return err(
            new AssetError({
              code: 'asset-parse-failed',
              expected: 'an acyclic keyed SceneAsset instance graph',
              hint: `recursive SceneAsset instance at ${entityKey} -> ${instance.source}`,
            }),
          );
        }
        const child = this.assetCatalog.get(childKey)?.payload;
        if (child?.kind === 'scene') {
          const childResult = this.resolveKeyedSceneGuids(
            child,
            world,
            childKey,
            new Set([...active, childKey]),
            guidToHandle,
            resolvedSceneHandles,
          );
          if (!childResult.ok) return childResult;
          if (!resolvedSceneHandles.has(childKey)) {
            const childHandle = unwrapHandle(world.allocSharedRef('SceneAsset', childResult.value));
            resolvedSceneHandles.set(childKey, childHandle);
            this._originIndex.set(childResult.value, childKey);
          }
          const overrides = [];
          for (const override of instance.overrides ?? []) {
            const overrideComponents = resolveComponents(
              `${entityKey}.${override.target.join('.')}`,
              override.components,
            );
            if (!overrideComponents.ok) return overrideComponents;
            overrides.push({ ...override, components: overrideComponents.value });
          }
          instance = {
            source: instance.source,
            ...(overrides.length === 0 && instance.overrides === undefined ? {} : { overrides }),
          };
        }
      }
      entities[entityKey] = {
        components: components.value,
        ...(instance === undefined ? {} : { instance }),
      };
    }
    return ok({
      kind: 'scene',
      entities,
      ...(scene.skinGuids === undefined ? {} : { skinGuids: scene.skinGuids }),
    });
  }

  /**
   * @internal
   * Transform a SceneAsset whose handle-type component fields hold GUID
   * strings (post-parseScenePayload intermediate state) into a copy whose
   * handle fields hold resolved Handle numbers.
   *
   * Schema-driven field detection (plan-strategy D-4): for each component
   * field whose Component.schema fieldType starts with `shared\<`, the
   * value is treated as a GUID string and resolved via `AssetGuid.parse` +
   * catalogue lookup + `world.internSharedRef` (feat-20260614 M8 D-15/D-17;
   * the registry mints nothing). Unknown component names are silently passed
   * through (the ecs layer's additionalProperties check will catch unknowns at
   * spawn if appropriate).
   *
   * Stop-on-first-error (AC-08): the first unresolvable GUID aborts
   * iteration and returns `AssetError(code='asset-not-found')` with a hint
   * containing the GUID string, node localId, and field name for AI-user
   * debuggability (P3).
   */
  _resolveSceneGuids(
    scene: SceneAsset,
    world: World,
    sceneGuidKey?: string,
    visitedMountGuids?: Set<string>,
    guidToHandle?: Map<string, number>,
    resolvedSceneHandles?: Map<string, number>,
    _materialGraphPreflighted = false,
  ): Result<SceneAsset, AssetError> {
    // SceneAsset has one public keyed representation. The Scene owner derives
    // numeric slots only during instantiation; no legacy array/mount reader is
    // retained here.
    void _materialGraphPreflighted;
    return this.resolveKeyedSceneGuids(
      scene,
      world,
      sceneGuidKey,
      visitedMountGuids ?? new Set(),
      guidToHandle ?? new Map(),
      resolvedSceneHandles ?? new Map(),
    );
  }

  /**
   * Register an asset and return a fresh
   * `Result<Handle<TagOf<T>, 'shared'>, AssetError>`. The brand `target`
   * tag is derived from the Asset's `kind` discriminator via `AssetTagMap`
   * (charter F1 single-entry indexability). The runtime representation is
   * an auto-incrementing u32 starting at 1024 (builtins reserve 1-2).
   *
   * feat-20260526 M4: `shadingModel` field is retired in favour of
   * pass-based MaterialAsset. This generic surface covers the full
   * `Asset` closed union (mesh / texture / sampler / scene / equirect
   * / material).
   */
  /**
   * feat-20260614 M8 (D-15 / D-17): catalogue a payload under its GUID.
   * Replaces the old `register` / `registerWithGuid` mint pair -- the registry
   * stores the PAYLOAD and never produces a handle (it owns no World).
   * Column minting is the caller's job via `world.allocSharedRef`.
   *
   * Validates mesh stride + material passes / sprite slices at catalogue entry
   * (same fail-fast surface as the old register path). Returns
   * `Result.err(AssetError)` on validation failure; `Result.ok(payload)` with
   * the stored payload (mesh payloads gain an `aabb`) on success.
   */
  catalog<T = Asset>(
    guid: AssetGuid | string,
    asset: T,
    refs?: readonly AssetRef[],
  ): Result<T, AssetError> {
    // D-5: narrow T to Asset for kind-discriminate branches. The runtime
    // catalog only accepts Asset-kind payloads (host custom kinds enter
    // through loadByGuid + registerParsedAsset, not catalog directly).
    const a: Asset = asset as unknown as Asset;
    const prepared = prepareAssetPayload(a);
    if (!prepared.ok) return prepared as Result<T, AssetError>;
    const stored = prepared.value;
    if (stored.kind === 'material') detectTileNeedsRepeatSampler(this, stored);
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const kind = a.kind;
    if (
      stored.kind === 'terrain' &&
      this.loadState.get(key)?.status !== 'provisional' &&
      !captureTerrainClosure(this, stored)
    )
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected:
            'complete terrain dependencies with height bytes derived from the author samples',
          hint: 'catalog the whole cooked closure before its root; do not replace derived heights independently',
        }),
      );
    // Drain any name recorded by an earlier _registerPackage call whose body had
    // not yet been catalogued (prod disk path; D-6). Preserve a name already on
    // a prior envelope for this key (re-catalog of the same GUID).
    const pendingName = this.pendingNames.get(key);
    const priorEnvelope = this.assetCatalog.get(key);
    const priorName = priorEnvelope?.name;
    const name = pendingName ?? priorName;
    this.pendingNames.delete(key);
    // feat-20260713 M4 / w15 (D-6, root cause a): when this GUID is being
    // re-catalogued with a DIFFERENT payload object, the prior object may still
    // be live behind a handle minted before the override (asset-registry.ts:513
    // identity scan would then MISS it). Record the superseded object -> GUID in
    // the origin reverse-index so `_guidForAsset` keeps resolving it — save/
    // collect of an owned entity holding that handle no longer fails with a
    // GUID-unresolved error (the 2026-07-06 crash). Structurally-modified copies
    // (a fresh object never catalogued) stay uncatalogued and correctly surface a
    // structured error at collect (requirements edge case "modified payload judged
    // as a new asset, not silently zeroed").
    if (priorEnvelope !== undefined && priorEnvelope.payload !== stored) {
      this._originIndex.set(priorEnvelope.payload, key);
    }
    this.assetCatalog.set(key, {
      guid: key,
      kind,
      ...(name !== undefined ? { name } : {}),
      payload: stored,
      refs: refs ?? [],
    });
    if (stored.kind === 'material') {
      const publication = this.materialPublication(key);
      publication.catalogRevision++;
      const { projection } = publication;
      if (projection !== undefined) this.materialPayloadProjections.set(stored, projection);
    }
    this.catalogEpoch++;
    this.loadState.registerReady(key, stored);
    if (stored.kind === 'terrain') captureTerrainClosure(this, stored);
    // D-1: catalog() inline path defaults every GUID to the no-package state
    // (null). loadByGuid + builtin override via their own registerPackage calls
    // before / after this so the package mapping is populated for all assets
    // through the single primitive (#1 SSOT). Do not clobber a package mapping
    // a prior registerPackage already established for this GUID.
    if (!this.packages.has(key)) this.packages.set(key, null);
    return ok(stored as T);
  }

  /**
   * @internal feat-20260618-asset-and-pack-name-fields M3 (D-1): the single
   * package-mapping write primitive. All three registration entry points funnel
   * here so the display-name invariant is implemented once (#1 SSOT):
   *   - catalog() inline path -> registerPackage(null, [guid])          (no package)
   *   - loadByGuid disk path  -> registerPackage(packageUrl, [g1,g2,...], names)
   *   - constructor builtin    -> registerPackage(null, [...guids])      (D-5 null)
   *
   * `path === null` registers the GUIDs with no package (resolveName reads their
   * storedName or returns ''). A non-null `path` finds-or-creates the shared
   * MutablePackage for that path and adds the GUIDs to it; per-GUID entry names
   * (D-2: name flows entry -> Package, never the payload) are taken from
   * `names`. The 1->N promotion branch (D-3) is added by w11. Never throws --
   * it only writes maps; resolution + validation happen in resolveName / rename.
   */
  _registerPackage(
    path: string | null,
    guids: readonly string[],
    names?: Map<string, string>,
  ): void {
    if (path === null) {
      for (const g of guids) {
        const key = g.toLowerCase();
        this.packages.set(key, null);
        const n = names?.get(g) ?? names?.get(key);
        if (n !== undefined) this.setStoredName(key, n);
      }
      return;
    }

    const pkg = this.packageByPath.get(path) ?? { path, assetGuids: new Set<string>() };
    this.packageByPath.set(path, pkg);

    // D-3: 1->N promotion. When this path already holds exactly one unnamed
    // asset and a new member is arriving, freeze the original asset's derived
    // basename as its stored name. An explicitly authored name is already the
    // stable identity and must be preserved without reporting a violation.
    const addsNewMember = guids.some((g) => !pkg.assetGuids.has(g.toLowerCase()));
    if (pkg.assetGuids.size === 1 && addsNewMember) {
      const [originalKey] = pkg.assetGuids;
      if (originalKey !== undefined) {
        if (!this.hasStoredName(originalKey)) {
          this.setStoredName(originalKey, deriveAssetName(pkg.path, 1));
        }
      }
    }

    for (const g of guids) {
      const key = g.toLowerCase();
      pkg.assetGuids.add(key);
      this.packages.set(key, pkg);
      const n = names?.get(g) ?? names?.get(key);
      if (n !== undefined) this.setStoredName(key, n);
    }
  }

  /**
   * Read the per-GUID stored display name (D-6 home: the envelope's `name`
   * field, with `pendingNames` covering the prod-disk ordering where the name is
   * known before the body is catalogued). Single read point for resolveName /
   * the 1->N promotion stability check.
   */
  private storedNameFor(key: string): string | undefined {
    return this.assetCatalog.get(key)?.name ?? this.pendingNames.get(key);
  }

  private hasStoredName(key: string): boolean {
    return this.storedNameFor(key) !== undefined;
  }

  /**
   * Write the per-GUID stored display name. When the envelope exists, replace it
   * with one carrying the new `name` (the envelope is immutable; D-6 keeps the
   * payload free of the name). Before the envelope is catalogued (prod disk
   * path), stash on `pendingNames` so catalog() can drain it into the new
   * envelope. `name === undefined` clears the name in both homes.
   */
  private setStoredName(key: string, name: string | undefined): void {
    const envelope = this.assetCatalog.get(key);
    if (envelope !== undefined) {
      const { name: _drop, ...rest } = envelope;
      this.assetCatalog.set(key, name === undefined ? rest : { ...rest, name });
      this.pendingNames.delete(key);
      return;
    }
    if (name === undefined) this.pendingNames.delete(key);
    else this.pendingNames.set(key, name);
  }

  /**
   * Return the `Package` this GUID belongs to, or `null` when the asset has no
   * package (catalog() inline + builtin, D-5), or `undefined` when the GUID was
   * never registered. The returned `Package` is a readonly snapshot whose
   * `assetCount` is derived from the live member set (#2 Derive).
   */
  packageOf(guid: AssetGuid | string): Package | null | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    if (pkg === undefined) return undefined;
    if (pkg === null) return null;
    return { path: pkg.path, assetGuids: pkg.assetGuids, assetCount: pkg.assetGuids.size };
  }

  /**
   * Resolve an asset's human-readable display name -- the single source of truth
   * for the two-segment identity's `name` segment (D-6). Every name consumer
   * (inspect / catalog builder / CLI) reads this or the same `deriveAssetName`
   * pure function it delegates to (AC-04); no consumer re-implements the
   * display-name rule. Returns a deterministic fallback rather than throwing on a missing
   * name (AC-15): an explicit stored name wins for any packaged or no-package
   * asset; otherwise a packaged asset falls back to `basename(path)`, and a
   * no-package asset resolves to `''` (the detectable "genuinely no name"
   * signal, charter P3). An unregistered GUID is treated as the no-package
   * branch.
   */
  resolveName(guid: AssetGuid | string): string {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    const storedName = this.storedNameFor(key);
    const path = pkg == null ? null : pkg.path;
    const assetCount = pkg == null ? 0 : pkg.assetGuids.size;
    return deriveAssetName(path, assetCount, storedName);
  }

  /**
   * Rename an asset's display name in memory (D-4). Three classes by package
   * shape:
   *   - no-package asset      -> set the stored self name
   *   - multi-asset package   -> set the entry stored name
   *   - single-asset package  -> rewrite the package path's leaf segment so the
   *                              derived basename becomes `newName` (the package
   *                              stays single-asset; the leaf IS the name)
   *
   * In-memory only (OOS-1: no disk write-back). Returns structured failures via
   * the closed `AssetErrorCode` union with no new members (D-4): a name that
   * collides with another member of the same package -> `asset-invalid-value`;
   * an unregistered GUID -> `asset-not-found`. AI users consume `.code` through
   * a `switch`, not by parsing `.message` (charter P3).
   */
  rename(guid: AssetGuid | string, newName: string): Result<void, AssetError> {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    if (!this.packages.has(key)) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `a registered asset for GUID ${key}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }

    const pkg = this.packages.get(key) ?? null;

    const collision = pkg !== null ? this.nameCollisionIn(pkg, key, newName) : null;
    if (collision !== null) return err(collision);

    if (pkg !== null && pkg.assetGuids.size === 1) {
      // Single-asset package: the leaf segment IS the derived name; rewrite it so
      // basename(path) === newName. Keep the directory prefix intact.
      const slash = pkg.path.lastIndexOf('/');
      const oldPath = pkg.path;
      pkg.path = slash >= 0 ? `${pkg.path.slice(0, slash + 1)}${newName}` : newName;
      this.packageByPath.delete(oldPath);
      this.packageByPath.set(pkg.path, pkg);
      this.setStoredName(key, undefined);
      return ok(undefined);
    }

    this.setStoredName(key, newName);
    return ok(undefined);
  }

  /**
   * Return an `asset-invalid-value` AssetError if another member of `pkg`
   * already resolves to `newName`, else null. Extracted from `rename` to keep
   * the collision-detection control flow flat (D-4 reuses the closed error code;
   * the detail narrows via the `{ field, value, reason }` union variant).
   */
  private nameCollisionIn(
    pkg: MutablePackage,
    selfKey: string,
    newName: string,
  ): AssetError | null {
    for (const memberKey of pkg.assetGuids) {
      if (memberKey !== selfKey && this.resolveName(memberKey) === newName) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `a name unique within package "${pkg.path}"`,
          hint: `another asset in "${pkg.path}" is already named "${newName}"; choose a distinct name`,
          detail: {
            field: 'name',
            value: newName,
            reason: `duplicate name within package ${pkg.path}`,
          },
        });
      }
    }
    return null;
  }

  /**
   * Parse a dash-form GUID string into an `AssetGuid`. Thin convenience over
   * `AssetGuid.parse` for the `loadByGuid` / `catalog` call sites; throws
   * `AssetError` on a malformed GUID (caller-error, mirrors `parseInt`-style
   * eager validation -- the GUID literal is author-supplied, not user data).
   */
  parseGuid(guidStr: string): AssetGuid {
    const parsed = AssetGuid.parse(guidStr);
    if (!parsed.ok) {
      throw new AssetError({
        code: 'asset-parse-failed',
        expected: `valid dash-form GUID, got "${guidStr}"`,
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      });
    }
    return parsed.value;
  }

  /**
   * Look up a catalogued payload by GUID, or `undefined` on miss. Used by the
   * ECS/render side (e.g. `walkMaterialParents` in `resolve-asset-handle.ts`)
   * to resolve a payload's embedded sub-asset GUIDs (D-19) without minting.
   */
  /** Terrain-derived dependencies remain paired with their adopted root payload. */
  terrainClosureCurrent(root: import('@forgeax/engine-types').TerrainAsset): boolean {
    return terrainClosureCurrent(this, root);
  }

  lookup<T = Asset>(guid: AssetGuid | string): T | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const ready = this.loadState.getReady<T>(key);
    if (ready !== undefined) return ready;
    if (this.packIndexUrl === undefined)
      return this.assetCatalog.get(key)?.payload as T | undefined;
    return undefined;
  }

  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
   * Return the texture-field name set for the given material-shader id,
   * derived from the registered shader's paramSchema via `derive(paramSchema)
   * .textureFieldNames`. Returns `undefined` when the shader is not yet
   * registered (cross-worktree shader-late-register, plan R-4).
   *
   * Used by `extractFrame` to know which values fields the shader
   * declares as texture handles; the extract layer validates handle-vs-
   * scalar typing and drops misclassified slots so the record stage's
   * MISSING_TEXTURE_HANDLE fallback can take over (white default texture)
   * rather than letting a stray handle reach `device.createBindGroup`.
   *
   * feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): delegates to the
   * extracted `./registry/validate-material` free function (signature stable).
   */
  materialShaderTextureFieldNames(shaderId: string): ReadonlySet<string> | undefined {
    return materialShaderTextureFieldNamesImpl(this, shaderId);
  }

  /**
   * Load an asset and all its transitively referenced sub-assets by GUID.
   * The result is a durable Asset payload. Consumer owners may narrow the
   * success type, then call their own World/Host projection; this registry does
   * not create a generic GUID-to-handle materializer.
   * Delegates to the load-by-guid collaboration module (w7 / D-4); see
   * registry/load-by-guid.ts for the full DDC / pack-fetch pipeline.
   */
  async loadByGuid<T = Asset>(
    guid: AssetGuid,
    parentContext?: {
      sceneEntityKey?: string;
      componentField?: string;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    return loadByGuidImpl<T>(this, guid, parentContext);
  }

  /**
   * Dispatch a pack payload through the injected LoaderRegistry. Delegates to
   * the load-by-guid collaboration module (w7 / D-4). Kept as a class method so
   * existing structural-cast test access keeps resolving.
   */
  parseAssetPayload(
    kind: string,
    payload: Record<string, unknown>,
    refs?: string[],
  ):
    | Asset
    | Record<string, unknown>
    | undefined
    | { readonly ok: false; readonly error: ParseErrorDetail } {
    return parseAssetPayloadImpl(this, kind, payload, refs);
  }

  /**
   * Parse a pack asset entry and return the payload + refs. Delegates to the
   * load-by-guid collaboration module (w7 / D-4). Kept as a class method so
   * existing structural-cast test access keeps resolving.
   */
  parseAndReturnAsset(assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }): Result<{ asset: Asset; refs: readonly string[] }, AssetError> {
    return parseAndReturnAssetImpl(this, assetEntry);
  }
  /** Return the legacy catalog snapshot when no GUID is supplied. */
  inspect(): InspectSnapshot;
  /** Return joined source/cook/package/runtime evidence for one GUID. */
  inspect(guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>>;
  inspect(guid?: string): InspectSnapshot | Promise<Result<AssetEvidence, AssetEvidenceError>> {
    if (guid !== undefined) return this.assetEvidenceAdapter.inspect(guid);
    const assets: InspectEntry[] = [];
    for (const [guid, envelope] of this.assetCatalog) {
      assets.push({
        guid,
        kind: envelope.payload.kind,
        name: this.resolveName(guid),
      });
    }
    return { assets };
  }

  /** Verify the same GUID evidence chain through the injected SDK capability. */
  verifyByGuid(guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>> {
    return this.assetEvidenceAdapter.verifyByGuid(guid);
  }

  /**
   * Return a readonly snapshot of all catalogued assets (inlined + pack-index)
   * for enumeration by asset panels (AC-03 single source of truth).
   *
   * Merges entries from the private `packIndexCache` (prod path, carries
   * `packageUrl`) and `assetCatalog` (inlined / dev path, no URL). Each
   * GUID appears exactly once. Returns a fresh array on every call — the
   * internal Maps are never exposed (charter P4 consistent abstraction).
   *
   * plan-strategy section 2 D1; requirements AC-03; research Finding 5.
   *
   * @example
   * ```ts
   * for (const e of registry.listCatalog()) {
   *   console.log(e.guid, e.kind, e.name, e.packageUrl);
   * }
   * ```
   */
  listCatalog(): readonly {
    guid: string;
    kind: string;
    name?: string;
    packageUrl: string;
    packageId?: CatalogEntry['packageId'];
    provenance?: CatalogEntry['provenance'];
    revision?: CatalogEntry['revision'];
    sourceKey?: CatalogEntry['sourceKey'];
    sourceIndex?: CatalogEntry['sourceIndex'];
    sourceOverrides?: CatalogEntry['sourceOverrides'];
    sourceOverrideDescriptors?: CatalogEntry['sourceOverrideDescriptors'];
    authoring?: CatalogEntry['authoring'];
    relations?: CatalogEntry['relations'];
    diagnostics?: CatalogEntry['diagnostics'];
    refs?: readonly string[];
    subject?: import('@forgeax/engine-types').CatalogSubject;
    execution?: import('@forgeax/engine-types').CookExecution;
    lifecycle?: import('@forgeax/engine-types').CatalogLifecycle;
    projection?: import('@forgeax/engine-types').CatalogProjection;
    /**
     * On-disk source-file path for external imported assets (FBX / GLB / HDR /
     * audio / font), relative to the game root. Editors locate the
     * `.meta.json` sidecar via `sourcePath + '.meta.json'` for CRUD; unlike
     * `packageUrl` (the runtime load artefact) it is stable across DDC cook
     * state. `undefined` for inline / dev-path assets (no sidecar, no CRUD).
     */
    sourcePath?: string;
  }[] {
    const seen = new Set<string>();
    const result: {
      guid: string;
      kind: string;
      name?: string;
      packageUrl: string;
      packageId?: CatalogEntry['packageId'];
      provenance?: CatalogEntry['provenance'];
      revision?: CatalogEntry['revision'];
      sourceKey?: CatalogEntry['sourceKey'];
      sourceIndex?: CatalogEntry['sourceIndex'];
      sourceOverrides?: CatalogEntry['sourceOverrides'];
      sourceOverrideDescriptors?: CatalogEntry['sourceOverrideDescriptors'];
      authoring?: CatalogEntry['authoring'];
      relations?: CatalogEntry['relations'];
      diagnostics?: CatalogEntry['diagnostics'];
      refs?: readonly string[];
      subject?: import('@forgeax/engine-types').CatalogSubject;
      execution?: import('@forgeax/engine-types').CookExecution;
      lifecycle?: import('@forgeax/engine-types').CatalogLifecycle;
      projection?: import('@forgeax/engine-types').CatalogProjection;
      sourcePath?: string;
      cookReceiptUrl?: string;
    }[] = [];

    // Prod entries: packIndexCache carries packageUrl + optional name + refs.
    if (this.packIndexCache) {
      for (const [guidKey, entry] of this.packIndexCache) {
        seen.add(guidKey);
        result.push({
          guid: guidKey,
          kind: entry.kind,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          packageUrl: entry.packageUrl,
          ...(entry.packageId !== undefined ? { packageId: entry.packageId } : {}),
          ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
          ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
          ...(entry.sourceKey !== undefined ? { sourceKey: entry.sourceKey } : {}),
          ...(entry.sourceIndex !== undefined ? { sourceIndex: entry.sourceIndex } : {}),
          ...(entry.sourceOverrides !== undefined
            ? { sourceOverrides: entry.sourceOverrides }
            : {}),
          ...(entry.sourceOverrideDescriptors !== undefined
            ? { sourceOverrideDescriptors: entry.sourceOverrideDescriptors }
            : {}),
          authoring: entry.authoring ?? authoringCapabilityForAssetKind(entry.kind),
          ...(entry.relations !== undefined ? { relations: entry.relations } : {}),
          ...(entry.diagnostics !== undefined ? { diagnostics: entry.diagnostics } : {}),
          ...(entry.refs !== undefined ? { refs: entry.refs } : {}),
          ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
          ...(entry.cookReceiptUrl !== undefined ? { cookReceiptUrl: entry.cookReceiptUrl } : {}),
          ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
          ...(entry.execution !== undefined ? { execution: entry.execution } : {}),
          ...(entry.lifecycle !== undefined ? { lifecycle: entry.lifecycle } : {}),
          ...(entry.projection !== undefined ? { projection: entry.projection } : {}),
        });
      }
    }

    // Inlined / dev-path entries: assetCatalog, no pack-index URL. The envelope
    // holds the authoritative AssetRef[] graph; flatten it to plain GUID edges
    // so both catalog paths expose the same refs: readonly string[] shape.
    for (const [guidKey, envelope] of this.assetCatalog) {
      if (!seen.has(guidKey)) {
        const name = envelope.name ?? this.resolveName(guidKey);
        result.push({
          guid: guidKey,
          kind: envelope.payload.kind,
          name,
          packageUrl: '',
          authoring: authoringCapabilityForAssetKind(envelope.payload.kind),
          subject: 'internal-asset',
          execution: 'direct',
          lifecycle: 'current',
          projection: {
            subject: 'internal-asset',
            execution: 'direct',
            lifecycle: 'current',
            operations: catalogOperationsFor({
              subject: 'internal-asset',
              execution: 'direct',
              lifecycle: 'current',
            }),
          },
          ...(envelope.refs.length > 0 ? { refs: envelope.refs.map((r) => r.guid) } : {}),
        });
      }
    }

    return result;
  }
}
