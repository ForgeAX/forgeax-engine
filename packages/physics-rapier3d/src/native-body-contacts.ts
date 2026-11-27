import type { PhysicsContactObservation } from '@forgeax/engine-physics';
import type { Collider, RigidBody, World } from '../pkg/rapier.mjs';
import type { Rapier3DCollisionEvent } from './physics-entity-records.js';

/** Existing any-manifold existence policy used when retiring native collider events. */
export function bodiesShareCollision(
  raw: World,
  bodyA: RigidBody | undefined,
  bodyB: RigidBody | undefined,
  entityA: number,
  entityB: number,
  owner: (handle: number) => number | undefined,
): boolean {
  if (bodyA === undefined || bodyB === undefined) return false;
  // Symmetric contact existence only needs the smaller collider roster.
  const smaller = bodyA.numColliders() <= bodyB.numColliders() ? bodyA : bodyB;
  const otherEntity = smaller === bodyA ? entityB : entityA;
  for (const colliderA of Array.from({ length: smaller.numColliders() }, (_, index) =>
    smaller.collider(index),
  )) {
    let hasContact = false;
    raw.intersectionPairsWith(colliderA, (other) => {
      if (
        !hasContact &&
        owner(other.handle) === otherEntity &&
        raw.intersectionPair(colliderA, other)
      )
        hasContact = true;
    });
    if (hasContact) return true;
    raw.contactPairsWith(colliderA, (other) => {
      if (hasContact || owner(other.handle) !== otherEntity) return;
      raw.contactPair(colliderA, other, () => {
        hasContact = true;
      });
    });
    if (hasContact) return true;
  }
  return false;
}

interface StoppedPair {
  readonly a: number;
  readonly b: number;
  readonly bodyA: number;
  readonly bodyB: number;
}
/** One-shot work from actual stopped logical pairs, not a second contact authority. */
export class StaticContactTransitions {
  private readonly stopped = new Map<string, StoppedPair>();
  private readonly adjacency = new Map<number, Set<string>>();
  get size(): number {
    return this.stopped.size;
  }
  constructor(private readonly body: (entity: number) => RigidBody | undefined) {}
  remember(a: number, b: number): void {
    const first = this.body(a),
      second = this.body(b);
    if (first === undefined || second === undefined) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    this.stopped.set(key, { a, b, bodyA: first.handle, bodyB: second.handle });
    for (const entity of [a, b]) {
      let keys = this.adjacency.get(entity);
      if (keys === undefined) {
        keys = new Set();
        this.adjacency.set(entity, keys);
      }
      keys.add(key);
    }
  }
  reconcile(
    raw: World,
    restore: (a: number, b: number, first: number, second: number) => void,
  ): void {
    for (const [key, pair] of this.stopped) {
      const first = this.body(pair.a),
        second = this.body(pair.b);
      this.remove(key, pair);
      if (
        first?.handle !== pair.bodyA ||
        second?.handle !== pair.bodyB ||
        !first.isEnabled() ||
        !second.isEnabled()
      )
        continue;
      const contact = touchingPair(raw, first, second);
      if (contact !== undefined) restore(pair.a, pair.b, contact[0], contact[1]);
    }
  }
  private remove(key: string, pair: StoppedPair): void {
    this.stopped.delete(key);
    for (const entity of [pair.a, pair.b]) {
      const keys = this.adjacency.get(entity);
      keys?.delete(key);
      if (keys?.size === 0) this.adjacency.delete(entity);
    }
  }
  forget(entity: number, expectedBody?: number): void {
    const keys = this.adjacency.get(entity);
    if (keys === undefined) return;
    for (const key of keys) {
      const pair = this.stopped.get(key);
      if (pair === undefined)
        throw new Error('static contact transition index lost its owned work');
      if (
        expectedBody !== undefined &&
        (pair.a === entity ? pair.bodyA : pair.bodyB) !== expectedBody
      )
        continue;
      this.remove(key, pair);
    }
  }
  clear(): void {
    this.stopped.clear();
    this.adjacency.clear();
  }
}

/** Called only after a completed native step; solver contacts define actual solid touching. */
function touchingPair(
  raw: World,
  first: RigidBody,
  second: RigidBody,
): readonly [number, number] | undefined {
  for (let index = 0; index < first.numColliders(); index++) {
    const collider = first.collider(index);
    if (!collider.isEnabled()) continue;
    let result: readonly [number, number] | undefined;
    const visit = (other: Collider) => {
      if (result !== undefined || other.parent()?.handle !== second.handle || !other.isEnabled())
        return;
      if (collider.isSensor() || other.isSensor()) {
        if (raw.intersectionPair(collider, other)) result = [collider.handle, other.handle];
      } else {
        const contacts = raw.narrowPhase.contactPairHasSolverContact(
          collider.handle,
          other.handle,
          4096,
        );
        if (contacts.manifoldCount > 4096)
          throw new Error('static contact transition exceeds 4096 manifolds');
        if (contacts.touching) result = [collider.handle, other.handle];
      }
    };
    raw.contactPairsWith(collider, visit);
    raw.intersectionPairsWith(collider, visit);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Publish contact restorations after the existing native event drain. */
export function restoreStaticContactObservations(
  transitions: StaticContactTransitions,
  raw: World,
  fixedStep: number,
  addPair: (a: number, b: number) => boolean,
  shapeId: (handle: number) => string | undefined,
  observe: (observation: PhysicsContactObservation, first: number, second: number) => void,
  publish: (event: Rapier3DCollisionEvent) => void,
): void {
  transitions.reconcile(raw, (a, b, first, second) => {
    if (!addPair(a, b)) return;
    const shapeA = shapeId(first),
      shapeB = shapeId(second);
    const shapes = {
      ...(shapeA === undefined ? {} : { shapeA }),
      ...(shapeB === undefined ? {} : { shapeB }),
    };
    observe({ phase: 'started', fixedStep, entityA: a, entityB: b, ...shapes }, first, second);
    publish({ type: 'started', fixedStep, entityA: a, entityB: b, ...shapes });
  });
}
