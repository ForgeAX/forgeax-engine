import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig, Dispose } from '@forgeax/view-workspace-core/frontend-contract';
import { FRONTEND_PLUGIN_ID, FRONTEND_MODULE } from './identity.ts';
import { PAGE_TYPE, PANEL_LAYOUT, SLOT, TITLE_I18N_KEY } from './identity.ts';

export const VIEW_PLUGINS_FRONTEND_PLUGIN_ID = FRONTEND_PLUGIN_ID;
export const VIEW_PLUGINS_FRONTEND_MODULE = FRONTEND_MODULE;

const viewPluginsListFrontendPlugin = {
  name: VIEW_PLUGINS_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewInspectorClient'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const panelHost = config.panelHost ?? ctx.get?.('panelHost', false);
    if (!panelHost) return;
    const pageHost = config.pageHost ?? ctx.get?.('pageHost', false);
    if (!pageHost) throw new TypeError('View plugins Frontend Plugin requires pageHost');
    const unregisterPageType = pageHost.registerType({
      context: 'project',
      typeId: PAGE_TYPE,
      titleKey: 'view.pages.plugins',
      order: 20,
      closable: true,
      singleton: true,
      initial: false,
      openable: true,
      layout: 'dock',
      showPanelRail: true,
      hideWhenInactive: true,
    });
    const workspaceClient = ctx.get('viewOperationClient');
    const transport = ctx.get?.('hostTransport', false);
    let disposePanel: Dispose | undefined;
    ctx.effect(() => async () => {
      await disposePanel?.();
      unregisterPageType();
    });
    disposePanel = await panelHost.mountPanel({
      id: SLOT,
      pageType: PAGE_TYPE,
      titleKey: TITLE_I18N_KEY,
      activity: { labelKey: TITLE_I18N_KEY, icon: 'package' },
      layout: PANEL_LAYOUT,
      panel: 'Plugins',
      props: {
        client: ctx.get('viewInspectorClient', false),
        workspaceClient,
        hostAssembly: ctx.get?.('hostAssembly', false),
        connectionId: transport && 'caller' in transport ? transport.caller.connectionId : undefined,
      },
    });
  },
};

export { viewPluginsListFrontendPlugin };
export default viewPluginsListFrontendPlugin;
