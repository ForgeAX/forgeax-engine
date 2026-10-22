import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig, ResourceIdentity, PanelLayout, PanelMount, PageTypeContribution, PageHost, PanelHost, Dispose, ResourceAssetActionResolver } from './frontend-contract.ts';
import type { ViewPresentation, PresentationConfig } from './engine-presentation.ts';
import type { ViewWorkspaceClient } from './client.ts';
import { liveEnginePresentation } from './engine-presentation.ts';
import { dedicatedPreviewPresentation } from './preview-surface.ts';
import { logResourceOpen } from './resource-open.ts';
import { createResourcePageController } from './resource-page-controller.ts';
import { createWorkspaceStateReader } from './workspace-state.ts';
import { reportWorkspaceCommandError } from './command-error.ts';

export const RESOURCE_PREVIEW_LAYOUT = Object.freeze<PanelLayout>({
  dock: 'fill',
  stack: 'tabs',
  order: 0,
});

export const RESOURCE_PROPERTIES_LAYOUT = Object.freeze<PanelLayout>({
  dock: 'right',
  size: Object.freeze({ value: 0.36, unit: 'fraction' }),
  stack: 'tabs',
  order: 1,
});

export const RESOURCE_FALLBACK_LAYOUT = Object.freeze<PanelLayout>({
  dock: 'fill',
  stack: 'tabs',
  order: 0,
});

export function createResourcePageTypeContribution(identity: ResourceIdentity, createController?: PageTypeContribution['createController']): PageTypeContribution {
  return {
    typeId: identity.PAGE_TYPE,
    context: 'project',
    titleKey: identity.PAGE_TITLE_I18N_KEY,
    order: identity.PAGE_ORDER,
    closable: true,
    singleton: true,
    initial: false,
    openable: true,
    layout: 'dock',
    showPanelRail: true,
    hideWhenInactive: true,
    resourceSelector: identity.RESOURCE_SELECTOR,
    resourcePresentation: identity.PREVIEW_SLOT ? 'preview' : 'details',
    priority: identity.PAGE_PRIORITY,
    ...(createController ? { createController } : {}),
  };
}

export function createResourcePanelClaims(identity: ResourceIdentity, props: { client?: ViewWorkspaceClient; presentation?: ViewPresentation; previewProps?: Record<string, unknown>; assetActions?: ResourceAssetActionResolver } = {}) {
  const claims: PanelMount[] = [];
  if (identity.PREVIEW_SLOT) {
    const owner = Object.freeze({
      panelId: identity.PREVIEW_SLOT,
      pageType: identity.PAGE_TYPE,
    });
    claims.push({
      id: identity.PREVIEW_SLOT,
      pageType: identity.PAGE_TYPE,
      titleKey: identity.PREVIEW_TITLE_I18N_KEY,
      activity: { labelKey: identity.PREVIEW_TITLE_I18N_KEY, icon: identity.PREVIEW_ICON },
      layout: identity.PREVIEW_LAYOUT ?? RESOURCE_PREVIEW_LAYOUT,
      panel: identity.PREVIEW_PANEL ?? identity.PREVIEW_SLOT,
      props: {
        client: props.client,
        presentation: dedicatedPreviewPresentation(props.presentation, owner),
        owner,
        ...props.previewProps,
      },
    });
  }
  claims.push({
    id: identity.PROPERTIES_SLOT,
    pageType: identity.PAGE_TYPE,
    titleKey: identity.PROPERTIES_TITLE_I18N_KEY,
    activity: { labelKey: identity.PROPERTIES_TITLE_I18N_KEY, icon: identity.PROPERTIES_ICON },
    layout: identity.PROPERTIES_LAYOUT,
    panel: identity.PROPERTIES_PANEL,
    props: { client: props.client, ...(props.assetActions ? { assetActions: props.assetActions } : {}) },
  });
  return Object.freeze(claims);
}

type ResourcePageExtras = { previewProps?: Record<string, unknown>; createController?: PageTypeContribution['createController'] };

