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
  },
};

export { viewMaterialFrontendPlugin };
export default viewMaterialFrontendPlugin;
