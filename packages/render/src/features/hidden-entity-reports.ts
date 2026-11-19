import type { EntityHandle } from '@forgeax/engine-ecs';
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
  const seen = new Set<EntityHandle>();
  const result: RenderFeatureHiddenEntityReport[] = [];
  for (const report of reports) {
    const entity = report.entity;
    if (seen.has(entity)) continue;
    seen.add(entity);
    result.push(Object.freeze({ entity }));
  }
  Object.freeze(result);
  owned.add(result);
  return result;
}

/** A single extraction owns this Set, so uniqueness is already established. */
export function captureHiddenEntities(
  entities: ReadonlySet<EntityHandle>,
): readonly RenderFeatureHiddenEntityReport[] {
  if (entities.size === 0) return NO_HIDDEN_ENTITY_REPORTS;
  const result: RenderFeatureHiddenEntityReport[] = [];
  for (const entity of entities) result.push(Object.freeze({ entity }));
  Object.freeze(result);
  owned.add(result);
  return result;
}
