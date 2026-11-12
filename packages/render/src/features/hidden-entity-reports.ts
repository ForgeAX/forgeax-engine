import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderFeatureHiddenEntityReport } from './types';

/** Producer-owned, unique immutable facts; borrowed arrays never acquire this proof. */
const owned = new WeakSet<readonly RenderFeatureHiddenEntityReport[]>();
export const NO_HIDDEN_ENTITY_REPORTS: readonly RenderFeatureHiddenEntityReport[] = Object.freeze(
  [],
);
owned.add(NO_HIDDEN_ENTITY_REPORTS);

export function isOwnedHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
): boolean {
  return owned.has(reports);
}

/** Capture once when an extraction producer publishes changed visibility facts. */
export function captureHiddenEntityReports(
  reports: readonly RenderFeatureHiddenEntityReport[],
): readonly RenderFeatureHiddenEntityReport[] {
  if (reports.length === 0) return NO_HIDDEN_ENTITY_REPORTS;
  if (owned.has(reports)) return reports;
  const seen = new WeakMap<World, Set<EntityHandle>>();
  const result: RenderFeatureHiddenEntityReport[] = [];
  for (const report of reports) {
    const world = report.world;
    const entity = report.entity;
    let entities = seen.get(world);
    if (entities === undefined) {
      entities = new Set();
      seen.set(world, entities);
    }
    if (entities.has(entity)) continue;
    entities.add(entity);
    result.push(Object.freeze({ world, entity }));
  }
  Object.freeze(result);
  owned.add(result);
  return result;
}

/** A single extraction owns this Set, so uniqueness is already established. */
export function captureHiddenEntities(
  world: World,
  entities: ReadonlySet<EntityHandle>,
): readonly RenderFeatureHiddenEntityReport[] {
  if (entities.size === 0) return NO_HIDDEN_ENTITY_REPORTS;
  const result: RenderFeatureHiddenEntityReport[] = [];
  for (const entity of entities) result.push(Object.freeze({ world, entity }));
  Object.freeze(result);
  owned.add(result);
  return result;
}
