import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { ClipboardProvider, OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { useTranslation } from '../i18n/useTranslation';
import { createRoot } from 'react-dom/client';
import { ContentBrowserPanel } from './ContentBrowserPanel';
import './content-browser.css';

export async function mountContentBrowserPanel(props: ComponentProps<typeof ContentBrowserPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement; writeClipboard?: (text: string) => Promise<void> }) {
  if (!props.mountElement) throw new TypeError('mountContentBrowserPanel requires mountElement');
  const root = createRoot(props.mountElement);
  function Panel() {
    const { t } = useTranslation();
    return <ClipboardProvider writeText={props.writeClipboard} dismissLabel={t('contentBrowser.dismissClipboardError')}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
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
    </OverlayRootProvider></ClipboardProvider>;
  }
  root.render(<Panel />);
  return async () => root.unmount();
}
