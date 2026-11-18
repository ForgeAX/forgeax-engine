import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { pointColorModes, verifyPointColors } from './point-colors.fixture';

for (const mode of pointColorModes)
  it(`point colors ${mode} on dawn`, { timeout: 120000 }, async () => {
    const surface = offscreenCanvas(128);
    const renderer = new WebGPURenderer({
      canvas: surface.canvas as unknown as OffscreenCanvas,
      forgeax: {
        bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
      },
    });
    try {
      await verifyPointColors(renderer, mode, async () => {});
    } finally {
      await renderer.dispose();
      surface.destroy();
    }
  });
