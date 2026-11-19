import type { FrontendPlatform } from '@forgeax/engine-host/platform';
import type { Plugin } from '@forgeax/engine-plugin';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import type { FrontendConfig, ViewFrontendRole } from './frontend-contract.ts';
import type { ViewWorkspaceClient } from './client.ts';
export type CoreFrontendConfig = FrontendConfig & { role?: ViewFrontendRole; platform?: FrontendPlatform; window?: Window & typeof globalThis; workspace?: { endpoint?: string; token: string; clientId: string; frontendTicket?: string } };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewOperationClient?: ViewWorkspaceClient; } }
import { createHostWebSocketClient } from '@forgeax/engine-host/transport';
import { createViewWorkspaceClient, workspaceBrowserEndpoint } from './client.ts';
import { createProjectSession } from './project-session.ts';
import { logResourceOpen, observeWorkspaceOpenRequests } from './resource-open.ts';
import { initViewTraceFromEnvironment, wrapViewWorkspaceClient } from './view-trace.ts';
import { attachPresentationResponder } from './presentation.ts';
import { workspaceError } from './contract.ts';
import { createContentBrowserDetailTabs } from './content-browser-detail-tabs.ts';
import type { createProjectDocumentFrameOwner } from './preview-surface.ts';
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewProjectDocumentFrameOwner: ReturnType<typeof createProjectDocumentFrameOwner>; } }

export const viewWorkspaceCoreFrontendPlugin: Plugin.Object<CoreFrontendConfig> = {
  name: 'forgeax.view.service.workspace-client.frontend',
  provide: ['viewOperationClient', 'contentBrowserDetailTabs'],
  async apply(ctx, config = {}) {
    ctx.provide('contentBrowserDetailTabs', createContentBrowserDetailTabs());
    ctx.effect(initViewTraceFromEnvironment);
    const lifetime = new AbortController();
    // Cordis emits removal before waiting for an asynchronous apply to settle.
    // Cancel pending I/O then, so ordinary effect cleanup can finish.
    ctx.on('internal/plugin', fiber => {
      if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort();
    });
    ctx.effect(() => () => lifetime.abort());
    const pageHost = config.pageHost ?? ctx.get?.('pageHost', false);
    const workspace = config.workspace;
    const window = config.window ?? globalThis;
    const configuredTransport = ctx.get?.('hostTransport', false);
    let transport: HostTransportClient | undefined = configuredTransport && 'request' in configuredTransport ? configuredTransport : undefined;
    // The frontend Host already owns the page's trusted socket. Reuse it so
    // workspace commands and page status subscriptions have one caller identity.
    if (workspace?.endpoint && !transport) {
      const url = workspaceBrowserEndpoint(workspace.endpoint, workspace.token, window.location?.href, 'frontend', workspace.frontendTicket);
      let socket!: WebSocket;
      let ownedTransport: HostTransportClient | undefined;
      let disposed = false;
      ctx.effect(() => {
        socket = new window.WebSocket(url);
        const close = () => {
          disposed = true;
          if (ownedTransport) ownedTransport.close('View workspace client disposed');
          else socket.close(1000, 'View workspace client disposed');
        };
        lifetime.signal.addEventListener('abort', close, { once: true });
        return () => { lifetime.signal.removeEventListener('abort', close); close(); };
      });
      try { ownedTransport = await createHostWebSocketClient(socket); }
      catch (error) { if (lifetime.signal.aborted) return; throw error; }
      if (disposed) { ownedTransport.close('View workspace client disposed'); return; }
      transport = ownedTransport;
    }
    const rawClient =
      transport && workspace?.clientId && workspace?.token
        ? createViewWorkspaceClient({
            transport,
            clientId: workspace.clientId,
            token: workspace.token,
          })
        : undefined;
    const client = wrapViewWorkspaceClient(rawClient);
    if (lifetime.signal.aborted) return;
    const role = config.role ?? 'shell';
    if (rawClient && (config.window ?? globalThis).location && role === 'shell') {
      const session = createProjectSession(rawClient, { role, window: config.window ?? globalThis });
      rawClient.projectSession = session;
      const dispose = () => session.dispose();
      lifetime.signal.addEventListener('abort', dispose, { once: true });
      ctx.effect(() => () => { lifetime.signal.removeEventListener('abort', dispose); dispose(); });
      // A headed document must finish exact-target recovery before its
      // plugins can construct an App. The View entry has no Engine workspace
      // surface, so let its Shell activate while a cold project opens.
      if (new URL(window.location.href).searchParams.has('forgeaxWorkspaceTarget'))
        await session.ready;
    }
    if (lifetime.signal.aborted) return;
    ctx.provide('viewOperationClient', client);
    if (transport) {
      const dispose = attachPresentationResponder(transport, async (operation, args, signal) => {
        if (operation === 'presentation.document.release') {
          const frameOwner = ctx.get?.('viewProjectDocumentFrameOwner', false);
          if (frameOwner) await frameOwner.release();
          operation = 'presentation.get';
        }
        if (!pageHost?.callPresentation) throw workspaceError('view-presentation-unavailable', 'an installed native presentation owner', 'Mount the View Shell before querying its presentation.');
        return pageHost.callPresentation(operation, args, signal);
      });
      ctx.effect(() => dispose);
      if (role === 'shell' && rawClient && window.location && !new URL(window.location.href).searchParams.has('forgeaxWorkspaceTarget')) {
        const present = () => {
          if (lifetime.signal.aborted || (config.document ?? window.document)?.visibilityState === 'hidden') return;
          void rawClient.presentProject({ signal: lifetime.signal }).catch(error => {
            if (!lifetime.signal.aborted) console.error('View project presentation failed', error);
          });
        };
        window.addEventListener('pointerdown', present, true);
        ctx.effect(() => () => window.removeEventListener('pointerdown', present, true));
        present();
      }
    }
    if (pageHost?.openResource && client) {
      logResourceOpen('open-request-observer-wired', {});
      const stop = observeWorkspaceOpenRequests(client, (request) => pageHost.openResource(request));
      ctx.effect(() => stop);
    } else {
      logResourceOpen('open-request-observer-skipped', {
        hasPageHost: Boolean(pageHost),
        hasOpenResource: Boolean(pageHost?.openResource),
        hasClient: Boolean(client),
      }, { level: 'warn' });
    }
  },
};

export default viewWorkspaceCoreFrontendPlugin;
