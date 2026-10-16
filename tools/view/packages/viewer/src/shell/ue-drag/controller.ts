import type { DockviewApi } from 'dockview';

import { syncEdgeEmptyChrome } from '../workbench-layout/dock-edges.ts';
import {
  capturePresentation,
  restorePanelToOrigin,
  type PanelRestoreEntry,
  type PresentationSnapshot,
} from '../workbench-layout/grid-layout-migration.ts';
import { isWorkbenchEdge } from '../workbench-layout/sidebar-state.ts';
import {
  clearEdgeDropPreview,
  syncEdgeDropPreview,
} from '../workbench-layout/edge-drop-preview.ts';
import { resolveEdgeStripHit } from '../workbench-layout/edge-strip-hit.ts';
import {
  directorLayout,
  hitDirector,
  previewRect,
  stripInsertion,
  type Point,
  type Rect,
  type UePosition,
} from './geometry';
import { rectOf } from './drop-target.ts';
import { getUeLivePreviewHost, hideUeOverlay, updateUeOverlay } from './overlay';

type DockGroup = DockviewApi['groups'][number];
type DockPanel = DockviewApi['panels'][number];

type StripHit = {
  group: DockGroup;
  tabsEl: HTMLElement;
  rect: Rect;
  insertion: { index: number; slot: Rect };
  side?: string;
};

type DropTarget =
  | { mode: 'edge'; group: DockGroup; edgeSide: string; index: number }
  | { mode: 'tab'; group: DockGroup; index: number }
  | { mode: 'split'; group: DockGroup; position: Exclude<UePosition, 'center'> }
  | { mode: 'center'; group: DockGroup };

type DragSession = {
  owner: DockviewApi;
  panel: DockPanel;
  originGroupId: string;
  originIndex: number;
  originEntry: PanelRestoreEntry;
  layoutBaseline: PresentationSnapshot;
  start: Point;
  dragging: boolean;
  lifted: boolean;
  liftedEl: HTMLElement | null;
  parkedParent: Node | null;
  parkedNext: Node | null;
  target: DropTarget | null;
  ghostTitle: string;
};

const DRAG_THRESHOLD = 5;
const STRIP_SLACK = 12;

let session: DragSession | null = null;

export function isUeDragging() {
  return session?.dragging === true && session?.lifted === true;
}

function pointNearRect(p: Point, r: Rect, slack: number) {
  return p.x >= r.x - slack && p.x <= r.x + r.width + slack
    && p.y >= r.y - slack && p.y <= r.y + r.height + slack;
}

function tabElements(tabsEl: Element) {
  return Array.from(tabsEl.querySelectorAll(':scope > .dv-tab:not(.fx-edge-preview-tab)'));
}

function stripHit(
  group: DockGroup,
  host: HTMLElement,
  rect: Rect,
  axis: 'x' | 'y',
  p: Point,
  side?: string,
): StripHit | null {
  const tabsEl = host.classList.contains('dv-tabs-container')
    ? host
    : host.querySelector('.dv-tabs-container');
  if (!(tabsEl instanceof HTMLElement)) return null;
  const tabs = tabElements(tabsEl).map((tab) => rectOf(tab)).filter((r): r is Rect => r !== null);
  return {
    group,
    tabsEl,
    rect,
    insertion: stripInsertion(tabs, rect, p, axis),
    side,
  };
}

function edgeStripHit(api: DockviewApi, wrapEl: HTMLElement, p: Point): StripHit | null {
  const hit = resolveEdgeStripHit(api, wrapEl, p, session?.ghostTitle ?? '');
  if (!hit) return null;
  const axis = hit.edgeSide === 'left' || hit.edgeSide === 'right' ? 'y' : 'x';
  const strip = stripHit(hit.group, hit.tabsEl, hit.rect, axis, p, hit.edgeSide);
  return strip;
}

type GridHover = {
  group: DockGroup;
  contentRect: Rect;
  onTabs: boolean;
};

