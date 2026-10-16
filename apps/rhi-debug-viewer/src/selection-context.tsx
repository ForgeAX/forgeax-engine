import type { ReadbackSubresource } from '@forgeax/engine-rhi-debug';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';

export interface SelectionState {
  readonly selectedWorkIndex: number;
  readonly selectedCommandIndex: number;
  readonly selectedEventIndex: number;
  readonly selectedPassIndex: number;
  readonly selectedResourceId: string | null;
  readonly selectedSubresource: ReadbackSubresource | null;
  setSelectedWorkIndex: (index: number) => void;
  setSelectedCommandIndex: (index: number) => void;
  selectWork: (workIndex: number, eventIndex?: number, passIndex?: number) => void;
  selectCommand: (eventIndex: number, passIndex?: number, workIndex?: number) => void;
  selectResource: (resourceId: string, subresource?: ReadbackSubresource) => void;
  clearSelection: () => void;
}

export const SelectionContext = createContext<SelectionState>({
  selectedWorkIndex: -1,
  selectedCommandIndex: -1,
  selectedEventIndex: -1,
  selectedPassIndex: -1,
  selectedResourceId: null,
  selectedSubresource: null,
  setSelectedWorkIndex: () => {},
  setSelectedCommandIndex: () => {},
  selectWork: () => {},
  selectCommand: () => {},
  selectResource: () => {},
  clearSelection: () => {},
});

export function useSelection(): SelectionState {
  return useContext(SelectionContext);
}

export function SelectionProvider({ children }: { readonly children: ReactNode }) {
  const [selectedWorkIndex, setSelectedWorkIndexRaw] = useState(-1);
  const [selectedCommandIndex, setSelectedCommandIndexRaw] = useState(-1);
  const [selectedEventIndex, setSelectedEventIndex] = useState(-1);
  const [selectedPassIndex, setSelectedPassIndex] = useState(-1);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [selectedSubresource, setSelectedSubresource] = useState<ReadbackSubresource | null>(null);
  const value = useMemo<SelectionState>(
    () => ({
      selectedWorkIndex,
      selectedCommandIndex,
      selectedEventIndex,
      selectedPassIndex,
      selectedResourceId,
      selectedSubresource,
      setSelectedWorkIndex: (index) => {
        setSelectedWorkIndexRaw(index);
        setSelectedCommandIndexRaw(-1);
        setSelectedResourceId(null);
        setSelectedSubresource(null);
      },
      setSelectedCommandIndex: (index) => {
        setSelectedCommandIndexRaw(index);
        setSelectedEventIndex(index);
        setSelectedWorkIndexRaw(-1);
        setSelectedResourceId(null);
        setSelectedSubresource(null);
      },
      selectWork: (workIndex, eventIndex = -1, passIndex = -1) => {
        setSelectedWorkIndexRaw(workIndex);
        setSelectedCommandIndexRaw(-1);
        setSelectedEventIndex(eventIndex);
        setSelectedPassIndex(passIndex);
        setSelectedResourceId(null);
        setSelectedSubresource(null);
      },
      selectCommand: (eventIndex, passIndex = -1, workIndex = -1) => {
        setSelectedCommandIndexRaw(eventIndex);
        setSelectedEventIndex(eventIndex);
        setSelectedPassIndex(passIndex);
        setSelectedWorkIndexRaw(workIndex);
        setSelectedResourceId(null);
        setSelectedSubresource(null);
      },
      selectResource: (resourceId, subresource) => {
        setSelectedResourceId(resourceId);
        setSelectedSubresource(subresource ?? null);
      },
      clearSelection: () => {
        setSelectedWorkIndexRaw(-1);
        setSelectedCommandIndexRaw(-1);
        setSelectedEventIndex(-1);
        setSelectedPassIndex(-1);
        setSelectedResourceId(null);
        setSelectedSubresource(null);
      },
    }),
    [
      selectedCommandIndex,
      selectedEventIndex,
      selectedPassIndex,
      selectedResourceId,
      selectedSubresource,
      selectedWorkIndex,
    ],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
