import { serveTaskWorker } from '@forgeax/engine-platform';
import { builtinTaskKinds } from '@forgeax/engine-render/tasks';
import type { TaskWorkerConnectMessage } from './protocol';
import { createSharedKernelSlices } from './shared-kernel-slices';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TaskWorkerConnectMessage>) => void) | null;
};

// The page connects this pool Worker to the Engine Worker's dispatcher.
scope.onmessage = (event): void => {
  if (event.data.kind !== 'task-connect') return;
  const port = event.data.port;
  serveTaskWorker(port, builtinTaskKinds, { slices: createSharedKernelSlices() });
};
