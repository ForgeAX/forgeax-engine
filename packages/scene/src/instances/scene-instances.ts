import { sceneTopoSort, sceneTopoSortSteps } from './scene-topology';
// @forgeax/engine-scene — scene instantiation and instance-state subsystem.

import {
  type Component,
  type ComponentData,
  type ComponentSchema,
  type EcsError,
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type InputShapeOf,
  type ShapeOf,
  type World,
} from '@forgeax/engine-ecs';
import { classifyEntityField, remapEntityFieldValue } from '@forgeax/engine-ecs/externalization';
import { componentSchema, releaseUnadoptedUniqueRef } from '@forgeax/engine-ecs/internal';
import {
  fillComponentDefaults,
  readRenderArrayView,
  StaleEntityError,
} from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type {
  AssetHandle,
  LocalEntityId,
  PackErrorCode,
  PackErrorDetail,
  SceneAsset,
  SceneEntityAddress,
  SceneEntityRef,
} from '@forgeax/engine-types';
import {
  AssetError,
  err,
  ok,
  PACK_ERROR_HINTS,
  type Result,
  toUnique,
} from '@forgeax/engine-types';
import { collectSubtree } from '../collect-subtree';
import { ComponentNotDefinedError } from '../errors';
import { resolveSceneEntity, sceneEntityAddressKey } from './binding.js';
import {
  type CompiledSceneAsset,
  type CompiledSceneEntity,
  type CompiledSceneResult,
  compileKeyedSceneAsset,
  compileKeyedSceneAssetSteps,
} from './keyed.js';
import { sceneMemberSlotCountSteps } from './member-layout';
import type { MountOverride, SceneInstanceMount } from './runtime-types.js';
import { retainSceneSourceReferences } from './source-references.js';
import {
  isPrimitiveScalarFieldType,
  mountOverrideStateKey,
  primitiveJsType,
  type SceneInstanceState,
  sceneWorldState,
} from './state.js';

export type { SceneInstanceOverrideRecord, SceneInstanceState } from './state.js';

const entityIndex = (entity: EntityHandle): number => (entity as number) & 0x00ffffff;
const entityGeneration = (entity: EntityHandle): number => ((entity as number) >>> 24) & 0xff;

/**
 * Success value of `worldInstantiateScene`. `root` is the synthetic scene-root
 * EntityHandle (carries `SceneInstance`). Schema-invalid authored fields fail
 * before an entity is created.
 */
export type SceneInstantiateOk = {
  readonly root: EntityHandle;
};

/**
 * Success value of `worldInstantiateSceneFlat` — the "edit the scene itself"
 * primitive. Unlike `instantiateScene`, NO synthetic SceneInstance root is
 * minted and NO `ChildOf` is forced onto top-level members: the scene's own
 * entities become plain top-level world entities whose hierarchy is exactly
 * their authored `ChildOf` (an entity with no `ChildOf` stays a root). `roots`
 * is the set of those top-level handles (own rootless entities + top-level
 * mount carriers). Nested prefabs inside the scene STILL materialise as their
 * own SceneInstance anchors (charter P4: instance == entity-with-SceneInstance)
 * — only THIS scene is flat.
 */
export type SceneInstantiateFlatOk = {
  readonly roots: EntityHandle[];
  /**
   * All mount carrier entities spawned while flattening this scene. These are
   * separate from `roots`: carriers with an authored parent are not roots,
   * but still delimit a nested prefab subtree for post-spawn hooks.
   */
  readonly mountEntities: EntityHandle[];
};

/**
 * @internal Intermediate produced by `_spawnSceneMembers` and consumed by both
 * the anchor finisher (`_instantiateSceneAsset`) and the flat finisher
 * (`_instantiateSceneAssetFlat`). Holds everything the shared member-spawn
 * (mounts recursion + own-entity spawn + deferred owned-parent wiring) computes,
 * before either finisher decides whether to wrap the members in a synthetic
 * SceneInstance root.
 */
export interface SceneMembersSpawn {
  /** LocalEntityId → live Entity u32 (ENTITY_NULL_RAW for unspawned slots). */
  readonly mapping: Uint32Array;
  /** Reverse map live Entity → LocalEntityId for override / detach bookkeeping. */
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  /** Own entities that carried no `ChildOf` — the scene's authored top-level roots. */
  readonly rootEntities: EntityHandle[];
  /** Mount carriers whose `mount.parent === undefined` (default-parented). */
  readonly mountEntitiesNeedingRootParent: EntityHandle[];
  /** Every mount carrier spawned by this scene, including explicitly parented carriers. */
  readonly mountEntities: EntityHandle[];
  /**
   * The child anchor and mapping for each mount. Flat scene opening has no
   * outer SceneInstance state to own parent-namespace mount overrides, so it
   * records those overrides on this child anchor after the shared spawn pass.
   */
  readonly mountInstances: readonly {
    readonly mount: SceneInstanceMount;
    readonly root: EntityHandle;
    readonly mapping: Uint32Array;
    readonly key?: string;
  }[];
  /** `entities.length + mounts + Σ memberCount`, captured at instantiate-time. */
  readonly totalSlots: number;
}

/**
 * Populate the instance binding projection from the private numeric mapping.
 * The authored key remains the only lookup identity: nested instance paths are
 * represented as the same string/tuple key accepted by `SceneEntityRef`, while
 * the numeric mapping stays local to the Scene owner.
 */
function* collectSceneEntityBindingsSteps(
  world: World,
  root: EntityHandle,
  prefix: readonly string[],
  bindings: Map<string, EntityHandle>,
  addresses: Map<EntityHandle, SceneEntityAddress>,
  incremental: boolean,
  visited = new Set<number>(),
): Generator<void, void, void> {
  const rootRaw = root as unknown as number;
  if (visited.has(rootRaw)) return;
  visited.add(rootRaw);
  const state = worldGetSceneInstanceState(world, root);
  if (!state.ok) return;
  const sceneInstance = world.components.resolve('SceneInstance');
  if (sceneInstance === undefined) return;
  const component = world.get(root, sceneInstance);
  if (!component.ok) return;
  const mapping = Array.from(
    (component.value as unknown as { mapping: ArrayLike<number> }).mapping,
  );
  for (const [slot, key] of state.value.keyByLocalId) {
    if (incremental) yield;
    const raw = mapping[slot];
    if (raw === undefined || raw === ENTITY_NULL_RAW) continue;
    const address: SceneEntityAddress =
      prefix.length === 0 ? key : ([...prefix, key] as unknown as [string, ...string[]]);
    bindings.set(sceneEntityAddressKey(address), raw as unknown as EntityHandle);
    addresses.set(raw as unknown as EntityHandle, address);
  }
  for (const childRoot of state.value.mountRoots) {
    if (incremental) yield;
    const childState = worldGetSceneInstanceState(world, childRoot);
    const childKey = childState.ok ? childState.value.instanceKey : undefined;
    if (childKey === undefined) continue;
    yield* collectSceneEntityBindingsSteps(
      world,
      childRoot,
      [...prefix, childKey],
      bindings,
      addresses,
      incremental,
      visited,
    );
  }
}

/** Explicit owner capabilities for fixed-content, suspended instance construction.
 * The owner validates its captured content/schema guard before each resume and
 * retains every newly materialized entity, including a partial failed instance.
 * This type is engine-internal; it does not make content Prepared by itself.
 */
