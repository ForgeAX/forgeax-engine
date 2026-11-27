import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { ClipboardProvider, OverlayRootProvider, PanelVisibilityProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { useTranslation } from '../i18n/useTranslation';
import { createRoot } from 'react-dom/client';
import { InspectorPanel } from './InspectorPanel';
import './inspector.css';
import './entity-inspector.css';

export async function mountInspectorPanel(props: ComponentProps<typeof InspectorPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement; writeClipboard?: (text: string) => Promise<void> }) {
  if (!props.mountElement) throw new TypeError('mountInspectorPanel requires mountElement');
  const root = createRoot(props.mountElement);
  function Panel() {
    const { t } = useTranslation();
    return <PanelVisibilityProvider element={props.mountElement}><ClipboardProvider writeText={props.writeClipboard} dismissLabel={t('inspector.dismissClipboardError')}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <InspectorPanel client={props.client} assetReferences={props.assetReferences} browseAsset={props.browseAsset} addConversationReference={props.addConversationReference} />
    </OverlayRootProvider></ClipboardProvider></PanelVisibilityProvider>;
  }
  root.render(<Panel />);
  return async () => root.unmount();
}
