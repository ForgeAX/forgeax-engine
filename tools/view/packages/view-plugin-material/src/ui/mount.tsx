import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { OverlayRootProvider, PanelVisibilityProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { MaterialPanel, MaterialPropertiesPanel } from './MaterialPanel';
import { MaterialPreviewPanel } from './MaterialPreviewPanel';
import { MaterialStatsPanel } from './MaterialStatsPanel';
import './material.css';

type MountProps = ComponentProps<typeof MaterialPreviewPanel> & ComponentProps<typeof MaterialPropertiesPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement };

function mount(node: Parameters<ReturnType<typeof createRoot>['render']>[0], props: MountProps) {
  if (!props.mountElement) throw new TypeError('material panel mount requires mountElement');
  const root = createRoot(props.mountElement);
  root.render(
    <OverlayRootProvider root={props.overlayRoot ?? props.mountElement}>
      {node}
    </OverlayRootProvider>,
  );
  return async () => root.unmount();
}

export async function mountMaterialPanel(props: MountProps) {
  return mount(
    <MaterialPanel client={props.client} assetActions={props.assetActions} />,
    props,
  );
}

export async function mountMaterialPropertiesPanel(props: MountProps) {
  return mount(
    <MaterialPropertiesPanel client={props.client} assetActions={props.assetActions} />,
    props,
  );
}

export async function mountMaterialPreviewPanel(props: MountProps) {
  return mount(
    <MaterialPreviewPanel
      client={props.client}
      presentation={props.presentation}
      owner={props.owner}
    />,
    props,
  );
}

export async function mountMaterialStatsPanel(props: MountProps) {
  return mount(<PanelVisibilityProvider element={props.mountElement}><MaterialStatsPanel client={props.client} /></PanelVisibilityProvider>, props);
}
