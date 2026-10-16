// @forgeax/engine-scene — scene instantiation and instance-state subsystem.

import {
  type Component,
  type ComponentData,
  type ComponentSchema,
  type EcsError,
  ENTITY_NULL_RAW,
  type EntityHandle,
  type InputShapeOf,
  type ShapeOf,
  type World,
} from '@forgeax/engine-ecs';
import { classifyEntityField, remapEntityFieldValue } from '@forgeax/engine-ecs/externalization';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { fillComponentDefaults, StaleEntityError } from '@forgeax/engine-ecs/projection';
import type {
  Handle,
  LocalEntityId,
  PackErrorCode,
  PackErrorDetail,
  SceneAsset,
  SceneEntityAddress,
  SceneEntityRef,
} from '@forgeax/engine-types';
import {
  err,
  ok,
  PACK_ERROR_HINTS,
  type Result,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import { ComponentNotDefinedError } from '../errors';
import { resolveSceneEntity, sceneEntityAddressKey } from './binding.js';
import {
  type CompiledSceneAsset,
  type CompiledSceneEntity,
  compileKeyedSceneAsset,
} from './keyed.js';
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
 * Legacy diagnostic shape retained on the scene-instantiation result for
 * non-blocking runtime observations. SceneAsset schema violations are
 * rejected by the keyed compiler before this result is produced; no authored
 * unknown-field record is emitted by the current path.
 *
 *   const r = worldInstantiateScene(world, handle);
 *   if (r.ok) for (const d of r.value.diagnostics)
 *     console.warn('scene diagnostic', d);
 *
 * Direct `world.spawn` / `world.addComponent` / `Commands.spawn` remain
 * fail-fast with `SpawnDataUnknownFieldError`.
 */
export type SceneInstantiateDiagnostic = {
  /** Component name associated with the observation. */
  readonly component: string;
  /** Field associated with the observation. */
  readonly field: string;
  /** LocalEntityId within the owning SceneAsset, when applicable. */
  readonly localId: number;
};

/**
 * Success value of `worldInstantiateScene`. `root` is the synthetic scene-root
 * EntityHandle (carries `SceneInstance`); `diagnostics` contains only
 * non-blocking runtime observations. Schema-invalid authored fields fail before
 * an entity is created.
 */
export type SceneInstantiateOk = {
  readonly root: EntityHandle;
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
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
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
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
function collectSceneEntityBindings(
  world: World,
  root: EntityHandle,
  prefix: readonly string[],
  bindings: Map<string, EntityHandle>,
  visited = new Set<number>(),
): void {
  const rootRaw = root as unknown as number;
  if (visited.has(rootRaw)) return;
  visited.add(rootRaw);
  const state = worldGetSceneInstanceState(world, root);
  if (!state.ok) return;
  const sceneInstance = world.components.resolve('SceneInstance');
  if (sceneInstance === undefined) return;
  const component = world.get(root, sceneInstance);
  if (!component.ok) return;
  const mapping = (component.value as unknown as { mapping: ArrayLike<number> }).mapping;
  for (const [slot, key] of state.value.keyByLocalId) {
    const raw = mapping[slot];
    if (raw === undefined || raw === ENTITY_NULL_RAW) continue;
    const address: SceneEntityAddress =
      prefix.length === 0 ? key : ([...prefix, key] as unknown as [string, ...string[]]);
    bindings.set(sceneEntityAddressKey(address), raw as unknown as EntityHandle);
  }
  for (const childRoot of state.value.mountRoots) {
    const childState = worldGetSceneInstanceState(world, childRoot);
    const childKey = childState.ok ? childState.value.instanceKey : undefined;
    if (childKey === undefined) continue;
    collectSceneEntityBindings(world, childRoot, [...prefix, childKey], bindings, visited);
  }
}

export type SceneAssetResolver = (
  source: number | string,
  parentHandle: Handle<'SceneAsset', 'shared'>,
) => Result<Handle<'SceneAsset', 'shared'>, unknown>;

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
 *   const { root, diagnostics } = r.value;
 *   for (const d of diagnostics) // non-blocking runtime observations
 *     console.warn('scene diagnostic', d);
 *   const inst = world.get(root, SceneInstance).value;
 *   const member = inst.mapping[0]; // first member entity
 */
export function worldInstantiateScene(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  parent?: EntityHandle,
  sceneSourceKey?: string,
): Result<SceneInstantiateOk, EcsError> {
  const stack = new Set<number>();
  // Keep the existing result shape for non-blocking runtime observations. The
  // keyed compiler rejects schema-invalid authoring data before spawning.
  const diagnostics: SceneInstantiateDiagnostic[] = [];
  const r = worldInstantiateSceneRec(
    world,
    handle,
    parent,
    stack,
    diagnostics,
    undefined,
    sceneSourceKey,
  );
  if (!r.ok) return r;
  return ok({ root: r.value, diagnostics });
}

/**
 * Materialise a projected `SceneAsset` payload without exposing the temporary
 * shared-ref handle to the caller. The World remains the owner of both the
 * handle and the instantiated SceneInstance: the producer grant is released
 * after the SceneInstance retains its source, including when instantiation
 * fails. This is the payload-shaped counterpart to `worldInstantiateScene` for
 * hosts that load a SceneAsset directly from the Engine AssetRegistry.
 */
export function worldInstantiateScenePayload(
  world: World,
  asset: SceneAsset,
  parent?: EntityHandle,
): Result<SceneInstantiateOk, EcsError> {
  const handle = world.allocSharedRef('SceneAsset', asset);
  try {
    return worldInstantiateScene(world, handle, parent);
  } finally {
    // The SceneInstance source column retains the handle on success. On a
    // failed materialisation there should be no remaining holder; either way
    // release the producer grant owned by this convenience entrypoint.
    world.sharedRefs.release(handle);
  }
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
 *   const { roots, diagnostics } = r.value; // roots = top-level handles
 */
export function worldInstantiateSceneFlat(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
): Result<SceneInstantiateFlatOk, EcsError> {
  const stack = new Set<number>();
  const diagnostics: SceneInstantiateDiagnostic[] = [];
  const handleKey = unwrapHandle(handle);
  const resolved = worldResolveSceneAsset(world, handle);
  if (!resolved.ok) return resolved;
  stack.add(handleKey);
  let r: Result<{ roots: EntityHandle[]; mountEntities: EntityHandle[] }, EcsError>;
  try {
    r = worldInstantiateSceneAssetFlat(world, handle, resolved.value, stack, diagnostics);
  } finally {
    stack.delete(handleKey);
  }
  if (!r.ok) return r;
  return ok({ ...r.value, diagnostics });
}
/**
 * @internal Recursive helper carrying the cycle-detection stack. Sugar /
 * other public callers must not see this mechanic — use `instantiateScene`
 * (D-3 / charter P1).
 */
export function worldInstantiateSceneRec(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
  instanceKey?: string,
  sceneSourceKey?: string,
): Result<EntityHandle, EcsError> {
  const handleKey = unwrapHandle(handle);
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
  const resolved = worldResolveSceneAsset(world, handle);
  if (!resolved.ok) return resolved;
  const asset = resolved.value;
  stack.add(handleKey);
  try {
    return worldInstantiateSceneAsset(
      world,
      handle,
      asset,
      parent,
      stack,
      diagnostics,
      instanceKey,
      sceneSourceKey,
    );
  } finally {
    stack.delete(handleKey);
  }
}
/**
 * @internal Resolve a SceneAsset handle through the SharedRefStore.
 * The handle u32 is the SharedRefStore slot id (`world.allocSharedRef
 * ('SceneAsset', asset)` is the producer; rc starts at 1, the SceneInstance
 * spawn retains to rc=2 in M4 / w13). Errors propagate as EcsError so the
 * instantiateScene chain returns a single closed union.
 */
export function worldResolveSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
): Result<SceneAsset, EcsError> {
  const r = world.sharedRefs.resolve(handle);
  if (!r.ok) {
    return err(r.error as unknown as EcsError);
  }
  return ok(r.value as SceneAsset);
}
/**
 * @internal Spawn one SceneAsset's members — the shared body of both scene
 * finishers. Recurses into `mounts[]` (each nested prefab becomes its own
 * SceneInstance anchor), spawns `entities[]` honouring their authored
 * `ChildOf`, and wires deferred owned-parent mount edges. Does NOT create a
 * synthetic root or force any `ChildOf` — that is the caller's (finisher's)
 * job. `_instantiateSceneRec` owns cycle bookkeeping.
 */
export function worldSpawnSceneMembers(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: CompiledSceneAsset,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
  mountKeys?: ReadonlyMap<number, string>,
): Result<SceneMembersSpawn, EcsError> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const childOfToken = world.components.resolve('ChildOf');
  // ChildOf is optional — only needed if the asset declares ChildOf or a
  // caller-supplied parent must be wired. If absent and we need it, we
  // fail-fast at the wiring site below.

  const ownEntities = asset.entities;
  const ownMounts = asset.mounts ?? [];
  const memberSum = ownMounts.reduce((s, m) => s + m.memberCount, 0);
  const countBaseline = ownEntities.length + ownMounts.length + memberSum;
  // C-R1 (studio-issues #6): mapping table must be sized to maxLocalId+1,
  // not to the entity count. An editor scene may have non-contiguous
  // localIds (deleted entities leave gaps); sizing to count means any
  // localId >= count is a silent Uint32Array OOB no-op -> entity spawns
  // but is unreachable by localId -> users report "character can't move".
  // Take the max of count-baseline and id-range so both packed and
  // sparse scenes work without over-allocation in the common case.
  let maxLocalId = ownEntities.reduce((m, e) => Math.max(m, e.localId as unknown as number), -1);
  for (const mount of ownMounts) {
    maxLocalId = Math.max(maxLocalId, mount.localId as unknown as number);
    const last = (mount.memberFirst as unknown as number) + mount.memberCount - 1;
    maxLocalId = Math.max(maxLocalId, last);
  }
  const totalSlots = Math.max(countBaseline, maxLocalId + 1);

  // R2/Bonus: namespace-overlap fail-fast (AC-05 /
  // pack-mount-localid-overlap). Each LocalEntityId in
  // [0, totalSlots) must be claimed by exactly one of:
  //   - entities[i].localId
  //   - mounts[i].localId
  //   - mounts[i] window slot (memberFirst .. memberFirst+memberCount-1)
  // Overlap or duplicate claim => fail-fast with the offending localIds
  // and human-readable origin labels.
  {
    const claims = new Map<number, string>();
    const overlapLids = new Set<number>();
    const overlapSources: string[] = [];
    const claim = (lid: number, src: string): void => {
      const prior = claims.get(lid);
      if (prior !== undefined) {
        if (!overlapLids.has(lid)) {
          overlapLids.add(lid);
          overlapSources.push(prior);
          overlapSources.push(src);
        } else {
          overlapSources.push(src);
        }
        return;
      }
      claims.set(lid, src);
    };
    for (const ent of ownEntities) {
      claim(ent.localId as unknown as number, `entities[${ent.localId as unknown as number}]`);
    }
    for (const mount of ownMounts) {
      const mLid = mount.localId as unknown as number;
      claim(mLid, `mount[${mLid}]`);
      const first = mount.memberFirst as unknown as number;
      for (let k = 0; k < mount.memberCount; k += 1) {
        claim(first + k, `mount[${mLid}].member[${k}]`);
      }
    }
    if (overlapLids.size > 0) {
      const overlapping = Array.from(overlapLids).sort((a, b) => a - b);
      return err({
        code: 'pack-mount-localid-overlap' as PackErrorCode,
        expected: 'each LocalEntityId claimed by exactly one entity or mount slot',
        hint: PACK_ERROR_HINTS['pack-mount-localid-overlap'],
        detail: {
          code: 'pack-mount-localid-overlap',
          overlapping,
          sources: overlapSources,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }
  }

  // Slot table: indexed by LocalEntityId; populated as entities / mounts /
  // members are spawned. mapping[localId] = encoded Entity u32. Unspawned
  // slots hold ENTITY_NULL_RAW (0xffffffff) — NOT 0, because a fresh World's
  // first spawn encodes to gen=0+idx=0=raw 0, which is a valid Entity. The
  // remap path in `_buildSceneEntityComponentDatas` distinguishes the two
  // (live=ENTITY_NULL_RAW => parent unspawned at remap time => surface as
  // null sentinel; live=any other u32 => valid live Entity, including 0).
  const mapping = new Uint32Array(totalSlots).fill(ENTITY_NULL_RAW);
  const entityToLocalId = new Map<EntityHandle, LocalEntityId>();
  const rootEntities: EntityHandle[] = [];
  const mountEntities: EntityHandle[] = [];
  // R2/B-1: mount entities whose `mount.parent === undefined` need their
  // ChildOf wired to the outer synthetic root (this scene's root). Step 5
  // does the wiring once the synthetic root entity is materialised; we
  // collect them here in step 1.
  const mountEntitiesNeedingRootParent: EntityHandle[] = [];
  // D-8 (feat-20260707): mount entities whose `mount.parent` points at an
  // OWNED entity slot are wired AFTER step 2 spawns the owned entities —
  // mounts are processed first (step 1), so the owned parent slot is still
  // ENTITY_NULL_RAW at mount-processing time. Same deferred-wiring shape as
  // mountEntitiesNeedingRootParent: register [mountEntity, parentSlot] here,
  // wire ChildOf once the slot is live. Without this the edge was silently
  // dropped, and the mount carrier stayed unreachable from its owned parent.
  const mountEntitiesNeedingDeferredParent: Array<[EntityHandle, number]> = [];
  const mountInstances: Array<{
    readonly mount: SceneInstanceMount;
    readonly root: EntityHandle;
    readonly mapping: Uint32Array;
  }> = [];

  // 1. Recurse into mounts[] FIRST so the mount-window slots
  //    (`mount.localId` + `[memberFirst, memberFirst+memberCount)`) are
  //    populated before any owned entity tries to remap a LocalEntityId
  //    pointing into the mount window (AC-24 cross-boundary reference).
  for (const mount of ownMounts) {
    // R2/B-3 + R2/B-4: validate overrides BEFORE child resolution so a
    // malformed override fails fast without observable side-effects.
    const overrideValidationRes = worldValidateMountOverrides(world, mount);
    if (!overrideValidationRes.ok) {
      return overrideValidationRes;
    }

    // Spawn the mount entity (carries mount.components).
    const mountLid = mount.localId as unknown as number;
    const mountSpawnRes = worldSpawnMountEntity(world, mount, mapping, diagnostics);
    if (!mountSpawnRes.ok) return mountSpawnRes;
    const mountEntity = mountSpawnRes.value;
    mountEntities.push(mountEntity);
    mapping[mountLid] = mountEntity as unknown as number;

    // Resolve mount.source -> child SceneAsset handle.
    const childHandleRes = worldResolveMountSource(world, mount.source, handle);
    if (!childHandleRes.ok) return childHandleRes;
    const childHandle = childHandleRes.value;

    // Recursively instantiate the child. Its synthetic root attaches as a
    // child of the mount entity; runtime observations share the same result
    // accumulator and bubble to the top-level instance.
    const childRes = worldInstantiateSceneRec(
      world,
      childHandle,
      mountEntity,
      stack,
      diagnostics,
      mountKeys?.get(mountLid),
    );
    if (!childRes.ok) return childRes;

    // R2/B-2: cross-check mount.memberCount === child.totalSlots BEFORE
    // copying the mount window. The child SceneInstance.mapping length is
    // the authoritative `totalSlots` of the child. AC-04 / requirements
    // S-5 mandate fail-fast at runtime for this disagreement.
    const childInstRes = world.get(childRes.value, sceneInstanceToken);
    if (!childInstRes.ok) return childInstRes;
    const childMapping = (childInstRes.value as unknown as { mapping: Uint32Array }).mapping;
    mountInstances.push({
      mount,
      root: childRes.value,
      mapping: childMapping,
      ...(mountKeys?.get(mountLid) === undefined ? {} : { key: mountKeys.get(mountLid) }),
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

    // Pull the child's mapping into our parent window. Default unset slots
    // to ENTITY_NULL_RAW so downstream "live" checks distinguish them from
    // the first Entity (gen=0+idx=0 encodes to raw u32 0).
    const window = mount.memberCount;
    for (let k = 0; k < window; k += 1) {
      mapping[(mount.memberFirst as unknown as number) + k] = childMapping[k] ?? ENTITY_NULL_RAW;
    }

    // Apply mount.overrides at instantiate-time (AC-19).
    // Each override.localId addresses a slot in *this* (parent) namespace
    // (R2/F-8 cement: parent-namespace + memberFirst+offset addressing).
    // The state map will be populated below with these overrides — but we
    // must also write the value through to the live entity column so the
    // readback invariant holds.
    // Mount-entity itself never has children attached by the caller other
    // than via the recursive child; nothing else to wire here.
    if (childOfToken !== undefined) {
      if (mount.parent !== undefined) {
        // Reparent the mount-entity ChildOf to the caller-specified parent.
        const parentSlot = mount.parent as unknown as number;
        const parentEntity = mapping[parentSlot];
        if (parentEntity !== undefined && parentEntity !== ENTITY_NULL_RAW) {
          const r = world.addComponent(mountEntity, {
            component: childOfToken,
            data: { parent: parentEntity } as never,
          });
          if (!r.ok) {
            // ChildOf may already be present from layer-1; reparent via set.
            const set = world.set(mountEntity, childOfToken, {
              parent: parentEntity,
            } as never);
            if (!set.ok) return set as Result<SceneMembersSpawn, EcsError>;
          }
        } else {
          // D-8: the owned parent slot is not spawned yet (owned entities
          // spawn in step 2, after this mount loop). Defer the ChildOf wire
          // to step 2's tail once mapping[parentSlot] is live.
          mountEntitiesNeedingDeferredParent.push([mountEntity, parentSlot]);
        }
      } else {
        // R2/B-1: default semantic — mount.parent === undefined wires the
        // mount entity ChildOf to *this* scene's synthetic root (created
        // in step 3 below). Defer the actual wire to step 5 after the
        // synthetic root spawn; record the mount entity here.
        mountEntitiesNeedingRootParent.push(mountEntity);
      }
    }
  }

  // 2. Spawn entities[] entities. Topo-sort by ChildOf so parents are
  //    spawned before children (so localId remap can read mapping live).
  //    This runs AFTER mount processing (step 1) so cross-boundary
  //    `ChildOf {parent: <mount-window-localId>}` references resolve
  //    correctly (AC-24).
  const order = sceneTopoSort(ownEntities);
  for (const idx of order) {
    const node = ownEntities[idx];
    if (node === undefined) continue;
    const lid = node.localId as unknown as number;
    const compDataRes = worldBuildSceneEntityComponentDatas(world, node, mapping, diagnostics);
    if (!compDataRes.ok) return compDataRes;
    const sp = (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
      ...compDataRes.value,
    );
    if (!sp.ok) return sp as Result<SceneMembersSpawn, EcsError>;
    const e = sp.value;
    mapping[lid] = e as unknown as number;
    entityToLocalId.set(e, lid as unknown as LocalEntityId);
    if (node.components.ChildOf === undefined) {
      rootEntities.push(e);
    }
  }

  // Hierarchy order cannot order arbitrary entity references (including
  // cycles). Once every slot is live, rebind schema-declared entity fields
  // through the same projection used at spawn. No asset-specific fixups.
  for (const node of [
    ...ownEntities,
    ...ownMounts.map((mount) => ({ localId: mount.localId, components: mount.components ?? {} })),
  ]) {
    const entity = mapping[node.localId as unknown as number] as EntityHandle;
    const componentDatas = worldBuildSceneEntityComponentDatas(world, node, mapping, diagnostics);
    if (!componentDatas.ok) return componentDatas;
    for (const { component, data } of componentDatas.value) {
      const references = Object.fromEntries(
        Object.entries(data).filter(
          ([field]) =>
            Object.hasOwn(node.components[component.name] ?? {}, field) &&
            classifyEntityField(component, field) !== null,
        ),
      );
      if (Object.keys(references).length === 0) continue;
      const rebound = world.set(entity, component, references as never);
      if (!rebound.ok) return rebound;
    }
  }

  // 2b. D-8 (feat-20260707): wire deferred owned-parent mount ChildOf edges.
  //     Owned entities are now live (step 2 above), so mapping[parentSlot]
  //     resolves. Same shape as the mountEntitiesNeedingRootParent wiring in
  //     step 5. The relationship mirror hook (relationshipOnInsert) pushes the
  //     carrier into the owned parent's Children mirror automatically.
  if (childOfToken !== undefined) {
    for (const [mountEntity, parentSlot] of mountEntitiesNeedingDeferredParent) {
      const parentEntity = mapping[parentSlot];
      if (parentEntity === undefined || parentEntity === ENTITY_NULL_RAW) continue;
      const set = world.set(mountEntity, childOfToken, { parent: parentEntity } as never);
      if (!set.ok) {
        const r = world.addComponent(mountEntity, {
          component: childOfToken,
          data: { parent: parentEntity } as never,
        });
        if (!r.ok) return r as Result<SceneMembersSpawn, EcsError>;
      }
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
/**
 * @internal Spawn one SceneAsset's entities + apply mounts recursively, then
 * wrap them in a synthetic SceneInstance root (the anchor). This is the
 * runtime / Play / nested-mount finisher (charter P4: instance ==
 * entity-with-SceneInstance). Caller (`_instantiateSceneRec`) owns cycle
 * bookkeeping.
 */
export function worldInstantiateSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
  instanceKey?: string,
  sceneSourceKey?: string,
): Result<EntityHandle, EcsError> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const childOfToken = world.components.resolve('ChildOf');

  const compiled = compileKeyedSceneAsset(world, handle, asset, {
    resolveSource: (source, parentHandle) => worldResolveMountSource(world, source, parentHandle),
    resolveAsset: (childHandle) => worldResolveSceneAsset(world, childHandle),
    stack,
  });
  if (!compiled.ok) return err(compiled.error as EcsError);
  const compiledAsset = compiled.value.asset;
  // Validate and acquire source references before any child or member can spawn.
  const sourceReferences = retainSceneSourceReferences(world, asset);
  if (!sourceReferences.ok) return sourceReferences;
  const releaseSourceReferences = sourceReferences.value;
  const membersRes = worldSpawnSceneMembers(
    world,
    handle,
    compiledAsset,
    stack,
    diagnostics,
    compiled.value.mountKeyByLocalId,
  );
  if (!membersRes.ok) {
    releaseSourceReferences();
    return membersRes;
  }
  const { mapping, entityToLocalId, rootEntities, mountEntitiesNeedingRootParent, totalSlots } =
    membersRes.value;
  const { mountInstances } = membersRes.value;
  const ownMounts = compiledAsset.mounts ?? [];

  // Allocate the actual instance state once. The managed store owns payload
  // identity and release; Scene holds no parallel handle-to-state registry.
  const detached = new Set<LocalEntityId>();
  const bindings = new Map<string, EntityHandle>();
  const state: SceneInstanceState = {
    source: handle,
    ...(sceneSourceKey === undefined ? {} : { sceneSourceKey }),
    keyByLocalId: new Map(compiled.value.keyByLocalId),
    ...(instanceKey === undefined ? {} : { instanceKey }),
    bindings,
    entityToLocalId,
    detachedLocalIds: detached,
    overrides: new Map(),
    rootEntities,
    mountRoots: mountInstances.map(({ root }) => root),
    totalSlots,
    mountTimeOverrides: ownMounts.flatMap((m) => m.overrides ?? []),
  };
  const stateRef = world.allocUniqueRef('SceneInstanceState', state, releaseSourceReferences);
  // Spawn the root with SceneInstance component, mapping snapshot, and
  // state ref. The mapping is a Uint32Array (array<entity> field shape).
  // Convert mapping Uint32Array to plain number[] for spawn write — the
  // ECS array<entity> arm copies element-by-element and accepts both, but
  // the plain-array form sidesteps a Uint32Array.length=0 corner case
  // observed during M2 testing where a non-empty Uint32Array was written
  // as if empty (suspect: archetype write-array dispatch on instanceof
  // Array vs TypedArray).
  const mappingPlain: number[] = Array.from(mapping);
  // The synthetic root is the ChildOf parent of every owned root entity
  // (step 5 below) and may itself become a ChildOf parent of a caller-
  // supplied `parent` chain. propagateTransforms expands the ECS-maintained
  // Children lists parent-first and treats a parent missing Transform
  // as `hierarchy-broken`, so the synthetic root must carry Transform
  // (identity TRS via layer-2 defaults) when Transform is defined.
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
  const transformToken = world.components.resolve('Transform');
  if (transformToken !== undefined) {
    rootComponents.push({
      component: transformToken,
      data: {} as never,
    });
  }
  const rootSpawn = (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
    ...rootComponents,
  );
  if (!rootSpawn.ok) {
    releaseSourceReferences();
    return rootSpawn;
  }
  const rootEntity = rootSpawn.value;

  // Apply mount overrides after the synthetic root has been spawned.
  for (const mount of ownMounts) {
    for (const ov of mount.overrides ?? []) {
      // feat-20260713 M2 / w8: `MountOverride.field` is optional (add-or-patch
      // discriminant carried by the shape itself). Record the override into
      // the SceneInstanceState map keyed by comp (no field) or comp:field
      // (field-patch), then apply it to the live member column via the shared
      // add-or-patch helper.
      const lid = ov.localId as unknown as LocalEntityId;
      let fieldMap = state.overrides.get(lid);
      if (fieldMap === undefined) {
        fieldMap = new Map();
        state.overrides.set(lid, fieldMap);
      }
      const { localId: _localId, ...record } = ov;
      fieldMap.set(mountOverrideStateKey(ov), record);
      // Apply override to the live member entity column.
      const memberEntityRaw = mapping[lid as unknown as number];
      if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
        const memberEntity = memberEntityRaw as unknown as EntityHandle;
        const applyRes = worldApplyMountOverride(
          world,
          memberEntity,
          worldRemapMountOverride(world, ov, mapping),
        );
        if (!applyRes.ok) {
          return applyRes as Result<EntityHandle, EcsError>;
        }
      }
    }
  }

  // Populate direct and nested keyed addresses only after this root state is
  // visible. Child SceneInstance states were published by the recursive spawn
  // above, so the same walk can project the complete address closure.
  collectSceneEntityBindings(world, rootEntity, [], bindings);

  // 5. Wire ChildOf for every owned root entity (no ChildOf at layer-1)
  //    to the synthetic root.
  if (childOfToken !== undefined) {
    for (const rootE of rootEntities) {
      if (!world.hasComponent(rootE, childOfToken)) {
        // No ChildOf yet — attach to synthetic root.
        const r = world.addComponent(rootE, {
          component: childOfToken,
          data: { parent: rootEntity } as never,
        });
        if (!r.ok) return r as Result<EntityHandle, EcsError>;
      }
    }
    // R2/B-1: wire mount entities with default `mount.parent === undefined`
    // to this scene's synthetic root. _spawnMountEntity may have attached a
    // placeholder ChildOf {parent: ENTITY_NULL_RAW} when mount.components
    // was empty; overwrite via set so the ChildOf chain meshRenderer ->
    // childSyntheticRoot -> mountEntity -> outerSyntheticRoot resolves
    // through Transform-bearing parents (AC-16 / requirements S-7).
    for (const mountE of mountEntitiesNeedingRootParent) {
      const set = world.set(mountE, childOfToken, { parent: rootEntity } as never);
      if (!set.ok) {
        const r = world.addComponent(mountE, {
          component: childOfToken,
          data: { parent: rootEntity } as never,
        });
        if (!r.ok) return r as Result<EntityHandle, EcsError>;
      }
    }
    // Caller-supplied parent: synthetic root's ChildOf -> parent.
    if (parent !== undefined) {
      const r = world.addComponent(rootEntity, {
        component: childOfToken,
        data: { parent } as never,
      });
      if (!r.ok) return r as Result<EntityHandle, EcsError>;
    }
  }

  return ok(rootEntity);
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
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
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
      diagnostics,
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
  _diagnostics: SceneInstantiateDiagnostic[],
): Result<ComponentData[], EcsError> {
  const out: ComponentData[] = [];
  const nodeLocalId = node.localId as unknown as number;
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
      if (kind !== null) {
        // Entity / array<entity> field — remap through the shared kernel.
        // localId -> live Entity. Slots not yet spawned hold ENTITY_NULL_RAW.
        const sceneRemap = (localId: number): number => {
          if (localId < 0 || localId >= mapping.length) return ENTITY_NULL_RAW;
          const live = mapping[localId];
          return live === undefined || live === ENTITY_NULL_RAW ? ENTITY_NULL_RAW : live;
        };
        remappedRaw[fieldName] = remapEntityFieldValue(value, kind, sceneRemap);
      } else {
        remappedRaw[fieldName] = value;
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
  const remapField = (field: string, value: unknown): unknown => {
    const kind = classifyEntityField(token as Component, field);
    if (kind === null) return value;
    const toLive = (slot: number): number => {
      if (slot < 0 || slot >= mapping.length) return ENTITY_NULL_RAW;
      return mapping[slot] ?? ENTITY_NULL_RAW;
    };
    return remapEntityFieldValue(value, kind, toLive);
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
  diagnostics: SceneInstantiateDiagnostic[],
): Result<EntityHandle, EcsError> {
  const fakeNode: CompiledSceneEntity = {
    localId: mount.localId,
    components: mount.components ?? {},
  };
  const cdRes = worldBuildSceneEntityComponentDatas(world, fakeNode, mapping, diagnostics);
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
  return (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(...cdRes.value);
}
/** @internal Resolve mount.source through the wired SceneAssetResolver. */
export function worldResolveMountSource(
  world: World,
  source: number | string,
  parentHandle: Handle<'SceneAsset', 'shared'>,
): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
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
  // Collect descendants first (DFS via iterDescendants) to avoid mutating
  // while iterating. SceneInstance.mapping also owns members that may not be
  // reachable through a Children mirror in a partially registered host. The
  // nested anchor list closes that same ownership boundary for mounted scenes.
  const list: EntityHandle[] = [];
  const seen = new Set<number>();
  const collect = (anchor: EntityHandle): void => {
    for (const e of world.iterDescendants(anchor)) {
      const raw = e as unknown as number;
      if (!seen.has(raw)) {
        seen.add(raw);
        list.push(e);
      }
    }
    const stateRes = worldGetSceneInstanceState(world, anchor);
    if (!stateRes.ok) return;
    for (const e of stateRes.value.entityToLocalId.keys()) {
      const raw = e as unknown as number;
      if (!seen.has(raw)) {
        seen.add(raw);
        list.push(e);
      }
    }
    for (const nestedRoot of stateRes.value.mountRoots) {
      const raw = nestedRoot as unknown as number;
      if (seen.has(raw)) continue;
      seen.add(raw);
      list.push(nestedRoot);
      collect(nestedRoot);
    }
  };
  collect(root);
  const childOfToken = world.components.resolve('ChildOf');
  // ChildOf uses linkedSpawn, so a parent-first pass would recursively retire
  // its children before this function can count them. Sort the ownership set
  // by its live ChildOf depth instead of relying on mirror traversal order;
  // nested SceneInstance roots are siblings of their mount carrier in the
  // flattened traversal but parents of the mounted members.
  const owned = new Set(list.map((entity) => Number(entity)));
  const ownedDepth = (entity: EntityHandle): number => {
    if (childOfToken === undefined) return 0;
    let current = entity;
    let depth = 0;
    const visited = new Set<number>();
    while (!visited.has(Number(current))) {
      visited.add(Number(current));
      const parentRes = world.get(current, childOfToken);
      if (!parentRes.ok) break;
      const parent = (parentRes.value as { parent: EntityHandle }).parent;
      if (!owned.has(Number(parent))) break;
      depth += 1;
      current = parent;
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
  const assetRes = worldResolveSceneAsset(world, state.source);
  if (!assetRes.ok) return assetRes;
  const key = state.keyByLocalId.get(lid as unknown as number);
  const node = key === undefined ? undefined : assetRes.value.entities[key];
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
): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
  const stateRes = worldGetSceneInstanceState(world, root);
  if (!stateRes.ok) return stateRes;
  return ok(stateRes.value.source);
}

/**
 * Topological sort over the implicit ChildOf graph (parents before children).
 * Cycle-free input always covers all n nodes; cyclic input emits whatever was
 * reachable from indegree-0 (the fallback caller handles cycle reporting via
 * `pack-cyclic-reference` at the upstream scanner / runtime path).
 */
function sceneTopoSort(nodes: readonly CompiledSceneEntity[]): readonly number[] {
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Uint32Array(n);
  const localIdToIdx = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    localIdToIdx.set(node.localId as unknown as number, i);
  }
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const child = node.components.ChildOf;
    if (child === undefined) continue;
    const p = (child as Record<string, unknown>).parent;
    if (typeof p === 'number') {
      const parentIdx = localIdToIdx.get(p);
      if (parentIdx !== undefined && parentIdx !== i) {
        childrenOf[parentIdx]?.push(i);
        indeg[i] = (indeg[i] ?? 0) + 1;
      }
    }
  }
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if ((indeg[i] ?? 0) === 0) queue.push(i);
  while (queue.length > 0) {
    const head = queue.shift();
    if (head === undefined) break;
    order.push(head);
    for (const c of childrenOf[head] ?? []) {
      indeg[c] = (indeg[c] ?? 0) - 1;
      if ((indeg[c] ?? 0) === 0) queue.push(c);
    }
  }
  // Append any nodes left unvisited (defensive — cycle would surface here).
  for (let i = 0; i < n; i += 1) {
    if (!order.includes(i) && nodes[i] !== undefined) order.push(i);
  }
  return order;
}
