import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { createDebugDraw } from '@forgeax/engine-debug-draw';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { selectSwapChainFormat } from '../../../render/src/record/render-context';

export type RendererDebugDrawHost = Pick<
  RendererHostAssembly['debugDrawHost'],
  'initialization' | 'device' | '_internal_createShaderModule' | '_internal_setRenderOverlay'
>;

/** Create the App-owned debug overlay after the renderer has initialized. */
export async function createDebugDrawOnReady(
  context: RendererDebugDrawHost,
  format?: TextureFormat,
): Promise<DebugDraw> {
  const ready = await context.initialization;
  if (!ready.ok) throw ready.error;

  const resolvedFormat =
    format ??
    (selectSwapChainFormat(context.device.caps.storageBuffer).view as unknown as TextureFormat);
  const result = await createDebugDraw({
    device: context.device,
    queue: context.device.queue,
    createShaderModule: context._internal_createShaderModule,
    format: resolvedFormat,
  });
  if (!result.ok) throw result.error;
  context._internal_setRenderOverlay(result.value);
  return result.value;
}

/** Release the App-owned debug overlay and clear its Render capability. */
export function releaseDebugDraw(context: RendererDebugDrawHost, debugDraw: DebugDraw): void {
  context._internal_setRenderOverlay(undefined);
  debugDraw.destroy();
}