export interface SceneInstantiationContext {
  readonly incremental: boolean;
  /** The owner guarantees deterministic source resolution under its fixed closure and schema guard. */
  readonly fixedSource?: true;
  readonly resolveAsset: (handle: AssetHandle<'scene'>) => Result<SceneAsset, EcsError>;
  readonly resolveSource: (
    source: number | string,
    parent: AssetHandle<'scene'>,
  ) => Result<AssetHandle<'scene'>, EcsError>;
  readonly materialize: (components: readonly ComponentData[]) => Result<EntityHandle, EcsError>;
  readonly retainSource: (asset: SceneAsset) => Result<() => void, EcsError>;
  /** Track effective author intent after a successfully applied, remapped override. */
  readonly applyOverride: (entity: EntityHandle, override: MountOverride) => Result<void, EcsError>;
}

type SceneMaterialization = SceneInstantiationContext & {
  readonly fixedPlans?: Map<AssetHandle<'scene'>, CompiledSceneResult>;
};

function synchronousSceneContext(world: World): SceneInstantiationContext {
  return {
    incremental: false,
    resolveAsset: (handle) => worldResolveSceneAsset(world, handle),
    resolveSource: (source, parent) => worldResolveMountSource(world, source, parent),
    materialize: (components) => world.spawn(...components),
    retainSource: (asset) => retainSceneSourceReferences(world, asset),
    applyOverride: (entity, override) => worldApplyMountOverride(world, entity, override),
  };
}

function finishSceneSteps<T>(steps: Generator<void, T, void>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

export type SceneAssetResolver = (
  source: number | string,
  parent: AssetHandle<'scene'>,
) => Result<AssetHandle<'scene'>, unknown>;

/** @internal */
export function worldSetSceneAssetResolver(world: World, resolver: SceneAssetResolver): void {
  sceneWorldState(world).resolver = resolver;
}

/** @internal */
export function worldGetSceneAssetResolver(world: World): SceneAssetResolver | null {
  return sceneWorldState(world).resolver as SceneAssetResolver | null;
}

/**
 * Materialise a SceneAsset (and any nested SceneAsset references via
 * `mounts[]`) into live entities. Returns the synthetic root Entity that
 * carries the `SceneInstance` ECS component (charter P4: instance ==
 * entity-with-SceneInstance).
 *
 * Recursion path is closed inside `_instantiateSceneRec(handle, parent,
 * stack)` (D-3); cycle detection is fail-fast `pack-cyclic-reference +
 * detail.kind:'mount-asset'` (D-1 mirror, plan-strategy §D-3). The
 * caller-supplied `parent` flows to the synthetic root's `ChildOf` so the
 * full sub-tree attaches under the AI user's host entity.
 *
 * @example
 *   const r = worldInstantiateScene(world, handle);
 *   if (!r.ok) return r;
 *   const { root } = r.value;
 *   const inst = world.get(root, SceneInstance).value;
 *   const member = inst.mapping[0]; // first member entity
 */
export function worldInstantiateScene(
  world: World,
  handle: AssetHandle<'scene'>,
  parent?: EntityHandle,
  sceneSourceKey?: string,
): Result<SceneInstantiateOk, EcsError> {
  const r = worldInstantiateSceneRec(
    world,
    handle,
    parent,
    new Set<number>(),
    undefined,
    sceneSourceKey,
  );
  if (!r.ok) return r;
  return ok({ root: r.value });
}

/**
 * Materialise a SceneAsset FLAT — the "edit the scene itself" primitive.
 * Unlike `instantiateScene`, this mints NO synthetic SceneInstance root and
 * forces NO `ChildOf` onto top-level members: the scene's own entities become
 * plain top-level world entities whose hierarchy is exactly their authored
 * `ChildOf` (an entity with no `ChildOf` is a root). Use this to OPEN a scene
 * for editing; use `instantiateScene` (anchor) at runtime / for nested
 * prefabs where an instance boundary + override isolation is wanted.
 *
 * Nested prefabs referenced via `mounts[]` STILL materialise as their own
 * SceneInstance anchors (charter P4 preserved) — only THIS top scene is flat.
 *
 * @example
 *   const r = worldInstantiateSceneFlat(world, handle);
 *   if (!r.ok) return r;
 *   const { roots } = r.value; // roots = top-level handles
 */
export function worldInstantiateSceneFlat(
  world: World,
  handle: AssetHandle<'scene'>,
): Result<SceneInstantiateFlatOk, EcsError> {
  const stack = new Set<number>();
  const handleKey = handle as number;
  const resolved = worldResolveSceneAsset(world, handle);
  if (!resolved.ok) return resolved;
  stack.add(handleKey);
  let r: Result<{ roots: EntityHandle[]; mountEntities: EntityHandle[] }, EcsError>;
  try {
    r = worldInstantiateSceneAssetFlat(world, handle, resolved.value, stack);
  } finally {
    stack.delete(handleKey);
  }
  if (!r.ok) return r;
  return r;
}
/**
 * @internal Recursive helper carrying the cycle-detection stack. Sugar /
 * other public callers must not see this mechanic — use `instantiateScene`
 * (D-3 / charter P1).
 */
export function worldInstantiateSceneRec(
  world: World,
  handle: AssetHandle<'scene'>,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  instanceKey?: string,
  sceneSourceKey?: string,
): Result<EntityHandle, EcsError> {
  return finishSceneSteps(
    worldInstantiateSceneSteps(
      world,
      handle,
      synchronousSceneContext(world),
      parent,
      stack,
      instanceKey,
      sceneSourceKey,
    ),
  );
}

/** Resume only at an exclusive legal World boundary, after the owner guard. */
export function* worldInstantiateSceneSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  context: SceneInstantiationContext,
  parent?: EntityHandle,
  stack = new Set<number>(),
  instanceKey?: string,
  sceneSourceKey?: string,
): Generator<void, Result<EntityHandle, EcsError>, void> {
  return yield* instantiateSceneSteps(
    world,
    handle,
    context.fixedSource === true ? { ...context, fixedPlans: new Map() } : context,
    parent,
    stack,
    instanceKey,
    sceneSourceKey,
  );
}

function* instantiateSceneSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  context: SceneMaterialization,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  instanceKey?: string,
  sceneSourceKey?: string,
): Generator<void, Result<EntityHandle, EcsError>, void> {
  if (context.incremental) yield;
  const handleKey = handle as number;
  if (stack.has(handleKey)) {
    const cycleArr: string[] = [];
    for (const k of stack) cycleArr.push(String(k));
    cycleArr.push(String(handleKey));
    const detail: PackErrorDetail = {
      code: 'pack-cyclic-reference',
      kind: 'mount-asset',
      cycle: cycleArr,
    };
    return err({
      code: 'pack-cyclic-reference' as PackErrorCode,
      expected: 'acyclic SceneAsset mount graph',
      hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
      detail,
    } as unknown as EcsError);
  }
  const resolved = context.resolveAsset(handle);
  if (!resolved.ok) return resolved;
  const asset = resolved.value;
  stack.add(handleKey);
  try {
    return yield* worldInstantiateSceneAssetSteps(
      world,
      handle,
      asset,
      parent,
      stack,
      context,
      instanceKey,
      sceneSourceKey,
    );
  } finally {
    stack.delete(handleKey);
  }
}
/** Resolve through the runtime asset owner, with optional schema/GUID preparation. */
export function worldResolveSceneAsset(
  world: World,
  handle: AssetHandle<'scene'>,
): Result<SceneAsset, EcsError> {
  const owner = world.assets;
  const valid = owner?.validate(handle, 'scene');
  if (owner === undefined || valid === undefined || !valid.ok) {
    return err(
      (valid !== undefined && !valid.ok
        ? valid.error
        : new AssetError({
            code: 'asset-reference-invalid',
            expected: 'a Scene reference owned by this World',
            hint: 'bind the runtime asset owner before instantiating a scene',
          })) as unknown as EcsError,
    );
  }
  const result = owner.read(handle);
  return result.ok ? ok(result.value) : err(result.error as EcsError);
}
/** Spawn owned members and nested anchors, leaving outer-root attachment to the finisher. */
export function worldSpawnSceneMembers(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: CompiledSceneAsset,
  stack: Set<number>,
  mountKeys?: ReadonlyMap<number, string>,
): Result<SceneMembersSpawn, EcsError> {
  return finishSceneSteps(
    worldSpawnSceneMembersSteps(
      world,
      handle,
      asset,
      stack,
      synchronousSceneContext(world),
      mountKeys,
    ),
  );
}

