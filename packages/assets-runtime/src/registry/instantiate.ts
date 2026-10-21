// @forgeax/engine-assets-runtime -- scene instantiate collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w6, D-4 + D-1). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). Hosts the SkinJointResolver + PostSpawnHook
// hook-contract types relocated from scene-instances/post-spawn-resolve-joints.ts
// (D-1); w9 wires PostSpawnHook into the AssetRegistry constructor.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  worldDespawnScene,
  worldInstantiateScene,
  worldInstantiateSceneFlat,
} from '@forgeax/engine-scene';
import type { SkinError } from '@forgeax/engine-skinning';
import type {
  Asset,
  AssetError,
  AssetHandle,
  CatalogEntry,
  SceneAsset,
  SkinAsset,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';
import {
  runtimeAssetReference,
  runtimeAssetSource,
  runtimeAssets,
} from '../internal/runtime-assets';
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

/** Publication fences read the single accepted source Catalog. */
function catalogEntriesForFence(registry: AssetRegistry): readonly CatalogEntry[] {
  return registry.catalogSnapshot()?.entries ?? [];
}

function sceneSourceKeyForGuid(
  registry: AssetRegistry,
  guid: string | undefined,
): string | undefined {
  return guid === undefined ? undefined : registry.catalogEntry(guid)?.sourceKey;
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
      const childGuid =
        typeof source === 'string' ? source.toLowerCase() : runtimeAssetSource(registry, source);
      // A runtime-created nested scene has no producer publication fence.
      if (childGuid === undefined) continue;
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
      const reference =
        typeof source === 'number' ? source : runtimeAssetReference(registry, childGuid);
      const borrowed =
        reference === undefined ? undefined : runtimeAssets(registry).borrow<Asset>(reference);
      const child = borrowed?.ok ? borrowed.value : undefined;
      if (child?.kind === 'scene') {
        const nested = visit(child, childPublication, [...path, entityKey]);
        if (!nested.ok) return nested;
      }
    }
    return ok(undefined);
  };

  return visit(scene, rootPublication, []);
}

/** Joint binding inspects only the selected Scene's already held dependency closure. */
function skinJointResolver(
  registry: AssetRegistry,
  scene: AssetHandle<'scene'>,
): SkinJointResolver {
  const bySkeleton = new Map<string, SkinAsset>();
  const records = runtimeAssets(registry);
  for (const asset of records.borrowClosure<Asset>([scene]).unwrap().values()) {
    if (asset.kind === 'skin' && asset.skeletonGuid !== undefined)
      bySkeleton.set(asset.skeletonGuid.toLowerCase(), asset);
  }
  return {
    resolveSkinAsset(handle) {
      const guid = runtimeAssetSource(registry, handle);
      return guid === undefined ? undefined : bySkeleton.get(guid);
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

/** Validate the source publication before any instance or component reference is created. */
function prepareSceneInstantiation(
  registry: AssetRegistry,
  handle: AssetHandle<'scene'>,
  world: World,
  expectedPublication?: ScenePublicationFence,
): Result<string | undefined, SceneInstantiateError> {
  const bound = world.bindAssets(registry);
  if (!bound.ok) return bound;
  const valid = registry.validate(handle, 'scene');
  if (!valid.ok) return valid;
  const scene = registry.read(handle);
  if (!scene.ok) return scene;
  const guid = runtimeAssetSource(registry, handle);
  const nested = validateKeyedScenePublication(registry, scene.value, guid);
  if (!nested.ok) return nested;
  if (expectedPublication !== undefined) {
    if (guid === undefined)
      return err({
        code: 'asset-generation-fence-mismatch',
        phase: 'instantiate',
        hint: 'the Scene source has no Catalog identity for publication fence validation',
        retryable: true,
        recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
      });
    const current = scenePublicationFenceFromCatalog(catalogEntriesForFence(registry), guid);
    if (!current.ok) return current;
    const matches = compareScenePublicationFences(expectedPublication, current.value);
    if (!matches.ok) return matches;
  }
  return ok(sceneSourceKeyForGuid(registry, guid));
}

/** Instantiate the current Scene content, retaining its original managed identity. */
export function instantiate(
  registry: AssetRegistry,
  handle: AssetHandle<'scene'>,
  world: World,
  parent?: EntityHandle,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle, SceneInstantiateError> {
  const prepared = prepareSceneInstantiation(registry, handle, world, expectedPublication);
  if (!prepared.ok) return prepared;
  const spawned = worldInstantiateScene(world, handle, parent, prepared.value);
  if (!spawned.ok) return spawned;
  const hook = registry.postSpawnHook?.(
    world,
    skinJointResolver(registry, handle),
    spawned.value.root,
  );
  if (hook !== undefined && !hook.ok) {
    worldDespawnScene(world, spawned.value.root);
    return err(hook.error);
  }
  return ok(spawned.value.root);
}

/** Expand top-level Scene members directly; nested instances retain their own source identity. */
export function instantiateFlat(
  registry: AssetRegistry,
  handle: AssetHandle<'scene'>,
  world: World,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle[], SceneInstantiateError> {
  const prepared = prepareSceneInstantiation(registry, handle, world, expectedPublication);
  if (!prepared.ok) return prepared;
  const spawned = worldInstantiateSceneFlat(world, handle);
  if (!spawned.ok) return spawned;
  if (registry.postSpawnHook !== undefined) {
    const roots = new Set([...spawned.value.roots, ...spawned.value.mountEntities]);
    const resolver = skinJointResolver(registry, handle);
    for (const root of roots) {
      const hook = registry.postSpawnHook(world, resolver, root);
      if (!hook.ok) {
        for (const spawnedRoot of roots) worldDespawnScene(world, spawnedRoot);
        return err(hook.error);
      }
    }
  }
  return ok(spawned.value.roots);
}

/** Derive child error provenance from the Scene fields and its source reference table. */
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
    if (origins === undefined) {
      const extracted = extractSceneEntityHandleGuids(
        registry.componentCatalog,
        scene.entities,
        sceneGuidKey === undefined ? undefined : registry.catalogEntry(sceneGuidKey)?.refs,
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
    return undefined;
  };
}
