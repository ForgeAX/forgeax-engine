import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { ClipboardProvider, OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { ContentBrowserPanel } from './ContentBrowserPanel';
import './content-browser.css';

export async function mountContentBrowserPanel(props: ComponentProps<typeof ContentBrowserPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement; writeClipboard?: (text: string) => Promise<void> }) {
  if (!props.mountElement) throw new TypeError('mountContentBrowserPanel requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <ClipboardProvider writeText={props.writeClipboard}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <ContentBrowserPanel
        assetReferences={props.assetReferences}
        client={props.client}
        pageHost={props.pageHost}
        revealPanel={props.revealPanel}
        dismissUnpinnedEdge={props.dismissUnpinnedEdge}
        detailTabs={props.detailTabs}
        addConversationReference={props.addConversationReference}
        registerAssetReveal={props.registerAssetReveal}
      />
    </OverlayRootProvider></ClipboardProvider>,
  );
  return async () => root.unmount();
}
