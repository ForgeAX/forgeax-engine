import {
  type BodyMotion,
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import { readNativeBodyMotion } from './derived-admission-preflight.js';
import type { RapierRigidBody, RapierWorld } from './physics-entity-records.js';

export interface BodyMotionWriteback {
  entity: number;
  pos: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

/** Motion projection owns its subscribers and current/previous native frontier.
 * Explicit writes retain one following observation, including a kinematic
 * arrival's final zero velocity. No poses or history are retained here. */
export class BodyMotionReadback {
  private pending = new Set<number>();
  private active = new Set<number>();
  private readonly listeners = new Set<(entity: number) => void>();

  subscribe(listener: (entity: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  readonly notify = (entity: number): void => {
    if (!this.listeners.size) return;
    for (const listener of this.listeners) {
      try {
        listener(entity);
      } catch (cause) {
        console.error('Physics motion observer failed', cause);
      }
    }
  };

  enroll(entity: number, followingStep = false): void {
    this.pending.add(entity);
    if (followingStep) this.active.add(entity);
  }

  read(
    entity: number,
    body: RapierRigidBody | undefined,
  ): Result<BodyMotion, ManagedPhysicsFailure> {
    if (body === undefined) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    return ok(readNativeBodyMotion(body));
  }

  writeback(
    raw: RapierWorld,
    entities: ReadonlyMap<number, { bodyHandle: number }>,
    types: { Dynamic: number; KinematicPositionBased: number },
  ): BodyMotionWriteback[] {
    const results: BodyMotionWriteback[] = [],
      pending = this.pending,
      active = this.active;
    const observing = this.listeners.size !== 0;
    raw.forEachActiveRigidBody(
      (body: { userData: unknown; handle: number; bodyType(): number }) => {
        const entity = body.userData as number;
        if (entities.get(entity)?.bodyHandle !== body.handle) return;
        // Preserve the original writeback route when no consumer subscribes.
        // Position kinematics with observers use explicit current/following writes;
        // Rapier may report them active indefinitely even while unchanged.
        if (observing && body.bodyType() === types.KinematicPositionBased) return;
        active.add(entity);
        pending.add(entity);
      },
    );
    for (const entity of pending) {
      const record = entities.get(entity);
      if (record === undefined) continue;
      const body = raw.bodies.get(record.bodyHandle) as RapierRigidBody | null;
      if (!body) continue;
      this.notify(entity);
      if (body.bodyType() !== types.Dynamic) continue;
      const translation = body.translation(),
        rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y, z: translation.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      });
    }
    pending.clear();
    this.pending = active;
    this.active = pending;
    return results;
  }

  clear(): void {
    this.listeners.clear();
    this.pending.clear();
    this.active.clear();
  }
}
