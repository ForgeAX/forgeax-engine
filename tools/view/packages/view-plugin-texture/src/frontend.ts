import type { Context } from '@forgeax/engine-plugin';
import type { FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import * as identity from './identity.ts';
import { applyResourcePagePlugin } from '@forgeax/view-workspace-core/resource-page';

export const VIEW_TEXTURE_FRONTEND_PLUGIN_ID = identity.FRONTEND_PLUGIN_ID;

const viewTextureFrontendPlugin = {
  name: VIEW_TEXTURE_FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  async apply(ctx: Context, config: FrontendConfig = {}) {
    await applyResourcePagePlugin(ctx, config, identity);
  },
};

export { viewTextureFrontendPlugin };
export default viewTextureFrontendPlugin;
