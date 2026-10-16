import { useEffect, useRef, useState } from 'react';

import type { HostConnection } from './HostConnectionIndicator';
import { attachHostWsTransport } from './host-ws-transport';

export function useHostWsConnection(
  transport: HostWsTransport | null | undefined,
  options: { onReconnect?: () => void } = {},
): HostConnection {
  const [connected, setConnected] = useState(() => transport?.connected === true);
  const [detail, setDetail] = useState<string | undefined>();
  const hadConnectedRef = useRef(transport?.connected === true);

  useEffect(() => {
    if (!transport) {
      setConnected(false);
      setDetail(undefined);
      hadConnectedRef.current = false;
      return;
    }
    return attachHostWsTransport(transport, (state) => {
      if (state.connected) {
        hadConnectedRef.current = true;
        setConnected(true);
        setDetail(undefined);
        return;
      }
      setConnected(false);
      setDetail(state.detail);
    });
  }, [transport]);

  if (!transport) {
    return { phase: 'unconfigured' };
  }
  if (connected) {
    return { phase: 'connected', onReconnect: options.onReconnect };
  }
  if (hadConnectedRef.current) {
    return {
      phase: 'disconnected',
      detail,
      onReconnect: options.onReconnect,
    };
  }
  return { phase: 'unconfigured', detail };
}

type HostWsTransport = import('./host-ws-transport').HostWsTransport;
