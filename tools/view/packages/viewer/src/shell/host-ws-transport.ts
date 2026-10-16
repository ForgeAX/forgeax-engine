export type HostWsTransport = {
  readonly connected: boolean;
  onDisconnect(listener: (error: { message?: string }) => void): () => void;
};

export function attachHostWsTransport(
  transport: HostWsTransport,
  onChange: (state: { connected: boolean; detail?: string }) => void,
): () => void {
  onChange({ connected: transport.connected });
  return transport.onDisconnect((error) => {
    onChange({ connected: false, detail: error?.message });
  });
}
