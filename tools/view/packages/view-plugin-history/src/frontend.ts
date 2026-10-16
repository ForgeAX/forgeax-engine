import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import { PAGE_TYPE, FRONTEND_PLUGIN_ID } from './identity.ts';
import { mountOperationHistory } from './ui/mount.ts';

export default {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  apply(ctx: Context, config: FrontendConfig = {}) {
    const pageHost = config.pageHost ?? ctx.get('pageHost', false);
    const document = config.document ?? globalThis.document;
    if (!document?.createElement) return;
    if (!pageHost) throw new Error('Operation history requires its native PageHost');
    const unregister = pageHost.registerType({
      context: 'project',
      typeId: PAGE_TYPE,
      titleKey: 'view.pages.history',
      order: 11,
      closable: true,
      singleton: true,
      initial: true,
      openable: true,
      layout: 'surface',
      showPanelRail: false,
      hideWhenInactive: true,
    });
    let dispose = () => {};
    let unmount = () => {};
    ctx.effect(() => () => {
      dispose();
      unmount();
      unregister();
    });
    const surface = document.createElement('section');
    surface.className = 'fx-view-operation-history';
    surface.dataset.forgeaxViewSurface = 'operation-history';
    dispose = mountOperationHistory({
      document,
      surface,
      client: ctx.get('viewOperationClient')!,
    });
    unmount = pageHost.mount(PAGE_TYPE, surface);
  },
};
