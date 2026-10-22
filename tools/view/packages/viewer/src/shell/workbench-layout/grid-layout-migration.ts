import type { DockviewApi } from 'dockview';

import {
  collapseEdgeGroup,
  ensureEdgeGroup,
  findEdgeGroup,
  syncEdgeEmptyChrome,
} from './dock-edges.ts';
import { isWorkbenchEdge } from './sidebar-state.ts';
import type { WorkbenchEdge } from './types.ts';

const PERIMETER_PX = 12;
const LEFT_FRAC = 0.22;
const RIGHT_FRAC = 0.22;
const BOTTOM_FRAC = 0.28;

/**
 * Drop auto-tuck records when the user moves a panel back to grid or to a different edge than `tuckedToEdge`.
 * Does not detect pre-tuck manual grid splits/resizes: if the user rearranged the grid before tuck ran,
 * we still tuck from the current group membership without restoring their prior layout.
 */
export function pruneUserRelocatedAutoTucked(api: DockviewApi, autoTucked: AutoTuckedMap): AutoTuckedMap {
  const next = { ...autoTucked };
  for (const id of Object.keys(next)) {
    const entry = next[id];
    if (!entry) continue;
    const panel = api.getPanel(id);
    if (!panel) {
      delete next[id];
      continue;
    }
    const loc = panel.api.location;
    if (loc.type === 'grid') {
      delete next[id];
      continue;
    }
    if (loc.type === 'edge' && entry.tuckedToEdge && loc.position !== entry.tuckedToEdge) {
      delete next[id];
    }
  }
  return next;
}

export type PanelRestoreEntry = {
  panelId: string;
  groupId: string;
  index: number;
  locationType: 'grid' | 'edge';
  edgePosition?: string;
  tuckedToEdge?: WorkbenchEdge;
};

export type GridGroupSnapshot = {
  id: string;
  panelIds: string[];
  activePanelId?: string;
  width?: number;
  height?: number;
  /** width / gridHostWidth at capture — used for proportional wide restore. */
  normWidth?: number;
  /** height / gridHostHeight at capture. */
  normHeight?: number;
  anchorGroupId?: string;
  splitDirection?: 'left' | 'right' | 'above' | 'below';
  /** BFS attach order from inferSplitRelations — replay splits in this sequence. */
  restoreOrder?: number;
};

export type PresentationSnapshot = {
  panels: PanelRestoreEntry[];
  gridGroups: GridGroupSnapshot[];
  activePanelId?: string;
  /** Grid layout surface (`.dv-dockview`) extent at capture — for ratio restore. */
  gridHostWidth?: number;
  gridHostHeight?: number;
};

export type RestorePresentationOptions = {
  /** Panels to leave at current location (e.g. user-placed edge tabs). */
  skipPanelIds?: ReadonlySet<string>;
  /** Measured dock host — layout + proportional sizes after topology restore. */
  layoutHost?: HTMLElement;
};

export type AutoTuckedMap = Record<string, PanelRestoreEntry>;

type GridGroup = DockviewApi['groups'][number];
type SplitDirection = NonNullable<GridGroupSnapshot['splitDirection']>;

function rectOf(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return r;
}

/** Skip auto-tuck until the grid has real split geometry (avoids pre-layout false peripherals). */
export function isDockGridSettled(api: DockviewApi, host: HTMLElement): boolean {
  const hostRect = rectOf(host);
  if (!hostRect) return false;
  const gridGroups = api.groups.filter((g) => g.api.location.type === 'grid');
  if (gridGroups.length === 0) return false;

  let maxArea = 0;
  let totalArea = 0;
  for (const group of gridGroups) {
    const gr = rectOf(group.element);
    if (!gr) return false;
    const area = gr.width * gr.height;
    maxArea = Math.max(maxArea, area);
    totalArea += area;
  }

  const hostArea = hostRect.width * hostRect.height;
  if (hostArea <= 0) return false;
  if (maxArea < hostArea * 0.12) return false;
  if (gridGroups.length > 1 && totalArea < hostArea * 0.32) return false;
  return true;
}

type EdgeScore = { side: WorkbenchEdge; distance: number };

