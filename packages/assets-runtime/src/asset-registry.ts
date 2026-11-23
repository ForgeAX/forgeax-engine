import { type Component, type EntityHandle, World } from '@forgeax/engine-ecs';
import { isStandaloneStaticMesh, meshAssetDecoder } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import { copyPackData } from '@forgeax/engine-pack/runtime';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import { compileKeyedSceneAsset, worldSetSceneAssetResolver } from '@forgeax/engine-scene';
import { MaterialArtifactRegistry, ShaderError, ShaderRegistry } from '@forgeax/engine-shader';
import type { PackageFetcher } from '@forgeax/engine-types';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetDecoder,
  type AssetDecoderLease,
  AssetError,
  type AssetEvidence,
  type AssetEvidenceError,
  type AssetEvidenceInputs,
  type AssetHandle,
  type AssetKind,
  type AssetLoadError,
  type AssetReferenceOwner,
  type BuiltinAssetKind,
  beginLoadWork,
  type CatalogEntry,
  type EngineMetrics,
  type ImageError,
  type ImportTransport,
  type InspectEntry,
  type InspectSnapshot,
  isMaterialTextureParameterType,
  loadTimelineNow,
  type MaterialAsset,
  type MaterialError,
  type MaterialParameter,
  type MaterialRasterSourceRecipe,
  type MaterialTable,
  type MaterialValue,
  materialGuidText,
  type ParticleEffectAsset,
  type ParticleEffectInput,
  projectAssetEvidence,
  type RuntimeAssetBinding,
  type SceneAsset,
  type TranscodeCaps,
  type MeshAsset as TypesMeshAsset,
  validateMaterialValues,
  validateTextureGenerator,
} from '@forgeax/engine-types';
import { defineAssetKind, isBuiltinAssetKind } from './asset-kind';
import { assetDataBytes, copyAssetData } from './internal/asset-data';
import {
  type AssetAdoption,
  type AssetAdoptionReader,
  type AssetLimits,
  AssetRecords,
  type MeshCpuFallback,
  type MeshCpuRequirement,
  type MeshPresentation,
  type MeshPresentationLease,
} from './internal/asset-records';
import {
  type AdoptedAssetSource,
  type AssetLoadOptions,
  type AssetSource,
  type AssetSourceOptions,
  createAssetSource,
  decodeStandaloneMeshBody,
  type SourceEntry,
  standaloneMeshBody,
} from './internal/asset-source';
import { DecoderRegistry } from './internal/decoder-registry';
import { trimRetainedBytes } from './internal/retention-budget';
import { installRuntimeAssets } from './internal/runtime-assets';
import { assetLoadCancelled, waitForAsset } from './internal/wait-for-asset';
import { pluginAssetDecoder } from './loaders/plugin';
import { runtimeMaterialProgramProjection } from './material/runtime-program';
import type { MeshGeometry } from './mesh-geometry.js';
import { copyPreparedAsset, prepareAssetPayload } from './prepare-payload.js';
import { readArtifact } from './registry/artifact-io.js';
import { linkRuntimeMaterial, prepareRuntimeAsset } from './runtime-asset-prepare';
import { linkRuntimeFont } from './runtime-font';
import {
  captureTerrainEdit,
  prepareTerrainHeightRange,
  prepareTerrainOutputs,
  type TerrainHeightRange,
  type TerrainInput,
} from './runtime-terrain';
import { prepareRuntimeTextureRange, type TextureRegion } from './runtime-texture';
import { linkRuntimeTileset } from './runtime-tileset';
import { extractSceneEntityHandleGuids } from './scene-handle-fields';
import { prepareRuntimeTerrain } from './terrain-closure.js';
import {
  type PublicationPreparationServices,
  preparePublicationPayloads,
} from './validate-publication.js';

/**
 * Strip readonly from all fields of T. Used to mutate the MeshAsset.aabb slot
 * after mesh validation passes (the interface is readonly but register-time
 * computation writes the real AABB into the caller's placeholder).
 */

// feat-20260705-runtime-tier2-decomposition M1 / w4 (D-4 F1): the pre-class
// constants, loaders, scene-payload / payload-validate / aabb helpers were
// straight-cut into sibling modules. The thin class value-imports only what its
// method bodies still reference; the full public consumer face (barrel + tests)
// is preserved via the `export ... from` re-export block below (pre-w14 shim,
// removed when consumers repoint in w14/w15).
import { type CatalogListener, type CatalogSource, createCatalogSource } from './catalog-source.js';
import type { MaterialReady, SourceMaterialPayload } from './material/loader.js';
import {
  assertMaterialCookedParameters,
  assertMaterialStaticSelection,
  bindMaterialTemplateProjection,
  type DecodedMaterialTemplate,
  installMaterialReadyShaders,
  type MaterialRenderProjection,
  type PrepareMaterialSourceProgram,
  projectMaterialTemplate,
} from './material/runtime-shader.js';
import type { CatalogReplicaSnapshot } from './registry/catalog-state.js';
import {
  instantiateFlat as instantiateFlatImpl,
  instantiate as instantiateImpl,
  type PostSpawnHook,
  type SceneInstantiateError,
} from './registry/instantiate.js';
import type { ScenePublicationFence } from './registry/scene-publication-fence.js';
import {
  captureSourceIngestionInputs,
  type SourceIngestionEntry,
  type SourceIngestionInputs,
} from './registry/source-ingestion-inputs';
import { materialShaderTextureFieldNames as materialShaderTextureFieldNamesImpl } from './registry/validate-material.js';
import { prepareRuntimeAnimationGraph } from './runtime-animation-graph';
import {
  type MeshRange,
  prepareRuntimeMeshPatch,
  prepareRuntimeMeshRange,
  prepareRuntimeMeshRanges,
} from './runtime-mesh';
import { prepareRuntimeScene } from './runtime-scene';

export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate.js';

// ─── Re-exports for engine-runtime-local consumers ──────────────────────────
//
// Legacy re-exports: `Asset` widens to the 4-variant engine-types union;
// `MeshAsset` keeps the engine-types shape (with `attributes`). Consumers
// that previously imported from `./asset-registry` keep working through
// the type alias re-exports below.

export type { Asset, TypesMeshAsset as MeshAsset };

// Primitive mesh payloads are produced by Geometry.
// process-static payload SSOT); the shared runtime vertex layout remains owned
// by @forgeax/engine-geometry.
// imported at the top of this file. The constructor still pre-populates the
// handle->payload map from those imports (the map itself retires in w49).

// feat-20260618-asset-and-pack-name-fields M3 (D-1 / D-3): the mutable runtime
// package object every GUID of the same import path shares. `assetGuids` grows
// as `registerPackage` adds GUIDs; `assetCount` (the engine-types `Package`
// view) is derived from `assetGuids.size`, never stored (#2 Derive). The public
// `packageOf(guid)` projects this to the readonly `Package` interface.

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

export interface AssetRegistryOptions extends Partial<Omit<AssetSourceOptions, 'decoders'>> {
  readonly shaderRegistry?: ShaderRegistry | undefined;
  readonly importTransport?: ImportTransport | undefined;
  readonly postSpawnHook?: PostSpawnHook | undefined;
  readonly runtimeBinding?: RuntimeAssetBinding | undefined;
  readonly components?: ReadonlyMap<string, Component>;
  readonly limits?: AssetLimits;
}

export type RuntimeAssetError = AssetError | AssetLoadError | ImageError | RhiError | MaterialError;

function materialBindingKind(value: unknown): 'texture' | 'source' | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const texture = Object.hasOwn(value, 'texture');
  const source = Object.hasOwn(value, 'source');
  if (texture === source) return undefined;
  return texture ? 'texture' : 'source';
}

function materialValuePatchKind(
  descriptors: PropertyDescriptorMap,
  current: MaterialAsset['values'],
  textureNames: ReadonlySet<string>,
): 'numeric' | 'binding' | undefined {
  let kind: 'numeric' | 'binding' = 'numeric';
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== 'string') return undefined;
    const entry = descriptors[name];
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return undefined;
    const previous = current?.[name];
    const binding = materialBindingKind(previous);
    if (binding !== undefined && materialBindingKind(entry.value) === binding) {
      kind = 'binding';
      continue;
    }
    if (
      textureNames.has(name) ||
      typeof previous === 'string' ||
      (previous !== null && typeof previous === 'object' && !Array.isArray(previous)) ||
      (typeof entry.value !== 'number' &&
        typeof entry.value !== 'boolean' &&
        !Array.isArray(entry.value))
    )
      return undefined;
  }
  return kind;
}

export interface AssetReloadOptions extends AssetLoadOptions {
  /** Reject gameplay edits, or explicitly replace edits made before this request. */
  readonly conflict: 'reject' | 'overwrite';
}

export interface AssetBatchLoadOptions extends AssetLoadOptions {
  /** Observe completed reads or yield to the host. Grants stay batch-owned
   * until success; throwing or cancelling here rolls back every admitted grant. */
  readonly onProgress?: (completed: number, total: number) => void | Promise<void>;
}

interface SourceAdoption {
  readonly started: number;
  readonly conflict: AssetReloadOptions['conflict'];
  readonly handle: AssetHandle;
}

interface MeshCpuRestore {
  readonly waiters: Map<AbortSignal | undefined, MeshCpuRequirement>;
  readonly result: Promise<Result<void, RuntimeAssetError>>;
}

interface SourceIngestionOperation {
  readonly root: string;
  readonly source: AssetSource;
  readonly inputs: SourceIngestionInputs;
  readonly records: AssetAdoption;
  readonly staged: Map<string, AssetHandle>;
  readonly visiting: Set<string>;
  readonly ownedMeshes: Map<string, SourceEntry>;
  readonly renderMeshes: ReadonlySet<string>;
  readonly contentKeys: ReadonlyMap<string, string | undefined>;
  readonly signal: AbortSignal | undefined;
  readonly policy: SourceAdoption | undefined;
  failure: RuntimeAssetError | undefined;
  committed: boolean;
  steps: Generator<void, Result<AssetHandle, RuntimeAssetError>> | undefined;
}

interface PreparedPublicationCandidate {
  readonly assets: ReadonlyMap<string, Asset>;
  readonly pack: RuntimePackEnvelope;
  readonly rows: readonly CatalogEntry[];
  readonly standaloneMeshes: ReadonlySet<string>;
  readonly source: AssetSource | undefined;
  readonly generations: ReadonlyMap<string, number>;
  readonly started: number;
  readonly decoderIdentities: ReadonlyMap<string, symbol | undefined>;
}

function includeRuntimeDependencies<T, E>(
  linked: Result<{ readonly value: T; readonly dependencies: readonly number[] }, E>,
  dependencies: readonly number[],
): Result<{ value: T; dependencies: readonly number[] }, E> {
  return linked.ok
    ? ok({
        value: linked.value.value,
        dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
      })
    : linked;
}

/** Runtime evidence supplied by the host. */
export interface RuntimeEvidenceSource {
  readonly evidence: (
    guid: string,
  ) => Promise<AssetEvidenceInputs | Result<AssetEvidenceInputs, AssetEvidenceError>>;
}

export class AssetRegistry implements AssetReferenceOwner {
  static readonly #sourceRead = AssetRegistry.prototype.sourceOf;
  static readonly #catalogRead = AssetRegistry.prototype.catalogEntry;
  private ingestionQueue: Promise<void> = Promise.resolve();
  private readonly ingestions = new Set<SourceIngestionOperation>();
  private hasTextureGenerators = false;
  readonly #decoders: DecoderRegistry;
  #source: AssetSource | undefined;
  readonly #meshRestores = new WeakMap<MeshPresentation, MeshCpuRestore>();
  readonly #meshPreparations = new Map<
    AssetHandle,
    {
      readonly controller: AbortController;
      readonly result: Promise<Result<void, RuntimeAssetError>>;
      waiters: number;
    }
  >();
  readonly #sceneRenderMeshes = new WeakMap<SceneAsset, ReadonlySet<number>>();
  readonly #ownedMeshBodies = new WeakMap<TypesMeshAsset, NonNullable<SourceEntry['meshBody']>>();
  #disposed = false;
  readonly #runtime: AssetRecords;
  /** Derived Terrain content can be copied, but only its author root may replace it. */
  readonly #terrainDerived = new WeakSet<object>();
  readonly #runtimeByGuid = new Map<string, AssetHandle>();
  readonly #runtimeGuids = new Map<number, AdoptedAssetSource>();
  #world: World | undefined;
  private readonly materialValueContracts = new WeakMap<
    object,
    {
      readonly parameters: ReadonlyMap<string, MaterialParameter> | undefined;
      readonly textures: ReadonlySet<string>;
    }
  >();

  get identity(): string {
    return this.#runtime.identity;
  }

