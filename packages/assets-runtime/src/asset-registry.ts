import { type Component, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import { copyPackData } from '@forgeax/engine-pack/runtime';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import { compileKeyedSceneAsset, worldSetSceneAssetResolver } from '@forgeax/engine-scene';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import type { PackageFetcher } from '@forgeax/engine-types';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetDecoder,
  type AssetDecoderLease,
  AssetError,
  type AssetEvidence,
  type AssetEvidenceError,
  type AssetHandle,
  type AssetKind,
  type AssetLoadError,
  type AssetReferenceOwner,
  type BuiltinAssetKind,
  type CatalogEntry,
  type EngineMetrics,
  type ImageError,
  type ImportTransport,
  type InspectEntry,
  type InspectSnapshot,
  isMaterialTextureParameterType,
  type MaterialAsset,
  type MaterialError,
  type MaterialParameter,
  type MaterialValue,
  materialGuidText,
  type ParticleEffectAsset,
  type ParticleEffectInput,
  type RuntimeAssetBinding,
  type SceneAsset,
  type TranscodeCaps,
  type MeshAsset as TypesMeshAsset,
  validateMaterialValues,
} from '@forgeax/engine-types';
import { defineAssetKind, isBuiltinAssetKind } from './asset-kind';
import { type AssetLimits, AssetRecords } from './internal/asset-records';
import {
  type AdoptedAssetSource,
  type AssetLoadOptions,
  type AssetSource,
  type AssetSourceOptions,
  createAssetSource,
} from './internal/asset-source';
import { DecoderRegistry } from './internal/decoder-registry';
import { installRuntimeAssets } from './internal/runtime-assets';
import { assetLoadCancelled } from './internal/wait-for-asset';
import { pluginAssetDecoder } from './loaders/plugin';
import { runtimeMaterialProgramProjection } from './material/runtime-program';
import { copyPreparedAsset } from './prepare-payload.js';
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
import type { MaterialReady } from './material/loader.js';
import {
  assertMaterialStaticSelection,
  installMaterialReadyShaders,
  type MaterialRenderProjection,
} from './material/runtime-shader.js';
import {
  createRuntimeAssetEvidenceAdapter,
  type RuntimeAssetEvidenceAdapter,
  type RuntimeEvidenceSource,
} from './registry/asset-evidence.js';
import type { CatalogReplica, CatalogReplicaSnapshot } from './registry/catalog-state.js';
import {
  instantiateFlat as instantiateFlatImpl,
  instantiate as instantiateImpl,
  type PostSpawnHook,
  type SceneInstantiateError,
} from './registry/instantiate.js';
import type { ScenePublicationFence } from './registry/scene-publication-fence.js';
import { materialShaderTextureFieldNames as materialShaderTextureFieldNamesImpl } from './registry/validate-material.js';
import { prepareRuntimeAnimationGraph } from './runtime-animation-graph';
import { type MeshRange, prepareRuntimeMeshPatch, prepareRuntimeMeshRange } from './runtime-mesh';
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

export interface AssetReloadOptions extends AssetLoadOptions {
  /** Reject gameplay edits, or explicitly replace edits made before this request. */
  readonly conflict: 'reject' | 'overwrite';
}

interface SourceAdoption {
  readonly started: number;
  readonly conflict: AssetReloadOptions['conflict'];
}

export class AssetRegistry implements AssetReferenceOwner {
  readonly #decoders: DecoderRegistry;
  #source: AssetSource | undefined;
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

