import { type EntityHandle, type Query, Update, type World } from '@forgeax/engine-ecs';
import { emitMobilityDiagnostic, Mobility, MobilityKindValue } from '@forgeax/engine-scene';
import { RIGID_BODY_TYPE_STATIC, RigidBody, rigidBodyTypeFromF32 } from './components.js';

export const MOBILITY_PHYSICS_CONFLICT_SYSTEM = 'mobilityPhysicsConflict' as const;

interface ConflictQueries {
  readonly mobilityChanged: Query;
  readonly bodyChanged: Query;
}

const QUERIES = new WeakMap<World, ConflictQueries>();

function queriesFor(world: World): ConflictQueries {
  let queries = QUERIES.get(world);
  if (queries === undefined) {
    queries = {
      mobilityChanged: world.query({ read: [Mobility, RigidBody], changed: [Mobility] }).unwrap(),
      bodyChanged: world.query({ read: [Mobility, RigidBody], changed: [RigidBody] }).unwrap(),
    };
    QUERIES.set(world, queries);
  }
  return queries;
}

function collectConflicts(query: Query, out: Map<number, number>): void {
  for (const span of query.spans().unwrap()) {
    const kinds = span.get(Mobility).kind;
    const types = span.get(RigidBody).type;
    for (let row = 0; row < span.length; row += 1) {
      const type = types[row] as number;
      if (kinds[row] === MobilityKindValue.static && type !== RIGID_BODY_TYPE_STATIC) {
        out.set(span.entities[row] as number, type);
      }
    }
  }
}

/**
 * Report `mobility-physics-conflict` once per entity whose `Mobility 'static'`
 * contradicts a dynamic or kinematic `RigidBody`. Neither component is derived
 * from the other; simulation keeps following `RigidBody`.
 */
export function detectMobilityPhysicsConflict(world: World): void {
  if (world.components.resolve(Mobility.name) === undefined) return;
  const { mobilityChanged, bodyChanged } = queriesFor(world);
  const conflicts = new Map<number, number>();
  collectConflicts(mobilityChanged, conflicts);
  collectConflicts(bodyChanged, conflicts);
  for (const [entity, type] of conflicts) {
    emitMobilityDiagnostic(world, entity as EntityHandle, {
      code: 'mobility-physics-conflict',
      rigidBodyType: rigidBodyTypeFromF32(type) as 'dynamic' | 'kinematic',
    });
  }
}

/** Install the Mobility/RigidBody consistency check for one World. */
export function registerMobilityPhysicsConflict(world: World): () => void {
  world
    .addSystem(Update, {
      name: MOBILITY_PHYSICS_CONFLICT_SYSTEM,
      queries: [],
      fn: detectMobilityPhysicsConflict,
    })
    .unwrap();
  return () => {
    world.removeSystem(Update, MOBILITY_PHYSICS_CONFLICT_SYSTEM);
    QUERIES.delete(world);
  };
}
