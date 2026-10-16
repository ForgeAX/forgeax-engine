import { DEFAULT_COLLAPSED_SIZE, EDGE_DEFAULT_PX, EDGE_GROUP_ID, WORKBENCH_EDGES } from './constants.ts';
import { isWorkbenchEdge } from './sidebar-state.ts';
import type { WorkbenchEdge } from './types.ts';

export type DockApiLike = {
  groups?: readonly DockGroupLike[] | readonly unknown[];
  panels?: readonly DockPanelLike[] | readonly unknown[];
  addEdgeGroup?: (position: string, options: {
    id: string;
    initialSize?: number;
    collapsed?: boolean;
    collapsedSize?: number;
  }) => unknown;
  setEdgeGroupVisible?: (position: string, visible: boolean) => void;
  removeEdgeGroup?: (position: string) => void;
};

export type DockGroupLike = {
  id?: string;
  panels?: readonly DockPanelLike[];
  activePanel?: DockPanelLike;
  element?: { getBoundingClientRect?: () => DOMRect | { width: number; height: number; left?: number; top?: number; x?: number; y?: number } };
  api?: {
    location?: { type?: string; position?: string };
    isCollapsed?: () => boolean;
    collapse?: () => void;
    expand?: () => void;
    setSize?: (size: { width?: number; height?: number }) => void;
  };
};

export type DockPanelLike = {
  id: string;
  api?: { title?: string; location?: { type?: string; position?: string } };
  group?: DockGroupLike;
};

function asDockApi(api: unknown): DockApiLike | null | undefined {
  return api as DockApiLike | null | undefined;
}

export function findEdgeGroup(api: unknown, position: string): DockGroupLike | undefined {
  const dock = asDockApi(api);
  if (!dock?.groups || !isWorkbenchEdge(position)) return undefined;
  return (dock.groups as readonly DockGroupLike[]).find((group) => {
    const location = group.api?.location;
    return location?.type === 'edge' && location.position === position;
  });
}

export function occupiedWorkbenchEdges(api: unknown): WorkbenchEdge[] {
  return WORKBENCH_EDGES.filter((edge) => (findEdgeGroup(api, edge)?.panels?.length ?? 0) > 0);
}

export function readEdgeExpandedFlags(api: unknown): Partial<Record<WorkbenchEdge, boolean>> {
  const flags: Partial<Record<WorkbenchEdge, boolean>> = {};
  for (const edge of WORKBENCH_EDGES) {
    const group = findEdgeGroup(api, edge);
    if (!group) continue;
    flags[edge] = group.api?.isCollapsed?.() !== true;
  }
  return flags;
}

export function runtimeEdgeOf(panel: DockPanelLike | null | undefined): WorkbenchEdge | null {
  const location = panel?.api?.location ?? panel?.group?.api?.location;
  if (location?.type !== 'edge') return null;
  return isWorkbenchEdge(location.position) ? location.position : null;
}

export function readEdgeSize(group: DockGroupLike | null | undefined, edge: WorkbenchEdge): number | null {
  const rect = group?.element?.getBoundingClientRect?.();
  if (!rect) return null;
  const size = edge === 'bottom' ? rect.height : rect.width;
  return Number.isFinite(size) && size > DEFAULT_COLLAPSED_SIZE ? size : null;
}

export function ensureEdgeGroup(
  api: unknown,
  position: string,
  { initialSize, collapsed = false }: { initialSize?: number; collapsed?: boolean } = {},
): DockGroupLike | undefined {
  const dock = asDockApi(api);
  if (!dock || !isWorkbenchEdge(position)) return undefined;
  const existing = findEdgeGroup(dock, position);
  if (existing) {
    try {
      dock.setEdgeGroupVisible?.(position, true);
    } catch {
      /* visibility is best-effort */
    }
    return existing;
  }
  const size = Number.isFinite(initialSize) && initialSize && initialSize > 0 ? initialSize : EDGE_DEFAULT_PX[position];
  try {
    dock.addEdgeGroup?.(position, {
      id: EDGE_GROUP_ID[position],
      initialSize: size,
      collapsed,
      collapsedSize: DEFAULT_COLLAPSED_SIZE,
    });
  } catch {
    /* already registered */
  }
  try {
    dock.setEdgeGroupVisible?.(position, true);
  } catch {
    /* visibility is best-effort */
  }
  return findEdgeGroup(dock, position);
}