export async function applyResourcePagePlugin(ctx: Context, config: FrontendConfig & PresentationConfig, identity: ResourceIdentity, extras: ResourcePageExtras = {}) {
  const panelHost = config.panelHost ?? ctx.get?.('panelHost', false);
  if (!panelHost) {
    logResourceOpen('resource-page-skipped', {
      reason: 'panel-host-missing',
      pageType: identity?.PAGE_TYPE ?? null,
    }, { level: 'warn' });
    return;
  }
  const pageHost = config.pageHost ?? ctx.get?.('pageHost', false);
  if (!pageHost) {
    throw new TypeError(`View ${identity.PAGE_TYPE} Frontend Plugin requires pageHost`);
  }
  return mountResourcePage(ctx, config, identity, pageHost, panelHost, extras);
}

async function mountResourcePage(ctx: Context, config: FrontendConfig & PresentationConfig, identity: ResourceIdentity, pageHost: PageHost, panelHost: PanelHost, extras: ResourcePageExtras = {}) {
  const presentation = liveEnginePresentation(ctx, config);
  let resourcePresentation: ViewPresentation | undefined;
  let resourceController: ReturnType<typeof createResourcePageController> | undefined;
  const unregisterPageType = pageHost.registerType(createResourcePageTypeContribution(identity, extras.createController
    ?? (() => resourceController = createResourcePageController(ctx.get('viewOperationClient'), identity.RESOURCE_SELECTOR.kinds ?? [], async target => { await resourcePresentation?.releaseSurface?.(target); }))));
  logResourceOpen('resource-page-registered', {
    pageType: identity.PAGE_TYPE,
    kinds: identity.RESOURCE_SELECTOR?.kinds ?? null,
  });
  const workspaceClient = ctx.get('viewOperationClient');
  const reader = createWorkspaceStateReader(workspaceClient);
  ctx.effect(() => {
    const stop = reader.subscribe(() => {});
    return () => { stop(); reader.dispose(); };
  });
  const assetActions: ResourceAssetActionResolver = value => {
    const guid = typeof value === 'string' ? value : value && typeof value === 'object' && 'guid' in value && typeof value.guid === 'string' ? value.guid : undefined;
    const snapshot = reader.getSnapshot();
    if (!guid || !snapshot?.assets?.some(asset => asset.guid === guid)) return;
    const scope = ctx.get('viewAssetReferences', false)?.getState().scope;
    const target = snapshot.scenePreview?.target ?? snapshot.projectTarget;
    if (!snapshot.project || !target) return;
    const input = { projectId: snapshot.project.id, targetId: target.targetId, targetGeneration: target.generation, guid };
    const current = () => {
      const now = reader.getSnapshot();
      const activeTarget = now?.scenePreview?.target ?? now?.projectTarget;
      return now?.project?.id === input.projectId && activeTarget?.targetId === input.targetId && activeTarget?.generation === input.targetGeneration;
    };
    const open = () => current() ? ctx.get('viewAssetReferences', false)?.open(guid)
      ?? workspaceClient?.call('asset.open', input) : undefined;
    return { onOpen: () => { void Promise.resolve(open()).catch(error => reportWorkspaceCommandError(error)); },
      ...(ctx.get('viewAssetBrowser', false)?.available() ? { onBrowse: () => {
        if (!current()) return;
        void ctx.get('viewAssetBrowser', false)?.revealAsset({ ...input, ...(scope ?? {}) }).then(ok => {
          if (!ok) throw new Error('asset-browser-reveal-unavailable');
        }).catch(error => reportWorkspaceCommandError(error));
      } } : {}) };
  };
  const disposers: Dispose[] = [];
  ctx.effect(() => async () => {
    try { await resourceController?.beforeClose?.(new AbortController().signal); }
    finally {
      for (const dispose of [...disposers].reverse()) await dispose?.();
      unregisterPageType();
    }
  });
  try {
    for (const claim of createResourcePanelClaims(identity, {
      client: workspaceClient,
      presentation,
      previewProps: extras.previewProps,
      assetActions,
    })) {
      if (claim.id === identity.PREVIEW_SLOT) resourcePresentation = claim.props?.presentation as ViewPresentation | undefined;
      disposers.push(await panelHost.mountPanel(claim));
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) await dispose?.();
    unregisterPageType();
    throw error;
  }
}
