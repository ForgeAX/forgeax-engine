import type { GameHost } from '@forgeax/engine-app';
import { renderFeaturePlugin } from '@forgeax/engine-app';
import type { Context } from '@forgeax/engine-plugin';
import { createFullscreenRenderFeature } from '@forgeax/engine-app';
import type { Renderer } from '@forgeax/engine-render';

export interface GameFullscreenFeatureHandle {
  readonly installed: boolean;
  readonly error?: string;
  dispose(): void;
}

/** Install one cooked fullscreen effect through the App-owned feature lease. */
export async function installGameFullscreenFeature(
  context: Context,
  host: GameHost | undefined,
  renderer: Renderer | undefined,
  options: Parameters<typeof createFullscreenRenderFeature>[0],
): Promise<GameFullscreenFeatureHandle> {
  if (host === undefined || renderer === undefined) {
    return {
      installed: false,
      error: 'Renderer host is unavailable; fullscreen effect remains disabled.',
      dispose: () => undefined,
    };
  }
  const feature = createFullscreenRenderFeature(options);
  try {
    await context.plugin(renderFeaturePlugin(feature));
    return { installed: true, dispose: () => undefined };
  } catch (cause) {
    return {
      installed: false,
      error: cause instanceof Error ? cause.message : String(cause),
      dispose: () => undefined,
    };
  }
}
