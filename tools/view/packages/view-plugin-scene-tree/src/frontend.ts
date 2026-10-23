import type { Context } from '@forgeax/engine-plugin';
import type { AssetBrowserReveal, FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { FRONTEND_PLUGIN_ID, FRONTEND_MODULE } from './identity.ts';
import { PAGE_TYPE, PANEL_LAYOUT, SLOT, TITLE_I18N_KEY } from './identity.ts';

export const VIEW_SCENE_TREE_FRONTEND_PLUGIN_ID = FRONTEND_PLUGIN_ID;
export const VIEW_SCENE_TREE_FRONTEND_MODULE = FRONTEND_MODULE;

const viewSceneTreeFrontendPlugin = {
  name: VIEW_SCENE_TREE_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewScenePage'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const panelHost = config.panelHost ?? ctx.get?.('panelHost', false);
    if (!panelHost) return;
    const workspaceClient = ctx.get('viewOperationClient');
    const disposePanel = await panelHost.mountPanel({
      id: SLOT,
      home: { kind: 'page', pageType: PAGE_TYPE },
      titleKey: TITLE_I18N_KEY,
      activity: { labelKey: TITLE_I18N_KEY, icon: 'tree' },
      layout: PANEL_LAYOUT,
      panel: 'SceneTree',
      props: {
        client: workspaceClient,
        assetReferences: ctx.get('viewAssetReferences', false),
        browseAsset: (input: AssetBrowserReveal) =>
          ctx.get('viewAssetBrowser', false)?.revealAsset(input) ?? Promise.resolve(false),
        canBrowseAsset: () => ctx.get('viewAssetBrowser', false)?.available() ?? false,
      },
    });
    ctx.effect(() => async () => {
      await disposePanel?.();
    });
  },
};

export { viewSceneTreeFrontendPlugin };
export default viewSceneTreeFrontendPlugin;
