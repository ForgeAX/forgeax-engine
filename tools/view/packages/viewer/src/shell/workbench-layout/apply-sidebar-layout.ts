import { WORKBENCH_EDGES } from './constants.ts';
import { collapseEdgeGroup, findEdgeGroup } from './dock-edges.ts';
import type { WorkbenchEdge } from './types.ts';

/** Edge groups stay collapsed in splitview; drawer open is owned by edge-drawer (overlay). */
export function applySidebarLayout(api: unknown, edges: readonly WorkbenchEdge[] = WORKBENCH_EDGES) {
  if (!api) return;
  for (const edge of edges) {
    const group = findEdgeGroup(api, edge);
    if (!group) continue;
    collapseEdgeGroup(group);
  }
}