  private prepareWithDecoder(
    kind: string,
    input: unknown,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
  ): Result<{ value: unknown; dependencies: readonly number[] }, AssetError> {
    const dependencies = new Set<number>();
    const prepared = this.#decoders.prepare(kind, input, {
      reference: (value, target) => {
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
        const valid = this.validate(handle, target);
        if (!valid.ok) return valid;
        dependencies.add(handle);
        return ok(handle as AssetHandle<typeof target>);
      },
      read: (handle) => this.read(handle),
    });
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
    sourceContent: (guid: string) => Asset | undefined = (guid) => this.preparedSource(guid),
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
    const created = this.#runtime.adopt<T['kind'], T, AssetError | MaterialError>(
      kind.value as T['kind'],
      input,
      dependencies,
      (owned) => {
        if (requiresOwnerPreparation(owned.kind))
          return this.prepareWithDecoder(owned.kind, owned, sources);
        const prepared = prepareRuntimeAsset(owned, sourceContent);
        if (!prepared.ok) return prepared;
        if (prepared.value.kind === 'tileset') {
          const linked = linkRuntimeTileset(
            prepared.value,
            this,
            (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
          );
          return linked.ok
            ? ok({
                value: linked.value.value,
                dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
              })
            : linked;
        }
        if (prepared.value.kind === 'font') {
          const linked = linkRuntimeFont(
            prepared.value,
            this,
            (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
          );
          return linked.ok
            ? ok({
                value: linked.value.value,
                dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
              })
            : linked;
        }

        if (prepared.value.kind === 'terrain')
          return prepareRuntimeTerrain(
            prepared.value,
            this.#runtime,
            (guid) => sources.get(guid) ?? this.#runtimeByGuid.get(guid),
          );
        if (owned.kind === 'material') {
          // Static program admission must finish before a reference or change is committed.
          try {
            projection = this.prepareMaterialProgramProjection(
              input as MaterialAsset,
              sourceContent,
            );
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
          const linked = this.linkMesh(prepared.value, sources);
          return linked.ok
            ? ok({
                value: linked.value.value,
                dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
              })
            : linked;
        }
        if (prepared.value.kind === 'animation-graph' || prepared.value.kind === 'scene') {
          const linked =
            prepared.value.kind === 'scene'
              ? this.linkScene(prepared.value, sources)
              : this.linkAnimationGraph(prepared.value, sources);
          return linked.ok
            ? ok({
                value: linked.value.value,
                dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
              })
            : linked;
        }
        if (prepared.value.kind !== 'material') return ok({ value: prepared.value });
        const linked = this.linkMaterial(prepared.value, sources);
        if (linked.ok) textures = linked.value.textures;
        return linked.ok
          ? ok({
              value: linked.value.value,
              dependencies: [...new Set([...dependencies, ...linked.value.dependencies])],
            })
          : linked;
      },
      replacing,
    );
    if (created.ok && kind.value === 'material') {
      const accepted = this.#runtime.borrow<MaterialAsset>(created.value).unwrap();
      this.prepareMaterialValueContract(accepted, textures);
      if (projection !== undefined) this.materialPayloadProjections.set(accepted, projection);
    }
    if (created.ok && kind.value === 'terrain')
      this.ownTerrainDerived(
        this.#runtime.borrow<import('@forgeax/engine-types').TerrainAsset>(created.value).unwrap(),
      );
    return created;
  }

  private ownTerrainDerived(terrain: import('@forgeax/engine-types').TerrainAsset): void {
    const own = (handle: string | number) => {
      if (typeof handle !== 'number') throw new Error('Terrain closure was not linked');
      this.#terrainDerived.add(this.#runtime.borrow<object>(handle).unwrap());
    };
    for (const handle of terrain.grids) own(handle);
    for (const section of terrain.sections) {
      own(section.heightTexture);
      own(section.weightTexture);
      own(section.material);
      for (const dependency of this.#runtime.dependencies(Number(section.material)).unwrap())
        own(dependency);
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
      const checked = this.validate(handle, kind);
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
  ) {
    const fields = new Set(knownTextures);
    for (const parameter of material.parameters ?? [])
      if (!isMaterialTextureParameterType(parameter.type)) fields.delete(parameter.name);
    for (const pass of material.passes ?? [])
      for (const field of this.materialShaderTextureFieldNames(pass.program.module) ?? [])
        fields.add(field);
    return linkRuntimeMaterial(
      material,
      this,
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
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
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
    const current = this.#runtime.borrow<Asset>(handle);
    if (!current.ok) return current;
    const derived = this.terrainDerivedWrite(current.value);
    if (derived !== undefined) return err(derived);
    if (current.value.kind === 'terrain') {
      const source = captureTerrainEdit(current.value, patch);
      if (!source.ok) return source;
      const adopted = this.createTerrainContent(source.value, handle as AssetHandle<'terrain'>);
      return adopted.ok ? ok(undefined) : adopted;
    }
    if (current.value.kind === 'material') {
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
        const contract = this.materialValueContracts.get(current.value);
        const valueDescriptors = Object.getOwnPropertyDescriptors(values.value);
        const numeric =
          contract !== undefined &&
          Reflect.ownKeys(valueDescriptors).every((name) => {
            if (typeof name !== 'string' || contract.textures.has(name)) return false;
            const entry = valueDescriptors[name];
            if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return false;
            const previous =
              current.value.kind === 'material' ? current.value.values?.[name] : undefined;
            // Changing a binding must transfer its holds through complete dependency preparation.
            if (
              typeof previous === 'string' ||
              (previous !== null && typeof previous === 'object' && !Array.isArray(previous))
            )
              return false;
            return (
              typeof entry.value === 'number' ||
              typeof entry.value === 'boolean' ||
              Array.isArray(entry.value)
            );
          });
        if (numeric)
          return this.#runtime.update(handle, values.value, {
            field: 'values',
            prepare: (_current, owned) => {
              const valid = validateMaterialValues(
                '<runtime-material>',
                owned as Record<string, MaterialValue>,
                contract.parameters,
              );
              return valid.ok ? ok({ value: owned }) : valid;
            },
          });
      }
    }
    let projection: MaterialRenderProjection | undefined;
    let textures: ReadonlySet<string> | undefined;
    const committed = this.#runtime.update(handle, patch, {
      prepare: (raw, update) => {
        const current = raw as unknown as Asset;
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
        if (!prepared.ok) return prepared;
        if (prepared.value.kind === 'tileset') {
          const linked = linkRuntimeTileset(prepared.value, this, (guid) =>
            this.#runtimeByGuid.get(guid),
          );
          return linked.ok
            ? ok({
                value: { ...update, atlases: linked.value.value.atlases },
                dependencies: linked.value.dependencies,
              })
            : linked;
        }
        if (prepared.value.kind === 'font') {
          const linked = linkRuntimeFont(prepared.value, this, (guid) =>
            this.#runtimeByGuid.get(guid),
          );
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

  /** Update a complete attribute range without copying or validating untouched vertices. */
  writeRange(handle: AssetHandle<'mesh'>, range: MeshRange): Result<void, AssetError>;
  writeRange(handle: AssetHandle<'texture'>, range: TextureRegion): Result<void, AssetError>;
  writeRange(handle: AssetHandle<'terrain'>, range: TerrainHeightRange): Result<void, AssetError>;
  writeRange(
    handle: AssetHandle<'mesh'> | AssetHandle<'texture'> | AssetHandle<'terrain'>,
    range: MeshRange | TextureRegion | TerrainHeightRange,
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
    return current.value.kind === 'texture'
      ? this.#runtime.writeRange(handle, range as TextureRegion, prepareRuntimeTextureRange)
      : this.#runtime.writeRange(handle, range as MeshRange, prepareRuntimeMeshRange);
  }

  snapshot(handle: AssetHandle) {
    return this.#runtime.snapshot(handle);
  }

  /** Atomically replace complete content while preserving the directly bound identity. */
  replace<K extends string, P>(
    handle: AssetHandle<K, P>,
    input: P extends ParticleEffectAsset ? ParticleEffectInput : P,
  ): Result<void, AssetError | MaterialError>;
  replace(handle: AssetHandle, raw: unknown): Result<void, AssetError | MaterialError> {
    const kind = this.#runtime.kind(handle);
    if (!kind.ok) return kind;
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
    const current = this.#runtime.borrow<Asset>(handle);
    if (!current.ok) return current;
    const derived = this.terrainDerivedWrite(current.value);
    if (derived !== undefined) return err(derived);
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
      return held.ok ? ok(existing) : held;
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
    const loaded =
      typeof kind === 'string'
        ? await source.load(key, kind, options)
        : await source.load(key, kind, options);
    if (!loaded.ok) return loaded;
    const programs = this.prepareSourcePrograms(source, key, options);
    if (!programs.ok) return programs;
    if (options.signal?.aborted) return err(assetLoadCancelled(key));
    if (this.#source !== source)
      return err(
        new AssetError({
          code: 'asset-write-conflict',
          expected: 'the same asset source until load adoption',
          hint: 'load again from the current source',
        }),
      );
    const staged = new Map<string, AssetHandle>();
    const adopted = this.#runtime.adoptClosure(() => this.adoptSource(key, new Set(), staged));
    if (!adopted.ok) return adopted;
    this.rememberSources(staged);
    this.#runtime.retain(adopted.value, expectedKind).unwrap();
    return adopted;
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
    };
    const loaded = await source.load(origin.guid, defineAssetKind(origin.kind), {
      ...options,
      refresh: true,
    });
    if (!loaded.ok) return loaded;
    const programs = this.prepareSourcePrograms(source, origin.guid, options);
    if (!programs.ok) return programs;
    if (options.signal?.aborted) return err(assetLoadCancelled(origin.guid));
    if (this.#disposed || this.#source !== source)
      return err(
        new AssetError({
          code: this.#disposed ? 'asset-owner-closed' : 'asset-write-conflict',
          expected: 'the same live asset source until adoption',
          hint: 'reload from the current asset owner',
        }),
      );
    const staged = new Map<string, AssetHandle>();
    const adopted = this.#runtime.adoptClosure(() =>
      this.adoptSource(origin.guid, new Set(), staged, policy),
    );
    if (!adopted.ok) return adopted;
    this.rememberSources(staged);
    return ok(undefined);
  }

  /** One preparation per decoded source; runtime numeric writes never inspect program bytes. */
  private prepareSourcePrograms(
    source: AssetSource,
    root: string,
    options: AssetLoadOptions,
  ): Result<void, RuntimeAssetError> {
    const visited = new Set<string>();
    const prepared: { material: MaterialAsset; ready: MaterialReady }[] = [];
    const visit = (guid: string): Result<void, RuntimeAssetError> => {
      const key = guid.toLowerCase();
      if (visited.has(key)) return ok(undefined);
      visited.add(key);
      const entry = source.entry(key);
      if (entry === undefined) return source.checkCurrent(key);
      if (entry.references === 'eager')
        for (const ref of entry.refs) {
          const child = visit(ref);
          if (!child.ok) return child;
        }
      if (entry.kind !== 'material') return ok(undefined);
      const material = entry.value as MaterialAsset & { readonly cooked?: unknown };
      if (material.cooked === undefined || this.materialPayloadProjections.has(material))
        return ok(undefined);
      // The Material decoder owns the complete immutable Cook record. Source adoption
      // checks its live closure and installs those facts without rehashing shader bytes.
      const record = material.cooked as MaterialReady['record'];
      for (const reference of [
        ...record.refs.parent,
        ...record.refs.textures,
        ...record.refs.samplers,
        ...record.refs.modules,
      ]) {
        if (!AssetGuid.parse(reference).ok) continue;
        const current = source.checkCurrent(reference.toLowerCase());
        if (!current.ok) return current;
      }
      const ready: MaterialReady = { status: 'Ready', record };
      prepared.push({ material, ready });
      return ok(undefined);
    };
    const loaded = visit(root);
    if (!loaded.ok) return loaded;
    if (options.signal?.aborted) return err(assetLoadCancelled(root));
    if (this.#disposed || this.#source !== source)
      return err(
        new AssetError({
          code: this.#disposed ? 'asset-owner-closed' : 'asset-write-conflict',
          expected: 'the same live asset source until program admission',
          hint: 'load from the current asset owner',
        }),
      );
    for (const guid of visited) {
      const current = source.checkCurrent(guid);
      if (!current.ok) return current;
    }
    for (const { material, ready } of prepared) {
      const projection = installMaterialReadyShaders(
        this.shaderRegistry,
        ready,
        this.materialArtifactRegistry,
      );
      this.materialPayloadProjections.set(material, projection);
    }
    return ok(undefined);
  }

  private rememberSources(staged: ReadonlyMap<string, AssetHandle>): void {
    for (const [guid, handle] of staged) {
      const decoded = this.#source?.entry(guid);
      const value = this.preparedSource(guid);
      this.#runtimeByGuid.set(guid, handle);
      this.#runtimeGuids.set(handle, {
        guid,
        kind: decoded?.kind ?? (value as Asset).kind,
        source: this.#source,
        publication: decoded?.publication,
        contentKey: this.sourceContentKey(guid),
        revision: this.#runtime.version(handle).unwrap(),
      });
    }
  }

  private sourceContentKey(guid: string): string | undefined {
    const inputs: string[] = [];
    const visited = new Set<string>();
    let key = guid;
    for (;;) {
      const entry = this.#source?.entry(key);
      if (entry === undefined || visited.has(key)) return undefined;
      visited.add(key);
      inputs.push(key, entry.digest, ...entry.refs);
      const asset = entry.value as Asset | null;
      if (asset?.kind === 'material') {
        const program = this.materialPayloadProjections.get(asset);
        if (program !== undefined) inputs.push(program.specializationKey);
      }
      if (asset?.kind !== 'material' || asset.parent === undefined) return JSON.stringify(inputs);
      key = materialGuidText(asset.parent).toLowerCase();
    }
  }

  private preparedSource(guid: string): Asset | undefined {
    return this.#source?.entry(guid.toLowerCase())?.value as Asset | undefined;
  }

  private adoptSource(
    key: string,
    visiting: Set<string>,
    staged: Map<string, AssetHandle>,
    policy?: SourceAdoption,
  ): Result<AssetHandle, RuntimeAssetError> {
    const prepared = staged.get(key);
    if (prepared !== undefined) return ok(prepared);
    const existing = this.#runtimeByGuid.get(key);
    if (existing !== undefined && policy === undefined) return ok(existing);
    if (visiting.has(key))
      return err(
        new AssetError({
          code: 'asset-reference-invalid',
          expected: 'an acyclic eager runtime asset closure',
          hint: 'remove the eager dependency cycle; executable plugin references remain deferred',
        }),
      );
    const decoded = this.#source?.entry(key);
    const origin = existing === undefined ? undefined : this.#runtimeGuids.get(existing);
    if (this.#source !== undefined) {
      const current = this.#source.checkCurrent(key);
      if (!current.ok) return current;
    }
    if (existing !== undefined && policy !== undefined) {
      const revision = this.#runtime.version(existing);
      if (!revision.ok) return revision;
      if (
        revision.value > policy.started ||
        (policy.conflict === 'reject' && revision.value !== origin?.revision)
      )
        return err(
          new AssetError({
            code: 'asset-write-conflict',
            expected: `unchanged runtime content for source ${key} until adoption`,
            hint: 'inspect gameplay edits before explicitly reloading with overwrite',
          }),
        );
    }
    const reuse =
      existing !== undefined &&
      origin !== undefined &&
      decoded !== undefined &&
      origin.source === this.#source &&
      this.#runtime.version(existing).unwrap() === origin.revision &&
      origin.contentKey !== undefined &&
      origin.contentKey === this.sourceContentKey(key);
    if (decoded !== undefined && !isBuiltinAssetKind(decoded.kind)) {
      visiting.add(key);
      const dependencies: number[] = [];
      if (decoded.references === 'eager')
        for (const ref of decoded.refs) {
          const child = this.adoptSource(ref.toLowerCase(), visiting, staged, policy);
          if (!child.ok) {
            visiting.delete(key);
            return child;
          }
          dependencies.push(child.value);
        }
      const prepare = this.#decoders.canPrepare(decoded.kind)
        ? (owned: unknown) => this.prepareWithDecoder(decoded.kind, owned, staged)
        : undefined;
      const created =
        reuse && prepare === undefined
          ? ok(existing)
          : this.#runtime.adopt(decoded.kind, decoded.value, dependencies, prepare, existing);
      visiting.delete(key);
      if (created.ok) staged.set(key, created.value);
      return created;
    }
    const source = this.preparedSource(key);
    if (source === undefined)
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `prepared source ${key}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    visiting.add(key);
    const dependencies = new Set<number>();
    const addReferences = (
      guid: string,
      asset: Asset,
      parents: Set<string>,
    ): Result<void, RuntimeAssetError> => {
      if (asset.kind === 'plugin' || this.#source?.entry(guid)?.references === 'deferred')
        return ok(undefined);
      if (asset.kind === 'animation-graph') {
        for (const node of asset.nodes)
          if (node.type === 'clip' && typeof node.clip === 'string') {
            const dependency = this.adoptSource(node.clip.toLowerCase(), visiting, staged, policy);
            if (!dependency.ok) return dependency;
            dependencies.add(dependency.value);
          }
      }
      const parent =
        asset.kind === 'material' && asset.parent !== undefined
          ? materialGuidText(asset.parent).toLowerCase()
          : undefined;
      const refs = new Set([
        ...(this.#source?.entry(guid)?.refs ?? []),
        ...(asset.kind === 'mesh'
          ? [
              ...asset.materialSlots.flatMap((slot) =>
                slot.defaultMaterial !== undefined && typeof slot.defaultMaterial !== 'number'
                  ? [AssetGuid.format(slot.defaultMaterial)]
                  : [],
              ),
              ...(asset.lods ?? []).flatMap((lod) =>
                typeof lod.mesh !== 'number' ? [AssetGuid.format(lod.mesh)] : [],
              ),
            ]
          : []),
      ]);
      for (const ref of refs) {
        const dependencyKey = ref.toLowerCase();
        if (dependencyKey === parent) continue;
        const dependency = this.adoptSource(dependencyKey, visiting, staged, policy);
        if (!dependency.ok) return dependency;
        dependencies.add(dependency.value);
      }
      if (parent !== undefined && !parents.has(parent)) {
        parents.add(parent);
        if (this.#source !== undefined) {
          const current = this.#source.checkCurrent(parent);
          if (!current.ok) return current;
        }
        const parentSource = this.preparedSource(parent);
        if (parentSource !== undefined) return addReferences(parent, parentSource, parents);
      }
      return ok(undefined);
    };
    const linked = addReferences(key, source, new Set());
    if (!linked.ok) {
      visiting.delete(key);
      return linked;
    }
    let content = source;
    if (source.kind === 'scene') {
      const prepared = prepareRuntimeScene(
        source,
        (name) => this.#world?.components.resolve(name) ?? this.componentCatalog.get(name),
        (value, kind) => {
          const dependency =
            typeof value === 'number'
              ? ok(value)
              : this.adoptSource(value.toLowerCase(), visiting, staged, policy);
          if (!dependency.ok) return dependency;
          const valid = this.validate(dependency.value, kind);
          return valid.ok ? dependency : valid;
        },
        decoded?.refs,
      );
      if (!prepared.ok) {
        visiting.delete(key);
        return prepared;
      }
      content = prepared.value.value;
      for (const dependency of prepared.value.dependencies) dependencies.add(dependency);
    }
    // An unchanged root can select newly adopted dependencies. Validate the
    // selected closure before reusing its content identity, including candidate
    // replacements hidden inside AssetRecords' atomic adoption.
    if (reuse && content.kind === 'terrain') {
      const checked = prepareRuntimeTerrain(
        content,
        this.#runtime,
        (guid) => staged.get(guid) ?? this.#runtimeByGuid.get(guid),
      );
      if (!checked.ok) {
        visiting.delete(key);
        return checked;
      }
      this.ownTerrainDerived(checked.value.value);
    }
    const created = reuse
      ? ok(existing)
      : this.createRuntimeContent(
          content,
          [...dependencies],
          staged,
          existing as AssetHandle<BuiltinAssetKind> | undefined,
        );
    visiting.delete(key);
    if (!created.ok) return created;
    staged.set(key, created.value); // One cache hold; each caller/binding retains separately.
    return created;
  }

  dispose(): void {
    if (this.#disposed) return;
    const conflict = this.#runtime.mutationError();
    if (conflict !== undefined) throw conflict;
    this.#disposed = true;
    this.#source?.dispose();
    this.#decoders.dispose();
    this.#runtime.dispose();
    this.#runtimeByGuid.clear();
    this.#runtimeGuids.clear();
    this.clearCatalogSource();
  }

  readonly #publicationCandidates = new WeakMap<
    RuntimePackEnvelope,
    {
      readonly assets: ReadonlyMap<string, Asset>;
      readonly pack: RuntimePackEnvelope;
      readonly rows: readonly CatalogEntry[];
      readonly source: AssetSource | undefined;
      readonly generations: ReadonlyMap<string, number>;
      readonly started: number;
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
    const source = this.#source;
    const started = this.#runtime.currentRevision;
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
    if (key && owned.pack)
      this.#publicationCandidates.set(key, {
        assets: result.value,
        pack: owned.pack,
        rows: owned.rows,
        source,
        generations,
        started,
      });
    // Public retention reads copy on demand. Neither a Map edit nor a byte write can forge readiness.
    return ok(
      new Map(
        [...result.value].map(([guid, asset]) => [guid, async () => copyPreparedAsset(asset)]),
      ),
    );
  }

  /** Consume private preparation once, before the producer publishes its Catalog delta. */
  commitPreparedPublication(pack: RuntimePackEnvelope, beforeCommit?: () => void): void {
    const candidate = this.#publicationCandidates.get(pack);
    const current = () =>
      candidate !== undefined &&
      candidate.source === this.#source &&
      [...candidate.generations].every(
        ([guid, revision]) => this.#source?.revision(guid) === revision,
      );
    if (!candidate || !current())
      throw new TypeError('candidate was not prepared in the current asset context');
    this.#publicationCandidates.delete(pack);
    beforeCommit?.();
    if (!current()) throw new TypeError('asset context changed during publication commit');
    this.#source?.preparePublication(candidate.pack, candidate.rows, candidate.assets);
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
    if (
      !candidate ||
      candidate.source !== this.#source ||
      this.#disposed ||
      [...candidate.generations].some(
        ([guid, revision]) => this.#source?.revision(guid) !== revision,
      )
    ) {
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
      if (
        !source ||
        field.path.length === 0 ||
        field.path[0] === 'kind' ||
        field.path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
      )
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
      replacements.set(guid, changed as Asset);
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
    const adopt = (guid: string): Result<AssetHandle, RuntimeAssetError> => {
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
      if (asset.kind !== 'plugin' && this.#decoders.referencePolicy(row.kind) !== 'deferred')
        for (const ref of row.refs ?? []) {
          const linked = adopt(ref);
          if (!linked.ok) return linked;
          dependencies.push(linked.value);
        }
      if (asset.kind === 'material') {
        const cooked = (asset as MaterialAsset & { cooked?: MaterialReady['record'] }).cooked;
        if (cooked)
          this.materialPayloadProjections.set(
            asset,
            installMaterialReadyShaders(
              this.shaderRegistry,
              { status: 'Ready', record: cooked },
              this.materialArtifactRegistry,
            ),
          );
      }
      let content = asset;
      if (asset.kind === 'scene') {
        // Scene decoder leaves schema-dependent reference indices in source form.
        // Resolve against this candidate's table before treating numbers as handles.
        const linked = this.linkScene(asset, staged, envelopes.get(key)?.refs);
        if (!linked.ok) return linked;
        content = linked.value.value;
        dependencies.push(...linked.value.dependencies);
      }
      const created = this.createRuntimeContent(
        content,
        dependencies,
        staged,
        existing as AssetHandle<Asset['kind']> | undefined,
        sourceContent,
      );
      if (!created.ok) return created;
      staged.set(key, created.value);
      visiting.delete(key);
      return created;
    };
    const result = this.#runtime.adoptClosure(
      () => {
        for (const guid of rows.keys()) {
          const value = adopt(guid);
          if (!value.ok) return value;
        }
        // Scene compilation is pure. Validate nested bindings against the candidate
        // handles before making any material, geometry or scene replacement visible.
        if (this.#world)
          for (const [guid, handle] of staged) {
            if (rows.get(guid)?.kind !== 'scene') continue;
            const asset = this.#runtime.borrow<SceneAsset>(handle).unwrap();
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
                resolveAsset: (source) => this.#runtime.borrow<SceneAsset>(source),
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
      () => beforeCommit?.(staged),
    );
    if (!result.ok) return result;
    for (const [guid, handle] of staged) {
      this.#runtimeByGuid.set(guid, handle);
      if (!this.#runtimeGuids.has(handle))
        this.#runtimeGuids.set(handle, {
          guid,
          kind: this.#runtime.borrow<Asset>(handle).unwrap().kind,
          source: this.#source,
          revision: -1,
          publication: undefined,
          contentKey: undefined,
        });
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
  private catalogSourceDispose: (() => void) | undefined;
  private catalogReplica: CatalogReplica | undefined;

  /** Owner-injected component catalog used for scene breadcrumb projection. */
  readonly componentCatalog: ReadonlyMap<string, Component>;
  /** Current browser-facing asset realm; absent for inline/shipped legacy use. */
  runtimeBinding: RuntimeAssetBinding | undefined = undefined;
  readonly materialArtifactRegistry = new MaterialArtifactRegistry();
  readonly materialPayloadProjections = new WeakMap<object, MaterialRenderProjection>();
  private assetEvidenceAdapter: RuntimeAssetEvidenceAdapter = createRuntimeAssetEvidenceAdapter();

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
    this.#runtime = new AssetRecords(options.limits);
    this.#decoders = new DecoderRegistry(options);
    installRuntimeAssets(
      this,
      this.#runtime,
      this.#runtimeByGuid,
      this.#runtimeGuids,
      this.#decoders,
      () => this.#source,
    );
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
   * `inspect(guid)` and `verifyByGuid(guid)` return the shared state model; an
   * omitted capability remains an explicit structured error, never a pass.
   */
  configureAssetEvidence(source: RuntimeEvidenceSource): void {
    this.assetEvidenceAdapter = createRuntimeAssetEvidenceAdapter(source);
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
    return this.catalogReplica?.get(guid);
  }

  /** Runtime content owns its accepted program projection; no source traversal occurs here. */
  getMaterialProjectionForPayload(material: MaterialAsset): MaterialRenderProjection | undefined {
    const projection = this.materialPayloadProjections.get(material);
    assertMaterialStaticSelection(material.staticSwitches, projection);
    return projection;
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
    this.catalogReplica = this.#source.catalog;
    this.catalogSourceDispose = this.catalogReplica.subscribe((delta) => {
      for (const listener of this.catalogListeners) {
        try {
          listener(delta);
        } catch {
          /* Observer failures cannot revoke an accepted publication. */
        }
      }
    });
    void this.catalogReplica.start();
  }

  clearCatalogSource(): void {
    const conflict = this.#runtime.mutationError();
    if (conflict !== undefined) throw conflict;
    this.#source?.dispose();
    this.#source = undefined;
    this.catalogSourceDispose?.();
    this.catalogSourceDispose = undefined;
    this.assetFetcher = undefined;
    this.catalogReplica = undefined;
    this.catalogEnumerating = undefined;
  }

  enumerateCatalog(): Promise<Result<readonly CatalogEntry[], AssetError>> {
    if (this.catalogEnumerating !== undefined) return this.catalogEnumerating;
    if (this.catalogSource === undefined || this.catalogReplica === undefined) {
      return Promise.resolve(catalogSourceUnconfigured());
    }
    const replica = this.catalogReplica;
    const pending = replica.start();
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

  reconcileCatalog(): Promise<CatalogReconcileResult> {
    return this.catalogReplica?.reconcile() ?? Promise.resolve(catalogSourceUnconfigured());
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
      const valid = this.validate(handle, 'animation-clip');
      return valid.ok ? ok(handle) : valid;
    });
  }

  private linkScene(
    scene: SceneAsset,
    sources: ReadonlyMap<string, AssetHandle> = this.#runtimeByGuid,
    refs?: readonly string[],
  ) {
    return prepareRuntimeScene(
      scene,
      (name) => this.#world?.components.resolve(name) ?? this.componentCatalog.get(name),
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
        const valid = this.validate(handle, kind);
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
    if (guid !== undefined) return this.assetEvidenceAdapter.inspect(guid);
    const assets: InspectEntry[] = [];
    for (const [guid, handle] of this.#runtimeByGuid) {
      const kind = this.#runtime.kind(handle);
      if (kind.ok)
        assets.push({ guid, kind: kind.value, name: this.catalogEntry(guid)?.name ?? '' });
    }
    return { assets };
  }

  /** Verify the same GUID evidence chain through the injected SDK capability. */
  verifyByGuid(guid: string): Promise<Result<AssetEvidence, AssetEvidenceError>> {
    return this.assetEvidenceAdapter.verifyByGuid(guid);
  }

  listCatalog(): readonly CatalogEntry[] {
    return this.catalogSnapshot()?.entries ?? [];
  }
}

/** Domain descriptors use their installed owner for the same admission as source decode. */
function requiresOwnerPreparation(kind: string): boolean {
  return (
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
