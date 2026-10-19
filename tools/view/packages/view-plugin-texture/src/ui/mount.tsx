import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { OverlayRootProvider, PanelVisibilityProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { TexturePreviewPanel } from './TexturePreviewPanel';
import { TexturePropertiesPanel } from './TexturePropertiesPanel';
import './texture.css';

type MountProps = ComponentProps<typeof TexturePreviewPanel> & ComponentProps<typeof TexturePropertiesPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement };

function mountPanel(node: Parameters<ReturnType<typeof createRoot>['render']>[0], props: MountProps) {
  if (!props.mountElement) throw new TypeError('texture panel mount requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <PanelVisibilityProvider element={props.mountElement}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      {node}
    </OverlayRootProvider></PanelVisibilityProvider>,
  );
  return async () => root.unmount();
}

export async function mountTexturePreviewPanel(props: MountProps) {
  return mountPanel(
    <TexturePreviewPanel client={props.client} presentation={props.presentation} owner={props.owner} />,
    props,
  );
}

export async function mountTexturePropertiesPanel(props: MountProps) {
  return mountPanel(
    <TexturePropertiesPanel client={props.client} assetActions={props.assetActions} />,
    props,
  );
}
