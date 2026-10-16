import type { AddPanelOptions, DockviewApi } from 'dockview';
import type { PanelClaim, PanelLayout } from '@forgeax/view-workspace-core/frontend-contract';

type ReconcileOptions = {
  titleFor?: (claim: PanelClaim) => string;
  attach?: (id: string) => void;
  availableWidth?: number;
  availableHeight?: number;
};

const DOCK_DIRECTION = Object.freeze({
  fill: 'right',
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
} as const);
const DOCK_ORDER = Object.freeze({
  fill: 0,
  top: 1,
  bottom: 2,
  left: 3,
  right: 4,
});
const layoutSignatures = new WeakMap<DockviewApi, string>();

function panelId(claim: PanelClaim) {
  return claim.id ?? claim.slot;
}

export function isPanelClosable(claim: PanelClaim | null | undefined) {
  return claim?.closable !== false;
}

function dockPanelParams(claim: PanelClaim, attach: (id: string) => void) {
  const id = panelId(claim);
  return {
    id,
    attach,
    layoutDock: claim.layout.dock,
    ...(claim.titleKey === undefined ? {} : { titleKey: claim.titleKey }),
    ...(isPanelClosable(claim) ? {} : { closable: false }),
  };
}

export function claimsForPage(claims: readonly PanelClaim[], pageType: string | null | undefined) {
  if (!pageType) return [];
  return claims.filter((claim) => claim.pageType === pageType);
}

function orderedClaims(claims: readonly PanelClaim[]) {
  return [...claims].sort(
    (left, right) =>
      (DOCK_ORDER[left.layout.dock] ?? 99) - (DOCK_ORDER[right.layout.dock] ?? 99) ||
      left.layout.order - right.layout.order ||
      panelId(left).localeCompare(panelId(right)),
  );
}

function layoutSignature(claims: readonly PanelClaim[]) {
  return JSON.stringify(
    orderedClaims(claims).map((claim) => [
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
  return Math.round(available * size.value);
}

function isGridPanel(api: DockviewApi, id: string) {
  return api.getPanel(id)?.group?.api.location.type === 'grid';
}

/**
 * Default home for a *new* panel only. Builds the multi-group grid from claim
 * anchors (left/right/bottom split from fill); edge groups are not used here.
 */
function placementFor(
  api: DockviewApi,
  claim: PanelClaim,
  anchors: ReadonlyMap<PanelLayout['dock'], string>,
  centerAnchor: string | undefined,
): AddPanelOptions['position'] {
  const dock = claim.layout.dock;
  const sameDock = anchors.get(dock);
  if (sameDock && isGridPanel(api, sameDock)) {
    return {
      direction: claim.layout.stack === 'tabs' ? 'within' : DOCK_DIRECTION[dock],
      referencePanel: sameDock,
    };
  }
  // An omitted position targets Dockview's active group, which may be an edge drawer.
  if (!centerAnchor || !isGridPanel(api, centerAnchor)) return { direction: 'right' };
  return {
    direction: dock === 'fill' ? 'within' : DOCK_DIRECTION[dock],
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
    availableWidth,
    availableHeight,
  }: ReconcileOptions = {},
) {
  const activeIds = new Set(claims.map(panelId));
  for (const panel of [...api.panels]) {
    if (!activeIds.has(panel.id)) panel.api.close();
  }
  // Retirement is immediate, but initial fractions need a visible extent.
  if ((availableWidth !== undefined && availableWidth <= 0) || (availableHeight !== undefined && availableHeight <= 0)) return;
  const signature = layoutSignature(claims);
  if (layoutSignatures.get(api) !== signature && api.panels.length > 0) {
    for (const panel of [...api.panels]) panel.api.close();
  }
  layoutSignatures.set(api, signature);

  const anchors = new Map<PanelLayout['dock'], string>();
  let centerAnchor = claims
    .filter((claim) => claim.layout.dock === 'fill')
    .map(panelId)
    .find((id) => isGridPanel(api, id));
  for (const claim of orderedClaims(claims)) {
    const id = panelId(claim);
    const existing = api.getPanel(id);
    if (existing) {
      // Runtime placement wins. Do not moveTo / re-add into claim.dock.
      if (isGridPanel(api, id)) {
        if (!centerAnchor && claim.layout.dock === 'fill') centerAnchor = id;
        if (!anchors.has(claim.layout.dock)) anchors.set(claim.layout.dock, id);
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
      continue;
    }
    const position = placementFor(api, claim, anchors, centerAnchor);
    const horizontalSize = initialSize(claim.layout.size, availableWidth);
    const verticalSize = initialSize(claim.layout.size, availableHeight);
    api.addPanel({
      id,
      component: 'slot',
      title: titleFor(claim),
      params: dockPanelParams(claim, attach),
      position,
      ...(horizontalSize === undefined || !['left', 'right'].includes(claim.layout.dock)
        ? {}
        : { initialWidth: horizontalSize }),
      ...(verticalSize === undefined || !['top', 'bottom'].includes(claim.layout.dock)
        ? {}
        : { initialHeight: verticalSize }),
    });
    if (!centerAnchor) centerAnchor = id;
    if (!anchors.has(claim.layout.dock)) anchors.set(claim.layout.dock, id);
  }
}
