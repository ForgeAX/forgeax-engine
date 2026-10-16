import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { FRONTEND_PLUGIN_ID, FRONTEND_MODULE } from './identity.ts';
import { PAGE_TYPE, PANEL_LAYOUT, SLOT, TITLE_I18N_KEY } from './identity.ts';

export const VIEW_OBJECT_INSPECTOR_FRONTEND_PLUGIN_ID = FRONTEND_PLUGIN_ID;
export const VIEW_OBJECT_INSPECTOR_FRONTEND_MODULE = FRONTEND_MODULE;

const viewObjectInspectorFrontendPlugin = {
  name: VIEW_OBJECT_INSPECTOR_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewScenePage'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const panelHost = config.panelHost ?? ctx.get?.('panelHost', false);
    if (!panelHost) return;
    const workspaceClient = ctx.get('viewOperationClient');
    const disposePanel = await panelHost.mountPanel({
      id: SLOT,
      pageType: PAGE_TYPE,
      titleKey: TITLE_I18N_KEY,
      activity: { labelKey: TITLE_I18N_KEY, icon: 'detail' },
      layout: PANEL_LAYOUT,
      panel: 'Inspector',
      props: { client: workspaceClient, assetReferences: ctx.get('viewAssetReferences', false),
        browseAsset: (guid: string) => {
          const scope = ctx.get('viewAssetReferences', false)?.getState().scope;
          return scope ? ctx.get('viewAssetBrowser', false)?.revealAsset({ ...scope, guid }) ?? Promise.resolve(false) : Promise.resolve(false);
        } },
    });
    ctx.effect(() => async () => {
      await disposePanel?.();
    });
  },
};

export { viewObjectInspectorFrontendPlugin };
export default viewObjectInspectorFrontendPlugin;
