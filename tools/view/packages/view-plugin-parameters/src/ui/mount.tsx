import type { ComponentProps } from 'react';
import '@forgeax/view-components/styles.css';
import { OverlayRootProvider } from '@forgeax/view-components';
import '../i18n/index.ts';
import { createRoot } from 'react-dom/client';
import { ParametersPanel } from './ParametersPanel.tsx';

export async function mountParametersPanel(props: ComponentProps<typeof ParametersPanel> & { mountElement: HTMLElement; overlayRoot?: HTMLElement }) {
  const { mountElement, overlayRoot, ...panelProps } = props;
  const root = createRoot(mountElement);
  root.render(<OverlayRootProvider root={overlayRoot ?? mountElement}><ParametersPanel {...panelProps} /></OverlayRootProvider>);
  return async () => root.unmount();
}