interface SceneMemberWork extends SceneMembersSpawn {
  readonly mountEntitiesNeedingDeferredParent: Array<[EntityHandle, number]>;
  readonly mountInstances: Array<SceneMembersSpawn['mountInstances'][number]>;
}

function setSceneParent(
  world: World,
  entity: EntityHandle,
  childOf: Component,
  parent: EntityHandle,
): Result<void, EcsError> {
  return world.hasComponent(entity, childOf)
    ? world.set(entity, childOf, { parent } as never)
    : world.addComponent(entity, { component: childOf, data: { parent } as never });
}

function* worldSpawnSceneMembersSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: CompiledSceneAsset,
  stack: Set<number>,
  context: SceneMaterialization,
  mountKeys?: ReadonlyMap<number, string>,
): Generator<void, Result<SceneMembersSpawn, EcsError>, void> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const childOfToken = world.components.resolve('ChildOf');

  const ownEntities = asset.entities;
  const ownMounts = asset.mounts ?? [];
  const slots = yield* sceneMemberSlotCountSteps(ownEntities, ownMounts, context.incremental);
  if (!slots.ok) return slots;
  const totalSlots = slots.value;

  // Raw entity zero is live; empty slots must use the explicit null sentinel.
  const mapping = new Uint32Array(totalSlots).fill(ENTITY_NULL_RAW);
  const entityToLocalId = new Map<EntityHandle, LocalEntityId>();
  const rootEntities: EntityHandle[] = [];
  const mountEntities: EntityHandle[] = [];
  const mountEntitiesNeedingRootParent: EntityHandle[] = [];
  const mountEntitiesNeedingDeferredParent: Array<[EntityHandle, number]> = [];
  const mountInstances: Array<{
    readonly mount: SceneInstanceMount;
    readonly root: EntityHandle;
    readonly mapping: Uint32Array;
  }> = [];

  const members: SceneMemberWork = {
    mapping,
    entityToLocalId,
    rootEntities,
    mountEntitiesNeedingRootParent,
    mountEntitiesNeedingDeferredParent,
    mountEntities,
    mountInstances,
    totalSlots,
  };
  const mounted = yield* spawnSceneMountsSteps(
    world,
    handle,
    ownMounts,
    stack,
    context,
    members,
    mountKeys,
  );
  if (!mounted.ok) return mounted;

  const own = yield* spawnSceneOwnMembersSteps(world, ownEntities, context, members);
  if (!own.ok) return own;

  const rebound = yield* rebindSceneMembersSteps(
    world,
    ownEntities,
    ownMounts,
    mapping,
    context.incremental,
  );
  if (!rebound.ok) return rebound;

  if (childOfToken !== undefined) {
    for (const [mountEntity, parentSlot] of mountEntitiesNeedingDeferredParent) {
      const parentEntity = mapping[parentSlot];
      if (parentEntity === undefined || parentEntity === ENTITY_NULL_RAW) continue;
      if (context.incremental) yield;
      const attached = setSceneParent(
        world,
        mountEntity,
        childOfToken,
        parentEntity as EntityHandle,
      );
      if (!attached.ok) return attached;
    }
  }

  return ok({
    mapping,
    entityToLocalId,
    rootEntities,
    mountEntitiesNeedingRootParent,
    mountEntities,
    mountInstances,
    totalSlots,
  });
}
function* spawnSceneMountsSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  ownMounts: readonly SceneInstanceMount[],
  stack: Set<number>,
  context: SceneMaterialization,
  members: SceneMemberWork,
  mountKeys?: ReadonlyMap<number, string>,
): Generator<void, Result<void, EcsError>, void> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) return err(new ComponentNotDefinedError('SceneInstance'));
  const childOfToken = world.components.resolve('ChildOf');
  const {
    mapping,
    mountEntities,
    mountEntitiesNeedingRootParent,
    mountEntitiesNeedingDeferredParent,
    mountInstances,
  } = members;
  // Mount windows exist before owned members resolve cross-instance references.
  for (const mount of ownMounts) {
    if (context.incremental) yield;
    const overrideValidationRes = worldValidateMountOverrides(world, mount);
    if (!overrideValidationRes.ok) {
      return overrideValidationRes;
    }

    const mountLid = mount.localId as unknown as number;
    const mountSpawnRes = worldSpawnMountEntity(world, mount, mapping, context.materialize);
    if (!mountSpawnRes.ok) return mountSpawnRes;
    const mountEntity = mountSpawnRes.value;
    mountEntities.push(mountEntity);
    mapping[mountLid] = mountEntity as unknown as number;

    const childHandleRes = context.resolveSource(mount.source, handle);
    if (!childHandleRes.ok) return childHandleRes;
    const childHandle = childHandleRes.value;

    const childRes = yield* instantiateSceneSteps(
      world,
      childHandle,
      context,
      mountEntity,
      stack,
      mountKeys?.get(mountLid),
    );
    if (!childRes.ok) return childRes;

    const childInstRes = world.get(childRes.value, sceneInstanceToken);
    if (!childInstRes.ok) return childInstRes;
    // Copy before yielding: ordinary World array reads are only synchronous borrows.
    const childMapping = Uint32Array.from(
      (childInstRes.value as unknown as { mapping: Uint32Array }).mapping,
    );
    const key = mountKeys?.get(mountLid);
    mountInstances.push({
      mount,
      root: childRes.value,
      mapping: childMapping,
      ...(key === undefined ? {} : { key }),
    });
    if (childMapping.length !== mount.memberCount) {
      return err({
        code: 'pack-mount-count-mismatch' as PackErrorCode,
        expected: 'mount.memberCount === child SceneAsset totalSlots',
        hint: PACK_ERROR_HINTS['pack-mount-count-mismatch'],
        detail: {
          code: 'pack-mount-count-mismatch',
          mountLocalId: mountLid,
          declared: mount.memberCount,
          actual: childMapping.length,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }

    const window = mount.memberCount;
    for (let k = 0; k < window; k += 1) {
      if (context.incremental) yield;
      mapping[(mount.memberFirst as unknown as number) + k] = childMapping[k] ?? ENTITY_NULL_RAW;
    }

    if (childOfToken === undefined) continue;
    if (mount.parent === undefined) {
      mountEntitiesNeedingRootParent.push(mountEntity);
      continue;
    }
    const parentSlot = Number(mount.parent);
    const parentEntity = mapping[parentSlot];
    if (parentEntity === undefined || parentEntity === ENTITY_NULL_RAW) {
      mountEntitiesNeedingDeferredParent.push([mountEntity, parentSlot]);
      continue;
    }
    const attach = setSceneParent(world, mountEntity, childOfToken, parentEntity as EntityHandle);
    if (!attach.ok) return attach;
  }

  return ok(undefined);
}

function* spawnSceneOwnMembersSteps(
  world: World,
  ownEntities: readonly CompiledSceneEntity[],
  context: SceneInstantiationContext,
  members: SceneMembersSpawn,
): Generator<void, Result<void, EcsError>, void> {
  const { mapping, entityToLocalId, rootEntities } = members;
  const order = context.incremental
    ? yield* sceneTopoSortSteps(ownEntities)
    : sceneTopoSort(world, ownEntities);
  for (const idx of order) {
    if (context.incremental) yield;
    const node = ownEntities[idx];
    if (node === undefined) continue;
    const lid = node.localId as unknown as number;
    const compDataRes = worldBuildSceneEntityComponentDatas(world, node, mapping);
    if (!compDataRes.ok) return compDataRes;
    const sp = context.materialize(compDataRes.value);
    if (!sp.ok) return sp;
    const e = sp.value;
    mapping[lid] = e as unknown as number;
    entityToLocalId.set(e, lid as unknown as LocalEntityId);
    if (node.components.ChildOf === undefined) {
      rootEntities.push(e);
    }
  }

  return ok(undefined);
}

function* rebindSceneMembersSteps(
  world: World,
  ownEntities: readonly CompiledSceneEntity[],
  ownMounts: readonly SceneInstanceMount[],
  mapping: Uint32Array,
  incremental: boolean,
): Generator<void, Result<void, EcsError>, void> {
  // Rebind non-hierarchy references after every local slot exists, including cycles.
  const remap = sceneSlotRemap(mapping);
  for (const node of [
    ...ownEntities,
    ...ownMounts.map((mount) => ({ localId: mount.localId, components: mount.components ?? {} })),
  ]) {
    if (incremental) yield;
    const entity = mapping[node.localId as unknown as number] as EntityHandle;
    for (const [name, fields] of Object.entries(node.components)) {
      const component = world.components.resolve(name);
      if (component === undefined) return err(new ComponentNotDefinedError(name));
      // Spawn has already validated and filled the other fields. Only authored
      // entity references depend on slots that may have been unresolved then.
      let references: Record<string, unknown> | undefined;
      for (const [field, value] of Object.entries(fields ?? {})) {
        const kind = classifyEntityField(component, field);
        if (kind === null) continue;
        references ??= Object.create(null) as Record<string, unknown>;
        references[field] = remapEntityFieldValue(value, kind, remap);
      }
      if (references === undefined) continue;
      if (incremental) yield;
      const rebound = world.set(entity, component, references as never);
      if (!rebound.ok) return rebound;
    }
  }

  return ok(undefined);
}

/**
 * @internal Spawn one SceneAsset's entities + apply mounts recursively, then
 * wrap them in a synthetic SceneInstance root (the anchor). This is the
 * runtime / Play / nested-mount finisher (charter P4: instance ==
 * entity-with-SceneInstance). Caller (`_instantiateSceneRec`) owns cycle
 * bookkeeping.
 */
export function worldInstantiateSceneAsset(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  instanceKey?: string,
  sceneSourceKey?: string,
): Result<EntityHandle, EcsError> {
  return finishSceneSteps(
    worldInstantiateSceneAssetSteps(
      world,
      handle,
      asset,
      parent,
      stack,
      synchronousSceneContext(world),
      instanceKey,
      sceneSourceKey,
    ),
  );
}

function* worldInstantiateSceneAssetSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  context: SceneMaterialization,
  instanceKey?: string,
  sceneSourceKey?: string,
): Generator<void, Result<EntityHandle, EcsError>, void> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }

  const compiled = yield* compileKeyedSceneAssetSteps(
    world,
    handle,
    asset,
    {
      resolveSource: context.resolveSource,
      resolveAsset: context.resolveAsset,
      stack,
      ...(context.fixedPlans === undefined ? {} : { fixedPlans: context.fixedPlans }),
    },
    context.incremental,
  );
  if (!compiled.ok) return err(compiled.error as EcsError);
  const compiledAsset = compiled.value.asset;
  const sourceReferences = context.retainSource(asset);
  if (!sourceReferences.ok) return sourceReferences;
  let sourceReferencesActive = true;
  const releaseSourceReferences = () => {
    if (!sourceReferencesActive) return;
    sourceReferencesActive = false;
    sourceReferences.value();
  };
  let transferred = false;
  try {
    const membersRes = yield* worldSpawnSceneMembersSteps(
      world,
      handle,
      compiledAsset,
      stack,
      context,
      compiled.value.mountKeyByLocalId,
    );
    if (!membersRes.ok) {
      return membersRes;
    }
    const { mapping, entityToLocalId, rootEntities, mountEntitiesNeedingRootParent, totalSlots } =
      membersRes.value;
    const { mountInstances } = membersRes.value;
    const ownMounts = compiledAsset.mounts ?? [];

    const detached = new Set<LocalEntityId>();
    const bindings = new Map<string, EntityHandle>();
    const entityAddresses = new Map<EntityHandle, SceneEntityAddress>();
    const state: SceneInstanceState = {
      source: handle,
      sourceContent: asset,
      ...(sceneSourceKey === undefined ? {} : { sceneSourceKey }),
      keyByLocalId: new Map(compiled.value.keyByLocalId),
      ...(instanceKey === undefined ? {} : { instanceKey }),
      bindings,
      entityAddresses,
      entityToLocalId,
      detachedLocalIds: detached,
      overrides: new Map(),
      rootEntities,
      mountRoots: mountInstances.map(({ root }) => root),
      totalSlots,
      mountTimeOverrides: ownMounts.flatMap((m) => m.overrides ?? []),
    };
    // The managed payload owns source cleanup after the root accepts it.
    const stateRef = world.allocUniqueRef('SceneInstanceState', state, releaseSourceReferences);
    const mappingPlain: number[] = Array.from(mapping);
    const rootComponents: ComponentData[] = [
      {
        component: sceneInstanceToken,
        data: {
          source: handle,
          mapping: mappingPlain,
          state: stateRef,
        } as never,
      },
    ];
    // Synthetic parents participate in the same Transform hierarchy as members.
    const transformToken = world.components.resolve('Transform');
    if (transformToken !== undefined) {
      rootComponents.push({
        component: transformToken,
        data: {} as never,
      });
    }
    const rootSpawn = context.materialize(rootComponents);
    if (!rootSpawn.ok) {
      if (world.resolveUniqueRef(stateRef).ok) {
        const released = releaseUnadoptedUniqueRef(world, stateRef);
        if (!released.ok) return released;
      }
      return rootSpawn;
    }
    transferred = true;
    const rootEntity = rootSpawn.value;

    const overridden = yield* applySceneMountOverridesSteps(
      world,
      ownMounts,
      mapping,
      state,
      context,
    );
    if (!overridden.ok) return overridden;

    yield* collectSceneEntityBindingsSteps(
      world,
      rootEntity,
      [],
      bindings,
      entityAddresses,
      context.incremental,
    );

    const attached = yield* attachSceneRootsSteps(
      world,
      rootEntity,
      parent,
      rootEntities,
      mountEntitiesNeedingRootParent,
      context.incremental,
    );
    if (!attached.ok) return attached;

    return ok(rootEntity);
  } finally {
    if (!transferred) releaseSourceReferences();
  }
}

