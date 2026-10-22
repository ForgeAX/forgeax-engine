import type { DockviewApi, DockviewWillDropEvent } from 'dockview';

import {
  DEFAULT_COLLAPSED_SIZE,
  EDGE_DRAWER_OPEN_DEFAULT_PX,
  EDGE_DRAWER_SIZE_MAX_PX,
  EDGE_DRAWER_SIZE_MIN_PX,
  EDGE_GROUP_ID,
} from './constants.ts';
import { installPointerDragSession, type PointerDragSessionHandle } from './pointer-drag-session.ts';
import {
  clearEdgeDropPreview,
  edgeStripHitFromPoint,
  syncEdgeDropPreview,
} from './edge-drop-preview.ts';
import {
  EDGE_PIN_CLASS,
  disposeEdgePinScope,
  edgePinScopeFor,
  type EdgePinScope,
} from './edge-pin-store.ts';
import type { WorkbenchEdge } from './types.ts';

const OPEN_CLASS = 'fx-edge-drawer-open';
const ANIM_CLASS = 'fx-edge-drawer-animating';
const ENSURED_EDGES = ['left', 'right', 'bottom'] as const;
const PORTAL_HOST_CLASS = 'fx-edge-drawer-portal-host';
const FLYOUT_CLASS = 'fx-edge-drawer-flyout';
const BOTTOM_SPAN_CLASS = 'fx-bottom-edge-spanning';
const BOTTOM_SPAN_VARS = [
  '--fx-bottom-edge-left',
  '--fx-bottom-edge-bottom',
  '--fx-bottom-edge-width',
  '--fx-bottom-edge-height',
] as const;

const DRAWER_VAR_NAMES = [
  '--fx-edge-drawer-width',
  '--fx-edge-drawer-max-width',
  '--fx-edge-drawer-height',
  '--fx-edge-drawer-left',
  '--fx-edge-drawer-right',
  '--fx-edge-drawer-top',
  '--fx-edge-drawer-bottom',
  '--fx-edge-strip-top',
  '--fx-edge-strip-left',
  '--fx-edge-strip-height',
  '--fx-edge-strip-width',
] as const;

const EDGE_HEADER_CLASSES = [
  'dv-groupview-header-left',
  'dv-groupview-header-right',
  'dv-groupview-header-top',
  'dv-groupview-header-bottom',
] as const;

const DISMISS_EXEMPT_SELECTORS = '.dv-context-menu, .fx-menu-position, .fx-ue-overlay, .fx-ue-tab-slot';
const DRAWER_CROSS_INSET_PX = 6;

export type EdgeDrawerController = {
  getOpenPanelId: () => string | null;
  close: () => void;
  forceClose: () => void;
  revealPanel: (panelId: string) => boolean;
  /** Page inactive: unportal drawer but keep pinScope; remember pinned open group. */
  suspendForPage: () => void;
  /** Page active again: reopen pinned drawer if pin + panel still valid. */
  resumePinned: () => void;
  togglePinForPanel: (groupId: string, panelId: string) => void;
  pinPanel: (groupId: string, panelId: string) => void;
  unpinPanel: (groupId: string) => void;
  onWillDrop: (event: DockviewWillDropEvent) => boolean;
  refreshBottomSpan: () => void;
  dispose: () => void;
};

function edgeGroups(api: DockviewApi) {
  return api.groups.filter((g) => g.api.location.type === 'edge');
}

function edgeOf(group: DockviewApi['groups'][number]): WorkbenchEdge {
  const loc = group.api.location;
  if (loc.type === 'edge' && loc.position === 'left') return 'left';
  if (loc.type === 'edge' && loc.position === 'right') return 'right';
  if (loc.type === 'edge' && loc.position === 'bottom') return 'bottom';
  if (group.element.classList.contains('dv-groupview-header-right')) return 'right';
  if (group.element.classList.contains('dv-groupview-header-bottom')) return 'bottom';
  return 'left';
}

function sizeVar(edge: string) {
  return edge === 'left' || edge === 'right' ? '--fx-edge-drawer-width' : '--fx-edge-drawer-height';
}

function readDrawerSize(group: DockviewApi['groups'][number], edge: WorkbenchEdge) {
  const n = parseFloat(group.element.style.getPropertyValue(sizeVar(edge)));
  return Number.isFinite(n) ? n : EDGE_DRAWER_OPEN_DEFAULT_PX;
}

