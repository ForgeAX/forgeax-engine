import type { HostToEngineMessage } from './protocol';
import {
  openRenderWorker,
  preloadRenderWorker,
  type RenderWorkerPreload,
} from './render-worker-preload';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HostToEngineMessage>) => void) | null;
};

const pending: MessageEvent<HostToEngineMessage>[] = [];
let loading = false;
scope.onmessage = (event) => {
  pending.push(event);
  if (loading) return;
  loading = true;
  const initial = event.data;
  // Project bootstraps supply their policy and Catalog up front. A standalone
  // bootstrap can set up its realm before it opens a child.
  let preload =
    initial.kind === 'init' &&
    initial.startup !== undefined &&
    initial.assetCatalog !== undefined &&
    initial.workers.render.enabled &&
    initial.diagnostics?.browserRenderPresentation !== true
      ? preloadRenderWorker(initial.shaderManifestUrl, openRenderWorker)
      : undefined;
  const takePreload = (): RenderWorkerPreload | undefined => {
    const result = preload;
    preload = undefined;
    return result;
  };
  void import('./engine-worker-runtime')
    .then(({ receiveEngineWorkerInput }) => {
      for (const input of pending)
        receiveEngineWorkerInput(input, input === event ? takePreload : undefined);
      pending.length = 0;
    })
    .catch((cause) => {
      preload?.worker?.terminate();
      queueMicrotask(() => {
        throw cause;
      });
    });
};
