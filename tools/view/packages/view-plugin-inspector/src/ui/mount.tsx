import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { ClipboardProvider, OverlayRootProvider, PanelVisibilityProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { InspectorPanel } from './InspectorPanel';
import './inspector.css';
import './entity-inspector.css';

export async function mountInspectorPanel(props: ComponentProps<typeof InspectorPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement; writeClipboard?: (text: string) => Promise<void> }) {
  if (!props.mountElement) throw new TypeError('mountInspectorPanel requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <PanelVisibilityProvider element={props.mountElement}><ClipboardProvider writeText={props.writeClipboard}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <InspectorPanel client={props.client} />
    </OverlayRootProvider></ClipboardProvider></PanelVisibilityProvider>,
  );
  return async () => root.unmount();
}
