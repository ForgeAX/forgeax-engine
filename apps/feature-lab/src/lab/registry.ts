import { AREAS, type AreaId } from './areas';
import { CATALOG_ROWS } from './catalog';
import type { FeatureDefinition, FeatureForm } from './feature';

export interface RegisteredFeature {
  /** `<area>/<slug>`, the `?f=` query value and the manual document path. */
  readonly id: string;
  readonly area: AreaId;
  /** Derived from the feature's catalog row. */
  readonly form: FeatureForm;
  readonly definition: FeatureDefinition;
}

const AREA_IDS = new Set<string>(AREAS.map((area) => area.id));

/**
 * Turns a glob result keyed by `.../features/<area>/<slug>.ts` (browser + Node) or
 * `.../node-features/<area>/<slug>.ts` (Node-only headless probes) into sorted rows.
 */
export function collectFeatures(modules: Record<string, unknown>): RegisteredFeature[] {
  const rows: RegisteredFeature[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const match = /(?:^|\/)(?:node-)?features\/([^/]+)\/([^/]+)\.ts$/.exec(path);
    if (match === null) continue;
    const [, area, slug] = match as unknown as [string, string, string];
    if (!AREA_IDS.has(area)) throw new Error(`[feature-lab] ${path}: unknown area '${area}'`);
    const definition = (mod as { default?: FeatureDefinition }).default;
    if (definition === undefined) throw new Error(`[feature-lab] ${path}: missing default export`);
    const form = CATALOG_ROWS.get(definition.catalog);
    if (form === undefined)
      throw new Error(`[feature-lab] ${path}: no catalog row named '${definition.catalog}'`);
    rows.push({ id: `${area}/${slug}`, area: area as AreaId, form, definition });
  }
  const order = new Map<string, number>(AREAS.map((area, index) => [area.id, index]));
  return rows.sort(
    (a, b) => (order.get(a.area) ?? 0) - (order.get(b.area) ?? 0) || a.id.localeCompare(b.id),
  );
}
