/**
 * Scene-tree type filters mirror forgeax-editor hierarchy filter options:
 * option ids are component schema names from the Engine host, not UI enums.
 */

const CATEGORY_RULES = [
  { test: /Camera/, category: 'camera' },
  { test: /Light/, category: 'light' },
  { test: /Character|Controller/, category: 'character' },
  { test: /PlayerStart/, category: 'start' },
  { test: /Spawner/, category: 'spawner' },
  { test: /Mesh/, category: 'mesh' },
];

function categoryRank(category: string) {
  const index = CATEGORY_RULES.findIndex((rule) => rule.category === category);
  return index === -1 ? CATEGORY_RULES.length : index;
}

/** @param {string} id */
export function hierarchyTypeCategory(id: string) {
  if (id === 'group') return 'group';
  if (id === 'entity') return 'entity';
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(id)) return rule.category;
  }
  return 'generic';
}

/** @param {string} a @param {string} b */
export function compareComponentFilterIds(a: string, b: string) {
  const ra = categoryRank(hierarchyTypeCategory(a));
  const rb = categoryRank(hierarchyTypeCategory(b));
  return ra - rb || a.localeCompare(b);
}

/**
 * @param {readonly string[]} componentNames
 * @param {ReadonlySet<string>} activeFilters
 */
export function entityMatchesSceneTreeFilters(componentNames: readonly string[], activeFilters: ReadonlySet<string>) {
  if (activeFilters.size === 0) return true;
  return componentNames.some((name) => activeFilters.has(name));
}

/**
 * Build filter options from a component schema name list and optional counts.
 * View derives these options from the loaded entity component identities.
 *
 * @param {readonly string[]} schemaNames
 * @param {ReadonlyMap<string, number>} [counts]
 */
export function buildSceneTreeFilterOptions(schemaNames: readonly string[], counts: ReadonlyMap<string, number> = new Map()) {
  const seen = new Set();
  const options = [];
  for (const name of schemaNames) {
    const id = String(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const count = counts.get(id);
    options.push({
      id,
      ...(count === undefined ? {} : { count }),
    });
  }
  options.sort((left, right) => compareComponentFilterIds(left.id, right.id));
  return options;
}