function* applySceneMountOverridesSteps(
  world: World,
  ownMounts: readonly SceneInstanceMount[],
  mapping: Uint32Array,
  state: SceneInstanceState,
  context: SceneInstantiationContext,
): Generator<void, Result<void, EcsError>, void> {
  for (const mount of ownMounts) {
    for (const ov of mount.overrides ?? []) {
      if (context.incremental) yield;
      const lid = ov.localId as unknown as LocalEntityId;
      let fieldMap = state.overrides.get(lid);
      if (fieldMap === undefined) {
        fieldMap = new Map();
        state.overrides.set(lid, fieldMap);
      }
      const { localId: _localId, ...record } = ov;
      fieldMap.set(mountOverrideStateKey(ov), record);
      const memberEntityRaw = mapping[lid as unknown as number];
      if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
        const memberEntity = memberEntityRaw as unknown as EntityHandle;
        const applyRes = context.applyOverride(
          memberEntity,
          worldRemapMountOverride(world, ov, mapping),
        );
        if (!applyRes.ok) {
          return applyRes;
        }
      }
    }
  }

  return ok(undefined);
}

function* attachSceneRootsSteps(
  world: World,
  rootEntity: EntityHandle,
  parent: EntityHandle | undefined,
  rootEntities: readonly EntityHandle[],
  mountEntities: readonly EntityHandle[],
  incremental: boolean,
): Generator<void, Result<void, EcsError>, void> {
  const childOf = world.components.resolve('ChildOf');
  if (childOf === undefined) return ok(undefined);
  for (const entity of rootEntities) {
    if (incremental) yield;
    if (world.hasComponent(entity, childOf)) continue;
    const attached = setSceneParent(world, entity, childOf, rootEntity);
    if (!attached.ok) return attached;
  }
  for (const entity of mountEntities) {
    if (incremental) yield;
    const attached = setSceneParent(world, entity, childOf, rootEntity);
    if (!attached.ok) return attached;
  }
  if (parent !== undefined) return setSceneParent(world, rootEntity, childOf, parent);
  return ok(undefined);
}

