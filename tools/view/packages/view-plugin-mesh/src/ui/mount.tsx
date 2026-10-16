import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { MeshPreviewPanel } from './MeshPreviewPanel';
import { MeshPropertiesPanel } from './MeshPropertiesPanel';
import './mesh.css';

type MountProps = ComponentProps<typeof MeshPreviewPanel> & ComponentProps<typeof MeshPropertiesPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement };

function mountPanel(node: Parameters<ReturnType<typeof createRoot>['render']>[0], props: MountProps) {
  if (!props.mountElement) throw new TypeError('mesh panel mount requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      {node}
    </OverlayRootProvider>,
  );
  return async () => root.unmount();
}

export async function mountMeshPreviewPanel(props: MountProps) {
  return mountPanel(
    <MeshPreviewPanel
      client={props.client}
      presentation={props.presentation}
      owner={props.owner}
      inputControllerFactory={props.inputControllerFactory}
    />,
    props,
  );
}

export async function mountMeshPropertiesPanel(props: MountProps) {
  return mountPanel(
    <MeshPropertiesPanel client={props.client} assetActions={props.assetActions} />,
    props,
  );
}