function groupFromPoint(api: DockviewApi, p: Point): GridHover | null {
  const el = document.elementFromPoint(p.x, p.y);
  const domOnTabs = Boolean(el?.closest('.dv-tabs-and-actions-container'));
  let best: GridHover | null = null;
  let bestArea = Infinity;
  for (const group of api.groups) {
    if (group.api.location.type !== 'grid') continue;
    const groupRect = rectOf(group.element);
    if (!groupRect || !pointNearRect(p, groupRect, 0)) continue;
    const contentEl = group.element.querySelector('.dv-content-container');
    const contentRect = rectOf(contentEl) ?? groupRect;
    const tabsRect = rectOf(group.element.querySelector('.dv-tabs-and-actions-container'));
    const onTabs = domOnTabs || Boolean(tabsRect && pointNearRect(p, tabsRect, 0));
    const area = groupRect.width * groupRect.height;
    if (area < bestArea) {
      bestArea = area;
      best = { group, contentRect, onTabs };
    }
  }
  return best;
}

function gridStripHit(hovered: GridHover, p: Point): StripHit | null {
  const host = hovered.group.element.querySelector(':scope > .dv-tabs-and-actions-container');
  if (!(host instanceof HTMLElement)) return null;
  const rect = rectOf(host);
  if (!rect) return null;
  return stripHit(hovered.group, host, rect, 'x', p);
}

let slotEl: HTMLDivElement | null = null;

function syncGridTabSlot(hit: StripHit | null, title: string) {
  if (!hit?.tabsEl) {
    slotEl?.remove();
    slotEl = null;
    return;
  }
  if (!slotEl) {
    slotEl = document.createElement('div');
    slotEl.className = 'fx-ue-tab-slot';
    slotEl.style.pointerEvents = 'none';
  }
  slotEl.textContent = title;
  slotEl.dataset.axis = hit.insertion.slot.width > hit.insertion.slot.height ? 'x' : 'y';
  const size = Math.max(hit.insertion.slot.width, hit.insertion.slot.height);
  slotEl.style.setProperty('--fx-ue-slot-size', `${size}px`);
  const tabs = tabElements(hit.tabsEl);
  const ref = tabs[hit.insertion.index] ?? null;
  if (slotEl.parentElement !== hit.tabsEl || slotEl.nextElementSibling !== ref) {
    hit.tabsEl.insertBefore(slotEl, ref);
  }
}

