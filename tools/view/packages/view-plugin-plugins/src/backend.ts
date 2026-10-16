import type { Context } from '@forgeax/engine-plugin';
import type { InspectorBackendConfig } from './runtime.ts';
import { BACKEND_PLUGIN_ID, BACKEND_MODULE } from './identity.ts';
import { viewInspectorBackendPlugin } from './runtime.ts';

export const VIEW_PLUGINS_PLUGIN_ID = BACKEND_PLUGIN_ID;
export const VIEW_PLUGINS_MODULE = BACKEND_MODULE;

/** Plugin manifest inspection (plugins.* operations). */
export const viewPluginsListBackendPlugin = {
  name: VIEW_PLUGINS_PLUGIN_ID,
  inject: ['viewWorkspaceAccessToken', 'hostTransport'],
  provide: ['viewInspector'],
  async apply(ctx: Context, config: InspectorBackendConfig = {}) {
    const accessToken = ctx.get('viewWorkspaceAccessToken');
    if (!accessToken) {
      throw new Error('View plugins-list backend requires the shared workspace session');
    }
    return viewInspectorBackendPlugin.apply(ctx, {
      ...config,
      accessToken,
    });
  },
};

export default viewPluginsListBackendPlugin;
