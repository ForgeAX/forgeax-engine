import { Disabled, type World as EcsWorld, Entity, type EntityHandle } from '@forgeax/engine-ecs';
import {
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  type PhysicsContactManifold,
  type PhysicsContactNormalFilter,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { Collider, RigidBody, World } from '../pkg/rapier.mjs';

const limit = 4096;
type ContactOwner = { readonly entity: number; readonly shape?: string; readonly body: RigidBody };
type ResolveOwner = (collider: Collider) => ContactOwner | undefined;
type VisitKind = 'colliders' | 'pairs' | 'manifolds' | 'points';

export function currentContactOwner(
  collider: Collider,
  entities: ReadonlyMap<number, { readonly bodyHandle: number }>,
  world: EcsWorld | undefined,
  shapes: ReadonlyMap<number, { readonly id: string }>,
): ContactOwner | undefined {
  const parent = collider.parent();
  if (parent === null || parent === undefined) return undefined;
  const owner = parent.userData;
  if (
    typeof owner !== 'number' ||
    entities.get(owner)?.bodyHandle !== parent.handle ||
    (world &&
      (!world.hasComponent(owner as EntityHandle, Entity) ||
        world.hasComponent(owner as EntityHandle, Disabled)))
  )
    return undefined;
  const shape = shapes.get(collider.handle);
  return { entity: owner, body: parent, ...(shape ? { shape: shape.id } : {}) };
}

/** Both projections share completed-step admission and retain atomic query failures. */
export function readContactQuery<T>(
  available: boolean,
  entity: number,
  resolveBody: () => RigidBody | undefined,
  read: (body: RigidBody) => T,
): Result<T, ManagedPhysicsFailure> {
  if (!available)
    return err(
      new ManagedPhysicsError('managed-physics-unavailable', {
        reason: 'current contacts require a healthy completed physics step after all mutations',
      }),
    );
  const body = resolveBody();
  if (!body) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
  try {
    return ok(read(body));
  } catch (cause) {
    return err(
      cause instanceof ManagedPhysicsError
        ? cause
        : new ManagedPhysicsError('managed-physics-unavailable', {
            reason: `current contact query failed: ${String(cause)}`,
          }),
    );
  }
}

class ContactQueryBudget {
  private visited = 0;
  private readonly counts = { colliders: 0, pairs: 0, manifolds: 0, points: 0 };
  constructor(private readonly entity: number) {}
  get remaining(): number {
    return limit - this.visited;
  }
  add(kind: VisitKind, count = 1): void {
    this.visited += count;
    this.counts[kind] += count;
    if (!Number.isSafeInteger(count) || count < 0 || this.visited > limit)
      throw new ManagedPhysicsError('managed-physics-unavailable', {
        reason:
          `current contact query exceeds ${limit} native visits for entity ${this.entity}: ` +
          `colliders=${this.counts.colliders}, pairs=${this.counts.pairs}, ` +
          `manifolds=${this.counts.manifolds}, points=${this.counts.points}; exhausted at ${kind}`,
      });
  }
}

function visitContactPairs(
  world: World,
  body: RigidBody,
  owner: ResolveOwner,
  budget: ContactQueryBudget,
  filterMask: number | undefined,
  visit: (collider: Collider, other: Collider, own: ContactOwner, otherOwner: ContactOwner) => void,
): void {
  const colliderCount = body.numColliders();
  budget.add('colliders', colliderCount);
  for (let index = 0; index < colliderCount; index += 1) {
    const collider = body.collider(index);
    if (!collider?.isEnabled() || collider.isSensor()) continue;
    const own = owner(collider);
    if (!own) continue;
    world.contactPairsWith(collider, (other) => {
      budget.add('pairs');
      // Native adjacency can retain a removed collider until the next step.
      if (!other) return;
      const otherOwner = owner(other);
      if (!other.isEnabled() || other.isSensor() || !otherOwner || otherOwner.entity === own.entity)
        return;
      if (filterMask !== undefined) {
        const groups = other.collisionGroups();
        if (((groups >>> 16) & filterMask) === 0 || ((filterMask >>> 16) & groups) === 0) return;
      }
      visit(collider, other, own, otherOwner);
    });
  }
}

/** Query the native contact graph in place; no contact or load registry is retained. */
export function queryContactManifolds(
  world: World,
  body: RigidBody,
  owner: ResolveOwner,
  entity: number,
  filterMask?: number,
): PhysicsContactManifold[] {
  const result: PhysicsContactManifold[] = [];
  const budget = new ContactQueryBudget(entity);
  const vector = (value: { x: number; y: number; z: number } | null): PhysicsVector => {
    if (
      !value ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      !Number.isFinite(value.z)
    )
      throw new ManagedPhysicsError('managed-physics-unavailable', {
        reason: 'current contact query requires finite native world-space points and normals',
      });
    return [value.x, value.y, value.z];
  };
  visitContactPairs(world, body, owner, budget, filterMask, (collider, other, own, otherOwner) => {
    const otherBody = otherOwner.body;
    const awake =
      (body.isDynamic() && !body.isSleeping()) ||
      (otherBody.isDynamic() && !otherBody.isSleeping());
    world.narrowPhase.contactPair(
      collider.handle,
      other.handle,
      world.bodies,
      (manifold, flipped) => {
        budget.add('manifolds');
        const pointCount = manifold.numSolverContacts();
        budget.add('points', pointCount);
        if (pointCount === 0) return;
        const normal = vector(manifold.normal());
        const points: PhysicsVector[] = new Array(pointCount);
        for (let point = 0; point < pointCount; point += 1)
          points[point] = vector(manifold.solverContactPoint(point));
        let normalImpulse: number | null = null;
        if (awake) {
          normalImpulse = 0;
          for (let contact = 0; contact < pointCount; contact += 1) {
            const impulse = manifold.solverContactImpulse(contact);
            if (!Number.isFinite(impulse) || impulse < 0)
              throw new ManagedPhysicsError('managed-physics-unavailable', {
                reason: 'current contact query requires finite nonnegative native impulses',
              });
            normalImpulse += impulse;
          }
          if (!Number.isFinite(normalImpulse))
            throw new ManagedPhysicsError('managed-physics-unavailable', {
              reason: 'current contact impulse sum exceeds finite numeric range',
            });
        }
        result.push({
          other: otherOwner.entity,
          ...(own.shape === undefined ? {} : { shape: own.shape }),
          ...(otherOwner.shape === undefined ? {} : { otherShape: otherOwner.shape }),
          normal: flipped ? [-normal[0], -normal[1], -normal[2]] : normal,
          points,
          normalImpulse,
        });
      },
      true,
    );
  });
  return result;
}

/** Read a complete entity relation without transporting solver points or manifold objects. */
export function queryContactNeighbors(
  world: World,
  body: RigidBody,
  owner: ResolveOwner,
  entity: number,
  filterMask?: number,
  normalFilter?: PhysicsContactNormalFilter,
): number[] {
  if (
    normalFilter !== undefined &&
    (!Array.isArray(normalFilter.direction) ||
      normalFilter.direction.length !== 3 ||
      !normalFilter.direction.every(Number.isFinite) ||
      !Number.isFinite(normalFilter.minimumDot))
  )
    throw new ManagedPhysicsError('managed-physics-unavailable', {
      reason: 'current contact normal filter requires a finite direction and minimum dot product',
    });
  const direction =
    normalFilter === undefined
      ? undefined
      : {
          x: normalFilter.direction[0],
          y: normalFilter.direction[1],
          z: normalFilter.direction[2],
        };
  const result = new Set<number>();
  const budget = new ContactQueryBudget(entity);
  visitContactPairs(world, body, owner, budget, filterMask, (collider, other, _own, otherOwner) => {
    if (result.has(otherOwner.entity)) return;
    const pair = world.narrowPhase.contactPairHasSolverContact(
      collider.handle,
      other.handle,
      budget.remaining,
      direction,
      normalFilter?.minimumDot,
    );
    // Charge the complete roster, including native any()'s unvisited tail.
    // The native wrapper skips the scan when that roster exceeds the budget.
    budget.add('manifolds', pair.manifoldCount);
    if (pair.touching) result.add(otherOwner.entity);
  });
  return [...result];
}
