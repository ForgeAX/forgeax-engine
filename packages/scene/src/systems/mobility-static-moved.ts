import { type EntityHandle, type Query, Update, type World } from '@forgeax/engine-ecs';
import { Mobility, MobilityKindValue } from '../components/mobility';
import { Transform } from '../components/transform';
import { emitMobilityDiagnostic } from '../mobility-diagnostics';

export const MOBILITY_STATIC_MOVED_SYSTEM = 'mobilityStaticMoved' as const;

interface StaticMovedQueries {
  readonly declared: Query;
  readonly moved: Query;
}

const QUERIES = new WeakMap<World, StaticMovedQueries>();

function queriesFor(world: World): StaticMovedQueries {
  let queries = QUERIES.get(world);
  if (queries === undefined) {
    queries = {
      declared: world.query({ with: [Transform], added: [Mobility] }).unwrap(),
      moved: world.query({ read: [Mobility], with: [Transform], changed: [Transform] }).unwrap(),
    };
    QUERIES.set(world, queries);
  }
  return queries;
}

/**
 * Report `mobility-static-moved` for static entities whose Transform changed
 * after the frame that declared them static. Initial placement (Transform
 * written in the same frame Mobility is added) is not a violation.
 */
export function detectMobilityStaticMoved(world: World): void {
  const { declared, moved } = queriesFor(world);
  const placed = new Set<number>();
  for (const span of declared.spans().unwrap()) {
    for (let row = 0; row < span.length; row += 1) placed.add(span.entities[row] as number);
  }
  const violations: EntityHandle[] = [];
  for (const span of moved.spans().unwrap()) {
    const kinds = span.get(Mobility).kind;
    for (let row = 0; row < span.length; row += 1) {
      if (kinds[row] !== MobilityKindValue.static) continue;
      const entity = span.entities[row] as number;
      if (!placed.has(entity)) violations.push(entity as EntityHandle);
    }
  }
  for (const entity of violations) {
    emitMobilityDiagnostic(world, entity, { code: 'mobility-static-moved' });
  }
}

export function registerMobilityStaticMoved(world: World): () => void {
  world
    .addSystem(Update, {
      name: MOBILITY_STATIC_MOVED_SYSTEM,
      queries: [],
      fn: detectMobilityStaticMoved,
    })
    .unwrap();
  return () => {
    world.removeSystem(Update, MOBILITY_STATIC_MOVED_SYSTEM);
    QUERIES.delete(world);
  };
}
