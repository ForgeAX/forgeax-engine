import { attachRecorder, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import { loadRhiPack } from '@forgeax/engine-runtime/internal/renderer-host';

/** Select the same concrete recorder backend in either Worker rendering tier. */
export async function attachWorkerRhiRecorder(): Promise<RecorderAttachment> {
  const nav = globalThis as { readonly navigator?: { readonly gpu?: unknown } };
  const backend =
    nav.navigator?.gpu === undefined
      ? ((await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>)
      : (rhiWebgpu as unknown as Record<string, unknown>);
  if (nav.navigator?.gpu === undefined && typeof backend.ensureReady === 'function')
    await (backend.ensureReady as () => Promise<unknown>)();
  const pack = loadRhiPack(backend);
  if (pack.createShaderModule === undefined)
    throw new Error('Worker RHI capture requires a shader-module capability');
  const attached = attachRecorder({
    rhi: pack.rhi,
    createShaderModule: pack.createShaderModule,
    ...(pack.createShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: pack.createShaderModuleImmediate }),
  });
  if (!attached.ok) throw attached.error;
  return attached.value;
}
