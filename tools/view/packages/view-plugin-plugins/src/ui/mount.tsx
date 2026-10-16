import type { ComponentProps } from 'react';
import { OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { PluginsPanel } from './PluginsPanel';
import './plugins.css';

export async function mountPluginsPanel(props: ComponentProps<typeof PluginsPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement }) {
  if (!props.mountElement) throw new TypeError('mountPluginsPanel requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <PluginsPanel
        hostAssembly={props.hostAssembly}
        connectionId={props.connectionId}
        client={props.client}
        workspaceClient={props.workspaceClient}
      />
    </OverlayRootProvider>,
  );
  return async () => root.unmount();
}
