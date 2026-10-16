import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { ClipboardProvider, OverlayRootProvider, PanelVisibilityProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { SceneTreePanel } from './SceneTreePanel';
import './scene-tree.css';

export async function mountSceneTreePanel(props: ComponentProps<typeof SceneTreePanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement; writeClipboard?: (text: string) => Promise<void> }) {
  if (!props.mountElement) throw new TypeError('mountSceneTreePanel requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <PanelVisibilityProvider element={props.mountElement}><ClipboardProvider writeText={props.writeClipboard}><OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      <SceneTreePanel client={props.client} />
    </OverlayRootProvider></ClipboardProvider></PanelVisibilityProvider>,
  );
  return async () => root.unmount();
}
