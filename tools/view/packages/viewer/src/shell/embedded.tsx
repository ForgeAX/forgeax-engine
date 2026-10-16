import { useEffect, useState } from 'react';
import { LoadingState, OverlayRootProvider } from '@forgeax/view-components';
import { VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { restoreProjectPreferences } from '@forgeax/view-workspace-core/project-session';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@forgeax/view-components/theme';
import type { Plugin } from '@forgeax/engine/plugin';
import type { ViewFrontendConfig } from '../config.ts';
import { createViewPanelHost } from '../host/panel-bridge.ts';
import { createViewPageHost, createViewPageTypeRegistry } from '../host/page-registry.ts';
import { createViewSlotRegistry } from '../host/slot-registry.ts';
import { initI18n, t } from '../i18n';
import { ViewerShell } from './ViewerShell';
import { useHostWsConnection } from './use-host-ws-connection';
import * as panels from '../panels-entry';
import '@forgeax/view-components/styles.css';
import '../styles.css';

/** Same-document UI plugin. Engine supplies only its exact live surface. */
const embeddedShell: Plugin = {
  name: 'forgeax.view.shell.workspace.mount',
  provide: ['panelHost', 'viewSlotRegistry', 'pageHost'],
  apply(ctx, config: ViewFrontendConfig = {}) {
    restoreProjectPreferences();
    initI18n();
    const state = globalThis;
    const previousPanels = state.__forgeaxViewPanelsPromise;
    state.__forgeaxViewPanelsPromise = Promise.resolve(panels);
    const registry = createViewSlotRegistry(document);
    const pageRegistry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry: pageRegistry });
    const element = document.createElement('div');
    const panelHost = createViewPanelHost({ registry, overlayRoot: element });
    element.id = 'forgeax-view-root';
    // Do not trap every UI overlay in a stacking context below the borrowed
    // Engine surface. Panels, surfaces and portaled overlays share one stack.
    element.style.cssText = 'position:absolute;inset:0';
    document.body.append(element);
    const root = createRoot(element);
    root.render(<ThemeProvider defaultTheme="system" className="fx-view-root">
      <LoadingState title={t('view.projectOpen.busy')} />
    </ThemeProvider>);
    ctx.effect(() => () => {
      root.unmount();
      element.remove();
      state.__forgeaxViewPanelsPromise = previousPanels;
      delete state.__forgeaxViewReady;
    });
    const hostTransport = ctx.get?.('hostTransport', false) as
      | import('./host-ws-transport').HostWsTransport
      | false;

    void ctx.plugin({
      name: 'forgeax.view.shell.workspace.render',
      inject: ['viewOperationClient'],
      apply(renderContext) {
        const client = renderContext.get('viewOperationClient')!;
        function ConnectedShell() {
          useEffect(() => { state.__forgeaxViewReady = { mounted: true }; }, []);
          const [selectedTabId, setSelectedTabId] = useState(VIEW_WORKSPACE_TAB_ID);
          const hostConnection = useHostWsConnection(
            hostTransport === false ? undefined : hostTransport,
            { onReconnect: () => { void client.projectSession?.reconnectHost?.(); } },
          );
          useEffect(() => {
            if (typeof client?.subscribe !== 'function') return undefined;
            return client.subscribe(state => {
              if (state.selectedTabId) setSelectedTabId(state.selectedTabId);
            });
          }, [client]);
          return <OverlayRootProvider root={element}><ThemeProvider defaultTheme="system" persist applyToDocument className="fx-view-root">
            <ViewerShell slotRegistry={registry} pageRegistry={pageRegistry} pageHost={pageHost} panelHost={panelHost}
              responsiveAutoTuck={config.layout?.responsiveAutoTuck}
              hostConnection={hostConnection}
              workspaceClient={client}
              selectedPageType={selectedTabId === VIEW_DISPLAY_TAB_ID ? 'display' : 'editor'}
              onSelectPageType={(typeId, signal) => {
                if (typeId === 'display' || typeId === 'editor') {
                  return client.selectTab(typeId === 'display' ? VIEW_DISPLAY_TAB_ID : VIEW_WORKSPACE_TAB_ID, { signal });
                }
              }} />
          </ThemeProvider></OverlayRootProvider>;
        }
        root.render(<ConnectedShell />);
      },
    });
    ctx.provide('viewSlotRegistry', registry);
    ctx.provide('panelHost', panelHost);
    ctx.provide('pageHost', pageHost);
  },
};
export default embeddedShell;