function scoreGroupForSide(gr: DOMRect, hostRect: DOMRect, side: WorkbenchEdge): number | null {
  switch (side) {
    case 'left': {
      const touch = gr.left - hostRect.left <= PERIMETER_PX;
      const band = gr.left + gr.width / 2 <= hostRect.left + hostRect.width * LEFT_FRAC;
      if (!touch && !band) return null;
      return (Math.max(0, gr.left - hostRect.left) + gr.width) / hostRect.width;
    }
    case 'right': {
      const touch = hostRect.right - gr.right <= PERIMETER_PX;
      const band = gr.left + gr.width / 2 >= hostRect.right - hostRect.width * RIGHT_FRAC;
      if (!touch && !band) return null;
      return (Math.max(0, hostRect.right - gr.right) + gr.width) / hostRect.width;
    }
    case 'bottom': {
      const touch = hostRect.bottom - gr.bottom <= PERIMETER_PX;
      const band = gr.top + gr.height / 2 >= hostRect.bottom - hostRect.height * BOTTOM_FRAC;
      if (!touch && !band) return null;
      return (Math.max(0, hostRect.bottom - gr.bottom) + gr.height) / hostRect.height;
    }
    default:
      return null;
  }
}

function classifyPeripheralGroups(
  api: DockviewApi,
  host: HTMLElement,
  sides: readonly WorkbenchEdge[],
  primaryPanelIds: ReadonlySet<string>,
): Partial<Record<WorkbenchEdge, GridGroup[]>> {
  const hostRect = rectOf(host);
  const result: Partial<Record<WorkbenchEdge, GridGroup[]>> = {};
  for (const side of sides) result[side] = [];
  if (!hostRect) return result;

  const gridGroups = api.groups.filter((g) => g.api.location.type === 'grid');
  const sidePriority: WorkbenchEdge[] = ['left', 'right', 'bottom'];

  for (const group of gridGroups) {
    if (group.panels.some((panel) => primaryPanelIds.has(panel.id))) continue;
    const gr = rectOf(group.element);
    if (!gr) continue;
    const scores: EdgeScore[] = [];
    for (const side of sides) {
      const distance = scoreGroupForSide(gr, hostRect, side);
      if (distance !== null) scores.push({ side, distance });
    }
    if (scores.length === 0) continue;
    scores.sort((a, b) => a.distance - b.distance
      || sidePriority.indexOf(a.side) - sidePriority.indexOf(b.side));
    result[scores[0]!.side]!.push(group);
  }

  const byLeft = (a: GridGroup, b: GridGroup) =>
    (rectOf(a.element)?.left ?? 0) - (rectOf(b.element)?.left ?? 0);
  const byTop = (a: GridGroup, b: GridGroup) =>
    (rectOf(a.element)?.top ?? 0) - (rectOf(b.element)?.top ?? 0);

  if (result.left) result.left.sort(byLeft);
  if (result.right) result.right.sort(byLeft);
  if (result.bottom) result.bottom.sort(byTop);
  return result;
}

function readGroupSize(group: GridGroup) {
  const r = rectOf(group.element);
  return r ? { width: r.width, height: r.height } : undefined;
}

/** Core grid split area — excludes outer host chrome and edge strip columns. */
function findGridLayoutSurface(layoutHost: HTMLElement | null | undefined): HTMLElement | null {
  if (!layoutHost) return null;
  const scoped = layoutHost.querySelector<HTMLElement>('.fx-view-dockview .dv-dockview');
  if (scoped) return scoped;
  const nested = layoutHost.querySelector<HTMLElement>('.dv-dockview');
  return nested;
}

function measureGridSurfaceEnvelope(api: DockviewApi): { width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const group of api.groups.filter((g) => g.api.location.type === 'grid')) {
    const r = rectOf(group.element);
    if (!r) continue;
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }
  if (!Number.isFinite(minX)) return null;
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function measureGridSurfaceExtent(
  api: DockviewApi,
  layoutHost?: HTMLElement | null,
): { width: number; height: number } | null {
  const surfaceEl = layoutHost ? findGridLayoutSurface(layoutHost) : null;
  const surfaceRect = surfaceEl ? rectOf(surfaceEl) : null;
  if (surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0) {
    return { width: surfaceRect.width, height: surfaceRect.height };
  }
  return measureGridSurfaceEnvelope(api);
}

