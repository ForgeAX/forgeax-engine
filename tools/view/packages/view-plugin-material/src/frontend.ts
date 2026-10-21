import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import * as identity from './identity.ts';
import { applyResourcePagePlugin } from '@forgeax/view-workspace-core/resource-page';

export const VIEW_MATERIAL_FRONTEND_PLUGIN_ID = identity.FRONTEND_PLUGIN_ID;
export const VIEW_MATERIAL_FRONTEND_MODULE = identity.FRONTEND_MODULE;

const viewMaterialFrontendPlugin = {
  name: VIEW_MATERIAL_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    await applyResourcePagePlugin(ctx, config, identity, {
      previewProps: {
        inputControllerFactory: () => ctx.get('viewPreviewInputController', false),
      },
    });
    const panelHost = config.panelHost ?? ctx.get('panelHost', false);
    if (!panelHost) return;
    const dispose = await panelHost.mountPanel({
      id: identity.STATS_SLOT, pageType: identity.PAGE_TYPE, titleKey: 'view.slots.materialStats', closable: true,
      activity: { labelKey: 'view.slots.materialStats', icon: 'detail' },
      layout: { dock: 'bottom', size: { value: 200, unit: 'px' }, stack: 'tabs', order: 2 },
      panel: 'MaterialStats', props: { client: ctx.get('viewOperationClient') },
    });
    ctx.effect(() => dispose);
  },
};

export { viewMaterialFrontendPlugin };
export default viewMaterialFrontendPlugin;
