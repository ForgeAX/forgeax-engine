import { createContext, type ReactNode, useContext } from 'react';
import type { WorkspacePanelId } from './workspace-layout';

type OpenPanel = (panelId: WorkspacePanelId) => void;

const PanelNavigationContext = createContext<OpenPanel>(() => {});

export function PanelNavigationProvider({
  children,
  openPanel,
}: {
  readonly children: ReactNode;
  readonly openPanel: OpenPanel;
}) {
  return (
    <PanelNavigationContext.Provider value={openPanel}>{children}</PanelNavigationContext.Provider>
  );
}

export function useOpenViewerPanel(): OpenPanel {
  return useContext(PanelNavigationContext);
}
