// @forgeax/engine-assets-runtime -- scene instantiate collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w6, D-4 + D-1). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). Hosts the SkinJointResolver + PostSpawnHook
// hook-contract types relocated from scene-instances/post-spawn-resolve-joints.ts
// (D-1); w9 wires PostSpawnHook into the AssetRegistry constructor.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  worldDespawnScene,
  worldInstantiateScene,
  worldInstantiateSceneFlat,
  worldSetSceneAssetResolver,
} from '@forgeax/engine-scene';
import type { SkinError } from '@forgeax/engine-skinning';
import {
  type Asset,
  type AssetEnvelope,
  AssetError,
  type CatalogEntry,
  type Handle,
  PACK_ERROR_HINTS,
  type SceneAsset,
  type SkeletonAsset,
  type SkinAsset,
  type TagOf,
  unwrapHandle,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { extractSceneEntityHandleGuids, type SceneHandleFieldEntry } from '../scene-handle-fields';
import {
  compareScenePublicationFences,
  type ScenePublicationFence,
  type ScenePublicationFenceError,
  scenePublicationFenceFromCatalog,
} from './scene-publication-fence';

/**
 * Resolver contract consumed by {@link postSpawnResolveJoints} (D-1: relocated
 * here from scene-instances/post-spawn-resolve-joints.ts so the hook contract
 * travels with the instantiate cluster into @forgeax/engine-assets-runtime).
 */
export interface SkinJointResolver {
  resolveSkinAsset(skeletonHandleRaw: number): SkinAsset | undefined;
}

/** Merge the live Edit Catalog and the Play pack-index projection for fences. */
function catalogEntriesForFence(registry: AssetRegistry): readonly CatalogEntry[] {
  const byGuid = new Map<string, CatalogEntry>();
  for (const entry of registry.catalogSnapshot()?.entries ?? []) {
    byGuid.set(entry.guid.toLowerCase(), entry);
  }
  for (const [guid, record] of registry.packIndexCache ?? []) {
    if (record.sourcePath === undefined) continue;
    const candidate = { ...record, guid, sourcePath: record.sourcePath } as CatalogEntry;
    const current = byGuid.get(guid.toLowerCase());
    if (current === undefined || candidate.publication !== undefined) {
      // A persisted Scene fence is captured from the complete pack-index
      // publication at save time. If the CatalogReplica is still carrying its
      // previous tuple during the watcher handoff, keep the same pack-index
      // authority here or the freshly reopened scene will reject its own
      // mount with asset-generation-fence-mismatch.
      byGuid.set(guid.toLowerCase(), candidate);
    }
  }
  return [...byGuid.values()];
}

/** Resolve the authored SceneEntity identity from the Catalog projection. */
function sceneSourceKeyForGuid(
  registry: AssetRegistry,
  guid: string | undefined,
): string | undefined {
  if (guid === undefined) return undefined;
  const key = guid.toLowerCase();
  const snapshotEntry = registry
    .catalogSnapshot()
    ?.entries.find((entry) => entry.guid.toLowerCase() === key);
  if (snapshotEntry?.sourceKey !== undefined) return snapshotEntry.sourceKey;
  return registry.packIndexCache?.get(key)?.sourceKey;
}

/** Derive a publication fence from the registry's unified live projections. */
export function scenePublicationFenceFromRegistry(
  registry: AssetRegistry,
  outputGuid: string,
): Result<ScenePublicationFence, ScenePublicationFenceError> {
  return scenePublicationFenceFromCatalog(catalogEntriesForFence(registry), outputGuid);
}

/**
 * Validate the producer receipt for every keyed instance edge before the
 * Scene owner starts spawning. The authored declaration carries only the
 * child GUID; the expected generation/digest comes from the parent
 * publication's external evidence, so publication state never leaks into the
 * SceneAsset model.
 */
/** @internal */
export function validateKeyedScenePublication(
  registry: AssetRegistry,
  scene: SceneAsset,
  rootGuid: string | undefined,
): Result<void, ScenePublicationFenceError> {
  if (rootGuid === undefined) return ok(undefined);
  const entries = catalogEntriesForFence(registry);
  const byGuid = new Map(entries.map((entry) => [entry.guid.toLowerCase(), entry]));
  const rootEntry = byGuid.get(rootGuid.toLowerCase());
  const rootPublication = rootEntry?.publication;
  if (rootPublication === undefined) return ok(undefined);
  const visited = new Set<string>();

  const visit = (
    current: SceneAsset,
    parentPublication: typeof rootPublication,
    path: readonly string[],
  ): Result<void, ScenePublicationFenceError> => {
    for (const [entityKey, node] of Object.entries(current.entities)) {
      const source = node.instance?.source;
      if (source === undefined) continue;
      const childGuid = source.toLowerCase();
      const childEntry = byGuid.get(childGuid);
      const childPublication = childEntry?.publication;
      const address = [...path, entityKey].join('/');
      if (childPublication === undefined) {
        return err({
          code: 'asset-generation-fence-mismatch',
          phase: 'instantiate',
          hint: `nested SceneAsset publication is unavailable at ${address}`,
          ...(childEntry?.sourcePath === undefined ? {} : { sourcePath: childEntry.sourcePath }),
          retryable: true,
          recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
        });
      }
      const evidence = parentPublication.externalEvidence.find(
        (item) => item.guid.toLowerCase() === childGuid,
      );
      const childOutput = childPublication.outputs.find(
        (output) => output.guid.toLowerCase() === childGuid,
      );
      if (
        evidence !== undefined &&
        (evidence.generation !== undefined || evidence.digest !== undefined)
      ) {
        if (
          (evidence.generation !== undefined &&
            evidence.generation !== childPublication.generation) ||
          (evidence.digest !== undefined &&
            (childOutput === undefined || evidence.digest !== childOutput.digest))
        ) {
          return err({
            code: 'asset-generation-fence-mismatch',
            phase: 'instantiate',
            hint: `nested SceneAsset publication changed at ${address}`,
            sourcePath: childPublication.sourcePath,
            sourceRevision: childPublication.sourceRevision,
            currentGeneration: childPublication.generation,
            retryable: true,
            recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
          });
        }
      }
      if (visited.has(childGuid)) continue;
      visited.add(childGuid);
      const child =
        childEntry?.guid === undefined ? undefined : registry.assetCatalog.get(childGuid)?.payload;
      if (child?.kind === 'scene') {
        const nested = visit(child, childPublication, [...path, entityKey]);
        if (!nested.ok) return nested;
      }
    }
    return ok(undefined);
  };

  return visit(scene, rootPublication, []);
}

/** Resolve one schema-declared shared-field GUID to a World-owned handle. */
export function resolveHandleGuid(
  registry: AssetRegistry,
  world: World,
  guidString: string,
  guidToHandle: Map<string, number>,
  fieldPath: string,
  location: string,
): Result<number, AssetError> {
  const guidRes = AssetGuid.parse(guidString);
  if (!guidRes.ok) {
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `valid GUID string for field ${fieldPath}`,
        hint: `GUID "${guidString}" could not be parsed; at ${location}, field=${fieldPath}`,
      }),
    );
  }
  const guidKey = guidString.toLowerCase();
  let slot = guidToHandle.get(guidKey);
  if (slot === undefined) {
    const envelope = registry.assetCatalog.get(guidKey);
    if (envelope === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidString} catalogued in AssetRegistry`,
          hint:
            `GUID ${guidString} not catalogued; ` +
            `call loadByGuid('${guidString}') before instantiate; ` +
            `at ${location}, field=${fieldPath}`,
        }),
      );
    }
    slot = unwrapHandle(world.sharedRefs.acquire(envelope.payload.kind, envelope.payload));
    guidToHandle.set(guidKey, slot);
  }
  return ok(slot);
}

/** Match a spawned Skin's skeleton handle to the catalogued SkinAsset bound to that skeleton. */
function skinJointResolver(registry: AssetRegistry, world: World): SkinJointResolver {
  return {
    resolveSkinAsset(skeletonHandleRaw: number) {
      const skelRes = resolveAssetHandle<SkeletonAsset>(
        world,
        skeletonHandleRaw as unknown as Handle<string, 'shared'>,
      );
      if (!skelRes.ok) return undefined;
      const skeletonGuid = registry._guidForAsset(skelRes.value as Asset);
      if (skeletonGuid === undefined) return undefined;
      for (const [, envelope] of registry.assetCatalog) {
        const asset = envelope.payload;
        if (asset.kind !== 'skin') continue;
        if (asset.skeletonGuid?.toLowerCase() === skeletonGuid) return asset;
      }
      return undefined;
    },
  };
}

/**
 * Post-spawn hook contract (D-1). A hook runs after instantiate spawns the
 * scene subtree; the shipped implementation is runtime's `postSpawnResolveJoints`
 * (auto-wire Skin.joints). Injected at the sole production assembly point
 * (createRenderer) in w9/w10; when absent, instantiate skips joint wiring.
 */
export type PostSpawnHook = (
  world: World,
  resolver: SkinJointResolver,
  root: EntityHandle,
) => { ok: true } | { ok: false; error: SkinError };

/** All structured failures produced by either public Scene spawn shape. */
export type SceneInstantiateError =
  | AssetError
  | PackError
  | EcsError
  | ScenePublicationFenceError
  | SkinError;

/** Remove only the entities and grants acquired by this instantiate call. */
function rollbackSpawn(
  world: World,
  roots: readonly EntityHandle[],
  allocHandles: readonly number[],
): void {
  for (const root of new Set(roots)) void worldDespawnScene(world, root);
  for (const raw of allocHandles) void world.sharedRefs.release(raw as never);
}

/** Validate publication and resolve one temporary Scene grant for either spawn shape. */
function prepareSceneInstantiation(
  registry: AssetRegistry,
  sceneAsset: SceneAsset,
  world: World,
  allocHandles: number[],
  expectedPublication?: ScenePublicationFence,
): Result<Handle<'SceneAsset', 'shared'>, SceneInstantiateError> {
  const sceneGuidKey = registry._guidForAsset(sceneAsset);
  const nestedPublication = validateKeyedScenePublication(registry, sceneAsset, sceneGuidKey);
  if (!nestedPublication.ok) return nestedPublication;
  if (expectedPublication !== undefined) {
    const entries = catalogEntriesForFence(registry);
    if (sceneGuidKey === undefined) {
      return err({
        code: 'asset-generation-fence-mismatch',
        phase: 'instantiate',
        hint: 'generated Scene source has no Catalog identity for publication fence validation',
        retryable: true,
        recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
      } as const);
    }
    const current = scenePublicationFenceFromCatalog(entries, sceneGuidKey);
    if (!current.ok) return current;
    const matches = compareScenePublicationFences(expectedPublication, current.value);
    if (!matches.ok) return matches;
  }
  const guidToHandle = new Map<string, number>();
  const resolvedSceneHandles = new Map<string, number>();
  const sceneRes = registry._resolveSceneGuids(
    sceneAsset,
    world,
    sceneGuidKey,
    undefined,
    guidToHandle,
    resolvedSceneHandles,
  );
  if (!sceneRes.ok) {
    rollbackSpawn(world, [], [...resolvedSceneHandles.values(), ...guidToHandle.values()]);
    return sceneRes;
  }
  allocHandles.push(...guidToHandle.values());
  allocHandles.push(...resolvedSceneHandles.values());

  // feat-20260703 M1 (D-1): register the resolved copy -> original
  // catalog GUID in the origin reverse-index so _guidForAsset can
  // find it even after the local sceneGuidKey variable is discarded.
  if (sceneGuidKey !== undefined) {
    registry._originIndex.set(sceneRes.value, sceneGuidKey);
  }

  // Register the GUID-resolved SceneAsset as a shared ref so
  // Scene owner resolves it transparently. The shared
  // grant remains temporary; the SceneInstance source column retains its
  // own reference before this call releases its grant.
  const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  allocHandles.push(unwrapHandle(sharedHandle));

  // Wire the identity resolver so keyed instance.source GUIDs resolved by
  // the registry pass through to the Scene owner.
  // Scene mount resolution calls this resolver; when source is a number (live handle),
  // return it as-is; when source is a string (unresolved GUID),
  // fail (should not happen after resolution, but fail-safe).
  worldSetSceneAssetResolver(world, (source, _parentHandle) => {
    if (typeof source === 'number') {
      return ok(source as unknown as Handle<'SceneAsset', 'shared'>);
    }
    const resolved = resolvedSceneHandles.get(source.toLowerCase());
    if (resolved !== undefined) {
      return ok(resolved as unknown as Handle<'SceneAsset', 'shared'>);
    }
    return err({
      code: 'asset-not-found' as const,
      expected: `mount source GUID ${source} resolved before instantiate`,
      hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
    });
  });
  return ok(sharedHandle);
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
export function instantiate<T extends SceneAsset>(
  registry: AssetRegistry,
  handle: Handle<TagOf<T>, 'shared'>,
  world: World,
  parent?: EntityHandle,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle, SceneInstantiateError> {
  const allocHandles: number[] = [];
  // feat-20260614 M8 (D-15 / D-17): resolve the SceneAsset payload from the
  // handle through the two-tier `resolveAssetHandle` (builtin / user-tier
  // world.sharedRefs) -- the registry holds no handle->payload map. Scene
  // GUID-type component fields are then resolved to fresh user-tier handles
  // via `world.allocSharedRef` (instantiate-time GUID->handle mint). When the
  // handle does not resolve to a scene payload, fall through to the ecs-only
  // path (an externally-resolved SceneAssetResolver handle).
  let instantiateResult: Result<EntityHandle, AssetError | PackError | EcsError>;
  const sceneRes0 = resolveAssetHandle<SceneAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );
  const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
  if (sceneAsset !== undefined && sceneAsset.kind !== 'scene') {
    return err(
      new AssetError({
        code: 'asset-invalid-value',
        expected: 'instantiate handle resolves to a SceneAsset',
        hint: `resolved asset kind was ${sceneAsset.kind}`,
      }),
    );
  }
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    // feat-20260622 M3 / w8: find the scene's GUID key in the catalog
    // so _resolveSceneGuids can reverse-decode from envelope.refs edges.
    const sceneSourceKey = sceneSourceKeyForGuid(registry, registry._guidForAsset(sceneAsset));
    const prepared = prepareSceneInstantiation(
      registry,
      sceneAsset,
      world,
      allocHandles,
      expectedPublication,
    );
    if (!prepared.ok) return prepared;
    const sharedHandle = prepared.value;

    // The Scene API still returns `{ root, diagnostics }` on success. This
    // runtime API keeps its `Result<EntityHandle>` contract and unwraps
    // `root`; schema-invalid authored fields fail before spawning.
    const sceneInst = worldInstantiateScene(world, sharedHandle, parent, sceneSourceKey);
    if (!sceneInst.ok) {
      rollbackSpawn(world, [], allocHandles);
      return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
    }
    instantiateResult = ok(sceneInst.value.root);
  } else {
    // Non-resolvable handle: original ecs direct path (backward compat).
    const sceneInst = worldInstantiateScene(
      world,
      handle as Handle<'SceneAsset', 'shared'>,
      parent,
    );
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
    }
    instantiateResult = ok(sceneInst.value.root);
  }

  // Post-spawn hook: auto-wire Skin.joints from jointPaths. feat-20260614 M8
  // (D-15): the Skin column holds a user-tier SkeletonAsset handle; resolve
  // it to the payload via the two-tier `resolveAssetHandle`, then match the
  // catalogued SkinAsset whose resolved skeleton payload is the same object
  // (the registry holds no handle->guid index).
  //
  // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): the hook is
  // injected via `registry.postSpawnHook` (the sole production assembly point
  // createRenderer wires `postSpawnResolveJoints`). When no hook is present
  // (standalone / test registries without joint-wiring needs), instantiate
  // skips the post-spawn wiring silently -- the resolver closure below stays
  // inline (it reads registry-internal state: assetCatalog / _guidForAsset).
  const hook = registry.postSpawnHook;
  if (hook !== undefined) {
    const resolver = skinJointResolver(registry, world);
    const jointResolveResult = hook(world, resolver, instantiateResult.value);
    if (!jointResolveResult.ok) {
      rollbackSpawn(world, [instantiateResult.value], allocHandles);
      return err(jointResolveResult.error);
    }
  }

  // The spawned source and component columns now own their retained references.
  for (const raw of allocHandles) void world.sharedRefs.release(raw as never);
  return instantiateResult;
}

/**
 * Materialise a `SceneAsset` FLAT into an existing `World` — the "edit the
 * scene itself" registry entry (#655). Shares the GUID-resolution + shared-ref +
 * SceneAssetResolver prelude with {@link instantiate}, but calls
 * `worldInstantiateSceneFlat` instead of `worldInstantiateScene`: NO synthetic
 * SceneInstance root, NO forced `ChildOf` on top-level members. The scene's own
 * entities become plain top-level world entities; nested prefabs (`mounts[]`)
 * still become their own SceneInstance anchors. Returns the set of top-level
 * entity handles.
 *
 * Use this to OPEN a scene for authoring; use {@link instantiate} (anchor) at
 * runtime / Play and for nested prefabs.
 *
 * The post-spawn Skin.joints hook (when wired via `registry.postSpawnHook`)
 * runs once per top-level root: each GLB root keeps its own `ChildOf` subtree,
 * so joint resolution is scoped to each subtree exactly as the anchor path
 * scopes it to the single synthetic root.
 */
export function instantiateFlat<T extends SceneAsset>(
  registry: AssetRegistry,
  handle: Handle<TagOf<T>, 'shared'>,
  world: World,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle[], SceneInstantiateError> {
  const allocHandles: number[] = [];
  let roots: EntityHandle[];
  let mountEntities: EntityHandle[];
  const sceneRes0 = resolveAssetHandle<SceneAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );
  const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    const prepared = prepareSceneInstantiation(
      registry,
      sceneAsset,
      world,
      allocHandles,
      expectedPublication,
    );
    if (!prepared.ok) return prepared;
    const sharedHandle = prepared.value;
    const sceneInst = worldInstantiateSceneFlat(world, sharedHandle);
    if (!sceneInst.ok) {
      rollbackSpawn(world, [], allocHandles);
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
    mountEntities = sceneInst.value.mountEntities;
  } else {
    const sceneInst = worldInstantiateSceneFlat(world, handle as Handle<'SceneAsset', 'shared'>);
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
    mountEntities = sceneInst.value.mountEntities;
  }

  // Post-spawn Skin.joints wiring, per top-level root. Mirrors the anchor
  // path's hook (D-1: injected via `registry.postSpawnHook`); when no hook is
  // present the flat path skips joint wiring silently.
  const hook = registry.postSpawnHook;
  if (hook !== undefined) {
    const resolver = skinJointResolver(registry, world);
    const hookRoots = new Set<EntityHandle>(roots);
    for (const mountEntity of mountEntities) hookRoots.add(mountEntity);
    for (const root of hookRoots) {
      const jointResolveResult = hook(world, resolver, root);
      if (!jointResolveResult.ok) {
        rollbackSpawn(world, [...roots, ...mountEntities], allocHandles);
        return err(jointResolveResult.error);
      }
    }
  }

  // Spawned component columns retain their resources; the flat top-level
  // scene has no source column to own these temporary producer grants.
  for (const raw of allocHandles) void world.sharedRefs.release(raw as never);
  return ok(roots);
}

/**
 * tweak-20260609 M1 helper: build the per-sub-ref parent context for a
 * SceneAsset child. feat-20260622 M3 / w9: re-sourced to lookup in the
 * scene envelope's ``refs[]`` edges instead of walking entity components
 * via extractSceneEntityHandleGuids (D-7). When the scene envelope is not
 * found in the catalog, falls back to the entity-walk path (backward compat
 * for call sites that lack a catalogued envelope).
 *
 * Texture edges (sourceField=undefined) produce ``componentField:
 * undefined`` — the breadcrumb will show GUID+kind only, no per-entity
 * detail (D-2: texture has no per-entity origin).
 */
export function buildSceneChildContext(
  registry: AssetRegistry,
  scene: Asset & { kind: 'scene' },
  subGuidKey: string,
  sceneGuidKey?: string,
):
  | {
      sceneEntityKey?: string;
      componentField?: string;
      sourceField?: {
        componentName?: string;
        fieldName: string;
        arrayIndex?: number;
      };
    }
  | undefined {
  return createSceneChildContextLookup(registry, scene)(subGuidKey, sceneGuidKey);
}

/** @internal One synchronous dependency traversal owns this lazy origin index. */
export function createSceneChildContextLookup(
  registry: AssetRegistry,
  scene: Asset & { kind: 'scene' },
): (subGuidKey: string, sceneGuidKey?: string) => ReturnType<typeof buildSceneChildContext> {
  let origins: Map<string, SceneHandleFieldEntry> | undefined;
  return (subGuidKey, sceneGuidKey) => {
    // feat-20260622 M3 / w9: direct lookup in envelope.refs edges.
    // feat-20260622 review r1: address the recursing scene's OWN envelope by
    // its guidKey, not the first scene in the catalog -- under a multi-scene
    // glTF catalog the first-scene scan attributes the breadcrumb to the wrong
    // scene. Fall back to the first-scene scan only when no guidKey is given
    // (legacy call sites lacking a catalogued envelope).
    let sceneEnvelope: AssetEnvelope | undefined;
    if (sceneGuidKey !== undefined) {
      const env = registry.assetCatalog.get(sceneGuidKey);
      if (env?.kind === 'scene') sceneEnvelope = env;
    }
    if (sceneEnvelope === undefined) {
      for (const [, env] of registry.assetCatalog) {
        if (env.kind === 'scene' && env.refs !== undefined && env.refs.length > 0) {
          sceneEnvelope = env;
          break;
        }
      }
    }
    let edgeResult:
      | {
          sceneEntityKey?: string;
          componentField?: string;
        }
      | undefined;
    if (sceneEnvelope?.refs !== undefined) {
      for (const ref of sceneEnvelope.refs) {
        if (ref.guid.toLowerCase() === subGuidKey) {
          const { sceneEntityKey, sourceField } = ref;
          const result: {
            sceneEntityKey?: string;
            componentField?: string;
            sourceField?: {
              componentName?: string;
              fieldName: string;
              arrayIndex?: number;
            };
          } = {};
          if (sceneEntityKey !== undefined) {
            result.sceneEntityKey = sceneEntityKey;
          }
          if (sourceField?.componentName !== undefined && sourceField?.fieldName !== undefined) {
            result.componentField =
              `${sourceField.componentName}.${sourceField.fieldName}` +
              (sourceField.arrayIndex !== undefined ? `[${sourceField.arrayIndex}]` : '');
          }
          if (sourceField !== undefined) {
            result.sourceField = sourceField;
          }
          // A rich edge (dev register path) carries full detail — return now.
          if (result.sceneEntityKey !== undefined || result.componentField !== undefined) {
            return result;
          }
          // feat-20260622 M4 / w14: a GUID-only edge (prod path: on-disk refs[]
          // strip sourceField / sceneEntityKey at the serialization boundary, w7
          // D-10) carries no per-entity detail. Keep this empty-but-defined
          // result as the fallback, then try the entity walk below to recover
          // the entity localId + component.field path (D-7 / B-8). The walk
          // recovers handle-field edges (mesh / material); a texture edge (D-2:
          // no per-entity origin) is not found by the walk, so the empty
          // edgeResult is returned (w10 texture-edge contract preserved).
          edgeResult = result;
          break;
        }
      }
    }
    // Backward compat: fall back to entity walk when the envelope edge carries
    // no per-entity detail (prod path: GUID-only refs[]) or no envelope is
    // available (e.g. direct catalog() registration with scene payload, no refs).
    if (origins === undefined) {
      const extracted = extractSceneEntityHandleGuids(
        registry.componentCatalog,
        scene.entities,
        sceneEnvelope?.refs?.map((ref) => ref.guid),
      );
      const index = new Map<string, SceneHandleFieldEntry>();
      for (const entry of extracted) {
        const key = entry.guidString.toLowerCase();
        if (!index.has(key)) index.set(key, entry);
      }
      origins = index;
    }
    const entry = origins.get(subGuidKey);
    if (entry !== undefined) {
      return {
        sceneEntityKey: entry.entityKey,
        componentField: `${entry.componentName}.${entry.fieldName}${entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : ''}`,
        // feat-20260622 verify r1: also surface the recovered provenance in
        // structured parts so the failure `.detail` can expose them for AI
        // property access (charter P3), not only the concatenated hint string.
        sourceField: {
          componentName: entry.componentName,
          fieldName: entry.fieldName,
          ...(entry.arrayIndex !== undefined ? { arrayIndex: entry.arrayIndex } : {}),
        },
      };
    }
    return edgeResult;
  };
}

/**
 * tweak-20260609 M1 helper: build the error-hint breadcrumb string
 * containing the parent asset's GUID + kind, enriched with the
 * caller-provided `parentContext` (entity localId + component.field).
 *
 * Per D-7 / B-8: the breadcrumb appears before the sub-asset's own hint,
 * separated by " / ".
 */
export function buildBreadcrumbHint(
  parentGuidKey: string,
  parentKind: string,
  subGuidKey: string,
  parentContext?: {
    sceneEntityKey?: string;
    componentField?: string;
  },
): string {
  let breadcrumb = `sub-asset ${subGuidKey} referenced by ${parentKind} ${parentGuidKey}`;
  const entity = parentContext?.sceneEntityKey;
  if (entity !== undefined && parentContext?.componentField !== undefined) {
    breadcrumb += ` (entity ${entity}, field ${parentContext.componentField})`;
  }
  return breadcrumb;
}