function annotateGroupSizeRatios(
  gridGroups: GridGroupSnapshot[],
  hostExtent: { width: number; height: number } | null,
) {
  if (!hostExtent) return;
  for (const group of gridGroups) {
    if (group.width && hostExtent.width > 0) {
      group.normWidth = group.width / hostExtent.width;
    }
    if (group.height && hostExtent.height > 0) {
      group.normHeight = group.height / hostExtent.height;
    }
  }
}

function adjacentAttach(
  attach: DOMRect,
  anchor: DOMRect,
): { direction: SplitDirection; gap: number } | null {
  const vOverlap = Math.min(attach.bottom, anchor.bottom) - Math.max(attach.top, anchor.top);
  const hOverlap = Math.min(attach.right, anchor.right) - Math.max(attach.left, anchor.left);
  if (attach.left >= anchor.right - 2 && vOverlap > attach.height * 0.35) {
    return { direction: 'right', gap: attach.left - anchor.right };
  }
  if (attach.right <= anchor.left + 2 && vOverlap > attach.height * 0.35) {
    return { direction: 'left', gap: anchor.left - attach.right };
  }
  if (attach.top >= anchor.bottom - 2 && hOverlap > attach.width * 0.35) {
    return { direction: 'below', gap: attach.top - anchor.bottom };
  }
  if (attach.bottom <= anchor.top + 2 && hOverlap > attach.width * 0.35) {
    return { direction: 'above', gap: anchor.top - attach.bottom };
  }
  return null;
}

function pickStableRoot(groups: GridGroup[]): GridGroup {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const group of groups) {
    const r = rectOf(group.element);
    if (!r) continue;
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let best = groups[0]!;
  let bestScore = -Infinity;
  for (const group of groups) {
    const r = rectOf(group.element);
    if (!r) continue;
    const area = r.width * r.height;
    const gx = r.left + r.width / 2;
    const gy = r.top + r.height / 2;
    const score = area - Math.hypot(gx - cx, gy - cy);
    if (score > bestScore || (score === bestScore && group.id.localeCompare(best.id) < 0)) {
      bestScore = score;
      best = group;
    }
  }
  return best;
}

/** Acyclic forest: anchor only onto already-connected (root-outward) groups. */
export function inferSplitRelations(api: DockviewApi): GridGroupSnapshot[] {
  const gridGroups = api.groups.filter((g) => g.api.location.type === 'grid');
  const snapshots: GridGroupSnapshot[] = gridGroups.map((group) => ({
    id: group.id,
    panelIds: group.panels.map((p) => p.id),
    ...(group.activePanel ? { activePanelId: group.activePanel.id } : {}),
    ...readGroupSize(group),
  }));
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const unassigned = new Set(gridGroups.map((g) => g.id));
  let restoreOrder = 0;

  while (unassigned.size > 0) {
    const remaining = gridGroups.filter((g) => unassigned.has(g.id));
    const root = pickStableRoot(remaining);
    unassigned.delete(root.id);
    const rootSnap = byId.get(root.id);
    if (rootSnap) rootSnap.restoreOrder = restoreOrder;
    const connected = new Set<string>([root.id]);

    for (;;) {
      let best: {
        groupId: string;
        anchorId: string;
        direction: SplitDirection;
        gap: number;
      } | null = null;

      for (const group of gridGroups) {
        if (!unassigned.has(group.id)) continue;
        const gr = rectOf(group.element);
        if (!gr) continue;
        for (const anchor of gridGroups) {
          if (!connected.has(anchor.id)) continue;
          const ar = rectOf(anchor.element);
          if (!ar) continue;
          const adj = adjacentAttach(gr, ar);
          if (adj && (!best || adj.gap < best.gap)) {
            best = {
              groupId: group.id,
              anchorId: anchor.id,
              direction: adj.direction,
              gap: adj.gap,
            };
          }
        }
      }

      if (!best) break;

      const snap = byId.get(best.groupId);
      if (snap) {
        snap.anchorGroupId = best.anchorId;
        snap.splitDirection = best.direction;
        restoreOrder += 1;
        snap.restoreOrder = restoreOrder;
      }
      unassigned.delete(best.groupId);
      connected.add(best.groupId);
    }
  }

  return snapshots;
}

