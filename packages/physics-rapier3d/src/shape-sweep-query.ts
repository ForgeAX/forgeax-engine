import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  finitePhysicsVector,
  type PhysicsQuaternion,
  PhysicsQueryError,
  type PhysicsQueryFailure,
  type PhysicsSweepQuery,
  type PhysicsVector,
  type ShapeSweepContact,
  type ShapeSweepResult,
  type SweepShape,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { Collider as RapierCollider } from '../pkg/rapier.mjs';
import type { PhysicsEntityRecord, RapierWorld } from './physics-entity-records.js';
import type { Rapier3DModule } from './wasm-loader.js';

export function sweepNativeShape(
  owner: {
    readonly raw: RapierWorld;
    readonly rapierModule: Rapier3DModule;
    readonly entityMap: ReadonlyMap<number, PhysicsEntityRecord>;
    readonly worldIdentity: World | undefined;
  },
  input: PhysicsSweepQuery,
  geometry: SweepShape,
  orientation: PhysicsQuaternion,
): Result<ShapeSweepResult, PhysicsQueryFailure> {
  const excluded = new Set(input.excludeEntities),
    hits: ShapeSweepContact[] = [];
  const entityOf = (collider: RapierCollider): number | undefined => {
    const parent = collider.parent();
    if (!parent) return undefined;
    const entity = parent.userData;
    if (typeof entity !== 'number') return undefined;
    const record = owner.entityMap.get(entity);
    if (
      !record ||
      record.bodyHandle !== parent.handle ||
      excluded.has(entity) ||
      (owner.worldIdentity !== undefined &&
        !owner.worldIdentity.hasComponent(entity as EntityHandle, Entity))
    )
      return undefined;
    return entity;
  };
  try {
    const createQueryShape = () => {
      switch (geometry.kind) {
        case 'sphere':
          return new owner.rapierModule.Ball(geometry.radius);
        case 'cuboid':
          return new owner.rapierModule.Cuboid(...geometry.halfExtents);
        case 'capsule':
          return new owner.rapierModule.Capsule(geometry.halfHeight, geometry.radius);
        case 'cylinder':
          return new owner.rapierModule.Cylinder(geometry.halfHeight, geometry.radius);
      }
    };
    const shape = createQueryShape();
    const position = { x: input.origin[0], y: input.origin[1], z: input.origin[2] },
      rotation = { x: orientation[0], y: orientation[1], z: orientation[2], w: orientation[3] };
    const flags =
      input.includeSensors === false
        ? owner.rapierModule.QueryFilterFlags.EXCLUDE_SENSORS
        : undefined;
    const eligible = (collider: RapierCollider) => entityOf(collider) !== undefined;
    let fraction = 0;
    const castToImpact = () => {
      if (input.initialOverlap === 'ignore') {
        owner.raw.intersectionsWithShape(
          position,
          rotation,
          shape,
          (collider: RapierCollider) => {
            const entity = entityOf(collider);
            if (entity !== undefined) excluded.add(entity);
            return true;
          },
          flags,
          input.filterMask,
          undefined,
          undefined,
          eligible,
        );
      }
      const hit = owner.raw.castShape(
        position,
        rotation,
        { x: input.motion[0], y: input.motion[1], z: input.motion[2] },
        shape,
        0,
        1,
        true,
        flags,
        input.filterMask,
        undefined,
        undefined,
        eligible,
      );
      if (hit === null) return ok({ hits, truncated: false });
      const entity = entityOf(hit.collider);
      fraction = hit.time_of_impact;
      const point: PhysicsVector = [hit.witness1.x, hit.witness1.y, hit.witness1.z];
      const normal: PhysicsVector = [hit.normal1.x, hit.normal1.y, hit.normal1.z];
      if (entity === undefined)
        return err(
          new PhysicsQueryError('physics-query-failed', {
            reason: 'native sweep returned invalid contact evidence',
          }),
        );
      const validateImpactEvidence = () => {
        if (
          !Number.isFinite(fraction) ||
          fraction < 0 ||
          fraction > 1 ||
          !finitePhysicsVector(point, 3) ||
          !finitePhysicsVector(normal, 3)
        )
          return err(
            new PhysicsQueryError('physics-query-failed', {
              reason: 'native sweep returned invalid contact evidence',
            }),
          );
        return undefined;
      };
      const invalidImpact = validateImpactEvidence();
      if (invalidImpact !== undefined) return invalidImpact;
      excluded.add(entity);
      hits.push({ entity, point, normal, fraction });
      position.x += input.motion[0] * fraction;
      position.y += input.motion[1] * fraction;
      position.z += input.motion[2] * fraction;
      if (!finitePhysicsVector([position.x, position.y, position.z], 3))
        return err(
          new PhysicsQueryError('physics-query-failed', {
            reason: 'native impact pose is not finite',
          }),
        );
      return undefined;
    };
    if (!input.motion.every((value) => Math.fround(value) === 0)) {
      const stopped = castToImpact();
      if (stopped !== undefined) return stopped;
    }
    // Gather the actual contact batch at the first impact pose, not later
    // contacts along the remaining trajectory. Stationary queries use the same
    // native volume/contact path at their current pose, without artificial motion.
    let truncated = false,
      failure: PhysicsQueryFailure | undefined;
    owner.raw.intersectionsWithShape(
      position,
      rotation,
      shape,
      (collider: RapierCollider) => {
        const entity = entityOf(collider);
        if (entity === undefined) return true;
        if (hits.length === input.maxHits) {
          truncated = true;
          return false;
        }
        const contact = collider.contactShape(shape, position, rotation, 0);
        if (contact === null) {
          failure = new PhysicsQueryError('physics-query-failed', {
            reason: 'native overlap lacks target contact evidence',
          });
          return false;
        }
        const point: PhysicsVector = [contact.point1.x, contact.point1.y, contact.point1.z],
          normal: PhysicsVector = [contact.normal1.x, contact.normal1.y, contact.normal1.z];
        if (!finitePhysicsVector(point, 3) || !finitePhysicsVector(normal, 3)) {
          failure = new PhysicsQueryError('physics-query-failed', {
            reason: 'native overlap returned invalid contact evidence',
          });
          return false;
        }
        excluded.add(entity);
        hits.push({ entity, point, normal, fraction });
        return true;
      },
      flags,
      input.filterMask,
      undefined,
      undefined,
      eligible,
    );
    // Boundary-touching bodies can share the native impact time while strict
    // intersection testing excludes their float32 contact pose. Recover exact
    // native TOI ties, without expanding the sphere or inventing extra motion.
    if (
      failure === undefined &&
      !truncated &&
      input.motion.some((value) => Math.fround(value) !== 0)
    ) {
      while (true) {
        const hit = owner.raw.castShape(
          { x: input.origin[0], y: input.origin[1], z: input.origin[2] },
          rotation,
          { x: input.motion[0], y: input.motion[1], z: input.motion[2] },
          shape,
          0,
          1,
          true,
          flags,
          input.filterMask,
          undefined,
          undefined,
          eligible,
        );
        if (hit === null || hit.time_of_impact > fraction) break;
        const entity = entityOf(hit.collider);
        const point: PhysicsVector = [hit.witness1.x, hit.witness1.y, hit.witness1.z];
        const normal: PhysicsVector = [hit.normal1.x, hit.normal1.y, hit.normal1.z];
        if (
          entity === undefined ||
          hit.time_of_impact !== fraction ||
          !finitePhysicsVector(point, 3) ||
          !finitePhysicsVector(normal, 3)
        ) {
          failure = new PhysicsQueryError('physics-query-failed', {
            reason: 'native impact tie returned inconsistent contact evidence',
          });
          break;
        }
        if (hits.length === input.maxHits) {
          truncated = true;
          break;
        }
        excluded.add(entity);
        hits.push({ entity, point, normal, fraction });
      }
    }
    return failure === undefined ? ok({ hits, truncated }) : err(failure);
  } catch (cause) {
    return err(new PhysicsQueryError('physics-query-failed', { reason: String(cause) }));
  }
}
