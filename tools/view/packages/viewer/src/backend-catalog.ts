import type { Plugin } from '@forgeax/engine-plugin';
import displayPlugin from '@forgeax/view-plugin-display/backend';
import pluginsPlugin from '@forgeax/view-plugin-plugins/backend';
import workspaceCorePlugin from '@forgeax/view-workspace-core/backend';
import * as displayIdentity from '@forgeax/view-plugin-display/identity';
import * as pluginsIdentity from '@forgeax/view-plugin-plugins/identity';

import {
  VIEW_PLUGIN_VERSION,
  VIEW_PRODUCT_PLUGINS,
  VIEW_WORKSPACE_CORE,
} from './catalog-shared.ts';

const implementations = new Map<string, Plugin>([
  [VIEW_WORKSPACE_CORE.BACKEND_MODULE, workspaceCorePlugin],
  [displayIdentity.BACKEND_MODULE, displayPlugin],
  [pluginsIdentity.BACKEND_MODULE, pluginsPlugin],
]);

export const VIEW_PRODUCT_BACKEND_CATALOG = new Map<string, { realm: 'host'; version: string; load: () => Promise<{ default: Plugin }> }>(
  [VIEW_WORKSPACE_CORE, ...VIEW_PRODUCT_PLUGINS].filter(plugin => 'BACKEND_MODULE' in plugin).map((plugin) => [
    plugin.BACKEND_MODULE,
    {
      realm: 'host',
      version: VIEW_PLUGIN_VERSION,
      load: async () => {
        const implementation = implementations.get(plugin.BACKEND_MODULE);
        if (!implementation) throw new Error(`View backend implementation is missing: ${plugin.BACKEND_MODULE}`);
        return { default: implementation };
      },
    },
  ]),
);