export function capturePresentation(api: DockviewApi, layoutHost?: HTMLElement | null): PresentationSnapshot {
  const panels: PanelRestoreEntry[] = [];
  for (const panel of api.panels) {
    const location = panel.api.location;
    panels.push({
      panelId: panel.id,
      groupId: panel.group.id,
      index: Math.max(0, panel.group.panels.indexOf(panel)),
      locationType: location.type === 'edge' ? 'edge' : 'grid',
      ...(location.type === 'edge' && location.position ? { edgePosition: location.position } : {}),
    });
  }
  const hostExtent = measureGridSurfaceExtent(api, layoutHost);
  const gridGroups = inferSplitRelations(api);
  annotateGroupSizeRatios(gridGroups, hostExtent);
  return {
    panels,
    gridGroups,
    activePanelId: api.activePanel?.id,
    ...(hostExtent
      ? { gridHostWidth: hostExtent.width, gridHostHeight: hostExtent.height }
      : {}),
  };
}

function splitAxis(direction: SplitDirection): 'horizontal' | 'vertical' {
  return direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
}

/** Dockview `moveTo` position (not our geometric above/below labels). */
function splitDirectionToMovePosition(
  direction: SplitDirection,
): 'left' | 'right' | 'top' | 'bottom' {
  switch (direction) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'above':
      return 'top';
    case 'below':
      return 'bottom';
    default:
      return 'bottom';
  }
}

/** Dockview split replay: left/right before above/below when sharing the same anchor. */
function splitDirectionPriority(direction: SplitDirection): number {
  switch (direction) {
    case 'left':
      return 0;
    case 'right':
      return 1;
    case 'above':
      return 2;
    case 'below':
      return 3;
    default:
      return 9;
  }
}

class GridRestoreSession {
  private readonly api: DockviewApi;
  private readonly snapshot: PresentationSnapshot;
  private readonly layoutHost?: HTMLElement;
  private readonly groupMap = new Map<string, GridGroup>();
  private readonly metaById = new Map<string, GridGroupSnapshot>();
  private readonly pending = new Set<string>();
  private readonly creating = new Set<string>();

  constructor(api: DockviewApi, snapshot: PresentationSnapshot, layoutHost?: HTMLElement) {
    this.api = api;
    this.snapshot = snapshot;
    this.layoutHost = layoutHost;
    for (const group of api.groups.filter((g) => g.api.location.type === 'grid')) {
      this.groupMap.set(group.id, group);
    }
    for (const meta of snapshot.gridGroups) {
      this.metaById.set(meta.id, meta);
      if (!this.groupMap.has(meta.id)) this.pending.add(meta.id);
    }
  }

  resolveRuntimeGroup(originalGroupId: string): GridGroup | undefined {
    return this.groupMap.get(originalGroupId)
      ?? this.api.groups.find((g) => g.id === originalGroupId && g.api.location.type === 'grid');
  }

  isPanelRestored(entry: PanelRestoreEntry): boolean {
    const panel = this.api.getPanel(entry.panelId);
    const runtime = this.resolveRuntimeGroup(entry.groupId);
    if (!panel || !runtime || entry.locationType !== 'grid') return false;
    if (panel.group.id !== runtime.id) return false;
    const actualIndex = panel.group.panels.indexOf(panel);
    return actualIndex === Math.min(entry.index, panel.group.panels.length - 1);
  }

  private resolveAnchorRuntime(anchorId: string | undefined): GridGroup | undefined {
    if (!anchorId) return undefined;
    return this.resolveRuntimeGroup(anchorId);
  }

  private applyGroupSize(
    group: GridGroup,
    meta: GridGroupSnapshot,
    direction: SplitDirection,
    hostWidth: number,
    hostHeight: number,
  ) {
    try {
      const axis = splitAxis(direction);
      const snapW = this.snapshot.gridHostWidth;
      const snapH = this.snapshot.gridHostHeight;
      if (axis === 'horizontal') {
        const target = meta.normWidth != null && snapW
          ? meta.normWidth * hostWidth
          : meta.width != null && snapW
            ? (meta.width / snapW) * hostWidth
            : meta.width;
        if (target != null && Number.isFinite(target) && target > 0) {
          group.api.setSize?.({ width: target });
        }
      } else {
        const target = meta.normHeight != null && snapH
          ? meta.normHeight * hostHeight
          : meta.height != null && snapH
            ? (meta.height / snapH) * hostHeight
            : meta.height;
        if (target != null && Number.isFinite(target) && target > 0) {
          group.api.setSize?.({ height: target });
        }
      }
    } catch {
      /* noop */
    }
  }

