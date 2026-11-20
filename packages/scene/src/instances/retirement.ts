import {
  Disabled,
  type EcsError,
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';

export type SceneRetirementReason =
  | 'invalid-budget'
  | 'duplicate-member'
  | 'participating-member'
  | 'foreign-child'
  | 'hierarchy-cycle'
  | 'stale-ownership'
  | 'changed-hierarchy';

export class SceneRetirementError extends Error {
  readonly code = 'scene-retirement-invalid';
  readonly expected =
    'a stopped Scene instance with an exclusively owned, current retirement roster';
  readonly hint =
    'retain the remaining custody and repair the owning lifecycle before resuming retirement';
  constructor(
    readonly detail: { readonly reason: SceneRetirementReason; readonly entity: EntityHandle },
  ) {
    super(`Scene retirement: ${detail.reason}`);
    this.name = 'SceneRetirementError';
  }
}

export interface SceneRetirementStatus {
  readonly done: boolean;
  readonly planned: boolean;
  readonly retiredMembers: number;
  readonly pendingMembers: number;
}

export interface SceneRetirement {
  readonly inspect: () => SceneRetirementStatus;
  readonly step: (
    maxWork: number,
    canContinue?: () => boolean,
  ) => Result<SceneRetirementStatus, SceneRetirementError | EcsError>;
}

interface RetirementPlan {
  readonly order: readonly EntityHandle[];
  readonly parents: ReadonlyMap<EntityHandle, number | undefined>;
}

type RetirementResult<T> = Result<T, SceneRetirementError | EcsError>;
function invalid(
  reason: SceneRetirementReason,
  entity = 0 as EntityHandle,
): RetirementResult<never> {
  return err(new SceneRetirementError({ reason, entity }));
}
function alive(world: World, entity: EntityHandle): boolean {
  return world[worldRead].getFieldValue(entity, Entity, 'self') !== undefined;
}

function* validateMembers(
  world: World,
  members: readonly EntityHandle[],
): Generator<void, RetirementResult<Set<EntityHandle>>, void> {
  const owned = new Set<EntityHandle>();
  for (const entity of members) {
    yield;
    if (owned.has(entity)) return invalid('duplicate-member', entity);
    owned.add(entity);
    if (!alive(world, entity)) continue;
    if (!world.hasComponent(entity, Disabled)) return invalid('participating-member', entity);
  }
  for (const entity of members) {
    const read = world[worldRead];
    const count = read.getArrayLength(entity, Children, 'entities') ?? 0;
    for (let index = 0; index < count; index++) {
      yield;
      const child = read.getArrayElement(entity, Children, 'entities', index) as EntityHandle;
      if (!owned.has(child) || !read.hasRelationshipEdge(ChildOf, child, entity))
        return invalid('foreign-child', entity);
    }
  }
  return ok(owned);
}

function* planRetirement(
  world: World,
  members: readonly EntityHandle[],
): Generator<void, RetirementResult<RetirementPlan>, void> {
  const validated = yield* validateMembers(world, members);
  if (!validated.ok) return validated;
  const parents = new Map<EntityHandle, number | undefined>();
  const childCounts = new Map<EntityHandle, number>();
  const leaves: EntityHandle[] = [];
  for (const entity of members) {
    yield;
    const parent = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
    parents.set(entity, parent);
    if (
      parent !== undefined &&
      parent !== ENTITY_NULL_RAW &&
      validated.value.has(parent as EntityHandle)
    )
      childCounts.set(parent as EntityHandle, (childCounts.get(parent as EntityHandle) ?? 0) + 1);
  }
  for (const entity of members) {
    yield;
    if (!childCounts.has(entity)) leaves.push(entity);
  }
  for (let cursor = 0; cursor < leaves.length; cursor++) {
    yield;
    const parent = parents.get(leaves[cursor] as EntityHandle) as EntityHandle | undefined;
    if (parent === undefined || !childCounts.has(parent)) continue;
    const remaining = (childCounts.get(parent) as number) - 1;
    childCounts.set(parent, remaining);
    if (remaining === 0) leaves.push(parent);
  }
  if (leaves.length !== members.length) return invalid('hierarchy-cycle');
  return ok({ order: leaves, parents });
}

function retireMember(
  world: World,
  entity: EntityHandle,
  parent: number | undefined,
): RetirementResult<void> {
  if (!alive(world, entity)) return ok(undefined);
  if (!world.hasComponent(entity, Disabled)) return invalid('participating-member', entity);
  const read = world[worldRead];
  if (
    read.getFieldValue(entity, ChildOf, 'parent') !== parent ||
    (read.getArrayLength(entity, Children, 'entities') ?? 0) !== 0
  )
    return invalid('changed-hierarchy', entity);
  return world.despawn(entity);
}

/**
 * Caller first stops domain participation and transfers source-reference custody.
 * Each work quantum performs one planning continuation or at most one leaf despawn;
 * linkedSpawn therefore cannot recursively drain the entire owned subtree.
 * This task proves Scene retirement only, never native/GPU retirement.
 */
export function createSceneRetirement(
  world: World,
  members: readonly EntityHandle[],
  isSafe: () => boolean,
): SceneRetirement {
  let roster: readonly EntityHandle[] = [...members];
  let planning: ReturnType<typeof planRetirement> | undefined = planRetirement(world, roster);
  let plan: RetirementPlan | undefined;
  let cursor = 0;
  let retiredMembers = 0;
  let done = false;
  const inspect = (): SceneRetirementStatus => ({
    done,
    planned: plan !== undefined || done,
    retiredMembers,
    pendingMembers: done ? 0 : roster.length - cursor,
  });
  const step = (
    maxWork: number,
    canContinue?: () => boolean,
  ): RetirementResult<SceneRetirementStatus> => {
    if (!Number.isSafeInteger(maxWork) || maxWork <= 0) return invalid('invalid-budget');
    if (done) return ok(inspect());
    for (let work = 0; work < maxWork && canContinue?.() !== false; work++) {
      if (!isSafe()) return invalid('stale-ownership');
      if (plan === undefined) {
        const next = (planning as ReturnType<typeof planRetirement>).next();
        if (!next.done) continue;
        if (!next.value.ok) {
          planning = planRetirement(world, roster);
          return next.value;
        }
        plan = next.value.value;
        planning = undefined;
      } else if (cursor < plan.order.length) {
        const entity = plan.order[cursor] as EntityHandle;
        const existed = alive(world, entity);
        const retired = retireMember(world, entity, plan.parents.get(entity));
        if (!retired.ok) return retired;
        cursor++;
        if (existed) retiredMembers++;
      }
      if (cursor === roster.length) {
        done = true;
        roster = [];
        plan = undefined;
        return ok(inspect());
      }
    }
    return ok(inspect());
  };
  return { inspect, step };
}
