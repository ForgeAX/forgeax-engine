import type { AddPanelOptions, DockviewApi, DockviewDidDropEvent, DockviewGroupPanel, PanelTransfer } from 'dockview';
import type { PanelClaim, PanelDockLocation, PanelPlacement, SlotRegistry } from '@forgeax/view-workspace-core/frontend-contract';

export type DockviewOwner =
  | { kind: 'page'; pageId: string; pageType: string }
  | { kind: 'shell-bottom' };

export type DockviewInstance = { api: DockviewApi; owner: DockviewOwner; host?: HTMLElement };

export function shellHomeClaimForPanel(panelId: string, claims: readonly PanelClaim[]) {
  const claim = claims.find(candidate => candidate.id === panelId);
  return claim?.home.kind === 'shell-bottom' ? claim : undefined;
}

export function canTransferPanelBetweenDocks(
  sourceOwner: DockviewOwner | undefined,
  targetOwner: DockviewOwner | undefined,
  claim: PanelClaim | undefined,
) {
  if (claim?.home.kind !== 'shell-bottom') return false;
  return (sourceOwner?.kind === 'shell-bottom' && targetOwner?.kind === 'page')
    || (sourceOwner?.kind === 'page' && targetOwner?.kind === 'shell-bottom');
}

export function panelPlacementFor(
  owner: DockviewOwner | undefined,
  location: DockviewGroupPanel['api']['location']['type'] | undefined,
): PanelPlacement {
  if (!owner || !location) return { kind: 'unmounted' };
  const dockLocation: PanelDockLocation = location;
  return owner.kind === 'page'
    ? { kind: 'page', pageId: owner.pageId, pageType: owner.pageType, location: dockLocation }
    : { kind: 'shell-bottom', location: dockLocation };
}

export function transferSourceFor(
  data: PanelTransfer | undefined,
  targetApi: DockviewApi,
  instances: ReadonlyMap<string, DockviewInstance>,
  claims: readonly PanelClaim[],
) {
  if (!data?.panelId || data.viewId === targetApi.id || targetApi.getPanel(data.panelId)) return undefined;
  const source = instances.get(data.viewId)?.api;
  const claim = shellHomeClaimForPanel(data.panelId, claims);
  if (!source?.getPanel(data.panelId) || !claim) return undefined;
  return { source, panelId: data.panelId, claim };
}

export function panelPositionForDrop(event: Pick<DockviewDidDropEvent, 'position' | 'group'>): AddPanelOptions['position'] {
  const group = event.group;
  if (!group) return undefined;
  const direction = event.position === 'center'
    ? 'within'
    : event.position === 'top' ? 'above' : event.position === 'bottom' ? 'below' : event.position;
  return { direction, referenceGroup: group };
}

export function firstGridGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  return api.groups.find(group => group.api.location.type === 'grid');
}

export function ensureGridGroup(api: DockviewApi) {
  return firstGridGroup(api) ?? api.addGroup();
}

export function bottomEdgeGroup(api: DockviewApi) {
  return api.groups.find(group => group.api.location.type === 'edge' && group.api.location.position === 'bottom');
}

export function shellBottomPosition(api: DockviewApi): AddPanelOptions['position'] {
  const group = bottomEdgeGroup(api);
  if (!group) throw new Error('View Shell bottom edge drawer is not initialized');
  return { direction: 'within', referenceGroup: group };
}

function panelAnchor(api: DockviewApi, id: string) {
  const panel = api.getPanel(id);
  return [...(panel?.group?.element.querySelectorAll<HTMLElement>('[data-forgeax-view-slot]') ?? [])]
    .find(anchor => anchor.dataset.forgeaxViewSlot === id);
}

async function waitForPanelAnchor(api: DockviewApi, id: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const anchor = panelAnchor(api, id);
    if (anchor) return anchor;
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  throw new Error(`View panel slot did not mount after transfer: ${id}`);
}

export async function transferDockPanel({
  sourceApi,
  targetApi,
  id,
  claim,
  registry,
  title,
  position,
  sourceWasEdge: sourceWasEdgeOverride,
}: {
  sourceApi: DockviewApi;
  targetApi: DockviewApi;
  id: string;
  claim: PanelClaim;
  registry: SlotRegistry;
  title: string;
  position?: AddPanelOptions['position'];
  sourceWasEdge?: boolean;
}) {
  if (claim.home.kind !== 'shell-bottom') throw new Error(`Only Shell-bottom panels can transfer between docks: ${id}`);
  if (sourceApi.id === targetApi.id || !sourceApi.getPanel(id)) return false;
  if (targetApi.getPanel(id)) throw new Error(`View panel already exists in the destination dock: ${id}`);

  const sourcePanel = sourceApi.getPanel(id)!;
  const sourceWasEdge = sourceWasEdgeOverride ?? sourcePanel.api.location.type === 'edge';
  const sourceAnchor = panelAnchor(sourceApi, id);
  if (!sourceAnchor) throw new Error(`View panel slot is not attached to its source dock: ${id}`);
  const mountHost = registry.resolve(id, sourceAnchor);
  const referenceGroup = position && 'referenceGroup' in position ? position.referenceGroup : undefined;
  let targetWasEdge = typeof referenceGroup !== 'string' && referenceGroup?.api.location.type === 'edge';

  try {
    const sourceParams = sourcePanel.api.getParameters();
    targetApi.addPanel({
      id,
      component: 'slot',
      title,
      params: {
        ...sourceParams,
        id,
        attach: (panelId: string, anchor?: HTMLElement) => registry.resolve(panelId, anchor),
      },
      ...(position === undefined ? {} : { position }),
    });
    const destinationPanel = targetApi.getPanel(id);
    targetWasEdge ||= destinationPanel?.api.location.type === 'edge';
    const destinationAnchor = await waitForPanelAnchor(targetApi, id);
    if (registry.resolve(id, destinationAnchor) !== mountHost || mountHost.parentNode !== destinationAnchor) {
      throw new Error(`View panel mount host did not attach to its destination dock: ${id}`);
    }
    sourcePanel.api.close();
    if (sourceApi.getPanel(id)) throw new Error(`View panel remained in its source dock after transfer: ${id}`);
    if (!sourceWasEdge) ensureGridGroup(sourceApi);
    if (!targetWasEdge) ensureGridGroup(targetApi);
    return true;
  } catch (error) {
    targetWasEdge ||= targetApi.getPanel(id)?.api.location.type === 'edge';
    targetApi.getPanel(id)?.api.close();
    if (sourceApi.getPanel(id)) {
      registry.resolve(id, sourceAnchor);
      if (!sourceWasEdge) ensureGridGroup(sourceApi);
    }
    if (!targetWasEdge) ensureGridGroup(targetApi);
    throw error;
  }
}
