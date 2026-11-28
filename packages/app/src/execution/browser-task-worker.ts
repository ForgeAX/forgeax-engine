import { claimBrowserPackProgramClients } from '@forgeax/engine-pack/runtime-browser';

function readServiceWorkerContainer(): ServiceWorkerContainer | undefined {
  try {
    return globalThis.navigator?.serviceWorker;
  } catch (cause) {
    // An opaque sandboxed iframe can run a Task Worker without Service Worker access.
    if (cause instanceof DOMException && cause.name === 'SecurityError') return undefined;
    throw cause;
  }
}

export function browserTaskWorker(): Worker {
  const serviceWorkers = readServiceWorkerContainer();
  let controlledBy = serviceWorkers?.controller;
  const worker = new Worker(new URL('./task-worker-runtime.mjs', import.meta.url), {
    type: 'module',
    name: 'forgeax-task',
  });
  if (serviceWorkers !== undefined && typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', ({ data, ports }) => {
      const port = ports[0];
      if (data?.kind !== 'task-claim-pack-scope' || !port || typeof data.scope !== 'string') return;
      const controller = serviceWorkers.controller;
      if (
        controller === null ||
        controller === undefined ||
        controller === controlledBy ||
        controller.scriptURL !== new URL('forgeax-pack-program-worker.js', data.scope).href
      ) {
        port.postMessage(false);
        port.close();
        return;
      }
      void claimBrowserPackProgramClients(controller).then((claimed) => {
        if (claimed) controlledBy = controller;
        port.postMessage(claimed);
        port.close();
      });
    });
  }
  return worker;
}
