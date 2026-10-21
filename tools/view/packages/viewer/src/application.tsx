/// <reference types="vite/client" />
import { ThemeProvider, initializeTheme } from '@forgeax/view-components/theme';
import { ClipboardProvider, OverlayRootProvider } from '@forgeax/view-components';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { createViewPanelHost } from './host/panel-bridge.ts';
import { createViewPageHost, createViewPageTypeRegistry } from './host/page-registry.ts';
import { mountViewViewer } from './host/frontend.ts';
import { createViewSlotRegistry } from './host/slot-registry.ts';
import { initI18n, t } from './i18n';
import type { HostConnection } from './shell/HostConnectionIndicator';
import { createBrowserConnection } from './plugins/browser-connection.ts';
import { ViewerShell } from './shell/ViewerShell';
import type { WorkspaceRecoveryClient } from './shell/WorkspaceProjectRecovery';
import type { ViewFrontendConfig } from './config.ts';
import '@forgeax/view-components/styles.css';
import './styles.css';
import { restoreProjectPreferences } from '@forgeax/view-workspace-core/project-session';

import type { EngineWorkspacePresentation } from '@forgeax/engine/app';
import type { Context } from '@forgeax/engine-plugin';
import type { FrontendPlatform } from '@forgeax/engine-host/platform';

export function mountViewApplication(platform: FrontendPlatform, { panels, presentation, context }: { panels?: Promise<unknown>; presentation?: EngineWorkspacePresentation; context?: Context } = {}) {
  const { window, document } = platform;
  restoreProjectPreferences(window);
  initI18n();

  initializeTheme('system', platform.theme?.getSnapshot());


  const root = document.getElementById('root');
  if (!root) throw new Error('ForgeaX View viewer requires #root');

  window.__forgeaxViewSlotRegistry = createViewSlotRegistry(document);
  const pageRegistry = createViewPageTypeRegistry();
  const pageHost = createViewPageHost({ registry: pageRegistry });
  const panelHost = createViewPanelHost({
    registry: window.__forgeaxViewSlotRegistry,
    overlayRoot: root,
    platform,
  });

  let workspaceClient: WorkspaceRecoveryClient | undefined;
  let hostConnection: HostConnection = { phase: 'connecting', onReconnect: startConnection };
  let responsiveAutoTuck = false;

  if (panels) {
    window.__forgeaxViewPanelsPromise = panels;
  } else if (import.meta.env.PROD) {
    window.__forgeaxViewPanelsUrl = '/panels.js';
  } else {
    window.__forgeaxViewPanelsPromise = import('./panels-entry');
  }

  const appRoot = createRoot(root);

  function connectionFailureMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unexpected token.*<|not valid json/i.test(message)) {
      return t('view.connection.errors.invalidBootstrap');
    }
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return t('view.connection.errors.network');
    }
    return message;
  }

  function setHostConnection(patch: Partial<HostConnection>) {
    hostConnection = {
      ...hostConnection,
      ...patch,
      onReconnect: startConnection,
    };
    renderApp();
  }

  const noSubscription = () => () => {};
  const readTheme = () => platform.theme?.getSnapshot();
  function Application() {
    const hostTheme = useSyncExternalStore(platform.theme?.subscribe ?? noSubscription, readTheme, readTheme);
    return (
      <StrictMode><ClipboardProvider writeText={platform.writeClipboard}><OverlayRootProvider root={root!}>
        <ThemeProvider systemTheme={hostTheme} persist applyToDocument className="fx-view-root">
          <ViewerShell
            slotRegistry={window.__forgeaxViewSlotRegistry!}
            pageRegistry={pageRegistry}
            pageHost={pageHost}
            panelHost={panelHost}
            workspaceClient={workspaceClient}
            hostConnection={hostConnection}
            responsiveAutoTuck={responsiveAutoTuck}
          />
        </ThemeProvider>
      </OverlayRootProvider></ClipboardProvider></StrictMode>
    );
  }
  function renderApp() { appRoot.render(<Application />); }

  async function connectToHost(signal: AbortSignal) {
    delete window.__forgeaxViewReady;
    setHostConnection({ phase: 'connecting', detail: undefined, reconnectBusy: true });

    let config: {
      configured?: boolean;
      reason?: string;
      frontendEndpoint?: string;
      token?: string;
      frontendTicket?: string;
      frontendConfig?: Pick<ViewFrontendConfig, 'layout'>;
    };
    try {
      const response = await platform.fetch('/__forgeax/view/bootstrap', { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`View bootstrap failed (${response.status})`);
      config = await response.json();
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted) return;
    responsiveAutoTuck = config.frontendConfig?.layout?.responsiveAutoTuck !== false;
    renderApp();
    if (config.configured === false) {
      const message = config.reason || t('view.connection.unconfigured');
      window.__forgeaxViewReady = { mounted: [], unconfigured: true, reason: message };
      setHostConnection({ phase: 'unconfigured', detail: message, reconnectBusy: false });
      return;
    }
    const mounted = await mountViewViewer({
      context,
      platform,
      presentation,
      embedded: false,
      endpoint: config.frontendEndpoint ?? '',
      token: config.token ?? '',
      frontendTicket: config.frontendTicket,
      document,
      window,
      resourceBrowser: true,
      viewSlotRegistry: window.__forgeaxViewSlotRegistry,
      panelHost,
      pageRegistry,
      pageHost,
    });
    return mounted;
  }

  function startConnection() {
    connection.reconnect();
  }

  renderApp();
  const connection = createBrowserConnection({
    connect: connectToHost,
    onChange: (value: HostConnection & { session?: Awaited<ReturnType<typeof mountViewViewer>> }) => {
      workspaceClient = value.session?.frontendHost.context.get('viewOperationClient') as WorkspaceRecoveryClient | undefined;
      if (value.session) window.__forgeaxViewReady = { mounted: value.session };
      if (value.detail) window.__forgeaxViewReady = { error: connectionFailureMessage(new Error(value.detail)) };
      const detail = value.detail ?? (value.phase === 'unconfigured' ? window.__forgeaxViewReady?.reason : undefined);
      setHostConnection({ ...value, detail: detail ? connectionFailureMessage(new Error(detail)) : undefined });
    },
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    await connection.dispose();
    appRoot.unmount();
  };
  const onPageHide = () => { void dispose(); };
  window.addEventListener('pagehide', onPageHide, { once: true });
  return dispose;

}
