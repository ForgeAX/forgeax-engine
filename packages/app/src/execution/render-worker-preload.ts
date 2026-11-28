import type { RenderWorkerConnection } from './render-worker-browser-channel';
import type { RenderWorkerInput } from './render-worker-protocol';

export interface RenderWorkerPreload {
  readonly worker: RenderWorkerConnection | undefined;
  readonly failure:
    | { readonly kind: 'constructor'; readonly cause: unknown }
    | { readonly kind: 'module'; readonly cause: string }
    | undefined;
}

export function openRenderWorker(): RenderWorkerConnection {
  return new Worker(new URL('./render-worker-runtime.mjs', import.meta.url), {
    type: 'module',
    name: 'forgeax-render',
  });
}

/** Load the module and its CPU inputs before the caller can admit a surface. */
export function preloadRenderWorker(
  url: string | undefined,
  open: () => RenderWorkerConnection,
): RenderWorkerPreload {
  let worker: RenderWorkerConnection | undefined;
  let failure: RenderWorkerPreload['failure'];
  try {
    worker = open();
    worker.onerror = (event) => {
      event.preventDefault();
      failure ??= { kind: 'module', cause: event.message };
    };
    worker.postMessage({
      kind: 'stage-shader-manifest',
      ...(url === undefined ? {} : { url }),
    } satisfies RenderWorkerInput);
  } catch (cause) {
    failure = { kind: 'constructor', cause };
  }
  return {
    worker,
    get failure() {
      return failure;
    },
  };
}
