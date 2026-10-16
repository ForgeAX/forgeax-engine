import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { AssetPropertiesPanel } from './AssetPropertiesPanel';
import './asset.css';

type MountProps = ComponentProps<typeof AssetPropertiesPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement };

export async function mountAssetPropertiesPanel(props: MountProps) {
  if (!props.mountElement) throw new TypeError('asset panel mount requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <AssetPropertiesPanel client={props.client} assetActions={props.assetActions} />
    </OverlayRootProvider>,
  );
  return async () => root.unmount();
}
