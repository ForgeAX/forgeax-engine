import type { DockviewApi } from 'dockview';

import { WORKBENCH_EDGES } from './constants.ts';
import { provisionEdgeGroupIfMissing } from './dock-edges.ts';
import { rectOf } from '../ue-drag/drop-target.ts';
import type { Point, Rect } from '../ue-drag/geometry.ts';
import type { WorkbenchEdge } from './types.ts';

const EDGE_SIDES = ['bottom', 'left', 'right'] as const satisfies readonly WorkbenchEdge[];
const EMPTY_EDGE_BAND = 18;
const STRIP_SLACK = 12;

export type EdgeStripHitInput = {
  edgeSide: string;
  group: DockviewApi['groups'][number];
  tabsEl: HTMLElement;
  rect: Rect;
  pointer: Point;
  title: string;
};

function edgeBand(wrap: Rect, side: string): Rect {
  const t = EMPTY_EDGE_BAND;
  switch (side) {
    case 'left':
      return { x: wrap.x, y: wrap.y, width: t, height: wrap.height };
    case 'right':
      return { x: wrap.x + wrap.width - t, y: wrap.y, width: t, height: wrap.height };
    case 'top':
      return { x: wrap.x, y: wrap.y, width: wrap.width, height: t };
    case 'bottom':
    default:
      return { x: wrap.x, y: wrap.y + wrap.height - t, width: wrap.width, height: t };
  }
}

function pointNearRect(p: Point, r: Rect, slack: number) {
  return p.x >= r.x - slack && p.x <= r.x + r.width + slack
    && p.y >= r.y - slack && p.y <= r.y + r.height + slack;
}

function tabsContainerFor(group: DockviewApi['groups'][number]): HTMLElement | null {
  const root = group.element;
  if (!(root instanceof HTMLElement)) return null;
  const nested = root.querySelector(
    '.dv-tabs-and-actions-container .dv-tabs-container',
  );
  if (nested instanceof HTMLElement) return nested;
  const flat = root.querySelector('.dv-tabs-container');
  if (flat instanceof HTMLElement) return flat;
  const actions = root.querySelector('.dv-tabs-and-actions-container');
  return actions instanceof HTMLElement ? actions : null;
}

function shellRect(root: HTMLElement): Rect | null {
  const shell = root.querySelector('.dv-shell');
  return rectOf(shell instanceof HTMLElement ? shell : root) ?? rectOf(root);
}

function findEdgeGroupForSide(api: DockviewApi, side: string) {
  return api.groups.find(
    (g) => g.api.location.type === 'edge' && g.api.location.position === side,
  );
}

function edgeStripOccupied(group: DockviewApi['groups'][number] | undefined): boolean {
  if (!group) return false;
  if ((group.panels?.length ?? 0) > 0) return true;
  const el = group.element;
  if (!(el instanceof HTMLElement)) return false;
  return !el.classList.contains('fx-edge-empty');
}

/** Side-effect free: shell bounds + visible rail geometry only. */
function probeEdgeStripHit(
  api: DockviewApi,
  wrapRect: Rect,
  pointer: Point,
  edges: readonly WorkbenchEdge[],
): { side: (typeof EDGE_SIDES)[number]; rect: Rect } | null {
  for (const side of EDGE_SIDES) {
    if (!edges.includes(side)) continue;
    const group = findEdgeGroupForSide(api, side);
    const occupied = edgeStripOccupied(group);
    let rect: Rect | null = null;
    if (occupied && group) {
      const groupEl = group.element;
      if (groupEl instanceof HTMLElement) {
        const stripHost = groupEl.querySelector('.dv-tabs-and-actions-container');
        if (stripHost instanceof HTMLElement) {
          rect = rectOf(stripHost);
        }
      }
    }
    if (!rect) {
      rect = edgeBand(wrapRect, side);
    }
    const slack = occupied ? STRIP_SLACK : 0;
    if (pointNearRect(pointer, rect, slack)) {
      return { side, rect };
    }
  }
  return null;
}

/**
 * Unified edge-band hit for UE drag and Dockview native drop preview.
 * Commits (provision slot) only for the matched side; reveal stays in edge-drop-preview.
 */
export function resolveEdgeStripHit(
  api: DockviewApi,
  root: HTMLElement,
  pointer: Point,
  title: string,
  edges: readonly WorkbenchEdge[] = WORKBENCH_EDGES,
): EdgeStripHitInput | null {
  const wrapRect = shellRect(root);
  if (!wrapRect) return null;

  const probe = probeEdgeStripHit(api, wrapRect, pointer, edges);
  if (!probe) return null;

  provisionEdgeGroupIfMissing(api, probe.side);
  const group = findEdgeGroupForSide(api, probe.side);
  if (!group) return null;

  const tabsEl = tabsContainerFor(group);
  if (!tabsEl) return null;

  const occupied = edgeStripOccupied(group);
  let rect = probe.rect;
  if (occupied) {
    const groupEl = group.element;
    if (groupEl instanceof HTMLElement) {
      const stripHost = groupEl.querySelector('.dv-tabs-and-actions-container');
      if (stripHost instanceof HTMLElement) {
        rect = rectOf(stripHost) ?? rect;
      }
    }
  }

  return {
    edgeSide: probe.side,
    group,
    tabsEl,
    rect,
    pointer,
    title,
  };
}
