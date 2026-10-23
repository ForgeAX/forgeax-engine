import type { AddPanelOptions, DockviewApi } from 'dockview';
import type { PanelClaim, PanelLayout } from '@forgeax/view-workspace-core/frontend-contract';
import { shellBottomPosition } from './panel-transfer.ts';

type ReconcileOptions = {
  titleFor?: (claim: PanelClaim) => string;
  attach?: (id: string, anchor?: HTMLElement) => void;
  preservePanelIds?: Pick<ReadonlySet<string>, 'has'>;
  shellBottom?: boolean;
  availableWidth?: number;
  availableHeight?: number;
};

const DOCK_DIRECTION = Object.freeze({
  fill: 'right',
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
  'right-bottom': 'below',
} as const);
const DOCK_ORDER = Object.freeze({
  fill: 0,
  top: 1,
  bottom: 2,
  left: 3,
  right: 4,
  'right-bottom': 5,
});
const layoutSignatures = new WeakMap<DockviewApi, string>();
const NO_PRESERVED_PANELS: ReadonlySet<string> = new Set();
type PagePanelClaim = Extract<PanelClaim, { home: { kind: 'page' } }>;

function isPagePanelClaim(claim: PanelClaim): claim is PagePanelClaim {
  return claim.home.kind === 'page';
}

function panelId(claim: PanelClaim) {
  return claim.id;
}

function layoutDock(claim: PanelClaim) {
  return isPagePanelClaim(claim) ? claim.layout.dock : undefined;
}

export function isPanelClosable(claim: PanelClaim | null | undefined) {
  return claim?.closable !== false;
}

function dockPanelParams(claim: PanelClaim, attach: (id: string, anchor?: HTMLElement) => void) {
  const id = panelId(claim);
  return {
    id,
    attach,
    layoutDock: layoutDock(claim),
    ...(claim.titleKey === undefined ? {} : { titleKey: claim.titleKey }),
    ...(isPanelClosable(claim) ? {} : { closable: false }),
  };
}

export function claimsForPage(claims: readonly PanelClaim[], pageType: string | null | undefined, api?: DockviewApi) {
  if (!pageType) return [];
  return claims.filter((claim) =>
    (claim.home.kind === 'page' && claim.home.pageType === pageType) ||
    (claim.home.kind === 'shell-bottom' && api?.getPanel(panelId(claim)) !== undefined));
}

function orderedClaims<T extends PanelClaim>(claims: readonly T[]) {
  return [...claims].sort(
    (left, right) =>
      (DOCK_ORDER[layoutDock(left) ?? 'fill'] ?? 99) - (DOCK_ORDER[layoutDock(right) ?? 'fill'] ?? 99) ||
      left.layout.order - right.layout.order ||
      panelId(left).localeCompare(panelId(right)),
  );
}

export function panelLayoutSignature(claims: readonly PanelClaim[]) {
  return JSON.stringify(
    orderedClaims(claims.filter(isPagePanelClaim)).map((claim) => [
      panelId(claim),
      claim.layout.dock,
      claim.layout.size ?? null,
      claim.layout.stack,
      claim.layout.order,
    ]),
  );
}

function initialSize(size: PanelLayout['size'], available: number | undefined) {
  if (!size) return undefined;
  if (size.unit === 'px') return size.value;
  if (available === undefined || !Number.isFinite(available) || available <= 0) return undefined;
  return Math.round(available * size.value) + (size.additionalPx ?? 0);
}

function isGridPanel(api: DockviewApi, id: string) {
  return api.getPanel(id)?.group?.api.location.type === 'grid';
}

function emptyGridGroup(api: DockviewApi) {
  return api.groups.find(group => group.api.location.type === 'grid' && group.panels.length === 0);
}

/** Page homes build the grid from claim anchors; Shell homes target the bottom edge. */
function placementFor(
  api: DockviewApi,
  claim: PanelClaim,
  anchors: ReadonlyMap<PanelLayout['dock'], string>,
  centerAnchor: string | undefined,
  emptyGroup: ReturnType<typeof emptyGridGroup>,
  shellBottom: boolean,
): AddPanelOptions['position'] {
  if (shellBottom) {
    if (isPagePanelClaim(claim)) throw new Error(`Page-home panel cannot be reconciled into the Shell dock: ${claim.id}`);
    return shellBottomPosition(api);
  }
  if (!isPagePanelClaim(claim)) {
    if (!centerAnchor || !isGridPanel(api, centerAnchor)) {
      return emptyGroup ? { direction: 'within', referenceGroup: emptyGroup } : undefined;
    }
    return { direction: 'within', referencePanel: centerAnchor };
  }
  const dock = claim.layout.dock;
  const sameDock = anchors.get(dock);
  if (sameDock && isGridPanel(api, sameDock)) {
    return {
      direction: claim.layout.stack === 'tabs' ? 'within' : DOCK_DIRECTION[dock],
      referencePanel: sameDock,
    };
  }
  if (dock === 'right-bottom') {
    const rightAnchor = anchors.get('right');
    if (rightAnchor && isGridPanel(api, rightAnchor)) {
      return { direction: 'below', referencePanel: rightAnchor };
    }
  }
  // An omitted position targets Dockview's active group, which may be an edge drawer.
  if (!centerAnchor || !isGridPanel(api, centerAnchor)) {
    if (emptyGroup) {
      return { direction: dock === 'fill' ? 'within' : DOCK_DIRECTION[dock], referenceGroup: emptyGroup };
    }
    return { direction: 'right' };
  }
  return {
    direction: dock === 'fill' ? 'within' : dock === 'right-bottom' ? 'right' : DOCK_DIRECTION[dock],
    referencePanel: centerAnchor,
  };
}

