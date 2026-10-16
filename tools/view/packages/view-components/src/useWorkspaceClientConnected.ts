import { useSyncExternalStore } from 'react';

type WorkspaceConnectionClient = {
  transport?: { connected?: boolean; request?: unknown };
  onDisconnect?: (listener: () => void) => () => void;
};

function readConnected(client?: WorkspaceConnectionClient | null) {
  const transport = client?.transport;
  return Boolean(transport && typeof transport.request === 'function' && transport.connected !== false);
}

export function useWorkspaceClientConnected(client?: WorkspaceConnectionClient | null) {
  return useSyncExternalStore(
    (onChange) => client?.onDisconnect?.(onChange) ?? (() => {}),
    () => readConnected(client),
    () => readConnected(client),
  );
}
