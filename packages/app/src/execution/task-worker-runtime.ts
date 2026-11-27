import { serveTaskWorker } from '@forgeax/engine-platform';
import type { TaskWorkerConnectMessage } from './protocol';
import { createSharedKernelSlices } from './shared-kernel-slices';
import { executionTaskKinds } from './task-kinds';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TaskWorkerConnectMessage>) => void) | null;
};

// The page connects this pool Worker to the Engine Worker's dispatcher.
scope.onmessage = (event): void => {
  if (event.data.kind !== 'task-connect') return;
  const port = event.data.port;
  serveTaskWorker(port, executionTaskKinds, { slices: createSharedKernelSlices() });
};