/**
 * Reconcile Dockview with the currently active, product-owned panel claims.
 * The shell only interprets generic zones and sizing hints.
 * `layout.dock` is the default home; collapse never closes panels.
 */
export function refreshDockPanelTitles(
  api: DockviewApi,
  claims: readonly PanelClaim[],
  titleFor: (claim: PanelClaim) => string = (claim) => claim.titleKey ?? panelId(claim),
) {
  for (const claim of claims) {
    const id = panelId(claim);
    const panel = api.getPanel(id);
    if (panel) panel.api.setTitle(titleFor(claim));
  }
}

/** Title and placement policy come from the active product claims. */
export function reconcileDockPanels(
  api: DockviewApi,
  claims: readonly PanelClaim[],
  {
    titleFor = (claim) => claim.titleKey ?? panelId(claim),
    attach = () => {},
    preservePanelIds = NO_PRESERVED_PANELS,
    shellBottom = false,
    availableWidth,
    availableHeight,
  }: ReconcileOptions = {},
) {
  const activeIds = new Set(claims.map(panelId));
  for (const panel of [...api.panels]) {
    if (!activeIds.has(panel.id) && !preservePanelIds.has(panel.id)) panel.api.close();
  }
  // Retirement is immediate, but initial fractions need a visible extent.
  if ((availableWidth !== undefined && availableWidth <= 0) || (availableHeight !== undefined && availableHeight <= 0)) return;
  const signature = panelLayoutSignature(claims);
  if (layoutSignatures.get(api) !== signature && api.panels.length > 0) {
    const pagePanelIds = new Set(claims.filter(claim => claim.home.kind === 'page').map(panelId));
    for (const panel of [...api.panels]) {
      if (pagePanelIds.has(panel.id) && !preservePanelIds.has(panel.id)) panel.api.close();
    }
  }
  layoutSignatures.set(api, signature);

  const anchors = new Map<PanelLayout['dock'], string>();
  const emptyGroup = emptyGridGroup(api);
  let centerAnchor = claims
    .filter((claim): claim is PagePanelClaim => isPagePanelClaim(claim) && claim.layout.dock === 'fill')
    .map(panelId)
    .find((id) => isGridPanel(api, id));
  for (const claim of orderedClaims(claims)) {
    const id = panelId(claim);
    const existing = api.getPanel(id);
    if (existing) {
      // Runtime placement wins. Do not moveTo / re-add into claim.dock.
      if (isGridPanel(api, id)) {
        if (isPagePanelClaim(claim)) {
          if (!centerAnchor && claim.layout.dock === 'fill') centerAnchor = id;
          if (!anchors.has(claim.layout.dock)) anchors.set(claim.layout.dock, id);
        }
      }
      existing.api.setTitle(titleFor(claim));
      if (typeof existing.api.getParameters === 'function' && typeof existing.api.updateParameters === 'function') {
        const current = existing.api.getParameters();
        const nextClosable = isPanelClosable(claim) ? undefined : false;
        const closableChanged = (current.closable === false) !== (nextClosable === false);
        const titleKeyChanged = claim.titleKey !== current.titleKey;
        if (closableChanged || titleKeyChanged) {
          existing.api.updateParameters({
            ...current,
            ...(claim.titleKey === undefined ? {} : { titleKey: claim.titleKey }),
            closable: nextClosable,
          });
        }
      }
      attach(id);
      continue;
    }
    const position = placementFor(api, claim, anchors, centerAnchor, emptyGroup, shellBottom);
    const dock = layoutDock(claim);
    const pageLayout = isPagePanelClaim(claim) ? claim.layout : undefined;
    const horizontalSize = initialSize(pageLayout?.size, availableWidth);
    const verticalSize = initialSize(pageLayout?.size, availableHeight);
    const referenceHeight = isPagePanelClaim(claim) && claim.layout.dock === 'right-bottom'
      && position?.direction === 'below' && 'referencePanel' in position && typeof position.referencePanel === 'string'
      ? api.getPanel(position.referencePanel)?.group?.api.height
      : undefined;
    const splitHeight = dock === 'right-bottom' && position?.direction === 'below'
      ? initialSize({ value: 0.5, unit: 'fraction' }, referenceHeight && referenceHeight > 0 ? referenceHeight : availableHeight)
      : undefined;
    api.addPanel({
      id,
      component: 'slot',
      title: titleFor(claim),
      params: dockPanelParams(claim, attach),
      position,
      ...(position && position.direction === 'within' && 'referencePanel' in position ? { inactive: true } : {}),
      ...(horizontalSize === undefined || !['left', 'right', 'right-bottom'].includes(dock ?? '') || position?.direction === 'below'
        ? {}
        : { initialWidth: horizontalSize }),
      ...((verticalSize === undefined && splitHeight === undefined) || !['top', 'bottom', 'right-bottom'].includes(dock ?? '') || position?.direction === 'right'
        ? {}
        : { initialHeight: verticalSize ?? splitHeight }),
    });
    if (isPagePanelClaim(claim)) {
      if (!centerAnchor) centerAnchor = id;
      if (!anchors.has(claim.layout.dock)) anchors.set(claim.layout.dock, id);
    } else if (!centerAnchor) centerAnchor = id;
  }
}
