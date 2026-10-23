import { Disabled, type World as EcsWorld, Entity, type EntityHandle } from '@forgeax/engine-ecs';
import {
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  type PhysicsContactManifold,
  type PhysicsContactNormalFilter,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RigidBody, World } from '../pkg/rapier.mjs';

const limit = 4096;
type ContactOwner = { readonly entity: number; readonly shape?: string; readonly body: RigidBody };
/** Resolve a collider handle and its native parent body to its managed owner. */
type ResolveOwner = (collider: number, parent: RigidBody | null) => ContactOwner | undefined;
type VisitKind = 'colliders' | 'pairs' | 'manifolds' | 'points';
type PhysicsVectorLike = { readonly x: number; readonly y: number; readonly z: number };

export function currentContactOwner(
  collider: number,
  parent: RigidBody | null,
  entities: ReadonlyMap<number, { readonly bodyHandle: number }>,
  world: EcsWorld | undefined,
  shapes: ReadonlyMap<number, { readonly id: string }>,
): ContactOwner | undefined {
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
  const shape = shapes.get(collider);
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

/** One native contact row of a body: handles plus solver-manifold facts. */
interface ContactPairRow {
  readonly collider: number;
  readonly other: number;
  readonly manifolds: number;
  /** 1 touching, 0 not touching, -1 a non-finite solver normal before any match. */
  readonly touching: number;
}

/**
 * Visit a body's managed contact pairs from one native roster read. The native
 * pass applies the enabled/sensor/group admission per pair in native order;
 * owner resolution, liveness and the visit budget stay here with the same
 * per-pair accounting as the former per-collider callback walk.
 */
function visitContactPairs(
  world: World,
  body: RigidBody,
  owner: ResolveOwner,
  budget: ContactQueryBudget,
  filterMask: number | undefined,
  direction: PhysicsVectorLike | undefined,
  minimumDot: number | undefined,
  visit: (row: ContactPairRow, own: ContactOwner, otherOwner: ContactOwner) => void,
): void {
  budget.add('colliders', body.numColliders());
  const rows = world.narrowPhase.bodyContactPairs(
    world.bodies,
    world.colliders,
    body.handle,
    filterMask,
    direction,
    minimumDot,
  );
  let index = 0;
  while (index < rows.length) {
    const collider = rows[index] as number;
    const end = index + 2 + (rows[index + 1] as number) * 4;
    index += 2;
    const own = owner(collider, body);
    // An unowned own collider is skipped without charging its pairs.
    if (own)
      for (let row = index; row < end; row += 4) {
        budget.add('pairs');
        // Removed, disabled, sensor and masked-out partners carry -1 manifolds.
        // Reject them before Native parent reads and ECS liveness checks.
        const manifolds = rows[row + 2] as number;
        if (manifolds < 0) continue;
        const parent = rows[row + 1] as number;
        const otherOwner = owner(
          rows[row] as number,
          Number.isNaN(parent) ? null : world.bodies.get(parent),
        );
        if (!otherOwner || otherOwner.entity === own.entity) continue;
        visit(
          { collider, other: rows[row] as number, manifolds, touching: rows[row + 3] as number },
          own,
          otherOwner,
        );
      }
    index = end;
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
  visitContactPairs(
    world,
    body,
    owner,
    budget,
    filterMask,
    undefined,
    undefined,
    (row, own, otherOwner) => {
      // A pair without any solver contact contributes only its empty manifold
      // roster; skip the per-manifold native reads for it.
      if (row.touching === 0) {
        budget.add('manifolds', row.manifolds);
        return;
      }
      const otherBody = otherOwner.body;
      const awake =
        (body.isDynamic() && !body.isSleeping()) ||
        (otherBody.isDynamic() && !otherBody.isSleeping());
      world.narrowPhase.contactPair(
        row.collider,
        row.other,
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
    },
  );
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
  visitContactPairs(
    world,
    body,
    owner,
    budget,
    filterMask,
    direction,
    normalFilter?.minimumDot,
    (row, _own, otherOwner) => {
      if (result.has(otherOwner.entity)) return;
      // Charge the complete roster, including native any()'s unvisited tail.
      budget.add('manifolds', row.manifolds);
      if (row.touching < 0)
        throw new ManagedPhysicsError('managed-physics-unavailable', {
          reason: 'current contact query failed: current contacts require a finite solver normal',
        });
      if (row.touching > 0) result.add(otherOwner.entity);
    },
  );
  return [...result];
}