/**
 * @internal Flat finisher — spawn one SceneAsset's members WITHOUT wrapping
 * them in a synthetic SceneInstance root and WITHOUT forcing `ChildOf` onto
 * top-level members. Used for "opening a scene to edit": the scene's own
 * entities become plain top-level world entities whose hierarchy is exactly
 * their authored `ChildOf`. Nested prefabs inside still materialise as their
 * own SceneInstance anchors (the mount recursion in `_spawnSceneMembers` is
 * always anchored). Returns the top-level handles (own rootless entities +
 * top-level mount carriers).
 */
export function worldInstantiateSceneAssetFlat(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  stack: Set<number>,
): Result<{ roots: EntityHandle[]; mountEntities: EntityHandle[] }, EcsError> {
  const compiled = compileKeyedSceneAsset(world, handle, asset, {
    resolveSource: (source, parentHandle) => worldResolveMountSource(world, source, parentHandle),
    resolveAsset: (childHandle) => worldResolveSceneAsset(world, childHandle),
    stack,
  });
  if (!compiled.ok) return err(compiled.error as EcsError);
  // Flat roots have no persistent source owner, but authored overrides must be
  // validated before any nested instance spawns and stay live during application.
  const sourceReferences = retainSceneSourceReferences(world, asset);
  if (!sourceReferences.ok) return sourceReferences;
  try {
    const membersRes = worldSpawnSceneMembers(
      world,
      handle,
      compiled.value.asset,
      stack,
      compiled.value.mountKeyByLocalId,
    );
    if (!membersRes.ok) return membersRes;
    const { rootEntities, mountEntitiesNeedingRootParent, mountEntities, mountInstances } =
      membersRes.value;
    const childOfToken = world.components.resolve('ChildOf');

    // Apply parent mount overrides to the live columns and record them on the
    // nested child anchor. Flat mode has no outer SceneInstance state; without
    // this hand-authored mounts[].overrides affect the live value but disappear
    // from the child state, so Gateway re-open cannot discover or revert them.
    for (const { mount, root, mapping: childMapping } of mountInstances) {
      const childStateRes = worldGetSceneInstanceState(world, root);
      if (!childStateRes.ok) return childStateRes;
      for (const ov of mount.overrides ?? []) {
        const childLocalId =
          (ov.localId as unknown as number) - (mount.memberFirst as unknown as number);
        const memberEntityRaw = childMapping[childLocalId];
        if (memberEntityRaw === undefined || memberEntityRaw === ENTITY_NULL_RAW) continue;
        const memberEntity = memberEntityRaw as unknown as EntityHandle;
        const applyRes = worldApplyMountOverride(
          world,
          memberEntity,
          worldRemapMountOverride(world, ov, childMapping),
        );
        if (!applyRes.ok) {
          return applyRes as Result<
            { roots: EntityHandle[]; mountEntities: EntityHandle[] },
            EcsError
          >;
        }
        let fieldMap = childStateRes.value.overrides.get(childLocalId as LocalEntityId);
        if (fieldMap === undefined) {
          fieldMap = new Map();
          childStateRes.value.overrides.set(childLocalId as LocalEntityId, fieldMap);
        }
        fieldMap.set(mountOverrideStateKey(ov), {
          comp: ov.comp,
          ...(ov.field === undefined ? {} : { field: ov.field }),
          value: ov.value,
        });
      }
    }

    // Default-parented mount carriers (`mount.parent === undefined`) would, in
    // anchor mode, attach to the synthetic root. Flat mode has none, so they
    // stay top-level. `_spawnMountEntity` may have left a placeholder
    // `ChildOf {parent: ENTITY_NULL_RAW}` (rare: mount with no components AND
    // Transform unregistered) — strip it so the carrier is a genuine root.
    if (childOfToken !== undefined) {
      for (const mountE of mountEntitiesNeedingRootParent) {
        const co = world.get(mountE, childOfToken);
        if (co.ok && (co.value as { parent: number }).parent === ENTITY_NULL_RAW) {
          world.removeComponent(mountE, childOfToken);
        }
      }
    }

    return ok({ roots: [...rootEntities, ...mountEntitiesNeedingRootParent], mountEntities });
  } finally {
    sourceReferences.value();
  }
}
function sceneSlotRemap(mapping: Uint32Array): (localId: number) => number {
  return (localId) =>
    localId >= 0 && localId < mapping.length
      ? (mapping[localId] ?? ENTITY_NULL_RAW)
      : ENTITY_NULL_RAW;
}

/** @internal Build ComponentData[] for one SceneEntity, remapping localIds.
 *
 * SceneAsset payloads use the same schema contract as explicit ECS writes.
 * Unknown fields fail before the first entity is spawned, with the component
 * schema's structured error. The source object is never mutated.
 */
