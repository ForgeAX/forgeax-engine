import type { Context } from '@forgeax/engine-plugin';
import type { HostRootDescriptor, HostAssembly } from '@forgeax/engine-host/protocol';
import type { FrontendHost } from '@forgeax/engine-host/frontend';
import type { ViewFrontendConfig } from '../config.ts';
export type ViewFrontendConnectionOptions = ViewFrontendConfig & {
  endpoint: string; token: string; frontendTicket?: string;
  WebSocket?: typeof globalThis.WebSocket; reload?: () => void | Promise<void>;
};
import { createFrontendPlatformPlugin } from '@forgeax/engine-host/platform';
import { createFrontendHost } from '@forgeax/engine-host/frontend';
import { createHostWebSocketClient } from '@forgeax/engine-host/transport';
import { HOST_ASSEMBLY_CHANGED_TOPIC } from '@forgeax/engine-host/transport';
import { requireWorkspaceString } from '@forgeax/view-workspace-core/contract';
import { workspaceBrowserEndpoint } from '@forgeax/view-workspace-core/client';

import { VIEW_FRONTEND_ROOT_PROGRAM } from '../frontend-root.ts';
import { createViewFrontendRoot } from '../frontend-root.ts';

export async function resolveViewFrontendRoot(root: HostRootDescriptor, localConfig?: ViewFrontendConfig) {
  if (root.program !== VIEW_FRONTEND_ROOT_PROGRAM) {
    throw new Error(`Unexpected View frontend root: ${root.program}`);
  }
  return createViewFrontendRoot(localConfig);
}
import { createViewSlotRegistry } from './slot-registry.ts';
import { createViewPageHost, createViewPageTypeRegistry } from './page-registry.ts';

function browserConfig(options: ViewFrontendConfig, token: string | undefined) {
  const browserConfig = {
    ...options,
    workspace: {
      ...(options.workspaceMountId === undefined ? {} : { mountId: options.workspaceMountId }),
      clientId: options.clientId ?? 'view-browser',
      ...(token === undefined ? {} : { token }),
      ...(options.resourceBrowser === undefined
        ? {}
        : { resourceBrowser: options.resourceBrowser }),
    },
  };
  delete browserConfig.workspaceMountId;
  delete browserConfig.clientId;
  delete browserConfig.resourceBrowser;
  return browserConfig;
}

export async function connectViewFrontend({ endpoint, token, WebSocket: SocketConstructor = globalThis.WebSocket, frontendTicket, reload, ...browserOptions }: Partial<ViewFrontendConnectionOptions> = {}) {
  const url = workspaceBrowserEndpoint(
    requireWorkspaceString(endpoint, 'endpoint'),
    requireWorkspaceString(token, 'token'),
    browserOptions.window?.location?.href ?? globalThis.location?.href,
    'frontend',
    frontendTicket,
  );
  if (!browserOptions.platform && typeof SocketConstructor !== 'function') {
    throw new TypeError('View frontend requires a browser WebSocket constructor');
  }
  const transport = await (browserOptions.platform ? browserOptions.platform.connectHost(url) : createHostWebSocketClient(new SocketConstructor(url)));
  let frontendHost: FrontendHost | undefined;
  let pendingAssembly: HostAssembly | undefined;
  let closed = false;
  const location = browserOptions.window?.location ?? globalThis.location;
  const reloadFrontend =
    reload ??
    (typeof location?.reload === 'function' ? () => location.reload() : undefined);
  const changed = (assembly: HostAssembly) => {
    if (closed) return;
    if (!frontendHost) { pendingAssembly = assembly; return; }
    if (frontendHost.assembly.current.revision === assembly.revision) return;
    if (reloadFrontend) void Promise.resolve(reloadFrontend()).catch((error) => transport.close(error));
    else transport.close(new Error('View frontend root changed; reload the page'));
  };
  const removeChanged = transport.subscribe<HostAssembly>(HOST_ASSEMBLY_CHANGED_TOPIC, changed);
  try {
    frontendHost = await createFrontendHost({
      context: browserOptions.context,
      resolveRoot: (root) => resolveViewFrontendRoot(root, browserConfig(browserOptions, token)),
      startupPlugins: [...(browserOptions.platform && !browserOptions.context?.get('frontendPlatform', false) ? [createFrontendPlatformPlugin(browserOptions.platform)] : []), ...(browserOptions.embedded === false ? [{
        name: 'forgeax.view.browser-shell',
        provide: ['panelHost', 'pageHost', 'viewSlotRegistry'],
        apply(ctx: Context) {
          if (browserOptions.panelHost) ctx.provide('panelHost', browserOptions.panelHost);
          if (browserOptions.pageHost) ctx.provide('pageHost', browserOptions.pageHost);
          if (browserOptions.viewSlotRegistry) ctx.provide('viewSlotRegistry', browserOptions.viewSlotRegistry);
        },
      }] : [])],
      transport,
      autoActivate: true,
    });
    if (pendingAssembly) changed(pendingAssembly);
  } catch (error) {
    removeChanged();
    transport.close('View frontend activation failed');
    throw error;
  }
  return Object.freeze({
    frontendHost,
    transport,
    endpoint: url,
    async dispose(reason = 'View frontend disposed') {
      closed = true;
      removeChanged();
      await frontendHost?.dispose();
      transport.close(reason);
    },
  });
}

export async function mountViewWorkspace(options: Partial<ViewFrontendConnectionOptions> = {}) {
  const connection = await connectViewFrontend(options);
  const shell = connection.frontendHost.context.get('viewWorkspaceShell', false);
  const api = connection.frontendHost.context.get('viewOperationClient', false);
  if (!shell || !api) {
    await connection.dispose('View workspace plugin did not mount');
    throw new Error('View frontend Host did not mount the workspace plugin');
  }
  return Object.freeze({ ...connection, api, shell });
}

export async function mountViewViewer(options: Partial<ViewFrontendConnectionOptions> = {}) {
  const document = options.document ?? globalThis.document;
  const viewSlotRegistry =
    options.viewSlotRegistry ??
    globalThis.__forgeaxViewSlotRegistry ??
    createViewSlotRegistry(document);
  globalThis.__forgeaxViewSlotRegistry = viewSlotRegistry;
  const pageRegistry = options.pageRegistry ?? createViewPageTypeRegistry();
  const pageHost = options.pageHost ?? createViewPageHost({ registry: pageRegistry });
  return connectViewFrontend({
    ...options,
    resourceBrowser: options.resourceBrowser ?? true,
    viewSlotRegistry,
    pageRegistry,
    pageHost,
  });
}
