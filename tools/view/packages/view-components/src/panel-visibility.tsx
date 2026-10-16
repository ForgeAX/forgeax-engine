import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { observeElementVisibility } from './visibility';

const PanelVisibility = createContext(true);
export function PanelVisibilityProvider({ element, children }: { element: HTMLElement; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => observeElementVisibility(element, setVisible), [element]);
  return <PanelVisibility.Provider value={visible}>{children}</PanelVisibility.Provider>;
}
/** Hidden panels retain UI state while releasing their active query leases. */
export function usePanelVisible() { return useContext(PanelVisibility); }
