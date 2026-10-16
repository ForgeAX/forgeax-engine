import { createContext, useContext } from 'react';

/** Per edge-group pinned tab id (at most one pin per group). Mirrors interface edgePinStore. */
export const EDGE_PIN_CLASS = 'fx-edge-pin';

export type EdgePinScope = {
  pinnedIn: (groupId: string) => string | undefined;
  setPinned: (groupId: string, panelId: string | undefined) => void;
  clear: () => void;
  subscribe: (onChange: () => void) => () => void;
};

const scopes = new WeakMap<object, {
  pins: Map<string, string | undefined>;
  listeners: Set<() => void>;
}>();

function scopeRecord(api: object) {
  let record = scopes.get(api);
  if (!record) {
    record = { pins: new Map(), listeners: new Set() };
    scopes.set(api, record);
  }
  return record;
}

export function edgePinScopeFor(api: object): EdgePinScope {
  const record = scopeRecord(api);
  return {
    pinnedIn(groupId: string) {
      return record.pins.get(groupId);
    },
    setPinned(groupId: string, panelId: string | undefined) {
      const current = record.pins.get(groupId);
      if (current === panelId) return;
      if (panelId === undefined) record.pins.delete(groupId);
      else record.pins.set(groupId, panelId);
      for (const listener of record.listeners) listener();
    },
    clear() {
      record.pins.clear();
      for (const listener of record.listeners) listener();
    },
    subscribe(onChange: () => void) {
      record.listeners.add(onChange);
      return () => record.listeners.delete(onChange);
    },
  };
}

export function disposeEdgePinScope(api: object) {
  scopes.delete(api);
}

export const EdgePinScopeContext = createContext<EdgePinScope | null>(null);

export function useEdgePinScope() {
  return useContext(EdgePinScopeContext);
}
