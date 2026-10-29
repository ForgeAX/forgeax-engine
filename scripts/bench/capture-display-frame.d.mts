import type { Renderer } from '@forgeax/engine-render';

/** Bottom-up RGBA8 from one ready, completed scene submission. */
export function captureDisplayFrame(
  renderer: Renderer,
  request: Parameters<Renderer['draw']>[0],
): Promise<Uint8Array>;
