import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { FRONTEND_PLUGIN_ID, FRONTEND_MODULE, PAGE_TYPE, PANEL_LAYOUT, SLOT, TITLE_I18N_KEY } from './identity.ts';

export const VIEW_CONTENT_BROWSER_FRONTEND_PLUGIN_ID = FRONTEND_PLUGIN_ID;
export const VIEW_CONTENT_BROWSER_FRONTEND_MODULE = FRONTEND_MODULE;

const viewContentBrowserFrontendPlugin = {
  name: VIEW_CONTENT_BROWSER_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewScenePage'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    const document = config.document ?? globalThis.document;
    const workspaceClient = ctx.get('viewOperationClient');
    const panelHost = config.panelHost ?? ctx.get('panelHost');
    if (!document?.createElement) return;
    if (!panelHost || typeof panelHost.claim !== 'function') {
      throw new TypeError('View content-browser Frontend Plugin requires panelHost');
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'fx-view-content-browser-host';
    wrapper.dataset.forgeaxView = 'content-browser-root';
    const reactMount = document.createElement('div');
    reactMount.className = 'fx-view-content-browser-ui';
    wrapper.append(reactMount);
    const unclaim = panelHost.claim({
      id: SLOT,
      pageType: PAGE_TYPE,
      titleKey: TITLE_I18N_KEY,
      activity: { labelKey: TITLE_I18N_KEY, icon: 'boxes' },
      layout: PANEL_LAYOUT,
    });
    let unmountSlot;
    let disposePanel;
    try {
      await panelHost.waitForSlot(SLOT);
      unmountSlot = panelHost.mount(SLOT, wrapper);
      disposePanel = await panelHost.mountPanelInto({
        element: reactMount,
        panel: 'ContentBrowser',
        props: { client: workspaceClient, pageHost: config.pageHost ?? ctx.get('pageHost', false), revealPanel: () => panelHost.reveal?.(SLOT) ?? Promise.resolve(false) },
      });
    } catch (error) {
      await disposePanel?.();
      unmountSlot?.();
      unclaim();
      throw error;
    }
    ctx.effect(() => async () => {
      await disposePanel?.();
      unmountSlot?.();
      unclaim();
    });
  },
};

export { viewContentBrowserFrontendPlugin };
export default viewContentBrowserFrontendPlugin;
