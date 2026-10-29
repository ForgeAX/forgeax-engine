import type { RendererOptions } from '@forgeax/engine-render';
import {
  loadRhiPack as loadRenderRhiPack,
  type RhiBackendPack,
} from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';

/** Runtime preserves module instrumentation fallback over the Render helper. */
export function loadRhiPack(
  mod: Record<string, unknown>,
  instrumentation?: RhiBackendPack['instrumentation'],
): RhiBackendPack {
  const backendInstrumentation = mod.instrumentation as
    | RhiBackendPack['instrumentation']
    | undefined;
  const resolvedInstrumentation = instrumentation ?? backendInstrumentation;
  return loadRenderRhiPack(mod, resolvedInstrumentation);
}

export type RendererBackendKind = 'injected' | 'webgpu' | 'wgpu-webgl2';

export type BackendPackSelection =
  | { readonly ok: true; readonly kind: RendererBackendKind; readonly value: RhiBackendPack }
  | { readonly ok: false; readonly kind: 'wgpu-webgl2'; readonly error: RhiError };

/** Select and load one identified backend; Runtime owns any subsequent attempt. */
export async function loadBackendPack(
  options?: RendererOptions,
  requested?: 'wgpu-webgl2',
): Promise<BackendPackSelection> {
  const explicit = options?.rhi;
  if (explicit !== undefined && explicit !== null) {
    return {
      ok: true,
      kind: 'injected',
      value: loadRhiPack({ rhi: explicit, ...(explicit as object) }, options?.rhiInstrumentation),
    };
  }
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (requested === undefined && nav?.gpu !== undefined && nav.gpu !== null) {
    return {
      ok: true,
      kind: 'webgpu',
      value: loadRhiPack(
        rhiWebgpu as unknown as Record<string, unknown>,
        options?.rhiInstrumentation,
      ),
    };
  }
  try {
    const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
    await (mod.ensureReady as () => Promise<unknown>)();
    return { ok: true, kind: 'wgpu-webgl2', value: loadRhiPack(mod, options?.rhiInstrumentation) };
  } catch (cause) {
    return {
      ok: false,
      kind: 'wgpu-webgl2',
      error: new RhiError({
        code: 'rhi-not-available',
        expected: 'a usable wgpu/WebGL2 backend is available',
        hint: `failed to load wgpu backend: ${String(cause)}`,
      }),
    };
  }
}
