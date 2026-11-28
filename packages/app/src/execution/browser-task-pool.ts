import { createTaskPool, type TaskWorkerToPoolMessage } from '@forgeax/engine-platform';
import { browserTaskWorker } from './browser-task-worker';
import { executionTaskKinds } from './task-kinds';

/** Main-thread Apps can submit the same worker-only task kinds as an Engine Worker. */
export function createBrowserTaskPool() {
  return createTaskPool({
    kinds: executionTaskKinds,
    workerFactory(listener) {
      const worker = browserTaskWorker();
      const { port1, port2 } = new MessageChannel();
      const terminate = () => {
        port1.close();
        worker.terminate();
      };
      port1.onmessage = (event: MessageEvent<TaskWorkerToPoolMessage>) =>
        listener.message(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        listener.error(new Error(event.message));
      };
      try {
        worker.postMessage({ kind: 'task-connect', port: port2 }, [port2]);
      } catch (cause) {
        port2.close();
        terminate();
        throw cause;
      }
      return {
        postMessage: (message, transfer) => port1.postMessage(message, transfer ?? []),
        terminate,
      };
    },
  });
}