  private sizeRestoreOrder(): GridGroupSnapshot[] {
    const ids = [...this.metaById.keys()].sort((a, b) => {
      const ma = this.metaById.get(a);
      const mb = this.metaById.get(b);
      if (ma?.anchorGroupId && ma.anchorGroupId === mb?.anchorGroupId) {
        const da = ma.splitDirection ? splitDirectionPriority(ma.splitDirection) : 9;
        const db = mb.splitDirection ? splitDirectionPriority(mb.splitDirection) : 9;
        if (da !== db) return da - db;
      }
      const oa = ma?.restoreOrder ?? Number.MAX_SAFE_INTEGER;
      const ob = mb?.restoreOrder ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
    return ids.map((id) => this.metaById.get(id)!).filter(Boolean);
  }

  applyProportionalSizes(gridSurface: { width: number; height: number }) {
    if (gridSurface.width <= 0 || gridSurface.height <= 0) return;
    for (const meta of this.sizeRestoreOrder()) {
      if (!meta.splitDirection) continue;
      const runtime = this.resolveRuntimeGroup(meta.id);
      if (!runtime) continue;
      this.applyGroupSize(
        runtime,
        meta,
        meta.splitDirection,
        gridSurface.width,
        gridSurface.height,
      );
    }
  }

  restoreActiveTabs(skip: ReadonlySet<string>) {
    for (const meta of this.snapshot.gridGroups) {
      if (!meta.activePanelId || skip.has(meta.activePanelId)) continue;
      const group = this.resolveRuntimeGroup(meta.id);
      const panel = this.api.getPanel(meta.activePanelId);
      if (group && panel?.group.id === group.id) panel.api.setActive();
    }
  }

  ensureOriginalGroup(originalGroupId: string, seedPanel: DockviewApi['panels'][number]): GridGroup | undefined {
    const existing = this.resolveRuntimeGroup(originalGroupId);
    if (existing) {
      this.groupMap.set(originalGroupId, existing);
      this.pending.delete(originalGroupId);
      return existing;
    }

    if (this.creating.has(originalGroupId)) return undefined;

    const meta = this.metaById.get(originalGroupId);
    if (!meta?.anchorGroupId || !meta.splitDirection) return undefined;

    const anchor = this.resolveAnchorRuntime(meta.anchorGroupId);
    if (!anchor) return undefined;

    this.creating.add(originalGroupId);
    try {
      seedPanel.api.moveTo({
        group: anchor,
        position: splitDirectionToMovePosition(meta.splitDirection),
      });
    } catch {
      this.creating.delete(originalGroupId);
      return undefined;
    }

    const runtime = seedPanel.group.api.location.type === 'grid' ? seedPanel.group : undefined;
    this.creating.delete(originalGroupId);
    if (!runtime) return undefined;

    this.groupMap.set(originalGroupId, runtime);
    this.pending.delete(originalGroupId);
    return runtime;
  }

  private pendingCreationOrder(): string[] {
    return [...this.pending].sort((a, b) => {
      const ma = this.metaById.get(a);
      const mb = this.metaById.get(b);
      if (ma?.anchorGroupId && ma.anchorGroupId === mb?.anchorGroupId) {
        const da = ma.splitDirection ? splitDirectionPriority(ma.splitDirection) : 9;
        const db = mb.splitDirection ? splitDirectionPriority(mb.splitDirection) : 9;
        if (da !== db) return da - db;
      }
      const oa = ma?.restoreOrder ?? Number.MAX_SAFE_INTEGER;
      const ob = mb?.restoreOrder ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
  }

  runTransaction(entries: PanelRestoreEntry[], options?: RestorePresentationOptions) {
    const skip = options?.skipPanelIds ?? new Set<string>();
    const byGroup = new Map<string, PanelRestoreEntry[]>();
    for (const entry of entries) {
      if (entry.locationType !== 'grid') continue;
      const list = byGroup.get(entry.groupId) ?? [];
      list.push(entry);
      byGroup.set(entry.groupId, list);
    }
    for (const list of byGroup.values()) list.sort((a, b) => a.index - b.index);

    let progress = true;
    while (this.pending.size > 0 && progress) {
      progress = false;
      for (const groupId of this.pendingCreationOrder()) {
        if (!this.pending.has(groupId)) continue;
        const meta = this.metaById.get(groupId);
        if (!meta) {
          this.pending.delete(groupId);
          continue;
        }
        if (this.groupMap.has(groupId)) {
          this.pending.delete(groupId);
          progress = true;
          continue;
        }
        if (meta.anchorGroupId && !this.resolveAnchorRuntime(meta.anchorGroupId)) continue;

        const groupEntries = byGroup.get(groupId) ?? [];
        const seedEntry = groupEntries.find(
          (e) => this.api.getPanel(e.panelId) && !skip.has(e.panelId),
        );
        if (!seedEntry) {
          this.pending.delete(groupId);
          progress = true;
          continue;
        }
        const seedPanel = this.api.getPanel(seedEntry.panelId)!;
        const runtime = this.ensureOriginalGroup(groupId, seedPanel);
        if (!runtime) continue;

        for (const entry of groupEntries) {
          if (skip.has(entry.panelId)) continue;
          const panel = this.api.getPanel(entry.panelId);
          if (!panel || panel.group.id === runtime.id) continue;
          try {
            panel.api.moveTo({ group: runtime, position: 'center', index: entry.index });
          } catch {
            /* keep location */
          }
        }
        progress = true;
      }
    }

    for (const entry of entries) {
      if (entry.locationType === 'edge') continue;
      if (skip.has(entry.panelId)) continue;
      const panel = this.api.getPanel(entry.panelId);
      if (!panel) continue;
      const runtime = this.groupMap.get(entry.groupId)
        ?? this.api.groups.find((g) => g.id === entry.groupId && g.api.location.type === 'grid');
      if (!runtime) continue;
      if (panel.group.id === runtime.id && panel.group.panels.indexOf(panel) === entry.index) continue;
      try {
        panel.api.moveTo({ group: runtime, position: 'center', index: entry.index });
      } catch {
        /* keep location */
      }
    }
  }
}

function finalizeEdgeDock(api: DockviewApi, group: GridGroup, position: WorkbenchEdge) {
  const el = group.element as HTMLElement | undefined;
  el?.classList?.remove('fx-edge-empty');
  try {
    api.setEdgeGroupVisible?.(position, true);
  } catch {
    /* noop */
  }
  collapseEdgeGroup(group);
}

function edgeGroupForRestore(
  api: DockviewApi,
  position: WorkbenchEdge,
): GridGroup | undefined {
  const ensured = ensureEdgeGroup(api, position, { collapsed: true });
  const found = findEdgeGroup(api, position);
  const id = ensured?.id ?? found?.id;
  if (!id) return undefined;
  return api.groups.find((g) => g.id === id && g.api.location.type === 'edge');
}

/** Restore one panel to snapshot origin (grid topology or native edge). */
export function restorePanelToOrigin(
  api: DockviewApi,
  panel: DockviewApi['panels'][number],
  entry: PanelRestoreEntry,
  snapshot: PresentationSnapshot,
): boolean {
  const originById = api.groups.find((g) => g.id === entry.groupId);
  if (originById) {
    try {
      panel.api.moveTo({ group: originById, position: 'center', index: entry.index });
      const loc = originById.api.location;
      if (loc.type === 'edge' && loc.position && isWorkbenchEdge(loc.position)) {
        finalizeEdgeDock(api, originById, loc.position);
      }
      return true;
    } catch {
      /* try fallbacks */
    }
  }

  if (entry.locationType === 'edge' && entry.edgePosition && isWorkbenchEdge(entry.edgePosition)) {
    const edgeGroup = edgeGroupForRestore(api, entry.edgePosition);
    if (edgeGroup) {
      try {
        panel.api.moveTo({ group: edgeGroup, position: 'center', index: entry.index });
        finalizeEdgeDock(api, edgeGroup, entry.edgePosition);
        return true;
      } catch {
        /* fall through */
      }
    }
  }

  if (entry.locationType === 'grid') {
    const session = new GridRestoreSession(api, snapshot);
    session.runTransaction([entry]);
    return session.isPanelRestored(entry);
  }

  return false;
}

export function restorePresentation(
  api: DockviewApi,
  snapshot: PresentationSnapshot | null | undefined,
  options?: RestorePresentationOptions,
) {
  if (!snapshot?.panels?.length) return;
  const skip = options?.skipPanelIds ?? new Set<string>();

  const edgeEntries = snapshot.panels.filter((e) => e.locationType === 'edge');
  for (const entry of edgeEntries) {
    if (skip.has(entry.panelId)) continue;
    if (!entry.edgePosition || !isWorkbenchEdge(entry.edgePosition)) continue;
    const panel = api.getPanel(entry.panelId);
    if (!panel) continue;
    restorePanelToOrigin(api, panel, entry, snapshot);
  }

  const session = new GridRestoreSession(api, snapshot, options?.layoutHost);
  session.runTransaction(snapshot.panels.filter((e) => e.locationType === 'grid'), options);
  session.restoreActiveTabs(skip);

  const layoutHost = options?.layoutHost;
  if (layoutHost) {
    syncEdgeEmptyChrome(api);
    const hostRect = rectOf(layoutHost);
    if (hostRect && hostRect.width > 0 && hostRect.height > 0) {
      try {
        api.layout(Math.round(hostRect.width), Math.round(hostRect.height));
      } catch {
        /* noop */
      }
      const gridSurface = measureGridSurfaceExtent(api, layoutHost);
      if (gridSurface) {
        session.applyProportionalSizes(gridSurface);
      }
    }
  }

  if (snapshot.activePanelId && !skip.has(snapshot.activePanelId)) {
    const active = api.getPanel(snapshot.activePanelId);
    try {
      active?.api.setActive();
    } catch {
      /* noop */
    }
  }
}

/** @deprecated use restorePanelToOrigin */
export function restorePanelToGridOrigin(
  api: DockviewApi,
  panel: DockviewApi['panels'][number],
  entry: PanelRestoreEntry,
  snapshot: PresentationSnapshot,
) {
  restorePanelToOrigin(api, panel, entry, snapshot);
}

export function tuckPeripheralGridGroups(
  api: DockviewApi,
  host: HTMLElement,
  sides: readonly WorkbenchEdge[],
  autoTucked: AutoTuckedMap,
  options?: { skipGroupIds?: ReadonlySet<string>; primaryPanelIds?: ReadonlySet<string> },
) {
  const skipGroups = options?.skipGroupIds ?? new Set<string>();
  const alreadyTucked = new Set(Object.keys(autoTucked));
  const primaryPanelIds = options?.primaryPanelIds ?? new Set<string>();
  const groupsBySide = classifyPeripheralGroups(api, host, sides, primaryPanelIds);

  type PendingTuck = {
    panel: GridGroup['panels'][number];
    groupId: string;
    index: number;
    edge: WorkbenchEdge;
  };
  const pending: PendingTuck[] = [];
  const pendingPanelIds = new Set<string>();

  for (const side of sides) {
    const groups = (groupsBySide[side] ?? []).filter((g) => !skipGroups.has(g.id));
    for (const group of groups) {
      const originalPanels = [...group.panels];
      for (let index = 0; index < originalPanels.length; index += 1) {
        const panel = originalPanels[index]!;
        if (panel.api.location.type === 'edge') continue;
        if (alreadyTucked.has(panel.id)) continue;
        if (pendingPanelIds.has(panel.id)) continue;
        const edge = side;
        pendingPanelIds.add(panel.id);
        pending.push({ panel, groupId: group.id, index, edge });
      }
    }
  }

  const byEdge = new Map<WorkbenchEdge, PendingTuck[]>();
  for (const item of pending) {
    const list = byEdge.get(item.edge) ?? [];
    list.push(item);
    byEdge.set(item.edge, list);
  }

  const tuckEdgeOrder: WorkbenchEdge[] = ['left', 'right', 'bottom'];
  for (const edge of tuckEdgeOrder) {
    const batch = byEdge.get(edge);
    if (!batch?.length) continue;
    ensureEdgeGroup(api, edge, { collapsed: true });
    const edgeGroup = findEdgeGroup(api, edge);
    if (!edgeGroup) continue;
    try {
      api.setEdgeGroupVisible?.(edge, true);
    } catch {
      /* best-effort */
    }
    const edgeEl = edgeGroup.element;
    if (edgeEl instanceof HTMLElement) edgeEl.classList.remove('fx-edge-empty');
    let tabIndex = edgeGroup.panels?.length ?? 0;
    for (const { panel, groupId, index } of batch) {
      autoTucked[panel.id] = {
        panelId: panel.id,
        groupId,
        index,
        locationType: 'grid',
        tuckedToEdge: edge,
      };
      panel.api.moveTo({ group: edgeGroup as never, position: 'center', index: tabIndex });
      tabIndex += 1;
    }
  }
  return autoTucked;
}

export function restoreAutoTuckedFromEdges(
  api: DockviewApi,
  edges: readonly WorkbenchEdge[],
  autoTucked: AutoTuckedMap,
  snapshot: PresentationSnapshot | null,
) {
  if (!snapshot) return autoTucked;
  const next = { ...autoTucked };
  const toRestore = Object.values(autoTucked).filter((e) => {
    if (!e.tuckedToEdge || !edges.includes(e.tuckedToEdge)) return false;
    return true;
  });
  if (toRestore.length === 0) return next;

  const session = new GridRestoreSession(api, snapshot);
  session.runTransaction(toRestore);
  for (const entry of toRestore) {
    if (session.isPanelRestored(entry)) delete next[entry.panelId];
  }
  return next;
}

function sidesSet(sides: readonly WorkbenchEdge[]) {
  return new Set(sides);
}

export type StageMigrationOutcome = {
  applied: boolean;
  baseline: PresentationSnapshot | null;
  autoTucked: AutoTuckedMap;
};

export function applyStageMigration(
  api: DockviewApi,
  host: HTMLElement,
  fromSides: readonly WorkbenchEdge[],
  toSides: readonly WorkbenchEdge[],
  baseline: PresentationSnapshot | null,
  autoTucked: AutoTuckedMap,
  primaryPanelIds: ReadonlySet<string>,
): StageMigrationOutcome {
  const from = sidesSet(fromSides);
  const to = sidesSet(toSides);
  if (from.size === to.size && [...from].every((s) => to.has(s))) {
    return { applied: true, baseline, autoTucked: { ...autoTucked } };
  }

  const tuckSides = [...to].filter((s) => !from.has(s));
  const restoreSides = [...from].filter((s) => !to.has(s));

  if (tuckSides.length > 0 && !isDockGridSettled(api, host)) {
    return { applied: false, baseline, autoTucked: { ...autoTucked } };
  }

  let nextBaseline = baseline;
  let nextAuto = pruneUserRelocatedAutoTucked(api, autoTucked);

  if (to.size === 0) {
    if (nextBaseline) {
      const autoTuckedIds = new Set(Object.keys(nextAuto));
      const skipPanelIds = new Set<string>();
      for (const panel of api.panels) {
        if (panel.api.location.type === 'edge' && !autoTuckedIds.has(panel.id)) {
          skipPanelIds.add(panel.id);
        }
      }
      restorePresentation(api, nextBaseline, { skipPanelIds, layoutHost: host });
      // Idempotent after restorePresentation (edge sync already ran pre-layout); no grid resize.
      syncEdgeEmptyChrome(api);
    }
    return { applied: true, baseline: null, autoTucked: {} };
  }

  if (restoreSides.length > 0) {
    nextAuto = restoreAutoTuckedFromEdges(api, restoreSides, nextAuto, nextBaseline);
  }

  if (tuckSides.length > 0) {
    if (from.size === 0 && !nextBaseline) {
      nextBaseline = capturePresentation(api, host);
    }
    const tuckedGroupIds = new Set(Object.values(nextAuto).map((e) => e.groupId));
    nextAuto = tuckPeripheralGridGroups(api, host, tuckSides, nextAuto, {
      skipGroupIds: tuckedGroupIds,
      primaryPanelIds,
    });
  }

  return { applied: true, baseline: nextBaseline, autoTucked: nextAuto };
}
