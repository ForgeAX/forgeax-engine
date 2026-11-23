import { stagePublicationShaders } from '@forgeax/engine-runtime/internal/shader-publication';
import type { BrowserRenderWorkerControl } from './render-worker-browser-channel';
import {
  adoptBrowserRenderPort,
  postRenderWorkerMessage,
  setBrowserRenderVisibility,
} from './render-worker-presentation';
import type { RenderWorkerInput, RenderWorkerOutput } from './render-worker-protocol';
import type { adoptStagedRenderShaders } from './render-worker-runtime';
import { rendererInspectionFailure, sendRendererInspection } from './renderer-inspection';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RenderWorkerInput>) => void) | null;
};
const output = { postMessage: (message: RenderWorkerOutput) => postRenderWorkerMessage(message) };
const pending: MessageEvent<RenderWorkerInput>[] = [];
let loading = false;
let hosted = false;
let staged: Parameters<typeof adoptStagedRenderShaders>[0] | undefined;

let receive = (event: MessageEvent<RenderWorkerInput>) => {
  const message = event.data;
  if (message.kind === 'inspect' && !pending.some((input) => input.data.kind === 'init')) {
    sendRendererInspection(output, message, rendererInspectionFailure('stale-session'));
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
      receive = receiveRenderWorkerInput;
      if (!hosted) scope.onmessage = receiveRenderWorkerInput;
    })
    .catch((cause) => {
      // Use the same Worker error event as a failing static module import.
      queueMicrotask(() => {
        throw cause;
      });
    });
};

scope.onmessage = (event: MessageEvent<RenderWorkerInput | BrowserRenderWorkerControl>) => {
  const message = event.data;
  if (message.kind === 'browser-render-connect') {
    hosted = true;
    adoptBrowserRenderPort(message.port, message.visible);
    message.port.onmessage = (input: MessageEvent<RenderWorkerInput>) => receive(input);
  } else if (message.kind === 'browser-render-visibility') {
    setBrowserRenderVisibility(message.visible);
  } else receive(event as MessageEvent<RenderWorkerInput>);
};
