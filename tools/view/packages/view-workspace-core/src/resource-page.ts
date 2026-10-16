import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig, ResourceIdentity, PanelLayout, PanelMount, PageTypeContribution, PageHost, PanelHost, Dispose } from './frontend-contract.ts';
import type { ViewPresentation, PresentationConfig } from './engine-presentation.ts';
import type { ViewWorkspaceClient } from './client.ts';
import { liveEnginePresentation } from './engine-presentation.ts';
import { dedicatedPreviewPresentation } from './preview-surface.ts';
import { logResourceOpen } from './resource-open.ts';

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

export function createResourcePageTypeContribution(identity: ResourceIdentity): PageTypeContribution {
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
    priority: identity.PAGE_PRIORITY,
  };
}

export function createResourcePanelClaims(identity: ResourceIdentity, props: { client?: ViewWorkspaceClient; presentation?: ViewPresentation; previewProps?: Record<string, unknown> } = {}) {
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
    props: { client: props.client },
  });
  return Object.freeze(claims);
}

export async function applyResourcePagePlugin(ctx: Context, config: FrontendConfig & PresentationConfig, identity: ResourceIdentity, extras: { previewProps?: Record<string, unknown> } = {}) {
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

async function mountResourcePage(ctx: Context, config: FrontendConfig & PresentationConfig, identity: ResourceIdentity, pageHost: PageHost, panelHost: PanelHost, extras: { previewProps?: Record<string, unknown> } = {}) {
  const presentation = liveEnginePresentation(ctx, config);
  const unregisterPageType = pageHost.registerType(createResourcePageTypeContribution(identity));
  logResourceOpen('resource-page-registered', {
    pageType: identity.PAGE_TYPE,
    kinds: identity.RESOURCE_SELECTOR?.kinds ?? null,
  });
  const workspaceClient = ctx.get('viewOperationClient');
  const disposers: Dispose[] = [];
  ctx.effect(() => async () => {
    for (const dispose of [...disposers].reverse()) await dispose?.();
    unregisterPageType();
  });
  try {
    for (const claim of createResourcePanelClaims(identity, {
      client: workspaceClient,
      presentation,
      previewProps: extras.previewProps,
    })) {
      disposers.push(await panelHost.mountPanel(claim));
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) await dispose?.();
    unregisterPageType();
    throw error;
  }
}
