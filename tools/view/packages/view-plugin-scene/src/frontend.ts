import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { createEditorPageTitleController } from '@forgeax/view-workspace-core/page-title';
import { FRONTEND_PLUGIN_ID, PAGE_TYPE } from './identity.ts';

export {
  FRONTEND_PLUGIN_ID as SCENE_PAGE_PLUGIN_ID,
  FRONTEND_MODULE as SCENE_PAGE_MODULE,
} from './identity.ts';

/** The page owns its tab; scene panels depend on its reversible capability. */
export default {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  provide: ['viewScenePage'],
  apply(ctx: Context, config: FrontendConfig = {}) {
    const pageHost = config.pageHost ?? ctx.get?.('pageHost', false);
    const unregister = pageHost?.registerType({
      context: 'project',
      typeId: PAGE_TYPE,
      titleKey: 'view.pages.editor',
      order: 0,
      closable: false,
      singleton: true,
      initial: true,
      openable: false,
      layout: 'dock',
      showPanelRail: false,
      hideWhenInactive: true,
      resourceSelector: { kinds: ['scene'] },
      resourcePresentation: 'preview',
      priority: 10,
      createController: () => createEditorPageTitleController(ctx.get('viewOperationClient')),
    });
    if (unregister) ctx.effect(() => unregister);
    ctx.provide('viewScenePage', { typeId: PAGE_TYPE });
  },
};