  attach(scope: object): Result<void, AssetError> {
    const attached = this.#runtime.attach(scope);
    if (!attached.ok) return attached;
    if (scope instanceof World && this.#world !== scope) {
      this.#world = scope;
      worldSetSceneAssetResolver(scope, (source) => {
        const handle =
          typeof source === 'number' ? source : this.#runtimeByGuid.get(source.toLowerCase());
        if (handle === undefined)
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `loaded Scene source ${source}`,
              hint: 'load the Scene and its dependencies before instantiating it',
            }),
          );
        const valid = this.validate(handle, 'scene');
        return valid.ok ? ok(handle as AssetHandle<'scene'>) : valid;
      });
    }
    return attached;
  }

  validate(handle: number, kind?: string): Result<void, AssetError> {
    return this.#runtime.validate(handle, kind);
  }

  retain(handle: number, kind?: string): Result<void, AssetError> {
    return this.#runtime.retain(handle, kind);
  }

  release(handle: number): Result<void, AssetError> {
    return this.#runtime.release(handle);
  }

  /** Retire a loaded GUID when the Registry cache has its only remaining grant. */
  unload(guid: AssetGuid | string): Result<boolean, AssetError> {
    const key = (typeof guid === 'string' ? guid : AssetGuid.format(guid)).toLowerCase();
    const handle = this.#runtimeByGuid.get(key);
    if (handle === undefined) return ok(false);
    const retired = this.#runtime.releaseIfSoleHolder(handle);
    if (retired.ok && retired.value) {
      this.#runtimeByGuid.delete(key);
      this.#runtimeGuids.delete(handle);
    }
    return retired;
  }

  /** Create independent runtime content, without a source GUID or World registration. */
  create<P, K extends string>(
    kind: AssetKind<P, K>,
    input: P,
  ): Result<AssetHandle<K, P>, AssetError | MaterialError>;
  create(input: TerrainInput): Result<AssetHandle<'terrain'>, AssetError | MaterialError>;
  create<T extends Asset | ParticleEffectInput>(
    input: T,
  ): Result<AssetHandle<T['kind']>, AssetError | MaterialError>;
  create(
    input: Asset | ParticleEffectInput | TerrainInput | AssetKind<unknown>,
    ...values: [] | [unknown]
  ): Result<AssetHandle, AssetError | MaterialError> {
    const kind =
      input && typeof input === 'object'
        ? Object.getOwnPropertyDescriptor(input, 'kind')
        : undefined;
    if (kind === undefined || !Object.hasOwn(kind, 'value') || typeof kind.value !== 'string')
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'an owned kind data property',
          hint: 'pass plain asset content or an AssetKind token',
        }),
      );
    const target = kind.value;
    if (values.length === 1) {
      const value = values[0];
      if (isBuiltinAssetKind(target)) {
        const valueKind =
          value !== null && typeof value === 'object'
            ? Object.getOwnPropertyDescriptor(value, 'kind')
            : undefined;
        if (
          valueKind === undefined ||
          !Object.hasOwn(valueKind, 'value') ||
          valueKind.value !== target
        )
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'content matching its asset kind',
              hint: 'supply matching built-in asset content',
            }),
          );
        return this.create(value as Asset);
      }
      return this.#runtime.create(target, value, [], (owned) =>
        this.prepareWithDecoder(target, owned),
      );
    }
    if (target === 'terrain') return this.createTerrainContent(input as TerrainInput);
    return this.createRuntimeContent(input as Asset, []);
  }

  /**
   * Create independent runtime content from storage the caller gives up.
   * Validation and preparation are exactly those of `create`; only ownership
   * differs. A binary view spanning its whole fixed buffer becomes the asset's
   * storage instead of being duplicated, so the caller must stop writing those
   * buffers, and a view it keeps observes later asset writes like any other
   * borrowed content.
   */
  createOwned<T extends Asset>(
    input: T,
  ): Result<AssetHandle<T['kind']>, AssetError | MaterialError> {
    return this.createRuntimeContent(input, [], undefined, undefined, undefined, 'take');
  }

  private prepareWithDecoder(
    kind: string,
    input: unknown,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    reader: AssetAdoptionReader = this.#runtime,
    checkSource: () => Result<void, AssetError> = () => ok(undefined),
  ): Result<{ value: unknown; dependencies: readonly number[] }, AssetError> {
    const dependencies = new Set<number>();
    const prepared = this.#decoders.prepare(kind, input, {
      reference: (value, target) => {
        const current = checkSource();
        if (!current.ok) return current;
        const handle =
          typeof value === 'number'
            ? value
            : (sources.get(value.toLowerCase()) ?? this.#runtimeByGuid.get(value.toLowerCase()));
        if (handle === undefined)
          return err(
            new AssetError({
              code: 'asset-reference-invalid',
              expected: `a loaded ${target} dependency`,
              hint: 'load the declared dependency before preparing runtime content',
            }),
          );
        const valid = reader.validate(handle, target);
        if (!valid.ok) return valid;
        dependencies.add(handle);
        return ok(handle as AssetHandle<typeof target>);
      },
      read: (handle) => {
        const current = checkSource();
        return current.ok ? reader.read(handle) : current;
      },
    });
    const current = checkSource();
    if (!current.ok) return current;
    return prepared.ok ? ok({ value: prepared.value, dependencies: [...dependencies] }) : prepared;
  }

  private createTerrainContent(
    input: TerrainInput,
    replacing?: AssetHandle<'terrain'>,
  ): Result<AssetHandle<'terrain'>, AssetError | MaterialError> {
    const outputs = prepareTerrainOutputs(input, this.#runtime, (guid) =>
      this.#runtimeByGuid.get(guid),
    );
    if (!outputs.ok) return outputs;
    const sources = new Map<string, AssetHandle>();
    const created: AssetHandle[] = [];
    const adopted = this.#runtime.adoptClosure(() => {
      for (const [key, asset] of Object.entries(outputs.value)) {
        if (key === 'terrain') continue;
        const value = this.createRuntimeContent(asset, [], sources);
        if (!value.ok) return value;
        sources.set(key, value.value);
        created.push(value.value);
      }
      const root = outputs.value.terrain;
      if (root?.kind !== 'terrain') throw new Error('Terrain derivation lost its root');
      return this.createRuntimeContent(root, [], sources, replacing);
    });
    if (adopted.ok) for (const handle of created) this.#runtime.release(handle).unwrap();
    return adopted as Result<AssetHandle<'terrain'>, AssetError | MaterialError>;
  }

  private createRuntimeContent<T extends Asset>(
    input: T,
    dependencies: readonly number[],
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    replacing?: AssetHandle<T['kind']>,
    sourceContent: (guid: string) => Asset | undefined = (guid) => this.runtimeSource(guid),
    storage: 'copy' | 'take' = 'copy',
    adoption?: AssetAdoption,
    component?: (name: string) => Component | undefined,
    checkSource?: () => Result<void, AssetError>,
    sceneRefs?: readonly string[],
    meshStorage?: 'render-transfer',
  ): Result<AssetHandle<T['kind']>, AssetError | MaterialError> {
    const kind =
      input !== null && typeof input === 'object'
        ? Object.getOwnPropertyDescriptor(input, 'kind')
        : undefined;
    if (
      kind === undefined ||
      !Object.hasOwn(kind, 'value') ||
      typeof kind.value !== 'string' ||
      !isBuiltinAssetKind(kind.value)
    )
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'an asset with an owned kind data property',
          hint: 'pass plain asset data without accessors',
        }),
      );
    let projection: MaterialRenderProjection | undefined;
    let textures: ReadonlySet<string> | undefined;
    let content = input;
    if (
      kind.value === 'material' &&
      (Object.hasOwn(input, 'cooked') || Object.hasOwn(input, 'materialTemplate'))
    ) {
      // Cook records belong to the source/program owners, not mutable asset versions.
      // Preserve descriptors so ordinary data admission still rejects accessors.
      const descriptors = Object.getOwnPropertyDescriptors(input);
      delete descriptors.cooked;
      delete descriptors.materialTemplate;
      content = Object.create(Object.getPrototypeOf(input), descriptors);
    }
    const reader = adoption?.reader ?? this.#runtime;
    const prepare = (owned: T) => {
      if (requiresOwnerPreparation(owned.kind))
        return this.prepareWithDecoder(owned.kind, owned, sources, reader, checkSource);
      const prepared = prepareRuntimeAsset(owned, sourceContent, meshStorage);
      if (!prepared.ok) return prepared;
      if (prepared.value.kind === 'tileset') {
        const linked = linkRuntimeTileset(
          prepared.value,
          reader,
          (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
        );
        return includeRuntimeDependencies(linked, dependencies);
      }
      if (prepared.value.kind === 'font') {
        const linked = linkRuntimeFont(
          prepared.value,
          reader,
          (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
        );
        return includeRuntimeDependencies(linked, dependencies);
      }

      if (prepared.value.kind === 'terrain')
        return prepareRuntimeTerrain(
          prepared.value,
          reader,
          (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
        );
      if (owned.kind === 'material') {
        // Static program admission must finish before a reference or change is committed.
        try {
          projection = this.prepareMaterialProgramProjection(input as MaterialAsset, sourceContent);
          assertMaterialCookedParameters((input as MaterialAsset).parameters, projection);
        } catch (cause) {
          if (
            cause !== null &&
            typeof cause === 'object' &&
            'code' in cause &&
            cause.code === 'material-specialization-not-cooked'
          )
            return err(cause as MaterialError);
          throw cause;
        }
      }
      if (prepared.value.kind === 'mesh') {
        const linked = this.linkMesh(prepared.value, sources, reader);
        return includeRuntimeDependencies(linked, dependencies);
      }
      if (prepared.value.kind === 'animation-graph' || prepared.value.kind === 'scene') {
        const linked =
          prepared.value.kind === 'scene'
            ? this.linkScene(prepared.value, sources, sceneRefs, reader, component)
            : this.linkAnimationGraph(prepared.value, sources, reader);
        return includeRuntimeDependencies<Asset, AssetError>(linked, dependencies);
      }
      if (prepared.value.kind !== 'material') return ok({ value: prepared.value });
      const linked = this.linkMaterial(prepared.value, sources, undefined, reader);
      if (linked.ok) textures = linked.value.textures;
      return includeRuntimeDependencies(linked, dependencies);
    };
    const created =
      adoption === undefined
        ? this.#runtime.adopt<T['kind'], T, AssetError | MaterialError>(
            kind.value as T['kind'],
            content,
            dependencies,
            prepare,
            replacing,
            storage,
          )
        : adoption.adopt<T['kind'], T, AssetError | MaterialError>(
            kind.value as T['kind'],
            content,
            dependencies,
            prepare,
            replacing,
            storage,
          );
    if (created.ok && kind.value === 'texture-generator' && adoption === undefined)
      this.hasTextureGenerators = true;
    if (created.ok && kind.value === 'material') {
      const accepted = reader.borrow<MaterialAsset>(created.value).unwrap();
      this.prepareMaterialValueContract(accepted, textures);
      if (projection !== undefined) this.materialPayloadProjections.set(accepted, projection);
    }
    if (created.ok && kind.value === 'terrain')
      this.ownTerrainDerived(
        reader.borrow<import('@forgeax/engine-types').TerrainAsset>(created.value).unwrap(),
        reader,
      );
    return created;
  }

  private ownTerrainDerived(
    terrain: import('@forgeax/engine-types').TerrainAsset,
    reader: AssetAdoptionReader = this.#runtime,
  ): void {
    const own = (handle: string | number) => {
      if (typeof handle !== 'number') throw new Error('Terrain closure was not linked');
      this.#terrainDerived.add(reader.borrow<object>(handle).unwrap());
    };
    for (const handle of terrain.grids) own(handle);
    for (const section of terrain.sections) {
      own(section.heightTexture);
      own(section.weightTexture);
      own(section.material);
      // Source retention can include shared assets that Terrain did not derive.
      const material = reader.borrow<MaterialAsset>(Number(section.material)).unwrap();
      const control = material.values?.terrainWeightTexture;
      if (
        control === null ||
        typeof control !== 'object' ||
        !('sampler' in control) ||
        typeof control.sampler !== 'number'
      )
        throw new Error('Terrain control sampler was not linked');
      own(control.sampler);
    }
  }

  private terrainDerivedWrite(value: object): AssetError | undefined {
    return this.#terrainDerived.has(value)
      ? new AssetError({
          code: 'asset-invalid-value',
          expected: 'writes to Terrain author fields',
          hint: 'update the Terrain root; copy a derived asset first when independent editable content is needed',
        })
      : undefined;
  }

  private linkMesh(
    mesh: TypesMeshAsset,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    reader: AssetAdoptionReader = this.#runtime,
  ): Result<{ value: TypesMeshAsset; dependencies: readonly number[] }, AssetError> {
    const dependencies = new Set<number>();
    const link = <K extends 'mesh' | 'material'>(
      reference: import('@forgeax/engine-types').AssetGuid | AssetHandle<K>,
      kind: K,
    ): Result<AssetHandle<K>, AssetError> => {
      const guid =
        typeof reference === 'number' ? undefined : AssetGuid.format(reference).toLowerCase();
      const handle =
        guid === undefined
          ? (reference as AssetHandle<K>)
          : (sources.get(guid) ?? this.#runtimeByGuid.get(guid));
      if (handle === undefined)
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `loaded ${kind} source ${guid}`,
            hint: 'load the dependency or supply a runtime asset reference before creating the mesh',
          }),
        );
      const checked = reader.validate(handle, kind);
      if (!checked.ok) return checked;
      dependencies.add(handle);
      return ok(handle as AssetHandle<K>);
    };
    const materialSlots: TypesMeshAsset['materialSlots'][number][] = [];
    for (const slot of mesh.materialSlots) {
      if (slot.defaultMaterial === undefined) {
        materialSlots.push(slot);
        continue;
      }
      const material = link(slot.defaultMaterial, 'material');
      if (!material.ok) return material;
      materialSlots.push({ ...slot, defaultMaterial: material.value });
    }
    const lods: NonNullable<TypesMeshAsset['lods']>[number][] = [];
    for (const lod of mesh.lods ?? []) {
      const lower = link(lod.mesh, 'mesh');
      if (!lower.ok) return lower;
      lods.push({ ...lod, mesh: lower.value });
    }
    return ok({
      value: { ...mesh, materialSlots, ...(mesh.lods === undefined ? {} : { lods }) },
      dependencies: [...dependencies],
    });
  }

  private linkMaterial(
    material: MaterialAsset,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    knownTextures?: ReadonlySet<string>,
    reader: AssetAdoptionReader = this.#runtime,
  ) {
    const fields = new Set(knownTextures);
    for (const parameter of material.parameters ?? [])
      if (!isMaterialTextureParameterType(parameter.type)) fields.delete(parameter.name);
    for (const pass of material.passes ?? [])
      for (const field of this.materialShaderTextureFieldNames(pass.program.module) ?? [])
        fields.add(field);
    return linkRuntimeMaterial(
      material,
      reader,
      (guid) => sources.get(guid.toLowerCase()) ?? this.#runtimeByGuid.get(guid.toLowerCase()),
      fields,
    );
  }

  /** Derived once at material admission or structural replacement, never per scalar write. */
  private prepareMaterialValueContract(
    material: MaterialAsset,
    linkedTextures?: ReadonlySet<string>,
  ): void {
    const parameters =
      material.parameters === undefined
        ? undefined
        : new Map(material.parameters.map((parameter) => [parameter.name, parameter]));
    const textures = new Set(linkedTextures);
    for (const parameter of parameters?.values() ?? [])
      if (isMaterialTextureParameterType(parameter.type)) textures.add(parameter.name);
    for (const pass of material.passes ?? [])
      for (const name of this.materialShaderTextureFieldNames(pass.program.module) ?? [])
        textures.add(name);
    this.materialValueContracts.set(material, { parameters, textures });
  }

  /** A generator and all its already-loaded output descriptors commit in one asset transaction. */
  private updateTextureGeneratorGroup(
    handle: AssetHandle,
    patch: Readonly<Record<string, unknown>>,
  ): Result<void, AssetError | MaterialError> {
    const current =
      this.#runtime.borrow<import('@forgeax/engine-types').TextureGeneratorAsset>(handle);
    if (!current.ok) return current;
    if ('kind' in patch)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'an unchanged generator kind',
          hint: 'update generator values, inputs or output declarations',
        }),
      );
    return this.#runtime.adoptClosure(() => {
      const updated = this.#runtime.update(
        handle,
        { ...current.value, ...patch },
        {
          replace: true,
          prepare: (_previous, owned) => {
            const prepared = this.prepareWithDecoder('texture-generator', owned);
            return prepared.ok
              ? ok({
                  value: prepared.value.value as Record<string, unknown>,
                  dependencies: prepared.value.dependencies,
                })
              : prepared;
          },
        },
      );
      if (!updated.ok) return updated;
      const visited = new Set<number>([handle]);
      const pending = [Number(handle)];
      while (pending.length > 0) {
        const next = pending.pop();
        if (next === undefined) break;
        for (const dependent of this.#runtime.dependentHandles(next)) {
          if (visited.has(dependent)) continue;
          visited.add(dependent);
          const content = this.#runtime.borrow<Asset>(dependent);
          if (!content.ok) return content;
          if (content.value.kind === 'gpu-texture') {
            const prepared = prepareRuntimeAsset(content.value, (guid) => this.runtimeSource(guid));
            if (!prepared.ok) return prepared;
            const replaced = this.#runtime.update(
              dependent,
              { ...prepared.value },
              { replace: true },
            );
            if (!replaced.ok) return replaced;
            pending.push(dependent);
          } else if (content.value.kind === 'texture-generator') {
            const replaced = this.#runtime.update(
              dependent,
              { ...content.value },
              { replace: true },
            );
            if (!replaced.ok) return replaced;
            pending.push(dependent);
          }
        }
      }
      return ok(undefined);
    });
  }

  /** Detached public content. Mutating this value never modifies the asset. */
  read<K extends string, P>(handle: AssetHandle<K, P>): Result<P, AssetError> {
    return this.#runtime.read<P>(handle);
  }

  /** Provenance of the adopted content, independent of later Catalog publications. */
  source(handle: AssetHandle): Result<
    | {
        readonly guid: string;
        readonly publication?: import('@forgeax/engine-types').AssetPublicationTuple &
          import('@forgeax/engine-types').AssetPublicationEnvelope;
      }
    | undefined,
    AssetError
  > {
    const valid = this.validate(handle);
    if (!valid.ok) return valid;
    const origin = this.#runtimeGuids.get(handle);
    return ok(
      origin === undefined
        ? undefined
        : {
            guid: origin.guid,
            ...(origin.publication === undefined
              ? {}
              : { publication: structuredClone(origin.publication) }),
          },
    );
  }

  installDecoder<P, K extends string>(
    kind: AssetKind<P, K>,
    decoder: AssetDecoder<P>,
  ): AssetDecoderLease {
    return this.#decoders.install(kind, decoder);
  }

  /** Source I/O diagnostics; runtime snapshots retain content, not this loading graph. */
  inspectSource() {
    return this.#source?.snapshot();
  }

  copy<K extends string, P>(handle: AssetHandle<K, P>): Result<AssetHandle<K, P>, AssetError> {
    const current = this.#runtime.borrow<unknown>(handle);
    if (!current.ok) return current;
    if (
      current.value !== null &&
      typeof current.value === 'object' &&
      'kind' in current.value &&
      current.value.kind === 'terrain'
    )
      return this.createTerrainContent(current.value as TerrainInput) as Result<
        AssetHandle<K, P>,
        AssetError
      >;
    const copied = this.#runtime.copy(handle);
    if (copied.ok && current.value !== null && typeof current.value === 'object') {
      const contract = this.materialValueContracts.get(current.value);
      if (contract !== undefined)
        this.materialValueContracts.set(
          this.#runtime.borrow<object>(copied.value).unwrap(),
          contract,
        );
      const projection = this.materialPayloadProjections.get(current.value);
      if (projection !== undefined)
        this.materialPayloadProjections.set(
          this.#runtime.borrow<object>(copied.value).unwrap(),
          projection,
        );
    }
    return copied;
  }

  /** A material value patch merges the named parameters in one commit. Other root fields replace. */
  update<K extends string, P>(
    handle: AssetHandle<K, P>,
    patch: Partial<Omit<P extends ParticleEffectAsset ? ParticleEffectInput : P, 'kind'>>,
  ): Result<void, AssetError | MaterialError>;
  update(
    handle: AssetHandle,
    patch: Readonly<Record<string, unknown>>,
  ): Result<void, AssetError | MaterialError> {
    const committed = this.updateContent(handle, patch);
    return committed.ok ? this.refreshTextureGeneratorInputs(handle) : committed;
  }

  private refreshTextureGeneratorInputs(handle: AssetHandle): Result<void, AssetError> {
    if (!this.hasTextureGenerators) return ok(undefined);
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
    if (kind.value !== 'texture' && kind.value !== 'gpu-texture' && kind.value !== 'sampler')
      return ok(undefined);
    for (const dependent of this.#runtime.dependentHandles(handle)) {
      const content = this.#runtime.borrow<Asset>(dependent);
      if (!content.ok) return content;
      if (content.value.kind !== 'texture-generator') continue;
      const updated = this.updateTextureGeneratorGroup(dependent as AssetHandle, {});
      if (!updated.ok)
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: updated.error.expected,
            hint: updated.error.hint,
          }),
        );
    }
    return ok(undefined);
  }

  private updateMaterialValues(
    handle: AssetHandle,
    current: MaterialAsset,
    patch: Readonly<Record<string, unknown>>,
  ): Result<void, AssetError | MaterialError> | undefined {
    const descriptors =
      patch !== null && typeof patch === 'object'
        ? Object.getOwnPropertyDescriptors(patch)
        : undefined;
    const values = descriptors?.values;
    if (
      descriptors !== undefined &&
      Reflect.ownKeys(descriptors).length === 1 &&
      values?.enumerable &&
      Object.hasOwn(values, 'value') &&
      values.value !== null &&
      typeof values.value === 'object' &&
      !Array.isArray(values.value)
    ) {
      const contract = this.materialValueContracts.get(current);
      const kind =
        contract === undefined
          ? undefined
          : materialValuePatchKind(
              Object.getOwnPropertyDescriptors(values.value),
              current.values,
              contract.textures,
            );
      if (contract !== undefined && kind !== undefined) {
        const result = this.#runtime.update<AssetError | MaterialError>(handle, values.value, {
          field: 'values',
          prepare: (_current, owned) => {
            const valid = validateMaterialValues(
              '<runtime-material>',
              owned as Record<string, MaterialValue>,
              contract.parameters,
            );
            if (!valid.ok) return valid;
            return kind === 'binding'
              ? this.prepareMaterialBindingValues(current, owned, contract.textures)
              : ok({ value: owned });
          },
        });
        if (result.ok) {
          const next = this.#runtime.borrow<MaterialAsset>(handle).unwrap();
          if (next !== current) {
            this.materialValueContracts.set(next, contract);
            const projection = this.materialPayloadProjections.get(current);
            if (projection !== undefined) this.materialPayloadProjections.set(next, projection);
          }
        }
        return result;
      }
    }
    return undefined;
  }

  /** Existing texture slots can keep the program contract and atomically transfer their holds. */
  private prepareMaterialBindingValues(
    current: MaterialAsset,
    patch: Record<string, unknown>,
    textures: ReadonlySet<string>,
  ): Result<{ value: Record<string, unknown>; dependencies: readonly number[] }, AssetError> {
    const linked = this.linkMaterial(
      {
        ...current,
        values: { ...current.values, ...patch } as Record<string, MaterialValue | null>,
      },
      this.#runtimeByGuid,
      textures,
    );
    if (!linked.ok) return linked;
    return ok({
      value: Object.fromEntries(
        Object.keys(patch).map((name) => [name, linked.value.value.values?.[name]]),
      ),
      dependencies: linked.value.dependencies,
    });
  }

  private prepareContentPatch(
    current: Asset,
    update: Record<string, unknown>,
  ): Result<{ asset: Asset; patch: Record<string, unknown> }, AssetError | MaterialError> {
    if ('kind' in update || 'parent' in update)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'runtime content with an unchanged kind and no source inheritance',
          hint: 'create an independent asset from source content, then edit its runtime fields',
        }),
      );
    if (current.kind === 'material' && 'values' in update) {
      if (
        update.values === null ||
        typeof update.values !== 'object' ||
        Array.isArray(update.values)
      )
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: 'named material values',
            hint: 'pass a material parameter patch',
          }),
        );
      update.values = { ...current.values, ...update.values };
    }
    if (current.kind === 'mesh') {
      const mesh = prepareRuntimeMeshPatch(current, update);
      if (!mesh.ok) return mesh;
      update = mesh.value as Record<string, unknown>;
    }
    const prepared = prepareRuntimeAsset({ ...current, ...update } as Asset, (guid) =>
      this.preparedSource(guid),
    );
    return prepared.ok ? ok({ asset: prepared.value, patch: update }) : prepared;
  }

  private prepareTilesetAssetPatch(
    asset: import('@forgeax/engine-types').TilesetAsset,
    update: Record<string, unknown>,
  ): Result<{ value: Record<string, unknown>; dependencies: readonly number[] }, AssetError> {
    const linked = linkRuntimeTileset(asset, this, (guid) => this.#runtimeByGuid.get(guid));
    return linked.ok
      ? ok({
          value: { ...update, atlases: linked.value.value.atlases },
          dependencies: linked.value.dependencies,
        })
      : linked;
  }

  private prepareFontAssetPatch(
    asset: import('@forgeax/engine-types').FontAsset,
    update: Record<string, unknown>,
  ): Result<{ value: Record<string, unknown>; dependencies: readonly number[] }, AssetError> {
    const linked = linkRuntimeFont(asset, this, (guid) => this.#runtimeByGuid.get(guid));
    return linked.ok
      ? ok({
          value: {
            ...update,
            atlas: linked.value.value.atlas,
            sampler: linked.value.value.sampler,
          },
          dependencies: linked.value.dependencies,
        })
      : linked;
  }

  private updateContent(
    handle: AssetHandle,
    patch: Readonly<Record<string, unknown>>,
  ): Result<void, AssetError | MaterialError> {
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
    if (kind.value === 'texture-generator') return this.updateTextureGeneratorGroup(handle, patch);
    const current = this.#runtime.borrow<Asset>(handle);
    if (!current.ok) return current;
    const derived = this.terrainDerivedWrite(current.value);
    if (derived !== undefined) return err(derived);
    if (requiresOwnerPreparation(kind.value))
      return this.#runtime.update(handle, patch, {
        // Preparation sees a complete, detached candidate and declares its exact
        // next references. Field patches never retain a stale dependency list.
        replace: true,
        prepare: (current, owned) =>
          this.prepareWithDecoder(kind.value, { ...current, ...owned }) as Result<
            { value: Record<string, unknown>; dependencies: readonly number[] },
            AssetError
          >,
      });
    if (current.value.kind === 'terrain') {
      const source = captureTerrainEdit(current.value, patch);
      if (!source.ok) return source;
      const adopted = this.createTerrainContent(source.value, handle as AssetHandle<'terrain'>);
      return adopted.ok ? ok(undefined) : adopted;
    }
    if (current.value.kind === 'material') {
      const values = this.updateMaterialValues(handle, current.value, patch);
      if (values !== undefined) return values;
    }
    let projection: MaterialRenderProjection | undefined;
    let textures: ReadonlySet<string> | undefined;
    const committed = this.#runtime.update(handle, patch, {
      prepare: (raw, update) => {
        const current = raw as unknown as Asset;
        const admitted = this.prepareContentPatch(current, update);
        if (!admitted.ok) return admitted;
        update = admitted.value.patch;
        const prepared = ok(admitted.value.asset);
        if (prepared.value.kind === 'tileset')
          return this.prepareTilesetAssetPatch(prepared.value, update);
        if (prepared.value.kind === 'font')
          return this.prepareFontAssetPatch(prepared.value, update);
        if (prepared.value.kind === 'terrain') {
          const checked = prepareRuntimeTerrain(prepared.value, this.#runtime, (guid) =>
            this.#runtimeByGuid.get(guid),
          );
          return checked.ok
            ? ok({ value: update, dependencies: checked.value.dependencies })
            : checked;
        }

        if (prepared.value.kind === 'animation-graph') {
          const linked = this.linkAnimationGraph(prepared.value);
          return linked.ok
            ? ok({
                value: { ...update, nodes: linked.value.value.nodes },
                dependencies: linked.value.dependencies,
              })
            : linked;
        }
        if (prepared.value.kind === 'scene') {
          const linked = this.linkScene(prepared.value);
          return linked.ok
            ? ok({
                value: { ...update, entities: linked.value.value.entities },
                dependencies: linked.value.dependencies,
              })
            : linked;
        }
        if (prepared.value.kind === 'mesh') {
          const linked = this.linkMesh(prepared.value);
          if (!linked.ok) return linked;
          return ok({
            value: {
              ...update,
              aabb: prepared.value.aabb,
              materialSlots: linked.value.value.materialSlots,
              ...(linked.value.value.lods === undefined ? {} : { lods: linked.value.value.lods }),
            },
            dependencies: linked.value.dependencies,
          });
        }
        if (prepared.value.kind === 'material') {
          projection = runtimeMaterialProgramProjection(
            current as MaterialAsset,
            prepared.value,
            this.materialPayloadProjections.get(raw),
          );
          try {
            assertMaterialStaticSelection(
              prepared.value.staticSwitches,
              projection,
              '<runtime-material>',
            );
            assertMaterialCookedParameters(prepared.value.parameters, projection);
          } catch (cause) {
            if (
              cause !== null &&
              typeof cause === 'object' &&
              'code' in cause &&
              cause.code === 'material-specialization-not-cooked'
            )
              return err(cause as MaterialError);
            throw cause;
          }
          const linked = this.linkMaterial(
            prepared.value,
            this.#runtimeByGuid,
            this.materialValueContracts.get(raw)?.textures,
          );
          if (!linked.ok) return linked;
          textures = linked.value.textures;
          update.values = linked.value.value.values;
          return ok({ value: update, dependencies: linked.value.dependencies });
        }
        return ok({ value: update });
      },
    });
    if (committed.ok && current.value.kind === 'material') {
      this.prepareMaterialValueContract(current.value, textures);
      if (projection === undefined) this.materialPayloadProjections.delete(current.value);
      else this.materialPayloadProjections.set(current.value, projection);
    }
    return committed;
  }

  /**
   * Update a complete attribute range without copying or validating untouched vertices.
   * A mesh range list (vertices, indices and attributes) commits at one revision.
   */
  writeRange(
    handle: AssetHandle<'mesh'>,
    range: MeshRange | readonly MeshRange[],
  ): Result<void, AssetError>;
  writeRange(handle: AssetHandle<'texture'>, range: TextureRegion): Result<void, AssetError>;
  writeRange(handle: AssetHandle<'terrain'>, range: TerrainHeightRange): Result<void, AssetError>;
  writeRange(
    handle: AssetHandle<'mesh'> | AssetHandle<'texture'> | AssetHandle<'terrain'>,
    range: MeshRange | readonly MeshRange[] | TextureRegion | TerrainHeightRange,
  ): Result<void, AssetError> {
    const current = this.#runtime.borrow<Asset>(handle);
    if (!current.ok) return current;
    const derived = this.terrainDerivedWrite(current.value);
    if (derived !== undefined) return err(derived);
    if (current.value.kind === 'terrain')
      return this.#runtime.writeRanges(
        handle,
        range as TerrainHeightRange,
        (value, captured, limits) =>
          prepareTerrainHeightRange(value, captured, this.#runtime, handle, limits),
      );
    if (current.value.kind === 'texture') {
      const committed = this.#runtime.writeRange(
        handle,
        range as TextureRegion,
        prepareRuntimeTextureRange,
      );
      return committed.ok ? this.refreshTextureGeneratorInputs(handle) : committed;
    }
    return Array.isArray(range)
      ? this.#runtime.writeRange(handle, range as readonly MeshRange[], prepareRuntimeMeshRanges)
      : this.#runtime.writeRange(handle, range as MeshRange, prepareRuntimeMeshRange);
  }

  snapshot(handle: AssetHandle) {
    return this.#runtime.snapshot(handle);
  }

  /** Read the current owned revision for an offline candidate's compare-and-replace guard. */
  revision(handle: AssetHandle): Result<number, AssetError> {
    return this.#runtime.version(handle);
  }

  /** Mesh storage charged to the Registry and to its fixed recovery artifact. */
  meshCpuResidency(handle: AssetHandle<'mesh'>) {
    return this.#runtime.meshCpuResidency(handle);
  }

  /** Replace complete content only when the target still has the captured revision. */
  replaceAtRevision<K extends string, P>(
    handle: AssetHandle<K, P>,
    expectedRevision: number,
    raw: P extends ParticleEffectAsset ? ParticleEffectInput : P,
  ): Result<void, AssetError | MaterialError> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'a non-negative safe integer revision captured before candidate work',
          hint: 'read registry.revision(handle) when freezing the source used by the candidate',
        }),
      );
    const current = this.#runtime.version(handle);
    if (!current.ok) return current;
    if (current.value !== expectedRevision)
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: `asset revision ${expectedRevision} before offline candidate publication`,
          hint: 'discard this stale candidate and retry from the currently published asset state',
        }),
      );
    return this.replace(handle, raw);
  }

  /** Atomically replace complete content while preserving the directly bound identity. */
  replace<K extends string, P>(
    handle: AssetHandle<K, P>,
    input: P extends ParticleEffectAsset ? ParticleEffectInput : P,
  ): Result<void, AssetError | MaterialError>;
  replace(handle: AssetHandle, raw: unknown): Result<void, AssetError | MaterialError> {
    const committed = this.replaceContent(handle, raw);
    return committed.ok ? this.refreshTextureGeneratorInputs(handle) : committed;
  }

  private replaceContent(
    handle: AssetHandle,
    raw: unknown,
  ): Result<void, AssetError | MaterialError> {
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
    const current = this.#runtime.borrow<Asset>(handle);
    if (!current.ok) return current;
    const derived = this.terrainDerivedWrite(current.value);
    if (derived !== undefined) return err(derived);
    if (kind.value === 'texture-generator') {
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !('kind' in raw) ||
        raw.kind !== 'texture-generator'
      )
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: 'an unchanged generator kind',
            hint: 'replace using a complete texture-generator payload',
          }),
        );
      const valid = validateTextureGenerator(raw, true);
      if (!valid.ok) return valid;
      const { kind: _kind, ...fields } = valid.value;
      return this.updateTextureGeneratorGroup(handle, fields);
    }
    if (requiresOwnerPreparation(kind.value)) {
      const replaced = this.#runtime.adopt(
        kind.value,
        raw,
        [],
        (owned) => this.prepareWithDecoder(kind.value, owned),
        handle,
      );
      return replaced.ok ? ok(undefined) : replaced;
    }
    const input = raw as Asset;
    if (current.value.kind === 'terrain') {
      if (input.kind !== 'terrain')
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: 'an unchanged asset kind',
            hint: 'create a new asset when changing its kind',
          }),
        );
      const result = this.createTerrainContent(
        input as TerrainInput,
        handle as AssetHandle<'terrain'>,
      );
      return result.ok ? ok(undefined) : result;
    }
    let projection: MaterialRenderProjection | undefined;
    let textures: ReadonlySet<string> | undefined;
    const committed = this.#runtime.update(handle, input as unknown as Record<string, unknown>, {
      replace: true,
      prepare: (current, captured) => {
        if (captured.kind !== current.kind)
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'an unchanged asset kind',
              hint: 'create a separate asset when changing its kind',
            }),
          );
        const prepared = prepareRuntimeAsset(captured as unknown as Asset, (guid) =>
          this.preparedSource(guid),
        );
        if (!prepared.ok) return prepared;
        const asset = prepared.value;
        const linked =
          asset.kind === 'tileset'
            ? linkRuntimeTileset(asset, this, (guid) => this.#runtimeByGuid.get(guid))
            : asset.kind === 'font'
              ? linkRuntimeFont(asset, this, (guid) => this.#runtimeByGuid.get(guid))
              : asset.kind === 'scene'
                ? this.linkScene(asset)
                : asset.kind === 'animation-graph'
                  ? this.linkAnimationGraph(asset)
                  : asset.kind === 'mesh'
                    ? this.linkMesh(asset)
                    : asset.kind === 'material'
                      ? this.linkMaterial(
                          asset,
                          this.#runtimeByGuid,
                          this.materialValueContracts.get(current)?.textures,
                        )
                      : asset.kind === 'terrain'
                        ? prepareRuntimeTerrain(asset, this.#runtime, (guid) =>
                            this.#runtimeByGuid.get(guid),
                          )
                        : ok({ value: asset, dependencies: [] as readonly number[] });
        if (!linked.ok) return linked;
        if ('textures' in linked.value) textures = linked.value.textures;
        if (asset.kind === 'material') {
          try {
            projection =
              this.prepareMaterialProgramProjection(input as MaterialAsset) ??
              runtimeMaterialProgramProjection(
                current as unknown as MaterialAsset,
                asset,
                this.materialPayloadProjections.get(current),
              );
            assertMaterialStaticSelection(asset.staticSwitches, projection, '<runtime-material>');
            assertMaterialCookedParameters(asset.parameters, projection);
          } catch (cause) {
            if (
              cause !== null &&
              typeof cause === 'object' &&
              'code' in cause &&
              cause.code === 'material-specialization-not-cooked'
            )
              return err(cause as MaterialError);
            throw cause;
          }
        }
        return ok({
          value: linked.value.value as unknown as Record<string, unknown>,
          dependencies: linked.value.dependencies,
        });
      },
    });
    if (committed.ok) {
      const accepted = this.#runtime.borrow<Asset>(handle).unwrap();
      if (accepted.kind === 'material') {
        this.prepareMaterialValueContract(accepted, textures);
        if (projection === undefined) this.materialPayloadProjections.delete(accepted);
        else this.materialPayloadProjections.set(accepted, projection);
      }
    }
    return committed;
  }

  observe() {
    return this.#runtime.observe();
  }

  /** Load into this owner's identity space. Repeated source loads retain gameplay edits. */
  load<K extends BuiltinAssetKind>(
    guid: AssetGuid | string,
    kind: K,
    options?: AssetLoadOptions,
  ): Promise<Result<AssetHandle<K>, RuntimeAssetError>>;
  load<P, K extends string>(
    guid: AssetGuid | string,
    kind: AssetKind<P, K>,
    options?: AssetLoadOptions,
  ): Promise<Result<AssetHandle<K, P>, RuntimeAssetError>>;
  async load(
    guid: AssetGuid | string,
    kind: BuiltinAssetKind | AssetKind<unknown, string>,
    options: AssetLoadOptions = {},
  ): Promise<Result<AssetHandle, RuntimeAssetError>> {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const expectedKind = typeof kind === 'string' ? kind : kind.kind;
    if (this.#disposed)
      return err(
        new AssetError({
          code: 'asset-owner-closed',
          expected: 'a live asset owner',
          hint: ASSET_ERROR_HINTS['asset-owner-closed'],
        }),
      );
    if (options.signal?.aborted) return err(assetLoadCancelled(key));
    const existing = this.#runtimeByGuid.get(key);
    if (existing !== undefined) {
      const held = this.#runtime.retain(existing, expectedKind);
      return held.ok ? this.finishMeshLoad(key, existing, options) : held;
    }
    const parsed =
      typeof guid === 'string' ? AssetGuid.parse(guid) : { ok: true as const, value: guid };
    if (!parsed.ok)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'a valid source GUID',
          hint: parsed.error.hint,
        }),
      );
    const source = this.#source;
    if (source === undefined) return catalogSourceUnconfigured();
    // One unit of `assets` load work per new GUID load, settled on every outcome.
    const finishLoadWork = beginLoadWork('assets', expectedKind);
    try {
      const loaded = await source.withDecodedClosure(key, () =>
        this.loadSource(source, key, kind, expectedKind, options),
      );
      return loaded.ok ? await this.finishMeshLoad(key, loaded.value, options) : loaded;
    } finally {
      finishLoadWork();
    }
  }

  private async finishMeshLoad(
    guid: string,
    handle: AssetHandle,
    options: AssetLoadOptions,
  ): Promise<Result<AssetHandle, RuntimeAssetError>> {
    if (options.signal?.aborted) {
      this.#runtime.release(handle);
      return err(assetLoadCancelled(guid));
    }
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
    if (options.usage === 'render' && kind.value === 'mesh') {
      const prepared = await this.waitForMeshPresentation(
        guid,
        handle as AssetHandle<'mesh'>,
        options.signal,
      );
      if (prepared.ok) return this.liveLoadGrant(handle);
      this.#runtime.release(handle);
      return prepared;
    }
    const scene =
      kind.value === 'scene' && options.usage === 'render'
        ? this.#runtime.borrow<SceneAsset>(handle).unwrap()
        : undefined;
    const renderMeshes = scene === undefined ? undefined : this.#sceneRenderMeshes.get(scene);
    const restores = this.requireMeshCpuClosure(handle, options.signal, renderMeshes);
    for (const mesh of renderMeshes ?? []) {
      const origin = this.#runtimeGuids.get(mesh as AssetHandle);
      if (origin !== undefined)
        restores.push(
          this.waitForMeshPresentation(origin.guid, mesh as AssetHandle<'mesh'>, options.signal),
        );
    }
    if (restores.length === 0) return ok(handle);
    const recovery = Promise.all(restores).then(
      (results) => results.find((result) => !result.ok) ?? ok(undefined),
    );
    const result =
      options.signal === undefined
        ? await recovery
        : await waitForAsset(recovery, options.signal, guid);
    if (result.ok) return this.liveLoadGrant(handle);
    this.#runtime.release(handle);
    return result;
  }

  private liveLoadGrant(handle: AssetHandle): Result<AssetHandle, AssetError> {
    const live = this.#runtime.validate(handle);
    return live.ok ? ok(handle) : live;
  }

  private requireMeshCpuClosure(
    root: AssetHandle,
    signal?: AbortSignal,
    renderMeshes?: ReadonlySet<number>,
  ): Promise<Result<void, RuntimeAssetError>>[] {
    const pending = new Set<AssetHandle>([root]);
    const restores: Promise<Result<void, RuntimeAssetError>>[] = [];
    for (const handle of pending) {
      const presentation = renderMeshes?.has(handle)
        ? undefined
        : this.#runtime.requireMeshCpu(handle);
      if (presentation !== undefined)
        restores.push(this.restoreMeshPresentation(handle, presentation, 'cpu-required', signal));
      for (const dependency of this.#runtime.dependencies(handle).unwrap())
        pending.add(dependency as AssetHandle);
    }
    return restores;
  }

  private async waitForMeshPresentation(
    guid: string,
    handle: AssetHandle<'mesh'>,
    signal?: AbortSignal,
  ): Promise<Result<void, RuntimeAssetError>> {
    if (signal?.aborted) return err(assetLoadCancelled(guid));
    let pending = this.#meshPreparations.get(handle);
    if (pending === undefined) {
      if (!this.#runtime.canPresentMesh(handle)) {
        const existing = this.#runtime.meshPresentation(handle);
        return existing !== undefined && !existing.lease.isCurrent()
          ? this.restoreMeshPresentation(handle, existing, 'render-recovery', signal)
          : ok(undefined);
      }
      const controller = new AbortController();
      const result = Promise.resolve()
        .then(() => this.prepareMeshPresentation(guid, handle, controller.signal))
        .finally(() => this.#meshPreparations.delete(handle));
      pending = { controller, result, waiters: 0 };
      this.#meshPreparations.set(handle, pending);
    }
    if (pending.controller.signal.aborted) {
      const settled = await (signal === undefined
        ? pending.result
        : waitForAsset(pending.result, signal, guid));
      if (signal?.aborted) return settled;
      return this.waitForMeshPresentation(guid, handle, signal);
    }
    pending.waiters++;
    try {
      return await (signal === undefined
        ? pending.result
        : waitForAsset(pending.result, signal, guid));
    } finally {
      if (--pending.waiters === 0) pending.controller.abort();
    }
  }

  private async prepareMeshPresentation(
    guid: string,
    handle: AssetHandle<'mesh'>,
    signal: AbortSignal,
  ): Promise<Result<void, RuntimeAssetError>> {
    const revision = this.#runtime.version(handle);
    if (!revision.ok) return revision;
    if (signal.aborted) return err(assetLoadCancelled(guid));
    const reason = await this.tryPresentMesh(guid, handle, revision.value, signal);
    if (!reason.ok) return reason;
    if (reason.value !== undefined && !signal.aborted)
      this.#runtime.noteMeshCpuFallback(handle, revision.value, reason.value);
    return ok(undefined);
  }

  private async tryPresentMesh(
    guid: string,
    handle: AssetHandle<'mesh'>,
    revision: number,
    signal: AbortSignal,
  ): Promise<Result<MeshCpuFallback | undefined, RuntimeAssetError>> {
    const present = this.#runtime.meshPresenter;
    if (present === undefined) return ok(this.#runtime.meshReceiverFallback());
    if (!this.#runtime.meshPresenterReady) return ok('render-not-ready');
    const origin = this.meshPresentationOrigin(handle, revision);
    if (!origin.ok) return ok(origin.error);
    const { source, publication, decoderIdentity, mesh, bytes } = origin.value;
    const body = this.#ownedMeshBodies.get(mesh);
    const retained = await source
      .retainMeshArtifact(guid, publication, decoderIdentity, signal, body)
      .catch(() => err('source-unavailable' as const));
    if (!retained.ok) return ok(retained.error);
    const fixed = retained.value;
    let accepted = false;
    let physical: MeshPresentationLease | undefined;
    let handoff: MeshPresentation | undefined;
    let sent = false;
    let preparing = true;
    const current = () =>
      this.#runtime.version(handle).ok &&
      this.#runtime.version(handle).unwrap() === revision &&
      this.#source === source &&
      this.#runtime.meshPresenter === present &&
      !signal.aborted;
    const presentation = (
      lease: MeshPresentationLease,
      ownership: 'transfer' | 'copy',
    ): MeshPresentation => ({
      handoff: ownership,
      bytes: fixed.bytes,
      storage: fixed.storage,
      read: fixed.read,
      lease,
      release() {
        fixed.release();
        this.lease.release();
      },
    });
    const prepare = async (): Promise<MeshCpuFallback | undefined> => {
      if (!current()) return this.#runtime.meshReceiverFallback();
      const result = await present(
        handle,
        revision,
        {
          bytes,
          capture: () => {
            if (!current() || !this.#runtime.canPresentMesh(handle))
              throw new Error('Mesh presentation changed before its reserved capture');
            if (body !== undefined && this.#runtime.canTransferMesh) {
              const pending = presentation(
                { isCurrent: () => preparing, release() {} },
                'transfer',
              );
              if (this.#runtime.retainMeshPresentation(handle, revision, pending)) {
                handoff = pending;
                this.#ownedMeshBodies.delete(mesh);
                return mesh;
              }
            }
            return this.#runtime.read<TypesMeshAsset>(handle).unwrap();
          },
          sent: () => {
            sent = true;
          },
        },
        signal,
      );
      if (!result.ok) return result.error;
      physical = result.value;
      if (!current() || !physical.isCurrent()) return this.#runtime.meshReceiverFallback();
      accepted =
        handoff !== undefined
          ? this.#runtime.rebindMeshPresentation(handle, handoff, physical)
          : this.#runtime.retainMeshPresentation(handle, revision, presentation(physical, 'copy'));
      if (accepted && handoff === undefined) fixed.releaseDecodedSource();
      return accepted ? undefined : 'render-preparation-failed';
    };
    const reason = await prepare().catch(() => 'render-preparation-failed' as const);
    preparing = false;
    if (accepted) return ok(reason);
    physical?.release();
    const pending = handoff as MeshPresentation | undefined;
    if (pending === undefined) fixed.release();
    else if (
      this.#runtime.meshPresentation(handle) === pending &&
      (sent || !this.#runtime.cancelMeshHandoff(handle, pending, mesh))
    ) {
      if (signal.aborted) {
        if (this.#runtimeByGuid.get(guid) === handle) this.unload(guid);
      } else {
        const restored = await this.restoreMeshPresentation(handle, pending, 'render-recovery');
        if (!restored.ok && this.#runtime.meshPresentation(handle) === pending) return restored;
      }
    }
    return ok(reason);
  }

  private meshPresentationOrigin(handle: AssetHandle<'mesh'>, revision: number) {
    const source = this.#source;
    const origin = this.#runtimeGuids.get(handle);
    if (!source || origin?.source !== source || !origin.publication || origin.revision !== revision)
      return err('source-unavailable' as const);
    const mesh = this.#runtime.borrowMeshForPresentation(handle);
    if (!mesh.ok || !isStandaloneStaticMesh(mesh.value)) return err('unsupported-mesh' as const);
    return ok({
      source,
      publication: origin.publication,
      decoderIdentity: origin.decoderIdentity,
      mesh: mesh.value,
      bytes: assetDataBytes(mesh.value, undefined, 'copy'),
    });
  }

  /** A new receiver can publish current assets again from their exact source. */
  async recoverMeshPresentations(): Promise<void> {
    for (const handle of this.#runtime.meshPresentationsForReceiver()) {
      const presentation = this.#runtime.meshPresentation(handle);
      if (presentation === undefined) continue;
      if (await this.reprepareMeshPresentation(handle as AssetHandle<'mesh'>, presentation))
        continue;
      if (this.#runtime.meshPresentation(handle) !== presentation) continue;
      const reason =
        this.#runtime.meshReceiverFallback() === 'multiple-render-receivers'
          ? 'multiple-render-receivers'
          : 'render-recovery';
      const restored = await this.restoreMeshPresentation(
        handle as AssetHandle,
        presentation,
        reason,
      );
      if (!restored.ok && this.#runtime.meshPresentation(handle) === presentation)
        throw restored.error;
    }
    if (!this.#runtime.meshPresenterReady) return;
    await Promise.all(
      this.#runtime.deferredMeshPresentations().map(async (handle) => {
        const mesh = handle as AssetHandle<'mesh'>;
        const origin = this.#runtimeGuids.get(mesh);
        if (origin === undefined) return;
        const prepared = await this.waitForMeshPresentation(origin.guid, mesh);
        if (!prepared.ok) throw prepared.error;
      }),
    );
  }

  private async reprepareMeshPresentation(
    handle: AssetHandle<'mesh'>,
    presentation: MeshPresentation,
  ): Promise<boolean> {
    const present = this.#runtime.meshPresenter;
    if (present === undefined) return false;
    try {
      const mesh = await this.readMeshPresentation(
        presentation,
        this.#runtime.canTransferMesh ? 'render-transfer' : undefined,
      );
      if (!mesh.ok) return false;
      const restored = this.#runtime.restoreMeshReferences(handle, presentation, mesh.value);
      const current = this.#runtime.version(handle);
      if (!restored.ok || !current.ok) return false;
      const result = await present(handle, current.value, {
        bytes: assetDataBytes(restored.value, undefined, 'receive'),
        capture: () => {
          if (
            this.#runtime.meshPresentation(handle) !== presentation ||
            this.#runtime.meshPresenter !== present
          )
            throw new Error('Mesh recovery changed before its reserved capture');
          return restored.value;
        },
      });
      if (!result.ok) return false;
      const lease = result.value;
      if (
        this.#runtime.meshPresenter === present &&
        this.#runtime.rebindMeshPresentation(handle, presentation, lease)
      )
        return true;
      lease.release();
    } catch {
      // Recovery can still attempt the full CPU representation.
    }
    return false;
  }

  private async readMeshPresentation(
    presentation: MeshPresentation,
    meshStorage?: 'render-transfer',
  ): Promise<Result<TypesMeshAsset, RuntimeAssetError>> {
    try {
      const restored = prepareRuntimeAsset(
        await presentation.read(),
        (guid) => this.runtimeSource(guid),
        meshStorage,
      );
      if (!restored.ok) return restored;
      if (restored.value.kind !== 'mesh') throw new TypeError('expected restored Mesh');
      return ok(restored.value);
    } catch (cause) {
      return err(
        new AssetError({
          code: 'asset-not-ready',
          expected: 'the exact retained Mesh artifact to decode',
          hint: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }

  private restoreMeshPresentation(
    handle: AssetHandle,
    presentation: MeshPresentation,
    reason: MeshCpuRequirement,
    signal?: AbortSignal,
  ): Promise<Result<void, RuntimeAssetError>> {
    const pending = this.#meshRestores.get(presentation);
    if (pending !== undefined) {
      if (!pending.waiters.has(signal)) pending.waiters.set(signal, reason);
      return pending.result;
    }
    const waiters = new Map([[signal, reason]]);
    const result = Promise.resolve().then(async () => {
      try {
        const restored = await this.readMeshPresentation(presentation);
        if (!restored.ok) return restored;
        for (const [waitingSignal, requirement] of waiters) {
          if (!waitingSignal?.aborted)
            return this.#runtime.restoreMeshCpu(handle, presentation, restored.value, requirement);
        }
        // Every wait already returned cancellation. Discard the decoded candidate.
        return ok(undefined);
      } finally {
        this.#meshRestores.delete(presentation);
      }
    });
    this.#meshRestores.set(presentation, { waiters, result });
    return result;
  }

  /** Load a finite roster serially, sharing Pack verification only until this
   * operation settles. Each returned entry owns one grant, including duplicates.
   * Failure releases every earlier grant and admits no further read. */
  loadMany<K extends BuiltinAssetKind>(
    guids: readonly (AssetGuid | string)[],
    kind: K,
    options?: AssetBatchLoadOptions,
  ): Promise<Result<AssetHandle<K>[], RuntimeAssetError>>;
  loadMany<P, K extends string>(
    guids: readonly (AssetGuid | string)[],
    kind: AssetKind<P, K>,
    options?: AssetBatchLoadOptions,
  ): Promise<Result<AssetHandle<K, P>[], RuntimeAssetError>>;
  async loadMany(
    guids: readonly (AssetGuid | string)[],
    kind: BuiltinAssetKind | AssetKind<unknown, string>,
    options: AssetBatchLoadOptions = {},
  ): Promise<Result<AssetHandle[], RuntimeAssetError>> {
    const source = this.#source;
    const readScope = source?.openLoadScope();
    const scoped = { ...options, readScope };
    const handles: AssetHandle[] = [];
    const sourceChanged = () =>
      err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: 'the same asset source until batch completion',
          hint: 'load again from the current source',
        }),
      );
    let completed = false;
    try {
      for (const guid of guids) {
        if (this.#source !== source) return sourceChanged();
        const result =
          typeof kind === 'string'
            ? await this.load(guid, kind, scoped)
            : await this.load(guid, kind, scoped);
        if (!result.ok) return result;
        handles.push(result.value);
        if (!options.signal?.aborted && options.onProgress)
          await options.onProgress(handles.length, guids.length);
        if (options.signal?.aborted)
          return err(assetLoadCancelled(typeof guid === 'string' ? guid : AssetGuid.format(guid)));
        if (this.#source !== source) return sourceChanged();
      }
      completed = true;
      return ok(handles);
    } finally {
      readScope?.clear();
      if (!completed) for (const handle of handles.reverse()) this.release(handle);
    }
  }

  private async loadSource(
    source: AssetSource,
    key: string,
    kind: BuiltinAssetKind | AssetKind<unknown, string>,
    expectedKind: string,
    options: AssetLoadOptions,
  ): Promise<Result<AssetHandle, RuntimeAssetError>> {
    const loaded =
      typeof kind === 'string'
        ? await source.load(key, kind, options)
        : await source.load(key, kind, options);
    if (!loaded.ok) return loaded;
    if (options.signal?.aborted) return err(assetLoadCancelled(key));
    if (this.#source !== source)
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: 'the same asset source until load adoption',
          hint: 'load again from the current source',
        }),
      );
    const adopted = await this.ingestSource(source, key, options);
    if (!adopted.ok) return adopted;
    if (options.signal?.aborted) return err(assetLoadCancelled(key));
    const held = this.#runtime.retain(adopted.value, expectedKind);
    return held.ok ? adopted : held;
  }

  /** Read independently owned published CPU geometry without render admission.
   * Material/LOD readiness and runtime-edited content still require load/read. */
  async readMeshGeometry(
    guid: AssetGuid | string,
    options: AssetLoadOptions = {},
  ): Promise<Result<MeshGeometry, RuntimeAssetError>> {
    if (this.#disposed)
      return err(
        new AssetError({
          code: 'asset-owner-closed',
          expected: 'a live asset owner',
          hint: ASSET_ERROR_HINTS['asset-owner-closed'],
        }),
      );
    const source = this.#source;
    if (source === undefined) return catalogSourceUnconfigured();
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const finish = beginLoadWork('assets', 'mesh-geometry');
    try {
      const request = source.readMeshGeometry(key, options);
      const read = await (options.signal === undefined
        ? request
        : waitForAsset(request, options.signal, key));
      if (this.#disposed || this.#source !== source)
        return err(
          new AssetError({
            code: this.#disposed ? 'asset-owner-closed' : 'asset-write-conflict',
            expected: 'the same live source until geometry read completes',
            hint: 'retry from the current asset owner',
          }),
        );
      return read;
    } finally {
      finish();
    }
  }

  /** Explicitly adopt the current source closure without changing any existing identity. */
  async reload<K extends string, P>(
    handle: AssetHandle<K, P>,
    options: AssetReloadOptions,
  ): Promise<Result<void, RuntimeAssetError>> {
    const valid = this.#runtime.validate(handle);
    if (!valid.ok) return valid;
    const origin = this.#runtimeGuids.get(handle);
    if (origin === undefined)
      return err(
        new AssetError({
          code: 'asset-reference-invalid',
          expected: 'a source-loaded runtime asset',
          hint: 'replace code-created assets directly; only loaded assets have a source to reload',
        }),
      );
    if (options.conflict !== 'reject' && options.conflict !== 'overwrite')
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'an explicit reject or overwrite source conflict policy',
          hint: 'choose whether this reload may replace existing gameplay edits',
        }),
      );
    const source = this.#source;
    if (source === undefined) return catalogSourceUnconfigured();
    const policy: SourceAdoption = {
      started: this.#runtime.currentRevision,
      conflict: options.conflict,
      handle,
    };
    return source.withDecodedClosure(origin.guid, async () => {
      const loaded = await source.load(origin.guid, defineAssetKind(origin.kind), {
        ...options,
        refresh: true,
      });
      if (!loaded.ok) return loaded;
      const adopted = await this.ingestSource(source, origin.guid, options, policy);
      return adopted.ok ? ok(undefined) : adopted;
    });
  }

  private async prepareDecodedMaterialTemplate(
    template: DecodedMaterialTemplate,
    generation: number,
  ): Promise<Result<MaterialRenderProjection, AssetError>> {
    const prepared = await this.shaderRegistry.prepareMaterialTemplate({
      guid: template.publication.guid,
      material: template.publication.resolved,
      sources: template.sources,
    });
    if (!prepared.ok)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: prepared.error.expected,
          hint: `${prepared.error.hint} (${prepared.error.message})`,
        }),
      );
    return ok(
      projectMaterialTemplate(
        template,
        generation,
        prepared.value,
        this.shaderRegistry,
        this.materialArtifactRegistry,
      ),
    );
  }

  /** Admit decoded shader inputs before opening the source-ingestion transaction. */
  private async prepareSourceIngestion(
    source: AssetSource,
    root: string,
    options: AssetLoadOptions,
    policy: SourceAdoption | undefined,
  ): Promise<Result<SourceIngestionOperation, RuntimeAssetError>> {
    const visited = new Map<string, symbol>();
    const programReferences = new Set<string>();
    const prepared: {
      material: MaterialAsset;
      record: MaterialReady['record'] | SourceMaterialPayload['cooked'];
    }[] = [];
    const templates: {
      readonly material: MaterialAsset;
      readonly template: DecodedMaterialTemplate;
      readonly generation: number;
    }[] = [];
    const visit = (guid: string): Result<void, RuntimeAssetError> => {
      const key = guid.toLowerCase();
      if (visited.has(key)) return ok(undefined);
      const entry = source.entry(key);
      if (entry === undefined) return source.checkCurrent(key);
      visited.set(key, entry.identity);
      if (entry.references === 'eager')
        for (const ref of entry.refs) {
          const child = visit(ref);
          if (!child.ok) return child;
        }
      if (entry.kind !== 'material') return ok(undefined);
      const material = entry.value as MaterialAsset & {
        readonly cooked?: MaterialReady['record'] | SourceMaterialPayload['cooked'];
        readonly materialTemplate?: DecodedMaterialTemplate;
      };
      if (this.materialPayloadProjections.has(material)) return ok(undefined);
      // The Material decoder owns the complete immutable Cook record. Source adoption
      // checks its live closure and installs those facts without rehashing shader bytes.
      const record = material.cooked;
      const template = material.materialTemplate;
      const refs = record?.refs ?? template?.publication.refs;
      if (refs === undefined) return ok(undefined);
      for (const reference of [
        ...refs.parent,
        ...refs.textures,
        ...refs.samplers,
        ...refs.modules,
      ]) {
        if (AssetGuid.parse(reference).ok) programReferences.add(reference.toLowerCase());
      }
      if (record !== undefined) prepared.push({ material, record });
      if (template !== undefined)
        templates.push({ material, template, generation: entry.publication.generation });
      return ok(undefined);
    };
    const loaded = visit(root);
    if (!loaded.ok) return loaded;
    const templatePreparations =
      templates.length === 0
        ? []
        : await Promise.all(
            templates.map(async (candidate) => ({
              ...candidate,
              prepared: await this.prepareDecodedMaterialTemplate(
                candidate.template,
                candidate.generation,
              ),
            })),
          );
    if (options.signal?.aborted) return err(assetLoadCancelled(root));
    if (this.#disposed || this.#source !== source)
      return err(
        new AssetError({
          code: this.#disposed ? 'asset-owner-closed' : 'asset-write-conflict',
          expected: 'the same live asset source until program admission',
          hint: 'load from the current asset owner',
        }),
      );
    const current = this.checkPreparedSourcePrograms(source, visited, programReferences);
    if (!current.ok) return current;
    for (const { prepared } of templatePreparations) if (!prepared.ok) return prepared;
    for (const { material, prepared } of templatePreparations) {
      if (!this.materialPayloadProjections.has(material))
        this.materialPayloadProjections.set(material, prepared.unwrap());
    }
    for (const { material, record } of prepared) {
      if (!this.materialPayloadProjections.has(material))
        this.installMaterialProjection(
          material,
          record,
          (guid) => source.entry(guid)?.value as Asset | undefined,
        );
    }
    return this.beginSourceIngestion(source, root, options, policy);
  }

  private checkPreparedSourcePrograms(
    source: AssetSource,
    entries: ReadonlyMap<string, symbol>,
    programReferences: ReadonlySet<string>,
  ): Result<void, RuntimeAssetError> {
    for (const [guid, identity] of entries)
      if (source.entry(guid)?.identity !== identity) return this.ingestionContextFailure();
    return source.checkCurrentMany(new Set([...entries.keys(), ...programReferences]));
  }

  private sourceContentKey(
    guid: string,
    entries: ReadonlyMap<string, SourceIngestionEntry>,
  ): string | undefined {
    const inputs: string[] = [],
      visited = new Set<string>();
    let key = guid;
    for (;;) {
      const entry = entries.get(key);
      if (entry === undefined || visited.has(key)) return undefined;
      visited.add(key);
      inputs.push(key, entry.digest, ...entry.refs);
      if (entry.programKey !== undefined) inputs.push(entry.programKey);
      if (entry.parent === undefined) return JSON.stringify(inputs);
      key = entry.parent;
    }
  }

  private runtimeSource(guid: string): Asset | undefined {
    const handle = this.#runtimeByGuid.get(guid.toLowerCase());
    if (handle !== undefined) {
      const content = this.#runtime.borrow<Asset>(handle);
      if (content.ok) return content.value;
    }
    return this.preparedSource(guid);
  }

  private preparedSource(guid: string): Asset | undefined {
    return this.#source?.entry(guid.toLowerCase())?.value as Asset | undefined;
  }

  private ingestSource(
    source: AssetSource,
    key: string,
    options: AssetLoadOptions,
    policy?: SourceAdoption,
  ): Promise<Result<AssetHandle, RuntimeAssetError>> {
    const queued = this.ingestionQueue.then(async () => {
      if (options.signal?.aborted) return err(assetLoadCancelled(key));
      if (this.#disposed || this.#source !== source) return this.ingestionContextFailure();
      const existing = this.#runtimeByGuid.get(key);
      if (policy !== undefined && existing !== policy.handle)
        return err(
          new AssetError({
            code: 'asset-invalidated',
            expected: 'the same loaded asset identity until reload adoption',
            hint: 'load again after unloading the previous identity',
          }),
        );
      if (existing !== undefined && policy === undefined) return ok(existing);
      return this.runSourceIngestion(source, key, options, policy);
    });
    // A rejected operation never poisons later queued loads. I/O was already concurrent.
    this.ingestionQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return options.signal === undefined ? queued : waitForAsset(queued, options.signal, key);
  }

  private ingestionContextFailure(): Result<never, AssetError> {
    return err(
      new AssetError({
        code: this.#disposed ? 'asset-owner-closed' : 'asset-write-conflict',
        expected: 'the same live source until ingestion',
        hint: 'load from the current asset owner',
      }),
    );
  }

  private sourceRenderMeshes(key: string, inputs: SourceIngestionInputs): Set<string> {
    const entry = inputs.entries.get(key);
    if (entry?.kind === 'mesh') return new Set([key]);
    if (entry?.kind !== 'scene') return new Set();
    const scene = inputs.borrow(key).unwrap().value as SceneAsset;
    if (Object.values(scene.entities).some((entity) => entity.instance !== undefined))
      return new Set();
    const components = new Map<string, Component>();
    for (const [name, component] of inputs.schemas) {
      if (component === undefined) return new Set();
      components.set(name, component);
    }
    const draw = new Set<string>();
    const other = new Set<string>();
    for (const field of extractSceneEntityHandleGuids(components, scene.entities, entry.refs)) {
      const guid = field.guidString.toLowerCase();
      if (field.componentName === 'MeshFilter' && field.fieldName === 'assetHandle') draw.add(guid);
      else other.add(guid);
    }
    for (const [guid, descendant] of inputs.entries)
      if (guid !== key) for (const ref of descendant.inputReferences) other.add(ref);
    return new Set(
      [...draw].filter((guid) => !other.has(guid) && inputs.entries.get(guid)?.kind === 'mesh'),
    );
  }

  private beginSourceIngestion(
    source: AssetSource,
    key: string,
    options: AssetLoadOptions,
    policy: SourceAdoption | undefined,
  ): Result<SourceIngestionOperation, RuntimeAssetError> {
    const captured = captureSourceIngestionInputs(
      source,
      this.#decoders,
      key,
      (guid) => this.#runtimeByGuid.get(guid),
      (name) => this.#world?.components.resolve(name) ?? this.componentCatalog.get(name),
      (asset) => this.materialPayloadProjections.get(asset)?.specializationKey,
    );
    if (!captured.ok) return captured;
    const inputs = captured.value;
    const candidate = this.#runtime.beginAdoption(
      undefined,
      policy?.started ?? this.#runtime.currentRevision,
    );
    if (!candidate.ok) {
      inputs.dispose();
      return candidate;
    }
    const contentKeys = new Map<string, string | undefined>();
    for (const guid of inputs.entries.keys())
      contentKeys.set(guid, this.sourceContentKey(guid, inputs.entries));
    const operation: SourceIngestionOperation = {
      root: key,
      source,
      inputs,
      records: candidate.value,
      staged: new Map(),
      visiting: new Set(),
      contentKeys,
      ownedMeshes: new Map(),
      renderMeshes:
        options.usage === 'render' && policy === undefined
          ? this.sourceRenderMeshes(key, inputs)
          : new Set(),
      signal: options.signal,
      policy,
      failure: undefined,
      committed: false,
      steps: undefined,
    };
    this.ingestions.add(operation);
    return ok(operation);
  }

  private checkSourceIngestion(
    operation: SourceIngestionOperation,
  ): Result<void, RuntimeAssetError> {
    if (operation.failure !== undefined) return err(operation.failure);
    if (this.#disposed || this.#source !== operation.source) return this.ingestionContextFailure();
    if (operation.signal?.aborted && !operation.committed)
      return err(assetLoadCancelled(operation.root));
    return operation.inputs.validate();
  }

  private ingestionGuard(operation: SourceIngestionOperation): Result<void, AssetError> {
    const current = this.checkSourceIngestion(operation);
    if (current.ok) return current;
    operation.failure = current.error;
    return err(
      current.error instanceof AssetError
        ? current.error
        : new AssetError({
            code: 'asset-write-conflict',
            expected: current.error.expected,
            hint: current.error.hint,
          }),
    );
  }

  private advanceSourceIngestion(
    operation: SourceIngestionOperation,
    steps: Generator<void, Result<AssetHandle, RuntimeAssetError>>,
  ): IteratorResult<void, Result<AssetHandle, RuntimeAssetError>> {
    const before = this.checkSourceIngestion(operation);
    if (!before.ok) return { done: true, value: before };
    const next = steps.next();
    const after = this.checkSourceIngestion(operation);
    return after.ok ? next : { done: true, value: after };
  }

  private commitSourceIngestion(
    operation: SourceIngestionOperation,
  ): Result<void, RuntimeAssetError> {
    const current = this.checkSourceIngestion(operation);
    if (!current.ok) return current;
    // Provenance descriptors are built from captured facts before the first public write.
    const origins = new Map<string, Omit<AdoptedAssetSource, 'revision'>>();
    for (const guid of operation.staged.keys()) {
      const entry = operation.inputs.entries.get(guid);
      if (entry === undefined) throw new Error('Ingestion lost its captured source');
      origins.set(guid, {
        guid,
        kind: entry.kind,
        source: operation.source,
        publication: entry.publication,
        contentKey: operation.contentKeys.get(guid),
        decoderIdentity: entry.decoderIdentity,
      });
    }
    // Another closure can start during an ingestion yield. In that case keep
    // its decoded storage intact and commit our own ordinary copy.
    for (const [guid, entry] of operation.ownedMeshes) {
      if (operation.source.canTakeMesh(operation.root, guid, entry)) continue;
      const handle = operation.staged.get(guid);
      if (handle === undefined) throw new Error('Ingestion lost its staged Mesh');
      const detached = operation.records.copyStagedMesh(handle);
      if (!detached.ok) return detached;
      operation.ownedMeshes.delete(guid);
    }
    const committed = operation.records.commit();
    if (!committed.ok) return err(operation.failure ?? committed.error);
    operation.committed = true;
    try {
      for (const [guid, handle] of operation.staged) {
        const origin = origins.get(guid) as Omit<AdoptedAssetSource, 'revision'>;
        const previous = this.#runtimeGuids.get(handle);
        const revision = this.#runtime.version(handle).unwrap();
        this.#runtimeByGuid.set(guid, handle);
        this.#runtimeGuids.set(handle, {
          ...origin,
          decoderIdentity:
            previous?.revision === revision ? previous.decoderIdentity : origin.decoderIdentity,
          revision,
        });
        const ownedMesh = operation.ownedMeshes.get(guid)?.meshBody;
        if (ownedMesh !== undefined) {
          this.#ownedMeshBodies.set(
            this.#runtime.borrowMeshForPresentation(handle).unwrap(),
            ownedMesh,
          );
          operation.source.takeMesh(guid);
        }
        if (origin.kind === 'texture-generator') this.hasTextureGenerators = true;
      }
      if (operation.renderMeshes.size > 0) {
        const root = operation.staged.get(operation.root);
        if (root !== undefined && operation.inputs.entries.get(operation.root)?.kind === 'scene') {
          const scene = this.#runtime.borrow<SceneAsset>(root).unwrap();
          const meshes = new Set<number>();
          for (const guid of operation.renderMeshes) {
            const mesh = this.#runtimeByGuid.get(guid);
            if (mesh !== undefined) meshes.add(mesh);
          }
          this.#sceneRenderMeshes.set(scene, meshes);
        }
      }
    } catch (cause) {
      // Records have been published; a metadata fault requires owner termination.
      this.dispose();
      throw cause;
    }
    return ok(undefined);
  }

  private retireSourceIngestion(operation: SourceIngestionOperation): boolean {
    const next = operation.records.stepRetirement(1);
    if (!next.ok) {
      this.dispose();
      throw next.error;
    }
    return next.value.phase === 'retired' || next.value.phase === 'closed';
  }

  private async runSourceIngestion(
    source: AssetSource,
    key: string,
    options: AssetLoadOptions,
    policy: SourceAdoption | undefined,
  ): Promise<Result<AssetHandle, RuntimeAssetError>> {
    const started = await this.prepareSourceIngestion(source, key, options, policy);
    if (!started.ok) return started;
    const operation = started.value;
    const steps = this.adoptSourceSteps(key, operation);
    operation.steps = steps;
    let result: Result<AssetHandle, RuntimeAssetError>;
    let slice = loadTimelineNow();
    try {
      for (;;) {
        const next = this.advanceSourceIngestion(operation, steps);
        if (next.done) {
          result = next.value;
          break;
        }
        if (loadTimelineNow() - slice >= 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          slice = loadTimelineNow();
        }
      }
      if (result.ok) {
        const committed = this.commitSourceIngestion(operation);
        if (!committed.ok) result = committed;
      }
      return result;
    } catch (cause) {
      if (operation.records.inspect().phase === 'closed') {
        this.dispose();
        throw cause;
      }
      if (cause instanceof AssetError && !operation.committed)
        return err(operation.failure ?? cause);
      throw cause;
    } finally {
      steps.return(err(assetLoadCancelled(key)));
      operation.steps = undefined;
      operation.inputs.dispose();
      operation.visiting.clear();
      if (!operation.committed) operation.records.retire();
      let retired = false;
      slice = loadTimelineNow();
      while (!retired) {
        retired = this.retireSourceIngestion(operation);
        if (!retired && loadTimelineNow() - slice >= 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          slice = loadTimelineNow();
        }
      }
      this.ingestions.delete(operation);
    }
  }

  private sourceIngestionContent(
    operation: SourceIngestionOperation,
    guid: string,
    kind: Asset['kind'],
  ): Asset | undefined {
    const key = guid.toLowerCase();
    // Published inheritance is a source input, not a mutable runtime parent.
    if (kind === 'material' && operation.inputs.entries.has(key))
      return operation.inputs.borrow(key).unwrap().value as Asset;
    const handle =
      operation.staged.get(key) ??
      operation.inputs.selections.get(key) ??
      this.#runtimeByGuid.get(key);
    if (handle !== undefined) return operation.records.reader.borrow<Asset>(handle).unwrap();
    return operation.inputs.entries.has(key)
      ? (operation.inputs.borrow(key).unwrap().value as Asset)
      : undefined;
  }

  private *adoptSourceReferences(
    guid: string,
    operation: SourceIngestionOperation,
    dependencies: Set<number>,
    parents: Set<string>,
  ): Generator<void, Result<void, RuntimeAssetError>> {
    const entry = operation.inputs.entries.get(guid);
    if (entry === undefined)
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `captured source ${guid}`,
          hint: 'load the complete declared source closure',
        }),
      );
    if (entry.kind === 'plugin' || entry.references === 'deferred') return ok(undefined);
    const parent = entry.parent;
    for (const ref of entry.inputReferences) {
      if (ref === parent) continue;
      const child = yield* this.adoptSourceSteps(ref, operation);
      if (!child.ok) return child;
      dependencies.add(child.value);
    }
    if (parent !== undefined && !parents.has(parent)) {
      parents.add(parent);
      return yield* this.adoptSourceReferences(parent, operation, dependencies, parents);
    }
    return ok(undefined);
  }

  private sourceIngestionSelection(
    key: string,
    operation: SourceIngestionOperation,
  ): Result<
    { existing: AssetHandle | undefined; reuse: boolean; cached: boolean },
    RuntimeAssetError
  > {
    const existing = operation.inputs.selections.get(key);
    if (existing === undefined) return ok({ existing, reuse: false, cached: false });
    const revision = operation.records.reader.version(existing);
    if (!revision.ok) return revision;
    if (operation.policy === undefined) return ok({ existing, reuse: false, cached: true });
    const origin = this.#runtimeGuids.get(existing);
    if (
      revision.value > operation.policy.started ||
      (operation.policy.conflict === 'reject' && revision.value !== origin?.revision)
    )
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: `unchanged runtime content for source ${key} until adoption`,
          hint: 'inspect gameplay edits before explicitly reloading with overwrite',
        }),
      );
    const reuse =
      origin !== undefined &&
      origin.source === operation.source &&
      revision.value === origin.revision &&
      origin.contentKey !== undefined &&
      origin.contentKey === operation.contentKeys.get(key);
    return ok({ existing, reuse, cached: false });
  }

  private *adoptSourceSteps(
    key: string,
    operation: SourceIngestionOperation,
  ): Generator<void, Result<AssetHandle, RuntimeAssetError>> {
    const { staged, visiting, inputs } = operation;
    const prepared = staged.get(key);
    if (prepared !== undefined) return ok(prepared);
    yield;
    if (!inputs.entries.has(key))
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `captured source ${key}`,
          hint: 'load its verified source before ingestion',
        }),
      );
    const selected = this.sourceIngestionSelection(key, operation);
    if (!selected.ok) return selected;
    if (selected.value.cached) return ok(selected.value.existing as AssetHandle);
    if (visiting.has(key))
      return err(
        new AssetError({
          code: 'asset-reference-invalid',
          expected: 'an acyclic eager runtime asset closure',
          hint: 'remove eager dependency cycles',
        }),
      );
    visiting.add(key);
    const dependencies = new Set<number>();
    const linked = yield* this.adoptSourceReferences(key, operation, dependencies, new Set());
    if (!linked.ok) return linked;
    yield;
    const created = this.prepareSourceIngestionContent(
      key,
      operation,
      selected.value.existing,
      selected.value.reuse,
      dependencies,
    );
    visiting.delete(key);
    if (created.ok) staged.set(key, created.value);
    return created;
  }

  /** Source POD is borrowed only within this synchronous preparation call, never a generator frame. */
  private prepareSourceIngestionContent(
    key: string,
    operation: SourceIngestionOperation,
    existing: AssetHandle | undefined,
    reuse: boolean,
    dependencies: Set<number>,
  ): Result<AssetHandle, RuntimeAssetError> {
    const { inputs, records, staged } = operation;
    const decoded = inputs.borrow(key);
    if (!decoded.ok) return decoded;
    const entry = decoded.value;
    if (!isBuiltinAssetKind(entry.kind)) {
      const prepare = this.#decoders.canPrepare(entry.kind)
        ? (owned: unknown) =>
            this.prepareWithDecoder(entry.kind, owned, staged, records.reader, () =>
              this.ingestionGuard(operation),
            )
        : undefined;
      return reuse && prepare === undefined
        ? ok(existing as AssetHandle)
        : records.adopt(entry.kind, entry.value, [...dependencies], prepare, existing);
    }
    let content = entry.value as Asset;
    if (content.kind === 'scene' && reuse) {
      const scene = this.prepareSourceIngestionScene(content, operation, entry.refs);
      if (!scene.ok) return scene;
      content = scene.value.value;
      for (const dependency of scene.value.dependencies) dependencies.add(dependency);
    }
    if (reuse) {
      const valid = records.reader.validate(existing as AssetHandle, content.kind);
      if (!valid.ok) return valid;
      if (content.kind === 'terrain') {
        const checked = prepareRuntimeTerrain(
          content,
          records.reader,
          (guid) => staged.get(guid) ?? inputs.selections.get(guid),
        );
        if (!checked.ok) return checked;
        this.ownTerrainDerived(checked.value.value, records.reader);
      }
      return ok(existing as AssetHandle);
    }
    const ownedMesh = this.takeSourceIngestionMesh(key, operation, existing, content, entry);
    return this.createRuntimeContent(
      content,
      [...dependencies],
      staged,
      existing as AssetHandle<BuiltinAssetKind> | undefined,
      (guid) => this.sourceIngestionContent(operation, guid, content.kind),
      ownedMesh ? 'take' : 'copy',
      records,
      (name) => inputs.schemas.get(name),
      () => this.ingestionGuard(operation),
      entry.refs,
      ownedMesh ? 'render-transfer' : undefined,
    );
  }

  private takeSourceIngestionMesh(
    key: string,
    operation: SourceIngestionOperation,
    existing: AssetHandle | undefined,
    content: Asset,
    entry: SourceEntry,
  ): boolean {
    const ownedMesh =
      existing === undefined &&
      content.kind === 'mesh' &&
      operation.renderMeshes.has(key) &&
      this.#runtime.canTransferMesh &&
      isStandaloneStaticMesh(content) &&
      operation.source.canTakeMesh(operation.root, key, entry);
    if (ownedMesh) operation.ownedMeshes.set(key, entry);
    return ownedMesh;
  }

  private prepareSourceIngestionScene(
    scene: SceneAsset,
    operation: SourceIngestionOperation,
    refs: readonly string[],
  ) {
    return prepareRuntimeScene(
      scene,
      (name) => operation.inputs.schemas.get(name),
      (value, kind) => {
        const handle =
          typeof value === 'number'
            ? value
            : (operation.staged.get(value.toLowerCase()) ??
              operation.inputs.selections.get(value.toLowerCase()) ??
              this.#runtimeByGuid.get(value.toLowerCase()));
        if (handle === undefined)
          return err(
            new AssetError({
              code: 'asset-reference-invalid',
              expected: 'a loaded declared Scene dependency',
              hint: 'declare the complete Scene reference table',
            }),
          );
        const valid = operation.records.reader.validate(handle, kind);
        return valid.ok ? ok(handle) : valid;
      },
      refs,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    const conflict = this.#runtime.mutationError();
    if (conflict !== undefined) throw conflict;
    this.#disposed = true;
    for (const operation of this.ingestions) {
      operation.steps?.return(this.ingestionContextFailure());
      operation.steps = undefined;
      operation.inputs.dispose();
    }
    this.#source?.dispose();
    this.#decoders.dispose();
    this.#runtime.dispose();
    this.#runtimeByGuid.clear();
    this.#runtimeGuids.clear();
    this.clearCatalogSource();
  }

  readonly #publicationCandidates = new WeakMap<
    RuntimePackEnvelope,
    PreparedPublicationCandidate
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
    const source = this.#source;
    const started = this.#runtime.currentRevision;
    const decoderIdentities = new Map(
      owned.rows.map((row) => [row.kind, this.#decoders.identity(row.kind)]),
    );
    if (owned.pack !== undefined && owned.pack.scopeId !== source?.catalog.scopeId)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'prepared publication in the configured Catalog scope',
          hint: 'prepare the publication with the current asset owner scope',
        }),
      );
    const generations = new Map(
      [...owned.rows.map((row) => row.guid), ...dependencies.keys()].map((guid) => [
        guid,
        source?.revision(guid) ?? 0,
      ]),
    );
    const baseline = await this.enumerateCatalog();
    if (!baseline.ok) return baseline;
    if (source !== this.#source)
      return err(
        new AssetError({
          code: 'asset-invalidated',
          expected: 'unchanged source during preparation',
          hint: 'retry in the current asset context',
        }),
      );
    const result = await preparePublicationPayloads(
      owned.rows,
      fetcher,
      external,
      { ...services, pack: owned.pack, dependencies },
      this.#decoders,
    );
    if (!result.ok) return result;
    for (const row of owned.rows) {
      const asset = result.value.get(row.guid.toLowerCase());
      if (asset?.kind !== 'material') continue;
      const template = (asset as MaterialAsset & { materialTemplate?: DecodedMaterialTemplate })
        .materialTemplate;
      if (template === undefined) continue;
      const ready = await this.prepareDecodedMaterialTemplate(
        template,
        row.publication?.generation ?? 0,
      );
      if (!ready.ok) return ready;
      this.materialPayloadProjections.set(asset, ready.value);
    }
    if (
      [...decoderIdentities].some(([kind, identity]) => this.#decoders.identity(kind) !== identity)
    )
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: 'the decoder leases captured for publication preparation',
          hint: 'prepare with the current owner decoders',
        }),
      );
    const retained = this.retainPreparedOutputs(
      result.value,
      owned.rows,
      services.retainProducerArtifacts ? owned.pack : undefined,
      fetcher,
    );
    if (key && owned.pack)
      this.#publicationCandidates.set(key, {
        assets: result.value,
        pack: owned.pack,
        rows: owned.rows,
        standaloneMeshes: retained.standaloneMeshes,
        source,
        generations,
        started,
        decoderIdentities,
      });
    return ok(retained.readers);
  }

  private retainPreparedOutputs(
    prepared: ReadonlyMap<string, Asset>,
    rows: readonly CatalogEntry[],
    pack: RuntimePackEnvelope | undefined,
    fetcher: PackageFetcher,
  ) {
    const readers = new Map<string, () => Promise<Asset>>();
    const standaloneMeshes = new Set<string>();
    const envelopes = new Map(pack?.assets.map((asset) => [asset.guid, asset]));
    const packageUrls = new Map(rows.map((row) => [row.guid, row.packageUrl]));
    for (const [guid, asset] of prepared) {
      const envelope = envelopes.get(guid);
      const packageUrl = packageUrls.get(guid);
      const read =
        asset.kind === 'mesh' && isStandaloneStaticMesh(asset) && envelope && packageUrl
          ? this.standaloneMeshReader(envelope, packageUrl, fetcher)
          : undefined;
      if (read !== undefined) standaloneMeshes.add(guid);
      readers.set(guid, read ?? (async () => copyPreparedAsset(asset)));
    }
    return { readers, standaloneMeshes };
  }

  private standaloneMeshReader(
    envelope: RuntimePackEnvelope['assets'][number],
    packageUrl: string,
    fetcher: PackageFetcher,
  ): (() => Promise<Asset>) | undefined {
    if (!this.#decoders.uses('mesh', meshAssetDecoder)) return undefined;
    const { meshBody } = standaloneMeshBody(envelope as Parameters<typeof standaloneMeshBody>[0]);
    const descriptor = meshBody?.artifacts.body;
    if (!meshBody || !descriptor) return undefined;
    const request = { packageUrl, guid: meshBody.guid, artifactKey: descriptor.path, descriptor };
    // The producer's immutable transport already owns the exact artifact. A
    // historical read can use that version after a Catalog change or withdrawal.
    return async () => {
      const bytes = (await readArtifact(request, fetcher)).unwrap();
      const mesh = await decodeStandaloneMeshBody(meshBody, bytes);
      return prepareAssetPayload(mesh).unwrap();
    };
  }

  private preparedDecodersCurrent(identities: ReadonlyMap<string, symbol | undefined>): boolean {
    for (const [kind, identity] of identities)
      if (this.#decoders.identity(kind) !== identity) return false;
    return true;
  }

  private publicationCandidateCurrent(
    candidate: PreparedPublicationCandidate | undefined,
  ): candidate is PreparedPublicationCandidate {
    return (
      candidate !== undefined &&
      !this.#disposed &&
      candidate.source === this.#source &&
      this.preparedDecodersCurrent(candidate.decoderIdentities) &&
      [...candidate.generations].every(
        ([guid, revision]) => this.#source?.revision(guid) === revision,
      )
    );
  }

  /** Check the consuming context before reusing a previously prepared publication. */
  isPreparedPublicationCurrent(pack: RuntimePackEnvelope): boolean {
    return this.publicationCandidateCurrent(this.#publicationCandidates.get(pack));
  }

  /** Consume private preparation once, before the producer publishes its Catalog delta. */
  commitPreparedPublication(pack: RuntimePackEnvelope, beforeCommit?: () => void): void {
    const candidate = this.#publicationCandidates.get(pack);
    const current = () => this.publicationCandidateCurrent(candidate);
    if (!candidate || !current())
      throw new TypeError('candidate was not prepared in the current asset context');
    this.#publicationCandidates.delete(pack);
    beforeCommit?.();
    if (!current()) throw new TypeError('asset context changed during publication commit');
    this.#source?.preparePublication(
      candidate.pack,
      candidate.rows,
      candidate.assets,
      candidate.standaloneMeshes,
      candidate.decoderIdentities,
    );
  }

  private invalidPreparedAuthorPath(path: readonly string[]): boolean {
    return (
      path.length === 0 ||
      path[0] === 'kind' ||
      path[0] === 'materialTemplate' ||
      path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
    );
  }

  private installAdoptedMaterialProjection(
    asset: Asset,
    readParent: (guid: string) => Asset | undefined,
  ): void {
    if (asset.kind !== 'material') return;
    const { cooked } = asset as MaterialAsset & {
      cooked?: MaterialReady['record'] | SourceMaterialPayload['cooked'];
    };
    if (cooked !== undefined) this.installMaterialProjection(asset, cooked, readParent);
  }

  private installMaterialProjection(
    material: MaterialAsset,
    cooked: MaterialReady['record'] | SourceMaterialPayload['cooked'],
    readParent: (guid: string) => Asset | undefined,
  ): void {
    const ready =
      cooked.schemaVersion === 'material-cook/5'
        ? { status: 'Ready' as const, record: cooked }
        : this.sourceMaterialReady(
            material as MaterialAsset & SourceMaterialPayload,
            cooked,
            readParent,
          );
    const projection = installMaterialReadyShaders(
      this.shaderRegistry,
      ready,
      this.materialArtifactRegistry,
    );
    this.materialPayloadProjections.set(material, projection);
  }

  private sourceMaterialReady(
    material: MaterialAsset & SourceMaterialPayload,
    record: SourceMaterialPayload['cooked'],
    readParent: (guid: string) => Asset | undefined,
  ) {
    const table: Record<string, MaterialAsset> = Object.create(null);
    let guid = record.guid;
    let authored = record.authored;
    while (authored !== undefined && !Object.hasOwn(table, guid)) {
      table[guid] = authored;
      if (authored.parent === undefined) break;
      guid = materialGuidText(authored.parent);
      const parent = readParent(guid.toLowerCase());
      if (parent?.kind !== 'material') break;
      const parentRecord = (parent as MaterialAsset & { cooked?: MaterialReady['record'] }).cooked;
      authored = parentRecord?.authored ?? parent;
    }
    const materials: MaterialTable = Object.freeze(table);
    const publication = material.rasterSources;
    return {
      record,
      publication,
      inputs: Object.freeze({ materials, modules: publication.modules }),
      prepareSource: (recipe: MaterialRasterSourceRecipe) =>
        this.prepareMaterialSourceProgram(recipe),
    };
  }

  private inheritPreparedMaterialTemplate(source: Asset, replacement: Asset): void {
    const projection = this.materialPayloadProjections.get(source);
    if (projection?.sourceTemplate !== undefined)
      this.materialPayloadProjections.set(replacement, projection);
  }

  /**
   * Adopt privately prepared content as runtime edits under existing GUID bindings.
   * Source/Catalog publication stays unchanged; sourceOf continues to report edits.
   * The preparation token is single-use and all output writes commit atomically.
   */
  adoptPreparedContent(
    pack: RuntimePackEnvelope,
    fields: readonly {
      readonly guid: string;
      readonly path: readonly string[];
      readonly value: unknown;
    }[] = [],
    beforeCommit?: (handles: ReadonlyMap<string, AssetHandle>) => void,
  ): Result<void, RuntimeAssetError> {
    const candidate = this.#publicationCandidates.get(pack);
    this.#publicationCandidates.delete(pack);
    if (!this.publicationCandidateCurrent(candidate)) {
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: 'current private publication preparation',
          hint: 'prepare the candidate again in this asset owner',
        }),
      );
    }
    const replacements = new Map<string, Asset>();
    for (const field of fields) {
      const guid = field.guid.toLowerCase();
      const source = replacements.get(guid) ?? candidate.assets.get(guid);
      if (!source || this.invalidPreparedAuthorPath(field.path))
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: 'an existing prepared author field',
            hint: 'refresh the live binding before adoption',
          }),
        );
      const parents: Array<[Record<string, unknown>, string]> = [];
      let cursor: unknown = source;
      for (const part of field.path) {
        if (
          cursor === null ||
          typeof cursor !== 'object' ||
          ArrayBuffer.isView(cursor) ||
          !Object.hasOwn(cursor, part)
        )
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'an existing prepared author field',
              hint: 'repair the live binding path',
            }),
          );
        parents.push([cursor as Record<string, unknown>, part]);
        cursor = (cursor as Record<string, unknown>)[part];
      }
      let changed: unknown = structuredClone(field.value);
      for (const [parent, part] of parents.reverse()) {
        const copy = Array.isArray(parent) ? [...parent] : { ...parent };
        (copy as Record<string, unknown>)[part] = changed;
        changed = copy;
      }
      const replacement = changed as Asset;
      this.inheritPreparedMaterialTemplate(source, replacement);
      replacements.set(guid, replacement);
    }
    const rows = new Map(candidate.rows.map((row) => [row.guid.toLowerCase(), row]));
    const envelopes = new Map(
      candidate.pack.assets.map((asset) => [asset.guid.toLowerCase(), asset]),
    );
    const staged = new Map<string, AssetHandle>();
    const visiting = new Set<string>();
    const sourceContent = (guid: string) =>
      replacements.get(guid.toLowerCase()) ??
      candidate.assets.get(guid.toLowerCase()) ??
      this.preparedSource(guid);
    const adopt = (
      guid: string,
      records: AssetAdoption,
    ): Result<AssetHandle, RuntimeAssetError> => {
      const key = guid.toLowerCase();
      const complete = staged.get(key);
      if (complete !== undefined) return ok(complete);
      const row = rows.get(key);
      const existing = this.#runtimeByGuid.get(key);
      if (!row)
        return existing === undefined
          ? err(
              new AssetError({
                code: 'asset-reference-invalid',
                expected: `loaded fixed dependency ${key}`,
                hint: 'load the retained dependency before adopting content',
              }),
            )
          : ok(existing);
      if (visiting.has(key))
        return err(
          new AssetError({
            code: 'asset-reference-invalid',
            expected: 'an acyclic eager content closure',
            hint: 'remove the eager reference cycle',
          }),
        );
      if (existing !== undefined && this.#runtime.version(existing).unwrap() > candidate.started)
        return err(
          new AssetError({
            code: 'asset-write-conflict',
            expected: `unchanged runtime content during preparation: ${key}`,
            hint: 'prepare again after the concurrent write',
          }),
        );
      const asset = sourceContent(key);
      if (!asset)
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `prepared content ${key}`,
            hint: 'prepare every output before adoption',
          }),
        );
      visiting.add(key);
      const dependencies: number[] = [];
      if (row.kind !== 'plugin' && this.#decoders.referencePolicy(row.kind) !== 'deferred')
        for (const ref of row.refs ?? []) {
          const linked = adopt(ref, records);
          if (!linked.ok) return linked;
          dependencies.push(linked.value);
        }
      if (row.kind === 'material') this.installAdoptedMaterialProjection(asset, sourceContent);
      const created = isBuiltinAssetKind(row.kind)
        ? this.createRuntimeContent(
            asset,
            dependencies,
            staged,
            existing as AssetHandle<BuiltinAssetKind> | undefined,
            sourceContent,
            'copy',
            records,
            undefined,
            undefined,
            envelopes.get(key)?.refs,
          )
        : records.adopt(
            row.kind,
            asset,
            dependencies,
            this.#decoders.canPrepare(row.kind) || replacements.has(key)
              ? (owned: unknown) => this.prepareWithDecoder(row.kind, owned, staged, records.reader)
              : undefined,
            existing,
          );
      if (!created.ok) return created;
      staged.set(key, created.value);
      visiting.delete(key);
      return created;
    };
    const result = this.#runtime.adoptPreparedClosure(
      (records) => {
        for (const guid of rows.keys()) {
          const value = adopt(guid, records);
          if (!value.ok) return value;
        }
        // Scene compilation is pure. Validate nested bindings against the candidate
        // handles before making any material, geometry or scene replacement visible.
        if (this.#world)
          for (const [guid, handle] of staged) {
            if (rows.get(guid)?.kind !== 'scene') continue;
            const asset = records.reader.borrow<SceneAsset>(handle).unwrap();
            const compiled = compileKeyedSceneAsset(
              this.#world,
              handle as AssetHandle<'scene'>,
              asset,
              {
                resolveSource: (source) => {
                  const value =
                    typeof source === 'number'
                      ? source
                      : (staged.get(source) ?? this.#runtimeByGuid.get(source));
                  return value === undefined
                    ? err(new Error('Missing scene dependency'))
                    : ok(value as AssetHandle<'scene'>);
                },
                resolveAsset: (source) => records.reader.borrow<SceneAsset>(source),
                stack: new Set([Number(handle)]),
              },
            );
            if (!compiled.ok)
              return err(
                new AssetError({
                  code: 'asset-invalid-value',
                  expected: 'a valid scene candidate',
                  hint: `repair scene fields and instance references: ${JSON.stringify(compiled.error)}`,
                }),
              );
          }
        return ok(undefined);
      },
      () => {
        beforeCommit?.(staged);
        if (!this.publicationCandidateCurrent(candidate))
          throw new AssetError({
            code: 'asset-write-conflict',
            expected: 'the prepared source and decoder context after acceptance',
            hint: 'dispose candidate consumers and prepare again',
          });
      },
    );
    if (!result.ok) return result;
    for (const [guid, handle] of staged) {
      this.#runtimeByGuid.set(guid, handle);
      if (rows.get(guid)?.kind === 'texture-generator') this.hasTextureGenerators = true;
      if (!this.#runtimeGuids.has(handle)) {
        const row = rows.get(guid);
        if (row === undefined) throw new TypeError(`Missing staged catalog row ${guid}`);
        this.#runtimeGuids.set(handle, {
          guid,
          kind: row.kind,
          source: this.#source,
          revision: -1,
          publication: undefined,
          contentKey: undefined,
        });
      }
    }
    return ok(undefined);
  }

  readPluginDefinition(guid: string) {
    return (
      this.#source?.readPluginDefinition(guid) ??
      Promise.resolve(
        catalogSourceUnconfigured<import('@forgeax/engine-types').PluginAssetDefinition>(),
      )
    );
  }
  get catalogSource(): CatalogSource | undefined {
    return this.#source?.catalogSource;
  }
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

  /** Owner-injected component catalog used for scene breadcrumb projection. */
  readonly componentCatalog: ReadonlyMap<string, Component>;
  /** Current browser-facing asset realm; absent for inline/shipped legacy use. */
  runtimeBinding: RuntimeAssetBinding | undefined = undefined;
  readonly materialArtifactRegistry = new MaterialArtifactRegistry();
  readonly materialPayloadProjections = new WeakMap<object, MaterialRenderProjection>();
  private assetEvidenceSource?: RuntimeEvidenceSource;

  // Optional owner metrics shared with the renderer at assembly. Material
  // preparation and drawing record diagnostics when this sink is installed.
  metrics: EngineMetrics | null = null;

  // feat-20260707 M5 / w33 (D-11): device texture-compression caps the Basis
  // texture / equirect arms feed to `selectTranscodeTarget`. `createRenderer`
  // projects `RhiCaps` -> `TranscodeCaps` and calls `setTranscodeCaps` right
  // after construction (D-8 one-line projection). A standalone registry (test /
  // headless) keeps the all-false default, which drives the uncompressed
  // fallback path (section 8 P3, AC-04) rather than a hard failure.
  transcodeCaps: TranscodeCaps = { bc: false, etc2: false, astc: false };

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

  readonly shaderRegistry: ShaderRegistry;
  #prepareMaterialSourceProgram: PrepareMaterialSourceProgram | undefined;

  /** The runtime host owns compilation policy for source-backed assets. */
  setMaterialSourceCompiler(prepare: PrepareMaterialSourceProgram): void {
    this.#prepareMaterialSourceProgram = prepare;
  }

  async prepareMaterialSourceProgram(recipe: MaterialRasterSourceRecipe) {
    if (this.#prepareMaterialSourceProgram !== undefined)
      return this.#prepareMaterialSourceProgram(recipe);
    return err(
      new ShaderError({
        code: 'shader-compile-failed',
        expected: 'a runtime material source compiler provided by the Renderer host',
        hint: 'construct the runtime Renderer host for a source-backed Material Pack',
        message: `No source compiler for material program '${recipe.selection.artifactDigest}'`,
      }),
    );
  }

  private readonly sourceOptions: Pick<
    AssetSourceOptions,
    'scopeId' | 'generation' | 'maxConcurrentReads'
  >;

  constructor(options: AssetRegistryOptions = {}) {
    this.sourceOptions = {
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
      ...(options.generation === undefined ? {} : { generation: options.generation }),
      ...(options.maxConcurrentReads === undefined
        ? {}
        : { maxConcurrentReads: options.maxConcurrentReads }),
    };
    this.#runtime = new AssetRecords(options.limits, (content) =>
      this.copySnapshotContent(content),
    );
    this.#decoders = new DecoderRegistry(options);
    installRuntimeAssets(this, {
      records: this.#runtime,
      sources: this.#runtimeByGuid,
      origins: this.#runtimeGuids,
      decoders: this.#decoders,
      source: () => this.#source,
      ownsPublicationReads: () =>
        this.sourceOf === AssetRegistry.#sourceRead &&
        this.catalogEntry === AssetRegistry.#catalogRead,
    });
    this.shaderRegistry = options.shaderRegistry ?? new ShaderRegistry({ manifestUrl: undefined });
    this.importTransport = options.importTransport;
    this.postSpawnHook = options.postSpawnHook;
    this.runtimeBinding = options.runtimeBinding;
    this.componentCatalog = options.components ?? new Map();
    this.#decoders.install(defineAssetKind('plugin'), pluginAssetDecoder);
    if (options.catalog !== undefined) this.setCatalogSource(options.catalog, options.fetcher);
  }

  /** Install the observation sink shared with renderer preparation and drawing. */
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
   * `inspect(guid)` returns the shared state model; an
   * omitted capability remains an explicit structured error, never a pass.
   */
  configureAssetEvidence(source: RuntimeEvidenceSource): void {
    this.assetEvidenceSource = source;
  }

  /**
   * @internal — read the owner observation sink.
   * Returns `null` when no `createRenderer` wired the registry to a renderer
   * (the standalone-test path; the structured fail-fast branches still fire).
   */
  _getMetrics(): EngineMetrics | null {
    return this.metrics;
  }

  /** Public identity projection consumed by scene collection boundaries. */
  guidOf(handle: number): string | undefined {
    return this.#runtimeGuids.get(handle)?.guid;
  }

  /** Evidence belongs to the adopted runtime content, never the latest Catalog row. */
  sourceOf(handle: number) {
    const origin = this.#runtimeGuids.get(handle);
    const revision = this.#runtime.version(handle);
    return origin === undefined || !revision.ok
      ? undefined
      : {
          guid: origin.guid,
          modified: revision.value !== origin.revision,
          ...(origin.publication === undefined ? {} : { publication: { ...origin.publication } }),
        };
  }

  sourceKeyOf(guid: string): string | undefined {
    return this.catalogEntry(guid)?.sourceKey;
  }

  /** Read one accepted navigation row without enumerating the Catalog. */
  catalogEntry(guid: string): CatalogEntry | undefined {
    return this.#source?.catalog?.get(guid);
  }

  /** Runtime content owns its accepted program projection; no source traversal occurs here. */
  getMaterialProjectionForPayload(material: MaterialAsset): MaterialRenderProjection | undefined {
    const projection = this.materialPayloadProjections.get(material);
    assertMaterialStaticSelection(material.staticSwitches, projection);
    return projection;
  }

  /** Bind the receiver's source template to this realm's existing shader owners. */
  bindReceivedMaterialTemplate(projection: MaterialRenderProjection): void {
    bindMaterialTemplateProjection(
      projection,
      undefined,
      this.shaderRegistry,
      this.materialArtifactRegistry,
    );
  }

  /**
   * The accepted program projection of one live material. A detached `read()` copy is not the
   * accepted payload and carries no projection, so a holder of a handle asks here.
   */
  getMaterialProjection(
    handle: AssetHandle<'material'>,
  ): Result<MaterialRenderProjection | undefined, AssetError> {
    const valid = this.validate(handle, 'material');
    if (!valid.ok) return valid;
    return ok(
      this.getMaterialProjectionForPayload(this.#runtime.borrow<MaterialAsset>(handle).unwrap()),
    );
  }

  private copySnapshotContent<T>(content: T): T {
    const copied = copyAssetData(content);
    if (
      content !== null &&
      typeof content === 'object' &&
      copied !== null &&
      typeof copied === 'object'
    ) {
      const projection = this.materialPayloadProjections.get(content);
      // A fixed copy retains the accepted program facts from this exact content.
      if (projection !== undefined) this.materialPayloadProjections.set(copied, projection);
    }
    return copied;
  }

  private prepareMaterialProgramProjection(
    material: MaterialAsset,
    sourceContent: (guid: string) => Asset | undefined = (guid) => this.preparedSource(guid),
  ): MaterialRenderProjection | undefined {
    const visited = new Set<MaterialAsset>();
    let current: MaterialAsset | undefined = material;
    let projection: MaterialRenderProjection | undefined;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      projection = this.materialPayloadProjections.get(current);
      if (projection !== undefined || current.parent === undefined) break;
      const parent: Asset | undefined = sourceContent(materialGuidText(current.parent));
      current = parent?.kind === 'material' ? parent : undefined;
    }
    for (const content of visited)
      assertMaterialStaticSelection(content.staticSwitches, projection);
    return projection;
  }

  /** Return one immutable cooked artifact by specialization key. */
  getMaterialArtifact(specializationKey: string) {
    return this.materialArtifactRegistry.get(specializationKey);
  }

  /** Configure the single publication source. Runtime edits retain their accepted identity. */
  configurePackIndex(url: string): void {
    this.setCatalogSource(
      createCatalogSource({
        url,
        ...(this.runtimeBinding === undefined
          ? {}
          : {
              expectedScope: {
                scopeId: this.runtimeBinding.scopeId,
                generation: this.runtimeBinding.generation,
              },
            }),
        ...(this.importTransport === undefined ? {} : { importTransport: this.importTransport }),
      }),
    );
  }

  configureRuntimeBinding(binding: RuntimeAssetBinding): void {
    this.runtimeBinding = binding;
    this.configurePackIndex(binding.catalogUrl);
  }

  /** Release completed source reads; held content and in-flight reads remain valid. */
  trimReadCache(): void {
    this.#source?.trimReadCache();
    // Other owners in this realm, such as derived device texels, share the budget.
    trimRetainedBytes();
  }

  /** Discard one decoded source; accepted runtime content changes only on explicit reload. */
  invalidate(guid: string): void {
    this.#source?.invalidate(guid);
  }

  /** Retire source I/O without changing content already held by runtime consumers. */
  invalidateAll(): void {
    const source = this.catalogSource;
    const fetcher = this.assetFetcher;
    if (source !== undefined) this.setCatalogSource(source, fetcher);
  }

  setCatalogSource(source: CatalogSource, fetcher?: PackageFetcher): void {
    this.clearCatalogSource();
    this.assetFetcher = fetcher;
    this.#source = createAssetSource({
      ...this.sourceOptions,
      catalog: source,
      decoders: this.#decoders,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    const replica = this.#source.catalog;
    replica.subscribe((delta) => {
      for (const listener of this.catalogListeners) {
        try {
          listener(delta);
        } catch {
          /* Observer failures cannot revoke an accepted publication. */
        }
      }
    });
    void replica.start();
  }

  clearCatalogSource(): void {
    const conflict = this.#runtime.mutationError();
    if (conflict !== undefined) throw conflict;
    this.#source?.dispose();
    this.#source = undefined;
    this.assetFetcher = undefined;
    this.catalogEnumerating = undefined;
  }

  enumerateCatalog(): Promise<Result<readonly CatalogEntry[], AssetError>> {
    if (this.catalogEnumerating !== undefined) return this.catalogEnumerating;
    const replica = this.#source?.catalog;
    if (replica === undefined) {
      return Promise.resolve(catalogSourceUnconfigured());
    }
    const pending = replica.start();
    const promise = pending.then((result): Result<readonly CatalogEntry[], AssetError> => {
      if (replica !== this.#source?.catalog)
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
    return this.#source?.catalog?.snapshot();
  }

  reconcileCatalog(): Promise<CatalogReconcileResult> {
    return this.#source?.catalog?.reconcile() ?? Promise.resolve(catalogSourceUnconfigured());
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
   * const sceneRes = await engine.assets.load(roomGuid, 'scene');
   * if (!sceneRes.ok) return;
   * const r = engine.assets.instantiate(sceneRes.value, world);
   * engine.assets.release(sceneRes.value);
   * if (!r.ok) {
   *   switch (r.error.code) {
   *     case 'asset-not-found':
   *     case 'pack-cyclic-reference':
   *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
   *   }
   * }
   * ```
   */
  instantiate(
    handle: AssetHandle<'scene'>,
    world: World,
    parent?: EntityHandle,
  ): Result<EntityHandle, SceneInstantiateError> {
    return instantiateImpl(this, handle, world, parent);
  }

  instantiateWithPublicationFence(
    handle: AssetHandle<'scene'>,
    world: World,
    parent: EntityHandle | undefined,
    expectedPublication: ScenePublicationFence,
  ): Result<EntityHandle, SceneInstantiateError>;
  instantiateWithPublicationFence(
    handle: AssetHandle<'scene'>,
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
  instantiateFlat(
    handle: AssetHandle<'scene'>,
    world: World,
  ): Result<EntityHandle[], SceneInstantiateError> {
    return instantiateFlatImpl(this, handle, world);
  }

  instantiateFlatWithPublicationFence(
    handle: AssetHandle<'scene'>,
    world: World,
    expectedPublication: ScenePublicationFence,
  ): Result<EntityHandle[], SceneInstantiateError> {
    return instantiateFlatImpl(this, handle, world, expectedPublication);
  }

  private linkAnimationGraph(
    graph: import('@forgeax/engine-types').AnimationGraph,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    reader: AssetAdoptionReader = this.#runtime,
  ) {
    return prepareRuntimeAnimationGraph(graph, (value) => {
      const handle =
        typeof value === 'number'
          ? value
          : (sources.get(value.toLowerCase()) ?? this.#runtimeByGuid.get(value.toLowerCase()));
      if (handle === undefined)
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `a loaded animation clip ${value}`,
            hint: 'load the clip or pass a reference created by this asset owner',
          }),
        );
      const valid = reader.validate(handle, 'animation-clip');
      return valid.ok ? ok(handle) : valid;
    });
  }

  private linkScene(
    scene: SceneAsset,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    refs?: readonly string[],
    reader: AssetAdoptionReader = this.#runtime,
    component: (name: string) => Component | undefined = (name) =>
      this.#world?.components.resolve(name) ?? this.componentCatalog.get(name),
  ) {
    return prepareRuntimeScene(
      scene,
      component,
      (value, kind) => {
        const handle =
          typeof value === 'number'
            ? value
            : (sources.get(value.toLowerCase()) ?? this.#runtimeByGuid.get(value.toLowerCase()));
        if (handle === undefined)
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `loaded ${kind} source ${value}`,
              hint: 'load Scene dependencies before creating runtime content',
            }),
          );
        const valid = reader.validate(handle, kind);
        return valid.ok ? ok(handle) : valid;
      },
      refs,
    );
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
  /** Return the loaded source identities when no GUID is supplied. */
  inspect(): InspectSnapshot;
  /** Return joined source/cook/package/runtime evidence for one GUID. */
  inspect(guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>>;
  inspect(guid?: string): InspectSnapshot | Promise<Result<AssetEvidence, AssetEvidenceError>> {
    if (guid !== undefined) return this.inspectEvidence(guid);
    const assets: InspectEntry[] = [];
    for (const [guid, handle] of this.#runtimeByGuid) {
      const kind = this.#runtime.kind(handle);
      if (kind.ok)
        assets.push({ guid, kind: kind.value, name: this.catalogEntry(guid)?.name ?? '' });
    }
    return { assets };
  }

  private async inspectEvidence(guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>> {
    if (this.assetEvidenceSource === undefined) {
      return err({
        code: 'asset-evidence-capability-missing',
        expected: 'an injected runtime evidence source',
        hint: 'configure an evidence source before calling inspect(guid)',
        detail: { capability: 'runtime evidence source', stage: `guid:${guid}` },
      });
    }
    const input = await this.assetEvidenceSource.evidence(guid);
    if ('ok' in input) return input.ok ? projectAssetEvidence(input.value) : input;
    return projectAssetEvidence(input);
  }

  listCatalog(): readonly CatalogEntry[] {
    return this.catalogSnapshot()?.entries ?? [];
  }
}

/** Domain descriptors use their installed owner for the same admission as source decode. */
function requiresOwnerPreparation(kind: string): boolean {
  return (
    kind === 'texture-generator' ||
    kind === 'gpu-texture' ||
    kind === 'particle-effect' ||
    kind === 'audio' ||
    kind === 'sampler' ||
    kind === 'equirect' ||
    kind === 'render-pipeline' ||
    kind === 'plugin' ||
    kind === 'navigation-mesh' ||
    !isBuiltinAssetKind(kind)
  );
}
