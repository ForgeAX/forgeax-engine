export type WorkspaceConnectionClient = { transport?: { connected?: boolean; request?: unknown }; onDisconnect?: (listener: (error?: unknown) => void) => () => void };

/**
 * Snapshot for whether the workspace client transport can accept requests.
 * Clients without a live transport report disconnected.
 */
export function readWorkspaceClientConnected(client?: WorkspaceConnectionClient) {
  if (!client) return false;
  const transport = client.transport;
  if (!transport || typeof transport.request !== 'function') return false;
  return transport.connected !== false;
}

/**
 * Subscribe to workspace transport disconnect (and initial disconnected state).
 * For use with React useSyncExternalStore.
 */
export function subscribeWorkspaceClientConnected(client: WorkspaceConnectionClient | undefined, onStoreChange: () => void) {
  if (!client) return () => {};
  return client.onDisconnect?.(() => {
    onStoreChange();
  }) ?? (() => {});
}
