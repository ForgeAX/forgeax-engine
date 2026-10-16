import { classifySceneEntity, type SceneEntityKind } from '@forgeax/view-workspace-core/scene-entity-classification';
export type SceneEntityTypeKey = SceneEntityKind | 'folder' | 'playerStart';
export type HierarchyRow = { id: string; name: string; typeKey?: SceneEntityTypeKey; componentNames?: string[]; depth: number; kind: 'folder' | 'entity'; virtual?: boolean; hidden?: boolean; hasChildren?: boolean; expanded?: boolean };
type EntityNode = { entityId?: string; entity?: number; name?: string; parentId?: string; componentNames?: string[] };
import { buildSceneTreeFilterOptions } from './hierarchy-filters.ts';

/**
 * Normalize Engine `scene.tree.get` payloads into panel rows.
 * View does not author hierarchy; it only projects the latest Engine response.
 */

/**
 * @param {unknown} result
 * @returns {Array<Record<string, unknown>>}
 */
function projectEntityRows(result: unknown): HierarchyRow[] {
  if (!result || typeof result !== 'object') return [];
  const nodes = 'nodes' in result ? result.nodes : undefined;
  if (!Array.isArray(nodes)) return [];
  const rows: HierarchyRow[] = [];
  const seen = new Set();
  const flat = nodes.filter((node): node is EntityNode => node != null && typeof node === 'object');
  const byId = new Map(flat.map(node => [String(node.entityId), node]));
  const children = new Map<string, EntityNode[]>();
  for (const node of flat) {
    if (node.parentId && byId.has(node.parentId)) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }
  const visit = (root: EntityNode) => {
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      const id = String(node.entityId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const descendants = children.get(id) ?? [];
      const componentNames = Array.isArray(node.componentNames) ? node.componentNames.filter(name => typeof name === 'string') : [];
      const typeKey = classifySceneEntity(componentNames).kind;
      rows.push({ id, componentNames, name: String(node.name?.trim() ? node.name : (node.entity === undefined ? id : `Entity ${node.entity}`)), typeKey,
        depth,
        kind: 'entity',
        ...(descendants.length ? { hasChildren: true, expanded: depth < 1 } : {}) });
      for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i], depth: depth + 1 });
    }
  };
  for (const node of flat) if (!node.parentId || !byId.has(node.parentId)) visit(node);
  // Preserve discoverability for cyclic or partial parent projections.
  for (const node of flat) visit(node);
  return rows;
}

/** Counts describe the loaded rows; Engine owns only component identities. */
export function sceneTreeComponentFilters(rows: readonly HierarchyRow[]) {
  const counts = new Map();
  for (const row of rows) for (const name of row.componentNames ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  return buildSceneTreeFilterOptions([...counts.keys()], counts);
}

/** This grouping row belongs only to View and is never sent as an entity reference. */
export const HIERARCHY_SCENE_FOLDER_ID = 'hierarchy:scene-root';
export function isSceneRootRow(row: HierarchyRow) { return row?.id === HIERARCHY_SCENE_FOLDER_ID; }
export function wrapWithVirtualSceneRoot(rows: HierarchyRow[]): HierarchyRow[] {
  if (rows.some(isSceneRootRow)) return rows.map(row => isSceneRootRow(row) ? { ...row, virtual: true } : row);
  return [{ id: HIERARCHY_SCENE_FOLDER_ID, name: 'Scene', typeKey: 'folder', depth: 0,
    kind: 'folder', virtual: true, hasChildren: rows.length > 0, expanded: true },
    ...rows.map(row => ({ ...row, depth: row.depth + 1 }))];
}
export function normalizeSceneTreeRows(result: unknown) { return wrapWithVirtualSceneRoot(projectEntityRows(result)); }
export function normalizeSceneTreeResponse(result: unknown) {
  const rows = normalizeSceneTreeRows(result);
  return { rows, filterOptions: sceneTreeComponentFilters(rows) };
}
