import type { Renderer } from '@forgeax/engine-render';
import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import type {
  CreateShaderModuleFn,
  RecordableBackend,
  RecorderAttachment,
  V7Tape,
} from '@forgeax/engine-rhi-debug';
import { attachRecorder, replayDeviceRequest } from '@forgeax/engine-rhi-debug';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import { createRhiInstrumentation } from './rhi-capture';

export interface BrowserRhiDebugRuntime {
  readonly rhi: RhiInstance;
  readonly attachment: RecorderAttachment;
  readonly createReplayDevice: (
    tape: V7Tape,
  ) => Promise<import('@forgeax/engine-types').Result<RhiDevice, unknown>>;
  readonly createShaderModule: CreateShaderModuleFn;
  readonly rhiInstrumentation: import('@forgeax/engine-render/internal/construct-renderer').RhiBackendInstrumentation;
  attachRenderer(renderer: Renderer): () => void;
}

interface BackendModule extends RecordableBackend {
  readonly ensureReady?: () => Promise<unknown>;
}

function hasWebGpu(): boolean {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  return nav?.gpu !== undefined;
}

async function loadBackend(): Promise<BackendModule> {
  const backend = (hasWebGpu()
    ? rhiWebgpu
    : await import('@forgeax/engine-rhi-wgpu')) as unknown as BackendModule;
  if (!hasWebGpu()) await backend.ensureReady?.();
  return backend;
}

/**
 * Assemble the browser preview's recorder at the Runtime seam. The preview
 * host owns the attachment and consumes only the encoded tape; it does not
 * reach into recorder state or reintroduce the removed DebugRhi facade.
 */
export async function createBrowserRhiDebugRuntime(): Promise<BrowserRhiDebugRuntime> {
  const backend = await loadBackend();
  const attached = attachRecorder(backend);
  if (!attached.ok) throw new Error(attached.error.hint);
  const attachment = attached.value;
  return {
    rhi: attachment.backend.rhi,
    attachment,
    createShaderModule: backend.createShaderModule,
    rhiInstrumentation: createRhiInstrumentation(attachment),
    createReplayDevice: async (tape) => {
      const adapter = await backend.rhi.requestAdapter();
      if (!adapter.ok) return adapter;
      return adapter.value.requestDevice(
        replayDeviceRequest(tape, adapter.value.features, adapter.value.limits),
      );
    },
    attachRenderer(_renderer: Renderer): () => void {
      // Frame boundaries and device loss are connected by the typed
      // rhiInstrumentation passed to createApp. This hook remains a no-op so
      // the Preview host keeps an explicit lifecycle slot without subscribing
      // a second boundary callback.
      return () => {};
    },
  };
}
