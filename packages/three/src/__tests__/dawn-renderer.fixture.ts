import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';

/** Serial cases share their immutable configuration; capture replays keep fresh devices. */
export function dawnRendererFixture(materialPrograms?: () => Promise<readonly string[]>) {
  let pending:
    | Promise<{
        renderer: WebGPURenderer;
        surface: ReturnType<typeof offscreenCanvas>;
      }>
    | undefined;
  afterAll(async () => {
    if (pending === undefined) return;
    const { renderer, surface } = await pending;
    try {
      await renderer.dispose();
    } finally {
      surface.destroy();
    }
  });
  return async () => {
    pending ??= (async () => {
      const programs = await materialPrograms?.();
      const manifest = await buildEngineShaderManifest();
      const surface = offscreenCanvas(128);
      return {
        surface,
        renderer: new WebGPURenderer({
          canvas: surface.canvas as unknown as OffscreenCanvas,
          forgeax: {
            ...(programs === undefined ? {} : { materialPrograms: programs }),
            bundler: { shaderManifestUrl: shaderManifestUrl(manifest) },
          },
        }),
      };
    })();
    return (await pending).renderer;
  };
}
