import type { Context } from '@forgeax/engine-plugin';
import type { BackendHost } from '@forgeax/engine-host/backend';
import type { FrontendHost } from '@forgeax/engine-host/frontend';
import type { ViewBackendOptions } from './plugins/backend.ts';
export type ViewStartOptions = Omit<ViewBackendOptions, 'engineHost'> & {
 backendHost?: BackendHost; frontendHost?: FrontendHost; frontend?: boolean; frontendContext?: Context;
};
import { createFrontendHost } from '@forgeax/engine-host';

import { createViewBackend } from './plugins/backend.ts';

/**
 * Open the View backend Host. The browser activates its own frontend Host.
 * Tests and non-browser embeddings may explicitly opt into a local frontend. Engine never calls this implicitly for a headed request.
 */
export async function startView(options: ViewStartOptions = {}) {
  const backend = await createViewBackend({
    platform: options.platform,
    capabilities: options.capabilities,
    frontendConfig: options.frontendConfig,
    disabledPages: options.disabledPages,
    workspaceEngine: options.workspaceEngine,
    workspaceAccessToken: options.workspaceAccessToken,
    workspaceAuthorize: options.workspaceAuthorize,
    engineHost: options.backendHost,
    workspacePlugin: options.workspacePlugin,
    workspaceOptions: options.workspaceOptions,
    onActivationReport: options.onActivationReport,
    workspaceServer: options.workspaceServer,
    workspaceHost: options.workspaceHost,
    workspacePort: options.workspacePort,
    workspacePath: options.workspacePath,
    staticRoot: options.staticRoot,
  });
  const suppliedFrontendHost = options.frontendHost;
  const createFrontend = options.frontend === true && suppliedFrontendHost === undefined;
  const transport = createFrontend
      ? backend.backendHost.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' })
      : undefined;
  if (transport && options.backendHost) {
    backend.backendHost.bindProjection(transport.caller, { assembly: backend.hostBinding.frontendAssembly });
  }
  let frontendHost = suppliedFrontendHost;
  let ownsFrontendHost = false;
  try {
    if (createFrontend) {
      const { resolveViewFrontendRoot } =
        await import('@forgeax/view-viewer/host/frontend');
      frontendHost = await createFrontendHost({
        context: options.frontendContext,
        transport,
        resolveRoot: (root) => resolveViewFrontendRoot(root, options.frontendConfig),
        autoActivate: true,
      });
      ownsFrontendHost = true;
    }
    return Object.freeze({
      ...backend,
      ...(backend.workspaceFrontendEndpoint
        ? {
            // A browser embedding needs the paired, server-issued frontend
            // ticket; the CLI adapter strips that query before connecting.
            workspaceEndpoint: backend.workspaceFrontendEndpoint,
            workspaceUrl: backend.workspaceFrontendUrl,
          }
        : {}),
      frontendHost,
      async dispose() {
        if (ownsFrontendHost) await frontendHost?.dispose();
        transport?.close();
        await backend.dispose();
      },
    });
  } catch (error) {
    transport?.close();
    await backend.dispose().catch(() => {});
    throw error;
  }
}