export function worldBuildSceneEntityComponentDatas(
  world: World,
  node: CompiledSceneEntity,
  mapping: Uint32Array,
): Result<ComponentData[], EcsError> {
  const out: ComponentData[] = [];
  const nodeLocalId = node.localId as unknown as number;
  let remap: ReturnType<typeof sceneSlotRemap> | undefined;
  for (const compName of Object.keys(node.components)) {
    const token = world.components.resolve(compName);
    if (token === undefined) {
      return err(new ComponentNotDefinedError(compName));
    }
    const raw = node.components[compName] ?? {};
    const schema = componentSchema(token) as Record<string, string>;
    const remappedRaw: Record<string, unknown> = {};
    for (const fieldName of Object.keys(raw)) {
      const fieldType = schema[fieldName];
      // Do not mutate the source `raw`. SceneAsset compilation normally catches
      // this earlier; this guard keeps the private numeric projection fail-fast
      // for callers that provide a precompiled asset.
      if (fieldType === undefined) {
        return err({
          code: 'spawn-data-unknown-field',
          expected: `field name in {${Object.keys(schema).sort().join(', ')}}`,
          hint: `unknown field '${fieldName}' on component '${compName}' at scene localId ${nodeLocalId}`,
          detail: {
            component: compName,
            field: fieldName,
            entity: nodeLocalId,
            knownFields: Object.keys(schema).sort(),
          },
        } as unknown as EcsError);
      }
      const value = (raw as Record<string, unknown>)[fieldName];
      const kind = classifyEntityField(token, fieldName);
      if (kind === null) remappedRaw[fieldName] = value;
      else {
        // Slots not yet spawned hold ENTITY_NULL_RAW.
        remap ??= sceneSlotRemap(mapping);
        remappedRaw[fieldName] = remapEntityFieldValue(value, kind, remap);
      }
    }
    const filled = fillComponentDefaults(token, remappedRaw);
    out.push({ component: token, data: filled as never });
  }
  return ok(out);
}

/**
 * Resolve the private local-slot values produced by keyed SceneAsset
 * compilation before an instance override is written to a live ECS row.
 * Override references are authored in the declaring parent namespace, while
 * `worldApplyMountOverride` deliberately accepts ordinary live component data.
 */
function worldRemapMountOverride(
  world: World,
  override: MountOverride,
  mapping: Uint32Array,
): MountOverride {
  const token = world.components.resolve(override.comp);
  if (token === undefined) return override;
  const remap = sceneSlotRemap(mapping);
  const remapField = (field: string, value: unknown): unknown => {
    const kind = classifyEntityField(token as Component, field);
    return remapEntityFieldValue(value, kind, remap);
  };
  if (override.field !== undefined) {
    return { ...override, value: remapField(override.field, override.value) };
  }
  if (
    typeof override.value !== 'object' ||
    override.value === null ||
    Array.isArray(override.value)
  ) {
    return override;
  }
  const value: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(override.value as Record<string, unknown>)) {
    value[field] = remapField(field, fieldValue);
  }
  return { ...override, value };
}

/**
 * @internal feat-20260713 M2 / w8: apply one MountOverride to a live member
 * entity column. The `field?` shape is the add-or-patch discriminant:
 *
 *   - `field` present -> PATCH one field: `world.set(member, comp, {[field]:
 *     value})`. Omitted fields keep their authored / existing values.
 *   - `field` absent  -> ADD/UPSERT the whole component: `value` is the
 *     per-field value map for `comp`. When the member already carries `comp`
 *     it is upserted (set-over each supplied field + schema defaults for the
 *     omitted ones — the whole component is rewritten from the value map +
 *     defaults, never a `component-already-present` error). When absent it is
 *     added fresh via `addComponent` (fillComponentDefaults fills omitted
 *     fields). The value-map is fed through `fillComponentDefaults` so the
 *     add and upsert paths write byte-identical rows.
 *
 * Component registration + value-key validation happened at
 * `_validateMountOverrides` (fail-fast before any spawn); by this point the
 * comp resolves through the World-local catalog and the value keys are schema-valid.
 * still guards defensively (an unregistered comp is a no-op skip, matching
 * the prior field-patch behaviour). Returns the underlying set / addComponent
 * Result so a shared-field value gate (D-4) or any other write error
 * propagates unchanged.
 */
export function worldApplyMountOverride(
  world: World,
  member: EntityHandle,
  ov: MountOverride,
): Result<void, EcsError> {
  const ovToken = world.components.resolve(ov.comp);
  if (ovToken === undefined) return ok(undefined);
  if (ov.field !== undefined) {
    // PATCH one field.
    return world.set(member, ovToken, { [ov.field]: ov.value } as never);
  }
  // ADD/UPSERT the whole component. Fill omitted fields from the schema so
  // add and upsert produce identical rows (upsert = full rewrite from the
  // value map + defaults).
  const rawValue = (ov.value ?? {}) as Record<string, unknown>;
  const filled = fillComponentDefaults(ovToken as Component, rawValue);
  const has = world.get(member, ovToken);
  if (has.ok) {
    // Already present -> upsert (set every filled field, no duplicate error).
    return world.set(member, ovToken, filled as never);
  }
  return world.addComponent(member, { component: ovToken, data: filled as never });
}
/**
 * @internal R2/B-3 + R2/B-4: validate `mount.overrides[]` BEFORE any
 * spawn so a malformed override fails fast with no observable side
 * effects (charter P3 explicit-failure). Two checks:
 *
 * 1. `override.localId` must address a slot inside the parent-namespace
 *    member window `[memberFirst, memberFirst + memberCount)` (AC-06).
 * 2. `override.field` must exist in the resolved component schema
 *    (AC-07). When the component is unregistered we cannot validate the
 *    field shape; let the existing fall-through path proceed (the
 *    catalog guard inside the override-application loop
 *    will skip the write).
 */
