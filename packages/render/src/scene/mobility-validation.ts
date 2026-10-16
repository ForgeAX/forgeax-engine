import type { EntityHandle, Query, World } from '@forgeax/engine-ecs';
import { emitMobilityDiagnostic, Mobility, MobilityKindValue } from '@forgeax/engine-scene';
import { MeshFilter } from '../components/mesh-filter';

interface MeshMobilityQueries {
  readonly kindChanged: Query;
  readonly meshAdded: Query;
}

const QUERIES = new WeakMap<World, MeshMobilityQueries>();

function queriesFor(world: World): MeshMobilityQueries {
  let queries = QUERIES.get(world);
  if (queries === undefined) {
    queries = {
      kindChanged: world
        .query({ read: [Mobility], with: [MeshFilter], changed: [Mobility] })
        .unwrap(),
      meshAdded: world.query({ read: [Mobility], added: [MeshFilter] }).unwrap(),
    };
    QUERIES.set(world, queries);
  }
  return queries;
}

function collectStationary(query: Query, out: Set<number>): void {
  for (const span of query.spans().unwrap()) {
    const kinds = span.get(Mobility).kind;
    for (let row = 0; row < span.length; row += 1) {
      if (kinds[row] === MobilityKindValue.stationary) out.add(span.entities[row] as number);
    }
  }
}

/**
 * Render owns the mesh vocabulary, so it rejects `Mobility 'stationary'` on
 * mesh entities (legal only on lights). Only new declarations or new meshes
 * are inspected; each entity is reported once.
 */
export function detectMobilityInvalidKind(world: World): void {
  if (world.components.resolve(Mobility.name) === undefined) return;
  const { kindChanged, meshAdded } = queriesFor(world);
  const stationary = new Set<number>();
  collectStationary(kindChanged, stationary);
  collectStationary(meshAdded, stationary);
  for (const entity of stationary) {
    emitMobilityDiagnostic(world, entity as EntityHandle, { code: 'mobility-invalid-kind' });
  }
}
