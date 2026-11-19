import type { Plugin } from '@forgeax/engine-plugin';
import * as displayIdentity from '@forgeax/view-plugin-display/identity';
import * as pluginsIdentity from '@forgeax/view-plugin-plugins/identity';

import {
  VIEW_PLUGIN_VERSION,
  VIEW_PRODUCT_PLUGINS,
  VIEW_WORKSPACE_CORE,
} from './catalog-shared.ts';

const loaders = new Map<string, () => Promise<{ default: Plugin }>>([
  [VIEW_WORKSPACE_CORE.BACKEND_MODULE, () => import('@forgeax/view-workspace-core/backend')],
  [displayIdentity.BACKEND_MODULE, () => import('@forgeax/view-plugin-display/backend')],
  [pluginsIdentity.BACKEND_MODULE, () => import('@forgeax/view-plugin-plugins/backend')],
]);

export const VIEW_PRODUCT_BACKEND_CATALOG = new Map<string, { realm: 'host'; version: string; load: () => Promise<{ default: Plugin }> }>(
  [VIEW_WORKSPACE_CORE, ...VIEW_PRODUCT_PLUGINS].filter(plugin => 'BACKEND_MODULE' in plugin).map((plugin) => [
    plugin.BACKEND_MODULE,
    {
      realm: 'host',
      version: VIEW_PLUGIN_VERSION,
      load: loaders.get(plugin.BACKEND_MODULE) ?? (() => Promise.reject(
        new Error(`View backend implementation is missing: ${plugin.BACKEND_MODULE}`),
      )),
    },
  ]),
);
