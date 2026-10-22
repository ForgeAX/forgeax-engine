import type { ViewFrontendConfig } from './config.ts';
import type { EngineWorkspaceProvider } from '@forgeax/engine/app';
import type { ViewPlatform, CarrierCapabilities } from '@forgeax/view-plugin-display/carrier-contract';
import type { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
export type ViewBackendProductConfig = {
  platform?: ViewPlatform; capabilities?: Partial<CarrierCapabilities>; workspaceEngine?: EngineWorkspaceProvider;
  workspaceAccessToken?: string; workspaceAuthorize?: NonNullable<ConstructorParameters<typeof ViewWorkspaceBroker>[0]>['authorize'];
  packSources?: NonNullable<ConstructorParameters<typeof ViewWorkspaceBroker>[0]>['packSources'];
};
import buildRevision from './build-identity.ts';
import * as display from '@forgeax/view-plugin-display/identity';
import * as plugins from '@forgeax/view-plugin-plugins/identity';
import * as inspector from '@forgeax/view-plugin-inspector/identity';
import * as contentBrowser from '@forgeax/view-plugin-content-browser/identity';
import * as sceneTree from '@forgeax/view-plugin-scene-tree/identity';
import * as material from '@forgeax/view-plugin-material/identity';
import * as mesh from '@forgeax/view-plugin-mesh/identity';
import * as texture from '@forgeax/view-plugin-texture/identity';
import * as asset from '@forgeax/view-plugin-asset/identity';
import * as viewport from '@forgeax/view-plugin-viewport/identity';
import * as scene from '@forgeax/view-plugin-scene/identity';
import * as html from '@forgeax/view-plugin-html/identity';
import * as history from '@forgeax/view-plugin-history/identity';
import * as assetReferences from '@forgeax/view-plugin-asset-references/identity';
import { PARAMETERS_FRONTEND_MODULE, PARAMETERS_FRONTEND_PLUGIN_ID } from '@forgeax/view-plugin-parameters/identity';

import { SHELL_MODULE, SHELL_PLUGIN_ID } from './plugins/shell-identity.ts';
import { PRESENTATION_MODULE, PRESENTATION_PLUGIN_ID } from '@forgeax/view-plugin-viewport/presentation-identity';

export const VIEW_PLUGIN_VERSION = '0.2.0';
export const VIEW_FRONTEND_ROOT_PROGRAM = '@forgeax/view/frontend-root';
export const VIEW_FRONTEND_MODULE = Object.freeze({ specifier: VIEW_FRONTEND_ROOT_PROGRAM });

export function viewFrontendRoot(frontendConfig: ViewFrontendConfig | undefined, disabledPages: readonly string[] = []) {
  return Object.freeze({
    program: VIEW_FRONTEND_ROOT_PROGRAM,
    codeRevision: buildRevision,
    config: { frontendConfig, disabledPages },
  });
}

export const VIEW_WORKSPACE_CORE = Object.freeze({
  BACKEND_PLUGIN_ID: 'forgeax.view.service.workspace.backend',
  FRONTEND_PLUGIN_ID: 'forgeax.view.service.workspace-client.frontend',
  BACKEND_MODULE: '@forgeax/view-workspace-core/backend',
  FRONTEND_MODULE: '@forgeax/view/workspace-frontend',
});

export const VIEW_PRODUCT_PLUGINS = Object.freeze([
  scene,
  display,
  viewport,
  contentBrowser,
  plugins,
  inspector,
  sceneTree,
  material,
  mesh,
  texture,
  asset,
  html,
  history,
]);

export const VIEW_CAPABILITY_FRONTEND_PLUGINS = Object.freeze([
  Object.freeze({ FRONTEND_PLUGIN_ID: PARAMETERS_FRONTEND_PLUGIN_ID, FRONTEND_MODULE: PARAMETERS_FRONTEND_MODULE }),
]);

/** Static native composition. Pack assets own game plugin identity; View owns only its UI policy. */
export function createViewProductPlan({ backendConfig, frontendConfig, disabledPages = [] }: { backendConfig?: ViewBackendProductConfig; frontendConfig?: ViewFrontendConfig; disabledPages?: readonly string[] } = {}) {
  const pages = new Set<string>(VIEW_PRODUCT_PLUGINS.map(plugin => plugin.PAGE_TYPE));
  for (const page of disabledPages) {
    if (!pages.has(page)) throw new TypeError(`Unknown View page: ${page}`);
  }
  const disabled = new Set(disabledPages);
  const displayBackendConfig = {
    platform: backendConfig?.platform,
    capabilities: backendConfig?.capabilities,
  };
  const workspaceBackendConfig = {
    workspaceEngine: backendConfig?.workspaceEngine,
    workspaceAccessToken: backendConfig?.workspaceAccessToken,
    workspaceAuthorize: backendConfig?.workspaceAuthorize,
    packSources: backendConfig?.packSources,
    capabilities: backendConfig?.capabilities,
  };
  const backend = [
    { id: VIEW_WORKSPACE_CORE.BACKEND_PLUGIN_ID, module: VIEW_WORKSPACE_CORE.BACKEND_MODULE, config: workspaceBackendConfig },
    { id: display.BACKEND_PLUGIN_ID, module: display.BACKEND_MODULE, config: displayBackendConfig },
    { id: plugins.BACKEND_PLUGIN_ID, module: plugins.BACKEND_MODULE, config: {} },
  ];
  const frontend = [
    { id: SHELL_PLUGIN_ID, module: SHELL_MODULE },
    { id: VIEW_WORKSPACE_CORE.FRONTEND_PLUGIN_ID, module: VIEW_WORKSPACE_CORE.FRONTEND_MODULE },
    { id: assetReferences.FRONTEND_PLUGIN_ID, module: assetReferences.FRONTEND_MODULE },
    ...(!disabled.has(scene.PAGE_TYPE) ? [{ id: scene.FRONTEND_PLUGIN_ID, module: scene.FRONTEND_MODULE }] : []),
    { id: PRESENTATION_PLUGIN_ID, module: PRESENTATION_MODULE },
    ...VIEW_PRODUCT_PLUGINS.filter(plugin => plugin !== scene && !disabled.has(plugin.PAGE_TYPE))
      .map(plugin => ({ id: plugin.FRONTEND_PLUGIN_ID, module: plugin.FRONTEND_MODULE })),
    ...VIEW_CAPABILITY_FRONTEND_PLUGINS.map(plugin => ({ id: plugin.FRONTEND_PLUGIN_ID, module: plugin.FRONTEND_MODULE })),
  ];
  return Object.freeze({
    backend: Object.freeze(backend),
    frontend: Object.freeze(frontend),
    frontendConfig,
    disabledPages: Object.freeze([...disabled]),
  });
}
