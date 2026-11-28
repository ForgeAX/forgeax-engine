import { createRuntimePackTaskKinds } from '@forgeax/engine-import';
import { browserPackProgramScope } from '@forgeax/engine-pack/runtime-browser';
import { serveTaskWorker } from '@forgeax/engine-platform';
import { runtimeTaskKinds } from '@forgeax/engine-runtime/internal/tasks';
import type { TaskWorkerConnectMessage } from './protocol';
import { createSharedKernelSlices } from './shared-kernel-slices';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TaskWorkerConnectMessage>) => void) | null;
  postMessage(
    message: { kind: 'task-claim-pack-scope'; scope: string },
    transfer: Transferable[],
  ): void;
};

async function importBrowserTaskProgram(url: string) {
  const programScope = browserPackProgramScope(url);
  if (programScope !== undefined) {
    // Activation can miss this Worker if its startup was still in progress.
    // Ask the page to reclaim it before ESM resolves this URL for the first time.
    await new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      const finish = () => {
        clearTimeout(timeout);
        port1.close();
        resolve();
      };
      const timeout = setTimeout(finish, 2000);
      try {
        port1.onmessage = finish;
        scope.postMessage({ kind: 'task-claim-pack-scope', scope: programScope }, [port2]);
      } catch {
        port2.close();
        finish();
      }
    });
  }
  return import(/* @vite-ignore */ url);
}

const kinds = { ...runtimeTaskKinds, ...createRuntimePackTaskKinds(importBrowserTaskProgram) };

// The page connects this pool Worker to the Engine Worker's dispatcher.
scope.onmessage = (event): void => {
  if (event.data.kind !== 'task-connect') return;
  const port = event.data.port;
  serveTaskWorker(port, kinds, { slices: createSharedKernelSlices() });
};
