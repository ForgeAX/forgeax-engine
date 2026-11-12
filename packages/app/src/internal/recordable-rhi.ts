import type { RendererOptions } from '@forgeax/engine-render';
import type { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import { loadRhiPack } from '@forgeax/engine-runtime/internal/renderer-host';

/** Select a usable backend before an explicit recorder RHI disables fallback. */
export async function recordableBackend(
  rendererOpts: Pick<RendererOptions, 'rhi'> = {},
): Promise<Parameters<typeof attachRecorder>[0]> {
  const nav = globalThis as { readonly navigator?: { readonly gpu?: unknown } };
  const explicitRhi = rendererOpts.rhi;
  let nativeAdapter =
    explicitRhi === undefined && nav.navigator?.gpu !== undefined
      ? await rhiWebgpu.requestAdapter()
      : undefined;
  const realBackend = (explicitRhi !== undefined
    ? { rhi: explicitRhi, ...explicitRhi }
    : nativeAdapter?.ok
      ? rhiWebgpu
      : await import('@forgeax/engine-rhi-wgpu')) as unknown as Record<string, unknown>;
  if (
    explicitRhi === undefined &&
    !nativeAdapter?.ok &&
    typeof realBackend.ensureReady === 'function'
  )
    await (realBackend.ensureReady as () => Promise<unknown>)();
  const pack = loadRhiPack(realBackend);
  if (pack.createShaderModule === undefined)
    throw new Error('RHI-debug requires a backend createShaderModule capability');
  return {
    // Consume the startup probe once; recovery requests a fresh adapter.
    rhi: nativeAdapter?.ok
      ? {
          ...pack.rhi,
          requestAdapter: async (...args) => {
            const initialAdapter = nativeAdapter;
            nativeAdapter = undefined;
            return initialAdapter ?? pack.rhi.requestAdapter(...args);
          },
        }
      : pack.rhi,
    createShaderModule: pack.createShaderModule,
    ...(pack.createShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: pack.createShaderModuleImmediate }),
  };
}
