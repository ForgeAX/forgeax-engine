import { stagePublicationShaders } from '@forgeax/engine-runtime/internal/shader-publication';
import type { RenderWorkerInput, RenderWorkerOutput } from './render-worker-protocol';
import type { adoptStagedRenderShaders } from './render-worker-runtime';
import { rendererInspectionFailure, sendRendererInspection } from './renderer-inspection';

const scope = globalThis as unknown as {
  postMessage(message: RenderWorkerOutput): void;
  onmessage: ((event: MessageEvent<RenderWorkerInput>) => void) | null;
};
const pending: MessageEvent<RenderWorkerInput>[] = [];
let loading = false;
let staged: Parameters<typeof adoptStagedRenderShaders>[0] | undefined;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === 'inspect' && !pending.some((input) => input.data.kind === 'init')) {
    sendRendererInspection(scope, message, rendererInspectionFailure('stale-session'));
    return;
  }
  if (message.kind === 'stage-shader-manifest' && pending.length === 0) {
    if (staged === undefined) {
      const { url } = message;
      staged = {
        url,
        ready: stagePublicationShaders(url === undefined ? undefined : { shaderManifestUrl: url })
          .ready,
      };
    }
  } else {
    pending.push(event);
  }
  if (loading) return;
  loading = true;
  // The first shader request is in flight while the device runtime is loaded.
  void import('./render-worker-runtime')
    .then(({ adoptStagedRenderShaders, receiveRenderWorkerInput }) => {
      if (staged !== undefined) adoptStagedRenderShaders(staged);
      staged = undefined;
      for (const input of pending) receiveRenderWorkerInput(input);
      pending.length = 0;
      scope.onmessage = receiveRenderWorkerInput;
    })
    .catch((cause) => {
      // Use the same Worker error event as a failing static module import.
      queueMicrotask(() => {
        throw cause;
      });
    });
};