function placeLiftedPreview(rect: Rect | null) {
  const s = session;
  const el = s?.liftedEl;
  if (!s || !el) return;
  if (!rect) {
    el.classList.add('fx-ue-lifted--hidden');
    return;
  }
  if (!s.parkedParent) {
    s.parkedParent = el.parentNode;
    s.parkedNext = el.nextSibling;
    getUeLivePreviewHost().append(el);
  }
  el.classList.remove('fx-ue-lifted--hidden');
  Object.assign(el.style, {
    position: 'fixed',
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function restoreLiftedDom(s: DragSession) {
  const el = s.liftedEl;
  if (!el || !s.parkedParent) return;
  try {
    s.parkedParent.insertBefore(el, s.parkedNext);
  } catch {
    /* noop */
  }
  s.parkedParent = null;
  s.parkedNext = null;
}

function updateDrag(api: DockviewApi, wrapEl: HTMLElement, p: Point) {
  if (!session?.lifted) return;
  const edge = edgeStripHit(api, wrapEl, p);
  let active: UePosition | null = null;
  let preview: Rect | null = null;
  let previewKind: 'slab' | 'strip' = 'slab';
  let target: DropTarget | null = null;
  let strip: StripHit | null = edge;

  const hovered = edge ? null : groupFromPoint(api, p);
  const director = hovered ? directorLayout(hovered.contentRect) : null;

  if (edge) {
    target = {
      mode: 'edge',
      group: edge.group,
      edgeSide: edge.side ?? 'left',
      index: edge.insertion.index,
    };
    syncEdgeDropPreview(api, {
      edgeSide: edge.side ?? 'left',
      group: edge.group,
      tabsEl: edge.tabsEl,
      rect: edge.rect,
      pointer: p,
      title: session.ghostTitle,
    });
  } else {
    clearEdgeDropPreview(api);
  }

  if (!edge && hovered?.onTabs) {
    strip = gridStripHit(hovered, p);
    if (strip) {
      preview = strip.rect;
      previewKind = 'strip';
      target = { mode: 'tab', group: strip.group, index: strip.insertion.index };
    }
  } else if (!edge && hovered && director) {
    const pos = hitDirector(director, p);
    if (pos) {
      active = pos;
      if (pos === 'center') {
        target = { mode: 'center', group: hovered.group };
        preview = null;
      } else {
        target = { mode: 'split', group: hovered.group, position: pos };
        preview = previewRect(hovered.contentRect, pos);
      }
    }
  }

  session.target = target;
  syncGridTabSlot(edge ? null : strip, session.ghostTitle);
  placeLiftedPreview(target?.mode === 'split' ? preview : null);
  if (edge) {
    hideUeOverlay();
  } else {
    updateUeOverlay({
      pointer: p,
      director,
      active,
      preview,
      previewKind,
      title: session.ghostTitle,
    });
  }
}

function dockIntoEdge(panel: DockPanel, edgeGroup: DockGroup, index: number) {
  edgeGroup.element.classList.remove('fx-edge-empty');
  panel.api.moveTo({ group: edgeGroup, position: 'center', index });
  try {
    edgeGroup.api.collapse?.();
  } catch {
    /* noop */
  }
}

function edgePositionOf(panel: DockPanel): string | undefined {
  const loc = panel.group.api.location;
  if (loc.type === 'edge' && loc.position && isWorkbenchEdge(loc.position)) return loc.position;
  return undefined;
}

function restoreOrigin(api: DockviewApi, s: DragSession) {
  restorePanelToOrigin(api, s.panel, s.originEntry, s.layoutBaseline);
  syncEdgeEmptyChrome(api);
}

function cleanupAfterCancelRestore(api: DockviewApi, s: DragSession) {
  restoreLiftedDom(s);
  s.liftedEl?.classList.remove('fx-ue-lifted', 'fx-ue-lifted--hidden');
  slotEl?.remove();
  slotEl = null;
  clearEdgeDropPreview(api);
  hideUeOverlay();
  restoreOrigin(api, s);
  /* Drawer stays closed: edge lift calls forceClose; cancel does not reopen (open ≠ pin). */
}

function rollbackFailedLift(api: DockviewApi, s: DragSession) {
  if (s.panel.api.location.type === 'floating') {
    restoreOrigin(api, s);
  }
  s.lifted = false;
  s.dragging = false;
  s.liftedEl = null;
}

function startLift(api: DockviewApi, s: DragSession, closeEdgeDrawer?: () => void): boolean {
  if (s.lifted) return true;
  if (s.panel.group.api.location.type === 'edge') {
    closeEdgeDrawer?.();
  }
  try {
    api.addFloatingGroup(s.panel);
  } catch {
    return false;
  }
  const floating = api.groups.find(
    (g) => g.api.location.type === 'floating' && g.panels.some((p) => p.id === s.panel.id),
  );
  if (!floating) {
    rollbackFailedLift(api, s);
    return false;
  }
  const el = floating.element ?? s.panel.group.element;
  const liftedEl = el.closest<HTMLElement>('.dv-resize-container') ?? el;
  if (!(liftedEl instanceof HTMLElement)) {
    rollbackFailedLift(api, s);
    return false;
  }
  liftedEl.classList.add('fx-ue-lifted', 'fx-ue-lifted--hidden');
  s.liftedEl = liftedEl;
  s.lifted = true;
  s.dragging = true;
  document.documentElement.classList.add('fx-ue-dragging');
  return true;
}

function commit(api: DockviewApi) {
  const s = session;
  if (!s?.lifted) return;
  restoreLiftedDom(s);
  s.liftedEl?.classList.remove('fx-ue-lifted', 'fx-ue-lifted--hidden');
  slotEl?.remove();
  slotEl = null;
  clearEdgeDropPreview(api);
  try {
    const target = s.target;
    if (target?.mode === 'edge') {
      dockIntoEdge(s.panel, target.group, target.index);
    } else if (target?.mode === 'tab') {
      s.panel.api.moveTo({ group: target.group, position: 'center', index: target.index });
    } else if (target?.mode === 'center') {
      s.panel.api.moveTo({ group: target.group, position: 'center' });
    } else if (target?.mode === 'split') {
      s.panel.api.moveTo({ group: target.group, position: target.position });
    } else {
      restoreOrigin(api, s);
    }
    s.panel.api.setActive();
    syncEdgeEmptyChrome(api);
  } catch {
    restoreOrigin(api, s);
  }
}

type UeDragOptions = {
  closeEdgeDrawer?: () => void;
};

function beginPendingSession(api: DockviewApi, panel: DockPanel, start: Point) {
  const originGroupId = panel.group.id;
  const originIndex = Math.max(0, panel.group.panels.indexOf(panel));
  const layoutBaseline = capturePresentation(api);
  session = {
    owner: api,
    panel,
    originGroupId,
    originIndex,
    originEntry: {
      panelId: panel.id,
      groupId: originGroupId,
      index: originIndex,
      locationType: panel.group.api.location.type === 'edge' ? 'edge' : 'grid',
      ...(edgePositionOf(panel) ? { edgePosition: edgePositionOf(panel) } : {}),
    },
    layoutBaseline,
    start,
    dragging: false,
    lifted: false,
    liftedEl: null,
    parkedParent: null,
    parkedNext: null,
    target: null,
    ghostTitle: panel.title ?? panel.id,
  };
}

function endSession(api?: DockviewApi) {
  if (session) {
    session.liftedEl?.classList.remove('fx-ue-lifted', 'fx-ue-lifted--hidden');
    restoreLiftedDom(session);
  }
  session = null;
  document.documentElement.classList.remove('fx-ue-dragging');
  hideUeOverlay();
  slotEl?.remove();
  slotEl = null;
  if (api) clearEdgeDropPreview(api);
}

function panelForTab(group: DockGroup, tab: Element): DockPanel | undefined {
  const tabs = tabElements(tab.parentElement ?? tab);
  const index = tabs.indexOf(tab);
  return group.panels[index] ?? group.panels[0];
}

export function installUeDockDrag(
  api: DockviewApi,
  host: HTMLElement,
  options: UeDragOptions = {},
): () => void {
  const closeEdgeDrawer = options.closeEdgeDrawer;
  const wrapEl = host;

  const onPointerMove = (event: PointerEvent) => {
    if (session?.owner !== api) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!session.lifted) {
      if (Math.hypot(point.x - session.start.x, point.y - session.start.y) < DRAG_THRESHOLD) return;
      if (!startLift(api, session, closeEdgeDrawer)) {
        endSession(api);
        return;
      }
    }
    event.preventDefault();
    updateDrag(api, wrapEl, point);
  };

  const onPointerUp = () => {
    const s = session;
    if (s?.owner !== api) return;
    if (!s.lifted) {
      endSession(api);
      return;
    }
    commit(api);
    endSession(api);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || session?.owner !== api || !session.lifted) return;
    event.preventDefault();
    const s = session;
    cleanupAfterCancelRestore(api, s);
    session = null;
    document.documentElement.classList.remove('fx-ue-dragging');
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || session) return;
    const target = event.target as Element | null;
    const tab = target?.closest('.dv-tab');
    if (!tab || !host.contains(tab)) return;
    if (target?.closest('.dv-default-tab-action, button, [role="button"]')) return;
    const group = api.groups.find((candidate) => candidate.element.contains(tab));
    if (!group || (group.api.location.type !== 'grid' && group.api.location.type !== 'edge')) return;
    const panel = panelForTab(group, tab);
    if (!panel) return;
    beginPendingSession(api, panel, { x: event.clientX, y: event.clientY });
  };

  const onDragStart = (event: DragEvent) => {
    const tab = (event.target as Element | null)?.closest('.dv-tab');
    if (tab && host.contains(tab)) event.preventDefault();
  };

  host.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('dragstart', onDragStart, true);

  return () => {
    if (session?.owner === api) endSession(api);
    host.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('dragstart', onDragStart, true);
  };
}
