import type { RendererOptions } from '@forgeax/engine-render';
import {
  loadRhiPack as loadRenderRhiPack,
  type RhiBackendPack,
} from '@forgeax/engine-render/internal/construct-renderer';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
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

/** Selects one backend pack; render receives only this typed owner contract. */
export async function loadBackendPack(
  options: RendererOptions | undefined,
  preferWgpu = false,
): Promise<
  | { readonly ok: true; readonly value: RhiBackendPack }
  | { readonly ok: false; readonly error: RhiError }
> {
  const explicit = options?.rhi;
  if (explicit !== undefined && explicit !== null) {
    return ok(loadRhiPack({ rhi: explicit, ...(explicit as object) }, options?.rhiInstrumentation));
  }
  const nav =
    typeof globalThis === 'undefined'
      ? undefined
      : (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (!preferWgpu && nav?.gpu !== undefined && nav.gpu !== null) {
    return ok(
      loadRhiPack(rhiWebgpu as unknown as Record<string, unknown>, options?.rhiInstrumentation),
    );
  }
  try {
    const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
    await (mod.ensureReady as () => Promise<unknown>)();
    return ok(loadRhiPack(mod, options?.rhiInstrumentation));
  } catch (cause) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'a usable RHI backend is available',
        hint: `failed to load wgpu backend: ${String(cause)}`,
      }),
    );
  }
}