/**
 * Register a collapsed edge slot without showing it (for drag hit-test commit).
 * Does not call setEdgeGroupVisible(true) on existing groups.
 */
export function provisionEdgeGroupIfMissing(
  api: unknown,
  position: string,
): DockGroupLike | undefined {
  const dock = asDockApi(api);
  if (!dock || !isWorkbenchEdge(position)) return undefined;
  const existing = findEdgeGroup(dock, position);
  if (existing) return existing;
  const size = EDGE_DEFAULT_PX[position];
  try {
    dock.addEdgeGroup?.(position, {
      id: EDGE_GROUP_ID[position],
      initialSize: size,
      collapsed: true,
      collapsedSize: DEFAULT_COLLAPSED_SIZE,
    });
  } catch {
    /* already registered */
  }
  try {
    dock.setEdgeGroupVisible?.(position, false);
  } catch {
    /* noop */
  }
  const group = findEdgeGroup(dock, position);
  const el = group?.element as HTMLElement | undefined;
  el?.classList?.add('fx-edge-empty');
  return group;
}

/**
 * Hide unused empty edge slots. Never dispose a group that still has panels.
 */
export function hideEmptyEdgeGroups(api: unknown, needed: readonly string[] | null | undefined) {
  const dock = asDockApi(api);
  const required = new Set((needed ?? []).filter(isWorkbenchEdge));
  for (const position of WORKBENCH_EDGES) {
    const group = findEdgeGroup(dock, position);
    if (!group) continue;
    if ((group.panels?.length ?? 0) > 0) continue;
    try {
      dock?.setEdgeGroupVisible?.(position, false);
    } catch {
      /* visibility is best-effort */
    }
    if (required.has(position)) continue;
    try {
      dock?.removeEdgeGroup?.(position);
    } catch {
      /* group already gone or hidden */
    }
  }
}

/** Sync native edge chrome visibility after programmatic panel moves (no drawer open). */
export function syncEdgeEmptyChrome(api: unknown) {
  const dock = asDockApi(api);
  if (!dock) return;
  for (const pos of WORKBENCH_EDGES) {
    const group = findEdgeGroup(dock, pos);
    const panels = group?.panels?.length ?? 0;
    const hasItems = panels > 0;
    const el = group?.element as HTMLElement | undefined;
    el?.classList?.toggle('fx-edge-empty', !hasItems);
    try {
      dock.setEdgeGroupVisible?.(pos, hasItems);
    } catch {
      /* noop */
    }
  }
}

export function collapseEdgeGroup(group: DockGroupLike | null | undefined) {
  if (!group?.api || group.api.isCollapsed?.() === true) return;
  try {
    group.api.collapse?.();
  } catch {
    /* non-edge groups no-op */
  }
}

export function expandEdgeGroup(group: DockGroupLike | null | undefined) {
  if (!group?.api || group.api.isCollapsed?.() === false) return;
  try {
    group.api.expand?.();
  } catch {
    /* non-edge groups no-op */
  }
}

export function restoreEdgeSize(group: DockGroupLike | null | undefined, edge: WorkbenchEdge, size: number | null | undefined) {
  if (!group?.api?.setSize || !Number.isFinite(size) || !size || size <= 0) return;
  try {
    group.api.setSize(edge === 'bottom' ? { height: size } : { width: size });
  } catch {
    /* size restore is best-effort after expand */
  }
}