export function worldValidateMountOverrides(
  world: World,
  mount: SceneInstanceMount,
): Result<void, EcsError> {
  const overrides = mount.overrides;
  if (overrides === undefined) return ok(undefined);
  const memberFirst = mount.memberFirst as unknown as number;
  const memberCount = mount.memberCount;
  const memberLast = memberFirst + memberCount;
  const mountLid = mount.localId as unknown as number;
  for (const ov of overrides) {
    const ovLid = ov.localId as unknown as number;
    // R2/B-3: parent-namespace check — override.localId must lie in the
    // member window [memberFirst, memberFirst + memberCount).
    if (ovLid < memberFirst || ovLid >= memberLast) {
      return err({
        code: 'pack-mount-override-localid-out-of-range' as PackErrorCode,
        expected: `override.localId in [${memberFirst}, ${memberLast})`,
        hint: PACK_ERROR_HINTS['pack-mount-override-localid-out-of-range'],
        detail: {
          code: 'pack-mount-override-localid-out-of-range',
          overrideLocalId: ovLid,
          mountLocalId: mountLid,
          memberCount,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }
    // feat-20260713 M2 / w8: double-branch schema check.
    //   - field-patch form (field present): the component (when registered)
    //     must declare `override.field` in its schema (R2/B-4, unchanged).
    //   - component-add form (field absent): the component MUST be registered
    //     (component-not-defined otherwise) AND every key in the value map
    //     must be a schema field (pack-mount-override-unknown-field).
    const ovToken = world.components.resolve(ov.comp);
    if (ov.field !== undefined) {
      if (ovToken !== undefined) {
        const schema = componentSchema(ovToken) as Record<string, unknown>;
        if (!(ov.field in schema)) {
          return err({
            code: 'pack-mount-override-unknown-field' as PackErrorCode,
            expected: `override.field defined on component '${ov.comp}'`,
            hint: PACK_ERROR_HINTS['pack-mount-override-unknown-field'],
            detail: {
              code: 'pack-mount-override-unknown-field',
              comp: ov.comp,
              field: ov.field,
              mountLocalId: mountLid,
            } as PackErrorDetail,
          } as unknown as EcsError);
        }
      }
    } else {
      // component-add form: comp must be registered so we can validate + apply
      // the whole component (add/upsert needs the schema).
      if (ovToken === undefined) {
        return err(new ComponentNotDefinedError(ov.comp));
      }
      const schema = componentSchema(ovToken) as Record<string, unknown>;
      const valueMap = (ov.value ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(valueMap)) {
        if (!(key in schema)) {
          return err({
            code: 'pack-mount-override-unknown-field' as PackErrorCode,
            expected: `override.value keys defined on component '${ov.comp}'`,
            hint: PACK_ERROR_HINTS['pack-mount-override-unknown-field'],
            detail: {
              code: 'pack-mount-override-unknown-field',
              comp: ov.comp,
              field: key,
              mountLocalId: mountLid,
            } as PackErrorDetail,
          } as unknown as EcsError);
        }
      }
    }
  }
  return ok(undefined);
}
/** @internal Spawn the mount-entity slot carrying mount.components (if any).
 *
 * R2/B-1: the mount entity is a structural intermediate in the ChildOf
 * chain `cube -> innerSyntheticRoot -> mountEntity -> outerSyntheticRoot`,
 * so it MUST carry Transform whenever Transform is registered (mirrors
 * the D-V-0 synthetic-root invariant). Otherwise propagateTransforms
 * expanding the chain hits a Transform-less parent and emits per-frame
 * `RhiError(hierarchy-broken)` (verify R1 root cause of the
 * hello-scene-nesting demo black frames).
 */
export function worldSpawnMountEntity(
  world: World,
  mount: SceneInstanceMount,
  mapping: Uint32Array,
  materialize: SceneInstantiationContext['materialize'] = (components) =>
    world.spawn(...components),
): Result<EntityHandle, EcsError> {
  const fakeNode: CompiledSceneEntity = {
    localId: mount.localId,
    components: mount.components ?? {},
  };
  const cdRes = worldBuildSceneEntityComponentDatas(world, fakeNode, mapping);
  if (!cdRes.ok) return cdRes;
  // R2/B-1: ensure Transform is attached so propagateTransforms can expand
  // through this entity. Layer-2 defaults supply identity TRS; the
  // mount.components overlay (when present and including Transform) takes
  // precedence and is already in cdRes.value.
  const transformToken = world.components.resolve('Transform');
  if (transformToken !== undefined) {
    const hasTransform = cdRes.value.some((c) => c.component === transformToken);
    if (!hasTransform) {
      cdRes.value.push({ component: transformToken, data: {} as never });
    }
  }
  if (cdRes.value.length === 0) {
    // Mount has no components AND Transform is unregistered (rare unit-
    // test path). Fall back to the placeholder ChildOf so the spawn has
    // a real archetype. Step 5 overwrites this placeholder.
    const childOfToken = world.components.resolve('ChildOf');
    if (childOfToken === undefined) {
      return err(new ComponentNotDefinedError('ChildOf'));
    }
    cdRes.value.push({
      component: childOfToken,
      data: { parent: ENTITY_NULL_RAW } as never,
    });
  }
  return materialize(cdRes.value);
}
/** @internal Resolve mount.source through the wired SceneAssetResolver. */
export function worldResolveMountSource(
  world: World,
  source: number | string,
  parentHandle: AssetHandle<'scene'>,
): Result<AssetHandle<'scene'>, EcsError> {
  if (typeof source === 'number') {
    const valid = world.assets?.validate(source, 'scene');
    if (valid?.ok) return ok(source as AssetHandle<'scene'>);
    if (valid !== undefined) return err(valid.error as unknown as EcsError);
  }
  const resolver = worldGetSceneAssetResolver(world);
  if (resolver === null) {
    return err({
      code: 'stale-entity' as const,
      expected: 'wired SceneAssetResolver (auto-wired by engine.assets.instantiate)',
      hint:
        'engine.assets.instantiate sugar wires this for you; ' +
        'call worldSetSceneAssetResolver before nested scene expansion.',
      detail: { entity: 0, slot: 0, generation: 0 },
    } as unknown as EcsError);
  }
  const r = resolver(source, parentHandle);
  if (!r.ok) {
    // Resolver carries `unknown` err (loose contract — engine-runtime may
    // wire any shape); narrow back to EcsError here at the boundary.
    return err(r.error as EcsError);
  }
  return ok(r.value);
}
/**
 * Public sugar — get the SceneInstanceState (Map / Set view) for
 * `root`. Equivalent to `world.get(root, SceneInstance)` followed by a
 * managed-ref resolution; provided so AI users do not have to learn the
 * `ref<T>` slot resolution mechanic for the common read path.
 *
 * Returns Err when `root` does not carry SceneInstance or the ref slot is dead.
 */
export function worldGetSceneInstanceState(
  world: World,
  root: EntityHandle,
): Result<SceneInstanceState, EcsError> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const r = world.get(root, sceneInstanceToken);
  if (!r.ok) return r;
  const stateRefRaw = (r.value as unknown as { state: number }).state;
  const stateRefHandle = toUnique<'SceneInstanceState'>(stateRefRaw);
  const payload = world.resolveUniqueRef<SceneInstanceState>(stateRefHandle);
  if (!payload.ok) {
    return err(
      new StaleEntityError(root as unknown as number, entityIndex(root), entityGeneration(root), {
        operation: 'resolveSceneInstanceState',
        component: 'SceneInstance',
        expectedGeneration: entityGeneration(root),
        actualGeneration: entityGeneration(root),
      }),
    );
  }
  return payload;
}

/** Resolve a generated SceneEntityRef against one concrete SceneInstance. */
export function worldResolveSceneEntity(
  world: World,
  root: EntityHandle,
  ref: SceneEntityRef,
): Result<EntityHandle, EcsError> {
  const state = worldGetSceneInstanceState(world, root);
  if (!state.ok) return state;
  // Anonymous POD scenes remain addressable with an explicit empty source key.
  // Never let the caller supply the identity used for the comparison: that
  // would make an anonymous instance accept a fabricated persistent ref.
  const resolved = resolveSceneEntity(ref, {
    sceneSourceKey: state.value.sceneSourceKey ?? '',
    bindings: state.value.bindings,
  });
  if (!resolved.ok) return err(resolved.error as unknown as EcsError);
  return ok(resolved.value as EntityHandle);
}
/**
 * Despawn a SceneInstance root + all its members. `opts.keepDetached`
 * preserves members marked via `worldDetachSceneMember` (plan-strategy
 * §D-5). Returns the count of entities actually despawned (root + each
 * non-detached member).
 *
 * For a plain entity (no SceneInstance), behaviour matches
 * `world.despawn(entity)` followed by `despawnDescendants(entity)` — i.e.
 * `keepDetached` is a no-op.
 */
export function worldDespawnScene(
  world: World,
  root: EntityHandle,
  opts?: { keepDetached?: boolean },
): Result<number, EcsError> {
  const dRes = worldDespawnDescendants(world, root, opts);
  if (!dRes.ok) return dRes;
  const drop = world.despawn(root);
  if (!drop.ok) return drop;
  return ok(dRes.value + 1);
}
/** Collect explicit hierarchy and instance ownership while all borrows are live. */
function collectSceneMembers(world: World, root: EntityHandle): Set<number> {
  const owned = collectSubtree(world, root);
  const sceneInstance = world.components.resolve('SceneInstance');
  const read = world[worldRead];
  if (sceneInstance !== undefined) {
    for (const raw of owned) {
      const anchor = raw as EntityHandle;
      const mapping = readRenderArrayView(world, anchor, sceneInstance, 'mapping');
      if (mapping === undefined) continue;
      for (let index = 0; index < mapping.length; index++) {
        const member = mapping[index];
        if (member !== undefined && member !== ENTITY_NULL_RAW)
          collectSubtree(world, member as EntityHandle, owned);
      }
      const stateRef = read.getFieldValue(anchor, sceneInstance, 'state');
      if (stateRef === undefined) continue;
      const state = world.resolveUniqueRef<SceneInstanceState>(
        toUnique<'SceneInstanceState'>(stateRef),
      );
      if (!state.ok) continue;
      // State still owns direct members if the physical mapping is incomplete.
      for (const member of state.value.entityToLocalId.keys()) collectSubtree(world, member, owned);
      for (const nestedRoot of state.value.mountRoots) collectSubtree(world, nestedRoot, owned);
    }
  }
  owned.delete(Number(root));
  return owned;
}

/**
 * Despawn every descendant of `root` reachable through Children mirror /
 * SceneInstance.mapping. `opts.keepDetached` is honoured only when `root`
 * carries a SceneInstance (otherwise the option is ignored — there is no
 * detached set on a plain entity).
 *
 * Returns the count of entities despawned. The `root` itself is NOT
 * despawned (that is `despawnScene`'s extra step).
 */
export function worldDespawnDescendants(
  world: World,
  root: EntityHandle,
  opts?: { keepDetached?: boolean },
): Result<number, EcsError> {
  let detached: Set<LocalEntityId> | null = null;
  let entityToLocalId: Map<EntityHandle, LocalEntityId> | null = null;
  if (opts?.keepDetached === true) {
    const stateRes = worldGetSceneInstanceState(world, root);
    if (stateRes.ok) {
      detached = stateRes.value.detachedLocalIds;
      entityToLocalId = stateRes.value.entityToLocalId;
    }
  }
  let count = 0;
  const owned = collectSceneMembers(world, root);
  const read = world[worldRead];
  const list: EntityHandle[] = [];
  for (const raw of owned) {
    const entity = raw as EntityHandle;
    if (world.hasComponent(entity, Entity)) list.push(entity);
    else owned.delete(raw);
  }
  const childOfToken = world.components.resolve('ChildOf');
  // ChildOf uses linkedSpawn, so a parent-first pass would recursively retire
  // its children before this function can count them. Sort the ownership set
  // by its live ChildOf depth instead of relying on mirror traversal order;
  // nested SceneInstance roots are siblings of their mount carrier in the
  // flattened traversal but parents of the mounted members.
  const ownedDepth = (entity: EntityHandle): number => {
    if (childOfToken === undefined) return 0;
    let current = entity;
    let depth = 0;
    const visited = new Set<number>();
    while (!visited.has(Number(current))) {
      visited.add(Number(current));
      const parent = read.getFieldValue(current, childOfToken, 'parent');
      if (parent === undefined || !owned.has(parent)) break;
      depth += 1;
      current = parent as EntityHandle;
    }
    return depth;
  };
  list.sort((a, b) => ownedDepth(b) - ownedDepth(a));
  for (const e of list) {
    if (detached !== null) {
      const lid = entityToLocalId?.get(e);
      if (lid !== undefined && detached.has(lid)) {
        if (childOfToken !== undefined) {
          world.removeComponent(e, childOfToken);
        }
        continue;
      }
    }
    const r = world.despawn(e);
    if (!r.ok) {
      if (r.error.code === 'stale-entity') continue;
      return r;
    }
    count += 1;
  }
  return ok(count);
}
/**
 * Write a runtime override to a member entity belonging to `root`. Routes
 * through `world.set(member, comp, { [field]: value })` after an entity-
 * scope guard so cross-instance writes fail-fast. Type-mismatch surfaces
 * `EcsErrorCode = 'scene-override-type-mismatch'` (D-9).
 */
export function worldSetSceneOverride<S extends ComponentSchema>(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
  component: Component<string, S>,
  field: keyof ShapeOf<S> & string,
  value: unknown,
): Result<void, EcsError> {
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) {
    return err(
      new StaleEntityError(
        member as unknown as number,
        entityIndex(member),
        entityGeneration(member),
        {
          operation: 'setSceneOverride',
          component: component.name,
          expectedGeneration: entityGeneration(member),
          actualGeneration: entityGeneration(member),
        },
      ),
    );
  }
  // Type guard: only check primitive scalar field types where we can
  // narrow `typeof`; ref / handle / entity / array / buffer fields skip
  // (write would surface a deeper error from set).
  const schemaType = (componentSchema(component) as Record<string, string>)[field];
  if (schemaType !== undefined && isPrimitiveScalarFieldType(schemaType)) {
    const expectJsType = primitiveJsType(schemaType);
    const actualJsType = typeof value;
    if (expectJsType !== actualJsType) {
      return err({
        code: 'scene-override-type-mismatch' as const,
        expected: `value typeof === ${expectJsType}`,
        hint:
          `setSceneOverride(${component.name}.${field}) expected ${expectJsType}, ` +
          `got ${actualJsType}; coerce or pick a different override path.`,
        detail: {
          code: 'scene-override-type-mismatch' as const,
          comp: component.name,
          field: field as string,
          expectedType: schemaType,
          actualType: actualJsType,
        },
      } as unknown as EcsError);
    }
  }
  const setRes = world.set(member, component, { [field]: value } as Partial<InputShapeOf<S>>);
  if (!setRes.ok) return setRes;
  // Record into state.overrides
  let fieldMap = state.overrides.get(lid);
  if (fieldMap === undefined) {
    fieldMap = new Map();
    state.overrides.set(lid, fieldMap);
  }
  fieldMap.set(`${component.name}:${field}`, {
    comp: component.name,
    field: field as string,
    value,
  });
  return ok(undefined);
}
/**
 * Drop a runtime override (and any mount-time override for the same
 * (member, comp, field) triple); roll the live column value back to the
 * source SceneAsset's layer-1 explicit value (M2 v1 — M3+ widens to layer
 * 2/3 defaults via fillComponentDefaults).
 */
export function worldRemoveSceneOverride<S extends ComponentSchema>(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
  component: Component<string, S>,
  field: keyof ShapeOf<S> & string,
): Result<void, EcsError> {
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  const fieldMap = state.overrides.get(lid);
  if (fieldMap !== undefined) {
    fieldMap.delete(`${component.name}:${field}`);
    if (fieldMap.size === 0) state.overrides.delete(lid);
  }
  // Look up the source SceneAsset layer-1 value.
  const key = state.keyByLocalId.get(lid as unknown as number);
  const node = key === undefined ? undefined : state.sourceContent.entities[key];
  const layer1 = node?.components[component.name] as Record<string, unknown> | undefined;
  if (layer1 !== undefined && field in layer1) {
    const r = world.set(member, component, { [field]: layer1[field] } as Partial<InputShapeOf<S>>);
    if (!r.ok) return r;
  }
  return ok(undefined);
}
/** Mark a member entity detached. Idempotent (set semantics). */
export function worldDetachSceneMember(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
): Result<void, EcsError> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  state.detachedLocalIds.add(lid);
  return ok(undefined);
}
/** Clear a detached mark. Idempotent (set semantics). */
export function worldReattachSceneMember(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
): Result<void, EcsError> {
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  state.detachedLocalIds.delete(lid);
  return ok(undefined);
}
/**
 * Get the SceneAsset handle a SceneInstance root was instantiated from.
 * Returns Err on a plain entity (no SceneInstance component).
 */
export function worldGetSceneAssetForInstance(
  world: World,
  root: EntityHandle,
): Result<AssetHandle<'scene'>, EcsError> {
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  return ok(stateRes.value.source);
}
