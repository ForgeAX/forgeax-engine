import type { DebugDrawSource } from '@forgeax/engine-debug-draw';
import { createDebugDrawSource } from '@forgeax/engine-debug-draw';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';

export type RendererDebugDrawHost = Pick<
  RendererHostAssembly['debugDrawHost'],
  'initialization' | '_internal_setRenderOverlay'
>;

/**
 * Install the App-owned CPU debug overlay source once the renderer has
 * initialized. The Renderer owns every GPU object the overlay draws with.
 */
export async function createDebugDrawOnReady(
  context: RendererDebugDrawHost,
): Promise<DebugDrawSource> {
  const ready = await context.initialization;
  if (!ready.ok) throw ready.error;
  const source = createDebugDrawSource();
  context._internal_setRenderOverlay(source);
  return source;
}

/** Release the App-owned debug overlay source and clear its Render capability. */
export function releaseDebugDraw(context: RendererDebugDrawHost, debugDraw: DebugDrawSource): void {
  context._internal_setRenderOverlay(undefined);
  debugDraw.destroy();
}
