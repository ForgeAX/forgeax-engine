import type { ViewFrontendConfig } from './config.ts';
import type { Plugin } from '@forgeax/engine-plugin';
import displayPlugin from '@forgeax/view-plugin-display/frontend';
import pluginsPlugin from '@forgeax/view-plugin-plugins/frontend';
import inspectorPlugin from '@forgeax/view-plugin-inspector/frontend';
import contentBrowserPlugin from '@forgeax/view-plugin-content-browser/frontend';
import sceneTreePlugin from '@forgeax/view-plugin-scene-tree/frontend';
import materialPlugin from '@forgeax/view-plugin-material/frontend';
import meshPlugin from '@forgeax/view-plugin-mesh/frontend';
import texturePlugin from '@forgeax/view-plugin-texture/frontend';
import assetPlugin from '@forgeax/view-plugin-asset/frontend';
import viewportPlugin from '@forgeax/view-plugin-viewport/frontend';
import workspaceCorePlugin from './host/workspace-frontend.ts';
import scenePagePlugin from '@forgeax/view-plugin-scene/frontend';
import shellPlugin, { SHELL_MODULE } from './plugins/shell.ts';
import presentationPlugin, { PRESENTATION_MODULE } from '@forgeax/view-plugin-viewport/presentation';
import * as displayIdentity from '@forgeax/view-plugin-display/identity';
import * as pluginsIdentity from '@forgeax/view-plugin-plugins/identity';
import * as inspectorIdentity from '@forgeax/view-plugin-inspector/identity';
import * as contentBrowserIdentity from '@forgeax/view-plugin-content-browser/identity';
import * as sceneTreeIdentity from '@forgeax/view-plugin-scene-tree/identity';
import * as materialIdentity from '@forgeax/view-plugin-material/identity';
import * as meshIdentity from '@forgeax/view-plugin-mesh/identity';
import * as textureIdentity from '@forgeax/view-plugin-texture/identity';
import * as assetIdentity from '@forgeax/view-plugin-asset/identity';
import * as viewportIdentity from '@forgeax/view-plugin-viewport/identity';
import * as sceneIdentity from '@forgeax/view-plugin-scene/identity';
import htmlUiPlugin from '@forgeax/view-plugin-html/frontend';
import historyPlugin from '@forgeax/view-plugin-history/frontend';
import * as historyIdentity from '@forgeax/view-plugin-history/identity';
import * as htmlIdentity from '@forgeax/view-plugin-html/identity';
import assetReferencesPlugin from '@forgeax/view-plugin-asset-references/frontend';
import * as assetReferencesIdentity from '@forgeax/view-plugin-asset-references/identity';

import {
  VIEW_PLUGIN_VERSION,
  VIEW_PRODUCT_PLUGINS,
  VIEW_WORKSPACE_CORE,
} from './catalog-shared.ts';

const implementations = new Map<string, Plugin.Object<ViewFrontendConfig>>([
  [assetReferencesIdentity.FRONTEND_MODULE, assetReferencesPlugin],
  [VIEW_WORKSPACE_CORE.FRONTEND_MODULE, workspaceCorePlugin],
  [sceneIdentity.FRONTEND_MODULE, scenePagePlugin],
  [displayIdentity.FRONTEND_MODULE, displayPlugin],
  [viewportIdentity.FRONTEND_MODULE, viewportPlugin],
  [contentBrowserIdentity.FRONTEND_MODULE, contentBrowserPlugin],
  [pluginsIdentity.FRONTEND_MODULE, pluginsPlugin],
  [inspectorIdentity.FRONTEND_MODULE, inspectorPlugin],
  [sceneTreeIdentity.FRONTEND_MODULE, sceneTreePlugin],
  [materialIdentity.FRONTEND_MODULE, materialPlugin],
  [meshIdentity.FRONTEND_MODULE, meshPlugin],
  [textureIdentity.FRONTEND_MODULE, texturePlugin],
  [assetIdentity.FRONTEND_MODULE, assetPlugin],
  [htmlIdentity.FRONTEND_MODULE, htmlUiPlugin],
  [historyIdentity.FRONTEND_MODULE, historyPlugin],
]);

// Asset type-preview pages borrow the App-owned surface. Starting them before
// the App publishes its presentation would leave required descendants pending
// and prevent Engine's native frontend root from activating.
// Viewport is not in this set: its fill dock is claimed with the other editor
// panels as soon as the scene page exists. Play/Engine only delay DOM inside
// that already-claimed slot, and must not inject engineWorkspacePresentation
// on the viewport plugin itself.
const presentationPages = new Set([
  materialIdentity.FRONTEND_MODULE,
  meshIdentity.FRONTEND_MODULE,
  textureIdentity.FRONTEND_MODULE,
  assetIdentity.FRONTEND_MODULE,
]);

export const VIEW_PRODUCT_FRONTEND_CATALOG = new Map<string, { realm: 'engine'; version: string; requiresWorkspacePresentation?: boolean; load: () => Promise<{ default: Plugin.Object<ViewFrontendConfig> }> }>(
  [VIEW_WORKSPACE_CORE, assetReferencesIdentity, ...VIEW_PRODUCT_PLUGINS].map((plugin) => [
    plugin.FRONTEND_MODULE,
    {
      realm: 'engine',
      version: VIEW_PLUGIN_VERSION,
      requiresWorkspacePresentation: presentationPages.has(plugin.FRONTEND_MODULE),
      load: async () => {
        const implementation = implementations.get(plugin.FRONTEND_MODULE);
        if (!implementation) throw new Error(`View frontend implementation is missing: ${plugin.FRONTEND_MODULE}`);
        return { default: implementation };
      },
    },
  ]),
);

for (const [name, plugin] of [[SHELL_MODULE, shellPlugin], [PRESENTATION_MODULE, presentationPlugin]] as const) {
  VIEW_PRODUCT_FRONTEND_CATALOG.set(name, {
    realm: 'engine',
    version: VIEW_PLUGIN_VERSION,
    load: async () => ({ default: plugin }),
  });
}
