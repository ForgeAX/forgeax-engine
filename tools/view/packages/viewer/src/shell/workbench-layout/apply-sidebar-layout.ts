import { WORKBENCH_EDGES } from './constants.ts';
import { collapseEdgeGroup, findEdgeGroup } from './dock-edges.ts';

/** Edge groups stay collapsed in splitview; drawer open is owned by edge-drawer (overlay). */
export function applySidebarLayout(api: unknown) {
  if (!api) return;
  for (const edge of WORKBENCH_EDGES) {
    const group = findEdgeGroup(api, edge);
    if (!group) continue;
    collapseEdgeGroup(group);
  }
}
