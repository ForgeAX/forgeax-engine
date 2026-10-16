import { HostAssemblyError } from '@forgeax/engine-host/protocol';
import type { HostTransportClient } from '@forgeax/engine-host/transport';

/** Standard Host client methods cross MCP; the Engine wire protocol stays in its public adapter. */
export async function connectMcpHost(
  invoke: any,
  bytes: any,
  url: string,
): Promise<HostTransportClient> {
  const descriptor = await invoke({ action: 'host-open', url });
  let connected = true;
  let generation = descriptor.generation;
  let closing: Promise<unknown> | undefined;
  let sequence = 0;
  const pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
  const topics = new Map<string, Set<(value: any) => void>>();
  const disconnects = new Set<(error: HostAssemblyError) => void>();
  const failure = (error: any) =>
    new HostAssemblyError(
      error?.code ?? 'host-transport-failure',
      error?.expected ?? 'an active Host connection',
      error?.hint ?? String(error?.message ?? error),
      error?.detail ?? {},
    );
  const retire = (error: any) => {
    if (!connected) return;
    connected = false;
    const cause = failure(error);
    for (const request of pending.values()) request.reject(cause);
    pending.clear();
    for (const listener of disconnects) listener(cause);
    disconnects.clear();
    topics.clear();
  };
  const packet = async (ref: any) => JSON.parse(new TextDecoder().decode(await bytes(ref)));
  void (async () => {
    try {
      while (connected) {
        const value = await packet(
          await invoke({ action: 'host-read', connectionId: descriptor.connectionId }),
        );
        if (!connected) return;
        for (const event of value.events) {
          if (event.requestId) {
            pending.get(event.requestId)?.resolve(event.response);
            pending.delete(event.requestId);
          } else for (const listener of topics.get(event.topic) ?? []) listener(event.value);
        }
        if (value.closed) {
          retire(value.error);
          return;
        }
      }
    } catch (error) {
      retire(error);
    }
  })();
  return {
    get connected() {
      return connected;
    },
    get generation() {
      return generation;
    },
    get caller() {
      return descriptor.caller;
    },
    async request(service, payload, options = {}) {
      if (!connected) throw failure('Host connection retired');
      const requestId = String(++sequence);
      const signal = options.signal;
      if (signal?.aborted) throw signal.reason;
      const abort = () => {
        pending.get(requestId)?.reject(signal?.reason);
        pending.delete(requestId);
        void invoke({
          action: 'host-cancel',
          connectionId: descriptor.connectionId,
          requestId,
        }).catch(() => {});
      };
      try {
        const response = new Promise<any>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          signal?.addEventListener('abort', abort, { once: true });
          void invoke(
            {
              action: 'host-request',
              connectionId: descriptor.connectionId,
              requestId,
              service,
              payload,
              ...(options.generation === undefined ? {} : { generation: options.generation }),
            },
            { signal },
          ).catch(reject);
        });
        const result = await packet(await response);
        if (!result.ok) throw failure(result.error);
        generation = result.generation;
        return result.value;
      } finally {
        pending.delete(requestId);
        signal?.removeEventListener('abort', abort);
      }
    },
    subscribe(topic, listener) {
      let callbacks = topics.get(topic);
      if (!callbacks) {
        topics.set(topic, (callbacks = new Set()));
        void invoke({
          action: 'host-subscribe',
          connectionId: descriptor.connectionId,
          topic,
        }).catch(retire);
      }
      callbacks.add(listener);
      return () => {
        callbacks!.delete(listener);
        if (callbacks!.size === 0) {
          topics.delete(topic);
          void invoke({
            action: 'host-unsubscribe',
            connectionId: descriptor.connectionId,
            topic,
          }).catch(retire);
        }
      };
    },
    onDisconnect(listener) {
      disconnects.add(listener);
      return () => {
        disconnects.delete(listener);
      };
    },
    close(reason) {
      if (!closing) {
        closing = Promise.resolve()
          .then(() => invoke({ action: 'host-close', connectionId: descriptor.connectionId }))
          .catch(() => {});
        retire(reason);
      }
      return closing.then(() => {});
    },
  };
}
