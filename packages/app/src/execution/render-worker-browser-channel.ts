import type { EngineToHostMessage } from './protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from './render-worker-protocol';

/** Same ordered publication connection whether a Worker or a transferred port owns it. */
export interface RenderWorkerConnection {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<RenderWorkerOutput>) => void) | null;
  postMessage(message: RenderWorkerInput, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

export type BrowserRenderWorkerControl =
  | {
      readonly kind: 'browser-render-connect';
      readonly port: MessagePort;
      readonly visible: boolean;
    }
  | { readonly kind: 'browser-render-visibility'; readonly visible: boolean };

/** The page owns each native Worker. Scene messages travel directly between Workers. */
export function browserRenderWorkerSource(
  post: (message: EngineToHostMessage, transfer?: Transferable[]) => void,
) {
  const connections = new Map<number, RenderWorkerConnection>();
  let sequence = 0;
  return {
    open(): RenderWorkerConnection {
      const workerId = ++sequence;
      const { port1, port2 } = new MessageChannel();
      const connection: RenderWorkerConnection = {
        onerror: null,
        onmessage: null,
        postMessage(message, transfer) {
          port1.postMessage(message, transfer ?? []);
        },
        addEventListener(type, listener) {
          port1.addEventListener(type, listener);
        },
        removeEventListener(type, listener) {
          port1.removeEventListener(type, listener);
        },
        terminate() {
          if (!connections.delete(workerId)) return;
          port1.onmessage = null;
          port1.close();
          post({ kind: 'browser-render-retire', workerId });
        },
      };
      port1.onmessage = (event) => connection.onmessage?.(event);
      connections.set(workerId, connection);
      try {
        post({ kind: 'browser-render-open', workerId, port: port2 }, [port2]);
      } catch (error) {
        connections.delete(workerId);
        port1.close();
        port2.close();
        throw error;
      }
      return connection;
    },
    failed(workerId: number, message: string): void {
      connections.get(workerId)?.onerror?.(new ErrorEvent('error', { message }));
    },
  };
}