function contentContainerOf(group: DockviewApi['groups'][number]) {
  return group.element.querySelector(':scope > .dv-content-container');
}

function isDismissExemptTarget(target: Element | null) {
  if (!target) return false;
  return Boolean(target.closest(DISMISS_EXEMPT_SELECTORS));
}

export function installEdgeDrawer(
  api: DockviewApi,
  root: HTMLElement,
): EdgeDrawerController {
  let openGroup: DockviewApi['groups'][number] | null = null;
  /** Edge group id to re-open after page suspend when pin drawer was showing. */
  let pinnedResumeGroupId: string | null = null;
  const pinScope: EdgePinScope = edgePinScopeFor(api);
  let drawerPortalHost: HTMLDivElement | null = null;
  let portaledFlyout: HTMLElement | null = null;
  const grip = document.createElement('div');
  grip.className = 'fx-edge-drawer-grip';

  const pinnedPanelId = (group: DockviewApi['groups'][number]) => pinScope.pinnedIn(group.id);
  const findPanel = (group: DockviewApi['groups'][number], id: string) =>
    group.panels.find((p) => p.id === id);
  const findGroup = (groupId: string) => edgeGroups(api).find((g) => g.id === groupId);

  const activeIsPinned = (group: DockviewApi['groups'][number]) => {
    const active = group.activePanel;
    return Boolean(active && pinnedPanelId(group) === active.id);
  };

  const ensureDrawerPortalHost = () => {
    if (drawerPortalHost) return drawerPortalHost;
    const host = document.createElement('div');
    host.className = PORTAL_HOST_CLASS;
    document.body.appendChild(host);
    drawerPortalHost = host;
    return host;
  };

  const copyDrawerVars = (from: CSSStyleDeclaration, to: HTMLElement) => {
    for (const name of DRAWER_VAR_NAMES) {
      const val = from.getPropertyValue(name);
      if (val) to.style.setProperty(name, val);
      else to.style.removeProperty(name);
    }
  };

  const syncFlyoutDirectionClasses = (
    group: DockviewApi['groups'][number],
    flyout: HTMLElement,
  ) => {
    for (const cls of EDGE_HEADER_CLASSES) {
      flyout.classList.toggle(cls, group.element.classList.contains(cls));
    }
  };

  /** Title state lives on the edge group; mirror onto portaled flyout for scoped CSS. */
  const syncFlyoutTitleState = (
    group: DockviewApi['groups'][number],
    flyout: HTMLElement,
  ) => {
    const state = group.element.getAttribute('data-fx-dock-title-state');
    if (state) flyout.setAttribute('data-fx-dock-title-state', state);
    else flyout.removeAttribute('data-fx-dock-title-state');
  };

  let gripResize!: PointerDragSessionHandle;

  const isInsideOpenDrawer = (target: Element | null): boolean => {
    if (!target || !openGroup) return false;
    if (openGroup.element.contains(target)) return true;
    if (portaledFlyout?.contains(target)) return true;
    if (grip.contains(target)) return true;
    return false;
  };

  const restoreDrawerFlyout = (group: DockviewApi['groups'][number]) => {
    gripResize?.abortActiveSession();
    const flyout = portaledFlyout ?? contentContainerOf(group);
    if (flyout instanceof HTMLElement) {
      flyout.classList.remove(FLYOUT_CLASS, ANIM_CLASS);
      for (const cls of EDGE_HEADER_CLASSES) flyout.classList.remove(cls);
      flyout.removeAttribute('data-fx-dock-title-state');
      group.element.appendChild(flyout);
    }
    grip.remove();
    portaledFlyout = null;
    if (drawerPortalHost) {
      for (const name of DRAWER_VAR_NAMES) drawerPortalHost.style.removeProperty(name);
      drawerPortalHost.replaceChildren();
    }
  };

  const portalDrawerFlyout = (group: DockviewApi['groups'][number]) => {
    const flyout = contentContainerOf(group);
    if (!(flyout instanceof HTMLElement)) return;
    const host = ensureDrawerPortalHost();
    flyout.classList.add(FLYOUT_CLASS);
    syncFlyoutDirectionClasses(group, flyout);
    syncFlyoutTitleState(group, flyout);
    copyDrawerVars(group.element.style, host);
    portaledFlyout = flyout;
    host.appendChild(flyout);
    host.appendChild(grip);
    positionGrip(group);
  };

  const positionGrip = (group: DockviewApi['groups'][number]) => {
    const e = edgeOf(group);
    const r = group.element.getBoundingClientRect();
    const maxWidth = parseFloat(group.element.style.getPropertyValue('--fx-edge-drawer-max-width'));
    const size = e === 'bottom' ? readDrawerSize(group, e) : Math.min(readDrawerSize(group, e), maxWidth);
    const sideHeight = parseFloat(group.element.style.getPropertyValue('--fx-edge-strip-height'));
    const bottomLeft = parseFloat(group.element.style.getPropertyValue('--fx-edge-strip-left'));
    const bottomWidth = parseFloat(group.element.style.getPropertyValue('--fx-edge-strip-width'));
    const g = grip.style;
    g.position = 'fixed';
    if (e === 'left') {
      g.top = `${r.top + DRAWER_CROSS_INSET_PX}px`;
      g.height = `${Math.max(0, sideHeight - 2 * DRAWER_CROSS_INSET_PX)}px`;
      g.left = `${r.right + size - 3}px`;
      g.width = '6px';
      g.cursor = 'ew-resize';
    } else if (e === 'right') {
      g.top = `${r.top + DRAWER_CROSS_INSET_PX}px`;
      g.height = `${Math.max(0, sideHeight - 2 * DRAWER_CROSS_INSET_PX)}px`;
      g.left = `${r.left - size - 3}px`;
      g.width = '6px';
      g.cursor = 'ew-resize';
    } else {
      g.left = `${bottomLeft + DRAWER_CROSS_INSET_PX}px`;
      g.width = `${Math.max(0, bottomWidth - 2 * DRAWER_CROSS_INSET_PX)}px`;
      g.top = `${r.top - size - 3}px`;
      g.height = '6px';
      g.cursor = 'ns-resize';
    }
  };

  const positionDrawer = (group: DockviewApi['groups'][number]) => {
    const edge = edgeOf(group);
    const style = group.element.style;
    const r = group.element.getBoundingClientRect();
    const occupied = (side: WorkbenchEdge) => edgeGroups(api).find(candidate =>
      edgeOf(candidate) === side && candidate.panels.length > 0,
    )?.element.getBoundingClientRect();

    if (edge === 'bottom') {
      const left = occupied('left')?.right ?? r.left;
      const right = occupied('right')?.left ?? r.right;
      style.setProperty('--fx-edge-strip-left', `${left}px`);
      style.setProperty('--fx-edge-strip-width', `${Math.max(0, right - left)}px`);
      style.setProperty('--fx-edge-drawer-bottom', `${window.innerHeight - r.top}px`);
      style.setProperty('--fx-edge-drawer-left', '0');
    } else {
      const opposite = occupied(edge === 'left' ? 'right' : 'left');
      const boundary = edge === 'left'
        ? opposite?.left ?? root.getBoundingClientRect().right
        : opposite?.right ?? root.getBoundingClientRect().left;
      const maxWidth = edge === 'left' ? boundary - r.right - 3 : r.left - boundary - 3;
      const sideHeight = Math.min(r.height, Math.max(0, (occupied('bottom')?.top ?? r.bottom) - r.top));
      style.setProperty('--fx-edge-drawer-max-width', `${Math.max(0, maxWidth)}px`);
      style.setProperty('--fx-edge-drawer-left', `${r.right}px`);
      style.setProperty('--fx-edge-drawer-right', `${window.innerWidth - r.left}px`);
      style.setProperty('--fx-edge-drawer-top', `${r.bottom}px`);
      style.setProperty('--fx-edge-drawer-bottom', `${window.innerHeight - r.top}px`);
      style.setProperty('--fx-edge-strip-top', `${r.top}px`);
      style.setProperty('--fx-edge-strip-left', `${r.left}px`);
      style.setProperty('--fx-edge-strip-height', `${sideHeight}px`);
      style.setProperty('--fx-edge-strip-width', `${r.width}px`);
    }
    if (openGroup === group && drawerPortalHost) {
      copyDrawerVars(style, drawerPortalHost);
    }
    if (portaledFlyout) {
      positionGrip(group);
    }
  };

  const kickAnim = (group: DockviewApi['groups'][number]) => {
    group.element.classList.remove(ANIM_CLASS);
    void group.element.offsetWidth;
    group.element.classList.add(ANIM_CLASS);
    const flyout = portaledFlyout ?? contentContainerOf(group);
    if (flyout instanceof HTMLElement) {
      flyout.classList.remove(ANIM_CLASS);
      void flyout.offsetWidth;
      flyout.classList.add(ANIM_CLASS);
    }
  };

  const forceClose = () => {
    const prev = openGroup;
    if (prev) {
      restoreDrawerFlyout(prev);
      prev.element.classList.remove(OPEN_CLASS, ANIM_CLASS);
      openGroup = null;
    }
  };

  const suspendForPage = () => {
    pinnedResumeGroupId = null;
    if (openGroup) {
      const pin = pinnedPanelId(openGroup);
      if (pin && findPanel(openGroup, pin)) {
        pinnedResumeGroupId = openGroup.id;
      }
    }
    forceClose();
  };

  const resumePinned = () => {
    const groupId = pinnedResumeGroupId;
    pinnedResumeGroupId = null;
    if (!groupId) return;
    const group = findGroup(groupId);
    if (!group) return;
    const pin = pinnedPanelId(group);
    if (!pin) return;
    const panel = findPanel(group, pin);
    if (!panel) return;
    try {
      panel.api.setActive();
    } catch {
      /* noop */
    }
    open(group);
  };

  const open = (group: DockviewApi['groups'][number]) => {
    if (openGroup && openGroup !== group) {
      restoreDrawerFlyout(openGroup);
      openGroup.element.classList.remove(OPEN_CLASS, ANIM_CLASS);
    }
    openGroup = group;
    group.element.classList.add(OPEN_CLASS);
    positionDrawer(group);
    portalDrawerFlyout(group);
    kickAnim(group);
  };

  const close = () => {
    if (!openGroup) return;
    const group = openGroup;
    if (activeIsPinned(group)) return;
    const pinnedId = pinnedPanelId(group);
    if (pinnedId) {
      const pinned = findPanel(group, pinnedId);
      if (pinned) {
        try {
          pinned.api.setActive();
        } catch {
          /* noop */
        }
        kickAnim(group);
        return;
      }
    }
    forceClose();
  };

  const togglePin = (group: DockviewApi['groups'][number], panel: DockviewApi['panels'][number]) => {
    const cur = pinnedPanelId(group);
    if (cur === panel.id) pinScope.setPinned(group.id, undefined);
    else {
      pinScope.setPinned(group.id, panel.id);
      try {
        panel.api.setActive();
      } catch {
        /* noop */
      }
      if (openGroup !== group) open(group);
    }
  };

  const pinPanel = (groupId: string, panelId: string) => {
    const group = findGroup(groupId);
    const panel = group ? findPanel(group, panelId) : undefined;
    if (!group || !panel) return;
    if (pinnedPanelId(group) === panelId) return;
    pinScope.setPinned(group.id, panelId);
    try {
      panel.api.setActive();
    } catch {
      /* noop */
    }
    if (openGroup !== group) open(group);
  };

  const unpinPanel = (groupId: string) => {
    const group = findGroup(groupId);
    if (!group) return;
    pinScope.setPinned(group.id, undefined);
  };

  const togglePinForPanel = (groupId: string, panelId: string) => {
    const group = findGroup(groupId);
    const panel = group ? findPanel(group, panelId) : undefined;
    if (!group || !panel) return;
    togglePin(group, panel);
  };

  const ensureEdgeSlots = () => {
    for (const pos of ENSURED_EDGES) {
      if (api.getEdgeGroup?.(pos)) continue;
      try {
        api.addEdgeGroup?.(pos, {
          id: EDGE_GROUP_ID[pos],
          initialSize: pos === 'bottom' ? 280 : 260,
          collapsed: true,
          collapsedSize: DEFAULT_COLLAPSED_SIZE,
        });
        api.setEdgeGroupVisible?.(pos, false);
      } catch {
        /* noop */
      }
    }
    for (const group of edgeGroups(api)) {
      try {
        group.api.collapse?.();
      } catch {
        /* noop */
      }
    }
  };

  const syncEmptyEdges = () => {
    for (const pos of ENSURED_EDGES) {
      const group = edgeGroups(api).find((g) => g.api.location.type === 'edge' && g.api.location.position === pos);
      const hasItems = (group?.panels.length ?? 0) > 0;
      const previewing = group?.element.classList.contains('fx-edge-drop-preview');
      try {
        api.setEdgeGroupVisible?.(pos, hasItems || Boolean(previewing));
      } catch {
        /* noop */
      }
      if (group) {
        group.element.classList.toggle('fx-edge-empty', !hasItems && !previewing);
        if (!hasItems && !previewing) {
          pinScope.setPinned(group.id, undefined);
          if (openGroup === group) forceClose();
        }
      }
    }
  };

  // Dockview lays the bottom edge out inside its middle column. Position that
  // actual view across the host so its tabs and hit target span both sidebars.
  let bottomSpanSlot: HTMLElement | null = null;
  const clearBottomSpan = () => {
    bottomSpanSlot?.classList.remove(BOTTOM_SPAN_CLASS);
    bottomSpanSlot = null;
    for (const name of BOTTOM_SPAN_VARS) root.style.removeProperty(name);
  };
  const syncBottomSpan = () => {
    const group = edgeGroups(api).find((candidate) => edgeOf(candidate) === 'bottom');
    const slot = group?.element.parentElement;
    const host = root.getBoundingClientRect();
    if (!group || !(slot instanceof HTMLElement) || !group.panels.length || host.width <= 0) {
      clearBottomSpan();
      return;
    }
    if (bottomSpanSlot !== slot) {
      bottomSpanSlot?.classList.remove(BOTTOM_SPAN_CLASS);
      bottomSpanSlot = slot;
    }
    const strip = slot.getBoundingClientRect();
    root.style.setProperty('--fx-bottom-edge-left', `${host.left}px`);
    root.style.setProperty('--fx-bottom-edge-bottom', `${window.innerHeight - host.bottom}px`);
    root.style.setProperty('--fx-bottom-edge-width', `${host.width}px`);
    root.style.setProperty('--fx-bottom-edge-height', `${strip.height}px`);
    slot.classList.add(BOTTOM_SPAN_CLASS);
  };
  let bottomSpanFrame: number | null = null;
  const scheduleBottomSpan = () => {
    if (bottomSpanFrame !== null) cancelAnimationFrame(bottomSpanFrame);
    bottomSpanFrame = requestAnimationFrame(() => {
      bottomSpanFrame = null;
      syncBottomSpan();
    });
  };

  const onClickCapture = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const tabEl = target?.closest('.dv-tab');
    if (!tabEl || tabEl.classList.contains('fx-edge-preview-tab')) return;
    const groupEl = tabEl.closest('.dv-groupview-edge');
    if (!groupEl || !root.contains(groupEl)) return;
    const group = edgeGroups(api).find((g) => g.element === groupEl);
    if (!group) return;
    event.preventDefault();
    event.stopPropagation();
    const pinBtn = target?.closest(`.${EDGE_PIN_CLASS}`);
    if (pinBtn) {
      const panelId = pinBtn.getAttribute('data-fx-edge-pin-panel');
      const panel = panelId ? findPanel(group, panelId) : undefined;
      if (panel) togglePin(group, panel);
      return;
    }
    const container = tabEl.closest('.dv-tabs-container');
    const tabs = container ? Array.from(container.querySelectorAll(':scope > .dv-tab:not(.fx-edge-preview-tab)')) : [];
    const index = tabs.indexOf(tabEl);
    const panel = index >= 0 ? group.panels[index] : undefined;
    const wasActive = panel != null && group.activePanel === panel;
    if (panel) {
      try {
        panel.api.setActive();
      } catch {
        /* noop */
      }
    }
    if (openGroup === group && wasActive) close();
    else if (openGroup === group && !wasActive) kickAnim(group);
    else open(group);
  };

  const onOutside = (event: MouseEvent) => {
    if (!openGroup) return;
    const target = event.target as Element | null;
    if (!target) return;
    if (isDismissExemptTarget(target)) return;
    if (isInsideOpenDrawer(target)) return;
    close();
  };

  gripResize = installPointerDragSession({
    element: grip,
    begin: () => {
      if (!openGroup) return null;
      const group = openGroup;
      const edge = edgeOf(group);
      return { group, edge, rect: group.element.getBoundingClientRect() };
    },
    move: ({ group, edge, rect: r }, ev) => {
      let size: number;
      if (edge === 'left') size = ev.clientX - r.right;
      else if (edge === 'right') size = r.left - ev.clientX;
      else size = r.top - ev.clientY;
      size = Math.max(EDGE_DRAWER_SIZE_MIN_PX, Math.min(size, EDGE_DRAWER_SIZE_MAX_PX));
      group.element.style.setProperty(sizeVar(edge), `${size}px`);
      if (drawerPortalHost) {
        copyDrawerVars(group.element.style, drawerPortalHost);
      }
      positionGrip(group);
    },
    preventDefault: true,
    stopPropagation: true,
    draggingClassName: 'fx-edge-drawer-grip--dragging',
  });

  const onWillDrop = (event: DockviewWillDropEvent) => {
    if (document.documentElement.classList.contains('fx-ue-dragging')) return false;
    const native = event.nativeEvent;
    if (!(native instanceof DragEvent)) return true;
    const point = { x: native.clientX, y: native.clientY };
    const title = native.dataTransfer?.getData('text/plain') || 'Panel';
    const hit = edgeStripHitFromPoint(api, root, point, title);
    if (hit) {
      syncEdgeDropPreview(api, hit);
      return true;
    }
    const position = event.position;
    if (event.kind === 'edge') {
      const group = edgeGroups(api).find(
        (g) => g.api.location.type === 'edge' && g.api.location.position === position,
      );
      const tabsEl = group?.element.querySelector('.dv-tabs-container');
      if (group && tabsEl instanceof HTMLElement) {
        const rect = tabsEl.getBoundingClientRect();
        syncEdgeDropPreview(api, {
          edgeSide: position,
          group,
          tabsEl,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          pointer: point,
          title,
        });
        return true;
      }
    }
    clearEdgeDropPreview(api);
    return true;
  };

  const onDragEnd = () => clearEdgeDropPreview(api);

  ensureEdgeSlots();
  syncEmptyEdges();
  syncBottomSpan();

  root.addEventListener('click', onClickCapture, true);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('dragend', onDragEnd, true);
  document.addEventListener('drop', onDragEnd, true);

  const layoutSub = api.onDidLayoutChange?.(() => {
    syncEmptyEdges();
    scheduleBottomSpan();
    if (openGroup) {
      positionDrawer(openGroup);
      if (portaledFlyout && drawerPortalHost) {
        copyDrawerVars(openGroup.element.style, drawerPortalHost);
        syncFlyoutTitleState(openGroup, portaledFlyout);
      }
      if (portaledFlyout) {
        positionGrip(openGroup);
      }
    }
  });

  const panelSub = api.onDidRemovePanel?.(() => {
    syncEmptyEdges();
    scheduleBottomSpan();
  });
  const hostResize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleBottomSpan);
  hostResize?.observe(root);

  return {
    getOpenPanelId: () => openGroup?.activePanel?.id ?? null,
    close,
    forceClose,
    revealPanel(panelId) {
      const panel = api.getPanel(panelId);
      if (!panel || panel.api.location.type !== 'edge') return false;
      panel.api.setActive();
      open(panel.group);
      return true;
    },
    suspendForPage,
    resumePinned,
    togglePinForPanel,
    pinPanel,
    unpinPanel,
    onWillDrop,
    refreshBottomSpan: scheduleBottomSpan,
    dispose: () => {
      gripResize.dispose();
      forceClose();
      clearEdgeDropPreview(api);
      pinScope.clear();
      disposeEdgePinScope(api);
      drawerPortalHost?.remove();
      drawerPortalHost = null;
      portaledFlyout = null;
      grip.remove();
      root.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('dragend', onDragEnd, true);
      document.removeEventListener('drop', onDragEnd, true);
      layoutSub?.dispose?.();
      panelSub?.dispose?.();
      hostResize?.disconnect();
      if (bottomSpanFrame !== null) cancelAnimationFrame(bottomSpanFrame);
      clearBottomSpan();
    },
  };
}
